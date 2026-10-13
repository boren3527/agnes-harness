import type { Event, EventInput, ScanQuery, SeamImplementations, WorkspaceInvocationView } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { DeviceRecognitionBudgetRequest, ExtensionManifest, ServiceContext } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDeviceCapturePublisher,
  type DeviceCapturePublisher,
} from '../../src/ext-host/device-capture-publisher.js'
import { recognitionIOAuthorization } from '../../src/ext-host/device-recognition-authorization.js'
import { leaseFor } from '../../src/ext-host/lease.js'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { serviceContext } from '../../src/ext-host/service-context.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

afterEach(() => vi.unstubAllGlobals())

function captureFixture(publish?: DeviceCapturePublisher) {
  const base = fixture()
  const bytes = readFileSync(new URL('../fixtures/aka-camera-test.jpg', import.meta.url))
  const selection: DeviceCaptureSelection = {
    deviceId: deviceSnapshot().session.deviceId,
    bindingRevision: 1,
    configRevision: 1,
    frameId: 'media-1',
    width: 320,
    height: 240,
    selectedAt: '2026-10-10T00:00:00.000Z',
    timeBasis: 'bridge_receive',
    ageAtSelectionMs: 20,
    artifact: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mime: 'image/jpeg',
    },
  }
  const connection = {
    deviceId: selection.deviceId,
    bindingRevision: 1,
    profile: {
      driver: 'aka-00',
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
      configRevision: 1,
    },
  }
  const reader = vi.fn(async (_key: string, _signal: AbortSignal, view?: string) =>
    view ? connection : deviceSnapshot(),
  )
  let saved: DeviceCaptureRecord | null = null
  const bridge = vi.fn(async (_key: string, _callId: string, input: unknown) => {
    const p = input as { operation: string; selection?: DeviceCaptureSelection; eventSeq?: number }
    if (p.operation === 'read') return saved
    if (p.operation === 'select') {
      if (!p.selection) throw new Error('missing selection')
      const fresh = saved === null
      saved ??= { selection: p.selection, stage: 'selected', eventSeq: null }
      return { fresh, record: saved }
    }
    if (!saved) throw new Error('no selection')
    if (p.operation === 'publication')
      return { captureId: '11111111-1111-4111-8111-111111111111', record: saved }
    if (p.operation === 'recorded') {
      saved = { ...saved, stage: 'recorded', eventSeq: p.eventSeq ?? null }
      return saved
    }
    saved = { ...saved, stage: 'stored' }
    return saved
  })
  const put = vi.spyOn(base.seams.artifacts, 'put').mockResolvedValue(selection.artifact)
  const build = serviceContext({
    seams: base.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: reader,
    deviceCaptureSelection: bridge,
    ...(publish ? { capturePublisher: publish } : {}),
  })
  const entry = {
    ...base.entry,
    owner: pluginRowSource('ext:agnes-examples/aka-robot'),
    manifest: {
      ...base.entry.manifest,
      capabilities: { ...base.entry.manifest.capabilities, artifacts: true },
    },
    capability: { ...base.entry.capability, name: 'aka.capture', kind: 'effect' as const },
  }
  const identity = { ...base.identity, session: { key: 'device-session', workspaceRoot: '/workspace' } }
  const admission = { commandId: 'capture-command', callId: 'a'.repeat(32) }
  const ctx = build(entry, identity, base.alive, base.workspace, admission)
  if (!ctx.captureArtifacts) throw new Error('missing capture port')
  return {
    ...base,
    bytes,
    selection,
    connection,
    reader,
    bridge,
    put,
    build,
    entry,
    identity,
    admission,
    ctx,
    port: ctx.captureArtifacts,
  }
}

it('refuses selecting or writing a new photo in the trusted recovery scope', async () => {
  const v = captureFixture()
  const ctx = v.build(v.entry, v.identity, v.alive, v.workspace, { ...v.admission, recoverOnly: true })
  const port = ctx.captureArtifacts
  if (!port) throw new Error('Missing capture recovery port')
  await expect(port.read()).rejects.toThrow('device capture storage unavailable')
  await expect(port.save(v.bytes, v.selection)).rejects.toThrow('device capture storage unavailable')
  expect(v.bridge.mock.calls.map((call) => (call[2] as { operation: string }).operation)).toEqual(['read'])
  expect(v.put).not.toHaveBeenCalled()
})

it('marks recognition originals without changing ordinary photo publication', async () => {
  for (const name of ['aka.capture', 'aka.recognition.test']) {
    const publish = vi.fn<DeviceCapturePublisher>(async () => 7)
    const v = captureFixture(publish)
    const ctx = v.build(
      { ...v.entry, capability: { ...v.entry.capability, name } },
      v.identity,
      v.alive,
      v.workspace,
      v.admission,
    )
    const port = ctx.captureArtifacts
    if (!port) throw new Error('Missing capture port')
    await port.save(v.bytes, v.selection)
    await port.publish()
    expect(publish.mock.calls[0]?.[6]).toBe(name === 'aka.recognition.test' ? 'recognition' : undefined)
  }
})

it('recovers and publishes the original photo without another blob write', async () => {
  const publish = vi.fn<DeviceCapturePublisher>(async (_key, _id, _ref, _actor, _signal, verify) => {
    await verify()
    return 7
  })
  const v = captureFixture(publish)
  await v.port.save(v.bytes, v.selection)
  const ctx = v.build(v.entry, v.identity, v.alive, v.workspace, { ...v.admission, recoverOnly: true })
  const port = ctx.captureArtifacts
  if (!port) throw new Error('Missing capture recovery port')
  await expect(port.read()).resolves.toMatchObject({ selection: v.selection, stage: 'stored' })
  await expect(port.recover()).resolves.toMatchObject({ selection: v.selection, stage: 'stored' })
  await expect(port.publish()).resolves.toMatchObject({
    selection: v.selection,
    stage: 'recorded',
    eventSeq: 7,
  })
  await expect(port.save(v.bytes, v.selection)).rejects.toThrow()
  expect(v.put).toHaveBeenCalledTimes(1)
})

