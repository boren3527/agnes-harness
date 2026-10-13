import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { WorkspaceBindingIndex, WorkspaceCatalog, WorkspaceIndex } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function setup(
  path?: string,
  changed?: ConstructorParameters<typeof DeviceBindingIndex>[1],
  connectionChanged?: ConstructorParameters<typeof DeviceBindingIndex>[2],
  recognitionChanged?: ConstructorParameters<typeof DeviceBindingIndex>[3],
) {
  const tables = sqliteTables(path)
  cleanup.push(() => tables.close())
  const table = tables.table('device_bindings')
  const workspaces = new WorkspaceCatalog(
    new WorkspaceIndex(table),
    new MemorySessionWorkspaces(),
    async (path) => ({ path, name: path.split('/').at(-1) ?? path }),
    () => 0,
    new WorkspaceBindingIndex(table),
  )
  return {
    tables,
    table,
    workspaces,
    devices: new DeviceBindingIndex(table, changed, connectionChanged, recognitionChanged),
  }
}

async function authority(workspaces: WorkspaceCatalog, session: string, root = '/repo/a') {
  await workspaces.add(root)
  return workspaces.authorizeAndBind(session, root)
}

describe('device workspace/session associations', () => {
  it('persists canonical connection metadata with independent CAS and idempotent identical retries', async () => {
    const changed = vi.fn()
    const { devices, workspaces } = setup(undefined, undefined, changed)
    const a = await authority(workspaces, 'a')
    devices.attach(a, randomUUID(), 0)
    const input = {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:AB',
    }
    expect(devices.connection(a).profile).toBeNull()
    const first = devices.saveConnection(a, input)
    expect(first.profile).toMatchObject({
      driver: 'aka-00',
      macAddress: '12:34:56:78:90:ab',
      configRevision: 1,
    })
    expect(devices.saveConnection(a, input)).toEqual(first)
    expect(devices.saveConnection(a, { ...input, expectedConfigRevision: 1 })).toEqual(first)
    expect(() => devices.saveConnection(a, { ...input, ip: '192.168.1.43' })).toThrow('revision')
    expect(() => devices.saveConnection(a, { ...input, expectedBindingRevision: 2 })).toThrow('revision')
    const second = devices.saveConnection(a, { ...input, expectedConfigRevision: 1, ip: '192.168.1.43' })
    expect(second.profile?.configRevision).toBe(2)
    expect(() => devices.saveConnection(a, input)).toThrow('revision')
    expect(devices.connection(a)).toEqual(second)
    expect(changed.mock.calls.map(([value]) => value.profile.configRevision)).toEqual([1, 2])
    expect(
      changed.mock.calls.every(([value]) => Object.isFrozen(value) && Object.isFrozen(value.profile)),
    ).toBe(true)
    changed.mockImplementationOnce(() => {
      throw new Error('notification unavailable')
    })
    const third = { ...input, expectedConfigRevision: 2, ip: '192.168.1.44' }
    expect(() => devices.saveConnection(a, third)).toThrow('notification unavailable')
    expect(devices.connection(a).profile).toMatchObject({ configRevision: 3, ip: third.ip })
    expect(devices.saveConnection(a, third)).toEqual(devices.connection(a))
    expect(changed.mock.calls.map(([value]) => value.profile.configRevision)).toEqual([1, 2, 3])
  })

  it('starts a fresh connection after detachment even when the old robot is occupied elsewhere', async () => {
    const { devices, workspaces, table } = setup()
    const a = await authority(workspaces, 'a')
    const history = await authority(workspaces, 'history')
    const b = await authority(workspaces, 'b', '/repo/b')
    const ordinary = await authority(workspaces, 'ordinary')
    const original = randomUUID()
    devices.attach(a, original, 0)
    devices.attach(history, original, 1)
    devices.attach(b, randomUUID(), 0)
    const input = {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '10.0.0.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    }
    devices.saveConnection(a, input)
    devices.detach(a, 1)
    devices.saveConnection(b, { ...input, sessionId: 'b' })
    expect(() => devices.attach(a, original, 2, true)).toThrow('device-in-use')
    const replacement = randomUUID()
    expect(() => devices.attach(ordinary, replacement, 2, true, true)).toThrow('inactive')
    expect(() => devices.attach(a, replacement, 1, true, true)).toThrow('revision')
    expect(devices.attach(a, replacement, 2, true, true)).toMatchObject({
      deviceId: replacement,
      bindingRevision: 3,
    })
    expect(devices.attach(a, replacement, 2, true, true)).toMatchObject({
      deviceId: replacement,
      bindingRevision: 3,
    })
    expect(devices.connection(a).profile).toBeNull()
    expect(devices.session('history')).toMatchObject({ deviceId: original, bindingRevision: 1 })
    expect(() => devices.resolve(history)).toThrow('inactive')
    expect(
      table.get('SELECT * FROM device_connection_profiles WHERE device_id = ?', [original]),
    ).toMatchObject({ ip: input.ip })
    expect(() => devices.saveConnection(a, { ...input, expectedBindingRevision: 3 })).toThrow('device-in-use')
    expect(
      devices.saveConnection(a, {
        ...input,
        expectedBindingRevision: 3,
        ip: '10.0.0.43',
        macAddress: '12:34:56:78:90:ac',
      }).profile,
    ).toMatchObject({ ip: '10.0.0.43' })
  })

  it('refuses duplicate active endpoint or reported identity, then permits explicit reuse after detachment', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const b = await authority(workspaces, 'b', '/repo/b')
    const originalDevice = randomUUID()
    devices.attach(a, originalDevice, 0)
    devices.attach(b, randomUUID(), 0)
    const input = {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '10.0.0.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    }
    devices.saveConnection(a, input)
    expect(() =>
      devices.saveConnection(b, { ...input, sessionId: 'b', macAddress: '12:34:56:78:90:ac' }),
    ).toThrow('endpoint-in-use')
    expect(() => devices.saveConnection(b, { ...input, sessionId: 'b', ip: '10.0.0.43' })).toThrow(
      'device-in-use',
    )
    expect(devices.connection(b).profile).toBeNull()
    devices.detach(a, 1)
    expect(() => devices.connection(a)).toThrow('inactive')
    expect(devices.saveConnection(b, { ...input, sessionId: 'b' }).profile?.ip).toBe(input.ip)
    const fresh = await authority(workspaces, 'fresh')
    expect(() => devices.attach(fresh, originalDevice, 2)).toThrow('device-in-use')
    expect(() => devices.attach(a, originalDevice, 2, true)).toThrow('device-in-use')
    expect(devices.workspace(a.workspaceId)).toMatchObject({ active: false, revision: 2 })
    expect(devices.session('fresh')).toBeUndefined()
    expect(devices.activeWorkspaces()).toHaveLength(1)
    devices.saveConnection(b, {
      ...input,
      sessionId: 'b',
      expectedConfigRevision: 1,
      macAddress: '12:34:56:78:90:ac',
    })
    expect(() => devices.attach(fresh, originalDevice, 2)).toThrow('device-in-use')
    devices.saveConnection(b, {
      ...input,
      sessionId: 'b',
      expectedConfigRevision: 2,
      ip: '10.0.0.43',
    })
    expect(() => devices.attach(fresh, originalDevice, 2)).toThrow('device-in-use')
    devices.saveConnection(b, {
      ...input,
      sessionId: 'b',
      expectedConfigRevision: 3,
      ip: '10.0.0.43',
      macAddress: '12:34:56:78:90:ac',
    })
    expect(devices.attach(fresh, originalDevice, 2).bindingRevision).toBe(3)
    expect(devices.connection(fresh).profile?.configRevision).toBe(1)
    expect(() => devices.connection(a)).toThrow('inactive')
    expect(devices.attach(a, originalDevice, 3, true).bindingRevision).toBe(3)
    expect(devices.connection(a).profile?.configRevision).toBe(1)
  })

  it('keeps configuration confined to an enrolled authority and rolls back failed persistence', async () => {
    const changed = vi.fn()
    const { devices, workspaces, table } = setup(undefined, undefined, changed)
    const a = await authority(workspaces, 'a')
    const ordinary = await authority(workspaces, 'ordinary')
    devices.attach(a, randomUUID(), 0)
    const input = {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '172.16.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    }
    expect(() => devices.connection({ ...a })).toThrow('daemon authority')
    expect(() => devices.saveConnection(ordinary, { ...input, sessionId: 'ordinary' })).toThrow('inactive')
    expect(() => devices.saveConnection(a, { ...input, sessionId: 'ordinary' })).toThrow('Invalid')
    for (const ip of [
      '127.0.0.1',
      '169.254.1.1',
      '172.32.0.1',
      '192.168.01.2',
      '10.0.0.256',
      'https://10.0.0.1',
    ])
      expect(() => devices.saveConnection(a, { ...input, ip })).toThrow('Invalid')
    table.exec(`CREATE TRIGGER refuse_connection BEFORE INSERT ON device_connection_profiles
      BEGIN SELECT RAISE(ABORT, 'profile unavailable'); END`)
    expect(() => devices.saveConnection(a, input)).toThrow('profile unavailable')
    expect(devices.connection(a).profile).toBeNull()
    expect(devices.resolve(a).bindingRevision).toBe(1)
    expect(changed).not.toHaveBeenCalled()
  })

  it('uses the production owner-confined storage adapter without touching the core ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-device-owned-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const storage = createSqliteStorage({ file: join(dir, 'ledger.db') })
    cleanup.push(() => storage.close())
    const owned = storage.tables('@agnes/daemon').table('device_workspace_bindings')
    const table = {
      ...owned,
      exec: (sql: string, params?: unknown[]) => {
        if (params) owned.run(sql, params)
        else owned.exec(sql)
      },
    }
    const catalog = new WorkspaceCatalog(
      new WorkspaceIndex(table),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'repo' }),
      () => 0,
      new WorkspaceBindingIndex(table),
    )
    const binding = await authority(catalog, 'a')
    const devices = new DeviceBindingIndex(table)
    const deviceId = randomUUID()
    devices.attach(binding, deviceId, 0)
    expect(devices.resolve(binding).deviceId).toBe(deviceId)
    const recognition = devices.recognition.save(binding, {
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      settings: {
        provider: 'aliyun',
        frequency: 2,
        requestBudget: 3600,
        credentialRef: `secret://aka-robot/device-${deviceId}-${randomUUID()}`,
      },
    })
    expect(devices.recognition.read(binding)).toEqual(recognition)
    devices.recognitionBudget.start(binding, {
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
      expectedRoundRevision: 0,
      startId: randomUUID(),
    })
    expect(
      devices.recognitionBudget.reserve(binding, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        expectedRoundRevision: 1,
        attemptId: randomUUID(),
      }),
    ).toMatchObject({ granted: true, round: { reserved: 1 } })

    const captureScope = { principalId: 'owner', sessionId: binding.sessionKey, commandId: 'capture-test' }
    const artifact = { sha256: 'a'.repeat(64), size: 3000, mime: 'image/jpeg' as const }
    devices.captures.select(captureScope, {
      deviceId,
      bindingRevision: 1,
      configRevision: 1,
      frameId: 'frame-1',
      width: 320,
      height: 240,
      selectedAt: '2026-10-10T00:00:00.000Z',
      timeBasis: 'bridge_receive',
      ageAtSelectionMs: 20,
      artifact,
    })
    devices.captures.stored(captureScope, artifact)
    const captureId = devices.captures.publicationId(captureScope)
    expect(captureId).toEqual(expect.any(String))
    const reopened = new DeviceBindingIndex(table)
    expect(reopened.captures.publicationId(captureScope)).toBe(captureId)
    expect(reopened.captures.publicationId({ ...captureScope, principalId: 'other' })).toBeNull()

    devices.detach(binding, 1)
    expect(() => devices.resolve(binding)).toThrow('inactive')
    expect(storage.coreTableNames()).not.toContain('device_workspace_bindings')
    expect(storage.coreTableNames()).not.toContain('device_session_bindings')
    expect(storage.coreTableNames()).not.toContain('device_connection_profiles')
    expect(storage.coreTableNames()).not.toContain('device_recognition_profiles')
    expect(storage.coreTableNames()).not.toContain('device_recognition_rounds')
    expect(storage.coreTableNames()).not.toContain('device_recognition_reservations')
    expect(storage.coreTableNames()).not.toContain('device_capture_records')
    expect(storage.coreTableNames()).not.toContain('device_capture_publications')
  })

  it('reuses workspace identity, explicitly enrolls device sessions, and preserves ordinary sessions', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'device-a')
    const ordinary = await authority(workspaces, 'ordinary')
    const deviceId = randomUUID()
    const first = devices.attach(a, deviceId, 0)
    expect(first).toEqual({
      sessionKey: 'device-a',
      workspaceId: a.workspaceId,
      deviceId,
      bindingRevision: 1,
    })
    expect(devices.attach(a, deviceId, 0)).toEqual(first)
    expect(devices.resolve(a)).toEqual(first)
    expect(() => devices.resolve(ordinary)).toThrow('inactive')
    expect(() => devices.detach(ordinary, 1)).toThrow('inactive')
    expect(devices.session('ordinary')).toBeUndefined()
    const b = await authority(workspaces, 'device-b')
    expect(devices.attach(b, deviceId, 1)).toMatchObject({ bindingRevision: 1 })
    expect(devices.resolve(b).deviceId).toBe(deviceId)
    expect((await workspaces.list()).items).toHaveLength(1)
  })

  it('rejects stale revisions and two active workspaces for one device without partial writes', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const b = await authority(workspaces, 'b', '/repo/b')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    expect(() => devices.attach(b, deviceId, 0)).toThrow('device-in-use')
    expect(devices.workspace(b.workspaceId)).toBeUndefined()
    expect(devices.session('b')).toBeUndefined()
    const other = await authority(workspaces, 'other')
    expect(() => devices.attach(other, deviceId, 0)).toThrow('revision')
    expect(() => devices.attach(other, randomUUID(), 1)).toThrow('device-in-use')
    expect(devices.session('other')).toBeUndefined()
  })

  it('retains historical identity on detach and never reactivates old sessions after reattach', async () => {
    const changed = vi.fn()
    const { devices, workspaces } = setup(undefined, changed)
    const a = await authority(workspaces, 'old')
    const deviceId = randomUUID()
    const historical = devices.attach(a, deviceId, 0)
    expect(devices.detach(a, 1)).toMatchObject({ revision: 2, active: false })
    expect(devices.detach(a, 2)).toMatchObject({ revision: 2, active: false })
    expect(devices.session('old')).toEqual(historical)
    expect(() => devices.resolve(a)).toThrow('inactive')
    expect(() => devices.attach(a, deviceId, 2)).toThrow('session-bound')
    const fresh = await authority(workspaces, 'fresh')
    expect(devices.attach(fresh, deviceId, 2)).toMatchObject({ bindingRevision: 3 })
    expect(() => devices.resolve(a)).toThrow('inactive')
    expect(devices.resolve(fresh).deviceId).toBe(deviceId)
    expect(changed.mock.calls.map(([binding]) => [binding.revision, binding.active])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ])
    expect(changed.mock.calls.every(([binding]) => Object.isFrozen(binding))).toBe(true)
    expect(() => devices.detach(a, 3)).toThrow('inactive')
    expect(() => devices.detach(fresh, 1)).toThrow('revision')
    expect(devices.resolve(fresh).deviceId).toBe(deviceId)
  })

  it('allows moving a detached device to another workspace without granting old sessions control', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const b = await authority(workspaces, 'b', '/repo/b')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    devices.detach(a, 1)
    devices.attach(b, deviceId, 0)
    expect(() => devices.resolve(a)).toThrow('inactive')
    expect(devices.resolve(b)).toMatchObject({ workspaceId: b.workspaceId, deviceId })
    const replacement = await authority(workspaces, 'replacement')
    devices.attach(replacement, randomUUID(), 2)
    expect(() => devices.resolve(a)).toThrow('inactive')
  })

  it('rejects forged authority, IP identifiers, and malformed revisions', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    for (const forged of [{ ...a }, { ...a, workspaceId: 'other' }]) {
      expect(() => devices.attach(forged, randomUUID(), 0)).toThrow('daemon authority')
      expect(() => devices.resolve(forged)).toThrow('daemon authority')
      expect(() => devices.detach(forged, 0)).toThrow('daemon authority')
    }
    expect(() => devices.attach(a, '192.168.1.96', 0)).toThrow('stable UUID')
    for (const revision of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => devices.attach(a, randomUUID(), revision)).toThrow('invalid device binding revision')
    expect(devices.workspace(a.workspaceId)).toBeUndefined()
  })

  it('normalizes UUID case so the same device cannot acquire two workspace owners', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const b = await authority(workspaces, 'b', '/repo/b')
    const deviceId = 'ABCDEF00-ABCD-4000-8000-ABCDEF000000'
    expect(devices.attach(a, deviceId, 0).deviceId).toBe(deviceId.toLowerCase())
    expect(devices.attach(a, deviceId.toLowerCase(), 0).deviceId).toBe(deviceId.toLowerCase())
    expect(() => devices.attach(b, deviceId.toLowerCase(), 0)).toThrow('device-in-use')
  })

  it('rolls back workspace creation when session enrollment cannot persist', async () => {
    const changed = vi.fn()
    const { devices, workspaces, table } = setup(undefined, changed)
    const a = await authority(workspaces, 'a')
    table.exec(`CREATE TRIGGER reject_device_session BEFORE INSERT ON device_session_bindings
      BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`)
    expect(() => devices.attach(a, randomUUID(), 0)).toThrow('storage unavailable')
    expect(devices.workspace(a.workspaceId)).toBeUndefined()
    expect(devices.session('a')).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it('persists associations and detached history across storage reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-device-binding-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'bindings.sqlite')
    const initial = setup(path)
    const a = await authority(initial.workspaces, 'a')
    const deviceId = randomUUID()
    initial.devices.attach(a, deviceId, 0)
    const profile = initial.devices.saveConnection(a, {
      sessionId: 'a',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    }).profile
    initial.devices.detach(a, 1)
    await initial.tables.close()
    const reopened = setup(path)
    const restored = await reopened.workspaces.restoreBinding('a')
    expect(reopened.devices.workspace(a.workspaceId)).toEqual({
      workspaceId: a.workspaceId,
      deviceId,
      revision: 2,
      active: false,
    })
    expect(reopened.devices.session('a')?.deviceId).toBe(deviceId)
    expect(() => reopened.devices.resolve(restored)).toThrow('inactive')
    expect(() => reopened.devices.connection(restored)).toThrow('inactive')
    const fresh = await authority(reopened.workspaces, 'fresh')
    reopened.devices.attach(fresh, deviceId, 2)
    expect(reopened.devices.connection(fresh)).toMatchObject({ bindingRevision: 3, profile })
  })
})

