import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginExtensionAPI, ToolContext, ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import type { CaptureDependencies } from './capture-frame.js'
import { capturePhoto } from './capture-tool.js'
import { readRegistration } from './connection-profile.js'
import { runDeviceControl } from './control-services.js'
import { AkaProtocolError } from './protocol.js'
import type { ScanTasks } from './scan-task.js'
import { uniqueImageContent } from './tool-images.js'

/** Operator observations for this car/floor; deliberately not a linear speed/distance model. */
export const DEMO_MOTION = Object.freeze({
  forward_3cm: { action: 'up' as const, speed: 30, milliseconds: 500, approximateCentimeters: 3 },
  forward_5cm: { action: 'up' as const, speed: 30, milliseconds: 700, approximateCentimeters: 5 },
  forward_10cm: { action: 'up' as const, speed: 30, milliseconds: 1000, approximateCentimeters: 10 },
})
type Goal = 'find_tennis' | 'pickup_tennis' | 'model_object' | 'model_tennis'
type Phase =
  | 'searching'
  | 'await_target'
  | 'target_missing'
  | 'aligning'
  | 'found'
  | 'not_found'
  | 'await_reference'
  | 'verifying_grab'
  | 'await_release'
  | 'released'
  | 'ready_model'
  | 'failed'
  | 'interrupted'
  | 'unknown'
type Scope = {
  deviceId: string
  sessionId: string
  workspaceId: string
  bindingRevision: number
  configRevision: number
  instanceId: string
  generation: number
  mediaGeneration: number
}
type Photo = {
  ref: { sha256: string; size: number; mime: string }
  selection: Record<string, unknown>
  motion: unknown
}
type Entry = Scope & {
  workflowId: string
  goal: Goal
  phase: Phase
  searchTurns: number
  adjustments: number
  forwards: number
  backwards: number
  motionHistory: {
    action: string
    speed: number
    milliseconds: number
    beforeFrameId: string
    afterFrameId: string | null
    summary: string
    receipt?: unknown
  }[]
  reference?: Reference
  referenceImage?: Photo['ref']
  photos: Photo[]
  lastFrameId: string
  note: string
  capturedAt: number
  lastActionReceipt?: unknown
  postActionPhotoAvailable?: boolean
  pickupConfirmedTurn?: number
  startedTurn: number
  foundTurn?: number
  subject?: { box: number[]; description: string }
}
type Decision =
  | 'observe'
  | 'not_found'
  | 'found'
  | 'align_left'
  | 'align_right'
  | keyof typeof DEMO_MOTION
  | 'grab'
  | 'gone'
  | 'still_visible'
  | 'release'
  | 'capture_subject'
  | 'back_up'
type Step = {
  workflowId: string
  frameId: string
  decision: Decision
  box?: number[]
  milliseconds?: number
  summary?: string
}
type Reference = {
  version: 1
  deviceId: string
  width: number
  height: number
  minWidthRatio: number
  maxWidthRatio: number
  minHeightRatio: number
  maxHeightRatio: number
  minCenterY?: number
  maxCenterY?: number
  imageFile?: 'reference.png'
  note?: string
}
const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  requiresApproval: 'never' as const,
  deferLoading: false,
  costHint: undefined,
  returnsImages: true,
}

