import { expect, it } from 'vitest'
import { boxInside, parseGrasp } from '../src/grasp.js'

const profile = () => ({
  forwardMin: 0.1,
  forwardMax: 0.2,
  lateralTolerance: 0.03,
  settleMilliseconds: 5000,
  heldBox: [100, 10, 220, 50],
  releaseBox: [100, 110, 220, 160],
})
it('checks actual grasp windows and disjoint visible holding/landing regions', () => {
  expect(parseGrasp(profile(), 320, 240)).toEqual(profile())
  expect(boxInside([140, 20, 180, 40], profile().heldBox)).toBe(true)
  expect(boxInside([90, 20, 180, 40], profile().heldBox)).toBe(false)
  for (const changed of [
    { forwardMin: 0.3 },
    { heldBox: [0, 0, 640, 480] },
    { releaseBox: [100, 20, 220, 60] },
    { settleMilliseconds: 100 },
    { heldBox: [100, 50, 100, 10] },
  ])
    expect(() => parseGrasp({ ...profile(), ...changed }, 320, 240)).toThrow()
})
