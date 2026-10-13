import type { ServiceContext, ServiceDef, ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import type { CaptureDependencies } from './capture-frame.js'
import { readRegistration, sameRegistration } from './connection-profile.js'
import { waitForCheck } from './connection-services.js'
import { parseRobotSettings } from './http-driver.js'
import { AkaProtocolError } from './protocol.js'
import type { AkaRuntime } from './runtime.js'

// Engineering caps for supervised manual operation, not measured autonomous calibration.
const limits = Object.freeze({ maxSpeed: 50, maxMilliseconds: 3000, maxCentimeters: 1, maxDegrees: 1 })
const actions = ['up', 'down', 'left', 'right', 'grab', 'release', 'stop'] as const
const inputSchema: ServiceDef['inputSchema'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bindingRevision: { type: 'integer', minimum: 1 },
    configRevision: { type: 'integer', minimum: 1 },
    action: { enum: [...actions] },
    speed: { type: 'integer', minimum: 1, maximum: limits.maxSpeed },
    milliseconds: { type: 'integer', minimum: 1, maximum: limits.maxMilliseconds },
  },
  required: ['bindingRevision', 'configRevision', 'action', 'speed', 'milliseconds'],
}
type ControlContext = Pick<ToolContext, 'device' | 'authorize' | 'signal'> & {
  session?: { key: string; turn?: number; toolUseId?: string }
}
export async function runDeviceControl(
  deps: CaptureDependencies,
  ctx: ControlContext,
  input: Record<string, unknown>,
  manual = true,
  workflow?: { id: string; onDispatch?: () => void },
) {
  const fail = (): never => {
    throw new AkaProtocolError('Device control unavailable or outcome unknown')
  }
  const action = input.action as (typeof actions)[number]
  if (
    !actions.includes(action) ||
    Object.keys(input).sort().join(',') !== 'action,bindingRevision,configRevision,milliseconds,speed' ||
    !Number.isSafeInteger(input.bindingRevision) ||
    !Number.isSafeInteger(input.configRevision) ||
    !Number.isSafeInteger(input.speed) ||
    (input.speed as number) < 1 ||
    (input.speed as number) > limits.maxSpeed ||
    !Number.isSafeInteger(input.milliseconds) ||
    (input.milliseconds as number) < 1 ||
    (input.milliseconds as number) > limits.maxMilliseconds
  )
    return fail()
  if (
    ['up', 'down', 'left', 'right'].includes(action) &&
    ((input.speed as number) < 30 ||
      (input.milliseconds as number) < (action === 'left' || action === 'right' ? 300 : 500))
  )
    return fail()
  return withControlDevice(
    deps,
    ctx,
    input,
    action === 'stop',
    async (runtime, operation, deviceId) => {
      workflow?.onDispatch?.()
      const result =
        action === 'stop'
          ? { ...(await runtime.stopControl()), stop: runtime.snapshot().control.lastStop }
          : await runtime.controlAction(
              action,
              input.speed as number,
              input.milliseconds as number,
              limits,
              operation,
            )
      if (result.state === 'unknown') return fail()
      return {
        deviceId,
        bindingRevision: input.bindingRevision as number,
        configRevision: input.configRevision as number,
        action,
        state: result.state,
        stop: result.stop,
        physicalResult: 'unverified',
      }
    },
    manual,
    workflow?.id,
  )
}
async function withControlDevice<T>(
  deps: CaptureDependencies,
  ctx: ControlContext,
  input: Record<string, unknown>,
  stopping: boolean,
  perform: (runtime: AkaRuntime, signal: AbortSignal, deviceId: string) => Promise<T>,
  manual = false,
  workflow?: string,
): Promise<T> {
  const fail = (): never => {
    throw new AkaProtocolError('Device operation unavailable')
  }
  const signal = AbortSignal.any([deps.api.ctx.signal, ctx.signal])
  signal.throwIfAborted()
  if (!ctx.device || !ctx.session?.key) return fail()
  const device = ctx.device,
    sessionId = ctx.session.key
  const binding = await waitForCheck(device.binding(), signal)
  if (
    !binding?.active ||
    binding.sessionId !== sessionId ||
    binding.bindingRevision !== input.bindingRevision
  )
    return fail()
  const id = binding.deviceId.toLowerCase(),
    owner = deps.owners.get(id)
  const registration = await waitForCheck(readRegistration(device, binding, deps.registrations), signal)
  if (
    !registration ||
    registration.configRevision !== input.configRevision ||
    !owner?.revoked ||
    owner.revoked.aborted ||
    owner.workspaceId !== binding.workspaceId ||
    owner.bindingRevision !== binding.bindingRevision ||
    !sameRegistration(owner.registration, registration) ||
    (!stopping && owner.sessionId !== sessionId)
  )
    return fail()
  const runtime = deps.pool.find(registration)
  if (runtime?.snapshot().identity !== 'matched') return fail()
  const operation = AbortSignal.any([signal, owner.revoked])
  const verify = async () => {
    operation.throwIfAborted()
    const current = await waitForCheck(device.binding(), operation)
    if (
      !current?.active ||
      current.sessionId !== sessionId ||
      current.workspaceId !== binding.workspaceId ||
      current.deviceId.toLowerCase() !== id ||
      current.bindingRevision !== binding.bindingRevision ||
      deps.owners.get(id) !== owner
    )
      return fail()
    const next = await waitForCheck(readRegistration(device, current, deps.registrations), operation)
    if (!next || !sameRegistration(next, registration)) return fail()
    operation.throwIfAborted()
  }
  // Independent stop never waits for the shared capture/movement slot.
  let acquired = false
  try {
    const decision = await waitForCheck(
      ctx.authorize('execute', { kind: 'datasource', id: `aka/device/${id}/control` }),
      operation,
    )
    if (decision.effect !== 'allow') return fail()
    await verify()
    if (manual && input.action === 'release')
      deps.guardModelRelease?.(sessionId, id, ctx.session?.turn, typeof ctx.session?.toolUseId === 'string')
    if (!stopping)
      deps.guardModelAction?.(
        sessionId,
        id,
        ctx.session?.turn,
        typeof ctx.session?.toolUseId === 'string',
        workflow,
      )
    if (manual) await deps.interruptTask?.(sessionId, stopping, id)
    await verify()
    if (!stopping && deps.busy.has(id)) return fail()
    if (!stopping) {
      deps.busy.add(id)
      acquired = true
    }
    const result = await perform(runtime, operation, id)
    await verify()
    return result
  } finally {
    if (acquired) deps.busy.delete(id)
  }
}
export function registerControlServices(
  register: (def: ServiceDef) => unknown,
  deps: CaptureDependencies,
): void {
  for (const stopping of [false, true])
    register({
      name: stopping ? 'aka.control.stop' : 'aka.control.action',
      kind: 'effect',
      inputSchema,
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceId: { type: 'string' },
          bindingRevision: { type: 'integer' },
          configRevision: { type: 'integer' },
          action: { enum: [...actions] },
          state: { enum: ['completed', 'acknowledged', 'sent'] },
          stop: { enum: ['completed', 'unknown', null] },
          physicalResult: { const: 'unverified' },
        },
        required: [
          'deviceId',
          'bindingRevision',
          'configRevision',
          'action',
          'state',
          'stop',
          'physicalResult',
        ],
      },
      timeoutMs: stopping ? 6000 : 20000,
      maxResultBytes: 2048,
      async handler(input, ctx: ServiceContext) {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          (input.action === 'stop') !== stopping
        )
          throw new AkaProtocolError('Invalid control service input')
        return runDeviceControl(deps, ctx, input)
      },
    })
  for (const stopping of [false, true])
    deps.api.registerTool({
      name: stopping ? 'aka_stop' : 'aka_control',
      description: stopping
        ? '独立请求当前会话设备底盘停止。不能证明实车停稳，也不取消机械臂序列。'
        : '执行一次前进up、后退down、左转left、右转right、夹取grab或释放release。模型动作配速固定30；前后移动500—3000ms，转向允许300—3000ms；设备端计时后自动停车，未知结果不得重发。本车实测前进样例：{"action":"up","speed":30,"milliseconds":1000}约10cm；700ms约5cm；500ms约3cm。30/250ms没有反应，低于速度30也不动。三组不是线性比例，不能用10cm/秒推算任意时长、速度、后退或转角，不承诺精确位移。接近过程中微调方向用left/right、speed30，默认500ms；连续默认时长调整或过冲时可选300ms，最多700ms；300ms仅用于接近微调，不用于找球或环视，不换算固定转角，停车等约1秒看新图再决定。环视用aka_surround；找网球、接近夹取、释放后建模用aka_demo_start/aka_demo_step，按有界检查点逐张判断，不能无限重试。用户给明确合法参数时原样发送，不偷偷调整。直接夹取释放与控制台同接口，机械臂按设备固定序列执行，speed/ms不改变机械臂序列。按用户要求夹取后核验原位置球是否消失，视觉核验与持物传感器结果分开，不自动释放。',
      parameters: stopping
        ? Type.Object({}, { additionalProperties: false })
        : Type.Object(
            {
              action: Type.Union([
                Type.Literal('up'),
                Type.Literal('down'),
                Type.Literal('left'),
                Type.Literal('right'),
                Type.Literal('grab'),
                Type.Literal('release'),
              ]),
              speed: Type.Literal(30),
              milliseconds: Type.Integer({ minimum: 300, maximum: limits.maxMilliseconds }),
            },
            { additionalProperties: false },
          ),
      meta: {
        isReadOnly: false,
        isDestructive: !stopping,
        isConcurrencySafe: stopping,
        isOpenWorld: false,
        replay: 'never',
        deferLoading: false,
        requiresApproval: 'never',
        costHint: undefined,
      },
      async execute(input, ctx) {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== (stopping ? '' : 'action,milliseconds,speed')
        )
          throw new AkaProtocolError('Invalid device control input')
        const binding = await ctx.device?.binding()
        if (!binding?.active || !ctx.device) throw new AkaProtocolError('Device binding unavailable')
        const registration = await readRegistration(ctx.device, binding, deps.registrations)
        const result = await runDeviceControl(deps, ctx, {
          ...(stopping ? { action: 'stop', speed: 1, milliseconds: 1 } : input),
          bindingRevision: binding.bindingRevision,
          configRevision: registration?.configRevision,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
      },
    })
}

