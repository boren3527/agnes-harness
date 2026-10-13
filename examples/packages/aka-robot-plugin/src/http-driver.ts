import { request } from 'node:http'
import { type JpegFrame, MjpegParser, mjpegBoundary } from './mjpeg.js'
import {
  AkaProtocolError,
  GRIP_PATHS,
  type Motion,
  type MotionLimits,
  motionPath,
  parseActionReceipt,
  robotEndpoint,
  STOP_PATH,
} from './protocol.js'

export type AkaTransportCode = 'cancelled' | 'timeout' | 'network' | 'http' | 'response'
export class AkaTransportError extends Error {
  constructor(readonly code: AkaTransportCode) {
    // Never include addresses, response bodies or credentials in diagnostics.
    super(`AKA transport: ${code}`)
    this.name = 'AkaTransportError'
  }
}

export interface AkaHeartbeat {
  service: 'AKA-00'
  identity: { macAddress: string | null; validity: 'reported' | 'unknown' }
}

export function parseHeartbeat(value: unknown): AkaHeartbeat {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AkaProtocolError('Invalid heartbeat')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' || record.service !== 'AKA-00')
    throw new AkaProtocolError('Endpoint is not an AKA-00 service')
  const mac = record.mac_address
  const valid =
    typeof mac === 'string' &&
    /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) &&
    mac !== '00:00:00:00:00:00' &&
    mac.toLowerCase() !== 'ff:ff:ff:ff:ff:ff'
  return {
    service: 'AKA-00',
    identity: { macAddress: valid ? mac.toLowerCase() : null, validity: valid ? 'reported' : 'unknown' },
  }
}

type Receipt = ReturnType<typeof parseActionReceipt> & { transportCode?: AkaTransportCode }

/** Internal native driver. The Host/runtime must authorize binding and control before invoking.
 * No arbitrary route, URL, headers, redirects, proxy, retries or queue are exposed.
 * A dedicated request/socket keeps stop independent of an outstanding action response.
 */
export class AkaHttpDriver {
  private readonly endpoint: URL
  constructor(ip: string, port = 80) {
    this.endpoint = new URL(robotEndpoint(ip, port))
  }

  async heartbeat(signal: AbortSignal): Promise<AkaHeartbeat> {
    return parseHeartbeat(await this.json('/api/system/heartbeat', 3000, signal))
  }

  async motorStatus(signal: AbortSignal): Promise<unknown> {
    // Raw observation only until the owning parser validates each measurement.
    return this.json('/api/motor/status', 3000, signal)
  }

  async readSettings(signal: AbortSignal) {
    const [speed, arm] = await Promise.all([
      this.json('/api/config/speed', 3000, signal),
      this.json('/api/arm/angles', 3000, signal),
    ])
    return parseRobotSettings(speed, arm)
  }

  async saveSettings(value: RobotSettings, kind: 'speed' | 'arm', signal: AbortSignal) {
    const checked = parseRobotSettings(value.speed, value.arm)
    if (kind === 'speed') await this.json('/api/config/speed', 5000, signal, 'POST', checked.speed)
    else await this.json('/api/arm/angles', 5000, signal, 'POST', checked.arm)
    const result = await this.readSettings(signal)
    if (JSON.stringify(result[kind]) !== JSON.stringify(checked[kind]))
      throw new AkaProtocolError('Robot settings readback differs')
    return result
  }

  async cameraStatus(signal: AbortSignal): Promise<boolean> {
    return this.cameraResponse(await this.json('/api/camera/status', 3000, signal))
  }

  async setCamera(open: boolean, signal: AbortSignal): Promise<boolean> {
    if (typeof open !== 'boolean') throw new AkaProtocolError('Invalid camera intent')
    return this.cameraResponse(
      await this.json(`/api/camera/${open ? 'open' : 'close'}`, 5000, signal, 'POST'),
    )
  }

