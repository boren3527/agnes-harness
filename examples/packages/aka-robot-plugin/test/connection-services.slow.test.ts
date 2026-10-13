import type { PluginExtensionAPI, ServiceContext, ServiceDef, ToolDef } from '@agnes/extension-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RuntimeOwner, registerConnectionServices } from '../src/connection-services.js'
import { AkaControlChannel } from '../src/control-channel.js'
import { registerControlServices, registerRobotSettings } from '../src/control-services.js'
import { AkaHttpDriver } from '../src/http-driver.js'
import { AkaRuntimePool } from '../src/runtime.js'

const id = '11111111-1111-4111-8111-111111111111'
const registration = {
  deviceId: id,
  ip: '192.168.50.42',
  port: 80,
  macAddress: '12:34:56:78:90:ab',
  configRevision: 1,
}
const enrolled = () => ({
  sessionId: 'device-chat',
  workspaceId: 'a'.repeat(64),
  deviceId: id,
  bindingRevision: 1,
  active: true,
})
const allow = () => ({ decisionId: 'test-decision', effect: 'allow', reason: 'test authorization' })
const held: AbortController[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.spyOn(AkaHttpDriver.prototype, 'heartbeat').mockResolvedValue({
    service: 'AKA-00',
    identity: { macAddress: registration.macAddress, validity: 'reported' },
  })
  vi.spyOn(AkaHttpDriver.prototype, 'cameraStatus').mockResolvedValue(false)
  vi.spyOn(AkaControlChannel.prototype, 'open').mockResolvedValue()
  vi.spyOn(AkaControlChannel.prototype, 'timedMotion').mockResolvedValue({ state: 'sent' })
  vi.spyOn(AkaControlChannel.prototype, 'stopMotion')
  vi.spyOn(AkaHttpDriver.prototype, 'grip').mockResolvedValue({ state: 'completed' })
  vi.spyOn(AkaHttpDriver.prototype, 'stop').mockResolvedValue({ state: 'completed' })
  vi.spyOn(AkaHttpDriver.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unexpected stream effect')
  })
  vi.spyOn(AkaHttpDriver.prototype, 'setCamera').mockImplementation(async (open) => open)
  vi.spyOn(AkaHttpDriver.prototype, 'move').mockResolvedValue({ state: 'completed' })
})
afterEach(() => {
  for (const owner of held.splice(0)) owner.abort()
  vi.restoreAllMocks()
})
function fixture(persisted = false) {
  const owner = new AbortController()
  held.push(owner)
  const invocation = new AbortController()
  const bindingLifetime = new AbortController()
  const pool = new AkaRuntimePool(owner.signal)
  const owners = new Map<string, RuntimeOwner>()
  const services = new Map<string, ServiceDef>()
  const tools = new Map<string, ToolDef>()
  const busy = new Set<string>()
  registerConnectionServices((value) => services.set(value.name, value), {
    lifetime: owner.signal,
    pool,
    owners,
    registrations: new Map(persisted ? [] : [[id, registration]]),
    busy,
  })
  registerControlServices((value) => services.set(value.name, value), {
    api: {
      ctx: { signal: owner.signal },
      registerTool: (tool: ToolDef) => tools.set(tool.name, tool),
    } as unknown as PluginExtensionAPI,
    pool,
    owners,
    busy,
    registrations: new Map(persisted ? [] : [[id, registration]]),
  })
  registerRobotSettings((value) => services.set(value.name, value), {
    api: { ctx: { signal: owner.signal } } as unknown as PluginExtensionAPI,
    pool,
    owners,
    busy,
    registrations: new Map(persisted ? [] : [[id, registration]]),
  })
  const profile = () => ({
    deviceId: id,
    bindingRevision: 1,
    profile: {
      driver: 'aka-00' as const,
      ip: registration.ip,
      port: registration.port,
      macAddress: registration.macAddress,
      configRevision: registration.configRevision,
    },
  })
  const connection = vi.fn(async () => profile())
  const ctx = {
    session: { key: 'device-chat' },
    signal: invocation.signal,
    device: {
      binding: vi.fn(async () => enrolled()),
      connection: persisted ? connection : undefined,
      retain: vi.fn(async () => ({
        binding: await ctx.device.binding(),
        connection: persisted ? await connection() : undefined,
        revoked: bindingLifetime.signal,
        release: vi.fn(),
      })),
    },
    authorize: vi.fn(async () => allow()),
  }
  const call = (name = 'connect', input: unknown = { configRevision: 1 }, context: unknown = ctx) => {
    const service = services.get(`aka.${name}`)
    if (!service) throw new Error('No connection service')
    return service.handler(input as Parameters<ServiceDef['handler']>[0], context as ServiceContext)
  }
  return {
    owner,
    invocation,
    bindingLifetime,
    pool,
    owners,
    ctx,
    services,
    tools,
    busy,
    call,
    connection,
    profile,
  }
}

