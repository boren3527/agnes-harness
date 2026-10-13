import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AkaControlChannel, type ControlObservation } from '../src/control-channel.js'
import { AkaHttpDriver } from '../src/http-driver.js'
import { runtimeMediaSource } from '../src/media-egress.js'
import type { JpegFrame } from '../src/mjpeg.js'
import { AkaRuntime, AkaRuntimePool } from '../src/runtime.js'

vi.mock('../src/http-driver.js', async (original) => ({
  ...(await original<typeof import('../src/http-driver.js')>()),
  AkaHttpDriver: vi.fn(),
}))
vi.mock('../src/control-channel.js', () => ({ AkaControlChannel: vi.fn() }))
const mac = '12:34:56:78:90:ab'
const heartbeat = { service: 'AKA-00', identity: { macAddress: mac, validity: 'reported' } }
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 240, 1, 64, 1, 1, 0x11, 0, 0xff, 0xd9])
const frame = (): JpegFrame => ({ bytes: Buffer.from(bytes), width: 320, height: 240 })
let http: {
  heartbeat: ReturnType<typeof vi.fn>
  cameraStatus: ReturnType<typeof vi.fn>
  setCamera: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn>
}
let channels: {
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  closed: ReturnType<typeof deferred<'network'>>
}[]
let streams: {
  signal: AbortSignal
  receive: (frame: JpegFrame) => void
  ended: ReturnType<typeof deferred<void>>
}[]
let runtimes: AkaRuntime[]
function runtime(lifetime = signal()) {
  const value = new AkaRuntime('192.168.50.42', 80, mac, lifetime)
  runtimes.push(value)
  return value
}
function channel(index = channels.length - 1) {
  const value = channels[index]
  if (!value) throw new Error('Expected channel')
  return value
}
function stream(index = streams.length - 1) {
  const value = streams[index]
  if (!value) throw new Error('Expected stream')
  return value
}
function observe(value: ControlObservation, index = channels.length - 1) {
  const call = channel(index).open.mock.calls[0]
  if (!call) throw new Error('Expected open')
  call[1](value)
}

beforeEach(() => {
  channels = []
  streams = []
  runtimes = []
  http = {
    heartbeat: vi.fn(async () => heartbeat),
    cameraStatus: vi.fn(async () => false),
    setCamera: vi.fn(async () => false),
    stream: vi.fn((_fps, signal: AbortSignal, receive: (frame: JpegFrame) => void) => {
      const ended = deferred<void>()
      streams.push({ signal, receive, ended })
      return ended.promise
    }),
  }
  vi.mocked(AkaHttpDriver).mockReset()
  // biome-ignore lint/complexity/useArrowFunction: constructor mock must be callable with new
  vi.mocked(AkaHttpDriver).mockImplementation(function () {
    return http as unknown as AkaHttpDriver
  })
  vi.mocked(AkaControlChannel).mockReset()
  // biome-ignore lint/complexity/useArrowFunction: constructor mock must be callable with new
  vi.mocked(AkaControlChannel).mockImplementation(function () {
    const closed = deferred<'network'>()
    const value = { open: vi.fn(async () => {}), close: vi.fn(() => closed.resolve('network')), closed }
    channels.push(value)
    return { ...value, closed: closed.promise } as unknown as AkaControlChannel
  })
})
afterEach(() => {
  for (const value of runtimes) value.dispose()
})