it('publishes only the daemon-fixed original and requires recorded acknowledgement', async () => {
  const publish = vi.fn<DeviceCapturePublisher>(async (_key, _id, _ref, _actor, _signal, verify) => {
    await verify()
    return 7
  })
  const v = captureFixture(publish)
  await v.port.save(v.bytes, v.selection)
  await expect(v.port.publish()).resolves.toMatchObject({ stage: 'recorded', eventSeq: 7 })
  expect(publish.mock.calls[0]?.slice(0, 3)).toEqual([
    'device-session',
    '11111111-1111-4111-8111-111111111111',
    v.selection.artifact,
  ])
  expect(v.put).toHaveBeenCalledTimes(1)
})

function publicationFixture() {
  const v = captureFixture()
  const rows: Event[] = []
  const ac = new AbortController()
  const session = {
    scan: vi.fn(async (q: ScanQuery) => {
      const matching = rows.filter(
        (e) =>
          (q.fromSeq === undefined || e.seq >= q.fromSeq) &&
          (q.toSeq === undefined || e.seq <= q.toSeq) &&
          (!q.type || e.type === q.type) &&
          (!q.lane || e.lane === q.lane),
      )
      return (q.order === 'desc' ? matching.reverse() : matching).slice(0, q.limit)
    }),
    append: vi.fn(async (tx: EventInput[]) => {
      const firstSeq = rows.length + 1
      rows.push(
        ...tx.map((e, i) => ({
          ...e,
          seq: firstSeq + i,
          ts: '2026-10-10T00:00:00.000Z',
          id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z04',
        })),
      )
      return { firstSeq, seqs: tx.map((_, i) => firstSeq + i) }
    }),
  }
  let current: typeof session | undefined = session
  const publish = createDeviceCapturePublisher((key) => (key === 'device-session' ? current : undefined))
  const run = () =>
    publish(
      'device-session',
      '11111111-1111-4111-8111-111111111111',
      v.selection.artifact,
      v.identity.actor,
      ac.signal,
      async () => {},
    )
  return {
    ...v,
    rows,
    session,
    ac,
    run,
    replace: () => {
      current = undefined
    },
  }
}
it('uses the current session writer and recovers the same durable capture without another append', async () => {
  const v = publicationFixture()
  expect(await v.run()).toBe(1)
  expect(await v.run()).toBe(1)
  expect(v.session.append).toHaveBeenCalledTimes(1)
  expect(v.rows[0]).toMatchObject({
    type: 'x/core/device-capture',
    origin: 'system',
    trust: 'trusted',
    ignorable: true,
  })
})
it.each(['duplicate', 'wrong-ref', 'malformed-ref', 'replaced-session'] as const)(
  'refuses %s capture publication without appending a replacement',
  async (mode) => {
    const v = publicationFixture()
    await v.run()
    if (mode === 'duplicate') v.rows.push({ ...(v.rows[0] as Event), seq: 2 })
    if (mode === 'wrong-ref' || mode === 'malformed-ref')
      v.rows[0] = {
        ...(v.rows[0] as Event),
        data: {
          captureId: '11111111-1111-4111-8111-111111111111',
          ref: { ...v.selection.artifact, size: mode === 'malformed-ref' ? 0 : 1 },
        },
      }
    if (mode === 'replaced-session')
      v.session.scan.mockImplementation(async () => {
        v.replace()
        return []
      })
    await expect(v.run()).rejects.toThrow('device capture publication unavailable')
    expect(v.session.append).toHaveBeenCalledTimes(1)
  },
)
it('retains publication occupancy until a cancelled real append settles, then recovers its event', async () => {
  const v = publicationFixture()
  let complete!: () => void
  const gate = new Promise<void>((resolve) => {
    complete = resolve
  })
  const append = v.session.append.getMockImplementation()
  if (!append) throw new Error('missing append')
  v.session.append.mockImplementation(async (tx) => {
    await gate
    return append(tx)
  })
  const pending = v.run().catch((error) => error as Error)
  await vi.waitFor(() => expect(v.session.append).toHaveBeenCalledTimes(1))
  v.ac.abort()
  await expect(v.run()).rejects.toThrow()
  complete()
  const failed = await pending
  expect(failed).toBeInstanceOf(Error)
  if (!(failed instanceof Error)) throw new Error('expected cancelled publication')
  expect(failed.message).toBe('device capture publication unavailable')
  const recovered = createDeviceCapturePublisher(() => v.session)
  expect(
    await recovered(
      'device-session',
      '11111111-1111-4111-8111-111111111111',
      v.selection.artifact,
      v.identity.actor,
      new AbortController().signal,
      async () => {},
    ),
  ).toBe(1)
  expect(v.rows).toHaveLength(1)
})

it('copies the image before async selection, journals before writing and returns only stored metadata', async () => {
  const v = captureFixture()
  const original = Uint8Array.from(v.bytes)
  v.reader.mockImplementation(async (_key, _signal, view) => {
    v.bytes.fill(0)
    return view ? v.connection : deviceSnapshot()
  })
  v.put.mockImplementation(async (bytes) => {
    expect(v.bridge.mock.calls[0]?.[2]).toMatchObject({ operation: 'select' })
    expect(bytes).toEqual(original)
    return v.selection.artifact
  })
  v.identity.session.key = 'forged-later'
  v.admission.callId = 'b'.repeat(32)
  const result = await v.port.save(v.bytes, v.selection)
  expect(result).toMatchObject({ stage: 'stored', eventSeq: null, selection: v.selection })
  expect(Object.isFrozen(result.selection.artifact)).toBe(true)
  expect(v.bridge.mock.calls[0]?.slice(0, 2)).toEqual(['device-session', 'a'.repeat(32)])
  expect(JSON.stringify(v.ctx)).not.toContain('callId')
  expect(() => v.ctx.artifacts.put(original, { mime: 'image/jpeg' })).toThrow()
  await expect(v.port.read()).resolves.toEqual(result)
  await expect(v.port.recover()).resolves.toEqual(result)
  await expect(v.port.save(original, v.selection)).resolves.toEqual(result)
  expect(v.put).toHaveBeenCalledTimes(1)
})

