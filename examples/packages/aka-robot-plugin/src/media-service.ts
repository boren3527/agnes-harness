import type { PluginExtensionAPI, ServiceDef } from '@agnes/extension-api'
import { readRegistration, sameRegistration } from './connection-profile.js'
import { type RuntimeOwner, waitForCheck } from './connection-services.js'
import { AkaMediaEgress, runtimeMediaSource } from './media-egress.js'
import { AkaProtocolError } from './protocol.js'
import type { AkaRuntimePool, RuntimeRegistration } from './runtime.js'

/** Read admission for already authorized camera media. No camera/network-to-robot side effect. */
export function registerMediaService(
  register: (def: ServiceDef) => unknown,
  deps: {
    api: PluginExtensionAPI
    pool: AkaRuntimePool
    registrations: ReadonlyMap<string, RuntimeRegistration>
    owners: Map<string, RuntimeOwner>
  },
): void {
  const lifetime = deps.api.ctx.signal
  const egress = new AkaMediaEgress(lifetime)
  let endpoint: Promise<ReturnType<NonNullable<PluginExtensionAPI['deviceMedia']>['register']>> | undefined
  const ensureEndpoint = () => {
    if (!endpoint)
      endpoint = (async () => {
        if (!deps.api.deviceMedia) throw new AkaProtocolError('Host media registration unavailable')
        await egress.listen()
        lifetime.throwIfAborted()
        return deps.api.deviceMedia.register(egress.endpoint())
      })()
    return endpoint
  }
  register({
    name: 'aka.media.ticket',
    kind: 'query',
    timeoutMs: 5000,
    maxResultBytes: 2048,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        configRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        bindingRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['configRevision', 'bindingRevision'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
        expiresInMs: { const: 30_000 },
        deviceId: { type: 'string' },
        configRevision: { type: 'integer' },
        bindingRevision: { type: 'integer' },
        rowRevision: { type: 'string' },
      },
      required: ['ticket', 'expiresInMs', 'deviceId', 'configRevision', 'bindingRevision', 'rowRevision'],
    },
    async handler(input, ctx) {
      const operation = AbortSignal.any([lifetime, ctx.signal])
      operation.throwIfAborted()
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['bindingRevision', 'configRevision'].includes(key)) ||
        !Number.isSafeInteger(input.bindingRevision) ||
        !Number.isSafeInteger(input.configRevision) ||
        (input.bindingRevision as number) < 1 ||
        (input.configRevision as number) < 1 ||
        !ctx.device ||
        !ctx.session?.key
      )
        throw new AkaProtocolError('Invalid media ticket request')
      const device = ctx.device
      const sessionId = ctx.session.key
      const binding = await waitForCheck(device.binding(), operation)
      operation.throwIfAborted()
      if (
        !binding?.active ||
        binding.sessionId !== sessionId ||
        binding.bindingRevision !== input.bindingRevision
      )
        throw new AkaProtocolError('Media binding unavailable')
      const id = binding.deviceId.toLowerCase()
      // A read ticket must not reserve or wait for the motor/camera operation slot.
      const registration = await waitForCheck(
        readRegistration(device, binding, deps.registrations),
        operation,
      )
      operation.throwIfAborted()
      const owner = deps.owners.get(id)
      if (
        !registration ||
        registration.configRevision !== input.configRevision ||
        !owner?.revoked ||
        owner.revoked.aborted ||
        owner.workspaceId !== binding.workspaceId ||
        owner.bindingRevision !== binding.bindingRevision ||
        owner.source !== (typeof device.connection === 'function' ? 'persisted' : 'legacy') ||
        !sameRegistration(owner.registration, registration)
      )
        throw new AkaProtocolError('Media connection unavailable')
      const active = AbortSignal.any([operation, owner.revoked])
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
          throw new AkaProtocolError('Media binding changed')
        const configuration = await waitForCheck(
          readRegistration(device, current, deps.registrations),
          active,
        )
        active.throwIfAborted()
        if (!configuration || !sameRegistration(configuration, registration) || deps.owners.get(id) !== owner)
          throw new AkaProtocolError('Media configuration changed')
      }
      const decision = await waitForCheck(
        ctx.authorize('select', { kind: 'datasource', id: `aka/device/${id}/media` }),
        active,
      )
      if (decision.effect !== 'allow') throw new AkaProtocolError('Media read denied')
      await verify()
      const runtime = deps.pool.find(registration)
      if (!runtime) throw new AkaProtocolError('Media runtime unavailable')
      const snapshot = runtime.snapshot()
      if (
        snapshot.connection !== 'connected' ||
        snapshot.identity !== 'matched' ||
        !['opening', 'streaming'].includes(snapshot.media)
      )
        throw new AkaProtocolError('Media camera unavailable')
      const registered = await waitForCheck(ensureEndpoint(), active)
      await verify()
      const revoked = AbortSignal.any([lifetime, owner.revoked, registered.revoked])
      const source = runtimeMediaSource(
        {
          sessionId,
          deviceId: id,
          rowRevision: registered.rowRevision,
          runtimeInstanceId: snapshot.instanceId,
          bindingRevision: binding.bindingRevision,
          configRevision: registration.configRevision,
          connectionGeneration: snapshot.generation,
          mediaGeneration: snapshot.mediaGeneration,
        },
        runtime,
        revoked,
      )
      const check = () => {
        source.check()
        if (deps.owners.get(id) !== owner || deps.pool.find(registration) !== runtime)
          throw new AkaProtocolError('Media owner changed')
      }
      check()
      active.throwIfAborted()
      return {
        ...egress.issue({ ...source, check }),
        deviceId: id,
        configRevision: registration.configRevision,
        bindingRevision: binding.bindingRevision,
        rowRevision: registered.rowRevision,
      }
    },
  })
}
