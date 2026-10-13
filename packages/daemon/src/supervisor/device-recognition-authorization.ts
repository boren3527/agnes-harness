import { pluginRowSource } from '@agnes/host'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import type { WorkerLink, WorkerServiceEffectScope } from './worker-link.js'

type Stage = 'upload-authorize' | 'upload' | 'detect'
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}

/** Daemon-only bridge to current Host checks. A serialized worker claim cannot create this scope. */
export function workerRecognitionAuthorization(
  link: Pick<WorkerLink, 'serviceEffect' | 'command'>,
  scope: WorkerServiceEffectScope,
  signal: AbortSignal,
) {
  const revoked = AbortSignal.any([signal, scope.revoked])
  const live = () => {
    if (
      revoked.aborted ||
      scope.recoverOnly ||
      scope.extension !== pluginRowSource('ext:agnes-examples/aka-robot') ||
      !['aka.recognition.test', 'aka.recognition.enable'].includes(scope.service) ||
      link.serviceEffect(scope.sessionKey, scope.callId) !== scope
    )
      denied()
  }
  live()
  const check = async (stage: Stage, stageSignal: AbortSignal) => {
    try {
      live()
      stageSignal.throwIfAborted()
      if (!['upload-authorize', 'upload', 'detect'].includes(stage)) return denied()
      const result = await link.command(
        'deviceRecognition.authorize',
        { sessionKey: scope.sessionKey, callId: scope.callId, stage },
        { timeoutMs: 2000 },
      )
      live()
      stageSignal.throwIfAborted()
      const inspected = inspectJsonData(result, 1024)
      if (
        !inspected.ok ||
        !inspected.value ||
        typeof inspected.value !== 'object' ||
        Array.isArray(inspected.value) ||
        Object.keys(inspected.value).join(',') !== 'authorized' ||
        (inspected.value as Record<string, unknown>).authorized !== true
      )
        return denied()
    } catch {
      return denied()
    }
  }
  return Object.freeze({
    revoked,
    // Credentials are not read until the Host also permits the first cloud destination.
    assertAuthorized: () => check('upload-authorize', revoked),
    assertIOAuthorized: check,
  })
}