it.each(['query', 'plugin', 'service', 'artifacts', 'nonce', 'admission', 'session'] as const)(
  'does not expose capture writes for %s',
  (mode) => {
    const v = captureFixture()
    const entry = {
      ...v.entry,
      capability: { ...v.entry.capability, kind: v.entry.capability.kind as 'effect' | 'query' },
      manifest: { ...v.entry.manifest, capabilities: { ...v.entry.manifest.capabilities } },
    }
    if (mode === 'query') entry.capability.kind = 'query'
    if (mode === 'plugin') entry.owner = 'plugin/other'
    if (mode === 'service') entry.capability.name = 'aka.status'
    if (mode === 'artifacts') entry.manifest.capabilities.artifacts = false
    if (mode === 'nonce') v.admission.callId = 'invalid'
    const { session, ...withoutSession } = v.identity
    const identity = mode === 'session' ? withoutSession : { ...withoutSession, session }
    const ctx = v.build(entry, identity, v.alive, v.workspace, mode === 'admission' ? undefined : v.admission)
    expect(ctx.captureArtifacts).toBeUndefined()
    expect(v.bridge).not.toHaveBeenCalled()
    expect(v.put).not.toHaveBeenCalled()
  },
)
it.each(['hash', 'size', 'dimensions', 'extra', 'device', 'permission'] as const)(
  'rejects invalid capture %s before a blob write',
  async (mode) => {
    const v = captureFixture(),
      selection = { ...v.selection, artifact: { ...v.selection.artifact } }
    if (mode === 'hash') selection.artifact.sha256 = 'b'.repeat(64)
    if (mode === 'size') selection.artifact.size++
    if (mode === 'dimensions') selection.width++
    if (mode === 'extra') Object.assign(selection, { commandId: 'forged' })
    if (mode === 'device') selection.deviceId = '22222222-2222-4222-8222-222222222222'
    if (mode === 'permission')
      vi.spyOn(v.seams.principals, 'authorize').mockResolvedValue({
        decisionId: 'deny',
        effect: 'deny',
        reason: 'no media',
      })
    await expect(v.port.save(v.bytes, selection)).rejects.toThrow('storage unavailable')
    expect(v.bridge).not.toHaveBeenCalled()
    expect(v.put).not.toHaveBeenCalled()
  },
)
it('holds the capture slot through cancelled persistence and redacts private write errors', async () => {
  const v = captureFixture()
  let finish!: () => void
  v.put.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    throw new Error('private file path')
  })
  const saving = v.port.save(v.bytes, v.selection)
  await vi.waitFor(() => expect(finish).toBeDefined())
  const rejection = expect(saving).rejects.toThrow('storage unavailable')
  v.ac.abort()
  await expect(v.port.save(v.bytes, v.selection)).rejects.toThrow('storage unavailable')
  expect(v.put).toHaveBeenCalledTimes(1)
  finish()
  await rejection
  expect(v.bridge.mock.calls.map((call) => (call[2] as { operation: string }).operation)).toEqual(['select'])
})
it.each(['device', 'version', 'stage', 'secret', 'cancel'] as const)(
  'refuses %s invalid or late recovery without writing again',
  async (mode) => {
    const v = captureFixture()
    v.bridge.mockImplementationOnce(async () => {
      if (mode === 'cancel') v.ac.abort()
      return {
        selection: {
          ...v.selection,
          ...(mode === 'device' ? { deviceId: '22222222-2222-4222-8222-222222222222' } : {}),
          ...(mode === 'version' ? { configRevision: 2 } : {}),
        },
        stage: mode === 'stage' ? 'selected' : 'stored',
        eventSeq: null,
        ...(mode === 'secret' ? { credentialRef: 'private' } : {}),
      }
    })
    await expect(v.port.recover()).rejects.toThrow('storage unavailable')
    expect(v.put).not.toHaveBeenCalled()
  },
)

const deviceSnapshot = () => ({
  workspace: {
    workspaceId: 'a'.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    active: true,
  },
  session: {
    sessionId: 'device-session',
    workspaceId: 'a'.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    bindingRevision: 1,
    active: true,
  },
})

function deviceFixture(
  reader: (key: string, signal: AbortSignal, view?: 'connection' | 'recognition') => Promise<unknown>,
) {
  const base = fixture()
  const identity = { ...base.identity, session: { key: 'device-session', workspaceRoot: '/untrusted-copy' } }
  const build = serviceContext({
    seams: base.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: reader,
  })
  const ctx = build(base.entry, identity, base.alive, base.workspace)
  if (!ctx.device) throw new Error('missing device lookup')
  return { ...base, identity, ctx, device: ctx.device, build }
}

it('fixes binding lookup to the actual invocation and returns copied frozen data', async () => {
  const original = deviceSnapshot()
  const read = vi.fn(async () => original)
  const { device, identity, ac, ctx } = deviceFixture(read)
  identity.session.key = 'forged-later'
  const result = await device.binding()
  expect(read).toHaveBeenCalledWith('device-session', ac.signal)
  expect(ctx.session?.key).toBe('device-session')
  expect(result).toEqual(original.session)
  expect(result).not.toBe(original.session)
  expect(Object.isFrozen(result)).toBe(true)
  original.session.active = false
  expect(result?.active).toBe(true)
})