describe('device recognition settings persistence', () => {
  const cloud = (deviceId: string) => ({
    provider: 'aliyun' as const,
    frequency: 2 as const,
    requestBudget: 3600,
    credentialRef: `secret://aka-robot/device-${deviceId}-${randomUUID()}`,
  })
  const input = (settings: unknown, expectedConfigRevision = 0) => ({
    expectedBindingRevision: 1,
    expectedConfigRevision,
    settings,
  })

  it('shares current device settings across enrolled sessions with independent CAS and clear tombstones', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const b = await authority(workspaces, 'b')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    devices.attach(b, deviceId, 1)
    expect(devices.recognition.read(a)).toEqual({
      deviceId,
      bindingRevision: 1,
      configRevision: 0,
      settings: null,
    })
    const settings = cloud(deviceId)
    const first = devices.recognition.save(a, input(settings))
    expect(devices.recognition.read(b)).toEqual(first)
    const view = devices.recognition.view(b)
    expect(view.settings).toEqual({
      provider: 'aliyun',
      frequency: 2,
      requestBudget: 3600,
      credentialConfigured: true,
    })
    expect(JSON.stringify(view)).not.toContain('secret://')
    expect(devices.recognition.save(a, input(settings))).toEqual(first)
    expect(devices.recognition.save(b, input(settings, 1))).toEqual(first)
    expect(Object.isFrozen(first) && Object.isFrozen(first.settings)).toBe(true)
    settings.requestBudget = 100
    expect(first.settings?.requestBudget).toBe(3600)
    expect(() => devices.recognition.save(b, input(settings))).toThrow('revision')
    expect(() => devices.recognition.save(a, { ...input(settings, 1), expectedBindingRevision: 2 })).toThrow(
      'revision',
    )
    const cleared = devices.recognition.save(b, input(null, 1))
    expect(cleared).toMatchObject({ configRevision: 2, settings: null })
    expect(devices.recognition.view(b).settings).toBeNull()
    expect(devices.recognition.save(b, input(null, 1))).toEqual(cleared)
    expect(() => devices.recognition.save(a, input(settings))).toThrow('revision')
    expect(devices.connection(a).profile).toBeNull()
  })

  it('rejects ordinary, forged and detached sessions and references belonging to another device', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    const ordinary = await authority(workspaces, 'ordinary')
    const other = await authority(workspaces, 'other', '/repo/other')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    devices.attach(other, randomUUID(), 0)
    for (const candidate of [ordinary, { ...a }]) {
      expect(() => devices.recognition.read(candidate)).toThrow()
      expect(() => devices.recognition.save(candidate, input(cloud(deviceId)))).toThrow()
    }
    expect(() => devices.recognition.save(other, input(cloud(deviceId)))).toThrow(
      'Invalid device recognition configuration',
    )
    devices.detach(a, 1)
    expect(() => devices.recognition.read(a)).toThrow('inactive')
    expect(() => devices.recognition.save(a, input(null))).toThrow('inactive')
  })

  it('normalizes supported local origins without probing and refuses credentials, arbitrary paths or remote endpoints', async () => {
    const { devices, workspaces } = setup()
    const a = await authority(workspaces, 'a')
    devices.attach(a, randomUUID(), 0)
    const local = {
      provider: 'local-yolo',
      frequency: 1,
      requestBudget: 20,
      credentialRef: null,
      baseUrl: 'http://127.0.0.1:8000',
    }
    expect(devices.recognition.save(a, input(local)).settings).toEqual({
      ...local,
      baseUrl: 'http://127.0.0.1:8000/',
    })
    expect(devices.recognition.view(a).settings).toEqual({
      provider: 'local-yolo',
      frequency: 1,
      requestBudget: 20,
      credentialConfigured: false,
      baseUrl: 'http://127.0.0.1:8000/',
    })
    for (const baseUrl of [
      'http://user:password@127.0.0.1/',
      'http://127.0.0.1/a',
      'http://127.1/',
      'http://2130706433/',
      'http://169.254.169.254/',
      'http://8.8.8.8/',
      'http://127.0.0.1:0/',
      'http://127.0.0.1/?token=private',
      'http://127.0.0.1/#fragment',
      'ftp://127.0.0.1/',
    ]) {
      expect(() => devices.recognition.save(a, input({ ...local, baseUrl }, 1))).toThrow(
        'Invalid device recognition configuration',
      )
    }
    expect(devices.recognition.read(a).configRevision).toBe(1)
    const privateLocal = { ...local, baseUrl: 'https://192.168.1.10:8000/', frequency: 0.5 }
    expect(devices.recognition.save(a, input(privateLocal, 1)).settings).toEqual(privateLocal)
  })

  it('refuses extra fields, unsafe bounds and malformed stored data without exposing input', async () => {
    const { devices, workspaces, table } = setup()
    const a = await authority(workspaces, 'a')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    const settings = cloud(deviceId)
    for (const bad of [
      { ...settings, accessKeySecret: 'synthetic-only' },
      { ...settings, frequency: 10 },
      { ...settings, requestBudget: 0 },
      { ...settings, requestBudget: 1.5 },
      { ...settings, requestBudget: 100001 },
    ])
      expect(() => devices.recognition.save(a, input(bad))).toThrow(
        'Invalid device recognition configuration',
      )
    expect(() => devices.recognition.save(a, { ...input(settings), extra: true } as never)).toThrow(
      'Invalid device recognition configuration',
    )
    devices.recognition.save(a, input(settings))
    expect(devices.recognition.references(deviceId, settings.credentialRef)).toBe(true)
    for (const corrupt of [
      'not-json-synthetic-only',
      '{}',
      '[]',
      JSON.stringify({ ...settings, credentialRef: 'other' }),
    ]) {
      table.exec('UPDATE device_recognition_profiles SET settings_json = ? WHERE device_id = ?', [
        corrupt,
        deviceId,
      ])
      expect(() => devices.recognition.read(a)).toThrow('Invalid device recognition configuration')
      expect(() => devices.recognition.references(deviceId, settings.credentialRef)).toThrow(
        'Invalid device recognition configuration',
      )
    }
  })

  it('rolls back failed writes and rejects revision overflow', async () => {
    const { devices, workspaces, table } = setup()
    const a = await authority(workspaces, 'a')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    table.exec(
      `CREATE TRIGGER reject_recognition BEFORE INSERT ON device_recognition_profiles BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`,
    )
    expect(() => devices.recognition.save(a, input(cloud(deviceId)))).toThrow('storage unavailable')
    expect(devices.recognition.read(a).configRevision).toBe(0)
    table.exec('DROP TRIGGER reject_recognition')
    devices.recognition.save(a, input(cloud(deviceId)))
    table.exec('UPDATE device_recognition_profiles SET config_revision = ? WHERE device_id = ?', [
      Number.MAX_SAFE_INTEGER,
      deviceId,
    ])
    expect(() => devices.recognition.save(a, input(null, Number.MAX_SAFE_INTEGER))).toThrow('revision')
    expect(devices.recognition.read(a).settings?.provider).toBe('aliyun')
  })

  it('reopens durable settings through the real SQLite fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-device-recognition-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'recognition.sqlite')
    const initial = setup(path)
    const a = await authority(initial.workspaces, 'a')
    const deviceId = randomUUID()
    initial.devices.attach(a, deviceId, 0)
    const saved = initial.devices.recognition.save(a, input(cloud(deviceId)))
    await initial.tables.close()
    const reopened = setup(path)
    const restored = await reopened.workspaces.restoreBinding('a')
    expect(reopened.devices.recognition.read(restored)).toEqual(saved)
    await reopened.tables.close()
  })
  it('emits only committed redacted recognition changes, not retries or conflicts', async () => {
    const changed = vi.fn()
    const { devices, workspaces } = setup(undefined, undefined, undefined, changed)
    const a = await authority(workspaces, 'a')
    const deviceId = randomUUID()
    devices.attach(a, deviceId, 0)
    const settings = cloud(deviceId)
    devices.recognition.save(a, input(settings))
    devices.recognition.save(a, input(settings))
    expect(() => devices.recognition.save(a, input(null))).toThrow('revision')
    expect(changed.mock.calls.map(([view]) => view.configRevision)).toEqual([1])
    const view = changed.mock.calls[0]?.[0]
    expect(view).toEqual(devices.recognition.view(a))
    expect(JSON.stringify(view)).not.toContain('secret://')
    expect(Object.isFrozen(view.settings)).toBe(true)
    devices.recognition.save(a, input(null, 1))
    expect(changed.mock.calls.map(([view]) => [view.configRevision, view.settings])).toEqual([
      [1, view.settings],
      [2, null],
    ])
    changed.mockImplementationOnce(() => {
      throw new Error('notification unavailable')
    })
    expect(() => devices.recognition.save(a, input(settings, 2))).toThrow('notification unavailable')
    expect(devices.recognition.read(a)).toMatchObject({ configRevision: 3, settings })
  })
})

