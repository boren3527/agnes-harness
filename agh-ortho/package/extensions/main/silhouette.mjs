// 剪影数值化（SILHOUETTE-PLAN §3/§4）：把一张**带透明通道**的渲染图变成一组数，
// 好让"轮廓像不像"能被机器比，而不是只能靠人眼。
//
// 三条设计约束，都是被实测逼出来的：
//   1. **零依赖**：插件不引外部包（PNG 解码用 node:zlib + 手工反 filter 就够 —— 我们只关心 alpha）。
//   2. **不猜背景**：只接受带 alpha 的 PNG（colorType 4/6）。RGB 图要"前景 vs 背景"必须猜一个背景色，
//      而猜出来的阈值会静默决定判定结果 —— 那正是本项目一直在避免的"静默错误"。所以直接拒绝，并说明
//      该怎么渲（`transparent: true`）。
//   3. **判据精度不能超过渲染精度**：容差由**每像素多少米**推出（≥2 像素），不许拍一个固定小容差 ——
//      渲染是采样，1 像素就是它的分辨极限。
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const HAS_ALPHA = { 4: true, 6: true }

/** 解码 8-bit、非隔行的 PNG。只支持插值需要的部分，遇到别的**明确报错**（不静默降级）。 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (bad signature)')
  let offset = 8
  let ihdr = null
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!ihdr) throw new Error('no IHDR chunk')
  if (ihdr.bitDepth !== 8) throw new Error(`only 8-bit PNGs are supported (got bit depth ${ihdr.bitDepth})`)
  if (ihdr.interlace !== 0) throw new Error('interlaced PNGs are not supported')
  const channels = CHANNELS[ihdr.colorType]
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`)
  if (idat.length === 0) throw new Error('no IDAT chunk')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = ihdr.width * channels
  const need = ihdr.height * (stride + 1)
  if (raw.length < need) throw new Error(`truncated image data (need ${need} bytes, got ${raw.length})`)
  const pixels = Buffer.alloc(ihdr.height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rowStart + i]
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v
      if (filter === 0) v = x
      else if (filter === 1) v = (x + a) & 0xff
      else if (filter === 2) v = (x + b) & 0xff
      else if (filter === 3) v = (x + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else throw new Error(`unknown row filter ${filter}`)
      cur[i] = v
    }
    cur.copy(pixels, y * stride)
    prev = cur
  }
  return { width: ihdr.width, height: ihdr.height, channels, colorType: ihdr.colorType, pixels }
}

/**
 * 剪影度量。**只接受带 alpha 的图**（见文件头第 2 条）。
 * `alphaThreshold`：alpha **大于**它就当作前景（0 ⇒ 只要不是全透明就算）。
 */
export function silhouetteOf(bytes, { alphaThreshold = 0 } = {}) {
  const png = decodePng(bytes)
  if (!HAS_ALPHA[png.colorType]) {
    throw new Error(
      `this PNG has no alpha channel (colour type ${png.colorType}); a silhouette cannot be separated from a background without guessing a background colour, which would silently decide the verdict. Render with transparency instead (transparent: true).`,
    )
  }
  const { width, height, channels, pixels } = png
  const alphaIndex = channels - 1
  let covered = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * channels + alphaIndex] > alphaThreshold) {
        covered += 1
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (covered === 0) {
    return { width, height, covered_fraction: 0, bbox_px: null, touches_edges: null, aspect_px: null, covered_pixels: 0 }
  }
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  return {
    width,
    height,
    covered_pixels: covered,
    covered_fraction: Number((covered / (width * height)).toFixed(6)),
    bbox_px: { x0, y0, x1, y1, width: bw, height: bh },
    touches_edges: { left: x0 === 0, right: x1 === width - 1, top: y0 === 0, bottom: y1 === height - 1 },
    // 宽高比与像素无关，是两侧**主要**可比的那个量。
    aspect_px: Number((bw / bh).toFixed(6)),
  }
}

/**
 * 每像素多少米。**只由 ortho_scale + sensor_fit + 图像尺寸推**，不许估。
 * Blender 语义：`ortho_scale` 跨的是 **sensor_fit 那一根轴**；`AUTO` 贴的是**较长的那一边**。
 * （下游自己在 capture 取景时踩过这个坑：AUTO 会把 36mm 贴到长边。）
 */
export function metresPerPixel({ orthoScale, sensorFit, width, height }) {
  const s = Number(orthoScale)
  if (!(s > 0) || !(width > 0) || !(height > 0)) return null
  const fit = sensorFit === 'HORIZONTAL' || sensorFit === 'VERTICAL' ? sensorFit : width >= height ? 'HORIZONTAL' : 'VERTICAL'
  return s / (fit === 'HORIZONTAL' ? width : height)
}

/**
 * 比较。两个可比的量：
 *   - `outline`（我们参数侧算出来的 u/v 跨度，米）⇒ 几何是否自洽；
 *   - `expectedAspect`（来自 photo_check 的区间中点）⇒ 像不像照片。
 * 容差 = max(2 像素折算成米, 相对 1%) —— 见文件头第 3 条。
 */
