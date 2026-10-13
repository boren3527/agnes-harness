/** Wire contracts checked against AKA-00 revision 68883db4ebb6d3072043c7c6eca9fc421bfe9a19.
 * This module performs no I/O. Only an authorized Host transport may send its requests.
 */
export const AKA_SOURCE_REVISION = '68883db4ebb6d3072043c7c6eca9fc421bfe9a19'

export class AkaProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AkaProtocolError'
  }
}

export function robotEndpoint(ip: string, port = 80): string {
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((s) => !/^(0|[1-9]\d{0,2})$/.test(s) || Number(s) > 255)) {
    throw new AkaProtocolError('A canonical private IPv4 address is required')
  }
  const [a, b] = parts.map(Number)
  if (!(a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new AkaProtocolError('Robot address must be in a private LAN')
  }
  integer(port, 1, 65535, 'port')
  return `http://${ip}:${port}`
}

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AkaProtocolError(`${name} must be an integer between ${min} and ${max}`)
  }
}

function bounded(value: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new AkaProtocolError(`${name} is outside the finite action limit`)
  }
}

export type MotionAction = 'up' | 'down' | 'left' | 'right'
export type Motion =
  | { action: MotionAction; speed: number; mode: 'time'; milliseconds: number }
  | { action: 'up' | 'down'; speed: number; mode: 'distance'; centimeters: number }
  | { action: 'left' | 'right'; speed: number; mode: 'angle'; degrees: number }

export interface MotionLimits {
  maxSpeed: number
  maxMilliseconds: number
  maxCentimeters: number
  maxDegrees: number
}

/** Limits must come from an accepted control lease/calibration, never model-provided overrides. */
export function motionPath(motion: Motion, limits: MotionLimits): string {
  integer(limits.maxSpeed, 1, 100, 'maxSpeed')
  integer(limits.maxMilliseconds, 1, 30000, 'maxMilliseconds')
  bounded(limits.maxCentimeters, 1000, 'maxCentimeters')
  bounded(limits.maxDegrees, 360, 'maxDegrees')
  if (!['up', 'down', 'left', 'right'].includes(motion.action)) throw new AkaProtocolError('Unknown motion')
  integer(motion.speed, 1, limits.maxSpeed, 'speed')
  const query = new URLSearchParams({ action: motion.action, speed: String(motion.speed) })
  switch (motion.mode) {
    case 'time':
      integer(motion.milliseconds, 1, limits.maxMilliseconds, 'milliseconds')
      query.set('time', String(motion.milliseconds))
      break
    case 'distance':
      if (motion.action !== 'up' && motion.action !== 'down')
        throw new AkaProtocolError('Invalid distance action')
      bounded(motion.centimeters, limits.maxCentimeters, 'centimeters')
      query.set('distance', String(motion.centimeters))
      break
    case 'angle':
      if (motion.action !== 'left' && motion.action !== 'right')
        throw new AkaProtocolError('Invalid angle action')
      bounded(motion.degrees, limits.maxDegrees, 'degrees')
      query.set('angle', String(motion.degrees))
      break
    default:
      throw new AkaProtocolError('Unknown motion mode')
  }
  return `/api/control?${query}`
}

export const STOP_PATH = '/api/control?action=stop'
export const GRIP_PATHS = {
  grab: '/api/control?action=grab',
  release: '/api/control?action=release',
} as const

export interface WheelReport {
  leftCmPerSecond: number
  rightCmPerSecond: number
  /** The official wire format has no successful-sample flag. Zero cannot prove stationary. */
  validity: 'unknown'
}

export function parseWheelReport(bytes: Uint8Array): WheelReport {
  if (bytes.length !== 5 || bytes[0] !== 0xbb) throw new AkaProtocolError('Malformed wheel report')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    leftCmPerSecond: view.getInt16(1, true) / 10,
    rightCmPerSecond: view.getInt16(3, true) / 10,
    validity: 'unknown',
  }
}

export function parseActionReceipt(
  value: unknown,
  expected?: MotionAction | 'grab' | 'release' | 'stop',
): { state: 'completed' | 'acknowledged' | 'unknown'; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AkaProtocolError('Invalid action receipt')
  const record = value as Record<string, unknown>
  if (
    expected &&
    ((record.action !== undefined && record.action !== expected) ||
      (record.status !== undefined && record.status !== 'success'))
  )
    throw new AkaProtocolError('Mismatched action receipt')
  // execute_action returns status/action for immediate stop and asynchronously accepted arm actions.
  if (expected && record.status === 'success' && record.action === expected && record.completed === undefined)
    return { state: expected === 'stop' ? 'completed' : 'acknowledged' }
  if (typeof record.completed !== 'boolean') throw new AkaProtocolError('Missing completed flag')
  if (record.completed) return { state: 'completed' }
  if (record.error !== undefined && typeof record.error !== 'string')
    throw new AkaProtocolError('Invalid action error')
  // A negative receipt or lost ACK does not certify that no physical motion occurred.
  return {
    state: 'unknown',
    ...(typeof record.error === 'string' ? { error: record.error.slice(0, 512) } : {}),
  }
}
