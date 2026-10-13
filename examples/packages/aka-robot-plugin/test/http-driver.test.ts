import { EventEmitter } from 'node:events'
import { type ClientRequest, type IncomingMessage, request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AkaHttpDriver, parseHeartbeat, parseRobotSettings } from '../src/http-driver.js'

vi.mock('node:http', () => ({ request: vi.fn() }))
const signal = () => new AbortController().signal
const limits = { maxSpeed: 50, maxMilliseconds: 1000, maxCentimeters: 10, maxDegrees: 30 }
const motion = { action: 'up', mode: 'time', speed: 25, milliseconds: 500 } as const
type Exchange = {
  options: Record<string, unknown>
  req: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
  open(status?: number, headers?: Record<string, string>): IncomingMessage
  respond(body: string | Buffer, status?: number, headers?: Record<string, string>): IncomingMessage
}
let exchanges: Exchange[]
function exchange(): Exchange {
  const value = exchanges[0]
  if (!value) throw new Error('Expected a native request')
  return value
}
beforeEach(() => {
  exchanges = []
  vi.mocked(request).mockReset()
  vi.mocked(request).mockImplementation(((
    options: Record<string, unknown>,
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
    exchanges.push({
      options,
      req,
      open(statusCode = 200, headers = {}) {
        const res = Object.assign(new EventEmitter(), { statusCode, headers, destroy: vi.fn() })
        callback(res as unknown as IncomingMessage)
        return res as unknown as IncomingMessage
      },
      respond(body, statusCode = 200, headers = {}) {
        const res = this.open(statusCode, headers)
        res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body))
        res.emit('end')
        return res as unknown as IncomingMessage
      },
    })
    return req as unknown as ClientRequest
  }) as typeof request)
})

// Framing/dimension fixture only; a real decoder is still required before displaying media.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 240, 1, 64, 1, 1, 0x11, 0, 0xff, 0xd9])
const part = Buffer.concat([
  Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
  jpeg,
  Buffer.from('\r\n'),
])