it('reads only the actual enrolled connection profile and returns a deeply frozen copy', async () => {
  const original = {
    deviceId: deviceSnapshot().session.deviceId,
    bindingRevision: 1,
    profile: {
      driver: 'aka-00',
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
      configRevision: 1,
    },
  }
  const read = vi.fn(async (_key: string, _signal: AbortSignal, view?: 'connection' | 'recognition') =>
    view ? original : deviceSnapshot(),
  )
  const { device, ac, identity } = deviceFixture(read)
  identity.session.key = 'forged-later'
  const result = await device.connection?.()
  expect(read).toHaveBeenCalledWith('device-session', ac.signal, 'connection')
  expect(result).toEqual(original)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result?.profile)).toBe(true)
  original.profile.ip = '192.168.1.43'
  expect(result?.profile?.ip).toBe('192.168.1.42')
  ac.abort()
  await expect(device.connection?.()).rejects.toThrow('closed')
})

it.each(['ordinary', 'inactive', 'old-host', 'device', 'revision', 'changed', 'expired'] as const)(
  'refuses connection metadata for %s without leaking a profile',
  async (mode) => {
    let reads = 0
    let abort: () => void = () => {}
    const { device, ac } = deviceFixture(async (_key, _signal, view) => {
      if (view) {
        if (mode === 'expired') abort()
        return mode === 'old-host'
          ? deviceSnapshot()
          : {
              deviceId:
                mode === 'device'
                  ? '22222222-2222-4222-8222-222222222222'
                  : deviceSnapshot().session.deviceId,
              bindingRevision: mode === 'revision' ? 2 : 1,
              profile: null,
            }
      }
      const binding = deviceSnapshot()
      if (mode === 'ordinary') return { workspace: binding.workspace, session: null }
      if (mode === 'inactive') binding.session.active = false
      if (mode === 'changed' && ++reads > 1) {
        binding.session.bindingRevision = 2
        binding.workspace.revision = 2
      }
      return binding
    })
    abort = () => ac.abort()
    await expect(device.connection?.()).rejects.toThrow()
  },
)

it('retains only the actual session binding beyond invocation completion and uses the row lifetime', async () => {
  const base = fixture()
  const row = new AbortController()
  const retain = vi.fn(async (_key: string, _signal: AbortSignal, lifetime: AbortSignal) => ({
    snapshot: deviceSnapshot(),
    connection: { deviceId: deviceSnapshot().session.deviceId, bindingRevision: 1, profile: null },
    revoked: lifetime,
    release() {},
  }))
  const build = serviceContext({
    seams: base.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: async () => deviceSnapshot(),
    deviceSessionRetain: retain,
  })
  const ctx = build(
    { ...base.entry, signal: row.signal },
    { ...base.identity, session: { key: 'device-session', workspaceRoot: '/wrong' } },
    base.alive,
    base.workspace,
  )
  const held = await ctx.device?.retain?.()
  expect(held?.binding.sessionId).toBe('device-session')
  expect(held?.connection).toMatchObject({ bindingRevision: 1, profile: null })
  expect(Object.isFrozen(held?.connection)).toBe(true)
  expect(retain).toHaveBeenCalledWith('device-session', base.ac.signal, row.signal)
  base.ac.abort()
  expect(held?.revoked.aborted).toBe(false)
  await expect(ctx.device?.retain?.()).rejects.toThrow('closed')
  row.abort()
  expect(held?.revoked.aborted).toBe(true)
})

it.each([
  'expired',
  'inactive',
  'wrong-session',
  'revoked',
  'wrong-configuration',
  'malformed-configuration',
])('releases late/invalid retained binding on %s', async (mode) => {
  const base = fixture()
  const lease = new AbortController()
  let finish!: (value: {
    snapshot: unknown
    connection?: unknown
    revoked: AbortSignal
    release(): void
  }) => void
  const pending = new Promise<{
    snapshot: unknown
    connection?: unknown
    revoked: AbortSignal
    release(): void
  }>((resolve) => {
    finish = resolve
  })
  const build = serviceContext({
    seams: base.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: async () => deviceSnapshot(),
    deviceSessionRetain: async () => pending,
  })
  const ctx = build(
    base.entry,
    { ...base.identity, session: { key: 'device-session', workspaceRoot: '/wrong' } },
    base.alive,
    base.workspace,
  )
  const retained = ctx.device?.retain?.()
  if (mode === 'expired') base.ac.abort()
  if (mode === 'revoked') lease.abort()
  const raw = deviceSnapshot()
  if (mode === 'inactive') raw.session.active = false
  if (mode === 'wrong-session') raw.session.sessionId = 'other'
  const release = vi.fn(() => lease.abort())
  finish({
    snapshot: raw,
    revoked: lease.signal,
    release,
    ...(mode === 'wrong-configuration'
      ? {
          connection: { deviceId: '22222222-2222-4222-8222-222222222222', bindingRevision: 1, profile: null },
        }
      : {}),
    ...(mode === 'malformed-configuration' ? { connection: { ip: 'fake' } } : {}),
  })
  await expect(retained).rejects.toThrow()
  expect(release).toHaveBeenCalled()
  expect(lease.signal.aborted).toBe(true)
})

it('keeps historical enrollment inactive and ordinary sessions unenrolled without caching', async () => {
  const historical = deviceSnapshot()
  historical.workspace.deviceId = '22222222-2222-4222-8222-222222222222'
  historical.workspace.revision = 2
  historical.session.active = false
  const read = vi
    .fn()
    .mockResolvedValueOnce(deviceSnapshot())
    .mockResolvedValueOnce(historical)
    .mockResolvedValueOnce({ workspace: deviceSnapshot().workspace, session: null })
  const { device } = deviceFixture(read)
  expect((await device.binding())?.active).toBe(true)
  await expect(device.binding()).resolves.toEqual(historical.session)
  await expect(device.binding()).resolves.toBeNull()
})

