import { type MotionProfile, parseMotion } from './approach.js'
import { type GraspProfile, parseGrasp } from './grasp.js'
import { AkaProtocolError } from './protocol.js'
import { parseRoutePresets, type RoutePresets } from './routes.js'

export type GroundPoint = { u: number; v: number; x: number; y: number }
export type GroundCalibration = {
  id: string
  revision: number
  width: number
  height: number
  installation: string
  labels: string[]
  points: GroundPoint[]
  checks: GroundPoint[]
  measurementErrorMeters: number
  matrix: number[]
  hull: number[][]
  observedErrorMeters: number
  motion?: MotionProfile
  grasp?: GraspProfile
  routes?: RoutePresets
}
const fail = (): never => {
  throw new AkaProtocolError('Invalid or degenerate ground calibration')
}
function solve(rows: number[][], rhs: number[]) {
  const normal = Array.from({ length: 8 }, (_, i) => [
    ...Array.from({ length: 8 }, (_, j) => rows.reduce((sum, row) => sum + (row[i] ?? 0) * (row[j] ?? 0), 0)),
    rows.reduce((sum, row, k) => sum + (row[i] ?? 0) * (rhs[k] ?? 0), 0),
  ])
  for (let i = 0; i < 8; i++) {
    let pivot = i
    for (let j = i + 1; j < 8; j++)
      if (Math.abs(normal[j]?.[i] ?? 0) > Math.abs(normal[pivot]?.[i] ?? 0)) pivot = j
    const row = normal[pivot]
    if (!row || Math.abs(row[i] ?? 0) < 1e-10) return fail()
    const current = normal[i]
    if (!current) return fail()
    normal[pivot] = current
    normal[i] = row
    const divisor = row[i] ?? 0
    for (let k = i; k <= 8; k++) row[k] = (row[k] ?? 0) / divisor
    for (let j = 0; j < 8; j++) {
      if (i === j) continue
      const other = normal[j]
      if (!other) return fail()
      const factor = other[i] ?? 0
      for (let k = i; k <= 8; k++) other[k] = (other[k] ?? 0) - factor * (row[k] ?? 0)
    }
  }
  return normal.map((row) => row[8] ?? 0)
}
const cross = (a: number[], b: number[], c: number[]) =>
  ((b[0] ?? 0) - (a[0] ?? 0)) * ((c[1] ?? 0) - (a[1] ?? 0)) -
  ((b[1] ?? 0) - (a[1] ?? 0)) * ((c[0] ?? 0) - (a[0] ?? 0))
