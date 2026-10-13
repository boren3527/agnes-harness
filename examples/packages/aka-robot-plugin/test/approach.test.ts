import { describe, expect, it } from 'vitest'
import { compatiblePosition, parseMotion, planApproach } from '../src/approach.js'
import { applyOrbitStep, createOrbit, observeOrbit, orbitStep } from '../src/orbit.js'

const profile = () =>
  parseMotion({
    speed: 30,
    milliseconds: 500,
    forwardMeters: [0.049, 0.05, 0.051],
    leftDegrees: [5, 5.5, 6],
    rightDegrees: [5, 5.5, 6],
    marginMeters: 0.005,
    marginDegrees: 0.5,
    minimumStandoff: 0.1,
    turningClearance: 0.2,
    lateralTolerance: 0.03,
    maximumVisionError: 0.02,
  })
describe('measured approach planning', () => {
  it('refuses orbit paths inside clearance and limits accumulated heading uncertainty', () => {
    const p = profile()
    expect(() => createOrbit({ forward: 0.2, left: 0, error: 0.005 }, p, 'left')).toThrow('clearance')
    const orbit = createOrbit({ forward: 0.7, left: 0, error: 0.005 }, p, 'left')
    orbit.pose.x = 0.6
    expect(() => orbitStep(orbit, 1, p)).toThrow('clearance')
    const uncertain = createOrbit({ forward: 0.7, left: 0, error: 0.005 }, p, 'right')
    uncertain.pose.yawError = (12 * Math.PI) / 180
    expect(() => orbitStep(uncertain, 1, p)).toThrow('uncertainty')
    expect(() => applyOrbitStep(uncertain, 'right', p)).toThrow('uncertainty')
  })
  it('rejects repeated viewpoint geometry and an object inconsistent with the measured path', () => {
    const p = profile(),
      orbit = createOrbit({ forward: 0.7, left: 0, error: 0.005 }, p, 'left')
    const first = observeOrbit(orbit, { forward: 0.7, left: 0, error: 0.005 }, 0)
    expect(first.index).toBe(1)
    expect(first.angleDegrees).toBeCloseTo(0, 8)
    expect(() => observeOrbit(orbit, { forward: 0.7, left: 0, error: 0.005 }, 1)).toThrow('separation')
    expect(() => observeOrbit(orbit, { forward: 0.3, left: 0, error: 0.005 }, 0)).toThrow('inconsistent')
  })
  it('selects bounded forward/left/right steps and stops before the next step could cross standoff', () => {
    const p = profile()
    expect(planApproach({ forward: 0.7, left: 0, error: 0.005 }, p, 0.6)).toEqual({ action: 'up' })
    expect(planApproach({ forward: 0.65, left: 0, error: 0.005 }, p, 0.6)).toMatchObject({
      outcome: 'at_standoff',
    })
    expect(planApproach({ forward: 0.7, left: 0.2, error: 0.005 }, p, 0.1)).toEqual({ action: 'left' })
    expect(planApproach({ forward: 0.3, left: 1, error: 0.005 }, p, 0.25)).toEqual({ action: 'left' })
    expect(planApproach({ forward: 0.7, left: -0.2, error: 0.005 }, p, 0.1)).toEqual({ action: 'right' })
    expect(planApproach({ forward: 0.7, left: 0.04, error: 0.005 }, p, 0.1)).toMatchObject({
      outcome: 'paused',
      reason: 'turn_too_coarse_or_clearance_unknown',
    })
  })
  it('pauses when motion cannot be distinguished from visual uncertainty', () => {
    const p = profile()
    expect(
      planApproach({ forward: 0.7, left: 0, error: 0.02 }, { ...p, forwardMeters: [0.01, 0.015, 0.02] }, 0.1),
    ).toMatchObject({ outcome: 'paused', reason: 'motion_below_visual_resolution' })
    expect(
      planApproach({ forward: 0.7, left: 0.2, error: 0.02 }, { ...p, leftDegrees: [1, 1.1, 1.2] }, 0.1),
    ).toMatchObject({ outcome: 'paused', reason: 'motion_below_visual_resolution' })
  })
  it('pauses at excessive uncertainty, insufficient turning clearance and unsafe requested distance', () => {
    const p = profile()
    for (const [position, stop] of [
      [{ forward: 0.7, left: 0, error: 0.05 }, 0.1],
      [{ forward: 0.08, left: 0, error: 0.005 }, 0.1],
      [{ forward: 0.7, left: 0, error: 0.005 }, 0.05],
      [{ forward: 0.14, left: 0.1, error: 0.005 }, 0.1],
    ] as const)
      expect(planApproach(position, p, stop)).toMatchObject({ outcome: 'paused' })
  })
  it('accepts observed motion ranges and rejects target swaps or unmeasured displacement', () => {
    const p = profile(),
      previous = { forward: 0.7, left: 0, error: 0.005 }
    expect(compatiblePosition(previous, { forward: 0.65, left: 0, error: 0.005 }, 'up', p)).toBe(true)
    expect(compatiblePosition(previous, { forward: 0.4, left: 0, error: 0.005 }, 'up', p)).toBe(false)
    const from = { forward: 0.7, left: 0.2, error: 0.005 },
      a = (5.5 * Math.PI) / 180
    expect(
      compatiblePosition(
        from,
        {
          forward: from.forward * Math.cos(a) + from.left * Math.sin(a),
          left: -from.forward * Math.sin(a) + from.left * Math.cos(a),
          error: 0.005,
        },
        'left',
        p,
      ),
    ).toBe(true)
  })
  it('rejects missing real samples, nonnumeric entries, zero motion and excessive engineering limits', () => {
    const p = profile()
    for (const changed of [
      { forwardMeters: [0.05] },
      { forwardMeters: [0.01, 0.02, Number.NaN] },
      { speed: 80 },
      { leftDegrees: [0, 0, 0] },
      { lateralTolerance: 0.01 },
      { invented: true },
    ])
      expect(() => parseMotion({ ...p, ...changed })).toThrow()
  })
})
