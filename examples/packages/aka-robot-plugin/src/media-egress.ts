import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'
import { jpegDimensions } from './mjpeg.js'
import type { AkaRuntime, RuntimeFrame } from './runtime.js'

/** Internal contract, not vendor fields or a browser-selectable destination. */
export interface MediaScope {
  readonly sessionId: string
  readonly deviceId: string
  readonly rowRevision: string
  readonly runtimeInstanceId: string
  readonly bindingRevision: number
  readonly configRevision: number
  readonly connectionGeneration: number
  readonly mediaGeneration: number
}
export interface MediaSource {
  readonly scope: Readonly<MediaScope>
  readonly revoked: AbortSignal
  /** Synchronous epoch check, including while an output socket is backpressured. */
  check(): void
  /** Checks current ownership/epochs and returns a copied frame; never opens a camera. */
  read(): RuntimeFrame | null
}
type Grant = { source: MediaSource; expiresAt: number }

const TICKET_MS = 30_000
const LEASE_MS = 60_000
const AUTH_MS = 3000
const MAX_CLIENTS = 32
const MAX_TICKETS = 128
const MAX_FRAME_BYTES = 3 * 1024 * 1024
const token = () => randomBytes(32).toString('base64url')
const sameScope = (a: MediaScope, b: MediaScope) =>
  a.sessionId === b.sessionId &&
  a.deviceId === b.deviceId &&
  a.rowRevision === b.rowRevision &&
  a.runtimeInstanceId === b.runtimeInstanceId &&
  a.bindingRevision === b.bindingRevision &&
  a.configRevision === b.configRevision &&
  a.connectionGeneration === b.connectionGeneration &&
  a.mediaGeneration === b.mediaGeneration

/** Trusted owner supplies the actual row/session/config lease; never caller-controlled input. */
export function runtimeMediaSource(
  scope: MediaScope,
  runtime: AkaRuntime,
  revoked: AbortSignal,
): MediaSource {
  const saved = Object.freeze({ ...scope })
  const check = () => {
    const snapshot = runtime.snapshot()
    if (
      revoked.aborted ||
      snapshot.connection !== 'connected' ||
      snapshot.identity !== 'matched' ||
      !['opening', 'streaming'].includes(snapshot.media) ||
      snapshot.instanceId !== saved.runtimeInstanceId ||
      snapshot.generation !== saved.connectionGeneration ||
      snapshot.mediaGeneration !== saved.mediaGeneration
    )
      throw new Error('Media source retired')
  }
  check()
  return Object.freeze({
    scope: saved,
    revoked,
    check,
    read: () => {
      check()
      return runtime.latestFrame()
    },
  })
}

/** Plugin-owned loopback egress. Only a trusted same-origin bridge gets endpoint credentials.
 * Camera authorization, fresh binding/config leases and source epoch checks belong to the caller.
 * This does not register a public service or permit browser access to a robot address.
 */
