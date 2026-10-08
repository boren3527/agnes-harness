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
