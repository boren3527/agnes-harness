import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  PluginExtensionAPI,
  ServiceContext,
  ServiceDef,
  ToolContext,
  ToolDef,
} from '@agnes/extension-api'
import { checkServiceDef, checkToolDef } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCaptureService } from '../src/capture-service.js'
import { registerCaptureTool } from '../src/capture-tool.js'
import type { RuntimeOwner } from '../src/connection-services.js'
import { AkaControlChannel } from '../src/control-channel.js'
import { runDeviceControl } from '../src/control-services.js'
import { DEMO_MOTION, DemoWorkflows, registerDemoWorkflows } from '../src/demo-workflows.js'
import { GroundGeometry, registerGeometry } from '../src/geometry-service.js'
import { AkaHttpDriver } from '../src/http-driver.js'
import type { JpegFrame } from '../src/mjpeg.js'
import { registerRecognitionService } from '../src/recognition-service.js'
import { AkaRuntimePool } from '../src/runtime.js'
import { registerScanTasks, ScanTasks } from '../src/scan-task.js'

const id = '11111111-1111-4111-8111-111111111111'
const registration = {
  deviceId: id,
  ip: '192.168.50.42',
  port: 80,
  macAddress: '12:34:56:78:90:ab',
  configRevision: 1,
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 240, 1, 64, 1, 1, 0x11, 0, 0xff, 0xd9])
const held: AbortController[] = []
afterEach(() => {
  for (const ac of held.splice(0)) ac.abort()
  vi.restoreAllMocks()
})
async function fixture() {
  const lifetime = new AbortController(),
    invocation = new AbortController(),
    revoked = new AbortController()
  held.push(lifetime)
  vi.spyOn(AkaHttpDriver.prototype, 'heartbeat').mockResolvedValue({
    service: 'AKA-00',
    identity: { macAddress: registration.macAddress, validity: 'reported' },
  })
  vi.spyOn(AkaHttpDriver.prototype, 'cameraStatus').mockResolvedValue(false)
  vi.spyOn(AkaControlChannel.prototype, 'open').mockResolvedValue()
  let receive!: (frame: JpegFrame) => void
  const stream = vi.spyOn(AkaHttpDriver.prototype, 'stream').mockImplementation((_fps, _signal, callback) => {
    receive = callback
    return new Promise<void>(() => {})
  })
  const pool = new AkaRuntimePool(lifetime.signal),
    busy = new Set<string>()
  const runtime = pool.get(registration)
  await runtime.connect(invocation.signal)
  runtime.startCamera(10)
  receive({ bytes: jpeg, width: 320, height: 240 })
  const binding = {
    sessionId: 'chat',
    workspaceId: 'a'.repeat(64),
    deviceId: id,
    bindingRevision: 1,
    active: true,
  }
  const owners = new Map<string, RuntimeOwner>([
    [
      id,
      {
        workspaceId: binding.workspaceId,
        bindingRevision: 1,
        registration,
        source: 'legacy',
        revoked: revoked.signal,
      },
    ],
  ])
  let tool!: ToolDef
  const api = {
    ctx: { signal: lifetime.signal },
    registerTool: (value: ToolDef) => {
      tool = value
      return () => {}
    },
  } as unknown as PluginExtensionAPI
  const deps = { api, pool, registrations: new Map([[id, registration]]), owners, busy }
  registerCaptureTool(deps)
  let service!: ServiceDef
  registerCaptureService((value) => {
    service = value
  }, deps)
  const stored: Buffer[] = []
  const put = vi.fn(async (bytes: Uint8Array) => {
    stored.push(Buffer.from(bytes))
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mime: 'image/jpeg',
    }
  })
  const ctx = {
    session: { key: 'chat', turn: 1, toolUseId: 'test-tool-use' },
    device: { binding: vi.fn(async () => binding) },
    signal: invocation.signal,
    authorize: vi.fn(async () => ({ effect: 'allow' })),
    artifacts: { put },
  }
  const call = (input: unknown = {}) =>
    tool.execute(input as Parameters<ToolDef['execute']>[0], ctx as unknown as ToolContext)
  const geometry = new GroundGeometry(deps)
  let recognitionService!: ServiceDef
  registerRecognitionService(
    (value) => {
      recognitionService = value
    },
    deps,
    geometry,
  )
  return {
    geometry,
    deps,
    recognitionService,
    lifetime,
    invocation,
    revoked,
    pool,
    runtime,
    busy,
    binding,
    owners,
    tool,
    put,
    stored,
    ctx,
    call,
    receive,
    stream,
    service,
  }
}
describe('AKA current-frame capture tool', () => {
  it('discards post-stop buffered frames and saves a subsequently received settled frame', async () => {
    const v = await fixture()
    vi.spyOn(AkaHttpDriver.prototype, 'stop').mockResolvedValue({ state: 'completed' })
    await v.runtime.stopControl()
    const threshold = v.runtime.captureReadyAfter()
    const before = v.runtime.latestFrame()?.id
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      const result = await v.call()
      expect(performance.now()).toBeGreaterThanOrEqual(threshold)
      expect(v.runtime.latestFrame()?.receivedAt).toBeGreaterThan(threshold)
      expect(result.structured?.frameId).not.toBe(before)
      expect(v.stored).toHaveLength(1)
    } finally {
      clearInterval(frames)
    }
  })
  it('saves the selected immutable frame as an image artifact without opening another stream', async () => {
    const v = await fixture()
    expect(checkToolDef(v.tool, { prefix: '' })).toEqual({ ok: true })
    const old = v.runtime.latestFrame()
    if (!old) throw new Error('Missing test frame')
    v.put.mockImplementation(async (bytes) => {
      v.stored.push(Buffer.from(bytes))
      v.receive({ bytes: jpeg, width: 320, height: 240 })
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mime: 'image/jpeg',
      }
    })
    const result = await v.call()
    expect(result.content[1]).toMatchObject({ type: 'image', mime: 'image/jpeg', ref: { size: jpeg.length } })
    expect(result.structured).toMatchObject({ deviceId: id, frameId: old.id, timeBasis: 'bridge_receive' })
    expect(v.stored[0]).toEqual(jpeg)
    expect(v.runtime.latestFrame()?.id).not.toBe(old.id)
    expect(v.stream).toHaveBeenCalledTimes(1)
    expect(v.busy.size).toBe(0)
  })
  it.each([
    'ordinary',
    'historical',
    'wrong-session',
    'denied',
    'busy',
    'retired',
    'stale',
    'extra-input',
  ] as const)('refuses %s before storing any image', async (mode) => {
    const v = await fixture()
    if (mode === 'ordinary') v.ctx.device.binding.mockResolvedValue(null as never)
    if (mode === 'historical') v.binding.active = false
    if (mode === 'wrong-session') v.binding.sessionId = 'other'
    if (mode === 'denied') v.ctx.authorize.mockResolvedValue({ effect: 'deny' })
    if (mode === 'busy') v.busy.add(id)
    if (mode === 'retired') v.revoked.abort()
    if (mode === 'stale') {
      const frame = v.runtime.latestFrame()
      if (!frame) throw new Error('Missing test frame')
      vi.spyOn(v.runtime, 'latestFrame').mockReturnValue({ ...frame, receivedAt: performance.now() - 1001 })
    }
    await expect(v.call(mode === 'extra-input' ? { deviceId: id } : {})).rejects.toThrow()
    expect(v.put).not.toHaveBeenCalled()
  })
  it.each(['binding', 'permission', 'generation', 'bad-ref', 'cancel'] as const)(
    'suppresses publication after %s changes during persistence',
    async (mode) => {
      const v = await fixture()
      v.put.mockImplementation(async (bytes) => {
        v.stored.push(Buffer.from(bytes))
        if (mode === 'binding') v.binding.active = false
        if (mode === 'permission') v.ctx.authorize.mockResolvedValue({ effect: 'deny' })
        if (mode === 'generation') v.runtime.dispose()
        if (mode === 'cancel') v.invocation.abort()
        return {
          sha256: mode === 'bad-ref' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          mime: 'image/jpeg',
        }
      })
      await expect(v.call()).rejects.toThrow()
      expect(v.stored).toHaveLength(1)
      expect(v.busy.size).toBe(0)
    },
  )
  it('keeps the device slot until an uncertain artifact write settles and never retries it', async () => {
    const v = await fixture()
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    v.put.mockImplementation(async (bytes) => {
      entered()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mime: 'image/jpeg',
      }
    })
    const pending = v.call()
    await started
    v.invocation.abort()
    expect(v.busy.has(id)).toBe(true)
    finish()
    await expect(pending).rejects.toThrow()
    expect(v.put).toHaveBeenCalledTimes(1)
    expect(v.busy.size).toBe(0)
  })
  it('redacts storage failures and releases the capture slot without retrying', async () => {
    const v = await fixture()
    v.put.mockRejectedValue(new Error('private-store-path-and-secret'))
    await expect(v.call()).rejects.toThrow('Current camera capture unavailable')
    expect(v.put).toHaveBeenCalledTimes(1)
    expect(v.busy.size).toBe(0)
  })
})