function hull(points: GroundPoint[]) {
  const sorted = points
    .map((p) => [p.u, p.v])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0))
  const half = (values: number[][]) => {
    const out: number[][] = []
    for (const point of values) {
      while (out.length > 1 && cross(out[out.length - 2] ?? [], out[out.length - 1] ?? [], point) <= 0)
        out.pop()
      out.push(point)
    }
    out.pop()
    return out
  }
  return [...half(sorted), ...half([...sorted].reverse())]
}
export function insideHull(vertices: number[][], point: number[]) {
  return (
    vertices.length >= 3 &&
    vertices.every((a, i) => cross(a, vertices[(i + 1) % vertices.length] ?? [], point) >= -1e-7)
  )
}
export function projectGround(
  c: Pick<GroundCalibration, 'matrix' | 'width' | 'height'>,
  u: number,
  v: number,
) {
  const U = u / c.width,
    V = v / c.height,
    m = c.matrix
  const denominator = (m[6] ?? 0) * U + (m[7] ?? 0) * V + 1
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) return fail()
  const x = ((m[0] ?? 0) * U + (m[1] ?? 0) * V + (m[2] ?? 0)) / denominator
  const y = ((m[3] ?? 0) * U + (m[4] ?? 0) * V + (m[5] ?? 0)) / denominator
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 10 || Math.abs(y) > 10) return fail()
  return { x, y }
}
/** Empirical plane fit within measured points. It is not an automatic grab qualification. */
export function fitGround(input: unknown, id: string, revision: number): GroundCalibration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
  const v = input as Record<string, unknown>
  if (
    Object.keys(v)
      .filter((key) => key !== 'motion' && key !== 'grasp' && key !== 'routes')
      .sort()
      .join(',') !== 'checks,height,installation,labels,measurementErrorMeters,points,width' ||
    !Number.isSafeInteger(v.width) ||
    (v.width as number) < 21 ||
    (v.width as number) > 4095 ||
    !Number.isSafeInteger(v.height) ||
    (v.height as number) < 21 ||
    (v.height as number) > 4095 ||
    typeof v.installation !== 'string' ||
    !v.installation.trim() ||
    v.installation.length > 128 ||
    !Array.isArray(v.labels) ||
    v.labels.length < 1 ||
    v.labels.length > 32 ||
    v.labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 256) ||
    typeof v.measurementErrorMeters !== 'number' ||
    !Number.isFinite(v.measurementErrorMeters) ||
    v.measurementErrorMeters < 0.001 ||
    v.measurementErrorMeters > 0.5
  )
    return fail()
  const width = v.width as number,
    height = v.height as number
  const points = (value: unknown, min: number) => {
    if (!Array.isArray(value) || value.length < min || value.length > 64) return fail()
    const seen = new Set<string>()
    return value.map((p) => {
      if (
        !p ||
        typeof p !== 'object' ||
        Object.keys(p).sort().join(',') !== 'u,v,x,y' ||
        ![p.u, p.v, p.x, p.y].every(Number.isFinite) ||
        p.u < 0 ||
        p.u > width ||
        p.v < 0 ||
        p.v > height ||
        p.x < 0 ||
        p.x > 10 ||
        Math.abs(p.y) > 10
      )
        return fail()
      const key = `${p.u}:${p.v}`
      if (seen.has(key)) return fail()
      seen.add(key)
      return { u: p.u, v: p.v, x: p.x, y: p.y } as GroundPoint
    })
  }
  const training = points(v.points, 6),
    checks = points(v.checks, 3),
    rows: number[][] = [],
    rhs: number[] = []
  const vertices = hull(training)
  if (vertices.length < 3) return fail()
  for (const p of checks)
    if (!insideHull(vertices, [p.u, p.v]) || training.some((t) => t.u === p.u && t.v === p.v)) return fail()
  for (const p of training) {
    const u = p.u / width,
      w = p.v / height
    rows.push([u, w, 1, 0, 0, 0, -p.x * u, -p.x * w], [0, 0, 0, u, w, 1, -p.y * u, -p.y * w])
    rhs.push(p.x, p.y)
  }
  const matrix = solve(rows, rhs)
  const model = { matrix, width, height }
  const error = Math.max(
    ...[...training, ...checks].map((p) => {
      const q = projectGround(model, p.u, p.v)
      return Math.hypot(q.x - p.x, q.y - p.y)
    }),
  )
  if (error > 0.25) return fail()
  // A projective horizon crossing the accepted region invalidates interpolation.
  const denominators = vertices.map(
    ([u = 0, w = 0]) => ((matrix[6] ?? 0) * u) / width + ((matrix[7] ?? 0) * w) / height + 1,
  )
  if (Math.min(...denominators) < 1e-4 && Math.max(...denominators) > -1e-4) return fail()
  return {
    id,
    revision,
    width,
    height,
    installation: v.installation,
    labels: [...new Set(v.labels as string[])],
    points: training,
    checks,
    measurementErrorMeters: v.measurementErrorMeters,
    matrix,
    hull: vertices,
    observedErrorMeters: error,
    ...(v.motion === undefined ? {} : { motion: parseMotion(v.motion) }),
    ...(v.grasp === undefined ? {} : { grasp: parseGrasp(v.grasp, width, height) }),
    ...(v.routes === undefined ? {} : { routes: parseRoutePresets(v.routes) }),
  }
}
export function estimateGround(
  c: GroundCalibration | null,
  image: { id: string; width: number; height: number },
  label: string,
  box: readonly number[],
) {
  const unknown = (reason: string) => ({ state: 'unknown' as const, reason, sourceResultId: image.id })
  if (!c) return unknown('uncalibrated')
  if (image.width !== c.width || image.height !== c.height) return unknown('resolution_changed')
  if (!c.labels.includes(label)) return unknown('contact_point_unverified')
  if (
    box.length !== 4 ||
    !box.every(Number.isFinite) ||
    (box[0] ?? -1) < 0 ||
    (box[1] ?? -1) < 0 ||
    (box[2] ?? 0) > image.width ||
    (box[3] ?? 0) > image.height ||
    (box[2] ?? 0) <= (box[0] ?? 0) ||
    (box[3] ?? 0) <= (box[1] ?? 0)
  )
    return unknown('invalid_box')
  const point = [(box[0] ?? 0) / 2 + (box[2] ?? 0) / 2, box[3] ?? 0]
  if (!insideHull(c.hull, point)) return unknown('outside_calibrated_region')
  try {
    const q = projectGround(c, point[0] ?? 0, point[1] ?? 0)
    return {
      state: 'estimated' as const,
      method: 'ground_plane_fit',
      coordinateFrame: 'robot',
      units: 'm',
      referencePoint: 'box_bottom_center',
      forward: q.x,
      left: q.y,
      groundDistance: Math.hypot(q.x, q.y),
      observedErrorMeters: c.observedErrorMeters + c.measurementErrorMeters,
      calibrationId: c.id,
      calibrationRevision: c.revision,
      sourceResultId: image.id,
      controlReady: false,
      limitation: 'Independent-point observed error is not a guaranteed control error bound',
    }
  } catch {
    return unknown('invalid_projection')
  }
}
