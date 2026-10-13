import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import type { PluginExtensionAPI, ServiceContext, ServiceDef } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { registerMediaService } from '../src/media-service.js'
import type { AkaRuntime, AkaRuntimePool, RuntimeSnapshot } from '../src/runtime.js'

const id = '11111111-1111-4111-8111-111111111111'
const registration = {
  deviceId: id,
  ip: '192.168.50.42',
  port: 80,
  macAddress: '12:34:56:78:90:ab',
  configRevision: 1,
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 0, 0xff, 0xd9])
const ownersToClose: AbortController[] = []
afterEach(() => {
  for (const owner of ownersToClose.splice(0)) owner.abort()
})
function fixture() {
  const lifetime = new AbortController()
  const retained = new AbortController()
  const registrationLife = new AbortController()
  ownersToClose.push(lifetime)
  const invocation = new AbortController()
  const snapshot: RuntimeSnapshot = {
    instanceId: 'fixture-runtime',
    connection: 'connected',
    generation: 1,
    mediaGeneration: 1,
    identity: 'matched',
    cameraOn: true,
    media: 'streaming',
    motor: { connected: true, state: 'connected' },
    wheels: null,
    frame: null,
    error: null,
    control: { phase: 'idle', lastStop: null },
  }
  const runtime = {
    snapshot: () => Object.freeze({ ...snapshot }),
    latestFrame: () => ({
      id: 'frame-1',
      bytes: jpeg,
      width: 3,
      height: 2,
      receivedAt: performance.now(),
      timeBasis: 'bridge_receive',
    }),
  } as unknown as AkaRuntime
  let endpoint: { port: number; authorization: string } | undefined
  const bind = vi.fn((value: { port: number; authorization: string }) => {
    endpoint = value
    return {
      rowRevision: 'fixture-row',
      registrationId: 'fixture-registration',
      revoked: registrationLife.signal,
      release() {
        registrationLife.abort()
      },
    }
  })
  const api = {
    ctx: { signal: lifetime.signal },
    deviceMedia: { register: bind },
  } as unknown as PluginExtensionAPI
  const owner = {
    workspaceId: 'a'.repeat(64),
    bindingRevision: 1,
    registration,
    source: 'persisted' as const,
    revoked: retained.signal,
  }
  const owners = new Map([[id, owner]])
  const binding = {
    sessionId: 'device-chat',
    workspaceId: owner.workspaceId,
    deviceId: id,
    bindingRevision: 1,
    active: true,
  }
  const lookup = vi.fn(async () => binding)
  const connection = vi.fn(async () => ({
    deviceId: id,
    bindingRevision: 1,
    profile: { driver: 'aka-00' as const, ...registration },
  }))
  const authorize = vi.fn(async () => ({ effect: 'allow' as const }))
  const ctx = {
    session: { key: binding.sessionId },
    device: { binding: lookup, connection },
    signal: invocation.signal,
    authorize,
  } as unknown as ServiceContext
  let service: ServiceDef | undefined
  registerMediaService(
    (value) => {
      service = value
    },
    {
      api,
      pool: { find: () => runtime } as unknown as AkaRuntimePool,
      owners,
      registrations: new Map(),
    },
  )
  if (!service) throw new Error('Media service not registered')
  return {
    ctx,
    lookup,
    connection,
    authorize,
    invocation,
    retained,
    lifetime,
    registrationLife,
    snapshot,
    owners,
    bind,
    api,
    service,
    endpoint: () => endpoint,
    call: (params: Record<string, unknown> = { bindingRevision: 1, configRevision: 1 }) =>
      service.handler(params, ctx),
  }
}

describe('registered AKA media ticket admission with real loopback WS', () => {
  it('issues no endpoint credential, retains media after invocation ends, and revokes on config lease loss', async () => {
    const value = fixture()
    value.snapshot.control = { phase: 'moving', lastStop: null }
    const result = (await value.call()) as { ticket: string; expiresInMs: number; deviceId: string }
    const endpoint = value.endpoint()
    if (!endpoint) throw new Error('No internal endpoint')
    expect(value.service.kind).toBe('query')
    expect(result).toMatchObject({ deviceId: id, expiresInMs: 30_000 })
    expect(JSON.stringify(result)).not.toContain(endpoint.authorization)
    expect(value.authorize).toHaveBeenCalledWith('select', {
      kind: 'datasource',
      id: `aka/device/${id}/media`,
    })
    value.invocation.abort()
    const client = new WebSocket(`ws://127.0.0.1:${endpoint.port}/media`, {
      headers: { Authorization: endpoint.authorization },
    })
    client.on('error', () => {})
    try {
      await once(client, 'open')
      const authorized = once(client, 'message')
      client.send(JSON.stringify({ type: 'auth', ticket: result.ticket }))
      expect(JSON.parse((await authorized)[0].toString()).type).toBe('authorized')
      const closed = once(client, 'close')
      value.retained.abort()
      await closed
    } finally {
      client.terminate()
    }
  })

  it.each(['ordinary', 'inactive', 'revision', 'no-owner', 'revoked', 'camera-off', 'denied'] as const)(
    'refuses %s before starting a media endpoint',
    async (mode) => {
      const value = fixture()
      if (mode === 'ordinary') value.lookup.mockResolvedValue(null as never)
      if (mode === 'inactive') value.lookup.mockResolvedValue({ ...(await value.lookup()), active: false })
      if (mode === 'no-owner') value.owners.clear()
      if (mode === 'revoked') value.retained.abort()
      if (mode === 'camera-off') value.snapshot.media = 'idle'
      if (mode === 'denied') value.authorize.mockResolvedValue({ effect: 'deny' } as never)
      await expect(
        value.call({ bindingRevision: mode === 'revision' ? 2 : 1, configRevision: 1 }),
      ).rejects.toThrow()
      expect(value.bind).not.toHaveBeenCalled()
      expect(value.endpoint()).toBeUndefined()
    },
  )

  it('refuses camera epoch changes during private registration', async () => {
    const value = fixture()
    const actual = value.bind.getMockImplementation()
    value.bind.mockImplementation((endpoint) => {
      value.snapshot.mediaGeneration++
      if (!actual) throw new Error('No registration fixture')
      return actual(endpoint)
    })
    await expect(value.call()).rejects.toThrow('retired')
  })

  it('refuses changed configuration after read authorization and old hosts without registration', async () => {
    const value = fixture()
    value.authorize.mockImplementation(async () => {
      value.connection.mockResolvedValue({
        deviceId: id,
        bindingRevision: 1,
        profile: { driver: 'aka-00', ...registration, configRevision: 2 },
      })
      return { effect: 'allow' }
    })
    await expect(value.call()).rejects.toThrow('configuration changed')
    expect(value.bind).not.toHaveBeenCalled()
    const older = fixture()
    delete (older.api as { deviceMedia?: unknown }).deviceMedia
    await expect(older.call()).rejects.toThrow('registration unavailable')
    expect(older.bind).not.toHaveBeenCalled()
  })
})
