import type { DeviceSessionPort } from '@agnes/extension-api'
import {
  type DeviceConnectionResult,
  type DeviceRecognitionResult,
  type DeviceSessionResult,
  inspectJsonData,
  validateMethod,
} from '@agnes/protocol'
import { frozenJson } from './frozen-json.js'

export type DeviceSessionRetainer = (
  sessionKey: string,
  signal: AbortSignal,
  lifetime: AbortSignal,
  scope?: 'recognition',
) => Promise<
  Readonly<{
    snapshot: unknown
    connection?: unknown
    recognition?: unknown
    revoked: AbortSignal
    release(): void
  }>
>

/** Captures Host identity once; reads fresh data and checks lifetime before and after every await. */
export function deviceSessionPort(
  sessionKey: string,
  read: (sessionKey: string, signal: AbortSignal, view?: 'connection' | 'recognition') => Promise<unknown>,
  signal: AbortSignal,
  assertLive: () => void,
  retained?: { retain: DeviceSessionRetainer; lifetime: AbortSignal },
): Readonly<DeviceSessionPort> {
  const refuse = (): never => {
    throw new Error('device binding unavailable')
  }
  const project = (raw: unknown) => {
    const inspected = inspectJsonData(raw)
    if (!inspected.ok) return refuse()
    const result = frozenJson(inspected.value)
    if (!validateMethod('_agnes/v1/device.session.get', 'result', result).ok) return refuse()
    const { session: binding, workspace: association } = result as unknown as DeviceSessionResult
    if (!binding) return null
    if (
      binding.sessionId !== sessionKey ||
      (association && association.workspaceId !== binding.workspaceId) ||
      (binding.active &&
        (!association?.active ||
          association.deviceId !== binding.deviceId ||
          association.revision !== binding.bindingRevision))
    )
      return refuse()
    return Object.freeze({ ...binding })
  }
  const retain = async (scope?: 'recognition') => {
    assertLive()
    signal.throwIfAborted()
    if (!retained) return refuse()
    const lease = await (scope
      ? retained.retain(sessionKey, signal, retained.lifetime, scope)
      : retained.retain(sessionKey, signal, retained.lifetime))
    try {
      assertLive()
      signal.throwIfAborted()
      const binding = project(lease.snapshot)
      if (!binding?.active || lease.revoked.aborted) return refuse()
      let connection: Readonly<DeviceConnectionResult> | undefined
      if (lease.connection !== undefined) {
        const inspected = inspectJsonData(lease.connection)
        if (!inspected.ok) return refuse()
        const value = frozenJson(inspected.value)
        if (!validateMethod('_agnes/v1/device.connection.get', 'result', value).ok) return refuse()
        connection = value as unknown as Readonly<DeviceConnectionResult>
        if (
          connection.deviceId !== binding.deviceId ||
          connection.bindingRevision !== binding.bindingRevision
        )
          return refuse()
      }
      let recognition: Readonly<DeviceRecognitionResult> | undefined
      if (scope === 'recognition') {
        const inspected = inspectJsonData(lease.recognition)
        if (!inspected.ok) return refuse()
        const value = frozenJson(inspected.value)
        if (!validateMethod('_agnes/v1/device.recognition.get', 'result', value).ok) return refuse()
        recognition = value as unknown as Readonly<DeviceRecognitionResult>
        if (
          recognition.deviceId !== binding.deviceId ||
          recognition.bindingRevision !== binding.bindingRevision
        )
          return refuse()
      }
      return Object.freeze({
        binding,
        ...(connection ? { connection } : {}),
        ...(recognition ? { recognition } : {}),
        revoked: lease.revoked,
        release: () => lease.release(),
      })
    } catch (error) {
      lease.release()
      throw error
    }
  }
  return Object.freeze({
    recognition: async () => {
      assertLive()
      signal.throwIfAborted()
      if (!sessionKey) return refuse()
      const before = project(await read(sessionKey, signal))
      assertLive()
      signal.throwIfAborted()
      if (!before?.active) return refuse()
      const raw = await read(sessionKey, signal, 'recognition')
      assertLive()
      signal.throwIfAborted()
      const inspected = inspectJsonData(raw)
      if (!inspected.ok) return refuse()
      const value = frozenJson(inspected.value)
      if (!validateMethod('_agnes/v1/device.recognition.get', 'result', value).ok) return refuse()
      const recognition = value as unknown as Readonly<DeviceRecognitionResult>
      const after = project(await read(sessionKey, signal))
      assertLive()
      signal.throwIfAborted()
      if (
        !after?.active ||
        after.deviceId !== before.deviceId ||
        after.workspaceId !== before.workspaceId ||
        after.bindingRevision !== before.bindingRevision ||
        recognition.deviceId !== after.deviceId ||
        recognition.bindingRevision !== after.bindingRevision
      )
        return refuse()
      return recognition
    },
    connection: async () => {
      assertLive()
      signal.throwIfAborted()
      if (!sessionKey) return refuse()
      const before = project(await read(sessionKey, signal))
      assertLive()
      signal.throwIfAborted()
      if (!before?.active) return refuse()
      const raw = await read(sessionKey, signal, 'connection')
      assertLive()
      signal.throwIfAborted()
      const inspected = inspectJsonData(raw)
      if (!inspected.ok) return refuse()
      const result = frozenJson(inspected.value)
      if (!validateMethod('_agnes/v1/device.connection.get', 'result', result).ok) return refuse()
      const connection = result as unknown as Readonly<DeviceConnectionResult>
      const after = project(await read(sessionKey, signal))
      assertLive()
      signal.throwIfAborted()
      if (
        !after?.active ||
        after.deviceId !== before.deviceId ||
        after.workspaceId !== before.workspaceId ||
        after.bindingRevision !== before.bindingRevision ||
        connection.deviceId !== after.deviceId ||
        connection.bindingRevision !== after.bindingRevision
      )
        return refuse()
      return connection
    },
    ...(retained
      ? {
          retain: () => retain(),
          retainRecognition: async () => {
            const lease = await retain('recognition')
            if (!lease.recognition) {
              lease.release()
              return refuse()
            }
            return Object.freeze({ ...lease, recognition: lease.recognition })
          },
        }
      : {}),
    binding: async () => {
      assertLive()
      signal.throwIfAborted()
      if (!sessionKey) return refuse()
      const raw = await read(sessionKey, signal)
      assertLive()
      signal.throwIfAborted()
      return project(raw)
    },
  })
}
