import type { HookHandler, PluginExtensionAPI, ServiceDef, ToolDef } from '@agnes/extension-api'
import { checkServiceDef, checkToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { validateAgainst } from '../../../../packages/protocol/src/index.js'
import { parseAkaConfig, runtime } from '../src/plugin.js'

const deviceId = '11111111-1111-4111-8111-111111111111'
const registration = {
  deviceId,
  ip: '192.168.50.42',
  port: 80,
  macAddress: '12:34:56:78:90:ab',
  configRevision: 1,
}
const binding = () => ({
  sessionId: 'device-chat',
  workspaceId: 'a'.repeat(64),
  deviceId,
  bindingRevision: 1,
  active: true,
})
function fixture(config: unknown = { devices: [registration] }) {
  const owner = new AbortController()
  let service: ServiceDef | undefined
  let tool: ToolDef | undefined
  let hook: HookHandler<'context'> | undefined
  const serviceNames: string[] = []
  const services = new Map<string, ServiceDef>()
  const tools: ToolDef[] = []
  const api = {
    ctx: { signal: owner.signal },
    registerTool: (value: ToolDef) => {
      tools.push(value)
      if (value.name === 'aka_observe') tool = value
      return () => {}
    },
    registerHook: (_event: string, value: HookHandler<'context'>) => {
      hook = value
      return () => {}
    },
  } as unknown as PluginExtensionAPI
  runtime.apply(
    {
      extension: () => api,
      services: {
        register(value) {
          serviceNames.push(value.name)
          services.set(value.name, value)
          if (value.name === 'aka.status') service = value
          return () => {}
        },
      },
    },
    config,
  )
  if (!service || !tool || !hook) throw new Error('Missing AKA contributions')
  const ctx = {
    session: { key: 'device-chat' },
    device: { binding: vi.fn(async () => binding()) },
    signal: new AbortController().signal,
  }
  return {
    owner,
    ctx,
    read: (invocation: unknown = ctx) =>
      service.handler({}, invocation as Parameters<ServiceDef['handler']>[1]),
    observe: (invocation: unknown = ctx) => tool.execute({}, invocation as Parameters<ToolDef['execute']>[1]),
    context: (invocation: unknown = ctx) =>
      hook({} as Parameters<typeof hook>[0], invocation as Parameters<typeof hook>[1]),
    service,
    tool,
    serviceNames,
    services,
    tools,
  }
}

describe('actual AKA plugin contributions', () => {
  function roundFixture() {
    const value = fixture()
    const service = value.services.get('aka.recognition.round.start')
    if (!service) throw new Error('Missing actual round service')
    const retired = new AbortController()
    const lease = {
      binding: binding(),
      recognition: {
        deviceId,
        bindingRevision: 1,
        configRevision: 1,
        settings: {
          provider: 'aliyun' as const,
          frequency: 2 as const,
          requestBudget: 2,
          credentialConfigured: true as const,
        },
      },
      revoked: retired.signal,
      release: vi.fn(),
    }
    const result = { deviceId, roundRevision: 1, budget: 2, reserved: 1 }
    const request = vi.fn(async (_input: unknown) => result)
    const retainRecognition = vi.fn(async () => lease)
    const input = {
      expectedBindingRevision: 1,
      expectedConfigRevision: 1,
      expectedRoundRevision: 0,
      startId: '22222222-2222-4222-8222-222222222222',
    }
    const ctx = {
      ...value.ctx,
      device: { ...value.ctx.device, retainRecognition },
      recognitionBudget: { request },
    }
    const invoke = (params: unknown = input, context: unknown = ctx) =>
      service.handler(
        params as Parameters<typeof service.handler>[0],
        context as Parameters<typeof service.handler>[1],
      )
    return { ...value, service, lease, retired, result, request, retainRecognition, input, ctx, invoke }
  }
  it('registers a round reader that returns existing usage without starting a round', async () => {
    const v = roundFixture()
    const reader = v.services.get('aka.recognition.round.read')
    if (!reader) throw new Error('missing reader')
    try {
      expect(checkServiceDef(reader)).toEqual({ ok: true })
      await expect(
        reader.handler({ expectedBindingRevision: 1, expectedConfigRevision: 1 }, v.ctx as never),
      ).resolves.toEqual(v.result)
      expect(v.request).toHaveBeenCalledWith({
        operation: 'read',
        expectedBindingRevision: 1,
        expectedConfigRevision: 1,
      })
      expect(v.retainRecognition).not.toHaveBeenCalled()
      await expect(
        reader.handler(
          { expectedBindingRevision: 1, expectedConfigRevision: 1, startId: 'forged' } as never,
          v.ctx as never,
        ),
      ).rejects.toThrow()
      expect(v.request).toHaveBeenCalledOnce()
    } finally {
      v.owner.abort()
    }
  })
  it('registers the real round-start effect and preserves used counts on idempotent readback without connecting', async () => {
    const v = roundFixture()
    try {
      expect(v.service.kind).toBe('effect')
      expect(checkServiceDef(v.service)).toEqual({ ok: true })
      await expect(v.invoke()).resolves.toEqual(v.result)
      expect(v.request).toHaveBeenCalledWith({ ...v.input, operation: 'start' })
      expect(v.lease.release).toHaveBeenCalledTimes(1)
      await expect(v.read()).resolves.toMatchObject({ runtime: null, automaticActions: false })
    } finally {
      v.owner.abort()
    }
  })
  it.each([
    'missing-port',
    'wrong-binding',
    'wrong-config',
    'retired',
    'selector',
    'bad-id',
    'secret-result',
  ] as const)('refuses round-start %s and releases any retained recognition lifetime', async (mode) => {
    const v = roundFixture()
    try {
      let params: unknown = v.input,
        ctx: unknown = v.ctx
      if (mode === 'missing-port') ctx = { ...v.ctx, recognitionBudget: undefined }
      if (mode === 'wrong-binding') v.lease.binding.active = false
      if (mode === 'wrong-config') v.lease.recognition.configRevision = 2
      if (mode === 'retired') v.retired.abort()
      if (mode === 'selector') params = { ...v.input, deviceId }
      if (mode === 'bad-id') params = { ...v.input, startId: 'bad' }
      if (mode === 'secret-result') Object.assign(v.result, { credentialRef: 'secret://private' })
      await expect(v.invoke(params, ctx)).rejects.toThrow()
      if (mode === 'secret-result') expect(v.request).toHaveBeenCalledTimes(1)
      else expect(v.request).not.toHaveBeenCalled()
      if (v.retainRecognition.mock.calls.length) expect(v.lease.release).toHaveBeenCalledTimes(1)
    } finally {
      v.owner.abort()
    }
  })
  it('refuses a late budget result after lease revocation and never repeats durable publication', async () => {
    const v = roundFixture()
    try {
      v.request.mockImplementationOnce(async () => {
        v.retired.abort()
        return v.result
      })
      await expect(v.invoke()).rejects.toThrow()
      expect(v.request).toHaveBeenCalledTimes(1)
      expect(v.lease.release).toHaveBeenCalledTimes(1)
    } finally {
      v.owner.abort()
    }
  })
  it('releases a recognition lease arriving after cancellation without publishing a round', async () => {
    const v = roundFixture()
    try {
      const cancelled = new AbortController()
      let finish!: (lease: typeof v.lease) => void
      v.retainRecognition.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const pending = v.invoke(v.input, { ...v.ctx, signal: cancelled.signal })
      cancelled.abort()
      await expect(pending).rejects.toThrow()
      expect(v.request).not.toHaveBeenCalled()
      finish(v.lease)
      await vi.waitFor(() => expect(v.lease.release).toHaveBeenCalledTimes(1))
    } finally {
      v.owner.abort()
    }
  })
  it('binds the shipped client descriptor to the actual backend row and registered service set', async () => {
    const manifestEntry = '../package.json'
    const descriptorEntry = '../client/agnes.client.json'
    const manifest = (await import(manifestEntry)).default
    const descriptor = (await import(descriptorEntry)).default
    const value = fixture({ devices: [] })
    try {
      expect(manifest.agnes.clientDescriptors[0].rowId).toBe(manifest.agnes.plugins[0].id)
      expect(new Set(descriptor.client.services)).toEqual(new Set(value.serviceNames))
      for (const name of [
        'aka.control.action',
        'aka.control.stop',
        'aka.settings.read',
        'aka.settings.save',
        'aka.geometry.read',
        'aka.geometry.save',
        'aka.geometry.estimate',
        'aka.modeling.settings.read',
        'aka.modeling.settings.save',
      ]) {
        const control = value.services.get(name)
        if (!control) throw new Error('Missing registered manual service')
        expect(checkServiceDef(control)).toEqual({ ok: true })
      }
      expect(descriptor.client.slots).toEqual(['workbench.device', 'tool.call.toolview'])
      const names = value.tools.map((tool) => tool.name)
      expect(new Set(names).size).toBe(names.length)
      const control = value.tools.find((tool) => tool.name === 'aka_control')
      if (!control) throw new Error('Missing control tool')
      for (const args of [
        { action: 'left', speed: 30, milliseconds: 500 },
        { action: 'right', speed: 30, milliseconds: 1000 },
        { action: 'down', speed: 30, milliseconds: 3000 },
        { action: 'left', speed: 30, milliseconds: 300 },
        { action: 'grab', speed: 30, milliseconds: 500 },
      ])
        expect(validateAgainst(control.parameters, args).ok).toBe(true)
      for (const args of [
        { action: 'left', speed: 51, milliseconds: 500 },
        { action: 'left', speed: 29, milliseconds: 500 },
        { action: 'left', speed: 50, milliseconds: 500 },
        { action: 'left', speed: 30, milliseconds: 299 },
        { action: 'left', speed: 30, milliseconds: 3001 },
        { action: 'left', speed: '15', milliseconds: 500 },
        { action: 'left', speed: 1.5, milliseconds: 500 },
        { action: 'left', speed: 30 },
        { action: 'stop', speed: 30, milliseconds: 500 },
        { action: 'left', speed: 30, milliseconds: 500, degrees: 45 },
      ])
        expect(validateAgainst(control.parameters, args).ok).toBe(false)
      const steps = [{ action: 'left', speed: 30, milliseconds: 500 }]
      const target = { labels: ['ball'], supervised: true }
      const mission = { ...target, goal: 'dispose', standoffMeters: 0.2 }
      const samples: Record<string, unknown> = {
        aka_stop: {},
        aka_capture: {},
        aka_distance: {},
        aka_observe: {},
        aka_control: { action: 'left', speed: 30, milliseconds: 500 },
        aka_patrol_saved: { supervised: true },
        aka_mission_saved: mission,
        aka_orbit_capture: { ...target, direction: 'left' },
        aka_mission: { ...mission, destinationLabels: ['bin'], steps },
        aka_transport: { ...target, destinationLabels: ['bin'], steps },
        aka_patrol: { supervised: true, steps, returnSteps: steps, homeLabels: ['marker'] },
        aka_scan: { views: 2, direction: 'left' },
        aka_read_observations: { taskId: 'sample', offset: 0, limit: 2 },
        aka_surround: {},
        aka_find_tennis: {},
        aka_pickup_tennis: {},
        aka_model_object: {},
        aka_demo_start: { goal: 'find_tennis' },
        aka_demo_step: { workflowId: 'sample', frameId: 'frame', decision: 'not_found' },
        aka_find: { views: 2, direction: 'left', labels: ['ball'] },
        aka_approach: { ...target, standoffMeters: 0.2, maxSteps: 2 },
        aka_grasp: { ...target, action: 'grab', destinationLabels: [] },
        aka_task_cancel: { taskId: 'sample' },
        aka_export_observations: { taskId: 'sample' },
        aka_generate_reference_view: {
          taskId: 'sample',
          view: 'front',
          description: 'A black glossy cup with a curved right handle.',
        },
        aka_generate_reference_views: {
          taskId: 'sample',
          description: 'A glossy black hollow ceramic cup with a curved loop handle.',
        },
        aka_read_reference_views: { taskId: 'sample', offset: 0 },
        aka_prepare_subject: { taskId: 'sample', photoIndex: 1 },
        aka_build_model: { taskId: 'sample', photoIndex: 1 },
        aka_modeling_status: {},
        aka_modeling_configure: {
          config: {
            generator: 'fixture',
            command: ['fixture', '{image}', '{out}'],
            upAxis: 'Z',
            unit: 'm',
            displayHeight: 1,
          },
        },
      }
      expect(Object.keys(samples).sort()).toEqual([...names].sort())
      for (const tool of value.tools) {
        const sample = samples[tool.name] as Record<string, unknown>
        expect(validateAgainst(tool.parameters, sample).ok, tool.name).toBe(true)
        expect(validateAgainst(tool.parameters, { ...sample, unexpected: true }).ok, tool.name).toBe(false)
        for (const required of tool.parameters.required ?? []) {
          const missing = { ...sample }
          delete missing[required]
          expect(validateAgainst(tool.parameters, missing).ok, `${tool.name}/${required}`).toBe(false)
        }
      }
      const patrol = value.tools.find((tool) => tool.name === 'aka_patrol')
      if (!patrol) throw new Error('Missing patrol tool')
      for (const step of [
        { ...steps[0], speed: 51 },
        { ...steps[0], action: 'grab' },
        { ...steps[0], extra: true },
      ]) {
        expect(validateAgainst(patrol.parameters, { supervised: true, steps: [step] }).ok).toBe(false)
      }
      for (const name of [
        'aka_find',
        'aka_approach',
        'aka_grasp',
        'aka_transport',
        'aka_mission',
        'aka_mission_saved',
        'aka_patrol',
        'aka_patrol_saved',
        'aka_orbit_capture',
        'aka_task_cancel',
        'aka_export_observations',
        'aka_prepare_subject',
        'aka_build_model',
      ]) {
        const tool = value.tools.find((tool) => tool.name === name)
        expect(tool, `Missing actual plugin tool: ${name}`).toBeDefined()
        if (!tool) throw new Error(`Missing actual plugin tool: ${name}`)
        expect(checkToolDef(tool), name).toEqual({ ok: true })
      }
      const restarted = fixture({ devices: [] })
      try {
        expect(restarted.tools.map((tool) => tool.name)).toEqual(names)
      } finally {
        restarted.owner.abort()
      }
    } finally {
      value.owner.abort()
    }
  })
  it('registers a query and read-only tool without allocating a runtime and with accurate model-visible facts', async () => {
    const value = fixture()
    expect(value.service.kind).toBe('query')
    expect(value.tool.meta).toMatchObject({ isReadOnly: true, replay: 'safe', isOpenWorld: false })
    await expect(value.read()).resolves.toMatchObject({
      enrollment: 'active',
      configured: true,
      automaticActions: false,
      configRevision: 1,
      runtime: null,
    })
    const content = JSON.stringify(await value.observe())
    expect(content).toContain('独立效果授权')
    expect(content).toContain('"automaticActions":false')
    expect(JSON.stringify(await value.context())).toContain('aka/device-state')
    value.owner.abort()
    await expect(value.read()).rejects.toThrow()
  })

  it('prefers persisted configuration and never falls back after a missing or failed profile read', async () => {
    const value = fixture()
    const connection = vi.fn(async () => ({
      deviceId,
      bindingRevision: 1,
      profile: {
        driver: 'aka-00' as const,
        ip: '192.168.50.43',
        port: 80,
        macAddress: registration.macAddress,
        configRevision: 2,
      },
    }))
    const invocation = { ...value.ctx, device: { ...value.ctx.device, connection } }
    await expect(value.read(invocation)).resolves.toMatchObject({
      configured: true,
      configRevision: 2,
      runtime: null,
    })
    await expect(
      value.read({
        ...invocation,
        device: {
          ...invocation.device,
          connection: async () => ({ deviceId, bindingRevision: 1, profile: null }),
        },
      }),
    ).resolves.toMatchObject({
      configured: false,
      configRevision: null,
      runtime: null,
    })
    connection.mockRejectedValue(new Error('Metadata unavailable'))
    await expect(value.read(invocation)).rejects.toThrow('Metadata unavailable')
    value.owner.abort()
  })

  it('provides saved task configuration to the model after the real page save service and refreshes it through observe', async () => {
    const value = fixture({ devices: [] })
    const files = new Map<string, Uint8Array>()
    const read = async (path: string) => {
      const bytes = files.get(path)
      if (!bytes) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' })
      return bytes
    }
    const invocation = {
      ...value.ctx,
      session: { key: 'device-chat', workspaceRoot: '/device-workspace' },
      device: {
        ...value.ctx.device,
        connection: async () => ({
          deviceId,
          bindingRevision: 1,
          profile: { ...registration, driver: 'aka-00' },
        }),
      },
      fs: {
        read,
        stat: async (path: string) => ({ kind: 'file', size: (await read(path)).length }),
        write: async (path: string, text: string) => files.set(path, new TextEncoder().encode(text)),
      },
    }
    const point = (u: number, v: number) => ({ u, v, x: 1 - v / 240, y: 1 - u / 160 })
    const routes = {
      patrol: {
        steps: [{ action: 'up', speed: 30, milliseconds: 500 }],
        returnSteps: [{ action: 'down', speed: 30, milliseconds: 500 }],
        homeLabels: ['ball'],
      },
      delivery: { steps: [{ action: 'up', speed: 30, milliseconds: 500 }], destinationLabels: ['bin'] },
    }
    try {
      const save = value.services.get('aka.geometry.save')
      if (!save) throw new Error('Missing page save service')
      await save.handler(
        {
          bindingRevision: 1,
          configRevision: 1,
          expectedRevision: 0,
          calibration: {
            width: 320,
            height: 240,
            installation: 'fixed-test-camera',
            labels: ['ball'],
            measurementErrorMeters: 0.005,
            points: [
              [10, 20],
              [150, 20],
              [290, 20],
              [10, 200],
              [150, 200],
              [290, 200],
            ].map(([u, v]) => point(u ?? 0, v ?? 0)),
            checks: [point(70, 90), point(200, 80), point(120, 140)],
            routes,
          },
        },
        invocation as unknown as Parameters<ServiceDef['handler']>[1],
      )
      expect(files.size).toBe(1)
      const { fs: _fs, ...hookInvocation } = invocation
      const context = (await value.context(hookInvocation)).sections?.[0]?.content ?? ''
      expect(context).toContain('"state":"last_read"')
      expect(context).toContain('"destinationLabels":["bin"]')
      expect(context).not.toContain('自主接近、抓取、搬运尚未开放')
      expect((await value.observe(invocation)).structured).toMatchObject({
        taskConfiguration: { state: 'saved', revision: 1, routes },
      })
      files.clear()
      expect((await value.observe(invocation)).structured).toMatchObject({
        taskConfiguration: { state: 'missing' },
      })
      expect((await value.context(hookInvocation)).sections?.[0]?.content).toContain('"state":"unavailable"')
    } finally {
      value.owner.abort()
    }
  })

  it('does not inherit workspace devices into ordinary or historical sessions', async () => {
    const value = fixture()
    const ordinary = { ...value.ctx, device: { binding: async () => null } }
    await expect(value.read(ordinary)).resolves.toMatchObject({
      enrollment: 'ordinary',
      deviceId: null,
      runtime: null,
      configured: false,
    })
    await expect(value.context(ordinary)).resolves.toEqual({})
    const historical = { ...value.ctx, device: { binding: async () => ({ ...binding(), active: false }) } }
    await expect(value.read(historical)).resolves.toMatchObject({
      enrollment: 'inactive',
      runtime: null,
      configured: false,
    })
    expect(JSON.stringify(await value.observe(historical))).not.toContain('12:34:56')
    value.owner.abort()
  })

  it('distinguishes missing Host bridge from an ordinary unenrolled session', async () => {
    const value = fixture()
    const unsupported = { session: value.ctx.session, signal: value.ctx.signal }
    await expect(value.read(unsupported)).resolves.toMatchObject({ enrollment: 'unavailable', runtime: null })
    await expect(value.context(unsupported)).resolves.toEqual({})
    value.owner.abort()
  })

  it('reports unconfigured enrollment and refuses forged or cancelled binding responses', async () => {
    const value = fixture({ devices: [] })
    await expect(value.read()).resolves.toMatchObject({
      enrollment: 'active',
      configured: false,
      runtime: null,
    })
    await expect(value.read({ ...value.ctx, session: { key: 'other' } })).rejects.toThrow('does not match')
    const cancel = new AbortController()
    let resolve!: (value: ReturnType<typeof binding>) => void
    const pending = value.read({
      ...value.ctx,
      signal: cancel.signal,
      device: {
        binding: () =>
          new Promise((yes) => {
            resolve = yes
          }),
      },
    })
    cancel.abort()
    resolve(binding())
    await expect(pending).rejects.toThrow()
    value.owner.abort()
  })

  it.each([
    { key: 'not-supported' },
    { devices: [{}] },
    { devices: [{ ...registration, ip: '127.0.0.1' }] },
    { devices: [{ ...registration, macAddress: '00:00:00:00:00:00' }] },
    { devices: [registration, registration] },
    { devices: [registration, { ...registration, deviceId: '22222222-2222-4222-8222-222222222222' }] },
  ])('refuses invalid owner config before opening any connection: %j', (config) => {
    expect(() => parseAkaConfig(config)).toThrow()
    expect(runtime.Config['~standard'].validate(config)).toHaveProperty('issues')
  })
})