it.each(['wrong-session', 'wrong-workspace', 'wrong-revision', 'malformed'] as const)(
  'refuses device data for %s',
  async (mode) => {
    const result = deviceSnapshot()
    if (mode === 'wrong-session') result.session.sessionId = 'other'
    if (mode === 'wrong-workspace') result.workspace.workspaceId = 'b'.repeat(64)
    if (mode === 'wrong-revision') result.workspace.revision = 2
    const { device } = deviceFixture(async () => (mode === 'malformed' ? { device: 'fake' } : result))
    await expect(device.binding()).rejects.toThrow('unavailable')
  },
)

it('retires late binding replies after the service invocation expires', async () => {
  let reply: (value: unknown) => void = () => {}
  const pending = new Promise<unknown>((resolve) => {
    reply = resolve
  })
  const { device, ac } = deviceFixture(async () => pending)
  const result = device.binding()
  ac.abort()
  reply(deviceSnapshot())
  await expect(result).rejects.toThrow('closed')
  await expect(device.binding()).rejects.toThrow('closed')
})

it('does not expose the device port to a non-session service embedding', () => {
  const { build, entry, identity, alive, workspace } = deviceFixture(async () => deviceSnapshot())
  const { session: _, ...nonSession } = identity
  expect(build(entry, nonSession, alive, workspace).device).toBeUndefined()
})
// `platform` overrides the fake platform seam (default facts/capability otherwise), so a test can
// make the seam's answer change between two context-builder invocations.
function fixture(platform?: Partial<SeamImplementations['platform']>) {
  const def = serviceFixture(),
    { handler: _, ...cap } = def
  const manifest: ExtensionManifest = {
    id: 'fixture/service',
    version: '1.0.0',
    apiRange: '^1.0',
    entry: './index.js',
    capabilities: { services: [cap], network: { hosts: ['allowed.test:443', 'only-manifest.test'] } },
  }
  const registry = new ServiceRegistry(),
    ac = new AbortController()
  registry.register(def, {
    manifest,
    lease: leaseFor(manifest, { now: Date.now(), ttlMs: 1000 }),
    signal: ac.signal,
  })
  const entry = registry.resolve(manifest.id, def.name)
  if (!entry) throw new Error('missing fixture')
  const workspace = {
    root: '/workspace',
    fs: () => ({
      read: async () => new Uint8Array(),
      list: async () => [],
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    }),
    ready: async () => ({ confine: async (argv: readonly string[]) => argv }),
    hookSnapshot: async () => ({ workspaceDigest: 'workspace', policyRevision: 1, hooks: [] }),
    approvalContext: () => ({}),
    checkpointContext: () => ({}),
  } as unknown as WorkspaceInvocationView
  const seams = fakeSeams(platform ? { platform } : {}),
    log = { debug() {}, info() {}, warn() {}, error() {} }
  const identity: Pick<ServiceContext, 'actor' | 'source' | 'requestId' | 'signal' | 'timeoutMs'> = {
    actor: { id: 'subject', org: '', role: '', deptPath: [], attrs: {} },
    source: 'surface',
    requestId: 'request',
    signal: ac.signal,
    timeoutMs: 1000,
  }
  const alive = () => {
    if (ac.signal.aborted) throw new Error('closed')
  }
  // `build` is exactly `ServiceInvocationDeps['context']` -- assemble.ts constructs it once
  // (`context: serviceContext({...})`) and service-invocation.ts's `run()` calls it once per
  // service invocation (`deps.context(entry, {...}, alive)`). Exposing it lets a test call it
  // more than once, the same way production does across two separate calls.
  const build = serviceContext({ seams, networkAllow: ['allowed.test', 'only-policy.test'], log })
  const ctx = build(entry, identity, alive, workspace)
  return { ctx, ac, seams, build, entry, identity, alive, workspace }
}

it('requires both manifest and sandbox network grants, safe methods and no redirects', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', fetch)
  const { ctx, ac } = fixture()
  await ctx.net.fetch('https://allowed.test/read', { dispatcher: 'author-controlled' } as never)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher')
  for (const url of [
    'http://allowed.test/read',
    'https://only-manifest.test',
    'https://only-policy.test',
    'https://user:password@allowed.test',
    'file:///etc/passwd',
  ])
    await expect(ctx.net.fetch(url)).rejects.toThrow()
  await expect(ctx.net.fetch('https://allowed.test', { method: 'POST' })).rejects.toThrow()
  await expect(ctx.net.fetch('https://allowed.test', { body: 'payload' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  const signal = fetch.mock.calls[0]?.[1]?.signal
  ac.abort()
  expect(signal?.aborted).toBe(true)
  await expect(ctx.net.fetch('https://allowed.test')).rejects.toThrow(/closed/)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('validates authorize requests and responses without pretending Core JobStatus compatibility', async () => {
  const { ctx, seams } = fixture()
  const authorize = vi.spyOn(seams.principals, 'authorize')
  await expect(ctx.authorize('execute', { kind: 'datasource', id: 'data' })).resolves.toMatchObject({
    effect: 'allow',
  })
  await expect(ctx.authorize('wildcard' as never, { kind: 'datasource', id: 'data' })).rejects.toThrow()
  expect(authorize).toHaveBeenCalledTimes(1)
  authorize.mockResolvedValue({
    decisionId: 'bad',
    effect: 'allow',
    reason: '',
    rowFilter: 'invalid public row scope',
  })
  await expect(ctx.authorize('execute', { kind: 'datasource', id: 'data' })).rejects.toThrow()
  expect(() => ctx.artifacts.poll('job')).toThrow(/unavailable/)
})

it('copies Host-resolved session identity and binds its workspace to the invocation', () => {
  const { ctx, build, entry, identity, alive, workspace } = fixture()
  expect(ctx.session).toBeUndefined()
  const session = { key: 'trusted-session', workspaceRoot: '/untrusted-root' }
  const bound = build(entry, { ...identity, session }, alive, workspace)
  session.key = 'changed-after-call'
  expect(bound.session).toEqual({ key: 'trusted-session', workspaceRoot: '/workspace' })
  expect(Object.isFrozen(bound.session)).toBe(true)
})

it('exposes a read-only platform view read from seams.platform at call time, and no sandbox (spec §5.1)', () => {
  const { ctx, seams } = fixture()
  expect(ctx.platform.shell).toBe(seams.platform.shell())
  expect(ctx.platform.fs).toEqual({ caseSensitive: true, pathSep: '/' })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'full', scope: [] })
  expect(Object.isFrozen(ctx.platform)).toBe(true)
  expect(Object.keys(ctx).sort()).toEqual([
    'actor',
    'artifacts',
    'authorize',
    'cwd',
    'exec',
    'fs',
    'log',
    'net',
    'platform',
    'requestId',
    'signal',
    'source',
    'timeoutMs',
  ])
})

it('probes capability() live on every call, never memoized from the first (spec §5.1)', () => {
  let calls = 0
  const { ctx } = fixture({
    capability: () => {
      calls++
      return calls === 1 ? { level: 'full', scope: [] } : { level: 'partial', scope: ['file'] }
    },
  })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'full', scope: [] })
  expect(ctx.platform.capability('anything')).toEqual({ level: 'partial', scope: ['file'] })
  expect(calls).toBe(2)
})