type CapturePort = NonNullable<ServiceContext['captureArtifacts']>
type CaptureRecord = NonNullable<Awaited<ReturnType<CapturePort['read']>>>
async function serviceFixture() {
  const v = await fixture()
  let record: CaptureRecord | null = null
  const read = vi.fn(async () => record)
  const save = vi.fn(async (bytes: Uint8Array, selection: Parameters<CapturePort['save']>[1]) => {
    v.stored.push(Buffer.from(bytes))
    // The real persistence reader canonicalizes field order; service comparisons must not depend on it.
    record = { selection: { artifact: selection.artifact, ...selection }, stage: 'stored', eventSeq: null }
    return record
  })
  const recover = vi.fn(async () => {
    if (!record || record.stage === 'selected') throw new Error('No saved bytes')
    return record
  })
  const publish = vi.fn(async () => {
    if (!record || record.stage === 'selected') throw new Error('Missing stored capture')
    record = { ...record, stage: 'recorded', eventSeq: 7 }
    return record
  })
  const ctx = { ...v.ctx, captureArtifacts: { read, save, recover, publish } }
  const input = { bindingRevision: 1, configRevision: 1 }
  const call = (params: unknown = input, context: unknown = ctx) =>
    v.service.handler(params as Parameters<ServiceDef['handler']>[0], context as ServiceContext)
  return {
    ...v,
    read,
    save,
    recover,
    publish,
    serviceCtx: ctx,
    serviceCall: call,
    getRecord: () => record,
    setRecord: (value: CaptureRecord) => {
      record = value
    },
  }
}
describe('AKA page capture effect', () => {
  it('registers a valid effect, saves the exact frame, and returns only verified recorded evidence', async () => {
    const v = await serviceFixture()
    expect(checkServiceDef(v.service)).toEqual({ ok: true })
    expect(v.service.kind).toBe('effect')
    const frame = v.runtime.latestFrame()
    const result = await v.serviceCall()
    expect(result).toMatchObject({
      deviceId: id,
      frameId: frame?.id,
      eventSeq: 7,
      artifact: { size: jpeg.length },
    })
    expect(v.stored).toEqual([jpeg])
    expect(v.getRecord()?.stage).toBe('recorded')
    expect(v.stream).toHaveBeenCalledTimes(1)
    expect(v.put).not.toHaveBeenCalled()
    expect(v.busy.size).toBe(0)
  })
  it('recovers the same original operation without selecting a replacement even after runtime disposal', async () => {
    const v = await serviceFixture()
    const first = await v.serviceCall()
    v.runtime.dispose()
    expect(await v.serviceCall()).toEqual(first)
    expect(v.save).toHaveBeenCalledTimes(1)
    expect(v.stored).toHaveLength(1)
  })
  it('does not recapture when a selected operation has no saved bytes', async () => {
    const v = await serviceFixture()
    await v.serviceCall()
    const prior = v.getRecord()
    if (!prior) throw new Error('Missing saved capture')
    v.setRecord({ ...prior, stage: 'selected', eventSeq: null })
    v.save.mockClear()
    v.publish.mockClear()
    v.receive({ bytes: jpeg, width: 320, height: 240 })
    await expect(v.serviceCall()).rejects.toThrow('Current camera capture unavailable')
    expect(v.save).not.toHaveBeenCalled()
    expect(v.publish).not.toHaveBeenCalled()
    expect(v.getRecord()?.selection.frameId).toBe(prior.selection.frameId)
  })
  it.each(['missing-port', 'ordinary', 'wrong-binding', 'wrong-config', 'extra-input', 'denied'] as const)(
    'refuses %s before saving or publishing',
    async (mode) => {
      const v = await serviceFixture()
      if (mode === 'ordinary') v.ctx.device.binding.mockResolvedValue(null as never)
      if (mode === 'denied') v.ctx.authorize.mockResolvedValue({ effect: 'deny' })
      const input = {
        bindingRevision: mode === 'wrong-binding' ? 2 : 1,
        configRevision: mode === 'wrong-config' ? 2 : 1,
        ...(mode === 'extra-input' ? { deviceId: id } : {}),
      }
      await expect(v.serviceCall(input, mode === 'missing-port' ? v.ctx : v.serviceCtx)).rejects.toThrow()
      expect(v.save).not.toHaveBeenCalled()
      expect(v.publish).not.toHaveBeenCalled()
    },
  )
  it('retains the shared device slot until a canceled write really settles and refuses another capture', async () => {
    const v = await serviceFixture()
    let finish!: () => void, entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const original = v.save.getMockImplementation()
    if (!original) throw new Error('Missing save implementation')
    v.save.mockImplementation(async (bytes, selection) => {
      entered()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return original(bytes, selection)
    })
    const pending = v.serviceCall()
    await started
    await expect(v.call()).rejects.toThrow()
    v.invocation.abort()
    expect(v.busy.has(id)).toBe(true)
    finish()
    await expect(pending).rejects.toThrow()
    expect(v.publish).not.toHaveBeenCalled()
    expect(v.stored).toHaveLength(1)
    expect(v.busy.size).toBe(0)
  })
  it('recovers a stored photo after a publication failure without another save', async () => {
    const v = await serviceFixture()
    v.publish.mockRejectedValueOnce(new Error('secret-store-path'))
    await expect(v.serviceCall()).rejects.toThrow('Current camera capture unavailable')
    expect(v.getRecord()?.stage).toBe('stored')
    const frameId = v.getRecord()?.selection.frameId
    v.receive({ bytes: jpeg, width: 320, height: 240 })
    expect(await v.serviceCall()).toMatchObject({ frameId, eventSeq: 7 })
    expect(v.save).toHaveBeenCalledTimes(1)
  })
  it.each(['selection', 'stage', 'sequence'] as const)('refuses mismatched publication %s', async (mode) => {
    const v = await serviceFixture()
    v.publish.mockImplementation(async () => {
      const record = v.getRecord()
      if (!record) throw new Error('Missing saved capture')
      return {
        ...record,
        stage: mode === 'stage' ? 'stored' : 'recorded',
        eventSeq: mode === 'sequence' ? -1 : 7,
        selection: mode === 'selection' ? { ...record.selection, frameId: 'other-frame' } : record.selection,
      }
    })
    await expect(v.serviceCall()).rejects.toThrow()
    expect(v.stored).toHaveLength(1)
  })
})

describe('AKA registered single-image recognition consumer', () => {
  it('uses a current stream frame and separates connection and recognition revisions', async () => {
    const v = await serviceFixture()
    const run = vi.fn<NonNullable<ServiceContext['recognition']>['run']>(async (expected, select, verify) => {
      expect(expected).toEqual({ bindingRevision: 1, configRevision: 2, roundRevision: 3 })
      const frame = await select(v.invocation.signal)
      expect(v.getRecord()?.stage).toBe('recorded')
      expect(frame.bytes).toEqual(jpeg)
      expect(frame.receivedAt).toBeLessThanOrEqual(performance.now())
      await verify?.()
      return {
        id: '22222222-2222-4222-8222-222222222222',
        deviceId: id,
        ...expected,
        frameId: frame.id,
        width: frame.width,
        height: frame.height,
        sha256: createHash('sha256').update(frame.bytes).digest('hex'),
        providerRequestId: 'request',
        elapsedMs: 1,
        detections: [],
      }
    })
    expect(checkServiceDef(v.recognitionService)).toEqual({ ok: true })
    const result = await v.recognitionService.handler(
      { bindingRevision: 1, configRevision: 1, recognitionRevision: 2, roundRevision: 3 },
      { ...v.serviceCtx, recognition: { run } } as unknown as ServiceContext,
    )
    expect(result).toMatchObject({
      configRevision: 2,
      frameId: v.runtime.latestFrame()?.id,
      eventSeq: 7,
      artifact: v.getRecord()?.selection.artifact,
    })
    expect(v.stored).toEqual([jpeg])
    expect(run).toHaveBeenCalledOnce()
    expect(v.stream).toHaveBeenCalledOnce()
    expect(v.put).not.toHaveBeenCalled()
    expect(v.geometry.latest('chat', id, 1)).toMatchObject({
      resultId: '22222222-2222-4222-8222-222222222222',
      width: 320,
      height: 240,
    })
    expect(v.busy.size).toBe(0)
  })
  it.each(['connection', 'cancel', 'generation'] as const)(
    'rejects %s before publishing a late result',
    async (mode) => {
      const v = await serviceFixture()
      const run = vi.fn<NonNullable<ServiceContext['recognition']>['run']>(
        async (_expected, select, verify) => {
          await select(v.invocation.signal)
          if (mode === 'cancel') v.invocation.abort()
          if (mode === 'generation') v.runtime.dispose()
          await verify?.()
          return {} as never
        },
      )
      await expect(
        v.recognitionService.handler(
          {
            bindingRevision: 1,
            configRevision: mode === 'connection' ? 2 : 1,
            recognitionRevision: 2,
            roundRevision: 3,
          },
          { ...v.serviceCtx, recognition: { run } } as unknown as ServiceContext,
        ),
      ).rejects.toThrow('Current camera recognition unavailable')
      expect(v.put).not.toHaveBeenCalled()
      expect(v.busy.size).toBe(0)
    },
  )
})

it.each(['save', 'publish', 'prior', 'selection', 'event'] as const)(
  'does not submit recognition when original storage fails at %s',
  async (mode) => {
    const v = await serviceFixture()
    if (mode === 'save') v.save.mockRejectedValueOnce(new Error('disk'))
    if (mode === 'publish') v.publish.mockRejectedValueOnce(new Error('event'))
    if (mode === 'selection')
      v.save.mockImplementationOnce(async (_bytes, selection) => ({
        selection: { ...selection, frameId: 'another-frame' },
        stage: 'stored',
        eventSeq: null,
      }))
    if (mode === 'event')
      v.publish.mockImplementationOnce(async () => {
        const record = v.getRecord()
        if (!record) throw new Error('missing original')
        return { selection: record.selection, stage: 'stored', eventSeq: null }
      })
    if (mode === 'prior') {
      await v.serviceCall()
      v.save.mockClear()
      v.publish.mockClear()
    }
    const detect = vi.fn()
    const run = vi.fn<NonNullable<ServiceContext['recognition']>['run']>(async (_expected, select) => {
      await select(v.invocation.signal)
      detect()
      return {} as never
    })
    await expect(
      v.recognitionService.handler(
        { bindingRevision: 1, configRevision: 1, recognitionRevision: 2, roundRevision: 3 },
        { ...v.serviceCtx, recognition: { run } } as unknown as ServiceContext,
      ),
    ).rejects.toThrow('Current camera recognition unavailable')
    expect(detect).not.toHaveBeenCalled()
    if (mode === 'prior') expect(run).not.toHaveBeenCalled()
    expect(v.busy.size).toBe(0)
  },
)

it.each(['cloud-failure', 'mismatched-result'] as const)(
  'retains the original and refuses resubmission after %s',
  async (mode) => {
    const v = await serviceFixture()
    const run = vi.fn<NonNullable<ServiceContext['recognition']>['run']>(async (_expected, select) => {
      await select(v.invocation.signal)
      if (mode === 'cloud-failure') throw new Error('reply lost')
      return { sha256: '0'.repeat(64), frameId: 'wrong' } as never
    })
    const input = { bindingRevision: 1, configRevision: 1, recognitionRevision: 2, roundRevision: 3 }
    const context = { ...v.serviceCtx, recognition: { run } } as unknown as ServiceContext
    await expect(v.recognitionService.handler(input, context)).rejects.toThrow()
    const original = v.getRecord()
    expect(original?.stage).toBe('recorded')
    await expect(v.recognitionService.handler(input, context)).rejects.toThrow()
    expect(v.getRecord()).toEqual(original)
    expect(run).toHaveBeenCalledOnce()
    expect(v.save).toHaveBeenCalledOnce()
    expect(v.publish).toHaveBeenCalledOnce()
  },
)

