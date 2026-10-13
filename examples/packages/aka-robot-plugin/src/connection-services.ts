import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import { readRegistration, registrationFromConnection, sameRegistration } from './connection-profile.js'
import { AkaProtocolError } from './protocol.js'
import type { AkaRuntimePool, RuntimeRegistration } from './runtime.js'

export interface RuntimeOwner {
  /** The connection claimant owns physical control until explicit disconnect. */
  sessionId?: string
  workspaceId: string
  bindingRevision: number
  registration: Readonly<RuntimeRegistration>
  source: 'persisted' | 'legacy'
  revoked?: AbortSignal
  release?(): void
}

/** Cancels this invocation's wait, not a remote operation. Late outcomes are consumed. */
export function waitForCheck<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  discard?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (succeeded: boolean, value: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      if (succeeded) resolve(value as T)
      else reject(value)
    }
    const cancel = () => finish(false, new AkaProtocolError('Device operation cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    void pending.then(
      (value) => {
        if (settled) discard?.(value)
        else finish(true, value)
      },
      (error: unknown) => finish(false, error),
    )
    if (signal.aborted) cancel()
  })
}

/** Only called by the trusted in-process plugin, through Host-admitted effect services.
 * Native transport is not the managed query net port and does not claim OS isolation.
 */
export function registerConnectionServices(
  register: (def: ServiceDef) => unknown,
  deps: {
    lifetime: AbortSignal
    pool: AkaRuntimePool
    registrations: ReadonlyMap<string, RuntimeRegistration>
    owners: Map<string, RuntimeOwner>
    busy?: Set<string>
  },
): void {
  const busy = deps.busy ?? new Set<string>()
  const inputSchema: ServiceDef['inputSchema'] = {
    type: 'object',
    additionalProperties: false,
    properties: { configRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    required: ['configRevision'],
  }
  const outputSchema: ServiceDef['outputSchema'] = {
    type: 'object',
    additionalProperties: false,
    properties: { state: { enum: ['connected', 'disconnected'] }, snapshot: { type: 'object' } },
    required: ['state', 'snapshot'],
  }
  for (const action of ['connect', 'disconnect', 'camera.set'] as const) {
    register({
      name: `aka.${action}`,
      kind: 'effect',
      inputSchema:
        action === 'camera.set'
          ? {
              ...inputSchema,
              properties: { ...(inputSchema.properties as object), open: { type: 'boolean' } },
              required: ['configRevision', 'open'],
            }
          : inputSchema,
      outputSchema:
        action === 'camera.set'
          ? {
              ...outputSchema,
              properties: {
                state: { enum: ['opening', 'streaming', 'closed'] },
                snapshot: { type: 'object' },
              },
            }
          : outputSchema,
      timeoutMs: 15000,
      maxResultBytes: 8192,
      async handler(input, ctx: ServiceContext) {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          !Number.isSafeInteger(input.configRevision) ||
          Object.keys(input).some(
            (key) => key !== 'configRevision' && !(action === 'camera.set' && key === 'open'),
          ) ||
          (action === 'camera.set' && typeof input.open !== 'boolean')
        )
          throw new AkaProtocolError('Invalid device connection request')
        const sessionKey = ctx.session?.key
        const device = ctx.device
        const operation = AbortSignal.any([deps.lifetime, ctx.signal])
        let bindingSignal: AbortSignal | undefined
        const live = () => {
          deps.lifetime.throwIfAborted()
          ctx.signal.throwIfAborted()
          bindingSignal?.throwIfAborted()
        }
        live()
        if (!sessionKey || !device) throw new AkaProtocolError('Device effect requires a session binding')
        const initial = await waitForCheck(device.binding(), operation)
        live()
        if (!initial?.active || initial.sessionId !== sessionKey)
          throw new AkaProtocolError('Device binding is not active for this session')
        const id = initial.deviceId.toLowerCase()
        const source = device.connection ? 'persisted' : 'legacy'
        const registration = await waitForCheck(
          readRegistration(device, initial, deps.registrations),
          operation,
        )
        live()
        if (!registration || input.configRevision !== registration.configRevision)
          throw new AkaProtocolError('Device configuration missing or changed')
        if (busy.has(id)) throw new AkaProtocolError('Device connection operation busy')
        busy.add(id)
        const owner = { workspaceId: initial.workspaceId, bindingRevision: initial.bindingRevision }
        const retainedOwner = deps.owners.get(id)
        if (
          retainedOwner?.sessionId === sessionKey &&
          retainedOwner.workspaceId === owner.workspaceId &&
          retainedOwner.bindingRevision === owner.bindingRevision &&
          !retainedOwner.revoked?.aborted &&
          retainedOwner.source === source &&
          sameRegistration(retainedOwner.registration, registration)
        )
          bindingSignal = retainedOwner.revoked
        const verify = async () => {
          live()
          const current = await waitForCheck(
            device.binding(),
            bindingSignal ? AbortSignal.any([operation, bindingSignal]) : operation,
          )
          live()
          if (
            !current?.active ||
            current.sessionId !== sessionKey ||
            current.deviceId.toLowerCase() !== id ||
            current.workspaceId !== owner.workspaceId ||
            current.bindingRevision !== owner.bindingRevision
          )
            throw new AkaProtocolError('Device binding changed during operation')
          const currentRegistration = await waitForCheck(
            readRegistration(device, current, deps.registrations),
            bindingSignal ? AbortSignal.any([operation, bindingSignal]) : operation,
          )
          live()
          if (!currentRegistration || !sameRegistration(registration, currentRegistration))
            throw new AkaProtocolError('Device configuration changed during operation')
        }
        let connecting = false
        let cameraStarted = false
        let claimed: RuntimeOwner | undefined
        try {
          const decision = await waitForCheck(
            ctx.authorize('execute', {
              kind: 'datasource',
              id: `aka/device/${id}${action === 'camera.set' ? '/camera' : ''}`,
            }),
            bindingSignal ? AbortSignal.any([operation, bindingSignal]) : operation,
          )
          live()
          if (decision.effect !== 'allow') throw new AkaProtocolError('Device effect authorization denied')
          await verify()
          const previous = deps.owners.get(id)
          if (
            previous &&
            (previous.sessionId !== sessionKey ||
              previous.revoked?.aborted ||
              previous.workspaceId !== owner.workspaceId ||
              previous.bindingRevision !== owner.bindingRevision ||
              previous.source !== source ||
              !sameRegistration(previous.registration, registration))
          ) {
            if (action !== 'connect') throw new AkaProtocolError('Device connection configuration changed')
            deps.pool.release(id)
            deps.owners.delete(id)
            previous.release?.()
          }
          if (!deps.owners.has(id)) deps.pool.release(id)
          const runtime = deps.pool.get(registration)
          if (action === 'camera.set') {
            if (
              !previous ||
              deps.owners.get(id) !== previous ||
              runtime.snapshot().connection !== 'connected'
            )
              throw new AkaProtocolError('Camera effect requires a retained connection')
            if (input.open) {
              if (!['opening', 'streaming'].includes(runtime.snapshot().media)) {
                cameraStarted = true
                const openingSignal = bindingSignal ? AbortSignal.any([operation, bindingSignal]) : operation
                await waitForCheck(runtime.openCamera(30, openingSignal), openingSignal)
              }
            } else {
              const closingSignal = bindingSignal ? AbortSignal.any([operation, bindingSignal]) : operation
              await waitForCheck(runtime.closeCamera(closingSignal), closingSignal)
            }
            await verify()
            const snapshot = runtime.snapshot()
            if (
              snapshot.connection !== 'connected' ||
              deps.owners.get(id) !== previous ||
              (input.open && !['opening', 'streaming'].includes(snapshot.media)) ||
              (!input.open && snapshot.cameraOn !== false)
            )
              throw new AkaProtocolError('Camera effect outcome unavailable')
            return JSON.parse(JSON.stringify({ state: input.open ? snapshot.media : 'closed', snapshot }))
          } else if (action === 'disconnect') {
            // Retire subscriptions locally; disconnect is not hardware camera close or motor stop.
            runtime.disconnect()
            deps.owners.delete(id)
            previous?.release?.()
          } else {
            if (runtime.snapshot().connection !== 'connected') {
              if (!device.retain) throw new AkaProtocolError('Device binding lifetime unavailable')
              const lease = await waitForCheck(device.retain(), operation, (late) => late.release())
              bindingSignal = lease.revoked
              const binding = lease.binding
              if (
                !binding.active ||
                binding.sessionId !== sessionKey ||
                binding.deviceId.toLowerCase() !== id ||
                binding.workspaceId !== owner.workspaceId ||
                binding.bindingRevision !== owner.bindingRevision ||
                lease.revoked.aborted
              ) {
                lease.release()
                throw new AkaProtocolError('Device binding lifetime changed')
              }
              if (device.connection) {
                try {
                  const retained = lease.connection && registrationFromConnection(binding, lease.connection)
                  if (!retained || !sameRegistration(registration, retained))
                    throw new AkaProtocolError('Device configuration lifetime missing or changed')
                } catch (error) {
                  lease.release()
                  throw error
                }
              }
              const revoke = () => {
                if (deps.owners.get(id) !== claimed) return
                deps.owners.delete(id)
                deps.pool.release(id)
                claimed?.release?.()
              }
              claimed = Object.freeze({
                ...owner,
                sessionId: sessionKey,
                registration,
                source,
                revoked: lease.revoked,
                release: () => {
                  lease.revoked.removeEventListener('abort', revoke)
                  lease.release()
                },
              })
              previous?.release?.()
              deps.owners.set(id, claimed)
              lease.revoked.addEventListener('abort', revoke, { once: true })
              if (lease.revoked.aborted) {
                revoke()
                throw new AkaProtocolError('Device binding lifetime revoked')
              }
              connecting = true
              // Cancellation retires this runtime in the catch before the per-device lock is freed.
              const connectionSignal = AbortSignal.any([operation, lease.revoked])
              await waitForCheck(runtime.connect(connectionSignal, verify), connectionSignal)
            }
            await verify()
            if (runtime.snapshot().connection !== 'connected')
              throw new AkaProtocolError('Device connection lost before completion')
            if (!deps.owners.has(id)) throw new AkaProtocolError('Device binding lifetime lost')
          }
          live()
          return JSON.parse(
            JSON.stringify({
              state: action === 'connect' ? 'connected' : 'disconnected',
              snapshot: runtime.snapshot(),
            }),
          )
        } catch (error) {
          // A failed attempt may already have opened a socket; retire it, never replay automatically.
          if (connecting || cameraStarted) {
            deps.pool.release(id)
            const retired = deps.owners.get(id)
            deps.owners.delete(id)
            ;(claimed ?? retired)?.release?.()
          }
          throw error
        } finally {
          busy.delete(id)
        }
      },
    })
  }
}
