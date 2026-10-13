import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { AkaMediaEgress, type MediaScope, type MediaSource, runtimeMediaSource } from '../src/media-egress.js'
import type { AkaRuntime, RuntimeFrame } from '../src/runtime.js'

const scope: MediaScope = {
  sessionId: 'device-chat',
  deviceId: '11111111-1111-4111-8111-111111111111',
  rowRevision: 'fixture-plugin-revision',
  runtimeInstanceId: 'fixture-runtime-instance',
  bindingRevision: 1,
  configRevision: 1,
  connectionGeneration: 1,
  mediaGeneration: 1,
}
// Framing-only fixture; these tests cover wire transport, not JPEG decoder acceptance.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 0, 0xff, 0xd9])
const frame = (id = 'fixture-frame'): RuntimeFrame => ({
  id,
  bytes: Buffer.from(jpeg),
  width: 3,
  height: 2,
  receivedAt: performance.now(),
  timeBasis: 'bridge_receive',
})
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})

async function fixture() {
  const owner = new AbortController()
  let clock = 0
  let current: RuntimeFrame | null = frame()
  let active = true
  const revoked = new AbortController()
  const source: MediaSource = {
    scope,
    revoked: revoked.signal,
    check: () => {
      if (!active) throw new Error('Retired source')
    },
    read: () => current,
  }
  const server = new AkaMediaEgress(owner.signal, () => clock)
  cleanup.push(() => server.close())
  await server.listen()
  const endpoint = server.endpoint()
  const connect = (headers: Record<string, string> = {}, path = '/media') => {
    const client = new WebSocket(`ws://127.0.0.1:${endpoint.port}${path}`, {
      headers: { Authorization: endpoint.authorization, ...headers },
      perMessageDeflate: false,
    })
    client.on('error', () => {})
    cleanup.push(async () => {
      client.terminate()
    })
    return client
  }
  return {
    server,
    source,
    revoked,
    owner,
    connect,
    setClock: (value: number) => {
      clock = value
    },
    setFrame: (value: RuntimeFrame | null) => {
      current = value
    },
    retire: () => {
      active = false
    },
  }
}

