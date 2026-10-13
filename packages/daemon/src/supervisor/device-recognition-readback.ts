import { pluginRowSource } from '@agnes/host'
import {
  type ExtensionCallParams,
  type ExtensionCallResult,
  inspectJsonData,
  readDeviceCaptureEvent,
  validateEvent,
} from '@agnes/protocol'
import type { ArtifactReadRpcOptions } from '../local/methods/artifacts.js'
import type { DeviceBindingIndex } from '../storage/device-bindings.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'

/** Daemon-only original receipt readback. Caller must first verify the original journal binding
 * and current service admission, and serialize behind the original effect lane. Reads existing
 * publication authority; never runs author/SDK code.
 */
export function deviceRecognitionReadback(deps: {
  bindings: DeviceBindingIndex | undefined
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  artifactRead: ArtifactReadRpcOptions | undefined
  eventRead?: (sessionId: string, seq: number, signal: AbortSignal) => Promise<unknown>
}) {
  return async (
    params: ExtensionCallParams & { commandId: string },
    principalId: string,
    externalSignal: AbortSignal,
  ): Promise<ExtensionCallResult | undefined> => {
    const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(5000)])
    const operation = async (): Promise<ExtensionCallResult | undefined> => {
      try {
        if (
          params.extension !== pluginRowSource('ext:agnes-examples/aka-robot') ||
          params.service !== 'aka.recognition.test'
        )
          return undefined
        const checked = inspectJsonData(params.input, 1024)
        if (
          !checked.ok ||
          !checked.value ||
          typeof checked.value !== 'object' ||
          Array.isArray(checked.value)
        )
          return undefined
        const expected = checked.value as Record<string, unknown>
        if (
          Object.keys(expected).sort().join(',') !==
            'bindingRevision,configRevision,recognitionRevision,roundRevision' ||
          Object.values(expected).some((v) => !Number.isSafeInteger(v) || (v as number) < 1)
        )
          return undefined
        const store = deps.bindings,
          read = deps.artifactRead,
          eventRead = deps.eventRead
        if (!store || !read || !eventRead) return undefined
        const owner = () => {
          const current = deps.ownership.resolve(params.sessionId)
          if (
            signal.aborted ||
            deps.bindings !== store ||
            deps.artifactRead !== read ||
            deps.eventRead !== eventRead ||
            !current?.active ||
            current.principalId !== principalId
          )
            throw new Error('original detection unavailable')
        }
        owner()
        const workspace = await deps.workspaces.restoreBinding(params.sessionId)
        owner()
        const identity = { principalId, sessionId: params.sessionId, commandId: params.commandId }
        const original = store.detectionResults.read(identity)
        if (!original) {
          // The original effect lane has settled. No capture proves no submission.
          // With a capture, all reservations of the unchanged round must already have
          // receipts for other commands. Admission reserves before detector dispatch;
          // an unmatched reservation could belong to this original and remains unknown.
          const binding = store.session(params.sessionId)
          if (
            !binding ||
            binding.workspaceId !== workspace.workspaceId ||
            binding.bindingRevision !== expected.bindingRevision
          )
            return undefined
          const capture = store.captures.read(identity)
          if (capture) {
            const configuration = store.recognition.read(workspace)
            const budget = store.recognitionBudget.read(workspace)
            if (
              capture.selection.deviceId !== binding.deviceId ||
              capture.selection.bindingRevision !== expected.bindingRevision ||
              capture.selection.configRevision !== expected.configRevision ||
              configuration.configRevision !== expected.recognitionRevision ||
              !budget ||
              budget.deviceId !== binding.deviceId ||
              budget.roundRevision !== expected.roundRevision ||
              budget.reserved !==
                store.detectionResults.completedInRound(binding.deviceId, budget.roundRevision)
            )
              return undefined
          }
          owner()
          return { output: { outcome: 'not-started', deviceId: binding.deviceId, ...expected } }
        }
        const { result, capture } = original,
          selected = capture.selection
        const association = () => {
          const binding = store.session(params.sessionId)
          if (
            workspace.sessionKey !== params.sessionId ||
            !binding ||
            binding.workspaceId !== workspace.workspaceId ||
            binding.deviceId !== selected.deviceId ||
            binding.bindingRevision !== selected.bindingRevision
          )
            throw new Error('original detection unavailable')
        }
        association()
        if (
          selected.bindingRevision !== expected.bindingRevision ||
          selected.configRevision !== expected.configRevision ||
          result.configRevision !== expected.recognitionRevision ||
          result.roundRevision !== expected.roundRevision ||
          !capture.eventSeq
        )
          return undefined
        const value = await eventRead(params.sessionId, capture.eventSeq, signal)
        owner()
        association()
        const event = validateEvent(value)
        if (!event.ok || event.value.seq !== capture.eventSeq || event.value.lane !== 'main') return undefined
        const publication = readDeviceCaptureEvent(event.value)
        const ref = selected.artifact
        if (
          !publication ||
          publication.captureId !== store.captures.publicationId(identity) ||
          publication.ref.sha256 !== ref.sha256 ||
          publication.ref.size !== ref.size ||
          publication.ref.mime !== ref.mime
        )
          return undefined
        // The authenticated reader validates the full CAS object before returning this bounded range.
        // A 1-byte response avoids replacing its existing response-size limit for large originals.
        const actual = (await read.read(
          { sessionId: params.sessionId, laneId: 'main', artifact: ref, range: 'bytes=0-0' },
          { principalId, sessionId: params.sessionId, laneId: 'main', authKind: 'local' },
          signal,
        )) as {
          ok?: unknown
          status?: unknown
          artifact?: { sha256?: unknown; size?: unknown; mime?: unknown }
        }
        owner()
        association()
        const restored = await deps.workspaces.restoreBinding(params.sessionId)
        owner()
        association()
        if (
          restored.sessionKey !== workspace.sessionKey ||
          restored.workspaceId !== workspace.workspaceId ||
          restored.canonicalRoot !== workspace.canonicalRoot ||
          restored.revision !== workspace.revision ||
          !actual ||
          actual.ok !== true ||
          actual.status !== 206 ||
          actual.artifact?.sha256 !== ref.sha256 ||
          actual.artifact.size !== ref.size ||
          actual.artifact.mime !== ref.mime
        )
          return undefined
        if (JSON.stringify(store.detectionResults.read(identity)) !== JSON.stringify(original))
          return undefined
        const output = {
          ...result,
          detections: result.detections.map((d) => ({
            label: d.label,
            confidence: d.confidence,
            box: [...d.box],
          })),
          artifact: { ...ref },
          eventSeq: capture.eventSeq,
          selectedAt: selected.selectedAt,
          timeBasis: selected.timeBasis,
          ageAtSelectionMs: selected.ageAtSelectionMs,
        }
        if (!inspectJsonData(output, 512 * 1024).ok) return undefined
        return { output }
      } catch {
        return undefined
      }
    }
    // Read-only ports may ignore cancellation; do not let them hold the UI indefinitely.
    let stop!: () => void
    const stopped = new Promise<undefined>((resolve) => {
      stop = () => resolve(undefined)
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
    try {
      return await Promise.race([operation(), stopped])
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }
}