describe('bounded real scan task', () => {
  async function scanFixture() {
    const v = await fixture()
    const owner = v.owners.get(id)
    if (!owner) throw new Error('Missing owner')
    owner.sessionId = 'chat'
    const geometry = new GroundGeometry(v.deps)
    const tasks = new ScanTasks(v.deps, geometry)
    const demos = new DemoWorkflows(v.deps)
    const tools = new Map<string, ToolDef>()
    const services = new Map<string, ServiceDef>()
    const api = {
      ...v.deps.api,
      registerTool: (tool: ToolDef) => {
        tools.set(tool.name, tool)
        return () => {}
      },
    }
    registerScanTasks((service) => services.set(service.name, service), { ...v.deps, api }, tasks)
    registerDemoWorkflows(api, demos, tasks)
    const motion = vi.spyOn(AkaHttpDriver.prototype, 'move').mockResolvedValue({ state: 'completed' })
    const stop = vi.spyOn(AkaHttpDriver.prototype, 'stop').mockResolvedValue({ state: 'completed' })
    const files = new Map<string, Uint8Array>()
    const write = vi.fn(async (path: string, data: Uint8Array | string) => {
      files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data)
    })
    const read = async (path: string) => {
      const data = files.get(path)
      if (!data) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return data
    }

    const ctx = {
      ...v.ctx,
      session: { ...v.ctx.session, workspaceRoot: '/workspace', step: 1 },
      artifacts: { ...v.ctx.artifacts, get: vi.fn(async () => jpeg) },
      fs: { write, read, stat: async (path: string) => ({ kind: 'file', size: (await read(path)).length }) },
      progress: vi.fn(),
    } as unknown as ToolContext
    v.deps.interruptTask = async (sessionId, stopping, deviceId) => {
      demos.interrupt(stopping ? undefined : sessionId, deviceId)
      await tasks.interrupt(sessionId, stopping, deviceId)
    }
    v.deps.guardModelAction = (sessionId, deviceId, turn, fromModel, workflow) =>
      demos.guardModelAction(sessionId, deviceId, turn, fromModel, workflow)
    v.deps.guardModelRelease = (sessionId, deviceId, turn, fromModel) =>
      demos.guardModelRelease(sessionId, deviceId, turn, fromModel)
    return { ...v, tasks, tools, services, motion, stop, ctx, write, geometry, demos }
  }
  function checkpoint(result: Awaited<ReturnType<DemoWorkflows['start']>>) {
    return result.structured as {
      workflowId: string
      frameId: string
      phase: string
      photoCount: number
      searchTurns: number
    }
  }
  async function graspReference(ctx: ToolContext) {
    await ctx.fs.write(
      join(ctx.session.workspaceRoot, '.agh-device', 'demo-grasp-reference', `${id}.json`),
      JSON.stringify({
        version: 1,
        deviceId: id,
        width: 320,
        height: 240,
        minWidthRatio: 0.3,
        maxWidthRatio: 0.7,
        minHeightRatio: 0.3,
        maxHeightRatio: 0.7,
        minCenterY: 0.4,
        maxCenterY: 0.65,
      }),
    )
  }
  it('analyzes seven search checkpoints but never sends a seventh turn or replays an old frame', async () => {
    const v = await scanFixture()
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      let state = checkpoint(await v.demos.start('find_tennis', v.ctx))
      expect(v.motion).not.toHaveBeenCalled()
      const initial = { ...state }
      for (let round = 1; round <= 6; round++) {
        state = checkpoint(
          await v.demos.step(
            { ...state, decision: 'not_found', summary: 'No tennis ball in the latest stopped original.' },
            v.ctx,
          ),
        )
        expect(state.searchTurns).toBe(round)
        expect(state.photoCount).toBe(round + 1)
        expect(state.phase).toBe('searching')
      }
      await expect(
        v.demos.step(
          { ...initial, decision: 'not_found', summary: 'No tennis ball in the latest stopped original.' },
          v.ctx,
        ),
      ).rejects.toThrow(/stale/)
      state = checkpoint(
        await v.demos.step(
          { ...state, decision: 'not_found', summary: 'No tennis ball in the latest stopped original.' },
          v.ctx,
        ),
      )
      expect(state.phase).toBe('not_found')
      await expect(v.demos.start('find_tennis', v.ctx)).rejects.toThrow(/already started/)
      expect(v.motion).toHaveBeenCalledTimes(6)
      for (const args of v.motion.mock.calls)
        expect(args[0]).toMatchObject({ action: 'left', speed: 30, milliseconds: 1000 })
    } finally {
      clearInterval(frames)
    }
  }, 20000)
  it.each([0, 1])(
    'stops immediately on finding a ball after %i turns and requires the operator reference before approaching',
    async (searchSteps) => {
      const v = await scanFixture()
      const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
      try {
        const initial = await v.demos.start('find_tennis', v.ctx)
        expect(initial.content.some((block) => block.type === 'image')).toBe(true)
        expect(initial.content.some((block) => block.type === 'ref')).toBe(false)
        let state = checkpoint(initial)
        if (searchSteps)
          state = checkpoint(
            await v.demos.step(
              {
                ...state,
                decision: 'not_found',
                summary: 'Initial photo has no ball; inspect one new photo after turning.',
              },
              v.ctx,
            ),
          )
        const found = await v.demos.step(
          {
            ...state,
            decision: 'found',
            box: [0.25, 0.25, 0.75, 0.75],
            summary: 'Tennis ball visible in this original.',
          },
          v.ctx,
        )
        const outputs = found.content.filter((block) => block.type === 'ref')
        expect(outputs).toHaveLength(1)
        expect(outputs[0]).toMatchObject({ ref: { mime: 'image/jpeg' } })
        state = checkpoint(found)
        expect(state.phase).toBe('found')
        expect(v.motion).toHaveBeenCalledTimes(searchSteps)
        await expect(
          v.demos.step(
            { ...state, decision: 'not_found', summary: 'No further searching after a found checkpoint.' },
            v.ctx,
          ),
        ).rejects.toThrow(/ended/)
        expect(v.motion).toHaveBeenCalledTimes(searchSteps)
        await expect(v.demos.start('pickup_tennis', v.ctx, state.workflowId)).rejects.toThrow(
          /new user request/,
        )
        await expect(v.demos.start('pickup_tennis', v.ctx)).rejects.toThrow(/new user request/)
        await expect(
          runDeviceControl(
            v.deps,
            { ...v.ctx, session: { ...v.ctx.session, toolUseId: 'model-call' } },
            {
              action: 'up',
              speed: 30,
              milliseconds: 500,
              bindingRevision: 1,
              configRevision: 1,
            },
          ),
        ).rejects.toThrow(/selected case/)
        expect(v.motion).toHaveBeenCalledTimes(searchSteps)
        v.ctx = { ...v.ctx, session: { ...v.ctx.session, turn: 2 } }
        state = checkpoint(await v.demos.start('pickup_tennis', v.ctx, state.workflowId))
        expect(state.phase).toBe('await_target')
        await expect(
          v.demos.step(
            {
              ...state,
              decision: 'align_right',
              box: [0.7, 0.3, 0.9, 0.7],
              summary: 'Old search photo is not enough.',
            },
            v.ctx,
          ),
        ).rejects.toThrow(/phase/)
        state = checkpoint(
          await v.demos.step(
            {
              ...state,
              decision: 'found',
              box: [0.25, 0.25, 0.75, 0.75],
              summary: 'Ball visible in the new CURRENT photo.',
            },
            v.ctx,
          ),
        )
        await expect(
          v.demos.step(
            {
              ...state,
              decision: 'forward_3cm',
              summary: 'Ball is centred and still distant.',
              box: [0.25, 0.25, 0.75, 0.75],
            },
            { ...v.ctx, session: { ...v.ctx.session, key: 'other' } },
          ),
        ).rejects.toThrow(/missing/)
        const beforeDenied = v.demos.latest('chat', id, 1)
        const missingBox = await v.demos.invokeStep(
          { ...state, decision: 'align_left', summary: 'Ball remains left of centre.' },
          v.ctx,
        )
        expect(missingBox).toMatchObject({
          isError: true,
          structured: { movementDispatched: false, reason: expect.stringContaining('target box') },
        })
        expect(v.demos.latest('chat', id, 1)).toEqual(beforeDenied)
        const snapshot = v.runtime.snapshot()
        for (const [change, reason] of [
          [{ connection: 'degraded' }, 'Device connection is degraded'],
          [{ media: 'error' }, 'Camera stream is error'],
          [{ control: { phase: 'unknown', lastStop: 'unknown' } }, 'Prior device action is unknown'],
        ] as const) {
          const status = vi.spyOn(v.runtime, 'snapshot').mockReturnValue({ ...snapshot, ...change })
          const blocked = await v.demos.invokeStep(
            { ...state, decision: 'align_left', box: [0.05, 0.25, 0.25, 0.75], summary: 'Ball left.' },
            v.ctx,
          )
          expect(blocked).toMatchObject({
            isError: true,
            structured: { movementDispatched: false, reason: expect.stringContaining(reason) },
          })
          status.mockRestore()
          expect(v.demos.latest('chat', id, 1)).toEqual(beforeDenied)
        }
        const denied = await v.demos.invokeStep(
          {
            ...state,
            decision: 'align_left',
            summary: 'Ball remains left of centre.',
            box: [0.05, 0.25, 0.25, 0.75],
          },
          { ...v.ctx, authorize: async () => ({ effect: 'deny' }) } as ToolContext,
        )
        expect(denied).toMatchObject({
          isError: true,
          structured: { state: 'not-started', movementDispatched: false },
        })
        expect(v.demos.latest('chat', id, 1)).toEqual(beforeDenied)
        expect(v.motion).toHaveBeenCalledTimes(searchSteps)
        state = checkpoint(
          await v.demos.step(
            {
              ...state,
              decision: 'forward_3cm',
              summary: 'Ball is centred and still distant.',
              box: [0.25, 0.25, 0.75, 0.75],
            },
            v.ctx,
          ),
        )
        expect(state.phase).toBe('await_reference')
        expect(v.motion).toHaveBeenCalledTimes(searchSteps)
        state = checkpoint(
          await v.demos.step(
            {
              ...state,
              decision: 'align_left',
              summary: 'Ball remains left of centre.',
              box: [0.05, 0.25, 0.25, 0.75],
            },
            v.ctx,
          ),
        )
        expect(v.motion.mock.calls[searchSteps]?.[0]).toMatchObject({
          action: 'left',
          speed: 30,
          milliseconds: 500,
        })
        await v.demos.step(
          {
            ...state,
            decision: 'align_right',
            summary: 'The new image shows overcorrection after the default pulse; try a smaller adjustment.',
            box: [0.7, 0.25, 0.9, 0.75],
            milliseconds: 300,
          },
          v.ctx,
        )
        expect(v.motion.mock.calls[searchSteps + 1]?.[0]).toMatchObject({
          action: 'right',
          speed: 30,
          milliseconds: 300,
        })
        expect(v.demos.latest('chat', id, 1)?.motionHistory.slice(-2)).toMatchObject([
          {
            action: 'left',
            speed: 30,
            milliseconds: 500,
            beforeFrameId: expect.any(String),
            afterFrameId: expect.any(String),
          },
          {
            action: 'right',
            speed: 30,
            milliseconds: 300,
            beforeFrameId: expect.any(String),
            afterFrameId: expect.any(String),
          },
        ])
      } finally {
        clearInterval(frames)
      }
    },
    10000,
  )
  it.each(['pickup_tennis', 'model_object'] as const)(
    'does not search for an absent current target in %s',
    async (goal) => {
      const v = await scanFixture()
      const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
      try {
        const tool = v.tools.get(goal === 'pickup_tennis' ? 'aka_pickup_tennis' : 'aka_model_object')
        if (!tool) throw new Error('Missing case entry')
        const state = checkpoint(await tool.execute({} as never, v.ctx))
        expect(state.phase).toBe('await_target')
        if (goal === 'model_object') {
          await expect(
            runDeviceControl(v.deps, v.ctx, {
              action: 'left',
              speed: 30,
              milliseconds: 500,
              bindingRevision: 1,
              configRevision: 1,
            }),
          ).rejects.toThrow(/stationary camera/)
          const scan = await v.tasks.scan({ views: 2, direction: 'left' }, v.ctx)
          expect(scan).toMatchObject({ isError: true, structured: { phase: 'failed' } })
          expect(v.motion).not.toHaveBeenCalled()
        }
        const rejected = await v.tools.get('aka_demo_step')?.execute(
          {
            ...state,
            frameId: 'stale',
            decision: 'align_right',
            box: [0.7, 0.3, 0.9, 0.7],
            summary: 'Old image must not drive movement.',
          } as never,
          v.ctx,
        )
        expect(rejected).toMatchObject({
          isError: true,
          structured: { state: 'not-started', movementDispatched: false },
        })
        const ended = await v.demos.step(
          {
            ...state,
            decision: 'not_found',
            summary: 'The requested target is absent in this current photo.',
          },
          v.ctx,
        )
        expect(ended.terminate).toBeUndefined()
        expect(ended).toMatchObject({
          structured: { phase: 'target_missing', searchTurns: 0 },
        })
        await expect(v.demos.start('find_tennis', v.ctx)).rejects.toThrow(/selected case/)
        expect(v.motion).not.toHaveBeenCalled()
      } finally {
        clearInterval(frames)
      }
    },
    6000,
  )
  it('refreshes an aged model observation without moving or losing its workflow', async () => {
    const v = await scanFixture()
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      const state = checkpoint(await v.demos.start('find_tennis', v.ctx))
      const actualNow = performance.now.bind(performance)
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => actualNow() + 40000)
      try {
        const refreshed = checkpoint(
          await v.demos.step(
            { ...state, decision: 'not_found', summary: 'No ball in the prior image.' },
            v.ctx,
          ),
        )
        expect(refreshed.workflowId).toBe(state.workflowId)
        expect(refreshed.frameId).not.toBe(state.frameId)
        expect(refreshed.photoCount).toBe(2)
        expect(refreshed.searchTurns).toBe(0)
        expect(v.motion).not.toHaveBeenCalled()
      } finally {
        clock.mockRestore()
      }
    } finally {
      clearInterval(frames)
    }
  }, 6000)
  it.each(Object.entries(DEMO_MOTION))(
    'uses the exact empirical preset %s and returns stopped before/after originals',
    async (decision, preset) => {
      const v = await scanFixture()
      const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
      try {
        await graspReference(v.ctx)
        let state = checkpoint(await v.demos.start('pickup_tennis', v.ctx))
        state = checkpoint(
          await v.demos.step(
            { ...state, decision: 'found', box: [0.25, 0.25, 0.75, 0.75], summary: 'Ball centred.' },
            v.ctx,
          ),
        )
        const before = state.frameId
        state = checkpoint(
          await v.demos.step(
            {
              ...state,
              decision: decision as keyof typeof DEMO_MOTION,
              summary: 'Ball is centred and smaller than reference; compare the next stopped image.',
              box: [0.4, 0.4, 0.6, 0.6],
            },
            v.ctx,
          ),
        )
        expect(v.motion.mock.calls[0]?.[0]).toMatchObject({
          action: 'up',
          speed: 30,
          milliseconds: preset.milliseconds,
        })
        expect(state.frameId).not.toBe(before)
        expect(state.photoCount).toBe(2)
        await expect(
          v.demos.step(
            {
              ...state,
              decision: 'align_right',
              summary: 'Ball remains right of centre.',
              box: [0.7, 0.2, 0.9, 0.8],
              milliseconds: 750 as 700,
            },
            v.ctx,
          ),
        ).rejects.toThrow(/500/)
        expect(v.motion).toHaveBeenCalledTimes(1)
      } finally {
        clearInterval(frames)
      }
    },
    6000,
  )
  it('exports a verified single original for the model case and rejects a replaced camera scope', async () => {
    const v = await scanFixture()
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      let state = checkpoint(await v.demos.start('model_object', v.ctx))
      state = checkpoint(
        await v.demos.step(
          { ...state, decision: 'found', box: [0.25, 0.25, 0.75, 0.75], summary: 'Ball centred.' },
          v.ctx,
        ),
      )
      await expect(
        v.demos.step({ ...state, decision: 'capture_subject', box: [0.1, 0.1, 0.9, 1] }, v.ctx),
      ).rejects.toThrow(/whole requested object/)
      await expect(
        v.demos.step(
          {
            ...state,
            decision: 'back_up',
            box: [0.1, 0.1, 0.9, 1],
            summary: 'Camera is on a table; movement must be refused.',
          },
          v.ctx,
        ),
      ).rejects.toThrow(/phase/)
      state = checkpoint(
        await v.demos.step(
          {
            ...state,
            decision: 'capture_subject',
            box: [0.65, 0.25, 0.95, 0.75],
            summary: 'Requested object is completely visible on the RIGHT; no centering movement is needed.',
          },
          v.ctx,
        ),
      )
      expect(state.phase).toBe('ready_model')
      const exported = await v.demos.export(state.workflowId, v.ctx)
      expect(exported.photoCount).toBe(1)
      expect(JSON.parse(new TextDecoder().decode(await v.ctx.fs.read(exported.manifest))).kind).toBe(
        'object-observation',
      )
      expect(v.motion).not.toHaveBeenCalled()
      vi.spyOn(AkaHttpDriver.prototype, 'setCamera').mockResolvedValue(false)
      await v.runtime.closeCamera(v.ctx.signal)
      expect((await v.demos.export(state.workflowId, v.ctx)).photoCount).toBe(1)
      const restarted = new DemoWorkflows(v.deps)
      const restored = await restarted.restoreModelArchive(state.workflowId, v.ctx)
      expect(restored).toMatchObject({ photoCount: 1, manifest: exported.manifest })
      expect(restarted.owns(state.workflowId)).toBe(false)
      expect(v.motion).not.toHaveBeenCalled()
      await expect(
        restarted.restoreModelArchive(state.workflowId, {
          ...v.ctx,
          session: { ...v.ctx.session, key: 'other' },
        }),
      ).rejects.toThrow(/binding/)
      const original = await v.ctx.fs.read(join(exported.directory, 'observation-1.jpg'))
      await v.ctx.fs.write(join(exported.directory, 'observation-1.jpg'), new Uint8Array([1, 2, 3]))
      await expect(restarted.restoreModelArchive(state.workflowId, v.ctx)).rejects.toThrow(/original/)
      await v.ctx.fs.write(join(exported.directory, 'observation-1.jpg'), original)
      const archive = JSON.parse(new TextDecoder().decode(await v.ctx.fs.read(exported.manifest)))
      for (const change of [
        { archiveVersion: 0 },
        { owner: { ...archive.owner, bindingRevision: archive.owner.bindingRevision + 1 } },
        { owner: { ...archive.owner, configRevision: archive.owner.configRevision + 1 } },
        { photos: [{ ...archive.photos[0], name: '../outside.jpg' }] },
      ]) {
        await v.ctx.fs.write(exported.manifest, JSON.stringify({ ...archive, ...change }))
        await expect(restarted.restoreModelArchive(state.workflowId, v.ctx)).rejects.toThrow(
          /archive|binding|configuration/,
        )
      }
      await v.ctx.fs.write(exported.manifest, JSON.stringify(archive))
      expect(v.motion).not.toHaveBeenCalled()
      let changed = false
      const savedBinding = await v.ctx.device!.binding(),
        write = vi.mocked(v.ctx.fs.write).getMockImplementation()!
      const changingCtx = {
        ...v.ctx,
        device: {
          ...v.ctx.device!,
          binding: async () => ({
            ...savedBinding!,
            bindingRevision: changed ? savedBinding!.bindingRevision + 1 : savedBinding!.bindingRevision,
          }),
        },
      }
      vi.spyOn(v.ctx.fs, 'write').mockImplementation(async (path, bytes) => {
        await write(path, bytes)
        if (path === exported.manifest) changed = true
      })
      await expect(v.demos.export(state.workflowId, changingCtx)).rejects.toThrow(/binding/)
      await expect(
        v.demos.export(state.workflowId, { ...v.ctx, session: { ...v.ctx.session, key: 'other' } }),
      ).rejects.toThrow(/binding/)
    } finally {
      clearInterval(frames)
    }
  }, 6000)
  it('verifies two post-grab photos and waits for a later release prompt without re-grabbing', async () => {
    const v = await scanFixture()
    const grip = vi.spyOn(AkaHttpDriver.prototype, 'grip').mockResolvedValue({ state: 'acknowledged' })
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      await graspReference(v.ctx)
      let state = checkpoint(await v.demos.start('pickup_tennis', v.ctx))
      state = checkpoint(
        await v.demos.step(
          { ...state, decision: 'found', box: [0.25, 0.25, 0.75, 0.75], summary: 'Ball centred.' },
          v.ctx,
        ),
      )
      state = checkpoint(await v.demos.step({ ...state, decision: 'grab', box: [0.25, 0, 0.75, 0.5] }, v.ctx))
      expect(state.phase).toBe('aligning')
      expect(grip).not.toHaveBeenCalled()
      state = checkpoint(
        await v.demos.step({ ...state, decision: 'grab', box: [0.25, 0.25, 0.75, 0.75] }, v.ctx),
      )
      expect(state.phase).toBe('verifying_grab')
      expect(state.photoCount).toBe(3)
      const verified = await v.demos.step(
        {
          ...state,
          decision: 'gone',
          summary: 'Both new photos show the original ground position without the ball.',
        },
        v.ctx,
      )
      expect(verified.terminate).toBe(true)
      state = checkpoint(verified)
      expect(state.phase).toBe('await_release')
      expect(grip.mock.calls.map((c) => c[0])).toEqual(['grab'])
      await expect(
        v.demos.step({ ...state, decision: 'grab', box: [0.25, 0.25, 0.75, 0.75] }, v.ctx),
      ).rejects.toThrow(/phase/)
      await expect(v.demos.step({ ...state, decision: 'release' }, v.ctx)).rejects.toThrow(
        /new user release prompt/,
      )
      await expect(
        runDeviceControl(v.deps, v.ctx, {
          action: 'release',
          speed: 30,
          milliseconds: 500,
          bindingRevision: 1,
          configRevision: 1,
        }),
      ).rejects.toThrow(/new user release prompt/)
      expect(grip.mock.calls.map((c) => c[0])).toEqual(['grab'])
      v.ctx = { ...v.ctx, session: { ...v.ctx.session, turn: 2 } }
      vi.spyOn(AkaHttpDriver.prototype, 'setCamera').mockResolvedValue(false)
      await v.runtime.closeCamera(v.ctx.signal)
      const now = performance.now()
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now + 40000)
      const release = v.demos.step({ ...state, decision: 'release' }, v.ctx)
      void release.catch(() => undefined)
      // The expiry check runs before arm dispatch. Restore the monotonic clock for frame settling.
      await new Promise((resolve) => setTimeout(resolve, 20))
      clock.mockRestore()
      state = checkpoint(await release)
      expect(state.phase).toBe('released')
      expect((state as unknown as { postActionPhotoAvailable: boolean }).postActionPhotoAvailable).toBe(false)
      expect(grip.mock.calls.map((c) => c[0])).toEqual(['grab', 'release'])
      v.runtime.startCamera(10)
      const restored = v.stream.mock.calls.at(-1)?.[2]
      if (!restored) throw new Error('Missing restored camera callback')
      v.receive = restored
      restored({ bytes: jpeg, width: 320, height: 240 })
      const next = checkpoint(await v.demos.start('model_tennis', v.ctx, state.workflowId))
      expect(next.phase).toBe('await_target')
      expect(next.photoCount).toBe(1)
      expect(v.motion).not.toHaveBeenCalled()
    } finally {
      clearInterval(frames)
    }
  }, 15000)
  it('executes a supplied patrol route in order and archives each stopped observation', async () => {
    const v = await scanFixture()
    const tool = v.tools.get('aka_patrol')
    if (!tool) throw new Error('Missing patrol tool')
    expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
    const steps = [
      { action: 'up', speed: 30, milliseconds: 500 },
      { action: 'right', speed: 30, milliseconds: 500 },
      { action: 'down', speed: 30, milliseconds: 500 },
    ] as const
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      const result = await tool.execute({ steps: [...steps], supervised: true } as never, v.ctx)
      expect(result.structured).toMatchObject({
        kind: 'patrol',
        phase: 'completed',
        completedViews: 4,
        requestedViews: 4,
        route: steps,
        physicalResult: 'unverified',
      })
      expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1)
      expect(v.motion.mock.calls.map((call) => call[0])).toMatchObject([
        { action: 'up', speed: 30 },
        { action: 'right', speed: 30 },
        { action: 'down', speed: 30 },
      ])
      const state = v.tasks.read('chat', id, 1)
      if (!state) throw new Error('Missing patrol record')
      const exported = await v.tasks.export(state.taskId, v.ctx)
      expect(exported).toMatchObject({ photoCount: 4 })
      expect(v.write).toHaveBeenCalledTimes(5)
      const manifest = v.write.mock.calls.find((call) => String(call[0]).endsWith('manifest.json'))
      expect(JSON.parse(String(manifest?.[1]))).toMatchObject({
        kind: 'patrol-record',
        viewpointsVerified: false,
      })
    } finally {
      clearInterval(frames)
    }
  })
  it.each([
    { steps: [], supervised: true },
    { steps: [{ action: 'grab', speed: 30, milliseconds: 500 }], supervised: true },
    { steps: [{ action: 'up', speed: 51, milliseconds: 500 }], supervised: true },
    { steps: [{ action: 'up', speed: 30, milliseconds: 3001 }], supervised: true },
    { steps: [{ action: 'up', speed: 30, milliseconds: 500 }], supervised: false },
  ])('rejects invalid patrol route before movement: %j', async (input) => {
    const v = await scanFixture()
    await expect(v.tasks.patrol(input as never, v.ctx)).rejects.toThrow('Invalid bounded patrol route')
    expect(v.motion).not.toHaveBeenCalled()
    expect(v.put).not.toHaveBeenCalled()
  })
  it('cancels patrol at a photo checkpoint without dispatching later route segments', async () => {
    const v = await scanFixture()
    const original = v.put.getMockImplementation()
    if (!original) throw new Error('Missing writer')
    let release: (() => void) | undefined
    v.put.mockImplementation(async (bytes) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(bytes)
    })
    const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
    try {
      const step: { action: 'up' | 'down'; speed: number; milliseconds: number } = {
        action: 'up',
        speed: 30,
        milliseconds: 500,
      }
      const steps = [step]
      const pending = v.tasks.patrol({ steps, supervised: true }, v.ctx)
      step.action = 'down'
      await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 3000 })
      const state = v.tasks.read('chat', id, 1)
      if (!state || !release) throw new Error('Missing patrol checkpoint')
      expect(state.route?.[0]?.action).toBe('up')
      await v.tasks.cancel(state.taskId, 'chat')
      release()
      expect((await pending).structured).toMatchObject({
        kind: 'patrol',
        phase: 'cancelled',
        completedViews: 0,
      })
      expect(v.motion).not.toHaveBeenCalled()
    } finally {
      clearInterval(frames)
    }
  })
  it.each([3, 8])(
    'returns %i fresh observation photos and accurate unmeasured coverage',
    async (views) => {
      const v = await scanFixture()
      const scan = v.tools.get('aka_scan')
      if (!scan) throw new Error('Missing scan tool')
      expect(checkToolDef(scan, { prefix: '' })).toEqual({ ok: true })
      const frames = setInterval(() => v.receive({ bytes: jpeg, width: 320, height: 240 }), 30)
      try {
        const surround = v.tools.get('aka_surround')
        if (!surround) throw new Error('Missing surround workflow')
        const result =
          views === 8
            ? await surround.execute({} as never, v.ctx)
            : await scan.execute({ views, direction: 'left' } as never, v.ctx)
        expect(result.structured).toMatchObject({
          phase: 'completed',
          completedViews: views,
          coverage: 'unmeasured',
          physicalResult: 'unverified',
        })
        expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1)
        expect(v.motion).toHaveBeenCalledTimes(views - 1)
        expect(v.motion.mock.calls.map((call) => call[0])).toEqual(
          Array.from({ length: views - 1 }, () => ({
            action: 'left',
            mode: 'time',
            speed: 30,
            milliseconds: 1000,
          })),
        )
        expect(v.put).toHaveBeenCalledTimes(views)
        expect(v.tasks.read('other', id, 1)).toBeNull()
        expect(v.tasks.read('chat', id, 2)).toBeNull()
        expect(v.tasks.read('chat', id, 1)?.phase).toBe('completed')
        const task = v.tasks.read('chat', id, 1)
        if (!task) throw new Error('Missing finished task')
        const exported = await v.tasks.export(task.taskId, v.ctx)
        expect(exported).toMatchObject({ photoCount: views, viewpointsVerified: false, scale: 'unknown' })
        expect(v.write).toHaveBeenCalledTimes(views + 1)
        if (views === 8) {
          await expect(surround.execute({} as never, v.ctx)).rejects.toThrow(/already started/)
          await expect(v.tools.get('aka_find_tennis')?.execute({} as never, v.ctx)).rejects.toThrow(
            /selected case/,
          )
          await expect(v.tools.get('aka_pickup_tennis')?.execute({} as never, v.ctx)).rejects.toThrow(
            /selected case/,
          )
          await expect(
            runDeviceControl(
              v.deps,
              { ...v.ctx, session: { ...v.ctx.session, toolUseId: 'model-call' } },
              { action: 'grab', speed: 30, milliseconds: 500, bindingRevision: 1, configRevision: 1 },
            ),
          ).rejects.toThrow(/selected case/)
        }
        const read = v.tools.get('aka_read_observations')
        if (!read) throw new Error('Missing observation reader')
        expect(read.meta).toMatchObject({ isReadOnly: true, isDestructive: false })
        for (let offset = 0; offset < views; offset += 2) {
          v.ctx = { ...v.ctx, session: { ...v.ctx.session, step: 2 + offset } }
          const page = await read.execute({ taskId: task.taskId, offset, limit: 2 } as never, v.ctx)
          expect(page.structured).toMatchObject({
            offset,
            total: views,
            nextOffset: offset + 2 < views ? offset + 2 : null,
          })
          expect(page.content.filter((c) => c.type === 'image')).toHaveLength(1)
          await expect(
            read.execute({ taskId: task.taskId, offset: 0, limit: 2 } as never, v.ctx),
          ).rejects.toThrow(/one observation page/)
        }
        expect(v.motion).toHaveBeenCalledTimes(views - 1)
        expect(v.put).toHaveBeenCalledTimes(views)
        v.ctx = { ...v.ctx, session: { ...v.ctx.session, step: 20 } }
        const ends = await v.tasks.readPhotos(task.taskId, 0, 2, v.ctx, true)
        expect(ends.structured).toMatchObject({ indices: [0, views - 1], nextOffset: null })
        const endFacts = ends.content.filter((c) => c.type === 'text').map((c) => JSON.parse(c.text))
        expect(endFacts.at(-1)).toMatchObject({
          index: views - 1,
          motion: { round: views - 1, action: 'left', speed: 30, milliseconds: 1000 },
        })
        await expect(v.tasks.readPhotos(task.taskId, 0, 3, v.ctx)).rejects.toThrow()
        await expect(
          v.tasks.readPhotos(task.taskId, 0, 2, { ...v.ctx, session: { ...v.ctx.session, key: 'other' } }),
        ).rejects.toThrow()
        expect(
          v.write.mock.calls
            .filter((call) => String(call[0]).endsWith('.jpg'))
            .every((call) => Buffer.from(call[1] as Uint8Array).equals(jpeg)),
        ).toBe(true)
        await expect(
          v.tasks.export(task.taskId, { ...v.ctx, session: { ...v.ctx.session, key: 'other' } }),
        ).rejects.toThrow()
      } finally {
        clearInterval(frames)
      }
    },
    20000,
  )
  it.each([0, 2500])(
    'finds a target after a short turn with %i ms cloud latency and dispatches no later turns',
    async (latency) => {
      const v = await scanFixture()
      const tool = v.tools.get('aka_find')
      if (!tool) throw new Error('Missing search tool')
      expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
      const artifact = {
        sha256: createHash('sha256').update(jpeg).digest('hex'),
        size: jpeg.length,
        mime: 'image/jpeg',
      }
      let serial = 0
      const replies = new Set<ReturnType<typeof setTimeout>>()
      const publish = async () => {
        v.receive({ bytes: jpeg, width: 320, height: 240 })
        const selectedAt = new Date().toISOString(),
          receivedAt = performance.now(),
          sequence = ++serial
        const confidence = v.motion.mock.calls.length ? 0.9 : 0.2
        if (latency)
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              replies.delete(timer)
              done()
            }, latency)
            replies.add(timer)
          })
        await v.geometry.remember(
          v.ctx,
          {
            id: `recognized-${sequence}`,
            frameId: `frame-${sequence}`,
            selectedAt,
            receivedAt,
            deviceId: id,
            bindingRevision: 1,
            width: 320,
            height: 240,
            artifact,
            detections: [
              ...Array.from({ length: 5 }, () => ({
                label: 'other',
                confidence: 0.99,
                box: [1, 2, 3, 4] as const,
              })),
              { label: 'ball', confidence, box: [10, 20, 30, 40] },
            ],
          },
          1,
        )
      }
      const frames = setInterval(() => void publish(), 30)
      try {
        const result = await tool.execute(
          { views: 4, direction: 'right', labels: ['Ball', '网球'] } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          phase: 'completed',
          kind: 'search',
          targetFound: true,
          completedViews: 2,
        })
        expect(v.motion).toHaveBeenCalledOnce()
        expect(
          result.content
            .filter((item) => item.type === 'image')
            .map((item) => (item.type === 'image' ? item.ref : null)),
        ).toEqual([artifact])
        expect(v.put).not.toHaveBeenCalled()
        expect(v.stop).toHaveBeenCalled()
      } finally {
        clearInterval(frames)
        for (const timer of replies) clearTimeout(timer)
      }
    },
    15000,
  )
  it.each([false, true])(
    'limits slow recognition reads by elapsed time and refuses late results (%s)',
    async (lateResult) => {
      const v = await scanFixture()
      const started = performance.now()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => started + elapsed)
      vi.spyOn(v.geometry, 'observation').mockImplementation(async () => {
        elapsed += 2600
        if (elapsed > 10400) throw new Error('Recognition polling exceeded its time budget')
        return lateResult && elapsed >= 10400
          ? {
              id: 'late-result',
              frameId: 'late-frame',
              deviceId: id,
              bindingRevision: 1,
              width: 320,
              height: 240,
              artifact: {
                sha256: createHash('sha256').update(jpeg).digest('hex'),
                size: jpeg.length,
                mime: 'image/jpeg',
              },
              detections: [{ label: 'ball', confidence: 0.99, box: [1, 2, 3, 4] }],
            }
          : null
      })
      const result = await v.tasks.find({ views: 4, direction: 'left', labels: ['ball'] }, v.ctx)
      expect(elapsed).toBeLessThanOrEqual(10400)
      expect(result.structured).toMatchObject({
        phase: 'failed',
        completedViews: 0,
        targetFound: false,
        error: 'Fresh recognition unavailable; enable the page recognition switch first',
      })
      expect(result.content.some((item) => item.type === 'image')).toBe(false)
      expect(v.motion).not.toHaveBeenCalled()
      expect(v.runtime.snapshot().control.phase).toBe('idle')
    },
  )
  it('cancels a search with no fresh recognition without moving or treating old matches as current', async () => {
    const v = await scanFixture()
    await v.geometry.remember(
      v.ctx,
      {
        id: 'old',
        frameId: 'old-frame',
        selectedAt: new Date(Date.now() - 5000).toISOString(),
        artifact: {
          sha256: createHash('sha256').update(jpeg).digest('hex'),
          size: jpeg.length,
          mime: 'image/jpeg',
        },
        deviceId: id,
        bindingRevision: 1,
        width: 320,
        height: 240,
        detections: [{ label: 'ball', confidence: 0.99, box: [1, 2, 3, 4] }],
      },
      1,
    )
    const pending = v.tasks.find({ views: 4, direction: 'left', labels: ['ball'] }, v.ctx)
    await vi.waitFor(() => expect(v.tasks.read('chat', id, 1)?.kind).toBe('search'))
    const state = v.tasks.read('chat', id, 1)
    if (!state) throw new Error('Missing search')
    await v.tasks.cancel(state.taskId, 'chat')
    expect((await pending).structured).toMatchObject({
      phase: 'cancelled',
      targetFound: false,
      completedViews: 0,
    })
    expect(v.motion).not.toHaveBeenCalled()
  })
  async function approachFixture() {
    const v = await scanFixture()
    const point = (u: number, pixelV: number) => ({ u, v: pixelV, x: 1 - pixelV / 240, y: 1 - u / 160 })
    const motion = {
      speed: 30,
      milliseconds: 500,
      forwardMeters: [0.049, 0.05, 0.051],
      leftDegrees: [5, 5.5, 6],
      rightDegrees: [5, 5.5, 6],
      marginMeters: 0.005,
      marginDegrees: 0.5,
      minimumStandoff: 0.1,
      turningClearance: 0.2,
      lateralTolerance: 0.03,
      maximumVisionError: 0.02,
    }
    await v.geometry.save(v.ctx, {
      bindingRevision: 1,
      configRevision: 1,
      expectedRevision: 0,
      calibration: {
        width: 320,
        height: 240,
        installation: 'fixed-test',
        labels: ['ball'],
        measurementErrorMeters: 0.005,
        motion,
        points: [
          [10, 20],
          [150, 20],
          [290, 20],
          [10, 200],
          [150, 200],
          [290, 200],
        ].map(([u, pixelV]) => point(u ?? 0, pixelV ?? 0)),
        checks: [point(70, 90), point(200, 80), point(120, 140)],
      },
    })
    const artifact = {
      sha256: createHash('sha256').update(jpeg).digest('hex'),
      size: jpeg.length,
      mime: 'image/jpeg',
    }
    let serial = 0
    const publish = async (forward: number, ambiguous = false) => {
      v.receive({ bytes: jpeg, width: 320, height: 240 })
      const bottom = (1 - forward) * 240
      const target = { label: 'ball', confidence: 0.9, box: [140, bottom - 10, 180, bottom] as const }
      await v.geometry.remember(
        v.ctx,
        {
          id: `approach-${++serial}`,
          frameId: `frame-${serial}`,
          selectedAt: new Date().toISOString(),
          receivedAt: performance.now(),
          deviceId: id,
          bindingRevision: 1,
          width: 320,
          height: 240,
          artifact,
          detections: ambiguous ? [target, { ...target, box: [10, 30, 20, 40] }] : [target],
        },
        1,
      )
    }
    return { ...v, publish }
  }
  it.each([0.7, 0.4])(
    'executes patrol return and checks the observed home pose at %s meters',
    async (finalDistance) => {
      const v = await approachFixture()
      const tool = v.tools.get('aka_patrol')
      if (!tool) throw new Error('Missing patrol tool')
      const frames = setInterval(
        () => void v.publish(v.motion.mock.calls.length >= 2 ? finalDistance : 0.7),
        30,
      )
      try {
        const result = await tool.execute(
          {
            steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
            returnSteps: [{ action: 'down', speed: 30, milliseconds: 500 }],
            homeLabels: ['ball'],
            supervised: true,
          } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          kind: 'patrol',
          phase: 'completed',
          completedViews: 3,
          homeEvidence: finalDistance === 0.7 ? 'observed_candidate' : 'unknown',
        })
        if (finalDistance !== 0.7)
          expect(result.structured).toMatchObject({
            outcome: 'paused',
            outcomeReason: 'home_marker_pose_not_reached',
          })
        expect(v.motion.mock.calls.map((c) => c[0].action)).toEqual(['up', 'down'])
        expect(result.content.filter((item) => item.type === 'image')).toHaveLength(1)
        const observations = result.content.filter(
          (item) => item.type === 'text' && 'observation' in JSON.parse(item.text),
        )
        expect(observations).toHaveLength(3)
      } finally {
        clearInterval(frames)
      }
    },
  )
  it('refuses patrol return evidence when calibrated distance uncertainty is too large', async () => {
    const v = await approachFixture()
    const current = await v.geometry.read(v.ctx, { bindingRevision: 1, configRevision: 1 })
    if (!current) throw new Error('Missing calibration')
    const {
      id: _id,
      revision: _revision,
      matrix: _matrix,
      hull: _hull,
      observedErrorMeters: _error,
      ...raw
    } = current
    await v.geometry.save(v.ctx, {
      bindingRevision: 1,
      configRevision: 1,
      expectedRevision: current.revision,
      calibration: { ...raw, measurementErrorMeters: 0.03 },
    })
    const frames = setInterval(() => void v.publish(0.7), 30)
    try {
      const result = await v.tasks.patrol(
        {
          steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
          returnSteps: [{ action: 'down', speed: 30, milliseconds: 500 }],
          homeLabels: ['ball'],
          supervised: true,
        },
        v.ctx,
      )
      expect(result.structured).toMatchObject({
        homeEvidence: 'unknown',
        outcome: 'paused',
        outcomeReason: 'home_marker_or_distance_unknown',
        completedViews: 1,
      })
      expect(v.motion).not.toHaveBeenCalled()
    } finally {
      clearInterval(frames)
    }
  })
  it.each(['complete', 'missing'] as const)(
    'moves around the object and retains four separated originals: %s',
    async (mode) => {
      const v = await approachFixture()
      const current = await v.geometry.read(v.ctx, { bindingRevision: 1, configRevision: 1 })
      if (!current?.motion) throw new Error('Missing calibration')
      const {
        id: _id,
        revision: _revision,
        matrix: _matrix,
        hull: _hull,
        observedErrorMeters: _error,
        ...raw
      } = current
      await v.geometry.save(v.ctx, {
        bindingRevision: 1,
        configRevision: 1,
        expectedRevision: current.revision,
        calibration: {
          ...raw,
          motion: {
            ...current.motion,
            milliseconds: 500,
            forwardMeters: [0.05, 0.05, 0.05],
            leftDegrees: [10, 10, 10],
            rightDegrees: [10, 10, 10],
            marginMeters: 0.001,
            marginDegrees: 0.1,
          },
        },
      })
      const pose = { x: 0, y: 0, yaw: 0 }
      v.motion.mockImplementation(async (motion) => {
        if (motion.action === 'up') {
          pose.x += 0.05 * Math.cos(pose.yaw)
          pose.y += 0.05 * Math.sin(pose.yaw)
        } else pose.yaw += ((motion.action === 'left' ? 1 : -1) * Math.PI) / 18
        return { state: 'acknowledged' }
      })
      const originals = new Map<string, Buffer>()
      vi.mocked(v.ctx.artifacts.get).mockImplementation(async (ref) => {
        const bytes = originals.get(ref.sha256)
        if (!bytes) throw new Error('Original missing')
        return bytes
      })
      let serial = 0
      const publish = async () => {
        const dx = 0.7 - pose.x,
          dy = -pose.y
        const x = dx * Math.cos(pose.yaw) + dy * Math.sin(pose.yaw),
          y = -dx * Math.sin(pose.yaw) + dy * Math.cos(pose.yaw)
        const u = 160 * (1 - y),
          pixelV = 240 * (1 - x)
        const comment = Buffer.from(String(++serial))
        const bytes = Buffer.concat([
          jpeg.subarray(0, 2),
          Buffer.from([0xff, 0xfe, 0, comment.length + 2]),
          comment,
          jpeg.subarray(2),
        ])
        v.receive({ bytes, width: 320, height: 240 })
        originals.set(createHash('sha256').update(bytes).digest('hex'), bytes)
        await v.geometry.remember(
          v.ctx,
          {
            id: `orbit-${serial}`,
            frameId: `frame-${serial}`,
            selectedAt: new Date().toISOString(),
            receivedAt: performance.now(),
            deviceId: id,
            bindingRevision: 1,
            width: 320,
            height: 240,
            artifact: {
              sha256: createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length,
              mime: 'image/jpeg',
            },
            detections:
              mode === 'missing' && v.motion.mock.calls.length
                ? []
                : [{ label: 'ball', confidence: 0.9, box: [u - 10, pixelV - 10, u + 10, pixelV] }],
          },
          1,
        )
      }
      const frames = setInterval(() => void publish(), 30)
      try {
        const tool = v.tools.get('aka_orbit_capture')
        if (!tool) throw new Error('Missing orbit tool')
        expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
        const result = await tool.execute(
          { labels: ['ball'], direction: 'left', supervised: true } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          kind: 'orbit',
          phase: mode === 'complete' ? 'completed' : 'failed',
          completedViews: mode === 'complete' ? 4 : 1,
          viewpointsVerified: false,
        })
        const images = result.content.filter((c) => c.type === 'image')
        expect(images).toHaveLength(mode === 'complete' ? 4 : 2)
        expect(new Set(images.map((image) => (image.type === 'image' ? image.ref.sha256 : ''))).size).toBe(
          images.length,
        )
        expect(v.motion.mock.calls.some((call) => call[0].action === 'up')).toBe(true)
        const exported = await v.tasks.export((result.structured as { taskId: string }).taskId, v.ctx)
        expect(exported.photoCount).toBe(images.length)
        const manifest = v.write.mock.calls.find((call) => String(call[0]).endsWith('manifest.json'))
        expect(JSON.parse(String(manifest?.[1]))).toMatchObject({
          kind: mode === 'complete' ? 'orbit-four-view' : 'orbit-partial',
          viewpointsVerified: false,
        })
        if (mode === 'complete') {
          const points = (
            result.structured as { viewpoints: { angleDegrees: number; uncertaintyDegrees: number }[] }
          ).viewpoints
          expect(points.map((p) => Math.round(p.angleDegrees / 90))).toEqual([0, 1, 2, -1])
          expect(points.every((p) => p.uncertaintyDegrees < 15)).toBe(true)
        }
      } finally {
        clearInterval(frames)
      }
    },
    20000,
  )
  it('reloads the saved patrol route and executes it without route parameters in the tool call', async () => {
    const v = await approachFixture()
    const ctx = {
      ...v.ctx,
      device: {
        ...v.ctx.device,
        connection: async () => ({
          deviceId: id,
          bindingRevision: 1,
          profile: { ...registration, driver: 'aka-00' as const },
        }),
      },
    } as ToolContext
    v.deps.registrations.clear()
    registerGeometry((service) => v.services.set(service.name, service), v.geometry)
    const current = await v.geometry.read(ctx, { bindingRevision: 1, configRevision: 1 })
    if (!current) throw new Error('Missing calibration')
    const {
      id: _id,
      revision: _revision,
      matrix: _matrix,
      hull: _hull,
      observedErrorMeters: _error,
      ...raw
    } = current
    const patrol = {
      steps: [{ action: 'up' as const, speed: 30, milliseconds: 500 }],
      returnSteps: [{ action: 'down' as const, speed: 30, milliseconds: 500 }],
      homeLabels: ['ball'],
    }
    const save = v.services.get('aka.geometry.save')
    if (!save) throw new Error('Missing page calibration save service')
    await save.handler(
      {
        bindingRevision: 1,
        configRevision: 1,
        expectedRevision: current.revision,
        calibration: { ...raw, routes: { patrol } },
      },
      ctx as unknown as ServiceContext,
    )
    const reopened = new GroundGeometry(v.deps)
    expect((await reopened.read(ctx, { bindingRevision: 1, configRevision: 1 }))?.routes).toEqual({
      patrol,
    })
    const frames = setInterval(() => void v.publish(0.7), 30)
    try {
      const tool = v.tools.get('aka_patrol_saved')
      if (!tool) throw new Error('Missing saved patrol tool')
      expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
      expect((await tool.execute({ supervised: true } as never, ctx)).structured).toMatchObject({
        kind: 'patrol',
        phase: 'completed',
        homeEvidence: 'observed_candidate',
      })
      expect(v.motion.mock.calls.map((c) => c[0])).toMatchObject(
        [...patrol.steps, ...patrol.returnSteps].map(({ milliseconds: _ms, ...step }) => step),
      )
    } finally {
      clearInterval(frames)
    }
  })
  it('uses real calibration and recognizes again after each measured step before stopping at standoff', async () => {
    const v = await approachFixture(),
      tool = v.tools.get('aka_approach')
    if (!tool) throw new Error('Missing approach tool')
    expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
    const frames = setInterval(() => void v.publish(v.motion.mock.calls.length ? 0.65 : 0.7), 30)
    try {
      const result = await tool.execute(
        { labels: ['ball'], standoffMeters: 0.6, maxSteps: 4, supervised: true } as never,
        v.ctx,
      )
      expect(result.structured).toMatchObject({
        kind: 'approach',
        phase: 'completed',
        outcome: 'at_standoff',
        completedViews: 2,
        physicalResult: 'unverified',
      })
      expect(v.motion).toHaveBeenCalledOnce()
      expect(v.motion.mock.calls[0]?.[0]).toMatchObject({ action: 'up', speed: 30, milliseconds: 500 })
      expect(result.content.filter((item) => item.type === 'image')).toHaveLength(1)
    } finally {
      clearInterval(frames)
    }
  })
  it.each(['ambiguous', 'changed-position'] as const)(
    'pauses approach on %s instead of selecting a new object or repeating movement',
    async (mode) => {
      const v = await approachFixture()
      const frames = setInterval(
        () => void v.publish(v.motion.mock.calls.length ? 0.4 : 0.7, mode === 'ambiguous'),
        30,
      )
      try {
        const result = await v.tasks.approach(
          { labels: ['ball'], standoffMeters: 0.6, maxSteps: 4, supervised: true },
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          phase: 'completed',
          outcome: 'paused',
          outcomeReason:
            mode === 'ambiguous' ? 'ambiguous_target' : 'target_changed_or_motion_outside_measured_range',
        })
        expect(v.motion).toHaveBeenCalledTimes(mode === 'ambiguous' ? 0 : 1)
      } finally {
        clearInterval(frames)
      }
    },
  )
  it('reports missing approach and grasp calibration as not started before movement', async () => {
    const v = await scanFixture()
    await expect(
      v.tasks.approach({ labels: ['ball'], standoffMeters: 0.2, maxSteps: 4, supervised: true }, v.ctx),
    ).resolves.toMatchObject({ structured: { state: 'not-started', physicalResult: 'unverified' } })
    await expect(
      v.tasks.grasp({ action: 'grab', labels: ['ball'], destinationLabels: [], supervised: true }, v.ctx),
    ).resolves.toMatchObject({ structured: { state: 'not-started', physicalResult: 'unverified' } })
    expect(v.motion).not.toHaveBeenCalled()
  })
  async function graspFixture(action: 'grab' | 'release', wrongAfter = false, stableAfter = false) {
    const v = await approachFixture(),
      versions = { bindingRevision: 1, configRevision: 1 }
    const current = await v.geometry.read(v.ctx, versions)
    if (!current) throw new Error('Missing calibration')
    const {
      id: _id,
      revision: _revision,
      matrix: _matrix,
      hull: _hull,
      observedErrorMeters: _error,
      ...raw
    } = current
    await v.geometry.save(v.ctx, {
      ...versions,
      expectedRevision: current.revision,
      calibration: {
        ...raw,
        grasp: {
          forwardMin: 0.65,
          forwardMax: 0.75,
          lateralTolerance: 0.03,
          settleMilliseconds: 4000,
          heldBox: [100, 10, 220, 50],
          releaseBox: [100, 110, 220, 160],
        },
      },
    })
    const grip = vi.spyOn(AkaHttpDriver.prototype, 'grip').mockResolvedValue({ state: 'acknowledged' })
    let serial = 0
    const publish = async () => {
      const changed = grip.mock.calls.length > 0
      const box =
        action === 'grab'
          ? changed && !wrongAfter
            ? [140, 20, 180, 40]
            : [140, 62, 180, 72]
          : changed
            ? [140, 120, 180, 140]
            : [140, 20, 180, 40]
      serial++
      const comment = Buffer.from(changed && stableAfter ? 'stationary-after' : String(serial))
      const bytes = Buffer.concat([
        jpeg.subarray(0, 2),
        Buffer.from([0xff, 0xfe, 0, comment.length + 2]),
        comment,
        jpeg.subarray(2),
      ])
      v.receive({ bytes, width: 320, height: 240 })
      await v.geometry.remember(
        v.ctx,
        {
          id: `grasp-${serial}`,
          frameId: `frame-${serial}`,
          selectedAt: new Date().toISOString(),
          receivedAt: performance.now(),
          deviceId: id,
          bindingRevision: 1,
          width: 320,
          height: 240,
          artifact: {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            mime: 'image/jpeg',
          },
          detections: [
            { label: 'ball', confidence: 0.9, box: box as [number, number, number, number] },
            ...(action === 'release'
              ? [{ label: 'bin', confidence: 0.9, box: [90, 100, 230, 170] as const }]
              : []),
          ],
        },
        1,
      )
    }
    return { ...v, grip, publish }
  }
  it.each(['grab', 'release'] as const)(
    'executes one %s and returns separate before/after originals with visual evidence only',
    async (action) => {
      const v = await graspFixture(action, false, true),
        tool = v.tools.get('aka_grasp')
      if (!tool) throw new Error('Missing grasp tool')
      expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
      const frames = setInterval(() => void v.publish(), 50)
      try {
        const result = await tool.execute(
          {
            action,
            labels: ['ball'],
            destinationLabels: action === 'release' ? ['bin'] : [],
            supervised: true,
          } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          phase: 'completed',
          completedViews: 3,
          armReceipt: 'acknowledged',
          gripEvidence: action === 'grab' ? 'held_candidate' : 'released_candidate',
          physicalResult: 'unverified',
        })
        expect(result.content.filter((item) => item.type === 'image')).toHaveLength(2)
        const observations = result.content
          .filter((item) => item.type === 'text')
          .map((item) => JSON.parse(item.text))
          .filter((item) => item.frameId)
        expect(observations).toHaveLength(3)
        expect(new Set(observations.map((item) => item.frameId)).size).toBe(3)
        expect(v.grip).toHaveBeenCalledOnce()
        expect(v.motion).not.toHaveBeenCalled()
      } finally {
        clearInterval(frames)
      }
    },
    15000,
  )
  it.each(['complete', 'lost', 'destination-missing'] as const)(
    'checks held object and destination through the real transport tool: %s',
    async (mode) => {
      const v = await graspFixture('release')
      const tool = v.tools.get('aka_transport')
      if (!tool) throw new Error('Missing transport tool')
      expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
      const original = v.geometry.observation.bind(v.geometry)
      vi.spyOn(v.geometry, 'observation').mockImplementation(async (...args) => {
        const image = await original(...args)
        if (!image) return image
        return {
          ...image,
          detections: image.detections.filter(
            (d) =>
              !(mode === 'lost' && v.motion.mock.calls.length > 0 && d.label === 'ball') &&
              !(mode === 'destination-missing' && d.label === 'bin'),
          ),
        }
      })
      const frames = setInterval(() => void v.publish(), 50)
      try {
        const result = await tool.execute(
          {
            labels: ['ball'],
            destinationLabels: ['bin'],
            supervised: true,
            steps: [
              { action: 'up', speed: 30, milliseconds: 500 },
              { action: 'right', speed: 30, milliseconds: 500 },
            ],
          } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          kind: 'transport',
          phase: 'completed',
          physicalResult: 'unverified',
        })
        if (mode === 'complete') {
          expect(result.structured).toMatchObject({ completedViews: 3, gripEvidence: 'held_candidate' })
          expect(v.motion).toHaveBeenCalledTimes(2)
        } else {
          expect(result.structured).toMatchObject({
            outcome: 'paused',
            outcomeReason:
              mode === 'lost' ? 'held_target_lost_or_ambiguous' : 'destination_not_observed_before_transport',
          })
          expect(v.motion).toHaveBeenCalledTimes(mode === 'lost' ? 1 : 0)
        }
        expect(v.grip).not.toHaveBeenCalled()
      } finally {
        clearInterval(frames)
      }
    },
  )
  it.each(['dispose', 'retrieve'] as const)(
    'runs the full %s mission with real stages and exact original images',
    async (goal) => {
      const v = await graspFixture('grab')
      const remember = v.geometry.remember.bind(v.geometry)
      vi.spyOn(v.geometry, 'remember').mockImplementation(async (ctx, image, revision) =>
        remember(
          ctx,
          {
            ...image,
            detections: [
              ...image.detections.map((d) =>
                v.grip.mock.calls.length >= 2 && d.label === 'ball'
                  ? { ...d, box: [140, 120, 180, 140] as const }
                  : d,
              ),
              { label: 'bin', confidence: 0.9, box: [90, 100, 230, 170] as const },
            ],
          },
          revision,
        ),
      )
      if (goal === 'retrieve') {
        const c = await v.geometry.read(v.ctx, { bindingRevision: 1, configRevision: 1 })
        if (!c) throw new Error('Missing calibration')
        const {
          id: _id,
          revision: _revision,
          matrix: _matrix,
          hull: _hull,
          observedErrorMeters: _error,
          ...raw
        } = c
        await v.geometry.save(v.ctx, {
          bindingRevision: 1,
          configRevision: 1,
          expectedRevision: c.revision,
          calibration: {
            ...raw,
            routes: {
              delivery: {
                steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
                destinationLabels: ['bin'],
              },
            },
          },
        })
      }
      await v.publish()
      const tool = v.tools.get(goal === 'retrieve' ? 'aka_mission_saved' : 'aka_mission')
      if (!tool) throw new Error('Missing mission tool')
      expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
      const frames = setInterval(() => void v.publish(), 50)
      try {
        const result = await tool.execute(
          {
            goal,
            labels: ['ball'],
            standoffMeters: 0.68,
            supervised: true,
            ...(goal === 'dispose'
              ? { destinationLabels: ['bin'], steps: [{ action: 'up', speed: 30, milliseconds: 500 }] }
              : {}),
          } as never,
          v.ctx,
        )
        expect(result.structured).toMatchObject({
          kind: 'mission',
          phase: 'completed',
          completedViews: goal === 'dispose' ? 5 : 4,
          gripEvidence: goal === 'dispose' ? 'released_candidate' : 'held_candidate',
          physicalResult: 'unverified',
        })
        expect(v.grip.mock.calls.map((c) => c[0])).toEqual(
          goal === 'dispose' ? ['grab', 'release'] : ['grab'],
        )
        expect(v.motion).toHaveBeenCalledOnce()
        expect(result.content.filter((c) => c.type === 'image').length).toBeGreaterThanOrEqual(7)
        const state = v.tasks.read('chat', id, 1)
        if (!state) throw new Error('Missing mission record')
        expect(state.taskId).toBe((result.structured as { taskId: string }).taskId)
      } finally {
        clearInterval(frames)
      }
    },
    25000,
  )
  it('refuses full pickup when destination is not observed before grasping', async () => {
    const v = await graspFixture('grab')
    await v.publish()
    const result = await v.tasks.mission(
      {
        goal: 'dispose',
        labels: ['ball'],
        destinationLabels: ['bin'],
        standoffMeters: 0.68,
        supervised: true,
        steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
      },
      v.ctx,
    )
    expect(result).toMatchObject({ isError: true, structured: { phase: 'failed', completedViews: 0 } })
    expect(result.structured).toMatchObject({ error: 'Destination must be observed before pickup' })
    expect(v.grip).not.toHaveBeenCalled()
    expect(v.motion).not.toHaveBeenCalled()
  })
  it('keeps mission ownership across stages and lets manual stop cancel the entire chain', async () => {
    const v = await graspFixture('release')
    await v.publish()
    const pending = v.tasks.mission(
      {
        goal: 'dispose',
        labels: ['ball'],
        destinationLabels: ['bin'],
        standoffMeters: 0.68,
        supervised: true,
        steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
      },
      v.ctx,
    )
    await vi.waitFor(() => expect(v.tasks.read('chat', id, 1)?.kind).toBe('mission'))
    await expect(v.tasks.scan({ views: 2, direction: 'right' }, v.ctx)).rejects.toThrow('Mission owns device')
    await runDeviceControl(v.deps, v.ctx, {
      bindingRevision: 1,
      configRevision: 1,
      action: 'stop',
      speed: 30,
      milliseconds: 500,
    })
    expect((await pending).structured).toMatchObject({ kind: 'mission', phase: 'cancelled' })
    expect(v.grip).not.toHaveBeenCalled()
    expect(v.motion).not.toHaveBeenCalled()
  })
  it('keeps possession unknown when the object remains on the ground and does not repeat grasp', async () => {
    const v = await graspFixture('grab', true),
      frames = setInterval(() => void v.publish(), 50)
    try {
      const result = await v.tasks.grasp(
        { action: 'grab', labels: ['ball'], destinationLabels: [], supervised: true },
        v.ctx,
      )
      expect(result.structured).toMatchObject({
        phase: 'completed',
        outcome: 'paused',
        gripEvidence: 'unknown',
      })
      expect(v.grip).toHaveBeenCalledOnce()
    } finally {
      clearInterval(frames)
    }
  }, 15000)
  it('cancels observation of an accepted arm sequence without resending or claiming arm cancellation', async () => {
    const v = await graspFixture('grab'),
      frames = setInterval(() => void v.publish(), 50)
    try {
      const pending = v.tasks.grasp(
        { action: 'grab', labels: ['ball'], destinationLabels: [], supervised: true },
        v.ctx,
      )
      await vi.waitFor(() => expect(v.grip).toHaveBeenCalled())
      const task = v.tasks.read('chat', id, 1)
      if (!task) throw new Error('Missing grasp task')
      await v.tasks.cancel(task.taskId, 'chat')
      expect((await pending).structured).toMatchObject({
        phase: 'cancelled',
        armReceipt: 'unknown',
        gripEvidence: 'unknown',
      })
      expect(v.grip).toHaveBeenCalledOnce()
      expect(v.runtime.snapshot().control.phase).toBe('unknown')
      expect(v.motion).not.toHaveBeenCalled()
    } finally {
      clearInterval(frames)
    }
  })
  it('cancels while saving a photo without dispatching later movement or another write', async () => {
    const v = await scanFixture()
    const original = v.put.getMockImplementation()
    if (!original) throw new Error('Missing writer')
    let finish: (() => void) | undefined
    v.put.mockImplementation(async (bytes) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return original(bytes)
    })
    const pending = v.tasks.scan({ views: 4, direction: 'right' }, v.ctx)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const state = v.tasks.read('chat', id, 1)
    if (!state || !finish) throw new Error('Missing running task')
    await expect(v.tasks.cancel(state.taskId, 'other')).rejects.toThrow()
    await v.tasks.cancel(state.taskId, 'chat')
    finish()
    const result = await pending
    expect(result.structured).toMatchObject({ phase: 'cancelled', completedViews: 0 })
    expect(v.motion).not.toHaveBeenCalled()
    expect(v.stop).not.toHaveBeenCalled()
    expect(v.put).toHaveBeenCalledOnce()
  })
  it('lets the stop command interrupt an active scan and prevents subsequent movement', async () => {
    const v = await scanFixture()
    let acknowledge: ((value: { state: 'acknowledged' }) => void) | undefined
    v.motion.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    )
    const pending = v.tasks.scan({ views: 4, direction: 'right' }, v.ctx)
    await vi.waitFor(() => expect(acknowledge).toBeDefined())
    await expect(
      runDeviceControl(v.deps, v.ctx, {
        bindingRevision: 1,
        configRevision: 1,
        action: 'stop',
        speed: 30,
        milliseconds: 500,
      }),
    ).resolves.toMatchObject({ state: 'completed' })
    if (!acknowledge) throw new Error('Missing pending motion')
    acknowledge({ state: 'acknowledged' })
    const result = await pending
    expect(result.structured).toMatchObject({ phase: 'cancelled', completedViews: 1 })
    expect(v.motion).toHaveBeenCalledOnce()
  })
  it('refuses an old frame after turning and never repeats the motor action', async () => {
    const v = await scanFixture()
    const result = await v.tasks.scan({ views: 2, direction: 'left' }, v.ctx)
    expect(result.structured).toMatchObject({ phase: 'failed', completedViews: 1 })
    expect(v.motion).toHaveBeenCalledOnce()
    expect(v.put).toHaveBeenCalledOnce()
  })
})
