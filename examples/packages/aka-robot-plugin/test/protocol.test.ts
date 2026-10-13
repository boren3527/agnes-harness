import { describe, expect, it } from 'vitest'
import {
  type Motion,
  motionPath,
  parseActionReceipt,
  parseWheelReport,
  robotEndpoint,
} from '../src/protocol.js'

const limits = { maxSpeed: 40, maxMilliseconds: 1200, maxCentimeters: 30, maxDegrees: 45 }

describe('AKA wire contracts', () => {
  it.each(['10.1.2.3', '172.16.4.9', '172.31.4.9', '192.168.43.232'])(
    'accepts explicit private address %s',
    (ip) => {
      expect(robotEndpoint(ip, 8080)).toBe(`http://${ip}:8080`)
    },
  )

  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
    '172.32.0.1',
    'localhost',
    '192.168.01.2',
    '3232235777',
    '192.168.1.1/secret',
    '192.168.1.1@evil.test',
    '192.168.1.256',
    ' 192.168.1.1',
    '::1',
  ])('rejects address substitution %s', (ip) => {
    expect(() => robotEndpoint(ip)).toThrow()
  })

  it.each([0, 65536, 1.5, Number.NaN])('rejects invalid port %s', (port) => {
    expect(() => robotEndpoint('192.168.1.2', port)).toThrow()
  })

  it('keeps centimeters, degrees and milliseconds distinct', () => {
    expect(motionPath({ action: 'up', speed: 30, mode: 'distance', centimeters: 2.5 }, limits)).toBe(
      '/api/control?action=up&speed=30&distance=2.5',
    )
    expect(motionPath({ action: 'left', speed: 20, mode: 'angle', degrees: 15 }, limits)).toBe(
      '/api/control?action=left&speed=20&angle=15',
    )
    expect(motionPath({ action: 'down', speed: 20, mode: 'time', milliseconds: 600 }, limits)).toBe(
      '/api/control?action=down&speed=20&time=600',
    )
  })

  it.each([
    { action: 'up', speed: 41, mode: 'time', milliseconds: 100 },
    { action: 'up', speed: 20, mode: 'time', milliseconds: 0 },
    { action: 'up', speed: 20, mode: 'time', milliseconds: 1201 },
    { action: 'left', speed: 20, mode: 'distance', centimeters: 10 },
    { action: 'up', speed: 20, mode: 'angle', degrees: 10 },
    { action: 'up', speed: 20, mode: 'distance', centimeters: Number.NaN },
    { action: 'up', speed: 20, mode: 'distance', centimeters: Number.POSITIVE_INFINITY },
    { action: 'up', speed: 20, mode: 'distance', centimeters: -1 },
    { action: 'right', speed: 20, mode: 'angle', degrees: 46 },
    { action: 'grab', speed: 20, mode: 'time', milliseconds: 500 },
    { action: 'up', speed: 20, mode: 'unlimited' },
  ])('refuses unbounded or wrong-unit motion %#', (input) => {
    expect(() => motionPath(input as Motion, limits)).toThrow()
  })

  it('decodes signed wheel values on a sliced buffer without inventing sample validity', () => {
    const buffer = Buffer.from([0, 0xbb, 0x18, 0xfc, 0xe8, 0x03, 0])
    expect(parseWheelReport(buffer.subarray(1, 6))).toEqual({
      leftCmPerSecond: -100,
      rightCmPerSecond: 100,
      validity: 'unknown',
    })
    expect(parseWheelReport(Buffer.from([0xbb, 0, 0, 0, 0])).validity).toBe('unknown')
    expect(() => parseWheelReport(buffer)).toThrow()
  })

  it('keeps actuator completion separate from verified outcomes', () => {
    expect(parseActionReceipt({ completed: true })).toEqual({ state: 'completed' })
    expect(parseActionReceipt({ completed: false, error: 'timeout' })).toEqual({
      state: 'unknown',
      error: 'timeout',
    })
    expect(() => parseActionReceipt({ status: 'success' })).toThrow()
    expect(() => parseActionReceipt({ completed: 'true' })).toThrow()
  })
})
