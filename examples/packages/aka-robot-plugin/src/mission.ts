import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { AkaProtocolError } from './protocol.js'
import { copyRoute, type RouteStep } from './transport.js'

export type MissionInput = {
  goal: 'dispose' | 'retrieve'
  labels: string[]
  destinationLabels: string[]
  steps: RouteStep[]
  standoffMeters: number
  supervised: true
}
export function parseMission(value: MissionInput): MissionInput {
  const labels = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length >= 1 &&
    list.length <= 12 &&
    list.every((s) => typeof s === 'string' && !!s.trim() && s.length <= 256)
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'destinationLabels,goal,labels,standoffMeters,steps,supervised' ||
    !['dispose', 'retrieve'].includes(value.goal) ||
    value.supervised !== true ||
    !labels(value.labels) ||
    !labels(value.destinationLabels) ||
    !Number.isFinite(value.standoffMeters) ||
    value.standoffMeters < 0.05 ||
    value.standoffMeters > 2
  )
    throw new AkaProtocolError('Invalid supervised mission')
  return {
    ...value,
    steps: copyRoute(value.steps),
    labels: value.labels.map((s) => s.trim()),
    destinationLabels: value.destinationLabels.map((s) => s.trim()),
  }
}
export type MissionStages = Record<
  'find' | 'approach' | 'grab' | 'transport' | 'release',
  () => Promise<ToolResult>
>
/** Stage receipts remain evidence, not physical guarantees. Unknown stages are never repeated. */
export async function runMissionStages(
  goal: MissionInput['goal'],
  ctx: ToolContext,
  stages: MissionStages,
  record: (name: keyof MissionStages, result: ToolResult) => void,
): Promise<ToolResult> {
  const content: ToolResult['content'] = []
  const receipts: { stage: string; result: unknown }[] = []
  const order =
    goal === 'dispose'
      ? (['find', 'approach', 'grab', 'transport', 'release'] as const)
      : (['find', 'approach', 'grab', 'transport'] as const)
  for (const name of order) {
    ctx.signal.throwIfAborted()
    ctx.progress(
      `复合任务：${{ find: '寻找目标', approach: '接近目标', grab: '夹取并核对', transport: '搬运并核对持物', release: '释放并核对投放' }[name]}`,
    )
    const result = await stages[name]()
    record(name, result)
    content.push(...result.content)
    receipts.push({ stage: name, result: result.structured })
    ctx.signal.throwIfAborted()
    const state = result.structured as
      | { phase?: string; outcome?: string; targetFound?: boolean; gripEvidence?: string }
      | undefined
    const confirmed =
      state?.phase === 'completed' &&
      !result.isError &&
      state.outcome !== 'paused' &&
      (name === 'find'
        ? state.targetFound === true
        : name === 'approach'
          ? state.outcome === 'at_standoff'
          : name === 'release'
            ? state.gripEvidence === 'released_candidate'
            : state.gripEvidence === 'held_candidate')
    if (!confirmed)
      return {
        content,
        isError: true,
        structured: {
          phase: 'failed',
          failedStage: name,
          stageResults: receipts,
          physicalResult: 'unverified',
        },
      }
  }
  return {
    content,
    structured: {
      phase: 'completed',
      stageResults: receipts,
      physicalResult: 'unverified',
      gripEvidence: goal === 'dispose' ? 'released_candidate' : 'held_candidate',
    },
  }
}
