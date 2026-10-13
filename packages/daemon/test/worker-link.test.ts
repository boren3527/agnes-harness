import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { pluginRowSource } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SharedSessionChannel } from '../../worker-runtime/src/shared-session-channel.js'
import { workerRecognitionAuthorization } from '../src/supervisor/device-recognition-authorization.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { WorkerLink } from '../src/supervisor/worker-link.js'

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = []

  write(chunk: Buffer): boolean {
    this.writes.push(chunk)
    return true
  }

  end(): this {
    return this
  }

  reply(requestId: string, value: { result?: unknown; error?: { code: string; message: string } }): void {
    this.emit('data', encodeFrame({ kind: 'reply', requestId, ...value }))
  }
}

function setup() {
  const socket = new FakeSocket()
  const link = new WorkerLink(socket as unknown as Socket, {
    onEvent() {},
    async onRequest() {},
  })
  return { link, socket }
}

afterEach(() => vi.useRealTimers())

describe('WorkerLink command settlement', () => {
  it('fails the process link on an unsafe hello generation', async () => {
    const { link, socket } = setup()
    socket.emit(
      'data',
      encodeFrame({
        kind: 'hello',
        token: 'token',
        workerKey: '@shared',
        workerGeneration: Number.MAX_SAFE_INTEGER + 1,
        profileHash: 'profile',
        workerKind: 'session',
      }),
    )
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })

  it('rejects a reply carrying another session key', async () => {
    const { link, socket } = setup()
    const command = link.commandForSession('a', 'ping', {})
    socket.emit(
      'data',
      encodeFrame({ kind: 'reply', requestId: 's1', sessionKey: 'b', result: { ok: true } }),
    )
    await expect(command).rejects.toThrow('session mismatch')
    expect(link.alive).toBe(true)
  })

  it('routes logs by their frame session and rejects a session frame without a key', async () => {
    const socket = new FakeSocket()
    const logs: string[] = []
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent() {},
      async onRequest() {},
      onLog: (sessionKey, _level, message) => logs.push(`${sessionKey}:${message}`),
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({ kind: 'log', sessionKey: 'a', level: 'info', message: 'one' }),
        encodeFrame({ kind: 'log', sessionKey: 'b', level: 'info', message: 'two' }),
      ]),
    )
    await vi.waitFor(() => expect(logs).toEqual(['a:one', 'b:two']))
    socket.emit('data', encodeFrame({ kind: 'event', event: { seq: 1 } }))
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })

  it('does not settle a later reply before an earlier event projection finishes', async () => {
    let release: (() => void) | undefined
    const projected = new Promise<void>((resolve) => {
      release = resolve
    })
    const socket = new FakeSocket()
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent: () => projected,
      async onRequest() {},
    })
    const command = link.commandForSession('session-a', 'ping', {}, { timeoutMs: 31_000 })
    let settled = false
    void command.then(() => {
      settled = true
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({
          kind: 'hello',
          token: 'token',
          workerKey: '@shared',
          workerGeneration: 1,
          profileHash: 'profile',
          workerKind: 'session',
        }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 1 } }),
        encodeFrame({ kind: 'reply', sessionKey: 'session-a', requestId: 's1', result: { ok: true } }),
      ]),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await expect(command).resolves.toEqual({ ok: true })
  })

  it('prevents a closed session channel from commanding a replacement with the same key', async () => {
    const { link, socket } = setup()
    const old = link.session('session-a', {
      binding: {
        version: 1,
        sessionKey: 'session-a',
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: '/workspace',
      },
    })
    socket.emit(
      'data',
      encodeFrame({
        kind: 'reply',
        sessionKey: 'session-a',
        requestId: 's1',
        result: { writerRunId: 'old', generation: 1 },
      }),
    )
    await old.hello
    const closing = old.closeSession()
    socket.emit(
      'data',
      encodeFrame({ kind: 'reply', sessionKey: 'session-a', requestId: 's2', result: undefined }),
    )
    await closing

    const replacement = link.session('session-a', {
      binding: {
        version: 1,
        sessionKey: 'session-a',
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: '/workspace',
      },
      resume: true,
    })
    socket.emit(
      'data',
      encodeFrame({
        kind: 'reply',
        sessionKey: 'session-a',
        requestId: 's3',
        result: { writerRunId: 'new', generation: 2 },
      }),
    )
    await replacement.hello
    const writesBeforeStaleCalls = socket.writes.length

    await expect(old.command('ping', {})).rejects.toThrow('worker session channel closed')
    await expect(old.tail(1)).rejects.toThrow('worker session channel closed')
    expect(socket.writes).toHaveLength(writesBeforeStaleCalls)
  })

  it('isolates a failed session projection without blocking another session', async () => {
    const socket = new FakeSocket()
    const order: number[] = []
    // The failure observer throwing (it runs notices and cleanup) must stay inside the link: the
    // frame chain has no one to hand a rejection to, and an unhandled one ends the daemon.
    const onSessionFailure = vi.fn(() => {
      throw new Error('observer failed')
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    onTestFinished(() => void process.off('unhandledRejection', onUnhandled))
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent: async (sessionKey, event) => {
        order.push(event.seq)
        if (sessionKey === 'session-a') throw new Error('projection failed')
      },
      async onRequest() {},
      onSessionFailure,
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({
          kind: 'hello',
          token: 'token',
          workerKey: '@shared',
          workerGeneration: 1,
          profileHash: 'profile',
          workerKind: 'session',
        }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 1 } }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 2 } }),
        encodeFrame({ kind: 'event', sessionKey: 'session-b', event: { seq: 3 } }),
      ]),
    )
    await vi.waitFor(() => expect(onSessionFailure).toHaveBeenCalledOnce())
    expect(link.alive).toBe(true)
    expect(order).toEqual([1, 3])
    await new Promise((r) => setTimeout(r, 20))
    expect(unhandled).toEqual([])
  })

  it.each([
    ['result', { result: { ok: true } }],
    ['error', { error: { code: 'E_TEST', message: 'refused' } }],
  ] as const)('clears the command deadline after a %s reply', async (_kind, reply) => {
    vi.useFakeTimers()
    const { link, socket } = setup()
    const command = link.command('ping', {}, { timeoutMs: 31_000 })
    expect(vi.getTimerCount()).toBe(1)

    socket.reply('s1', reply)
    if ('error' in reply) await expect(command).rejects.toEqual(reply.error)
    else await expect(command).resolves.toEqual(reply.result)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears every pending deadline when the link closes', async () => {
    vi.useFakeTimers()
    const { link } = setup()
    const first = link.command('ping', {}, { timeoutMs: 31_000 })
    const second = link.command('ping', {}, { timeoutMs: 31_000 })
    expect(vi.getTimerCount()).toBe(2)

    link.close('test')
    await expect(first).rejects.toThrow('worker link closed')
    await expect(second).rejects.toThrow('worker link closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('immediately notifies an exit observer registered after local close', () => {
    const { link } = setup()
    link.close('before observer registration')
    const exited = vi.fn()
    link.onExit(exited)
    expect(exited).toHaveBeenCalledOnce()
  })

  it('keeps timeout and late-reply settlement single-shot', async () => {
    vi.useFakeTimers()
    const { link, socket } = setup()
    const command = link.command('ping', {}, { timeoutMs: 10 })
    const rejection = expect(command).rejects.toThrow('worker command ping timed out')
    await vi.advanceTimersByTimeAsync(10)
    await rejection
    expect(vi.getTimerCount()).toBe(0)

    socket.reply('s1', { result: { late: true } })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('installation errors across worker frames', () => {
  it.each([
    [
      rpcError('CAPABILITY_DENIED', { code: 'SKILL_INSTALL_LOCAL_OWNER_REQUIRED', secret: 'private' }),
      'SKILL_INSTALL_LOCAL_OWNER_REQUIRED',
    ],
    [rpcError('INVALID_PARAMS', { secret: 'private' }), 'SKILL_INSTALL_INVALID'],
    [new Error('SKILL_READ_REJECTED'), 'SKILL_READ_REJECTED'],
    [new Error('private path and token'), 'SKILL_INSTALL_FAILED'],
  ])('preserves safe categories without arbitrary messages', async (failure, code) => {
    const socket = new FakeSocket()
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent() {},
      async onRequest() {
        throw failure
      },
    })
    const channel = new SharedSessionChannel((frame) => socket.emit('data', encodeFrame(frame)))
    const pending = channel.run('session', () =>
      channel.request('skill-install', {}, new AbortController().signal),
    )
    const rejected = expect(pending).rejects.toEqual({ code, message: code })
    await vi.waitFor(() => expect(socket.writes.length).toBe(1))
    const bytes = socket.writes[0]
    if (!bytes) throw new Error('missing reply')
    const reply = JSON.parse(bytes.toString())
    expect(JSON.stringify(reply)).not.toContain('private')
    channel.settle(reply)
    await rejected
    socket.emit('close')
    expect(link.alive).toBe(false)
  })
})

describe('WorkerLink preview frames', () => {
  it('hands a preview frame to onPreview after the events before it, without its kind or key', async () => {
    const socket = new FakeSocket()
    const order: string[] = []
    let releaseEvent!: () => void
    const eventDone = new Promise<void>((resolve) => {
      releaseEvent = resolve
    })
    new WorkerLink(socket as unknown as Socket, {
      onEvent: async () => {
        await eventDone
        order.push('event')
      },
      onPreview: (key, update) => order.push(`preview:${key}:${JSON.stringify(update)}`),
      async onRequest() {},
    })
    socket.emit('data', encodeFrame({ kind: 'event', sessionKey: 's', seq: 1, event: { seq: 1, type: 'x' } }))
    socket.emit(
      'data',
      encodeFrame({
        kind: 'preview',
        sessionKey: 's',
        lane: 'main',
        effectId: 'e1',
        stream: 'text',
        offset: 0,
        delta: 'hi',
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    releaseEvent()
    await vi.waitFor(() => expect(order).toHaveLength(2))
    expect(order).toEqual([
      'event',
      'preview:s:{"lane":"main","effectId":"e1","stream":"text","offset":0,"delta":"hi"}',
    ])
  })

  it('closes the link on a preview frame without a session key', async () => {
    const { link, socket } = setup()
    socket.emit(
      'data',
      encodeFrame({ kind: 'preview', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'x' }),
    )
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })
})

describe('daemon-dispatched service effect continuity', () => {
  const input = (callId = 'a'.repeat(32)) => ({
    callId,
    sessionKey: 'device',
    effectCommandId: 'command-1',
    credential: { private: 'not-in-scope' },
    call: {
      sessionId: 'device',
      extension: 'plugin/aka-test',
      service: 'aka.recognition.test',
      commandId: 'command-1',
      input: {},
    },
  })
  it('binds staged recognition checks to the same pending dispatch and refuses retired scopes', async () => {
    const { link, socket } = setup()
    const params = input()
    params.call.extension = pluginRowSource('ext:agnes-examples/aka-robot')
    const pending = link.command('callService', params)
    const scope = link.serviceEffect('device', params.callId)
    if (!scope) throw new Error('missing actual pending scope')
    const authority = workerRecognitionAuthorization(link, scope, new AbortController().signal)
    for (const stage of ['upload-authorize', 'upload', 'detect'] as const) {
      const checking = authority.assertIOAuthorized(stage, authority.revoked)
      const frame = JSON.parse(socket.writes.at(-1)?.toString() ?? 'null')
      expect(frame).toMatchObject({
        kind: 'command',
        method: 'deviceRecognition.authorize',
        params: { sessionKey: 'device', callId: params.callId, stage },
      })
      socket.reply(frame.requestId, { result: { authorized: true } })
      await expect(checking).resolves.toBeUndefined()
    }
    // A JSON copy cannot stand in for the exact daemon-owned view.
    expect(() => workerRecognitionAuthorization(link, { ...scope }, authority.revoked)).toThrow()
    socket.reply('s1', { result: {} })
    await pending
    expect(authority.revoked.aborted).toBe(true)
    const writes = socket.writes.length
    await expect(authority.assertAuthorized()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(socket.writes).toHaveLength(writes)
  })
  it.each(['other-plugin', 'other-service', 'recover-only'] as const)(
    'refuses recognition admission for %s without sending a Host check',
    async (mode) => {
      const { link, socket } = setup()
      const params = {
        ...input(),
        ...(mode === 'recover-only' ? { effectRecoverOnly: true } : {}),
      }
      params.call.extension =
        mode === 'other-plugin'
          ? pluginRowSource('ext:another-plugin')
          : pluginRowSource('ext:agnes-examples/aka-robot')
      if (mode === 'other-service') params.call.service = 'aka.recognition.round.start'
      const pending = link.command('callService', params)
      const scope = link.serviceEffect('device', params.callId)
      if (!scope) throw new Error('missing actual pending scope')
      expect(() => workerRecognitionAuthorization(link, scope, scope.revoked)).toThrow()
      expect(socket.writes).toHaveLength(1)
      socket.reply('s1', { result: {} })
      await pending
    },
  )
  it('refuses an unsupported stage before sending any backcheck', async () => {
    const { link, socket } = setup()
    const params = input()
    params.call.extension = pluginRowSource('ext:agnes-examples/aka-robot')
    const pending = link.command('callService', params)
    const scope = link.serviceEffect('device', params.callId)
    if (!scope) throw new Error('missing actual pending scope')
    const authority = workerRecognitionAuthorization(link, scope, scope.revoked)
    await expect(authority.assertIOAuthorized('redirect' as never, scope.revoked)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(socket.writes).toHaveLength(1)
    socket.reply('s1', { result: {} })
    await pending
  })
  it.each([undefined, false, { authorized: false }, { authorized: true, extra: true }])(
    'refuses malformed Host recognition response %j',
    async (result) => {
      const { link, socket } = setup()
      const params = input()
      params.call.extension = pluginRowSource('ext:agnes-examples/aka-robot')
      const pending = link.command('callService', params)
      const scope = link.serviceEffect('device', params.callId)
      if (!scope) throw new Error('missing actual pending scope')
      const authority = workerRecognitionAuthorization(link, scope, scope.revoked)
      const checking = authority.assertAuthorized()
      socket.reply('s2', { result })
      await expect(checking).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      socket.reply('s1', { result: {} })
      await pending
    },
  )
  it.each(['stage-cancel', 'effect-finished', 'host-error', 'timeout'] as const)(
    'does not grant recognition after %s during the Host check',
    async (reason) => {
      vi.useFakeTimers()
      const { link, socket } = setup()
      const params = input()
      params.call.extension = pluginRowSource('ext:agnes-examples/aka-robot')
      const pending = link.command('callService', params)
      const scope = link.serviceEffect('device', params.callId)
      if (!scope) throw new Error('missing actual pending scope')
      const authority = workerRecognitionAuthorization(link, scope, scope.revoked)
      const stage = new AbortController()
      const checking = authority.assertIOAuthorized('upload', stage.signal)
      const refused = expect(checking).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      if (reason === 'stage-cancel') stage.abort()
      if (reason === 'effect-finished') {
        socket.reply('s1', { result: {} })
        await pending
      }
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(2000)
      socket.reply(
        's2',
        reason === 'host-error'
          ? { error: { code: 'error', message: 'private signed-url credential' } }
          : { result: { authorized: true } },
      )
      await refused
      if (reason !== 'effect-finished') {
        socket.reply('s1', { result: {} })
        await pending
      }
    },
  )
  it('copies only the trusted dispatch identity and revokes it on the actual reply', async () => {
    const { link, socket } = setup()
    const params = input()
    const pending = link.command('callService', params)
    const scope = link.serviceEffect('device', params.callId)
    expect(scope).toMatchObject({
      sessionKey: 'device',
      callId: params.callId,
      commandId: 'command-1',
      extension: params.call.extension,
      service: params.call.service,
    })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(Object.keys(scope ?? {}).sort()).toEqual([
      'callId',
      'commandId',
      'extension',
      'revoked',
      'service',
      'sessionKey',
    ])
    expect(link.serviceEffect('other', params.callId)).toBeUndefined()
    expect(link.serviceEffect('device', 'b'.repeat(32))).toBeUndefined()
    params.call.service = 'other'
    params.sessionKey = 'other'
    expect(scope?.service).toBe('aka.recognition.test')
    socket.reply('s1', { result: {} })
    await pending
    expect(scope?.revoked.aborted).toBe(true)
    expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
  })
  it('copies trusted recovery scope and revokes it on completion', async () => {
    const { link, socket } = setup()
    const params = { ...input(), effectRecoverOnly: true }
    const pending = link.command('callService', params)
    const scope = link.serviceEffect('device', params.callId)
    expect(scope?.recoverOnly).toBe(true)
    params.effectRecoverOnly = false
    expect(scope?.recoverOnly).toBe(true)
    socket.reply('s1', { result: {} })
    await pending
    expect(scope?.revoked.aborted).toBe(true)
  })
  it.each(['inspect', 'query', 'mismatch', 'wrong-session', 'malformed', 'bad-recovery'] as const)(
    'does not grant continuity for %s input',
    async (mode) => {
      const { link, socket } = setup()
      const params = input()
      if (mode === 'query') delete (params as Partial<typeof params>).effectCommandId
      if (mode === 'mismatch') params.effectCommandId = 'another-command'
      if (mode === 'wrong-session') params.sessionKey = 'other'
      if (mode === 'malformed') Object.assign(params.call, { extra: 'selector' })
      if (mode === 'bad-recovery') Object.assign(params, { effectRecoverOnly: false })
      const pending = link.command(mode === 'inspect' ? 'inspectService' : 'callService', params)
      expect(link.serviceEffect('device', params.callId)).toBeUndefined()
      socket.reply('s1', { result: {} })
      await pending
    },
  )
  it('revokes before an abort acknowledgement, without settling the unknown service outcome', async () => {
    const { link, socket } = setup()
    const pending = link.command('callService', input())
    const scope = link.serviceEffect('device', 'a'.repeat(32))
    const aborted = link.command('abortService', { callId: 'a'.repeat(32) })
    expect(scope?.revoked.aborted).toBe(true)
    expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
    socket.reply('s2', { result: {} })
    await aborted
    socket.reply('s1', { result: { possiblyDispatched: true } })
    await expect(pending).resolves.toEqual({ possiblyDispatched: true })
  })
  it('revokes on timeout and never revives the scope on a late reply', async () => {
    vi.useFakeTimers()
    try {
      const { link, socket } = setup()
      const pending = link.command('callService', input(), { timeoutMs: 20 })
      const scope = link.serviceEffect('device', 'a'.repeat(32))
      const failed = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(20)
      await failed
      expect(scope?.revoked.aborted).toBe(true)
      socket.reply('s1', { result: {} })
      await Promise.resolve()
      expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('revokes on worker error, failed session and explicit session close', async () => {
    for (const reason of ['error', 'failed', 'close'] as const) {
      const { link, socket } = setup()
      const pending = link.command('callService', input())
      const scope = link.serviceEffect('device', 'a'.repeat(32))
      if (reason === 'error') {
        const failed = expect(pending).rejects.toThrow('worker link closed')
        socket.emit('error', new Error('transport failure'))
        await failed
      } else if (reason === 'failed') {
        socket.emit(
          'data',
          encodeFrame({ kind: 'session.interrupted', sessionKey: 'device', reason: 'failed' }),
        )
        await vi.waitFor(() => expect(scope?.revoked.aborted).toBe(true))
        socket.reply('s1', { result: {} })
        await pending
      } else {
        const closed = link.closeSession('device', 'retired')
        expect(scope?.revoked.aborted).toBe(true)
        socket.emit('data', encodeFrame({ kind: 'reply', sessionKey: 'device', requestId: 's2', result: {} }))
        await closed
        socket.reply('s1', { result: {} })
        await pending
      }
      expect(scope?.revoked.aborted).toBe(true)
      expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
    }
  })
  it('refuses ambiguous duplicate call IDs and bounds scopes without granting a fallback', async () => {
    const { link, socket } = setup()
    const first = link.command('callService', input())
    const scope = link.serviceEffect('device', 'a'.repeat(32))
    const duplicate = link.command('callService', input())
    expect(scope?.revoked.aborted).toBe(true)
    expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
    socket.reply('s1', { result: {} })
    socket.reply('s2', { result: {} })
    await Promise.all([first, duplicate])
    const all: Promise<unknown>[] = []
    for (let i = 0; i < 129; i++)
      all.push(link.command('callService', input(i.toString(16).padStart(32, '0'))))
    expect(link.serviceEffect('device', '7f'.padStart(32, '0'))).toBeDefined()
    expect(link.serviceEffect('device', '80'.padStart(32, '0'))).toBeUndefined()
    all.forEach((_, i) => {
      socket.reply(`s${i + 3}`, { result: {} })
    })
    await Promise.all(all)
  })
  it('cleans a scope if the command write throws instead of leaving admission alive', async () => {
    const { link, socket } = setup()
    vi.spyOn(socket, 'write').mockImplementationOnce(() => {
      throw new Error('write unavailable')
    })
    await expect(link.command('callService', input())).rejects.toThrow('write unavailable')
    expect(link.serviceEffect('device', 'a'.repeat(32))).toBeUndefined()
    const running = link.command('callService', input())
    const scope = link.serviceEffect('device', 'a'.repeat(32))
    const failed = expect(running).rejects.toThrow('worker link closed')
    vi.spyOn(socket, 'write').mockImplementationOnce(() => {
      throw new Error('close write unavailable')
    })
    expect(() => link.close('retired')).toThrow('close write unavailable')
    await failed
    expect(scope?.revoked.aborted).toBe(true)
    expect(link.alive).toBe(false)
  })
})
