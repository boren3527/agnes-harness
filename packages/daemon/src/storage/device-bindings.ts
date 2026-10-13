import {
  type DeviceConnectionProfile,
  type DeviceConnectionResult,
  type DeviceConnectionSaveParams,
  validateMethod,
} from '@agnes/protocol'
import { DeviceCaptureRecords } from './device-captures.js'
import { DeviceDetectionResults } from './device-detection-results.js'
import { DeviceRecognitionProfiles } from './device-recognition.js'
import { DeviceRecognitionBudget } from './device-recognition-budget.js'
import { ensure, type TableHandle } from './table.js'
import { assertWorkspaceBindingEnvelope, type WorkspaceBindingEnvelope } from './workspaces.js'

/** Device associations do not change canonical workspace identity or ordinary session history. */
export interface WorkspaceDeviceBinding {
  readonly workspaceId: string
  readonly deviceId: string
  readonly revision: number
  readonly active: boolean
}

export interface SessionDeviceBinding {
  readonly sessionKey: string
  readonly workspaceId: string
  readonly deviceId: string
  readonly bindingRevision: number
}

export class DeviceBindingConflict extends Error {
  constructor(
    readonly reason: 'revision' | 'device-in-use' | 'session-bound' | 'inactive' | 'endpoint-in-use',
  ) {
    super(`Device binding conflict: ${reason}`)
    this.name = 'DeviceBindingConflict'
  }
}

type WorkspaceRow = { workspace_id: string; device_id: string; revision: number; active: number }
type SessionRow = {
  session_key: string
  workspace_id: string
  device_id: string
  binding_revision: number
}

/** Storage seam only: callers must retire runtime tasks and stop the car before detach.
 * Every write needs a daemon-issued workspace authority, never a workspaceId from service JSON.
 * Request entry points must separately authorize a live session and freshly restore its workspace;
 * an issued envelope is not a principal grant and must not be retained across asynchronous work.
 */
