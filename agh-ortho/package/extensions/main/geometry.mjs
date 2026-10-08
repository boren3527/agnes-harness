/**
 * geometry.mjs —— 意图层 → 几何的规则（纯函数，零依赖）。
 *
 * 为什么单独一个模块：`agh_ortho_verify` 的 numeric 校验必须从**两条独立路径**看同一个模型 ——
 *   ① extentsFromParams  直接读参数叶子（w / d / h / at / z）
 *   ② extentsFromBoxes   读 lowering 产出的 ops
 * 校验比的就是这两者。共用一条路径的话校验就是同义反复。
 *
 * 唯一被两条路径共享的是落位规则 `placementOf` —— 这是**已知的校验盲区**：如果这条规则本身
 * 把中心算错了，两条路径会一起错，残差仍为 0。记在 notes/SKELETON-STATUS.md 里，别当成已覆盖。
 */

const FINITE = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * 落位规则（唯一真值）。下游的 primitive_cube_add 把方块放在**中心**，所以返回值是中心点。
 *   - 有 `at`  → 用它的向量
 *   - 有 `z`   → [0, 0, z]
 *   - 都没有   → 方块"底面落地"（中心在 h/2）；板落在 z = 0
 */
export function placementOf(item, h) {
  const at = item?.at?.v
  if (Array.isArray(at) && at.length === 3 && at.every(FINITE)) return [...at]
  if (FINITE(item?.z?.v)) return [0, 0, item.z.v]
  return [0, 0, FINITE(h) ? h / 2 : 0]
}

/** 一个 assembly item 是否会被 lowering 成 op —— 两条路径必须用同一个判定，否则会错位。 */
export function lowersToOp(item) {
  if (!item || typeof item !== 'object') return false
  if (item.repeat !== undefined) return false
  if (item.feature === 'slab') return FINITE(item.w?.v) && FINITE(item.d?.v)
  if (item.feature === 'box') return FINITE(item.w?.v) && FINITE(item.d?.v) && FINITE(item.h?.v)
  return false
}

/** lowering 的产物 → 轴对齐包围盒。平面在 Z 上零厚（下游 plane 的 scale 第二/三参不影响厚度）。 */
export function boxesFromOps(ops) {
  const boxes = []
  for (const op of ops ?? []) {
    if (!op || op.op !== 'mesh.primitive_add') continue
    const a = op.args ?? {}
    const size = FINITE(a.size) ? a.size : 1
    const scale = Array.isArray(a.scale) && a.scale.length === 3 ? a.scale : [1, 1, 1]
    const c = Array.isArray(a.location) && a.location.length === 3 ? a.location : [0, 0, 0]
    const half = scale.map((v) => (v * size) / 2)
    const min = [c[0] - half[0], c[1] - half[1], c[2] - half[2]]
    const max = [c[0] + half[0], c[1] + half[1], c[2] + half[2]]
    if (a.kind === 'plane') {
      min[2] = c[2]
      max[2] = c[2]
    }
    boxes.push({ name: String(a.name), kind: a.kind, centre: [...c], min, max })
  }
  return boxes
}

/** 包围盒 → { name, x|y|z: { centre, size } }。中心/尺寸的表示法让符号约定不影响比较。 */
export function extentsFromBoxes(boxes) {
  return boxes.map((b) => ({
    name: b.name,
    x: { centre: (b.min[0] + b.max[0]) / 2, size: b.max[0] - b.min[0] },
    y: { centre: (b.min[1] + b.max[1]) / 2, size: b.max[1] - b.min[1] },
    z: { centre: (b.min[2] + b.max[2]) / 2, size: b.max[2] - b.min[2] },
  }))
}

/** 参数叶子 → 同一种表示法。只收会被 lowering 的 item，保证与 ops 列表**按序对齐**。 */
export function extentsFromParams(items) {
  const out = []
  for (const item of items ?? []) {
    if (!lowersToOp(item)) continue
    const w = item.w.v
    const d = item.d.v
    const h = item.feature === 'box' ? item.h.v : null
    const c = placementOf(item, h ?? undefined)
    out.push({
      name: String(item.id ?? out.length),
      x: { centre: c[0], size: w },
      y: { centre: c[1], size: d },
      z: { centre: c[2], size: h === null ? 0 : h },
    })
  }
  return out
}

