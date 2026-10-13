import WebSocket, { type RawData } from 'ws'
import { type AkaTransportCode, AkaTransportError } from './http-driver.js'
import {
  type Motion,
  type MotionLimits,
  motionPath,
  parseWheelReport,
  robotEndpoint,
  type WheelReport,
} from './protocol.js'

export type ControlObservation =
  | { kind: 'wheels'; report: WheelReport }
  | { kind: 'motor'; connected: boolean | null; state: string | null }

export interface ControlReceipt {
  state: 'sent' | 'acknowledged' | 'unknown'
  /** Even a successful action ACK does not verify stationary, held or completed. */
  transportCode?: AkaTransportCode
}

/** Internal native transport, not an authorization port. One socket, one action, no retries.
 * Vendor directional controls use 0xAA + signed steering/throttle. Runtime bounds their duration.
 */
export class AkaControlChannel {
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: { finish(receipt: ControlReceipt): void } | undefined
  private end: (() => void) | undefined
  private resolveClosed!: (reason: AkaTransportCode | 'closed') => void
  readonly closed = new Promise<AkaTransportCode | 'closed'>((resolve) => {
    this.resolveClosed = resolve
  })
  private retired = false
  private opened = false
  private readonly url: string

  constructor(ip: string, port = 80) {
    this.url = `${robotEndpoint(ip, port).replace('http:', 'ws:')}/ws/control`
  }

  open(signal: AbortSignal, receive: (observation: ControlObservation) => void): Promise<void> {
    if (this.socket || this.retired) throw new Error('AKA control channel is single-use')
    if (signal.aborted) {
      this.close()
      return Promise.reject(new AkaTransportError('cancelled'))
    }
    return new Promise((resolve, reject) => {
      const finish = (code: AkaTransportCode | 'closed') => {
        if (this.retired) return
        this.retired = true
        this.opened = false
        clearTimeout(this.timer)
        signal.removeEventListener('abort', cancel)
        this.pending?.finish({ state: 'unknown', transportCode: code === 'closed' ? 'network' : code })
        this.socket?.terminate()
        this.resolveClosed(code)
        reject(new AkaTransportError(code === 'closed' ? 'network' : code))
      }
      const cancel = () => finish('cancelled')
      this.end = () => finish('closed')
      const arm = (milliseconds: number) => {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => finish('timeout'), milliseconds)
      }
      try {
        this.socket = new WebSocket(this.url, {
          followRedirects: false,
          handshakeTimeout: 3000,
          maxPayload: 8192,
          perMessageDeflate: false,
          agent: false,
        })
      } catch {
        finish('network')
        return
      }
      const socket = this.socket
      socket.once('open', () => {
        if (this.retired) return
        this.opened = true
        arm(5000)
        resolve()
      })
      socket.on('message', (raw: RawData, binary: boolean) => {
        if (this.retired) return
        try {
          const size = Array.isArray(raw) ? raw.reduce((n, bytes) => n + bytes.length, 0) : raw.byteLength
          if (!binary || size < 2 || size > 8192) throw new Error('Invalid message')
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)
          if (bytes[0] === 0xbb) {
            const report = parseWheelReport(bytes)
            arm(5000)
            receive({ kind: 'wheels', report })
            return
          }
          if (bytes[0] !== 0xdd) throw new Error('Unknown prefix')
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1)),
          )
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON')
          const record = value as Record<string, unknown>
          if (record.type === 'ip' && typeof record.ip === 'string' && record.ip.length <= 64) return
          if (record.type === 'motor_status') {
            if (!record.motor || typeof record.motor !== 'object' || Array.isArray(record.motor))
              throw new Error('Invalid motor')
            const motor = record.motor as Record<string, unknown>
            receive({
              kind: 'motor',
              connected: typeof motor.connected === 'boolean' ? motor.connected : null,
              state: typeof motor.state === 'string' && motor.state.length <= 64 ? motor.state : null,
            })
            return
          }
          if (
            record.type !== 'action' ||
            !record.result ||
            typeof record.result !== 'object' ||
            Array.isArray(record.result)
          )
            throw new Error('Unmatched action')
          const result = record.result as Record<string, unknown>
          if (typeof result.status !== 'string') throw new Error('Invalid action receipt')
          // Joystick packets have no action ACK. An unrelated arm/legacy ACK must not complete them.
        } catch {
          finish('response')
        }
      })
      socket.once('error', () => finish('network'))
      socket.once('close', () => finish('network'))
      signal.addEventListener('abort', cancel, { once: true })
      arm(3000)
      if (signal.aborted) cancel()
    })
  }

  timedMotion(motion: Motion, limits: MotionLimits, signal: AbortSignal): Promise<ControlReceipt> {
    motionPath(motion, limits)
    if (motion.mode !== 'time') throw new Error('AKA WS requires bounded time mode')
    if (signal.aborted) return Promise.reject(new AkaTransportError('cancelled'))
    if (!this.opened || this.retired || !this.socket || this.pending)
      throw new Error('AKA control channel unavailable or busy')
    const socket = this.socket
    return new Promise((resolve) => {
      const cancel = () => {
        this.pending?.finish({ state: 'unknown', transportCode: 'cancelled' })
        this.close()
      }
      const timer = setTimeout(() => {
        this.pending?.finish({ state: 'unknown', transportCode: 'timeout' })
        this.close()
      }, 3000)
      this.pending = {
        finish: (receipt) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', cancel)
          this.pending = undefined
          resolve(receipt)
        },
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        // Public speed is a percentage; vendor joystick axes span -127..127.
        const speed = Math.round((motion.speed * 127) / 100)
        const steering = motion.action === 'left' ? -speed : motion.action === 'right' ? speed : 0
        const throttle = motion.action === 'up' ? speed : motion.action === 'down' ? -speed : 0
        const packet = Buffer.alloc(3)
        packet[0] = 0xaa
        packet.writeInt8(steering, 1)
        packet.writeInt8(throttle, 2)
        socket.send(packet, (error) => {
          if (error && !this.retired) {
            this.pending?.finish({ state: 'unknown', transportCode: 'network' })
            this.close()
          } else if (!this.retired) this.pending?.finish({ state: 'sent' })
        })
      } catch {
        this.pending?.finish({ state: 'unknown', transportCode: 'network' })
        this.close()
      }
      if (signal.aborted) cancel()
    })
  }

  /** Independent neutral packet, matching the vendor's brake/release control. */
  stopMotion(): void {
    if (!this.opened || this.retired || !this.socket) return
    try {
      this.socket.send(Buffer.from([0xaa, 0, 0]), (error) => {
        if (error) this.close()
      })
    } catch {
      this.close()
    }
  }

  close(): void {
    if (this.end) this.end()
    else if (!this.retired) {
      this.retired = true
      this.resolveClosed('closed')
    }
  }
}