export class DeviceBindingIndex {
  readonly captures: DeviceCaptureRecords
  readonly detectionResults: DeviceDetectionResults
  readonly recognition: DeviceRecognitionProfiles
  readonly recognitionBudget: DeviceRecognitionBudget
  constructor(
    private readonly table: TableHandle,
    private readonly changed?: (binding: Readonly<WorkspaceDeviceBinding>) => void,
    private readonly connectionChanged?: (connection: Readonly<DeviceConnectionResult>) => void,
    recognitionChanged?: (recognition: Readonly<import('@agnes/protocol').DeviceRecognitionResult>) => void,
  ) {
    this.captures = new DeviceCaptureRecords(table)
    this.detectionResults = new DeviceDetectionResults(table, this.captures)
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_workspace_bindings (
        workspace_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        active INTEGER NOT NULL CHECK(active IN (0, 1))
      )`,
    )
    table.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS device_active_workspace ON device_workspace_bindings(device_id) WHERE active = 1',
    )
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_session_bindings (
        session_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL CHECK(binding_revision > 0)
      )`,
    )
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_connection_profiles (
      device_id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL CHECK(port > 0 AND port <= 65535),
      mac_address TEXT NOT NULL,
      config_revision INTEGER NOT NULL CHECK(config_revision > 0)
    )`,
    )
    this.recognition = new DeviceRecognitionProfiles(
      table,
      (authority) => this.resolve(authority),
      recognitionChanged,
    )
    this.recognitionBudget = new DeviceRecognitionBudget(table, (authority) =>
      this.recognition.read(authority),
    )
  }

  /** Owner-confirmed endpoint metadata only. Saving never probes a device or authorizes IO. */
  connection(authority: WorkspaceBindingEnvelope): DeviceConnectionResult {
    const binding = this.resolve(authority)
    const row = this.table.get<{ ip: string; port: number; mac_address: string; config_revision: number }>(
      'SELECT ip, port, mac_address, config_revision FROM device_connection_profiles WHERE device_id = ?',
      [binding.deviceId],
    )
    const profile: DeviceConnectionProfile | null = row
      ? {
          driver: 'aka-00',
          ip: row.ip,
          port: row.port,
          macAddress: row.mac_address,
          configRevision: row.config_revision,
        }
      : null
    const result = { deviceId: binding.deviceId, bindingRevision: binding.bindingRevision, profile }
    if (!validateMethod('_agnes/v1/device.connection.get', 'result', result).ok)
      throw new TypeError('Invalid stored device connection profile')
    return result
  }

  saveConnection(
    authority: WorkspaceBindingEnvelope,
    input: DeviceConnectionSaveParams,
  ): DeviceConnectionResult {
    assertWorkspaceBindingEnvelope(authority)
    if (
      !validateMethod('_agnes/v1/device.connection.save', 'params', input).ok ||
      input.sessionId !== authority.sessionKey
    )
      throw new TypeError('Invalid device connection configuration')
    let changed = false
    const result = this.table.transaction(() => {
      const current = this.connection(authority)
      if (current.bindingRevision !== input.expectedBindingRevision)
        throw new DeviceBindingConflict('revision')
      const before = current.profile
      const same =
        before?.ip === input.ip &&
        before.port === input.port &&
        before.macAddress === input.macAddress.toLowerCase()
      if ((before?.configRevision ?? 0) !== input.expectedConfigRevision) {
        if (same && before?.configRevision === input.expectedConfigRevision + 1) return current
        throw new DeviceBindingConflict('revision')
      }
      if (same) return current
      const occupied = this.table.get<{ mac_address: string }>(
        `SELECT p.mac_address FROM device_connection_profiles p
         JOIN device_workspace_bindings w ON w.device_id = p.device_id
         WHERE w.active = 1 AND ((p.ip = ? AND p.port = ?) OR p.mac_address = ?) AND p.device_id <> ? LIMIT 1`,
        [input.ip, input.port, input.macAddress.toLowerCase(), current.deviceId],
      )
      if (occupied)
        throw new DeviceBindingConflict(
          occupied.mac_address === input.macAddress.toLowerCase() ? 'device-in-use' : 'endpoint-in-use',
        )
      this.table.exec(
        `INSERT INTO device_connection_profiles(device_id, ip, port, mac_address, config_revision)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET
         ip = excluded.ip, port = excluded.port, mac_address = excluded.mac_address,
         config_revision = excluded.config_revision`,
        [
          current.deviceId,
          input.ip,
          input.port,
          input.macAddress.toLowerCase(),
          input.expectedConfigRevision + 1,
        ],
      )
      changed = true
      return this.connection(authority)
    })
    if (changed)
      this.connectionChanged?.(
        Object.freeze({ ...result, profile: result.profile ? Object.freeze({ ...result.profile }) : null }),
      )
    return result
  }

  workspace(workspaceId: string): WorkspaceDeviceBinding | undefined {
    const row = this.table.get<WorkspaceRow>(
      'SELECT workspace_id, device_id, revision, active FROM device_workspace_bindings WHERE workspace_id = ?',
      [workspaceId],
    )
    return row
      ? {
          workspaceId: row.workspace_id,
          deviceId: row.device_id,
          revision: row.revision,
          active: row.active === 1,
        }
      : undefined
  }

  activeWorkspaces(): WorkspaceDeviceBinding[] {
    return this.table
      .all<WorkspaceRow>(
        'SELECT workspace_id, device_id, revision, active FROM device_workspace_bindings WHERE active = 1 ORDER BY workspace_id LIMIT 10001',
      )
      .map((row) => ({
        workspaceId: row.workspace_id,
        deviceId: row.device_id,
        revision: row.revision,
        active: true,
      }))
  }

  session(sessionKey: string): SessionDeviceBinding | undefined {
    const row = this.table.get<SessionRow>(
      'SELECT session_key, workspace_id, device_id, binding_revision FROM device_session_bindings WHERE session_key = ?',
      [sessionKey],
    )
    return row
      ? {
          sessionKey: row.session_key,
          workspaceId: row.workspace_id,
          deviceId: row.device_id,
          bindingRevision: row.binding_revision,
        }
      : undefined
  }

  /** Creates/reattaches an association and explicitly enrolls this real session atomically.
   * A repeated enrollment is idempotent. Only an owner-checked explicit bind may renew an old enrollment.
   * Replacement starts a fresh device after detach; other histories and old profiles stay unchanged.
   */
  attach(
    authority: WorkspaceBindingEnvelope,
    deviceId: string,
    expectedRevision: number,
    renew = false,
    replaceInactiveDevice = false,
  ): SessionDeviceBinding {
    assertWorkspaceBindingEnvelope(authority)
    if (
      typeof deviceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)
    )
      throw new TypeError('deviceId must be a stable UUID v4, not an IP address')
    deviceId = deviceId.toLowerCase()
    this.checkRevision(expectedRevision)
    const before = this.workspace(authority.workspaceId)
    const result = this.table.transaction(() => {
      const current = this.workspace(authority.workspaceId)
      const existing = this.session(authority.sessionKey)
      const replacing =
        replaceInactiveDevice &&
        renew &&
        current?.active === false &&
        existing?.workspaceId === authority.workspaceId &&
        existing.deviceId === current.deviceId &&
        existing.bindingRevision === current.revision - 1 &&
        deviceId !== current.deviceId
      if (existing) {
        if (
          existing.workspaceId === authority.workspaceId &&
          existing.deviceId === deviceId &&
          current?.active &&
          current.deviceId === deviceId &&
          current.revision === existing.bindingRevision &&
          (expectedRevision === current.revision || expectedRevision === current.revision - 1)
        )
          return existing
        if (
          !replacing &&
          (!renew ||
            existing.workspaceId !== authority.workspaceId ||
            existing.deviceId !== deviceId ||
            current?.deviceId !== deviceId)
        )
          throw new DeviceBindingConflict('session-bound')
      }
      if (replaceInactiveDevice && !replacing) throw new DeviceBindingConflict('inactive')
      if ((current?.revision ?? 0) !== expectedRevision) throw new DeviceBindingConflict('revision')
      if (current?.active && current.deviceId !== deviceId) throw new DeviceBindingConflict('device-in-use')
      const owner = this.table.get<{ workspace_id: string }>(
        'SELECT workspace_id FROM device_workspace_bindings WHERE device_id = ? AND active = 1',
        [deviceId],
      )
      if (owner && owner.workspace_id !== authority.workspaceId)
        throw new DeviceBindingConflict('device-in-use')
      const configuredOwner = this.table.get<{ device_id: string }>(
        `SELECT w.device_id FROM device_connection_profiles saved
         JOIN device_connection_profiles other ON other.device_id <> saved.device_id
          AND ((other.ip = saved.ip AND other.port = saved.port) OR other.mac_address = saved.mac_address)
         JOIN device_workspace_bindings w ON w.device_id = other.device_id AND w.active = 1
         WHERE saved.device_id = ? LIMIT 1`,
        [deviceId],
      )
      if (configuredOwner) throw new DeviceBindingConflict('device-in-use')
      const revision = current?.active ? current.revision : expectedRevision + 1
      if (!Number.isSafeInteger(revision)) throw new DeviceBindingConflict('revision')
      this.table.exec(
        `INSERT INTO device_workspace_bindings(workspace_id, device_id, revision, active)
         VALUES (?, ?, ?, 1) ON CONFLICT(workspace_id)
         DO UPDATE SET device_id = excluded.device_id, revision = excluded.revision, active = 1`,
        [authority.workspaceId, deviceId, revision],
      )
      this.table.exec(
        `INSERT INTO device_session_bindings(session_key, workspace_id, device_id, binding_revision) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET device_id = excluded.device_id,
         binding_revision = excluded.binding_revision`,
        [authority.sessionKey, authority.workspaceId, deviceId, revision],
      )
      const persisted = this.session(authority.sessionKey)
      if (!persisted) throw new Error('device session binding was not persisted')
      return persisted
    })
    const after = this.workspace(authority.workspaceId)
    if (
      after &&
      (!before ||
        before.revision !== after.revision ||
        before.active !== after.active ||
        before.deviceId !== after.deviceId)
    )
      this.changed?.(Object.freeze({ ...after }))
    return result
  }

  /** Fail closed for ordinary, detached, replaced, or cross-workspace sessions. */
  resolve(authority: WorkspaceBindingEnvelope): SessionDeviceBinding {
    assertWorkspaceBindingEnvelope(authority)
    const session = this.session(authority.sessionKey)
    const workspace = this.workspace(authority.workspaceId)
    if (
      !session ||
      session.workspaceId !== authority.workspaceId ||
      !workspace?.active ||
      session.deviceId !== workspace.deviceId ||
      session.bindingRevision !== workspace.revision
    )
      throw new DeviceBindingConflict('inactive')
    return session
  }

  detach(authority: WorkspaceBindingEnvelope, expectedRevision: number): WorkspaceDeviceBinding {
    assertWorkspaceBindingEnvelope(authority)
    this.checkRevision(expectedRevision)
    const before = this.workspace(authority.workspaceId)
    const result = this.table.transaction(() => {
      const current = this.workspace(authority.workspaceId)
      if (!current || current.revision !== expectedRevision) throw new DeviceBindingConflict('revision')
      if (!current.active) return current
      // A historical session cannot detach a replacement device in the same workspace.
      this.resolve(authority)
      if (!Number.isSafeInteger(current.revision + 1)) throw new DeviceBindingConflict('revision')
      this.table.exec(
        'UPDATE device_workspace_bindings SET active = 0, revision = revision + 1 WHERE workspace_id = ?',
        [authority.workspaceId],
      )
      const persisted = this.workspace(authority.workspaceId)
      if (!persisted) throw new Error('device workspace binding was not persisted')
      return persisted
    })
    if (before?.revision !== result.revision || before.active !== result.active)
      this.changed?.(Object.freeze({ ...result }))
    return result
  }

  private checkRevision(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid device binding revision')
  }
}