/**
 * 从 lowering 产出的 ops 里取出"我打算让下游创建什么"。
 * 只取 primitive_add —— 它是唯一会创建对象的 op，也正是场景读回要比对的目标。
 */
export function expectedObjectsFromOps(ops) {
  const out = []
  for (const op of ops ?? []) {
    if (!op || op.op !== 'mesh.primitive_add') continue
    const args = op.args ?? {}
    out.push({
      name: args.name,
      kind: args.kind,
      // 缺 `size` 时用 1.0：这不是猜 —— 下游的默认值就是 1.0，双处可查
      // （OP_MANIFEST 的 'size': {'default': 1.0}，以及 agh_ops.py 的 `else 1.0`）。
      size: typeof args.size === 'number' ? args.size : 1,
      location: Array.isArray(args.location) ? [...args.location] : [0, 0, 0],
      scale: Array.isArray(args.scale) ? [...args.scale] : [1, 1, 1],
    })
  }
  return out
}

export const SCENE_TOLERANCE = 1e-6

/**
 * 每种基元在 `size = 1` 时的**单位尺寸**（还要再乘 `size` 与 `scale`）。
 *
 * 出处是下游自己的映射，不是猜的 —— `agh-blender/.../bridge/agh_ops.py:143-155`：
 *   cube      → primitive_cube_add(size=size)       → (1, 1, 1)
 *   plane     → primitive_plane_add(size=size)      → (1, 1, 0)          ← 零厚
 *   uv_sphere → radius = size/2                     → (1, 1, 1)
 *   cylinder  → radius = size/2, depth = size       → (1, 1, 1)
 *   cone      → radius1 = size/2, depth = size      → (1, 1, 1)
 *   torus     → major = size/2, minor = size/8      → (1.25, 1.25, 0.25) ← **不是 1**
 *
 * 所以"期望尺寸 = scale × size"这句**只对其他五种成立**，torus 必须单独给。
 * 这张表本该由下游的 `catalog()` 发布（见 notes/DOWNSTREAM-REQUEST-readback.md §8），
 * 在它发布之前这里是带出处的硬编码；届时删掉这里、改读 catalog 即可。
 */
export const UNIT_EXTENT = {
  cube: [1, 1, 1],
  plane: [1, 1, 0],
  uv_sphere: [1, 1, 1],
  cylinder: [1, 1, 1],
  cone: [1, 1, 1],
  torus: [1.25, 1.25, 0.25],
}

/**
 * `scene_readback` 半档的比对：**只用下游场景读回里真实存在的字段**。
 *
 * 能断言的（精确）：对象按确切名字存在、类型是 MESH、location 与 scale 与我们的 ops 一致。
 * 不能断言的（必须自己说出来）：最终尺寸（w×d×h）—— `describe_scene()` 不发布 `dimensions`；
 * 以及基元种类本身（除 type=MESH 外，下游 catalog 不发布每种基元的顶点/面数）。
 * 这两条正是 notes/DOWNSTREAM-REQUEST-readback.md 那份请求的理由。
 *
 * 本档与 `numeric` 档是**两条独立路径**：numeric 只看我方自洽，本档第一次引入外部事实。
 */
