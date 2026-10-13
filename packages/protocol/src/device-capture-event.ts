import { type ArtifactRef, type EventEnvelope, ArtifactRef as RefSchema } from '../gen/ts/session-v1.js'
import { inspectJsonData } from './json-data.js'
import { validateAgainst } from './validate.js'

/** Private Host event, not an extension append namespace or a model tool result.
 * Producers must authorize the capture and persist exact bytes before appending this event. */
export function readDeviceCaptureEvent(
  event: Pick<EventEnvelope, 'type' | 'origin' | 'trust' | 'data' | 'ignorable'>,
): Readonly<{ captureId: string; ref: ArtifactRef; purpose?: 'recognition' }> | undefined {
  if (
    event.type !== 'x/core/device-capture' ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true
  )
    return undefined
  const checked = inspectJsonData(event.data, 4096)
  if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
    return undefined
  const data = checked.value as Record<string, unknown>
  if (
    !['captureId,ref', 'captureId,purpose,ref'].includes(Object.keys(data).sort().join(',')) ||
    (Object.hasOwn(data, 'purpose') && data.purpose !== 'recognition') ||
    typeof data.captureId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.captureId)
  )
    return undefined
  const ref = validateAgainst<ArtifactRef>(RefSchema, data.ref)
  if (!ref.ok || ref.value.mime !== 'image/jpeg' || ref.value.size < 1 || ref.value.size > 4 * 1024 * 1024)
    return undefined
  return Object.freeze({
    captureId: data.captureId,
    ref: Object.freeze({ ...ref.value }),
    ...(data.purpose === 'recognition' ? { purpose: 'recognition' as const } : {}),
  })
}

export type DeviceCaptureSelection = Readonly<{
  deviceId: string
  bindingRevision: number
  configRevision: number
  frameId: string
  width: number
  height: number
  selectedAt: string
  timeBasis: 'bridge_receive'
  ageAtSelectionMs: number
  artifact: Readonly<{ sha256: string; size: number; mime: 'image/jpeg' }>
}>
export type DeviceCaptureRecord = Readonly<{
  selection: DeviceCaptureSelection
  stage: 'selected' | 'stored' | 'recorded'
  eventSeq: number | null
}>

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
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
export function readDeviceCaptureSelection(value: unknown): DeviceCaptureSelection | undefined {
  try {
    const v = object(
      value,
      'ageAtSelectionMs,artifact,bindingRevision,configRevision,deviceId,frameId,height,selectedAt,timeBasis,width',
    )
    const a = object(v.artifact, 'mime,sha256,size')
    if (
      typeof v.deviceId !== 'string' ||
      !uuid.test(v.deviceId) ||
      !positive(v.bindingRevision) ||
      !positive(v.configRevision) ||
      v.timeBasis !== 'bridge_receive' ||
      typeof v.ageAtSelectionMs !== 'number' ||
      !Number.isFinite(v.ageAtSelectionMs) ||
      v.ageAtSelectionMs < 0 ||
      v.ageAtSelectionMs > 1000 ||
      !text(v.frameId) ||
      !positive(v.width) ||
      (v.width as number) > 4096 ||
      !positive(v.height) ||
      (v.height as number) > 4096 ||
      typeof v.selectedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.selectedAt) ||
      !Number.isFinite(Date.parse(v.selectedAt)) ||
      new Date(v.selectedAt).toISOString() !== v.selectedAt ||
      typeof a.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !positive(a.size) ||
      (a.size as number) > 4 * 1024 * 1024 ||
      a.mime !== 'image/jpeg'
    )
      return undefined
    // Canonical ordering makes same-command comparisons independent of caller property order.
    return Object.freeze({
      deviceId: v.deviceId,
      bindingRevision: v.bindingRevision as number,
      configRevision: v.configRevision as number,
      frameId: v.frameId as string,
      width: v.width as number,
      height: v.height as number,
      selectedAt: v.selectedAt,
      timeBasis: 'bridge_receive',
      ageAtSelectionMs: v.ageAtSelectionMs,
      artifact: Object.freeze({ sha256: a.sha256, size: a.size as number, mime: 'image/jpeg' as const }),
    })
  } catch {
    return undefined
  }
}

export function readDeviceCaptureRecord(value: unknown): DeviceCaptureRecord | undefined {
  try {
    const v = object(value, 'eventSeq,selection,stage')
    const selected = readDeviceCaptureSelection(v.selection)
    if (
      !selected ||
      !['selected', 'stored', 'recorded'].includes(v.stage as string) ||
      (v.stage === 'recorded' ? !positive(v.eventSeq) : v.eventSeq !== null)
    )
      return undefined
    return Object.freeze({
      selection: selected,
      stage: v.stage as DeviceCaptureRecord['stage'],
      eventSeq: v.eventSeq as number | null,
    })
  } catch {
    return undefined
  }
}