  private cameraResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AkaProtocolError('Invalid camera status')
    const on = (value as Record<string, unknown>).camera_on
    if (typeof on !== 'boolean') throw new AkaProtocolError('Invalid camera status')
    return on
  }

  /** Subscription ends on cancellation, closure or failure. The caller owns its finite lifetime.
   * No frame queue is created, and the idle deadline advances only on a complete valid frame.
   */
  stream(fps: number, signal: AbortSignal, onFrame: (frame: JpegFrame) => void): Promise<void> {
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 30)
      throw new AkaProtocolError('Invalid stream frame rate')
    if (signal.aborted) return Promise.reject(new AkaTransportError('cancelled'))
    return new Promise((resolve, reject) => {
      let settled = false
      let response: { destroy(): void } | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: AkaTransportError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        response?.destroy()
        req.destroy()
        if (error) reject(error)
        else resolve()
      }
      const cancel = () => finish(new AkaTransportError('cancelled'))
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish(new AkaTransportError('timeout')), 5000)
      }
      const req = request(
        {
          protocol: 'http:',
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || '80',
          path: `/api/camera/stream?fps=${fps}`,
          method: 'GET',
          agent: false,
          maxHeaderSize: 8192,
          headers: { Accept: 'multipart/x-mixed-replace', 'Cache-Control': 'no-store', Connection: 'close' },
        },
        (res) => {
          response = res
          if (settled) {
            res.destroy()
            return
          }
          if (res.statusCode !== 200) {
            finish(new AkaTransportError('http'))
            return
          }
          let parser: MjpegParser
          try {
            parser = new MjpegParser(mjpegBoundary(res.headers['content-type'] ?? ''))
          } catch {
            finish(new AkaTransportError('response'))
            return
          }
          res.on('data', (chunk: Buffer) => {
            if (settled) return
            try {
              const frame = parser.push(chunk)
              if (frame) {
                arm()
                onFrame(frame)
              }
            } catch {
              finish(new AkaTransportError('response'))
            }
          })
          res.once('error', () => finish(new AkaTransportError('network')))
          res.once('aborted', () => finish(new AkaTransportError('network')))
          res.once('end', () => {
            if (settled) return
            try {
              parser.finish()
              finish()
            } catch {
              finish(new AkaTransportError('response'))
            }
          })
        },
      )
      req.once('error', () => finish(new AkaTransportError('network')))
      signal.addEventListener('abort', cancel, { once: true })
      arm()
      if (signal.aborted) cancel()
      if (!settled) req.end()
    })
  }

  move(motion: Motion, limits: MotionLimits, signal: AbortSignal): Promise<Receipt> {
    const path = motionPath(motion, limits)
    return this.action(
      path,
      motion.mode === 'time' ? motion.milliseconds + 5000 : 35000,
      signal,
      motion.action,
    )
  }

  grip(action: 'grab' | 'release', signal: AbortSignal): Promise<Receipt> {
    if (action !== 'grab' && action !== 'release') throw new AkaProtocolError('Unknown grip action')
    return this.action(GRIP_PATHS[action], 15000, signal, action)
  }

  async stop(
    signal: AbortSignal,
  ): Promise<{ state: 'completed' | 'unknown'; transportCode?: AkaTransportCode }> {
    // Caller supplies an independent stop deadline; an aborted motion signal cannot cancel stop.
    const result = await this.action(STOP_PATH, 3000, signal, 'stop')
    return { ...result, state: result.state === 'acknowledged' ? 'unknown' : result.state }
  }

  private async action(
    path: string,
    timeoutMs: number,
    signal: AbortSignal,
    expected?: Motion['action'] | 'grab' | 'release' | 'stop',
  ): Promise<Receipt> {
    if (signal.aborted) throw new AkaTransportError('cancelled')
    try {
      return parseActionReceipt(await this.json(path, timeoutMs, signal), expected)
    } catch (error) {
      // A lost/invalid receipt is never proof that a physical action did not happen.
      const transportCode = error instanceof AkaTransportError ? error.code : 'response'
      return { state: 'unknown', transportCode }
    }
  }

  private json(
    path: string,
    timeoutMs: number,
    signal: AbortSignal,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new AkaTransportError('cancelled'))
    return new Promise((resolve, reject) => {
      let settled = false
      let response: { destroy(): void } | undefined
      const chunks: Buffer[] = []
      let size = 0
      const maxBytes = 64 * 1024
      const finish = (error?: AkaTransportError, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (error) {
          response?.destroy()
          req.destroy()
          reject(error)
        } else resolve(value)
      }
      const cancel = () => finish(new AkaTransportError('cancelled'))
      // http.request uses the literal validated IP and does not consult HTTP proxy environment.
      const req = request(
        {
          protocol: 'http:',
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || '80',
          method,
          path,
          agent: false,
          maxHeaderSize: 8192,
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-store',
            Connection: 'close',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
        },
        (res) => {
          response = res
          if (settled) {
            res.destroy()
            return
          }
          if (res.statusCode !== 200) {
            finish(new AkaTransportError('http'))
            return
          }
          const length = res.headers['content-length']
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
            finish(new AkaTransportError('response'))
            return
          }
          res.on('data', (chunk: Buffer) => {
            if (settled) return
            size += chunk.length
            if (size > maxBytes) {
              finish(new AkaTransportError('response'))
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          res.once('aborted', () => finish(new AkaTransportError('network')))
          res.once('error', () => finish(new AkaTransportError('network')))
          res.once('end', () => {
            if (settled) return
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
              finish(undefined, JSON.parse(text))
            } catch {
              finish(new AkaTransportError('response'))
            }
          })
        },
      )
      const timer = setTimeout(() => finish(new AkaTransportError('timeout')), timeoutMs)
      req.once('error', () => finish(new AkaTransportError('network')))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      if (!settled) req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
}

export type RobotSettings = {
  speed: { forward_speed: number; turn_speed: number }
  arm: { driver: 'zp10s' | 'sts3215'; angles: Record<string, number | Record<string, number>> }
}
export function parseRobotSettings(speed: unknown, arm: unknown): RobotSettings {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AkaProtocolError('Invalid robot settings')
    return v as Record<string, unknown>
  }
  const number = (v: unknown, max: number): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max)
      throw new AkaProtocolError('Invalid robot setting range')
    return v as number
  }
  const sp = object(speed),
    ar = object(arm)
  if (ar.driver !== 'zp10s' && ar.driver !== 'sts3215') throw new AkaProtocolError('Unknown arm driver')
  const max = ar.driver === 'zp10s' ? 270 : 4095
  const keys = ar.driver === 'zp10s' ? ['servo0', 'servo1'] : ['servo1', 'servo2']
  const angles = object(ar.angles)
  const group = (v: unknown) => {
    const g = object(v)
    if (Object.keys(g).sort().join(',') !== keys.join(',')) throw new AkaProtocolError('Invalid servo fields')
    return Object.fromEntries(keys.map((k) => [k, number(g[k], max)]))
  }
  if (Object.keys(angles).sort().join(',') !== 'grab_position,gripper_close,gripper_open,lift_position')
    throw new AkaProtocolError('Invalid arm fields')
  return {
    speed: { forward_speed: number(sp.forward_speed, 100), turn_speed: number(sp.turn_speed, 100) },
    arm: {
      driver: ar.driver,
      angles: {
        grab_position: group(angles.grab_position),
        lift_position: group(angles.lift_position),
        gripper_open: number(angles.gripper_open, max),
        gripper_close: number(angles.gripper_close, max),
      },
    },
  }
}
