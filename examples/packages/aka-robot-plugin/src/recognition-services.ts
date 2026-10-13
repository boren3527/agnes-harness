import type { ServiceDef } from '@agnes/extension-api'
import { waitForCheck } from './connection-services.js'
import { AkaProtocolError } from './protocol.js'

const uuid = '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
const roundSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' },
    roundRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    budget: { type: 'integer', minimum: 1, maximum: 100000 },
    reserved: { type: 'integer', minimum: 0, maximum: 100000 },
  },
  required: ['deviceId', 'roundRevision', 'budget', 'reserved'],
}
/** Explicit budget effect only. Does not connect, open a camera, upload or enable inference. */
export function registerRecognitionServices(register: (def: ServiceDef) => unknown, lifetime: AbortSignal) {
  register({
    name: 'aka.recognition.round.read',
    kind: 'effect',
    timeoutMs: 5000,
    maxResultBytes: 2048,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedBindingRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expectedConfigRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['expectedBindingRevision', 'expectedConfigRevision'],
    },
    outputSchema: { anyOf: [{ type: 'null' }, roundSchema] },
    async handler(input, ctx) {
      const signal = AbortSignal.any([lifetime, ctx.signal])
      signal.throwIfAborted()
      if (!input || typeof input !== 'object' || Array.isArray(input) || !ctx.recognitionBudget)
        throw new AkaProtocolError('Recognition round unavailable')
      const fields = Object.getOwnPropertyDescriptors(input)
      const bindingRevision = fields.expectedBindingRevision?.value
      const configRevision = fields.expectedConfigRevision?.value
      if (
        Reflect.ownKeys(fields).sort().join(',') !== 'expectedBindingRevision,expectedConfigRevision' ||
        Object.values(fields).some((field) => !('value' in field)) ||
        !Number.isSafeInteger(bindingRevision) ||
        bindingRevision < 1 ||
        !Number.isSafeInteger(configRevision) ||
        configRevision < 0
      )
        throw new AkaProtocolError('Recognition round unavailable')
      return await waitForCheck(
        ctx.recognitionBudget.request({
          operation: 'read',
          expectedBindingRevision: bindingRevision,
          expectedConfigRevision: configRevision,
        }),
        signal,
      )
    },
  })
  register({
    name: 'aka.recognition.round.start',
    kind: 'effect',
    timeoutMs: 5000,
    maxResultBytes: 2048,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedBindingRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expectedConfigRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expectedRoundRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
        startId: { type: 'string', pattern: uuid },
      },
      required: ['expectedBindingRevision', 'expectedConfigRevision', 'expectedRoundRevision', 'startId'],
    },
    outputSchema: roundSchema,
    async handler(input, ctx) {
      const fail = (): never => {
        throw new AkaProtocolError('Recognition round unavailable')
      }
      const signal = AbortSignal.any([lifetime, ctx.signal])
      signal.throwIfAborted()
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
      const fields = Object.getOwnPropertyDescriptors(input)
      if (
        Object.keys(fields).sort().join(',') !==
          'expectedBindingRevision,expectedConfigRevision,expectedRoundRevision,startId' ||
        Object.values(fields).some((field) => !('value' in field))
      )
        return fail()
      const bindingRevision = fields.expectedBindingRevision?.value as number,
        configRevision = fields.expectedConfigRevision?.value as number,
        roundRevision = fields.expectedRoundRevision?.value as number,
        startId = fields.startId?.value as string
      if (
        !Number.isSafeInteger(bindingRevision) ||
        bindingRevision < 1 ||
        !Number.isSafeInteger(configRevision) ||
        configRevision < 1 ||
        !Number.isSafeInteger(roundRevision) ||
        roundRevision < 0 ||
        roundRevision >= Number.MAX_SAFE_INTEGER ||
        typeof startId !== 'string' ||
        !new RegExp(uuid).test(startId) ||
        !ctx.recognitionBudget ||
        !ctx.device?.retainRecognition ||
        !ctx.session?.key
      )
        return fail()
      const lease = await waitForCheck(ctx.device.retainRecognition(), signal, (late) => late.release())
      try {
        const live = () => {
          signal.throwIfAborted()
          lease.revoked.throwIfAborted()
          if (
            !lease.binding.active ||
            lease.binding.sessionId !== ctx.session?.key ||
            lease.binding.bindingRevision !== bindingRevision ||
            lease.recognition.deviceId !== lease.binding.deviceId ||
            lease.recognition.bindingRevision !== bindingRevision ||
            lease.recognition.configRevision !== configRevision ||
            !lease.recognition.settings
          )
            return fail()
        }
        live()
        // Await durable publication rather than pretending cancellation rolls it back.
        const result = await ctx.recognitionBudget.request({
          operation: 'start',
          expectedBindingRevision: bindingRevision,
          expectedConfigRevision: configRevision,
          expectedRoundRevision: roundRevision,
          startId,
        })
        live()
        if (
          !result ||
          'granted' in result ||
          result.deviceId !== lease.binding.deviceId ||
          result.roundRevision !== roundRevision + 1 ||
          !Number.isSafeInteger(result.budget) ||
          result.budget < 1 ||
          result.budget > 100000 ||
          !Number.isSafeInteger(result.reserved) ||
          result.reserved < 0 ||
          result.reserved > result.budget ||
          Object.keys(result).sort().join(',') !== 'budget,deviceId,reserved,roundRevision'
        )
          return fail()
        // Idempotent retries may return a round already used; never claim its count was reset to zero.
        return Object.freeze({ ...result })
      } finally {
        lease.release()
      }
    },
  })
}
