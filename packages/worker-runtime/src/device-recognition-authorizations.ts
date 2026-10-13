import type { HostOptions } from '@agnes/host'
import { inspectJsonData } from '@agnes/protocol'

type Registrar = NonNullable<HostOptions['deviceRecognitionAuthorization']>
type Authorization = Parameters<Registrar>[2]

/** Private Host closures indexed by daemon call identity; never a worker/plugin JSON claim. */
export class DeviceRecognitionAuthorizations {
  private readonly entries = new Map<string, { sessionKey: string; authorization: Authorization }>()
  readonly register: Registrar = (sessionKey, callId, authorization) => {
    if (
      !sessionKey ||
      !/^[a-f0-9]{32}$/.test(callId) ||
      authorization.revoked.aborted ||
      this.entries.has(callId) ||
      this.entries.size >= 128
    )
      throw new Error('recognition authority unavailable')
    const entry = { sessionKey, authorization }
    this.entries.set(callId, entry)
    authorization.revoked.addEventListener(
      'abort',
      () => {
        if (this.entries.get(callId) === entry) this.entries.delete(callId)
      },
      { once: true },
    )
  }
  async authorize(input: unknown): Promise<{ authorized: true }> {
    const value = inspectJsonData(input, 4096)
    if (!value.ok || !value.value || typeof value.value !== 'object' || Array.isArray(value.value))
      throw new Error('recognition authority unavailable')
    const p = value.value as Record<string, unknown>
    if (
      Object.keys(p).sort().join(',') !== 'callId,sessionKey,stage' ||
      typeof p.callId !== 'string' ||
      typeof p.sessionKey !== 'string' ||
      !['upload-authorize', 'upload', 'detect'].includes(p.stage as string)
    )
      throw new Error('recognition authority unavailable')
    const entry = this.entries.get(p.callId)
    if (!entry || entry.sessionKey !== p.sessionKey || entry.authorization.revoked.aborted)
      throw new Error('recognition authority unavailable')
    if (
      (await entry.authorization.assertIOAuthorized(
        p.stage as Parameters<Authorization['assertIOAuthorized']>[0],
        entry.authorization.revoked,
      )) !== undefined
    )
      throw new Error('recognition authority unavailable')
    if (this.entries.get(p.callId) !== entry || entry.authorization.revoked.aborted)
      throw new Error('recognition authority unavailable')
    return { authorized: true }
  }
}
