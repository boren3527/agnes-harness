import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginRowSource } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from '../src/local/artifact-read-authority.js'
import { CommandQueue } from '../src/local/command-queue.js'
import { executeJournaledEffect } from '../src/local/methods/extensions.js'
import { PersistentCommandJournal } from '../src/storage/command-journal.js'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import { WorkspaceBindingIndex, WorkspaceCatalog, WorkspaceIndex } from '../src/storage/workspaces.js'
import { composeProductionProjectedArtifactRead } from '../src/supervisor/artifact-read.js'
import { deviceRecognitionReadback } from '../src/supervisor/device-recognition-readback.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(size = 100, grant = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agh-recognition-readback-')),
    root = realpathSync.native(dir)
  cleanup.push(async () => rmSync(dir, { recursive: true, force: true }))
  const database = join(dir, 'metadata.db')
  let tables = sqliteTables(database)
  cleanup.push(() => tables.close())
  let authorityTables = sqliteTables(join(dir, 'authority.db'))
  cleanup.push(() => authorityTables.close())
  const state = () => {
    const table = tables.table('devices'),
      bindings = new DeviceBindingIndex(table)
    const ownership = new SessionPrincipalOwnershipIndex(table)
    const workspaces = new WorkspaceCatalog(
      new WorkspaceIndex(table),
      new SessionWorkspaceIndex(table),
      async (path) => ({ path: realpathSync.native(path), name: 'fixture' }),
      Date.now,
      new WorkspaceBindingIndex(table),
    )
    const index = new PersistentArtifactReadAuthorityIndex(authorityTables.table('artifact-authority'))
    const projected = composeProductionProjectedArtifactRead(dir, {
      authority: createArtifactReadAuthorityPort(index),
      writer: { append: index.append.bind(index), revoke: index.revoke.bind(index) },
      ownership: { resolve: async (key) => ownership.resolve(key) },
      limits: { maxArtifactBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024 },
      operationTimeoutMs: 2000,
      scopeTimeoutMs: 2000,
    })
    return { bindings, ownership, workspaces, projected }
  }
  let s = state()
  await s.workspaces.add(root)
  const workspace = await s.workspaces.authorizeAndBind('session', root)
  const deviceId = '11111111-1111-4111-8111-111111111111'
  s.bindings.attach(workspace, deviceId, 0)
  s.ownership.bindNew('session', 'owner')
  s.ownership.activateNew('session', 'owner')
  const identity = { principalId: 'owner', sessionId: 'session', commandId: 'original-recognition' }
  const bytes = Buffer.alloc(size, 1),
    ref = { sha256: createHash('sha256').update(bytes).digest('hex'), size, mime: 'image/jpeg' as const }
  const folder = join(dir, 'artifacts', 'sha256', ref.sha256.slice(0, 2)),
    file = join(folder, ref.sha256)
  mkdirSync(folder, { recursive: true })
  writeFileSync(file, bytes)
  s.bindings.captures.select(identity, {
    deviceId,
    bindingRevision: 1,
    configRevision: 7,
    frameId: 'original-frame',
    width: 320,
    height: 240,
    selectedAt: '2026-10-10T00:00:00.000Z',
    timeBasis: 'bridge_receive',
    ageAtSelectionMs: 10,
    artifact: ref,
  })
  s.bindings.captures.stored(identity, ref)
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
    data: { captureId: s.bindings.captures.publicationId(identity), ref },
  }
  if (grant) await s.projected.projection.observe('session', event, new AbortController().signal)
  s.bindings.captures.recorded(identity, 42)
  const candidate = {
    id: '22222222-2222-4222-8222-222222222222',
    deviceId,
    bindingRevision: 1,
    configRevision: 3,
    roundRevision: 2,
    frameId: 'original-frame',
    width: 320,
    height: 240,
    sha256: ref.sha256,
    providerRequestId: 'synthetic-paid-once',
    elapsedMs: 123,
    detections: [],
  }
  s.bindings.detectionResults.save(identity, candidate, '2026-10-10T00:00:01.000Z')
  const eventRead = vi.fn(async (_session: string, _seq: number, _signal: AbortSignal) => event)
  const deps = () => ({
    bindings: s.bindings,
    ownership: s.ownership,
    workspaces: s.workspaces,
    artifactRead: s.projected.rpc,
    eventRead,
  })
  const params = {
    sessionId: 'session',
    extension: pluginRowSource('ext:agnes-examples/aka-robot'),
    service: 'aka.recognition.test',
    commandId: identity.commandId,
    input: { bindingRevision: 1, configRevision: 7, recognitionRevision: 3, roundRevision: 2 },
  }
  return {
    identity,
    params,
    event,
    eventRead,
    file,
    ref,
    candidate,
    bytes,
    deps,
    current: () => s,
    journal: () => new PersistentCommandJournal(tables.table('journal')),
    reopen: async () => {
      await tables.close()
      await authorityTables.close()
      tables = sqliteTables(database)
      authorityTables = sqliteTables(join(dir, 'authority.db'))
      s = state()
    },
  }
}
it.each(['recorded', 'not-started', 'captured-not-submitted'] as const)(
  'recovers a %s original after durable-store reopen without repeating inference',
  async (outcome) => {
    const v = await fixture(2 * 1024 * 1024),
      queue = new CommandQueue()
    if (outcome === 'not-started') v.params.commandId = 'failed-before-frame-selection'
    if (outcome === 'captured-not-submitted') {
      const state = v.current()
      const authority = await state.workspaces.restoreBinding('session')
      state.bindings.recognition.save(authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        settings: {
          provider: 'aliyun',
          frequency: 1,
          requestBudget: 10,
          credentialRef: `secret://aka-robot/device-${v.candidate.deviceId}-33333333-3333-4333-8333-333333333333`,
        },
      })
      state.bindings.recognitionBudget.start(authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        expectedRoundRevision: 0,
        startId: '44444444-4444-4444-8444-444444444444',
      })
      const original = state.bindings.captures.read(v.identity)
      if (!original) throw new Error('fixture capture missing')
      v.params.commandId = 'failed-after-capture-before-detect'
      v.params.input = { ...v.params.input, recognitionRevision: 1, roundRevision: 1 }
      const identity = { ...v.identity, commandId: v.params.commandId }
      state.bindings.captures.select(identity, original.selection)
      state.bindings.captures.stored(identity, v.ref)
      state.bindings.captures.recorded(identity, 43)
    }
    cleanup.push(() => queue.close())
    const call = vi.fn(async () => {
      throw new Error('lost worker reply after detection archive')
    })
    const run = (readbackOnly?: true, params = v.params) =>
      executeJournaledEffect({
        journal: v.journal(),
        commandQueue: queue,
        callService: call,
        params,
        credential: { kind: 'local' },
        signal: new AbortController().signal,
        serviceId: params.service,
        identity: { ...v.identity, commandId: params.commandId, clientId: 'client-web' },
        bindingKind: 'client-module.effect',
        readRecognitionResult: deviceRecognitionReadback(v.deps()),
        ...(readbackOnly ? { readbackOnly } : {}),
      })
    await expect(run(true)).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    expect(v.eventRead).not.toHaveBeenCalled()
    await expect(run()).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    await v.reopen()
    await expect(run()).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    await expect(
      run(true, { ...v.params, input: { ...v.params.input, roundRevision: 3 } }),
    ).rejects.toMatchObject({ data: { code: 'ID_CONFLICT' } })
    if (outcome === 'recorded') {
      unlinkSync(v.file)
      await expect(run(true)).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
      writeFileSync(v.file, v.bytes)
    }
    const restored = await run(true)
    if (outcome === 'recorded') {
      expect(restored).toMatchObject({
        output: { ...v.candidate, artifact: v.ref, eventSeq: 42, timeBasis: 'bridge_receive' },
      })
      expect(v.eventRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['session', 42])
    } else {
      expect(restored).toEqual({
        output: {
          outcome: 'not-started',
          deviceId: v.candidate.deviceId,
          ...v.params.input,
        },
      })
      expect(v.eventRead).not.toHaveBeenCalled()
    }
    await expect(run(true)).resolves.toEqual(restored)
    expect(call).toHaveBeenCalledOnce()
    if (outcome === 'captured-not-submitted') {
      const state = v.current(),
        authority = await state.workspaces.restoreBinding('session')
      state.bindings.recognitionBudget.reserve(authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        expectedRoundRevision: 1,
        attemptId: '55555555-5555-4555-8555-555555555555',
      })
      expect(
        await deviceRecognitionReadback(v.deps())(v.params, 'owner', new AbortController().signal),
      ).toBeUndefined()
      const other = { ...v.identity, commandId: 'other-completed-detection' }
      const capture = state.bindings.captures.read(v.identity)
      if (!capture) throw new Error('Missing original capture')
      state.bindings.captures.select(other, capture.selection)
      state.bindings.captures.stored(other, v.ref)
      state.bindings.captures.recorded(other, 44)
      state.bindings.detectionResults.save(
        other,
        {
          ...v.candidate,
          id: '66666666-6666-4666-8666-666666666666',
          configRevision: 1,
          roundRevision: 1,
        },
        '2026-10-10T00:00:02.000Z',
      )
      expect(
        await deviceRecognitionReadback(v.deps())(v.params, 'owner', new AbortController().signal),
      ).toEqual(restored)
    }
  },
)
it('waits for an in-flight original before certifying that no image was submitted', async () => {
  const v = await fixture(),
    queue = new CommandQueue()
  cleanup.push(() => queue.close())
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const started = vi.fn()
  const readback = vi.fn(deviceRecognitionReadback(v.deps()))
  const run = (readbackOnly?: true) =>
    executeJournaledEffect({
      journal: v.journal(),
      commandQueue: queue,
      callService: async () => {
        started()
        await pending
        throw new Error('no frame')
      },
      params: { ...v.params, commandId: 'pending-without-frame' },
      credential: { kind: 'local' },
      signal: new AbortController().signal,
      serviceId: 'recognition',
      identity: { ...v.identity, commandId: 'pending-without-frame', clientId: 'web' },
      bindingKind: 'client-module.effect',
      readRecognitionResult: readback,
      ...(readbackOnly ? { readbackOnly } : {}),
    })
  const original = expect(run()).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
  await vi.waitFor(() => expect(started).toHaveBeenCalled())
  const recovering = run(true)
  await new Promise((resolve) => setImmediate(resolve))
  expect(readback).not.toHaveBeenCalled()
  finish()
  await original
  await expect(recovering).resolves.toMatchObject({ output: { outcome: 'not-started' } })
})
it.each([
  'owner',
  'input',
  'service',
  'event',
  'lane',
  'publication',
  'missing-archive',
  'corrupt-archive',
  'missing-file',
  'wrong-bytes',
  'late-owner',
  'no-authority',
  'late-owner-after-read',
  'late-workspace',
  'late-archive',
  'cancel-after-read',
  'cancel',
])('refuses %s original readback and exposes no private errors', async (mode) => {
  const v = await fixture(100, mode !== 'no-authority'),
    signal = new AbortController(),
    deps = v.deps(),
    params = { ...v.params }
  if (mode === 'input') params.input = { ...params.input, recognitionRevision: 4 }
  if (mode === 'service') params.service = 'aka.recognition.enable'
  if (mode === 'event') v.event.seq = 43
  if (mode === 'lane') v.event.lane = 'other'
  if (mode === 'publication')
    v.event.data = { ...(v.event.data as object), captureId: '22222222-2222-4222-8222-222222222222' }
  if (mode === 'missing-archive') vi.spyOn(deps.bindings.detectionResults, 'read').mockReturnValue(null)
  if (mode === 'corrupt-archive')
    vi.spyOn(deps.bindings.detectionResults, 'read').mockImplementation(() => {
      throw new Error('private database path')
    })
  if (mode === 'missing-file') unlinkSync(v.file)
  if (mode === 'wrong-bytes') writeFileSync(v.file, Buffer.alloc(v.ref.size, 2))
  if (mode === 'late-owner')
    v.eventRead.mockImplementationOnce(async () => {
      vi.spyOn(deps.ownership, 'resolve').mockReturnValue({ active: true, principalId: 'other' })
      return v.event
    })
  if (['late-owner-after-read', 'late-archive', 'cancel-after-read'].includes(mode)) {
    const actualRead = deps.artifactRead.read
    deps.artifactRead = {
      ...deps.artifactRead,
      read: async (...args) => {
        const result = await actualRead(...args)
        if (mode === 'late-owner-after-read')
          vi.spyOn(deps.ownership, 'resolve').mockReturnValue({ active: true, principalId: 'other' })
        if (mode === 'late-archive') vi.spyOn(deps.bindings.detectionResults, 'read').mockReturnValue(null)
        if (mode === 'cancel-after-read') signal.abort()
        return result
      },
    }
  }
  if (mode === 'late-workspace') {
    const restore = deps.workspaces.restoreBinding.bind(deps.workspaces)
    let reads = 0
    vi.spyOn(deps.workspaces, 'restoreBinding').mockImplementation(async (key) => {
      const binding = await restore(key)
      return ++reads === 1 ? binding : { ...binding, revision: binding.revision + 1 }
    })
  }
  if (mode === 'cancel') signal.abort()
  expect(
    await deviceRecognitionReadback(deps)(params, mode === 'owner' ? 'other' : 'owner', signal.signal),
  ).toBeUndefined()
})
it('settles a canceled readback even when its read-only event port ignores cancellation', async () => {
  const v = await fixture(),
    lifetime = new AbortController()
  let finish!: (event: EventEnvelope) => void
  v.eventRead.mockImplementationOnce(
    () =>
      new Promise<EventEnvelope>((resolve) => {
        finish = resolve
      }),
  )
  const reading = deviceRecognitionReadback(v.deps())(v.params, 'owner', lifetime.signal)
  await vi.waitFor(() => expect(v.eventRead).toHaveBeenCalledOnce())
  lifetime.abort()
  await expect(reading).resolves.toBeUndefined()
  finish(v.event)
  await Promise.resolve()
  expect(v.current().bindings.detectionResults.read(v.identity)?.result).toEqual(v.candidate)
})
