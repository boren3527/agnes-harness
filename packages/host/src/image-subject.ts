import { deflateSync, inflateSync } from 'node:zlib'
import { decodeSafeImageBytes } from '@agnes/protocol-validation'

export const SUBJECT_LIMITS = {
  maxBytesPerImage: 16 * 1024 * 1024,
  maxAggregateBytes: 32 * 1024 * 1024,
  maxPixelsPerImage: 2048 * 2048,
  maxAggregatePixels: 16 * 1024 * 1024,
}

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(name: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(name, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4)
  return out
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c,
    x = Math.abs(p - a),
    y = Math.abs(p - b),
    z = Math.abs(p - c)
  return x <= y && x <= z ? a : y <= z ? b : c
}

/** Bounded PNG decode. Preserve real alpha; otherwise remove only near-white border-connected pixels. */
export function transparentSubject(input: Uint8Array): {
  bytes: Uint8Array
  width: number
  height: number
  background: 'model-alpha' | 'white-border'
} {
  const image = decodeSafeImageBytes({ bytes: input, mimeType: 'image/png' }, SUBJECT_LIMITS)
  const png = Buffer.from(image.bytes)
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0
  if (!channels || png[24] !== 8 || png[28] !== 0) throw new Error('IMAGE_UNSUPPORTED_PNG')
  const data: Buffer[] = []
  for (let pos = 8; pos < png.length; ) {
    const len = png.readUInt32BE(pos)
    if (png.toString('ascii', pos + 4, pos + 8) === 'IDAT') data.push(png.subarray(pos + 8, pos + 8 + len))
    pos += len + 12
  }
  const { width, height } = image,
    stride = width * channels
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height })
  if (raw.length !== (stride + 1) * height) throw new Error('IMAGE_INVALID_PNG')
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number
    if (filter > 4) throw new Error('IMAGE_INVALID_PNG')
    for (let x = 0; x < stride; x++) {
      const idx = y * stride + x,
        a = x >= channels ? (pixels[idx - channels] as number) : 0
      const b = y ? (pixels[idx - stride] as number) : 0,
        c = y && x >= channels ? (pixels[idx - stride - channels] as number) : 0
      const delta =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? Math.floor((a + b) / 2)
              : filter === 4
                ? paeth(a, b, c)
                : 0
      pixels[idx] = ((raw[y * (stride + 1) + x + 1] as number) + delta) & 255
    }
  }
  const count = width * height,
    rgba = Buffer.alloc(count * 4)
  let transparent = 0,
    opaque = 0
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 3; j++) rgba[i * 4 + j] = pixels[i * channels + j] as number
    rgba[i * 4 + 3] = channels === 4 ? (pixels[i * 4 + 3] as number) : 255
    if ((rgba[i * 4 + 3] as number) < 16) transparent++
    if ((rgba[i * 4 + 3] as number) > 240) opaque++
  }
  let background: 'model-alpha' | 'white-border' = 'model-alpha'
  const hasTransparentBorder = () => {
    let clear = 0
    for (let x = 0; x < width; x++) {
      if ((rgba[x * 4 + 3] as number) < 16) clear++
      if ((rgba[((height - 1) * width + x) * 4 + 3] as number) < 16) clear++
    }
    for (let y = 0; y < height; y++) {
      if ((rgba[y * width * 4 + 3] as number) < 16) clear++
      if ((rgba[(y * width + width - 1) * 4 + 3] as number) < 16) clear++
    }
    return clear >= width + height
  }
  if (transparent < count * 0.01 || !hasTransparentBorder()) {
    background = 'white-border'
    const visited = new Uint8Array(count),
      queue = new Uint32Array(count)
    let head = 0,
      tail = 0
    const add = (i: number) => {
      if (visited[i]) return
      visited[i] = 1
      const k = i * 4
      if ((rgba[k] as number) < 245 || (rgba[k + 1] as number) < 245 || (rgba[k + 2] as number) < 245) return
      queue[tail++] = i
      rgba[k + 3] = 0
    }
    for (let x = 0; x < width; x++) {
      add(x)
      add((height - 1) * width + x)
    }
    for (let y = 0; y < height; y++) {
      add(y * width)
      add(y * width + width - 1)
    }
    while (head < tail) {
      const i = queue[head++] as number,
        x = i % width
      if (x) add(i - 1)
      if (x + 1 < width) add(i + 1)
      if (i >= width) add(i - width)
      if (i + width < count) add(i + width)
    }
    transparent = 0
    opaque = 0
    for (let i = 0; i < count; i++) {
      if ((rgba[i * 4 + 3] as number) < 16) transparent++
      if ((rgba[i * 4 + 3] as number) > 240) opaque++
    }
  }
  if (transparent < count * 0.01 || opaque < count * 0.01 || !hasTransparentBorder())
    throw new Error('IMAGE_BACKGROUND_UNVERIFIED')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return {
    bytes: Buffer.concat([
      png.subarray(0, 8),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
    width,
    height,
    background,
  }
}
