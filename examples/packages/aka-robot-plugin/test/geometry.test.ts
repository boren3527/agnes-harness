import { performance } from 'node:perf_hooks'
import type { ServiceContext } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import type { CaptureDependencies } from '../src/capture-frame.js'
import { estimateGround, fitGround, projectGround } from '../src/geometry.js'
import { GroundGeometry } from '../src/geometry-service.js'

const id = '11111111-1111-4111-8111-111111111111'
const point = (u: number, v: number) => ({ u, v, x: 2 - v / 240, y: 1 - u / 160 })
const calibration = () => ({
  width: 320,
  height: 240,
  installation: 'fixed-test-camera',
  labels: ['ball'],
  measurementErrorMeters: 0.01,
  points: [
    [10, 20],
    [150, 20],
    [290, 20],
    [10, 200],
    [150, 200],
    [290, 200],
  ].map(([u, v]) => point(u ?? 0, v ?? 0)),
  checks: [point(70, 90), point(200, 80), point(120, 140)],
})
describe('ground plane calibration and distance', () => {
  it('preserves bounded route presets without allowing arm actions or an overlong return route', () => {
    const step = { action: 'up', speed: 30, milliseconds: 500 }
    const routes = {
      patrol: { steps: [step], returnSteps: [{ ...step, action: 'down' }], homeLabels: ['ball'] },
      delivery: { steps: [step], destinationLabels: ['bin'] },
    }
    expect(fitGround({ ...calibration(), routes }, id, 1).routes).toEqual(routes)
    for (const invalid of [
      { patrol: { ...routes.patrol, steps: [{ ...step, action: 'grab' }] } },
      { patrol: { ...routes.patrol, steps: Array.from({ length: 12 }, () => step) } },
      { delivery: { steps: [step], destinationLabels: [] } },
      { delivery: { steps: [{ ...step, speed: 51 }], destinationLabels: ['bin'] } },
    ])
      expect(() => fitGround({ ...calibration(), routes: invalid }, id, 1)).toThrow()
  })
  it('fits references and independently measures errors, with forward/left in metres', () => {
    const c = fitGround(calibration(), id, 1)
    const projected = projectGround(c, 160, 120)
    expect(projected.x).toBeCloseTo(1.5, 8)
    expect(projected.y).toBeCloseTo(0, 8)
    const distance = estimateGround(c, { id: 'source', width: 320, height: 240 }, 'ball', [140, 80, 180, 120])
    expect(distance).toMatchObject({
      state: 'estimated',
      units: 'm',
      coordinateFrame: 'robot',
      sourceResultId: 'source',
      controlReady: false,
    })
    if (distance.state !== 'estimated') throw new Error('Missing estimated distance')
    expect(distance.groundDistance).toBeCloseTo(1.5, 8)
    expect(distance.observedErrorMeters).toBeCloseTo(0.01, 8)
    const changed = calibration()
    changed.checks[0] = { ...point(70, 90), x: point(70, 90).x + 0.1 }
    expect(fitGround(changed, id, 2).observedErrorMeters).toBeCloseTo(0.1, 8)
  })
  it('keeps unknown distances for unsupported contact points, changed resolution and outside references', () => {
    const c = fitGround(calibration(), id, 1),
      image = { id: 'source', width: 320, height: 240 }
    expect(estimateGround(null, image, 'ball', [140, 80, 180, 120])).toMatchObject({ reason: 'uncalibrated' })
    expect(estimateGround(c, image, 'can', [140, 80, 180, 120])).toMatchObject({
      reason: 'contact_point_unverified',
    })
    expect(estimateGround(c, { ...image, width: 640 }, 'ball', [140, 80, 180, 120])).toMatchObject({
      reason: 'resolution_changed',
    })
    expect(estimateGround(c, image, 'ball', [140, 80, 180, 239])).toMatchObject({
      reason: 'outside_calibrated_region',
    })
  })
  it('refuses duplicate/collinear references and reused validation points', () => {
    expect(() =>
      fitGround({ ...calibration(), points: Array.from({ length: 6 }, () => point(20, 30)) }, id, 1),
    ).toThrow()
    expect(() =>
      fitGround({ ...calibration(), points: [20, 40, 60, 80, 100, 120].map((u) => point(u, 30)) }, id, 1),
    ).toThrow()
    expect(() =>
      fitGround({ ...calibration(), checks: [point(10, 20), point(70, 90), point(120, 140)] }, id, 1),
    ).toThrow()
  })
})
function fixture() {
  const data = new Map<string, Uint8Array>()
  const missing = () => Object.assign(new Error('Not found'), { code: 'ENOENT' })
  const binding = { deviceId: id, sessionId: 'chat', workspaceId: 'w', bindingRevision: 1, active: true }
  const ctx = {
    session: { key: 'chat', workspaceRoot: '/workspace' },
    device: { binding: vi.fn(async () => binding) },
    signal: new AbortController().signal,
    fs: {
      read: vi.fn(async (path: string) => {
        const value = data.get(path)
        if (!value) throw missing()
        return value
      }),
      stat: vi.fn(async (path: string) => {
        const value = data.get(path)
        if (!value) throw missing()
        return { kind: 'file', size: value.length }
      }),
      write: vi.fn(async (path: string, value: string) => {
        data.set(path, new TextEncoder().encode(value))
      }),
    },
  } as unknown as ServiceContext
  const deps = {
    registrations: new Map([
      [
        id,
        { deviceId: id, ip: '192.168.50.42', port: 80, macAddress: '12:34:56:78:90:ab', configRevision: 1 },
      ],
    ]),
  } as unknown as CaptureDependencies
  return { ctx, data, binding, geometry: new GroundGeometry(deps), deps }
}
it('saves, reopens and estimates only the same session actual recognition source', async () => {
  const v = fixture(),
    input = { bindingRevision: 1, configRevision: 1 }
  await expect(v.geometry.read(v.ctx, input)).resolves.toBeNull()
  const saved = await v.geometry.save(v.ctx, { ...input, expectedRevision: 0, calibration: calibration() })
  expect(saved.revision).toBe(1)
  const reopened = new GroundGeometry(v.deps)
  await expect(reopened.read(v.ctx, input)).resolves.toEqual(saved)
  await expect(
    v.geometry.save(v.ctx, { ...input, expectedRevision: 0, calibration: calibration() }),
  ).rejects.toThrow('version changed')
  await v.geometry.remember(
    v.ctx,
    {
      id: 'source',
      selectedAt: '2026-10-11T00:00:00.000Z',
      frameId: 'original-frame',
      deviceId: id,
      bindingRevision: 1,
      width: 320,
      height: 240,
      detections: [
        { label: 'ball', confidence: 0.99, box: [140, 80, 180, 120] },
        { label: 'unverified-object', confidence: 0.8, box: [100, 80, 130, 120] },
      ],
    },
    1,
  )
  await expect(v.geometry.estimate(v.ctx, { ...input, resultId: 'source' })).resolves.toMatchObject({
    resultId: 'source',
    selectedAt: '2026-10-11T00:00:00.000Z',
    frameId: 'original-frame',
    estimates: [
      { index: 0, label: 'ball', confidence: 0.99, box: [140, 80, 180, 120], state: 'estimated' },
      {
        index: 1,
        label: 'unverified-object',
        confidence: 0.8,
        state: 'unknown',
        reason: 'contact_point_unverified',
      },
    ],
  })
  await expect(v.geometry.estimate(v.ctx, { ...input, resultId: 'invented' })).rejects.toThrow('unavailable')
  v.binding.sessionId = 'other'
  const other = { ...v.ctx, session: { ...v.ctx.session, key: 'other' } } as ServiceContext
  await expect(v.geometry.estimate(other, { ...input, resultId: 'source' })).rejects.toThrow('unavailable')
})