// Mirror of Task 2's Kernel test (core/test/kernel.test.ts): there, platform must be the SAME
// object across two sessions (computed once). Here it is the opposite requirement: platform must
// be a DIFFERENT, freshly-probed object across two service invocations sharing one `serviceContext`
// construction -- exactly how assemble.ts wires it (`context: serviceContext({...})`, called once,
// then invoked once per call by service-invocation.ts's `run()`). `capability()` alone cannot prove
// this: PlatformView.capability() always delegates live to the seam regardless of when
// platformView() was constructed (see platform-facts.ts), so it would look fresh even if someone
// hoisted `platformView(deps.seams.platform)` out of the per-invocation closure and cached the
// whole object. The `shell`/`fs`/`terminal` facts are the part `platformFacts()` snapshots once
// per `platformView()` call, so they are what actually goes stale under that regression -- proving
// freshness there is what catches it.
it('builds platform fresh inside the per-call context builder, not once when serviceContext() is constructed (spec §5.1)', () => {
  // Flips on every actual seam.shell() call (not tied to an absolute call count, since `fixture()`
  // itself already invokes `build` once to hand back `ctx` for the other tests): a fresh-per-call
  // implementation calls shell() once per `build(...)`, so two explicit calls here see opposite
  // values; a hoisted/cached implementation calls shell() once ever (whenever platformView() first
  // runs) and both explicit calls would see that same single cached value.
  let posix = true
  const { build, entry, identity, alive, workspace } = fixture({
    shell: () => {
      posix = !posix
      return posix ? 'posix' : 'powershell'
    },
  })
  const first = build(entry, identity, alive, workspace)
  const second = build(entry, identity, alive, workspace)
  expect(first.platform.shell).not.toBe(second.platform.shell)
  expect(first.platform).not.toBe(second.platform)
})

const recognitionView = () => ({
  deviceId: deviceSnapshot().session.deviceId,
  bindingRevision: 1,
  configRevision: 1,
  settings: { provider: 'aliyun', frequency: 2, requestBudget: 100, credentialConfigured: true },
})
it('reads redacted recognition settings for the trusted session as a frozen snapshot', async () => {
  const raw = recognitionView()
  const read = vi.fn(async (_key, _signal, view) => (view === 'recognition' ? raw : deviceSnapshot()))
  const { device, ac } = deviceFixture(read)
  const value = await device.recognition?.()
  expect(read).toHaveBeenCalledWith('device-session', ac.signal, 'recognition')
  expect(value).toEqual(raw)
  expect(Object.isFrozen(value?.settings)).toBe(true)
  raw.settings.requestBudget = 20
  expect(value?.settings?.requestBudget).toBe(100)
})
it.each(['ordinary', 'old-reader', 'device', 'binding', 'changed', 'secret'])(
  'refuses recognition settings from %s',
  async (mode) => {
    let reads = 0
    const { device } = deviceFixture(async (_key, _signal, view) => {
      if (view === 'recognition') {
        if (mode === 'old-reader') return deviceSnapshot()
        return {
          ...recognitionView(),
          ...(mode === 'secret' ? { credentialRef: 'secret://private' } : {}),
          ...(mode === 'device' ? { deviceId: '22222222-2222-4222-8222-222222222222' } : {}),
          ...(mode === 'binding' ? { bindingRevision: 2 } : {}),
        }
      }
      const raw = deviceSnapshot()
      if (mode === 'ordinary') return { ...raw, session: null }
      if (mode === 'changed' && ++reads > 1) {
        raw.workspace.revision = 2
        raw.session.bindingRevision = 2
      }
      return raw
    })
    await expect(device.recognition?.()).rejects.toThrow()
  },
)
it.each(['valid', 'missing', 'device', 'secret'])(
  'projects recognition-scoped service retention: %s',
  async (mode) => {
    const base = fixture()
    const row = new AbortController()
    const revoked = new AbortController()
    const release = vi.fn(() => revoked.abort())
    const retain = vi.fn(async () => ({
      snapshot: deviceSnapshot(),
      revoked: revoked.signal,
      release,
      ...(mode === 'missing'
        ? {}
        : {
            recognition: {
              ...recognitionView(),
              ...(mode === 'device' ? { deviceId: '22222222-2222-4222-8222-222222222222' } : {}),
              ...(mode === 'secret' ? { credentialRef: 'secret://private' } : {}),
            },
          }),
    }))
    const build = serviceContext({
      seams: base.seams,
      networkAllow: [],
      log: { debug() {}, info() {}, warn() {}, error() {} },
      deviceSession: async () => deviceSnapshot(),
      deviceSessionRetain: retain,
    })
    const ctx = build(
      { ...base.entry, signal: row.signal },
      { ...base.identity, session: { key: 'device-session', workspaceRoot: '/wrong' } },
      base.alive,
      base.workspace,
    )
    const held = ctx.device?.retainRecognition?.()
    if (mode === 'valid') {
      const lease = await held
      expect(lease?.recognition).toEqual(recognitionView())
      expect(Object.isFrozen(lease?.recognition.settings)).toBe(true)
      base.ac.abort()
      expect(lease?.revoked.aborted).toBe(false)
      lease?.release()
      expect(lease?.revoked.aborted).toBe(true)
    } else {
      await expect(held).rejects.toThrow()
      expect(revoked.signal.aborted).toBe(true)
    }
    expect(retain).toHaveBeenCalledWith('device-session', base.ac.signal, row.signal, 'recognition')
  },
)

