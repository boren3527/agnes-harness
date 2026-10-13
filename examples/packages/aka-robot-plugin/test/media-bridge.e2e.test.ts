import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createDeviceMediaResolver } from '../../../../packages/cli/launch/device-media.js'
import { createWebServer, type DeviceMediaResolver } from '../../../../packages/web-server/src/index.js'
import { AkaMediaEgress, type MediaSource } from '../src/media-egress.js'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 0, 0xff, 0xd9])
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop()
})
async function freePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  return address.port
}
async function fixture(
  mode: 'normal' | 'missing' | 'wrong-endpoint' | 'pending' | 'launcher' | 'delayed' = 'normal',
) {
  const revoked = new AbortController()
  const egress = new AkaMediaEgress(revoked.signal)
  cleanups.push(() => egress.close())
  await egress.listen()
  let image = jpeg
  let frameId = 'frame-1'
  const source: MediaSource = {
    scope: {
      sessionId: 'device-chat',
      deviceId: 'fixture-device',
      rowRevision: 'fixture-row',
      runtimeInstanceId: 'fixture-runtime',
      bindingRevision: 1,
      configRevision: 1,
      connectionGeneration: 1,
      mediaGeneration: 1,
    },
    revoked: revoked.signal,
    check: () => revoked.signal.throwIfAborted(),
    read: () => ({
      id: frameId,
      bytes: image,
      width: 3,
      height: 2,
      receivedAt: performance.now(),
      timeBasis: 'bridge_receive',
    }),
  }
  let abortSeen: AbortSignal | undefined
  const resolve = vi.fn<DeviceMediaResolver>(async (request, signal) => {
    abortSeen = signal
    if (mode === 'delayed') await new Promise((done) => setTimeout(done, 3200))
    if (mode === 'pending')
      await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }))
    if (request.rowId !== 'fixture-row' || request.sessionId !== 'device-chat') return null
    return {
      ...egress.endpoint(),
      port: mode === 'wrong-endpoint' ? 0 : egress.endpoint().port,
      revoked: revoked.signal,
    }
  })
  const port = await freePort()
  let workerGeneration = 1
  const launcher = createDeviceMediaResolver(async () => ({
    found: true,
    ...egress.endpoint(),
    rowRevision: source.scope.rowRevision,
    registrationId: '11111111-1111-4111-8111-111111111111',
    workerGeneration,
    deviceId: source.scope.deviceId,
    bindingRevision: source.scope.bindingRevision,
    configRevision: source.scope.configRevision,
    rosterRevision: 'fixture-roster',
  }))
  cleanups.push(async () => launcher.close())
  const origin = `http://127.0.0.1:${port}`
  const web = await createWebServer({
    root: process.cwd(),
    port,
    origin,
    wsUrl: 'ws://127.0.0.1:4312',
    ...(mode === 'missing' ? {} : { deviceMedia: mode === 'launcher' ? launcher.resolve : resolve }),
  })
  cleanups.push(() => web.close())
  const connect = (headers: Record<string, string> = {}, path = '/api/client-modules/device-media') => {
    const client = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, {
      headers: { Origin: origin, ...headers },
    })
    client.on('error', () => {})
    cleanups.push(async () => {
      client.terminate()
    })
    return client
  }
  const auth = () => ({
    type: 'auth',
    rowId: 'fixture-row',
    sessionId: 'device-chat',
    ticket: egress.issue(source).ticket,
  })
  return {
    resolve,
    connect,
    auth,
    source,
    egress,
    revoked,
    web,
    replaceWorker: () => {
      workerGeneration++
    },
    signal: () => abortSeen,
    setFrame: (id: string, bytes: Buffer) => {
      frameId = id
      image = bytes
    },
  }
}
async function until(test: () => boolean) {
  const deadline = performance.now() + 2000
  while (!test()) {
    if (performance.now() > deadline) throw new Error('Bridge assertion deadline')
    await new Promise((done) => setTimeout(done, 10))
  }
}

