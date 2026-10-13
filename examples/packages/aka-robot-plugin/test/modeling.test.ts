import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  checkServiceDef,
  checkToolDef,
  type PluginExtensionAPI,
  type ServiceDef,
  type ToolContext,
  type ToolDef,
} from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModel, parseModelingConfig, registerModeling } from '../src/modeling.js'
import type { ScanTasks } from '../src/scan-task.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

const config = {
  generator: 'fixture',
  command: ['fixture-generator', '{image}', '{out}'],
  upAxis: 'Y',
  unit: 'normalised',
  displayHeight: 0.3,
  blenderExecutable: 'configured-blender',
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(photoCount: 1 | 4 = 4, multipart = false) {
  const root = await mkdtemp(join(tmpdir(), 'aka-modeling-'))
  roots.push(root)
  const fs = {
    read: (p: string) => readFile(join(root, p)),
    stat: async (p: string) => {
      const s = await stat(join(root, p))
      return { kind: 'file', size: s.size, mtimeMs: s.mtimeMs }
    },
    write: async (p: string, bytes: string | Uint8Array) => {
      const path = join(root, p)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    },
  }
  // Node join does not discard an absolute second path. Resolve workspace-relative and absolute ports explicitly.
  const path = (p: string) => (p.startsWith(root) ? p : join(root, p))
  fs.read = (p) => readFile(path(p))
  fs.stat = async (p) => {
    const s = await stat(path(p))
    return { kind: 'file', size: s.size, mtimeMs: s.mtimeMs }
  }
  fs.write = async (p, bytes) => {
    await mkdir(dirname(path(p)), { recursive: true })
    await writeFile(path(p), bytes)
  }
  const bytes = Buffer.from('fixture-image')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const directory = join(root, 'photos'),
    manifest = join(directory, 'manifest.json')
  const photos = Array.from({ length: photoCount }, (_, index) => index + 1).map((i) => ({
    name: `observation-${i}.jpg`,
    ref: { sha256: sha, size: bytes.length },
    selection: { detections: [{ label: 'box', confidence: 0.9 }], viewpoint: { index: i } },
  }))
  await fs.write(
    manifest,
    JSON.stringify({ kind: photoCount === 1 ? 'object-observation' : 'orbit-four-view', photos }),
  )
  for (const photo of photos) await fs.write(join(directory, photo.name), bytes)
  const tasks = {
    export: vi.fn(async () => ({
      captureSetId: 'task',
      directory,
      manifest,
      photoCount,
      viewpointsVerified: false,
      scale: 'unknown',
    })),
  } as unknown as Pick<ScanTasks, 'export'>
  const services = new Map<string, ServiceDef>(),
    tools: ToolDef[] = []
  const api = {
    registerTool: (tool: ToolDef) => {
      tools.push(tool)
      return () => {}
    },
  } as PluginExtensionAPI
  registerModeling(api, (service) => services.set(service.name, service), tasks as ScanTasks)
  const orthoEntry = '../../agh-ortho/extensions/main/index.mjs',
    blenderEntry = '../../agh-blender/extensions/main/index.mjs'
  const ortho = (await import(orthoEntry)).runtime,
    blender = (await import(blenderEntry)).runtime
  const contributed: ToolDef[] = []
  const pluginCtx = {
    extension: () => ({
      registerTool: (t: ToolDef) => {
        contributed.push(t)
        return () => {}
      },
    }),
    services: { register: () => () => {} },
  }
  ortho.apply(pluginCtx)
  blender.apply(pluginCtx)
  const ctx = {
    imageGeneration: {
      subject: vi.fn(async () => ({
        bytes: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAGElEQVR4nGP4//8/AwyDiX0iIv/hHJgMAAL1Gc497znIAAAAAElFTkSuQmCC',
          'base64',
        ),
        mime: 'image/png',
        model: 'agnes-image-2.5-flash',
        background: 'model-alpha',
        width: 3,
        height: 3,
      })),
    },
    session: { key: 'device', workspaceRoot: root },
    cwd: root,
    device: { binding: async () => ({ active: true, sessionId: 'device', bindingRevision: 1 }) },
    signal: new AbortController().signal,
    progress: vi.fn(),
    fs,
    artifacts: {
      put: vi.fn(async (data: Uint8Array, meta: { mime: string }) => ({
        sha256: createHash('sha256').update(data).digest('hex'),
        size: data.length,
        mime: meta.mime,
      })),
    },
    tools: { list: () => contributed, invoke: vi.fn() },
  } as unknown as ToolContext
  const invoke = vi.mocked(ctx.tools.invoke)
  let importedName = 'subject'
  let importedNames = [importedName]
  invoke.mockImplementation(async (name, args) => {
    const v = args as Record<string, unknown>
    if (name === 'agh_ortho_mesh_run') {
      const sidecar = 'source.json'
      await fs.write(
        sidecar,
        JSON.stringify({
          imageSha256: createHash('sha256')
            .update(await fs.read(String(v.image_file)))
            .digest('hex'),
          measuredSizeInFile: [1, 2, 1],
          upAxis: 'Y',
          unit: 'normalised',
          declaredHeight: 2,
        }),
      )
      return {
        content: [],
        structured: { ok: true, mesh_run: { mesh_path: 'mesh.glb', sidecar_path: sidecar } },
      }
    }
    if (name === 'agh_ortho_emit_ops') return contributed.find((t) => t.name === name)!.execute(args, ctx)
    if (name === 'agh_blender_apply_ops') {
      const ops = v.ops as Array<{ op: string; args: Record<string, unknown> }>
      const render = ops.find((o) => o.op === 'render.still')
      if (render)
        await fs.write(
          String(render.args.path),
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
            'base64',
          ),
        )
      const imported = ops.find((o) => o.op === 'mesh.import')
      if (imported) {
        importedName = String(imported.args.name)
        importedNames = multipart ? [importedName, `${importedName}_part`] : [importedName]
      }
      const joined = ops.find((o) => o.op === 'object.join')
      if (joined) importedNames = [String(joined.args.name)]
      return {
        content: [],
        structured: {
          ok: true,
          result: { applied: [{ op: 'mesh.import', result: { imported: [...importedNames] } }] },
        },
      }
    }
    if (name === 'agh_blender_scene')
      return {
        content: [],
        structured: {
          ok: true,
          scene: {
            objects: importedNames.map((name) => ({
              name,
              bounds: { min: [-0.1, -0.1, 0], max: [0.1, 0.1, 0.3] },
            })),
          },
        },
      }
    if (name === 'agh_blender_export') await fs.write(String(v.destination), 'fixture-blend')
    return { content: [], structured: { ok: true, verdict: 'fit', run_id: v.run_id } }
  })
  return { ctx, root, fs, services, tools, contributed, tasks, invoke, manifest }
}
describe('AKA modeling demo integration', () => {
  it('joins all newly imported mesh parts before applying the model placement', async () => {
    const f = await fixture(1, true)
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)
    expect(result.isError, JSON.stringify(result.structured)).not.toBe(true)
    const batches = f.invoke.mock.calls
      .filter(([name]) => name === 'agh_blender_apply_ops')
      .map(([, args]) => (args as { ops: { op: string; args: Record<string, unknown> }[] }).ops)
    expect(batches[0]?.map((op) => op.op)).toEqual(['mesh.import'])
    expect(batches[1]?.map((op) => op.op)).toEqual(['object.join', 'object.transform'])
    expect(batches[1]?.[0]?.args.names).toHaveLength(2)
  })
  it.each([true, false])(
    'reads modeling prerequisites without mistaking a restricted image port for missing configuration (%s)',
    async (exposed) => {
      const f = await fixture(1)
      const subject = f.ctx.imageGeneration?.subject
      if (!exposed) delete f.ctx.imageGeneration
      const status = f.tools.find((tool) => tool.name === 'aka_modeling_status')
      if (!status) throw new Error('Missing modeling status tool')
      expect((await status.execute({}, f.ctx)).structured).toMatchObject({
        meshGeneratorConfigured: false,
        imageGenerationPortAvailable: exposed ? true : null,
        imageKeyVerification: 'not_checked',
      })
      expect(f.invoke).not.toHaveBeenCalled()
      expect(subject).not.toHaveBeenCalled()
    },
  )
  it.each(['agh_blender_scene', 'agh_blender_ops_catalog', 'agh_blender_apply_ops', 'agh_blender_export'])(
    'reports a missing managed instance as an actual tool error: %s',
    async (name) => {
      const f = await fixture()
      const tool = f.contributed.find((tool) => tool.name === name)
      if (!tool) throw new Error('Missing Blender tool')
      expect(
        await tool.execute(
          (name === 'agh_blender_apply_ops'
            ? { ops: [{ op: 'object.transform', args: { name: 'subject', scale: [1, 1, 1] } }] }
            : name === 'agh_blender_export'
              ? { destination: 'new.blend' }
              : {}) as never,
          f.ctx,
        ),
      ).toMatchObject({ isError: true, structured: { ok: false } })
    },
  )
  it('generates four modeling references through separate calls, anchors identity, pages them and refuses camera motions', async () => {
    const f = await fixture(1)
    const generate = f.tools.find((t) => t.name === 'aka_generate_reference_view')
    const read = f.tools.find((t) => t.name === 'aka_read_reference_views')
    if (!generate || !read) throw new Error('Missing reference tools')
    const description = 'One black ceramic cup with a wide hollow rim and a curved handle on the right.'
    const early = await generate.execute({ taskId: 'task', view: 'right', description } as never, f.ctx)
    expect(early).toMatchObject({ isError: true, structured: { stage: 'read-original' } })
    for (const view of ['front', 'right', 'back', 'left']) {
      const result = await generate.execute({ taskId: 'task', view, description } as never, f.ctx)
      expect(result.isError).not.toBe(true)
      expect(result.structured).toMatchObject({ view, physicalObservation: false })
    }
    const subject = vi.mocked(f.ctx.imageGeneration!.subject)
    expect(subject.mock.calls.map((c) => c[0].view)).toEqual(['front', 'right', 'back', 'left'])
    expect(subject.mock.calls[0]?.[0].images).toHaveLength(1)
    expect(subject.mock.calls[1]?.[0].images).toHaveLength(2)
    expect(subject.mock.calls.every((c) => c[0].description === description)).toBe(true)
    expect(f.invoke).not.toHaveBeenCalled()
    const ctx = { ...f.ctx, session: { ...f.ctx.session, turn: 1, step: 1 } }
    const page = await read.execute({ taskId: 'task', offset: 0 } as never, ctx)
    expect(page.content.filter((c) => c.type === 'image')).toHaveLength(2)
    await expect(read.execute({ taskId: 'task', offset: 2 } as never, ctx)).rejects.toThrow(/next inference/)
    expect(
      (
        await read.execute({ taskId: 'task', offset: 2 } as never, {
          ...ctx,
          session: { ...ctx.session, step: 2 },
        })
      ).content.filter((c) => c.type === 'image'),
    ).toHaveLength(2)
    await generate.execute({ taskId: 'task', view: 'front', description } as never, f.ctx)
    expect(subject).toHaveBeenCalledTimes(4)
    const restoredTools: ToolDef[] = []
    registerModeling(
      {
        registerTool: (tool: ToolDef) => {
          restoredTools.push(tool)
          return () => {}
        },
      } as PluginExtensionAPI,
      () => {},
      f.tasks,
    )
    const restoredRead = restoredTools.find((t) => t.name === 'aka_read_reference_views')!
    const restored = await restoredRead.execute({ taskId: 'task', offset: 0 } as never, {
      ...ctx,
      session: { ...ctx.session, step: 3 },
    })
    expect(restored.content.filter((c) => c.type === 'image')).toHaveLength(2)
    const restoredGenerate = restoredTools.find((t) => t.name === 'aka_generate_reference_view')!
    expect(
      (await restoredGenerate.execute({ taskId: 'task', view: 'front', description } as never, f.ctx))
        .isError,
    ).not.toBe(true)
    expect(subject).toHaveBeenCalledTimes(4)
  })
  it('reports image-model failures without inventing reference views or launching Blender', async () => {
    const f = await fixture(1),
      generate = f.tools.find((t) => t.name === 'aka_generate_reference_view')
    if (!generate) throw new Error('Missing reference tool')
    vi.mocked(f.ctx.imageGeneration!.subject).mockRejectedValue(new Error('IMAGE_ACCESS_DENIED'))
    expect(
      await generate.execute(
        {
          taskId: 'task',
          view: 'front',
          description: 'A black hollow cup with a handle on the right.',
        } as never,
        f.ctx,
      ),
    ).toMatchObject({ isError: true, structured: { stage: 'generate-view', error: 'IMAGE_ACCESS_DENIED' } })
    expect(f.invoke).not.toHaveBeenCalled()
    const restoredTools: ToolDef[] = []
    registerModeling(
      {
        registerTool: (t: ToolDef) => {
          restoredTools.push(t)
          return () => {}
        },
      } as PluginExtensionAPI,
      () => {},
      f.tasks,
    )
    const result = await restoredTools
      .find((t) => t.name === 'aka_generate_reference_view')!
      .execute(
        {
          taskId: 'task',
          view: 'front',
          description: 'A black hollow cup with a handle on the right.',
        } as never,
        f.ctx,
      )
    expect(result).toMatchObject({ isError: true })
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
  })
  it('keeps a generated reference after image publication fails instead of generating again', async () => {
    const f = await fixture(1),
      tool = f.tools.find((t) => t.name === 'aka_generate_reference_view')!
    const input = {
      taskId: 'task',
      view: 'front',
      description: 'One black ceramic cup with a curved handle.',
    }
    vi.mocked(f.ctx.artifacts.put).mockRejectedValueOnce(new Error('Publication unavailable'))
    expect(await tool.execute(input as never, f.ctx)).toMatchObject({ isError: true })
    const restoredTools: ToolDef[] = []
    registerModeling(
      {
        registerTool: (t: ToolDef) => {
          restoredTools.push(t)
          return () => {}
        },
      } as PluginExtensionAPI,
      () => {},
      f.tasks,
    )
    expect(
      (
        await restoredTools
          .find((t) => t.name === 'aka_generate_reference_view')!
          .execute(input as never, f.ctx)
      ).isError,
    ).not.toBe(true)
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
  })
  it('recovers local saving without another image request and invalidates after configuration changes', async () => {
    const f = await fixture(1),
      tool = f.tools.find((t) => t.name === 'aka_generate_reference_view')!
    let revision = 1
    const ctx = {
      ...f.ctx,
      imageGeneration: {
        ...f.ctx.imageGeneration!,
        configuration: async () => ({
          revision,
          model: 'qwen-image-2.1-pro',
          size: '1K' as const,
          enabled: true,
        }),
      },
    }
    const input = {
      taskId: 'task',
      view: 'front',
      description: 'One black ceramic cup with a curved handle.',
    }
    const write = f.fs.write.bind(f.fs)
    const failure = vi.spyOn(f.fs, 'write').mockImplementation(async (path, data) => {
      if (String(path).endsWith('front.png')) throw new Error('Disk unavailable')
      await write(path, data)
    })
    expect(await tool.execute(input as never, ctx)).toMatchObject({
      isError: true,
      structured: { stage: 'save-reference' },
    })
    failure.mockRestore()
    expect((await tool.execute(input as never, ctx)).isError).not.toBe(true)
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
    revision = 2
    expect((await tool.execute(input as never, ctx)).isError).not.toBe(true)
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(2)
  })
  it('refuses a configuration change during generation and permits retrying a failed image read without duplicating a group', async () => {
    const f = await fixture(1)
    const description = 'One black ceramic cup with a curved handle on its right.'
    const generate = f.tools.find((t) => t.name === 'aka_generate_reference_view')!
    let revision = 1
    const ctx = {
      ...f.ctx,
      imageGeneration: {
        ...f.ctx.imageGeneration!,
        configuration: async () => ({
          revision,
          model: 'qwen-image-2.1-pro',
          size: '1K' as const,
          enabled: true,
        }),
      },
    }
    const subject = vi.mocked(f.ctx.imageGeneration!.subject),
      original = subject.getMockImplementation()!
    subject.mockImplementationOnce(async (input) => {
      const result = await original(input)
      revision++
      return result
    })
    expect(
      await generate.execute({ taskId: 'task', view: 'front', description } as never, ctx),
    ).toMatchObject({ isError: true, structured: { error: expect.stringMatching(/configuration changed/) } })
    revision = 1
    expect(
      await generate.execute({ taskId: 'task', view: 'front', description } as never, ctx),
    ).toMatchObject({ isError: true })
    expect(subject).toHaveBeenCalledTimes(1)
    const good = await fixture(1)
    await good.tools
      .find((t) => t.name === 'aka_generate_reference_views')!
      .execute({ taskId: 'task', description } as never, good.ctx)
    const reader = good.tools.find((t) => t.name === 'aka_read_reference_views')!
    const readCtx = { ...good.ctx, session: { ...good.ctx.session, turn: 1, step: 1 } }
    vi.mocked(good.ctx.artifacts.put).mockRejectedValueOnce(new Error('Temporary publication error'))
    await expect(reader.execute({ taskId: 'task', offset: 0 } as never, readCtx)).rejects.toThrow(
      /publication/,
    )
    expect(
      (await reader.execute({ taskId: 'task', offset: 0 } as never, readCtx)).content.filter(
        (c) => c.type === 'image',
      ),
    ).toHaveLength(2)
    await expect(reader.execute({ taskId: 'task', offset: 2 } as never, readCtx)).rejects.toThrow(
      /next inference/,
    )
  })
  it('returns a clear preparation failure rather than an unknown thrown outcome', async () => {
    const f = await fixture(1),
      tool = f.tools.find((t) => t.name === 'aka_prepare_subject')!
    vi.mocked(f.ctx.imageGeneration!.subject).mockRejectedValue(new Error('IMAGE_ACCESS_DENIED'))
    await expect(tool.execute({ taskId: 'task', photoIndex: 1 } as never, f.ctx)).resolves.toMatchObject({
      isError: true,
      structured: { stage: 'prepare-subject', error: 'IMAGE_ACCESS_DENIED' },
    })
    expect(await tool.execute({ taskId: 'task', photoIndex: 1 } as never, f.ctx)).toMatchObject({
      isError: true,
    })
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
  })
  it('rejects changed reference archives and concurrent groups without another generation', async () => {
    const f = await fixture(1)
    const generated = await f.tools
      .find((t) => t.name === 'aka_generate_reference_views')!
      .execute(
        {
          taskId: 'task',
          description: 'One black ceramic cup with a rounded handle on the right.',
        } as never,
        f.ctx,
      )
    const report = generated.structured as { views: { result: { path: string } }[] }
    const directory = dirname(report.views[0]!.result.path),
      path = join(directory, 'manifest.json')
    const saved = JSON.parse(new TextDecoder().decode(await f.fs.read(path)))
    const freshReader = () => {
      const tools: ToolDef[] = []
      registerModeling(
        {
          registerTool: (t: ToolDef) => {
            tools.push(t)
            return () => {}
          },
        } as PluginExtensionAPI,
        () => {},
        f.tasks,
      )
      return tools.find((t) => t.name === 'aka_read_reference_views')!
    }
    const ctx = { ...f.ctx, session: { ...f.ctx.session, turn: 1, step: 1 } }
    for (const change of [
      { owner: { ...saved.owner, sessionId: 'other' } },
      { owner: { ...saved.owner, bindingRevision: saved.owner.bindingRevision + 1 } },
      { originalSha256: '0'.repeat(64) },
    ]) {
      await f.fs.write(path, JSON.stringify({ ...saved, ...change }))
      await expect(freshReader().execute({ taskId: 'task', offset: 0 } as never, ctx)).rejects.toThrow(
        /identity/,
      )
    }
    await f.fs.write(path, JSON.stringify(saved))
    const right = join(directory, 'right.png'),
      bytes = await f.fs.read(right)
    await f.fs.write(right, new Uint8Array([1, 2, 3]))
    await expect(freshReader().execute({ taskId: 'task', offset: 0 } as never, ctx)).rejects.toThrow(
      /changed/,
    )
    await f.fs.write(right, bytes)
    const reader = freshReader(),
      put = vi.mocked(f.ctx.artifacts.put),
      original = put.getMockImplementation()!
    let ready!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
        ready = resolve
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve
      })
    put.mockImplementationOnce(async (...args) => {
      ready()
      await barrier
      return original(...args)
    })
    const first = reader.execute({ taskId: 'task', offset: 0 } as never, ctx)
    await started
    try {
      await expect(reader.execute({ taskId: 'task', offset: 2 } as never, ctx)).rejects.toThrow(
        /next inference/,
      )
    } finally {
      release()
      expect((await first).content.filter((c) => c.type === 'image')).toHaveLength(2)
    }
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(4)
  })
  it('generates secondary references in parallel and preserves the complete manifest', async () => {
    // Each parallel result must remain usable after one local publication recovery.
    const f = await fixture(1),
      batch = f.tools.find((t) => t.name === 'aka_generate_reference_views')!
    const subject = vi.mocked(f.ctx.imageGeneration!.subject),
      original = subject.getMockImplementation()!
    let active = 0,
      peak = 0
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    subject.mockImplementation(async (input) => {
      if (input.view === 'front') return original(input)
      active++
      peak = Math.max(peak, active)
      if (active === 3) release()
      try {
        await ready
        return await original(input)
      } finally {
        active--
      }
    })
    const result = await batch.execute(
      { taskId: 'task', description: 'One glossy black ceramic cup with a curved loop handle.' } as never,
      f.ctx,
    )
    expect(result).toMatchObject({ structured: { ok: true } })
    expect(peak).toBe(3)
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(0)
    const paths = (result.structured as { views: { result: { path: string } }[] }).views
    const manifest = JSON.parse(await readFile(join(paths[0]!.result.path, '..', 'manifest.json'), 'utf8'))
    expect(Object.keys(manifest.views).sort()).toEqual(['back', 'front', 'left', 'right'])
    const failed = await fixture(1),
      failedBatch = failed.tools.find((t) => t.name === 'aka_generate_reference_views')!
    vi.mocked(failed.ctx.imageGeneration!.subject).mockRejectedValue(new Error('IMAGE_ACCESS_DENIED'))
    expect(
      await failedBatch.execute(
        { taskId: 'task', description: 'One glossy black ceramic cup with a curved loop handle.' } as never,
        failed.ctx,
      ),
    ).toMatchObject({ isError: true, structured: { ok: false } })
    expect(failed.invoke).not.toHaveBeenCalled()
  })
  it('invalidates prepared subject caches after switching the configured image model', async () => {
    const f = await fixture(1),
      tool = f.tools.find((t) => t.name === 'aka_prepare_subject')!
    let model = 'agnes-image-2.5-flash',
      revision = 1
    const original = vi.mocked(f.ctx.imageGeneration!.subject).getMockImplementation()!
    vi.mocked(f.ctx.imageGeneration!.subject).mockImplementation(async (input) => ({
      ...(await original(input)),
      model,
    }))
    const ctx = {
      ...f.ctx,
      imageGeneration: {
        ...f.ctx.imageGeneration!,
        configuration: async () => ({ revision, model, size: '1K' as const, enabled: true }),
      },
    }
    expect((await tool.execute({ taskId: 'task', photoIndex: 1 } as never, ctx)).structured).toMatchObject({
      model,
      reused: false,
    })
    expect((await tool.execute({ taskId: 'task', photoIndex: 1 } as never, ctx)).structured).toMatchObject({
      model,
      reused: true,
    })
    model = 'qwen-image-2.1-pro'
    revision = 2
    expect((await tool.execute({ taskId: 'task', photoIndex: 1 } as never, ctx)).structured).toMatchObject({
      model,
      reused: false,
    })
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(2)
  })
  it('processes and builds the demo subject from one original without inventing four views', async () => {
    const f = await fixture(1)
    const manifestPath = join(f.root, 'photos', 'manifest.json')
    const manifest = JSON.parse(new TextDecoder().decode(await f.fs.read(manifestPath)))
    await f.fs.write(
      manifestPath,
      JSON.stringify({
        ...manifest,
        subject: {
          box: [0.65, 0.25, 0.95, 0.75],
          description: 'Requested visible object on the right, not the dominant central object.',
        },
      }),
    )
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)
    expect(result.isError, JSON.stringify(result.structured)).not.toBe(true)
    expect(result.structured).toMatchObject({ ok: true, stage: 'completed', sourceViewCount: 1 })
    expect(f.ctx.imageGeneration?.subject).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.anything()],
        subjectBox: [0.65, 0.25, 0.95, 0.75],
        description: 'Requested visible object on the right, not the dominant central object.',
      }),
    )
    expect((result.structured as { references: unknown[] }).references).toHaveLength(1)
  })
  it.each([
    'token-not-enforced',
    'handshake-http-error',
    'handshake-rejected',
    'handshake-network-error',
    'connected',
  ])('registers Blender only after a verified handshake: %s', async (outcome) => {
    const f = await fixture()
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    const tool = f.contributed.find((t) => t.name === 'agh_blender_start')!
    const result = await tool.execute(
      { executable: 'fixture-blender', empty: true } as never,
      {
        ...f.ctx,
        sandbox: { enforcement: () => 'unavailable', confine: async (argv: string[]) => argv },
        exec: vi.fn(async (argv: string[]) => {
          if (argv[1] !== '--version') {
            const instances = join(f.root, '.agh-blender', 'instances')
            const [entry] = await readdir(instances)
            await f.fs.write(join(instances, entry!, 'port.json'), JSON.stringify({ port: 12345 }))
          }
          return { code: 0, stdout: argv[1] === '--version' ? 'Blender 4.2.0' : 'fixture|123', stderr: '' }
        }),
        net: {
          fetch: vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
            if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }))
            if (!init?.headers?.['X-AGH-Token'])
              return new Response('{}', { status: outcome === 'token-not-enforced' ? 200 : 401 })
            if (outcome === 'handshake-network-error') throw new Error('fixture bridge disconnected')
            return new Response(JSON.stringify({ ok: outcome !== 'handshake-rejected' }), {
              status: outcome === 'handshake-http-error' ? 500 : 200,
            })
          }),
        },
      } as unknown as ToolContext,
    )
    expect(result.structured?.ok).toBe(outcome === 'connected')
    const instances = join(f.root, '.agh-blender', 'instances')
    const [entry] = await readdir(instances)
    const files = await readdir(join(instances, entry!))
    expect(files.includes('instance.json')).toBe(outcome === 'connected')
    expect(files).toContain('start-report.json')
    expect(JSON.parse(String(await f.fs.read(join(instances, entry!, 'start-report.json')))).ok).toBe(
      outcome === 'connected',
    )
    if (outcome === 'connected') expect(child.kill).not.toHaveBeenCalled()
    else expect(child.kill).toHaveBeenCalled()
    if (outcome === 'connected') {
      const beforeSpawns = vi.mocked(spawn).mock.calls.length
      const again = await tool.execute(
        { empty: true } as never,
        {
          ...f.ctx,
          net: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
        } as unknown as ToolContext,
      )
      expect(again.structured).toMatchObject({ ok: true, reused: true, emptyApplied: false })
      expect(spawn).toHaveBeenCalledTimes(beforeSpawns)
      expect(await tool.execute({ executable: 'another-Blender' } as never, f.ctx)).toMatchObject({
        isError: true,
        structured: { ok: false },
      })
      expect(spawn).toHaveBeenCalledTimes(beforeSpawns)
      const rejected = await tool.execute(
        {} as never,
        {
          ...f.ctx,
          net: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 })) },
        } as unknown as ToolContext,
      )
      expect(rejected).toMatchObject({ isError: true, structured: { ok: false } })
      expect(spawn).toHaveBeenCalledTimes(beforeSpawns)
      const ops = f.contributed.find((t) => t.name === 'agh_blender_apply_ops')
      if (!ops) throw new Error('Missing Blender ops')
      const transport = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              applied: [{ op: 'mesh.import', result: {} }],
              failed: { code: 'E_NO_SUCH_OBJECT' },
            }),
          ),
      )
      const partial = await ops.execute(
        { ops: [{ op: 'mesh.import', args: {} }] } as never,
        { ...f.ctx, timeoutMs: 30000, net: { fetch: transport } } as unknown as ToolContext,
      )
      expect(partial).toMatchObject({ isError: true, structured: { outcome: 'partial', replaySafe: false } })
      expect((transport.mock.calls[0] as unknown as [unknown, { timeoutMs: number }])[1].timeoutMs).toBe(
        29000,
      )
      expect(
        (transport.mock.calls[0] as unknown as [unknown, { headers: Record<string, string> }])[1].headers[
          'X-AGH-Timeout-Ms'
        ],
      ).toBe('29000')
      const capture = f.contributed.find((t) => t.name === 'agh_blender_capture')!
      const captureTransport = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 }))
      await capture.execute(
        { camera: 'TestCamera' } as never,
        { ...f.ctx, timeoutMs: 120000, net: { fetch: captureTransport } } as unknown as ToolContext,
      )
      expect(
        (captureTransport.mock.calls[0] as unknown as [unknown, { timeoutMs: number }])[1].timeoutMs,
      ).toBe(95000)
      const stagedPath = join(instances, entry!, 'staging', 'verified.blend')
      const stagedBytes = Buffer.from('verified Blender export')
      await f.fs.write(stagedPath, stagedBytes)
      const destination = join(f.root, 'delivery.blend')
      const exporter = f.contributed.find((t) => t.name === 'agh_blender_export')
      if (!exporter) throw new Error('Missing Blender export')
      const exportContext = (sha256: string) =>
        ({
          ...f.ctx,
          net: {
            fetch: async () =>
              new Response(
                JSON.stringify({
                  ok: true,
                  applied: [{ result: { path: stagedPath, bytes: stagedBytes.length, sha256 } }],
                }),
              ),
          },
        }) as unknown as ToolContext
      expect(await exporter.execute({ destination } as never, exportContext('0'.repeat(64)))).toMatchObject({
        isError: true,
      })
      await expect(f.fs.stat(destination)).rejects.toThrow()
      const digest = createHash('sha256').update(stagedBytes).digest('hex')
      expect(
        (await exporter.execute({ destination } as never, exportContext(digest))).structured,
      ).toMatchObject({ ok: true, sha256: digest })
      expect(await f.fs.read(destination)).toEqual(stagedBytes)
    }
  })
  it('kills an unregistered Blender when startup is cancelled after spawn', async () => {
    const f = await fixture()
    const cancellation = new AbortController()
    const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    const tool = f.contributed.find((t) => t.name === 'agh_blender_start')!
    await expect(
      tool.execute(
        { executable: 'fixture-blender', empty: true } as never,
        {
          ...f.ctx,
          signal: cancellation.signal,
          sandbox: { enforcement: () => 'unavailable', confine: async (argv: string[]) => argv },
          exec: vi.fn(async (argv: string[]) => {
            if (argv[1] !== '--version') cancellation.abort()
            return { code: 0, stdout: argv[1] === '--version' ? 'Blender 4.2.0' : 'GONE', stderr: '' }
          }),
        } as unknown as ToolContext,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalled()
    const instances = join(f.root, '.agh-blender', 'instances')
    for (const entry of await readdir(instances))
      expect(await readdir(join(instances, entry))).not.toContain('instance.json')
  })
  it('reports asynchronous Blender spawn errors without starting a real process', async () => {
    const f = await fixture()
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn(), kill: vi.fn() })
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('fixture spawn denied')))
      return child as unknown as ReturnType<typeof spawn>
    })
    const tool = f.contributed.find((t) => t.name === 'agh_blender_start')!
    const result = await tool.execute(
      { executable: 'fixture-blender', empty: true } as never,
      {
        ...f.ctx,
        sandbox: { enforcement: () => 'unavailable', confine: async (argv: string[]) => argv },
        exec: vi.fn(async (argv: string[]) => ({
          code: 0,
          stdout: argv[1] === '--version' ? 'Blender 4.2.0' : 'GONE',
          stderr: '',
        })),
      } as unknown as ToolContext,
    )
    expect(result.structured).toMatchObject({
      ok: false,
      blockers: expect.arrayContaining([expect.stringContaining('fixture spawn denied')]),
    })
  })
  it('refuses a cancelled Blender start before discovery or process execution', async () => {
    const f = await fixture()
    const cancellation = new AbortController()
    cancellation.abort()
    const exec = vi.fn()
    const tool = f.contributed.find((t) => t.name === 'agh_blender_start')!
    await expect(
      tool.execute(
        { empty: true } as never,
        {
          ...f.ctx,
          signal: cancellation.signal,
          exec,
        } as ToolContext,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(exec).not.toHaveBeenCalled()
  })
  it('publishes verified Blender captures as model-readable artifacts and rejects changed bytes', async () => {
    const entry = '../../agh-blender/extensions/main/capture-artifact.mjs'
    const { publishCapture } = await import(entry)
    const f = await fixture()
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAGElEQVR4nGP4//8/AwyDiX0iIv/hHJgMAAL1Gc497znIAAAAAElFTkSuQmCC',
      'base64',
    )
    const shot = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    await expect(publishCapture(f.ctx, bytes, shot)).resolves.toMatchObject({
      registered: true,
      ref: { sha256: shot.sha256, size: bytes.length, mime: 'image/png' },
    })
    await expect(publishCapture(f.ctx, bytes, { ...shot, sha256: 'a'.repeat(64) })).rejects.toThrow('digest')
    await expect(publishCapture(f.ctx, Buffer.from('invalid-png'), shot)).rejects.toThrow('PNG')
    const truncated = bytes.subarray(0, 40)
    await expect(
      publishCapture(f.ctx, truncated, {
        bytes: truncated.length,
        sha256: createHash('sha256').update(truncated).digest('hex'),
      }),
    ).rejects.toThrow('PNG')
    await expect(publishCapture({ signal: f.ctx.signal }, bytes, shot)).rejects.toThrow(
      'update the AGH runtime',
    )
    expect(f.ctx.artifacts.put).toHaveBeenCalledOnce()
    expect(f.contributed.find((t) => t.name === 'agh_blender_capture')?.meta.returnsImages).toBe(true)
  })
  it('registers valid imported tools and persists UI settings without launching anything', async () => {
    const f = await fixture()
    for (const t of [...f.tools, ...f.contributed]) expect(checkToolDef(t), t.name).toEqual({ ok: true })
    for (const s of f.services.values()) expect(checkServiceDef(s), s.name).toEqual({ ok: true })
    const ctx = f.ctx as unknown as Parameters<ServiceDef['handler']>[1]
    expect(
      await f.services.get('aka.modeling.settings.read')!.handler({ bindingRevision: 1 }, ctx),
    ).toBeNull()
    await f.services.get('aka.modeling.settings.save')!.handler({ bindingRevision: 1, config }, ctx)
    expect(await f.services.get('aka.modeling.settings.read')!.handler({ bindingRevision: 1 }, ctx)).toEqual(
      config,
    )
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it('uses the selected original and actual emitter, renders preview and exports a blend with all four references', async () => {
    const f = await fixture()
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 2, prepareSubject: false }, f.ctx)
    expect(result.isError, JSON.stringify(result.structured)).not.toBe(true)
    expect(result.structured).toMatchObject({
      ok: true,
      stage: 'completed',
      mode: 'single-image-demo',
      scale: 'unknown',
      references: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('observation-4.jpg') }),
      ]),
    })
    expect(f.invoke).toHaveBeenCalledWith(
      'agh_ortho_mesh_run',
      expect.objectContaining({ image_file: join(f.root, 'photos', 'observation-2.jpg') }),
      expect.anything(),
    )
    expect(f.invoke).toHaveBeenCalledWith(
      'agh_blender_start',
      { empty: true, executable: config.blenderExecutable },
      expect.anything(),
    )
    const opsBatches = f.invoke.mock.calls
      .filter((c) => c[0] === 'agh_blender_apply_ops')
      .map((c) => (c[1] as { ops: { op: string }[] }).ops)
    expect(opsBatches[0]?.map((op) => op.op)).toEqual(['mesh.import'])
    expect(opsBatches[1]?.map((op) => op.op)).toEqual(['object.transform'])
    expect(result.content.some((c) => c.type === 'image')).toBe(true)
    const report = result.structured as { reportPath: string; blend: string }
    expect(JSON.parse(await readFile(report.reportPath, 'utf8')).stage).toBe('completed')
    expect(await readFile(report.blend, 'utf8')).toBe('fixture-blend')
  })
  it('does not capture or run generators when required plugins are missing', async () => {
    const f = await fixture()
    f.ctx.tools.list = () => []
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)
    expect(result.isError).toBe(true)
    expect(f.tasks.export).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it('runs the image-to-image subject through mesh and Blender and reuses it without a second generation', async () => {
    const f = await fixture()
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    const first = await buildModel(f.tasks, { taskId: 'task', photoIndex: 2 }, f.ctx)
    expect(first.isError, JSON.stringify(first.structured)).not.toBe(true)
    expect(first.structured).toMatchObject({
      ok: true,
      stage: 'completed',
      subject: { background: 'model-alpha', reused: false },
      references: expect.arrayContaining([
        expect.objectContaining({
          observation: { detections: [{ label: 'box', confidence: 0.9 }], viewpoint: { index: 1 } },
        }),
      ]),
    })
    // Both clients display the last image as the result, and keep the reference inspectable.
    const images = first.content.filter((c) => c.type === 'image')
    expect(images).toHaveLength(2)
    const delivered = first.structured as { preview: { sha256: string }; subject: { sha256: string } }
    expect(images[0]?.ref.sha256).toBe(delivered.subject.sha256)
    expect(images.at(-1)?.ref.sha256).toBe(delivered.preview.sha256)
    expect(delivered.preview.sha256).not.toBe(delivered.subject.sha256)
    expect(f.ctx.progress).toHaveBeenCalledWith(expect.stringContaining('生成网格'))
    expect(f.ctx.progress).toHaveBeenCalledWith(expect.stringContaining('建模产物已保存'))
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledWith({
      images: expect.arrayContaining([expect.objectContaining({ mime: 'image/jpeg' })]),
    })
    expect(f.invoke.mock.calls.find((c) => c[0] === 'agh_ortho_mesh_run')?.[1]).toMatchObject({
      image_file: expect.stringContaining('subject.png'),
    })
    const second = await buildModel(f.tasks, { taskId: 'task', photoIndex: 2 }, f.ctx)
    expect(second.structured).toMatchObject({ ok: true, subject: { reused: true } })
    const imports = f.invoke.mock.calls
      .filter((c) => c[0] === 'agh_blender_apply_ops')
      .flatMap((c) => (c[1] as { ops: { op: string; args: { name?: string } }[] }).ops)
      .filter((op) => op.op === 'mesh.import')
    expect(imports).toHaveLength(2)
    expect(imports[0]?.args.name).not.toBe(imports[1]?.args.name)
    expect(second.structured).toMatchObject({
      visualReview: 'pending_model_comparison',
      exportScope: 'entire_managed_scene',
    })
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
    const report = first.structured as {
      subject: { path: string; sha256: string }
      selectedImageSha256: string
    }
    expect(
      createHash('sha256')
        .update(await f.fs.read(report.subject.path))
        .digest('hex'),
    ).toBe(report.subject.sha256)
    expect(report.subject.sha256).not.toBe(report.selectedImageSha256)
    // A failed local artifact publication must not turn a valid cache into another paid generation.
    vi.mocked(f.ctx.artifacts.put).mockRejectedValueOnce(new Error('artifact unavailable'))
    expect(await buildModel(f.tasks, { taskId: 'task', photoIndex: 2 }, f.ctx)).toMatchObject({
      isError: true,
      structured: { stage: 'prepare-subject' },
    })
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(1)
    const prepared = f.tools.find((t) => t.name === 'aka_prepare_subject')!
    await prepared.execute({ taskId: 'task', photoIndex: 2, force: true }, f.ctx)
    expect(f.ctx.imageGeneration!.subject).toHaveBeenCalledTimes(2)
  })
  it('refuses changed reference views and failed image generation before mesh or Blender execution', async () => {
    const f = await fixture()
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    await f.fs.write(join(f.root, 'photos', 'observation-4.jpg'), 'changed')
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)
    expect(result).toMatchObject({ isError: true, structured: { stage: 'prepare-subject' } })
    expect(f.ctx.imageGeneration!.subject).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
    const g = await fixture()
    await g.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    vi.mocked(g.ctx.imageGeneration!.subject).mockRejectedValue(new Error('IMAGE_BACKGROUND_UNVERIFIED'))
    expect(await buildModel(g.tasks, { taskId: 'task', photoIndex: 1 }, g.ctx)).toMatchObject({
      isError: true,
      structured: { stage: 'prepare-subject', error: 'IMAGE_BACKGROUND_UNVERIFIED' },
    })
    expect(g.invoke).not.toHaveBeenCalled()
  })
  it('reports failed generation and does not launch Blender', async () => {
    const f = await fixture()
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    f.invoke.mockResolvedValue({
      content: [],
      structured: { ok: false, blockers: ['generator unavailable'] },
    })
    const result = await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)
    expect(result).toMatchObject({ isError: true, structured: { ok: false, stage: 'generate-mesh' } })
    expect(f.invoke).toHaveBeenCalledTimes(1)
  })
  it('refuses a truncated preview before exporting a Blender delivery', async () => {
    const f = await fixture(1)
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    const invoke = f.invoke.getMockImplementation()
    if (!invoke) throw new Error('Missing fixture invocation')
    f.invoke.mockImplementation(async (name, args, options) => {
      const result = await invoke(name, args, options)
      if (name === 'agh_blender_apply_ops') {
        const render = (args as { ops: { op: string; args: { path?: string } }[] }).ops.find(
          (op) => op.op === 'render.still',
        )
        if (render?.args.path)
          await f.fs.write(render.args.path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      }
      return result
    })
    expect(await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)).toMatchObject({
      isError: true,
      structured: { stage: 'render-preview' },
    })
    expect(f.invoke.mock.calls.some(([name]) => name === 'agh_blender_export')).toBe(false)
  })
  it('refuses incomplete four-view sets and a changed source photo', async () => {
    const f = await fixture()
    await f.fs.write('.agnes/agh-ortho/mesh-run.json', JSON.stringify(config))
    await f.fs.write(join(f.root, 'photos', 'observation-1.jpg'), 'changed')
    expect((await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)).isError).toBe(true)
    expect(f.invoke).not.toHaveBeenCalled()
    await f.fs.write(f.manifest, JSON.stringify({ kind: 'orbit-partial', photos: [] }))
    expect((await buildModel(f.tasks, { taskId: 'task', photoIndex: 1 }, f.ctx)).isError).toBe(true)
  })
  it('rejects incomplete generator settings', () => {
    expect(() => parseModelingConfig({ ...config, command: ['python'] })).toThrow()
    expect(() => parseModelingConfig({ ...config, upAxis: 'unknown' })).toThrow()
  })
  it('passes the configured executable through the real Blender version check without starting a process', async () => {
    const f = await fixture()
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: '', truncated: false }))
    const start = f.contributed.find((t) => t.name === 'agh_blender_start')
    if (!start) throw new Error('Missing Blender tool')
    const result = await start.execute({ empty: true, executable: config.blenderExecutable }, {
      ...f.ctx,
      exec,
      sandbox: { enforcement: () => ({ level: 'none', scope: [] }) },
    } as unknown as ToolContext)
    expect(exec).toHaveBeenCalledWith(
      config.blenderExecutable ? [config.blenderExecutable, '--version'] : [],
      { timeoutMs: 30000 },
    )
    expect(result.structured).toMatchObject({ ok: false })
  })
})