function budgetFixture() {
  const base = fixture()
  const read = vi.fn(async () => deviceSnapshot())
  const bridge = vi.fn(
    async (_key: string, _callId: string, _input: DeviceRecognitionBudgetRequest, _signal: AbortSignal) =>
      ({
        deviceId: deviceSnapshot().session.deviceId,
        roundRevision: 1,
        budget: 2,
        reserved: 0,
      }) as unknown,
  )
  const build = serviceContext({
    seams: base.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: read,
    deviceRecognitionBudget: bridge,
  })
  const entry = {
    ...base.entry,
    owner: pluginRowSource('ext:agnes-examples/aka-robot'),
    capability: { ...base.entry.capability, kind: 'effect' as const, name: 'aka.recognition.round.start' },
  }
  const identity = { ...base.identity, session: { key: 'device-session', workspaceRoot: '/workspace' } }
  const admission = { commandId: 'command', callId: 'a'.repeat(32) }
  const input = {
    operation: 'start' as const,
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    expectedRoundRevision: 0,
    startId: '22222222-2222-4222-8222-222222222222',
  }
  return {
    ...base,
    read,
    bridge,
    build,
    entry,
    identity,
    admission,
    input,
    ctx: build(entry, identity, base.alive, base.workspace, admission),
  }
}
it('binds recognition budget to admitted identity and returns only copied immutable budget state', async () => {
  const v = budgetFixture()
  v.identity.session.key = 'forged'
  v.admission.callId = 'b'.repeat(32)
  const round = await v.ctx.recognitionBudget?.request(v.input)
  expect(v.bridge).toHaveBeenCalledWith('device-session', 'a'.repeat(32), v.input, v.ac.signal)
  expect(Object.isFrozen(v.bridge.mock.calls[0]?.[2])).toBe(true)
  expect(round).toMatchObject({ budget: 2, reserved: 0 })
  expect(Object.isFrozen(round)).toBe(true)
  expect(JSON.stringify(v.ctx)).not.toContain('callId')
  v.identity.session.key = 'device-session'
  v.admission.callId = 'a'.repeat(32)
  const detector = v.build(
    { ...v.entry, capability: { ...v.entry.capability, name: 'aka.recognition.test' } },
    v.identity,
    v.alive,
    v.workspace,
    v.admission,
  )
  v.bridge.mockResolvedValueOnce({
    granted: true,
    round: {
      deviceId: deviceSnapshot().session.deviceId,
      roundRevision: 1,
      budget: 2,
      reserved: 1,
    },
  })
  const reserved = await detector.recognitionBudget?.request({
    operation: 'reserve',
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    expectedRoundRevision: 1,
    attemptId: '22222222-2222-4222-8222-222222222222',
  })
  expect(reserved).toMatchObject({ granted: true, round: { reserved: 1 } })
  expect(Object.isFrozen(reserved && 'round' in reserved ? reserved.round : undefined)).toBe(true)
  v.bridge.mockResolvedValueOnce(null)
  await expect(
    detector.recognitionBudget?.request({
      operation: 'read',
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
    }),
  ).resolves.toBeNull()
})
it.each([
  'query',
  'other-plugin',
  'other-service',
  'missing-admission',
  'missing-session',
  'bad-nonce',
] as const)('does not expose a budget effect for %s', (mode) => {
  const v = budgetFixture()
  const entry = { ...v.entry, capability: { ...v.entry.capability } }
  if (mode === 'query') Object.assign(entry.capability, { kind: 'query' })
  if (mode === 'other-plugin') entry.owner = 'plugin/other'
  if (mode === 'other-service') entry.capability.name = 'aka.status'
  if (mode === 'bad-nonce') v.admission.callId = 'bad'
  const ctx = v.build(
    entry,
    mode === 'missing-session' ? ({ ...v.identity, session: undefined } as never) : v.identity,
    v.alive,
    v.workspace,
    mode === 'missing-admission' ? undefined : v.admission,
  )
  expect(ctx.recognitionBudget).toBeUndefined()
  expect(v.bridge).not.toHaveBeenCalled()
})
it.each(['extra', 'wrong-operation', 'fraction', 'role'] as const)(
  'rejects %s budget input before contacting the bridge',
  async (mode) => {
    const v = budgetFixture()
    const input = { ...v.input }
    if (mode === 'extra') Object.assign(input, { callId: 'b'.repeat(32) })
    if (mode === 'wrong-operation') Object.assign(input, { operation: 'invented' })
    if (mode === 'fraction') input.expectedBindingRevision = 0.5
    if (mode === 'role') {
      Object.assign(input, { operation: 'reserve', attemptId: input.startId })
      delete (input as Partial<typeof input>).startId
    }
    await expect(v.ctx.recognitionBudget?.request(input)).rejects.toThrow('unavailable')
    expect(v.bridge).not.toHaveBeenCalled()
  },
)
it.each(['cancel', 'binding', 'secret', 'count'] as const)(
  'refuses %s late or malformed budget responses',
  async (mode) => {
    const v = budgetFixture()
    v.bridge.mockImplementationOnce(async () => {
      if (mode === 'cancel') v.ac.abort()
      if (mode === 'binding')
        v.read.mockImplementation(async () => {
          const state = deviceSnapshot()
          state.session.deviceId = state.workspace.deviceId = '33333333-3333-4333-8333-333333333333'
          return state
        })
      return {
        deviceId: deviceSnapshot().session.deviceId,
        roundRevision: 1,
        budget: 2,
        reserved: mode === 'count' ? 3 : 0,
        ...(mode === 'secret' ? { credentialRef: 'secret://private' } : {}),
      }
    })
    await expect(v.ctx.recognitionBudget?.request(v.input)).rejects.toThrow()
  },
)

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DeviceCaptureRecord, DeviceCaptureSelection } from '@agnes/protocol'

