import { randomUUID } from 'node:crypto'
import {
  type DeviceCaptureRecord as CaptureRecord,
  type DeviceCaptureSelection as CaptureSelection,
  inspectJsonData,
  readDeviceCaptureSelection,
} from '@agnes/protocol'
import { ensure, type TableHandle } from './table.js'

/** Internal persistence only. The caller must separately authorize the live owner/session/effect.
 * Does not mint artifact-read authority, write blobs or fabricate a model tool result. */
export type CaptureScope = Readonly<{ principalId: string; sessionId: string; commandId: string }>
export type {
  DeviceCaptureRecord as CaptureRecord,
  DeviceCaptureSelection as CaptureSelection,
} from '@agnes/protocol'

type Row = { selection: string; stage: string; event_seq: number | null }
const refuse = (): never => {
  throw new Error('device capture record unavailable')
}
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
const text = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 512 &&
  ![...v].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
function object(value: unknown, keys: string): Record<string, unknown> {
  const checked = inspectJsonData(value, 4096)
  if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
    return refuse()
  const row = checked.value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== keys) return refuse()
  return row
}
function scope(value: CaptureScope): readonly string[] {
  const v = object(value, 'commandId,principalId,sessionId')
  if (!text(v.principalId) || !text(v.sessionId) || !text(v.commandId)) return refuse()
  return [v.principalId as string, v.sessionId as string, v.commandId as string]
}
function selection(value: unknown): CaptureSelection {
  return readDeviceCaptureSelection(value) ?? refuse()
}

export class DeviceCaptureRecords {
  constructor(private readonly table: TableHandle) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_capture_records (
      principal_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
      selection TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('selected','stored','recorded')),
      event_seq INTEGER, PRIMARY KEY(principal_id, session_id, command_id),
      CHECK((stage = 'recorded' AND event_seq IS NOT NULL AND event_seq > 0) OR (stage != 'recorded' AND event_seq IS NULL)))`,
    )
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_capture_publications (
      principal_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
      capture_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(principal_id, session_id, command_id))`,
    )
  }
  /** Trusted producer correlation, never a worker-selected identity or a publication receipt. */
  publicationId(identity: CaptureScope): string | null {
    const key = scope(identity)
    const row = this.table.get<{ capture_id: unknown }>(
      `SELECT capture_id FROM device_capture_publications
      WHERE principal_id = ? AND session_id = ? AND command_id = ?`,
      [...key],
    )
    if (!row) return null
    const record = this.read(identity)
    if (
      !record ||
      record.stage === 'selected' ||
      typeof row.capture_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.capture_id)
    )
      return refuse()
    return row.capture_id
  }
  private ensurePublication(identity: CaptureScope): void {
    if (this.publicationId(identity)) return
    // A legacy recorded event cannot be assigned a new identity: that could duplicate publication.
    if (this.read(identity)?.stage !== 'stored') refuse()
    this.table.exec(
      `INSERT INTO device_capture_publications
      (principal_id, session_id, command_id, capture_id) VALUES (?, ?, ?, ?)`,
      [...scope(identity), randomUUID()],
    )
    if (!this.publicationId(identity)) refuse()
  }
  read(identity: CaptureScope): CaptureRecord | null {
    const row = this.table.get<Row>(
      `SELECT selection, stage, event_seq FROM device_capture_records
      WHERE principal_id = ? AND session_id = ? AND command_id = ?`,
      [...scope(identity)],
    )
    if (!row) return null
    try {
      const selected = selection(JSON.parse(row.selection))
      if (
        !['selected', 'stored', 'recorded'].includes(row.stage) ||
        (row.stage === 'recorded' ? !positive(row.event_seq) : row.event_seq !== null)
      )
        return refuse()
      return Object.freeze({
        selection: selected,
        stage: row.stage as CaptureRecord['stage'],
        eventSeq: row.event_seq,
      })
    } catch {
      return refuse()
    }
  }
  /** Records the exact selection BEFORE any blob write. Existing selection is never replaced. */
  select(
    identity: CaptureScope,
    candidate: CaptureSelection,
  ): Readonly<{ fresh: boolean; record: CaptureRecord }> {
    const key = scope(identity),
      selected = selection(candidate)
    return this.table.transaction(() => {
      const before = this.read(identity)
      if (before) {
        if (JSON.stringify(before.selection) !== JSON.stringify(selected)) return refuse()
        return Object.freeze({ fresh: false, record: before })
      }
      this.table.exec(
        `INSERT INTO device_capture_records
        (principal_id, session_id, command_id, selection, stage, event_seq) VALUES (?, ?, ?, ?, 'selected', NULL)`,
        [...key, JSON.stringify(selected)],
      )
      const record = this.read(identity)
      if (!record) return refuse()
      return Object.freeze({ fresh: true, record })
    })
  }
  /** Caller must verify persisted blob bytes against this ref before acknowledging storage. */
  stored(identity: CaptureScope, artifact: CaptureSelection['artifact']): CaptureRecord {
    const ref = object(artifact, 'mime,sha256,size')
    return this.table.transaction(() => {
      const before = this.read(identity)
      if (
        !before ||
        ref.sha256 !== before.selection.artifact.sha256 ||
        ref.size !== before.selection.artifact.size ||
        ref.mime !== before.selection.artifact.mime
      )
        return refuse()
      if (before.stage !== 'selected') {
        this.ensurePublication(identity)
        return before
      }
      this.table.exec(
        `UPDATE device_capture_records SET stage = 'stored'
        WHERE principal_id = ? AND session_id = ? AND command_id = ? AND stage = 'selected'`,
        [...scope(identity)],
      )
      this.ensurePublication(identity)
      return this.read(identity) ?? refuse()
    })
  }
  /** Only after a real durable session event and artifact-read ownership have been established. */
  recorded(identity: CaptureScope, eventSeq: number): CaptureRecord {
    if (!positive(eventSeq)) return refuse()
    return this.table.transaction(() => {
      const before = this.read(identity)
      if (
        !before ||
        before.stage === 'selected' ||
        (before.stage === 'recorded' && before.eventSeq !== eventSeq)
      )
        return refuse()
      if (!this.publicationId(identity)) return refuse()
      if (before.stage === 'recorded') return before
      this.table.exec(
        `UPDATE device_capture_records SET stage = 'recorded', event_seq = ?
        WHERE principal_id = ? AND session_id = ? AND command_id = ? AND stage = 'stored'`,
        [eventSeq, ...scope(identity)],
      )
      return this.read(identity) ?? refuse()
    })
  }
}
