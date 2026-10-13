import { scanPages } from '@agnes/core'
import { type Actor, type ArtifactRef, readDeviceCaptureEvent } from '@agnes/protocol'
import type { HostSession } from '../host.js'

export type DeviceCapturePublisher = (
  sessionKey: string,
  captureId: string,
  ref: ArtifactRef,
  actor: Actor,
  signal: AbortSignal,
  verify: () => Promise<void>,
  purpose?: 'recognition',
) => Promise<number>

/** Uses the existing session writer. Retry searches the original identity; it never fabricates a tool result. */
export function createDeviceCapturePublisher(
  resolve: (key: string) => Pick<HostSession, 'append' | 'scan'> | undefined,
): DeviceCapturePublisher {
  const pending = new Map<string, Set<string>>()
  return async (key, captureId, ref, actor, signal, verify, purpose) => {
    const fail = (): never => {
      throw new Error('device capture publication unavailable')
    }
    const session = resolve(key)
    const event = {
      type: 'x/core/device-capture',
      v: 1,
      origin: 'system',
      trust: 'trusted' as const,
      ignorable: true as const,
      lane: 'main',
      actor,
      data: { captureId, ref, ...(purpose ? { purpose } : {}) },
    }
    const selected = readDeviceCaptureEvent(event)
    if (!session || !selected || signal.aborted || pending.get(key)?.has(captureId)) return fail()
    const ids = pending.get(key) ?? new Set<string>()
    ids.add(captureId)
    pending.set(key, ids)
    const current = async () => {
      signal.throwIfAborted()
      await verify()
      signal.throwIfAborted()
      if (resolve(key) !== session) return fail()
    }
    try {
      await current()
      const tail = await session.scan({ order: 'desc', limit: 1 })
      await current()
      let existing: number | undefined
      if (tail[0]) {
        for await (const page of scanPages((q) => session.scan(q), {
          type: 'x/core/device-capture',
          lane: 'main',
          toSeq: tail[0].seq,
        })) {
          await current()
          for (const row of page) {
            const capture = readDeviceCaptureEvent(row)
            const data = row.data
            if (
              data &&
              typeof data === 'object' &&
              !Array.isArray(data) &&
              data.captureId === captureId &&
              !capture
            )
              return fail()
            if (capture?.captureId !== captureId) continue
            if (
              existing !== undefined ||
              capture.ref.sha256 !== selected.ref.sha256 ||
              capture.ref.size !== selected.ref.size ||
              capture.ref.mime !== selected.ref.mime
            )
              return fail()
            existing = row.seq
          }
        }
      }
      await current()
      if (existing !== undefined) return existing
      // Keep the slot until the actual append settles, even if cancellation arrives meanwhile.
      const committed = await session.append([{ ...event, data: selected }])
      await current()
      if (
        committed.seqs.length !== 1 ||
        committed.seqs[0] !== committed.firstSeq ||
        !Number.isSafeInteger(committed.firstSeq) ||
        committed.firstSeq < 1
      )
        return fail()
      const rows = await session.scan({ fromSeq: committed.firstSeq, toSeq: committed.firstSeq, limit: 1 })
      await current()
      const persisted = rows[0] && readDeviceCaptureEvent(rows[0])
      if (
        rows[0]?.seq !== committed.firstSeq ||
        !persisted ||
        persisted.captureId !== captureId ||
        JSON.stringify(persisted.ref) !== JSON.stringify(selected.ref)
      )
        return fail()
      return committed.firstSeq
    } catch {
      return fail()
    } finally {
      ids.delete(captureId)
      if (!ids.size && pending.get(key) === ids) pending.delete(key)
    }
  }
}
