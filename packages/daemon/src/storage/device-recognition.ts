import type { DeviceRecognitionResult } from '@agnes/protocol'
import type { SessionDeviceBinding } from './device-bindings.js'
import { DeviceBindingConflict } from './device-bindings.js'
import { ensure, type TableHandle } from './table.js'
import type { WorkspaceBindingEnvelope } from './workspaces.js'

type Limits = Readonly<{ frequency: 0.5 | 1 | 2; requestBudget: number }>
export type DeviceRecognitionSettings =
  | (Limits & Readonly<{ provider: 'aliyun'; credentialRef: string }>)
  | (Limits & Readonly<{ provider: 'local-yolo'; baseUrl: string; credentialRef: string | null }>)
export type DeviceRecognitionSnapshot = Readonly<{
  deviceId: string
  bindingRevision: number
  configRevision: number
  settings: DeviceRecognitionSettings | null
}>
export type DeviceRecognitionView = Readonly<DeviceRecognitionResult>

function invalid(): never {
  throw new TypeError('Invalid device recognition configuration')
}
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
function secretRef(value: unknown, deviceId: string, local: boolean): string {
  if (!new RegExp(`^${uuid}$`).test(deviceId)) invalid()
  const prefix = `secret://aka-robot/${local ? 'local-' : ''}device-${deviceId}-`
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    !new RegExp(`^${uuid}$`).test(value.slice(prefix.length))
  )
    invalid()
  return value
}
export function deviceRecognitionLocalOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https?:\/\/(?:localhost|[0-9.]+)(?::[0-9]{1,5})?\/?$/.test(value)
  )
    invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  const host = value.match(/^https?:\/\/([^/:]+)/)?.[1]
  if (host !== url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    invalid()
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    const parts = url.hostname.split('.').map(Number)
    if (
      parts.length !== 4 ||
      !parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
      !(
        parts[0] === 10 ||
        (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
      )
    )
      invalid()
  }
  if (url.port === '0') invalid()
  return url.toString()
}
function settings(value: unknown, deviceId: string): DeviceRecognitionSettings | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (
    ![0.5, 1, 2].includes(record.frequency as number) ||
    !Number.isSafeInteger(record.requestBudget) ||
    (record.requestBudget as number) < 1 ||
    (record.requestBudget as number) > 100000
  )
    invalid()
  const limits = {
    frequency: record.frequency as Limits['frequency'],
    requestBudget: record.requestBudget as number,
  }
  if (
    record.provider === 'aliyun' &&
    Object.keys(record).sort().join(',') === 'credentialRef,frequency,provider,requestBudget'
  )
    return Object.freeze({
      provider: 'aliyun',
      ...limits,
      credentialRef: secretRef(record.credentialRef, deviceId, false),
    })
  if (
    record.provider === 'local-yolo' &&
    Object.keys(record).sort().join(',') === 'baseUrl,credentialRef,frequency,provider,requestBudget'
  )
    return Object.freeze({
      provider: 'local-yolo',
      ...limits,
      baseUrl: deviceRecognitionLocalOrigin(record.baseUrl),
      credentialRef: record.credentialRef === null ? null : secretRef(record.credentialRef, deviceId, true),
    })
  return invalid()
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
}

/** Trusted daemon storage. Request callers must separately check the current session owner.
 * Contains refs only, never credentials. No IO/probe/recognition on save or read.
 */
export class DeviceRecognitionProfiles {
  constructor(
    private readonly table: TableHandle,
    private readonly resolve: (authority: WorkspaceBindingEnvelope) => SessionDeviceBinding,
    private readonly changed?: (view: DeviceRecognitionView) => void,
  ) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_recognition_profiles (
      device_id TEXT PRIMARY KEY, config_revision INTEGER NOT NULL CHECK(config_revision > 0),
      settings_json TEXT NOT NULL
    )`,
    )
  }

  /** Trusted commit recovery only: a detached session must not hide a published credential.
   * Malformed persistence throws; callers must preserve an uncertain ref, not guess it is unused.
   */
  references(deviceId: string, ref: string): boolean {
    const row = this.table.get<{ settings_json: string }>(
      'SELECT settings_json FROM device_recognition_profiles WHERE device_id = ?',
      [deviceId],
    )
    if (!row) return false
    if (typeof row.settings_json !== 'string' || row.settings_json.length > 4096) invalid()
    let value: unknown
    try {
      value = JSON.parse(row.settings_json)
    } catch {
      return invalid()
    }
    return settings(value, deviceId)?.credentialRef === ref
  }

  read(authority: WorkspaceBindingEnvelope): DeviceRecognitionSnapshot {
    const binding = this.resolve(authority)
    const row = this.table.get<{ config_revision: number; settings_json: string }>(
      'SELECT config_revision, settings_json FROM device_recognition_profiles WHERE device_id = ?',
      [binding.deviceId],
    )
    let value: unknown = null
    if (row) {
      revision(row.config_revision)
      if (
        row.config_revision === 0 ||
        typeof row.settings_json !== 'string' ||
        row.settings_json.length > 4096
      )
        invalid()
      try {
        value = JSON.parse(row.settings_json)
      } catch {
        return invalid()
      }
    }
    return Object.freeze({
      deviceId: binding.deviceId,
      bindingRevision: binding.bindingRevision,
      configRevision: row?.config_revision ?? 0,
      settings: settings(value, binding.deviceId),
    })
  }

  /** Client projection only: configured is not authenticated, tested or running. */
  view(authority: WorkspaceBindingEnvelope): DeviceRecognitionView {
    const current = this.read(authority)
    const value = current.settings
    return Object.freeze({
      ...current,
      settings: value
        ? value.provider === 'aliyun'
          ? Object.freeze({
              provider: 'aliyun' as const,
              frequency: value.frequency,
              requestBudget: value.requestBudget,
              credentialConfigured: true as const,
            })
          : Object.freeze({
              provider: 'local-yolo' as const,
              frequency: value.frequency,
              requestBudget: value.requestBudget,
              credentialConfigured: value.credentialRef !== null,
              baseUrl: value.baseUrl,
            })
        : null,
    })
  }

  save(
    authority: WorkspaceBindingEnvelope,
    input: Readonly<{ expectedBindingRevision: number; expectedConfigRevision: number; settings: unknown }>,
  ): DeviceRecognitionSnapshot {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'expectedBindingRevision,expectedConfigRevision,settings'
    )
      invalid()
    revision(input.expectedBindingRevision)
    revision(input.expectedConfigRevision)
    let changed = false
    const result = this.table.transaction(() => {
      const current = this.read(authority)
      if (current.bindingRevision !== input.expectedBindingRevision)
        throw new DeviceBindingConflict('revision')
      const next = settings(input.settings, current.deviceId)
      const json = JSON.stringify(next)
      const same = json === JSON.stringify(current.settings)
      if (current.configRevision !== input.expectedConfigRevision) {
        if (same && current.configRevision === input.expectedConfigRevision + 1) return current
        throw new DeviceBindingConflict('revision')
      }
      if (same) return current
      if (!Number.isSafeInteger(current.configRevision + 1)) throw new DeviceBindingConflict('revision')
      this.table.exec(
        `INSERT INTO device_recognition_profiles(device_id, config_revision, settings_json)
        VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET
        config_revision = excluded.config_revision, settings_json = excluded.settings_json`,
        [current.deviceId, current.configRevision + 1, json],
      )
      changed = true
      return this.read(authority)
    })
    if (changed) this.changed?.(this.view(authority))
    return result
  }
}
