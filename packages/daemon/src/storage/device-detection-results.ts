import { inspectJsonData } from '@agnes/protocol'
import type { CaptureScope, DeviceCaptureRecords } from './device-captures.js'
import { ensure, type TableHandle } from './table.js'

export type DetectionReceipt = Readonly<{
  id: string
  deviceId: string
  bindingRevision: number
  configRevision: number
  roundRevision: number
  frameId: string
  width: number
  height: number
  sha256: string
  providerRequestId: string
  elapsedMs: number
  detections: readonly Readonly<{
    label: string
    confidence: number
    box: readonly [number, number, number, number]
  }>[]
}>
const refuse = (): never => {
  throw new Error('device detection result unavailable')
}
const text = (v: unknown, max: number) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  ![...v].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse()
  if (Object.keys(value).sort().join(',') !== keys) return refuse()
  return value as Record<string, unknown>
}
function key(identity: CaptureScope): string[] {
  const checked = inspectJsonData(identity, 4096)
  if (!checked.ok) return refuse()
  const v = object(checked.value, 'commandId,principalId,sessionId')
  if (![v.principalId, v.sessionId, v.commandId].every((v) => text(v, 512))) return refuse()
  return [v.principalId as string, v.sessionId as string, v.commandId as string]
}
function receipt(value: unknown): DetectionReceipt {
  const checked = inspectJsonData(value, 512 * 1024)
  if (!checked.ok) return refuse()
  const v = object(
    checked.value,
    'bindingRevision,configRevision,detections,deviceId,elapsedMs,frameId,height,id,providerRequestId,roundRevision,sha256,width',
  )
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  if (
    typeof v.id !== 'string' ||
    !uuid.test(v.id) ||
    typeof v.deviceId !== 'string' ||
    !uuid.test(v.deviceId) ||
    ![v.bindingRevision, v.configRevision, v.roundRevision, v.width, v.height].every(positive) ||
    (v.width as number) > 4096 ||
    (v.height as number) > 4096 ||
    !text(v.frameId, 512) ||
    !text(v.providerRequestId, 512) ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    typeof v.elapsedMs !== 'number' ||
    !Number.isFinite(v.elapsedMs) ||
    v.elapsedMs < 0 ||
    v.elapsedMs > 10000 ||
    !Array.isArray(v.detections) ||
    v.detections.length > 1000
  )
    return refuse()
  const detections = v.detections.map((value) => {
    const d = object(value, 'box,confidence,label')
    if (
      !text(d.label, 256) ||
      typeof d.confidence !== 'number' ||
      !Number.isFinite(d.confidence) ||
      d.confidence < 0 ||
      d.confidence > 1 ||
      !Array.isArray(d.box) ||
      d.box.length !== 4 ||
      d.box.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    )
      return refuse()
    const [x1, y1, x2, y2] = d.box as [number, number, number, number]
    if (x1 < 0 || y1 < 0 || x2 > (v.width as number) || y2 > (v.height as number) || x2 <= x1 || y2 <= y1)
      return refuse()
    return Object.freeze({
      label: d.label as string,
      confidence: d.confidence,
      box: Object.freeze([x1, y1, x2, y2] as [number, number, number, number]),
    })
  })
  return Object.freeze({
    id: v.id,
    deviceId: v.deviceId,
    bindingRevision: v.bindingRevision as number,
    configRevision: v.configRevision as number,
    roundRevision: v.roundRevision as number,
    frameId: v.frameId as string,
    width: v.width as number,
    height: v.height as number,
    sha256: v.sha256,
    providerRequestId: v.providerRequestId as string,
    elapsedMs: v.elapsedMs,
    detections: Object.freeze(detections),
  })
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return refuse()
  return value
}

/** Internal trusted-backend archive. No worker write RPC or artifact-read grant.
 * Results are immutable and require the original durable capture publication.
 */
export class DeviceDetectionResults {
  constructor(
    private readonly table: TableHandle,
    private readonly captures: DeviceCaptureRecords,
  ) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS device_detection_results (
      principal_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
      result TEXT NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY(principal_id, session_id, command_id))`,
    )
  }
  private matches(identity: CaptureScope, result: DetectionReceipt) {
    const capture = this.captures.read(identity)
    if (capture?.stage !== 'recorded' || !capture.eventSeq) return refuse()
    const s = capture.selection
    if (
      s.deviceId !== result.deviceId ||
      s.bindingRevision !== result.bindingRevision ||
      s.frameId !== result.frameId ||
      s.width !== result.width ||
      s.height !== result.height ||
      s.artifact.sha256 !== result.sha256
    )
      return refuse()
    return capture
  }
  read(identity: CaptureScope) {
    const row = this.table.get<{ result: string; completed_at: string }>(
      'SELECT result, completed_at FROM device_detection_results WHERE principal_id = ? AND session_id = ? AND command_id = ?',
      key(identity),
    )
    if (!row) return null
    try {
      if (typeof row.result !== 'string' || Buffer.byteLength(row.result, 'utf8') > 512 * 1024)
        return refuse()
      const result = receipt(JSON.parse(row.result))
      const capture = this.matches(identity, result)
      return Object.freeze({ capture, result, completedAt: timestamp(row.completed_at) })
    } catch {
      return refuse()
    }
  }
  /** Every successful detector invocation has one daemon-generated receipt ID. */
  completedInRound(deviceId: string, roundRevision: number): number {
    if (!text(deviceId, 512) || !positive(roundRevision)) return refuse()
    const row = this.table.get<{ n: number }>(
      "SELECT COUNT(DISTINCT json_extract(result, '$.id')) AS n FROM device_detection_results WHERE json_extract(result, '$.deviceId') = ? AND json_extract(result, '$.roundRevision') = ?",
      [deviceId, roundRevision],
    )
    if (!row || !Number.isSafeInteger(row.n) || row.n < 0) return refuse()
    return row.n
  }
  save(identity: CaptureScope, value: DetectionReceipt, completedAt: string) {
    const scopeKey = key(identity),
      result = receipt(value),
      at = timestamp(completedAt)
    return this.table.transaction(() => {
      this.matches(identity, result)
      const before = this.read(identity)
      if (before) {
        if (JSON.stringify(before.result) !== JSON.stringify(result) || before.completedAt !== at)
          return refuse()
        return before
      }
      this.table.exec(
        'INSERT INTO device_detection_results (principal_id, session_id, command_id, result, completed_at) VALUES (?, ?, ?, ?, ?)',
        [...scopeKey, JSON.stringify(result), at],
      )
      return this.read(identity) ?? refuse()
    })
  }
}
