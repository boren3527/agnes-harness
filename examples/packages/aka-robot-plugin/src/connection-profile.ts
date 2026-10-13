import type { DeviceSessionPort } from '@agnes/extension-api'
import { AkaProtocolError } from './protocol.js'
import type { RuntimeRegistration } from './runtime.js'

type Binding = NonNullable<Awaited<ReturnType<DeviceSessionPort['binding']>>>
type Connection = Awaited<ReturnType<NonNullable<DeviceSessionPort['connection']>>>

export function sameRegistration(a: RuntimeRegistration, b: RuntimeRegistration): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.ip === b.ip &&
    a.port === b.port &&
    a.macAddress === b.macAddress &&
    a.configRevision === b.configRevision
  )
}

/** Host validates the profile schema; the plugin additionally pins its invocation identity. */
export function registrationFromConnection(
  binding: Binding,
  connection: Readonly<Connection>,
): Readonly<RuntimeRegistration> | undefined {
  if (connection.deviceId !== binding.deviceId || connection.bindingRevision !== binding.bindingRevision)
    throw new AkaProtocolError('Device configuration identity changed')
  if (!connection.profile) return undefined
  if (connection.profile.driver !== 'aka-00') throw new AkaProtocolError('Unsupported device driver')
  const { ip, port, macAddress, configRevision } = connection.profile
  return Object.freeze({ deviceId: binding.deviceId.toLowerCase(), ip, port, macAddress, configRevision })
}

/** No fallback on missing/error persisted profiles. Row config is for older hosts only. */
export async function readRegistration(
  device: Readonly<DeviceSessionPort>,
  binding: Binding,
  legacy: ReadonlyMap<string, RuntimeRegistration>,
): Promise<Readonly<RuntimeRegistration> | undefined> {
  if (device.connection) return registrationFromConnection(binding, await device.connection())
  return legacy.get(binding.deviceId.toLowerCase())
}
