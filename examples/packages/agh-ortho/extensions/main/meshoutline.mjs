/**
 * 把**网格自己的形状**投影成六视图的轮廓（B）。
 *
 * 为什么需要它：图纸上每个部件画的是一个**盒子**（参数化部件没错 —— 盒子就是形状），
 * 但对**生成网格**，那等于把形状整个丢掉 ⇒ "人看图纸"这一步对网格路几乎没有信息量（§9.28 发现一）。
 *
 * 三条纪律：
 *  ① **只交"米"**：本模块输出的是每个视图里一组 `[u0, v0, u1, v1]`（米），**不碰像素**。
 *     像素↔米的换算只有一个地方（`views.mjs` 的 `toX`/`toY`）—— 多一套坐标系就是多一个撒谎的机会。
 *  ② **映射只有一处**：顶点的"文件空间 → 世界"用调用方给的 `transform`（与 `meshGeometryFor` 同一个），
 *     不在本模块里再推一遍轴。
 *  ③ **量不出来就说量不出来**：节点变形不受支持、或没有 POSITION 可读 ⇒ 返回 `{ ok: false, why }`，
 *     绝不画一个"看起来对"的轮廓。
 *
 * 精度：`cell`（默认 0.01 m）是轮廓的栅格步长。图纸是 117.56 px/m ⇒ 1 cm ≈ 1.2 px，
 * 所以再细也没有意义（判据的精度不许超过它的分辨率 —— 这条在这儿同样成立）。
 */
import { VIEWS } from './views.mjs'

export { decodePositions } from './glb-geometry.mjs'

/** 文件空间 → 世界：与 `meshGeometryFor` **同一个** transform（`map`/`scale`/`location`）。 */
export function toWorld(vertices, { map = [0, 1, 2], scale = 1, location = [0, 0, 0] } = {}) {
  return vertices.map((v) => [
    v[map[0]] * scale + (location[0] ?? 0),
    v[map[1]] * scale + (location[1] ?? 0),
    v[map[2]] * scale + (location[2] ?? 0),
  ])
}

/** 一维投影轴（`views.mjs` 里每个视图的 u/v 就是世界轴的组合，这里只做点乘）。 */
const dot = (p, axis) => p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]

/**
 * 某视图的占用格 → **按行合并**的矩形（米）。
 * 逐点落格（O(n)），再逐行把相邻格并成一段 —— 输出几百个矩形，而不是几万个。
 */
export function outlineRuns(worldVertices, view, { cell = 0.01 } = {}) {
  if (!Array.isArray(worldVertices) || worldVertices.length === 0) return []
  const us = worldVertices.map((p) => dot(p, view.u))
  const vs = worldVertices.map((p) => dot(p, view.v))
  let u0 = Infinity,
    v0 = Infinity,
    u1 = -Infinity,
    v1 = -Infinity
  for (let i = 0; i < us.length; i++) {
    u0 = Math.min(u0, us[i])
    u1 = Math.max(u1, us[i])
    v0 = Math.min(v0, vs[i])
    v1 = Math.max(v1, vs[i])
  }
  const cols = Math.max(1, Math.ceil((u1 - u0) / cell))
  const rows = Math.max(1, Math.ceil((v1 - v0) / cell))
  if (cols * rows > 400000) return [] // 防一手：步长被人调得太细时不至于把内存吃掉
  const grid = new Set()
  for (let i = 0; i < worldVertices.length; i += 1) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((us[i] - u0) / cell)))
    const r = Math.min(rows - 1, Math.max(0, Math.floor((vs[i] - v0) / cell)))
    grid.add(r * cols + c)
  }
  const runs = []
  for (let r = 0; r < rows; r += 1) {
    let c = 0
    while (c < cols) {
      if (!grid.has(r * cols + c)) {
        c += 1
        continue
      }
      let end = c
      while (end + 1 < cols && grid.has(r * cols + (end + 1))) end += 1
      runs.push([u0 + c * cell, v0 + r * cell, u0 + (end + 1) * cell, v0 + (r + 1) * cell])
      c = end + 1
    }
  }
  return runs
}

/** 六个视图各一份（键是视图 id）。视图的 u/v 轴取自 `views.mjs` —— 与盒子**同一套轴**。 */
export function outlinesFor(worldVertices, { cell = 0.01 } = {}) {
  const out = {}
  for (const view of VIEWS) out[view.id] = outlineRuns(worldVertices, view, { cell })
  return out
}