function messages(client: WebSocket) {
  const values: { bytes: Buffer; binary: boolean }[] = []
  client.on('message', (bytes, binary) => {
    values.push({ bytes: Buffer.from(bytes as Buffer), binary })
  })
  return values
}
async function until(test: () => boolean) {
  const deadline = performance.now() + 2000
  while (!test()) {
    if (performance.now() > deadline) throw new Error('Transport assertion deadline')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('AKA internal loopback binary egress', () => {
  it('requires separate host credentials, consumes one-use tickets and sends ordered JSON/JPEG groups', async () => {
    const value = await fixture()
    const grant = value.server.issue(value.source)
    expect(grant.expiresInMs).toBe(30_000)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    expect(received).toHaveLength(0)
    client.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }))
    await until(() => received.length >= 3)
    expect(JSON.parse(received[0].bytes.toString())).toEqual({ type: 'authorized', leaseMs: 60_000 })
    expect(JSON.parse(received[1].bytes.toString())).toMatchObject({
      type: 'frame',
      id: 'fixture-frame',
      width: 3,
      height: 2,
      byteLength: jpeg.length,
      timeBasis: 'bridge_receive',
    })
    expect(received[1].binary).toBe(false)
    expect(received[2]).toEqual({ bytes: jpeg, binary: true })
    const replay = value.connect()
    await once(replay, 'open')
    const closed = once(replay, 'close')
    replay.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }))
    await closed
    value.setFrame(frame('second'))
    await until(() => received.length === 5)
    expect(JSON.parse(received[3].bytes.toString()).id).toBe('second')
    const stopped = once(client, 'close')
    value.revoked.abort()
    await stopped
  })

  it.each([
    ['wrong-host-credential', { Authorization: 'Bearer invalid' }, '/media'],
    ['direct-browser-origin', { Origin: 'http://127.0.0.1' }, '/media'],
    ['browser-chosen-path', {}, '/media?ticket=forbidden'],
    ['subprotocol', { 'Sec-WebSocket-Protocol': 'forbidden' }, '/media'],
  ] as const)('refuses %s before any frame', async (_name, headers, path) => {
    const value = await fixture()
    const client = value.connect(headers, path)
    const received = messages(client)
    await new Promise<void>((resolve) => client.once('close', () => resolve()))
    expect(received).toHaveLength(0)
  })

  it.each(['expired', 'revoked', 'wrong-message', 'binary', 'retired'] as const)(
    'closes a %s authentication with no output',
    async (mode) => {
      const value = await fixture()
      const { ticket } = value.server.issue(value.source)
      const client = value.connect()
      const received = messages(client)
      await once(client, 'open')
      if (mode === 'expired') value.setClock(30_000)
      if (mode === 'revoked') value.revoked.abort()
      if (mode === 'retired') value.retire()
      const closed = once(client, 'close')
      client.send(JSON.stringify({ type: mode === 'wrong-message' ? 'renew' : 'auth', ticket }), {
        binary: mode === 'binary',
      })
      await closed
      expect(received).toHaveLength(0)
    },
  )

  it('renews only the same scope and closes on lease expiry without renewing from client text', async () => {
    const value = await fixture()
    value.setFrame(null)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'auth', ticket: value.server.issue(value.source).ticket }))
    await until(() => received.length === 1)
    value.setClock(50_000)
    client.send(JSON.stringify({ type: 'renew', ticket: value.server.issue(value.source).ticket }))
    await until(() => received.length === 2)
    value.setClock(109_999)
    expect(client.readyState).toBe(WebSocket.OPEN)
    const closed = once(client, 'close')
    value.setClock(110_000)
    await closed
  })

  it.each([
    'sessionId',
    'deviceId',
    'rowRevision',
    'runtimeInstanceId',
    'bindingRevision',
    'configRevision',
    'connectionGeneration',
    'mediaGeneration',
  ] as const)('rejects renewal after %s changes', async (field) => {
    const value = await fixture()
    value.setFrame(null)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'auth', ticket: value.server.issue(value.source).ticket }))
    await until(() => received.length === 1)
    const changed = { ...scope, [field]: typeof scope[field] === 'number' ? 2 : 'different' } as MediaScope
    const grant = value.server.issue({ ...value.source, scope: changed })
    const closed = once(client, 'close')
    client.send(JSON.stringify({ type: 'renew', ticket: grant.ticket }))
    await closed
    expect(received).toHaveLength(1)
  })

  it('does not retain unbounded tickets and checks epochs even without a new frame', async () => {
    const value = await fixture()
    for (let i = 0; i < 128; i++) value.server.issue(value.source)
    expect(() => value.server.issue(value.source)).toThrow('limit')
    value.setClock(30_000)
    const ticket = value.server.issue(value.source).ticket
    value.setFrame(null)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'auth', ticket }))
    await until(() => received.length === 1)
    const closed = once(client, 'close')
    value.retire()
    await closed
    expect(received).toHaveLength(1)
  })

  it('closes an unauthenticated peer after the handshake deadline without reading any frame', async () => {
    const value = await fixture()
    value.setFrame(null)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    await once(client, 'close')
    expect(received).toHaveLength(0)
  }, 6000)

  it.each(['dimensions', 'truncated', 'oversized'] as const)(
    'rejects %s JPEG without a partial frame group',
    async (mode) => {
      const value = await fixture()
      const invalid = frame()
      value.setFrame({
        ...invalid,
        width: mode === 'dimensions' ? 4 : invalid.width,
        bytes:
          mode === 'truncated'
            ? jpeg.subarray(0, -1)
            : mode === 'oversized'
              ? Buffer.alloc(3 * 1024 * 1024 + 1)
              : jpeg,
      })
      const client = value.connect()
      const received = messages(client)
      await once(client, 'open')
      const closed = once(client, 'close')
      client.send(JSON.stringify({ type: 'auth', ticket: value.server.issue(value.source).ticket }))
      await closed
      expect(received).toHaveLength(1)
      expect(JSON.parse(received[0].bytes.toString()).type).toBe('authorized')
    },
  )

  it('caps concurrent unauthenticated WS clients as well as active viewers', async () => {
    const value = await fixture()
    for (let i = 0; i < 32; i++) await once(value.connect(), 'open')
    const rejected = value.connect()
    const received = messages(rejected)
    await new Promise<void>((resolve) => rejected.once('close', () => resolve()))
    expect(received).toHaveLength(0)
  })

  it('copies scope and reader methods and prunes revoked unused tickets', async () => {
    const value = await fixture()
    const mutable = { ...value.source, scope: { ...scope } }
    const ticket = value.server.issue(mutable).ticket
    mutable.scope.sessionId = 'retargeted'
    mutable.read = () => {
      throw new Error('Replaced reader')
    }
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'auth', ticket }))
    await until(() => received.length === 3)
    expect(received[2].binary).toBe(true)
    value.revoked.abort()
    const nextOwner = new AbortController()
    expect(() => value.server.issue({ ...value.source, revoked: nextOwner.signal })).not.toThrow()
  })

  it('skips complete intermediate frames for a paused peer and resumes with intact newest groups', async () => {
    const value = await fixture()
    value.setFrame(null)
    const client = value.connect()
    const received = messages(client)
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'auth', ticket: value.server.issue(value.source).ticket }))
    await until(() => received.length === 1)
    // Pause the real TCP receiver to inject transport backpressure, not a mocked send count.
    const socket = (client as unknown as { _socket: import('node:net').Socket })._socket
    socket.pause()
    const large = Buffer.alloc(2 * 1024 * 1024)
    jpeg.subarray(0, -2).copy(large)
    large.writeUInt16BE(0xffd9, large.length - 2)
    try {
      for (let i = 0; i < 24; i++) {
        value.setFrame({ ...frame(`slow-${i}`), bytes: large })
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
    } finally {
      socket.resume()
    }
    value.setFrame({ ...frame('newest'), bytes: large })
    await until(() =>
      received.some((entry) => !entry.binary && JSON.parse(entry.bytes.toString()).id === 'newest'),
    )
    await until(() => received.length % 2 === 1)
    const groups = received.slice(1)
    const digest = createHash('sha256').update(large).digest('hex')
    expect(groups.length / 2).toBeLessThan(25)
    for (let at = 0; at < groups.length; at += 2) {
      expect(groups[at].binary).toBe(false)
      const metadata = JSON.parse(groups[at].bytes.toString())
      expect(metadata.type).toBe('frame')
      expect(groups[at + 1].binary).toBe(true)
      expect(groups[at + 1].bytes.byteLength).toBe(metadata.byteLength)
      expect(
        createHash('sha256')
          .update(groups[at + 1].bytes)
          .digest('hex'),
      ).toBe(digest)
    }
  }, 8000)

  it('retires all sockets and rejects new work on shutdown during pending listen', async () => {
    const owner = new AbortController()
    const server = new AkaMediaEgress(owner.signal)
    const pending = server.listen()
    const checked = expect(pending).rejects.toThrow('closed')
    owner.abort()
    await server.close()
    await checked
    expect(() => server.endpoint()).toThrow()
    await expect(server.listen()).rejects.toThrow()
  })

  it('binds runtime readers to connection and camera epochs without opening a camera', () => {
    const owner = new AbortController()
    const snapshot = {
      instanceId: scope.runtimeInstanceId,
      connection: 'connected',
      identity: 'matched',
      media: 'streaming',
      generation: 1,
      mediaGeneration: 1,
    }
    let reads = 0
    const runtime = {
      snapshot: () => snapshot,
      latestFrame: () => {
        reads++
        return frame()
      },
    } as unknown as AkaRuntime
    const source = runtimeMediaSource(scope, runtime, owner.signal)
    expect(reads).toBe(0)
    expect(source.read()?.id).toBe('fixture-frame')
    snapshot.mediaGeneration = 2
    expect(() => source.check()).toThrow('retired')
    expect(() => source.read()).toThrow('retired')
    expect(reads).toBe(1)
  })
})
