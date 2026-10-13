import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Host from '@agnes/host'
import {
  type CredentialStore,
  createCredentialStore,
  pluginRowSource,
  stageDeviceRecognitionCredential,
  stageDeviceRecognitionToken,
} from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceBindingIndex } from '../src/storage/device-bindings.js'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { workerDeviceRecognitionBudget } from '../src/supervisor/device-recognition-budget.js'
import { resolveDeviceRecognitionCredentialForEffect } from '../src/supervisor/device-recognition-credential.js'
import { DeviceRecognitionExecutor } from '../src/supervisor/device-recognition-execute.js'
import { DeviceRecognitionRequests } from '../src/supervisor/device-recognition-request.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { WorkerLink, type WorkerServiceEffectScope } from '../src/supervisor/worker-link.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.restoreAllMocks()
})

describe('private single-image execution with durable budget', () => {
  const jpeg = () =>
    Uint8Array.from([
      255, 216, 255, 192, 0, 11, 8, 0, 240, 1, 64, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1, 2, 3,
      255, 217,
    ])
  async function fixture(shared?: DeviceRecognitionExecutor, frequency: 0.5 | 1 | 2 = 2, startRound = true) {
    const v = await credentialFixture(frequency)
    if (startRound) await v.run(v.start)
    const frame = { id: 'same-frame', receivedAt: performance.now(), width: 320, height: 240, bytes: jpeg() }
    const uploadAuthorize = vi.fn(async () => {}),
      upload = vi.fn(async () => {}),
      detect = vi.fn(async () => {})
    const factory = vi
      .spyOn(Host, 'createAliRecognitionPipeline')
      .mockImplementation(async (credentials, admit) => {
        expect(credentials).toEqual({ accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' })
        if (!admit) throw new Error('mandatory engine admission missing')
        return {
          upload: async (_frame, signal) => {
            await admit('upload-authorize', signal)
            await uploadAuthorize()
            await admit('upload', signal)
            await upload()
            return 'opaque-upload'
          },
          detect: async (_token, signal) => {
            await admit('detect', signal)
            await detect()
            return {
              RequestId: 'synthetic-request',
              Data: {
                Width: 320,
                Height: 240,
                Elements: [{ Type: 'ball', Score: 0.8, Boxes: [1, 2, 30, 40] }],
              },
            }
          },
          close: vi.fn(),
        }
      })
    const authorization = {
      ...v.authorization,
      assertIOAuthorized: vi.fn(
        async (_stage: 'upload-authorize' | 'upload' | 'detect', _signal: AbortSignal) => {},
      ),
    }
    const executor = shared ?? v.executor
    v.deps.assertRecognitionIdle = (deviceId) => executor.assertIdle(deviceId)
    const recognize = (input = frame, signal = v.signal.signal) =>
      executor.recognize(
        v.deps,
        'device',
        { bindingRevision: 1, configRevision: 1, roundRevision: 1 },
        v.scope,
        authorization,
        input,
        signal,
      )
    return {
      ...v,
      bindings: v.deps.bindings,
      frame,
      factory,
      uploadAuthorize,
      upload,
      detect,
      authorization,
      recognize,
    }
  }
  it.each([
    'allowed',
    'upload-denied',
    'detect-denied',
    'expired',
    'invalid-jpeg',
    'clock-reversed',
    'configuration-changed',
    'missing-original',
    'unpublished-original',
    'wrong-original',
    'connection-changed-after-detect',
    'archive-write-failed',
    'archived-reply-lost',
    'owner-changed-after-detect',
    'recognition-changed-before-archive',
  ] as const)(
    'uses the private frame route and actual pending WorkerLink for executor admission: %s',
    async (mode) => {
      const v = await fixture()
      v.bindings.saveConnection(v.authority, {
        sessionId: 'device',
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        ip: '192.168.1.42',
        port: 80,
        macAddress: '12:34:56:78:90:ab',
      })
      const originalIdentity = { principalId: 'owner', sessionId: 'device', commandId: 'command-1' }
      if (mode !== 'missing-original') {
        const artifact = {
          sha256: createHash('sha256').update(v.frame.bytes).digest('hex'),
          size: v.frame.bytes.length,
          mime: 'image/jpeg' as const,
        }
        v.bindings.captures.select(originalIdentity, {
          deviceId: v.deviceId,
          bindingRevision: 1,
          configRevision: 1,
          frameId: mode === 'wrong-original' ? 'different-frame' : v.frame.id,
          width: v.frame.width,
          height: v.frame.height,
          selectedAt: new Date().toISOString(),
          timeBasis: 'bridge_receive',
          ageAtSelectionMs: 0,
          artifact,
        })
        v.bindings.captures.stored(originalIdentity, artifact)
        if (mode !== 'unpublished-original') v.bindings.captures.recorded(originalIdentity, 42)
      }
      if (mode === 'connection-changed-after-detect')
        v.detect.mockImplementationOnce(async () => {
          v.bindings.saveConnection(v.authority, {
            sessionId: 'device',
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            ip: '192.168.1.43',
            port: 80,
            macAddress: '12:34:56:78:90:ab',
          })
        })
      if (mode === 'archive-write-failed')
        vi.spyOn(v.bindings.detectionResults, 'save').mockImplementationOnce(() => {
          throw new Error('private database path')
        })
      if (mode === 'archived-reply-lost') {
        const save = v.bindings.detectionResults.save.bind(v.bindings.detectionResults)
        vi.spyOn(v.bindings.detectionResults, 'save').mockImplementationOnce((...args) => {
          save(...args)
          throw new Error('reply lost after durable archive')
        })
      }
      if (mode === 'owner-changed-after-detect')
        v.detect.mockImplementationOnce(async () => {
          vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue({ active: true, principalId: 'other' })
        })
      if (mode === 'recognition-changed-before-archive') {
        const recognize = v.executor.recognizeFromWorker.bind(v.executor)
        vi.spyOn(v.executor, 'recognizeFromWorker').mockImplementationOnce(async (...args) => {
          const result = await recognize(...args)
          v.bindings.recognition.save(v.authority, {
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            settings: null,
          })
          return result
        })
      }
      const requests: string[] = []
      class AuthoritySocket extends EventEmitter {
        write(bytes: Buffer) {
          const frame = JSON.parse(bytes.toString())
          if (frame.method === 'deviceRecognition.authorize') {
            requests.push(frame.params.stage)
            const authorized = !(
              (mode === 'upload-denied' && frame.params.stage === 'upload') ||
              (mode === 'detect-denied' && frame.params.stage === 'detect')
            )
            queueMicrotask(() =>
              this.emit(
                'data',
                encodeFrame({ kind: 'reply', requestId: frame.requestId, result: { authorized } }),
              ),
            )
          }
          return true
        }
        end() {
          return this
        }
      }
      const socket = new AuthoritySocket()
      const link = new WorkerLink(socket as unknown as Socket, { onEvent() {}, async onRequest() {} })
      const pending = link.command('callService', {
        callId: v.scope.callId,
        sessionKey: 'device',
        effectCommandId: 'command-1',
        call: {
          sessionId: 'device',
          commandId: 'command-1',
          extension: v.scope.extension,
          service: v.scope.service,
          input: {},
        },
      })
      const scope = link.serviceEffect('device', v.scope.callId)
      const gateway = new DeviceRecognitionRequests(v.executor)
      const begin = {
        operation: 'begin',
        callId: v.scope.callId,
        expected: { bindingRevision: 1, configRevision: 1, roundRevision: 1 },
      }
      const admitted = await gateway.request(v.deps, link, 'device', begin, scope)
      if (!('ticket' in admitted)) throw new Error('missing admitted frame window')
      const params = {
        operation: 'execute',
        callId: v.scope.callId,
        ticket: admitted.ticket,
        frame: {
          id: v.frame.id,
          width: v.frame.width,
          height: v.frame.height,
          jpegBase64: Buffer.from(v.frame.bytes).toString('base64'),
          ageAtSendMs: performance.now() - v.frame.receivedAt,
        },
      }
      if (mode === 'expired') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1001)
      if (mode === 'clock-reversed') vi.spyOn(performance, 'now').mockReturnValue(0)
      if (mode === 'invalid-jpeg') params.frame.jpegBase64 = Buffer.from('not a JPEG').toString('base64')
      if (mode === 'configuration-changed')
        v.bindings.recognition.save(v.authority, {
          expectedBindingRevision: 1,
          expectedConfigRevision: 1,
          settings: null,
        })
      const execute = () => gateway.request(v.deps, link, 'device', params, scope)
      try {
        if (mode === 'allowed') {
          await expect(execute()).resolves.toMatchObject({ providerRequestId: 'synthetic-request' })
          expect(v.detect).toHaveBeenCalledOnce()
          expect(v.bindings.detectionResults.read(originalIdentity)).toMatchObject({
            capture: { eventSeq: 42 },
            result: { providerRequestId: 'synthetic-request', frameId: v.frame.id },
          })
          expect(v.bindings.detectionResults.read({ ...originalIdentity, principalId: 'other' })).toBeNull()
          expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
        } else {
          await expect(execute()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
          const completedDetection = [
            'connection-changed-after-detect',
            'archive-write-failed',
            'archived-reply-lost',
            'owner-changed-after-detect',
            'recognition-changed-before-archive',
          ].includes(mode)
          if (completedDetection) expect(v.detect).toHaveBeenCalledOnce()
          else expect(v.detect).not.toHaveBeenCalled()
          if (mode === 'detect-denied' || completedDetection) expect(v.upload).toHaveBeenCalledOnce()
          else expect(v.upload).not.toHaveBeenCalled()
          if (mode === 'archived-reply-lost')
            expect(v.bindings.detectionResults.read(originalIdentity)?.result.providerRequestId).toBe(
              'synthetic-request',
            )
          else expect(v.bindings.detectionResults.read(originalIdentity)).toBeNull()
          expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({
            reserved: completedDetection ? 1 : 0,
          })
        }
        expect(requests).toContain('upload-authorize')
        const sent = requests.length
        await expect(execute()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
        await expect(gateway.request(v.deps, link, 'device', begin, scope)).rejects.toMatchObject({
          data: { code: 'CAPABILITY_DENIED' },
        })
        expect(requests).toHaveLength(sent)
      } finally {
        socket.emit('data', encodeFrame({ kind: 'reply', requestId: 's1', result: {} }))
        await pending
        link.close('test complete')
      }
      // A completed service cannot reuse the original receipt to access the SDK or stored key.
      const oldRequests = requests.length
      v.factory.mockClear()
      v.read.mockClear()
      await expect(execute()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(requests).toHaveLength(oldRequests)
      expect(v.factory).not.toHaveBeenCalled()
      expect(v.read).not.toHaveBeenCalled()
    },
  )
  it('shares the cloud slot until aborted SDK settlement and releases it even when close fails', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const shared = new DeviceRecognitionExecutor()
    const first = await fixture(shared)
    const second = await fixture(shared)
    let finish!: () => void
    second.detect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const running = first.recognize()
    await vi.waitFor(() => expect(second.detect).toHaveBeenCalledOnce())
    first.signal.abort()
    await expect(second.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(second.uploadAuthorize).toHaveBeenCalledOnce()
    expect(second.bindings.recognitionBudget.read(second.authority)).toMatchObject({ reserved: 0 })
    const pipeline = await second.factory.mock.results[0]?.value
    if (!pipeline) throw new Error('fixture pipeline missing')
    pipeline.close.mockImplementationOnce(() => {
      throw new Error('private-close-error')
    })
    finish()
    await expect(running).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    now += 500
    await expect(second.recognize()).resolves.toMatchObject({ deviceId: second.deviceId })
    expect(second.bindings.recognitionBudget.read(second.authority)).toMatchObject({ reserved: 1 })
  })
  it('enforces the shared 2 Hz dispatch ceiling before uploading for another device', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const shared = new DeviceRecognitionExecutor()
    const first = await fixture(shared)
    const second = await fixture(shared)
    await first.recognize()
    await expect(second.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(second.uploadAuthorize).toHaveBeenCalledOnce()
    expect(second.bindings.recognitionBudget.read(second.authority)).toMatchObject({ reserved: 0 })
    now += 499
    await expect(second.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    now += 1
    await expect(second.recognize()).resolves.toMatchObject({ deviceId: second.deviceId })
    expect(second.bindings.recognitionBudget.read(second.authority)).toMatchObject({ reserved: 1 })
    expect(second.uploadAuthorize).toHaveBeenCalledTimes(2)
  })
  it.each([0.5, 1, 2] as const)(
    'respects configured %s Hz and refuses clock rollback before more IO',
    async (frequency) => {
      let now = 3000
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const v = await fixture(undefined, frequency)
      await v.recognize()
      now -= 1
      await expect(v.recognize({ ...v.frame, receivedAt: now })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      now = 3000 + 1000 / frequency - 1
      await expect(v.recognize({ ...v.frame, receivedAt: now })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(v.uploadAuthorize).toHaveBeenCalledOnce()
      expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
      now += 1
      await expect(v.recognize({ ...v.frame, receivedAt: now })).resolves.toMatchObject({
        deviceId: v.deviceId,
      })
      expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 2 })
    },
  )
  it('returns the exact copied image and frozen detections after one durable reservation', async () => {
    const v = await fixture()
    const original = Uint8Array.from(v.frame.bytes)
    v.uploadAuthorize.mockImplementationOnce(async () => {
      v.frame.bytes.fill(0)
    })
    const result = await v.recognize()
    expect(result.frame.bytes).toEqual(original)
    expect(result.frame.bytes).not.toBe(v.frame.bytes)
    expect(result.providerRequestId).toBe('synthetic-request')
    expect(result.submittedAt).toBeLessThanOrEqual(result.completedAt)
    expect(result.hash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(Object.isFrozen(result.detections[0]?.box)).toBe(true)
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(JSON.stringify(result)).not.toContain('opaque-upload')
  })
  it.each(['upload-authorize', 'upload', 'detect'] as const)(
    'refuses %s permission without dispatching that IO',
    async (stage) => {
      const v = await fixture()
      v.authorization.assertIOAuthorized.mockImplementation(async (value) => {
        if (value === stage) throw new Error('signed-private-url synthetic-secret')
      })
      await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(
        stage === 'upload-authorize' ? v.uploadAuthorize : stage === 'upload' ? v.upload : v.detect,
      ).not.toHaveBeenCalled()
      expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 0 })
    },
  )
  it('rechecks configuration between upload authorization and image upload', async () => {
    const v = await fixture()
    v.uploadAuthorize.mockImplementationOnce(async () => {
      v.bindings.recognition.save(v.authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        settings: null,
      })
    })
    await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.upload).not.toHaveBeenCalled()
    expect(v.detect).not.toHaveBeenCalled()
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 0 })
  })
  it('refuses exhausted budget before credentials or upload and never starts a new round', async () => {
    const v = await fixture()
    for (let i = 0; i < 2; i++)
      v.bindings.recognitionBudget.reserve(v.authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        expectedRoundRevision: 1,
        attemptId: randomUUID(),
      })
    await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.read).not.toHaveBeenCalled()
    expect(v.factory).not.toHaveBeenCalled()
    expect(v.uploadAuthorize).not.toHaveBeenCalled()
    expect(v.upload).not.toHaveBeenCalled()
    expect(v.detect).not.toHaveBeenCalled()
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 2, roundRevision: 1 })
  })
  it.each(['missing', 'replaced'] as const)(
    'refuses a %s round before credential or image IO',
    async (mode) => {
      const v = await fixture(undefined, 2, mode !== 'missing')
      if (mode === 'replaced') await v.run({ ...v.start, expectedRoundRevision: 1, startId: randomUUID() })
      await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(v.read).not.toHaveBeenCalled()
      expect(v.factory).not.toHaveBeenCalled()
      expect(v.uploadAuthorize).not.toHaveBeenCalled()
      expect(v.detect).not.toHaveBeenCalled()
      expect(v.bindings.recognitionBudget.read(v.authority)).toEqual(
        mode === 'missing' ? null : { deviceId: v.deviceId, roundRevision: 2, budget: 2, reserved: 0 },
      )
    },
  )
  it('still atomically refuses detection if capacity is consumed during image upload', async () => {
    const v = await fixture()
    v.upload.mockImplementationOnce(async () => {
      for (let i = 0; i < 2; i++)
        v.bindings.recognitionBudget.reserve(v.authority, {
          expectedBindingRevision: 1,
          expectedConfigRevision: 1,
          expectedRoundRevision: 1,
          attemptId: randomUUID(),
        })
    })
    await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.upload).toHaveBeenCalledOnce()
    expect(v.detect).not.toHaveBeenCalled()
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 2, roundRevision: 1 })
  })
  it('does not dispatch or refund when final IO admission is revoked after reservation', async () => {
    const v = await fixture()
    let checks = 0
    v.authorization.assertIOAuthorized.mockImplementation(async (stage) => {
      if (stage === 'detect' && ++checks === 2) throw new Error('revoked after reservation')
    })
    await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.detect).not.toHaveBeenCalled()
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
  })
  it('retains the device slot until a cancelled real dispatch settles, without replay or refund', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const v = await fixture()
    let finish!: () => void
    v.detect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const running = v.recognize()
    await vi.waitFor(() => expect(v.detect).toHaveBeenCalledTimes(1))
    v.signal.abort()
    await expect(v.recognize(v.frame, new AbortController().signal)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(v.factory).toHaveBeenCalledTimes(1)
    const next = { ...v.start, expectedRoundRevision: 1, startId: randomUUID() }
    await expect(v.run(next)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ roundRevision: 1, reserved: 1 })
    finish()
    await expect(running).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
    now += 500
    await expect(v.recognize(v.frame, new AbortController().signal)).resolves.toMatchObject({
      providerRequestId: 'synthetic-request',
    })
    expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 2 })
    await expect(v.run(next)).resolves.toMatchObject({ roundRevision: 2, reserved: 0 })
  })
  it.each(['configuration', 'owner', 'scope'] as const)(
    'discards a real detection reply after %s retirement without refund',
    async (mode) => {
      const v = await fixture()
      v.detect.mockImplementationOnce(async () => {
        if (mode === 'configuration')
          v.bindings.recognition.save(v.authority, {
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            settings: null,
          })
        if (mode === 'owner') vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue(undefined)
        if (mode === 'scope') v.ac.abort()
      })
      await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(v.detect).toHaveBeenCalledTimes(1)
      expect(v.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 1 })
    },
  )
  it.each(['corrupt', 'mismatch', 'stale', 'future', 'accessor'] as const)(
    'rejects %s image before credentials or IO',
    async (mode) => {
      const v = await fixture()
      if (mode === 'corrupt') v.frame.bytes.fill(0)
      if (mode === 'mismatch') v.frame.width = 321
      if (mode === 'stale') v.frame.receivedAt -= 2000
      if (mode === 'future') v.frame.receivedAt += 2000
      if (mode === 'accessor')
        Object.defineProperty(v.frame, 'width', {
          get() {
            throw new Error('private')
          },
        })
      await expect(v.recognize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(v.factory).not.toHaveBeenCalled()
      expect(v.read).not.toHaveBeenCalled()
    },
  )
})
async function setup(credentials?: CredentialStore, frequency: 0.5 | 1 | 2 = 2) {
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
  const authority = await workspaces.authorizeAndBind('device', '/repo/a')
  const deviceId = randomUUID()
  bindings.attach(authority, deviceId, 0)
  bindings.recognition.save(authority, {
    expectedBindingRevision: 1,
    expectedConfigRevision: 0,
    settings: {
      provider: 'aliyun',
      frequency,
      requestBudget: 2,
      credentialRef: credentials
        ? await stageDeviceRecognitionCredential(
            credentials,
            deviceId,
            { accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' },
            new AbortController().signal,
          )
        : `secret://aka-robot/device-${deviceId}-${randomUUID()}`,
    },
  })
  ownership.bindNew('device', 'owner')
  ownership.activateNew('device', 'owner')
  const ac = new AbortController()
  const scope: WorkerServiceEffectScope = Object.freeze({
    callId: 'a'.repeat(32),
    sessionKey: 'device',
    commandId: 'start',
    extension: pluginRowSource('ext:agnes-examples/aka-robot'),
    service: 'aka.recognition.round.start',
    revoked: ac.signal,
  })
  const executor = new DeviceRecognitionExecutor()
  const deps = {
    bindings,
    ownership,
    workspaces,
    credentials,
    assertRecognitionIdle: (deviceId: string) => executor.assertIdle(deviceId),
  }
  const start = {
    callId: scope.callId,
    operation: 'start',
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
    expectedRoundRevision: 0,
    startId: randomUUID(),
  }
  const read = {
    callId: scope.callId,
    operation: 'read',
    expectedBindingRevision: 1,
    expectedConfigRevision: 1,
  }
  return {
    deps,
    executor,
    authority,
    deviceId,
    ac,
    scope,
    start,
    read,
    run: (input: unknown, effect: WorkerServiceEffectScope | undefined = scope, key = 'device') =>
      workerDeviceRecognitionBudget(deps, key, input, effect),
  }
}

describe('private worker recognition budget authority', () => {
  it.each(['missing', 'async'] as const)('requires a synchronous daemon draining guard: %s', async (mode) => {
    const v = await setup()
    const deps = {
      bindings: v.deps.bindings,
      ownership: v.deps.ownership,
      workspaces: v.deps.workspaces,
      ...(mode === 'async' ? { assertRecognitionIdle: async () => {} } : {}),
    }
    await expect(workerDeviceRecognitionBudget(deps, 'device', v.start, v.scope)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(v.deps.bindings.recognitionBudget.read(v.authority)).toBeNull()
  })
  it('allows the explicit round-read scope only to inspect existing allowance', async () => {
    const v = await setup()
    const proof = { ...v.scope, service: 'aka.recognition.round.read' }
    await expect(v.run(v.read, proof)).resolves.toBeNull()
    await expect(v.run(v.start, proof)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    await v.run(v.start)
    await expect(v.run(v.read, proof)).resolves.toMatchObject({ reserved: 0 })
    await expect(
      v.run(
        {
          callId: v.scope.callId,
          operation: 'reserve',
          expectedBindingRevision: 1,
          expectedConfigRevision: 1,
          expectedRoundRevision: 1,
          attemptId: randomUUID(),
        },
        proof,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.deps.bindings.recognitionBudget.read(v.authority)?.reserved).toBe(0)
  })
  it('uses the current owner workspace, keeps retry usage and returns no configuration secret reference', async () => {
    const v = await setup()
    expect(await v.run(v.read)).toBeNull()
    const round = await v.run(v.start)
    expect(round).toMatchObject({ deviceId: v.deviceId, roundRevision: 1, reserved: 0, budget: 2 })
    const testScope = { ...v.scope, service: 'aka.recognition.test' }
    const claim = {
      callId: v.scope.callId,
      operation: 'reserve',
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
      expectedRoundRevision: 1,
      attemptId: randomUUID(),
    }
    expect(await v.run(claim, testScope)).toMatchObject({ granted: true, round: { reserved: 1 } })
    expect(await v.run(claim, testScope)).toMatchObject({ granted: false, round: { reserved: 1 } })
    expect(await v.run(v.start)).toMatchObject({ reserved: 1 })
    expect(await v.run(v.read)).toMatchObject({ reserved: 1 })
    expect(JSON.stringify(round)).not.toContain('secret://')
    expect(JSON.stringify(round)).not.toContain('credential')
  })
  it.each(['missing', 'revoked', 'nonce', 'session', 'plugin', 'service', 'owner', 'unavailable'] as const)(
    'refuses %s authority before creating a round',
    async (mode) => {
      const v = await setup()
      let scope: WorkerServiceEffectScope | undefined = v.scope
      if (mode === 'missing') scope = undefined
      if (mode === 'revoked') v.ac.abort()
      if (mode === 'nonce') scope = { ...v.scope, callId: 'b'.repeat(32) }
      if (mode === 'session') scope = { ...v.scope, sessionKey: 'other' }
      if (mode === 'plugin') scope = { ...v.scope, extension: 'plugin/imitation' }
      if (mode === 'service') scope = { ...v.scope, service: 'aka.status' }
      if (mode === 'owner') vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue(undefined)
      if (mode === 'unavailable') Object.assign(v.deps, { bindings: undefined })
      await expect(workerDeviceRecognitionBudget(v.deps, 'device', v.start, scope)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(v.deps.bindings?.recognitionBudget.read(v.authority) ?? null).toBeNull()
    },
  )
  it('separates explicit round-start from detector reservation permissions', async () => {
    const v = await setup()
    await expect(v.run(v.start, { ...v.scope, service: 'aka.recognition.test' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await v.run(v.start)
    const claim = {
      callId: v.scope.callId,
      operation: 'reserve',
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
      expectedRoundRevision: 1,
      attemptId: randomUUID(),
    }
    await expect(v.run(claim)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(v.deps.bindings.recognitionBudget.read(v.authority)).toMatchObject({ reserved: 0 })
  })
  it.each(['selector', 'fraction', 'negative', 'malformed-id', 'accessor', 'huge'] as const)(
    'rejects closed input violation %s without changing budget',
    async (mode) => {
      const v = await setup()
      let input: unknown = { ...v.start }
      if (mode === 'selector') input = { ...v.start, deviceId: v.deviceId }
      if (mode === 'fraction') input = { ...v.start, expectedRoundRevision: 0.5 }
      if (mode === 'negative') input = { ...v.start, expectedBindingRevision: -1 }
      if (mode === 'malformed-id') input = { ...v.start, startId: { toString: () => randomUUID() } }
      if (mode === 'accessor')
        input = Object.defineProperty({}, 'callId', {
          get() {
            throw new Error('do not invoke')
          },
        })
      if (mode === 'huge') input = { ...v.start, extra: 'x'.repeat(4097) }
      await expect(v.run(input)).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
      expect(v.deps.bindings.recognitionBudget.read(v.authority)).toBeNull()
    },
  )
  it.each(['scope', 'owner', 'binding', 'configuration'] as const)(
    'rechecks %s after workspace resolution',
    async (mode) => {
      const v = await setup()
      const restore = v.deps.workspaces.restoreBinding.bind(v.deps.workspaces)
      vi.spyOn(v.deps.workspaces, 'restoreBinding').mockImplementationOnce(async (key) => {
        const authority = await restore(key)
        if (mode === 'scope') v.ac.abort()
        if (mode === 'owner') vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue(undefined)
        if (mode === 'binding') v.deps.bindings.detach(authority, 1)
        if (mode === 'configuration')
          v.deps.bindings.recognition.save(authority, {
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            settings: null,
          })
        return authority
      })
      await expect(v.run(v.start)).rejects.toMatchObject({
        data: { code: mode === 'configuration' ? 'REVISION_CONFLICT' : 'CAPABILITY_DENIED' },
      })
      if (mode === 'configuration')
        expect(v.deps.bindings.recognition.read(v.authority)).toMatchObject({
          configRevision: 2,
          settings: null,
        })
      if (mode !== 'binding') expect(v.deps.bindings.recognitionBudget.read(v.authority)).toBeNull()
    },
  )
  it('refuses stale reads and sanitizes backend exceptions rather than sending private messages', async () => {
    const v = await setup()
    await expect(v.run({ ...v.read, expectedConfigRevision: 0 })).rejects.toMatchObject({
      data: { code: 'REVISION_CONFLICT' },
    })
    vi.spyOn(v.deps.workspaces, 'restoreBinding').mockRejectedValue(
      new Error('private-path secret://private'),
    )
    const error = await v.run(v.start).catch((error: unknown) => error)
    expect(JSON.stringify(error)).not.toContain('secret://')
    expect(String(error)).not.toContain('private-path')
  })
})

async function credentialFixture(frequency: 0.5 | 1 | 2 = 2) {
  const root = mkdtempSync(join(tmpdir(), 'agh-recognition-effect-'))
  cleanup.push(async () => {
    rmSync(root, { recursive: true, force: true })
  })
  const store = createCredentialStore({ root: join(root, 'home') })
  const v = await setup(store, frequency)
  const authorization = { revoked: new AbortController().signal, assertAuthorized: vi.fn(() => {}) }
  const scope = { ...v.scope, service: 'aka.recognition.test' }
  const signal = new AbortController()
  const readStored = store.read.bind(store)
  const read = vi.spyOn(store, 'read')
  return {
    ...v,
    store,
    authorization,
    scope,
    signal,
    read,
    readStored,
    resolve: () =>
      resolveDeviceRecognitionCredentialForEffect(
        v.deps,
        'device',
        { bindingRevision: 1, configRevision: 1 },
        scope,
        authorization,
        signal.signal,
      ),
  }
}
describe('backend-only recognition credential consumption', () => {
  it('reads the current private credential with real store enforcement and frozen backend values', async () => {
    const v = await credentialFixture()
    const result = await v.resolve()
    expect(result.provider).toBe('aliyun')
    expect(Object.isFrozen(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(JSON.stringify(result)).not.toContain('synthetic-id')
    if (result.provider !== 'aliyun') throw new Error('wrong provider')
    const consume = vi.fn(async (credentials, signal) => {
      expect(credentials).toEqual({ accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' })
      expect(Object.isFrozen(credentials)).toBe(true)
      expect(signal.aborted).toBe(false)
      return { accepted: true }
    })
    await expect(result.run(consume)).resolves.toEqual({ accepted: true })
    expect(v.read).toHaveBeenCalledTimes(1)
    expect(v.authorization.assertAuthorized).toHaveBeenCalled()
  })
  it.each(['scope', 'plugin', 'service', 'owner', 'grant', 'cancel', 'missing-store', 'versions'] as const)(
    'refuses %s before private storage access',
    async (mode) => {
      const v = await credentialFixture()
      if (mode === 'scope') v.ac.abort()
      if (mode === 'plugin') v.scope.extension = 'plugin/other'
      if (mode === 'service') v.scope.service = 'aka.recognition.round.start'
      if (mode === 'owner') vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue(undefined)
      if (mode === 'grant')
        v.authorization.assertAuthorized.mockImplementation(() => {
          throw new Error('private grant details')
        })
      if (mode === 'cancel') v.signal.abort()
      if (mode === 'missing-store') v.deps.credentials = undefined
      if (mode === 'versions')
        v.deps.bindings.recognition.save(v.authority, {
          expectedBindingRevision: 1,
          expectedConfigRevision: 1,
          settings: null,
        })
      await expect(v.resolve()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(v.read).not.toHaveBeenCalled()
    },
  )
  it.each(['scope', 'owner', 'grant', 'cancel', 'configuration', 'binding', 'storage-error'] as const)(
    'rechecks %s after asynchronous credential read and never returns late secrets',
    async (mode) => {
      const v = await credentialFixture()
      const read = v.readStored
      v.read.mockImplementationOnce(async (ref) => {
        if (mode === 'storage-error') throw new Error('private-path secret://private synthetic-secret')
        const record = await read(ref)
        if (mode === 'scope') v.ac.abort()
        if (mode === 'owner') vi.spyOn(v.deps.ownership, 'resolve').mockReturnValue(undefined)
        if (mode === 'grant')
          v.authorization.assertAuthorized.mockImplementation(() => {
            throw new Error('synthetic-secret')
          })
        if (mode === 'cancel') v.signal.abort()
        if (mode === 'configuration')
          v.deps.bindings.recognition.save(v.authority, {
            expectedBindingRevision: 1,
            expectedConfigRevision: 1,
            settings: null,
          })
        if (mode === 'binding') v.deps.bindings.detach(v.authority, 1)
        return record
      })
      const result = await v.resolve().catch((error: unknown) => error)
      expect(result).toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(JSON.stringify(result)).not.toContain('synthetic-secret')
      expect(JSON.stringify(result)).not.toContain('secret://')
      expect(String(result)).not.toContain('private-path')
    },
  )
  it.each([false, true])(
    'resolves local provider with optional token %s, never via cloud credentials',
    async (withToken) => {
      const v = await credentialFixture()
      const credentialRef = withToken
        ? await stageDeviceRecognitionToken(v.store, v.deviceId, 'local-synthetic-token', v.signal.signal)
        : null
      v.deps.bindings.recognition.save(v.authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        settings: {
          provider: 'local-yolo',
          frequency: 2,
          requestBudget: 2,
          baseUrl: 'http://127.0.0.1:8000',
          credentialRef,
        },
      })
      v.read.mockClear()
      const result = await resolveDeviceRecognitionCredentialForEffect(
        v.deps,
        'device',
        { bindingRevision: 1, configRevision: 2 },
        v.scope,
        v.authorization,
        v.signal.signal,
      )
      expect(result).toMatchObject({ provider: 'local-yolo', baseUrl: 'http://127.0.0.1:8000/' })
      expect(JSON.stringify(result)).not.toContain('local-synthetic-token')
      if (result.provider !== 'local-yolo') throw new Error('wrong provider')
      await expect(result.run(async (token) => token)).resolves.toBe(
        withToken ? 'local-synthetic-token' : null,
      )
      expect(v.read).toHaveBeenCalledTimes(withToken ? 1 : 0)
    },
  )
})

it.each(['cancel', 'grant', 'configuration', 'scope'] as const)(
  'revokes retained credential consumption for %s before any backend effect',
  async (mode) => {
    const v = await credentialFixture()
    const access = await v.resolve()
    if (access.provider !== 'aliyun') throw new Error('wrong provider')
    if (mode === 'cancel') v.signal.abort()
    if (mode === 'scope') v.ac.abort()
    if (mode === 'grant')
      v.authorization.assertAuthorized.mockImplementation(() => {
        throw new Error('revoked')
      })
    if (mode === 'configuration')
      v.deps.bindings.recognition.save(v.authority, {
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
        settings: null,
      })
    const operation = vi.fn(async () => ({ accepted: true }))
    await expect(access.run(operation)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(operation).not.toHaveBeenCalled()
  },
)
it('holds credential effect completion until actual settlement and discards a revoked response', async () => {
  const v = await credentialFixture(),
    access = await v.resolve()
  if (access.provider !== 'aliyun') throw new Error('wrong provider')
  let finish: ((value: unknown) => void) | undefined
  const started = vi.fn(
    async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const running = access.run(started)
  let settled = false
  const check = running.catch((error) => {
    settled = true
    return error
  })
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
  await expect(access.run(started)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(started).toHaveBeenCalledTimes(1)
  v.ac.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  finish?.({ privateReply: 'must-not-return' })
  const error = await check
  expect(error).toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(JSON.stringify(error)).not.toContain('must-not-return')
})

it('waits for backend authorization and rechecks revocation before reading secrets', async () => {
  const v = await credentialFixture()
  let finish: (() => void) | undefined
  v.authorization.assertAuthorized.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const resolving = v.resolve()
  const denied = expect(resolving).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  await vi.waitFor(() => expect(v.authorization.assertAuthorized).toHaveBeenCalledTimes(1))
  expect(v.read).not.toHaveBeenCalled()
  v.ac.abort()
  finish?.()
  await denied
  expect(v.read).not.toHaveBeenCalled()
})