/** Bounded checkpoints, with model interpretation outside the plugin. No retained invocation or background motion. */
export class DemoWorkflows {
  private readonly entries = new Map<string, Entry>()
  private readonly active = new Map<string, { sessionId: string; controller: AbortController }>()
  private readonly scenarios = new Map<string, { turn: number; goal: Goal | 'surround' }>()
  constructor(private readonly deps: CaptureDependencies) {}
  private selectScenario(goal: Goal | 'surround', ctx: ToolContext) {
    const turn = ctx.session.turn
    if (!Number.isSafeInteger(turn) || (turn ?? -1) < 0)
      throw new AkaProtocolError('Runtime user-turn identity unavailable; update AGH first')
    const previous = this.scenarios.get(ctx.session.key)
    if (previous && previous.turn === turn && previous.goal !== goal)
      throw new AkaProtocolError(
        'Keep this user turn in its selected case; wait for a new user request before another case',
      )
    if (previous && previous.turn === turn && goal === 'surround')
      throw new AkaProtocolError(
        'Surroundings sampling already started in this turn; read its photos and summarize instead of turning again',
      )
    this.scenarios.set(ctx.session.key, { turn: turn as number, goal })
    return turn as number
  }
  async surround(ctx: ToolContext, scans: ScanTasks) {
    let selected = false
    try {
      const scope = await this.scope(ctx)
      if (this.active.has(scope.deviceId) || this.deps.busy.has(scope.deviceId))
        throw new AkaProtocolError('Demo busy')
      const prior = this.entries.get(scope.deviceId)
      if (prior && ['unknown', 'verifying_grab', 'await_release'].includes(prior.phase))
        throw new AkaProtocolError('Stop or finish the pending action before surroundings sampling')
      this.selectScenario('surround', ctx)
      selected = true
      this.interrupt(ctx.session.key, scope.deviceId)
      return await scans.scan(
        { views: 8, direction: 'left' },
        ctx,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'surround',
      )
    } catch (error) {
      // ScanTasks returns failures after starting a scan as a ToolResult. These
      // protocol exceptions are admission failures, before any movement starts.
      if (!(error instanceof AkaProtocolError)) throw error
      if (selected) this.scenarios.delete(ctx.session.key)
      const state = { state: 'not-started', reason: error.message, movementDispatched: false }
      return { isError: true, structured: state, content: [{ type: 'text', text: JSON.stringify(state) }] }
    }
  }
  owns(workflowId: string) {
    return [...this.entries.values()].some((e) => e.workflowId === workflowId)
  }
  latest(sessionId: string | undefined, deviceId: string, bindingRevision: number) {
    const entry = this.entries.get(deviceId.toLowerCase())
    return entry && entry.sessionId === sessionId && entry.bindingRevision === bindingRevision
      ? {
          workflowId: entry.workflowId,
          goal: entry.goal,
          phase: entry.phase,
          searchTurns: entry.searchTurns,
          frameId: entry.lastFrameId,
          photoCount: entry.photos.length,
          note: entry.note,
          motionHistory: entry.motionHistory.map((motion) => ({ ...motion })),
        }
      : null
  }
  interrupt(sessionId: string | undefined, deviceId?: string) {
    for (const [id, entry] of this.entries) {
      if ((!deviceId || id === deviceId) && (!sessionId || entry.sessionId === sessionId)) {
        entry.phase = 'interrupted'
        this.active.get(id)?.controller.abort()
      }
    }
  }
  guardModelRelease(sessionId: string, deviceId: string, turn: number | undefined, fromModel = true) {
    const entry = this.entries.get(deviceId.toLowerCase())
    if (
      entry?.sessionId === sessionId &&
      entry.pickupConfirmedTurn !== undefined &&
      (fromModel || turn !== undefined) &&
      (!Number.isSafeInteger(turn) || (turn ?? 0) <= entry.pickupConfirmedTurn)
    )
      throw new AkaProtocolError(
        'Wait for a new user release prompt; release cannot run in the pickup confirmation turn',
      )
  }
  guardModelAction(
    sessionId: string,
    deviceId: string,
    turn: number | undefined,
    fromModel: boolean,
    workflow?: string,
  ) {
    if (!fromModel) return
    const scenario = this.scenarios.get(sessionId)
    const entry = this.entries.get(deviceId.toLowerCase())
    if (
      entry?.sessionId === sessionId &&
      entry.goal === 'model_object' &&
      entry.startedTurn === turn &&
      entry.phase !== 'interrupted'
    )
      throw new AkaProtocolError(
        'Modeling from a stationary camera prohibits motor and gripper actions; use photographs and Blender only',
      )
    // Only internal workflow calls carry this identity; tool/service inputs cannot set it.
    // Keep the stationary-camera prohibition above, including internal scan attempts.
    if (workflow === 'surround' && scenario?.goal === 'surround' && scenario.turn === turn) return
    if (
      workflow &&
      entry?.workflowId === workflow &&
      entry.sessionId === sessionId &&
      this.active.has(deviceId.toLowerCase())
    )
      return
    if (
      scenario &&
      scenario.turn === turn &&
      (scenario.goal !== 'find_tennis' || entry?.startedTurn === turn)
    )
      throw new AkaProtocolError(
        'Use the selected case workflow; do not bypass it with direct controls or automatically approach after finding a ball. Stop remains available.',
      )
  }
  private async scope(ctx: ToolContext, requireCamera = true): Promise<Scope> {
    ctx.signal.throwIfAborted()
    this.deps.api.ctx.signal.throwIfAborted()
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device)
      throw new AkaProtocolError('Demo device unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations)
    const runtime = registration && this.deps.pool.find(registration)
    const owner = this.deps.owners.get(binding.deviceId.toLowerCase())
    const state = runtime?.snapshot()
    if (
      !registration ||
      owner?.sessionId !== ctx.session.key ||
      owner.workspaceId !== binding.workspaceId ||
      owner.bindingRevision !== binding.bindingRevision ||
      owner.revoked?.aborted
    )
      throw new AkaProtocolError(
        'Device binding or ownership changed; reconnect this session before continuing',
      )
    if (state?.connection !== 'connected')
      throw new AkaProtocolError(
        `Device connection is ${state?.connection ?? 'unavailable'}; reconnect before continuing`,
      )
    if (requireCamera && state.media !== 'streaming')
      throw new AkaProtocolError(`Camera stream is ${state.media}; restore live camera before continuing`)
    if (state.control.phase !== 'idle')
      throw new AkaProtocolError(
        `Prior device action is ${state.control.phase}; finish or confirm stop before continuing; do not retry movement`,
      )
    return {
      deviceId: binding.deviceId.toLowerCase(),
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      bindingRevision: binding.bindingRevision,
      configRevision: registration.configRevision,
      instanceId: state.instanceId,
      generation: state.generation,
      mediaGeneration: state.mediaGeneration,
    }
  }
  private async check(entry: Entry, ctx: ToolContext, requireCamera = true) {
    const current = await this.scope(ctx, requireCamera)
    if (
      (Object.keys(current) as (keyof Scope)[]).some(
        (key) => (requireCamera || key !== 'mediaGeneration') && current[key] !== entry[key],
      )
    )
      throw new AkaProtocolError('Demo scope changed')
    return current
  }
  private async photo(entry: Entry, ctx: ToolContext, motion: unknown = null, fresh = false) {
    if (entry.photos.length >= 64) throw new AkaProtocolError('Demo photo limit reached')
    await this.check(entry, ctx)
    ctx.progress('正在拍照观察…')
    const result = await capturePhoto(this.deps, ctx, {
      bindingRevision: entry.bindingRevision,
      configRevision: entry.configRevision,
      ...(fresh ? { afterReceivedAt: performance.now() } : {}),
    })
    const image = result.content.find((block) => block.type === 'image')
    const selection = result.structured as Record<string, unknown>
    if (image?.type !== 'image' || typeof selection?.frameId !== 'string')
      throw new AkaProtocolError('Demo original unavailable')
    entry.photos.push({ ref: { ...image.ref }, selection: { ...selection }, motion })
    entry.lastFrameId = selection.frameId
    entry.capturedAt = performance.now()
  }
  private result(entry: Entry): ToolResult {
    const state = {
      workflowId: entry.workflowId,
      goal: entry.goal,
      phase: entry.phase,
      searchTurns: entry.searchTurns,
      maxSearchTurns: 6,
      adjustments: entry.adjustments,
      forwards: entry.forwards,
      backwards: entry.backwards,
      motionHistory: entry.motionHistory.map((motion) => ({ ...motion })),
      graspReference: entry.reference ?? null,
      photoCount: entry.photos.length,
      frameId: entry.lastFrameId,
      note: entry.note,
      physicalResult: 'unverified',
      ...(entry.lastActionReceipt ? { lastActionReceipt: entry.lastActionReceipt } : {}),
      ...(entry.postActionPhotoAvailable === undefined
        ? {}
        : { postActionPhotoAvailable: entry.postActionPhotoAvailable }),
      next:
        entry.phase === 'await_release'
          ? 'wait_for_user_release_prompt'
          : entry.phase === 'ready_model'
            ? 'Use agh_ortho surface parameters and six-view review first; optional complex-shape references via aka_generate_reference_views; actual camera render through agh_blender_capture'
            : entry.phase === 'found'
              ? 'report_found_and_ask_whether_to_approach; wait for a new user request'
              : entry.phase === 'target_missing'
                ? 'report_current_target_missing; ask user to find it first; no movement'
                : ['searching', 'await_target', 'aligning', 'verifying_grab'].includes(entry.phase)
                  ? 'analyze these originals, then aka_demo_step using this frameId'
                  : null,
    }
    return {
      structured: state,
      // Use the kernel's existing end-of-turn contract so successful pickup cannot
      // immediately be followed by a model-generated release in the same loop.
      // Finding/missing a target closes the workflow, but leaves one assistant
      // inference for the requested user-facing summary. Case guards prevent motion.
      ...(entry.phase === 'await_release' ? { terminate: true } : {}),
      content: uniqueImageContent([
        ...(entry.phase === 'found'
          ? [
              {
                type: 'text' as const,
                text: `找到了网球。${entry.note} 是否需要接近抓取？等待新的用户指令，不继续转向或抓取。`,
              },
            ]
          : []),
        ...(entry.phase === 'await_release'
          ? [
              {
                type: 'text' as const,
                text: '已抓起网球，等你让我释放。',
              },
            ]
          : []),
        { type: 'text', text: JSON.stringify(state) },
        ...(entry.postActionPhotoAvailable === false ? [] : entry.photos.slice(-2)).flatMap((p) => [
          { type: 'text' as const, text: JSON.stringify({ selection: p.selection, motion: p.motion }) },
          { type: 'image' as const, ref: { ...p.ref }, mime: 'image/jpeg' },
        ]),
        ...(entry.referenceImage
          ? [
              {
                type: 'text' as const,
                text: 'Operator-confirmed successful pickup reference screenshot. Compare camera content and occupancy, not the surrounding UI. Its reported 12–13 cm is not a current distance measurement.',
              },
              { type: 'image' as const, ref: { ...entry.referenceImage }, mime: 'image/png' },
            ]
          : []),
      ]).map((block) =>
        entry.phase === 'found' &&
        block.type === 'image' &&
        block.ref.sha256 === entry.photos.at(-1)?.ref.sha256
          ? { type: 'ref' as const, ref: block.ref, mime: block.mime }
          : block,
      ),
    }
  }
  async start(goal: Goal, ctx: ToolContext, previous?: string) {
    if (!['find_tennis', 'pickup_tennis', 'model_object', 'model_tennis'].includes(goal))
      throw new AkaProtocolError('Invalid demo goal')
    // Preserve the old tool argument as an alias, without its former automatic ball search.
    if (goal === 'model_tennis') goal = 'model_object'
    const scope = await this.scope(ctx)
    if (this.active.has(scope.deviceId) || this.deps.busy.has(scope.deviceId))
      throw new AkaProtocolError('Demo busy')
    const prior = this.entries.get(scope.deviceId)
    if (prior?.phase === 'unknown')
      throw new AkaProtocolError('Stop or recover the unknown prior demo before starting another')
    if (prior && ['verifying_grab', 'await_release'].includes(prior.phase))
      throw new AkaProtocolError(
        'Finish pickup verification and wait for the user release prompt before a new demo',
      )
    if (
      previous &&
      (!prior ||
        prior.workflowId !== previous ||
        prior.sessionId !== scope.sessionId ||
        !['found', 'released'].includes(prior.phase))
    )
      throw new AkaProtocolError('Prior demo result unavailable')
    if (previous && prior) await this.check(prior, ctx, prior.phase !== 'released')
    if (
      prior?.foundTurn !== undefined &&
      (!Number.isSafeInteger(ctx.session.turn) || (ctx.session.turn ?? 0) <= prior.foundTurn)
    )
      throw new AkaProtocolError(
        'Wait for a new user request after reporting the found ball; do not automatically approach or restart search',
      )
    const startedTurn = this.selectScenario(goal, ctx)
    if (prior?.startedTurn === startedTurn)
      throw new AkaProtocolError(
        'This case already started in this user turn; use its current checkpoint, or report the ended result instead of starting another sweep',
      )
    const entry: Entry = {
      ...scope,
      workflowId: randomUUID(),
      goal,
      phase: goal === 'find_tennis' ? 'searching' : 'await_target',
      startedTurn,
      searchTurns: 0,
      adjustments: 0,
      forwards: 0,
      backwards: 0,
      motionHistory: [],
      photos: [],
      lastFrameId: '',
      note:
        goal === 'find_tennis'
          ? 'Analyze the initial original. Only not_found may turn once; found stops and asks about approach.'
          : 'Analyze this CURRENT original before any movement. Found requires its target box and description. If absent, not_found ends without moving; ask to find the target first.',
      capturedAt: 0,
    }
    this.entries.set(scope.deviceId, entry)
    const controller = new AbortController()
    this.active.set(scope.deviceId, { sessionId: scope.sessionId, controller })
    try {
      await this.photo(
        entry,
        { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) },
        null,
        true,
      )
      if (goal === 'pickup_tennis') await this.reference(entry, ctx)
      return this.result(entry)
    } catch (error) {
      entry.phase = controller.signal.aborted || ctx.signal.aborted ? 'interrupted' : 'unknown'
      throw error
    } finally {
      this.active.delete(scope.deviceId)
    }
  }
  private box(input: Step) {
    const b = input.box
    if (
      b?.length !== 4 ||
      !b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      (b[2] ?? 0) <= (b[0] ?? 0) ||
      (b[3] ?? 0) <= (b[1] ?? 0)
    )
      throw new AkaProtocolError('Provide the target box from this original, normalized to 0–1')
    return {
      center: ((b[0] ?? 0) + (b[2] ?? 0)) / 2,
      centerY: ((b[1] ?? 0) + (b[3] ?? 0)) / 2,
      width: (b[2] ?? 0) - (b[0] ?? 0),
      height: (b[3] ?? 0) - (b[1] ?? 0),
    }
  }
  private async reference(entry: Entry, ctx: ToolContext): Promise<Reference | null> {
    const path = join(
      ctx.session.workspaceRoot,
      '.agh-device',
      'demo-grasp-reference',
      `${entry.deviceId}.json`,
    )
    try {
      const info = await ctx.fs.stat(path)
      if (info.kind !== 'file' || info.size > 4096) throw new AkaProtocolError('Invalid demo grasp reference')
      const r = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await ctx.fs.read(path)),
      ) as Reference
      const last = entry.photos.at(-1)?.selection
      if (
        Object.keys(r)
          .filter((key) => !['imageFile', 'note', 'minCenterY', 'maxCenterY'].includes(key))
          .sort()
          .join(',') !==
          'deviceId,height,maxHeightRatio,maxWidthRatio,minHeightRatio,minWidthRatio,version,width' ||
        r.version !== 1 ||
        r.deviceId !== entry.deviceId ||
        r.width !== last?.width ||
        r.height !== last?.height ||
        ![r.minWidthRatio, r.maxWidthRatio, r.minHeightRatio, r.maxHeightRatio].every(
          (v) => Number.isFinite(v) && v > 0 && v <= 1,
        ) ||
        r.minWidthRatio >= r.maxWidthRatio ||
        r.minHeightRatio >= r.maxHeightRatio ||
        ((r.minCenterY !== undefined || r.maxCenterY !== undefined) &&
          (!Number.isFinite(r.minCenterY) ||
            !Number.isFinite(r.maxCenterY) ||
            (r.minCenterY ?? -1) < 0 ||
            (r.maxCenterY ?? 2) > 1 ||
            (r.minCenterY ?? 1) >= (r.maxCenterY ?? 0))) ||
        (r.imageFile !== undefined && r.imageFile !== 'reference.png') ||
        (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 1000))
      )
        throw new AkaProtocolError('Demo reference does not match this camera')
      entry.reference = r
      if (r.imageFile && !entry.referenceImage) {
        const imagePath = join(
          ctx.session.workspaceRoot,
          '.agh-device',
          'demo-grasp-reference',
          entry.deviceId,
          r.imageFile,
        )
        const info = await ctx.fs.stat(imagePath)
        if (info.kind !== 'file' || info.size < 8 || info.size > 4 * 1024 * 1024)
          throw new AkaProtocolError('Invalid reference screenshot')
        const bytes = await ctx.fs.read(imagePath)
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
          throw new AkaProtocolError('Invalid reference screenshot')
        entry.referenceImage = await ctx.artifacts.put(bytes, { mime: 'image/png' })
      }
      return r
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        delete entry.reference
        delete entry.referenceImage
        return null
      }
      throw error
    }
  }
  async invokeStep(input: Step, ctx: ToolContext): Promise<ToolResult> {
    let dispatched = false
    try {
      return await this.step(input, ctx, () => {
        dispatched = true
      })
    } catch (error) {
      // A rejected checkpoint is not a lost motor receipt. Throwing before movement
      // makes Core conservatively report a mutation as "unknown after dispatch".
      if (dispatched || !(error instanceof AkaProtocolError)) throw error
      const state = { state: 'not-started', reason: error.message, movementDispatched: false }
      return { isError: true, structured: state, content: [{ type: 'text', text: JSON.stringify(state) }] }
    }
  }
  async step(input: Step, ctx: ToolContext, onDispatch?: () => void): Promise<ToolResult> {
    const entry = [...this.entries.values()].find((e) => e.workflowId === input.workflowId)
    if (!entry || entry.sessionId !== ctx.session.key || entry.lastFrameId !== input.frameId)
      throw new AkaProtocolError('Demo checkpoint is missing or stale; never replay a movement')
    await this.check(entry, ctx, !(input.decision === 'release' && entry.phase === 'await_release'))
    if (
      this.active.has(entry.deviceId) ||
      [
        'failed',
        'interrupted',
        'unknown',
        'released',
        'ready_model',
        'not_found',
        'target_missing',
        'found',
      ].includes(entry.phase)
    )
      throw new AkaProtocolError('Demo is busy or ended')
    const controller = new AbortController()
    this.active.set(entry.deviceId, { sessionId: entry.sessionId, controller })
    const invocation = {
      ...ctx,
      signal: AbortSignal.any([ctx.signal, controller.signal, this.deps.api.ctx.signal]),
    }
    let dispatched = false
    const move = async (
      action: 'left' | 'right' | 'up' | 'down' | 'grab' | 'release',
      milliseconds: number,
    ) => {
      const history = {
        action,
        speed: 30,
        milliseconds,
        beforeFrameId: entry.lastFrameId,
        afterFrameId: null as string | null,
        summary: input.summary ?? '',
        receipt: undefined as unknown,
      }
      const receipt = await runDeviceControl(
        this.deps,
        invocation,
        {
          bindingRevision: entry.bindingRevision,
          configRevision: entry.configRevision,
          action,
          speed: 30,
          milliseconds,
        },
        false,
        {
          id: entry.workflowId,
          onDispatch: () => {
            dispatched = true
            onDispatch?.()
            entry.motionHistory.push(history)
          },
        },
      )
      entry.lastActionReceipt = receipt
      history.receipt = receipt
      if (action === 'release') {
        // The accepted arm action must not become "unknown" merely because its
        // optional follow-up camera picture is unavailable. Never release again.
        entry.phase = 'released'
        entry.postActionPhotoAvailable = false
        try {
          await this.photo(entry, invocation, { action, speed: 30, milliseconds, receipt })
          entry.postActionPhotoAvailable = true
        } catch {
          entry.note =
            'Release accepted; post-action photo unavailable. Do not replay release. Restore the camera before modeling a currently visible object.'
        }
      } else await this.photo(entry, invocation, { action, speed: 30, milliseconds, receipt })
      if (entry.postActionPhotoAvailable !== false) history.afterFrameId = entry.lastFrameId
    }
    try {
      const d = input.decision
      if (d === 'observe') {
        await this.photo(entry, invocation, null, true)
        return this.result(entry)
      }
      // Release may intentionally arrive in a later user turn; it does not navigate using an old image.
      if (d !== 'release' && performance.now() - entry.capturedAt > 30000) {
        await this.photo(entry, invocation, null, true)
        entry.note =
          'The prior image became old while reasoning. A fresh original is returned; no movement was sent. Analyze it before the next checkpoint.'
        return this.result(entry)
      }
      if (
        (d === 'not_found' || d === 'back_up' || d.startsWith('align_') || d.startsWith('forward_')) &&
        !input.summary?.trim()
      )
        throw new AkaProtocolError(
          'Describe the latest image and prior movement effect before choosing the next movement',
        )
      if (d === 'not_found' && entry.phase === 'await_target') {
        entry.phase = 'target_missing'
        entry.note =
          entry.goal === 'pickup_tennis'
            ? '当前画面没有网球，不能接近抓取。请先按找球任务寻找；本次没有移动。'
            : '当前画面未看到指定建模物体，请先让物体出现在画面里；本次没有移动。'
      } else if (d === 'not_found' && entry.phase === 'searching') {
        if (entry.searchTurns === 6) {
          entry.phase = 'not_found'
          entry.note =
            'Six stopped search turns were analyzed without finding a tennis ball; stop and report not found.'
        } else {
          await move('left', 1000)
          entry.searchTurns++
          entry.note =
            'Analyze this stopped original. Found: stop and ask about approach; not found: next checkpoint. At most six turns.'
        }
      } else if (d === 'found' && ['searching', 'await_target'].includes(entry.phase)) {
        this.box(input)
        if (!input.summary?.trim())
          throw new AkaProtocolError('Describe the requested target evidence in this current original')
        entry.phase = entry.goal === 'find_tennis' ? 'found' : 'aligning'
        if (entry.goal === 'find_tennis') entry.foundTurn = entry.startedTurn
        entry.note = `Model visual observation (not cloud detection): ${input.summary}`
      } else if (
        entry.goal === 'pickup_tennis' &&
        d === 'back_up' &&
        ['aligning', 'await_reference'].includes(entry.phase)
      ) {
        const b = this.box(input)
        if (entry.backwards >= 6 || (b.width < 0.5 && b.height < 0.75 && (input.box?.[3] ?? 0) < 0.98))
          throw new AkaProtocolError('Back up only for a close or cropped target, at most six steps')
        await move('down', 500)
        entry.backwards++
        entry.phase = 'aligning'
        entry.note =
          'One 30/500 backward pulse completed. Compare both stopped originals and motion history; backward distance is not calibrated. Stop retreating once the ball fits the intended frame.'
      } else if (
        d === 'capture_subject' &&
        entry.goal === 'model_object' &&
        ['aligning', 'await_reference'].includes(entry.phase)
      ) {
        this.box(input)
        if (
          (input.box?.[0] ?? 0) < 0.02 ||
          (input.box?.[1] ?? 0) < 0.02 ||
          (input.box?.[2] ?? 1) > 0.98 ||
          (input.box?.[3] ?? 1) > 0.98
        )
          throw new AkaProtocolError(
            'For modeling, show the whole requested object with visible margin; if cropped, reframe and inspect a new photo',
          )
        if (!input.summary?.trim())
          throw new AkaProtocolError('Describe the selected modeling object in this original')
        entry.subject = { box: [...(input.box ?? [])], description: input.summary }
        entry.phase = 'ready_model'
        entry.note =
          'Current complete subject original ready for image processing and Blender; no grasp occupancy or exact distance is required for modeling.'
        await this.export(entry.workflowId, invocation)
      } else if (
        entry.goal === 'pickup_tennis' &&
        (d === 'align_left' || d === 'align_right') &&
        ['aligning', 'await_reference'].includes(entry.phase)
      ) {
        const b = this.box(input),
          ms = input.milliseconds ?? 500
        if (
          !Number.isSafeInteger(ms) ||
          ms < 300 ||
          ms > 700 ||
          entry.adjustments >= 8 ||
          (d === 'align_left' ? b.center >= 0.4 : b.center <= 0.6)
        )
          throw new AkaProtocolError('Alignment must be necessary, at most eight steps, and 300–700 ms')
        await move(d === 'align_left' ? 'left' : 'right', ms)
        entry.adjustments++
        entry.phase = 'aligning'
        entry.note =
          'Recheck horizontal centering from the new photo; use speed 30 and 500 ms first. After repeated default adjustments or overshoot, try 300 ms for fine alignment during approach only; no fixed turn angle is known.'
      } else if (
        entry.goal === 'pickup_tennis' &&
        d in DEMO_MOTION &&
        ['aligning', 'await_reference'].includes(entry.phase)
      ) {
        const b = this.box(input),
          preset = DEMO_MOTION[d as keyof typeof DEMO_MOTION]
        if (b.center < 0.4 || b.center > 0.6 || entry.forwards >= 12)
          throw new AkaProtocolError('Center the ball first; forward steps are bounded to twelve')
        const reference = await this.reference(entry, invocation)
        if (!reference) {
          entry.phase = 'await_reference'
          entry.note =
            'The successful-grasp reference image/occupancy has not been configured; do not guess approach completion.'
        } else if (
          b.width >= reference.maxWidthRatio ||
          b.height >= reference.maxHeightRatio ||
          (b.width >= reference.minWidthRatio && b.height >= reference.minHeightRatio)
        ) {
          entry.note =
            'The ball has reached or exceeded the approach reference. Do not advance again; check grab/subject eligibility from this image.'
        } else {
          await move(preset.action, preset.milliseconds)
          entry.forwards++
          entry.phase = 'aligning'
          entry.note = `Operator observed about ${preset.approximateCentimeters} cm for this preset; compare the new image, do not report measured travel.`
        }
      } else if (
        entry.goal === 'pickup_tennis' &&
        d === 'grab' &&
        ['aligning', 'await_reference'].includes(entry.phase)
      ) {
        const b = this.box(input),
          r = await this.reference(entry, invocation)
        if (!r) {
          entry.phase = 'await_reference'
          entry.note =
            'Waiting for the operator-provided successful-grasp occupancy reference; no arm action was sent.'
        } else if (
          b.center < 0.4 ||
          b.center > 0.6 ||
          b.width < r.minWidthRatio ||
          b.centerY < (r.minCenterY ?? 0) ||
          b.centerY > (r.maxCenterY ?? 1) ||
          b.width > r.maxWidthRatio ||
          b.height < r.minHeightRatio ||
          b.height > r.maxHeightRatio
        ) {
          entry.phase = 'aligning'
          entry.note =
            'Target is outside the recorded reference occupancy; analyze and adjust before grabbing or collecting the subject.'
        } else if (entry.goal === 'pickup_tennis') {
          await move('grab', 500)
          await this.photo(entry, invocation, null, true)
          entry.phase = 'verifying_grab'
          entry.note =
            'Analyze both post-grab originals: the ball must disappear from the original ground position. Do not grab again.'
        } else throw new AkaProtocolError('Wrong action for this demo goal')
      } else if ((d === 'gone' || d === 'still_visible') && entry.phase === 'verifying_grab') {
        if (!input.summary?.trim()) throw new AkaProtocolError('Describe both post-grab originals')
        if (d === 'gone') {
          const turn = ctx.session.turn
          if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0)
            throw new AkaProtocolError(
              'Runtime user-turn identity unavailable; update the runtime before using the demo release workflow',
            )
          entry.pickupConfirmedTurn = turn
        }
        entry.phase = d === 'gone' ? 'await_release' : 'failed'
        entry.note =
          d === 'gone'
            ? `Visual pickup success under the operator's disappearance criterion; no hardware possession sensor. Wait for a new release prompt. Evidence: ${input.summary}`
            : `Ball remains visible: pickup not confirmed; no automatic retry. ${input.summary}`
      } else if (d === 'release' && entry.phase === 'await_release') {
        this.guardModelRelease(ctx.session.key, entry.deviceId, ctx.session.turn)
        await move('release', 500)
        entry.phase = 'released'
        if (entry.postActionPhotoAvailable)
          entry.note =
            'Release accepted. Wait for a user modeling request and analyze its new current original; if the requested object is absent, report it rather than automatically searching.'
      } else throw new AkaProtocolError('Decision does not match this workflow phase')
      return this.result(entry)
    } catch (error) {
      if (dispatched) entry.phase = controller.signal.aborted ? 'interrupted' : 'unknown'
      throw error
    } finally {
      this.active.delete(entry.deviceId)
    }
  }
  private async checkModelArchive(
    ctx: ToolContext,
    owner: Pick<Scope, 'deviceId' | 'sessionId' | 'workspaceId' | 'bindingRevision' | 'configRevision'>,
  ) {
    ctx.signal.throwIfAborted()
    const binding = await ctx.device?.binding()
    if (
      !ctx.device ||
      !binding?.active ||
      binding.sessionId !== ctx.session.key ||
      binding.sessionId !== owner.sessionId ||
      binding.deviceId.toLowerCase() !== owner.deviceId ||
      binding.workspaceId !== owner.workspaceId ||
      binding.bindingRevision !== owner.bindingRevision
    )
      throw new AkaProtocolError('Model archive binding changed')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations)
    if (!registration || registration.configRevision !== owner.configRevision)
      throw new AkaProtocolError('Model archive configuration changed')
  }
  /** Restore immutable modeling input only. Never restore an executable motion workflow. */
  async restoreModelArchive(workflowId: string, ctx: ToolContext) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workflowId)) return undefined
    ctx.signal.throwIfAborted()
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key)
      throw new AkaProtocolError('Model archive binding changed')
    const directory = join(ctx.session.workspaceRoot, '.agh-device', 'exports', workflowId)
    const manifest = join(directory, 'manifest.json')
    let bytes: Uint8Array
    try {
      const info = await ctx.fs.stat(manifest)
      if (info.kind !== 'file' || info.size > 128 * 1024) throw new AkaProtocolError('Invalid model archive')
      bytes = await ctx.fs.read(manifest)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
    if (bytes.length > 128 * 1024) throw new AkaProtocolError('Invalid model archive')
    const saved = JSON.parse(new TextDecoder().decode(bytes))
    if (saved.kind !== 'object-observation') return undefined
    if (saved.archiveVersion !== 1 || saved.workflowId !== workflowId || !saved.owner)
      throw new AkaProtocolError('Model archive has no verified owner; do not regenerate automatically')
    await this.checkModelArchive(ctx, saved.owner)
    const photo = saved.photos?.[0]
    if (
      saved.task?.phase !== 'ready_model' ||
      !Array.isArray(saved.photos) ||
      saved.photos.length !== 1 ||
      photo?.name !== 'observation-1.jpg' ||
      !/^[a-f0-9]{64}$/.test(photo.ref?.sha256) ||
      !Number.isSafeInteger(photo.ref?.size) ||
      photo.ref.size < 1 ||
      photo.ref.size > 8 * 1024 * 1024
    )
      throw new AkaProtocolError('Invalid model original archive')
    const original = await ctx.fs.read(join(directory, photo.name))
    if (
      original.length !== photo.ref.size ||
      createHash('sha256').update(original).digest('hex') !== photo.ref.sha256
    )
      throw new AkaProtocolError('Model original changed')
    await this.checkModelArchive(ctx, saved.owner)
    return {
      captureSetId: workflowId,
      directory,
      manifest,
      photoCount: 1,
      viewpointsVerified: false,
      scale: 'unknown',
    }
  }
  async export(workflowId: string, ctx: ToolContext) {
    const entry = [...this.entries.values()].find((e) => e.workflowId === workflowId)
    if (entry?.phase !== 'ready_model') throw new AkaProtocolError('Model subject checkpoint is not complete')
    // Offline processing uses immutable originals, not a later live stream epoch.
    await this.checkModelArchive(ctx, entry)
    const photo = entry.photos.at(-1)
    if (!photo) throw new AkaProtocolError('Model source missing')
    const bytes = await ctx.artifacts.get(photo.ref)
    if (
      bytes.length !== photo.ref.size ||
      createHash('sha256').update(bytes).digest('hex') !== photo.ref.sha256
    )
      throw new AkaProtocolError('Model original changed')
    await this.checkModelArchive(ctx, entry)
    const directory = join(ctx.session.workspaceRoot, '.agh-device', 'exports', workflowId),
      manifest = join(directory, 'manifest.json')
    await ctx.fs.write(join(directory, 'observation-1.jpg'), bytes)
    await ctx.fs.write(
      manifest,
      JSON.stringify({
        kind: 'object-observation',
        archiveVersion: 1,
        workflowId,
        owner: {
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
          deviceId: entry.deviceId,
          bindingRevision: entry.bindingRevision,
          configRevision: entry.configRevision,
        },
        task: { goal: entry.goal, phase: entry.phase },
        subject: entry.subject,
        scale: 'unknown',
        viewpointsVerified: false,
        photos: [{ name: 'observation-1.jpg', ref: photo.ref, selection: photo.selection }],
      }),
    )
    await this.checkModelArchive(ctx, entry)
    return {
      captureSetId: workflowId,
      directory,
      manifest,
      photoCount: 1,
      viewpointsVerified: false,
      scale: 'unknown',
    }
  }
}

