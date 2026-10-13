import type {
  Actor,
  DeviceCaptureRecord,
  DeviceCaptureSelection,
  JsonValue,
  ServiceCapability,
} from '@agnes/protocol'
import { validateServiceCapability } from '@agnes/protocol'
import type { DeviceSessionPort, Logger, PlatformView, SessionRef } from './common.js'
import type { ToolContext } from './tool.js'

export type { ServiceCapability } from '@agnes/protocol'
export type ServiceKind = ServiceCapability['kind']
/** Service-only budget operation; Host fixes session and live call identity. No credential access. */
export type DeviceRecognitionBudgetRequest = Readonly<
  {
    expectedBindingRevision: number
    expectedConfigRevision: number
  } & (
    | { operation: 'read' }
    | { operation: 'start'; expectedRoundRevision: number; startId: string }
    | { operation: 'reserve'; expectedRoundRevision: number; attemptId: string }
  )
>
export type DeviceRecognitionBudgetRound = Readonly<{
  deviceId: string
  roundRevision: number
  budget: number
  reserved: number
}>
export interface DeviceRecognitionBudgetPort {
  request(
    input: DeviceRecognitionBudgetRequest,
  ): Promise<
    DeviceRecognitionBudgetRound | Readonly<{ granted: boolean; round: DeviceRecognitionBudgetRound }> | null
  >
}
/** Service-only single-image inference. Host fixes the call, provider, credentials and budget. */
export interface DeviceRecognitionPort {
  run(
    expected: Readonly<{ bindingRevision: number; configRevision: number; roundRevision: number }>,
    select: (
      signal: AbortSignal,
    ) => Promise<
      Readonly<{ id: string; receivedAt: number; width: number; height: number; bytes: Uint8Array }>
    >,
    verifySelection?: () => Promise<void>,
  ): Promise<
    Readonly<{
      id: string
      deviceId: string
      bindingRevision: number
      configRevision: number
      roundRevision: number
      frameId: string
      width: number
      height: number
      sha256: string
      providerRequestId: string
      elapsedMs: number
      detections: readonly Readonly<{
        label: string
        confidence: number
        box: readonly [number, number, number, number]
      }>[]
    }>
  >
}

export interface ServiceContext {
  /** Optional admitted AKA effect only; selecting/configuring does not automatically run inference. */
  readonly recognition?: Readonly<DeviceRecognitionPort>
  /** Supporting Hosts expose this only to admitted AKA capture/test effects, never arbitrary event append. */
  readonly captureArtifacts?: Readonly<{
    read(): Promise<DeviceCaptureRecord | null>
    save(bytes: Uint8Array, selection: DeviceCaptureSelection): Promise<DeviceCaptureRecord>
    recover(): Promise<DeviceCaptureRecord>
    publish(): Promise<DeviceCaptureRecord>
  }>
  /** Only authorized recognition effect services on supporting hosts; absent for queries/tools. */
  readonly recognitionBudget?: Readonly<DeviceRecognitionBudgetPort>
  /** Fresh host-owned enrollment lookup for this invocation only; never physical control authority. */
  readonly device?: Readonly<DeviceSessionPort>
  /** Host-resolved session/workspace identity; absent for non-session embeddings and older hosts.
   * This is data, never a substitute for authorization, and cannot be supplied in service input.
   */
  readonly session?: Readonly<Pick<SessionRef, 'key' | 'workspaceRoot'>>
  readonly actor: Actor
  readonly source: string
  readonly requestId: string
  readonly cwd: string
  readonly exec: ToolContext['exec']
  readonly fs: ToolContext['fs']
  readonly net: ToolContext['net']
  readonly artifacts: ToolContext['artifacts']
  readonly authorize: ToolContext['authorize']
  // Same read-only view a tool gets; services never get sandbox (they do not spawn).
  readonly platform: PlatformView
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly log: Logger
}
export interface ServiceDef<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue>
  extends ServiceCapability {
  handler(input: I, ctx: ServiceContext): Promise<O>
}
/** Static data contract only; Host compiles schemas and enforces grants before invoking handlers. */
export function checkServiceDef(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  try {
    if (def === null || typeof def !== 'object') throw new Error('object required')
    if (
      Reflect.ownKeys(def).some(
        (key) => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(def, key) ?? {})),
      )
    )
      throw new Error('data fields required')
    const capability = { ...def } as Record<string, unknown>
    const handler = Object.getOwnPropertyDescriptor(def, 'handler')?.value
    delete capability.handler
    const checked = validateServiceCapability(capability)
    if (typeof handler !== 'function') return { ok: false, problems: ['handler: expected function'] }
    return checked.ok
      ? { ok: true }
      : { ok: false, problems: checked.errors.map((e) => `${e.path}: ${e.message}`) }
  } catch {
    return { ok: false, problems: ['service: invalid definition'] }
  }
}
