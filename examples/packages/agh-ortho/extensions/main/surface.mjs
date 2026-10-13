import { outlinesFor } from './meshoutline.mjs'
import { renderSheet, sheetPlacement, sixViewRects } from './views.mjs'

export function normalizeProfile(input) {
  const profile = input.map((p) => [...p])
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  if (profile.length > 1 && distance(profile[0], profile.at(-1)) < 1e-9) profile.pop()
  if (profile.length < 3) throw new Error('Revolve needs three distinct section points')
  const pairs = profile.map((p, i) => [p, profile[(i + 1) % profile.length]])
  if (pairs.some(([a, b]) => distance(a, b) < 1e-9)) throw new Error('Adjacent section points must differ')
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const on = (a, b, p) =>
    Math.abs(orient(a, b, p)) < 1e-12 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++) {
      if (j === i + 1 || (i === 0 && j === pairs.length - 1)) continue
      const [a, b] = pairs[i],
        [c, d] = pairs[j]
      if (
        (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) ||
        on(a, b, c) ||
        on(a, b, d) ||
        on(c, d, a) ||
        on(c, d, b)
      )
        throw new Error('Revolve section intersects itself')
    }
  return profile
}

/** Parameter-derived review, with actual scene readback kept separate from estimates. */
export function surfaceReview(surfaces, projection = 'first_angle', scene = null) {
  const vertices = [],
    rows = [],
    boxes = []
  for (const shape of surfaces) {
    const origin = shape.location ?? [0, 0, 0],
      points = []
    if (shape.kind === 'revolve') {
      const count = shape.segments ?? 96
      for (const [radius, height] of shape.profile)
        for (let i = 0; i < count; i++) {
          const angle = (2 * Math.PI * i) / count
          points.push([
            origin[0] + radius * Math.cos(angle),
            origin[1] + radius * Math.sin(angle),
            origin[2] + height,
          ])
        }
    } else {
      // NURBS control points bound the centreline; radius-expanded hull is conservative.
      for (const p of shape.points)
        for (const x of [-1, 1])
          for (const y of [-1, 1])
            for (const z of [-1, 1]) points.push(p.map((n, i) => n + origin[i] + [x, y, z][i] * shape.radius))
    }
    const min = [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis])))
    const max = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis])))
    const size = max.map((n, i) => n - min[i]),
      center = max.map((n, i) => (n + min[i]) / 2)
    boxes.push({ name: shape.name, min, max, size, center })
    const stride = Math.max(1, Math.ceil(points.length / 1536))
    vertices.push(...points.filter((_, i) => i % stride === 0))
    const actual = scene?.objects?.find((o) => o.name === shape.name)
    const bounds = actual?.bounds
    const tolerance = Math.max(1e-6, Math.max(...size) * 1e-4)
    const measured = bounds?.min?.length === 3 && bounds?.max?.length === 3
    const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    const transformMatches =
      actual?.type === 'MESH' &&
      triple(actual.location) &&
      triple(actual.scale) &&
      triple(actual.rotation_euler) &&
      [0, 1, 2].every(
        (i) =>
          Math.abs(actual.location[i] - origin[i]) <= tolerance &&
          Math.abs(actual.scale[i] - 1) <= 1e-6 &&
          Math.abs(actual.rotation_euler[i]) <= 1e-6,
      ) &&
      (actual.rotationMode === undefined || actual.rotationMode === 'XYZ')
    const matched =
      measured &&
      triple(bounds.min) &&
      triple(bounds.max) &&
      transformMatches &&
      [0, 1, 2].every((axis) =>
        shape.kind === 'revolve'
          ? Math.abs(bounds.min[axis] - min[axis]) <= tolerance &&
            Math.abs(bounds.max[axis] - max[axis]) <= tolerance
          : bounds.min[axis] >= min[axis] - tolerance && bounds.max[axis] <= max[axis] + tolerance,
      )
    rows.push({
      name: shape.name,
      kind: shape.kind,
      bounds: { min, max },
      dimensions: size,
      check: shape.kind === 'revolve' ? 'sampled_surface_bounds' : 'curve_control_hull_containment',
      actual: bounds ?? null,
      matched: scene ? Boolean(matched) : null,
      transformMatches: scene ? Boolean(transformMatches) : null,
      tolerance,
    })
  }
  const views = sixViewRects(boxes)
  const span = Math.max(...rows.flatMap((row) => row.dimensions))
  const outlines = outlinesFor(vertices, { cell: Math.max(1e-6, span / 64) })
  const minimum = [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis])))
  const maximum = [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis])))
  const target = minimum.map((n, i) => (n + maximum[i]) / 2)
  const radius = Math.hypot(...maximum.map((n, i) => (n - minimum[i]) / 2))
  return {
    ok: scene ? rows.every((row) => row.matched) : true,
    sceneChecked: Boolean(scene),
    rows,
    previewFraming: {
      target,
      boundingSphereRadius: radius,
      squareImageOrthoScale: Math.max(1e-4, 2 * radius * 1.25),
      note: 'For a square orthographic preview, aim at target and set camera.add ortho_scale to at least squareImageOrthoScale. Set an existing camera with camera.add replace=true; object.transform cannot set lens/ortho_scale. This bounds the modeled parts only; inspect the actual render for occlusion and lighting.',
    },
    views: views.map((v) => ({ view: v.id, bbox: v.bbox, objects: v.names })),
    sheet: renderSheet(views, sheetPlacement(projection), { projection, outlines }),
    note: 'Six views describe these parameters. Tube outline uses a conservative control hull. Matching scene bounds does not prove photographic resemblance; compare the actual render with the source.',
  }
}