export function registerRobotSettings(register: (def: ServiceDef) => unknown, deps: CaptureDependencies) {
  for (const save of [false, true])
    register({
      name: save ? 'aka.settings.save' : 'aka.settings.read',
      kind: 'effect',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bindingRevision: { type: 'integer', minimum: 1 },
          configRevision: { type: 'integer', minimum: 1 },
          ...(save ? { kind: { enum: ['speed', 'arm'] }, settings: { type: 'object' } } : {}),
        },
        required: save
          ? ['bindingRevision', 'configRevision', 'kind', 'settings']
          : ['bindingRevision', 'configRevision'],
      },
      outputSchema: { type: 'object' },
      timeoutMs: 20000,
      maxResultBytes: 4096,
      async handler(value, ctx: ServiceContext) {
        const input = value as Record<string, unknown>
        if (
          Object.keys(input).sort().join(',') !==
          (save ? 'bindingRevision,configRevision,kind,settings' : 'bindingRevision,configRevision')
        )
          throw new AkaProtocolError('Invalid settings request')
        let desired: ReturnType<typeof parseRobotSettings> | undefined
        if (save) {
          if (input.kind !== 'speed' && input.kind !== 'arm')
            throw new AkaProtocolError('Invalid settings kind')
          const v = input.settings as { speed?: unknown; arm?: unknown }
          desired = parseRobotSettings(v?.speed, v?.arm)
        }
        return withControlDevice(deps, ctx, input, false, async (runtime, signal, deviceId) => {
          if (desired) {
            const current = await runtime.settings(signal)
            if (current.arm.driver !== desired.arm.driver) throw new AkaProtocolError('Arm driver changed')
          }
          const settings = await runtime.settings(signal, desired, input.kind as 'speed' | 'arm' | undefined)
          return {
            deviceId,
            bindingRevision: input.bindingRevision as number,
            configRevision: input.configRevision as number,
            settings,
          }
        })
      },
    })
}
