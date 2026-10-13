import { createHash, randomUUID } from 'node:crypto'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import { workerRecognitionAuthorization } from './device-recognition-authorization.js'
import type { DeviceRecognitionExecutor } from './device-recognition-execute.js'
import type { WorkerLink, WorkerServiceEffectScope } from './worker-link.js'

const maxEncoded = 4 * Math.ceil((2.5 * 1024 * 1024) / 3)
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}
type Entry = {
  ticket: string
  issuedAt: number | undefined
  used: boolean
  expected: { bindingRevision: number; configRevision: number; roundRevision: number }
}

/** One-use, daemon-clock frame admission. Entries live only as long as the original effect. */
export class DeviceRecognitionRequests {
  private readonly entries = new Map<WorkerServiceEffectScope, Entry>()
  constructor(private readonly executor: DeviceRecognitionExecutor) {}

  async request(
    deps: Parameters<DeviceRecognitionExecutor['recognizeFromWorker']>[0],
    link: Pick<WorkerLink, 'serviceEffect' | 'command'>,
    sessionKey: string,
    params: unknown,
    scope: WorkerServiceEffectScope | undefined,
  ) {
    try {
      const checked = inspectJsonData(params, maxEncoded + 4096)
      if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
        return denied()
      const p = checked.value as Record<string, unknown>
      if (!scope || scope.sessionKey !== sessionKey || p.callId !== scope.callId) return denied()
      const authority = workerRecognitionAuthorization(link, scope, scope.revoked)
      if (p.operation === 'begin') {
        if (Object.keys(p).sort().join(',') !== 'callId,expected,operation') return denied()
        const expected = p.expected
        if (
          !expected ||
          typeof expected !== 'object' ||
          Array.isArray(expected) ||
          Object.keys(expected).sort().join(',') !== 'bindingRevision,configRevision,roundRevision' ||
          Object.values(expected).some((v) => !Number.isSafeInteger(v) || (v as number) < 1) ||
          this.entries.has(scope) ||
          this.entries.size >= 128
        )
          return denied()
        const entry: Entry = {
          ticket: randomUUID(),
          issuedAt: undefined,
          used: false,
          expected: { ...(expected as Entry['expected']) },
        }
        // Reserve before awaiting: concurrent begins cannot replace a pending or consumed ticket.
        this.entries.set(scope, entry)
        scope.revoked.addEventListener('abort', () => this.entries.delete(scope), { once: true })
        await authority.assertAuthorized()
        if (scope.revoked.aborted || this.entries.get(scope) !== entry) return denied()
        entry.issuedAt = performance.now()
        return { ticket: entry.ticket }
      }
      if (p.operation !== 'execute' || Object.keys(p).sort().join(',') !== 'callId,frame,operation,ticket')
        return denied()
      const entry = this.entries.get(scope)
      if (!entry || entry.issuedAt === undefined || entry.used || p.ticket !== entry.ticket) return denied()
      entry.used = true // Invalid frames and failed/unknown calls never get a fresh attempt under this effect.
      const frame = p.frame
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return denied()
      const f = frame as Record<string, unknown>
      if (
        Object.keys(f).sort().join(',') !== 'ageAtSendMs,height,id,jpegBase64,width' ||
        typeof f.ageAtSendMs !== 'number' ||
        !Number.isFinite(f.ageAtSendMs) ||
        f.ageAtSendMs < 0 ||
        f.ageAtSendMs > 1000 ||
        typeof f.jpegBase64 !== 'string' ||
        f.jpegBase64.length > maxEncoded
      )
        return denied()
      const now = performance.now(),
        receivedAt = entry.issuedAt - f.ageAtSendMs
      if (!Number.isFinite(now) || now < entry.issuedAt || receivedAt < 0 || now - receivedAt > 1000)
        return denied()
      const bytes = Buffer.from(f.jpegBase64, 'base64')
      if (bytes.length > 2.5 * 1024 * 1024 || bytes.toString('base64') !== f.jpegBase64) return denied()
      // The live, journaled single-image effect must already have published its exact original.
      // Scope/owner identities come from the daemon, never from worker frame JSON.
      const store = deps.bindings,
        principal = deps.ownership.resolve(sessionKey)
      if (!store || !principal?.active || scope.service !== 'aka.recognition.test') return denied()
      const identity = {
        principalId: principal.principalId,
        sessionId: sessionKey,
        commandId: scope.commandId,
      }
      const workspace = await deps.workspaces.restoreBinding(sessionKey)
      const current = () => {
        const owner = deps.ownership.resolve(sessionKey)
        const connection = store.connection(workspace)
        const configuration = store.recognition.read(workspace)
        const round = store.recognitionBudget.read(workspace)
        const capture = store.captures.read(identity)
        if (
          deps.bindings !== store ||
          !owner?.active ||
          owner.principalId !== principal.principalId ||
          workspace.sessionKey !== sessionKey ||
          scope.revoked.aborted ||
          this.entries.get(scope) !== entry ||
          link.serviceEffect(sessionKey, scope.callId) !== scope ||
          !capture ||
          capture.stage !== 'recorded' ||
          !capture.eventSeq ||
          !connection.profile ||
          connection.deviceId !== capture.selection.deviceId ||
          connection.bindingRevision !== capture.selection.bindingRevision ||
          connection.profile.configRevision !== capture.selection.configRevision ||
          configuration.deviceId !== capture.selection.deviceId ||
          configuration.bindingRevision !== entry.expected.bindingRevision ||
          configuration.configRevision !== entry.expected.configRevision ||
          round?.roundRevision !== entry.expected.roundRevision ||
          capture.selection.bindingRevision !== entry.expected.bindingRevision ||
          capture.selection.frameId !== f.id ||
          capture.selection.width !== f.width ||
          capture.selection.height !== f.height ||
          capture.selection.artifact.size !== bytes.length ||
          capture.selection.artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')
        )
          return denied()
      }
      current()
      if (store.detectionResults.read(identity)) return denied()
      const result = await this.executor.recognizeFromWorker(
        deps,
        link,
        sessionKey,
        entry.expected,
        scope,
        { id: f.id as string, width: f.width as number, height: f.height as number, bytes, receivedAt },
        scope.revoked,
      )
      if (
        scope.revoked.aborted ||
        this.entries.get(scope) !== entry ||
        link.serviceEffect(sessionKey, scope.callId) !== scope
      )
        return denied()
      current()
      const receipt = {
        id: result.id,
        deviceId: result.deviceId,
        bindingRevision: result.bindingRevision,
        configRevision: result.configRevision,
        roundRevision: result.roundRevision,
        frameId: result.frame.id,
        width: result.frame.width,
        height: result.frame.height,
        sha256: result.hash,
        providerRequestId: result.providerRequestId,
        elapsedMs: result.completedAt - result.submittedAt,
        detections: result.detections,
      }
      // Durable metadata precedes worker reply / effect-journal completion. Failure never retries SDK.
      return store.detectionResults.save(identity, receipt, new Date().toISOString()).result
    } catch {
      return denied()
    }
  }
}
