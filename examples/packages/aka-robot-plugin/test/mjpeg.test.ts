import { describe, expect, it } from 'vitest'
import { type JpegFrame, jpegDimensions, MjpegParser, mjpegBoundary } from '../src/mjpeg.js'

// A framing/dimension fixture, not a claim to test actual JPEG decoding.
function jpeg(width = 320, height = 240): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ])
}

function part(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`),
    bytes,
    Buffer.from('\r\n'),
  ])
}

describe('bounded AKA multipart camera stream', () => {
  it('checks the negotiated content type and boundary', () => {
    expect(mjpegBoundary('multipart/x-mixed-replace; boundary=frame')).toBe('frame')
    expect(mjpegBoundary('multipart/x-mixed-replace; boundary="frame"')).toBe('frame')
    expect(() => mjpegBoundary('text/html; boundary=frame')).toThrow()
    expect(() => mjpegBoundary('multipart/x-mixed-replace; boundary=frame\r\nInjected: yes')).toThrow()
  })

  it('handles every split point, including JPEG bytes and closing CRLF', () => {
    const body = Buffer.concat([part(jpeg()), Buffer.from('--frame--\r\n')])
    for (let split = 0; split <= body.length; split++) {
      const parser = new MjpegParser('frame')
      const first = parser.push(body.subarray(0, split))
      const second = parser.push(body.subarray(split))
      expect(second ?? first).toMatchObject({ width: 320, height: 240, bytes: jpeg() })
      expect(() => parser.finish()).not.toThrow()
    }
  })

  it('assembles byte-by-byte input and keeps frames independent of mutable transport memory', () => {
    const body = part(jpeg())
    const parser = new MjpegParser('frame')
    let frame: JpegFrame | undefined
    for (const byte of body) frame = parser.push(Buffer.from([byte])) ?? frame
    body.fill(0)
    expect(frame?.bytes).toEqual(jpeg())
    parser.finish()
  })

  it('retains only the latest frame when a large transport chunk contains many parts', () => {
    const parser = new MjpegParser('frame', 32)
    const body = Buffer.concat([...Array.from({ length: 1000 }, () => part(jpeg())), part(jpeg(640, 480))])
    expect(parser.push(body)).toMatchObject({ width: 640, height: 480 })
    parser.finish()
  })

  it.each([
    '--wrong\r\n',
    '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 99999999\r\n\r\n',
    '--frame\r\nContent-Type: text/html\r\nContent-Length: 17\r\n\r\n',
    '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 17\r\nContent-Length: 18\r\n\r\n',
    `--frame\r\n${'x'.repeat(4097)}`,
  ])('terminates malformed framing without silently substituting another frame %#', (input) => {
    const parser = new MjpegParser('frame')
    expect(() => parser.push(Buffer.from(input))).toThrow()
    expect(() => parser.push(part(jpeg()))).toThrow('failed')
  })

  it('reports truncated bodies and bad terminators', () => {
    const parser = new MjpegParser('frame')
    parser.push(part(jpeg()).subarray(0, -4))
    expect(() => parser.finish()).toThrow('Truncated')
    const bad = part(jpeg())
    bad[bad.length - 1] = 0
    expect(() => new MjpegParser('frame').push(bad)).toThrow('terminator')
  })

  it.each([
    [0, 240],
    [320, 0],
    [4097, 240],
    [4096, 4096],
  ])('rejects unsafe dimensions %s × %s', (width, height) => {
    expect(() => jpegDimensions(jpeg(width, height))).toThrow('dimensions')
  })

  it('rejects missing JPEG boundaries and malformed segment lengths', () => {
    expect(() => jpegDimensions(jpeg().subarray(1))).toThrow('JPEG')
    const bad = jpeg()
    bad[5] = 255
    expect(() => jpegDimensions(bad)).toThrow('segment')
  })
})