export function compareScene(expected, scene) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : []
  const byName = new Map(objects.map((o) => [o?.name, o]))
  const axisDelta = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length
      ? Math.max(...a.map((v, i) => Math.abs(v - b[i])))
      : null
  const rows = []
  for (const want of expected) {
    const got = byName.get(want.name)
    if (!got) {
      rows.push({
        object: want.name,
        verdict: 'missing',
        note: '场景里没有这个确切名字的对象。Blender 会把重名改成 name.001，所以"精确名字找不到"意味着要么没创建、要么名字被占了。',
      })
      continue
    }
    const locationDelta = axisDelta(want.location, got.location)
    const scaleDelta = axisDelta(want.scale, got.scale)
    const rotationPublished = Array.isArray(got.rotation_euler)
    const rotationIsZero = !rotationPublished || got.rotation_euler.every((r) => Math.abs(r) <= SCENE_TOLERANCE)
    // 尺寸断言的三个前置条件，缺一个就不做 —— 而"为什么没做"必须写进 rows：
    //   1. 下游为**这个对象**发布了 dimensions；
    //   2. 我们知道这种基元的单位尺寸（否则"期望值"就是我编的，torus 就是反例）；
    //   3. 对象**没有旋转** —— `obj.dimensions` 是"本地包围盒 × scale"，一旦旋转，世界 AABB ≠ 它。
    const unit = UNIT_EXTENT[want.kind]
    const expectedSize = unit ? unit.map((u, i) => u * want.size * want.scale[i]) : null
    // 三个前置条件必须**每一个都出现在这个条件里** —— 上面注释写了三条，代码里只写两条就是个 bug
    // （自检抓到过：旋转的对象尺寸仍然被"断言"了，于是 size_not_asserted_reason 成了 null）。
    const dimensionsDelta =
      Array.isArray(got.dimensions) && expectedSize && rotationIsZero ? axisDelta(expectedSize, got.dimensions) : null
    const sizeAsserted = dimensionsDelta !== null
    const sizeNotAssertedReason = sizeAsserted
      ? null
      : !Array.isArray(got.dimensions)
        ? 'this downstream published no dimensions for this object'
        : !unit
          ? `no unit-extent entry for kind "${want.kind}", so an expected size would be a guess`
          : 'the object is rotated, and dimensions is the local bounding box times scale, not the world AABB'
    const typeIsMesh = got.type === 'MESH'
    // 旋转也算不符：M1 的 ops 从不设置 rotation_euler，所以现场不该有旋转。
    const ok =
      typeIsMesh &&
      rotationIsZero &&
      locationDelta !== null &&
      locationDelta <= SCENE_TOLERANCE &&
      scaleDelta !== null &&
      scaleDelta <= SCENE_TOLERANCE &&
      (!sizeAsserted || dimensionsDelta <= SCENE_TOLERANCE)
    rows.push({
      object: want.name,
      verdict: ok ? 'match' : 'mismatch',
      type_is_mesh: typeIsMesh,
      location_delta: locationDelta,
      scale_delta: scaleDelta,
      rotation_published: rotationPublished,
      rotation_is_zero: rotationIsZero,
      // 这一项的真假说明"尺寸语义"到底验没验；为假时 reason 说明为什么没验。
      size_asserted: sizeAsserted,
      size_not_asserted_reason: sizeNotAssertedReason,
      dimensions_delta: dimensionsDelta,
      expected_size_m: expectedSize,
      // 观测到的（不是断言的）：顶点/面数能让人和模型一眼看出 cube(8/6) 还是 plane(4/1)，
      // 但"期望值"下游没有发布，所以我们只报出来，不据此判成败。
      observed: {
        type: got.type,
        location: got.location,
        scale: got.scale,
        rotation_euler: got.rotation_euler ?? null,
        dimensions: got.dimensions ?? null,
        vertices: got.vertices,
        polygons: got.polygons,
        materials: got.materials,
      },
    })
  }
  const expectedNames = new Set(expected.map((e) => e.name))
  return {
    rows,
    matched: rows.filter((r) => r.verdict === 'match').length,
    missing: rows.filter((r) => r.verdict === 'missing').map((r) => r.object),
    mismatched: rows.filter((r) => r.verdict === 'mismatch').map((r) => r.object),
    // 下游这一版到底有没有发布尺寸 —— 决定"尺寸语义"是"验过了"还是"还没验"。
    dimensions_published: objects.some((o) => Array.isArray(o?.dimensions)),
    size_asserted: rows.length > 0 && rows.every((r) => r.size_asserted === true),
    // 场景里不属于本次意图的对象（--factory-startup 会带来 Cube/Light/Camera）。**不是失败。**
    extra_objects: objects.filter((o) => !expectedNames.has(o?.name)).map((o) => o?.name),
  }
}
