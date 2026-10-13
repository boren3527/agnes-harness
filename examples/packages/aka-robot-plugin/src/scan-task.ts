import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { ServiceDef, ToolContext, ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { compatiblePosition, type Position, planApproach } from './approach.js'
import type { CaptureDependencies } from './capture-frame.js'
import { capturePhoto } from './capture-tool.js'
import { readRegistration } from './connection-profile.js'
import { runDeviceControl } from './control-services.js'
import { estimateGround } from './geometry.js'
import type { GroundGeometry } from './geometry-service.js'
import { boxInside } from './grasp.js'
import { type MissionInput, parseMission, runMissionStages } from './mission.js'
import { applyOrbitStep, createOrbit, observeOrbit, orbitStep } from './orbit.js'
import { AkaProtocolError } from './protocol.js'
import { uniqueImageContent } from './tool-images.js'
import { copyRoute, type RouteStep, transportObservation } from './transport.js'

const CLOUD_OBSERVATION_MS = 10000

function notStarted(reason: string): ToolResult {
  const result = { state: 'not-started', reason, physicalResult: 'unverified' }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

export type ScanTaskState = {
  taskId: string
  sessionId: string
  deviceId: string
  bindingRevision: number
  configRevision: number
  kind: 'scan' | 'search' | 'approach' | 'grasp' | 'release' | 'patrol' | 'transport' | 'mission' | 'orbit'
  phase:
    | 'capturing'
    | 'approaching'
    | 'gripping'
    | 'verifying'
    | 'turning'
    | 'completed'
    | 'cancelled'
    | 'failed'
  completedViews: number
  requestedViews: number
  startedAt: string
  endedAt: string | null
  coverage: 'unmeasured'
  physicalResult: 'unverified'
  error: string | null
  targetFound?: boolean
  targetLabels?: string[]
  matchedResultId?: string
  outcome?: 'at_standoff' | 'paused' | 'step_limit'
  outcomeReason?: string
  gripEvidence?: 'unknown' | 'held_candidate' | 'released_candidate'
  armReceipt?: 'completed' | 'acknowledged' | 'unknown'
  route?: PatrolStep[]
  stage?: string
  homeEvidence?: 'unknown' | 'observed_candidate'
  viewpoints?: {
    index: number
    angleDegrees: number
    uncertaintyDegrees: number
    method: string
    resultId: string
  }[]
}
type PatrolStep = RouteStep
type Photo = { ref: { sha256: string; size: number; mime: string }; selection: unknown; motion?: unknown }
type Entry = {
  photos: Photo[]
  state: ScanTaskState
  controller: AbortController
  done: Promise<void>
  finish(): void
}
const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  deferLoading: false,
  requiresApproval: 'never' as const,
  costHint: undefined,
  returnsImages: true,
}
/** Bounded synchronous scan: never keeps a completed invocation or starts a background movement queue. */
export class ScanTasks {
  private readonly entries = new Map<string, Entry>()
  private readonly missions = new Map<string, Entry & { invocation: ToolContext }>()
  private readonly readSteps = new Map<string, { turn: number; step: number }>()
  constructor(
    private readonly deps: CaptureDependencies,
    private readonly geometry?: GroundGeometry,
  ) {}
  read(sessionId: string | undefined, deviceId: string, bindingRevision: number) {
    const mission = this.missions.get(deviceId.toLowerCase())
    const child = this.entries.get(deviceId.toLowerCase())
    const item =
      mission && !mission.state.endedAt ? mission.state : this.entries.get(deviceId.toLowerCase())?.state
    return item && item.sessionId === sessionId && item.bindingRevision === bindingRevision
      ? {
          ...item,
          ...(mission &&
          !mission.state.endedAt &&
          child &&
          child !== mission &&
          !child.state.endedAt &&
          child.state.sessionId === item.sessionId &&
          child.state.bindingRevision === item.bindingRevision
            ? { phase: child.state.phase, stage: child.state.kind }
            : {}),
          ...(item.route ? { route: item.route.map((step) => ({ ...step })) } : {}),
          ...(item.viewpoints ? { viewpoints: item.viewpoints.map((view) => ({ ...view })) } : {}),
        }
      : null
  }
  async interrupt(sessionId: string | undefined, stopping = false, deviceId?: string) {
    const pending: Promise<void>[] = []
    for (const entry of [...this.entries.values(), ...this.missions.values()]) {
      if (
        entry.state.endedAt ||
        (deviceId && entry.state.deviceId !== deviceId) ||
        (!stopping && entry.state.sessionId !== sessionId)
      )
        continue
      entry.controller.abort()
      if (!stopping) pending.push(entry.done)
    }
    await Promise.all(pending)
  }
  async cancel(taskId: unknown, sessionId: string | undefined) {
    const entry = [...this.entries.values(), ...this.missions.values()].find(
      (e) => e.state.taskId === taskId && e.state.sessionId === sessionId,
    )
    if (!entry) throw new AkaProtocolError('Task not found in current session')
    entry.controller.abort()
    return { ...entry.state, cancelRequested: true }
  }
  async export(taskId: string, ctx: ToolContext) {
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key)
      throw new AkaProtocolError('Device binding unavailable')
    const mission = this.missions.get(binding.deviceId.toLowerCase())
    const entry =
      mission?.state.taskId === taskId ? mission : this.entries.get(binding.deviceId.toLowerCase())
    if (
      !entry ||
      entry.state.taskId !== taskId ||
      entry.state.sessionId !== ctx.session.key ||
      entry.state.bindingRevision !== binding.bindingRevision ||
      !entry.state.endedAt ||
      !entry.photos.length
    )
      throw new AkaProtocolError('Completed observation photos unavailable')
    const root = join(ctx.session.workspaceRoot, '.agh-device', 'exports', taskId)
    const photos = []
    for (let index = 0; index < entry.photos.length; index++) {
      ctx.signal.throwIfAborted()
      const photo = entry.photos[index]
      if (!photo) throw new AkaProtocolError('Photo missing')
      const bytes = await ctx.artifacts.get(photo.ref)
      if (
        bytes.length !== photo.ref.size ||
        createHash('sha256').update(bytes).digest('hex') !== photo.ref.sha256
      )
        throw new AkaProtocolError('Original image read failed')
      const name = `observation-${index + 1}.jpg`
      await ctx.fs.write(join(root, name), bytes)
      photos.push({ name, ref: photo.ref, selection: photo.selection, motion: photo.motion ?? null })
    }
    const manifest = {
      captureSetId: taskId,
      kind:
        entry.state.kind === 'orbit'
          ? entry.state.phase === 'completed' && entry.state.completedViews === 4
            ? 'orbit-four-view'
            : 'orbit-partial'
          : entry.state.kind === 'patrol'
            ? 'patrol-record'
            : 'observation-sweep',
      task: entry.state,
      viewpointsVerified: false,
      scale: 'unknown',
      photos,
      modelingNote:
        entry.state.kind === 'orbit'
          ? '视角由实测运动和地面观察估计；包含角度误差，不是外部定位真值，无绝对尺度或模型质量保证。'
          : '环视观察图并非绕同一物体的四视角；不可据此宣称尺寸准确或几何重建成功。',
    }
    await ctx.fs.write(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return {
      captureSetId: taskId,
      directory: root,
      manifest: join(root, 'manifest.json'),
      photoCount: photos.length,
      viewpointsVerified: false,
      scale: 'unknown',
    }
  }
  async find(input: { views: number; direction: 'left' | 'right'; labels: string[] }, ctx: ToolContext) {
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'direction,labels,views' ||
      !Array.isArray(input.labels) ||
      input.labels.length < 1 ||
      input.labels.length > 12 ||
      input.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 256) ||
      !this.geometry
    )
      throw new AkaProtocolError('Invalid search labels or recognition unavailable')
    return this.scan(
      { views: input.views, direction: input.direction },
      ctx,
      input.labels.map((label) => label.trim()),
    )
  }

  async readPhotos(
    taskId: string,
    offset: number,
    limit: number,
    ctx: ToolContext,
    compareEnds = false,
  ): Promise<ToolResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2)
      throw new AkaProtocolError('Invalid observation page')
    const binding = await ctx.device?.binding()
    const entry = binding && this.entries.get(binding.deviceId.toLowerCase())
    if (
      !binding?.active ||
      binding.sessionId !== ctx.session.key ||
      !entry ||
      entry.state.taskId !== taskId ||
      entry.state.sessionId !== ctx.session.key ||
      entry.state.bindingRevision !== binding.bindingRevision ||
      !entry.state.endedAt ||
      offset >= entry.photos.length
    )
      throw new AkaProtocolError('Completed observation photos unavailable')
    const { turn, step } = ctx.session
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step))
      throw new AkaProtocolError('Runtime image-step identity unavailable; update AGH before paging photos')
    const previousRead = this.readSteps.get(ctx.session.key)
    if (previousRead && previousRead.turn === turn && previousRead.step === step)
      throw new AkaProtocolError(
        'Only one observation page per inference step. Analyze the returned images and record this group, then read the next page in a new step; batching pages drops images from model input.',
      )
    // Claim before reading CAS: simultaneous requests must not both pass the guard.
    this.readSteps.set(ctx.session.key, { turn: turn as number, step: step as number })
    const content: ToolResult['content'] = []
    const indices = compareEnds
      ? [0, entry.photos.length - 1]
      : Array.from({ length: Math.min(limit, entry.photos.length - offset) }, (_, i) => offset + i)
    for (const index of indices) {
      ctx.signal.throwIfAborted()
      const photo = entry.photos[index]
      if (!photo) throw new AkaProtocolError('Observation photo missing')
      const bytes = await ctx.artifacts.get(photo.ref)
      if (
        bytes.length !== photo.ref.size ||
        createHash('sha256').update(bytes).digest('hex') !== photo.ref.sha256
      )
        throw new AkaProtocolError('Original observation image read failed')
      content.push(
        {
          type: 'text',
          text: JSON.stringify({ index, selection: photo.selection, motion: photo.motion ?? null }),
        },
        { type: 'image', ref: { ...photo.ref }, mime: 'image/jpeg' },
      )
    }
    ctx.signal.throwIfAborted()
    const current = await ctx.device?.binding()
    if (
      !current?.active ||
      current.sessionId !== ctx.session.key ||
      current.deviceId !== binding.deviceId ||
      current.bindingRevision !== binding.bindingRevision
    )
      throw new AkaProtocolError('Observation binding changed')
    const next = Math.min(offset + limit, entry.photos.length)
    const page = {
      taskId,
      offset,
      total: entry.photos.length,
      nextOffset: !compareEnds && next < entry.photos.length ? next : null,
      indices,
      instruction:
        'Analyze this group now and retain indexed observations before reading another page in a NEW inference step. Do not batch pages. After all pages, briefly summarize the surroundings and finish; do not start searching or approaching.',
    }
    return {
      content: uniqueImageContent([{ type: 'text', text: JSON.stringify(page) }, ...content]),
      structured: page,
    }
  }
  async patrol(
    input: { steps: PatrolStep[]; supervised: true; returnSteps?: PatrolStep[]; homeLabels?: string[] },
    ctx: ToolContext,
  ) {
    if (
      !input ||
      !['steps,supervised', 'homeLabels,returnSteps,steps,supervised'].includes(
        Object.keys(input).sort().join(','),
      ) ||
      input.supervised !== true
    )
      throw new AkaProtocolError('Invalid bounded patrol route')
    // Copy before awaiting device reads: callers cannot alter the route in flight.
    const steps = copyRoute(input.steps)
    if (input.returnSteps !== undefined) {
      const returning = copyRoute(input.returnSteps)
      if (
        !Array.isArray(input.homeLabels) ||
        !input.homeLabels.length ||
        input.homeLabels.length > 12 ||
        input.homeLabels.some((s) => typeof s !== 'string' || !s.trim() || s.length > 256) ||
        steps.length + returning.length > 12
      )
        throw new AkaProtocolError('Invalid patrol return route or home labels')
      const route = [...steps, ...returning]
      return this.scan(
        { views: route.length + 1, direction: 'left' },
        ctx,
        input.homeLabels.map((s) => s.trim()),
        undefined,
        route,
        undefined,
        true,
      )
    }
    return this.scan({ views: steps.length + 1, direction: 'left' }, ctx, undefined, undefined, steps)
  }
  async transport(
    input: { steps: RouteStep[]; labels: string[]; destinationLabels: string[]; supervised: true },
    ctx: ToolContext,
  ) {
    const validLabels = (labels: unknown): labels is string[] =>
      Array.isArray(labels) &&
      labels.length >= 1 &&
      labels.length <= 12 &&
      labels.every((label) => typeof label === 'string' && !!label.trim() && label.length <= 256)
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'destinationLabels,labels,steps,supervised' ||
      input.supervised !== true ||
      !validLabels(input.labels) ||
      !validLabels(input.destinationLabels) ||
      !this.geometry
    )
      throw new AkaProtocolError('Invalid supervised transport request')
    const steps = copyRoute(input.steps)
    return this.scan(
      { views: steps.length + 1, direction: 'left' },
      ctx,
      input.labels.map((label) => label.trim()),
      undefined,
      steps,
      { destinationLabels: input.destinationLabels.map((label) => label.trim()) },
    )
  }
  private async presetCalibration(ctx: ToolContext) {
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device || !this.geometry)
      throw new AkaProtocolError('Current device calibration unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations)
    if (!registration) throw new AkaProtocolError('Device registration unavailable')
    const calibration = await this.geometry.read(ctx, {
      bindingRevision: binding.bindingRevision,
      configRevision: registration.configRevision,
    })
    if (!calibration) throw new AkaProtocolError('Saved calibration unavailable')
    return calibration
  }
  async patrolPreset(input: { supervised: true }, ctx: ToolContext) {
    if (!input || Object.keys(input).join(',') !== 'supervised' || input.supervised !== true)
      throw new AkaProtocolError('Invalid saved patrol request')
    const calibration = await this.presetCalibration(ctx),
      route = calibration.routes?.patrol
    if (!route) throw new AkaProtocolError('Save patrol and return route first')
    const steps = [...route.steps, ...route.returnSteps]
    return this.scan(
      { views: steps.length + 1, direction: 'left' },
      ctx,
      route.homeLabels,
      undefined,
      steps,
      undefined,
      true,
      { id: calibration.id, revision: calibration.revision },
    )
  }
  async missionPreset(
    input: { goal: 'dispose' | 'retrieve'; labels: string[]; standoffMeters: number; supervised: true },
    ctx: ToolContext,
  ) {
    if (!input || Object.keys(input).sort().join(',') !== 'goal,labels,standoffMeters,supervised')
      throw new AkaProtocolError('Invalid saved mission request')
    const calibration = await this.presetCalibration(ctx),
      route = calibration.routes?.delivery
    if (!route) throw new AkaProtocolError('Save delivery route and destination labels first')
    return this.mission({ ...input, ...route }, ctx, { id: calibration.id, revision: calibration.revision })
  }
  async mission(
    raw: MissionInput,
    ctx: ToolContext,
    preset?: { id: string; revision: number },
  ): Promise<ToolResult> {
    const input = parseMission(raw)
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device || !this.geometry)
      throw new AkaProtocolError('Mission device unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations),
      id = binding.deviceId.toLowerCase()
    if (!registration) throw new AkaProtocolError('Mission registration unavailable')
    const versions = { bindingRevision: binding.bindingRevision, configRevision: registration.configRevision }
    const calibration = await this.geometry.read(ctx, versions),
      runtime = this.deps.pool.find(registration)
    if (preset && (calibration?.id !== preset.id || calibration.revision !== preset.revision))
      throw new AkaProtocolError('Saved route changed')
    if (
      !calibration?.motion ||
      !calibration.grasp ||
      input.standoffMeters < calibration.motion.minimumStandoff ||
      input.standoffMeters < calibration.grasp.forwardMin ||
      input.standoffMeters > calibration.grasp.forwardMax
    )
      throw new AkaProtocolError('Mission requires measured approach and grasp window')
    if (
      runtime?.snapshot().control.phase !== 'idle' ||
      this.deps.busy.has(id) ||
      (this.entries.get(id) && !this.entries.get(id)?.state.endedAt) ||
      (this.missions.get(id) && !this.missions.get(id)?.state.endedAt)
    )
      throw new AkaProtocolError('Device task already running')
    const controller = new AbortController(),
      signal = AbortSignal.any([
        ctx.signal,
        controller.signal,
        this.deps.api.ctx.signal,
        AbortSignal.timeout(180000),
      ])
    const invocation = { ...ctx, signal }
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: Entry & { invocation: ToolContext } = {
      invocation,
      controller,
      done,
      finish,
      photos: [],
      state: {
        taskId: randomUUID(),
        sessionId: ctx.session.key,
        deviceId: id,
        ...versions,
        kind: 'mission',
        phase: 'capturing',
        completedViews: 0,
        requestedViews: input.goal === 'dispose' ? 5 : 4,
        startedAt: new Date().toISOString(),
        endedAt: null,
        coverage: 'unmeasured',
        physicalResult: 'unverified',
        error: null,
      },
    }
    this.missions.set(id, entry)
    let result: ToolResult = { content: [], isError: true }
    try {
      let destination = await this.geometry.observation(invocation, versions, Date.now() - 1500)
      if (!destination) {
        await runDeviceControl(
          this.deps,
          invocation,
          { ...versions, action: 'stop', speed: 1, milliseconds: 1 },
          false,
        )
        const since = Date.now() + 300,
          after = performance.now() + 300
        ctx.progress('捡取前：停车等待新照片，核对投放位置')
        for (const deadline = performance.now() + CLOUD_OBSERVATION_MS; performance.now() < deadline; ) {
          signal.throwIfAborted()
          destination = await this.geometry.observation(
            invocation,
            versions,
            since,
            after,
            CLOUD_OBSERVATION_MS,
          )
          if (performance.now() >= deadline) {
            destination = null
            break
          }
          if (destination) break
          await delay(200, undefined, { signal })
        }
      }
      if (
        !destination?.artifact ||
        destination.detections.filter(
          (d) =>
            typeof d.confidence === 'number' &&
            d.confidence >= 0.6 &&
            input.destinationLabels.some((s) => s.toLowerCase() === d.label.trim().toLowerCase()),
        ).length !== 1
      )
        throw new AkaProtocolError('Destination must be observed before pickup')
      const stage = async (run: () => Promise<ToolResult>) => {
        signal.throwIfAborted()
        const current = await this.geometry?.read(invocation, versions)
        if (current?.id !== calibration.id || current.revision !== calibration.revision)
          throw new AkaProtocolError('Mission calibration changed')
        return run()
      }
      result = await runMissionStages(
        input.goal,
        invocation,
        {
          find: () =>
            stage(() => this.find({ views: 6, direction: 'left', labels: input.labels }, invocation)),
          approach: () =>
            stage(() =>
              this.approach(
                {
                  labels: input.labels,
                  standoffMeters: input.standoffMeters,
                  maxSteps: 12,
                  supervised: true,
                },
                invocation,
              ),
            ),
          grab: () =>
            stage(() =>
              this.grasp(
                { action: 'grab', labels: input.labels, destinationLabels: [], supervised: true },
                invocation,
              ),
            ),
          transport: () =>
            stage(() =>
              this.transport(
                {
                  steps: input.steps,
                  labels: input.labels,
                  destinationLabels: input.destinationLabels,
                  supervised: true,
                },
                invocation,
              ),
            ),
          release: () =>
            stage(() =>
              this.grasp(
                {
                  action: 'release',
                  labels: input.labels,
                  destinationLabels: input.destinationLabels,
                  supervised: true,
                },
                invocation,
              ),
            ),
        },
        (name, receipt) => {
          entry.state.stage = name
          const child = this.entries.get(id)
          if (child) entry.photos.push(...child.photos)
          if (!receipt.isError) entry.state.completedViews++
        },
      )
      entry.state.phase = result.isError ? 'failed' : 'completed'
      const completed = result.structured as {
        gripEvidence?: ScanTaskState['gripEvidence']
        failedStage?: string
      }
      if (completed.gripEvidence) entry.state.gripEvidence = completed.gripEvidence
      if (completed.failedStage) entry.state.error = `Stage ${completed.failedStage} unconfirmed`
    } catch (error) {
      entry.state.phase = signal.aborted ? 'cancelled' : 'failed'
      entry.state.error =
        error instanceof AkaProtocolError
          ? error.message
          : 'Mission interrupted or current stage evidence unavailable'
      result.content = entry.photos.map((photo) => ({
        type: 'image',
        ref: { ...photo.ref },
        mime: 'image/jpeg',
      }))
    } finally {
      try {
        if ((await runtime.stopControl()).state === 'unknown') {
          entry.state.phase = 'failed'
          entry.state.error = 'Motor stop unknown'
        }
      } catch {
        entry.state.phase = 'failed'
        entry.state.error = 'Motor stop unknown'
      }
      entry.state.endedAt = new Date().toISOString()
      entry.finish()
      this.entries.set(id, entry)
    }
    return {
      content: uniqueImageContent([{ type: 'text', text: JSON.stringify(entry.state) }, ...result.content]),
      structured: { ...entry.state, stages: result.structured },
      ...(entry.state.phase === 'completed' ? {} : { isError: true }),
    }
  }
  async orbit(
    input: { labels: string[]; direction: 'left' | 'right'; supervised: true },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'direction,labels,supervised' ||
      input.supervised !== true ||
      !['left', 'right'].includes(input.direction) ||
      !Array.isArray(input.labels) ||
      !input.labels.length ||
      input.labels.length > 12 ||
      input.labels.some((s) => typeof s !== 'string' || !s.trim() || s.length > 256) ||
      !this.geometry
    )
      throw new AkaProtocolError('Invalid supervised orbit')
    const labels = input.labels.map((s) => s.trim()),
      binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device)
      throw new AkaProtocolError('Orbit device unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations),
      id = binding.deviceId.toLowerCase()
    if (!registration) throw new AkaProtocolError('Orbit registration unavailable')
    const versions = {
        bindingRevision: binding.bindingRevision,
        configRevision: registration.configRevision,
      },
      calibration = await this.geometry.read(ctx, versions),
      runtime = this.deps.pool.find(registration)
    if (
      !calibration?.motion ||
      runtime?.snapshot().media !== 'streaming' ||
      this.deps.owners.get(id)?.sessionId !== ctx.session.key
    )
      throw new AkaProtocolError('Orbit requires connected camera and measured ground/motion calibration')
    if (
      runtime.snapshot().control.phase !== 'idle' ||
      this.deps.busy.has(id) ||
      (this.entries.get(id) && !this.entries.get(id)?.state.endedAt) ||
      (this.missions.get(id) && !this.missions.get(id)?.state.endedAt)
    )
      throw new AkaProtocolError('Device task already running')
    const controller = new AbortController(),
      signal = AbortSignal.any([
        ctx.signal,
        controller.signal,
        this.deps.api.ctx.signal,
        AbortSignal.timeout(180000),
      ])
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: Entry = {
      controller,
      done,
      finish,
      photos: [],
      state: {
        taskId: randomUUID(),
        sessionId: ctx.session.key,
        deviceId: id,
        ...versions,
        kind: 'orbit',
        phase: 'capturing',
        completedViews: 0,
        requestedViews: 4,
        startedAt: new Date().toISOString(),
        endedAt: null,
        coverage: 'unmeasured',
        physicalResult: 'unverified',
        error: null,
        viewpoints: [],
      },
    }
    this.entries.set(id, entry)
    const invocation = { ...ctx, signal },
      content: ToolResult['content'] = []
    const profile = calibration.motion
    let orbit: ReturnType<typeof createOrbit> | undefined,
      sourceLabel: string | undefined,
      pulses = 0
    try {
      for (let view = 0; view < 4; view++) {
        if (orbit)
          for (;;) {
            signal.throwIfAborted()
            const current = await this.geometry.read(invocation, versions)
            if (current?.id !== calibration.id || current.revision !== calibration.revision)
              throw new AkaProtocolError('Orbit calibration changed')
            const action = orbitStep(orbit, view, profile)
            if (action === 'observe') break
            if (++pulses > 200) throw new AkaProtocolError('Orbit pulse budget exhausted')
            entry.state.phase = action === 'up' ? 'approaching' : 'turning'
            await runDeviceControl(
              this.deps,
              invocation,
              { ...versions, action, speed: profile.speed, milliseconds: profile.milliseconds },
              false,
            )
            applyOrbitStep(orbit, action, profile)
          }
        await runDeviceControl(
          this.deps,
          invocation,
          { ...versions, action: 'stop', speed: 1, milliseconds: 1 },
          false,
        )
        const since = Date.now() + 300,
          after = performance.now() + 300
        entry.state.phase = 'capturing'
        let image: Awaited<ReturnType<GroundGeometry['observation']>> = null
        for (const deadline = performance.now() + CLOUD_OBSERVATION_MS; performance.now() < deadline; ) {
          signal.throwIfAborted()
          image = await this.geometry.observation(invocation, versions, since, after, CLOUD_OBSERVATION_MS)
          if (performance.now() >= deadline) {
            image = null
            break
          }
          if (image?.artifact) break
          await delay(200, undefined, { signal })
        }
        if (!image?.artifact || entry.photos.some((photo) => photo.ref.sha256 === image?.artifact?.sha256))
          throw new AkaProtocolError('Distinct orbit original unavailable')
        const photo = { ref: { ...image.artifact }, selection: image as unknown }
        entry.photos.push(photo)
        content.push({ type: 'image', ref: { ...image.artifact }, mime: 'image/jpeg' })
        const current = await this.geometry.read(invocation, versions)
        if (current?.id !== calibration.id || current.revision !== calibration.revision)
          throw new AkaProtocolError('Orbit calibration changed')
        const matches = image.detections.filter(
            (d) =>
              typeof d.confidence === 'number' &&
              d.confidence >= 0.6 &&
              labels.some((s) => s.toLowerCase() === d.label.trim().toLowerCase()),
          ),
          target = matches.length === 1 ? matches[0] : undefined
        const position = target && estimateGround(calibration, image, target.label, target.box)
        if (position?.state !== 'estimated' || (sourceLabel && target?.label !== sourceLabel))
          throw new AkaProtocolError('Orbit target or distance ambiguous')
        const observed = {
          forward: position.forward,
          left: position.left,
          error: position.observedErrorMeters,
        }
        if (!orbit) {
          orbit = createOrbit(observed, profile, input.direction)
          sourceLabel = target?.label
        }
        const viewpoint = observeOrbit(orbit, observed, view)
        entry.state.viewpoints?.push({ ...viewpoint, resultId: image.id })
        photo.selection = { ...image, viewpoint }
        content.push({
          type: 'text',
          text: JSON.stringify({ ...viewpoint, resultId: image.id, viewpointGeometry: 'estimated' }),
        })
        entry.state.completedViews++
        ctx.progress(`绕物拍摄 ${view + 1}/4：估计视角已核对，原图已保存`)
      }
      entry.state.phase = 'completed'
    } catch (error) {
      entry.state.phase = signal.aborted ? 'cancelled' : 'failed'
      entry.state.error =
        error instanceof AkaProtocolError
          ? error.message
          : 'Orbit stopped: target, viewpoint, clearance or motion evidence unconfirmed'
    } finally {
      try {
        if ((await runtime.stopControl()).state === 'unknown') {
          entry.state.phase = 'failed'
          entry.state.error = 'Motor stop unknown'
        }
      } catch {
        entry.state.phase = 'failed'
        entry.state.error = 'Motor stop unknown'
      }
      entry.state.endedAt = new Date().toISOString()
      entry.finish()
    }
    return {
      content: uniqueImageContent([{ type: 'text', text: JSON.stringify(entry.state) }, ...content]),
      structured: { ...entry.state, viewpointGeometry: 'estimated', viewpointsVerified: false },
      ...(entry.state.phase === 'completed' ? {} : { isError: true }),
    }
  }
  async approach(
    input: { labels: string[]; standoffMeters: number; maxSteps: number; supervised: true },
    ctx: ToolContext,
  ) {
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'labels,maxSteps,standoffMeters,supervised' ||
      input.supervised !== true ||
      !Number.isSafeInteger(input.maxSteps) ||
      input.maxSteps < 1 ||
      input.maxSteps > 12 ||
      !Number.isFinite(input.standoffMeters) ||
      input.standoffMeters < 0.05 ||
      input.standoffMeters > 2 ||
      !Array.isArray(input.labels) ||
      input.labels.length < 1 ||
      input.labels.length > 12 ||
      input.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 256) ||
      !this.geometry
    )
      throw new AkaProtocolError('Invalid supervised approach request')
    return this.scan(
      { views: input.maxSteps + 1, direction: 'left' },
      ctx,
      input.labels.map((label) => label.trim()),
      { standoff: input.standoffMeters },
    )
  }
  async grasp(
    input: { action: 'grab' | 'release'; labels: string[]; destinationLabels: string[]; supervised: true },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const validLabels = (values: unknown): values is string[] =>
      Array.isArray(values) &&
      values.length <= 12 &&
      values.every((value) => typeof value === 'string' && !!value.trim() && value.length <= 256)
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'action,destinationLabels,labels,supervised' ||
      input.supervised !== true ||
      !['grab', 'release'].includes(input.action) ||
      !validLabels(input.labels) ||
      !input.labels.length ||
      !validLabels(input.destinationLabels) ||
      (input.action === 'release' && !input.destinationLabels.length) ||
      !this.geometry
    )
      throw new AkaProtocolError('Invalid grasp request')
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device)
      throw new AkaProtocolError('Grasp device unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations)
    const runtime = registration && this.deps.pool.find(registration),
      id = binding.deviceId.toLowerCase()
    if (
      this.missions.get(id) &&
      !this.missions.get(id)?.state.endedAt &&
      this.missions.get(id)?.invocation !== ctx
    )
      throw new AkaProtocolError('Mission owns device')
    if (
      !registration ||
      this.deps.owners.get(id)?.sessionId !== ctx.session.key ||
      runtime?.snapshot().media !== 'streaming' ||
      runtime.snapshot().control.phase !== 'idle' ||
      this.deps.busy.has(id) ||
      (this.entries.get(id) && !this.entries.get(id)?.state.endedAt)
    )
      throw new AkaProtocolError('Connect idle control session and camera before grasping')
    const versions = { bindingRevision: binding.bindingRevision, configRevision: registration.configRevision }
    const calibration = await this.geometry.read(ctx, versions)
    if (!calibration?.grasp) return notStarted('Save measured grasp and observation regions first')
    const grasp = calibration.grasp
    if (
      this.deps.busy.has(id) ||
      runtime.snapshot().control.phase !== 'idle' ||
      (this.entries.get(id) && !this.entries.get(id)?.state.endedAt)
    )
      throw new AkaProtocolError('Device task already running')
    const controller = new AbortController()
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: Entry = {
      photos: [],
      controller,
      done,
      finish,
      state: {
        taskId: randomUUID(),
        sessionId: ctx.session.key,
        deviceId: id,
        ...versions,
        kind: input.action === 'grab' ? 'grasp' : 'release',
        phase: 'capturing',
        completedViews: 0,
        requestedViews: 3,
        startedAt: new Date().toISOString(),
        endedAt: null,
        coverage: 'unmeasured',
        physicalResult: 'unverified',
        error: null,
        targetLabels: [...input.labels],
        gripEvidence: 'unknown',
      },
    }
    this.entries.set(id, entry)
    const signal = AbortSignal.any([
      ctx.signal,
      controller.signal,
      this.deps.api.ctx.signal,
      AbortSignal.timeout(45000),
    ])
    const invocation = { ...ctx, signal },
      content: ToolResult['content'] = []
    let actionSent = false,
      since = Date.now() + 300,
      after = performance.now() + 300
    let previousImage: { id: string; frameId: string | undefined } | undefined,
      sourceLabel: string | undefined
    const labels = (
      items: readonly {
        label: string
        confidence?: number
        box: readonly [number, number, number, number]
      }[],
      requested: string[],
    ) =>
      items.filter(
        (item) =>
          typeof item.confidence === 'number' &&
          item.confidence >= 0.6 &&
          requested.some((label) => label.trim().toLowerCase() === item.label.trim().toLowerCase()),
      )
    try {
      await runDeviceControl(
        this.deps,
        invocation,
        { ...versions, action: 'stop', speed: 1, milliseconds: 1 },
        false,
      )
      since = Date.now() + 300
      after = performance.now() + 300
      for (let index = 0; index < 3; index++) {
        signal.throwIfAborted()
        entry.state.phase = index ? 'verifying' : 'capturing'
        let image: Awaited<ReturnType<GroundGeometry['observation']>> = null
        for (const deadline = performance.now() + CLOUD_OBSERVATION_MS; performance.now() < deadline; ) {
          image = await this.geometry.observation(invocation, versions, since, after, CLOUD_OBSERVATION_MS)
          signal.throwIfAborted()
          if (performance.now() >= deadline) {
            image = null
            break
          }
          if (
            image?.artifact &&
            (!previousImage || (image.id !== previousImage.id && image.frameId !== previousImage.frameId))
          )
            break
          image = null
          await delay(200, undefined, { signal })
        }
        if (!image?.artifact) throw new AkaProtocolError('Distinct fresh recognition unavailable')
        const current = await this.geometry.read(invocation, versions)
        signal.throwIfAborted()
        if (
          current?.id !== calibration.id ||
          current.revision !== calibration.revision ||
          image.width !== calibration.width ||
          image.height !== calibration.height
        )
          throw new AkaProtocolError('Grasp calibration changed')
        entry.photos.push({ ref: { ...image.artifact }, selection: image })
        content.push(
          {
            type: 'text',
            text: JSON.stringify({
              stage: index ? 'after' : 'before',
              resultId: image.id,
              frameId: image.frameId,
              detections: image.detections,
            }),
          },
          { type: 'image', ref: { ...image.artifact }, mime: 'image/jpeg' },
        )
        entry.state.completedViews++
        const targets = labels(image.detections, input.labels),
          target = targets.length === 1 ? targets[0] : undefined
        if (!target || (sourceLabel && target.label !== sourceLabel)) {
          entry.state.outcome = 'paused'
          entry.state.outcomeReason = 'target_or_grasp_observation_ambiguous'
          break
        }
        if (!index) {
          sourceLabel = target.label
          if (input.action === 'grab') {
            const position = estimateGround(calibration, image, target.label, target.box)
            if (
              position.state !== 'estimated' ||
              position.forward - position.observedErrorMeters < grasp.forwardMin ||
              position.forward + position.observedErrorMeters > grasp.forwardMax ||
              Math.abs(position.left) + position.observedErrorMeters > grasp.lateralTolerance ||
              boxInside(target.box, grasp.heldBox)
            ) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'target_outside_measured_grasp_window'
              break
            }
          } else if (
            !boxInside(target.box, grasp.heldBox) ||
            !labels(image.detections, input.destinationLabels).some((destination) =>
              boxInside(grasp.releaseBox, destination.box),
            )
          ) {
            entry.state.outcome = 'paused'
            entry.state.outcomeReason = 'held_target_or_destination_not_observed'
            break
          }
          entry.state.phase = 'gripping'
          ctx.progress(
            input.action === 'grab'
              ? '夹取一次，等待新图核对；动作回执不等于持物'
              : '释放一次，等待新图核对落点',
          )
          actionSent = true
          entry.state.armReceipt = 'unknown'
          const started = performance.now()
          const receipt = await runDeviceControl(
            this.deps,
            invocation,
            { ...versions, action: input.action, speed: 1, milliseconds: 1 },
            false,
          )
          if (receipt.state === 'sent') throw new AkaProtocolError('Arm receipt unavailable')
          entry.state.armReceipt = receipt.state
          await delay(Math.max(0, grasp.settleMilliseconds - (performance.now() - started)), undefined, {
            signal,
          })
        } else {
          const expectedRegion = input.action === 'grab' ? grasp.heldBox : grasp.releaseBox
          if (
            !boxInside(target.box, expectedRegion) ||
            (input.action === 'release' &&
              !labels(image.detections, input.destinationLabels).some((destination) =>
                boxInside(grasp.releaseBox, destination.box),
              ))
          ) {
            entry.state.outcome = 'paused'
            entry.state.outcomeReason = 'grasp_or_release_not_visually_confirmed'
            break
          }
          if (index === 2)
            entry.state.gripEvidence = input.action === 'grab' ? 'held_candidate' : 'released_candidate'
        }
        // Fresh acquisitions may have identical pixels once the arm and camera stop moving.
        previousImage = { id: image.id, frameId: image.frameId }
        since = Date.now() + 400
        after = performance.now() + 400
      }
      entry.state.phase = 'completed'
    } catch {
      entry.state.phase = controller.signal.aborted || ctx.signal.aborted ? 'cancelled' : 'failed'
      entry.state.error =
        'Grasp interrupted or new physical evidence unavailable; never automatically repeat the arm command'
    } finally {
      if (actionSent) {
        try {
          if ((await runtime.stopControl()).state === 'unknown') {
            entry.state.error = 'Motor stop outcome unknown; arm is not cancelled'
            entry.state.phase = 'failed'
          }
        } catch {
          entry.state.error = 'Motor stop outcome unknown; arm is not cancelled'
          entry.state.phase = 'failed'
        }
      }
      entry.state.endedAt = new Date().toISOString()
      entry.finish()
    }
    return {
      content: uniqueImageContent([{ type: 'text', text: JSON.stringify(entry.state) }, ...content]),
      structured: { ...entry.state },
      ...(entry.state.phase === 'completed' ? {} : { isError: true }),
    }
  }
  async scan(
    input: { views: number; direction: 'left' | 'right' },
    ctx: ToolContext,
    labels?: string[],
    approach?: { standoff: number },
    route?: PatrolStep[],
    transport?: { destinationLabels: string[] },
    returnHome = false,
    preset?: { id: string; revision: number },
    workflow?: 'surround',
  ): Promise<ToolResult> {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'direction,views' ||
      !Number.isSafeInteger(input.views) ||
      input.views < 2 ||
      input.views > (labels && !approach && !route ? 6 : 13) ||
      !['left', 'right'].includes(input.direction)
    )
      throw new AkaProtocolError('Invalid scan request')
    const binding = await ctx.device?.binding()
    if (!binding?.active || binding.sessionId !== ctx.session.key || !ctx.device)
      throw new AkaProtocolError('Scan device unavailable')
    const registration = await readRegistration(ctx.device, binding, this.deps.registrations)
    const owner = this.deps.owners.get(binding.deviceId.toLowerCase())
    const runtime = registration && this.deps.pool.find(registration)
    if (!registration || owner?.sessionId !== ctx.session.key || runtime?.snapshot().media !== 'streaming')
      throw new AkaProtocolError('Connect the control session and camera before scanning')
    const versions = { bindingRevision: binding.bindingRevision, configRevision: registration.configRevision }
    const calibration = approach || transport || returnHome ? await this.geometry?.read(ctx, versions) : null
    if (preset && (calibration?.id !== preset.id || calibration.revision !== preset.revision))
      throw new AkaProtocolError('Saved route changed')
    if (returnHome && !calibration) return notStarted('Save ground calibration for patrol home marker')
    if (transport && !calibration?.grasp)
      return notStarted('Save measured grasp observation regions before transport')
    if (approach && (!calibration?.motion || approach.standoff < calibration.motion.minimumStandoff))
      return notStarted('Save ground and measured motion calibration before approaching')
    const id = binding.deviceId.toLowerCase()
    if (
      this.missions.get(id) &&
      !this.missions.get(id)?.state.endedAt &&
      this.missions.get(id)?.invocation !== ctx
    )
      throw new AkaProtocolError('Mission owns device')
    if (this.deps.busy.has(id) || runtime.snapshot().control.phase !== 'idle')
      throw new AkaProtocolError('Device control busy or unresolved')
    const old = this.entries.get(id)
    if (old && !old.state.endedAt) throw new AkaProtocolError('Device task already running')
    const controller = new AbortController()
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: Entry = {
      photos: [],
      controller,
      done,
      finish,
      state: {
        taskId: randomUUID(),
        sessionId: ctx.session.key,
        deviceId: id,
        bindingRevision: binding.bindingRevision,
        configRevision: registration.configRevision,
        kind: transport ? 'transport' : route ? 'patrol' : approach ? 'approach' : labels ? 'search' : 'scan',
        ...(route ? { route } : {}),
        ...(returnHome ? { homeEvidence: 'unknown' as const } : {}),
        ...(labels ? { targetFound: false, targetLabels: labels } : {}),
        phase: 'capturing',
        completedViews: 0,
        requestedViews: input.views,
        startedAt: new Date().toISOString(),
        endedAt: null,
        coverage: 'unmeasured',
        physicalResult: 'unverified',
        error: null,
      },
    }
    this.entries.set(id, entry)
    const signal = AbortSignal.any([
      ctx.signal,
      controller.signal,
      this.deps.api.ctx.signal,
      AbortSignal.timeout(route || approach ? 180000 : 90000),
    ])
    const invocation = { ...ctx, signal }
    const content: ToolResult['content'] = []
    let afterReceivedAt: number | undefined = labels ? performance.now() + 300 : undefined
    let recognizedAfter = Date.now() + 300
    let nextAction: 'up' | 'down' | 'left' | 'right' = input.direction
    let previous: { position: Position; action: 'up' | 'left' | 'right'; label: string } | undefined
    let movementAttempted = false
    let heldLabel: string | undefined
    let homePosition: Position | undefined
    let homeLabel: string | undefined
    let lastMotion: unknown = null
    try {
      if (route) {
        await runDeviceControl(
          this.deps,
          invocation,
          { ...versions, action: 'stop', speed: 1, milliseconds: 1 },
          false,
        )
        afterReceivedAt = performance.now()
        await delay(300, undefined, { signal })
      }
      for (let i = 0; i < input.views; i++) {
        signal.throwIfAborted()
        if (i) {
          const routeStep = route?.[i - 1]
          if (routeStep) nextAction = routeStep.action
          if (approach || transport || returnHome) {
            const current = await this.geometry?.read(invocation, versions)
            signal.throwIfAborted()
            if (current?.id !== calibration?.id || current?.revision !== calibration?.revision)
              throw new AkaProtocolError('Approach calibration changed')
          }
          entry.state.phase = nextAction === 'up' || nextAction === 'down' ? 'approaching' : 'turning'
          ctx.progress(
            `${route ? '巡逻记录' : approach ? '接近观察' : '观察采样'} ${i + 1}/${input.views}：${nextAction === 'up' ? '短步前进' : nextAction === 'down' ? '短步后退' : '有限转向'}`,
          )
          movementAttempted = true
          const requestedMotion = {
            action: nextAction,
            speed: routeStep?.speed ?? calibration?.motion?.speed ?? 30,
            milliseconds: routeStep?.milliseconds ?? calibration?.motion?.milliseconds ?? 1000,
          }
          const motionReceipt = await runDeviceControl(
            this.deps,
            invocation,
            {
              ...versions,
              ...requestedMotion,
            },
            false,
            workflow ? { id: workflow } : undefined,
          )
          lastMotion = { round: i, ...requestedMotion, receipt: motionReceipt }
          afterReceivedAt = performance.now()
          recognizedAfter = Date.now() + 300
          entry.state.phase = 'capturing'
          // Only read frame availability while waiting; never retry an artifact write or motor action.
          for (let wait = 0; wait < 20; wait++) {
            await delay(50, undefined, { signal })
            if ((runtime.latestFrame()?.receivedAt ?? 0) > afterReceivedAt) break
          }
          await delay(300, undefined, { signal })
        }
        entry.state.phase = 'capturing'
        if (labels) {
          let observation: Awaited<ReturnType<GroundGeometry['observation']>> = null
          ctx.progress(`观察 ${i + 1}/${input.views}：停车等待新照片的云端识别`)
          for (const deadline = performance.now() + CLOUD_OBSERVATION_MS; performance.now() < deadline; ) {
            signal.throwIfAborted()
            observation =
              (await this.geometry?.observation(
                invocation,
                versions,
                recognizedAfter,
                afterReceivedAt,
                CLOUD_OBSERVATION_MS,
              )) ?? null
            if (performance.now() >= deadline) {
              observation = null
              break
            }
            if (observation) break
            await delay(200, undefined, { signal })
          }
          signal.throwIfAborted()
          if (!observation?.artifact)
            throw new AkaProtocolError(
              'Fresh recognition unavailable; enable the page recognition switch first',
            )
          const matched = observation.detections.filter(
            (item) =>
              labels.some((label) => label.toLocaleLowerCase() === item.label.trim().toLocaleLowerCase()) &&
              typeof item.confidence === 'number' &&
              item.confidence >= 0.6,
          )
          content.push(
            {
              type: 'text',
              text: JSON.stringify({
                observation: i + 1,
                resultId: observation.id,
                frameId: observation.frameId,
                detections: observation.detections,
                matched,
              }),
            },
            { type: 'image', ref: { ...observation.artifact }, mime: 'image/jpeg' },
          )
          entry.photos.push({ ref: { ...observation.artifact }, selection: observation })
          if (returnHome && calibration && (i === 0 || i === input.views - 1)) {
            const current = await this.geometry?.read(invocation, versions)
            signal.throwIfAborted()
            if (current?.id !== calibration.id || current.revision !== calibration.revision)
              throw new AkaProtocolError('Home calibration changed')
            const target = matched.length === 1 ? matched[0] : undefined
            const position = target && estimateGround(calibration, observation, target.label, target.box)
            if (position?.state !== 'estimated' || position.observedErrorMeters > 0.025) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'home_marker_or_distance_unknown'
            } else if (i === 0) {
              homePosition = {
                forward: position.forward,
                left: position.left,
                error: position.observedErrorMeters,
              }
              homeLabel = target?.label
            } else if (
              !homePosition ||
              target?.label !== homeLabel ||
              Math.hypot(position.forward - homePosition.forward, position.left - homePosition.left) >
                0.1 - position.observedErrorMeters - homePosition.error
            ) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'home_marker_pose_not_reached'
            } else entry.state.homeEvidence = 'observed_candidate'
          }
          if (transport && calibration?.grasp) {
            const current = await this.geometry?.read(invocation, versions)
            signal.throwIfAborted()
            if (
              current?.id !== calibration.id ||
              current.revision !== calibration.revision ||
              observation.width !== calibration.width ||
              observation.height !== calibration.height
            )
              throw new AkaProtocolError('Transport calibration changed')
            const evidence = transportObservation(
              observation.detections,
              labels,
              transport.destinationLabels,
              calibration.grasp.heldBox,
              calibration.grasp.releaseBox,
            )
            if (!evidence.held || (heldLabel && heldLabel !== evidence.label)) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'held_target_lost_or_ambiguous'
              entry.state.gripEvidence = 'unknown'
            } else if (i === 0 && !evidence.destinationVisible) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'destination_not_observed_before_transport'
            } else if (i === input.views - 1 && !evidence.releaseAligned) {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason = 'destination_not_aligned_after_transport'
            } else {
              heldLabel = evidence.label
              entry.state.gripEvidence = 'held_candidate'
            }
          }
          if (matched.length) {
            entry.state.targetFound = true
            entry.state.matchedResultId = observation.id
          }
          if (approach && calibration?.motion) {
            const current = await this.geometry?.read(invocation, versions)
            signal.throwIfAborted()
            if (current?.id !== calibration.id || current.revision !== calibration.revision)
              throw new AkaProtocolError('Approach calibration changed')
            const detection = matched.length === 1 ? matched[0] : undefined
            const estimated =
              detection && estimateGround(calibration, observation, detection.label, detection.box)
            if (estimated?.state !== 'estimated') {
              entry.state.outcome = 'paused'
              entry.state.outcomeReason =
                matched.length > 1 ? 'ambiguous_target' : 'target_or_distance_unknown'
            } else {
              const position = {
                forward: estimated.forward,
                left: estimated.left,
                error: estimated.observedErrorMeters,
              }
              if (
                previous &&
                (previous.label !== detection?.label ||
                  !compatiblePosition(previous.position, position, previous.action, calibration.motion))
              ) {
                entry.state.outcome = 'paused'
                entry.state.outcomeReason = 'target_changed_or_motion_outside_measured_range'
              } else {
                const decision = planApproach(position, calibration.motion, approach.standoff)
                content.push({
                  type: 'text',
                  text: JSON.stringify({
                    position,
                    decision,
                    calibrationId: calibration.id,
                    calibrationRevision: calibration.revision,
                  }),
                })
                if ('outcome' in decision) {
                  entry.state.outcome = decision.outcome
                  entry.state.outcomeReason = decision.reason
                } else {
                  nextAction = decision.action
                  previous = { position, action: decision.action, label: detection?.label ?? '' }
                }
              }
            }
          }
        } else {
          const photo = await capturePhoto(this.deps, invocation, {
            ...versions,
            ...(afterReceivedAt === undefined ? {} : { afterReceivedAt }),
          })
          content.push(
            {
              type: 'text',
              text: route
                ? `巡逻记录 ${i + 1}：${i === 0 ? '起点' : `路线第${i}段停车后`}；位置与返回起点未验证。`
                : `观察图 ${i + 1}：转角未测量，不能据此声称覆盖一整圈或绕物四视角。`,
            },
            ...photo.content,
          )
          const image = photo.content.find((item) => item.type === 'image')
          if (image?.type !== 'image') throw new AkaProtocolError('Photo image missing')
          entry.photos.push({ ref: { ...image.ref }, selection: photo.structured, motion: lastMotion })
        }
        entry.state.completedViews++
        ctx.progress(`观察采样 ${entry.state.completedViews}/${input.views}：照片已保存`)
        if (entry.state.outcome || (!approach && !transport && !route && entry.state.targetFound)) break
      }
      if (approach && !entry.state.outcome) {
        entry.state.outcome = 'step_limit'
        entry.state.outcomeReason = 'requested_step_budget_exhausted'
      }
      entry.state.phase = 'completed'
    } catch (error) {
      entry.state.phase = controller.signal.aborted || ctx.signal.aborted ? 'cancelled' : 'failed'
      entry.state.error =
        error instanceof AkaProtocolError
          ? error.message
          : 'Scan interrupted or a camera/control result could not be confirmed'
    } finally {
      // Independent stop remains available even when the task signal has expired.
      try {
        if (movementAttempted && (await runtime.stopControl()).state === 'unknown') {
          entry.state.error = 'Stop outcome unknown'
          if (entry.state.phase === 'completed') entry.state.phase = 'failed'
        }
      } catch {
        entry.state.error = 'Stop outcome unknown'
        if (entry.state.phase === 'completed') entry.state.phase = 'failed'
      }
      entry.state.endedAt = new Date().toISOString()
      entry.finish()
    }
    const state = { ...entry.state }
    return {
      content: uniqueImageContent([{ type: 'text', text: JSON.stringify(state) }, ...content]),
      structured: state,
      ...(state.phase === 'completed' ? {} : { isError: true }),
    }
  }
}
export function registerScanTasks(
  register: (def: ServiceDef) => unknown,
  deps: CaptureDependencies,
  tasks: ScanTasks,
) {
  deps.api.registerTool({
    name: 'aka_patrol_saved',
    description:
      '现场监督下按当前设备已保存的巡逻和返程路线执行，沿途拍照识别，终点核对起点标记。不用重新输入动作时长，不擅自生成路线；未配置、配置变化或无法核对则停止。需开启页面识别。',
    parameters: Type.Object({ supervised: Type.Literal(true) }, { additionalProperties: false }),
    meta,
    execute: (input, ctx) => tasks.patrolPreset(input as { supervised: true }, ctx),
  })
  deps.api.registerTool({
    name: 'aka_mission_saved',
    description:
      '现场监督下复用当前设备已保存的搬运路线和目的地类别，完成寻物、接近、夹取、搬运和可选投放。dispose投放；retrieve到交接点后保留物品。labels与standoffMeters仍按实际样品及抓取窗口选择，不编造类别或路线。未配置或证据不明时停止，需开启页面识别。',
    parameters: Type.Object(
      {
        goal: Type.Union([Type.Literal('dispose'), Type.Literal('retrieve')]),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        standoffMeters: Type.Number({ minimum: 0.05, maximum: 2 }),
        supervised: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) =>
      tasks.missionPreset(
        input as { goal: 'dispose' | 'retrieve'; labels: string[]; standoffMeters: number; supervised: true },
        ctx,
      ),
  })
  deps.api.registerTool({
    name: 'aka_orbit_capture',
    description:
      '现场监督且物体固定、周围路线已清空时，依据已保存地面和实测运动标定，实际移动到物体周围四个约90度间隔的观察位置并拍照。每处重新识别唯一目标、核对位置和角度误差；同类歧义、目标消失、运动不一致或误差过大即停止。最多200短步/180秒，不抓取、无避障。返回四个估计视角的确切原图，可导出供建模；不是外部定位真值，不保证模型质量。',
    parameters: Type.Object(
      {
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        direction: Type.Union([Type.Literal('left'), Type.Literal('right')]),
        supervised: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) =>
      tasks.orbit(input as { labels: string[]; direction: 'left' | 'right'; supervised: true }, ctx),
  })
  deps.api.registerTool({
    name: 'aka_mission',
    description:
      '执行现场监督的完整寻物、接近、夹取、指定路线搬运及目的地核对任务。goal=dispose最后投放；retrieve保留物品等待交接。需已标定运动/地面/抓取窗口，开始前观察到唯一目的容器或交接标记，每阶段重新核对，不确定即停。steps只能使用用户明确指定并清空的路线，不能编造导航；无地图、无避障，不保证抓取或精确返还。需要开启页面识别。',
    parameters: Type.Object(
      {
        goal: Type.Union([Type.Literal('dispose'), Type.Literal('retrieve')]),
        supervised: Type.Literal(true),
        standoffMeters: Type.Number({ minimum: 0.05, maximum: 2 }),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        destinationLabels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1,
          maxItems: 12,
        }),
        steps: Type.Array(
          Type.Object(
            {
              action: Type.Union([
                Type.Literal('up'),
                Type.Literal('down'),
                Type.Literal('left'),
                Type.Literal('right'),
              ]),
              speed: Type.Integer({ minimum: 30, maximum: 50 }),
              milliseconds: Type.Integer({ minimum: 500, maximum: 3000 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) => tasks.mission(input as MissionInput, ctx),
  })
  deps.api.registerTool({
    name: 'aka_transport',
    description:
      '现场监督下沿用户明确指定的已清空路线搬运已夹取物品。开始前须在新识别图同时观察到唯一持物和目的容器；每段停车后重新核对持物，丢失、歧义或标定变化即暂停。终点核对投放区域位于唯一容器框内。最多12段，不探索未知路线、不自动释放、无地图定位；held_candidate仅是视觉候选证据。',
    parameters: Type.Object(
      {
        supervised: Type.Literal(true),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        destinationLabels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1,
          maxItems: 12,
        }),
        steps: Type.Array(
          Type.Object(
            {
              action: Type.Union([
                Type.Literal('up'),
                Type.Literal('down'),
                Type.Literal('left'),
                Type.Literal('right'),
              ]),
              speed: Type.Integer({ minimum: 30, maximum: 50 }),
              milliseconds: Type.Integer({ minimum: 500, maximum: 3000 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) =>
      tasks.transport(
        input as { steps: RouteStep[]; labels: string[]; destinationLabels: string[]; supervised: true },
        ctx,
      ),
  })
  deps.api.registerTool({
    name: 'aka_patrol',
    description:
      '现场监督下执行用户指定的清空路线，起点及每段停车后拍照。可同时提供returnSteps返程和homeLabels起点标记类别，去返程合计最多12段；返程需页面识别与地面标定，在终点重新核对唯一标记的相对位置，返回视觉候选证据。沿途原图和识别结果进会话。不能擅自编造路线，无地图、避障或精确定位。',
    parameters: Type.Object(
      {
        supervised: Type.Literal(true),
        returnSteps: Type.Optional(
          Type.Array(
            Type.Object(
              {
                action: Type.Union([
                  Type.Literal('up'),
                  Type.Literal('down'),
                  Type.Literal('left'),
                  Type.Literal('right'),
                ]),
                speed: Type.Integer({ minimum: 30, maximum: 50 }),
                milliseconds: Type.Integer({ minimum: 500, maximum: 3000 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 12 },
          ),
        ),
        homeLabels: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        ),
        steps: Type.Array(
          Type.Object(
            {
              action: Type.Union([
                Type.Literal('up'),
                Type.Literal('down'),
                Type.Literal('left'),
                Type.Literal('right'),
              ]),
              speed: Type.Integer({ minimum: 30, maximum: 50 }),
              milliseconds: Type.Integer({ minimum: 500, maximum: 3000 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) => tasks.patrol(input as { steps: PatrolStep[]; supervised: true }, ctx),
  })
  deps.api.registerTool({
    name: 'aka_scan',
    description:
      '仅用于查看全部周围环境，禁止用于找网球或找到即停任务：整批完成后模型才判断，会错过停车时机。找网球必须aka_find_tennis/aka_demo_start后逐张aka_demo_step。一次完成用户要求的有界原地环视：先保存起始图，再逐段以速度30转向1000毫秒，每次停车等约一秒，取之后的新帧，再继续转。views是照片数，转向段数为views减1，最多13张/12段/90秒。本车现场观察七段30/1000毫秒约转一圈，查看一圈可选views=8（起始加7段），这只是估计，不是角度标定。采样结束后必须用aka_read_observations分批读取全部照片，每批最多2张，先逐组分析，再比较起始与最后图并综合总结；不能只分析默认附带的少数图片。无需云识别，不前进、不后退、不抓取。结果未知即停，不重发。相同画面不算新方向，不保证精确360度或绕物四视角。可用aka_task_cancel或停止按钮打断。',
    parameters: Type.Object(
      {
        views: Type.Integer({ minimum: 2, maximum: 13 }),
        direction: Type.Union([Type.Literal('left'), Type.Literal('right')]),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, deferLoading: true },
    execute: (input, ctx) => tasks.scan(input as { views: number; direction: 'left' | 'right' }, ctx),
  })
  deps.api.registerTool({
    name: 'aka_read_observations',
    description:
      '只读当前会话已结束环视的原图，每张附轮次、方向、配速、持续时间。每个推理步骤只调用一次，offset从0开始、limit最多2张，分析并记录本组内容后在下一步读取nextOffset，直到null。严禁把多页放在同一步调用，图片上限会使前面的组消失，后端会拒绝第二组。七转八张按offset=0、2、4、6依次读完，简洁总结环境后结束，不找球、不抓取。需要首尾对比时另一步compareEnds=true；不强制精确360度论证。无移动、拍照或云识别。',
    parameters: Type.Object(
      {
        taskId: Type.String({ minLength: 1, maxLength: 64 }),
        offset: Type.Integer({ minimum: 0, maximum: 12 }),
        limit: Type.Integer({ minimum: 1, maximum: 2 }),
        compareEnds: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, isReadOnly: true, isDestructive: false, isConcurrencySafe: false },
    execute: (input, ctx) => {
      const page = input as { taskId: string; offset: number; limit: number; compareEnds?: boolean }
      return tasks.readPhotos(page.taskId, page.offset, page.limit, ctx, page.compareEnds === true)
    },
  })
  deps.api.registerTool({
    name: 'aka_find',
    description:
      '这是按云端类别和置信度寻找的模式；用户网球演示优先aka_demo_start(find_tennis)/aka_demo_step，由模型逐张看原图，不依赖云端是否支持网球类别。在已连接小车且页面实时识别开关开启时，有限转向寻找指定类别，最多六个观察位置。labels填写识别服务实际类别名称，可包含中英文别名；置信度至少0.6。每次转向后等待新送检原图，匹配即停止并返回对应原图；无新识别就停止。不会接近或夹取，不保证一整圈覆盖。',
    parameters: Type.Object(
      {
        views: Type.Integer({ minimum: 2, maximum: 6 }),
        direction: Type.Union([Type.Literal('left'), Type.Literal('right')]),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, deferLoading: true },
    execute: (input, ctx) =>
      tasks.find(input as { views: number; direction: 'left' | 'right'; labels: string[] }, ctx),
  })
  deps.api.registerTool({
    name: 'aka_approach',
    description:
      '这是米制标定接近模式；用户网球照片占比演示改用aka_demo_start(pickup_tennis/model_tennis)与aka_demo_step的实测3/5/10cm档位。在用户现场监督且路段已清空时，依据已保存地面/实测运动标定，短步转向和前进到目标前指定停车距离。必须已开启页面识别，每步重新识别原图，目标消失、同类歧义、超出标定、运动不一致即暂停。最多12步/180秒（包含云端等待），单次等待新识别最多10秒，不抓取，不具备避障，不保证物理到位。仅当用户明确要求并现场监督时传supervised=true。',
    parameters: Type.Object(
      {
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        standoffMeters: Type.Number({ minimum: 0.05, maximum: 2 }),
        maxSteps: Type.Integer({ minimum: 1, maximum: 12 }),
        supervised: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) =>
      tasks.approach(
        input as { labels: string[]; standoffMeters: number; maxSteps: number; supervised: true },
        ctx,
      ),
  })
  deps.api.registerTool({
    name: 'aka_grasp',
    description:
      '这是云检和米制标定窗口模式；用户以成功夹取照片占比、夹后球消失为条件的任务用aka_demo_start(pickup_tennis)/aka_demo_step，不将漏检当作夹取成功。在用户现场监督下执行一次夹取或投放。需已保存抓取距离窗口、持物观察区域、落点区域，且已开启实时识别。夹取先核对唯一地面目标处于机械窗口；释放须先观察到持物及落点区域位于目标容器框内。动作后用两张新原图核对位置变化，只返回视觉候选证据，不保证真正持物或落入容器；未知结果不重试，不自动搬运。grab时destinationLabels可为空，release时填写识别服务真实容器类别。',
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal('grab'), Type.Literal('release')]),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 12 }),
        destinationLabels: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 12 }),
        supervised: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    meta,
    execute: (input, ctx) =>
      tasks.grasp(
        input as {
          action: 'grab' | 'release'
          labels: string[]
          destinationLabels: string[]
          supervised: true
        },
        ctx,
      ),
  })
  deps.api.registerTool({
    name: 'aka_task_cancel',
    description: '取消当前会话已开始的环视采样任务；不会开始新任务或重放动作。',
    parameters: Type.Object({ taskId: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
    meta: { ...meta, isDestructive: false, isConcurrencySafe: true, returnsImages: false },
    async execute(input, ctx) {
      const state = await tasks.cancel((input as { taskId: string }).taskId, ctx.session.key)
      return { content: [{ type: 'text', text: JSON.stringify(state) }], structured: state }
    },
  })
  deps.api.registerTool({
    name: 'aka_export_observations',
    description:
      '把当前会话已完成环视采样的确切原图和说明导出到工作区，供图片记录或建模插件读取。不是自动环绕拍摄，不声称四视角或尺寸准确。不会移动小车。',
    parameters: Type.Object({ taskId: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
    meta: { ...meta, isDestructive: false, returnsImages: false },
    async execute(input, ctx) {
      const result = await tasks.export((input as { taskId: string }).taskId, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
    },
  })
  register({
    name: 'aka.task.cancel',
    kind: 'effect',
    timeoutMs: 3000,
    maxResultBytes: 4096,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { taskId: { type: 'string', maxLength: 64 } },
      required: ['taskId'],
    },
    outputSchema: { type: 'object' },
    async handler(input, ctx) {
      return tasks.cancel((input as { taskId: string }).taskId, ctx.session?.key)
    },
  })
}