describe('AKA Host effect handler connection gates', () => {
  it('uses persisted profiles without row configuration and replaces a revoked connection explicitly', async () => {
    const value = fixture(true)
    await expect(value.call()).resolves.toMatchObject({ state: 'connected' })
    const old = value.pool.find(registration)
    if (!old) throw new Error('Missing connected runtime')
    value.bindingLifetime.abort()
    expect(old.snapshot().connection).toBe('disposed')
    const next = { ...registration, ip: '192.168.50.43', configRevision: 2 }
    value.connection.mockResolvedValue({
      ...value.profile(),
      profile: { ...value.profile().profile, ...next },
    })
    const nextLifetime = new AbortController()
    value.ctx.device.retain.mockImplementation(async () => ({
      binding: enrolled(),
      connection: await value.connection(),
      revoked: nextLifetime.signal,
      release: vi.fn(),
    }))
    await expect(value.call('connect', { configRevision: 2 })).resolves.toMatchObject({ state: 'connected' })
    expect(value.pool.find(registration)).toBeUndefined()
    expect(value.pool.find(next)?.snapshot().connection).toBe('connected')
    value.owner.abort()
    nextLifetime.abort()
  })

  it('rejects configuration changes during authorization before network I/O', async () => {
    const value = fixture(true)
    value.ctx.authorize.mockImplementation(async () => {
      value.connection.mockResolvedValue({
        ...value.profile(),
        profile: { ...value.profile().profile, configRevision: 2 },
      })
      return allow()
    })
    await expect(value.call()).rejects.toThrow('configuration changed')
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
    expect(value.owners.size).toBe(0)
  })

  it('reconnects the same saved endpoint in the old session after explicit re-enrollment', async () => {
    const value = fixture(true)
    await value.call()
    const old = value.pool.find(registration)!
    value.bindingLifetime.abort()
    expect(old.snapshot().connection).toBe('disposed')
    expect(value.owners.size).toBe(0)
    value.ctx.device.binding.mockResolvedValue({ ...enrolled(), bindingRevision: 3 })
    value.connection.mockResolvedValue({ ...value.profile(), bindingRevision: 3 })
    const nextLifetime = new AbortController()
    value.ctx.device.retain.mockImplementation(async () => ({
      binding: await value.ctx.device.binding(),
      connection: await value.connection(),
      revoked: nextLifetime.signal,
      release: vi.fn(),
    }))
    try {
      await expect(value.call()).resolves.toMatchObject({ state: 'connected' })
      expect(value.pool.find(registration)).not.toBe(old)
      expect(value.owners.get(id)).toMatchObject({ sessionId: 'device-chat', bindingRevision: 3 })
      expect(AkaControlChannel.prototype.timedMotion).not.toHaveBeenCalled()
      expect(AkaHttpDriver.prototype.setCamera).not.toHaveBeenCalled()
    } finally {
      nextLifetime.abort()
    }
  })

  it('retires a connection if persisted configuration changes while heartbeat is in flight', async () => {
    const value = fixture(true)
    const heartbeat = deferred<Awaited<ReturnType<AkaHttpDriver['heartbeat']>>>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValueOnce(heartbeat.promise)
    const pending = value.call().catch((error: unknown) => error)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
    const previous = value.pool.find(registration)
    value.connection.mockResolvedValue({
      ...value.profile(),
      profile: { ...value.profile().profile, configRevision: 2 },
    })
    heartbeat.resolve({
      service: 'AKA-00',
      identity: { macAddress: registration.macAddress, validity: 'reported' },
    })
    expect(await pending).toBeInstanceOf(Error)
    expect(previous?.snapshot().connection).toBe('disposed')
    expect(value.owners.size).toBe(0)
    expect(AkaControlChannel.prototype.open).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.cameraStatus).not.toHaveBeenCalled()
  })

  it.each(['missing', 'failed', 'wrong-identity'])(
    'refuses persisted %s metadata without using legacy row data',
    async (mode) => {
      const value = fixture()
      const context = {
        ...value.ctx,
        device: {
          ...value.ctx.device,
          connection: async () => {
            if (mode === 'failed') throw new Error('Metadata unavailable')
            return mode === 'missing'
              ? { ...value.profile(), profile: null }
              : { ...value.profile(), deviceId: '22222222-2222-4222-8222-222222222222' }
          },
        },
      }
      await expect(value.call('connect', { configRevision: 1 }, context)).rejects.toThrow()
      expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
      expect(value.ctx.authorize).not.toHaveBeenCalled()
    },
  )

  it('rejects a changed profile acquired by retain and releases it before network I/O', async () => {
    const value = fixture(true)
    const release = vi.fn()
    value.ctx.device.retain.mockResolvedValue({
      binding: enrolled(),
      revoked: value.bindingLifetime.signal,
      connection: {
        ...value.profile(),
        profile: { ...value.profile().profile, ip: '192.168.50.43', configRevision: 2 },
      },
      release,
    })
    await expect(value.call()).rejects.toThrow('configuration lifetime')
    expect(release).toHaveBeenCalledOnce()
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
  })

  it('does not reuse a legacy connection without a configuration-bearing lease on a newer host', async () => {
    const value = fixture()
    await value.call()
    const old = value.pool.find(registration)
    const context = { ...value.ctx, device: { ...value.ctx.device, connection: value.connection } }
    await expect(value.call('connect', { configRevision: 1 }, context)).rejects.toThrow(
      'configuration lifetime',
    )
    expect(old?.snapshot().connection).toBe('disposed')
    expect(value.owners.size).toBe(0)
    expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalledOnce()
  })

  it('requires a matching configuration-bearing retained lease before I/O', async () => {
    const value = fixture(true)
    const release = vi.fn()
    value.ctx.device.retain.mockResolvedValue({
      binding: enrolled(),
      connection: undefined,
      revoked: value.bindingLifetime.signal,
      release,
    })
    await expect(value.call()).rejects.toThrow('configuration lifetime')
    expect(release).toHaveBeenCalledOnce()
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
  })

  it('releases a retained lease that resolves after cancellation instead of orphaning it', async () => {
    const value = fixture(true)
    const release = vi.fn()
    const lease = deferred<Awaited<ReturnType<typeof value.ctx.device.retain>>>()
    value.ctx.device.retain.mockReturnValue(lease.promise)
    const pending = value.call()
    await vi.waitFor(() => expect(value.ctx.device.retain).toHaveBeenCalled())
    value.invocation.abort()
    await expect(pending).rejects.toThrow('cancelled')
    lease.resolve({
      binding: enrolled(),
      connection: value.profile(),
      revoked: value.bindingLifetime.signal,
      release,
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(value.owners.size).toBe(0)
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
  })

  it('opens one explicitly authorized camera stream, keeps it after invocation completion and revokes it with the binding', async () => {
    const value = fixture()
    await value.call()
    let streamSignal: AbortSignal | undefined
    vi.mocked(AkaHttpDriver.prototype.stream).mockImplementation((_fps, signal) => {
      streamSignal = signal
      return new Promise(() => {})
    })
    expect(value.services.get('aka.camera.set')?.kind).toBe('effect')
    const opened = deferred<boolean>()
    vi.mocked(AkaHttpDriver.prototype.setCamera).mockReturnValueOnce(opened.promise)
    const opening = value.call('camera.set', { configRevision: 1, open: true })
    await vi.waitFor(() =>
      expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledWith(true, expect.any(AbortSignal)),
    )
    expect(AkaHttpDriver.prototype.stream).not.toHaveBeenCalled()
    opened.resolve(true)
    await expect(opening).resolves.toMatchObject({
      state: 'opening',
      snapshot: { cameraOn: null, media: 'opening' },
    })
    expect(value.ctx.authorize).toHaveBeenLastCalledWith('execute', {
      kind: 'datasource',
      id: `aka/device/${id}/camera`,
    })
    await value.call('camera.set', { configRevision: 1, open: true })
    expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledOnce()
    expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledWith(true, expect.any(AbortSignal))
    expect(AkaHttpDriver.prototype.stream).toHaveBeenCalledTimes(1)
    expect(AkaHttpDriver.prototype.stream).toHaveBeenCalledWith(
      30,
      expect.any(AbortSignal),
      expect.any(Function),
    )
    value.invocation.abort()
    expect(streamSignal?.aborted).toBe(false)
    value.bindingLifetime.abort()
    expect(streamSignal?.aborted).toBe(true)
    expect(value.owners.size).toBe(0)
    expect(AkaHttpDriver.prototype.move).not.toHaveBeenCalled()
  })

  it('restores an ended camera stream on the retained connection without movement', async () => {
    const value = fixture(true)
    await value.call()
    const ended = deferred<void>()
    vi.mocked(AkaHttpDriver.prototype.stream)
      .mockImplementationOnce(() => ended.promise)
      .mockImplementation(() => new Promise(() => {}))
    await value.call('camera.set', { configRevision: 1, open: true })
    const runtime = value.pool.get(registration)
    const generation = runtime.snapshot().mediaGeneration
    ended.resolve()
    await vi.waitFor(() => expect(runtime.snapshot().media).toBe('error'))
    await expect(value.call()).resolves.toMatchObject({ state: 'connected' })
    await expect(value.call('camera.set', { configRevision: 1, open: true })).resolves.toMatchObject({
      state: 'opening',
      snapshot: { connection: 'connected', media: 'opening', frame: null },
    })
    expect(runtime.snapshot().mediaGeneration).toBeGreaterThan(generation)
    expect(value.pool.get(registration)).toBe(runtime)
    expect(AkaControlChannel.prototype.timedMotion).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.grip).not.toHaveBeenCalled()
  })
  it('serializes camera close with connection effects and discards frames arriving after close', async () => {
    const value = fixture()
    await value.call()
    let receive: Parameters<AkaHttpDriver['stream']>[2] | undefined
    vi.mocked(AkaHttpDriver.prototype.stream).mockImplementation((_fps, _signal, onFrame) => {
      receive = onFrame
      return new Promise(() => {})
    })
    await value.call('camera.set', { configRevision: 1, open: true })
    const runtime = value.pool.get(registration)
    const closed = deferred<boolean>()
    vi.mocked(AkaHttpDriver.prototype.setCamera).mockReturnValueOnce(closed.promise)
    const pending = value.call('camera.set', { configRevision: 1, open: false })
    await vi.waitFor(() =>
      expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledWith(false, expect.any(AbortSignal)),
    )
    await expect(value.call('camera.set', { configRevision: 1, open: true })).rejects.toThrow('busy')
    await expect(value.call('disconnect')).rejects.toThrow('busy')
    receive?.({ bytes: Buffer.alloc(0), width: 1, height: 1 })
    expect(runtime.latestFrame()).toBeNull()
    closed.resolve(false)
    await expect(pending).resolves.toMatchObject({
      state: 'closed',
      snapshot: { cameraOn: false, media: 'idle' },
    })
    expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    expect(AkaHttpDriver.prototype.stream).toHaveBeenCalledTimes(1)
  })

  it.each(['unconnected', 'denied', 'inactive', 'config', 'invalid-open', 'extra-input'])(
    'refuses camera %s before opening a stream',
    async (mode) => {
      const value = fixture()
      if (mode !== 'unconnected') await value.call()
      if (mode === 'denied') value.ctx.authorize.mockResolvedValue({ ...allow(), effect: 'deny' })
      if (mode === 'inactive') value.ctx.device.binding.mockResolvedValue({ ...enrolled(), active: false })
      const input =
        mode === 'extra-input'
          ? { configRevision: 1, open: true, ip: '192.168.1.2' }
          : { configRevision: mode === 'config' ? 2 : 1, open: mode === 'invalid-open' ? 'yes' : true }
      await expect(value.call('camera.set', input)).rejects.toThrow()
      expect(AkaHttpDriver.prototype.stream).not.toHaveBeenCalled()
      expect(AkaHttpDriver.prototype.setCamera).not.toHaveBeenCalled()
    },
  )

  it('retires a newly opened stream when the post-open binding check is cancelled and ignores its late result', async () => {
    const value = fixture()
    await value.call()
    let streamSignal: AbortSignal | undefined
    vi.mocked(AkaHttpDriver.prototype.stream).mockImplementation((_fps, signal) => {
      streamSignal = signal
      return new Promise(() => {})
    })
    const late = deferred<ReturnType<typeof enrolled>>()
    value.ctx.device.binding
      .mockResolvedValueOnce(enrolled())
      .mockResolvedValueOnce(enrolled())
      .mockReturnValueOnce(late.promise)
    const old = value.pool.get(registration)
    const pending = value
      .call('camera.set', { configRevision: 1, open: true })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.stream).toHaveBeenCalled())
    value.invocation.abort()
    expect(await pending).toBeInstanceOf(Error)
    expect(streamSignal?.aborted).toBe(true)
    expect(old.snapshot().connection).toBe('disposed')
    expect(value.owners.size).toBe(0)
    const replacement = value.pool.get(registration)
    late.resolve(enrolled())
    await Promise.resolve()
    expect(replacement.snapshot().connection).toBe('idle')
    expect(AkaHttpDriver.prototype.setCamera).toHaveBeenCalledWith(true, expect.any(AbortSignal))
  })

  it('ends a camera authorization wait on binding revocation before any camera IO', async () => {
    const value = fixture()
    await value.call()
    const approval = deferred<ReturnType<typeof allow>>()
    value.ctx.authorize.mockReturnValueOnce(approval.promise)
    const pending = value
      .call('camera.set', { configRevision: 1, open: true })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(value.ctx.authorize).toHaveBeenCalledTimes(2))
    value.bindingLifetime.abort()
    expect(await pending).toBeInstanceOf(Error)
    approval.resolve(allow())
    await Promise.resolve()
    expect(AkaHttpDriver.prototype.stream).not.toHaveBeenCalled()
  })

  it('preserves unknown hardware state and does not reopen media after a failed close', async () => {
    const value = fixture()
    await value.call()
    vi.mocked(AkaHttpDriver.prototype.stream).mockImplementation(() => new Promise(() => {}))
    await value.call('camera.set', { configRevision: 1, open: true })
    vi.mocked(AkaHttpDriver.prototype.setCamera).mockRejectedValueOnce(new Error('Lost close receipt'))
    await expect(value.call('camera.set', { configRevision: 1, open: false })).rejects.toThrow()
    expect(value.pool.get(registration).snapshot()).toMatchObject({
      connection: 'connected',
      cameraOn: null,
      media: 'idle',
    })
    expect(AkaHttpDriver.prototype.stream).toHaveBeenCalledTimes(1)
  })

  it('refuses sustained connection without a trusted lifetime port before native IO', async () => {
    const value = fixture()
    await expect(
      value.call(
        'connect',
        { configRevision: 1 },
        { ...value.ctx, device: { binding: value.ctx.device.binding } },
      ),
    ).rejects.toThrow('lifetime unavailable')
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
  })

  it('ends a pending connection on binding revocation without waiting for a late heartbeat', async () => {
    const value = fixture()
    const heartbeat = deferred<Awaited<ReturnType<AkaHttpDriver['heartbeat']>>>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValueOnce(heartbeat.promise)
    let failure: unknown
    const pending = value.call().catch((error: unknown) => {
      failure = error
    })
    try {
      await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
      const runtime = value.pool.get(registration)
      value.bindingLifetime.abort()
      await vi.waitFor(() => expect(failure).toBeDefined(), { timeout: 200 })
      expect(runtime.snapshot().connection).toBe('disposed')
      expect(value.owners.size).toBe(0)
    } finally {
      heartbeat.resolve({
        service: 'AKA-00',
        identity: { macAddress: registration.macAddress, validity: 'reported' },
      })
      await pending
    }
  })
  it('retires the actual runtime when the trusted binding lifetime is revoked after the invocation completed', async () => {
    const value = fixture()
    await value.call()
    const runtime = value.pool.get(registration)
    value.bindingLifetime.abort()
    expect(runtime.snapshot().connection).toBe('disposed')
    expect(value.owners.size).toBe(0)
    expect(value.pool.get(registration).snapshot().connection).toBe('idle')
  })
  it('opens one passive connection only after authorization and fresh binding; repeated connect does not replay IO', async () => {
    const value = fixture()
    expect(value.services.get('aka.connect')?.kind).toBe('effect')
    await expect(value.call()).resolves.toMatchObject({
      state: 'connected',
      snapshot: { connection: 'connected', cameraOn: false },
    })
    expect(value.ctx.authorize).toHaveBeenCalledWith('execute', {
      kind: 'datasource',
      id: `aka/device/${id}`,
    })
    await value.call()
    expect(AkaControlChannel.prototype.open).toHaveBeenCalledTimes(1)
    expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalledTimes(1)
    expect(AkaHttpDriver.prototype.stream).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.setCamera).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.move).not.toHaveBeenCalled()
    await expect(value.call('disconnect')).resolves.toMatchObject({
      state: 'disconnected',
      snapshot: { connection: 'idle' },
    })
    expect(value.owners.size).toBe(0)
  })

  it.each(['deny', 'require_approval'])(
    'refuses device-specific authorization %s before native IO',
    async (effect) => {
      const value = fixture()
      value.ctx.authorize.mockResolvedValue({ ...allow(), effect })
      await expect(value.call()).rejects.toThrow('authorization denied')
      expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
      expect(AkaControlChannel.prototype.open).not.toHaveBeenCalled()
    },
  )

  it.each(['ordinary', 'inactive', 'forged', 'config', 'extra-input'])(
    'refuses %s without native IO',
    async (mode) => {
      const value = fixture()
      const binding =
        mode === 'ordinary'
          ? null
          : {
              ...enrolled(),
              active: mode !== 'inactive',
              sessionId: mode === 'forged' ? 'another-chat' : 'device-chat',
            }
      const ctx = { ...value.ctx, device: { binding: async () => binding } }
      const input =
        mode === 'extra-input'
          ? { configRevision: 1, deviceId: id }
          : { configRevision: mode === 'config' ? 2 : 1 }
      await expect(value.call('connect', input, ctx)).rejects.toThrow()
      expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
    },
  )

  it('rechecks binding after asynchronous authorization and releases the operation lock on refusal', async () => {
    const value = fixture()
    const approval = deferred<ReturnType<typeof allow>>()
    value.ctx.authorize.mockReturnValueOnce(approval.promise)
    const pending = value.call()
    await Promise.resolve()
    await expect(value.call()).rejects.toThrow('busy')
    value.ctx.device.binding.mockResolvedValue({ ...enrolled(), bindingRevision: 2 })
    approval.resolve(allow())
    await expect(pending).rejects.toThrow('binding changed')
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
    value.ctx.device.binding.mockResolvedValue(enrolled())
    await expect(value.call()).resolves.toMatchObject({ state: 'connected' })
  })

  it('refuses a binding changed during heartbeat before camera status or WS and disposes the partial runtime', async () => {
    const value = fixture()
    const heartbeat = deferred<Awaited<ReturnType<AkaHttpDriver['heartbeat']>>>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValueOnce(heartbeat.promise)
    const pending = value.call()
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
    value.ctx.device.binding.mockResolvedValue({ ...enrolled(), active: false })
    heartbeat.resolve({
      service: 'AKA-00',
      identity: { macAddress: registration.macAddress, validity: 'reported' },
    })
    await expect(pending).rejects.toThrow('binding changed')
    expect(AkaHttpDriver.prototype.cameraStatus).not.toHaveBeenCalled()
    expect(AkaControlChannel.prototype.open).not.toHaveBeenCalled()
    expect(value.pool.get(registration).snapshot().connection).toBe('idle')
    expect(value.owners.size).toBe(0)
  })

  it('replaces an older workspace revision without sharing its live connection', async () => {
    const value = fixture()
    await value.call()
    const old = value.pool.get(registration)
    value.ctx.device.binding.mockResolvedValue({ ...enrolled(), bindingRevision: 2 })
    await value.call()
    expect(old.snapshot().connection).toBe('disposed')
    expect(value.pool.get(registration)).not.toBe(old)
    expect(value.owners.get(id)?.bindingRevision).toBe(2)
  })

  it.each(['authorization', 'binding'])(
    'cancels a pending %s check and permits a new operation before its late result',
    async (stage) => {
      const value = fixture()
      const approval = deferred<ReturnType<typeof allow>>()
      const binding = deferred<ReturnType<typeof enrolled>>()
      if (stage === 'authorization') value.ctx.authorize.mockReturnValueOnce(approval.promise)
      else value.ctx.device.binding.mockResolvedValueOnce(enrolled()).mockReturnValueOnce(binding.promise)
      let failure: unknown
      const pending = value.call().catch((error: unknown) => {
        failure = error
      })
      try {
        await vi.waitFor(() => expect(value.ctx.authorize).toHaveBeenCalled())
        if (stage === 'binding')
          await vi.waitFor(() => expect(value.ctx.device.binding).toHaveBeenCalledTimes(2))
        value.invocation.abort()
        await vi.waitFor(() => expect(failure).toBeInstanceOf(Error), { timeout: 200 })
        expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
        const replacement = new AbortController()
        await expect(
          value.call('connect', { configRevision: 1 }, { ...value.ctx, signal: replacement.signal }),
        ).resolves.toMatchObject({ state: 'connected' })
        const runtime = value.pool.get(registration)
        approval.resolve(allow())
        binding.resolve(enrolled())
        await pending
        await Promise.resolve()
        expect(value.pool.get(registration)).toBe(runtime)
        expect(runtime.snapshot().connection).toBe('connected')
        expect(value.owners.get(id)?.bindingRevision).toBe(1)
      } finally {
        approval.resolve(allow())
        binding.resolve(enrolled())
        await pending
      }
    },
  )

  it('rejects a channel lost before connection completion without claiming ownership', async () => {
    const value = fixture()
    vi.mocked(AkaControlChannel.prototype.open).mockImplementationOnce(async function (
      this: AkaControlChannel,
    ) {
      this.close()
    })
    await expect(value.call()).rejects.toThrow()
    expect(value.owners.size).toBe(0)
    expect(value.pool.get(registration).snapshot().connection).toBe('idle')
  })

  it('retires a cancelled partial runtime before a new connection and ignores the old heartbeat', async () => {
    const value = fixture()
    const heartbeat = deferred<Awaited<ReturnType<AkaHttpDriver['heartbeat']>>>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValueOnce(heartbeat.promise)
    const pending = value.call().catch((error: unknown) => error)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
    const old = value.pool.get(registration)
    value.invocation.abort()
    expect(await pending).toBeInstanceOf(Error)
    expect(old.snapshot().connection).toBe('disposed')
    const replacement = new AbortController()
    await expect(
      value.call('connect', { configRevision: 1 }, { ...value.ctx, signal: replacement.signal }),
    ).resolves.toMatchObject({ state: 'connected' })
    const current = value.pool.get(registration)
    heartbeat.resolve({
      service: 'AKA-00',
      identity: { macAddress: registration.macAddress, validity: 'reported' },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(value.pool.get(registration)).toBe(current)
    expect(current.snapshot().connection).toBe('connected')
    expect(value.owners.get(id)?.bindingRevision).toBe(1)
  })
})

