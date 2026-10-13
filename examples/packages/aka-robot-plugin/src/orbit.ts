import type { MotionProfile, Position } from './approach.js'
import { AkaProtocolError } from './protocol.js'

export type Pose = { x: number; y: number; yaw: number; yawError: number; positionError: number }
export type Orbit = {
  center: { x: number; y: number }
  radius: number
  startAngle: number
  direction: 1 | -1
  pose: Pose
}
export const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const mean = (samples: number[]) => samples.reduce((sum, n) => sum + n, 0) / samples.length
const radians = (degrees: number) => (degrees * Math.PI) / 180
export function createOrbit(target: Position, profile: MotionProfile, direction: 'left' | 'right'): Orbit {
  const radius = Math.hypot(target.forward, target.left)
  if (
    ![radius, target.error].every(Number.isFinite) ||
    target.error < 0 ||
    target.error > profile.maximumVisionError ||
    radius > 1.5 ||
    radius / Math.SQRT2 - target.error < profile.turningClearance
  )
    throw new AkaProtocolError('Orbit clearance or distance outside measured limits')
  return {
    center: { x: target.forward, y: target.left },
    radius,
    startAngle: Math.atan2(-target.left, -target.forward),
    direction: direction === 'left' ? 1 : -1,
    pose: { x: 0, y: 0, yaw: 0, yawError: 0, positionError: target.error },
  }
}
export function orbitStep(
  orbit: Orbit,
  view: number,
  profile: MotionProfile,
): 'up' | 'left' | 'right' | 'observe' {
  if (
    Math.hypot(orbit.center.x - orbit.pose.x, orbit.center.y - orbit.pose.y) - orbit.pose.positionError <
    profile.turningClearance
  )
    throw new AkaProtocolError('Orbit current clearance uncertain')
  const angle = orbit.startAngle + (orbit.direction * view * Math.PI) / 2
  const goal = {
    x: orbit.center.x + orbit.radius * Math.cos(angle),
    y: orbit.center.y + orbit.radius * Math.sin(angle),
  }
  const dx = goal.x - orbit.pose.x,
    dy = goal.y - orbit.pose.y
  const travel = Math.max(...profile.forwardMeters) + profile.marginMeters
  const atGoal = Math.hypot(dx, dy) <= travel
  const heading = atGoal
    ? Math.atan2(orbit.center.y - orbit.pose.y, orbit.center.x - orbit.pose.x)
    : Math.atan2(dy, dx)
  const delta = wrap(heading - orbit.pose.yaw)
  const action = delta >= 0 ? 'left' : 'right'
  const samples = action === 'left' ? profile.leftDegrees : profile.rightDegrees,
    turn = mean(samples)
  if (Math.abs(delta) > radians(turn / 2 + 1)) {
    const nextYawError =
      orbit.pose.yawError +
      radians(Math.max(...samples.map((sample) => Math.abs(sample - turn))) + profile.marginDegrees)
    if (nextYawError > radians(12)) throw new AkaProtocolError('Orbit heading uncertainty exceeded')
    return action
  }
  if (atGoal) return 'observe'
  // Reject any pulse whose swept line could enter the measured clearance circle.
  const end = {
    x: orbit.pose.x + travel * Math.cos(orbit.pose.yaw),
    y: orbit.pose.y + travel * Math.sin(orbit.pose.yaw),
  }
  const vx = end.x - orbit.pose.x,
    vy = end.y - orbit.pose.y
  const fraction = Math.max(
    0,
    Math.min(
      1,
      ((orbit.center.x - orbit.pose.x) * vx + (orbit.center.y - orbit.pose.y) * vy) / (vx * vx + vy * vy),
    ),
  )
  if (
    Math.hypot(orbit.center.x - orbit.pose.x - fraction * vx, orbit.center.y - orbit.pose.y - fraction * vy) -
      orbit.pose.positionError -
      travel * Math.sin(orbit.pose.yawError) -
      profile.marginMeters <
    profile.turningClearance
  )
    throw new AkaProtocolError('Orbit pulse clearance uncertain')
  return 'up'
}
export function applyOrbitStep(orbit: Orbit, action: 'up' | 'left' | 'right', profile: MotionProfile) {
  if (action === 'up') {
    const amount = mean(profile.forwardMeters)
    orbit.pose.x += amount * Math.cos(orbit.pose.yaw)
    orbit.pose.y += amount * Math.sin(orbit.pose.yaw)
    orbit.pose.positionError +=
      Math.max(...profile.forwardMeters.map((n) => Math.abs(n - amount))) +
      profile.marginMeters +
      amount * Math.sin(orbit.pose.yawError)
  } else {
    const samples = action === 'left' ? profile.leftDegrees : profile.rightDegrees,
      amount = mean(samples)
    orbit.pose.yaw = wrap(orbit.pose.yaw + radians(amount) * (action === 'left' ? 1 : -1))
    orbit.pose.yawError += radians(
      Math.max(...samples.map((n) => Math.abs(n - amount))) + profile.marginDegrees,
    )
  }
  if (orbit.pose.yawError > radians(12)) throw new AkaProtocolError('Orbit heading uncertainty exceeded')
}
export function observeOrbit(orbit: Orbit, target: Position, view: number) {
  const c = Math.cos(orbit.pose.yaw),
    s = Math.sin(orbit.pose.yaw)
  const x = orbit.center.x - target.forward * c + target.left * s
  const y = orbit.center.y - target.forward * s - target.left * c
  const visionError =
    target.error + 2 * Math.hypot(target.forward, target.left) * Math.sin(orbit.pose.yawError / 2)
  if (Math.hypot(x - orbit.pose.x, y - orbit.pose.y) > orbit.pose.positionError + visionError + 0.03)
    throw new AkaProtocolError('Orbit target or movement inconsistent')
  const angle = Math.atan2(y - orbit.center.y, x - orbit.center.x)
  const uncertainty = Math.asin(Math.min(1, visionError / Math.hypot(x - orbit.center.x, y - orbit.center.y)))
  const expected = orbit.startAngle + (orbit.direction * view * Math.PI) / 2
  if (Math.abs(wrap(angle - expected)) + uncertainty > radians(15))
    throw new AkaProtocolError('Orbit viewpoint separation unconfirmed')
  orbit.pose.x = x
  orbit.pose.y = y
  orbit.pose.positionError = visionError
  return {
    index: view + 1,
    angleDegrees: (wrap(angle - orbit.startAngle) * 180) / Math.PI,
    uncertaintyDegrees: (uncertainty * 180) / Math.PI,
    method: 'measured-motion-and-ground-observation' as const,
  }
}
