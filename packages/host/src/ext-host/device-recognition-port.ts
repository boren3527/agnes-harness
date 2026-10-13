import { createHash } from 'node:crypto'
import type { DeviceRecognitionPort, DeviceSessionPort } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { copyRecognitionFrame } from '../adapters/recognition-frame.js'
import type { AssembleDeps } from '../assembly-deps.js'
import { frozenJson } from './frozen-json.js'
import type { ServiceInvocationAuthorization } from './service-invocation.js'

const refuse = (): never => {
  throw new Error('device recognition unavailable')
}
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

/** The private bridge owns its ticket. Authors supply no call/session/credential selectors. */
export function deviceRecognitionPort(
  sessionKey: string,
  callId: string,
  bridge: NonNullable<AssembleDeps['deviceRecognitionExecute']>,
  device: Readonly<DeviceSessionPort>,
  authorization: ServiceInvocationAuthorization,
  signal: AbortSignal,
  alive: () => void,
): Readonly<DeviceRecognitionPort> {
  let used = false
  return Object.freeze({
    run: async (
      input: Parameters<DeviceRecognitionPort['run']>[0],
      select: Parameters<DeviceRecognitionPort['run']>[1],
      verifySelection?: Parameters<DeviceRecognitionPort['run']>[2],
    ) => {
      const live = () => {
        alive()
        signal.throwIfAborted()
        authorization.revoked.throwIfAborted()
      }
      live()
      if (used) return refuse()
      used = true
      const checked = inspectJsonData(input, 1024)
      if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
        return refuse()
      const expected = frozenJson(checked.value) as unknown as Parameters<DeviceRecognitionPort['run']>[0]
      if (
        Object.keys(expected).sort().join(',') !== 'bindingRevision,configRevision,roundRevision' ||
        !Object.values(expected).every(positive) ||
        typeof select !== 'function' ||
        (verifySelection !== undefined && typeof verifySelection !== 'function') ||
        !device.retainRecognition
      )
        return refuse()
      const lease = await device.retainRecognition()
      try {
        const active = AbortSignal.any([signal, authorization.revoked, lease.revoked])
        const verify = async () => {
          live()
          active.throwIfAborted()
          if (
            !lease.binding.active ||
            lease.binding.sessionId !== sessionKey ||
            lease.binding.bindingRevision !== expected.bindingRevision ||
            lease.recognition.deviceId !== lease.binding.deviceId ||
            lease.recognition.bindingRevision !== expected.bindingRevision ||
            lease.recognition.configRevision !== expected.configRevision ||
            lease.recognition.settings?.provider !== 'aliyun'
          )
            return refuse()
          await authorization.assertAuthorized()
          live()
          active.throwIfAborted()
        }
        await verify()
        const frame = copyRecognitionFrame(await select(active))
        await verify()
        const initialAge = performance.now() - frame.receivedAt
        if (!Number.isFinite(initialAge) || initialAge < 0 || initialAge > 1000) return refuse()
        // Issue the cross-process age anchor after persistence. Otherwise its elapsed
        // time and ageAtSendMs both count saving the same original, rejecting fresh frames.
        // Admission above still precedes selection; begin/execute remain single-use.
        const window = inspectJsonData(
          await bridge(sessionKey, callId, { operation: 'begin', expected }, active),
          1024,
        )
        await verify()
        if (
          !window.ok ||
          !window.value ||
          typeof window.value !== 'object' ||
          Array.isArray(window.value) ||
          Object.keys(window.value).join(',') !== 'ticket'
        )
          return refuse()
        const ticket = (window.value as { ticket: unknown }).ticket
        if (typeof ticket !== 'string' || !uuid.test(ticket)) return refuse()
        const ageAtSendMs = performance.now() - frame.receivedAt
        if (!Number.isFinite(ageAtSendMs) || ageAtSendMs < 0 || ageAtSendMs > 1000) return refuse()
        const sha256 = createHash('sha256').update(frame.bytes).digest('hex')
        const raw = await bridge(
          sessionKey,
          callId,
          {
            operation: 'execute',
            ticket,
            frame: {
              id: frame.id,
              width: frame.width,
              height: frame.height,
              ageAtSendMs,
              jpegBase64: Buffer.from(frame.bytes).toString('base64'),
            },
          },
          active,
        )
        await verify()
        const result = inspectJsonData(raw, 512 * 1024)
        if (!result.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value))
          return refuse()
        const r = result.value as Record<string, unknown>
        if (
          Object.keys(r).sort().join(',') !==
            'bindingRevision,configRevision,detections,deviceId,elapsedMs,frameId,height,id,providerRequestId,roundRevision,sha256,width' ||
          typeof r.id !== 'string' ||
          !uuid.test(r.id) ||
          r.deviceId !== lease.binding.deviceId ||
          r.bindingRevision !== expected.bindingRevision ||
          r.configRevision !== expected.configRevision ||
          r.roundRevision !== expected.roundRevision ||
          r.frameId !== frame.id ||
          r.width !== frame.width ||
          r.height !== frame.height ||
          r.sha256 !== sha256 ||
          typeof r.providerRequestId !== 'string' ||
          !r.providerRequestId ||
          r.providerRequestId.length > 512 ||
          typeof r.elapsedMs !== 'number' ||
          !Number.isFinite(r.elapsedMs) ||
          r.elapsedMs < 0 ||
          !Array.isArray(r.detections) ||
          r.detections.length > 1000
        )
          return refuse()
        for (const d of r.detections) {
          if (
            !d ||
            typeof d !== 'object' ||
            Array.isArray(d) ||
            Object.keys(d).sort().join(',') !== 'box,confidence,label' ||
            typeof d.label !== 'string' ||
            !d.label ||
            d.label.length > 256 ||
            typeof d.confidence !== 'number' ||
            d.confidence < 0 ||
            d.confidence > 1 ||
            !Array.isArray(d.box) ||
            d.box.length !== 4 ||
            d.box.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v)) ||
            d.box[0] < 0 ||
            d.box[1] < 0 ||
            d.box[2] > frame.width ||
            d.box[3] > frame.height ||
            d.box[2] <= d.box[0] ||
            d.box[3] <= d.box[1]
          )
            return refuse()
        }
        if (verifySelection) {
          await verifySelection()
          await verify()
        }
        return frozenJson(result.value) as unknown as Awaited<ReturnType<DeviceRecognitionPort['run']>>
      } finally {
        lease.release()
      }
    },
  })
}
