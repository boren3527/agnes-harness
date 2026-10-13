import type { ClientModuleMediaResolveResult } from '@agnes/protocol'
import type { DeviceMediaRequest, DeviceMediaResolver } from '@agnes/web/server'

/** Private daemon lookup and bounded sequential revalidation. Credentials never enter HTTP replies. */
export function createDeviceMediaResolver(
  read: (request: Readonly<DeviceMediaRequest>) => Promise<ClientModuleMediaResolveResult>,
) {
  const viewers = new Set<() => void>()
  let closed = false
  const resolve: DeviceMediaResolver = async (request, signal) => {
    if (closed || signal.aborted || viewers.size >= 32) return null
    const revoked = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (revoked.signal.aborted) return
      revoked.abort()
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      viewers.delete(stop)
    }
    viewers.add(stop)
    signal.addEventListener('abort', stop, { once: true })
    let first: ClientModuleMediaResolveResult
    try {
      first = await read(request)
    } catch {
      stop()
      return null
    }
    if (!first.found || signal.aborted || closed || revoked.signal.aborted) {
      stop()
      return null
    }
    const saved = first
    const current = async () => {
      try {
        const next = await read(request)
        if (
          !next.found ||
          next.port !== saved.port ||
          next.authorization !== saved.authorization ||
          next.rowRevision !== saved.rowRevision ||
          next.registrationId !== saved.registrationId ||
          next.workerGeneration !== saved.workerGeneration ||
          next.deviceId !== saved.deviceId ||
          next.bindingRevision !== saved.bindingRevision ||
          next.configRevision !== saved.configRevision ||
          next.rosterRevision !== saved.rosterRevision
        )
          return stop()
        if (!revoked.signal.aborted && !closed) {
          timer = setTimeout(() => void current(), 1000)
          timer.unref()
        }
      } catch {
        stop()
      }
    }
    timer = setTimeout(() => void current(), 1000)
    timer.unref()
    return Object.freeze({ port: saved.port, authorization: saved.authorization, revoked: revoked.signal })
  }
  return Object.freeze({
    resolve,
    close: () => {
      closed = true
      for (const stop of [...viewers]) stop()
    },
  })
}
