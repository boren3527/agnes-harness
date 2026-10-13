import type { Server } from 'node:http'
import type { WebSocket } from 'ws'

export const DEVICE_MEDIA_PATH = '/api/client-modules/device-media'
export interface DeviceMediaRequest {
  readonly rowId: string
  readonly sessionId: string
  readonly ticket: string
}
/** Only the authenticated launcher resolves a registered plugin endpoint. Never browser data. */
export interface DeviceMediaEndpoint {
  readonly port: number
  readonly authorization: string
  readonly revoked: AbortSignal
}
export type DeviceMediaResolver = (
  request: Readonly<DeviceMediaRequest>,
  signal: AbortSignal,
) => Promise<Readonly<DeviceMediaEndpoint> | null>

const MAX_BYTES = 3 * 1024 * 1024
const validTicket = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

/** Fixed same-origin WS route. Metadata and binary remain paired under output backpressure.
 * The resolver owns profile/row/session authority; it must refuse stale/untrusted registrations.
 */
export async function mountDeviceMedia(
  server: Server,
  origin: string,
  resolver?: DeviceMediaResolver,
): Promise<() => void> {
  if (!resolver) {
    const refuse = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex) => {
      if (request.url?.split('?', 1)[0] === DEVICE_MEDIA_PATH || server.listenerCount('upgrade') === 1)
        socket.destroy()
    }
    server.on('upgrade', refuse)
    return () => server.off('upgrade', refuse)
  }
  // Importing the packaged Web module must not initialize the optional WS/CJS implementation.
  const { WebSocket, WebSocketServer } = await import('ws')
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })
  let disposed = false
  const pairs = new Map<WebSocket, () => void>()
  // A dedicated listener type avoids accepting arbitrary upgrade request fields as destinations.
  const handle = (
    request: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    if (request.url?.split('?', 1)[0] !== DEVICE_MEDIA_PATH) {
      if (server.listenerCount('upgrade') === 1) socket.destroy()
      return
    }
    if (
      disposed ||
      !resolver ||
      request.method !== 'GET' ||
      request.url !== DEVICE_MEDIA_PATH ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] !== undefined &&
        request.headers['sec-fetch-site'] !== 'same-origin') ||
      request.headers['sec-websocket-protocol'] !== undefined ||
      ws.clients.size >= 32
    ) {
      socket.destroy()
      return
    }
    ws.handleUpgrade(request, socket, head, (client) => attach(client))
  }
  const attach = (client: WebSocket) => {
    const lifetime = new AbortController()
    let upstream: WebSocket | undefined
    let endpoint: DeviceMediaEndpoint | undefined
    let started = false
    let admitted = false
    let awaitingAck = false
    let metadata: { text: string; length: number } | undefined
    let latest: { text: string; bytes: Buffer } | undefined
    let ack: string | undefined
    let sending = false
    let finished = false
    const stop = () => {
      if (finished) return
      finished = true
      lifetime.abort()
      clearTimeout(authTimer)
      clearInterval(pump)
      endpoint?.revoked.removeEventListener('abort', stop)
      upstream?.terminate()
      client.terminate()
      pairs.delete(client)
      metadata = undefined
      latest = undefined
      ack = undefined
    }
    let authTimer = setTimeout(stop, 3000)
    authTimer.unref()
    const flush = () => {
      if (finished || sending || client.bufferedAmount !== 0 || client.readyState !== WebSocket.OPEN) return
      if (ack) {
        const text = ack
        ack = undefined
        sending = true
        client.send(text, (error) => {
          sending = false
          if (error) stop()
          else flush()
        })
        return
      }
      if (!latest) return
      const group = latest
      latest = undefined
      sending = true
      client.send(group.text, { binary: false }, (error) => {
        if (error) stop()
      })
      client.send(group.bytes, { binary: true }, (error) => {
        sending = false
        if (error) stop()
        else flush()
      })
    }
    const pump = setInterval(flush, 67)
    pump.unref()
    pairs.set(client, stop)
    client.on('error', stop)
    client.once('close', stop)
    client.on('message', (bytes, binary) => {
      void (async () => {
        try {
          if (binary || finished) throw new Error('Invalid media message')
          const value = JSON.parse(bytes.toString()) as Record<string, unknown>
          if (!value || typeof value !== 'object' || Array.isArray(value) || !validTicket(value.ticket))
            throw new Error('Invalid media message')
          if (started) {
            if (
              !admitted ||
              awaitingAck ||
              value.type !== 'renew' ||
              Object.keys(value).some((key) => !['type', 'ticket'].includes(key)) ||
              upstream?.readyState !== WebSocket.OPEN ||
              upstream.bufferedAmount !== 0
            )
              throw new Error('Invalid media renewal')
            awaitingAck = true
            upstream.send(JSON.stringify({ type: 'renew', ticket: value.ticket }), (error) => {
              if (error) stop()
            })
            return
          }
          started = true
          if (
            value.type !== 'auth' ||
            Object.keys(value).some((key) => !['type', 'ticket', 'rowId', 'sessionId'].includes(key)) ||
            [value.rowId, value.sessionId].some(
              (part) => typeof part !== 'string' || !part || part.length > 256,
            )
          )
            throw new Error('Invalid media scope')
          // The browser has sent its bounded auth message. Give daemon scope
          // resolution its own deadline instead of charging it to the first-message timer.
          clearTimeout(authTimer)
          authTimer = setTimeout(stop, 12000)
          authTimer.unref()
          const resolved = await resolver?.(
            Object.freeze({
              rowId: value.rowId as string,
              sessionId: value.sessionId as string,
              ticket: value.ticket,
            }),
            lifetime.signal,
          )
          if (finished || lifetime.signal.aborted) return
          if (
            !resolved ||
            !Number.isSafeInteger(resolved.port) ||
            resolved.port < 1 ||
            resolved.port > 65535 ||
            !/^Bearer [A-Za-z0-9_-]{43}$/.test(resolved.authorization) ||
            resolved.revoked.aborted
          )
            throw new Error('Media unavailable')
          endpoint = Object.freeze({ ...resolved })
          endpoint.revoked.addEventListener('abort', stop, { once: true })
          if (endpoint.revoked.aborted) {
            stop()
            return
          }
          clearTimeout(authTimer)
          authTimer = setTimeout(stop, 3000)
          authTimer.unref()
          upstream = new WebSocket(`ws://127.0.0.1:${endpoint.port}/media`, {
            headers: { Authorization: endpoint.authorization },
            maxPayload: MAX_BYTES,
            perMessageDeflate: false,
          })
          upstream.on('error', stop)
          upstream.once('close', stop)
          upstream.once('open', () => {
            if (finished || endpoint?.revoked.aborted) {
              stop()
              return
            }
            awaitingAck = true
            upstream?.send(JSON.stringify({ type: 'auth', ticket: value.ticket }), (error) => {
              if (error) stop()
            })
          })
          upstream.on('message', (data, isBinary) => {
            try {
              const payload = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data)
              if (finished || endpoint?.revoked.aborted) {
                stop()
                return
              }
              if (isBinary) {
                if (!admitted || !metadata || payload.length !== metadata.length)
                  throw new Error('Unpaired media')
                latest = { text: metadata.text, bytes: Buffer.from(payload) }
                metadata = undefined
                flush()
                return
              }
              if (payload.length > 1024 || metadata) throw new Error('Invalid metadata')
              const text = payload.toString()
              const message = JSON.parse(text) as Record<string, unknown>
              if (message.type === 'authorized') {
                if (
                  !awaitingAck ||
                  ack ||
                  message.leaseMs !== 60_000 ||
                  Object.keys(message).some((key) => !['type', 'leaseMs'].includes(key))
                )
                  throw new Error('Unexpected media admission')
                awaitingAck = false
                admitted = true
                ack = text
                clearTimeout(authTimer)
                flush()
              } else {
                if (
                  !admitted ||
                  message.type !== 'frame' ||
                  typeof message.id !== 'string' ||
                  !message.id ||
                  message.id.length > 256 ||
                  Object.keys(message).some(
                    (key) =>
                      !['type', 'id', 'width', 'height', 'byteLength', 'timeBasis', 'ageMs'].includes(key),
                  ) ||
                  !Number.isSafeInteger(message.width) ||
                  !Number.isSafeInteger(message.height) ||
                  (message.width as number) < 1 ||
                  (message.height as number) < 1 ||
                  (message.width as number) > 4096 ||
                  (message.height as number) > 4096 ||
                  (message.width as number) * (message.height as number) > 16_000_000 ||
                  !Number.isSafeInteger(message.byteLength) ||
                  (message.byteLength as number) < 4 ||
                  (message.byteLength as number) > MAX_BYTES ||
                  message.timeBasis !== 'bridge_receive' ||
                  typeof message.ageMs !== 'number' ||
                  !Number.isFinite(message.ageMs) ||
                  message.ageMs < 0
                )
                  throw new Error('Invalid frame metadata')
                metadata = { text, length: message.byteLength as number }
              }
            } catch {
              stop()
            }
          })
        } catch {
          stop()
        }
      })()
    })
  }
  server.on('upgrade', handle)
  return () => {
    if (disposed) return
    disposed = true
    server.off('upgrade', handle)
    for (const stop of pairs.values()) stop()
    ws.close()
  }
}
