import { DeviceBindingConflict } from './device-bindings.js'
import type { DeviceRecognitionSnapshot } from './device-recognition.js'
import { ensure, type TableHandle } from './table.js'
import type { WorkspaceBindingEnvelope } from './workspaces.js'

type Round = Readonly<{ deviceId: string; roundRevision: number; budget: number; reserved: number }>
type Row = { round_revision: number; budget: number; reserved: number; start_id: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const invalid = (): never => {
  throw new TypeError('Invalid device recognition budget')
}
function revision(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) invalid()
}
/** Owner-confined durable reservations, not cloud billing or dispatch evidence.
 * The caller separately admits an explicit start, drains in-flight requests, and authorizes IO.
 * No automatic reset on configuration change/reconnect/restart; no refund of uncertain reservations.
 */
export class DeviceRecognitionBudget {
  constructor(
    private readonly table: TableHandle,
    private readonly configuration: (authority: WorkspaceBindingEnvelope) => DeviceRecognitionSnapshot,
  ) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_recognition_rounds (
      device_id TEXT PRIMARY KEY, round_revision INTEGER NOT NULL CHECK(round_revision > 0),
      budget INTEGER NOT NULL CHECK(budget > 0), reserved INTEGER NOT NULL CHECK(reserved >= 0),
      start_id TEXT NOT NULL)`,
    )
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_recognition_reservations (
      device_id TEXT NOT NULL, round_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL,
      PRIMARY KEY(device_id, round_revision, attempt_id))`,
    )
  }
  private stored(deviceId: string): Row | undefined {
    const row = this.table.get<Row>(
      'SELECT round_revision, budget, reserved, start_id FROM device_recognition_rounds WHERE device_id = ?',
      [deviceId],
    )
    if (!row) return undefined
    revision(row.round_revision, 1)
    revision(row.budget, 1)
    revision(row.reserved)
    if (row.budget > 100000 || row.reserved > row.budget || !uuid.test(row.start_id)) invalid()
    const count = this.table.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM device_recognition_reservations WHERE device_id = ? AND round_revision = ?',
      [deviceId, row.round_revision],
    )?.n
    if (count !== row.reserved) invalid()
    return row
  }
  private view(deviceId: string, row: Row): Round {
    return Object.freeze({
      deviceId,
      roundRevision: row.round_revision,
      budget: row.budget,
      reserved: row.reserved,
    })
  }
  read(authority: WorkspaceBindingEnvelope): Round | null {
    const current = this.configuration(authority)
    const row = this.stored(current.deviceId)
    return row ? this.view(current.deviceId, row) : null
  }
  start(
    authority: WorkspaceBindingEnvelope,
    input: Readonly<{
      expectedBindingRevision: number
      expectedConfigRevision: number
      expectedRoundRevision: number
      startId: string
    }>,
  ): Round {
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,startId' ||
      typeof input.startId !== 'string' ||
      !uuid.test(input.startId)
    )
      invalid()
    revision(input.expectedRoundRevision)
    revision(input.expectedBindingRevision, 1)
    revision(input.expectedConfigRevision, 1)
    return this.table.transaction(() => {
      const current = this.configuration(authority)
      if (
        !current.settings ||
        current.bindingRevision !== input.expectedBindingRevision ||
        current.configRevision !== input.expectedConfigRevision
      )
        throw new DeviceBindingConflict('revision')
      const before = this.stored(current.deviceId)
      if (before?.start_id === input.startId) {
        if (before.round_revision !== input.expectedRoundRevision + 1)
          throw new DeviceBindingConflict('revision')
        return this.view(current.deviceId, before)
      }
      if (
        (before?.round_revision ?? 0) !== input.expectedRoundRevision ||
        !Number.isSafeInteger(input.expectedRoundRevision + 1)
      )
        throw new DeviceBindingConflict('revision')
      this.table.exec('DELETE FROM device_recognition_reservations WHERE device_id = ?', [current.deviceId])
      this.table.exec(
        `INSERT INTO device_recognition_rounds(device_id, round_revision, budget, reserved, start_id) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(device_id) DO UPDATE SET round_revision = excluded.round_revision, budget = excluded.budget, reserved = 0, start_id = excluded.start_id`,
        [current.deviceId, input.expectedRoundRevision + 1, current.settings.requestBudget, input.startId],
      )
      const row = this.stored(current.deviceId)
      if (!row) return invalid()
      return this.view(current.deviceId, row)
    })
  }
  reserve(
    authority: WorkspaceBindingEnvelope,
    input: Readonly<{
      expectedBindingRevision: number
      expectedConfigRevision: number
      expectedRoundRevision: number
      attemptId: string
    }>,
  ): Readonly<{ granted: boolean; round: Round }> {
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'attemptId,expectedBindingRevision,expectedConfigRevision,expectedRoundRevision' ||
      typeof input.attemptId !== 'string' ||
      !uuid.test(input.attemptId)
    )
      invalid()
    revision(input.expectedBindingRevision, 1)
    revision(input.expectedConfigRevision, 1)
    revision(input.expectedRoundRevision, 1)
    return this.table.transaction(() => {
      const current = this.configuration(authority)
      const before = this.stored(current.deviceId)
      if (
        !current.settings ||
        !before ||
        current.bindingRevision !== input.expectedBindingRevision ||
        current.configRevision !== input.expectedConfigRevision ||
        before.round_revision !== input.expectedRoundRevision
      )
        throw new DeviceBindingConflict('revision')
      const duplicate = this.table.get(
        'SELECT 1 FROM device_recognition_reservations WHERE device_id = ? AND round_revision = ? AND attempt_id = ?',
        [current.deviceId, before.round_revision, input.attemptId],
      )
      if (duplicate || before.reserved >= Math.min(before.budget, current.settings.requestBudget))
        return Object.freeze({ granted: false, round: this.view(current.deviceId, before) })
      this.table.exec(
        'INSERT INTO device_recognition_reservations(device_id, round_revision, attempt_id) VALUES (?, ?, ?)',
        [current.deviceId, before.round_revision, input.attemptId],
      )
      this.table.exec('UPDATE device_recognition_rounds SET reserved = reserved + 1 WHERE device_id = ?', [
        current.deviceId,
      ])
      const after = this.stored(current.deviceId)
      if (!after) return invalid()
      return Object.freeze({ granted: true, round: this.view(current.deviceId, after) })
    })
  }
}
