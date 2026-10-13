import type { ResolvedProfile } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { WorkerPool } from './worker-pool.js'

export interface PrivateDeviceMediaEndpoint {
  readonly port: number
  readonly authorization: string
  readonly rowRevision: string
  readonly registrationId: string
  readonly workerGeneration: number
}

/** Private composition port. The caller must map an admitted browser row to its backend row.
 * Never starts a worker, registers an endpoint, consumes a ticket or grants browser authority.
 */
export function workerDeviceMediaReader(
  pool: Pick<WorkerPool, 'businessWorker'>,
  profile: () => ResolvedProfile,
): (rowId: string, signal: AbortSignal) => Promise<Readonly<PrivateDeviceMediaEndpoint> | null> {
  return async (rowId, signal) => {
    if (typeof rowId !== 'string' || !rowId || rowId.length > 256 || rowId.includes('\0'))
      throw rpcError('CAPABILITY_DENIED')
    if (signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    const hash = profile().hash
    const saved = pool.businessWorker()
    if (!saved?.link.alive) return null
    let value: unknown
    try {
      value = await saved.link.command('deviceMedia.endpoint', { rowId }, { timeoutMs: 3000 })
    } catch {
      // Worker error strings must not carry private credentials into an RPC or launcher log.
      throw rpcError('INTERNAL_ERROR')
    }
    if (signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    const current = pool.businessWorker()
    if (
      profile().hash !== hash ||
      !saved.link.alive ||
      current?.link !== saved.link ||
      current.generation !== saved.generation
    )
      throw rpcError('CAPABILITY_DENIED')
    if (value === null) return null
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw rpcError('INTERNAL_ERROR')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).length !== 4 ||
      Object.keys(record).some(
        (key) => !['port', 'authorization', 'rowRevision', 'registrationId'].includes(key),
      ) ||
      !Number.isSafeInteger(record.port) ||
      (record.port as number) < 1 ||
      (record.port as number) > 65535 ||
      typeof record.authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(record.authorization) ||
      typeof record.rowRevision !== 'string' ||
      !record.rowRevision ||
      record.rowRevision.length > 256 ||
      typeof record.registrationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.registrationId)
    )
      throw rpcError('INTERNAL_ERROR')
    return Object.freeze({
      port: record.port as number,
      authorization: record.authorization,
      rowRevision: record.rowRevision,
      registrationId: record.registrationId,
      workerGeneration: saved.generation,
    })
  }
}
