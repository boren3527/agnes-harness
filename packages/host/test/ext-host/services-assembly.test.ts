import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sandboxWorkspaceProbe } from '@agnes/base'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { isServicePreDispatchFailure } from '../../src/ext-host/service-invocation.js'
import type { HostOptions } from '../../src/host.js'
import { PublicationGate } from '../../src/publication-gate.js'
import { createTestHost, type TestHost } from '../../testkit/index.js'

const held: { root: string; host: TestHost['host'] }[] = []
const packageId = '@agnes-test/service'
const rowId = 'ext:fixture/service'
const owner = pluginRowSource(rowId)
const snapshotId = `sha256-${'8'.repeat(64)}`
afterEach(async () => {
  for (const h of held.splice(0)) {
    await h.host.close()
    rmSync(h.root, { recursive: true, force: true })
  }
})

async function fixture(
  authorized = true,
  deviceSession?: HostOptions['deviceSession'],
  deviceRecognitionBudget?: HostOptions['deviceRecognitionBudget'],
  deviceRecognitionAuthorization?: HostOptions['deviceRecognitionAuthorization'],
  networkAllow?: readonly string[],
  inference?: Pick<
    HostOptions,
    'deviceRecognitionExecute' | 'deviceSessionRetain' | 'deviceCaptureSelection'
  >,
  budgetService = 'aka.recognition.test',
) {
  const rowId = deviceRecognitionBudget ? 'ext:agnes-examples/aka-robot' : 'ext:fixture/service'
  const owner = pluginRowSource(rowId)
  const root = mkdtempSync(join(tmpdir(), 'agnes-services-'))
  const pkg = join(root, 'package')
  mkdirSync(pkg, { recursive: true })
  const { handler: _, ...original } = serviceFixture()
  const cap = deviceRecognitionBudget
    ? { ...original, kind: 'effect' as const, name: budgetService }
    : original
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: { plugins: [{ id: rowId, export: 'main', services: [cap.name] }] },
    }),
  )
  writeFileSync(
    join(pkg, 'index.mjs'),
    `export const main = { apply(ctx) { ctx.services.register({ ...${JSON.stringify(cap)}, async handler(input, serviceCtx) {
    if (input.value === 2) await serviceCtx.fs.write('forbidden-write', 'no');
    if (input.value === 3) return {value: (await serviceCtx.fs.read('read.txt')).length};
    if (input.value === 4) await serviceCtx.fs.read('../outside');
    if (input.value === 5) await serviceCtx.exec(['touch', 'forbidden-exec']);
    if (input.value === 6) await new Promise((resolve) => setTimeout(resolve, 40));
    if (input.value === 7) return {value: serviceCtx.session?.workspaceRoot === serviceCtx.cwd && Object.isFrozen(serviceCtx.session) ? (serviceCtx.session.key === 'service-session' ? 7 : 8) : -1};
    if (input.value === 10) { const budget = await serviceCtx.recognitionBudget?.request({operation:'read',expectedBindingRevision:1,expectedConfigRevision:1}); return {value: budget?.reserved ?? -1}; }
    if (input.value === 11) { if (!serviceCtx.captureArtifacts || await serviceCtx.captureArtifacts.read() !== null) throw new Error('missing original storage admission'); const result = await serviceCtx.recognition.run({bindingRevision:1,configRevision:1,roundRevision:1}, async () => ({id:'actual-frame',receivedAt:performance.now(),width:320,height:240,bytes:await serviceCtx.fs.read('recognition.jpg')})); return {value:result.detections.length}; }
    if (input.value === 9) { const binding = await serviceCtx.device?.binding(); return {value: binding?.sessionId === serviceCtx.session?.key && Object.isFrozen(binding) ? 9 : -1}; }
    return {value: input.value};
  } }); } };`,
  )
  writeFileSync(join(root, 'read.txt'), 'test')
  if (inference)
    writeFileSync(
      join(root, 'recognition.jpg'),
      readFileSync(new URL('../fixtures/aka-camera-test.jpg', import.meta.url)),
    )
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId,
      profile: 'local-dev',
      packageId,
      version: '1.0.0',
      integrity: snapshotId,
      treeIntegrity: hashDirectory(pkg, { exclude: [] }),
      capabilityHash: 'fixture',
      directory: pkg,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const result = await createTestHost({
    dataDir: root,
    script: [],
    ...inference,
    ...(networkAllow
      ? {
          profileInputs: {
            user: { name: 'local-dev', policy: { recognitionNetworkAllow: [...networkAllow] } },
          },
          presets: {
            standard: {
              name: 'standard',
              extends: 'base',
              sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
            },
          },
          packages: {
            '@agnes/base': {
              sandboxWorkspaceProbe: (input) =>
                sandboxWorkspaceProbe({
                  ...input,
                  probeExec: async () => {
                    throw new Error('Recognition authorization must not require a sandbox process')
                  },
                }),
            },
          },
        }
      : {}),
    ...(deviceSession ? { deviceSession } : {}),
    ...(deviceRecognitionBudget ? { deviceRecognitionBudget } : {}),
    ...(deviceRecognitionAuthorization ? { deviceRecognitionAuthorization } : {}),
    runtimePluginCatalogue: [source],
    extensionLoader: {
      import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    },
    ...(authorized
      ? {
          serviceAuthority: {
            async resolve() {
              return {
                source: 'surface',
                subjectCredential: 'trusted',
                grants: [{ extension: owner, name: cap.name, range: '^1.0' }],
              }
            },
          },
        }
      : {}),
  })
  await result.host.applyRuntimeTarget(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: rowId,
          plugin: `${packageId}@${snapshotId}/main`,
          snapshotDigest: snapshotId,
          exportName: 'main',
          entryRevision: snapshotId,
          extrasRevision: 'none',
          mountRevision: 'service-assembly:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  const serviceSession = await result.host.createSession({ cwd: root, key: 'service-session' })
  held.push({ root, host: result.host })
  return {
    ...result,
    root,
    serviceSession,
    call: (value: number) =>
      result.host.callService(
        {
          sessionId: serviceSession.key,
          extension: owner,
          service: cap.name,
          input: { value },
          ...(deviceRecognitionBudget ? { commandId: 'budget-command' } : {}),
        },
        'opaque',
        undefined,
        deviceRecognitionBudget ? { commandId: 'budget-command', callId: 'a'.repeat(32) } : undefined,
      ),
  }
}

