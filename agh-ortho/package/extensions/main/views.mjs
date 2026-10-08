/**
 * views.mjs —— 正交六视图的投影、SVG 与 numeric 残差（纯函数，零依赖）。
 *
 * 下游**没有相机 op**（CONTRACT §3.4）：agh_blender_capture 只抓当前 GUI 视口，严格正交六视图
 * 下游给不了，必须自己渲染。纯 JS 正交投影 + 包围盒足以覆盖 6 种基元的装配体。
 *
 * 输出主选 SVG 而不是 PNG 的理由（CONTRACT §8.2 + 上游契约 §2.3）：模型**看不到**工具产出的
 * 图片像素，但 SVG 是文本 ⇒ 模型能直接读视图的几何。这也是 M1 把 views 做成"只返回文本、
 * 不落盘"的原因：没有副效应，就不需要描述符层。
 */

export const VIEW_CONVENTION =
  'up = +Z, front = -Y, right-handed (CONTRACT §4.1). u = screen right, v = screen up, look = viewer → scene. 这套 u/v 方向是本插件采用的约定，尚未对照 GB/T 17451 逐条核过。'

// CONTRACT §8.1。每张视图只观测 2 个轴 ⇒ X / Y / Z 各被 4 张视图观测，这就是交叉一致性的来源。
export const VIEWS = [
  { id: 'front', label: '主视图 front', look: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { id: 'top', label: '俯视图 top', look: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
  { id: 'left', label: '左视图 left', look: [1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { id: 'right', label: '右视图 right', look: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { id: 'bottom', label: '仰视图 bottom', look: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { id: 'back', label: '后视图 back', look: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
]

const AXES = ['x', 'y', 'z']

function unitAxis(vector) {
  for (let i = 0; i < 3; i += 1) {
    if (vector[i] !== 0) {
      if (Math.abs(vector[i]) !== 1) throw new Error('a view basis vector must be a signed unit axis')
      return { axis: AXES[i], sign: vector[i] }
    }
  }
  throw new Error('a view basis vector must not be the zero vector')
}

const dot = (p, vec) => p[0] * vec[0] + p[1] * vec[1] + p[2] * vec[2]

/**
 * 六视图的**第一角法/第三角法**排布（CONTRACT §8.1）。
 * 第三角法左右上下相反 ⇒ 所以 projection 必须写进产物，否则图纸读不回来。
 */
export function sheetPlacement(projection) {
  const first = projection !== 'third_angle'
  const sign = first ? 1 : -1
  // col 相对主视图向右为正；row 向下为正。
  // 第三角法两个方向都相反（第一角法：俯视图在下、左视图在右；第三角法：俯视图在上、左视图在左）。
  // 注意 CONTRACT §8.1 的注只说"左右相反"，那是简化说法；标准（GB/T 17451 / ANSI Y14.3）
  // 是上下也反。这里按标准实现，落图前请对照标准复核。
  return {
    convention: first ? 'first_angle' : 'third_angle',
    front: { col: 0, row: 0 },
    top: { col: 0, row: 1 * sign },
    bottom: { col: 0, row: -1 * sign },
    left: { col: 1 * sign, row: 0 },
    right: { col: -1 * sign, row: 0 },
    back: { col: 2 * sign, row: 0 },
  }
}

/** 一个包围盒在某视图上的 2D 范围。用 8 个角点算，符号约定自动跟随视图基底。 */
export function projectBox(box, view) {
  const us = []
  const vs = []
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        us.push(dot([x, y, z], view.u))
        vs.push(dot([x, y, z], view.v))
      }
    }
  }
  return { u: [Math.min(...us), Math.max(...us)], v: [Math.min(...vs), Math.max(...vs)] }
}

/** 六视图的矩形集合。rects 与传入 boxes **按序对齐**（所以调用方不必依赖对象名）。 */
export function sixViewRects(boxes) {
  return VIEWS.map((view) => {
    const rects = boxes.map((box) => projectBox(box, view))
    const us = rects.map((r) => r.u).flat()
    const vs = rects.map((r) => r.v).flat()
    return {
      id: view.id,
      label: view.label,
      look: view.look,
      u: view.u,
      v: view.v,
      names: boxes.map((b) => b.name),
      rects,
      bbox: us.length ? { u: [Math.min(...us), Math.max(...us)], v: [Math.min(...vs), Math.max(...vs)] } : null,
    }
  })
}

/** 从 u/v 范围反解出被观测轴的 { centre, size }。sign 处理 u = -X 这类镜像。 */
function measure(range, sign) {
  return { centre: (sign * (range[0] + range[1])) / 2, size: range[1] - range[0] }
}

/**
 * numeric 校验（CONTRACT §9 `numeric` 档，不需要 Blender）：
 *   参数 → ops → 包围盒 → 六视图 → **从视图反解** → 与参数比对
 * 残差必须为 0。同时检查交叉一致性：同一个轴被 4 张视图观测，4 个观测值必须彼此相等。
 *
 * 返回 max 与逐项明细。max 非 0 就是几何不自洽 —— 不接受任何"接近 0"。
 */
export function residual(paramExtents, views, boxes) {
  const rows = []
  let max = 0
  let worst = null

  for (const [index, params] of paramExtents.entries()) {
    if (!boxes[index]) {
      rows.push({ object: params.name, axis: '*', note: 'this item has no box in the emitted ops' })
      max = Infinity
      continue
    }
    for (const axis of AXES) {
      const observations = []
      for (const view of views) {
        const rect = view.rects[index]
        if (!rect) continue
        const uAxis = unitAxis(view.u)
        const vAxis = unitAxis(view.v)
        if (uAxis.axis === axis) observations.push({ view: view.id, ...measure(rect.u, uAxis.sign) })
        if (vAxis.axis === axis) observations.push({ view: view.id, ...measure(rect.v, vAxis.sign) })
      }
      if (observations.length === 0) {
        rows.push({ object: params.name, axis, observed_by: [], note: 'no view observes this axis' })
        max = Infinity
        continue
      }
      const centres = observations.map((o) => o.centre)
      const sizes = observations.map((o) => o.size)
      const spread = Math.max(...centres) - Math.min(...centres)
      const delta = Math.max(
        ...centres.map((c) => Math.abs(c - params[axis].centre)),
        ...sizes.map((s) => Math.abs(s - params[axis].size)),
      )
      const here = Math.max(delta, spread)
      if (here > max) {
        max = here
        worst = `${params.name}.${axis}`
      }
      rows.push({
        object: params.name,
        axis,
        observed_by: observations.map((o) => o.view),
        from_params: { centre: params[axis].centre, size: params[axis].size },
        from_views: { centre: centres[0], size: sizes[0] },
        cross_view_spread: spread,
        delta,
      })
    }
  }
  return { max, worst, rows }
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------
const SVG_W = 520
const SVG_H = 380
const PAD = 56
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 同一张图纸上的视图必须**共用比例尺** —— 逐视图各自自适应缩放在工程图上是错的。
 * 取所有视图包络里较大的那个跨度来定一个共同 scale。
 */
export function commonScale(views, { width = SVG_W, height = SVG_H, pad = PAD } = {}) {
  const spans = views
    .filter((v) => v.bbox)
    .map((v) => ({ u: v.bbox.u[1] - v.bbox.u[0] || 1, v: v.bbox.v[1] - v.bbox.v[0] || 1 }))
  if (spans.length === 0) return 1
  const maxU = Math.max(...spans.map((s) => s.u))
  const maxV = Math.max(...spans.map((s) => s.v))
  return Math.min((width - 2 * pad) / maxU, (height - 2 * pad) / maxV)
}

/**
 * 一张视图一个 SVG（CONTRACT §8.2：正交视图本质是线条图，SVG 可度量、可 diff、模型可读）。
 * 自写的正交投影 ⇒ 不需要任何渲染依赖，也不碰"图片块毒化会话"那条线。
 */
export function svgFor(view, sheet, options = {}) {
  const box = view.bbox
  const u0 = box ? box.u[0] : -1
  const u1 = box ? box.u[1] : 1
  const v0 = box ? box.v[0] : -1
  const v1 = box ? box.v[1] : 1
  const spanU = u1 - u0 || 1
  const spanV = v1 - v0 || 1
  // options.scale 由 commonScale() 传入 ⇒ 同一图纸上的所有视图比例一致。
  const scale = options.scale ?? Math.min((SVG_W - 2 * PAD) / spanU, (SVG_H - 2 * PAD) / spanV)
  const offX = PAD + ((SVG_W - 2 * PAD) - spanU * scale) / 2
  const offY = PAD + ((SVG_H - 2 * PAD) - spanV * scale) / 2
  const toX = (u) => offX + (u - u0) * scale
  const toY = (v) => SVG_H - offY - (v - v0) * scale

  const parts = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}">`,
    `<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`,
    `<g font-family="monospace" font-size="11" fill="#555">`,
    `<text x="12" y="18">${esc(view.label)} · look (${view.look.join(',')}) · u (${view.u.join(',')}) · v (${view.v.join(',')})</text>`,
    `<text x="12" y="32">sheet col/row ${sheet.col}/${sheet.row} · scale 1:${(1 / scale).toFixed(3)} (px per unit)</text>`,
    `</g>`,
  )
  for (const [index, rect] of view.rects.entries()) {
    const x = toX(rect.u[0])
    const y = toY(rect.v[1])
    const w = Math.max(1, (rect.u[1] - rect.u[0]) * scale)
    const h = Math.max(1, (rect.v[1] - rect.v[0]) * scale)
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="rgba(40,90,160,0.10)" stroke="#285aa0" stroke-width="1.2"/>`,
      `<text x="${x.toFixed(2)}" y="${(y - 3).toFixed(2)}" font-family="monospace" font-size="10" fill="#285aa0">${esc(view.names[index])} ${(rect.u[1] - rect.u[0]).toFixed(3)}×${(rect.v[1] - rect.v[0]).toFixed(3)}</text>`,
    )
  }
  if (box) {
    parts.push(
      `<rect x="${toX(u0).toFixed(2)}" y="${toY(v1).toFixed(2)}" width="${((u1 - u0) * scale).toFixed(2)}" height="${((v1 - v0) * scale).toFixed(2)}" fill="none" stroke="#b03030" stroke-width="0.8" stroke-dasharray="4 3"/>`,
      `<text x="12" y="${SVG_H - 10}" font-family="monospace" font-size="10" fill="#b03030">extent u ${(u1 - u0).toFixed(3)} · v ${(v1 - v0).toFixed(3)}</text>`,
    )
  }
  parts.push('</svg>')
  return parts.join('\n')
}
