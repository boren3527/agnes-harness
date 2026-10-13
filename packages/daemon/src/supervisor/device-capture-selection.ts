import { pluginRowSource } from '@agnes/host'
import {
  type EventEnvelope,
  inspectJsonData,
  readDeviceCaptureEvent,
  rpcError,
  validateEvent,
} from '@agnes/protocol'
import type { DeviceBindingIndex } from '../storage/device-bindings.js'
import type { CaptureSelection } from '../storage/device-captures.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'
import type { TrustedArtifactInspector } from './artifact-authority-projection.js'
import type { WorkerServiceEffectScope } from './worker-link.js'

const owner = pluginRowSource('ext:agnes-examples/aka-robot')
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}

/** A storage acknowledgement requires actual trusted CAS inspection, never a worker receipt.
 * The pool supplies the live journaled scope; worker JSON cannot select an owner or command.
 */
export async function workerDeviceCaptureSelection(
  deps: {
    bindings: DeviceBindingIndex | undefined
    ownership: Pick<SessionPrincipalOwnership, 'resolve'>
    workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
    inspector?: TrustedArtifactInspector
    eventRead?: (sessionKey: string, seq: number, signal: AbortSignal) => Promise<unknown>
    publicationAuthority?: (
      sessionKey: string,
      principalId: string,
      event: EventEnvelope,
      signal: AbortSignal,
    ) => Promise<void>
  },
  sessionKey: string,
  params: unknown,
  scope: WorkerServiceEffectScope | undefined,
) {
  const checked = inspectJsonData(params, 8192)
  if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
    throw rpcError('INVALID_PARAMS')
  const p = checked.value as Record<string, unknown>
  if (
    Object.keys(p).sort().join(',') !==
      (p.operation === 'read' || p.operation === 'stored' || p.operation === 'publication'
        ? 'callId,operation'
        : p.operation === 'select'
          ? 'callId,operation,selection'
          : p.operation === 'recorded'
            ? 'callId,eventSeq,operation'
            : '') ||
    typeof p.callId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(p.callId)
  )
    throw rpcError('INVALID_PARAMS')
  const store = deps.bindings
  let principal: ReturnType<SessionPrincipalOwnership['resolve']>
  const current = () => {
    const now = deps.ownership.resolve(sessionKey)
    if (
      !store ||
      deps.bindings !== store ||
      !scope ||
      scope.revoked.aborted ||
      scope.callId !== p.callId ||
      scope.sessionKey !== sessionKey ||
      scope.extension !== owner ||
      !['aka.capture', 'aka.recognition.test'].includes(scope.service) ||
      (scope.recoverOnly && scope.service !== 'aka.capture') ||
      !principal?.active ||
      !now?.active ||
      principal.principalId !== now.principalId
    )
      denied()
  }
  try {
    principal = deps.ownership.resolve(sessionKey)
    current()
    if (scope?.recoverOnly && p.operation === 'select') return denied()
    const authority = await deps.workspaces.restoreBinding(sessionKey)
    current()
    if (!store || !principal || !scope || authority.sessionKey !== sessionKey) return denied()
    const connection = store.connection(authority)
    if (!connection.profile) return denied()
    const identity = {
      principalId: principal.principalId,
      sessionId: sessionKey,
      commandId: scope.commandId,
    }
    const matches = (selection: CaptureSelection) => {
      if (
        selection.deviceId !== connection.deviceId ||
        selection.bindingRevision !== connection.bindingRevision ||
        selection.configRevision !== connection.profile?.configRevision
      )
        denied()
    }
    if (p.operation === 'read') {
      const record = store.captures.read(identity)
      if (record) matches(record.selection)
      return record
    }
    if (p.operation === 'stored' || p.operation === 'publication' || p.operation === 'recorded') {
      const record = store.captures.read(identity)
      if (!record || !deps.inspector) return denied()
      if (p.operation === 'recorded' && record.stage === 'selected') return denied()
      matches(record.selection)
      const ref = record.selection.artifact
      const checkedRef = inspectJsonData(
        await deps.inspector.inspect({ sha256: ref.sha256, mime: ref.mime }, scope.revoked),
        4096,
      )
      current()
      const after = store.connection(authority)
      if (
        after.deviceId !== connection.deviceId ||
        after.bindingRevision !== connection.bindingRevision ||
        after.profile?.configRevision !== connection.profile.configRevision ||
        !checkedRef.ok ||
        !checkedRef.value ||
        typeof checkedRef.value !== 'object' ||
        Array.isArray(checkedRef.value)
      )
        return denied()
      const actual = checkedRef.value as Record<string, unknown>
      if (
        Object.keys(actual).sort().join(',') !== 'mime,sha256,size' ||
        actual.sha256 !== ref.sha256 ||
        actual.size !== ref.size ||
        actual.mime !== ref.mime
      )
        return denied()
      const stored = store.captures.stored(identity, ref)
      if (p.operation === 'stored') return stored
      const captureId = store.captures.publicationId(identity)
      if (!captureId) return denied()
      if (p.operation === 'recorded') {
        if (
          !Number.isSafeInteger(p.eventSeq) ||
          (p.eventSeq as number) < 1 ||
          !deps.eventRead ||
          !deps.publicationAuthority
        )
          return denied()
        const checkedEvent = validateEvent(
          await deps.eventRead(sessionKey, p.eventSeq as number, scope.revoked),
        )
        current()
        if (!checkedEvent.ok) return denied()
        const event = checkedEvent.value
        const capture = readDeviceCaptureEvent(event)
        if (
          event.seq !== p.eventSeq ||
          (event.lane ?? 'main') !== 'main' ||
          !capture ||
          capture.captureId !== captureId ||
          capture.ref.sha256 !== ref.sha256 ||
          capture.ref.size !== ref.size ||
          capture.ref.mime !== ref.mime
        )
          return denied()
        await deps.publicationAuthority(sessionKey, principal.principalId, event, scope.revoked)
        current()
        const final = store.connection(authority)
        if (
          final.deviceId !== connection.deviceId ||
          final.bindingRevision !== connection.bindingRevision ||
          final.profile?.configRevision !== connection.profile.configRevision
        )
          return denied()
        return store.captures.recorded(identity, event.seq)
      }
      // Correlation only: the current Host session must append the trusted event itself.
      return Object.freeze({ captureId, record: stored })
    }
    // Storage validates the closed selection before writing. Check its binding before mutation,
    // and retain no await between the final authority check and the synchronous transaction.
    if (!p.selection || typeof p.selection !== 'object' || Array.isArray(p.selection)) return denied()
    const selection = p.selection as CaptureSelection
    matches(selection)
    current()
    return store.captures.select(identity, selection)
  } catch {
    // Workspace/database errors must not disclose paths or persisted metadata to worker replies.
    return denied()
  }
}
