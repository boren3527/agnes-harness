import { boxInside } from './grasp.js'
import { AkaProtocolError } from './protocol.js'

export type RouteStep = { action: 'up' | 'down' | 'left' | 'right'; speed: number; milliseconds: number }
export function copyRoute(steps: RouteStep[]): RouteStep[] {
  if (
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > 12 ||
    steps.some(
      (step) =>
        !step ||
        Object.keys(step).sort().join(',') !== 'action,milliseconds,speed' ||
        !['up', 'down', 'left', 'right'].includes(step.action) ||
        !Number.isSafeInteger(step.speed) ||
        step.speed < 30 ||
        step.speed > 50 ||
        !Number.isSafeInteger(step.milliseconds) ||
        step.milliseconds < 500 ||
        step.milliseconds > 3000,
    )
  )
    throw new AkaProtocolError('Invalid bounded patrol route')
  return steps.map((step) => ({ ...step }))
}
type Box = readonly number[]
type Detection = { label: string; confidence?: number; box: Box }
export function transportObservation(
  detections: readonly Detection[],
  labels: string[],
  destinationLabels: string[],
  heldBox: Box,
  releaseBox: Box,
) {
  const matching = (requested: string[]) =>
    detections.filter(
      (d) =>
        typeof d.confidence === 'number' &&
        d.confidence >= 0.6 &&
        requested.some((label) => label.toLowerCase() === d.label.trim().toLowerCase()),
    )
  const targets = matching(labels),
    destinations = matching(destinationLabels)
  return {
    held: targets.length === 1 && !!targets[0] && boxInside(targets[0].box, heldBox),
    label: targets.length === 1 ? targets[0]?.label : undefined,
    destinationVisible: destinations.length === 1,
    releaseAligned:
      destinations.length === 1 && !!destinations[0] && boxInside(releaseBox, destinations[0].box),
  }
}
