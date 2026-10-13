import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteStorage, pluginRowSource, type ResolvedProfile } from '@agnes/host'
import { readDeviceCaptureEvent, rpcError } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
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
import { workerDeviceCaptureSelection } from '../src/supervisor/device-capture-selection.js'
import { readWorkerDeviceSession } from '../src/supervisor/device-session-read.js'
import { workerServiceCaller } from '../src/supervisor/service-worker.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { sqliteTables } from './sqlite-tables.js'

it('recovers one original photo through the real worker, daemon metadata, disk and session after lost reply and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-aka-capture-pipeline-'))
  const root = realpathSync.native(dir),
    key = 'aka-pipeline'
  const database = join(dir, 'daemon.db')
  let tables = sqliteTables(database)
  let authorityTables = sqliteTables(join(dir, 'authority.db'))
  const eventLifetime = new AbortController()
  const ledger = createSqliteStorage({
    file: join(dir, 'sessions.db'),
    tablesDir: join(dir, 'inspection-tables'),
  })
  const queue = new CommandQueue()
  const deviceId = '11111111-1111-4111-8111-111111111111'
  const rowId = 'ext:agnes-examples/aka-robot',
    source = pluginRowSource(rowId)
  const manifest = JSON.parse(
    readFileSync(
      new URL('../../../examples/packages/aka-robot-plugin/package.json', import.meta.url),
      'utf8',
    ),
  )
  const pkg = join(dir, 'aka-package')
  mkdirSync(pkg)
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: 'module',
      exports: './index.mjs',
      agnes: { plugins: manifest.agnes.plugins },
    }),
  )
  writeFileSync(join(pkg, 'index.mjs'), 'export const runtime = {};\n')
  const profile = {
    name: 'local-dev',
    hash: 'aka-pipeline-profile',
    dataDir: dir,
    cacheDir: join(dir, 'cache'),
  } as ResolvedProfile
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  const config: DaemonConfig = {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 90_000 },
  }
  const authorityStore = () => {
    const t = tables.table('daemon')
    const bindings = new DeviceBindingIndex(t),
      ownership = new SessionPrincipalOwnershipIndex(t)
    const workspaces = new WorkspaceCatalog(
      new WorkspaceIndex(t),
      new SessionWorkspaceIndex(t),
      async (path) => ({ path: realpathSync.native(path), name: 'fixture' }),
      Date.now,
      new WorkspaceBindingIndex(t),
    )
    const index = new PersistentArtifactReadAuthorityIndex(authorityTables.table('artifact-authority'))
    const projected = composeProductionProjectedArtifactRead(dir, {
      authority: createArtifactReadAuthorityPort(index),
      writer: { append: index.append.bind(index), revoke: index.revoke.bind(index) },
      ownership: { resolve: async (id) => ownership.resolve(id) },
      limits: { maxArtifactBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024 },
      operationTimeoutMs: 2000,
      scopeTimeoutMs: 2000,
    })
    return { bindings, ownership, workspaces, projected }
  }
  let state = authorityStore(),
    loseRecordedReply = true
  const requests: Array<{ operation: string; recoverOnly: boolean }> = []
  const start = async () => {
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      workerEntry: fileURLToPath(new URL('./aka-capture-worker-entry.ts', import.meta.url)),
      clock: Date.now,
      onEvent: (sessionKey, event) =>
        state.projected.projection.observe(sessionKey, event, eventLifetime.signal),
      onRequest: async (sessionKey, frame, scope) => {
        if (frame.method === 'device-session-read')
          return readWorkerDeviceSession(
            { store: state.bindings, ownership: state.ownership, workspaces: state.workspaces },
            sessionKey,
            frame.params,
          )
        if (frame.method !== 'device-capture-selection') throw new Error('Unexpected worker request')
        const operation = (frame.params as { operation: string }).operation
        requests.push({ operation, recoverOnly: scope?.recoverOnly === true })
        const result = await workerDeviceCaptureSelection(
          {
            bindings: state.bindings,
            ownership: state.ownership,
            workspaces: state.workspaces,
            inspector: state.projected.inspector,
            eventRead: async (session, seq, signal) => {
              signal.throwIfAborted()
              return (await ledger.scan(session, { fromSeq: seq, toSeq: seq, limit: 1 }))[0]
            },
            publicationAuthority: async (session, owner, event, signal) => {
              await state.projected.projection.observe(session, event, signal)
              const capture = readDeviceCaptureEvent(event)
              if (!capture) throw new Error('Missing actual capture')
              const result = await state.projected.workerRead(
                { sessionId: session, laneId: 'main', ownerId: owner, sha256: capture.ref.sha256 },
                signal,
              )
              if (!result || !('ok' in result) || !result.ok) throw new Error('Original is not readable')
            },
          },
          sessionKey,
          frame.params,
          scope,
        )
        if (operation === 'recorded' && loseRecordedReply) {
          loseRecordedReply = false
          throw rpcError('INTERNAL_ERROR') // Persisted event/record, but the original acknowledgement is lost.
        }
        return result
      },
      notices: { emit() {} },
    })
    const server = await listenUnix(paths.workersSocketPath, (socket) => pool.adopt(socket))
    return { pool, server, call: workerServiceCaller(pool, () => profile) }
  }
  let worker: Awaited<ReturnType<typeof start>> | undefined
  const stop = async () => {
    if (!worker) return
    await worker.pool.closeAll(2000).catch(() => undefined)
    worker.pool.killAll()
    await worker.server.close()
    worker = undefined
  }
  const credential = {
    kind: 'surface-service',
    source: 'client-web',
    subjectCredential: { kind: 'local' },
    grants: ['aka.connect', 'aka.camera.set', 'aka.status', 'aka.capture'].map((name) => ({
      extension: source,
      name,
      range: '^0.1.0',
    })),
  }
  const captureIdentity = {
    principalId: 'owner',
    clientId: 'client-web',
    sessionId: key,
    commandId: 'original-photo',
  }
  const capture = async (readbackOnly?: true) => {
    if (!worker) throw new Error('Worker unavailable')
    return executeJournaledEffect({
      journal: new PersistentCommandJournal(tables.table('daemon')),
      commandQueue: queue,
      callService: worker.call,
      params: {
        sessionId: key,
        extension: source,
        service: 'aka.capture',
        commandId: captureIdentity.commandId,
        input: { bindingRevision: 1, configRevision: 1 },
      },
      credential,
      signal: new AbortController().signal,
      serviceId: 'aka.capture',
      identity: captureIdentity,
      bindingKind: 'client-effect',
      ...(readbackOnly ? { readbackOnly } : {}),
    })
  }
  let phase = 'setup'
  try {
    await state.workspaces.add(root)
    const binding = await state.workspaces.authorizeAndBind(key, root)
    state.bindings.attach(binding, deviceId, 0)
    state.bindings.saveConnection(binding, {
      sessionId: key,
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.50.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    })
    state.ownership.bindNew(key, 'owner')
    state.ownership.activateNew(key, 'owner')
    phase = 'worker startup'
    worker = await start()
    await expect(capture(true)).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    expect(requests).toHaveLength(0)
    phase = 'open session'
    await worker.pool.acquire(key, { binding })
    for (const [service, input] of [
      ['aka.connect', { configRevision: 1 }],
      ['aka.camera.set', { configRevision: 1, open: true }],
    ] as const) {
      phase = service
      await worker.call(
        { sessionId: key, extension: source, service, commandId: service, input },
        credential,
        undefined,
        { commandId: service },
      )
    }
    phase = 'streaming status'
    await vi.waitFor(
      async () => {
        expect(
          await worker?.call(
            { sessionId: key, extension: source, service: 'aka.status', input: {} },
            credential,
          ),
        ).toMatchObject({ output: { runtime: { media: 'streaming' } } })
      },
      { timeout: 5000 },
    )
    phase = 'capture and lost reply'
    await expect(capture()).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    const original = state.bindings.captures.read({
      principalId: 'owner',
      sessionId: key,
      commandId: 'original-photo',
    })
    expect(original).toMatchObject({ stage: 'recorded', eventSeq: expect.any(Number) })
    if (!original) throw new Error('Missing persisted original')
    const ref = original.selection.artifact
    const file = join(dir, 'artifacts', 'sha256', ref.sha256.slice(0, 2), ref.sha256)
    const bytes = readFileSync(file)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256)
    await stop()
    await tables.close()
    await authorityTables.close()
    tables = sqliteTables(database)
    authorityTables = sqliteTables(join(dir, 'authority.db'))
    state = authorityStore()
    rmSync(file)
    const before = requests.length
    worker = await start()
    await worker.pool.acquire(key, { binding: await state.workspaces.restoreBinding(key) })
    await expect(capture(true)).rejects.toMatchObject({ data: { code: 'OUTCOME_UNKNOWN' } })
    expect(requests.length).toBeGreaterThan(before)
    expect(
      requests.slice(before).every((request) => request.recoverOnly && request.operation !== 'select'),
    ).toBe(true)
    expect(
      state.bindings.captures.read({
        principalId: captureIdentity.principalId,
        sessionId: captureIdentity.sessionId,
        commandId: captureIdentity.commandId,
      }),
    ).toEqual(original)
    writeFileSync(file, bytes)
    const recovered = await capture(true)
    expect(recovered.output).toMatchObject({
      deviceId,
      frameId: original.selection.frameId,
      artifact: ref,
      eventSeq: original.eventSeq,
    })
    const events = await ledger.scan(key, { type: 'x/core/device-capture', limit: 100 })
    expect(events).toHaveLength(1)
    expect(events[0]?.seq).toBe(original.eventSeq)
    const read = await state.projected.workerRead(
      { sessionId: key, laneId: 'main', ownerId: 'owner', sha256: ref.sha256 },
      new AbortController().signal,
    )
    expect(read).toMatchObject({ ok: true, artifact: ref })
    expect(await capture()).toEqual(recovered)
    expect(requests.filter((request) => request.operation === 'select')).toHaveLength(1)
  } catch (error) {
    throw new Error(`Capture pipeline phase: ${phase}; ${JSON.stringify(error)}`, { cause: error })
  } finally {
    await stop()
    await queue.close()
    await ledger.close()
    await tables.close()
    await authorityTables.close()
    eventLifetime.abort()
    rmSync(dir, { recursive: true, force: true })
    if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon'))
      rmSync(dirname(paths.socketPath), { recursive: true, force: true })
  }
}, 150_000)
