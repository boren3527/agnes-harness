// 自己解 PNG（zlib + 反 filter），量"内容占画面"与"内容包围盒是否贴到画幅边缘"。
// 后者才是判据：贴边 = 被裁掉 = "整个人形不在画面里"；不贴边 = 整只都在，只是小。
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function decodePng(path) {
  const buf = readFileSync(path)
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6))
    throw new Error(`unsupported png: depth ${bitDepth} color ${colorType}`)
  const channels = colorType === 2 ? 3 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]
    rp += 1
    const row = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const x = row[i]
      let v
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`bad filter ${filter}`)
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, channels, pixels: out }
}

function measure(path) {
  const { width, height, channels, pixels } = decodePng(path)
  const counts = new Map()
  for (let i = 0; i < pixels.length; i += channels) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const total = width * height
  const [bgKey, bgCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const bg = [(bgKey >> 16) & 0xff, (bgKey >> 8) & 0xff, bgKey & 0xff]
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let content = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      const d = Math.max(
        Math.abs(pixels[i] - bg[0]),
        Math.abs(pixels[i + 1] - bg[1]),
        Math.abs(pixels[i + 2] - bg[2]),
      )
      if (d > 12) {
        content += 1
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  // 只算"亮"的像素（模型是浅灰，网格/坐标轴是细线）：更贴近"模型本体占多少"
  let bright = 0
  let bMinX = width
  let bMinY = height
  let bMaxX = -1
  let bMaxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      if (pixels[i] > 90 && pixels[i + 1] > 90 && pixels[i + 2] > 90) {
        bright += 1
        if (x < bMinX) bMinX = x
        if (y < bMinY) bMinY = y
        if (x > bMaxX) bMaxX = x
        if (y > bMaxY) bMaxY = y
      }
    }
  }
  return {
    file: path.split('\\').pop(),
    size: `${width}x${height}`,
    background_rgb: bg.join(','),
    background_share: `${((bgCount / total) * 100).toFixed(1)}%`,
    distinct_colors: counts.size,
    content_share: `${((content / total) * 100).toFixed(1)}%`,
    bright_body_share: `${((bright / total) * 100).toFixed(1)}%`,
    content_bbox:
      maxX < 0 ? null : { x: [minX, maxX], y: [minY, maxY], w: maxX - minX + 1, h: maxY - minY + 1 },
    touches_edges:
      maxX < 0
        ? null
        : { left: minX <= 1, right: maxX >= width - 2, top: minY <= 1, bottom: maxY >= height - 2 },
    // 判据在这里：**模型本体**的包围盒是否贴到画幅边缘 ⇒ 被裁掉了。
    body_bbox:
      bMaxX < 0
        ? null
        : {
            x: [bMinX, bMaxX],
            y: [bMinY, bMaxY],
            w: bMaxX - bMinX + 1,
            h: bMaxY - bMinY + 1,
            cx: Math.round((bMinX + bMaxX) / 2),
            cy: Math.round((bMinY + bMaxY) / 2),
          },
    body_touches_edges:
      bMaxX < 0
        ? null
        : { left: bMinX <= 1, right: bMaxX >= width - 2, top: bMinY <= 1, bottom: bMaxY >= height - 2 },
  }
}

const dir = '.agh-blender/instances'
const targets = [
  `${dir}/62d5f8cb-65da-458d-9a11-da27ee9904d5/captures/422c2887-1214-42c7-a589-7b269920b990.png`,
  `${dir}/29c4cc84-2be5-4de8-905c-2c2f9b88ea57/captures/62fa2ae7-ec50-451d-93c1-973dfbbb2973.png`,
]
for (const t of targets) console.log(JSON.stringify(measure(t), null, 2))
