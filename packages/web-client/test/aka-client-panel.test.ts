/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type {
  DeviceConnectionResult,
  DeviceRecognitionResult,
  DeviceRecognitionSaveParams,
} from '@agnes/protocol'
import {
  AgnesClientService,
  ClientResourceService,
  CommandService,
  clientModule,
  type DeviceWorkbenchProps,
  type HostAgnesClient,
  LocaleService,
  SessionService,
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  ThemeService,
} from '@agnes/web-client'
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const id = '11111111-1111-4111-8111-111111111111'
const macAddress = '12:34:56:78:90:ab'
const binding = {
  sessionId: 'device',
  workspaceId: 'a'.repeat(64),
  deviceId: id,
  bindingRevision: 1,
  active: true,
}
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  sessionStorage.clear()
  for (const close of cleanup.splice(0).reverse()) await close()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function setup(slotProps: Partial<DeviceWorkbenchProps> = {}) {
  const manifestEntry = '../../../examples/packages/aka-robot-plugin/package.json'
  const descriptorEntry = '../../../examples/packages/aka-robot-plugin/client/agnes.client.json'
  const manifest = (await import(manifestEntry)).default
  const descriptor = (await import(descriptorEntry)).default
  const entry = `../../../examples/packages/aka-robot-plugin/client/${descriptor.client.entry.replace(/^\.\//, '')}`
  const { apply } = await import(entry)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.declare('tool.call.toolview', { kind: 'keyed', scope: 'session' })
  const events = new Map<string, Set<() => void>>()
  let profile: DeviceConnectionResult['profile'] = null
  let runtime: { connection: string; media: string; cameraOn: boolean | null } | null = null
  const result = (): DeviceConnectionResult => ({ deviceId: id, bindingRevision: 1, profile })
  const readStatus = () => ({
    deviceId: id,
    enrollment: 'active',
    configured: !!profile,
    configRevision: profile?.configRevision ?? null,
    runtime,
    automaticActions: false,
  })
  const connection = vi.fn(async () => result())
  const save = vi.fn(async (input: { ip: string; port: number; macAddress: string }) => {
    profile = {
      driver: 'aka-00',
      ip: input.ip,
      port: input.port,
      macAddress: input.macAddress,
      configRevision: 1,
    }
    return result()
  })
  let recognitionState: DeviceRecognitionResult = {
    deviceId: id,
    bindingRevision: 1,
    configRevision: 0,
    settings: null,
  }
  const recognitionRequests: DeviceRecognitionSaveParams[] = []
  const recognition = vi.fn(async () => recognitionState)
  const recognitionSave = vi.fn(async (input: DeviceRecognitionSaveParams) => {
    recognitionRequests.push(structuredClone(input))
    const settings = input.settings
    recognitionState = {
      deviceId: id,
      bindingRevision: 1,
      configRevision: input.expectedConfigRevision + 1,
      settings: settings
        ? settings.provider === 'aliyun'
          ? {
              provider: 'aliyun',
              frequency: settings.frequency,
              requestBudget: settings.requestBudget,
              credentialConfigured: true,
            }
          : {
              provider: 'local-yolo',
              frequency: settings.frequency,
              requestBudget: settings.requestBudget,
              baseUrl: settings.baseUrl,
              credentialConfigured: settings.credentials.action !== 'clear',
            }
        : null,
    }
    return recognitionState
  })
  const client = {
    connectionState: 'connected',
    device: { connection, saveConnection: save, recognition, saveRecognition: recognitionSave },
    sessions: { get: () => undefined },
    on: (event: string, listener: () => void) => {
      const listeners = events.get(event) ?? new Set<() => void>()
      events.set(event, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const query = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => readStatus())
  const effect = vi.fn(
    async (
      _module: unknown,
      _session: string,
      name: string,
      _command: string,
      input: Record<string, unknown>,
      _mode?: Readonly<{ readbackOnly: true }>,
    ): Promise<Record<string, unknown>> => {
      if (name === 'aka.probe') return { ...input, deviceId: id, macAddress, identity: 'reported' }
      if (name === 'aka.connect') runtime = { connection: 'connected', media: 'idle', cameraOn: false }
      if (name === 'aka.disconnect') runtime = { connection: 'idle', media: 'idle', cameraOn: null }
      if (name === 'aka.camera.set')
        runtime = {
          connection: 'connected',
          media: input.open ? 'opening' : 'idle',
          cameraOn: input.open ? null : false,
        }
      return { state: runtime?.connection }
    },
  )
  new AgnesClientService(ctx, client as unknown as HostAgnesClient, query, effect)
  new CommandService(ctx, async () => true)
  const session = new SessionService(ctx, 'device', client as unknown as HostAgnesClient)
  const imageResource = {
    url: 'blob:recognition-test',
    release: vi.fn(),
    artifact: { sha256: 'b'.repeat(64), size: 3945, mime: 'image/jpeg' },
  }
  const imageLoad = vi.fn<ClientResourceService['images']['load']>(async () => imageResource)
  class TestResources extends ClientResourceService {
    override readonly images = Object.freeze({ load: imageLoad })
  }
  new TestResources(ctx, client as unknown as HostAgnesClient, session)
  new ThemeService(ctx, 'light')
  const locale = new LocaleService(ctx, 'zh-CN')
  const moduleIdentity = {
    packageId: manifest.name,
    rowId: manifest.agnes.clientDescriptors[0].rowId,
    revision: 'test',
    allowedSlots: descriptor.client.slots,
    slotCatalogVersion: descriptor.client.slotCatalogVersion,
    services: descriptor.client.services,
  }
  let fiber = ctx.plugin(clientModule({ apply }), moduleIdentity)
  await fiber
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const render = (props: Partial<DeviceWorkbenchProps>) =>
    root.render(
      createElement(
        SlotsProvider,
        { registry, session, locale },
        createElement(SlotOutlet<'workbench.device'>, {
          name: 'workbench.device',
          props: { sessionId: 'device', binding, ...props },
        }),
      ),
    )
  render(slotProps)
  cleanup.push(
    () => ctx.fiber.dispose(),
    () => root.unmount(),
  )
  await vi.waitFor(() => expect(button(el, '连接并保存').disabled).toBe(false))
  return {
    el,
    ctx,
    render,
    reload: async () => {
      await fiber.dispose()
      fiber = ctx.plugin(clientModule({ apply }), moduleIdentity)
      await fiber
    },
    fiber,
    session,
    locale,
    connection,
    save,
    recognition,
    recognitionSave,
    recognitionRequests,
    imageLoad,
    imageResource,
    query,
    effect,
    client,
    emit: (name: string) => {
      for (const listener of events.get(name) ?? []) listener()
    },
    result,
    setRuntime: (value: typeof runtime) => {
      runtime = value
    },
  }
}
function button(el: HTMLElement, label: string): HTMLButtonElement {
  const node = Array.from(el.querySelectorAll('button')).find((item) => item.textContent === label)
  if (!node) throw new Error(`Missing button: ${label}`)
  return node
}
function edit(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`)
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
async function probe(el: HTMLElement) {
  edit(el, 'ip', '192.168.50.42')
  await vi.waitFor(() =>
    expect((el.querySelector('input[name="ip"]') as HTMLInputElement).value).toBe('192.168.50.42'),
  )
  button(el, '探测设备身份').click()
  await vi.waitFor(() => expect(el.textContent).toContain(macAddress))
}

describe('actual AKA browser module pairing flow', () => {
  it('shows connection onboarding without controls or modeling settings before pairing', async () => {
    const value = await setup()
    await vi.waitFor(() => expect(button(value.el, '连接并保存').disabled).toBe(false))
    expect(value.el.textContent).toContain('配置新连接')
    expect(value.el.querySelector('.aka-live-video')).toBeNull()
    expect(value.el.querySelector('.aka-manual-control')).toBeNull()
    expect(value.el.textContent).not.toContain('三维建模配置')
    expect(value.query).not.toHaveBeenCalled()
    value.query.mockRejectedValue(new Error('runtime status timed out'))
    await value.reload()
    await vi.waitFor(() => expect(button(value.el, '连接并保存').disabled).toBe(false))
    expect((value.el.querySelector('[name="ip"]') as HTMLInputElement).disabled).toBe(false)
    expect(value.query).not.toHaveBeenCalled()
  })
  it.each(['success', 'prepare-failure', 'probe-failure'] as const)(
    'submits an inactive connection from the configuration form: %s',
    async (outcome) => {
      const prepareConnection = vi.fn(async () => {
        if (outcome === 'prepare-failure') throw new Error('private backend failure')
        return binding
      })
      const connectionConfigured = vi.fn()
      const value = await setup({
        binding: { ...binding, deviceId: '22222222-2222-4222-8222-222222222222', active: false },
        prepareConnection,
        connectionConfigured,
      })
      expect(value.el.textContent).toContain('配置新连接')
      expect(value.el.textContent).not.toContain('重新绑定原设备')
      expect(value.connection).not.toHaveBeenCalled()
      expect(value.query).not.toHaveBeenCalled()
      expect(prepareConnection).not.toHaveBeenCalled()
      if (outcome === 'probe-failure')
        value.effect.mockRejectedValueOnce(new Error('private network failure'))
      edit(value.el, 'ip', '192.168.50.42')
      button(value.el, '连接并保存').click()
      button(value.el, '连接并保存').click()
      if (outcome !== 'success') {
        await vi.waitFor(() => expect(value.el.querySelector('[role="alert"]')).not.toBeNull())
        expect(value.el.textContent).not.toContain('private backend failure')
        expect((value.el.querySelector('[name="ip"]') as HTMLInputElement).value).toBe('192.168.50.42')
        expect(value.effect).toHaveBeenCalledTimes(outcome === 'probe-failure' ? 1 : 0)
        expect(value.save).not.toHaveBeenCalled()
        expect(connectionConfigured).not.toHaveBeenCalled()
      } else {
        await vi.waitFor(() => expect(connectionConfigured).toHaveBeenCalledOnce())
        expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
          'aka.probe',
          'aka.connect',
          'aka.camera.set',
        ])
        expect(value.save).toHaveBeenCalledOnce()
      }
      expect(prepareConnection).toHaveBeenCalledOnce()
    },
  )
  it('clears connection inputs immediately when detached during a pending probe', async () => {
    const value = await setup()
    const pending = deferred<Record<string, unknown>>()
    value.effect.mockImplementationOnce(() => pending.promise)
    edit(value.el, 'ip', '192.168.50.42')
    button(value.el, '连接并保存').click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledOnce())
    const prepareConnection = vi.fn(async () => binding)
    value.render({ binding: { ...binding, active: false }, prepareConnection })
    await vi.waitFor(() => expect((value.el.querySelector('[name="ip"]') as HTMLInputElement).value).toBe(''))
    pending.resolve({ ...value.effect.mock.calls[0]?.[4], deviceId: id, macAddress, identity: 'reported' })
    await vi.waitFor(() => expect(button(value.el, '连接并保存').disabled).toBe(false))
    expect(value.save).not.toHaveBeenCalled()
    expect(prepareConnection).not.toHaveBeenCalled()
  })
  it('connects, saves and opens the camera from one click, then restores the console after reload', async () => {
    const value = await setup()
    edit(value.el, 'ip', '192.168.50.42')
    await vi.waitFor(() =>
      expect((value.el.querySelector('[name="ip"]') as HTMLInputElement).value).toBe('192.168.50.42'),
    )
    button(value.el, '连接并保存').click()
    button(value.el, '连接并保存').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-console')).not.toBeNull())
    await vi.waitFor(() =>
      expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
        'aka.probe',
        'aka.connect',
        'aka.camera.set',
      ]),
    )
    expect(value.save).toHaveBeenCalledOnce()
    expect(value.effect.mock.calls[2]?.[4]).toEqual({ configRevision: 1, open: true })
    expect(value.el.querySelector('.aka-live-video')).not.toBeNull()
    expect(value.el.querySelector('.aka-connection-card')).toBeNull()
    await value.reload()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-console')).not.toBeNull())
    expect(value.el.textContent).toContain('192.168.50.42:80')
    expect(value.save).toHaveBeenCalledOnce()
  })
  it.each([
    { connection: 'degraded', media: 'idle', cameraOn: null },
    { connection: 'connected', media: 'error', cameraOn: null },
  ])(
    'restores a saved device after connection or camera loss (%s) without resaving or movement',
    async (runtime) => {
      const v = await setup()
      edit(v.el, 'ip', '192.168.50.42')
      button(v.el, '连接并保存').click()
      await vi.waitFor(() => expect(v.el.querySelector('.aka-console')).not.toBeNull())
      await vi.waitFor(() => expect(button(v.el, '刷新配置与状态').disabled).toBe(false))
      v.setRuntime(runtime)
      await v.reload()
      await vi.waitFor(() => expect(button(v.el, '恢复连接和画面').disabled).toBe(false))
      v.effect.mockClear()
      v.effect.mockRejectedValueOnce(new Error('fixture offline'))
      button(v.el, '恢复连接和画面').click()
      await vi.waitFor(() => expect(v.el.querySelector('[role="alert"]')).not.toBeNull())
      await vi.waitFor(() => expect(button(v.el, '恢复连接和画面').disabled).toBe(false))
      expect(v.el.textContent).toContain('192.168.50.42:80')
      expect(v.el.textContent).not.toContain('fixture offline')
      expect(v.effect.mock.calls.map((c) => c[2])).toEqual(['aka.connect'])
      v.effect.mockClear()
      button(v.el, '恢复连接和画面').click()
      button(v.el, '恢复连接和画面').click()
      await vi.waitFor(() =>
        expect(v.effect.mock.calls.map((c) => c[2])).toEqual(['aka.connect', 'aka.camera.set']),
      )
      expect(v.effect.mock.calls[1]?.[4]).toEqual({ configRevision: 1, open: true })
      await vi.waitFor(() => expect(v.el.textContent).toContain('已连接'))
      expect(v.save).toHaveBeenCalledOnce()
      expect(v.el.textContent).toContain('192.168.50.42:80')
    },
  )
  it('dispatches manual buttons through real module commands and keeps stop available during pending movement', async () => {
    const v = await setup()
    await captureReady(v)
    v.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: {
        connection: 'connected',
        media: 'streaming',
        cameraOn: true,
        control: { phase: 'idle', lastStop: null },
        wheels: { leftCmPerSecond: 3, rightCmPerSecond: 4, ageMs: 0 },
      },
    })
    await vi.waitFor(() => expect(button(v.el, '前进').disabled).toBe(false))
    expect(v.el.textContent).toContain('3 cm/s')
    v.connection.mockClear()
    const moving = deferred<Record<string, unknown>>()
    v.effect.mockImplementation(async (_module, _session, name, _command, input) => {
      if (name === 'aka.control.action') return moving.promise
      return {
        deviceId: id,
        bindingRevision: 1,
        configRevision: 1,
        action: input.action,
        state: 'completed',
        stop: 'completed',
        physicalResult: 'unverified',
      }
    })
    button(v.el, '前进').click()
    button(v.el, '前进').click()
    await vi.waitFor(() => expect(button(v.el, '前进').disabled).toBe(true))
    expect(button(v.el, '停止底盘').disabled).toBe(false)
    button(v.el, '停止底盘').click()
    await vi.waitFor(() => expect(v.el.textContent).toContain('已收到停止回执'))
    const actions = v.effect.mock.calls.filter((call) => call[2] === 'aka.control.action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.[4]).toEqual({
      bindingRevision: 1,
      configRevision: 1,
      action: 'up',
      speed: 30,
      milliseconds: 1000,
    })
    expect(v.effect.mock.calls.filter((call) => call[2] === 'aka.control.stop')).toHaveLength(1)
    moving.resolve({
      deviceId: id,
      bindingRevision: 1,
      configRevision: 1,
      action: 'up',
      state: 'sent',
      stop: 'completed',
      physicalResult: 'unverified',
    })
    await vi.waitFor(() => expect(button(v.el, '前进').disabled).toBe(false))
    expect(v.el.textContent).toContain('控制指令已发送')
    expect(v.connection).not.toHaveBeenCalled()
  })
  it('does not send an out-of-range manual speed or display stale wheels as valid', async () => {
    const v = await setup()
    await captureReady(v)
    v.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: {
        connection: 'connected',
        media: 'streaming',
        cameraOn: true,
        control: { phase: 'idle' },
        wheels: { leftCmPerSecond: 999, rightCmPerSecond: 999, ageMs: 2000 },
      },
    })
    await vi.waitFor(() => expect(button(v.el, '前进').disabled).toBe(false))
    edit(v.el, 'manualSpeed', '51')
    await vi.waitFor(() =>
      expect((v.el.querySelector('input[name="manualSpeed"]') as HTMLInputElement).value).toBe('51'),
    )
    const count = v.effect.mock.calls.length
    button(v.el, '前进').click()
    await vi.waitFor(() => expect(v.el.textContent).toContain('速度须为 30—50'))
    expect(v.effect.mock.calls).toHaveLength(count)
    expect(v.el.textContent).not.toContain('999 cm/s')
  })

  async function captureReady(value: Awaited<ReturnType<typeof setup>>) {
    await probe(value.el)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() => expect(button(value.el, '连接已保存设备').disabled).toBe(false))
    button(value.el, '连接已保存设备').click()
    await vi.waitFor(() => expect(button(value.el, '开启摄像头').disabled).toBe(false))
    expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
    button(value.el, '开启摄像头').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-live-video')).not.toBeNull())
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true },
    })
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() => expect(button(value.el, '保存当前相机照片').disabled).toBe(false))
  }
  const captureReceipt = {
    deviceId: id,
    bindingRevision: 1,
    configRevision: 1,
    frameId: 'frame-1',
    eventSeq: 9,
    artifact: { sha256: 'b'.repeat(64), size: 3945, mime: 'image/jpeg' },
  }
  async function recognitionReady(value: Awaited<ReturnType<typeof setup>>) {
    await captureReady(value)
    value.recognition.mockResolvedValue({
      deviceId: id,
      bindingRevision: 1,
      configRevision: 2,
      settings: { provider: 'aliyun', frequency: 2, requestBudget: 10, credentialConfigured: true },
    })
    value.effect.mockImplementation(async (_module, _session, name) => {
      if (name === 'aka.recognition.round.read')
        return { deviceId: id, roundRevision: 3, budget: 10, reserved: 1 }
      return {
        id: '22222222-2222-4222-8222-222222222222',
        deviceId: id,
        bindingRevision: 1,
        configRevision: 2,
        roundRevision: 3,
        frameId: 'frame-1',
        width: 320,
        height: 240,
        sha256: 'b'.repeat(64),
        artifact: captureReceipt.artifact,
        eventSeq: 9,
        selectedAt: '2026-10-10T01:00:00.000Z',
        timeBasis: 'bridge_receive',
        ageAtSelectionMs: 1,
        providerRequestId: 'request',
        elapsedMs: 10,
        detections: [{ label: '<script>ball</script>', confidence: 0.9, box: [10, 20, 30, 40] }],
      }
    })
    value.effect.mockClear()
    expect(value.recognition).not.toHaveBeenCalled()
    expect(button(value.el, '测试图片').disabled).toBe(false)
    button(value.el, '读取当前识别额度').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('1 / 10'))
    await vi.waitFor(() => expect(button(value.el, '测试图片').disabled).toBe(false))
  }
  it('opens ground calibration and saves measured reference and independent check points', async () => {
    const value = await setup()
    await captureReady(value)
    const geometryEntry = '../../../examples/packages/aka-robot-plugin/src/geometry-service.js'
    const { GroundGeometry } = await import(geometryEntry)
    const fsEntry = '../../host/src/adapters/fs.js'
    const policyEntry = '../../core/testkit/index.js'
    const nodeFsEntry = 'node:fs',
      nodeOsEntry = 'node:os',
      nodePathEntry = 'node:path'
    const { mkdtempSync, realpathSync, rmSync } = await import(nodeFsEntry)
    const { tmpdir } = await import(nodeOsEntry)
    const { join } = await import(nodePathEntry)
    const { createFs } = await import(fsEntry)
    const { testFsPolicy } = await import(policyEntry)
    const root = mkdtempSync(join(tmpdir(), 'aka-ui-config-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const hostFs = createFs(() => ({ policy: testFsPolicy(realpathSync.native(root)), caseSensitive: false }))
    const backend = {
      session: { key: 'device', workspaceRoot: root },
      device: { binding: async () => binding, connection: async () => value.result() },
      signal: new AbortController().signal,
      fs: {
        read: hostFs.read,
        stat: hostFs.stat,
        write: async (path: string, data: string) => hostFs.write(path, new TextEncoder().encode(data)),
      },
    }
    const geometry = new GroundGeometry({ registrations: new Map() })
    const versions = { bindingRevision: 1, configRevision: 1 }
    value.query.mockImplementation(async (...args) =>
      args[2] === 'aka.geometry.read'
        ? geometry.read(backend, versions)
        : {
            deviceId: id,
            enrollment: 'active',
            configRevision: 1,
            runtime: {
              connection: 'connected',
              media: 'streaming',
              cameraOn: true,
              frame: { width: 320, height: 240 },
            },
          },
    )
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() => expect(button(value.el, '地面测距标定').disabled).toBe(false))
    button(value.el, '地面测距标定').click()
    await vi.waitFor(() =>
      expect((value.el.querySelector('[name="groundInstallation"]') as HTMLInputElement)?.disabled).toBe(
        false,
      ),
    )
    edit(value.el, 'groundInstallation', 'fixed camera')
    edit(value.el, 'groundLabels', 'ball')
    for (const [group, coordinates] of [
      [
        'points',
        [
          [10, 20],
          [150, 20],
          [290, 20],
          [10, 200],
          [150, 200],
          [290, 200],
        ],
      ],
      [
        'checks',
        [
          [70, 90],
          [200, 80],
          [120, 140],
        ],
      ],
    ] as const) {
      for (let row = 0; row < coordinates.length; row++)
        for (const key of ['u', 'v', 'x', 'y'])
          edit(
            value.el,
            `${group}.${row}.${key}`,
            key === 'u'
              ? String(coordinates[row]?.[0])
              : key === 'v'
                ? String(coordinates[row]?.[1])
                : key === 'x'
                  ? String(1 - (coordinates[row]?.[1] ?? 0) / 240)
                  : String(1 - (coordinates[row]?.[0] ?? 0) / 160),
          )
    }
    value.effect.mockImplementation(async (_module, _session, name, _command, input) => {
      if (name !== 'aka.geometry.save') throw new Error('Unexpected effect')
      return geometry.save(backend, input)
    })
    button(value.el, '保存标定').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('保存成功，观测最大偏差'))
    expect(value.effect.mock.calls.at(-1)?.[2]).toBe('aka.geometry.save')
    expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({
      expectedRevision: 0,
      calibration: { width: 320, height: 240, labels: ['ball'], installation: 'fixed camera' },
    })
    const enabled = value.el.querySelector('[name="motionEnabled"]') as HTMLInputElement
    enabled.click()
    await vi.waitFor(() => expect(value.el.querySelector('[name="motion.forwardMeters"]')).not.toBeNull())
    const motion = {
      speed: 30,
      milliseconds: 500,
      forwardMeters: [0.049, 0.05, 0.051],
      leftDegrees: [5, 5.5, 6],
      rightDegrees: [5, 5.5, 6],
      marginMeters: 0.005,
      marginDegrees: 0.5,
      minimumStandoff: 0.1,
      turningClearance: 0.2,
      lateralTolerance: 0.03,
      maximumVisionError: 0.02,
    }
    for (const [key, measured] of Object.entries(motion))
      edit(value.el, `motion.${key}`, Array.isArray(measured) ? measured.join(',') : String(measured))
    expect((value.el.querySelector('.aka-ground-dialog form') as HTMLFormElement).checkValidity()).toBe(true)
    button(value.el, '保存标定').click()
    await vi.waitFor(() =>
      expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({
        expectedRevision: 1,
        calibration: { motion },
      }),
    )
    // Dispatch does not imply save settlement; wait for the form to become editable.
    await vi.waitFor(() =>
      expect((value.el.querySelector('[name="graspEnabled"]') as HTMLInputElement).disabled).toBe(false),
    )
    const graspEnabled = value.el.querySelector('[name="graspEnabled"]') as HTMLInputElement
    graspEnabled.click()
    await vi.waitFor(() => expect(value.el.querySelector('[name="grasp.heldBox"]')).not.toBeNull())
    const grasp = {
      forwardMin: 0.1,
      forwardMax: 0.2,
      lateralTolerance: 0.03,
      settleMilliseconds: 5000,
      heldBox: [100, 10, 220, 50],
      releaseBox: [100, 110, 220, 160],
    }
    for (const [key, measured] of Object.entries(grasp))
      edit(value.el, `grasp.${key}`, Array.isArray(measured) ? measured.join(',') : String(measured))
    button(value.el, '保存标定').click()
    await vi.waitFor(() =>
      expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({ calibration: { motion, grasp } }),
    )
    await vi.waitFor(() => expect(button(value.el, '保存标定').disabled).toBe(false))
    ;(value.el.querySelector('[name="patrolRouteEnabled"]') as HTMLInputElement).click()
    ;(value.el.querySelector('[name="deliveryRouteEnabled"]') as HTMLInputElement).click()
    await vi.waitFor(() => expect(value.el.querySelector('[name="homeLabels"]')).not.toBeNull())
    edit(value.el, 'homeLabels', 'ball')
    edit(value.el, 'destinationLabels', 'bin')
    edit(value.el, 'steps.0.speed', '30')
    edit(value.el, 'steps.0.milliseconds', '500')
    const returning = value.el.querySelector('[name="returnSteps.0.action"]') as HTMLSelectElement
    returning.value = 'down'
    returning.dispatchEvent(new Event('change', { bubbles: true }))
    expect((value.el.querySelector('.aka-ground-dialog form') as HTMLFormElement).checkValidity()).toBe(true)
    button(value.el, '保存标定').click()
    await vi.waitFor(() =>
      expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({
        calibration: {
          motion,
          grasp,
          routes: {
            patrol: {
              steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
              returnSteps: [{ action: 'down', speed: 30, milliseconds: 1000 }],
              homeLabels: ['ball'],
            },
            delivery: {
              steps: [{ action: 'up', speed: 30, milliseconds: 1000 }],
              destinationLabels: ['bin'],
            },
          },
        },
      }),
    )
    button(value.el, '关闭').click()
    const reopened = new GroundGeometry({ registrations: new Map() })
    expect(await reopened.read(backend, versions)).toMatchObject({
      revision: 4,
      motion,
      grasp,
      routes: {
        patrol: { homeLabels: ['ball'], steps: [{ action: 'up', speed: 30, milliseconds: 500 }] },
        delivery: { destinationLabels: ['bin'] },
      },
    })
    button(value.el, '地面测距标定').click()
    await vi.waitFor(() =>
      expect((value.el.querySelector('[name="homeLabels"]') as HTMLInputElement)?.value).toBe('ball'),
    )
    expect((value.el.querySelector('[name="steps.0.speed"]') as HTMLInputElement).value).toBe('30')
    button(value.el, '关闭').click()
  })
  it('shows distance for the exact recognition source without altering the live image', async () => {
    const value = await setup()
    await recognitionReady(value)
    value.query.mockImplementation(async (...args) =>
      args[2] === 'aka.geometry.estimate'
        ? {
            resultId: '22222222-2222-4222-8222-222222222222',
            estimates: [{ index: 0, state: 'estimated', groundDistance: 0.5, observedErrorMeters: 0.02 }],
          }
        : {
            deviceId: id,
            enrollment: 'active',
            configRevision: 1,
            runtime: { connection: 'connected', media: 'streaming', cameraOn: true },
          },
    )
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('估计地面距离: 50.0 cm'))
    expect(value.el.textContent).toContain('观测偏差加量测余量 2.0 cm')
  })
  it('shows the active observation task and dispatches its exact cancellation', async () => {
    const value = await setup()
    await captureReady(value)
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: { taskId: 'scan-task', phase: 'capturing', completedViews: 2, requestedViews: 4, endedAt: null },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('正在拍照 · 2/4'))
    button(value.el, '取消观察任务').click()
    await vi.waitFor(() => expect(value.effect.mock.calls.at(-1)?.[2]).toBe('aka.task.cancel'))
    expect(value.effect.mock.calls.at(-1)?.[4]).toEqual({ taskId: 'scan-task' })
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: {
        taskId: 'search-task',
        kind: 'search',
        targetLabels: ['网球'],
        targetFound: true,
        phase: 'completed',
        completedViews: 2,
        requestedViews: 4,
        endedAt: new Date().toISOString(),
      },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('网球 · 已识别目标，请核对原图'))
    expect([...value.el.querySelectorAll('button')].some((item) => item.textContent === '取消观察任务')).toBe(
      false,
    )
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: {
        taskId: 'grasp-task',
        kind: 'grasp',
        gripEvidence: 'held_candidate',
        phase: 'completed',
        completedViews: 3,
        requestedViews: 3,
        endedAt: new Date().toISOString(),
      },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('已观察到持物迹象，请核对原图'))
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: {
        taskId: 'mission-task',
        kind: 'mission',
        stage: 'transport',
        phase: 'approaching',
        completedViews: 3,
        requestedViews: 5,
        endedAt: null,
      },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('正在搬运并核对目的地'))
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: {
        taskId: 'orbit-task',
        kind: 'orbit',
        phase: 'completed',
        completedViews: 4,
        requestedViews: 4,
        endedAt: new Date().toISOString(),
        viewpoints: [{ index: 2, angleDegrees: 91, uncertaintyDegrees: 3 }],
      },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('估计拍摄视角: 2: 91° ±3.0°'))
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'streaming', cameraOn: true, control: { phase: 'idle' } },
      task: {
        taskId: 'patrol-task',
        kind: 'patrol',
        phase: 'completed',
        completedViews: 3,
        requestedViews: 3,
        endedAt: new Date().toISOString(),
        homeEvidence: 'observed_candidate',
      },
    })
    await vi.waitFor(() => expect(value.el.textContent).toContain('起点标记位置吻合，请核对原图'))
  })
  it('opens robot speed and servo dialogs and saves exact driver fields', async () => {
    const value = await setup()
    await captureReady(value)
    const settings = {
      speed: { forward_speed: 50, turn_speed: 40 },
      arm: {
        driver: 'zp10s',
        angles: {
          grab_position: { servo0: 245, servo1: 180 },
          lift_position: { servo0: 200, servo1: 180 },
          gripper_open: 150,
          gripper_close: 90,
        },
      },
    }
    value.effect.mockImplementation(async (_module, _session, name, _call, input) => ({
      deviceId: id,
      bindingRevision: 1,
      configRevision: 1,
      settings: name === 'aka.settings.save' ? input.settings : settings,
    }))
    button(value.el, '行驶速度设置').click()
    await vi.waitFor(() => expect(value.el.querySelector('input[name="speed.forward_speed"]')).not.toBeNull())
    edit(value.el, 'speed.forward_speed', '30')
    button(value.el, '保存到小车').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('回读核对通过'))
    expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({
      kind: 'speed',
      settings: { speed: { forward_speed: 30, turn_speed: 40 } },
    })
    button(value.el, '关闭').click()
    button(value.el, '舵机角度设置').click()
    await vi.waitFor(() =>
      expect(value.el.querySelector('input[name="arm.angles.gripper_close"]')).not.toBeNull(),
    )
    expect(value.el.textContent).toContain('度 (0–270)')
    edit(value.el, 'arm.angles.gripper_close', '100')
    button(value.el, '保存到小车').click()
    await vi.waitFor(() =>
      expect(value.effect.mock.calls.at(-1)?.[4]).toMatchObject({
        kind: 'arm',
        settings: { arm: { driver: 'zp10s', angles: { gripper_close: 100 } } },
      }),
    )
    button(value.el, '关闭').click()
  })
  it('runs continuous recognition serially and allows switching off during an outstanding image', async () => {
    const value = await setup()
    await recognitionReady(value)
    const original = value.effect.getMockImplementation()
    if (!original) throw new Error('Missing effect mock')
    let finish: ((v: Record<string, unknown>) => void) | undefined
    value.effect.mockImplementation(async (...args) => {
      if (args[2] === 'aka.recognition.test')
        return new Promise((resolve) => {
          finish = resolve
        })
      return original(...args)
    })
    button(value.el, '开启连续识别').click()
    await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 2000 })
    expect(button(value.el, '关闭连续识别').disabled).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(value.effect.mock.calls.filter((call) => call[2] === 'aka.recognition.test')).toHaveLength(1)
    button(value.el, '关闭连续识别').click()
    const call = value.effect.mock.calls.find((call) => call[2] === 'aka.recognition.test')
    if (!call || !finish) throw new Error('Missing pending image')
    finish(await original(...call))
    await vi.waitFor(() => expect(value.el.textContent).toContain('最近送检原图与识别结果'))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(value.effect.mock.calls.filter((call) => call[2] === 'aka.recognition.test')).toHaveLength(1)
    expect(value.effect.mock.calls.some((call) => call[2] === 'aka.recognition.round.start')).toBe(false)
  })
  it('stops continuous recognition when the current budget is exhausted', async () => {
    const value = await setup()
    await recognitionReady(value)
    const original = value.effect.getMockImplementation()
    if (!original) throw new Error('Missing effect mock')
    let paid = 0
    value.effect.mockImplementation(async (...args) => {
      if (args[2] === 'aka.recognition.round.read')
        return { deviceId: id, roundRevision: 3, budget: 10, reserved: paid ? 10 : 1 }
      paid++
      return original(...args)
    })
    button(value.el, '开启连续识别').click()
    await vi.waitFor(() => expect(paid).toBe(1), { timeout: 2000 })
    await vi.waitFor(() =>
      expect(
        value.el.querySelector('.aka-recognition-control [role="switch"]')?.getAttribute('aria-checked'),
      ).toBe('false'),
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(paid).toBe(1)
    expect(button(value.el, '开启连续识别').disabled).toBe(true)
  })
  it('resumes continuous recognition only after confirming the failed original was never submitted', async () => {
    const value = await setup()
    await recognitionReady(value)
    const respond = value.effect.getMockImplementation()
    if (!respond) throw new Error('Missing effect mock')
    let interrupted = false
    value.effect.mockImplementation(async (...args) => {
      if (args[2] === 'aka.recognition.test' && args[5]?.readbackOnly)
        return { outcome: 'not-started', deviceId: binding.deviceId, ...args[4] }
      if (args[2] === 'aka.recognition.test' && !interrupted) {
        interrupted = true
        throw new Error('Lost pre-submission response')
      }
      return respond(...args)
    })
    button(value.el, '开启连续识别').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('最近送检原图与识别结果'), {
      timeout: 4000,
    })
    button(value.el, '关闭连续识别').click()
    const tests = value.effect.mock.calls.filter((call) => call[2] === 'aka.recognition.test')
    expect(tests).toHaveLength(3)
    expect(tests[1]?.slice(3)).toEqual([tests[0]?.[3], tests[0]?.[4], { readbackOnly: true }])
    expect(tests[2]?.[3]).not.toBe(tests[0]?.[3])
    expect(value.effect.mock.calls.some((call) => call[2] === 'aka.recognition.round.start')).toBe(false)
    expect(sessionStorage.length).toBe(0)
  })
  it('explicitly reads budget and tests one image, with same-frame boxes and no live overlay or budget reset', async () => {
    const value = await setup()
    await recognitionReady(value)
    button(value.el, '测试图片').click()
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('最近送检原图与识别结果'))
    expect(value.imageLoad).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(value.el.querySelector('.aka-recognition-result img')?.getAttribute('src')).toBe(
        'blob:recognition-test',
      ),
    )
    expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
      'aka.recognition.round.read',
      'aka.recognition.test',
    ])
    expect(value.effect.mock.calls[1]?.[4]).toEqual({
      bindingRevision: 1,
      configRevision: 1,
      recognitionRevision: 2,
      roundRevision: 3,
    })
    expect(value.imageLoad).toHaveBeenCalledWith({
      laneId: 'main',
      artifact: captureReceipt.artifact,
      signal: expect.any(AbortSignal),
    })
    expect(value.el.querySelector('rect')?.getAttribute('width')).toBe('20')
    expect(value.el.querySelector('script')).toBeNull()
    expect(value.el.textContent).toContain('<script>ball</script>')
    expect(button(value.el, '测试图片').disabled).toBe(false)
    value.session.setSession('ordinary')
    await vi.waitFor(() => expect(value.imageResource.release).toHaveBeenCalledOnce())
    expect(value.el.querySelector('.aka-recognition-result img')).toBeNull()
  })
  it.each([
    { requestBudget: 2, effectiveBudget: 2, exhausted: true },
    { requestBudget: 20, effectiveBudget: 10, exhausted: false },
  ])(
    'uses the effective round cap after configuring a budget of $requestBudget',
    async ({ requestBudget, effectiveBudget, exhausted }) => {
      const value = await setup()
      await recognitionReady(value)
      value.recognition.mockResolvedValue({
        deviceId: id,
        bindingRevision: 1,
        configRevision: 3,
        settings: { provider: 'aliyun', frequency: 2, requestBudget, credentialConfigured: true },
      })
      value.effect.mockResolvedValue({ deviceId: id, roundRevision: 3, budget: 10, reserved: 2 })
      button(value.el, '读取当前识别额度').click()
      await vi.waitFor(() => {
        expect(value.el.textContent).toContain(`已预留次数 / 当前有效额度： 2 / ${effectiveBudget}`)
        expect(button(value.el, '测试图片').disabled).toBe(exhausted)
      })
      if (exhausted) {
        expect(value.el.textContent).toContain('当前有效额度已用尽')
        const reason = button(value.el, '测试图片').getAttribute('aria-describedby')
        expect(reason).toBeTruthy()
        if (!reason) throw new Error('Missing disabled-action explanation')
        expect(value.el.ownerDocument.getElementById(reason)?.textContent).toContain('当前有效额度已用尽')
        button(value.el, '测试图片').click()
      }
      expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
        'aka.recognition.round.read',
        'aka.recognition.round.read',
      ])
    },
  )
  it.each(['recognized', 'not-started'])(
    'restores a %s recognition after module reload without repeating inference',
    async (outcome) => {
      const value = await setup()
      await recognitionReady(value)
      const responder = value.effect.getMockImplementation()
      if (!responder) throw new Error('Missing receipt fixture')
      value.effect.mockRejectedValueOnce(new Error('Lost response'))
      button(value.el, '测试图片').click()
      await vi.waitFor(() => expect(value.el.textContent).toContain('操作结果未确认'))
      const sent = value.effect.mock.calls[1]
      expect(sent?.[2]).toBe('aka.recognition.test')
      value.effect.mockImplementation(responder)
      if (outcome === 'not-started')
        value.effect.mockResolvedValueOnce({
          outcome: 'not-started',
          deviceId: binding.deviceId,
          ...sent?.[4],
        })
      await value.reload()
      await vi.waitFor(() =>
        expect(value.el.textContent).toContain(
          outcome === 'recognized' ? '最近送检原图与识别结果' : '已确认原操作未送检',
        ),
      )
      expect(value.effect.mock.calls[2]?.slice(2)).toEqual([
        'aka.recognition.test',
        sent?.[3],
        sent?.[4],
        { readbackOnly: true },
      ])
      expect(value.effect).toHaveBeenCalledTimes(3)
      expect(value.el.textContent).not.toContain('Lost response')
      expect(sessionStorage.length).toBe(0)
      expect(button(value.el, '测试图片').disabled).toBe(false)
    },
  )
  it('keeps an unsuccessful recognition readback on the original identity across another reload', async () => {
    const value = await setup()
    await recognitionReady(value)
    value.effect.mockRejectedValue(new Error('Unknown charged result'))
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('操作结果未确认'))
    const sent = value.effect.mock.calls[1]
    button(value.el, '核对原识别结果').click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(button(value.el, '核对原识别结果').disabled).toBe(false))
    await value.reload()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(button(value.el, '核对原识别结果').disabled).toBe(false))
    expect(value.effect.mock.calls.slice(2).map((call) => call.slice(2))).toEqual([
      ['aka.recognition.test', sent?.[3], sent?.[4], { readbackOnly: true }],
      ['aka.recognition.test', sent?.[3], sent?.[4], { readbackOnly: true }],
    ])
    expect(value.imageLoad).not.toHaveBeenCalled()
    expect(value.el.textContent).not.toContain('Unknown charged result')
    expect(button(value.el, '开始新的识别额度轮次').disabled).toBe(true)
  })
  it('retains explicit original readback after an in-flight recognition reply is invalidated', async () => {
    const value = await setup()
    await recognitionReady(value)
    const responder = value.effect.getMockImplementation()
    if (!responder) throw new Error('Missing receipt fixture')
    const late = deferred<Record<string, unknown>>()
    value.effect.mockImplementationOnce(() => late.promise)
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(2))
    const sent = value.effect.mock.calls[1]
    if (!sent) throw new Error('Missing original dispatch')
    value.emit('reconnecting')
    late.resolve(await responder(...sent))
    await vi.waitFor(() => expect(button(value.el, '核对原识别结果').disabled).toBe(false))
    expect(value.imageLoad).not.toHaveBeenCalled()
    button(value.el, '核对原识别结果').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('最近送检原图与识别结果'))
    expect(value.effect.mock.calls[2]?.slice(2)).toEqual([
      'aka.recognition.test',
      sent[3],
      sent[4],
      { readbackOnly: true },
    ])
  })
  it('retries only saved image reading when its first display fails', async () => {
    const value = await setup()
    await recognitionReady(value)
    value.imageLoad.mockRejectedValueOnce(new Error('PrivateReadPath'))
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('无法核验或展示'))
    expect(value.el.textContent).not.toContain('PrivateReadPath')
    button(value.el, '重新读取送检原图').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-recognition-result img')).not.toBeNull())
    expect(value.imageLoad).toHaveBeenCalledTimes(2)
    expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
      'aka.recognition.round.read',
      'aka.recognition.test',
    ])
  })
  it('prepares a missing recognition round on an explicit test click with the current CAS revision', async () => {
    const value = await setup()
    await recognitionReady(value)
    const responder = value.effect.getMockImplementation()
    if (!responder) throw new Error('Missing recognition responder')
    value.effect.mockClear()
    value.effect.mockImplementation(async (...args) => {
      if (args[2] === 'aka.recognition.round.read') return null as unknown as Record<string, unknown>
      if (args[2] === 'aka.recognition.round.start')
        return { deviceId: id, roundRevision: 1, budget: 10, reserved: 0 }
      return { ...(await responder(...args)), roundRevision: 1 }
    })
    button(value.el, '读取当前识别额度').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('当前没有识别额度'))
    button(value.el, '测试图片').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-recognition-result')).not.toBeNull())
    expect(value.effect.mock.calls.map((call) => call[2])).toEqual([
      'aka.recognition.round.read',
      'aka.recognition.round.read',
      'aka.recognition.round.start',
      'aka.recognition.test',
    ])
    expect(value.effect.mock.calls[2]?.[4]).toEqual({
      expectedBindingRevision: 1,
      expectedConfigRevision: 2,
      expectedRoundRevision: 0,
      startId: expect.any(String),
    })
    expect(value.effect.mock.calls[3]?.[4]).toMatchObject({ recognitionRevision: 2, roundRevision: 1 })
  })
  it.each(['rejected', 'wrong-image', 'late-session'] as const)(
    'does not resubmit recognition after %s',
    async (mode) => {
      const value = await setup()
      await recognitionReady(value)
      const pending = deferred<Record<string, unknown>>()
      value.effect.mockImplementationOnce(() =>
        mode === 'rejected' ? Promise.reject(new Error('SecretProviderText')) : pending.promise,
      )
      button(value.el, '测试图片').click()
      await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(2))
      if (mode === 'late-session') value.session.setSession('ordinary')
      else if (mode === 'wrong-image') pending.resolve({ ...captureReceipt, sha256: 'forged' })
      await vi.waitFor(() => expect(button(value.el, '测试图片').disabled).toBe(true))
      if (mode !== 'late-session')
        await vi.waitFor(() => expect(value.el.textContent).toContain('操作结果未确认'))
      if (value.el.querySelector('.aka-console')) button(value.el, '测试图片').click()
      expect(value.effect).toHaveBeenCalledTimes(2)
      expect(value.imageLoad).not.toHaveBeenCalled()
      expect(value.el.textContent).not.toContain('SecretProviderText')
      if (mode === 'late-session') pending.resolve({})
    },
  )
  it('saves a photo through the admitted page effect, suppresses double clicks, and leaves live video available', async () => {
    const value = await setup()
    await captureReady(value)
    const pending = deferred<Record<string, unknown>>()
    value.effect.mockImplementation(async (_module, _session, name) => {
      if (name !== 'aka.capture') throw new Error('Unexpected operation')
      return pending.promise
    })
    value.effect.mockClear()
    const capture = button(value.el, '保存当前相机照片')
    capture.click()
    capture.click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(1))
    expect(value.effect.mock.calls[0]?.slice(1)).toEqual([
      'device',
      'aka.capture',
      expect.stringMatching(/^[a-f0-9-]{36}$/),
      { bindingRevision: 1, configRevision: 1 },
      undefined,
    ])
    expect(value.el.querySelector('.aka-live-video')).not.toBeNull()
    pending.resolve(captureReceipt)
    await vi.waitFor(() => expect(value.el.textContent).toContain('照片已留档'))
    expect(button(value.el, '保存当前相机照片').disabled).toBe(false)
  })
  it.each(['rejected', 'wrong-device', 'wrong-sequence'] as const)(
    'does not automatically retry an unknown %s capture or expose provider errors',
    async (mode) => {
      const value = await setup()
      await captureReady(value)
      value.effect.mockClear()
      value.effect.mockImplementation(async () => {
        if (mode === 'rejected') throw new Error('secret-provider-path')
        return { ...captureReceipt, ...(mode === 'wrong-device' ? { deviceId: 'other' } : { eventSeq: 0 }) }
      })
      button(value.el, '保存当前相机照片').click()
      await vi.waitFor(() => expect(value.el.textContent).toContain('拍照结果未确认'))
      button(value.el, '保存当前相机照片').click()
      expect(value.effect).toHaveBeenCalledTimes(1)
      expect(value.el.textContent).not.toContain('secret-provider-path')
      expect(value.el.querySelector('.aka-live-video')).not.toBeNull()
      button(value.el, '刷新配置与状态').click()
      await vi.waitFor(() => expect(button(value.el, '刷新配置与状态').disabled).toBe(false))
      expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
      expect(value.el.textContent).toContain('拍照结果未确认')
      expect(value.effect).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
      button(value.el, '核对原拍照结果').click()
      await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
      expect(value.effect.mock.calls[1]?.[3]).toBe(value.effect.mock.calls[0]?.[3])
      expect(value.el.textContent).toContain('拍照结果未确认')
      expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
      await value.reload()
      await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
      expect(value.effect).toHaveBeenCalledTimes(2)
      expect(value.el.textContent).toContain('拍照结果未确认')
      expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
      expect(value.el.textContent).not.toContain('secret-provider-path')
    },
  )
  it('does not publish a late capture receipt into a switched session', async () => {
    const value = await setup()
    await captureReady(value)
    const pending = deferred<Record<string, unknown>>()
    value.effect.mockImplementation(async () => pending.promise)
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('正在将选中的照片'))
    value.session.setSession('another')
    pending.resolve(captureReceipt)
    await vi.waitFor(() => expect(button(value.el, '保存当前相机照片').disabled).toBe(true))
    expect(value.el.textContent).not.toContain('照片已留档')
  })

  it('explicitly checks the original unknown photo using the same host command ID without requiring streaming', async () => {
    const value = await setup()
    await captureReady(value)
    value.effect.mockClear()
    value.effect.mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue(captureReceipt)
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
    const original = value.effect.mock.calls[0]
    value.query.mockResolvedValue({
      deviceId: id,
      enrollment: 'active',
      configRevision: 1,
      runtime: { connection: 'connected', media: 'idle', cameraOn: false },
    })
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() => expect(button(value.el, '开启摄像头').disabled).toBe(false))
    expect(button(value.el, '核对原拍照结果').disabled).toBe(false)
    expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
    const recover = button(value.el, '核对原拍照结果')
    recover.click()
    recover.click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('照片已留档'))
    expect(value.effect).toHaveBeenCalledTimes(2)
    expect(value.effect.mock.calls[1]?.slice(1, 5)).toEqual(original?.slice(1, 5))
    expect(value.effect.mock.calls[1]?.[5]).toEqual({ readbackOnly: true })
  })

  it('restores unresolved capture after the actual client module reload without auto-dispatching a photo', async () => {
    const value = await setup()
    await captureReady(value)
    value.effect.mockClear()
    value.effect.mockRejectedValue(new Error('unknown'))
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
    const original = value.effect.mock.calls[0]
    await value.reload()
    await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
    expect(value.effect).toHaveBeenCalledTimes(1)
    expect(button(value.el, '保存当前相机照片').disabled).toBe(true)
    value.effect.mockResolvedValue(captureReceipt)
    button(value.el, '核对原拍照结果').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('照片已留档'))
    expect(value.effect.mock.calls[1]?.slice(1, 5)).toEqual(original?.slice(1, 5))
    expect(value.effect.mock.calls[1]?.[5]).toEqual({ readbackOnly: true })
    expect(sessionStorage.length).toBe(0)
  })
  it('keeps failed recovery on the same original and allocates a new ID only after successful completion', async () => {
    const value = await setup()
    await captureReady(value)
    value.effect.mockClear()
    value.effect.mockRejectedValue(new Error('unknown'))
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
    button(value.el, '核对原拍照结果').click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(button(value.el, '核对原拍照结果').disabled).toBe(false))
    expect(value.effect.mock.calls[1]?.[3]).toBe(value.effect.mock.calls[0]?.[3])
    value.effect.mockResolvedValue(captureReceipt)
    button(value.el, '核对原拍照结果').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('照片已留档'))
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(value.effect).toHaveBeenCalledTimes(4))
    expect(value.effect.mock.calls[2]?.[3]).toBe(value.effect.mock.calls[0]?.[3])
    expect(value.effect.mock.calls[3]?.[3]).not.toBe(value.effect.mock.calls[0]?.[3])
  })

  it('keeps an in-flight capture alive while refreshing the same saved configuration', async () => {
    const value = await setup()
    await captureReady(value)
    const pending = deferred<Record<string, unknown>>()
    value.effect.mockImplementation(() => pending.promise)
    button(value.el, '保存当前相机照片').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('正在将选中的照片'))
    const refreshed = deferred<DeviceConnectionResult>()
    value.connection.mockImplementationOnce(() => refreshed.promise)
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('正在读取当前配置'))
    refreshed.resolve(value.result())
    await vi.waitFor(() => expect(value.el.querySelector('.aka-live-video')).not.toBeNull())
    expect(value.el.textContent).toContain('正在将选中的照片')
    pending.resolve(captureReceipt)
    await vi.waitFor(() => expect(value.el.textContent).toContain('照片已留档'))
  })

  it('automatically requests video for an opened camera and rejects its late ticket after session change', async () => {
    const value = await setup()
    const pendingTicket = deferred<unknown>()
    const original = value.query.getMockImplementation()
    if (!original) throw new Error('Missing service fixture')
    value.query.mockImplementation(async (...args) =>
      args[2] === 'aka.media.ticket' ? pendingTicket.promise : original(...args),
    )
    const socket = vi.fn()
    vi.stubGlobal('WebSocket', socket)
    await probe(value.el)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() => expect(button(value.el, '连接已保存设备').disabled).toBe(false))
    button(value.el, '连接已保存设备').click()
    await vi.waitFor(() => expect(button(value.el, '开启摄像头').disabled).toBe(false))
    button(value.el, '开启摄像头').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-live-video')).not.toBeNull())
    await vi.waitFor(() =>
      expect(value.query).toHaveBeenCalledWith(
        expect.objectContaining({ rowId: 'ext:agnes-examples/aka-robot' }),
        'device',
        'aka.media.ticket',
        { configRevision: 1, bindingRevision: 1 },
      ),
    )
    value.session.setSession('ordinary')
    pendingTicket.resolve({
      ticket: 'a'.repeat(43),
      expiresInMs: 30000,
      deviceId: id,
      configRevision: 1,
      bindingRevision: 1,
      rowRevision: 'current',
    })
    await vi.waitFor(() => expect(value.el.textContent).not.toContain('停止观看'))
    expect(socket).not.toHaveBeenCalled()
  })
  it('checks identity, requires explicit save, then explicitly connects and controls the camera through Host commands', async () => {
    const value = await setup()
    expect(value.save).not.toHaveBeenCalled()
    expect(value.effect).not.toHaveBeenCalled()
    await probe(value.el)
    expect(value.save).not.toHaveBeenCalled()
    expect(value.el.textContent).toContain(macAddress)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() =>
      expect(value.save).toHaveBeenCalledWith({
        sessionId: 'device',
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        ip: '192.168.50.42',
        port: 80,
        macAddress,
      }),
    )
    await vi.waitFor(() => expect(button(value.el, '连接已保存设备').disabled).toBe(false))
    expect(value.effect).toHaveBeenCalledTimes(1)
    button(value.el, '连接已保存设备').click()
    await vi.waitFor(() => expect(button(value.el, '开启摄像头').disabled).toBe(false))
    expect(value.effect).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowId: 'ext:agnes-examples/aka-robot' }),
      'device',
      'aka.connect',
      expect.any(String),
      { configRevision: 1 },
    )
    button(value.el, '开启摄像头').click()
    await vi.waitFor(() => expect(button(value.el, '关闭摄像头').disabled).toBe(false))
    expect(value.el.querySelector('.aka-live-video')).not.toBeNull()
    button(value.el, '关闭摄像头').click()
    await vi.waitFor(() => expect(button(value.el, '开启摄像头').disabled).toBe(false))
    button(value.el, '断开本地订阅').click()
    await vi.waitFor(() => expect(button(value.el, '连接已保存设备').disabled).toBe(false))
    expect(value.el.textContent).toContain('未连接')
  })

  it('invalidates a completed probe when the address is edited', async () => {
    const value = await setup()
    await probe(value.el)
    edit(value.el, 'ip', '192.168.50.43')
    await vi.waitFor(() => expect(value.el.textContent).not.toContain(macAddress))
    expect(value.save).not.toHaveBeenCalled()
    expect(
      Array.from(value.el.querySelectorAll('button')).some((item) => item.textContent === '确认并保存配置'),
    ).toBe(false)
  })

  it('does not dispatch duplicate probes from rapid clicks', async () => {
    const value = await setup()
    edit(value.el, 'ip', '192.168.50.42')
    const probeButton = button(value.el, '探测设备身份')
    probeButton.click()
    probeButton.click()
    await vi.waitFor(() => expect(value.el.textContent).toContain(macAddress))
    expect(value.effect).toHaveBeenCalledOnce()
    expect(value.save).not.toHaveBeenCalled()
  })

  it('recovers a committed save with a lost reply by readback instead of repeating the save or connecting', async () => {
    const value = await setup()
    const save = value.save.getMockImplementation()
    if (!save) throw new Error('Missing save implementation')
    value.save.mockImplementation(async (input) => {
      await save(input)
      throw new Error('Lost reply')
    })
    await probe(value.el)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() =>
      expect(value.el.querySelector('[role="alert"]')?.textContent).toContain('无法核实'),
    )
    expect(value.el.querySelector('.aka-console')).toBeNull()
    expect(value.save).toHaveBeenCalledOnce()
    expect(value.effect).toHaveBeenCalledOnce()
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() => expect(button(value.el, '连接已保存设备').disabled).toBe(false))
    expect(value.el.textContent).toContain('192.168.50.42:80')
    expect(value.save).toHaveBeenCalledOnce()
    expect(value.effect).toHaveBeenCalledOnce()
  })

  it('refuses a refreshed configuration for another device', async () => {
    const value = await setup()
    value.connection.mockResolvedValue({
      ...value.result(),
      deviceId: '22222222-2222-4222-8222-222222222222',
    })
    button(value.el, '刷新配置与状态').click()
    await vi.waitFor(() =>
      expect(value.el.querySelector('[role="alert"]')?.textContent).toContain('无法核实'),
    )
    expect(button(value.el, '探测设备身份').disabled).toBe(true)
    expect(value.effect).not.toHaveBeenCalled()
  })

  it.each(['switch', 'offline', 'unload'])(
    'ignores a late save reply after %s without connecting',
    async (mode) => {
      const value = await setup()
      await probe(value.el)
      const late = deferred<DeviceConnectionResult>()
      value.save.mockReturnValue(late.promise)
      button(value.el, '确认并保存配置').click()
      await vi.waitFor(() => expect(value.save).toHaveBeenCalled())
      if (mode === 'switch') {
        value.session.setSession('other')
        value.session.setSession('device')
      }
      if (mode === 'offline') {
        value.client.connectionState = 'reconnecting'
        value.emit('reconnecting')
      }
      if (mode === 'unload') await value.fiber.dispose()
      late.resolve({
        deviceId: id,
        bindingRevision: 1,
        profile: {
          driver: 'aka-00',
          ip: '192.168.50.42',
          port: 80,
          macAddress,
          configRevision: 1,
        },
      })
      await vi.waitFor(() => expect(value.el.textContent).not.toContain('操作进行中'))
      expect(value.el.textContent).not.toContain('192.168.50.42:80')
      expect(value.effect).toHaveBeenCalledOnce()
    },
  )

  it.each(['wrong-device', 'wrong-ip', 'wrong-revision', 'unknown-identity', 'failure'])(
    'does not permit saving a %s probe result',
    async (mode) => {
      const value = await setup()
      value.effect.mockImplementation(async (_module, _session, _name, _command, input) => {
        if (mode === 'failure') throw new Error('private diagnostics must stay hidden')
        return {
          ...input,
          deviceId: mode === 'wrong-device' ? '22222222-2222-4222-8222-222222222222' : id,
          ip: mode === 'wrong-ip' ? '192.168.50.99' : input.ip,
          bindingRevision: mode === 'wrong-revision' ? 2 : 1,
          macAddress,
          identity: mode === 'unknown-identity' ? 'unknown' : 'reported',
        }
      })
      edit(value.el, 'ip', '192.168.50.42')
      button(value.el, '探测设备身份').click()
      await vi.waitFor(() =>
        expect(value.el.querySelector('[role="alert"]')?.textContent).toContain('无法核实'),
      )
      expect(value.save).not.toHaveBeenCalled()
      expect(value.el.textContent).not.toContain('private diagnostics')
    },
  )

  it.each(['edit', 'switch', 'offline', 'unload'])(
    'discards a pending probe after %s without saving',
    async (mode) => {
      const value = await setup()
      const late = deferred<Record<string, unknown>>()
      value.effect.mockImplementation(async () => late.promise)
      edit(value.el, 'ip', '192.168.50.42')
      button(value.el, '探测设备身份').click()
      await vi.waitFor(() => expect(value.effect).toHaveBeenCalled())
      if (mode === 'edit') edit(value.el, 'ip', '192.168.50.43')
      if (mode === 'switch') {
        value.session.setSession('other')
        value.session.setSession('device')
      }
      if (mode === 'offline') {
        value.client.connectionState = 'reconnecting'
        value.emit('reconnecting')
      }
      if (mode === 'unload') await value.fiber.dispose()
      late.resolve({
        deviceId: id,
        bindingRevision: 1,
        expectedConfigRevision: 0,
        ip: '192.168.50.42',
        port: 80,
        macAddress,
        identity: 'reported',
      })
      await vi.waitFor(() => expect(value.el.textContent).not.toContain('操作进行中'))
      expect(value.el.textContent).not.toContain(macAddress)
      expect(value.save).not.toHaveBeenCalled()
    },
  )

  it('associates labels and errors, refuses public IPs and updates locale', async () => {
    const value = await setup()
    const input = value.el.querySelector('input[name="ip"]') as HTMLInputElement
    expect(value.el.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('小车 IP')
    edit(value.el, 'ip', '8.8.8.8')
    button(value.el, '探测设备身份').click()
    await vi.waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      '私有 IPv4',
    )
    expect(value.effect).not.toHaveBeenCalled()
    value.locale.setLocale('en')
    await vi.waitFor(() => expect(value.el.textContent).toContain('Check device identity'))
  })
})

function choose(el: HTMLElement, name: string, value: string) {
  const select = el.querySelector(`select[name="${name}"]`)
  if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
async function openRecognition(value: Awaited<ReturnType<typeof setup>>) {
  if (!value.el.querySelector('.aka-console')) {
    await probe(value.el)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-console')).not.toBeNull())
    value.effect.mockClear()
  }
  button(value.el, '图像识别配置').click()
  await vi.waitFor(() => expect(button(value.el, '保存识别配置').disabled).toBe(false))
  expect(value.el.querySelector('dialog')?.open).toBe(true)
}
async function enterCloud(el: HTMLElement) {
  edit(el, 'accessKeyId', 'SyntheticAK')
  edit(el, 'accessKeySecret', 'SyntheticSecret')
  await vi.waitFor(() =>
    expect((el.querySelector('input[name="accessKeySecret"]') as HTMLInputElement).value).toBe(
      'SyntheticSecret',
    ),
  )
}

describe('actual AKA recognition configuration dialog', () => {
  it('survives StrictMode effect replay without leaving the initial configuration read locked', async () => {
    const value = await setup()
    const entry = '../../../examples/packages/aka-robot-plugin/client/recognition-settings.js'
    const { RecognitionSettings } = await import(entry)
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    cleanup.push(() => root.unmount())
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(RecognitionSettings, {
          ctx: { agnes: value.client, session: value.session, locale: value.locale },
          sessionId: 'device',
          binding,
          close: vi.fn(),
        }),
      ),
    )
    await vi.waitFor(() => expect(button(el, '保存识别配置').disabled).toBe(false))
    expect(value.recognition).toHaveBeenCalledTimes(2)
    expect(el.querySelector('dialog')?.open).toBe(true)
    expect(value.recognitionSave).not.toHaveBeenCalled()
  })
  it('closing an in-flight save clears inputs but readback observes a committed configuration on reopening', async () => {
    const value = await setup()
    const settled = deferred<void>()
    const original = value.recognitionSave.getMockImplementation()
    if (!original) throw new Error('Missing save fixture')
    value.recognitionSave.mockImplementation(async (input) => {
      const result = await original(input)
      await settled.promise
      return result
    })
    await openRecognition(value)
    await enterCloud(value.el)
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.recognitionRequests).toHaveLength(1))
    button(value.el, '关闭').click()
    await vi.waitFor(() => expect(value.el.querySelector('dialog')).toBeNull())
    await openRecognition(value)
    expect(value.el.querySelector('input[type="password"]')).toBeNull()
    expect((value.el.querySelector('select[name="action"]') as HTMLSelectElement).value).toBe('keep')
    settled.resolve()
    await vi.waitFor(() => expect(button(value.el, '保存识别配置').disabled).toBe(false))
    expect(value.recognitionRequests).toHaveLength(1)
    expect(value.el.textContent).not.toContain('配置已保存；识别未启动。')
  })
  it('rejects an invalid budget before RPC and clears both secret inputs', async () => {
    const value = await setup()
    await openRecognition(value)
    await enterCloud(value.el)
    edit(value.el, 'requestBudget', '0')
    await vi.waitFor(() =>
      expect((value.el.querySelector('input[name="requestBudget"]') as HTMLInputElement).value).toBe('0'),
    )
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('请检查频率、预算'))
    expect(value.recognitionSave).not.toHaveBeenCalled()
    for (const input of value.el.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      expect(input.value).toBe('')
  })

  it('reads and saves redacted cloud settings through the existing owner SDK with CAS and no inference effect', async () => {
    const value = await setup()
    expect(value.recognition).not.toHaveBeenCalled()
    await openRecognition(value)
    expect(value.recognition).toHaveBeenCalledWith('device')
    expect(value.recognitionSave).not.toHaveBeenCalled()
    await enterCloud(value.el)
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('配置已保存；识别未启动。'))
    expect(value.recognitionRequests).toEqual([
      {
        sessionId: 'device',
        expectedBindingRevision: 1,
        expectedConfigRevision: 0,
        settings: {
          provider: 'aliyun',
          frequency: 2,
          requestBudget: 3600,
          credentials: { action: 'replace', accessKeyId: 'SyntheticAK', accessKeySecret: 'SyntheticSecret' },
        },
      },
    ])
    expect(value.el.querySelector('input[type="password"]')).toBeNull()
    expect(value.el.textContent).not.toContain('SyntheticSecret')
    expect(value.effect).not.toHaveBeenCalled()
    expect(value.query.mock.calls.every((call) => call[2] === 'aka.status')).toBe(true)
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.recognitionRequests).toHaveLength(2))
    expect(value.recognitionRequests[1]).toMatchObject({
      expectedConfigRevision: 1,
      settings: { credentials: { action: 'keep' } },
    })
    button(value.el, '关闭').click()
    await vi.waitFor(() => expect(value.el.querySelector('dialog')).toBeNull())
  })
  it('switches to local settings without retaining cloud inputs and saves the explicit no-token option', async () => {
    const value = await setup()
    await openRecognition(value)
    await enterCloud(value.el)
    choose(value.el, 'provider', 'local-yolo')
    await vi.waitFor(() => expect(value.el.textContent).toContain('本地 YOLO 服务尚未联调'))
    expect(value.el.querySelector('input[name="accessKeySecret"]')).toBeNull()
    edit(value.el, 'baseUrl', 'http://127.0.0.1:8000')
    choose(value.el, 'frequency', '0.5')
    await vi.waitFor(() =>
      expect((value.el.querySelector('input[name="baseUrl"]') as HTMLInputElement).value).toBe(
        'http://127.0.0.1:8000',
      ),
    )
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.recognitionRequests).toHaveLength(1))
    expect(value.recognitionRequests[0]).toMatchObject({
      settings: {
        provider: 'local-yolo',
        baseUrl: 'http://127.0.0.1:8000',
        frequency: 0.5,
        credentials: { action: 'clear' },
      },
    })
    expect(JSON.stringify(value.recognitionRequests[0])).not.toContain('Synthetic')
    expect(value.effect).not.toHaveBeenCalled()
  })
  it('locks an uncertain save until readback and never renders secret-bearing errors or retries automatically', async () => {
    const value = await setup()
    await openRecognition(value)
    value.recognitionSave.mockRejectedValue(new Error('SyntheticSecret provider failure'))
    await enterCloud(value.el)
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('保存结果未确认'))
    expect(button(value.el, '保存识别配置').disabled).toBe(true)
    expect(value.el.textContent).not.toContain('SyntheticSecret')
    expect((value.el.querySelector('input[name="accessKeySecret"]') as HTMLInputElement).value).toBe('')
    expect(value.recognitionSave).toHaveBeenCalledTimes(1)
    button(value.el, '重新读取配置').click()
    await vi.waitFor(() => expect(button(value.el, '保存识别配置').disabled).toBe(false))
    expect(value.recognitionSave).toHaveBeenCalledTimes(1)
  })
  it('rejects cross-device and secret-bearing configuration reads before enabling save', async () => {
    const value = await setup()
    await probe(value.el)
    button(value.el, '确认并保存配置').click()
    await vi.waitFor(() => expect(value.el.querySelector('.aka-console')).not.toBeNull())
    value.recognition.mockResolvedValue({
      deviceId: id,
      bindingRevision: 1,
      configRevision: 0,
      settings: null,
      accessKeySecret: 'DoNotDisplay',
    } as DeviceRecognitionResult)
    button(value.el, '图像识别配置').click()
    await vi.waitFor(() => expect(value.el.textContent).toContain('无法读取当前配置'))
    expect(button(value.el, '保存识别配置').disabled).toBe(true)
    expect(value.el.textContent).not.toContain('DoNotDisplay')
    value.recognition.mockResolvedValue({
      deviceId: '22222222-2222-4222-8222-222222222222',
      bindingRevision: 1,
      configRevision: 0,
      settings: null,
    })
    button(value.el, '重新读取配置').click()
    await vi.waitFor(() => expect(value.recognition).toHaveBeenCalledTimes(2))
    expect(button(value.el, '保存识别配置').disabled).toBe(true)
  })
  it('clears credentials on session change and drops a late save without re-opening the dialog', async () => {
    const value = await setup()
    const saved = deferred<DeviceRecognitionResult>()
    value.recognitionSave.mockImplementation(() => saved.promise)
    await openRecognition(value)
    await enterCloud(value.el)
    button(value.el, '保存识别配置').click()
    await vi.waitFor(() => expect(value.recognitionSave).toHaveBeenCalledTimes(1))
    expect((value.el.querySelector('input[name="accessKeySecret"]') as HTMLInputElement).value).toBe('')
    value.session.setSession('ordinary')
    await vi.waitFor(() => expect(value.el.querySelector('dialog')).toBeNull())
    saved.resolve({
      deviceId: id,
      bindingRevision: 1,
      configRevision: 1,
      settings: {
        provider: 'aliyun',
        frequency: 2,
        requestBudget: 3600,
        credentialConfigured: true,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(value.el.querySelector('dialog')).toBeNull()
    expect(value.el.textContent).not.toContain('配置已保存；识别未启动。')
    expect(value.effect).not.toHaveBeenCalled()
  })
})
