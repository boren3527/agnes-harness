import { createHash, randomUUID } from 'node:crypto'
import {
  copyRecognitionFrame,
  createAliRecognitionPipeline,
  parseAliDetections,
  type RecognitionFrame,
} from '@agnes/host'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import { workerRecognitionAuthorization } from './device-recognition-authorization.js'
import { workerDeviceRecognitionBudget } from './device-recognition-budget.js'
import { resolveDeviceRecognitionCredentialForEffect } from './device-recognition-credential.js'
import type { WorkerLink, WorkerServiceEffectScope } from './worker-link.js'

type Dependencies = Parameters<typeof resolveDeviceRecognitionCredentialForEffect>[0]
type Authorization = Parameters<typeof resolveDeviceRecognitionCredentialForEffect>[4] &
  Readonly<{
    assertIOAuthorized(stage: 'upload-authorize' | 'upload' | 'detect', signal: AbortSignal): Promise<void>
  }>
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}

/** One daemon-owned instance per device store. Private backend execution, never a secret-bearing RPC.
 * Invoker grants, account-wide IO admission and a live effect scope are mandatory caller inputs.
 * Continuous jobs need their own retained authorization; a finished service scope cannot run a job.
 */
export class DeviceRecognitionExecutor {
  private readonly inFlight = new Set<string>()
  // Conservative shared limit: all cloud accounts in this daemon share one real SDK slot.
  private cloudBusy = false
  private lastCloudDispatch = Number.NEGATIVE_INFINITY
  private readonly lastDeviceDispatch = new Map<string, number>()

  private assertDispatchInterval(deviceId: string, frequency: 0.5 | 1 | 2): void {
    const now = performance.now()
    if (
      !Number.isFinite(now) ||
      now - this.lastCloudDispatch < 500 ||
      now - (this.lastDeviceDispatch.get(deviceId) ?? Number.NEGATIVE_INFINITY) < 1000 / frequency
    )
      denied()
    // No device needs a dispatch timestamp older than the slowest supported interval.
    for (const [id, at] of this.lastDeviceDispatch) if (now - at >= 2000) this.lastDeviceDispatch.delete(id)
  }

  /** Round changes share this exact executor; checking and store start must have no await between. */
  assertIdle(deviceId: string): void {
    if (this.inFlight.has(deviceId)) denied()
  }

  /** Production worker admission must use its original pending effect, never an author callback. */
  async recognizeFromWorker(
    deps: Dependencies,
    link: Pick<WorkerLink, 'serviceEffect' | 'command'>,
    sessionKey: string,
    expected: Parameters<DeviceRecognitionExecutor['execute']>[2],
    scope: WorkerServiceEffectScope | undefined,
    input: RecognitionFrame,
    signal: AbortSignal,
  ) {
    try {
      if (!scope || scope.sessionKey !== sessionKey) return denied()
      const authorization = workerRecognitionAuthorization(link, scope, signal)
      return await this.execute(deps, sessionKey, expected, scope, authorization, input, signal)
    } catch {
      return denied()
    }
  }

  async recognize(...args: Parameters<DeviceRecognitionExecutor['execute']>) {
    try {
      return await this.execute(...args)
    } catch {
      return denied()
    }
  }

