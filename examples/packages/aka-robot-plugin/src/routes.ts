import { AkaProtocolError } from './protocol.js'
import { copyRoute, type RouteStep } from './transport.js'

export type RoutePresets = {
  patrol?: { steps: RouteStep[]; returnSteps: RouteStep[]; homeLabels: string[] }
  delivery?: { steps: RouteStep[]; destinationLabels: string[] }
}
export function parseRoutePresets(value: unknown): RoutePresets {
  const fail = (): never => {
    throw new AkaProtocolError('Invalid device route presets')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as RoutePresets
  if (!Object.keys(v).length || Object.keys(v).some((key) => key !== 'patrol' && key !== 'delivery'))
    return fail()
  const labels = (list: unknown) => {
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > 12 ||
      list.some((s) => typeof s !== 'string' || !s.trim() || s.length > 256)
    )
      return fail()
    return list.map((s: string) => s.trim())
  }
  const result: RoutePresets = {}
  if (v.patrol !== undefined) {
    if (!v.patrol || Object.keys(v.patrol).sort().join(',') !== 'homeLabels,returnSteps,steps') return fail()
    const steps = copyRoute(v.patrol.steps),
      returnSteps = copyRoute(v.patrol.returnSteps)
    if (steps.length + returnSteps.length > 12) return fail()
    result.patrol = { steps, returnSteps, homeLabels: labels(v.patrol.homeLabels) }
  }
  if (v.delivery !== undefined) {
    if (!v.delivery || Object.keys(v.delivery).sort().join(',') !== 'destinationLabels,steps') return fail()
    result.delivery = {
      steps: copyRoute(v.delivery.steps),
      destinationLabels: labels(v.delivery.destinationLabels),
    }
  }
  return result
}