it('loads a real bundled factory and enforces the selected session workspace/query I/O', async () => {
  const h = await fixture()
  expect(h.host.extensions()).toEqual([])
  expect(h.host.kernel.sessions.size).toBe(1)
  await expect(h.call(1)).resolves.toEqual({ output: { value: 1 } })
  await expect(h.call(3)).resolves.toEqual({ output: { value: 4 } })
  await expect(h.call(7)).resolves.toEqual({ output: { value: 7 } })
  const other = await h.host.createSession({ cwd: h.root, key: 'service-other' })
  await expect(
    h.host.callService(
      { sessionId: other.key, extension: owner, service: 'fixture.echo', input: { value: 7 } },
      'opaque',
    ),
  ).resolves.toEqual({ output: { value: 8 } })
  await other.close()
  for (const value of [2, 4, 5])
    await expect(h.call(value)).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
  await h.host.close()
  let closedFailure: unknown
  try {
    h.call(1)
  } catch (error) {
    closedFailure = error
  }
  expect(closedFailure).toMatchObject({ code: 'E_HOST_CLOSED' })
  expect(isServicePreDispatchFailure(closedFailure)).toBe(true)
})

it('supplies fresh device enrollment to the real registered service through Host assembly', async () => {
  let active = true
  const lookup = vi.fn(async (key: string) => ({
    workspace: {
      workspaceId: 'a'.repeat(64),
      deviceId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      active,
    },
    session: active
      ? {
          sessionId: key,
          workspaceId: 'a'.repeat(64),
          deviceId: '11111111-1111-4111-8111-111111111111',
          bindingRevision: 1,
          active: true,
        }
      : null,
  }))
  const h = await fixture(true, lookup)
  await expect(h.call(9)).resolves.toEqual({ output: { value: 9 } })
  expect(lookup.mock.calls[0]?.[0]).toBe(h.serviceSession.key)
  active = false
  await expect(h.call(9)).resolves.toEqual({ output: { value: -1 } })
})

