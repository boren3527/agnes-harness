import { AkaProtocolError } from './protocol.js'

/** Measurements describe a fixed speed/pulse on one supervised clear floor. They are not a collision sensor. */
export type MotionProfile = {
  speed: number
  milliseconds: number
  forwardMeters: number[]
  leftDegrees: number[]
  rightDegrees: number[]
  marginMeters: number
  marginDegrees: number
  minimumStandoff: number
  turningClearance: number
  lateralTolerance: number
  maximumVisionError: number
}
export function parseMotion(value: unknown): MotionProfile {
  const fail = (): never => {
    throw new AkaProtocolError('Invalid measured motion profile')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const p = value as MotionProfile
  if (
    Object.keys(p).sort().join(',') !==
    'forwardMeters,lateralTolerance,leftDegrees,marginDegrees,marginMeters,maximumVisionError,milliseconds,minimumStandoff,rightDegrees,speed,turningClearance'
  )
    return fail()
  const range = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max
  if (
    !Number.isSafeInteger(p.speed) ||
    !range(p.speed, 30, 50) ||
    !Number.isSafeInteger(p.milliseconds) ||
    !range(p.milliseconds, 500, 3000) ||
    !range(p.marginMeters, 0.001, 0.05) ||
    !range(p.marginDegrees, 0.1, 5) ||
    !range(p.minimumStandoff, 0.05, 2) ||
    !range(p.turningClearance, 0.15, 2) ||
    !range(p.lateralTolerance, 0.01, 0.15) ||
    !range(p.maximumVisionError, 0.001, 0.05)
  )
    return fail()
  for (const [samples, min, max] of [
    [p.forwardMeters, 0.001, 0.15],
    [p.leftDegrees, 0.1, 30],
    [p.rightDegrees, 0.1, 30],
  ] as const) {
    if (
      !Array.isArray(samples) ||
      samples.length < 3 ||
      samples.length > 20 ||
      !samples.every((n) => range(n, min, max))
    )
      return fail()
  }
  if (
    Math.min(...p.leftDegrees, ...p.rightDegrees) <= p.marginDegrees ||
    p.lateralTolerance <= p.maximumVisionError ||
    Math.min(...p.forwardMeters) <= p.marginMeters ||
    p.turningClearance < p.minimumStandoff
  )
    return fail()
  return structuredClone(p)
}
export type Position = { forward: number; left: number; error: number }
export type ApproachDecision =
  | { action: 'up' | 'left' | 'right' }
  | { outcome: 'at_standoff' | 'paused'; reason: string }
export function planApproach(position: Position, profile: MotionProfile, standoff: number): ApproachDecision {
  const { forward: x, left: y, error: e } = position
  if (
    ![x, y, e, standoff].every(Number.isFinite) ||
    e < 0 ||
    e > profile.maximumVisionError ||
    standoff < profile.minimumStandoff ||
    x - e < standoff
  )
    return { outcome: 'paused', reason: 'distance_or_uncertainty_outside_measured_limits' }
  const maxTravel = Math.max(...profile.forwardMeters) + profile.marginMeters
  if (Math.abs(y) + e > profile.lateralTolerance) {
    const distance = Math.hypot(x, y),
      bearing = Math.atan2(y, x)
    const action = y > 0 ? 'left' : 'right'
    const maxYaw =
      ((Math.max(...(action === 'left' ? profile.leftDegrees : profile.rightDegrees)) +
        profile.marginDegrees) *
        Math.PI) /
      180
    const angleError = Math.asin(Math.min(1, e / distance))
    const minYaw =
      ((Math.min(...(action === 'left' ? profile.leftDegrees : profile.rightDegrees)) -
        profile.marginDegrees) *
        Math.PI) /
      180
    if (minYaw <= 2 * angleError) return { outcome: 'paused', reason: 'motion_below_visual_resolution' }
    const minimumForwardAfterTurn =
      Math.min(...[minYaw, maxYaw].map((a) => x * Math.cos(a) + Math.abs(y) * Math.sin(a))) - e
    if (
      distance - e < profile.turningClearance ||
      Math.abs(bearing) - angleError <= maxYaw ||
      minimumForwardAfterTurn < standoff
    )
      return { outcome: 'paused', reason: 'turn_too_coarse_or_clearance_unknown' }
    return { action }
  }
  if (x - e - maxTravel < standoff)
    return { outcome: 'at_standoff', reason: 'within_one_measured_step_of_requested_standoff' }
  if (Math.min(...profile.forwardMeters) - profile.marginMeters <= 2 * e)
    return { outcome: 'paused', reason: 'motion_below_visual_resolution' }
  return { action: 'up' }
}
/** Detect target swaps or movement inconsistent with measured samples before dispatching another step. */
export function compatiblePosition(
  previous: Position,
  current: Position,
  action: 'up' | 'left' | 'right',
  profile: MotionProfile,
) {
  const samples =
    action === 'up' ? profile.forwardMeters : action === 'left' ? profile.leftDegrees : profile.rightDegrees
  const margin = action === 'up' ? profile.marginMeters : profile.marginDegrees
  const predictions = [Math.min(...samples) - margin, Math.max(...samples) + margin].map((amount) => {
    if (action === 'up') return { x: previous.forward - amount, y: previous.left }
    const a = ((amount * Math.PI) / 180) * (action === 'left' ? 1 : -1)
    return {
      x: previous.forward * Math.cos(a) + previous.left * Math.sin(a),
      y: -previous.forward * Math.sin(a) + previous.left * Math.cos(a),
    }
  })
  const tolerance = previous.error + current.error + profile.marginMeters
  return (
    current.forward >= Math.min(...predictions.map((p) => p.x)) - tolerance &&
    current.forward <= Math.max(...predictions.map((p) => p.x)) + tolerance &&
    current.left >= Math.min(...predictions.map((p) => p.y)) - tolerance &&
    current.left <= Math.max(...predictions.map((p) => p.y)) + tolerance
  )
}