describe('real same-origin Web media bridge to AKA loopback egress', () => {
  it('allows daemon resolution to finish after the initial client-message deadline', async () => {
    const value = await fixture('delayed')
    const client = value.connect()
    await once(client, 'open')
    const first = once(client, 'message')
    client.send(JSON.stringify(value.auth()))
    const [data] = await first
    expect(JSON.parse(data.toString())).toEqual({ type: 'authorized', leaseMs: 60000 })
    expect(value.signal()?.aborted).toBe(false)
  }, 10000)
  it('relays through the production launcher lease and closes playback on worker replacement', async () => {
    const value = await fixture('launcher')
    const client = value.connect()
    const messages: Buffer[] = []
    client.on('message', (data) => messages.push(Buffer.from(data as Buffer)))
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => messages.length === 3)
    expect(messages[2]).toEqual(jpeg)
    expect(messages.some((data) => data.toString().includes(value.egress.endpoint().authorization))).toBe(
      false,
    )
    const closed = once(client, 'close')
    value.replaceWorker()
    await closed
    expect(client.readyState).toBe(WebSocket.CLOSED)
  })
  it('relays binary video with no private credential in the browser messages and closes on revocation', async () => {
    const value = await fixture()
    const client = value.connect()
    const messages: { text: string; binary: boolean; bytes: Buffer }[] = []
    client.on('message', (bytes, binary) =>
      messages.push({ text: bytes.toString(), binary, bytes: Buffer.from(bytes as Buffer) }),
    )
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => messages.length === 3)
    expect(value.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: 'fixture-row', sessionId: 'device-chat' }),
      expect.any(AbortSignal),
    )
    expect(JSON.parse(messages[0].text)).toEqual({ type: 'authorized', leaseMs: 60_000 })
    expect(JSON.parse(messages[1].text)).toMatchObject({ id: 'frame-1', byteLength: jpeg.length })
    expect(messages[2]).toMatchObject({ binary: true, bytes: jpeg })
    expect(messages.some((entry) => entry.text.includes(value.egress.endpoint().authorization))).toBe(false)
    const closed = once(client, 'close')
    value.revoked.abort()
    await closed
  })

  it.each([
    ['missing-origin', { Origin: '' }, '/api/client-modules/device-media'],
    ['wrong-origin', { Origin: 'https://untrusted.invalid' }, '/api/client-modules/device-media'],
    ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }, '/api/client-modules/device-media'],
    ['URL-ticket', {}, '/api/client-modules/device-media?ticket=forbidden'],
    ['unknown-route', {}, '/unknown-media-route'],
  ] as const)('refuses %s before resolving any private endpoint', async (_name, headers, path) => {
    const value = await fixture()
    const client = value.connect(headers, path)
    await new Promise<void>((done) => client.once('close', () => done()))
    expect(value.resolve).not.toHaveBeenCalled()
  })

  it.each(['missing', 'wrong-endpoint'] as const)('fails closed for %s registration', async (mode) => {
    const value = await fixture(mode)
    const client = value.connect()
    const received: unknown[] = []
    client.on('message', (data) => received.push(data))
    if (mode !== 'missing') {
      await once(client, 'open')
      client.send(JSON.stringify(value.auth()))
    }
    await new Promise<void>((done) => client.once('close', () => done()))
    expect(received).toHaveLength(0)
  })

  it('cancels a pending resolver on client loss without connecting its late endpoint', async () => {
    const value = await fixture('pending')
    const client = value.connect()
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => !!value.signal())
    client.terminate()
    await until(() => value.signal()?.aborted === true)
  })

  it('does not accept destination injection or retarget a running connection', async () => {
    const value = await fixture()
    const client = value.connect()
    await once(client, 'open')
    const closed = once(client, 'close')
    client.send(JSON.stringify({ ...value.auth(), port: 80, host: '192.168.1.1' }))
    await closed
    expect(value.resolve).not.toHaveBeenCalled()
  })

  it('forwards fresh renewal tickets but rejects a scope change in the internal egress', async () => {
    const value = await fixture()
    const client = value.connect()
    let admissions = 0
    client.on('message', (bytes, binary) => {
      if (!binary && JSON.parse(bytes.toString()).type === 'authorized') admissions++
    })
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => admissions === 1)
    client.send(JSON.stringify({ type: 'renew', ticket: value.egress.issue(value.source).ticket }))
    await until(() => admissions === 2)
    const changed = { ...value.source, scope: { ...value.source.scope, sessionId: 'other-chat' } }
    const closed = once(client, 'close')
    client.send(JSON.stringify({ type: 'renew', ticket: value.egress.issue(changed).ticket }))
    await closed
    expect(admissions).toBe(2)
  })

  it('web server shutdown closes both legs and aborts the resolver lifetime', async () => {
    const value = await fixture()
    const client = value.connect()
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => !!value.signal())
    const closed = once(client, 'close')
    await value.web.close()
    await closed
    expect(value.signal()?.aborted).toBe(true)
  })

  it('keeps complete JSON/JPEG groups under real paused-browser TCP backpressure', async () => {
    const value = await fixture()
    const client = value.connect()
    const received: { bytes: Buffer; binary: boolean }[] = []
    client.on('message', (bytes, binary) => received.push({ bytes: Buffer.from(bytes as Buffer), binary }))
    await once(client, 'open')
    client.send(JSON.stringify(value.auth()))
    await until(() => received.length === 3)
    const socket = (client as unknown as { _socket: import('node:net').Socket })._socket
    const image = Buffer.alloc(2 * 1024 * 1024)
    jpeg.subarray(0, -2).copy(image)
    image.writeUInt16BE(0xffd9, image.length - 2)
    socket.pause()
    try {
      for (let i = 0; i < 24; i++) {
        value.setFrame(`paused-${i}`, image)
        await new Promise((done) => setTimeout(done, 80))
      }
    } finally {
      socket.resume()
    }
    value.setFrame('newest', image)
    await until(() =>
      received.some((entry) => !entry.binary && JSON.parse(entry.bytes.toString()).id === 'newest'),
    )
    await until(() => received.length % 2 === 1)
    const groups = received.slice(3)
    const digest = createHash('sha256').update(image).digest('hex')
    expect(groups.length / 2).toBeLessThan(25)
    for (let at = 0; at < groups.length; at += 2) {
      expect(groups[at].binary).toBe(false)
      const info = JSON.parse(groups[at].bytes.toString())
      expect(groups[at + 1].binary).toBe(true)
      expect(groups[at + 1].bytes.length).toBe(info.byteLength)
      expect(
        createHash('sha256')
          .update(groups[at + 1].bytes)
          .digest('hex'),
      ).toBe(digest)
    }
  }, 8000)
})