export function compareSilhouette(silhouette, { orthoScale, sensorFit, outline, expectedAspect, expectedRange, minPixels = 2, relativeTolerance = 0.01 } = {}) {
  const out = { view: silhouette?.view ?? null, blockers: [] }
  if (!silhouette || silhouette.aspect_px === null || silhouette.aspect_px === undefined) {
    out.blockers.push({ code: 'E_SILHOUETTE_EMPTY', message: 'the render contains no foreground pixels, so there is no outline to compare' })
    return out
  }
  const mpp = metresPerPixel({ orthoScale, sensorFit, width: silhouette.width, height: silhouette.height })
  if (mpp === null) {
    out.blockers.push({
      code: 'E_SILHOUETTE_NO_SCALE',
      message: 'there is no pixel-to-metre mapping: ortho_scale and the image size are both required, and ortho_scale cannot be guessed (a guessed scale would silently decide the verdict)',
    })
    return out
  }
  // 被裁掉的剪影必须**挡住**，不能只是记一笔：轮廓不完整时，由它推出的每个数都"看起来合法但是错的"。
  // 下游实测过这件事 —— 相机偏了半格，一个 2.0 m 的物体量出来是 1.2 m。
  const edge = silhouette.touches_edges
  if (edge && (edge.left || edge.right || edge.top || edge.bottom)) {
    const sides = ['left', 'right', 'top', 'bottom'].filter((s) => edge[s])
    out.blockers.push({
      code: 'E_SILHOUETTE_CROPPED',
      message: `the silhouette touches the frame on the ${sides.join(' / ')} side(s), so its outline is incomplete and every number derived from it is plausible but wrong (the downstream measured 1.2 m for a 2.0 m object from exactly this). Frame the whole object before comparing.`,
    })
  }
  const sizeM = { width: silhouette.bbox_px.width * mpp, height: silhouette.bbox_px.height * mpp }
  const tolerance = Math.max(minPixels * mpp, relativeTolerance * Math.max(sizeM.width, sizeM.height))
  const aspect = sizeM.width / sizeM.height
  out.metres_per_pixel = mpp
  out.size_m = { width: Number(sizeM.width.toFixed(6)), height: Number(sizeM.height.toFixed(6)) }
  out.aspect = Number(aspect.toFixed(6))
  out.tolerance_m = Number(tolerance.toFixed(6))
  out.tolerance_source = `max(${minPixels} px = ${(minPixels * mpp).toFixed(6)} m, ${relativeTolerance * 100}% = ${(relativeTolerance * Math.max(sizeM.width, sizeM.height)).toFixed(6)} m) so the criterion is never finer than the render's own sampling`
  if (outline && Number.isFinite(Number(outline.u_span)) && Number.isFinite(Number(outline.v_span))) {
    const outlineAspect = Number(outline.u_span) / Number(outline.v_span)
    out.outline_aspect = Number(outlineAspect.toFixed(6))
    out.aspect_delta = Number(Math.abs(aspect - outlineAspect).toFixed(6))
    out.matches_outline = out.aspect_delta <= tolerance
    if (!out.matches_outline) {
      out.blockers.push({
        code: 'E_SILHOUETTE_OFF_OUTLINE',
        message: `the rendered silhouette's aspect is ${out.aspect} but the parameter side computes ${out.outline_aspect} for the same view; the difference ${out.aspect_delta} exceeds the tolerance ${out.tolerance_m} (derived from the render's own resolution). Either the render is not the view we think it is, or the parameters do not describe the scene.`,
      })
    }
  }
  // 与照片比：**认照片读数写下的那个区间**（宽度按它的写入精度放宽），与 photo_check 同一套口径。
  // 实测抓到过同一件事两个结论：`photo_check` 的区间判定说 inside:true，而这里拿"区间中点 ± 渲染容差"
  // 去比，说差 0.033 > 容差 0.0097 ⇒ 挡住。一个事实两套判据、两个结论，读者无从解释。
  // 所以**区间是判据**；中点距离只作为信息印出来，不参与判定。
  if (expectedRange && Number.isFinite(Number(expectedRange.min)) && Number.isFinite(Number(expectedRange.max))) {
    const bound = Number(expectedRange.boundTolerance ?? 0)
    const lo = Number(expectedRange.min) - bound
    const hi = Number(expectedRange.max) + bound
    const mid = (Number(expectedRange.min) + Number(expectedRange.max)) / 2
    out.photo_range = {
      min: Number(expectedRange.min),
      max: Number(expectedRange.max),
      bound_tolerance: bound,
      widened_to: [Number(lo.toFixed(6)), Number(hi.toFixed(6))],
    }
    out.expected_aspect = Number(mid.toFixed(6))
    out.aspect_vs_photo = Number((aspect < lo ? lo - aspect : aspect > hi ? aspect - hi : 0).toFixed(6))
    out.aspect_vs_photo_midpoint = Number(Math.abs(aspect - mid).toFixed(6))
    out.matches_photo = aspect >= lo && aspect <= hi
    if (!out.matches_photo) {
      out.blockers.push({
        code: 'E_SILHOUETTE_OFF_PHOTO',
        message: `the rendered silhouette's aspect is ${out.aspect}, outside the photo reading's interval ${Number(expectedRange.min)}..${Number(expectedRange.max)} (widened by its own writing precision to ${Number(lo.toFixed(6))}..${Number(hi.toFixed(6))}); it misses the nearest bound by ${out.aspect_vs_photo}. The interval IS the criterion — do not widen it, and do not copy the computed value in.`,
      })
    }
  } else if (expectedAspect !== null && expectedAspect !== undefined && Number.isFinite(Number(expectedAspect))) {
    const want = Number(expectedAspect)
    out.expected_aspect = Number(want.toFixed(6))
    out.aspect_vs_photo = Number(Math.abs(aspect - want).toFixed(6))
    out.matches_photo = out.aspect_vs_photo <= tolerance
    if (!out.matches_photo) {
      out.blockers.push({
        code: 'E_SILHOUETTE_OFF_PHOTO',
        message: `the rendered silhouette's aspect is ${out.aspect} while the photo reading expects ${out.expected_aspect}; the difference ${out.aspect_vs_photo} exceeds the tolerance ${out.tolerance_m}.`,
      })
    }
  }
  out.ok = out.blockers.length === 0
  return out
}
