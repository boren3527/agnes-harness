import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalArtifactReadStore, pluginRowSource } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { type CaptureSelection, DeviceCaptureRecords } from '../src/storage/device-captures.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { workerDeviceCaptureSelection } from '../src/supervisor/device-capture-selection.js'
import type { WorkerServiceEffectScope } from '../src/supervisor/worker-link.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const identity = { principalId: 'owner', sessionId: 'session', commandId: 'capture-command' }
async function publicationFixture(service = 'aka.capture') {
  const v = await effectFixture(service)
  await v.run(v.select)
  v.deps.inspector = { inspect: async () => candidate().artifact }
  await v.run({ callId: v.scope.callId, operation: 'stored' })
  const event: EventEnvelope = {
    seq: 42,
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z04',
    ts: '2026-10-10T00:00:00.000Z',
    type: 'x/core/device-capture',
    v: 1,
    lane: 'main',
    origin: 'system',
    trust: 'trusted',
    ignorable: true,
    actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    data: { captureId: v.deps.bindings.captures.publicationId(identity), ref: candidate().artifact },
  }
  const readEvent = vi.fn(async (_key: string, _seq: number, _signal: AbortSignal) => event)
  const publicationAuthority = vi.fn(
    async (_key: string, _principal: string, _event: EventEnvelope, _signal: AbortSignal) => {},
  )
  v.deps.eventRead = readEvent
  v.deps.publicationAuthority = publicationAuthority
  return {
    ...v,
    event,
    readEvent,
    publicationAuthority,
    recorded: { callId: v.scope.callId, operation: 'recorded', eventSeq: 42 },
  }
}
it.each(['aka.capture', 'aka.recognition.test'])(
  'records only a matching durable event with confirmed owner-scoped original for %s',
  async (service) => {
    const v = await publicationFixture(service)
    expect(await v.run(v.recorded)).toMatchObject({ stage: 'recorded', eventSeq: 42 })
    expect(await v.run(v.recorded)).toMatchObject({ stage: 'recorded', eventSeq: 42 })
    expect(v.readEvent.mock.calls[0]?.slice(0, 2)).toEqual(['session', 42])
    expect(v.publicationAuthority.mock.calls[0]?.slice(0, 2)).toEqual(['session', 'owner'])
  },
)
it.each([
  'missing-read',
  'missing-authority',
  'seq',
  'id',
  'ref',
  'trust',
  'lane',
  'grant',
  'cancel',
  'config',
] as const)('refuses %s recorded acknowledgement without advancing the stored record', async (mode) => {
  const v = await publicationFixture()
  if (mode === 'missing-read') delete v.deps.eventRead
  if (mode === 'missing-authority') delete v.deps.publicationAuthority
  if (mode === 'seq') v.event.seq = 43
  if (mode === 'id')
    v.event.data = { captureId: '22222222-2222-4222-8222-222222222222', ref: candidate().artifact }
  if (mode === 'ref')
    v.event.data = {
      captureId: v.deps.bindings.captures.publicationId(identity),
      ref: { ...candidate().artifact, size: 1 },
    }
  if (mode === 'trust') v.event.trust = 'untrusted'
  if (mode === 'lane') v.event.lane = 'other'
  v.publicationAuthority.mockImplementation(async () => {
    if (mode === 'grant') throw new Error('private authority error')
    if (mode === 'cancel') v.ac.abort()
    if (mode === 'config')
      v.deps.bindings.saveConnection(v.authority, {
        sessionId: 'session',
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        ip: '192.168.1.43',
        port: 80,
        macAddress: '12:34:56:78:90:ab',
      })
  })
  await expect(v.run(v.recorded)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(v.deps.bindings.captures.read(identity)).toMatchObject({ stage: 'stored', eventSeq: null })
})
const candidate = (): CaptureSelection => ({
  deviceId: '11111111-1111-4111-8111-111111111111',
  bindingRevision: 1,
  configRevision: 1,
  frameId: 'current-media-frame-1',
  width: 320,
  height: 240,
  selectedAt: '2026-10-10T00:00:00.000Z',
  timeBasis: 'bridge_receive',
  ageAtSelectionMs: 20,
  artifact: { sha256: 'a'.repeat(64), size: 3000, mime: 'image/jpeg' },
})
function fixture(path?: string) {
  const tables = sqliteTables(path)
  cleanup.push(() => tables.close())
  const table = tables.table('device_captures')
  return { tables, table, records: new DeviceCaptureRecords(table) }
}
it('persists selection, stored original and actual event coordinates across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-capture-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'records.sqlite')
  const first = fixture(path),
    selected = candidate()
  expect(first.records.select(identity, selected)).toMatchObject({
    fresh: true,
    record: { stage: 'selected', eventSeq: null },
  })
  await first.tables.close()
  const second = fixture(path)
  expect(second.records.select(identity, candidate())).toMatchObject({
    fresh: false,
    record: { stage: 'selected' },
  })
  expect(second.records.stored(identity, candidate().artifact).stage).toBe('stored')
  const captureId = second.records.publicationId(identity)
  expect(captureId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  second.records.stored(identity, candidate().artifact)
  expect(second.records.publicationId(identity)).toBe(captureId)
  await second.tables.close()
  const third = fixture(path)
  expect(third.records.read(identity)?.stage).toBe('stored')
  expect(third.records.publicationId(identity)).toBe(captureId)
  expect(third.records.publicationId({ ...identity, principalId: 'other' })).toBeNull()
  expect(third.records.publicationId({ ...identity, sessionId: 'other' })).toBeNull()
  expect(third.records.recorded(identity, 42)).toMatchObject({ stage: 'recorded', eventSeq: 42 })
  expect(third.records.recorded(identity, 42).eventSeq).toBe(42)
  expect(() => third.records.recorded(identity, 43)).toThrow('unavailable')
  expect(third.records.stored(identity, candidate().artifact).stage).toBe('recorded')
  expect(third.records.publicationId(identity)).toBe(captureId)
})
it('does not replace a selected frame or confuse the same command in another owner/session', () => {
  const { records } = fixture()
  const chosen = candidate()
  const original = records.select(identity, chosen).record
  expect(Object.isFrozen(original.selection.artifact)).toBe(true)
  expect(original.selection.artifact).not.toBe(chosen.artifact)
  expect(() => records.select(identity, { ...candidate(), frameId: 'later-frame' })).toThrow('unavailable')
  expect(records.read({ ...identity, principalId: 'other' })).toBeNull()
  expect(records.read({ ...identity, sessionId: 'other' })).toBeNull()
  expect(() => records.recorded(identity, 42)).toThrow('unavailable')
  expect(() => records.stored(identity, { ...candidate().artifact, sha256: 'b'.repeat(64) })).toThrow(
    'unavailable',
  )
  expect(records.read(identity)?.stage).toBe('selected')
})
it('recovers legacy stored bytes with one identity but refuses to invent an identity for a recorded event', () => {
  const { records, table } = fixture()
  records.select(identity, candidate())
  table.exec("UPDATE device_capture_records SET stage = 'stored'")
  expect(records.publicationId(identity)).toBeNull()
  records.stored(identity, candidate().artifact)
  const id = records.publicationId(identity)
  expect(id).toEqual(expect.any(String))
  records.stored(identity, candidate().artifact)
  expect(records.publicationId(identity)).toBe(id)
  table.exec('DELETE FROM device_capture_publications')
  table.exec("UPDATE device_capture_records SET stage = 'recorded', event_seq = 42")
  expect(() => records.stored(identity, candidate().artifact)).toThrow('unavailable')
  expect(() => records.recorded(identity, 42)).toThrow('unavailable')
  expect(records.publicationId(identity)).toBeNull()
  expect(records.read(identity)).toMatchObject({ stage: 'recorded', eventSeq: 42 })
})
it('rolls back storage confirmation when its durable publication identity cannot be saved', () => {
  const { records, table } = fixture()
  records.select(identity, candidate())
  const exec = table.exec.bind(table)
  const fault = vi.spyOn(table, 'exec').mockImplementation((sql, params) => {
    if (sql.includes('INSERT INTO device_capture_publications')) throw new Error('disk failure')
    exec(sql, params)
  })
  expect(() => records.stored(identity, candidate().artifact)).toThrow('disk failure')
  expect(records.read(identity)?.stage).toBe('selected')
  expect(records.publicationId(identity)).toBeNull()
  fault.mockRestore()
  records.stored(identity, candidate().artifact)
  expect(records.publicationId(identity)).toEqual(expect.any(String))
})
it('refuses corrupt publication identity without replacing it or acknowledging an event', () => {
  const { records, table } = fixture()
  records.select(identity, candidate())
  records.stored(identity, candidate().artifact)
  table.exec("UPDATE device_capture_publications SET capture_id = 'invalid'")
  expect(() => records.publicationId(identity)).toThrow('unavailable')
  expect(() => records.stored(identity, candidate().artifact)).toThrow('unavailable')
  expect(() => records.recorded(identity, 42)).toThrow('unavailable')
  expect(records.read(identity)).toMatchObject({ stage: 'stored', eventSeq: null })
})
it.each(['extra', 'bad-size', 'bad-date', 'bad-device', 'accessor', 'old-frame'])(
  'refuses malformed selection %s without inserting a record',
  (kind) => {
    const { records } = fixture()
    const bad = { ...candidate() }
    if (kind === 'extra') Object.assign(bad, { secret: 'not permitted' })
    if (kind === 'bad-size') bad.artifact = { ...bad.artifact, size: 4 * 1024 * 1024 + 1 }
    if (kind === 'bad-date') bad.selectedAt = '2026-02-30T00:00:00.000Z'
    if (kind === 'bad-device') bad.deviceId = 'arbitrary'
    if (kind === 'old-frame') bad.ageAtSelectionMs = 1001
    if (kind === 'accessor') Object.defineProperty(bad, 'frameId', { enumerable: true, get: () => 'forged' })
    expect(() => records.select(identity, bad)).toThrow('unavailable')
    expect(records.read(identity)).toBeNull()
  },
)
it('refuses corrupt persisted metadata rather than treating it as a fresh operation', () => {
  const { records, table } = fixture()
  records.select(identity, candidate())
  table.exec('UPDATE device_capture_records SET selection = ?', ['{"artifact":{}}'])
  expect(() => records.read(identity)).toThrow('unavailable')
  expect(() => records.select(identity, candidate())).toThrow('unavailable')
})

async function effectFixture(service = 'aka.capture') {
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
  const authority = await workspaces.authorizeAndBind('session', '/repo/a')
  bindings.attach(authority, candidate().deviceId, 0)
  bindings.saveConnection(authority, {
    sessionId: 'session',
    expectedBindingRevision: 1,
    expectedConfigRevision: 0,
    ip: '192.168.1.42',
    port: 80,
    macAddress: '12:34:56:78:90:ab',
  })
  ownership.bindNew('session', 'owner')
  ownership.activateNew('session', 'owner')
  const ac = new AbortController()
  const scope: WorkerServiceEffectScope = {
    callId: 'a'.repeat(32),
    sessionKey: 'session',
    commandId: 'capture-command',
    extension: pluginRowSource('ext:agnes-examples/aka-robot'),
    service,
    revoked: ac.signal,
  }
  const deps: Parameters<typeof workerDeviceCaptureSelection>[0] & { bindings: DeviceBindingIndex } = {
    bindings,
    ownership,
    workspaces,
  }
  const run = (params: unknown, proof: WorkerServiceEffectScope | undefined = scope) =>
    workerDeviceCaptureSelection(deps, 'session', params, proof)
  const select = { callId: scope.callId, operation: 'select', selection: candidate() }
  const read = { callId: scope.callId, operation: 'read' }
  return { deps, scope, ac, authority, select, read, run }
}
it('denies new selection in recovery scope while allowing readback of the same original', async () => {
  const v = await effectFixture()
  const scope = { ...v.scope, recoverOnly: true as const }
  await expect(v.run(v.select, scope)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(v.deps.bindings.captures.read(identity)).toBeNull()
  await v.run(v.select)
  await expect(v.run(v.read, scope)).resolves.toMatchObject({ selection: candidate(), stage: 'selected' })
  await expect(
    v.run({ ...v.select, selection: { ...candidate(), frameId: 'new-frame' } }, scope),
  ).rejects.toThrow()
  expect(v.deps.bindings.captures.read(identity)?.selection).toEqual(candidate())
})

it('persists exact selection under the daemon command and never acknowledges blob/event completion', async () => {
  const v = await effectFixture()
  expect(await v.run(v.read)).toBeNull()
  expect(await v.run(v.select)).toMatchObject({ fresh: true, record: { stage: 'selected', eventSeq: null } })
  expect(await v.run(v.select)).toMatchObject({ fresh: false, record: { stage: 'selected' } })
  await expect(v.run({ ...v.select, selection: { ...candidate(), frameId: 'later' } })).rejects.toThrow()
  expect(await v.run(v.read)).toMatchObject({ selection: { frameId: candidate().frameId } })
  expect(v.deps.bindings.captures.read({ ...identity, commandId: 'other' })).toBeNull()
  v.deps.bindings.saveConnection(v.authority, {
    sessionId: 'session',
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    ip: '192.168.1.43',
    port: 80,
    macAddress: '12:34:56:78:90:ab',
  })
  await expect(v.run(v.read)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(v.deps.bindings.captures.read(identity)?.selection.frameId).toBe(candidate().frameId)
})
it.each(['missing', 'nonce', 'session', 'plugin', 'service', 'revoked', 'selector', 'ack'] as const)(
  'refuses %s capture authority before persistence',
  async (mode) => {
    const v = await effectFixture()
    const scope = { ...v.scope }
    const input = { ...v.select }
    if (mode === 'nonce') scope.callId = 'b'.repeat(32)
    if (mode === 'session') scope.sessionKey = 'other'
    if (mode === 'plugin') scope.extension = 'plugin/other'
    if (mode === 'service') scope.service = 'aka.status'
    if (mode === 'revoked') v.ac.abort()
    if (mode === 'selector') Object.assign(input, { commandId: 'other', principalId: 'other' })
    if (mode === 'ack') Object.assign(input, { operation: 'stored' })
    await expect(
      workerDeviceCaptureSelection(v.deps, 'session', input, mode === 'missing' ? undefined : scope),
    ).rejects.toThrow()
    expect(v.deps.bindings.captures.read(identity)).toBeNull()
  },
)
it.each(['binding', 'config', 'device', 'metadata'] as const)(
  'refuses %s mismatch without selecting a frame',
  async (mode) => {
    const v = await effectFixture()
    const selection = { ...candidate() }
    if (mode === 'binding') selection.bindingRevision++
    if (mode === 'config') selection.configRevision++
    if (mode === 'device') selection.deviceId = '22222222-2222-4222-8222-222222222222'
    if (mode === 'metadata') Object.assign(selection, { eventSeq: 1 })
    await expect(v.run({ ...v.select, selection })).rejects.toThrow()
    expect(v.deps.bindings.captures.read(identity)).toBeNull()
  },
)
it.each(['cancel', 'owner', 'wrong-workspace', 'configuration', 'private-error'] as const)(
  'rechecks capture continuity after workspace lookup: %s',
  async (mode) => {
    const v = await effectFixture()
    const restore = v.deps.workspaces.restoreBinding.bind(v.deps.workspaces)
    vi.spyOn(v.deps.workspaces, 'restoreBinding').mockImplementation(async (key) => {
      const authority = await restore(key)
      if (mode === 'cancel') v.ac.abort()
      if (mode === 'owner')
        vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue({ active: true, principalId: 'other' })
      if (mode === 'configuration')
        v.deps.bindings.saveConnection(authority, {
          sessionId: key,
          expectedBindingRevision: 1,
          expectedConfigRevision: 1,
          ip: '192.168.1.43',
          port: 80,
          macAddress: '12:34:56:78:90:ab',
        })
      if (mode === 'private-error') throw new Error('private database path and secret')
      return mode === 'wrong-workspace' ? { ...authority, sessionKey: 'other' } : authority
    })
    const error = await v.run(v.select).catch((error: unknown) => error)
    expect(error).toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(JSON.stringify(error)).not.toContain('private database')
    expect(v.deps.bindings.captures.read(identity)).toBeNull()
  },
)
it('redacts an ownership store failure before workspace resolution', async () => {
  const v = await effectFixture()
  vi.spyOn(v.deps.ownership, 'resolve').mockImplementation(() => {
    throw new Error('private owner database path')
  })
  const restore = vi.spyOn(v.deps.workspaces, 'restoreBinding')
  await expect(v.run(v.select)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(restore).not.toHaveBeenCalled()
  expect(v.deps.bindings.captures.read(identity)).toBeNull()
})

it('acknowledges only the exact persisted CAS bytes and leaves session publication unconfirmed', async () => {
  const v = await effectFixture()
  const directory = await mkdtemp(join(tmpdir(), 'agh-capture-bytes-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('exact persisted bytes')
  const ref = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mime: 'image/jpeg',
  }
  const path = join(directory, 'artifacts', 'sha256', ref.sha256.slice(0, 2))
  const reader = createLocalArtifactReadStore({ dataDir: directory, maxArtifactBytes: 4 * 1024 * 1024 })
  v.deps.inspector = { inspect: reader.inspect.bind(reader) }
  await v.run({ ...v.select, selection: { ...candidate(), artifact: ref } })
  const stored = { callId: v.scope.callId, operation: 'stored' }
  await expect(v.run(stored)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(v.deps.bindings.captures.read(identity)?.stage).toBe('selected')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, ref.sha256), bytes)
  expect(await v.run(stored)).toMatchObject({ stage: 'stored', eventSeq: null, selection: { artifact: ref } })
  const publication = { callId: v.scope.callId, operation: 'publication' }
  const prepared = await v.run(publication)
  expect(prepared).toMatchObject({
    captureId: expect.any(String),
    record: { stage: 'stored', eventSeq: null },
  })
  expect(await v.run(publication)).toEqual(prepared)
  await expect(v.run({ ...publication, captureId: 'worker-chosen' })).rejects.toThrow()
  // Inspector verifies persisted bytes, not image decoding, frame freshness or session ownership grants.
  await writeFile(join(path, ref.sha256), new TextEncoder().encode('different file bytes'))
  await expect(v.run(stored)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  await expect(v.run(publication)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(v.deps.bindings.captures.read(identity)?.stage).toBe('stored')
})
it.each(['size', 'extra', 'cancel', 'configuration', 'owner'] as const)(
  'refuses %s actual-storage acknowledgement after inspection without advancing phase',
  async (mode) => {
    const v = await effectFixture()
    await v.run(v.select)
    v.deps.inspector = {
      inspect: async () => {
        if (mode === 'cancel') v.ac.abort()
        if (mode === 'configuration')
          v.deps.bindings.saveConnection(v.authority, {
            sessionId: 'session',
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            ip: '192.168.1.43',
            port: 80,
            macAddress: '12:34:56:78:90:ab',
          })
        if (mode === 'owner')
          vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue({ active: true, principalId: 'other' })
        return {
          ...candidate().artifact,
          ...(mode === 'size' ? { size: candidate().artifact.size + 1 } : {}),
          ...(mode === 'extra' ? { privatePath: 'secret' } : {}),
        }
      },
    }
    await expect(v.run({ callId: v.scope.callId, operation: 'stored' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(v.deps.bindings.captures.read(identity)?.stage).toBe('selected')
  },
)

it('allows recognition test original persistence but never recognition recovery or continuous writes', async () => {
  const v = await effectFixture()
  const recognition = { ...v.scope, service: 'aka.recognition.test' }
  await expect(v.run(v.select, recognition)).resolves.toMatchObject({ fresh: true })
  await expect(v.run(v.read, recognition)).resolves.toMatchObject({ stage: 'selected' })
  for (const proof of [
    { ...recognition, recoverOnly: true as const },
    { ...recognition, service: 'aka.recognition.enable' },
  ])
    await expect(v.run(v.read, proof)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})