describe('AKA device runtime observations and media lifecycle', () => {
  it('shares one runtime across callers and refuses alternate identities/configurations until explicit release', async () => {
    const owner = new AbortController()
    const pool = new AkaRuntimePool(owner.signal)
    const registration = {
      deviceId: '10000000-0000-4000-8000-000000000001',
      ip: '192.168.50.42',
      port: 80,
      macAddress: mac,
      configRevision: 1,
    }
    const first = pool.get(registration)
    expect(pool.get({ ...registration, macAddress: mac.toUpperCase() })).toBe(first)
    await first.connect(signal())
    first.startCamera(15)
    stream().receive(frame())
    const previousFrameId = first.latestFrame()?.id
    expect(channels).toHaveLength(1)
    expect(() => pool.get({ ...registration, configRevision: 2 })).toThrow('configuration changed')
    expect(() => pool.get({ ...registration, deviceId: '10000000-0000-4000-8000-000000000002' })).toThrow(
      'already registered',
    )
    expect(() =>
      pool.get({ ...registration, ip: '10.0.0.2', deviceId: '10000000-0000-4000-8000-000000000002' }),
    ).toThrow('already registered')
    pool.release(registration.deviceId)
    expect(first.snapshot().connection).toBe('disposed')
    const next = pool.get({ ...registration, configRevision: 2 })
    expect(next).not.toBe(first)
    expect(next.snapshot().instanceId).not.toBe(first.snapshot().instanceId)
    expect(next.snapshot().connection).toBe('idle')
    await next.connect(signal())
    next.startCamera(15)
    stream().receive(frame())
    expect(next.latestFrame()?.id).not.toBe(previousFrameId)
    owner.abort()
    expect(next.snapshot().connection).toBe('disposed')
    expect(() => pool.get(registration)).toThrow('pool disposed')
  })

  it('refuses invalid registry metadata without opening any network transport', () => {
    const pool = new AkaRuntimePool(signal())
    const registration = {
      deviceId: '10000000-0000-4000-8000-000000000001',
      ip: '10.0.0.2',
      port: 80,
      macAddress: mac,
      configRevision: 1,
    }
    expect(() => pool.get({ ...registration, deviceId: 'address' })).toThrow('Invalid runtime registration')
    expect(() => pool.get({ ...registration, configRevision: 0 })).toThrow('Invalid runtime registration')
    expect(() => pool.get({ ...registration, macAddress: '00:00:00:00:00:00' })).toThrow('identity')
    expect(http.heartbeat).not.toHaveBeenCalled()
    expect(channels).toHaveLength(0)
    pool.dispose()
  })

  it('connects once to the confirmed reported identity without opening the camera or moving', async () => {
    const value = runtime()
    await value.connect(signal())
    expect(value.snapshot()).toMatchObject({
      connection: 'connected',
      identity: 'matched',
      cameraOn: false,
      media: 'idle',
      wheels: null,
      frame: null,
    })
    expect(http.stream).not.toHaveBeenCalled()
    expect(http.setCamera).not.toHaveBeenCalled()
    await expect(value.connect(signal())).rejects.toThrow('already active')
    expect(channels).toHaveLength(1)
    observe({ kind: 'wheels', report: { leftCmPerSecond: 0, rightCmPerSecond: -10, validity: 'unknown' } })
    expect(value.snapshot().wheels).toMatchObject({
      leftCmPerSecond: 0,
      rightCmPerSecond: -10,
      validity: 'unknown',
    })
    observe({ kind: 'motor', connected: true, state: 'connected' })
    expect(value.snapshot().motor).toEqual({ connected: true, state: 'connected' })
  })

  it.each([null, 'ab:90:78:56:34:12'])(
    'refuses identity %s before WS or media requests',
    async (reported) => {
      http.heartbeat.mockResolvedValue({
        ...heartbeat,
        identity: { macAddress: reported, validity: 'unknown' },
      })
      const value = runtime()
      await expect(value.connect(signal())).rejects.toThrow('identity mismatch')
      expect(value.snapshot()).toMatchObject({
        connection: 'degraded',
        identity: 'mismatch',
        error: 'identity',
      })
      expect(channels).toHaveLength(0)
      expect(http.cameraStatus).not.toHaveBeenCalled()
      expect(http.stream).not.toHaveBeenCalled()
    },
  )

  it('rejects a cancelled late heartbeat without creating a channel', async () => {
    const pending = deferred<typeof heartbeat>()
    http.heartbeat.mockReturnValue(pending.promise)
    const value = runtime()
    const ac = new AbortController()
    const connect = value.connect(ac.signal)
    await vi.waitFor(() => expect(http.heartbeat).toHaveBeenCalled())
    ac.abort()
    pending.resolve(heartbeat)
    await expect(connect).rejects.toMatchObject({ code: 'cancelled' })
    expect(value.snapshot()).toMatchObject({ connection: 'degraded', frame: null })
    expect(channels).toHaveLength(0)
  })

  it('retains only the latest owned frame, and reading/copying it has no camera effects', async () => {
    const value = runtime()
    expect(value.latestFrame()).toBeNull()
    await value.connect(signal())
    value.startCamera(15)
    const source = frame()
    stream().receive(source)
    const snapshot = value.snapshot()
    const mediaReader = runtimeMediaSource(
      {
        sessionId: 'fixture-session',
        deviceId: 'fixture-device',
        rowRevision: 'fixture-row',
        runtimeInstanceId: snapshot.instanceId,
        bindingRevision: 1,
        configRevision: 1,
        connectionGeneration: snapshot.generation,
        mediaGeneration: snapshot.mediaGeneration,
      },
      value,
      signal(),
    )
    expect(mediaReader.read()?.id).toBe(snapshot.frame?.id)
    const first = value.latestFrame()
    expect(first).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}:1:1:1$/),
      timeBasis: 'bridge_receive',
      width: 320,
      height: 240,
    })
    source.bytes.fill(0)
    first?.bytes.fill(1)
    expect(value.latestFrame()?.bytes).toEqual(bytes)
    stream().receive(frame())
    expect(value.snapshot()).toMatchObject({
      cameraOn: true,
      media: 'streaming',
      frame: { id: expect.stringMatching(/^[0-9a-f-]{36}:1:1:2$/) },
    })
    expect(http.stream).toHaveBeenCalledTimes(1)
    expect(() => value.startCamera(15)).toThrow('already active')
    await value.closeCamera(signal())
    expect(stream().signal.aborted).toBe(true)
    stream().receive(frame())
    expect(value.snapshot()).toMatchObject({ cameraOn: false, media: 'idle', frame: null })
    expect(value.latestFrame()).toBeNull()
    expect(() => mediaReader.read()).toThrow('retired')
    expect(http.setCamera).toHaveBeenCalledWith(false, expect.any(AbortSignal))
  })

  it('serializes hardware close with other camera effects', async () => {
    const value = runtime()
    await value.connect(signal())
    value.startCamera(15)
    const pending = deferred<boolean>()
    http.setCamera.mockReturnValue(pending.promise)
    const closing = value.closeCamera(signal())
    expect(() => value.startCamera(15)).toThrow('closing')
    await expect(value.closeCamera(signal())).rejects.toThrow('closing')
    pending.resolve(false)
    await closing
    value.startCamera(15)
    expect(streams).toHaveLength(2)
    await value.closeCamera(signal())
    const opening = deferred<boolean>()
    http.setCamera.mockReturnValueOnce(opening.promise)
    const cancelled = new AbortController()
    const lateOpen = value.openCamera(30, cancelled.signal)
    cancelled.abort()
    opening.resolve(true)
    await expect(lateOpen).rejects.toThrow()
    expect(streams).toHaveLength(2)
    http.setCamera.mockResolvedValueOnce(false)
    await expect(value.openCamera(30, signal())).rejects.toThrow('Camera open not confirmed')
    expect(streams).toHaveLength(2)
  })

  it('does not claim camera off after stream failure, and late old callbacks cannot replace a restarted stream', async () => {
    const value = runtime()
    await value.connect(signal())
    value.startCamera(15)
    stream().receive(frame())
    const previous = stream()
    previous.ended.reject(new Error('network'))
    await Promise.resolve()
    expect(value.snapshot()).toMatchObject({ cameraOn: null, media: 'error', frame: null })
    value.startCamera(15)
    stream().receive(frame())
    const current = value.latestFrame()?.id
    previous.receive(frame())
    expect(value.latestFrame()?.id).toBe(current)
  })

  it('retires media and measurements on control loss without replay or stale reconnect updates', async () => {
    const value = runtime()
    await value.connect(signal())
    value.startCamera(15)
    stream().receive(frame())
    channel().closed.resolve('network')
    await Promise.resolve()
    expect(value.snapshot()).toMatchObject({
      connection: 'degraded',
      cameraOn: null,
      frame: null,
      wheels: null,
    })
    expect(stream().signal.aborted).toBe(true)
    await value.connect(signal())
    observe({ kind: 'motor', connected: true, state: 'stale' }, 0)
    stream(0).receive(frame())
    expect(value.snapshot()).toMatchObject({
      generation: 2,
      connection: 'connected',
      media: 'idle',
      motor: { connected: null, state: null },
      frame: null,
    })
    expect(http.stream).toHaveBeenCalledTimes(1)
  })

  it('rejects stale close completion after reconnect and permanently disposes on owner cancellation', async () => {
    const lifetime = new AbortController()
    const value = runtime(lifetime.signal)
    await value.connect(signal())
    const pending = deferred<boolean>()
    http.setCamera.mockReturnValue(pending.promise)
    const closing = value.closeCamera(signal())
    value.disconnect()
    expect(http.setCamera.mock.calls.at(-1)?.[1].aborted).toBe(true)
    http.cameraStatus.mockResolvedValue(true)
    await value.connect(signal())
    pending.resolve(false)
    await expect(closing).rejects.toMatchObject({ code: 'cancelled' })
    expect(value.snapshot().cameraOn).toBe(true)
    lifetime.abort()
    expect(value.snapshot()).toMatchObject({ connection: 'disposed', frame: null, cameraOn: null })
    await expect(value.connect(signal())).rejects.toThrow('unavailable')
  })
})
