import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { PluginExtensionAPI, ToolContext, ToolDef, ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import type { ScanTasks } from './scan-task.js'

const views = ['front', 'right', 'back', 'left'] as const
type View = (typeof views)[number]
type ImageRef = { sha256: string; size: number; mime: string }
type Plan = {
  directory: string
  description: string
  sourceHash: string
  configuration: string
  attempted: View[]
  pending: Partial<Record<View, Awaited<ReturnType<NonNullable<ToolContext['imageGeneration']>['subject']>>>>
  box?: number[]
  bindingRevision: number
  deviceId: string
  workspaceId: string
  views: Partial<Record<View, { path: string; ref: ImageRef; published: boolean }>>
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'never' as const,
  requiresApproval: 'always' as const,
  deferLoading: false,
  costHint: { wallMs: 200000 },
  returnsImages: true,
}

/** Generated references are kept apart from camera originals and never enter motion/recognition evidence. */
export function registerModelReferences(api: PluginExtensionAPI, tasks: Pick<ScanTasks, 'export'>) {
  const plans = new Map<string, Plan>()
  const readSteps = new Map<string, string>()
  const reading = new Set<string>()
  const planWrites = new WeakMap<Plan, Promise<void>>()
  const key = (ctx: ToolContext, taskId: string) => `${ctx.session.key}/${taskId}`
  const persistPlan = async (ctx: ToolContext, plan: Plan, taskId: string) => {
    const write = (planWrites.get(plan) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await ctx.fs.write(
          join(plan.directory, 'manifest.json'),
          JSON.stringify(
            {
              taskId,
              archiveVersion: 1,
              owner: {
                sessionId: ctx.session.key,
                deviceId: plan.deviceId,
                bindingRevision: plan.bindingRevision,
                workspaceId: plan.workspaceId,
              },
              description: plan.description,
              originalSha256: plan.sourceHash,
              ...(plan.box ? { selectedBox: plan.box } : {}),
              configuration: plan.configuration,
              physicalObservation: false,
              completedViews: views.filter((name) => plan.views[name]?.published),
              views: plan.views,
              attempted: plan.attempted,
            },
            null,
            2,
          ),
        )
        await ctx.fs.write(
          join(plan.directory, '..', 'current.json'),
          JSON.stringify({ id: basename(plan.directory) }),
        )
      })
    planWrites.set(plan, write)
    await write
  }
  const binding = async (ctx: ToolContext, plan?: Plan) => {
    ctx.signal.throwIfAborted()
    const b = await ctx.device?.binding()
    if (
      !b?.active ||
      b.sessionId !== ctx.session.key ||
      (plan &&
        (b.deviceId !== plan.deviceId ||
          b.bindingRevision !== plan.bindingRevision ||
          b.workspaceId !== plan.workspaceId))
    )
      throw new Error('Model reference binding changed')
    return b
  }
  const readImage = async (ctx: ToolContext, row: { path: string; ref: ImageRef }) => {
    const info = await ctx.fs.stat(row.path)
    if (info.kind !== 'file' || info.size !== row.ref.size || info.size > 16 * 1024 * 1024)
      throw new Error('Model reference changed')
    const bytes = await ctx.fs.read(row.path)
    if (bytes.length !== row.ref.size || digest(bytes) !== row.ref.sha256)
      throw new Error('Model reference changed')
    return bytes
  }
  const checkConfiguration = async (ctx: ToolContext, expected: string) => {
    const current = await ctx.imageGeneration?.configuration?.()
    if (JSON.stringify(current ?? null) !== expected)
      throw new Error('Image configuration changed during reference generation; do not mix reference sets')
  }
  const restorePlan = async (ctx: ToolContext, taskId: string, directory: string, sourceHash: string) => {
    const path = join(directory, 'manifest.json')
    let saved: {
      archiveVersion: number
      taskId: string
      originalSha256: string
      owner: { sessionId: string; deviceId: string; bindingRevision: number; workspaceId: string }
      description: string
      configuration: string
      attempted: View[]
      views: Plan['views']
      selectedBox?: number[]
    }
    try {
      const info = await ctx.fs.stat(path)
      if (info.kind !== 'file' || info.size > 64 * 1024) throw new Error('Invalid reference archive')
      const bytes = await ctx.fs.read(path)
      if (bytes.length > 64 * 1024) throw new Error('Invalid reference archive')
      saved = JSON.parse(new TextDecoder().decode(bytes))
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
    const b = await binding(ctx)
    if (
      saved.archiveVersion !== 1 ||
      saved.taskId !== taskId ||
      saved.originalSha256 !== sourceHash ||
      saved.owner?.sessionId !== ctx.session.key ||
      saved.owner?.deviceId !== b.deviceId ||
      saved.owner?.bindingRevision !== b.bindingRevision ||
      saved.owner?.workspaceId !== b.workspaceId ||
      typeof saved.description !== 'string' ||
      !saved.description.trim() ||
      saved.description.length > 2400 ||
      typeof saved.configuration !== 'string' ||
      saved.configuration.length > 2048 ||
      !Array.isArray(saved.attempted) ||
      saved.attempted.length > 4 ||
      saved.attempted.length < 1 ||
      new Set(saved.attempted).size !== saved.attempted.length ||
      saved.attempted.some((v: View) => !views.includes(v)) ||
      !saved.views ||
      typeof saved.views !== 'object' ||
      Object.keys(saved.views).some((v) => !views.includes(v as View))
    )
      throw new Error('Reference archive identity changed; do not regenerate automatically')
    const id = digest(
      new TextEncoder().encode(
        JSON.stringify({
          source: sourceHash,
          box: saved.selectedBox,
          description: saved.description,
          configuration: JSON.parse(saved.configuration),
        }),
      ),
    )
    if (id !== basename(directory)) throw new Error('Reference archive parameters changed')
    const plan: Plan = {
      directory,
      description: saved.description,
      sourceHash,
      configuration: saved.configuration,
      attempted: [...saved.attempted],
      pending: {},
      ...(saved.selectedBox ? { box: saved.selectedBox } : {}),
      bindingRevision: b.bindingRevision,
      deviceId: b.deviceId,
      workspaceId: b.workspaceId,
      views: {},
    }
    for (const name of views) {
      const row = saved.views[name]
      if (!row) continue
      if (
        !saved.attempted.includes(name) ||
        !/^[a-f0-9]{64}$/.test(row.ref?.sha256) ||
        !Number.isSafeInteger(row.ref?.size) ||
        row.ref.size < 8 ||
        row.ref.size > 16 * 1024 * 1024 ||
        row.ref.mime !== 'image/png' ||
        typeof row.published !== 'boolean'
      )
        throw new Error('Invalid reference image archive')
      const restored = { path: join(directory, `${name}.png`), ref: row.ref, published: row.published }
      plan.views[name] = restored
      await readImage(ctx, restored)
    }
    await binding(ctx, plan)
    return plan
  }
  const singleView: ToolDef = {
    name: 'aka_generate_reference_view',
    description:
      '先看摄像头原图，详细描述用户指定主体的形状、部件、材质、颜色、比例和可见细节，再生成建模参考图。先front，再right、back、left，每次调用只生成一张，用同一description，原图及已生成正面作身份参考。四张是图片模型推测的不同角度，不是小车实拍，不用于测距或抓取。必须四张生成完成并逐张分析再调用agh_ortho/agh_blender建模；图片失败就说明原因，不跳到球体方块粗模。无移动，无夹爪动作。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        view: Type.Union(views.map((v) => Type.Literal(v))),
        description: Type.String({ minLength: 20, maxLength: 2400 }),
      },
      { additionalProperties: false },
    ),
    meta,
    async execute(input, ctx): Promise<ToolResult> {
      const v = input as { taskId: string; view: View; description: string }
      let stage = 'read-original'
      try {
        if (!views.includes(v.view) || !v.description?.trim() || v.description.length > 2400)
          throw new Error('Invalid modeling view')
        const b = await binding(ctx)
        const exported = await tasks.export(v.taskId, ctx)
        const info = await ctx.fs.stat(exported.manifest)
        if (info.kind !== 'file' || info.size > 128 * 1024) throw new Error('Invalid camera manifest')
        const manifest = JSON.parse(new TextDecoder().decode(await ctx.fs.read(exported.manifest)))
        if (
          manifest.kind !== 'object-observation' ||
          exported.photoCount !== 1 ||
          manifest.photos?.length !== 1
        )
          throw new Error('Capture and describe the current subject first')
        const source = manifest.photos[0]
        if (
          source.name !== 'observation-1.jpg' ||
          !/^[a-f0-9]{64}$/.test(source.ref?.sha256) ||
          !Number.isSafeInteger(source.ref?.size) ||
          source.ref.size < 1 ||
          source.ref.size > 8 * 1024 * 1024
        )
          throw new Error('Invalid original camera photo')
        const bytes = await readImage(ctx, { path: join(exported.directory, source.name), ref: source.ref })
        const box = manifest.subject?.box as number[] | undefined
        if (
          box !== undefined &&
          (!Array.isArray(box) ||
            box.length !== 4 ||
            !box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
            (box[2] ?? 0) <= (box[0] ?? 0) ||
            (box[3] ?? 0) <= (box[1] ?? 0))
        )
          throw new Error('Invalid selected object box')
        const configuration = await ctx.imageGeneration?.configuration?.()
        if (configuration && !configuration.enabled) throw new Error('IMAGE_NOT_CONFIGURED')
        const configurationKey = JSON.stringify(configuration ?? null)
        const id = digest(
          new TextEncoder().encode(
            JSON.stringify({
              source: source.ref.sha256,
              box,
              description: v.description,
              configuration: configuration ?? null,
            }),
          ),
        )
        let plan = plans.get(key(ctx, v.taskId))
        if (
          !plan ||
          plan.sourceHash !== source.ref.sha256 ||
          plan.configuration !== configurationKey ||
          plan.description !== v.description ||
          JSON.stringify(plan.box) !== JSON.stringify(box)
        ) {
          if (v.view !== 'front')
            throw new Error('Generate front first using the same detailed description for all four views')
          plan = (await restorePlan(
            ctx,
            v.taskId,
            join(exported.directory, 'generated-references', id),
            source.ref.sha256,
          )) ?? {
            directory: join(exported.directory, 'generated-references', id),
            description: v.description,
            sourceHash: source.ref.sha256,
            configuration: configurationKey,
            attempted: [],
            pending: {},
            ...(box ? { box: [...box] } : {}),
            bindingRevision: b.bindingRevision,
            deviceId: b.deviceId,
            workspaceId: b.workspaceId,
            views: {},
          }
          plans.set(key(ctx, v.taskId), plan)
        }
        await binding(ctx, plan)
        const cached = plan.views[v.view]
        if (cached) {
          await checkConfiguration(ctx, plan.configuration)
          stage = 'publish-reference'
          const ref = await ctx.artifacts.put(await readImage(ctx, cached), { mime: 'image/png' })
          if (ref.sha256 !== cached.ref.sha256 || ref.size !== cached.ref.size || ref.mime !== 'image/png')
            throw new Error('Published reference differs from the saved image')
          cached.published = true
          await persistPlan(ctx, plan, v.taskId)
          await binding(ctx, plan)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  view: v.view,
                  path: cached.path,
                  reused: true,
                  physicalObservation: false,
                }),
              },
              { type: 'image', ref: cached.ref, mime: 'image/png' },
            ],
            structured: { view: v.view, path: cached.path, reused: true, physicalObservation: false },
          }
        }
        if (!ctx.imageGeneration) throw new Error('IMAGE_NOT_CONFIGURED')
        if (!plan.pending[v.view] && plan.attempted.includes(v.view))
          throw new Error(
            'Reference request was already dispatched without a saved image. Do not dispatch it again; inspect its recorded failure or update the image configuration first.',
          )
        const images: { bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' }[] = [
          { bytes, mime: 'image/jpeg' },
        ]
        if (v.view !== 'front') {
          const front = plan.views.front
          if (!front) throw new Error('Generate and inspect the front reference first')
          images.push({ bytes: await readImage(ctx, front), mime: 'image/png' })
        }
        stage = 'generate-view'
        await checkConfiguration(ctx, plan.configuration)
        if (!plan.pending[v.view]) {
          if (!plan.attempted.includes(v.view)) plan.attempted.push(v.view)
          // Persist admission before sending a paid request, including across worker restarts.
          await persistPlan(ctx, plan, v.taskId)
        }
        ctx.progress(`正在生成${{ front: '正面', right: '右侧', back: '背面', left: '左侧' }[v.view]}参考图…`)
        const generated =
          plan.pending[v.view] ??
          (await ctx.imageGeneration.subject({
            images,
            ...(box ? { subjectBox: box } : {}),
            view: v.view,
            description: v.description,
          }))
        await checkConfiguration(ctx, plan.configuration)
        await binding(ctx, plan)
        if (
          generated.mime !== 'image/png' ||
          generated.bytes.length < 8 ||
          generated.bytes.length > 16 * 1024 * 1024 ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => generated.bytes[i] === n)
        )
          throw new Error('Invalid generated reference')
        plan.pending[v.view] = generated
        const path = join(plan.directory, `${v.view}.png`)
        stage = 'save-reference'
        await ctx.fs.write(path, generated.bytes)
        const cachedRow = {
          path,
          ref: { sha256: digest(generated.bytes), size: generated.bytes.length, mime: 'image/png' },
          published: false,
        }
        plan.views[v.view] = cachedRow
        await persistPlan(ctx, plan, v.taskId)
        delete plan.pending[v.view]
        stage = 'publish-reference'
        const ref = await ctx.artifacts.put(generated.bytes, { mime: 'image/png' })
        if (
          ref.sha256 !== cachedRow.ref.sha256 ||
          ref.size !== cachedRow.ref.size ||
          ref.mime !== 'image/png'
        )
          throw new Error('Published reference differs from the saved image')
        cachedRow.published = true
        const report = {
          taskId: v.taskId,
          description: plan.description,
          originalSha256: plan.sourceHash,
          ...(plan.box ? { selectedBox: plan.box } : {}),
          view: v.view,
          path,
          model: generated.model,
          background: generated.background,
          physicalObservation: false,
          inferredUnseenSurfaces: v.view !== 'front',
          completedViews: views.filter((name) => plan.views[name]?.published),
          next:
            views.find((name) => !plan.views[name]?.published) ??
            'read all four references, then model with agh_ortho/agh_blender and compare rendered views',
        }
        await persistPlan(ctx, plan, v.taskId)
        await binding(ctx, plan)
        return {
          content: [
            { type: 'text', text: JSON.stringify(report) },
            { type: 'image', ref, mime: 'image/png' },
          ],
          structured: report,
        }
      } catch (error) {
        ctx.signal.throwIfAborted()
        const report = {
          ok: false,
          stage,
          error: error instanceof Error ? error.message : 'Reference generation failed',
          recovery:
            stage === 'save-reference' || stage === 'publish-reference' ? 'local_only' : 'inspect_failure',
          next:
            stage === 'save-reference' || stage === 'publish-reference'
              ? 'Repeat the same arguments only to recover retained/saved bytes. The tool refuses a previously dispatched request with no saved result; do not force another paid request or claim four complete views.'
              : 'Report this failure clearly. Do not claim four views exist, do not automatically retry a sent image request, and do not substitute a crude primitive model.',
        }
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(report) }],
          structured: report,
        }
      }
    },
  }
  api.registerTool(singleView)
  api.registerTool({
    name: 'aka_generate_reference_views',
    description:
      '仅在复杂外形需要图片辅助时生成四角度参考：先确定正面，再并行生成右侧、背面、左侧，保持同一主体描述与正面身份参考。不移动小车。只返回完成情况，之后aka_read_reference_views offset=0、2逐组查看四张图片。建模以agh_ortho参数和六视图校验为主，不用生图代替几何校验。任一失败如实说明，不自动重试或启动粗模。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        description: Type.String({ minLength: 20, maxLength: 2400 }),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, returnsImages: false, costHint: { wallMs: 400000 } },
    async execute(input, ctx) {
      const v = input as { taskId: string; description: string }
      const front = await singleView.execute({ ...v, view: 'front' }, ctx)
      const results: ToolResult[] = [front]
      if (!front.isError) {
        const settled = await Promise.allSettled(
          views.slice(1).map((view) => singleView.execute({ ...v, view }, ctx)),
        )
        for (const row of settled)
          results.push(
            row.status === 'fulfilled'
              ? row.value
              : { isError: true, content: [{ type: 'text', text: 'Reference operation interrupted' }] },
          )
      }
      ctx.signal.throwIfAborted()
      const ok = results.length === 4 && results.every((result) => !result.isError)
      const report = {
        ok,
        views: results.map((result, index) => ({
          view: views[index],
          ok: !result.isError,
          result: result.structured ?? null,
        })),
        next: ok
          ? 'Read reference views offset=0 then offset=2; use agh_ortho geometry and verify the actual Blender render.'
          : 'Report failed references; do not repeat image requests automatically.',
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(report) }],
        structured: report,
        ...(ok ? {} : { isError: true }),
      }
    },
  })
  api.registerTool({
    name: 'aka_read_reference_views',
    description:
      '四张建模参考生成后分两步读图：offset=0看正面与右侧，下一步offset=2看背面与左侧；逐组分析形状和比例，交给agh_ortho/agh_blender建模。不得同一步读两组挤掉图片。只有四张都成功才可读取；重启后可恢复新格式档案，会核对原图、会话、设备绑定和图片摘要。只读归档图片，不移动、不拍照、不生成图片。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        offset: Type.Union([Type.Literal(0), Type.Literal(2)]),
      },
      { additionalProperties: false },
    ),
    meta: {
      ...meta,
      isReadOnly: true,
      isOpenWorld: false,
      requiresApproval: 'never',
      replay: 'safe',
      costHint: undefined,
    },
    async execute(input, ctx) {
      const v = input as { taskId: string; offset: 0 | 2 }
      if (![0, 2].includes(v.offset)) throw new Error('Invalid reference group')
      let plan = plans.get(key(ctx, v.taskId))
      if (!plan) {
        const exported = await tasks.export(v.taskId, ctx)
        const manifestInfo = await ctx.fs.stat(exported.manifest)
        if (manifestInfo.kind !== 'file' || manifestInfo.size > 128 * 1024)
          throw new Error('Invalid camera manifest')
        const sourceBytes = await ctx.fs.read(exported.manifest)
        if (sourceBytes.length > 128 * 1024) throw new Error('Invalid camera manifest')
        const source = JSON.parse(new TextDecoder().decode(sourceBytes))
        if (source.kind !== 'object-observation' || source.photos?.length !== 1)
          throw new Error('Invalid camera archive')
        const photo = source.photos[0]
        if (
          photo?.name !== 'observation-1.jpg' ||
          !/^[a-f0-9]{64}$/.test(photo.ref?.sha256) ||
          !Number.isSafeInteger(photo.ref?.size) ||
          photo.ref.size < 1 ||
          photo.ref.size > 8 * 1024 * 1024
        )
          throw new Error('Invalid original camera photo')
        await readImage(ctx, { path: join(exported.directory, photo.name), ref: photo.ref })
        const pointerPath = join(exported.directory, 'generated-references', 'current.json')
        const info = await ctx.fs.stat(pointerPath)
        if (info.kind !== 'file' || info.size > 1024) throw new Error('Invalid reference index')
        const pointerBytes = await ctx.fs.read(pointerPath)
        if (pointerBytes.length > 1024) throw new Error('Invalid reference index')
        const pointer = JSON.parse(new TextDecoder().decode(pointerBytes))
        if (!/^[a-f0-9]{64}$/.test(pointer.id)) throw new Error('Invalid reference index')
        plan = await restorePlan(
          ctx,
          v.taskId,
          join(exported.directory, 'generated-references', pointer.id),
          source.photos[0].ref?.sha256,
        )
        if (plan && JSON.stringify(plan.box) !== JSON.stringify(source.subject?.box))
          throw new Error('Reference archive selected subject changed')
        if (plan) plans.set(key(ctx, v.taskId), plan)
      }
      if (!plan || !views.every((name) => plan.views[name]?.published))
        throw new Error('Four complete generated reference views are required')
      await binding(ctx, plan)
      if (!Number.isSafeInteger(ctx.session.turn) || !Number.isSafeInteger(ctx.session.step))
        throw new Error('Runtime image-step identity unavailable')
      const stamp = `${ctx.session.turn}/${ctx.session.step}`
      if (readSteps.get(ctx.session.key) === stamp || reading.has(ctx.session.key))
        throw new Error('Analyze one reference group before reading another in the next inference step')
      reading.add(ctx.session.key)
      try {
        const content: ToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify({
              description: plan.description,
              physicalObservation: false,
              originalSha256: plan.sourceHash,
              nextOffset: v.offset === 0 ? 2 : null,
            }),
          },
        ]
        for (const name of views.slice(v.offset, v.offset + 2)) {
          const row = plan.views[name]
          if (!row) throw new Error('Missing generated reference')
          const ref = await ctx.artifacts.put(await readImage(ctx, row), { mime: 'image/png' })
          if (ref.sha256 !== row.ref.sha256 || ref.size !== row.ref.size || ref.mime !== 'image/png')
            throw new Error('Published reference differs from the saved image')
          content.push(
            {
              type: 'text',
              text: JSON.stringify({ view: name, path: row.path, physicalObservation: false }),
            },
            { type: 'image', ref: row.ref, mime: 'image/png' },
          )
        }
        await binding(ctx, plan)
        readSteps.set(ctx.session.key, stamp)
        return {
          content,
          structured: {
            directory: plan.directory,
            views: plan.views,
            description: plan.description,
            physicalObservation: false,
            nextOffset: v.offset === 0 ? 2 : null,
          },
        }
      } finally {
        reading.delete(ctx.session.key)
      }
    },
  })
}
