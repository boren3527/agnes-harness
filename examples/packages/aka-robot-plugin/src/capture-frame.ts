import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { PluginExtensionAPI, ServiceContext, ToolContext } from '@agnes/extension-api'
import { readRegistration, sameRegistration } from './connection-profile.js'
import { type RuntimeOwner, waitForCheck } from './connection-services.js'
import { jpegDimensions } from './mjpeg.js'
import { AkaProtocolError } from './protocol.js'
import type { AkaRuntimePool, RuntimeRegistration } from './runtime.js'

export type CaptureDependencies = {
  api: PluginExtensionAPI
  pool: AkaRuntimePool
  registrations: ReadonlyMap<string, RuntimeRegistration>
  owners: Map<string, RuntimeOwner>
  busy: Set<string>
  interruptTask?: (sessionId: string | undefined, stopping?: boolean, deviceId?: string) => Promise<void>
  guardModelRelease?: (
    sessionId: string,
    deviceId: string,
    turn: number | undefined,
    fromModel: boolean,
  ) => void
  guardModelAction?: (
    sessionId: string,
    deviceId: string,
    turn: number | undefined,
    fromModel: boolean,
    workflow?: string,
  ) => void
}
export type CaptureSelection = Parameters<NonNullable<ServiceContext['captureArtifacts']>['save']>[1]
type CaptureContext = Pick<ToolContext, 'device' | 'authorize' | 'signal'> & { session?: { key: string } }

/** One qualification path for model and page captures. Holds the device slot through actual persistence. */
export async function withCaptureFrame<T>(
  deps: CaptureDependencies,
  ctx: CaptureContext,
  consume: (frame: {
    bytes: Buffer
    receivedAt: number
    selection: CaptureSelection
    signal: AbortSignal
    verify(): Promise<void>
  }) => Promise<T>,
  expected?: { bindingRevision: number; configRevision: number; afterReceivedAt?: number },
): Promise<T> {
  const fail = (): never => {
    throw new AkaProtocolError('Current camera capture unavailable')
  }
  const signal = AbortSignal.any([deps.api.ctx.signal, ctx.signal])
  signal.throwIfAborted()
  if (!ctx.device || !ctx.session?.key) return fail()
  const device = ctx.device,
    sessionId = ctx.session.key
  const binding = await waitForCheck(device.binding(), signal)
  if (!binding?.active || binding.sessionId !== sessionId) return fail()
  const id = binding.deviceId.toLowerCase()
  if (deps.busy.has(id)) return fail()
  deps.busy.add(id)
  try {
    const registration = await waitForCheck(readRegistration(device, binding, deps.registrations), signal)
    if (
      expected &&
      (binding.bindingRevision !== expected.bindingRevision ||
        registration?.configRevision !== expected.configRevision)
    )
      return fail()
    const owner = deps.owners.get(id)
    if (
      !registration ||
      !owner?.revoked ||
      owner.revoked.aborted ||
      owner.workspaceId !== binding.workspaceId ||
      owner.bindingRevision !== binding.bindingRevision ||
      owner.source !== (typeof device.connection === 'function' ? 'persisted' : 'legacy') ||
      !sameRegistration(owner.registration, registration)
    )
      return fail()
    const active = AbortSignal.any([signal, owner.revoked])
    const runtime = deps.pool.find(registration)
    if (!runtime) return fail()
    const initial = runtime.snapshot()
    const verify = async () => {
      active.throwIfAborted()
      const current = await waitForCheck(device.binding(), active)
      if (
        !current?.active ||
        current.sessionId !== sessionId ||
        current.deviceId.toLowerCase() !== id ||
        current.workspaceId !== binding.workspaceId ||
        current.bindingRevision !== binding.bindingRevision
      )
        return fail()
      const configuration = await waitForCheck(readRegistration(device, current, deps.registrations), active)
      active.throwIfAborted()
      const state = runtime.snapshot()
      if (
        !configuration ||
        !sameRegistration(configuration, registration) ||
        deps.owners.get(id) !== owner ||
        deps.pool.find(registration) !== runtime ||
        state.instanceId !== initial.instanceId ||
        state.generation !== initial.generation ||
        state.mediaGeneration !== initial.mediaGeneration ||
        state.connection !== 'connected' ||
        state.identity !== 'matched' ||
        state.media !== 'streaming' ||
        state.control.phase !== 'idle'
      )
        return fail()
    }
    const decision = await waitForCheck(
      ctx.authorize('select', { kind: 'datasource', id: `aka/device/${id}/media` }),
      active,
    )
    if (decision.effect !== 'allow') return fail()
    await verify()
    const after = Math.max(expected?.afterReceivedAt ?? 0, runtime.captureReadyAfter())
    if (after > 0) {
      // Wait for a frame received after settling, rather than saving the buffered turning frame.
      const deadline = Math.max(performance.now(), after) + 2000
      while ((runtime.latestFrame()?.receivedAt ?? 0) <= after) {
        if (performance.now() >= deadline) return fail()
        await delay(50, undefined, { signal: active })
        await verify()
      }
    }
    const frame = runtime.latestFrame()
    if (
      frame?.timeBasis !== 'bridge_receive' ||
      frame.bytes.length > 4 * 1024 * 1024 ||
      frame.receivedAt <= after
    )
      return fail()
    const age = performance.now() - frame.receivedAt
    if (!Number.isFinite(age) || age < 0 || age > 1000) return fail()
    const bytes = Buffer.from(frame.bytes),
      size = jpegDimensions(bytes)
    if (size.width !== frame.width || size.height !== frame.height) return fail()
    const hash = createHash('sha256').update(bytes).digest('hex')
    const selectedAt = new Date().toISOString()
    const selection: CaptureSelection = Object.freeze({
      deviceId: id,
      bindingRevision: binding.bindingRevision,
      configRevision: registration.configRevision,
      frameId: frame.id,
      width: frame.width,
      height: frame.height,
      timeBasis: frame.timeBasis,
      ageAtSelectionMs: age,
      selectedAt,
      artifact: Object.freeze({ sha256: hash, size: bytes.length, mime: 'image/jpeg' }),
    })
    const verifyPublication = async () => {
      await verify()
      const decision = await waitForCheck(
        ctx.authorize('select', { kind: 'datasource', id: `aka/device/${id}/media` }),
        active,
      )
      if (decision.effect !== 'allow') return fail()
      await verify()
    }
    return await consume({
      bytes,
      receivedAt: frame.receivedAt,
      selection,
      signal: active,
      verify: verifyPublication,
    })
  } catch {
    return fail()
  } finally {
    deps.busy.delete(id)
  }
}