describe('durable device recognition reservation rounds', () => {
  async function configured(path?: string) {
    const fixture = setup(path)
    const a = await authority(fixture.workspaces, 'a')
    const b = await authority(fixture.workspaces, 'b')
    const deviceId = randomUUID()
    fixture.devices.attach(a, deviceId, 0)
    fixture.devices.attach(b, deviceId, 1)
    const settings = {
      provider: 'aliyun',
      frequency: 2,
      requestBudget: 2,
      credentialRef: `secret://aka-robot/device-${deviceId}-${randomUUID()}`,
    }
    fixture.devices.recognition.save(a, { expectedBindingRevision: 1, expectedConfigRevision: 0, settings })
    return { ...fixture, a, b, deviceId, settings }
  }
  const start = () => ({
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    expectedRoundRevision: 0,
    startId: randomUUID(),
  })
  const claim = () => ({
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    expectedRoundRevision: 1,
    attemptId: randomUUID(),
  })
  it('shares an explicit round across enrolled sessions and refuses repeat attempts without double admission', async () => {
    const { devices, a, b } = await configured()
    expect(devices.recognitionBudget.read(a)).toBeNull()
    expect(() => devices.recognitionBudget.reserve(a, claim())).toThrow('revision')
    const input = start()
    expect(devices.recognitionBudget.start(a, input)).toMatchObject({
      roundRevision: 1,
      reserved: 0,
      budget: 2,
    })
    const attempt = claim()
    expect(devices.recognitionBudget.reserve(a, attempt)).toMatchObject({
      granted: true,
      round: { reserved: 1 },
    })
    expect(devices.recognitionBudget.reserve(b, attempt)).toMatchObject({
      granted: false,
      round: { reserved: 1 },
    })
    expect(devices.recognitionBudget.start(b, input)).toMatchObject({ reserved: 1 })
    expect(devices.recognitionBudget.reserve(b, claim())).toMatchObject({
      granted: true,
      round: { reserved: 2 },
    })
    expect(devices.recognitionBudget.reserve(a, claim())).toMatchObject({
      granted: false,
      round: { reserved: 2 },
    })
    expect(Object.isFrozen(devices.recognitionBudget.read(a))).toBe(true)
    expect(() => devices.recognitionBudget.start(a, start())).toThrow('revision')
    expect(devices.recognitionBudget.start(a, { ...start(), expectedRoundRevision: 1 })).toMatchObject({
      roundRevision: 2,
      reserved: 0,
    })
    expect(() => devices.recognitionBudget.reserve(a, claim())).toThrow('revision')
  })
  it('preserves consumed reservations across config changes, lowered caps and clear/save', async () => {
    const { devices, a, settings } = await configured()
    devices.recognitionBudget.start(a, start())
    devices.recognitionBudget.reserve(a, claim())
    const save = (settings: unknown, expectedConfigRevision: number) =>
      devices.recognition.save(a, { expectedBindingRevision: 1, expectedConfigRevision, settings })
    save({ ...settings, requestBudget: 1 }, 1)
    expect(() => devices.recognitionBudget.reserve(a, claim())).toThrow('revision')
    expect(devices.recognitionBudget.reserve(a, { ...claim(), expectedConfigRevision: 2 })).toMatchObject({
      granted: false,
      round: { reserved: 1 },
    })
    save({ ...settings, requestBudget: 100 }, 2)
    expect(devices.recognitionBudget.reserve(a, { ...claim(), expectedConfigRevision: 3 })).toMatchObject({
      granted: true,
      round: { reserved: 2, budget: 2 },
    })
    expect(devices.recognitionBudget.reserve(a, { ...claim(), expectedConfigRevision: 3 })).toMatchObject({
      granted: false,
    })
    save(null, 3)
    expect(() => devices.recognitionBudget.reserve(a, { ...claim(), expectedConfigRevision: 4 })).toThrow(
      'revision',
    )
    save(settings, 4)
    expect(devices.recognitionBudget.read(a)).toMatchObject({ reserved: 2, budget: 2 })
    expect(devices.recognitionBudget.reserve(a, { ...claim(), expectedConfigRevision: 5 })).toMatchObject({
      granted: false,
    })
  })
  it('rejects ordinary/detached authorities, private selectors, malformed ids and bounds', async () => {
    const { devices, a, workspaces } = await configured()
    devices.recognitionBudget.start(a, start())
    const ordinary = await authority(workspaces, 'ordinary')
    expect(() => devices.recognitionBudget.read(ordinary)).toThrow('inactive')
    for (const input of [
      { ...claim(), attemptId: '' },
      { ...claim(), attemptId: { toString: () => randomUUID() } },
      { ...claim(), expectedRoundRevision: 0 },
      { ...claim(), deviceId: randomUUID() },
    ])
      expect(() => devices.recognitionBudget.reserve(a, input as never)).toThrow(
        'Invalid device recognition budget',
      )
    devices.detach(a, 1)
    expect(() => devices.recognitionBudget.read(a)).toThrow('inactive')
  })
  it('rolls back failed reservations and refuses inconsistent or overflowing persisted rounds', async () => {
    const { devices, a, deviceId, table } = await configured()
    devices.recognitionBudget.start(a, start())
    table.exec(
      `CREATE TRIGGER fail_budget BEFORE UPDATE ON device_recognition_rounds BEGIN SELECT RAISE(ABORT, 'budget storage unavailable'); END`,
    )
    expect(() => devices.recognitionBudget.reserve(a, claim())).toThrow('budget storage unavailable')
    table.exec('DROP TRIGGER fail_budget')
    expect(devices.recognitionBudget.read(a)).toMatchObject({ reserved: 0 })
    const priorAttempt = claim()
    devices.recognitionBudget.reserve(a, priorAttempt)
    table.exec(
      `CREATE TRIGGER fail_round BEFORE UPDATE ON device_recognition_rounds BEGIN SELECT RAISE(ABORT, 'round storage unavailable'); END`,
    )
    expect(() => devices.recognitionBudget.start(a, { ...start(), expectedRoundRevision: 1 })).toThrow(
      'round storage unavailable',
    )
    table.exec('DROP TRIGGER fail_round')
    expect(devices.recognitionBudget.reserve(a, priorAttempt)).toMatchObject({
      granted: false,
      round: { roundRevision: 1, reserved: 1 },
    })
    table.exec('UPDATE device_recognition_rounds SET reserved = 0 WHERE device_id = ?', [deviceId])
    expect(() => devices.recognitionBudget.read(a)).toThrow('Invalid device recognition budget')
    table.exec('UPDATE device_recognition_rounds SET reserved = 1, round_revision = ? WHERE device_id = ?', [
      Number.MAX_SAFE_INTEGER,
      deviceId,
    ])
    table.exec('UPDATE device_recognition_reservations SET round_revision = ? WHERE device_id = ?', [
      Number.MAX_SAFE_INTEGER,
      deviceId,
    ])
    expect(() =>
      devices.recognitionBudget.start(a, { ...start(), expectedRoundRevision: Number.MAX_SAFE_INTEGER }),
    ).toThrow('revision')
  })
  it('reopens the actual SQLite reservation round without granting an old attempt again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-recognition-budget-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'budget.sqlite')
    const initial = await configured(path)
    const input = start()
    initial.devices.recognitionBudget.start(initial.a, input)
    const attempt = claim()
    initial.devices.recognitionBudget.reserve(initial.a, attempt)
    await initial.tables.close()
    const reopened = setup(path)
    const a = await reopened.workspaces.restoreBinding('a')
    expect(reopened.devices.recognitionBudget.start(a, input)).toMatchObject({ reserved: 1 })
    expect(reopened.devices.recognitionBudget.reserve(a, attempt)).toMatchObject({
      granted: false,
      round: { reserved: 1 },
    })
    expect(reopened.devices.recognitionBudget.reserve(a, claim())).toMatchObject({
      granted: true,
      round: { reserved: 2 },
    })
    await reopened.tables.close()
  })
})