it('does not accept a delayed recognition reply for a frame received before the movement finished', async () => {
  const v = fixture(),
    after = performance.now(),
    input = { bindingRevision: 1, configRevision: 1 }
  const image = {
    id: 'delayed',
    frameId: 'old-frame',
    receivedAt: after - 1,
    selectedAt: new Date().toISOString(),
    deviceId: id,
    bindingRevision: 1,
    width: 320,
    height: 240,
    artifact: { sha256: 'a'.repeat(64), size: 100, mime: 'image/jpeg' },
    detections: [{ label: 'ball', confidence: 0.99, box: [140, 80, 180, 120] as const }],
  }
  await v.geometry.remember(v.ctx, image, 1)
  await expect(v.geometry.observation(v.ctx, input, Date.now() - 1000, after)).resolves.toBeNull()
  await v.geometry.remember(
    v.ctx,
    { ...image, id: 'new', frameId: 'new-frame', receivedAt: performance.now() },
    1,
  )
  await expect(v.geometry.observation(v.ctx, input, Date.now() - 1000, after)).resolves.toMatchObject({
    id: 'new',
    frameId: 'new-frame',
  })
  // A stopped task may wait for cloud latency, but must still reject pre-movement frames.
  const cloud = fixture()
  const capturedAt = Date.now() - 3000
  await cloud.geometry.remember(
    cloud.ctx,
    { ...image, id: 'cloud', selectedAt: new Date(capturedAt).toISOString(), receivedAt: after + 1 },
    1,
  )
  await expect(cloud.geometry.observation(cloud.ctx, input, capturedAt - 1, after)).resolves.toBeNull()
  await expect(
    cloud.geometry.observation(cloud.ctx, input, capturedAt - 1, after, 10000),
  ).resolves.toMatchObject({ id: 'cloud' })
  await expect(cloud.geometry.observation(cloud.ctx, input, capturedAt + 1, after, 10000)).resolves.toBeNull()
  await expect(
    cloud.geometry.observation(cloud.ctx, input, capturedAt - 1, after + 2, 10000),
  ).resolves.toBeNull()
})