it('refuses the production Host call when no source authority is assembled', async () => {
  const h = await fixture(false)
  await expect(h.call(1)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('rejects a stale session before service context or author code can run', async () => {
  const h = await fixture()
  let error: unknown
  try {
    await h.host.callService(
      {
        sessionId: 'stale-session',
        extension: owner,
        service: 'fixture.echo',
        input: { value: 1 },
      },
      'opaque',
    )
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
  expect(isServicePreDispatchFailure(error)).toBe(true)
})

it('holds the workspace lease through handler settlement and releases it before session close returns', async () => {
  const h = await fixture()
  const running = h.call(6)
  let closed = false
  const closing = h.serviceSession.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(closed).toBe(false)
  await expect(running).resolves.toEqual({ output: { value: 6 } })
  await closing
  expect(closed).toBe(true)
  let error: unknown
  try {
    await h.call(1)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
})

it('hands service dispatch into the workspace before releasing publication during async author work', async () => {
  const h = await fixture()
  const events: string[] = []
  let observeRelease!: () => void
  const released = new Promise<void>((resolve) => {
    observeRelease = resolve
  })
  const enterDispatch = PublicationGate.prototype.enterDispatch
  const gate = vi.spyOn(PublicationGate.prototype, 'enterDispatch').mockImplementation(async function (
    this: PublicationGate,
  ) {
    events.push('ticket:enter')
    const ticket = await enterDispatch.call(this)
    events.push('ticket:admitted')
    return {
      release: () => {
        events.push('ticket:release')
        ticket.release()
        observeRelease()
      },
    }
  })
  try {
    let serviceSettled = false
    const running = h.call(6).then(
      (result) => {
        serviceSettled = true
        events.push('service')
        return result
      },
      (error: unknown) => {
        serviceSettled = true
        throw error
      },
    )

    await released
    expect(serviceSettled).toBe(false)

    // PublicationDispatch can release only after WorkspaceInvocationPort.run() returns. That run()
    // acquires synchronously, so session close must now wait for the async handler even though the
    // publication ticket is already free.
    let sessionClosed = false
    const closing = h.serviceSession.close().then(() => {
      sessionClosed = true
      events.push('session-close')
    })
    await Promise.resolve()
    expect(sessionClosed).toBe(false)

    await expect(running).resolves.toEqual({ output: { value: 6 } })
    await closing
    expect(events.slice(0, 3)).toEqual(['ticket:enter', 'ticket:admitted', 'ticket:release'])
    expect(events.indexOf('ticket:release')).toBeLessThan(events.indexOf('service'))
    expect(events.indexOf('service')).toBeLessThan(events.indexOf('session-close'))
  } finally {
    gate.mockRestore()
  }
})

it('does not poison publication admission when an ordinary service call fails', async () => {
  const h = await fixture()
  await expect(h.call(2)).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })

  // A failed service call must not poison publication of the same Cordis service row.
  await expect(
    h.host.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [
          createPluginRow({
            id: rowId,
            plugin: `${packageId}@${snapshotId}/main`,
            snapshotDigest: snapshotId,
            exportName: 'main',
            entryRevision: snapshotId,
            extrasRevision: 'none',
            mountRevision: 'service-assembly:v2',
          }),
        ],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '1'.repeat(64),
      }),
    ),
  ).resolves.toMatchObject({ ok: true })
  await expect(h.call(1)).resolves.toEqual({ output: { value: 1 } })
})

