import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import { type CaptureDependencies, type CaptureSelection, withCaptureFrame } from './capture-frame.js'
import { AkaProtocolError } from './protocol.js'

type Record = NonNullable<Awaited<ReturnType<NonNullable<ServiceContext['captureArtifacts']>['read']>>>
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const fail = (): never => {
  throw new AkaProtocolError('Current camera capture unavailable')
}

function sameSelection(a: CaptureSelection, b: CaptureSelection): boolean {
  return (
    (
      [
        'deviceId',
        'bindingRevision',
        'configRevision',
        'frameId',
        'width',
        'height',
        'selectedAt',
        'timeBasis',
        'ageAtSelectionMs',
      ] as const
    ).every((key) => a[key] === b[key]) &&
    a.artifact.sha256 === b.artifact.sha256 &&
    a.artifact.size === b.artifact.size &&
    a.artifact.mime === b.artifact.mime
  )
}

/** Page effect. The Host fixes the operation identity and owns durable recovery/publication. */
export function registerCaptureService(register: (def: ServiceDef) => unknown, deps: CaptureDependencies) {
  register({
    name: 'aka.capture',
    kind: 'effect',
    timeoutMs: 15000,
    maxResultBytes: 2048,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { bindingRevision: revision, configRevision: revision },
      required: ['bindingRevision', 'configRevision'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deviceId: { type: 'string' },
        bindingRevision: revision,
        configRevision: revision,
        frameId: { type: 'string' },
        eventSeq: revision,
        artifact: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            size: { type: 'integer', minimum: 1, maximum: 4 * 1024 * 1024 },
            mime: { const: 'image/jpeg' },
          },
          required: ['sha256', 'size', 'mime'],
        },
      },
      required: ['deviceId', 'bindingRevision', 'configRevision', 'frameId', 'eventSeq', 'artifact'],
    },
    async handler(input, ctx) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
        const fields = Object.getOwnPropertyDescriptors(input)
        if (
          Reflect.ownKeys(fields).sort().join(',') !== 'bindingRevision,configRevision' ||
          Object.values(fields).some((field) => !('value' in field))
        )
          return fail()
        const expected = {
          bindingRevision: fields.bindingRevision?.value as number,
          configRevision: fields.configRevision?.value as number,
        }
        if (
          !Number.isSafeInteger(expected.bindingRevision) ||
          expected.bindingRevision < 1 ||
          !Number.isSafeInteger(expected.configRevision) ||
          expected.configRevision < 1 ||
          !ctx.session?.key ||
          !ctx.device ||
          !ctx.captureArtifacts
        )
          return fail()
        const signal = AbortSignal.any([deps.api.ctx.signal, ctx.signal])
        signal.throwIfAborted()
        const binding = await ctx.device.binding()
        signal.throwIfAborted()
        if (
          !binding?.active ||
          binding.sessionId !== ctx.session.key ||
          binding.bindingRevision !== expected.bindingRevision
        )
          return fail()
        const id = binding.deviceId.toLowerCase(),
          port = ctx.captureArtifacts
        const matches = (record: Record) => {
          if (
            record.selection.deviceId !== id ||
            record.selection.bindingRevision !== expected.bindingRevision ||
            record.selection.configRevision !== expected.configRevision
          )
            return fail()
        }
        const publish = async (original: Record) => {
          matches(original)
          signal.throwIfAborted()
          // Recover selected bytes only if they really exist. Never replace a journaled frame.
          const stored = await port.recover()
          signal.throwIfAborted()
          matches(stored)
          if (stored.stage === 'selected' || !sameSelection(stored.selection, original.selection))
            return fail()
          const recorded = await port.publish()
          signal.throwIfAborted()
          matches(recorded)
          if (
            recorded.stage !== 'recorded' ||
            !Number.isSafeInteger(recorded.eventSeq) ||
            !recorded.eventSeq ||
            recorded.eventSeq < 1 ||
            !sameSelection(recorded.selection, original.selection)
          )
            return fail()
          const s = recorded.selection
          return {
            deviceId: s.deviceId,
            bindingRevision: s.bindingRevision,
            configRevision: s.configRevision,
            frameId: s.frameId,
            artifact: { ...s.artifact },
            eventSeq: recorded.eventSeq,
          }
        }
        const existing = await port.read()
        signal.throwIfAborted()
        if (existing) {
          if (deps.busy.has(id)) return fail()
          deps.busy.add(id)
          try {
            return await publish(existing)
          } finally {
            deps.busy.delete(id)
          }
        }
        return await withCaptureFrame(
          deps,
          ctx,
          async ({ bytes, selection, verify }) => {
            // Another invocation may have selected the original frame during the first read.
            const prior = await port.read()
            signal.throwIfAborted()
            if (prior) return publish(prior)
            await verify()
            const stored = await port.save(bytes, selection)
            await verify()
            if (!sameSelection(stored.selection, selection)) return fail()
            return publish(stored)
          },
          expected,
        )
      } catch {
        return fail()
      }
    },
  })
}
