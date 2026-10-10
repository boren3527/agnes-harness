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
 *  ③ **量不出来就说量不出来**：节点带旋转、或没有 POSITION 可读 ⇒ 返回 `{ ok: false, why }`，
 *     绝不画一个"看起来对"的轮廓。
 *
 * 精度：`cell`（默认 0.01 m）是轮廓的栅格步长。图纸是 117.56 px/m ⇒ 1 cm ≈ 1.2 px，
 * 所以再细也没有意义（判据的精度不许超过它的分辨率 —— 这条在这儿同样成立）。
 */
import { VIEWS } from './views.mjs'

const COMPONENTS = { 5126: { size: 4, read: (b, o) => b.readFloatLE(o) } }

function parseGlb(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') return { ok: false, why: 'not a GLB (bad magic)' }
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'JSON') {
      try {
        json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
      } catch (error) {
        return { ok: false, why: `the JSON chunk did not parse (${error?.message ?? error})` }
      }
    } else if (type === 'BIN\0') {
      bin = buf.subarray(off + 8, off + 8 + len)
    }
    off += 8 + len
  }
  if (!json) return { ok: false, why: 'no JSON chunk' }
  if (!bin) return { ok: false, why: 'no BIN chunk: the vertex data is not in this file' }
  return { ok: true, json, bin }
}

/**
 * 读出所有 POSITION 顶点（**文件空间**，只施加节点自己的 translation/scale）。
 * 节点带旋转时**拒绝**（与 `glbWorldBounds` 同一条纪律：轴对齐的盒子/投影对旋转是错的）。
 */
export function decodePositions(bytes) {
  const parsed = parseGlb(bytes)
  if (!parsed.ok) return parsed
  const { json, bin } = parsed
  const nodes = Array.isArray(json.nodes) ? json.nodes : []
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  const accessors = Array.isArray(json.accessors) ? json.accessors : []
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : []
  const out = []
  let nodeCount = 0
  for (const node of nodes) {
    if (node?.mesh === undefined) continue
    const q = Array.isArray(node.rotation) ? node.rotation : null
    if (q && q.some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-6)) {
      return { ok: false, why: 'a node carries a rotation: an axis-aligned projection of it would be wrong' }
    }
    const s = Array.isArray(node.scale) ? node.scale : [1, 1, 1]
    const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0]
    nodeCount += 1
    for (const prim of meshes[node.mesh]?.primitives ?? []) {
      const acc = accessors[prim?.attributes?.POSITION]
      if (!acc || acc.type !== 'VEC3') return { ok: false, why: 'a POSITION accessor is missing or is not VEC3' }
      const fmt = COMPONENTS[acc.componentType]
      if (!fmt) return { ok: false, why: `unsupported POSITION componentType ${acc.componentType} (want 5126 float32)` }
      const bv = bufferViews[acc.bufferView]
      if (!bv) return { ok: false, why: 'a POSITION accessor has no bufferView' }
      const stride = bv.byteStride ?? 3 * fmt.size
      const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
      for (let i = 0; i < acc.count; i += 1) {
        const at = base + i * stride
        if (at + 3 * fmt.size > bin.length) return { ok: false, why: 'the vertex data runs past the BIN chunk' }
        out.push([fmt.read(bin, at) * s[0] + t[0], fmt.read(bin, at + 4) * s[1] + t[1], fmt.read(bin, at + 8) * s[2] + t[2]])
      }
    }
  }
  if (nodeCount === 0 || out.length === 0) return { ok: false, why: 'no mesh node with readable vertices' }
  return { ok: true, vertices: out, nodes: nodeCount }
}

/** 文件空间 → 世界：与 `meshGeometryFor` **同一个** transform（`map`/`scale`/`location`）。 */
export function toWorld(vertices, { map = [0, 1, 2], scale = 1, location = [0, 0, 0] } = {}) {
  return vertices.map((v) => [v[map[0]] * scale + (location[0] ?? 0), v[map[1]] * scale + (location[1] ?? 0), v[map[2]] * scale + (location[2] ?? 0)])
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
  const u0 = Math.min(...us)
  const v0 = Math.min(...vs)
  const cols = Math.max(1, Math.ceil((Math.max(...us) - u0) / cell))
  const rows = Math.max(1, Math.ceil((Math.max(...vs) - v0) / cell))
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