it('rejects a service after its Cordis row is removed', async () => {
  const h = await fixture()
  await h.host.applyRuntimeTarget(
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  await expect(h.call(1)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('holds activation cutover until a real service invocation finishes', async () => {
  const h = await fixture()
  let startService!: () => void
  const start = new Promise<void>((resolve) => {
    startService = resolve
  })
  const turn = h.host.activationBarrier.admit('turn')
  const call = turn.run(async () => {
    await start
    return h.call(6)
  })
  let switched = false
  const activation = h.host.activationBarrier.quiesce('service-activation', async () => {
    switched = true
  })

  startService()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(switched).toBe(false)
  await expect(call).resolves.toEqual({ output: { value: 6 } })
  await activation
  expect(switched).toBe(true)
})

it('routes an admitted AKA budget effect through the real Host and refuses missing grants first', async () => {
  const lookup = vi.fn(async (key: string) => ({
    workspace: {
      workspaceId: 'a'.repeat(64),
      deviceId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      active: true,
    },
    session: {
      sessionId: key,
      workspaceId: 'a'.repeat(64),
      deviceId: '11111111-1111-4111-8111-111111111111',
      bindingRevision: 1,
      active: true,
    },
  }))
  const bridge = vi.fn(async () => ({
    deviceId: '11111111-1111-4111-8111-111111111111',
    roundRevision: 1,
    budget: 2,
    reserved: 1,
  }))
  const allowed = await fixture(true, lookup, bridge)
  await expect(allowed.call(10)).resolves.toEqual({ output: { value: 1 } })
  expect(bridge).toHaveBeenCalledWith(
    'service-session',
    'a'.repeat(32),
    { operation: 'read', expectedBindingRevision: 1, expectedConfigRevision: 1 },
    expect.any(AbortSignal),
  )
  bridge.mockClear()
  const denied = await fixture(false, lookup, bridge)
  await expect(denied.call(10)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(bridge).not.toHaveBeenCalled()
})

it.each(['all', 'none', 'upload-only'])(
  'checks the actual AKA row network declaration and Host policy while its effect is live: %s',
  async (policy) => {
    let proof: Parameters<NonNullable<HostOptions['deviceRecognitionAuthorization']>>[2] | undefined
    let registered!: () => void
    const registration = new Promise<void>((resolve) => {
      registered = resolve
    })
    const register = vi.fn((key: string, callId: string, authorization: NonNullable<typeof proof>) => {
      expect(key).toBe('service-session')
      expect(callId).toBe('a'.repeat(32))
      proof = authorization
      registered()
    })
    const deviceId = '11111111-1111-4111-8111-111111111111'
    const lookup = async (sessionId: string) => ({
      workspace: { workspaceId: 'a'.repeat(64), deviceId, revision: 1, active: true },
      session: { sessionId, workspaceId: 'a'.repeat(64), deviceId, bindingRevision: 1, active: true },
    })
    let finishBudget!: () => void
    const heldBudget = new Promise<void>((resolve) => {
      finishBudget = resolve
    })
    const h = await fixture(
      true,
      lookup,
      async () => {
        await heldBudget
        return { deviceId, roundRevision: 1, budget: 2, reserved: 1 }
      },
      register,
      policy === 'all'
        ? ['openplatform.aliyuncs.com', 'oss-cn-shanghai.aliyuncs.com', 'objectdet.cn-shanghai.aliyuncs.com']
        : policy === 'upload-only'
          ? ['oss-cn-shanghai.aliyuncs.com']
          : [],
    )
    const call = h.call(10)
    // Consume a failure even if assertion exits before cleanup; always release the held author handler.
    void call.catch(() => {})
    try {
      await registration
      expect(register).toHaveBeenCalledOnce()
      if (!proof) throw new Error('missing real Host registration')
      expect(proof.revoked.aborted).toBe(false)
      for (const stage of ['upload-authorize', 'upload', 'detect'] as const) {
        const check = proof.assertIOAuthorized(stage, new AbortController().signal)
        if (policy === 'all' || (policy === 'upload-only' && stage === 'upload'))
          await expect(check).resolves.toBeUndefined()
        else await expect(check).rejects.toThrow()
      }
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(proof.assertIOAuthorized('detect', cancelled.signal)).rejects.toThrow()
    } finally {
      finishBudget()
    }
    await expect(call).resolves.toEqual({ output: { value: 1 } })
    if (!proof) throw new Error('missing real Host registration')
    expect(proof.revoked.aborted).toBe(true)
    await expect(proof.assertAuthorized()).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
    await expect(proof.assertIOAuthorized('detect', new AbortController().signal)).rejects.toThrow()
  },
)

it.each([true, false])(
  'runs the real admitted single-image context with live IO checks: %s',
  async (allowed) => {
    const deviceId = '11111111-1111-4111-8111-111111111111'
    const snapshot = (sessionId: string) => ({
      workspace: { workspaceId: 'a'.repeat(64), deviceId, revision: 1, active: true },
      session: { sessionId, workspaceId: 'a'.repeat(64), deviceId, bindingRevision: 1, active: true },
    })
    const recognition = {
      deviceId,
      bindingRevision: 1,
      configRevision: 1,
      settings: { provider: 'aliyun', frequency: 2, requestBudget: 10, credentialConfigured: true },
    }
    let proof: Parameters<NonNullable<HostOptions['deviceRecognitionAuthorization']>>[2] | undefined
    const release = vi.fn()
    const originals = vi.fn(async () => null)
    const ticket = '22222222-2222-4222-8222-222222222222'
    const bridge = vi.fn(async (key: string, callId: string, input: unknown, signal: AbortSignal) => {
      expect(key).toBe('service-session')
      expect(callId).toBe('a'.repeat(32))
      if (!proof) throw new Error('missing actual registration')
      const p = input as {
        operation: string
        frame?: { id: string; width: number; height: number; jpegBase64: string }
      }
      await proof.assertIOAuthorized('upload-authorize', signal)
      if (p.operation === 'begin') return { ticket }
      await proof.assertIOAuthorized('upload', signal)
      await proof.assertIOAuthorized('detect', signal)
      if (!p.frame) throw new Error('missing actual selected frame')
      return {
        id: ticket,
        deviceId,
        bindingRevision: 1,
        configRevision: 1,
        roundRevision: 1,
        frameId: p.frame.id,
        width: p.frame.width,
        height: p.frame.height,
        sha256: createHash('sha256').update(Buffer.from(p.frame.jpegBase64, 'base64')).digest('hex'),
        providerRequestId: 'request',
        elapsedMs: 1,
        detections: [],
      }
    })
    const h = await fixture(
      true,
      async (key, _signal, view) =>
        view === 'connection'
          ? {
              deviceId,
              bindingRevision: 1,
              profile: {
                driver: 'aka-00',
                ip: '192.168.1.42',
                port: 80,
                macAddress: '12:34:56:78:90:ab',
                configRevision: 1,
              },
            }
          : snapshot(key),
      async () => null,
      (_key, _call, value) => {
        proof = value
      },
      allowed
        ? ['openplatform.aliyuncs.com', 'oss-cn-shanghai.aliyuncs.com', 'objectdet.cn-shanghai.aliyuncs.com']
        : [],
      {
        deviceRecognitionExecute: bridge,
        deviceCaptureSelection: originals,
        deviceSessionRetain: async (key) => ({
          snapshot: snapshot(key),
          recognition,
          revoked: new AbortController().signal,
          release,
        }),
      },
    )
    if (allowed) await expect(h.call(11)).resolves.toEqual({ output: { value: 0 } })
    else await expect(h.call(11)).rejects.toThrow()
    expect(originals).toHaveBeenCalledWith(
      'service-session',
      'a'.repeat(32),
      { operation: 'read' },
      expect.any(AbortSignal),
    )
    expect(bridge).toHaveBeenCalledTimes(allowed ? 2 : 1)
    expect(release).toHaveBeenCalledOnce()
    expect(proof?.revoked.aborted).toBe(true)
  },
)

it('admits the real round-read row without cloud IO authority', async () => {
  const deviceId = '11111111-1111-4111-8111-111111111111'
  const reader = async (sessionId: string) => ({
    workspace: { workspaceId: 'a'.repeat(64), deviceId, revision: 1, active: true },
    session: { sessionId, workspaceId: 'a'.repeat(64), deviceId, bindingRevision: 1, active: true },
  })
  const bridge = vi.fn(async () => ({ deviceId, roundRevision: 2, budget: 10, reserved: 3 }))
  const io = vi.fn()
  const h = await fixture(true, reader, bridge, io, [], undefined, 'aka.recognition.round.read')
  await expect(h.call(10)).resolves.toEqual({ output: { value: 3 } })
  expect(bridge).toHaveBeenCalledWith(
    'service-session',
    'a'.repeat(32),
    { operation: 'read', expectedBindingRevision: 1, expectedConfigRevision: 1 },
    expect.any(AbortSignal),
  )
  expect(io).not.toHaveBeenCalled()
})
