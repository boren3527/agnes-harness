import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { type CaptureSelection, DeviceCaptureRecords } from '../src/storage/device-captures.js'
import { type DetectionReceipt, DeviceDetectionResults } from '../src/storage/device-detection-results.js'
import { sqliteTables } from './sqlite-tables.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const identity = { principalId: 'owner', sessionId: 'session', commandId: 'original-command' }
const at = '2026-10-10T00:00:00.000Z'
const selected: CaptureSelection = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  bindingRevision: 1,
  configRevision: 7,
  frameId: 'original-frame',
  width: 320,
  height: 240,
  selectedAt: at,
  timeBasis: 'bridge_receive',
  ageAtSelectionMs: 10,
  artifact: { sha256: 'a'.repeat(64), size: 100, mime: 'image/jpeg' },
}
const candidate = (): DetectionReceipt => ({
  id: '22222222-2222-4222-8222-222222222222',
  deviceId: selected.deviceId,
  bindingRevision: 1,
  configRevision: 3,
  roundRevision: 2,
  frameId: selected.frameId,
  width: 320,
  height: 240,
  sha256: selected.artifact.sha256,
  providerRequestId: 'synthetic-request',
  elapsedMs: 123,
  detections: [{ label: 'ball', confidence: 0.8, box: [1, 2, 30, 40] }],
})
function fixture(path?: string, stage = 'recorded') {
  const tables = sqliteTables(path)
  cleanup.push(() => tables.close())
  const table = tables.table('devices'),
    captures = new DeviceCaptureRecords(table)
  if (stage !== 'missing') {
    captures.select(identity, selected)
    if (stage !== 'selected') captures.stored(identity, selected.artifact)
    if (stage === 'recorded') captures.recorded(identity, 42)
  }
  return { tables, table, captures, results: new DeviceDetectionResults(table, captures) }
}
it('persists the exact independent receipt across SQLite reopen and keeps owner/session/command isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-detection-results-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'results.sqlite'),
    v = fixture(path)
  const first = v.results.save(identity, candidate(), at)
  expect(first).toEqual({
    capture: { selection: selected, stage: 'recorded', eventSeq: 42 },
    result: candidate(),
    completedAt: at,
  })
  expect(v.results.save(identity, { ...candidate(), detections: [...candidate().detections] }, at)).toEqual(
    first,
  )
  expect(Object.isFrozen(first.result.detections[0]?.box)).toBe(true)
  await v.tables.close()
  const reopened = sqliteTables(path)
  cleanup.push(() => reopened.close())
  const table = reopened.table('devices'),
    results = new DeviceDetectionResults(table, new DeviceCaptureRecords(table))
  expect(results.read(identity)).toEqual(first)
  for (const other of [
    { ...identity, principalId: 'other' },
    { ...identity, sessionId: 'other' },
    { ...identity, commandId: 'other' },
  ])
    expect(results.read(other)).toBeNull()
  expect(() => results.save(identity, { ...candidate(), roundRevision: 3 }, at)).toThrow()
  expect(() => results.save(identity, candidate(), '2026-10-10T00:00:01.000Z')).toThrow()
  expect(results.read(identity)).toEqual(first)
})
it.each(['missing', 'selected', 'stored'])(
  'refuses archive without an actual recorded original: %s',
  (stage) => {
    const v = fixture(undefined, stage)
    expect(() => v.results.save(identity, candidate(), at)).toThrow()
    expect(v.results.read(identity)).toBeNull()
  },
)
it.each([
  'frame',
  'hash',
  'device',
  'binding',
  'width',
  'box',
  'label',
  'score',
  'extra',
  'elapsed',
  'timestamp',
])('refuses invalid or mismatched %s without creating an archive', (mode) => {
  const v = fixture(),
    value = candidate()
  const malformed: Record<string, unknown> = { ...value }
  if (mode === 'frame') malformed.frameId = 'different'
  if (mode === 'hash') malformed.sha256 = 'b'.repeat(64)
  if (mode === 'device') malformed.deviceId = value.id
  if (mode === 'binding') malformed.bindingRevision = 2
  if (mode === 'width') malformed.width = 321
  if (mode === 'box') malformed.detections = [{ label: 'ball', confidence: 0.8, box: [1, 2, 321, 40] }]
  if (mode === 'label') malformed.detections = [{ ...value.detections[0], label: 'ball\ncommand' }]
  if (mode === 'score') malformed.detections = [{ ...value.detections[0], confidence: 2 }]
  if (mode === 'extra') malformed.secret = 'not permitted'
  if (mode === 'elapsed') malformed.elapsedMs = Number.NaN
  expect(() =>
    v.results.save(identity, malformed as DetectionReceipt, mode === 'timestamp' ? 'invalid' : at),
  ).toThrow()
  expect(v.results.read(identity)).toBeNull()
})
it('rejects corrupted stored metadata and missing original without fabricating a receipt', () => {
  const v = fixture()
  v.results.save(identity, candidate(), at)
  v.table.exec('UPDATE device_detection_results SET result = ?', ['{"secret":"corrupted"}'])
  expect(() => v.results.read(identity)).toThrow('device detection result unavailable')
  v.table.exec('UPDATE device_detection_results SET result = ?', [JSON.stringify(candidate())])
  v.table.exec('DELETE FROM device_capture_records')
  expect(() => v.results.read(identity)).toThrow('device detection result unavailable')
})
it('rolls back a write failure rather than exposing a partially acknowledged result', () => {
  const v = fixture(),
    exec = v.table.exec.bind(v.table)
  const fault = vi.spyOn(v.table, 'exec').mockImplementation((sql, params) => {
    exec(sql, params)
    if (sql.startsWith('INSERT INTO device_detection_results')) throw new Error('synthetic storage failure')
  })
  expect(() => v.results.save(identity, candidate(), at)).toThrow('synthetic storage failure')
  expect(v.results.read(identity)).toBeNull()
  expect(v.captures.read(identity)?.eventSeq).toBe(42)
  fault.mockRestore()
})
