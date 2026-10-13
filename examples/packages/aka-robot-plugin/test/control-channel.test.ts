import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AkaControlChannel } from '../src/control-channel.js'

vi.mock('ws', () => ({ default: vi.fn() }))
const limits = { maxSpeed: 50, maxMilliseconds: 1000, maxCentimeters: 10, maxDegrees: 30 }
const motion = { action: 'up', mode: 'time', speed: 25, milliseconds: 500 } as const
type FakeSocket = EventEmitter & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
let sockets: FakeSocket[]
const json = (value: unknown) => Buffer.concat([Buffer.from([0xdd]), Buffer.from(JSON.stringify(value))])
function socket(): FakeSocket {
  const value = sockets.at(-1)
  if (!value) throw new Error('No control socket')
  return value
}
async function opened() {
  const channel = new AkaControlChannel('192.168.50.42')
  const ac = new AbortController()
  const receive = vi.fn()
  const pending = channel.open(ac.signal, receive)
  socket().emit('open')
  await pending
  return { channel, ac, receive, ws: socket() }
}
beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
  vi.mocked(WebSocket).mockReset()
  // biome-ignore lint/complexity/useArrowFunction: constructor mock must be callable with new
  vi.mocked(WebSocket).mockImplementation(function () {
    const value = Object.assign(new EventEmitter(), { send: vi.fn(), terminate: vi.fn() })
    sockets.push(value)
    return value as unknown as WebSocket
  })
})
afterEach(() => vi.useRealTimers())

describe('AKA native control channel', () => {
  it('pins the endpoint, caps messages and does not send an action while connecting', async () => {
    const { channel, receive, ws } = await opened()
    expect(vi.mocked(WebSocket).mock.calls[0]).toEqual([
      'ws://192.168.50.42:80/ws/control',
      {
        followRedirects: false,
        handshakeTimeout: 3000,
        maxPayload: 8192,
        perMessageDeflate: false,
        agent: false,
      },
    ])
    expect(ws.send).not.toHaveBeenCalled()
    ws.emit('message', json({ type: 'ip', ip: '192.168.50.42' }), true)
    ws.emit('message', json({ type: 'motor_status', motor: { connected: true, state: 'connected' } }), true)
    ws.emit('message', Buffer.from([0xbb, 100, 0, 0x9c, 0xff]), true)
    expect(receive.mock.calls.map(([value]) => value)).toEqual([
      { kind: 'motor', connected: true, state: 'connected' },
      { kind: 'wheels', report: { leftCmPerSecond: 10, rightCmPerSecond: -10, validity: 'unknown' } },
    ])
    channel.close()
    await expect(channel.closed).resolves.toBe('closed')
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves unknown motor fields rather than inventing successful measurements', async () => {
    const { channel, ws, receive } = await opened()
    ws.emit('message', json({ type: 'motor_status', motor: { connected: 'yes', state: 0 } }), true)
    expect(receive).toHaveBeenCalledWith({ kind: 'motor', connected: null, state: null })
    channel.close()
  })

  it.each([
    ['up', 0, 32],
    ['down', 0, -32],
    ['left', -32, 0],
    ['right', 32, 0],
  ] as const)(
    'sends the vendor binary joystick packet for %s, then independent neutral',
    async (action, steering, throttle) => {
      const { channel, ws } = await opened()
      const pending = channel.timedMotion({ ...motion, action }, limits, new AbortController().signal)
      const packet = ws.send.mock.calls[0]?.[0] as Buffer
      expect(packet.length).toBe(3)
      expect(packet[0]).toBe(0xaa)
      expect(packet.readInt8(1)).toBe(steering)
      expect(packet.readInt8(2)).toBe(throttle)
      expect(() => channel.timedMotion(motion, limits, new AbortController().signal)).toThrow('busy')
      ws.emit('message', json({ type: 'action', result: { status: 'success' } }), true)
      ws.send.mock.calls[0]?.[1]()
      await expect(pending).resolves.toEqual({ state: 'sent' })
      channel.stopMotion()
      expect(ws.send.mock.calls[1]?.[0]).toEqual(Buffer.from([0xaa, 0, 0]))
      channel.close()
    },
  )

  it.each(['distance', 'angle', 'unbounded', 'pre-cancel'] as const)('does not dispatch %s', async (mode) => {
    const { channel, ws } = await opened()
    const ac = new AbortController()
    if (mode === 'pre-cancel') ac.abort()
    const value =
      mode === 'distance'
        ? ({ action: 'up', mode: 'distance', speed: 25, centimeters: 1 } as const)
        : mode === 'angle'
          ? ({ action: 'left', mode: 'angle', speed: 25, degrees: 1 } as const)
          : mode === 'unbounded'
            ? { ...motion, milliseconds: 0 }
            : motion
    if (mode === 'pre-cancel')
      await expect(channel.timedMotion(value, limits, ac.signal)).rejects.toMatchObject({ code: 'cancelled' })
    else expect(() => channel.timedMotion(value, limits, ac.signal)).toThrow()
    expect(ws.send).not.toHaveBeenCalled()
    channel.close()
  })

  it.each(['malformed', 'oversized', 'close', 'cancel', 'timeout', 'send-error'] as const)(
    'retires an uncertain action after %s without replay',
    async (mode) => {
      const { channel, ws, receive } = await opened()
      const ac = new AbortController()
      const pending = channel.timedMotion(motion, limits, ac.signal)
      if (mode === 'malformed') ws.emit('message', Buffer.from([0xdd, 0xff]), true)
      if (mode === 'oversized') ws.emit('message', Buffer.alloc(8193), true)
      if (mode === 'close') ws.emit('close')
      if (mode === 'cancel') ac.abort()
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(3000)
      if (mode === 'send-error') ws.send.mock.calls[0]?.[1](new Error('private address'))
      await expect(pending).resolves.toMatchObject({ state: 'unknown' })
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(ws.terminate).toHaveBeenCalledOnce()
      expect(() => channel.timedMotion(motion, limits, new AbortController().signal)).toThrow('unavailable')
      ws.emit('message', Buffer.from([0xbb, 0, 0, 0, 0]), true)
      expect(receive).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not let announcements or motor-only updates extend wheel telemetry freshness', async () => {
    const { channel, ws } = await opened()
    await vi.advanceTimersByTimeAsync(4999)
    ws.emit('message', json({ type: 'ip', ip: '192.168.50.42' }), true)
    ws.emit('message', json({ type: 'motor_status', motor: { connected: true } }), true)
    await vi.advanceTimersByTimeAsync(1)
    await expect(channel.closed).resolves.toBe('timeout')
  })

  it('renews only on valid wheel reports and cancels an unopened connection', async () => {
    const { channel, ws } = await opened()
    await vi.advanceTimersByTimeAsync(4999)
    ws.emit('message', Buffer.from([0xbb, 0, 0, 0, 0]), true)
    await vi.advanceTimersByTimeAsync(4999)
    expect(ws.terminate).not.toHaveBeenCalled()
    channel.close()
    const cancelled = new AkaControlChannel('10.0.0.2')
    const ac = new AbortController()
    const pending = cancelled.open(ac.signal, vi.fn())
    const refusal = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    ac.abort()
    await refusal
    await expect(cancelled.closed).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })
})