it.each(['upload-authorize', 'upload', 'detect'] as const)(
  'requires current Host authority and both network grants for recognition %s',
  async (stage) => {
    const v = fixture()
    const host = {
      'upload-authorize': 'openplatform.aliyuncs.com',
      upload: 'oss-cn-shanghai.aliyuncs.com',
      detect: 'objectdet.cn-shanghai.aliyuncs.com',
    }[stage]
    const authority = { revoked: v.ac.signal, assertAuthorized: vi.fn(async () => {}) }
    const allowedEntry = {
      ...v.entry,
      manifest: {
        ...v.entry.manifest,
        capabilities: { ...v.entry.manifest.capabilities, network: { hosts: [host] } },
      },
    }
    const check = recognitionIOAuthorization(authority, allowedEntry, [`${host}:443`], v.alive)
    await check.assertIOAuthorized(stage, v.ac.signal)
    expect(authority.assertAuthorized).toHaveBeenCalledOnce()
    await expect(
      recognitionIOAuthorization(authority, v.entry, [host], v.alive).assertIOAuthorized(stage, v.ac.signal),
    ).rejects.toThrow('unavailable')
    await expect(
      recognitionIOAuthorization(authority, allowedEntry, [], v.alive).assertIOAuthorized(stage, v.ac.signal),
    ).rejects.toThrow('unavailable')
    await expect(check.assertIOAuthorized('arbitrary' as never, v.ac.signal)).rejects.toThrow('unavailable')
    authority.assertAuthorized.mockImplementationOnce(async () => {
      v.ac.abort()
    })
    await expect(check.assertIOAuthorized(stage, v.ac.signal)).rejects.toThrow()
  },
)

it.each([
  'test',
  'enable',
  'query',
  'other-plugin',
  'round',
  'missing-admission',
  'recover',
  'missing-authority',
  'missing-retain',
] as const)('exposes the single-image port only to its admitted recognition scope: %s', (mode) => {
  const v = fixture()
  const bridge = vi.fn(async () => ({ ticket: '22222222-2222-4222-8222-222222222222' }))
  const build = serviceContext({
    seams: v.seams,
    networkAllow: [],
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceSession: async () => deviceSnapshot(),
    deviceRecognitionExecute: bridge,
    ...(mode === 'missing-retain'
      ? {}
      : {
          deviceSessionRetain: async () => {
            throw new Error('not invoked')
          },
        }),
  })
  const entry = {
    ...v.entry,
    owner:
      mode === 'other-plugin'
        ? pluginRowSource('ext:fixture/other')
        : pluginRowSource('ext:agnes-examples/aka-robot'),
    capability: {
      ...v.entry.capability,
      name:
        mode === 'round'
          ? 'aka.recognition.round.start'
          : mode === 'enable'
            ? 'aka.recognition.enable'
            : 'aka.recognition.test',
      kind: mode === 'query' ? ('query' as const) : ('effect' as const),
    },
  }
  const ctx = build(
    entry,
    { ...v.identity, session: { key: 'device-session', workspaceRoot: '/workspace' } },
    v.alive,
    v.workspace,
    mode === 'missing-admission'
      ? undefined
      : {
          commandId: 'recognition-command',
          callId: 'a'.repeat(32),
          ...(mode === 'recover' ? { recoverOnly: true as const } : {}),
        },
    mode === 'missing-authority' ? undefined : { revoked: v.ac.signal, assertAuthorized: async () => {} },
  )
  expect(Boolean(ctx.recognition)).toBe(mode === 'test' || mode === 'enable')
  expect(bridge).not.toHaveBeenCalled()
})

it.each(['test', 'enable', 'recover-test'] as const)(
  'grants original storage only to the single recognition test effect: %s',
  (mode) => {
    const v = captureFixture()
    const entry = {
      ...v.entry,
      capability: {
        ...v.entry.capability,
        name: mode === 'enable' ? 'aka.recognition.enable' : 'aka.recognition.test',
      },
    }
    const ctx = v.build(entry, v.identity, v.alive, v.workspace, {
      ...v.admission,
      ...(mode === 'recover-test' ? { recoverOnly: true as const } : {}),
    })
    expect(Boolean(ctx.captureArtifacts)).toBe(mode === 'test')
    expect(v.bridge).not.toHaveBeenCalled()
    expect(v.put).not.toHaveBeenCalled()
  },
)

it('gives round read only budget read, never reset, reserve, inference or original writes', async () => {
  const v = budgetFixture()
  const entry = { ...v.entry, capability: { ...v.entry.capability, name: 'aka.recognition.round.read' } }
  const ctx = v.build(entry, v.identity, v.alive, v.workspace, v.admission)
  expect(ctx.recognition).toBeUndefined()
  expect(ctx.captureArtifacts).toBeUndefined()
  await expect(
    ctx.recognitionBudget?.request({
      operation: 'read',
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
    }),
  ).resolves.toMatchObject({ budget: 2 })
  v.bridge.mockClear()
  await expect(ctx.recognitionBudget?.request(v.input)).rejects.toThrow()
  await expect(
    ctx.recognitionBudget?.request({
      operation: 'reserve',
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
      expectedRoundRevision: 1,
      attemptId: v.input.startId,
    }),
  ).rejects.toThrow()
  expect(v.bridge).not.toHaveBeenCalled()
})
