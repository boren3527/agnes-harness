import type {
  DeviceRecognitionBudgetPort,
  DeviceRecognitionBudgetRequest,
  DeviceSessionPort,
} from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { frozenJson } from './frozen-json.js'

export type DeviceRecognitionBudgetBridge = (
  sessionKey: string,
  callId: string,
  input: DeviceRecognitionBudgetRequest,
  signal: AbortSignal,
) => Promise<unknown>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const number = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min
const refuse = (): never => {
  throw new Error('device recognition budget unavailable')
}
/** Invoker has already checked grants/journal admission. Authors cannot supply call/session selectors. */
export function deviceRecognitionBudgetPort(
  sessionKey: string,
  callId: string,
  service: string,
  bridge: DeviceRecognitionBudgetBridge,
  device: Readonly<DeviceSessionPort>,
  signal: AbortSignal,
  alive: () => void,
): Readonly<DeviceRecognitionBudgetPort> {
  const live = () => {
    alive()
    signal.throwIfAborted()
  }
  return Object.freeze({
    request: async (input: DeviceRecognitionBudgetRequest) => {
      live()
      const inspected = inspectJsonData(input, 4096)
      if (
        !inspected.ok ||
        !inspected.value ||
        typeof inspected.value !== 'object' ||
        Array.isArray(inspected.value)
      )
        return refuse()
      const p = frozenJson(inspected.value) as unknown as DeviceRecognitionBudgetRequest
      const fields = Object.keys(p).sort().join(',')
      const expected =
        p.operation === 'read'
          ? 'expectedBindingRevision,expectedConfigRevision,operation'
          : p.operation === 'start'
            ? 'expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,operation,startId'
            : p.operation === 'reserve'
              ? 'attemptId,expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,operation'
              : ''
      if (
        !expected ||
        fields !== expected ||
        !number(p.expectedBindingRevision, 1) ||
        !number(p.expectedConfigRevision, p.operation === 'read' ? 0 : 1)
      )
        return refuse()
      if (
        p.operation !== 'read' &&
        (!number(p.expectedRoundRevision, p.operation === 'start' ? 0 : 1) ||
          typeof (p.operation === 'start' ? p.startId : p.attemptId) !== 'string' ||
          !uuid.test(p.operation === 'start' ? p.startId : p.attemptId))
      )
        return refuse()
      if (service === 'aka.recognition.round.read' && p.operation !== 'read') return refuse()
      if ((p.operation === 'start') !== (service === 'aka.recognition.round.start') && p.operation !== 'read')
        return refuse()
      const binding = await device.binding()
      live()
      if (!binding?.active || binding.bindingRevision !== p.expectedBindingRevision) return refuse()
      const raw = await bridge(sessionKey, callId, p, signal)
      live()
      const after = await device.binding()
      live()
      if (
        !after?.active ||
        after.deviceId !== binding.deviceId ||
        after.bindingRevision !== binding.bindingRevision
      )
        return refuse()
      const checked = inspectJsonData(raw, 4096)
      if (!checked.ok) return refuse()
      const result = frozenJson(checked.value)
      const round =
        p.operation === 'reserve' && result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>).round
          : result
      if (round === null && p.operation === 'read') return null
      if (!round || typeof round !== 'object' || Array.isArray(round)) return refuse()
      const r = round as Record<string, unknown>
      if (
        Object.keys(r).sort().join(',') !== 'budget,deviceId,reserved,roundRevision' ||
        r.deviceId !== binding.deviceId ||
        !number(r.roundRevision, 1) ||
        !number(r.budget, 1) ||
        (r.budget as number) > 100000 ||
        !number(r.reserved, 0) ||
        (r.reserved as number) > (r.budget as number)
      )
        return refuse()
      if (
        p.operation !== 'read' &&
        r.roundRevision !== p.expectedRoundRevision + (p.operation === 'start' ? 1 : 0)
      )
        return refuse()
      if (p.operation === 'reserve') {
        const v = result as Record<string, unknown>
        if (Object.keys(v).sort().join(',') !== 'granted,round' || typeof v.granted !== 'boolean')
          return refuse()
      }
      // No await between final lifetime check and returning the immutable, closed budget view.
      return result as Awaited<ReturnType<DeviceRecognitionBudgetPort['request']>>
    },
  })
}
