import { AkaProtocolError } from './protocol.js'
export type GraspProfile = {
  forwardMin: number
  forwardMax: number
  lateralTolerance: number
  settleMilliseconds: number
  heldBox: number[]
  releaseBox: number[]
}
export function parseGrasp(value: unknown, width: number, height: number): GraspProfile {
  const fail = (): never => {
    throw new AkaProtocolError('Invalid grasp observation calibration')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const p = value as GraspProfile
  if (
    Object.keys(p).sort().join(',') !==
      'forwardMax,forwardMin,heldBox,lateralTolerance,releaseBox,settleMilliseconds' ||
    ![p.forwardMin, p.forwardMax, p.lateralTolerance, p.settleMilliseconds].every(Number.isFinite) ||
    p.forwardMin < 0.05 ||
    p.forwardMax > 1.5 ||
    p.forwardMin >= p.forwardMax ||
    p.lateralTolerance < 0.01 ||
    p.lateralTolerance > 0.15 ||
    !Number.isSafeInteger(p.settleMilliseconds) ||
    p.settleMilliseconds < 4000 ||
    p.settleMilliseconds > 10000
  )
    return fail()
  for (const box of [p.heldBox, p.releaseBox])
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      (box[0] ?? -1) < 0 ||
      (box[1] ?? -1) < 0 ||
      (box[2] ?? 0) > width ||
      (box[3] ?? 0) > height ||
      (box[2] ?? 0) <= (box[0] ?? 0) ||
      (box[3] ?? 0) <= (box[1] ?? 0)
    )
      return fail()
  if (
    Math.min(p.heldBox[2] ?? 0, p.releaseBox[2] ?? 0) > Math.max(p.heldBox[0] ?? 0, p.releaseBox[0] ?? 0) &&
    Math.min(p.heldBox[3] ?? 0, p.releaseBox[3] ?? 0) > Math.max(p.heldBox[1] ?? 0, p.releaseBox[1] ?? 0)
  )
    return fail()
  return structuredClone(p)
}
export function boxInside(box: readonly number[], region: readonly number[]) {
  return (
    box.length === 4 &&
    region.length === 4 &&
    box.every(Number.isFinite) &&
    (box[0] ?? -1) >= (region[0] ?? 0) &&
    (box[1] ?? -1) >= (region[1] ?? 0) &&
    (box[2] ?? Infinity) <= (region[2] ?? 0) &&
    (box[3] ?? Infinity) <= (region[3] ?? 0) &&
    (box[2] ?? 0) > (box[0] ?? 0) &&
    (box[3] ?? 0) > (box[1] ?? 0)
  )
}