describe('native camera subscription', () => {
  it('delivers bounded parsed frames and closes resources on stream completion', async () => {
    const receive = vi.fn()
    const pending = new AkaHttpDriver('10.0.0.2').stream(15, signal(), receive)
    expect(exchanges[0]?.options.path).toBe('/api/camera/stream?fps=15')
    const res = exchange().open(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
    res.emit('data', part.subarray(0, 30))
    expect(receive).not.toHaveBeenCalled()
    res.emit('data', part.subarray(30))
    expect(receive.mock.calls[0]?.[0]).toEqual({ bytes: jpeg, width: 320, height: 240 })
    res.emit('end')
    await pending
    expect(exchanges[0]?.req.destroy).toHaveBeenCalled()
    expect(res.destroy).toHaveBeenCalled()
  })

  it.each(['redirect', 'content-type', 'truncated'])('closes an invalid stream: %s', async (mode) => {
    const receive = vi.fn()
    const pending = new AkaHttpDriver('10.0.0.2').stream(15, signal(), receive)
    const res = exchange().open(mode === 'redirect' ? 302 : 200, {
      'content-type': mode === 'content-type' ? 'text/html' : 'multipart/x-mixed-replace; boundary=frame',
    })
    if (mode === 'truncated') {
      res.emit('data', part.subarray(0, part.length - 8))
      res.emit('end')
    }
    await expect(pending).rejects.toMatchObject({ code: mode === 'redirect' ? 'http' : 'response' })
    expect(receive).not.toHaveBeenCalled()
    expect(exchanges).toHaveLength(1)
  })

  it('does not let incomplete dribbled bytes extend the valid-frame deadline', async () => {
    vi.useFakeTimers()
    const pending = new AkaHttpDriver('10.0.0.2').stream(15, signal(), vi.fn())
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    const res = exchange().open(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
    await vi.advanceTimersByTimeAsync(4999)
    res.emit('data', part.subarray(0, 20))
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renews on complete frames and retires late callbacks after cancellation', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const receive = vi.fn()
    const pending = new AkaHttpDriver('10.0.0.2').stream(15, abort.signal, receive)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    const res = exchange().open(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
    await vi.advanceTimersByTimeAsync(4000)
    res.emit('data', part)
    await vi.advanceTimersByTimeAsync(4000)
    expect(exchanges[0]?.req.destroy).not.toHaveBeenCalled()
    abort.abort()
    await assertion
    res.emit('data', part)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the stream when its downstream consumer throws', async () => {
    const pending = new AkaHttpDriver('10.0.0.2').stream(15, signal(), () => {
      throw new Error('consumer')
    })
    const res = exchange().open(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' })
    res.emit('data', part)
    await expect(pending).rejects.toMatchObject({ code: 'response' })
    expect(res.destroy).toHaveBeenCalled()
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('native AKA HTTP boundary', () => {
  it.each(['status', 'open', 'close'] as const)(
    'uses the verified camera %s route and method',
    async (operation) => {
      const driver = new AkaHttpDriver('10.0.0.2')
      const pending =
        operation === 'status'
          ? driver.cameraStatus(signal())
          : driver.setCamera(operation === 'open', signal())
      expect(exchange().options).toMatchObject({
        path: `/api/camera/${operation}`,
        method: operation === 'status' ? 'GET' : 'POST',
      })
      exchange().respond(JSON.stringify({ camera_on: operation === 'open' }))
      await expect(pending).resolves.toBe(operation === 'open')
    },
  )

  it.each([{}, { camera_on: 0 }, { camera_on: 'false' }, null])(
    'refuses an invalid camera state %j',
    async (body) => {
      const pending = new AkaHttpDriver('10.0.0.2').cameraStatus(signal())
      exchange().respond(JSON.stringify(body))
      await expect(pending).rejects.toThrow('Invalid camera status')
    },
  )

  it('pins a private literal address, fixed read-only route and independent socket', async () => {
    const driver = new AkaHttpDriver('192.168.50.42')
    const pending = driver.heartbeat(signal())
    expect(exchanges[0]?.options).toMatchObject({
      hostname: '192.168.50.42',
      port: '80',
      path: '/api/system/heartbeat',
      method: 'GET',
      agent: false,
      maxHeaderSize: 8192,
    })
    exchanges[0]?.respond(
      JSON.stringify({ status: 'ok', service: 'AKA-00', mac_address: '12:34:56:78:9A:BC' }),
    )
    await expect(pending).resolves.toEqual({
      service: 'AKA-00',
      identity: { macAddress: '12:34:56:78:9a:bc', validity: 'reported' },
    })
  })

  it.each(['', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', 'invalid'])(
    'keeps unverifiable identity unknown: %s',
    (mac_address) => {
      expect(parseHeartbeat({ status: 'ok', service: 'AKA-00', mac_address }).identity).toEqual({
        macAddress: null,
        validity: 'unknown',
      })
    },
  )
  it('refuses another service and addresses outside the LAN before network I/O', () => {
    expect(() => parseHeartbeat({ status: 'ok', service: 'router' })).toThrow('not an AKA-00')
    expect(() => new AkaHttpDriver('127.0.0.1')).toThrow('private LAN')
    expect(() => new AkaHttpDriver('192.168.1.2/other')).toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([301, 302, 400, 500])('never follows or retries HTTP %i', async (status) => {
    const pending = new AkaHttpDriver('10.0.0.2').heartbeat(signal())
    exchanges[0]?.respond('{}', status, { location: 'http://169.254.169.254/' })
    await expect(pending).rejects.toMatchObject({ code: 'http' })
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]?.req.destroy).toHaveBeenCalled()
  })

  it.each(['advertised', 'actual', 'invalid-utf8', 'invalid-json'])(
    'bounds and validates response bytes: %s',
    async (mode) => {
      const pending = new AkaHttpDriver('10.0.0.2').motorStatus(signal())
      const body =
        mode === 'actual' ? Buffer.alloc(65537) : mode === 'invalid-utf8' ? Buffer.from([0xff]) : 'broken'
      exchanges[0]?.respond(body, 200, mode === 'advertised' ? { 'content-length': '65537' } : {})
      await expect(pending).rejects.toMatchObject({ code: 'response' })
      expect(exchanges[0]?.req.destroy).toHaveBeenCalled()
    },
  )

  it('uses a total deadline even while waiting for a response', async () => {
    vi.useFakeTimers()
    const pending = new AkaHttpDriver('10.0.0.2').heartbeat(signal())
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
    expect(exchanges[0]?.req.destroy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not dispatch an already cancelled action', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(new AkaHttpDriver('10.0.0.2').move(motion, limits, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(exchanges).toHaveLength(0)
  })

  it.each(['cancel', 'network', 'malformed', 'wrong-action', 'rejected-action'])(
    'keeps a possibly dispatched action unknown after %s',
    async (mode) => {
      const abort = new AbortController()
      const pending = new AkaHttpDriver('10.0.0.2').move(motion, limits, abort.signal)
      if (mode === 'cancel') abort.abort()
      else if (mode === 'network') exchanges[0]?.req.emit('error', new Error('secret details'))
      else if (mode === 'wrong-action')
        exchanges[0]?.respond('{"status":"success","action":"down","completed":true}')
      else if (mode === 'rejected-action')
        exchanges[0]?.respond('{"status":"error","action":"up","completed":true}')
      else exchanges[0]?.respond('{"completed":"yes"}')
      const receipt = await pending
      expect(receipt.state).toBe('unknown')
      expect(receipt).not.toHaveProperty('error')
      expect(exchanges).toHaveLength(1)
    },
  )

  it('sends stop independently while a move is awaiting its receipt', async () => {
    const driver = new AkaHttpDriver('10.0.0.2')
    const abort = new AbortController()
    const moving = driver.move(motion, limits, abort.signal)
    const stopping = driver.stop(signal())
    expect(exchanges).toHaveLength(2)
    expect(exchanges[1]?.options.path).toBe('/api/control?action=stop')
    exchanges[1]?.respond('{"completed":true}')
    await expect(stopping).resolves.toEqual({ state: 'completed' })
    abort.abort()
    exchanges[0]?.respond('{"completed":true}')
    await expect(moving).resolves.toMatchObject({ state: 'unknown', transportCode: 'cancelled' })
  })
})

it('reads official speed and driver-specific arm settings and writes a bounded JSON body', async () => {
  const speed = { forward_speed: 30, turn_speed: 25 }
  const arm = {
    driver: 'zp10s',
    angles: {
      grab_position: { servo0: 245, servo1: 180 },
      lift_position: { servo0: 200, servo1: 180 },
      gripper_open: 150,
      gripper_close: 90,
    },
  }
  const driver = new AkaHttpDriver('10.0.0.2')
  const read = driver.readSettings(signal())
  expect(exchanges.map((v) => v.options.path)).toEqual(['/api/config/speed', '/api/arm/angles'])
  exchanges[0]?.respond(JSON.stringify(speed))
  exchanges[1]?.respond(JSON.stringify(arm))
  await expect(read).resolves.toEqual({ speed, arm })
  exchanges = []
  const save = driver.saveSettings({ speed, arm } as ReturnType<typeof parseRobotSettings>, 'arm', signal())
  expect(exchange().options).toMatchObject({ method: 'POST', path: '/api/arm/angles' })
  expect(exchange().req.end).toHaveBeenCalledWith(JSON.stringify({ driver: arm.driver, angles: arm.angles }))
  exchange().respond(JSON.stringify({ status: 'success', ...arm }))
  await vi.waitFor(() => expect(exchanges).toHaveLength(3))
  exchanges[1]?.respond(JSON.stringify(speed))
  exchanges[2]?.respond(JSON.stringify(arm))
  await expect(save).resolves.toEqual({ speed, arm })
  expect(() => parseRobotSettings(speed, { ...arm, angles: { ...arm.angles, gripper_close: 271 } })).toThrow()
  expect(() => parseRobotSettings(speed, { ...arm, driver: 'unknown' })).toThrow()
})

it.each(['stop', 'grab', 'release'] as const)(
  'accepts the official %s status/action response without a completed flag',
  async (action) => {
    const driver = new AkaHttpDriver('192.168.50.42')
    const pending = action === 'stop' ? driver.stop(signal()) : driver.grip(action, signal())
    expect(exchange().options.path).toBe(`/api/control?action=${action}`)
    exchange().respond(JSON.stringify({ status: 'success', action }))
    await expect(pending).resolves.toEqual({ state: action === 'stop' ? 'completed' : 'acknowledged' })
  },
)
it('does not accept an unrelated or rejected arm response as an accepted grab', async () => {
  const driver = new AkaHttpDriver('192.168.50.42')
  const pending = driver.grip('grab', signal())
  exchange().respond(JSON.stringify({ status: 'success', action: 'release' }))
  await expect(pending).resolves.toMatchObject({ state: 'unknown' })
})
