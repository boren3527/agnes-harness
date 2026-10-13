import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { type PackageAdminService, registerPackageAdmin } from '../src/packages/handler.js'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { deviceMediaSessionResolver } from '../src/supervisor/device-media-resolve.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const endpoint = {
  port: 12345,
  authorization: `Bearer ${'a'.repeat(43)}`,
  rowRevision: 'snapshot',
  registrationId: '11111111-1111-4111-8111-111111111111',
  workerGeneration: 1,
}
const authority = {
  audience: 'admin' as const,
  principalId: 'owner',
  clientId: 'launcher',
  permissions: ['packages.read' as const],
}
const input = {
  profile: 'local-dev',
  sessionId: 'session',
  rowId: 'web:robot',
  backendRowId: 'ext:robot',
  rosterRevision: 'roster',
}

async function setup() {
  const tables = sqliteTables()
  cleanup.push(() => tables.close())
  const bindings = new DeviceBindingIndex(tables.table('devices'))
  const ownership = new MemorySessionPrincipalOwnership()
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    async (path) => ({ path, name: 'repo' }),
    () => 0,
  )
  await workspaces.add('/repo/a')
  const binding = await workspaces.authorizeAndBind('session', '/repo/a')
  bindings.attach(binding, randomUUID(), 0)
  const config = {
    sessionId: 'session',
    expectedBindingRevision: 1,
    expectedConfigRevision: 0,
    ip: '192.168.1.42',
    port: 80,
    macAddress: '12:34:56:78:90:ab',
  }
  bindings.saveConnection(binding, config)
  ownership.bindNew('session', 'owner')
  ownership.activateNew('session', 'owner')
  const read = vi.fn(async () => endpoint)
  const deps = { profile: 'local-dev', bindings, ownership, workspaces, read }
  return {
    ...deps,
    deps,
    binding,
    config,
    ac: new AbortController(),
    resolve: deviceMediaSessionResolver(deps),
  }
}

describe('private media session authority', () => {
  it.each(['default', 'local-private', 'jwt-private'] as const)(
    'exposes private media only on an explicitly enabled local transport: %s',
    async (kind) => {
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'owner' })
      cleanup.push(() => ep.close())
      ep.conn.initialized = true
      ep.conn.authKind = kind === 'jwt-private' ? 'jwt' : 'local'
      ep.conn.credentialKind = kind === 'jwt-private' ? 'jwt' : 'local'
      const call = vi.fn(async () => ({ found: false }))
      registerPackageAdmin(
        ep,
        { call } as unknown as PackageAdminService,
        () => authority,
        kind !== 'default',
      )
      const result = await ep.handle({
        jsonrpc: '2.0',
        id: 1,
        method: '_agnes/v1/clientModules.resolveMedia',
        params: { profile: input.profile, rowId: input.rowId, sessionId: input.sessionId },
      })
      if (kind === 'local-private') {
        expect(result).toMatchObject({ result: { found: false } })
        expect(call).toHaveBeenCalledWith(
          '_agnes/v1/clientModules.resolveMedia',
          expect.objectContaining({ rowId: 'web:robot' }),
          authority,
          expect.any(AbortSignal),
        )
      } else {
        expect(result).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
        expect(call).not.toHaveBeenCalled()
      }
    },
  )
  it('returns a current private endpoint with server-owned binding and configuration versions', async () => {
    const v = await setup()
    const current = v.bindings.connection(v.binding)
    await expect(v.resolve(input, authority, v.ac.signal)).resolves.toEqual({
      found: true,
      ...endpoint,
      deviceId: current.deviceId,
      bindingRevision: 1,
      configRevision: 1,
      rosterRevision: 'roster',
    })
    expect(v.read).toHaveBeenCalledWith('ext:robot', v.ac.signal)
  })
  it.each(['owner', 'profile', 'ordinary', 'cancelled'] as const)(
    'refuses %s before any worker lookup',
    async (kind) => {
      const v = await setup()
      if (kind === 'ordinary') {
        await v.workspaces.add('/repo/b')
        await v.workspaces.authorizeAndBind('ordinary', '/repo/b')
        v.ownership.bindNew('ordinary', 'owner')
        v.ownership.activateNew('ordinary', 'owner')
      }
      if (kind === 'cancelled') v.ac.abort()
      await expect(
        v.resolve(
          {
            ...input,
            ...(kind === 'profile' ? { profile: 'other' } : {}),
            ...(kind === 'ordinary' ? { sessionId: 'ordinary' } : {}),
          },
          { ...authority, ...(kind === 'owner' ? { principalId: 'other' } : {}) },
          v.ac.signal,
        ),
      ).rejects.toBeDefined()
      expect(v.read).not.toHaveBeenCalled()
    },
  )
  it.each(['configuration', 'workspace', 'ownership', 'cancelled'] as const)(
    'rejects a reply crossing %s changes',
    async (kind) => {
      const v = await setup()
      v.read.mockImplementation(async () => {
        if (kind === 'configuration')
          v.bindings.saveConnection(v.binding, { ...v.config, expectedConfigRevision: 1, ip: '192.168.1.43' })
        if (kind === 'workspace') {
          await v.workspaces.add('/repo/b')
          await v.workspaces.authorizeAndBind('session', '/repo/b')
        }
        if (kind === 'ownership') vi.spyOn(v.ownership, 'resolve').mockReturnValue(undefined)
        if (kind === 'cancelled') v.ac.abort()
        return endpoint
      })
      await expect(v.resolve(input, authority, v.ac.signal)).rejects.toBeDefined()
    },
  )
})