export class AkaMediaEgress {
  private readonly secret = token()
  private readonly tickets = new Map<string, Grant>()
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer((_req, res) => res.writeHead(404).end())
  private readonly ws = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })
  private stopped = false
  private pending: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private port: number | undefined
  private readonly removeLifetime: () => void

  constructor(
    owner: AbortSignal,
    private readonly now: () => number = () => performance.now(),
  ) {
    const stop = () => {
      void this.close()
    }
    owner.addEventListener('abort', stop, { once: true })
    this.removeLifetime = () => owner.removeEventListener('abort', stop)
    this.server.on('error', stop)
    this.server.on('connection', (socket) => {
      if (this.stopped || this.sockets.size >= 64) {
        socket.destroy()
        return
      }
      this.sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => this.sockets.delete(socket))
      socket.setTimeout(AUTH_MS, () => socket.destroy())
    })
    this.server.on('upgrade', (req, socket, head) => {
      if (
        !(socket instanceof Socket) ||
        this.stopped ||
        this.port === undefined ||
        req.method !== 'GET' ||
        req.url !== '/media' ||
        req.headers.host !== `127.0.0.1:${this.port}` ||
        req.headers.origin !== undefined ||
        req.headers['sec-websocket-protocol'] !== undefined ||
        req.headers.authorization !== `Bearer ${this.secret}` ||
        this.ws.clients.size >= MAX_CLIENTS
      ) {
        socket.destroy()
        return
      }
      this.ws.handleUpgrade(req, socket, head, (client) => {
        socket.setTimeout(0)
        this.attach(client)
      })
    })
    if (owner.aborted) void this.close()
  }

  /** Explicit/lazy start; plugin construction and status queries need not bind a port. */
  async listen(): Promise<void> {
    if (this.stopped) throw new Error('Media egress closed')
    if (!this.pending)
      this.pending = new Promise<void>((resolve, reject) => {
        const fail = () => {
          this.server.off('listening', ready)
          reject(new Error('Media egress unavailable'))
        }
        const ready = () => {
          this.server.off('error', fail)
          const address = this.server.address()
          if (!address || typeof address === 'string' || this.stopped) {
            reject(new Error('Media egress closed'))
            return
          }
          this.port = address.port
          resolve()
        }
        this.server.once('error', fail)
        this.server.once('listening', ready)
        this.server.listen(0, '127.0.0.1')
      })
    await this.pending
    if (this.stopped) throw new Error('Media egress closed')
  }

  /** Private host registration data; never returned by a browser query or embedded in a URL. */
  endpoint(): Readonly<{ port: number; authorization: string }> {
    if (this.stopped || this.port === undefined) throw new Error('Media egress unavailable')
    return Object.freeze({ port: this.port, authorization: `Bearer ${this.secret}` })
  }

  /** Call only after Host authorization and a current config-bearing retained lease. */
  issue(source: MediaSource): Readonly<{ ticket: string; expiresInMs: number }> {
    if (this.stopped || source.revoked.aborted) throw new Error('Media source unavailable')
    const scope = source.scope
    if (
      !scope.sessionId ||
      !scope.deviceId ||
      !scope.rowRevision ||
      !scope.runtimeInstanceId ||
      [scope.sessionId, scope.deviceId, scope.rowRevision, scope.runtimeInstanceId].some(
        (value) => typeof value !== 'string' || value.length > 256,
      ) ||
      [scope.bindingRevision, scope.configRevision, scope.connectionGeneration, scope.mediaGeneration].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      ) ||
      typeof source.read !== 'function' ||
      typeof source.check !== 'function'
    )
      throw new Error('Invalid media source')
    source.check()
    this.prune()
    if (this.tickets.size >= MAX_TICKETS) throw new Error('Media ticket limit')
    const ticket = token()
    // Copy trusted scope so mutation cannot retarget an issued ticket.
    const read = source.read.bind(source)
    const check = source.check.bind(source)
    this.tickets.set(ticket, {
      source: Object.freeze({ scope: Object.freeze({ ...scope }), revoked: source.revoked, read, check }),
      expiresAt: this.now() + TICKET_MS,
    })
    return Object.freeze({ ticket, expiresInMs: TICKET_MS })
  }

  private prune(): void {
    for (const [ticket, grant] of this.tickets)
      if (grant.expiresAt <= this.now() || grant.source.revoked.aborted) this.tickets.delete(ticket)
  }

  private consume(ticket: unknown): MediaSource | undefined {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return
    const grant = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!grant || grant.expiresAt <= this.now() || grant.source.revoked.aborted) return
    return grant.source
  }

  private attach(client: WebSocket): void {
    let source: MediaSource | undefined
    let leaseUntil = 0
    let lastId: string | undefined
    let sending = false
    const stop = () => client.terminate()
    const auth = setTimeout(stop, AUTH_MS)
    auth.unref()
    const release = () => source?.revoked.removeEventListener('abort', stop)
    const timer = setInterval(() => {
      if (!source) return
      if (this.stopped || source.revoked.aborted || leaseUntil <= this.now()) {
        stop()
        return
      }
      try {
        source.check()
        // No queue: only an entire newest group can begin after the previous one drained.
        if (sending || client.bufferedAmount !== 0 || client.readyState !== WebSocket.OPEN) return
        const frame = source.read()
        if (source.revoked.aborted || this.stopped) {
          stop()
          return
        }
        if (!frame || frame.id === lastId) return
        if (
          typeof frame.id !== 'string' ||
          frame.id.length > 256 ||
          frame.bytes.length > MAX_FRAME_BYTES ||
          !Number.isFinite(frame.receivedAt) ||
          frame.timeBasis !== 'bridge_receive'
        )
          throw new Error('Invalid frame')
        const dimensions = jpegDimensions(frame.bytes)
        if (dimensions.width !== frame.width || dimensions.height !== frame.height)
          throw new Error('Invalid frame')
        const bytes = Buffer.from(frame.bytes)
        const metadata = JSON.stringify({
          type: 'frame',
          id: frame.id,
          width: frame.width,
          height: frame.height,
          byteLength: bytes.length,
          timeBasis: frame.timeBasis,
          ageMs: Math.max(0, performance.now() - frame.receivedAt),
        })
        sending = true
        lastId = frame.id
        client.send(metadata, { binary: false }, (error) => {
          if (error) stop()
        })
        client.send(bytes, { binary: true }, (error) => {
          sending = false
          if (error) stop()
        })
      } catch {
        stop()
      }
    }, 67)
    timer.unref()
    client.on('error', stop)
    client.once('close', () => {
      clearTimeout(auth)
      clearInterval(timer)
      release()
    })
    client.on('message', (bytes, binary) => {
      try {
        if (binary) throw new Error('Invalid media control')
        const value = JSON.parse(bytes.toString()) as Record<string, unknown>
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((key) => key !== 'type' && key !== 'ticket') ||
          value.type !== (source ? 'renew' : 'auth')
        )
          throw new Error('Invalid media control')
        const next = this.consume(value.ticket)
        if (!next || (source && !sameScope(source.scope, next.scope))) throw new Error('Invalid media ticket')
        next.check()
        release()
        source = next
        source.revoked.addEventListener('abort', stop, { once: true })
        if (source.revoked.aborted || this.stopped) {
          stop()
          return
        }
        leaseUntil = this.now() + LEASE_MS
        clearTimeout(auth)
        client.send(JSON.stringify({ type: 'authorized', leaseMs: LEASE_MS }), (error) => {
          if (error) stop()
        })
      } catch {
        stop()
      }
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    this.removeLifetime()
    this.tickets.clear()
    for (const client of this.ws.clients) client.terminate()
    for (const socket of this.sockets) socket.destroy()
    this.ws.close()
    this.closing = (async () => {
      // listen() may still be pending when owner shutdown arrives.
      if (this.pending) await this.pending.catch(() => {})
      if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
      this.port = undefined
    })()
    return this.closing
  }
}