describe('AKA manual and model control through the connected device', () => {
  const input = { bindingRevision: 1, configRevision: 1, action: 'up', speed: 30, milliseconds: 500 }
  const control = (
    v: ReturnType<typeof fixture>,
    params: Record<string, unknown> = input,
    context: unknown = v.ctx,
  ) => {
    const service = v.services.get(params.action === 'stop' ? 'aka.control.stop' : 'aka.control.action')
    if (!service) throw new Error('Missing control service')
    return service.handler(params as never, context as ServiceContext)
  }
  it('waits for the device-owned finite movement before independent stop, without claiming measured completion', async () => {
    const v = fixture(true)
    await v.call()
    await expect(control(v)).resolves.toMatchObject({
      action: 'up',
      state: 'completed',
      stop: 'completed',
      physicalResult: 'unverified',
    })
    expect(AkaHttpDriver.prototype.move).toHaveBeenCalledWith(
      { action: 'up', mode: 'time', speed: 30, milliseconds: 500 },
      expect.objectContaining({ maxSpeed: 50, maxMilliseconds: 3000 }),
      expect.any(AbortSignal),
    )
    expect(AkaHttpDriver.prototype.stop).toHaveBeenCalledOnce()
    expect(AkaControlChannel.prototype.stopMotion).toHaveBeenCalledOnce()
    expect(AkaControlChannel.prototype.timedMotion).not.toHaveBeenCalled()
    expect(v.pool.find(registration)?.snapshot().control.phase).toBe('idle')
  })
  it('runs the model grip tool with an accepted arm receipt and prevents movement during its settling interval', async () => {
    const v = fixture(true)
    await v.call()
    const tool = v.tools.get('aka_control')
    if (!tool) throw new Error('Missing model tool')
    vi.mocked(AkaHttpDriver.prototype.grip).mockResolvedValueOnce({ state: 'acknowledged' })
    const pending = tool.execute({ action: 'grab', speed: 30, milliseconds: 500 } as never, v.ctx as never)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.grip).toHaveBeenCalled())
    expect(v.pool.find(registration)?.snapshot().control.phase).toBe('gripping')
    await expect(control(v, { ...input, action: 'up' })).rejects.toThrow()
    await expect(pending).resolves.toMatchObject({
      structured: { action: 'grab', state: 'acknowledged', physicalResult: 'unverified' },
    })
    expect(AkaControlChannel.prototype.timedMotion).not.toHaveBeenCalled()
  }, 10000)
  it('blocks an uncertain movement until its request ends and a later explicit stop succeeds', async () => {
    const v = fixture(true)
    await v.call()
    const reply = deferred<{ state: 'completed' }>()
    vi.mocked(AkaHttpDriver.prototype.move).mockReturnValueOnce(reply.promise)
    const moving = control(v).catch((error: unknown) => error)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.move).toHaveBeenCalledOnce())
    expect(v.busy.has(id)).toBe(true)
    await expect(control(v, { ...input, action: 'stop' })).resolves.toMatchObject({
      state: 'completed',
      physicalResult: 'unverified',
    })
    expect(AkaHttpDriver.prototype.stop).toHaveBeenCalledOnce()
    reply.resolve({ state: 'completed' })
    expect(await moving).toBeInstanceOf(Error)
    await expect(control(v)).rejects.toThrow()
    expect(AkaHttpDriver.prototype.move).toHaveBeenCalledOnce()
    vi.mocked(AkaHttpDriver.prototype.stop).mockResolvedValueOnce({ state: 'unknown' })
    await expect(control(v, { ...input, action: 'stop' })).rejects.toThrow()
    await expect(control(v)).rejects.toThrow()
    await expect(control(v, { ...input, action: 'stop' })).resolves.toMatchObject({ state: 'completed' })
    expect(v.pool.find(registration)?.snapshot().control.phase).toBe('idle')
    await expect(control(v, { ...input, action: 'left', milliseconds: 300 })).resolves.toMatchObject({
      action: 'left',
      state: 'completed',
      physicalResult: 'unverified',
    })
    expect(AkaHttpDriver.prototype.move).toHaveBeenLastCalledWith(
      { action: 'left', mode: 'time', speed: 30, milliseconds: 300 },
      expect.anything(),
      expect.any(AbortSignal),
    )
  })
  it.each([
    'unconnected',
    'other-session',
    'denied',
    'speed',
    'speed-too-low',
    'duration',
    'duration-too-short',
    'turn-too-short',
    'extra',
    'binding',
    'configuration',
  ])('refuses %s before movement or gripping', async (mode) => {
    const v = fixture(true)
    if (mode !== 'unconnected') await v.call()
    const request = { ...input } as Record<string, unknown>
    let context: unknown = v.ctx
    if (mode === 'other-session') {
      context = {
        ...v.ctx,
        session: { key: 'other' },
        device: { ...v.ctx.device, binding: async () => ({ ...enrolled(), sessionId: 'other' }) },
      }
    }
    if (mode === 'denied') v.ctx.authorize.mockResolvedValue({ ...allow(), effect: 'deny' })
    if (mode === 'speed') request.speed = 51
    if (mode === 'speed-too-low') request.speed = 29
    if (mode === 'duration') request.milliseconds = 0
    if (mode === 'duration-too-short') request.milliseconds = 499
    if (mode === 'turn-too-short') {
      request.action = 'left'
      request.milliseconds = 299
    }
    if (mode === 'extra') request.maxSpeed = 100
    if (mode === 'binding') request.bindingRevision = 2
    if (mode === 'configuration') request.configRevision = 2
    await expect(control(v, request, context)).rejects.toThrow()
    expect(AkaControlChannel.prototype.timedMotion).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.move).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.grip).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.stop).not.toHaveBeenCalled()
  })
  it('marks failed grip as unresolved and does not treat motor stop as arm cancellation', async () => {
    const v = fixture(true)
    await v.call()
    vi.mocked(AkaHttpDriver.prototype.grip).mockResolvedValueOnce({ state: 'unknown' })
    await expect(control(v, { ...input, action: 'grab' })).rejects.toThrow()
    await expect(control(v, { ...input, action: 'stop' })).resolves.toMatchObject({
      physicalResult: 'unverified',
    })
    await expect(control(v, { ...input, action: 'release' })).rejects.toThrow()
    expect(AkaHttpDriver.prototype.grip).toHaveBeenCalledOnce()
  })
})

