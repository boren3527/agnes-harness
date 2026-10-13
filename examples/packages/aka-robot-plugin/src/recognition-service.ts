import type { ServiceDef } from '@agnes/extension-api'
import { type CaptureDependencies, withCaptureFrame } from './capture-frame.js'
import type { GroundGeometry } from './geometry-service.js'
import { AkaProtocolError } from './protocol.js'

const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const string = { type: 'string', minLength: 1, maxLength: 512 }
/** One explicitly admitted single-image effect. No reconnect, camera open or inference loop. */
export function registerRecognitionService(
  register: (def: ServiceDef) => unknown,
  deps: CaptureDependencies,
  geometry?: GroundGeometry,
) {
  register({
    name: 'aka.recognition.test',
    kind: 'effect',
    timeoutMs: 15000,
    maxResultBytes: 512 * 1024,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bindingRevision: revision,
        configRevision: revision,
        recognitionRevision: revision,
        roundRevision: revision,
      },
      required: ['bindingRevision', 'configRevision', 'recognitionRevision', 'roundRevision'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifact: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            size: { type: 'integer', minimum: 1, maximum: 2.5 * 1024 * 1024 },
            mime: { const: 'image/jpeg' },
          },
          required: ['sha256', 'size', 'mime'],
        },
        eventSeq: revision,
        selectedAt: { type: 'string', minLength: 1, maxLength: 64 },
        timeBasis: { const: 'bridge_receive' },
        ageAtSelectionMs: { type: 'number', minimum: 0, maximum: 1000 },
        id: string,
        deviceId: string,
        bindingRevision: revision,
        configRevision: revision,
        roundRevision: revision,
        frameId: string,
        width: { type: 'integer', minimum: 21, maximum: 4095 },
        height: { type: 'integer', minimum: 21, maximum: 4095 },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        providerRequestId: string,
        elapsedMs: { type: 'number', minimum: 0 },
        detections: {
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 256 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              box: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0 } },
            },
            required: ['label', 'confidence', 'box'],
          },
        },
      },
      required: [
        'artifact',
        'eventSeq',
        'selectedAt',
        'timeBasis',
        'ageAtSelectionMs',
        'id',
        'deviceId',
        'bindingRevision',
        'configRevision',
        'roundRevision',
        'frameId',
        'width',
        'height',
        'sha256',
        'providerRequestId',
        'elapsedMs',
        'detections',
      ],
    },
    async handler(input, ctx) {
      const fail = (): never => {
        throw new AkaProtocolError('Current camera recognition unavailable')
      }
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return fail()
        const fields = Object.getOwnPropertyDescriptors(input)
        if (
          Reflect.ownKeys(fields).sort().join(',') !==
            'bindingRevision,configRevision,recognitionRevision,roundRevision' ||
          Object.values(fields).some((f) => !('value' in f))
        )
          return fail()
        const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))
        if (
          !Object.values(values).every((v) => Number.isSafeInteger(v) && v > 0) ||
          !ctx.recognition ||
          !ctx.captureArtifacts
        )
          return fail()
        const artifacts = ctx.captureArtifacts
        // A prior original belongs to this operation: never replace it or repeat detection.
        if (await artifacts.read()) return fail()
        let original: Awaited<ReturnType<typeof artifacts.publish>> | undefined
        let receivedAt: number | undefined
        let verify: (() => Promise<void>) | undefined
        const result = await ctx.recognition.run(
          {
            bindingRevision: values.bindingRevision,
            configRevision: values.recognitionRevision,
            roundRevision: values.roundRevision,
          },
          (signal) =>
            withCaptureFrame(
              deps,
              { ...ctx, signal },
              async (frame) => {
                receivedAt = frame.receivedAt
                verify = frame.verify
                await verify()
                const saved = await artifacts.save(frame.bytes, frame.selection)
                await verify()
                const matches = (record: typeof saved) =>
                  Object.entries(frame.selection).every(([key, value]) =>
                    key === 'artifact'
                      ? record.selection.artifact.sha256 === frame.selection.artifact.sha256 &&
                        record.selection.artifact.size === frame.selection.artifact.size &&
                        record.selection.artifact.mime === frame.selection.artifact.mime
                      : record.selection[key as keyof typeof frame.selection] === value,
                  )
                if (saved.stage === 'selected' || !matches(saved)) return fail()
                original = await artifacts.publish()
                await verify()
                if (
                  original.stage !== 'recorded' ||
                  !original.eventSeq ||
                  !Number.isSafeInteger(original.eventSeq) ||
                  original.eventSeq < 1 ||
                  !matches(original)
                )
                  return fail()
                return {
                  id: frame.selection.frameId,
                  receivedAt: frame.receivedAt,
                  width: frame.selection.width,
                  height: frame.selection.height,
                  bytes: frame.bytes,
                }
              },
              { bindingRevision: values.bindingRevision, configRevision: values.configRevision },
            ),
          async () => {
            if (!verify) return fail()
            await verify()
          },
        )
        if (
          !original ||
          receivedAt === undefined ||
          !Number.isFinite(receivedAt) ||
          result.sha256 !== original.selection.artifact.sha256 ||
          result.frameId !== original.selection.frameId ||
          result.width !== original.selection.width ||
          result.height !== original.selection.height ||
          result.deviceId !== original.selection.deviceId ||
          result.bindingRevision !== original.selection.bindingRevision
        )
          return fail()
        await geometry?.remember(
          ctx,
          {
            ...result,
            selectedAt: original.selection.selectedAt,
            receivedAt,
            artifact: { ...original.selection.artifact },
          },
          values.configRevision,
        )
        return {
          ...result,
          artifact: { ...original.selection.artifact },
          eventSeq: original.eventSeq,
          selectedAt: original.selection.selectedAt,
          timeBasis: original.selection.timeBasis,
          ageAtSelectionMs: original.selection.ageAtSelectionMs,
        } as unknown as Awaited<ReturnType<ServiceDef['handler']>>
      } catch {
        return fail()
      }
    },
  })
}
