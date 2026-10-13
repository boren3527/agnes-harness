import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { seams as baseSeams } from '@agnes/base'
import { fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import { describe, expect, it, vi } from 'vitest'
import { createLocalArtifactReadStore } from '../../src/artifact-read-store.js'
import { createDeviceCapturePublisher } from '../../src/ext-host/device-capture-publisher.js'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import {
  auditKinds,
  type PluginHost,
  pluginHost,
  pluginRow,
  pluginSource,
  pluginSourceWith,
  rowState,
  settle,
  targetOf,
  toolNames,
} from './plugin-extension-fixture.js'

const ROW = 'ext:acme/plugin-tools'
const SOURCE = pluginRowSource(ROW)
const probe = () => (globalThis as { __pluginProbe?: Record<string, unknown> }).__pluginProbe ?? {}
const resetProbe = () => {
  ;(globalThis as { __pluginProbe?: Record<string, unknown> }).__pluginProbe = {}
}

describe('a third-party row registers through ctx.extension()', () => {
  it('admits actual AKA connection effects only with trusted journal admission and disposes the connection on unload', async () => {
    const ROW = 'ext:agnes-examples/aka-robot'
    const SOURCE = pluginRowSource(ROW)
    const akaEntry = '../../../../examples/packages/aka-robot-plugin/index.js'
    const httpEntry = '../../../../examples/packages/aka-robot-plugin/src/http-driver.js'
    const channelEntry = '../../../../examples/packages/aka-robot-plugin/src/control-channel.js'
    const { runtime: akaRuntime } = await import(akaEntry)
    const { AkaHttpDriver } = await import(httpEntry)
    const { AkaControlChannel } = await import(channelEntry)
    const deviceId = '11111111-1111-4111-8111-111111111111'
    const macAddress = '12:34:56:78:90:ab'
    const workspaceId = 'a'.repeat(64)
    const connection = {
      deviceId,
      bindingRevision: 1,
      profile: { driver: 'aka-00', ip: '192.168.50.42', port: 80, macAddress, configRevision: 1 },
    }
    const bindingLifetime = new AbortController()
    const heartbeat = vi.spyOn(AkaHttpDriver.prototype, 'heartbeat').mockResolvedValue({
      service: 'AKA-00',
      identity: { macAddress, validity: 'reported' },
    })
    const cameraStatus = vi.spyOn(AkaHttpDriver.prototype, 'cameraStatus').mockResolvedValue(false)
    const open = vi.spyOn(AkaControlChannel.prototype, 'open').mockResolvedValue(undefined)
    const close = vi.spyOn(AkaControlChannel.prototype, 'close')
    const stream = vi
      .spyOn(AkaHttpDriver.prototype, 'stream')
      .mockRejectedValue(new Error('Unexpected stream'))
    const camera = vi
      .spyOn(AkaHttpDriver.prototype, 'setCamera')
      .mockRejectedValue(new Error('Unexpected camera effect'))
    const move = vi.spyOn(AkaHttpDriver.prototype, 'move').mockRejectedValue(new Error('Unexpected move'))
    const captureOps: string[] = []
    let savedCapture: import('@agnes/protocol').DeviceCaptureRecord | null = null
    const captureId = '11111111-1111-4111-8111-111111111111'
    let active = true
    const captureProvider = fakeProvider([toolTurn('aka_capture', {}), textTurn('saved')], '2')
    // Keep unrelated seam substitutes, but exercise Base's actual disk artifact writer.
    const h = await pluginHost(pluginSource('', 'plugin', ROW), {
      provider: captureProvider,
      deviceCaptureSelection: async (key, callId, raw, signal) => {
        if (key !== 'aka-effect' || callId !== 'a'.repeat(32)) throw new Error('Unexpected capture scope')
        signal.throwIfAborted()
        const input = raw as {
          operation: string
          selection?: import('@agnes/protocol').DeviceCaptureSelection
          eventSeq?: number
        }
        captureOps.push(input.operation)
        if (input.operation === 'read') return savedCapture
        if (input.operation === 'select') {
          if (!input.selection) throw new Error('Missing selection')
          const fresh = savedCapture === null
          savedCapture ??= { selection: input.selection, stage: 'selected', eventSeq: null }
          return { fresh, record: savedCapture }
        }
        if (!savedCapture) throw new Error('Missing capture')
        if (input.operation === 'publication') return { captureId, record: savedCapture }
        // Metadata bridge substitute verifies the actual bytes and durable event; it is not a daemon worker test.
        const ref = savedCapture.selection.artifact
        const bytes = await createLocalArtifactReadStore({
          dataDir: h.dataDir,
          maxArtifactBytes: 4 * 1024 * 1024,
        }).get(ref, signal)
        if (
          !bytes ||
          createHash('sha256').update(bytes).digest('hex') !== ref.sha256 ||
          bytes.length !== ref.size
        )
          throw new Error('Missing bytes')
        if (input.operation === 'recorded') {
          if (!input.eventSeq) throw new Error('Missing event sequence')
          const events = await h.host.kernel
            .get(key)
            ?.scan({ fromSeq: input.eventSeq, toSeq: input.eventSeq, limit: 1 })
          if (events?.[0]?.type !== 'x/core/device-capture' || events[0].seq !== input.eventSeq)
            throw new Error('Missing capture event')
          savedCapture = { ...savedCapture, stage: 'recorded', eventSeq: input.eventSeq ?? null }
        } else if (savedCapture.stage !== 'recorded') savedCapture = { ...savedCapture, stage: 'stored' }
        return savedCapture
      },
      seamFactories: { artifacts: baseSeams.artifacts },
      deviceSession: async (key, _signal, view) =>
        view === 'connection'
          ? connection
          : {
              workspace: { workspaceId, deviceId, revision: 1, active },
              session: { sessionId: key, workspaceId, deviceId, bindingRevision: 1, active },
            },
      deviceSessionRetain: async (key, _signal, lifetime) => ({
        connection,
        snapshot: {
          workspace: { workspaceId, deviceId, revision: 1, active },
          session: { sessionId: key, workspaceId, deviceId, bindingRevision: 1, active },
        },
        revoked: AbortSignal.any([lifetime, bindingLifetime.signal]),
        release() {},
      }),
      disableSessionTitle: true,
      extensionLoader: { import: async () => ({ plugin: akaRuntime }) },
      serviceAuthority: {
        async resolve() {
          return {
            source: 'test-surface',
            subjectCredential: 'trusted',
            grants: [
              'aka.status',
              'aka.media.ticket',
              'aka.probe',
              'aka.connect',
              'aka.disconnect',
              'aka.camera.set',
              'aka.capture',
            ].map((name) => ({
              extension: SOURCE,
              name,
              range: '^2.3',
            })),
          }
        },
      },
    })
    try {
      const row = Object.freeze({
        ...pluginRow(ROW),
        config: { devices: [] },
      })
      expect((await h.host.applyRuntimeTarget(targetOf([row]))).ok).toBe(true)
      const session = await h.host.createSession({ cwd: h.dataDir, key: 'aka-effect' })
      const params = {
        sessionId: 'aka-effect',
        extension: SOURCE,
        service: 'aka.connect',
        input: { configRevision: 1 },
      }
      await expect(h.host.callService(params, 'test-credential')).rejects.toMatchObject({
        data: { code: 'INVALID_PARAMS' },
      })
      await expect(
        h.host.callService({ ...params, commandId: 'connect-1' }, 'test-credential'),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      await expect(
        h.host.callService({ ...params, commandId: 'connect-1' }, 'test-credential', undefined, {
          commandId: 'other',
        }),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(heartbeat).not.toHaveBeenCalled()
      const probe = {
        ...params,
        service: 'aka.probe',
        input: {
          ip: '192.168.50.42',
          port: 80,
          bindingRevision: 1,
          expectedConfigRevision: 1,
        },
        commandId: 'probe-1',
      }
      await expect(h.host.callService(probe, 'test-credential')).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(heartbeat).not.toHaveBeenCalled()
      await expect(
        h.host.callService(probe, 'test-credential', undefined, {
          commandId: 'probe-1',
        }),
      ).resolves.toMatchObject({
        output: { deviceId, macAddress, identity: 'reported', expectedConfigRevision: 1 },
      })
      expect(stream).not.toHaveBeenCalled()
      expect(camera).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()
      // Synthetic trusted admission tests the real Host guard; it does not exercise daemon journaling.
      await expect(
        h.host.callService({ ...params, commandId: 'connect-1' }, 'test-credential', undefined, {
          commandId: 'connect-1',
        }),
      ).resolves.toMatchObject({
        output: { state: 'connected', snapshot: { connection: 'connected', cameraOn: false } },
      })
      await expect(
        h.host.callService({ ...params, service: 'aka.status', input: {} }, 'test-credential'),
      ).resolves.toMatchObject({
        output: { enrollment: 'active', runtime: { connection: 'connected' }, automaticActions: false },
      })
      expect(stream).not.toHaveBeenCalled()
      expect(camera).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()
      const cameraParams = { ...params, service: 'aka.camera.set', input: { configRevision: 1, open: true } }
      await expect(h.host.callService(cameraParams, 'test-credential')).rejects.toMatchObject({
        data: { code: 'INVALID_PARAMS' },
      })
      await expect(
        h.host.callService({ ...cameraParams, commandId: 'camera-open' }, 'test-credential'),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(stream).not.toHaveBeenCalled()
      let mediaSignal: AbortSignal | undefined
      let receiveFrame: ((frame: { bytes: Buffer; width: number; height: number }) => void) | undefined
      stream.mockImplementation((...args: unknown[]) => {
        const signal = args[1]
        if (!(signal instanceof AbortSignal)) throw new Error('Expected media lifetime')
        mediaSignal = signal
        receiveFrame = args[2] as typeof receiveFrame
        return new Promise<void>(() => {})
      })
      camera.mockResolvedValue(true)
      await expect(
        h.host.callService({ ...cameraParams, commandId: 'camera-open' }, 'test-credential', undefined, {
          commandId: 'camera-open',
        }),
      ).resolves.toMatchObject({
        output: { state: 'opening', snapshot: { media: 'opening', cameraOn: null } },
      })
      expect(mediaSignal?.aborted).toBe(false)
      const mediaTicket = await h.host.callService(
        { ...params, service: 'aka.media.ticket', input: { configRevision: 1, bindingRevision: 1 } },
        'test-credential',
      )
      const mediaEndpoint = h.host.deviceMediaEndpoint(ROW)
      expect(mediaEndpoint).not.toBeNull()
      expect(mediaTicket.output).toMatchObject({
        deviceId,
        expiresInMs: 30_000,
        ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        rowRevision: mediaEndpoint?.rowRevision,
      })
      expect(JSON.stringify(mediaTicket)).not.toContain(mediaEndpoint?.authorization)
      if (!receiveFrame) throw new Error('Missing actual runtime frame callback')
      const captureBytes = readFileSync(new URL('../fixtures/aka-camera-test.jpg', import.meta.url))
      receiveFrame({
        bytes: captureBytes,
        width: 320,
        height: 240,
      })
      expect(toolNames(h)).toContain('aka_capture')
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: '保存当前小车画面' }],
        kind: 'prompt',
      })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const captures = JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq }))
      expect(captures).toContain('image/jpeg')
      expect(captures).toContain('ageAtSelectionMs')
      expect(captures).toContain('bridge_receive')
      const digest = createHash('sha256').update(captureBytes).digest('hex')
      expect(captures).toContain(`artifact://${digest}`)
      expect((await session.projectUI()).nodes).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          name: 'aka_capture',
          resultSeq: expect.any(Number),
        }),
      )
      const persistedRef = { sha256: digest, size: captureBytes.length, mime: 'image/jpeg' }
      receiveFrame({ bytes: captureBytes, width: 320, height: 240 })
      const captureParams = {
        ...params,
        service: 'aka.capture',
        commandId: 'capture-1',
        input: { bindingRevision: 1, configRevision: 1 },
      }
      await expect(
        h.host.callService({ ...params, commandId: 'connect-recovery' }, 'test-credential', undefined, {
          commandId: 'connect-recovery',
          callId: 'a'.repeat(32),
          recoverOnly: true,
        }),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      await expect(h.host.callService(captureParams, 'test-credential')).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      // A trusted command without the worker call nonce must not acquire the private artifact port.
      await expect(
        h.host.callService(captureParams, 'test-credential', undefined, { commandId: 'capture-1' }),
      ).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
      const captured = await h.host
        .callService(captureParams, 'test-credential', undefined, {
          commandId: 'capture-1',
          callId: 'a'.repeat(32),
        })
        .catch(() => {
          throw new Error(`Capture failed after ${captureOps.join(',')}`)
        })
      expect(captured.output).toMatchObject({
        deviceId,
        artifact: persistedRef,
        eventSeq: expect.any(Number),
      })
      const eventSeq = (captured.output as { eventSeq: number }).eventSeq
      expect(
        await h.host.callService(captureParams, 'test-credential', undefined, {
          commandId: 'capture-1',
          callId: 'a'.repeat(32),
          recoverOnly: true,
        }),
      ).toEqual(captured)
      const publish = createDeviceCapturePublisher((key) => h.host.kernel.get(key))
      expect(
        await publish(
          'aka-effect',
          captureId,
          persistedRef,
          session.d.actor,
          new AbortController().signal,
          async () => {},
        ),
      ).toBe(eventSeq)
      expect(await session.scan({ type: 'x/core/device-capture', toSeq: session.lastSeq })).toHaveLength(1)
      expect((await session.projectUI()).nodes).toContainEqual(
        expect.objectContaining({ kind: 'artifact', seq: eventSeq, name: captureId, ref: persistedRef }),
      )
      expect(
        await createLocalArtifactReadStore({ dataDir: h.dataDir, maxArtifactBytes: 4 * 1024 * 1024 }).get(
          persistedRef,
          new AbortController().signal,
        ),
      ).toEqual(Uint8Array.from(captureBytes))
      camera.mockResolvedValueOnce(false)
      await expect(
        h.host.callService(
          { ...cameraParams, commandId: 'camera-close', input: { configRevision: 1, open: false } },
          'test-credential',
          undefined,
          { commandId: 'camera-close' },
        ),
      ).resolves.toMatchObject({ output: { state: 'closed', snapshot: { cameraOn: false, media: 'idle' } } })
      expect(mediaSignal?.aborted).toBe(true)
      await h.host.callService(
        { ...cameraParams, commandId: 'camera-open-2' },
        'test-credential',
        undefined,
        { commandId: 'camera-open-2' },
      )
      expect(mediaSignal?.aborted).toBe(false)
      active = false
      bindingLifetime.abort()
      expect(mediaSignal?.aborted).toBe(true)
      expect(close).toHaveBeenCalled()
      await expect(
        h.host.callService({ ...params, commandId: 'connect-2' }, 'test-credential', undefined, {
          commandId: 'connect-2',
        }),
      ).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
      await expect(
        h.host.callService({ ...params, service: 'aka.status', input: {} }, 'test-credential'),
      ).resolves.toMatchObject({ output: { enrollment: 'inactive', runtime: null } })
      await h.host.applyRuntimeTarget(targetOf([]))
      expect(close).toHaveBeenCalled()
      expect(toolNames(h)).not.toContain('aka_observe')
      await session.close()
      const reopened = await h.host.createSession({ cwd: h.dataDir, key: 'aka-effect' })
      try {
        const retryPublish = createDeviceCapturePublisher((key) => h.host.kernel.get(key))
        expect(
          await retryPublish(
            'aka-effect',
            captureId,
            persistedRef,
            reopened.d.actor,
            new AbortController().signal,
            async () => {},
          ),
        ).toBe(eventSeq)
        expect(await reopened.scan({ type: 'x/core/device-capture', toSeq: reopened.lastSeq })).toHaveLength(
          1,
        )
        expect((await reopened.projectUI()).nodes).toContainEqual(
          expect.objectContaining({ kind: 'artifact', seq: eventSeq, name: captureId, ref: persistedRef }),
        )
        expect(
          JSON.stringify(await reopened.scan({ type: 'tool/result', toSeq: reopened.lastSeq })),
        ).toContain(`artifact://${digest}`)
        expect((await reopened.projectUI()).nodes).toContainEqual(
          expect.objectContaining({
            kind: 'tool',
            name: 'aka_capture',
            resultSeq: expect.any(Number),
          }),
        )
        expect(
          await createLocalArtifactReadStore({ dataDir: h.dataDir, maxArtifactBytes: 4 * 1024 * 1024 }).get(
            persistedRef,
            new AbortController().signal,
          ),
        ).toEqual(Uint8Array.from(captureBytes))
      } finally {
        await reopened.close()
      }
    } finally {
      await h.host.close()
      for (const spy of [heartbeat, cameraStatus, open, close, stream, camera, move]) spy.mockRestore()
    }
  })

  it('mounts the actual AKA factory and supplies device-scoped model context, observation and status service', async () => {
    // Load the public example as a runtime fixture, without adding examples to Host's product project graph.
    const akaEntry = '../../../../examples/packages/aka-robot-plugin/index.js'
    const { runtime: akaRuntime } = await import(akaEntry)
    const deviceId = '11111111-1111-4111-8111-111111111111'
    const workspaceId = 'a'.repeat(64)
    const bridge = vi.fn(async (key: string, _signal: AbortSignal, view?: 'connection' | 'recognition') =>
      view === 'connection'
        ? { deviceId, bindingRevision: 1, profile: null }
        : {
            workspace: { workspaceId, deviceId, revision: 1, active: true },
            session:
              key === 'aka-ordinary'
                ? null
                : {
                    sessionId: key,
                    workspaceId,
                    deviceId,
                    bindingRevision: 1,
                    active: key !== 'aka-history',
                  },
          },
    )
    const provider = fakeProvider(
      [
        toolTurn('aka_observe', {}),
        textTurn('done'),
        toolTurn('aka_observe', {}),
        textTurn('done'),
        toolTurn('aka_observe', {}),
        textTurn('done'),
      ],
      '2',
    )
    const source = pluginSource('')
    const h = await pluginHost(source, {
      provider,
      deviceSession: bridge,
      disableSessionTitle: true,
      // Real Host mounting/registrations; import the actual example's public module instead of a copied factory.
      extensionLoader: { import: async () => ({ plugin: akaRuntime }) },
      serviceAuthority: {
        async resolve() {
          return {
            source: 'test-surface',
            subjectCredential: 'trusted',
            grants: [{ extension: SOURCE, name: 'aka.status', range: '^2.3' }],
          }
        },
      },
    })
    try {
      expect((await h.host.applyRuntimeTarget(targetOf([pluginRow()]))).ok).toBe(true)
      for (const [key, enrollment] of [
        ['aka-device', 'active'],
        ['aka-ordinary', 'ordinary'],
        ['aka-history', 'inactive'],
      ] as const) {
        const session = await h.host.createSession({ cwd: h.dataDir, key })
        const start = provider.requests.length
        try {
          await expect(
            h.host.callService(
              { sessionId: key, extension: SOURCE, service: 'aka.status', input: {} },
              'test-credential',
            ),
          ).resolves.toMatchObject({
            output: { enrollment, configured: false, runtime: null, automaticActions: false },
          })
          await session.enqueue('next-turn', {
            actor: session.d.actor,
            content: [{ type: 'text', text: '查询设备状态' }],
            kind: 'prompt',
          })
          expect(
            (await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
          ).toBe('completed')
          expect(
            JSON.stringify(await session.scan({ type: 'tool/result', toSeq: session.lastSeq })),
          ).toContain(`\\"enrollment\\":\\"${enrollment}\\"`)
          const requests = JSON.stringify(provider.requests.slice(start))
          if (enrollment === 'ordinary') expect(requests).not.toContain('aka/device-state')
          else expect(requests).toContain('当前会话 AKA 设备快照')
        } finally {
          await session.close()
        }
      }
      await h.host.applyRuntimeTarget(targetOf([]))
      expect(toolNames(h)).not.toContain('aka_observe')
    } finally {
      await h.host.close()
    }
  })

  it('provides device enrollment to the actual context and tool calls without inheriting into ordinary sessions', async () => {
    const bridge = vi.fn(async (key: string, _signal: AbortSignal, view?: 'connection' | 'recognition') =>
      view
        ? {
            deviceId: '11111111-1111-4111-8111-111111111111',
            bindingRevision: 1,
            profile: {
              driver: 'aka-00',
              ip: '192.168.1.42',
              port: 80,
              macAddress: '12:34:56:78:90:ab',
              configRevision: 1,
            },
          }
        : {
            workspace: {
              workspaceId: 'a'.repeat(64),
              deviceId: '11111111-1111-4111-8111-111111111111',
              revision: 1,
              active: true,
            },
            session:
              key === 'device-session'
                ? {
                    sessionId: key,
                    workspaceId: 'a'.repeat(64),
                    deviceId: '11111111-1111-4111-8111-111111111111',
                    bindingRevision: 1,
                    active: true,
                  }
                : null,
          },
    )
    const provider = fakeProvider(
      [toolTurn('device_observe', {}), textTurn('done'), toolTurn('device_observe', {}), textTurn('done')],
      '2',
    )
    const source = pluginSource(`
  agnes.registerHook('context', async (_payload, ctx) => {
    const binding = await ctx.device.binding()
    const connection = binding?.active ? await ctx.device.connection() : null
    return binding?.active ? { additionalContext: 'enrolled-context:' + binding.sessionId + ':profile:' + connection.profile.ip } : {}
  })
  agnes.registerTool({ ...tool('device_observe'),
    parameters: { [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_args, ctx) {
      const binding = await ctx.device.binding()
      const connection = binding?.active ? await ctx.device.connection() : null
      return { content: [{ type: 'text', text: binding?.active ? 'enrolled-tool:' + binding.sessionId + ':profile:' + connection.profile.ip : 'ordinary-tool' }] }
    }
  })
`)
    const h = await pluginHost(source, { deviceSession: bridge, provider, disableSessionTitle: true })
    try {
      expect((await h.host.applyRuntimeTarget(targetOf([pluginRow()]))).ok).toBe(true)
      for (const key of ['device-session', 'ordinary-session']) {
        const session = await h.host.createSession({ cwd: h.dataDir, key })
        const start = provider.requests.length
        try {
          await session.enqueue('next-turn', {
            actor: session.d.actor,
            content: [{ type: 'text', text: 'observe' }],
            kind: 'prompt',
          })
          const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
          expect(
            outcome.reason,
            JSON.stringify(await session.scan({ type: 'turn/end', toSeq: session.lastSeq })),
          ).toBe('completed')
          const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
          expect(JSON.stringify(results)).toContain(
            key === 'device-session' ? 'enrolled-tool:device-session:profile:192.168.1.42' : 'ordinary-tool',
          )
          const requests = JSON.stringify(provider.requests.slice(start))
          if (key === 'device-session')
            expect(requests).toContain('enrolled-context:device-session:profile:192.168.1.42')
          else {
            expect(requests).not.toContain('enrolled-context:')
            expect(requests).not.toContain('192.168.1.42')
          }
        } finally {
          await session.close()
        }
      }
      expect(bridge.mock.calls.map(([key]) => key)).toContain('ordinary-session')
      expect(bridge.mock.calls.map(([key]) => key)).toContain('device-session')
    } finally {
      await h.host.close()
    }
  })

  it('adds a tool and an observe hook owned by a Host-stamped source', async () => {
    const h = await pluginHost(
      pluginSource(`
  agnes.registerTool(tool('plugin_echo'))
  agnes.on('session_start', () => {})
`),
    )
    const report = await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()

    expect(report.ok).toBe(true)
    expect(rowState(h, ROW)).toBe('active')
    expect(toolNames(h)).toContain('plugin_echo')
    const registered = h.host.kernel.tools.resolve('plugin_echo')
    expect(registered?.source).toEqual({ source: SOURCE, trust: 'trusted' })
    expect(registered?.packageIdentity).toBe('@acme/plugin-tools')
    expect(registered?.packageVersion).toBe('2.3.4')
    expect(registered?.executionDomain).toBe('workspace')
    expect(h.host.kernel.registrations(SOURCE)).toEqual(['tool:plugin_echo', 'hook:session_start'])

    const status = h.host.extensions().find((e) => e.id === SOURCE)
    expect(status).toMatchObject({
      package: '@acme/plugin-tools',
      version: '2.3.4',
      trust: 'trusted',
      loaded: true,
    })
    expect(auditKinds(h, 'extension.registered').map((e) => e.detail?.name)).toEqual([
      'plugin_echo',
      'session_start',
    ])
    expect(auditKinds(h, 'extension.loaded').some((e) => e.detail?.id === SOURCE)).toBe(true)
    await h.host.close()
  })

  it('runs the tool through its lease and drops it when the row goes', async () => {
    const h = await pluginHost(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    expect(h.host.extensions().find((e) => e.id === SOURCE)?.lease?.scope.toolPrefix).toBe('')

    await h.host.applyRuntimeTarget(targetOf([]))
    await settle()

    expect([...h.host.kernel.tools.snapshot(0).byName.keys()]).not.toContain('plugin_echo')
    expect(h.host.kernel.registrations(SOURCE)).toEqual([])
    expect(auditKinds(h, 'extension.revoked').filter((e) => e.detail?.id === SOURCE)).toHaveLength(1)
    expect(h.host.extensions().find((e) => e.id === SOURCE)?.loaded).toBe(false)
    await h.host.close()
  })

  it('refuses everything that is not a tool, any hook event (via registerHook) or a ledger event', async () => {
    resetProbe()
    const h = await pluginHost(
      pluginSource(`
  const refused = {}
  const attempt = (label, run) => { try { run(); refused[label] = 'allowed' } catch (e) { refused[label] = e.code } }
  attempt('rewriting hook', () => agnes.on('tool_call', () => {}))
  attempt('registerHook', () => agnes.registerHook('tool_call', () => {}))
  attempt('registerSlot', () => agnes.registerSlot('status.line', () => null))
  attempt('registerService', () => agnes.registerService({}))
  attempt('registerProjection', () => agnes.registerProjection({}))
  attempt('registerResource', () => agnes.registerResource({}))
  attempt('observe hook', () => agnes.on('shutdown', () => {}))
  globalThis.__pluginProbe = { refused }
`),
    )
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    expect(probe().refused).toEqual({
      'rewriting hook': 'E_CAPABILITY_UNDECLARED',
      registerHook: 'allowed',
      registerSlot: 'E_CAPABILITY_UNDECLARED',
      registerService: 'E_CAPABILITY_UNDECLARED',
      registerProjection: 'E_CAPABILITY_UNDECLARED',
      registerResource: 'E_CAPABILITY_UNDECLARED',
      'observe hook': 'allowed',
    })
    await h.host.close()
  })

  it('cannot take a builtin tool name', async () => {
    const source = pluginSource(`  agnes.registerTool(tool('grep'))`)
    const h = await pluginHost(source)
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))).rejects.toThrow(/reserved/)
    await settle()
    expect(h.host.kernel.tools.resolve('grep')?.source.source).not.toBe(SOURCE)
    expect(auditKinds(h, 'extension.registered')).toEqual([])
    await h.host.close()
  })

  // agnes/mcp-search declares its two tool names (design §3.9, D123), so as a builtin row they are
  // reserved like any other builtin's. agnes/mcp-client declared none, so nothing was reserved before.
  it('cannot take tool_search, which agnes/mcp-search declares', async () => {
    const source = pluginSource(`  agnes.registerTool(tool('tool_search'))`)
    const h = await pluginHost(source)
    await expect(h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))).rejects.toThrow(/reserved/)
    await settle()
    expect(h.host.kernel.tools.resolve('tool_search')?.source.source).toBe('agnes/mcp-search')
    await h.host.close()
  })

  it('runs its observe hooks for sessions, and says shutdown to open ones when the row goes', async () => {
    resetProbe()
    const h = await pluginHost(
      pluginSource(`
  const events = (globalThis.__pluginProbe = { events: [] }).events
  agnes.on('session_start', () => { events.push('session_start') })
  agnes.on('shutdown', (payload) => { events.push('shutdown:' + payload.reason) })
`),
    )
    await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
    await settle()
    const session = await h.host.createSession({ cwd: h.dataDir })
    await settle()
    expect(probe().events).toEqual(['session_start'])

    await h.host.applyRuntimeTarget(targetOf([]))
    await settle()
    expect(probe().events).toEqual(['session_start', 'shutdown:revoke'])
    expect(h.host.kernel.registrations(SOURCE)).toEqual([])
    await session.close()
    await h.host.close()
  })

  it('refuses a replacement of a governance builtin that leaves its hooks out', async () => {
    const empty = await pluginHost(pluginSource('  void agnes'))
    await expect(empty.host.applyRuntimeTarget(targetOf([pluginRow('ext:agnes/privacy')]))).rejects.toThrow(
      /must register hooks: session_start, shutdown/,
    )
    expect(rowState(empty, 'ext:agnes/privacy')).toBe('active')
    expect(empty.host.ordinaryConvergence().rows.find((r) => r.id === 'ext:agnes/privacy')).toBeDefined()
    await empty.host.close()

    const complete = await pluginHost(
      pluginSource(`
  agnes.on('session_start', () => {})
  agnes.on('shutdown', () => {})
`),
    )
    const report = await complete.host.applyRuntimeTarget(targetOf([pluginRow('ext:agnes/privacy')]))
    expect(report.ok).toBe(true)
    await complete.host.close()
  })

  it('fails the target when two different rows register the same tool name', async () => {
    const h = await pluginHost(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    await expect(
      h.host.applyRuntimeTarget(targetOf([pluginRow('ext:acme/first'), pluginRow('ext:acme/second')])),
    ).rejects.toThrow(/E_REGISTRY_DUPLICATE/)
    await settle()
    expect(h.host.kernel.registrations(pluginRowSource('ext:acme/second'))).toEqual([])
    await h.host.close()
  })

  it('stays out of the way when the same row is applied again', async () => {
    const h = await pluginHost(
      pluginSource(`
  agnes.registerTool(tool('plugin_echo'))
  agnes.on('session_start', () => {})
`),
    )
    for (let round = 0; round < 3; round++) {
      const report = await h.host.applyRuntimeTarget(targetOf([pluginRow(ROW)]))
      await settle()
      expect(report.ok).toBe(true)
    }
    expect(toolNames(h).filter((n) => n === 'plugin_echo')).toHaveLength(1)
    expect(h.host.kernel.registrations(SOURCE)).toEqual(['tool:plugin_echo', 'hook:session_start'])
    await h.host.close()
  })
})

