import { randomUUID } from 'node:crypto'
import type { CredentialStore } from './adapters/credential-store.js'

type Store = Pick<CredentialStore, 'enforcement' | 'putApiKey' | 'read' | 'remove'>
export type DeviceRecognitionCredential = Readonly<{ accessKeyId: string; accessKeySecret: string }>
export class DeviceRecognitionCredentialError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'cancelled' | 'storage' | 'cleanup') {
    super('Device recognition credential operation failed')
    this.name = 'DeviceRecognitionCredentialError'
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function device(value: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new DeviceRecognitionCredentialError('invalid')
  return value
}
function credential(value: unknown): DeviceRecognitionCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DeviceRecognitionCredentialError('invalid')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'accessKeyId,accessKeySecret' ||
    ![record.accessKeyId, record.accessKeySecret].every(
      (item) => typeof item === 'string' && /^[!-~]{1,256}$/.test(item),
    )
  )
    throw new DeviceRecognitionCredentialError('invalid')
  return Object.freeze({
    accessKeyId: record.accessKeyId as string,
    accessKeySecret: record.accessKeySecret as string,
  })
}
function check(store: Store, signal: AbortSignal): void {
  if (signal.aborted) throw new DeviceRecognitionCredentialError('cancelled')
  if (store.enforcement.level !== 'full') throw new DeviceRecognitionCredentialError('unavailable')
}
function reference(deviceId: string, ref: string, local = false): void {
  const prefix = `secret://aka-robot/${local ? 'local-' : ''}device-${device(deviceId)}-`
  if (typeof ref !== 'string' || !ref.startsWith(prefix) || !uuid.test(ref.slice(prefix.length)))
    throw new DeviceRecognitionCredentialError('invalid')
}

/** Trusted owner composition only. Admission and config CAS belong to the caller, not this store.
 * A fresh ref makes both AK halves one atomic record; never overwrites a published credential.
 */
export async function stageDeviceRecognitionCredential(
  store: Store,
  deviceId: string,
  value: unknown,
  signal: AbortSignal,
): Promise<string> {
  check(store, signal)
  const id = device(deviceId)
  const pair = credential(value)
  return stage(store, id, pair, false, signal)
}

async function stage(
  store: Store,
  id: string,
  value: object,
  local: boolean,
  signal: AbortSignal,
): Promise<string> {
  const ref = `secret://aka-robot/${local ? 'local-' : ''}device-${id}-${randomUUID()}`
  try {
    await store.putApiKey(ref, JSON.stringify({ version: 1, deviceId: id, ...value }))
    check(store, signal)
    return ref
  } catch {
    // A write can fail after rename: remove only this attempt's fresh unpublished reference.
    try {
      await store.remove(ref)
    } catch {
      throw new DeviceRecognitionCredentialError('cleanup')
    }
    throw new DeviceRecognitionCredentialError(signal.aborted ? 'cancelled' : 'storage')
  }
}

export async function stageDeviceRecognitionToken(
  store: Store,
  deviceId: string,
  token: unknown,
  signal: AbortSignal,
): Promise<string> {
  check(store, signal)
  if (typeof token !== 'string' || !/^[!-~]{1,4096}$/.test(token))
    throw new DeviceRecognitionCredentialError('invalid')
  return stage(store, device(deviceId), { token }, true, signal)
}

export async function readDeviceRecognitionToken(
  store: Store,
  deviceId: string,
  ref: string,
  signal: AbortSignal,
): Promise<string> {
  check(store, signal)
  reference(deviceId, ref, true)
  let stored: Awaited<ReturnType<Store['read']>>
  try {
    stored = await store.read(ref)
  } catch {
    throw new DeviceRecognitionCredentialError('storage')
  }
  check(store, signal)
  if (stored?.kind !== 'api-key' || stored.provider !== 'aka-robot' || stored.value.length > 20000)
    throw new DeviceRecognitionCredentialError('invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(stored.value)
  } catch {
    throw new DeviceRecognitionCredentialError('invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new DeviceRecognitionCredentialError('invalid')
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'deviceId,token,version' ||
    value.deviceId !== deviceId ||
    value.version !== 1 ||
    typeof value.token !== 'string' ||
    !/^[!-~]{1,4096}$/.test(value.token)
  )
    throw new DeviceRecognitionCredentialError('invalid')
  return value.token
}

/** Resolve only the current owner-checked configuration's ref. Never return this to a client/model. */
export async function readDeviceRecognitionCredential(
  store: Store,
  deviceId: string,
  ref: string,
  signal: AbortSignal,
): Promise<DeviceRecognitionCredential> {
  check(store, signal)
  reference(deviceId, ref)
  let stored: Awaited<ReturnType<Store['read']>>
  try {
    stored = await store.read(ref)
  } catch {
    throw new DeviceRecognitionCredentialError('storage')
  }
  check(store, signal)
  if (stored?.kind !== 'api-key' || stored.provider !== 'aka-robot' || stored.value.length > 2048)
    throw new DeviceRecognitionCredentialError('invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(stored.value)
  } catch {
    throw new DeviceRecognitionCredentialError('invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new DeviceRecognitionCredentialError('invalid')
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'accessKeyId,accessKeySecret,deviceId,version' ||
    record.version !== 1 ||
    record.deviceId !== deviceId
  )
    throw new DeviceRecognitionCredentialError('invalid')
  return credential({ accessKeyId: record.accessKeyId, accessKeySecret: record.accessKeySecret })
}

/** Only for an unpublished staged ref after failed configuration CAS; not a public deletion API. */
export async function discardDeviceRecognitionCredential(
  store: Store,
  deviceId: string,
  ref: string,
): Promise<void> {
  reference(deviceId, ref, typeof ref === 'string' && ref.startsWith('secret://aka-robot/local-device-'))
  if (store.enforcement.level !== 'full') throw new DeviceRecognitionCredentialError('unavailable')
  try {
    await store.remove(ref)
  } catch {
    throw new DeviceRecognitionCredentialError('cleanup')
  }
}