export function registerDemoWorkflows(api: PluginExtensionAPI, workflows: DemoWorkflows, scans: ScanTasks) {
  api.registerTool({
    name: 'aka_find_tennis',
    description:
      '仅用于用户明确要求“找网球/找球”的找球任务；“环视/查看周围环境”禁止调用本工具，应调用aka_surround。找球任务入口：只拍当前方向的起始原图，零次转向。必须先由模型判断这张原图；已看到网球就aka_demo_step(found)带box和summary停下上报。没找到才aka_demo_step(not_found)，每次仅左转30配速1000ms，停稳一秒拍新图，交回模型判断，再决定是否下一转，最多六转。严禁用aka_scan/aka_surround整批采样替代找球，因为整批转完才判断会错过找到即停。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: { ...meta, isDestructive: false },
    execute: (_input, ctx) => workflows.start('find_tennis', ctx),
  })
  api.registerTool({
    name: 'aka_surround',
    description:
      '仅用于“环视/查看四周/查看周围环境”的环视任务，不是找球。固定环视：先留档起始图，随后左转30配速1000ms，停车等待约1秒拍新图，连续七次，共八张原图。一次调用完成全部采样，不因无需云识别或模型尚未总结而提前结束；取消、断线或未知动作仍停止。结果给出taskId；随后aka_read_observations每一步只读一组照片：offset依次0、2、4、6，limit=2，分析并记录本组再读下一组，禁止同一步并行或串行调用多页，否则图片超过模型上限。读完八张简洁总结周围环境就结束；即使看到网球也不能开始找球或接近抓取。每张应记录轮次和参数；用户实测七段约一圈，仅作本车现场参考，不能承诺精确360度。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta,
    execute: (_input, ctx) => workflows.surround(ctx, scans),
  })
  api.registerTool({
    name: 'aka_pickup_tennis',
    description:
      '仅用于用户明确要求接近或抓取当前画面里的网球。只拍新的当前原图，不转向、不搜索；模型必须先found带box/summary确认球可见，再逐步居中、前进、夹取。当前图没球时not_found结束并提示先找球。找球完成当轮禁止调用，等用户确认是否接近抓取。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: { ...meta, isDestructive: false },
    execute: (_input, ctx) => workflows.start('pickup_tennis', ctx),
  })
  api.registerTool({
    name: 'aka_model_object',
    description:
      '仅用于用户要求给当前画面里的指定物体建模（任意物体，不限网球）。先拍当前原图，不自动找球、转向居中、前进或抓取。模型按用户指定目标found带box/summary确认可见；没有则not_found结束。完整入镜时capture_subject带目标box/summary保存这张已分析原图，先确认主体身份并详细描述外形、材质、颜色和比例，优先用agh_ortho参数与六视图校验建模，复杂外形需要图片辅助才aka_generate_reference_views并行生成参考并分组分析；agh_blender_capture提供camera返回真实模型渲染。只拍照，禁止所有底盘和夹爪动作。',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: { ...meta, isDestructive: false },
    execute: (_input, ctx) => workflows.start('model_object', ctx),
  })
  api.registerTool({
    name: 'aka_demo_start',
    description:
      '兼容入口；优先使用各任务专用工具：环视aka_surround；找球aka_find_tennis；当前图有球才接近aka_pickup_tennis；当前图指定物体建模aka_model_object。find_tennis最多六转找到即停，必须等新用户请求才能接近。pickup_tennis与model_object只拍当前图，found确认目标在当前图才能继续；not_found立即结束不转向搜索。model_tennis是model_object的兼容别名，不再自动找球。旧工作流仅供状态参考，不授权恢复或切换任务。',
    parameters: Type.Object(
      {
        goal: Type.Union([
          Type.Literal('find_tennis'),
          Type.Literal('pickup_tennis'),
          Type.Literal('model_object'),
          Type.Literal('model_tennis'),
        ]),
        previousWorkflowId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, isDestructive: false, deferLoading: true },
    execute: (input, ctx) => {
      const v = input as { goal: Goal; previousWorkflowId?: string }
      return workflows.start(v.goal, ctx, v.previousWorkflowId)
    },
  })
  api.registerTool({
    name: 'aka_demo_step',
    description:
      '用最新原图判断推进一个任务检查点。每次not_found/align/forward必须给summary，说明新旧图变化、上一动作参数和为何选择下一步；每步返回前后原图及motionHistory（历史方向、参数、前后frameId和判断摘要）；微调先看历史避免转过头，配速固定30，默认500ms；连续默认时长调整或反向过冲时可选300ms，仅用于接近微调，不按未标定角速度推算。frameId必须来自上一结果，禁止复用旧帧重发。找球:not_found左转30/1000后停车拍照，最多6次；found须给原图中网球的normalized box和summary，立即停止寻转。接近必须先found确认新起始图确有网球；没有则not_found结束、提示先找球，不自动切找球。找球结束当轮不得接近。接近:box格式[x1,y1,x2,y2]均0–1，球左偏align_left/右偏align_right，500ms先试，允许300至700ms整毫秒，300ms仅用于连续默认调整后的接近微调，按新旧图调整，最多8次，停车后新图重看。球中心在画面40%–60%时可选forward_10cm(30/1000)、forward_5cm(30/700)、forward_3cm(30/500)，这是本车实测近似值，不线性推算，最多12步，必须有成功夹取占比参考，近了选较小步。grab仅匹配参考占比后调用一次，等机械臂与画面稳定后返回两张新图；gone须summary说明两图里原位置的球消失，按用户视觉条件上报成功但无持物传感器，结束并等待新的释放提示词；still_visible失败不自动重夹。release只有用户明确提示释放才调用。当前目标太近或裁切时可back_up，每次后退30/500后停车拍新图，最多六次，方向距离未标定；模型按新旧图确认效果，不连续盲退。model_object不自动找球、居中或前进，不要求夹取占比。当前图里的用户指定物体完整入镜留2%边缘时capture_subject带box/summary保存已分析的原图和目标描述；目标裁切或缺失就请用户调整摆放，禁止建模任务移动小车。优先以原图建立agh_ortho曲面参数，检查六视图和实际场景；复杂外形需要图片辅助才aka_generate_reference_views并行生成参考。最终agh_blender_capture提供camera返回真实模型渲染。observe只补拍，不移动。unknown/failed/interrupted不得继续；缺参考不猜。',
    parameters: Type.Object(
      {
        workflowId: Type.String({ minLength: 1, maxLength: 64 }),
        frameId: Type.String({ minLength: 1, maxLength: 512 }),
        decision: Type.Union(
          [
            'observe',
            'not_found',
            'found',
            'align_left',
            'align_right',
            'forward_3cm',
            'forward_5cm',
            'forward_10cm',
            'grab',
            'gone',
            'still_visible',
            'release',
            'capture_subject',
            'back_up',
          ].map((s) => Type.Literal(s)),
        ),
        box: Type.Optional(
          Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
            minItems: 4,
            maxItems: 4,
            description:
              'Required for found, align_left, align_right, forward_3cm, forward_5cm, forward_10cm, grab, back_up and capture_subject. Target box [x1,y1,x2,y2] from the current frameId, normalized to 0–1. Do not reuse a prior frame box.',
          }),
        ),
        milliseconds: Type.Optional(Type.Integer({ minimum: 300, maximum: 700 })),
        summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) => workflows.invokeStep(input as Step, ctx),
  })
}
