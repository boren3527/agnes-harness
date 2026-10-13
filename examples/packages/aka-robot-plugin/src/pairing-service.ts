import type { DeviceSessionPort, ServiceDef } from '@agnes/extension-api'
import { registrationFromConnection, sameRegistration } from './connection-profile.js'
import { waitForCheck } from './connection-services.js'
import { AkaHttpDriver } from './http-driver.js'
import { AkaProtocolError, robotEndpoint } from './protocol.js'

/** An explicitly admitted, finite heartbeat probe. No profile write, camera or motor effect. */
export function registerPairingService(
  register: (def: ServiceDef) => unknown,
  deps: { lifetime: AbortSignal; busy: Set<string> },
): void {
  register({
    name: 'aka.probe',
    kind: 'effect',
    timeoutMs: 15000,
    maxResultBytes: 2048,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ip: { type: 'string', minLength: 7, maxLength: 15 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        bindingRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expectedConfigRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
      },
      required: ['ip', 'port', 'bindingRevision', 'expectedConfigRevision'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deviceId: { type: 'string' },
        bindingRevision: { type: 'integer' },
        expectedConfigRevision: { type: 'integer' },
        ip: { type: 'string' },
        port: { type: 'integer' },
        macAddress: { type: 'string' },
        identity: { const: 'reported' },
      },
      required: [
        'deviceId',
        'bindingRevision',
        'expectedConfigRevision',
        'ip',
        'port',
        'macAddress',
        'identity',
      ],
    },
    async handler(input, ctx) {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !['ip', 'port', 'bindingRevision', 'expectedConfigRevision'].includes(key),
        ) ||
        typeof input.ip !== 'string' ||
        typeof input.port !== 'number' ||
        typeof input.bindingRevision !== 'number' ||
        !Number.isSafeInteger(input.bindingRevision) ||
        input.bindingRevision < 1 ||
        typeof input.expectedConfigRevision !== 'number' ||
        !Number.isSafeInteger(input.expectedConfigRevision) ||
        input.expectedConfigRevision < 0 ||
        input.expectedConfigRevision >= Number.MAX_SAFE_INTEGER
      )
        throw new AkaProtocolError('Invalid device probe request')
      // Canonical private IPv4 and port validation, before authorization or any network I/O.
      robotEndpoint(input.ip, input.port)
      const device = ctx.device
      const key = ctx.session?.key
      if (!key || !device?.connection || !device.retain)
        throw new AkaProtocolError('Device probe requires configuration and lifetime ports')
      const readConnection = device.connection.bind(device)
      const operation = AbortSignal.any([deps.lifetime, ctx.signal])
      operation.throwIfAborted()
      const binding = await waitForCheck(device.binding(), operation)
      if (!binding?.active || binding.sessionId !== key || binding.bindingRevision !== input.bindingRevision)
        throw new AkaProtocolError('Device probe binding unavailable or changed')
      const id = binding.deviceId.toLowerCase()
      if (deps.busy.has(id) || deps.busy.size >= 32)
        throw new AkaProtocolError('Device connection operation busy')
      deps.busy.add(id)
      let lease: Awaited<ReturnType<NonNullable<DeviceSessionPort['retain']>>> | undefined
      try {
        const initial = await waitForCheck(device.connection(), operation)
        const registration = registrationFromConnection(binding, initial)
        if ((registration?.configRevision ?? 0) !== input.expectedConfigRevision)
          throw new AkaProtocolError('Device probe configuration changed')
        const decision = await waitForCheck(
          ctx.authorize('execute', {
            kind: 'datasource',
            id: `aka/device/${id}/pairing`,
          }),
          operation,
        )
        operation.throwIfAborted()
        if (decision.effect !== 'allow') throw new AkaProtocolError('Device probe authorization denied')
        lease = await waitForCheck(device.retain(), operation, (late) => late.release())
        const leased = lease.binding
        if (
          !lease.connection ||
          !leased.active ||
          leased.sessionId !== key ||
          leased.deviceId !== binding.deviceId ||
          leased.workspaceId !== binding.workspaceId ||
          leased.bindingRevision !== binding.bindingRevision
        )
          throw new AkaProtocolError('Device probe lifetime changed')
        const retainedRegistration = registrationFromConnection(leased, lease.connection)
        if (
          registration
            ? !retainedRegistration || !sameRegistration(registration, retainedRegistration)
            : retainedRegistration
        )
          throw new AkaProtocolError('Device probe configuration lifetime changed')
        const signal = AbortSignal.any([operation, lease.revoked])
        const verify = async () => {
          signal.throwIfAborted()
          const current = await waitForCheck(device.binding(), signal)
          if (
            !current?.active ||
            current.sessionId !== key ||
            current.deviceId !== binding.deviceId ||
            current.workspaceId !== binding.workspaceId ||
            current.bindingRevision !== binding.bindingRevision
          )
            throw new AkaProtocolError('Device probe binding changed')
          const profile = registrationFromConnection(current, await waitForCheck(readConnection(), signal))
          signal.throwIfAborted()
          if (registration ? !profile || !sameRegistration(registration, profile) : profile)
            throw new AkaProtocolError('Device probe configuration changed')
        }
        await verify()
        const heartbeat = await waitForCheck(
          new AkaHttpDriver(input.ip, input.port).heartbeat(signal),
          signal,
        )
        await verify()
        if (heartbeat.identity.validity !== 'reported' || !heartbeat.identity.macAddress)
          throw new AkaProtocolError('Device probe reported identity unavailable')
        return {
          deviceId: binding.deviceId,
          bindingRevision: binding.bindingRevision,
          expectedConfigRevision: input.expectedConfigRevision,
          ip: input.ip,
          port: input.port,
          macAddress: heartbeat.identity.macAddress,
          identity: 'reported',
        }
      } finally {
        try {
          lease?.release()
        } finally {
          deps.busy.delete(id)
        }
      }
    },
  })
}
