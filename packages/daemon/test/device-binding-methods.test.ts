import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CredentialStore,
  createCredentialStore,
  readDeviceRecognitionCredential,
  readDeviceRecognitionToken,
} from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerDeviceBindings } from '../src/local/methods/device-bindings.js'
import { saveDeviceRecognition } from '../src/local/methods/device-recognition-save.js'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { readWorkerDeviceSession } from '../src/supervisor/device-session-read.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const request = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

async function setup(recognitionCredentials?: CredentialStore) {
  const tables = sqliteTables()
  cleanup.push(() => tables.close())
  const changes: Array<{ revision: number; active: boolean }> = []
  const store = new DeviceBindingIndex(tables.table('devices'), (binding) => changes.push(binding))
  const owners = new MemorySessionPrincipalOwnership()
  let available = true
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    async (path) => {
      if (!available) throw rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_STALE' })
      return { path, name: 'repo' }
    },
    () => 0,
  )
  await workspaces.add('/repo/a')
  for (const [id, owner] of [
    ['a', 'owner'],
    ['b', 'owner'],
    ['foreign', 'other'],
    ['pending', 'owner'],
  ] as const) {
    await workspaces.authorizeAndBind(id, '/repo/a')
    owners.bindNew(id, owner)
    if (id !== 'pending') owners.activateNew(id, owner)
  }
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'owner' })
  cleanup.push(() => ep.close())
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const deps = {
    recognitionCredentials,
    store,
    workspaces: { restoreBinding: (id: string) => workspaces.restoreBinding(id) },
    requireSessionOwner: (_method: string, id: string) => {
      if (owners.resolve(id)?.principalId !== ep.conn.principalId) throw rpcError('CAPABILITY_DENIED')
    },
  }
  registerDeviceBindings(ep, deps)
  return {
    ep,
    store,
    changes,
    owners,
    workspaces,
    deps,
    disappear: () => {
      available = false
    },
  }
}