  private async execute(
    deps: Dependencies,
    sessionKey: string,
    expected: Readonly<{ bindingRevision: number; configRevision: number; roundRevision: number }>,
    scope: WorkerServiceEffectScope | undefined,
    authorization: Authorization,
    input: RecognitionFrame,
    signal: AbortSignal,
  ) {
    const inspected = inspectJsonData(expected, 1024)
    if (!inspected.ok || !inspected.value || typeof inspected.value !== 'object') return denied()
    const versions = inspected.value as Record<string, unknown>
    if (
      Object.keys(versions).sort().join(',') !== 'bindingRevision,configRevision,roundRevision' ||
      Object.values(versions).some((v) => !Number.isSafeInteger(v) || (v as number) < 1)
    )
      return denied()
    const bindingRevision = versions.bindingRevision as number,
      configRevision = versions.configRevision as number,
      roundRevision = versions.roundRevision as number
    // receivedAt must belong to this process's monotonic clock, not a worker's performance.now().
    const frame = copyRecognitionFrame(input)
    const startedAt = performance.now()
    const fresh = (maxAge: number) => {
      const age = performance.now() - frame.receivedAt
      if (age < 0 || age > maxAge) return denied()
    }
    fresh(1000)
    const authority = await deps.workspaces.restoreBinding(sessionKey)
    if (authority.sessionKey !== sessionKey || !deps.bindings) return denied()
    const configuration = deps.bindings.recognition.read(authority)
    if (
      configuration.bindingRevision !== bindingRevision ||
      configuration.configRevision !== configRevision ||
      configuration.settings?.provider !== 'aliyun' ||
      !scope ||
      signal.aborted
    )
      return denied()
    const deviceId = configuration.deviceId
    const frequency = configuration.settings.frequency
    const owner = deps.ownership.resolve(sessionKey)
    const bindings = deps.bindings
    if (this.inFlight.has(deviceId) || this.cloudBusy) return denied()
    this.assertDispatchInterval(deviceId, frequency)
    this.inFlight.add(deviceId)
    this.cloudBusy = true
    let pipeline: Awaited<ReturnType<typeof createAliRecognitionPipeline>> | undefined
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(10000 - (performance.now() - startedAt))))
    const cancellation = AbortSignal.any([signal, deadline])
    const attemptId = randomUUID()
    const hash = createHash('sha256').update(frame.bytes).digest('hex')
    let submittedAt: number | undefined
    const live = () => {
      const currentOwner = deps.ownership.resolve(sessionKey)
      const current = bindings.recognition.read(authority)
      if (
        cancellation.aborted ||
        scope.revoked.aborted ||
        authorization.revoked.aborted ||
        !owner?.active ||
        !currentOwner?.active ||
        currentOwner.principalId !== owner.principalId ||
        deps.bindings !== bindings ||
        current.deviceId !== deviceId ||
        current.bindingRevision !== bindingRevision ||
        current.configRevision !== configRevision ||
        performance.now() - startedAt >= 10000
      )
        return denied()
    }
    try {
      live()
      // Reject known unusable rounds before reading credentials or uploading an image.
      // This read does not claim capacity; staged detect admission still reserves atomically.
      const budget = bindings.recognitionBudget.read(authority)
      if (
        !budget ||
        budget.deviceId !== deviceId ||
        budget.roundRevision !== roundRevision ||
        budget.reserved >= Math.min(budget.budget, configuration.settings.requestBudget)
      )
        return denied()
      const access = await resolveDeviceRecognitionCredentialForEffect(
        deps,
        sessionKey,
        { bindingRevision, configRevision },
        scope,
        authorization,
        cancellation,
      )
      if (access.provider !== 'aliyun') return denied()
      const admit = async (stage: 'upload-authorize' | 'upload' | 'detect', stageSignal: AbortSignal) => {
        live()
        if ((await authorization.assertIOAuthorized(stage, stageSignal)) !== undefined) return denied()
        await access.check()
        live()
        fresh(stage === 'upload-authorize' ? 1000 : 5000)
        if (stage !== 'detect') return
        const claim = await workerDeviceRecognitionBudget(
          deps,
          sessionKey,
          {
            operation: 'reserve',
            callId: scope.callId,
            expectedBindingRevision: bindingRevision,
            expectedConfigRevision: configRevision,
            expectedRoundRevision: roundRevision,
            attemptId,
          },
          scope,
        )
        if (!claim || !('granted' in claim) || claim.granted !== true) return denied()
        // Reservations are durable even if the grant or configuration changes while awaiting admission.
        if ((await authorization.assertIOAuthorized(stage, stageSignal)) !== undefined) return denied()
        await access.check()
        live()
        fresh(5000)
        this.assertDispatchInterval(deviceId, frequency)
        submittedAt = performance.now()
        this.lastCloudDispatch = submittedAt
        this.lastDeviceDispatch.set(deviceId, submittedAt)
      }
      pipeline = await access.run(async (credentials) => createAliRecognitionPipeline(credentials, admit))
      const active = pipeline
      const token = await access.run((_credentials, currentSignal) => active.upload(frame, currentSignal))
      const response = await access.run((_credentials, currentSignal) => active.detect(token, currentSignal))
      live()
      if (submittedAt === undefined) return denied()
      const detections = parseAliDetections(response, frame.width, frame.height)
      const providerRequestId = (response as { RequestId: unknown }).RequestId
      if (typeof providerRequestId !== 'string' || !providerRequestId) return denied()
      return Object.freeze({
        id: attemptId,
        deviceId,
        bindingRevision,
        configRevision,
        roundRevision,
        frame: Object.freeze({ ...frame, bytes: Uint8Array.from(frame.bytes) }),
        hash,
        submittedAt,
        completedAt: performance.now(),
        providerRequestId,
        detections: Object.freeze(
          detections.map((detection) =>
            Object.freeze({
              ...detection,
              box: Object.freeze([...detection.box] as [number, number, number, number]),
            }),
          ),
        ),
      })
    } catch {
      // No signed URL, credentials, storage path or provider error reaches an untrusted reply.
      return denied()
    } finally {
      try {
        pipeline?.close()
      } finally {
        this.inFlight.delete(deviceId)
        this.cloudBusy = false
      }
    }
  }
}
