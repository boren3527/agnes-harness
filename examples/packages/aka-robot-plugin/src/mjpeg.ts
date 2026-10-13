import { AkaProtocolError } from './protocol.js'

export interface JpegFrame {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

/** Checks JPEG framing and declared dimensions before decoding; not a substitute for a decoder. */
export function jpegDimensions(bytes: Buffer, maxPixels = 16_000_000): { width: number; height: number } {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  ) {
    throw new AkaProtocolError('Incomplete JPEG')
  }
  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) throw new AkaProtocolError('Invalid JPEG marker')
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) break
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
      throw new AkaProtocolError('Unexpected JPEG marker')
    if (marker === 0x01) continue
    if (at + 2 > bytes.length) break
    const length = bytes.readUInt16BE(at)
    if (length < 2 || at + length > bytes.length - 2)
      throw new AkaProtocolError('Invalid JPEG segment length')
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new AkaProtocolError('Invalid JPEG size segment')
      const height = bytes.readUInt16BE(at + 3)
      const width = bytes.readUInt16BE(at + 5)
      if (!width || !height || width > 4096 || height > 4096 || width * height > maxPixels) {
        throw new AkaProtocolError('JPEG dimensions exceed limits')
      }
      return { width, height }
    }
    at += length
  }
  throw new AkaProtocolError('JPEG dimensions missing')
}

export function mjpegBoundary(contentType: string): string {
  const match = /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([\w-]{1,70})"|([\w-]{1,70}))\s*$/i.exec(
    contentType,
  )
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) throw new AkaProtocolError('Invalid MJPEG content type')
  return boundary
}

/** AKA emits Content-Length on every part. Strict framing prevents cross-frame substitution.
 * A malformed stream terminates the parser; the connection owner must report/reconnect it.
 */
export class MjpegParser {
  private storage = Buffer.alloc(4096)
  private buffer = Buffer.alloc(0)
  private state: 'boundary' | 'headers' | 'body' | 'closing' | 'ended' | 'failed' = 'boundary'
  private length = 0
  private readonly delimiter: Buffer
  private readonly maxBuffered: number

  constructor(
    boundary: string,
    private readonly maxFrameBytes = 4 * 1024 * 1024,
  ) {
    if (
      !/^[\w-]{1,70}$/.test(boundary) ||
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 32 ||
      maxFrameBytes > 4 * 1024 * 1024
    ) {
      throw new AkaProtocolError('Invalid MJPEG parser limits')
    }
    this.delimiter = Buffer.from(`--${boundary}`)
    this.maxBuffered = maxFrameBytes + 4096 + this.delimiter.length + 4
  }

  push(chunk: Uint8Array): JpegFrame | undefined {
    if (this.state === 'failed') throw new AkaProtocolError('MJPEG parser has failed')
    const frames: JpegFrame[] = []
    try {
      // Input chunks can be arbitrarily large; never retain an entire transport chunk.
      for (let offset = 0; offset < chunk.length; ) {
        const size = Math.min(16384, chunk.length - offset, this.maxBuffered - this.buffer.length)
        if (size <= 0) throw new AkaProtocolError('MJPEG buffer limit exceeded')
        const slice = chunk.subarray(offset, offset + size)
        offset += size
        this.append(slice)
        this.drain(frames)
      }
      return frames[0]
    } catch (error) {
      this.buffer = Buffer.alloc(0)
      this.state = 'failed'
      throw error
    }
  }

  finish(): void {
    if (
      this.state === 'failed' ||
      this.state === 'headers' ||
      this.state === 'body' ||
      this.buffer.length !== 0
    ) {
      this.buffer = Buffer.alloc(0)
      this.state = 'failed'
      throw new AkaProtocolError('Truncated MJPEG stream')
    }
    this.state = 'ended'
    this.storage = Buffer.alloc(0)
  }

  private append(slice: Uint8Array): void {
    const needed = this.buffer.length + slice.length
    let offset = this.buffer.length ? this.buffer.byteOffset - this.storage.byteOffset : 0
    if (needed > this.storage.length) {
      const storage = Buffer.allocUnsafe(
        Math.min(this.maxBuffered, Math.max(needed, this.storage.length * 2)),
      )
      this.buffer.copy(storage)
      this.storage = storage
      offset = 0
    } else if (offset + needed > this.storage.length) {
      this.buffer.copy(this.storage, 0)
      offset = 0
    }
    this.storage.set(slice, offset + this.buffer.length)
    this.buffer = this.storage.subarray(offset, offset + needed)
  }

  private drain(frames: JpegFrame[]): void {
    while (true) {
      if (this.state === 'closing') {
        if (this.buffer.length < 2) return
        if (this.buffer[0] !== 13 || this.buffer[1] !== 10)
          throw new AkaProtocolError('Invalid MJPEG closing terminator')
        this.buffer = this.buffer.subarray(2)
        this.state = 'ended'
      }
      if (this.state === 'ended') {
        if (this.buffer.length) throw new AkaProtocolError('Data after MJPEG closing boundary')
        return
      }
      if (this.state === 'boundary') {
        if (this.buffer.length < this.delimiter.length + 2) return
        if (!this.buffer.subarray(0, this.delimiter.length).equals(this.delimiter))
          throw new AkaProtocolError('MJPEG boundary mismatch')
        const tail = this.buffer.subarray(this.delimiter.length, this.delimiter.length + 2).toString('ascii')
        if (tail !== '\r\n' && tail !== '--') throw new AkaProtocolError('Invalid MJPEG boundary suffix')
        this.buffer = this.buffer.subarray(this.delimiter.length + 2)
        if (tail === '--') {
          this.state = 'closing'
          continue
        }
        this.state = 'headers'
      }
      if (this.state === 'headers') {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) {
          if (this.buffer.length > 4096) throw new AkaProtocolError('MJPEG headers too large')
          return
        }
        if (end > 4096) throw new AkaProtocolError('MJPEG headers too large')
        const headers = new Map<string, string>()
        for (const line of this.buffer.subarray(0, end).toString('ascii').split('\r\n')) {
          const colon = line.indexOf(':')
          if (colon <= 0) throw new AkaProtocolError('Invalid MJPEG header')
          const name = line.slice(0, colon).toLowerCase()
          if (headers.has(name)) throw new AkaProtocolError('Duplicate MJPEG header')
          headers.set(name, line.slice(colon + 1).trim())
        }
        const size = headers.get('content-length') ?? ''
        if (headers.get('content-type')?.toLowerCase() !== 'image/jpeg' || !/^[1-9]\d{0,7}$/.test(size))
          throw new AkaProtocolError('Invalid JPEG part headers')
        this.length = Number(size)
        if (this.length > this.maxFrameBytes) throw new AkaProtocolError('MJPEG frame too large')
        this.buffer = this.buffer.subarray(end + 4)
        this.state = 'body'
      }
      if (this.state === 'body') {
        if (this.buffer.length < this.length + 2) return
        if (this.buffer[this.length] !== 13 || this.buffer[this.length + 1] !== 10)
          throw new AkaProtocolError('Invalid JPEG part terminator')
        const bytes = Buffer.from(this.buffer.subarray(0, this.length))
        const size = jpegDimensions(bytes)
        // Keep one latest complete frame, including when one input contains thousands of parts.
        frames[0] = { bytes, ...size }
        this.buffer = this.buffer.subarray(this.length + 2)
        this.state = 'boundary'
      }
    }
  }
}