describe('device binding RPC', () => {
  it.each([false, true])(
    'explicitly configures an old session without reactivating other old sessions (fresh=%s)',
    async (replaceInactiveDevice) => {
      const { ep, store, workspaces, changes } = await setup()
      const bind = (id: number, sessionId: string, expectedRevision: number) =>
        ep.handle(
          request(id, '_agnes/v1/device.session.bind', {
            sessionId,
            expectedRevision,
            ...(id >= 4 ? { replaceInactiveDevice } : {}),
          }),
        )
      await bind(1, 'a', 0)
      await bind(2, 'b', 1)
      const authority = await workspaces.restoreBinding('a')
      const original = store.session('a')!.deviceId
      store.saveConnection(authority, {
        sessionId: 'a',
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        ip: '192.168.50.42',
        port: 80,
        macAddress: '12:34:56:78:90:ab',
      })
      store.recognition.save(authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        settings: {
          provider: 'local-yolo',
          frequency: 2,
          requestBudget: 100,
          baseUrl: 'http://127.0.0.1:8000/',
          credentialRef: null,
        },
      })
      await ep.handle(request(3, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 }))
      expect(await bind(4, 'a', 1)).toMatchObject({ error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } })
      expect(await bind(5, 'a', 2)).toMatchObject({
        result: {
          workspace: { active: true, revision: 3 },
          session: { sessionId: 'a', active: true, bindingRevision: 3 },
        },
      })
      const configuredDevice = store.session('a')?.deviceId
      // Lost reply retry is idempotent; it does not create a different device or increment again.
      expect(await bind(6, 'a', 2)).toMatchObject({
        result: { session: { deviceId: configuredDevice, active: true, bindingRevision: 3 } },
      })
      if (replaceInactiveDevice) {
        expect(configuredDevice).not.toBe(original)
        expect(store.connection(authority).profile).toBeNull()
        expect(store.recognition.read(authority)).toMatchObject({ configRevision: 0, settings: null })
      } else {
        expect(configuredDevice).toBe(original)
        expect(store.connection(authority).profile).toMatchObject({ ip: '192.168.50.42', configRevision: 1 })
        expect(store.recognition.read(authority)).toMatchObject({
          bindingRevision: 3,
          configRevision: 1,
          settings: { provider: 'local-yolo' },
        })
      }
      expect(await ep.handle(request(7, '_agnes/v1/device.session.get', { sessionId: 'b' }))).toMatchObject({
        result: { session: { active: false, bindingRevision: 1 } },
      })
      // The other historical session joins only through its own explicit request.
      expect(await bind(8, 'b', 3)).toMatchObject(
        replaceInactiveDevice
          ? { error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } }
          : { result: { session: { active: true, deviceId: original, bindingRevision: 3 } } },
      )
      expect(changes.map((value) => value.revision)).toEqual([1, 2, 3])
    },
  )
  it('rechecks ownership after workspace lookup before disclosing recognition configuration', async () => {
    const { ep, deps } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    const original = deps.workspaces.restoreBinding
    deps.workspaces.restoreBinding = async (id) => {
      const restored = await original(id)
      deps.requireSessionOwner = () => {
        throw rpcError('CAPABILITY_DENIED')
      }
      return restored
    }
    expect(await ep.handle(request(2, '_agnes/v1/device.recognition.get', { sessionId: 'a' }))).toMatchObject(
      { error: { data: { code: 'CAPABILITY_DENIED' } } },
    )
  })

  it('returns only the current owner device recognition view and refuses ordinary/history/foreign access', async () => {
    const { ep, store, workspaces } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    const authority = await workspaces.restoreBinding('a')
    const binding = store.resolve(authority)
    store.recognition.save(authority, {
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      settings: {
        provider: 'aliyun',
        frequency: 2,
        requestBudget: 3600,
        credentialRef: `secret://aka-robot/device-${binding.deviceId}-00000000-0000-4000-8000-000000000001`,
      },
    })
    const result = await ep.handle(request(2, '_agnes/v1/device.recognition.get', { sessionId: 'a' }))
    expect(result).toMatchObject({
      result: {
        deviceId: binding.deviceId,
        bindingRevision: 1,
        configRevision: 1,
        settings: { provider: 'aliyun', frequency: 2, requestBudget: 3600, credentialConfigured: true },
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret://')
    for (const sessionId of ['b', 'foreign', 'pending'])
      expect(await ep.handle(request(3, '_agnes/v1/device.recognition.get', { sessionId }))).toHaveProperty(
        'error',
      )
    await ep.handle(request(4, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 }))
    expect(await ep.handle(request(5, '_agnes/v1/device.recognition.get', { sessionId: 'a' }))).toMatchObject(
      { error: { data: { code: 'DEVICE_RECOGNITION_CONFLICT', reason: 'inactive' } } },
    )
  })

  it('does not permit recognition view reads from a remote credential or accept arbitrary device selectors', async () => {
    const { ep } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    expect(
      await ep.handle(request(2, '_agnes/v1/device.recognition.get', { sessionId: 'a', deviceId: 'other' })),
    ).toHaveProperty('error')
    ep.conn.credentialKind = 'jwt'
    expect(await ep.handle(request(3, '_agnes/v1/device.recognition.get', { sessionId: 'a' }))).toMatchObject(
      { error: { data: { reason: 'local owner required' } } },
    )
  })

  it('saves and reads current device metadata, rejects ordinary/history access and keeps configuration CAS separate', async () => {
    const { ep } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    expect(await ep.handle(request(2, '_agnes/v1/device.connection.get', { sessionId: 'a' }))).toMatchObject({
      result: { bindingRevision: 1, profile: null },
    })
    const input = {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:AB',
    }
    const saved = await ep.handle(request(3, '_agnes/v1/device.connection.save', input))
    expect(saved).toMatchObject({
      result: { bindingRevision: 1, profile: { configRevision: 1, macAddress: '12:34:56:78:90:ab' } },
    })
    if (!saved || !('result' in saved)) throw new Error('Missing saved connection result')
    expect(await ep.handle(request(4, '_agnes/v1/device.connection.save', input))).toMatchObject({
      result: saved.result,
    })
    expect(
      await ep.handle(request(5, '_agnes/v1/device.connection.save', { ...input, ip: '192.168.1.43' })),
    ).toMatchObject({ error: { data: { code: 'DEVICE_CONFIGURATION_CONFLICT', reason: 'revision' } } })
    for (const action of ['get', 'save'])
      expect(
        await ep.handle(
          request(
            6,
            `_agnes/v1/device.connection.${action}`,
            action === 'get' ? { sessionId: 'b' } : { ...input, sessionId: 'b' },
          ),
        ),
      ).toMatchObject({ error: { data: { code: 'DEVICE_CONFIGURATION_CONFLICT', reason: 'inactive' } } })
    await ep.handle(request(7, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 }))
    expect(await ep.handle(request(8, '_agnes/v1/device.connection.get', { sessionId: 'a' }))).toMatchObject({
      error: { data: { reason: 'inactive' } },
    })
  })

  it.each(['foreign', 'remote', 'stale-workspace', 'extra-input'])(
    'refuses connection metadata save for %s before persistence',
    async (mode) => {
      const { ep, store, workspaces, disappear } = await setup()
      await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
      if (mode === 'remote') ep.conn.authKind = 'jwt'
      if (mode === 'stale-workspace') disappear()
      const input = {
        sessionId: mode === 'foreign' ? 'foreign' : 'a',
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        ip: '192.168.1.42',
        port: 80,
        macAddress: '12:34:56:78:90:ab',
        ...(mode === 'extra-input' ? { deviceId: 'forged' } : {}),
      }
      expect(await ep.handle(request(2, '_agnes/v1/device.connection.save', input))).toHaveProperty('error')
      if (mode !== 'stale-workspace')
        expect(store.connection(await workspaces.restoreBinding('a')).profile).toBeNull()
    },
  )

  it('shares fresh owner-checked reads with the worker without enrolling ordinary sessions', async () => {
    const { store, owners, workspaces, ep } = await setup()
    const deps = { store, ownership: owners, workspaces }
    expect(await readWorkerDeviceSession(deps, 'a', {})).toMatchObject({ session: null })
    const reply = await ep.handle(
      request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }),
    )
    expect(reply && 'result' in reply).toBe(true)
    if (!reply || !('result' in reply)) throw new Error('binding RPC returned no result')
    expect(await readWorkerDeviceSession(deps, 'a', {})).toEqual(reply.result)
    expect(await readWorkerDeviceSession(deps, 'b', {})).toMatchObject({ session: null })
    await expect(readWorkerDeviceSession(deps, 'b', { view: 'connection' })).rejects.toThrow('inactive')
    expect(await readWorkerDeviceSession(deps, 'a', { view: 'connection' })).toMatchObject({
      profile: null,
      bindingRevision: 1,
    })
    store.saveConnection(await workspaces.restoreBinding('a'), {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    })
    expect(await readWorkerDeviceSession(deps, 'a', { view: 'connection' })).toEqual(
      store.connection(await workspaces.restoreBinding('a')),
    )
    expect(await readWorkerDeviceSession(deps, 'a', { view: 'recognition' })).toEqual(
      store.recognition.view(await workspaces.restoreBinding('a')),
    )
    await expect(readWorkerDeviceSession(deps, 'b', { view: 'recognition' })).rejects.toThrow('inactive')
    for (const params of [
      { view: 'other' },
      { view: 'recognition', credentialRef: 'secret://private' },
      { view: 'connection', sessionId: 'b' },
    ])
      await expect(readWorkerDeviceSession(deps, 'a', params)).rejects.toBeDefined()
  })

  it.each(['payload', 'pending', 'missing-store', 'workspace-stale'] as const)(
    'refuses worker binding lookup for %s',
    async (mode) => {
      const { store, owners, workspaces, disappear } = await setup()
      if (mode === 'workspace-stale') disappear()
      await expect(
        readWorkerDeviceSession(
          { store: mode === 'missing-store' ? undefined : store, ownership: owners, workspaces },
          mode === 'pending' ? 'pending' : 'a',
          mode === 'payload' ? { sessionId: 'foreign' } : {},
        ),
      ).rejects.toBeDefined()
    },
  )

  it.each(
    [{}, { view: 'connection' }].flatMap((params) =>
      (['owner', 'storage'] as const).map((mode) => [params, mode] as const),
    ),
  )('refuses %s lookup after %s changes during workspace validation', async (params, mode) => {
    const { store, owners, workspaces } = await setup()
    let changed = false
    const deps: Parameters<typeof readWorkerDeviceSession>[0] = {
      store,
      ownership: {
        resolve: (key) => (changed ? { active: true, principalId: 'replacement' } : owners.resolve(key)),
      },
      workspaces: {
        restoreBinding: async (key) => {
          const authority = await workspaces.restoreBinding(key)
          if (mode === 'owner') changed = true
          else deps.store = undefined
          return authority
        },
      },
    }
    await expect(readWorkerDeviceSession(deps, 'a', params)).rejects.toMatchObject({
      code: rpcError('CAPABILITY_DENIED').code,
    })
  })
  it('queries ordinary sessions without enrolling and binds a daemon-assigned identity idempotently', async () => {
    const { ep, store } = await setup()
    expect(await ep.handle(request(1, '_agnes/v1/device.session.get', { sessionId: 'a' }))).toMatchObject({
      result: { workspace: null, session: null },
    })
    const bound = await ep.handle(
      request(2, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }),
    )
    expect(bound).toMatchObject({
      result: {
        workspace: { revision: 1, active: true },
        session: { sessionId: 'a', bindingRevision: 1, active: true },
      },
    })
    const deviceId = store.session('a')?.deviceId
    expect(deviceId).toMatch(/^[a-f0-9-]{36}$/)
    expect(
      await ep.handle(request(3, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 })),
    ).toMatchObject({
      result: { session: { deviceId } },
    })
    expect(await ep.handle(request(4, '_agnes/v1/device.session.get', { sessionId: 'b' }))).toMatchObject({
      result: { workspace: { deviceId }, session: null },
    })
    expect(store.session('b')).toBeUndefined()
    expect(await ep.handle(request(5, '_agnes/v1/device.bindings.list'))).toMatchObject({
      result: { items: [{ deviceId, active: true }] },
    })
  })

  it('rejects unknown, foreign and pending sessions before persisting a binding', async () => {
    const { ep, store } = await setup()
    for (const sessionId of ['missing', 'foreign', 'pending']) {
      expect(await ep.handle(request(1, '_agnes/v1/device.session.get', { sessionId }))).toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED' } },
      })
      expect(
        await ep.handle(request(2, '_agnes/v1/device.session.bind', { sessionId, expectedRevision: 0 })),
      ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
      expect(store.session(sessionId)).toBeUndefined()
    }
    expect(store.activeWorkspaces()).toEqual([])
  })

  it('refuses remote authenticated identities and caller-supplied workspace/device identity', async () => {
    const { ep, store } = await setup()
    ep.conn.authKind = 'jwt'
    ep.conn.credentialKind = 'jwt'
    expect(await ep.handle(request(1, '_agnes/v1/device.bindings.list'))).toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(
      await ep.handle(request(2, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 })),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    ep.conn.authKind = 'local'
    ep.conn.credentialKind = 'local'
    for (const injected of [{ deviceId: 'fake' }, { workspaceId: 'fake' }, { expectedRevision: -1 }]) {
      expect(
        await ep.handle(
          request(3, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0, ...injected }),
        ),
      ).toMatchObject({ error: { code: -32602 } })
    }
    expect(store.activeWorkspaces()).toEqual([])
  })

  it('allows a second enrolled session but rejects stale competing creation', async () => {
    const { ep, store } = await setup()
    const responses = await Promise.all(
      ['a', 'b'].map((sessionId, i) =>
        ep.handle(request(i + 1, '_agnes/v1/device.session.bind', { sessionId, expectedRevision: 0 })),
      ),
    )
    expect(responses.filter((response) => response && 'result' in response)).toHaveLength(1)
    expect(responses.filter((response) => response && 'error' in response)).toMatchObject([
      { error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } },
    ])
    const missing = store.session('a') ? 'b' : 'a'
    expect(
      await ep.handle(
        request(3, '_agnes/v1/device.session.bind', { sessionId: missing, expectedRevision: 1 }),
      ),
    ).toMatchObject({ result: { session: { active: true } } })
    expect(store.session('a')?.deviceId).toBe(store.session('b')?.deviceId)
  })

  it('returns detached historical session identity rather than silently switching cars', async () => {
    const { ep, store } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    const old = store.session('a')?.deviceId
    expect(old).toBeDefined()
    expect(
      await ep.handle(request(2, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 })),
    ).toMatchObject({
      result: { workspace: { revision: 2, active: false }, session: { deviceId: old, active: false } },
    })
    expect(
      await ep.handle(request(2, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 2 })),
    ).toMatchObject({ result: { workspace: { revision: 2, active: false } } })
    await ep.handle(request(2, '_agnes/v1/device.session.bind', { sessionId: 'b', expectedRevision: 2 }))
    expect(store.session('b')?.deviceId).not.toBe(old)
    expect(await ep.handle(request(3, '_agnes/v1/device.session.get', { sessionId: 'a' }))).toMatchObject({
      result: { session: { deviceId: old, active: false } },
    })
    expect(
      await ep.handle(request(4, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 3 })),
    ).toMatchObject({ error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } })
    expect(
      await ep.handle(request(5, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 3 })),
    ).toMatchObject({ error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } })
    expect(store.activeWorkspaces()).toMatchObject([{ revision: 3, active: true }])
  })

  it('refuses ordinary, unauthorized, remote, stale and forged detach requests without changing enrollment', async () => {
    const { ep, store } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    for (const sessionId of ['missing', 'foreign', 'pending', 'b']) {
      expect(
        await ep.handle(request(2, '_agnes/v1/device.session.detach', { sessionId, expectedRevision: 1 })),
      ).toMatchObject({ error: {} })
    }
    for (const params of [
      { sessionId: 'a', expectedRevision: 0 },
      { sessionId: 'a', expectedRevision: 1.5 },
      { sessionId: 'a', expectedRevision: 1, deviceId: 'fake' },
      { sessionId: 'a', expectedRevision: 1, workspaceId: 'fake' },
    ]) {
      expect(await ep.handle(request(3, '_agnes/v1/device.session.detach', params))).toMatchObject({
        error: { code: -32602 },
      })
    }
    expect(
      await ep.handle(request(4, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 2 })),
    ).toMatchObject({ error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } })
    ep.conn.authKind = 'jwt'
    ep.conn.credentialKind = 'jwt'
    expect(
      await ep.handle(request(5, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 })),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    expect(store.activeWorkspaces()).toMatchObject([{ revision: 1, active: true }])
    expect(store.session('a')?.bindingRevision).toBe(1)
    expect(store.session('b')).toBeUndefined()
  })

  it('detaches one shared association once, notifying revocation while keeping both session histories', async () => {
    const { ep, store, changes } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    await ep.handle(request(2, '_agnes/v1/device.session.bind', { sessionId: 'b', expectedRevision: 1 }))
    const replies = await Promise.all(
      ['a', 'b'].map((sessionId, index) =>
        ep.handle(request(index + 3, '_agnes/v1/device.session.detach', { sessionId, expectedRevision: 1 })),
      ),
    )
    expect(replies.filter((reply) => reply && 'result' in reply)).toHaveLength(1)
    expect(replies.filter((reply) => reply && 'error' in reply)).toMatchObject([
      { error: { data: { code: 'DEVICE_BINDING_CONFLICT' } } },
    ])
    expect(changes).toMatchObject([
      { revision: 1, active: true },
      { revision: 2, active: false },
    ])
    expect(store.activeWorkspaces()).toEqual([])
    for (const sessionId of ['a', 'b']) {
      expect(store.session(sessionId)).toMatchObject({ bindingRevision: 1 })
      expect(await ep.handle(request(5, '_agnes/v1/device.session.get', { sessionId }))).toMatchObject({
        result: { workspace: { revision: 2, active: false }, session: { active: false } },
      })
      expect(
        await ep.handle(request(6, '_agnes/v1/device.session.detach', { sessionId, expectedRevision: 2 })),
      ).toMatchObject({
        result: { workspace: { revision: 2, active: false } },
      })
    }
    expect(changes).toHaveLength(2)
  })

  it.each(
    (['ownership', 'workspace', 'replacement', 'storage', 'closed-connection'] as const).flatMap((mode) =>
      (['detach', 'save'] as const).map((action) => [mode, action] as const),
    ),
  )('rechecks %s when performing %s after workspace validation yields', async (mode, action) => {
    const { ep, store, deps, workspaces, disappear } = await setup()
    await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }))
    const original = deps.workspaces.restoreBinding
    if (mode === 'workspace') disappear()
    else
      deps.workspaces.restoreBinding = async (id) => {
        const authority = await original(id)
        if (mode === 'ownership')
          deps.requireSessionOwner = () => {
            throw rpcError('CAPABILITY_DENIED')
          }
        if (mode === 'storage') (deps as { store: DeviceBindingIndex | undefined }).store = undefined
        if (mode === 'closed-connection') await ep.close()
        if (mode === 'replacement') {
          store.detach(authority, 1)
          store.attach(await workspaces.restoreBinding('b'), '11111111-1111-4111-8111-111111111111', 2)
        }
        return authority
      }
    expect(
      await ep.handle(
        action === 'detach'
          ? request(2, '_agnes/v1/device.session.detach', { sessionId: 'a', expectedRevision: 1 })
          : request(2, '_agnes/v1/device.connection.save', {
              sessionId: 'a',
              expectedBindingRevision: 1,
              expectedConfigRevision: 0,
              ip: '192.168.1.96',
              port: 80,
              macAddress: '14:0a:02:d3:7c:01',
            }),
      ),
    ).toMatchObject({ error: {} })
    expect(store.activeWorkspaces()).toMatchObject([
      { revision: mode === 'replacement' ? 3 : 1, active: true },
    ])
    if (mode !== 'workspace')
      expect(
        store.connection(await workspaces.restoreBinding(mode === 'replacement' ? 'b' : 'a')).profile,
      ).toBeNull()
  })

  it('checks workspace freshness and rechecks ownership after async validation', async () => {
    const { ep, store, disappear, deps, workspaces } = await setup()
    const original = deps.workspaces.restoreBinding
    deps.workspaces.restoreBinding = async (id) => {
      const binding = await original(id)
      deps.requireSessionOwner = () => {
        throw rpcError('CAPABILITY_DENIED')
      }
      return binding
    }
    expect(
      await ep.handle(request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 })),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    expect(store.activeWorkspaces()).toEqual([])
    deps.requireSessionOwner = () => {}
    deps.workspaces.restoreBinding = (id) => workspaces.restoreBinding(id)
    disappear()
    expect(
      await ep.handle(request(2, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 })),
    ).toMatchObject({ error: { data: { code: 'WORKSPACE_STALE' } } })
    expect(store.activeWorkspaces()).toEqual([])
  })
})