describe('a third-party tool whose package comes back to a state the Host has already published', () => {
  const snapshot = (digit: string) => `sha256-${digit.repeat(64)}`
  const identity = (snapshotId: string) => ({ snapshotId })
  // The model-facing tool must carry a TypeBox schema, or the Host refuses the call's arguments.
  const OBJECT_SCHEMA = `{ [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {}, required: [], additionalProperties: false }`
  const echoTool = (text: string) =>
    `  agnes.registerTool({ ...tool('plugin_echo'), parameters: ${OBJECT_SCHEMA}, async execute() { return { content: [{ type: 'text', text: '${text}' }] } } })`
  // A provider whose next turn is a call to the named tool, so a test decides what the model does.
  const caller = () => {
    let next = fakeProvider([])
    const provider = { ...next, infer: (...args: Parameters<typeof next.infer>) => next.infer(...args) }
    return {
      provider,
      script: (name: string) => {
        next = fakeProvider([toolTurn(name, {}), textTurn('done')], '2')
      },
    }
  }
  type Session = Awaited<ReturnType<PluginHost['host']['createSession']>>
  // A call in a held session shows what a session that stays open across the change gets; a call in
  // no session opens one, which binds to the generation published at that moment.
  const callTool = async (h: PluginHost, driver: ReturnType<typeof caller>, name: string, held?: Session) => {
    driver.script(name)
    const session = held ?? (await h.host.createSession({ cwd: h.dataDir, key: `call-${Math.random()}` }))
    try {
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'go' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const data = (await session.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data
      return JSON.stringify(data)
    } finally {
      if (!held) await session.close()
    }
  }

  it('keeps answering after disable then enable, and after remove then reinstall', async () => {
    const driver = caller()
    const v1 = pluginSource(echoTool('plugin_echo'))
    const h = await pluginHost([v1], { provider: driver.provider })
    try {
      const enabled = targetOf([pluginRow()])
      const disabled = targetOf([pluginRow(ROW, 'plugin', true)])
      const removed = targetOf([])
      await h.host.applyRuntimeTarget(enabled)
      await settle()
      expect(await callTool(h, driver, 'plugin_echo')).toContain('plugin_echo')
      const held = await h.host.createSession({ cwd: h.dataDir, key: 'held-across-the-change' })

      // The same content comes back after each of these; the generation it maps to was published
      // before, and the lease its tool was registered under has been revoked since.
      for (const away of [disabled, removed]) {
        await h.host.applyRuntimeTarget(away)
        await settle()
        expect(toolNames(h)).not.toContain('plugin_echo')
        await h.host.applyRuntimeTarget(enabled)
        await settle()
        for (const session of [undefined, held]) {
          const outcome = await callTool(h, driver, 'plugin_echo', session)
          expect(outcome).not.toContain('lease revoked')
          expect(outcome).toContain('plugin_echo')
        }
      }
      await held.close()
    } finally {
      await h.host.close()
    }
  })

  it('keeps one shared generation across a registry-neutral change to the published target', async () => {
    const driver = caller()
    const h = await pluginHost([pluginSource(echoTool('plugin_echo'))], { provider: driver.provider })
    try {
      await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
      await settle()
      const held = await h.host.createSession({ cwd: h.dataDir, key: 'held-across-neutral' })
      // A web-only row changes the composite revision but not the registry revision, so the published
      // generation must not be pruned: a session opened afterwards binds to the same registries.
      await h.host.applyRuntimeTarget(targetOf([pluginRow(), pluginRow('web:acme/plugin-tools')]))
      await settle()
      const fresh = await h.host.createSession({ cwd: h.dataDir, key: 'opened-after-neutral' })
      expect(fresh.currentTools()).toBe(held.currentTools())
      expect(fresh.currentResources()).toBe(held.currentResources())
      expect(await callTool(h, driver, 'plugin_echo', fresh)).toContain('plugin_echo')
      await held.close()
      await fresh.close()
    } finally {
      await h.host.close()
    }
  })

  it('answers with the old version after v1 to v2 to v1', async () => {
    const driver = caller()
    const version = (id: string) =>
      pluginSourceWith(
        [
          {
            exportName: 'plugin',
            rowId: ROW,
            body: echoTool(`answer-${id}`),
          },
        ],
        identity(snapshot(id)),
      )
    const h = await pluginHost([version('1'), version('2')], {
      provider: driver.provider,
    })
    try {
      const at = (id: string) => targetOf([pluginRow(ROW, 'plugin', false, identity(id))])
      for (const id of ['1', '2', '1', '2']) {
        await h.host.applyRuntimeTarget(at(snapshot(id)))
        await settle()
        const outcome = await callTool(h, driver, 'plugin_echo')
        expect(outcome).not.toContain('lease revoked')
        expect(outcome).toContain(`answer-${id}`)
      }
    } finally {
      await h.host.close()
    }
  })
})

describe('installing a third-party tool row', () => {
  // The system string is cached across turns, so it must not depend on which tools happen to be disclosed.
  const turnWith = async (source: ReturnType<typeof pluginSource> | undefined) => {
    const provider = fakeProvider([textTurn('done')], '2')
    const h = await pluginHost(source ? [source] : [], { provider })
    try {
      if (source) {
        await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
        await settle()
      }
      const session = await h.host.createSession({ cwd: h.dataDir, key: 'system-stable-fixture' })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'hello' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(out.reason).toBe('completed')
    } finally {
      await h.host.close()
    }
    const request = provider.requests[0]
    if (!request) throw new Error('provider received no request')
    return request
  }

  it('keeps the wire system string byte-identical while adding an eagerly disclosed tool', async () => {
    const bare = await turnWith(undefined)
    const installed = await turnWith(pluginSource(`  agnes.registerTool(tool('plugin_echo'))`))
    // Without differing tool lists the equality below would prove nothing about the tool axis.
    expect(installed.tools.map((t) => t.name)).toContain('plugin_echo')
    expect(bare.tools.map((t) => t.name)).not.toContain('plugin_echo')
    expect(bare.system.length).toBeGreaterThan(500)
    expect(installed.system).toBe(bare.system)
  })
})

describe('a third-party tool whose description is too long for the wire', () => {
  it('fails that row with the tool name and the problem, and the next turn still reaches the model', async () => {
    const provider = fakeProvider([textTurn('done')], '2')
    const h = await pluginHost(
      pluginSource(`  agnes.registerTool({ ...tool('plugin_verbose'), description: 'v'.repeat(9000) })`),
      { provider },
    )
    try {
      let failure: unknown
      try {
        await h.host.applyRuntimeTarget(targetOf([pluginRow()]))
      } catch (error) {
        failure = error
      }
      await settle()
      expect(String(failure)).toContain('plugin_verbose')
      expect(String(failure)).toContain('description: must be at most 4096 UTF-16 code units')
      expect(h.host.kernel.tools.resolve('plugin_verbose')).toBeUndefined()
      const session = await h.host.createSession({ cwd: h.dataDir, key: 'verbose-tool-fixture' })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'hello' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(out.reason).toBe('completed')
      const types = (await session.scan({ toSeq: session.lastSeq })).map((event) => event.type)
      expect(JSON.stringify(types)).not.toContain('E_ENVELOPE')
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0]?.tools.map((t) => t.name)).not.toContain('plugin_verbose')
      await session.close()
    } finally {
      await h.host.close()
    }
  })
})
