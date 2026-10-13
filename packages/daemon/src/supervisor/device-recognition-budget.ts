import { pluginRowSource } from '@agnes/host'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import { DeviceBindingConflict, type DeviceBindingIndex } from '../storage/device-bindings.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'
import type { WorkerServiceEffectScope } from './worker-link.js'

const owner = pluginRowSource('ext:agnes-examples/aka-robot')
const services = new Set([
  'aka.recognition.round.read',
  'aka.recognition.round.start',
  'aka.recognition.test',
  'aka.recognition.enable',
])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}

/** Private worker path. Pool supplies a live, daemon-dispatched scope, never a JSON proof.
 * It grants neither credentials nor inference. Host grants and in-flight draining remain caller obligations.
 */
export async function workerDeviceRecognitionBudget(
  deps: {
    bindings: DeviceBindingIndex | undefined
    ownership: Pick<SessionPrincipalOwnership, 'resolve'>
    workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
    assertRecognitionIdle?: (deviceId: string) => void
  },
  sessionKey: string,
  params: unknown,
  scope: WorkerServiceEffectScope | undefined,
) {
  const inspected = inspectJsonData(params, 4096)
  if (
    !inspected.ok ||
    !inspected.value ||
    typeof inspected.value !== 'object' ||
    Array.isArray(inspected.value)
  )
    throw rpcError('INVALID_PARAMS')
  const p = inspected.value as Record<string, unknown>
  const operation = p.operation
  const keys = Object.keys(p).sort().join(',')
  const extra = operation === 'start' ? 'startId' : operation === 'reserve' ? 'attemptId' : undefined
  const expectedKeys =
    operation === 'read'
      ? 'callId,expectedBindingRevision,expectedConfigRevision,operation'
      : operation === 'start'
        ? 'callId,expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,operation,startId'
        : operation === 'reserve'
          ? 'attemptId,callId,expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,operation'
          : undefined
  if (
    !expectedKeys ||
    keys !== expectedKeys ||
    typeof p.callId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(p.callId) ||
    (extra && (typeof p[extra] !== 'string' || !uuid.test(p[extra] as string))) ||
    !Number.isSafeInteger(p.expectedBindingRevision) ||
    (p.expectedBindingRevision as number) < 1 ||
    !Number.isSafeInteger(p.expectedConfigRevision) ||
    (p.expectedConfigRevision as number) < (operation === 'read' ? 0 : 1) ||
    (operation !== 'read' &&
      (!Number.isSafeInteger(p.expectedRoundRevision) ||
        (p.expectedRoundRevision as number) < (operation === 'start' ? 0 : 1)))
  )
    throw rpcError('INVALID_PARAMS')
  const store = deps.bindings
  let principal: ReturnType<SessionPrincipalOwnership['resolve']>
  const current = () => {
    const active = deps.ownership.resolve(sessionKey)
    if (
      !scope ||
      scope.revoked.aborted ||
      scope.callId !== p.callId ||
      scope.sessionKey !== sessionKey ||
      scope.extension !== owner ||
      !services.has(scope.service) ||
      (scope.service === 'aka.recognition.round.read' && operation !== 'read') ||
      !store ||
      deps.bindings !== store ||
      !principal?.active ||
      !active?.active ||
      active.principalId !== principal.principalId ||
      (operation === 'start' && scope.service !== 'aka.recognition.round.start') ||
      (operation === 'reserve' && scope.service === 'aka.recognition.round.start')
    )
      denied()
  }
  try {
    principal = deps.ownership.resolve(sessionKey)
    current()
    const authority = await deps.workspaces.restoreBinding(sessionKey)
    current()
    if (authority.sessionKey !== sessionKey || !store) return denied()
    if (operation === 'read') {
      const configuration = store.recognition.read(authority)
      if (
        configuration.bindingRevision !== p.expectedBindingRevision ||
        configuration.configRevision !== p.expectedConfigRevision
      )
        throw new DeviceBindingConflict('revision')
      return store.recognitionBudget.read(authority)
    }
    const versions = {
      expectedBindingRevision: p.expectedBindingRevision as number,
      expectedConfigRevision: p.expectedConfigRevision as number,
      expectedRoundRevision: p.expectedRoundRevision as number,
    }
    if (operation === 'start') {
      const configuration = store.recognition.read(authority)
      if (!deps.assertRecognitionIdle || deps.assertRecognitionIdle(configuration.deviceId) !== undefined)
        return denied()
      current()
      // No await after the daemon's shared in-flight guard and before the atomic round change.
      return store.recognitionBudget.start(authority, { ...versions, startId: p.startId as string })
    }
    return store.recognitionBudget.reserve(authority, { ...versions, attemptId: p.attemptId as string })
  } catch (error) {
    if (error instanceof DeviceBindingConflict && error.reason === 'revision')
      throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
    // Workspace/database errors must not leak host paths, query text or stored values to worker replies.
    return denied()
  }
}