it('reads and saves robot settings through the connected session and refuses mismatched arm drivers', async () => {
  const v = fixture()
  const settings = {
    speed: { forward_speed: 50, turn_speed: 40 },
    arm: {
      driver: 'zp10s' as const,
      angles: {
        grab_position: { servo0: 245, servo1: 180 },
        lift_position: { servo0: 200, servo1: 180 },
        gripper_open: 150,
        gripper_close: 90,
      },
    },
  }
  const read = vi.spyOn(AkaHttpDriver.prototype, 'readSettings').mockResolvedValue(settings)
  const save = vi.spyOn(AkaHttpDriver.prototype, 'saveSettings').mockImplementation(async (value) => value)
  await v.call()
  const input = { bindingRevision: 1, configRevision: 1 }
  await expect(v.call('settings.read', input)).resolves.toMatchObject({ deviceId: id, settings })
  const next = { ...settings, speed: { forward_speed: 30, turn_speed: 20 } }
  await expect(v.call('settings.save', { ...input, kind: 'speed', settings: next })).resolves.toMatchObject({
    settings: next,
  })
  expect(save).toHaveBeenCalledWith(next, 'speed', expect.any(AbortSignal))
  await expect(
    v.call('settings.save', {
      ...input,
      kind: 'arm',
      settings: {
        ...settings,
        arm: {
          driver: 'sts3215',
          angles: {
            grab_position: { servo1: 1850, servo2: 2650 },
            lift_position: { servo1: 2300, servo2: 2100 },
            gripper_open: 4000,
            gripper_close: 3000,
          },
        },
      },
    }),
  ).rejects.toThrow('Arm driver changed')
  expect(save).toHaveBeenCalledOnce()
  v.ctx.device.binding.mockResolvedValue({ ...enrolled(), sessionId: 'another-chat' })
  await expect(v.call('settings.read', input)).rejects.toThrow()
  expect(read).toHaveBeenCalledTimes(3)
})