describe('owner recognition configuration save', () => {
  const cloud = {
    provider: 'aliyun' as const,
    frequency: 2 as const,
    requestBudget: 3600,
    credentials: {
      action: 'replace' as const,
      accessKeyId: 'synthetic-access-id',
      accessKeySecret: 'synthetic-secret-only',
    },
  }
  const save = (settings: unknown = cloud, expectedConfigRevision = 0) => ({
    sessionId: 'a',
    expectedBindingRevision: 1,
    expectedConfigRevision,
    settings,
  })
  async function configured() {
    const dir = await mkdtemp(join(tmpdir(), 'agh-recognition-save-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const credentials = createCredentialStore({ root: join(dir, 'home') })
    const fixture = await setup(credentials)
    await fixture.ep.handle(
      request(1, '_agnes/v1/device.session.bind', { sessionId: 'a', expectedRevision: 0 }),
    )
    return { ...fixture, credentials, authority: await fixture.workspaces.restoreBinding('a') }
  }

  it('publishes an atomic cloud pair, returns no secrets, and deduplicates identical replace retries', async () => {
    const { ep, store, credentials, authority } = await configured()
    const write = vi.spyOn(credentials, 'putApiKey')
    const first = await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    expect(first).toMatchObject({
      result: { configRevision: 1, settings: { provider: 'aliyun', credentialConfigured: true } },
    })
    expect(JSON.stringify(first)).not.toContain('secret://')
    expect(JSON.stringify(first)).not.toContain(cloud.credentials.accessKeySecret)
    const current = store.recognition.read(authority)
    if (!current.settings?.credentialRef) throw new Error('Missing private reference')
    expect(
      await readDeviceRecognitionCredential(
        credentials,
        current.deviceId,
        current.settings.credentialRef,
        new AbortController().signal,
      ),
    ).toEqual({
      accessKeyId: cloud.credentials.accessKeyId,
      accessKeySecret: cloud.credentials.accessKeySecret,
    })
    expect(await ep.handle(request(3, '_agnes/v1/device.recognition.save', save()))).toMatchObject({
      result: { configRevision: 1 },
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(
      await ep.handle(
        request(
          4,
          '_agnes/v1/device.recognition.save',
          save({ ...cloud, credentials: { action: 'keep' } }, 1),
        ),
      ),
    ).toMatchObject({ result: { configRevision: 1 } })
    expect(await ep.handle(request(5, '_agnes/v1/device.recognition.save', save(null, 1)))).toMatchObject({
      result: { configRevision: 2, settings: null },
    })
    expect(await ep.handle(request(6, '_agnes/v1/device.recognition.save', save()))).toHaveProperty('error')
  })

  it('supports local token replacement, keeping and clearing without contacting inference', async () => {
    const { ep, store, credentials, authority } = await configured()
    const local = {
      provider: 'local-yolo',
      frequency: 1,
      requestBudget: 20,
      baseUrl: 'http://127.0.0.1:8000',
      credentials: { action: 'replace', token: 'synthetic-local-token' },
    }
    expect(await ep.handle(request(2, '_agnes/v1/device.recognition.save', save(local)))).toMatchObject({
      result: {
        configRevision: 1,
        settings: { provider: 'local-yolo', credentialConfigured: true, baseUrl: 'http://127.0.0.1:8000/' },
      },
    })
    const current = store.recognition.read(authority)
    if (!current.settings?.credentialRef) throw new Error('Missing private reference')
    expect(
      await readDeviceRecognitionToken(
        credentials,
        current.deviceId,
        current.settings.credentialRef,
        new AbortController().signal,
      ),
    ).toBe('synthetic-local-token')
    expect(await ep.handle(request(3, '_agnes/v1/device.recognition.save', save(local)))).toMatchObject({
      result: { configRevision: 1 },
    })
    expect(
      await ep.handle(
        request(
          4,
          '_agnes/v1/device.recognition.save',
          save({ ...local, credentials: { action: 'keep' } }, 1),
        ),
      ),
    ).toMatchObject({ result: { configRevision: 1 } })
    expect(
      await ep.handle(
        request(
          5,
          '_agnes/v1/device.recognition.save',
          save({ ...local, credentials: { action: 'clear' } }, 1),
        ),
      ),
    ).toMatchObject({ result: { configRevision: 2, settings: { credentialConfigured: false } } })
  })

  it('refuses private selectors, ordinary/remote access and missing credentials without writing', async () => {
    const { ep, store, credentials, authority } = await configured()
    const write = vi.spyOn(credentials, 'putApiKey')
    for (const input of [
      { ...save(), credentialRef: 'other' },
      { ...save(), sessionId: 'b' },
      save({ ...cloud, credentials: { action: 'keep' } }),
      save({ ...cloud, requestBudget: 0 }),
    ])
      expect(await ep.handle(request(2, '_agnes/v1/device.recognition.save', input))).toHaveProperty('error')
    ep.conn.credentialKind = 'jwt'
    expect(await ep.handle(request(3, '_agnes/v1/device.recognition.save', save()))).toHaveProperty('error')
    expect(write).not.toHaveBeenCalled()
    expect(store.recognition.read(authority).configRevision).toBe(0)
  })

  it('cleans a staged credential if ownership changes before publication', async () => {
    const { ep, store, credentials, authority, deps } = await configured()
    const original = credentials.putApiKey.bind(credentials)
    let staged = ''
    vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      deps.requireSessionOwner = () => {
        throw rpcError('CAPABILITY_DENIED')
      }
    })
    expect(await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))).toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(await credentials.read(staged)).toBeNull()
    expect(store.recognition.read(authority).configRevision).toBe(0)
  })

  it('cleans a staged credential after a CAS race and keeps the competing configuration', async () => {
    const { ep, store, credentials, authority } = await configured()
    const original = credentials.putApiKey.bind(credentials)
    let staged = ''
    vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      store.recognition.save(authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        settings: {
          provider: 'local-yolo',
          frequency: 1,
          requestBudget: 10,
          baseUrl: 'http://127.0.0.1:8000',
          credentialRef: null,
        },
      })
    })
    expect(await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))).toHaveProperty('error')
    expect(await credentials.read(staged)).toBeNull()
    expect(store.recognition.read(authority).settings?.provider).toBe('local-yolo')
  })

  it('retains a published credential if persistence succeeds but the subsequent operation reports failure', async () => {
    const { ep, store, credentials, authority } = await configured()
    const original = store.recognition.save.bind(store.recognition)
    vi.spyOn(store.recognition, 'save').mockImplementation((...args) => {
      original(...args)
      throw new Error('synthetic-secret-only')
    })
    const failed = await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    expect(failed).toMatchObject({ error: { data: { code: 'DEVICE_RECOGNITION_SAVE_FAILED' } } })
    expect(JSON.stringify(failed)).not.toContain('synthetic-secret-only')
    const persisted = store.recognition.read(authority)
    if (!persisted.settings?.credentialRef) throw new Error('Missing private reference')
    expect(await credentials.read(persisted.settings.credentialRef)).not.toBeNull()
    expect(persisted.configRevision).toBe(1)
  })
  it('repairs a missing old credential only with the current configuration version', async () => {
    const { ep, store, credentials, authority } = await configured()
    await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    const old = store.recognition.read(authority).settings?.credentialRef
    if (!old) throw new Error('Missing reference')
    await credentials.remove(old)
    expect(await ep.handle(request(3, '_agnes/v1/device.recognition.save', save()))).toHaveProperty('error')
    expect(store.recognition.read(authority).configRevision).toBe(1)
    expect(await ep.handle(request(4, '_agnes/v1/device.recognition.save', save(cloud, 1)))).toMatchObject({
      result: { configRevision: 2 },
    })
    const next = store.recognition.read(authority).settings?.credentialRef
    expect(next).not.toBe(old)
    if (!next) throw new Error('Missing replacement')
    expect(await credentials.read(next)).not.toBeNull()
  })

  it('serializes same-device writers while credentials are being persisted', async () => {
    const { ep, store, credentials, authority } = await configured()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const original = credentials.putApiKey.bind(credentials)
    vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      await original(ref, value)
      enter()
      await release
    })
    const first = ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    await entered
    try {
      expect(await ep.handle(request(3, '_agnes/v1/device.recognition.save', save()))).toMatchObject({
        error: { data: { code: 'DEVICE_RECOGNITION_BUSY' } },
      })
      expect(store.recognition.read(authority).configRevision).toBe(0)
    } finally {
      resume()
    }
    expect(await first).toMatchObject({ result: { configRevision: 1 } })
  })

  it('cleans late cancellation and releases the device writer lock', async () => {
    const { store, credentials, authority } = await configured()
    const controller = new AbortController()
    const original = credentials.putApiKey.bind(credentials)
    let staged = ''
    const write = vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      controller.abort()
    })
    await expect(
      saveDeviceRecognition(
        { ...save(), settings: cloud },
        credentials,
        async () => ({ store, authority }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
    expect(await credentials.read(staged)).toBeNull()
    expect(store.recognition.read(authority).configRevision).toBe(0)
    write.mockRestore()
    expect(
      await saveDeviceRecognition(
        { ...save(), settings: cloud },
        credentials,
        async () => ({ store, authority }),
        new AbortController().signal,
      ),
    ).toMatchObject({ configRevision: 1 })
  })

  it('preserves a staged credential when publication cannot be determined', async () => {
    const { ep, store, credentials } = await configured()
    const original = credentials.putApiKey.bind(credentials)
    let staged = ''
    vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
    })
    vi.spyOn(store.recognition, 'save').mockImplementation(() => {
      throw new Error('synthetic-secret-only')
    })
    vi.spyOn(store.recognition, 'references').mockImplementation(() => {
      throw new Error('synthetic-secret-only')
    })
    const result = await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    expect(result).toMatchObject({ error: { data: { code: 'DEVICE_RECOGNITION_PUBLICATION_UNCERTAIN' } } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-only')
    expect(await credentials.read(staged)).not.toBeNull()
  })
  it('reports failed stage cleanup without exposing storage errors or claiming publication', async () => {
    const { ep, store, credentials, authority, deps } = await configured()
    const original = credentials.putApiKey.bind(credentials)
    let staged = ''
    vi.spyOn(credentials, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      deps.requireSessionOwner = () => {
        throw rpcError('CAPABILITY_DENIED')
      }
    })
    vi.spyOn(credentials, 'remove').mockRejectedValue(new Error('synthetic-secret-only'))
    const result = await ep.handle(request(2, '_agnes/v1/device.recognition.save', save()))
    expect(result).toMatchObject({ error: { data: { code: 'DEVICE_RECOGNITION_CLEANUP_FAILED' } } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-only')
    expect(store.recognition.read(authority).configRevision).toBe(0)
    expect(await credentials.read(staged)).not.toBeNull()
  })
})
