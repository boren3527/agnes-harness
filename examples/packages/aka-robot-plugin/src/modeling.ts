import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  PluginExtensionAPI,
  ServiceContext,
  ServiceDef,
  ToolContext,
  ToolResult,
} from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { registerModelReferences } from './model-references.js'
import type { ScanTasks } from './scan-task.js'
import { prepareSubject } from './subject.js'
import { uniqueImageContent } from './tool-images.js'

type Config = {
  generator: string
  command: string[]
  preprocessCommand?: string[]
  output?: string
  upAxis: string
  unit: string
  blenderExecutable?: string
  displayHeight: number
}
type SettingsContext = Pick<ServiceContext, 'session' | 'device' | 'fs' | 'signal'>
const configPath = (root: string) => join(root, '.agnes', 'agh-ortho', 'mesh-run.json')
export function parseModelingConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid modeling configuration')
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'generator',
          'command',
          'preprocessCommand',
          'output',
          'upAxis',
          'unit',
          'blenderExecutable',
          'displayHeight',
        ].includes(k),
    )
  )
    throw new Error('Unknown modeling configuration field')
  const argv = (a: unknown): a is string[] =>
    Array.isArray(a) &&
    a.length > 0 &&
    a.length <= 64 &&
    a.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !s.includes('\0'))
  if (
    typeof v.generator !== 'string' ||
    !v.generator.trim() ||
    v.generator.length > 128 ||
    !argv(v.command) ||
    !v.command.some((s) => s.includes('{image}') || s.includes('{prep}')) ||
    !v.command.some((s) => s.includes('{out}')) ||
    (v.preprocessCommand !== undefined && !argv(v.preprocessCommand)) ||
    !['X', 'Y', 'Z', '-X', '-Y', '-Z'].includes(String(v.upAxis)) ||
    !['m', 'cm', 'mm', 'normalised', 'normalized', 'unitless'].includes(String(v.unit)) ||
    typeof v.displayHeight !== 'number' ||
    !Number.isFinite(v.displayHeight) ||
    v.displayHeight < 0.01 ||
    v.displayHeight > 10
  )
    throw new Error(
      'Generator command needs image/prep and out placeholders, declared axis/unit and demo height',
    )
  for (const k of ['output', 'blenderExecutable'])
    if (
      v[k] !== undefined &&
      (typeof v[k] !== 'string' ||
        !(v[k] as string).trim() ||
        (v[k] as string).length > 4096 ||
        (v[k] as string).includes('\0'))
    )
      throw new Error(`Invalid ${k}`)
  return structuredClone(v) as Config
}
async function scope(ctx: SettingsContext, revision?: number) {
  const binding = await ctx.device?.binding()
  if (
    !ctx.session ||
    !binding?.active ||
    binding.sessionId !== ctx.session.key ||
    (revision !== undefined && revision !== binding.bindingRevision)
  )
    throw new Error('Device modeling scope unavailable')
  ctx.signal.throwIfAborted()
  return ctx.session.workspaceRoot
}
export async function readModelingConfig(ctx: SettingsContext): Promise<Config | null> {
  const path = configPath(await scope(ctx))
  try {
    const stat = await ctx.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > 65536) throw new Error('Modeling configuration too large')
    return parseModelingConfig(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await ctx.fs.read(path))),
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}
const toolsNeeded = [
  'agh_ortho_mesh_run',
  'agh_ortho_emit_ops',
  'agh_ortho_fit',
  'agh_ortho_save',
  'agh_blender_start',
  'agh_blender_apply_ops',
  'agh_blender_scene',
  'agh_blender_export',
]
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid modeling plugin response')
  return v as Record<string, unknown>
}
/** One or four originals prepare one subject image; generated geometry remains an approximation. */
export async function buildModel(
  tasks: Pick<ScanTasks, 'export'>,
  input: { taskId: string; photoIndex: number; prepareSubject?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const runId = `aka-${randomUUID()}`
  let stage = 'preflight'
  const progress = (next: string, message: string) => {
    stage = next
    ctx.progress(message)
  }
  const report: Record<string, unknown> = {
    runId,
    taskId: input.taskId,
    mode: 'single-image-demo',
    scale: 'unknown',
    physicalAccuracy: 'unverified',
  }
  let reportPath: string | undefined
  try {
    const root = await scope(ctx)
    const missing = toolsNeeded.filter((name) => !ctx.tools.list().some((t) => t.name === name))
    if (missing.length) throw new Error(`Enable modeling plugins first: ${missing.join(', ')}`)
    const config = await readModelingConfig(ctx)
    if (!config)
      throw new Error(
        'Configure the existing mesh generator with aka_modeling_configure first; no generator command is invented',
      )
    if (!Number.isInteger(input.photoIndex) || input.photoIndex < 1 || input.photoIndex > 4)
      throw new Error('Photo index must be 1–4')
    const invoke = async (name: string, args: Record<string, unknown>) => {
      ctx.signal.throwIfAborted()
      const result = await ctx.tools.invoke(name, args as Parameters<typeof ctx.tools.invoke>[1], {
        signal: ctx.signal,
      })
      const data = object(result.structured)
      if (result.isError || data.ok !== true)
        throw new Error(`${name}: ${JSON.stringify(data.blockers ?? data).slice(0, 1500)}`)
      return data
    }
    progress('export-photos', '建模 1/6：校验物体原图和观察记录')
    const exported = await tasks.export(input.taskId, ctx)
    const manifestInfo = await ctx.fs.stat(exported.manifest)
    if (manifestInfo.kind !== 'file' || manifestInfo.size > 128 * 1024)
      throw new Error('Invalid photo manifest')
    const manifest = object(JSON.parse(new TextDecoder().decode(await ctx.fs.read(exported.manifest))))
    if (
      !(
        (manifest.kind === 'orbit-four-view' && exported.photoCount === 4) ||
        (manifest.kind === 'object-observation' && exported.photoCount === 1)
      ) ||
      !Array.isArray(manifest.photos) ||
      manifest.photos.length !== exported.photoCount
    )
      throw new Error('Complete a four-view orbit or a model subject checkpoint before building this demo')
    reportPath = join(root, '.agh-device', 'models', runId, 'report.json')
    const photo = object(manifest.photos[input.photoIndex - 1])
    if (photo.name !== `observation-${input.photoIndex}.jpg`) throw new Error('Invalid photo manifest')
    let image = join(exported.directory, photo.name)
    const imageInfo = await ctx.fs.stat(image)
    if (imageInfo.kind !== 'file' || imageInfo.size > 8 * 1024 * 1024)
      throw new Error('Source photo too large')
    const bytes = await ctx.fs.read(image)
    let digest = createHash('sha256').update(bytes).digest('hex')
    const photoRef = object(photo.ref)
    if (digest !== photoRef.sha256 || bytes.length !== photoRef.size) throw new Error('Source photo changed')
    Object.assign(report, {
      selectedImage: image,
      selectedImageSha256: digest,
      references: manifest.photos.map((p: unknown, index: number) => {
        const row = object(p),
          ref = object(row.ref)
        if (row.name !== `observation-${index + 1}.jpg` || typeof ref.sha256 !== 'string')
          throw new Error('Invalid reference image')
        return {
          path: join(exported.directory, row.name as string),
          sha256: ref.sha256,
          observation: row.selection ?? null,
        }
      }),
      displayHeight: config.displayHeight,
      captureManifest: exported.manifest,
      sourceViewCount: exported.photoCount,
    })
    const persist = () => ctx.fs.write(reportPath!, JSON.stringify({ ...report, stage }, null, 2))
    await persist()
    if (input.prepareSubject !== false) {
      progress('prepare-subject', '建模 2/6：改善参考图清晰度并生成透明主体')
      await persist()
      const subject = await prepareSubject(
        ctx,
        exported,
        input.photoIndex,
        join(root, '.agh-device', 'models', runId, 'subject.png'),
      )
      report.subject = { ...subject, artifact: subject.artifact }
      image = subject.path
      digest = subject.sha256
      await persist()
    }
    progress('generate-mesh', '建模 3/6：使用已配置的生成器生成网格')
    const generated = await invoke('agh_ortho_mesh_run', { name: runId, image_file: image })
    const mesh = object(generated.mesh_run)
    if (typeof mesh.mesh_path !== 'string' || typeof mesh.sidecar_path !== 'string')
      throw new Error('Generated mesh paths unavailable')
    report.mesh = mesh.mesh_path
    const sidecar = object(JSON.parse(new TextDecoder().decode(await ctx.fs.read(mesh.sidecar_path))))
    if (
      sidecar.imageSha256 !== digest ||
      !Array.isArray(sidecar.measuredSizeInFile) ||
      sidecar.measuredSizeInFile.length !== 3 ||
      sidecar.measuredSizeInFile.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    )
      throw new Error('Generated mesh provenance or dimensions invalid')
    const size = sidecar.measuredSizeInFile as number[]
    const axis = String(sidecar.upAxis).replace(/^[+-]/, '')
    const axisIndex = ['X', 'Y', 'Z'].indexOf(axis)
    const height = sidecar.declaredHeight
    if (axisIndex < 0 || typeof height !== 'number' || height <= 0 || !Number.isFinite(height))
      throw new Error('Generated mesh height/axis invalid')
    const factor = config.displayHeight / height
    const dims =
      axis === 'X' ? [size[2], size[1], size[0]] : axis === 'Y' ? [size[0], size[2], size[1]] : size
    const leaf = (n: number) => ({ v: n, conf: 0.4 })
    const subjectName = `${runId}_subject`
    const cameraName = `${runId}_camera`
    const lightName = `${runId}_light`
    const params = {
      schema_version: '0.1',
      unit: 'm',
      frame: { up: 'Z', front: '-Y', handed: 'right' },
      projection: 'first_angle',
      assumptions: ['proportions_only'],
      assembly: [
        {
          id: subjectName,
          part: 'body',
          feature: 'mesh',
          at: { v: [0, 0, config.displayHeight / 2], conf: 0.4 },
          path: mesh.mesh_path,
          w: leaf(dims[0]! * factor),
          d: leaf(dims[1]! * factor),
          h: leaf(config.displayHeight),
          source: {
            kind: 'generated_mesh',
            model: config.generator,
            input_image_sha256: digest,
            up_axis: sidecar.upAxis,
            unit: sidecar.unit,
            declared_height: height,
            note: 'Single input image, optionally AIGC subject from reference views. Height is a demo display setting, not measured. Generated details are unverified.',
          },
        },
      ],
    }
    progress('start-blender', '建模 4/6：启动 Blender')
    await invoke('agh_blender_start', {
      empty: true,
      ...(config.blenderExecutable ? { executable: config.blenderExecutable } : {}),
    })
    const priorScene = await invoke('agh_blender_scene', {})
    const priorObjects = object(priorScene.scene).objects
    if (!Array.isArray(priorObjects)) throw new Error('Existing scene readback unavailable')
    const occupied = priorObjects.map(object).flatMap((row) => {
      const max = row.bounds && object(row.bounds).max
      return Array.isArray(max) && typeof max[0] === 'number' && Number.isFinite(max[0]) ? [max[0]] : []
    })
    if (occupied.length) {
      const target = params.assembly[0]
      if (target)
        target.at.v[0] = Math.max(...occupied) + ((dims[0] ?? 0) * factor) / 2 + config.displayHeight
    }
    report.sceneLayout = {
      existingObjectsPreserved: true,
      subjectLocation: params.assembly[0]?.at.v,
      note: 'Display layout in Blender, not a measured physical location.',
    }
    const emission = await invoke('agh_ortho_emit_ops', params)
    if (
      !Array.isArray(emission.ops) ||
      !emission.ops.length ||
      (Array.isArray(emission.unlowered) && emission.unlowered.length)
    )
      throw new Error('Model cannot be imported with current Blender capabilities')
    progress('import-mesh', '建模 5/6：导入模型并核对比例')
    const importOps = emission.ops.map(object).filter((op) => op.op === 'mesh.import')
    const placementOps = emission.ops.map(object).filter((op) => op.op !== 'mesh.import')
    if (importOps.length !== 1) throw new Error('Expected one subject mesh import')
    // A GLB can contain several mesh objects. Preserve their relative positions by
    // joining only this import's new parts before applying the subject placement.
    const imported = await invoke('agh_blender_apply_ops', { ops: importOps })
    const applied = object(imported.result).applied
    if (!Array.isArray(applied)) throw new Error('Import receipt unavailable')
    const importReceipt = applied.map(object).find((v) => v.op === 'mesh.import')
    let importedNames = object(importReceipt?.result).imported
    if (
      !Array.isArray(importedNames) ||
      !importedNames.length ||
      !importedNames.includes(subjectName) ||
      importedNames.some((name) => typeof name !== 'string') ||
      new Set(importedNames).size !== importedNames.length
    )
      throw new Error('Imported subject names unavailable')
    const joined = importedNames.length > 1
    await invoke('agh_blender_apply_ops', {
      ops: [
        ...(joined
          ? [
              {
                op: 'object.join',
                args: {
                  names: [subjectName, ...importedNames.filter((name) => name !== subjectName)],
                  name: subjectName,
                },
              },
            ]
          : []),
        ...placementOps,
      ],
    })
    if (joined) importedNames = [subjectName]
    report.importAssembly = { multipartJoined: joined, subjectName }
    const scene = await invoke('agh_blender_scene', {})
    const objects = object(scene.scene).objects
    if (!Array.isArray(importedNames) || !importedNames.length || !Array.isArray(objects))
      throw new Error('Imported mesh readback unavailable')
    const bounds = objects
      .map(object)
      .filter((o) => importedNames.includes(o.name))
      .map((o) => object(o.bounds))
    if (
      bounds.length !== importedNames.length ||
      bounds.some(
        (b) =>
          !Array.isArray(b.min) ||
          !Array.isArray(b.max) ||
          b.min.length !== 3 ||
          b.max.length !== 3 ||
          [...b.min, ...b.max].some((n) => typeof n !== 'number' || !Number.isFinite(n)),
      )
    )
      throw new Error('Imported world bounds unavailable')
    const low = [0, 1, 2].map((i) => Math.min(...bounds.map((b) => (b.min as number[])[i]!)))
    const high = [0, 1, 2].map((i) => Math.max(...bounds.map((b) => (b.max as number[])[i]!)))
    const center = low.map((n, i) => (n + high[i]!) / 2)
    const span = Math.hypot(...high.map((n, i) => n - low[i]!))
    if (!Number.isFinite(span) || span <= 0 || center.some((n) => !Number.isFinite(n)))
      throw new Error('Invalid scene bounds')
    const preview = join(root, '.agh-device', 'models', runId, 'preview.png')
    progress('render-preview', '建模 6/6：渲染预览并保存工程')
    await invoke('agh_blender_apply_ops', {
      ops: [
        {
          op: 'light.add',
          args: { kind: 'sun', name: lightName, energy: 3, location: [span, -span, span * 2] },
        },
        { op: 'object.look_at', args: { name: lightName, target: center } },
        {
          op: 'camera.add',
          args: {
            name: cameraName,
            type: 'ORTHO',
            ortho_scale: span * 1.2,
            location: [center[0]! + span, center[1]! - span * 2, center[2]! + span],
          },
        },
        { op: 'object.look_at', args: { name: cameraName, target: center } },
        {
          op: 'render.still',
          args: { camera: cameraName, width: 768, height: 768, path: preview, transparent: true },
        },
      ],
    })
    const previewBytes = await ctx.fs.read(preview)
    if (
      previewBytes.length < 45 ||
      previewBytes.length > 8 * 1024 * 1024 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => previewBytes[i] === v) ||
      Buffer.from(previewBytes).toString('ascii', 12, 16) !== 'IHDR' ||
      Buffer.from(previewBytes).toString('ascii', previewBytes.length - 8, previewBytes.length - 4) !== 'IEND'
    )
      throw new Error('Rendered PNG unavailable')
    const ref = await ctx.artifacts.put(previewBytes, { mime: 'image/png', name: 'model-preview.png' })
    report.fit = await invoke('agh_ortho_fit', { ...params, against_scene: true, image_file: image })
    stage = 'export-blend'
    const blend = join(root, '.agh-device', 'models', runId, 'model.blend')
    await invoke('agh_blender_export', { destination: blend, name: runId })
    const saved = await invoke('agh_ortho_save', {
      ...params,
      run_id: runId,
      scene_file: blend,
      mesh_file: mesh.mesh_path,
      image_file: image,
      against_scene: true,
    })
    Object.assign(report, {
      ok: true,
      blend,
      preview: ref,
      orthoReport: saved,
      visualReview: 'pending_model_comparison',
      exportScope: 'entire_managed_scene',
      note: report.subject
        ? `${exported.photoCount}张原图用于 AIGC 主体处理及复核，网格以生成的单张主体图建模；无真实尺寸或重建精度保证。`
        : `${exported.photoCount}张来源原图中选择一张生成演示模型；无真实尺寸或重建精度保证。`,
    })
    stage = 'completed'
    await persist()
    ctx.progress('建模产物已保存：请对照原图检查渲染预览，再判断外形是否通过')
    return {
      content: uniqueImageContent([
        {
          type: 'text',
          text: JSON.stringify({ runId, blend, mesh: report.mesh, report: reportPath, note: report.note }),
        },
        ...(report.subject
          ? [
              {
                type: 'image' as const,
                ref: object(report.subject).artifact as typeof ref,
                mime: 'image/png' as const,
              },
            ]
          : []),
        // Both conversation clients keep the last image as the final preview.
        // The generated reference belongs in the process; deliver the actual Blender render last.
        { type: 'image', ref, mime: 'image/png' },
      ]),
      structured: {
        ...report,
        fit: { verdict: object(report.fit).verdict ?? 'unknown' },
        orthoReport: { run_id: saved.run_id, ok: saved.ok },
        stage,
        reportPath,
      },
    }
  } catch (error) {
    report.ok = false
    report.stage = stage
    report.error = error instanceof Error ? error.message : String(error)
    if (reportPath) await ctx.fs.write(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(report) }], structured: report }
  }
}
export function registerModeling(
  api: PluginExtensionAPI,
  register: (def: ServiceDef) => unknown,
  tasks: Pick<ScanTasks, 'export'>,
) {
  registerModelReferences(api, tasks)
  api.registerTool({
    name: 'aka_modeling_status',
    description:
      '只读检查当前设备会话的网格生成器配置和Blender工具是否具备。不会启动Blender、生成图片或运行生成器。imageGenerationPortAvailable=null表示当前只读调用不能检查执行端口，不表示图片模型未配置；图片设置和key均未核验，不能因此阻止已配置的aka_prepare_subject调用。缺网格生成器时可查agh_ortho_catalog，依据照片用现有基础几何建模，不猜程序路径。实际尺寸未知，成功必须看渲染预览。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute(_input, ctx) {
      const config = await readModelingConfig(ctx)
      const names = new Set(ctx.tools.list().map((tool) => tool.name))
      const state = {
        // Host only lends this effect port to approved mutating calls. Its absence
        // in this read-only invocation says nothing about the saved configuration.
        imageGenerationPortAvailable: typeof ctx.imageGeneration?.subject === 'function' ? true : null,
        imageKeyVerification: 'not_checked',
        meshGeneratorConfigured: config !== null,
        generator: config?.generator ?? null,
        configuredBlenderExecutable: config?.blenderExecutable ?? null,
        missingTools: toolsNeeded.filter((name) => !names.has(name)),
        alternative: config
          ? null
          : 'photo-guided parametric geometry with agh_ortho_catalog and Blender whitelist; dimensions are estimated',
        visualReviewRequired: true,
      }
      return { content: [{ type: 'text', text: JSON.stringify(state) }], structured: state }
    },
  })
  api.registerTool({
    name: 'aka_modeling_configure',
    description:
      '保存已有 3D 网格生成器命令到当前工作区，供 aka_build_model 使用。仅使用用户提供或工作区文档中真实存在的生成器，不猜测程序或路径；不会执行生成器。command 必须含 {image} 或 {prep} 以及 {out}；Blender 可选 executable。',
    parameters: Type.Object(
      {
        config: Type.Object(
          {
            generator: Type.String({ minLength: 1, maxLength: 128 }),
            command: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
              minItems: 1,
              maxItems: 64,
            }),
            preprocessCommand: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
            ),
            output: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
            upAxis: Type.Union([
              Type.Literal('X'),
              Type.Literal('Y'),
              Type.Literal('Z'),
              Type.Literal('-X'),
              Type.Literal('-Y'),
              Type.Literal('-Z'),
            ]),
            unit: Type.Union([
              Type.Literal('m'),
              Type.Literal('cm'),
              Type.Literal('mm'),
              Type.Literal('normalised'),
              Type.Literal('normalized'),
              Type.Literal('unitless'),
            ]),
            displayHeight: Type.Number({ minimum: 0.01, maximum: 10 }),
            blenderExecutable: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'always',
    },
    async execute(input, ctx) {
      const root = await scope(ctx),
        config = parseModelingConfig((input as { config: unknown }).config)
      await ctx.fs.write(configPath(root), JSON.stringify(config, null, 2))
      return {
        content: [{ type: 'text', text: '生成器配置已保存，未执行生成器。' }],
        structured: { configured: true },
      }
    },
  })
  api.registerTool({
    name: 'aka_prepare_subject',
    description:
      '将已完成四视角采样或建模任务当前主体原图交给已配置图片模型，生成清晰透明PNG。photoIndex为主图序号；建模任务单图填1，四视角其余图作参考。没有缓存时上传确切的1张或4张来源并调用一次服务，同组默认复用结果，force=true重新生成。不移动、不生成虚构的实拍视角；AIGC不用于测距或夹取核验。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        photoIndex: Type.Integer({ minimum: 1, maximum: 4 }),
        force: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: { wallMs: 200000 },
      deferLoading: false,
      requiresApproval: 'always',
      returnsImages: true,
    },
    async execute(input, ctx) {
      try {
        const v = input as { taskId: string; photoIndex: number; force?: boolean },
          root = await scope(ctx)
        const exported = await tasks.export(v.taskId, ctx)
        const subject = await prepareSubject(
          ctx,
          exported,
          v.photoIndex,
          join(root, '.agh-device', 'subjects', `${randomUUID()}.png`),
          v.force === true,
        )
        return {
          content: [
            { type: 'text', text: JSON.stringify(subject) },
            { type: 'image', ref: subject.artifact, mime: 'image/png' },
          ],
          structured: subject,
        }
      } catch (error) {
        ctx.signal.throwIfAborted()
        const report = {
          ok: false,
          stage: 'prepare-subject',
          error: error instanceof Error ? error.message : 'Subject preparation failed',
          next: 'Explain the failure briefly. Do not claim an image was prepared or automatically repeat a dispatched request.',
        }
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(report) }],
          structured: report,
        }
      }
    },
  })
  for (const action of ['read', 'save'] as const)
    register({
      name: `aka.modeling.settings.${action}`,
      kind: action === 'save' ? 'effect' : 'query',
      timeoutMs: 5000,
      maxResultBytes: 65536,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bindingRevision: { type: 'integer', minimum: 1 },
          ...(action === 'save' ? { config: { type: 'object' } } : {}),
        },
        required: ['bindingRevision', ...(action === 'save' ? ['config'] : [])],
      },
      outputSchema: { type: ['object', 'null'] },
      async handler(input, ctx) {
        const v = input as { bindingRevision: number; config: unknown }
        const root = await scope(ctx, v.bindingRevision)
        if (action === 'read')
          return (await readModelingConfig(ctx)) as unknown as Awaited<ReturnType<ServiceDef['handler']>>
        const config = parseModelingConfig(v.config)
        await ctx.fs.write(configPath(root), JSON.stringify(config, null, 2))
        return (await readModelingConfig(ctx)) as unknown as Awaited<ReturnType<ServiceDef['handler']>>
      },
    })
  api.registerTool({
    name: 'aka_build_model',
    description:
      '仅用于已配置的网格生成器：原图或透明主体→agh-ortho调度生成及校验→Blender实际预览和工程。先aka_modeling_status检查配置。单图photoIndex=1；prepareSubject=true清理主体（兼容原默认），原图已适合生成器时明确传false，避免不必要的生图。没有生成器不要调用本工具或先花额度准备图片，直接按主体原图使用agh_ortho_surface_ops等已披露的参数能力建模，杯子应有杯壁、开口和把手，不用球体粗模代替其他物体。不猜命令、不移动、不声称真实尺寸。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        photoIndex: Type.Integer({ minimum: 1, maximum: 4 }),
        prepareSubject: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: { wallMs: 600000 },
      deferLoading: false,
      requiresApproval: 'always',
      returnsImages: true,
    },
    execute: (input, ctx) =>
      buildModel(tasks, input as { taskId: string; photoIndex: number; prepareSubject?: boolean }, ctx),
  })
}
