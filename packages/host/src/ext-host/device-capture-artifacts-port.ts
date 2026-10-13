import { createHash } from 'node:crypto'
import type { SeamImplementations } from '@agnes/core'
import type { DeviceSessionPort, ServiceContext } from '@agnes/extension-api'
import {
  type DeviceCaptureSelection,
  inspectJsonData,
  readDeviceCaptureRecord,
  readDeviceCaptureSelection,
} from '@agnes/protocol'
import { decodeSafeImageBytes } from '@agnes/protocol-validation'
import type { AssembleDeps } from '../assembly-deps.js'

/** No session/command selectors reach author code; the daemon verifies actual disk bytes.
 * A stored result is not a published session artifact and is never reported as capture completion.
 */
export function deviceCaptureArtifactsPort(deps: {
  sessionKey: string
  callId: string
  recoverOnly?: true
  purpose?: 'recognition'
  bridge: NonNullable<AssembleDeps['deviceCaptureSelection']>
  device: Readonly<DeviceSessionPort>
  actor: ServiceContext['actor']
  seams: SeamImplementations
  signal: AbortSignal
  alive(): void
  publish?: import('./device-capture-publisher.js').DeviceCapturePublisher
}): NonNullable<ServiceContext['captureArtifacts']> {
  const fail = (): never => {
    throw new Error('device capture storage unavailable')
  }
  const live = () => {
    deps.alive()
    deps.signal.throwIfAborted()
  }
  const current = async () => {
    live()
    const binding = await deps.device.binding()
    live()
    const connection = await deps.device.connection?.()
    live()
    if (
      !binding?.active ||
      binding.sessionId !== deps.sessionKey ||
      !connection?.profile ||
      connection.deviceId !== binding.deviceId ||
      connection.bindingRevision !== binding.bindingRevision
    )
      return fail()
    const grant = await deps.seams.principals.authorize(deps.actor, 'select', {
      kind: 'datasource',
      id: `aka/device/${binding.deviceId}/media`,
    })
    live()
    if (grant.effect !== 'allow') return fail()
    return { binding, connection }
  }
  const request = async (
    input:
      | Readonly<{ operation: 'read' | 'stored' | 'publication' }>
      | Readonly<{ operation: 'recorded'; eventSeq: number }>
      | Readonly<{ operation: 'select'; selection: DeviceCaptureSelection }>,
  ) => {
    const before = await current()
    const matches = (selection: DeviceCaptureSelection) => {
      if (
        selection.deviceId !== before.binding.deviceId ||
        selection.bindingRevision !== before.binding.bindingRevision ||
        selection.configRevision !== before.connection.profile?.configRevision
      )
        return fail()
    }
    if (input.operation === 'select') matches(input.selection)
    const raw = await deps.bridge(deps.sessionKey, deps.callId, input, deps.signal)
    const after = await current()
    if (
      before.binding.deviceId !== after.binding.deviceId ||
      before.binding.bindingRevision !== after.binding.bindingRevision ||
      before.connection.profile?.configRevision !== after.connection.profile?.configRevision
    )
      return fail()
    if (raw === null && input.operation === 'read') return null
    const checked = inspectJsonData(raw, 8192)
    if (!checked.ok) return fail()
    const response =
      ['select', 'publication'].includes(input.operation) &&
      checked.value &&
      typeof checked.value === 'object' &&
      !Array.isArray(checked.value)
        ? (checked.value as Record<string, unknown>).record
        : checked.value
    const result = record(response)
    matches(result.selection)
    if (input.operation === 'stored' && result.stage === 'selected') return fail()
    if (input.operation === 'recorded' && (result.stage !== 'recorded' || result.eventSeq !== input.eventSeq))
      return fail()
    return raw
  }
  const record = (raw: unknown) => readDeviceCaptureRecord(raw) ?? fail()
  let saving = false
  return Object.freeze({
    async publish() {
      if (saving || !deps.publish) return fail()
      saving = true
      try {
        const prepared = inspectJsonData(await request({ operation: 'publication' }), 8192)
        if (
          !prepared.ok ||
          !prepared.value ||
          typeof prepared.value !== 'object' ||
          Array.isArray(prepared.value)
        )
          return fail()
        const p = prepared.value as Record<string, unknown>
        if (Object.keys(p).sort().join(',') !== 'captureId,record' || typeof p.captureId !== 'string')
          return fail()
        const original = record(p.record)
        if (original.stage === 'selected') return fail()
        const verify = async () => {
          const now = await current()
          if (
            now.binding.deviceId !== original.selection.deviceId ||
            now.binding.bindingRevision !== original.selection.bindingRevision ||
            now.connection.profile?.configRevision !== original.selection.configRevision
          )
            return fail()
        }
        const eventSeq = await deps.publish(
          deps.sessionKey,
          p.captureId,
          original.selection.artifact,
          deps.actor,
          deps.signal,
          verify,
          deps.purpose,
        )
        const completed = record(await request({ operation: 'recorded', eventSeq }))
        if (JSON.stringify(completed.selection) !== JSON.stringify(original.selection)) return fail()
        return completed
      } catch {
        return fail()
      } finally {
        saving = false
      }
    },
    async read() {
      try {
        const raw = await request(Object.freeze({ operation: 'read' }))
        if (deps.recoverOnly && raw === null) return fail()
        return raw === null ? null : record(raw)
      } catch {
        return fail()
      }
    },
    async recover() {
      try {
        return record(await request(Object.freeze({ operation: 'stored' })))
      } catch {
        return fail()
      }
    },
    async save(bytes, input) {
      if (deps.recoverOnly) return fail()
      if (saving) return fail()
      saving = true
      try {
        live()
        const selection = readDeviceCaptureSelection(input)
        if (!selection) return fail()
        // Copy before any await, then verify the JPEG structure, dimensions and exact digest.
        const image = decodeSafeImageBytes(
          { bytes, mimeType: 'image/jpeg' },
          {
            maxBytesPerImage: 4 * 1024 * 1024,
            maxAggregateBytes: 4 * 1024 * 1024,
            maxPixelsPerImage: 4096 * 4096,
            maxAggregatePixels: 4096 * 4096,
          },
        )
        const ref = selection.artifact
        if (
          image.width !== selection.width ||
          image.height !== selection.height ||
          image.bytes.length !== ref.size ||
          createHash('sha256').update(image.bytes).digest('hex') !== ref.sha256
        )
          return fail()
        const selected = inspectJsonData(
          await request(Object.freeze({ operation: 'select', selection })),
          8192,
        )
        if (
          !selected.ok ||
          !selected.value ||
          typeof selected.value !== 'object' ||
          Array.isArray(selected.value)
        )
          return fail()
        const reply = selected.value as Record<string, unknown>
        const chosen = record(reply.record)
        if (
          Object.keys(reply).sort().join(',') !== 'fresh,record' ||
          typeof reply.fresh !== 'boolean' ||
          JSON.stringify(chosen.selection) !== JSON.stringify(selection)
        )
          return fail()
        // Existing stored bytes are checked by daemon instead of rewriting them.
        if (chosen.stage !== 'selected') return record(await request(Object.freeze({ operation: 'stored' })))
        const beforeWrite = await current()
        if (
          beforeWrite.binding.deviceId !== selection.deviceId ||
          beforeWrite.binding.bindingRevision !== selection.bindingRevision ||
          beforeWrite.connection.profile?.configRevision !== selection.configRevision
        )
          return fail()
        const stored = await deps.seams.artifacts.put(image.bytes, {
          mime: ref.mime,
          name: `aka-${ref.sha256.slice(0, 16)}.jpg`,
        })
        live()
        if (stored.sha256 !== ref.sha256 || stored.size !== ref.size || stored.mime !== ref.mime)
          return fail()
        return record(await request(Object.freeze({ operation: 'stored' })))
      } catch {
        return fail()
      } finally {
        saving = false
      }
    },
  })
}
