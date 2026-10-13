import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConnectionServices } from '../src/connection-services.js'
import { AkaHttpDriver } from '../src/http-driver.js'
import { registerPairingService } from '../src/pairing-service.js'
import { AkaRuntimePool } from '../src/runtime.js'

const deviceId = '11111111-1111-4111-8111-111111111111'
const binding = () => ({
  sessionId: 'device',
  workspaceId: 'a'.repeat(64),
  deviceId,
  bindingRevision: 1,
  active: true,
})
const profile = () => ({ deviceId, bindingRevision: 1, profile: null })
const input = { ip: '192.168.50.42', port: 80, bindingRevision: 1, expectedConfigRevision: 0 }
const identity = {
  service: 'AKA-00' as const,
  identity: { macAddress: '12:34:56:78:90:ab', validity: 'reported' as const },
}
const held: AbortController[] = []
beforeEach(() => {
  vi.spyOn(AkaHttpDriver.prototype, 'heartbeat').mockResolvedValue(identity)
  vi.spyOn(AkaHttpDriver.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unexpected camera')
  })
  vi.spyOn(AkaHttpDriver.prototype, 'cameraStatus').mockRejectedValue(new Error('Unexpected camera'))
  vi.spyOn(AkaHttpDriver.prototype, 'move').mockRejectedValue(new Error('Unexpected motor'))
})
afterEach(() => {
  for (const owner of held.splice(0)) owner.abort()
  vi.restoreAllMocks()
})
function fixture(configured = false) {
  const owner = new AbortController()
  const invocation = new AbortController()
  const retained = new AbortController()
  held.push(owner)
  const release = vi.fn()
  const busy = new Set<string>()
  const connection = () => ({
    ...profile(),
    profile: configured
      ? {
          driver: 'aka-00' as const,
          ip: input.ip,
          port: input.port,
          macAddress: identity.identity.macAddress,
          configRevision: 1,
        }
      : null,
  })
  const services = new Map<string, ServiceDef>()
  const register = (def: ServiceDef) => services.set(def.name, def)
  registerPairingService(register, { lifetime: owner.signal, busy })
  registerConnectionServices(register, {
    lifetime: owner.signal,
    busy,
    pool: new AkaRuntimePool(owner.signal),
    registrations: new Map(),
    owners: new Map(),
  })
  const ctx = {
    session: { key: 'device' },
    signal: invocation.signal,
    device: {
      binding: vi.fn(async () => binding()),
      connection: vi.fn(async () => connection()),
      retain: vi.fn(async () => ({
        binding: binding(),
        connection: connection(),
        revoked: retained.signal,
        release,
      })),
    },
    authorize: vi.fn(async () => ({ decisionId: 'test', effect: 'allow', reason: 'test' })),
  }
  const call = (
    request: unknown = { ...input, expectedConfigRevision: configured ? 1 : 0 },
    context: unknown = ctx,
    name = 'aka.probe',
  ) => {
    const service = services.get(name)
    if (!service) throw new Error('Missing service')
    return service.handler(request as Parameters<ServiceDef['handler']>[0], context as ServiceContext)
  }
  return { owner, invocation, retained, release, busy, ctx, services, call }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AKA finite pairing probe', () => {
  it('returns the reported identity and current save revisions without opening camera or writing configuration', async () => {
    const value = fixture()
    expect(value.services.get('aka.probe')?.kind).toBe('effect')
    await expect(value.call()).resolves.toEqual({
      ...input,
      deviceId,
      macAddress: identity.identity.macAddress,
      identity: 'reported',
    })
    expect(value.ctx.authorize).toHaveBeenCalledWith('execute', {
      kind: 'datasource',
      id: `aka/device/${deviceId}/pairing`,
    })
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.busy.size).toBe(0)
    expect(AkaHttpDriver.prototype.stream).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.cameraStatus).not.toHaveBeenCalled()
    expect(AkaHttpDriver.prototype.move).not.toHaveBeenCalled()
  })

  it.each([
    'public',
    'loopback',
    'noncanonical',
    'port',
    'extra',
    'revision',
    'config',
    'ordinary',
    'denied',
    'old-host',
  ])('refuses %s before device I/O', async (mode) => {
    const value = fixture()
    let request: unknown = input
    let context: unknown = value.ctx
    if (mode === 'public') request = { ...input, ip: '8.8.8.8' }
    if (mode === 'loopback') request = { ...input, ip: '127.0.0.1' }
    if (mode === 'noncanonical') request = { ...input, ip: '192.168.050.42' }
    if (mode === 'port') request = { ...input, port: 0 }
    if (mode === 'extra') request = { ...input, sessionId: 'other' }
    if (mode === 'revision') request = { ...input, bindingRevision: 2 }
    if (mode === 'config') request = { ...input, expectedConfigRevision: 1 }
    if (mode === 'ordinary')
      context = { ...value.ctx, device: { ...value.ctx.device, binding: async () => null } }
    if (mode === 'denied')
      value.ctx.authorize.mockResolvedValue({ decisionId: 'test', effect: 'deny', reason: 'test' })
    if (mode === 'old-host') context = { ...value.ctx, device: { binding: value.ctx.device.binding } }
    await expect(value.call(request, context)).rejects.toThrow()
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
    expect(value.busy.size).toBe(0)
  })

  it('does not manufacture a MAC when the device identity is unavailable', async () => {
    const value = fixture()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockResolvedValue({
      service: 'AKA-00',
      identity: { macAddress: null, validity: 'unknown' },
    })
    await expect(value.call()).rejects.toThrow('identity unavailable')
    expect(value.release).toHaveBeenCalledOnce()
  })

  it('refuses a newly saved profile after authorization without probing the old request', async () => {
    const value = fixture()
    value.ctx.authorize.mockImplementation(async () => {
      value.ctx.device.connection.mockResolvedValue({
        ...profile(),
        profile: {
          driver: 'aka-00',
          ip: input.ip,
          port: input.port,
          macAddress: identity.identity.macAddress,
          configRevision: 1,
        },
      })
      return { decisionId: 'test', effect: 'allow', reason: 'test' }
    })
    await expect(value.call()).rejects.toThrow('configuration changed')
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.busy.size).toBe(0)
  })

  it('rejects configuration changing during probe I/O even before a revocation notification', async () => {
    const value = fixture(true)
    const heartbeat = deferred<typeof identity>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValue(heartbeat.promise)
    const pending = value.call().catch((error: unknown) => error)
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
    value.ctx.device.connection.mockResolvedValue({
      ...profile(),
      profile: {
        driver: 'aka-00',
        ip: input.ip,
        port: input.port,
        macAddress: identity.identity.macAddress,
        configRevision: 2,
      },
    })
    heartbeat.resolve(identity)
    expect(await pending).toBeInstanceOf(Error)
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.busy.size).toBe(0)
  })

  it.each(['revoked', 'switched', 'cancelled'])(
    'rejects a late heartbeat after %s and releases the lease',
    async (mode) => {
      const value = fixture()
      const heartbeat = deferred<typeof identity>()
      vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValue(heartbeat.promise)
      const pending = value.call().catch((error: unknown) => error)
      await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
      if (mode === 'revoked') value.retained.abort()
      if (mode === 'cancelled') value.invocation.abort()
      if (mode === 'switched')
        value.ctx.device.binding.mockResolvedValue({ ...binding(), bindingRevision: 2 })
      heartbeat.resolve(identity)
      expect(await pending).toBeInstanceOf(Error)
      expect(value.release).toHaveBeenCalledOnce()
      expect(value.busy.size).toBe(0)
    },
  )

  it('shares the per-device connection lock while probe I/O is pending', async () => {
    const value = fixture(true)
    const heartbeat = deferred<typeof identity>()
    vi.mocked(AkaHttpDriver.prototype.heartbeat).mockReturnValue(heartbeat.promise)
    const pending = value.call()
    await vi.waitFor(() => expect(AkaHttpDriver.prototype.heartbeat).toHaveBeenCalled())
    await expect(value.call()).rejects.toThrow('busy')
    await expect(value.call({ configRevision: 1 }, value.ctx, 'aka.connect')).rejects.toThrow('busy')
    heartbeat.resolve(identity)
    await pending
    expect(value.busy.size).toBe(0)
  })

  it('releases a configuration lease resolving after cancellation and performs no heartbeat', async () => {
    const value = fixture()
    const lease = deferred<Awaited<ReturnType<typeof value.ctx.device.retain>>>()
    value.ctx.device.retain.mockReturnValue(lease.promise)
    const pending = value.call().catch((error: unknown) => error)
    await vi.waitFor(() => expect(value.ctx.device.retain).toHaveBeenCalled())
    value.invocation.abort()
    expect(await pending).toBeInstanceOf(Error)
    lease.resolve({
      binding: binding(),
      connection: profile(),
      revoked: value.retained.signal,
      release: value.release,
    })
    await vi.waitFor(() => expect(value.release).toHaveBeenCalledOnce())
    expect(AkaHttpDriver.prototype.heartbeat).not.toHaveBeenCalled()
  })
})
