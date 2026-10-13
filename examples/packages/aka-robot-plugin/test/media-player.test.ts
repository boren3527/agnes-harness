import { afterEach, describe, expect, it, vi } from 'vitest'

const entry = '../client/media-player.js'
const { createMediaPlayer } = await import(entry)
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  vi.useRealTimers()
})
class Peer {
  readyState = 1
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  message(data: string | ArrayBuffer) {
    this.onmessage?.({ data })
  }
}
function fixture() {
  const peer = new Peer()
  const state = vi.fn()
  const drawImage = vi.fn()
  const bitmap = { width: 3, height: 2, close: vi.fn() }
  const decode = vi.fn(async (_blob: Blob) => bitmap)
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) }
  const socket = vi.fn(() => peer)
  let active = true
  const ticket = vi.fn(async (_input: unknown) => ({
    ticket: 'a'.repeat(43),
    expiresInMs: 30000,
    deviceId: 'robot',
    configRevision: 2,
    bindingRevision: 3,
    rowRevision: 'row-v1',
  }))
  const options = {
    origin: 'http://127.0.0.1:5173',
    rowId: 'row',
    sessionId: 'chat',
    deviceId: 'robot',
    configRevision: 2,
    bindingRevision: 3,
    ticket,
    valid: () => active,
    canvas,
    state,
    socket,
    decode,
  }
  const start = () => {
    const stop = createMediaPlayer(options)
    cleanups.push(stop)
    return stop
  }
  const metadata = {
    type: 'frame',
    id: 'f1',
    width: 3,
    height: 2,
    byteLength: 4,
    timeBasis: 'bridge_receive',
    ageMs: 0,
  }
  const frame = () => {
    peer.message(JSON.stringify(metadata))
    peer.message(new Uint8Array([255, 216, 255, 217]).buffer)
  }
  const auth = () => peer.message(JSON.stringify({ type: 'authorized', leaseMs: 60000 }))
  return {
    peer,
    state,
    drawImage,
    bitmap,
    decode,
    canvas,
    socket,
    ticket,
    options,
    start,
    auth,
    frame,
    inactive: () => {
      active = false
    },
  }
}
async function opened(value: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(value.socket).toHaveBeenCalledTimes(1))
  value.peer.onopen?.()
}
describe('AKA same-origin browser player', () => {
  it('gives the channel its own deadline after a slow ticket response', async () => {
    vi.useFakeTimers()
    const v = fixture()
    const value = await v.ticket({})
    let finish!: (ticket: typeof value) => void
    v.ticket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    v.start()
    await vi.advanceTimersByTimeAsync(6000)
    expect(v.state).toHaveBeenLastCalledWith('videoWaiting')
    finish(value)
    await vi.advanceTimersByTimeAsync(4000)
    v.peer.onopen?.()
    v.auth()
    v.frame()
    await vi.advanceTimersByTimeAsync(0)
    expect(v.state).toHaveBeenLastCalledWith('videoLive')
  })
  it('reports only the failed stage for unavailable tickets and bounds a stalled ticket request', async () => {
    vi.useFakeTimers()
    const failed = fixture()
    const error = vi.fn()
    Object.assign(failed.options, { error })
    failed.ticket.mockRejectedValue(new Error('503 private backend details'))
    failed.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(error).toHaveBeenLastCalledWith('videoTicketError')
    expect(failed.state).toHaveBeenLastCalledWith('videoError')
    expect(failed.socket).not.toHaveBeenCalled()
    const stalled = fixture()
    Object.assign(stalled.options, { error })
    stalled.ticket.mockImplementation(() => new Promise(() => {}))
    stalled.start()
    await vi.advanceTimersByTimeAsync(15000)
    expect(stalled.state).toHaveBeenLastCalledWith('videoError')
    expect(error).toHaveBeenLastCalledWith('videoTicketError')
  })
  it('authenticates only in the first message and paints a decoded matching frame', async () => {
    const v = fixture()
    const stop = v.start()
    await opened(v)
    expect(v.socket).toHaveBeenCalledWith('ws://127.0.0.1:5173/api/client-modules/device-media')
    expect(v.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'auth', rowId: 'row', sessionId: 'chat', ticket: 'a'.repeat(43) }),
    )
    v.auth()
    expect(v.drawImage).not.toHaveBeenCalled()
    v.frame()
    await vi.waitFor(() => expect(v.state).toHaveBeenLastCalledWith('videoLive'))
    expect(v.drawImage).toHaveBeenCalledWith(v.bitmap, 0, 0)
    expect(v.bitmap.close).toHaveBeenCalledTimes(1)
    stop()
    expect(v.canvas.width).toBe(0)
    expect(v.peer.close).toHaveBeenCalledTimes(1)
  })
  it('rejects a ticket for another configuration before opening a socket', async () => {
    const v = fixture()
    v.ticket.mockResolvedValue({
      ticket: 'a'.repeat(43),
      expiresInMs: 30000,
      deviceId: 'robot',
      configRevision: 9,
      bindingRevision: 3,
      rowRevision: 'row-v1',
    })
    v.start()
    await vi.waitFor(() => expect(v.state).toHaveBeenLastCalledWith('videoError'))
    expect(v.socket).not.toHaveBeenCalled()
  })
  it('does not open a socket for a ticket resolved after disposal', async () => {
    const v = fixture()
    const stop = v.start()
    stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(v.socket).not.toHaveBeenCalled()
    expect(v.state).toHaveBeenCalledTimes(1)
  })
  it.each(['binary', 'metadata', 'oversize'])('closes on invalid %s without painting', async (kind) => {
    const v = fixture()
    v.start()
    await opened(v)
    v.auth()
    if (kind === 'binary') v.peer.message(new Uint8Array([255, 216, 255, 217]).buffer)
    else
      v.peer.message(
        JSON.stringify({
          type: 'frame',
          width: 3,
          height: 2,
          byteLength: kind === 'oversize' ? 4 * 1024 * 1024 : 4,
        }),
      )
    expect(v.state).toHaveBeenLastCalledWith('videoError')
    expect(v.drawImage).not.toHaveBeenCalled()
  })
  it('keeps only the latest waiting frame while a decode is in progress', async () => {
    const v = fixture()
    let finish!: (value: typeof v.bitmap) => void
    v.decode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    v.start()
    await opened(v)
    v.auth()
    v.frame()
    v.frame()
    v.frame()
    expect(v.decode).toHaveBeenCalledTimes(1)
    finish(v.bitmap)
    await vi.waitFor(() => expect(v.decode).toHaveBeenCalledTimes(2))
    expect(v.drawImage).toHaveBeenCalledTimes(2)
  })
  it('discards a pending decode after the session owner changes', async () => {
    const v = fixture()
    let finish!: (value: typeof v.bitmap) => void
    v.decode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    v.start()
    await opened(v)
    v.auth()
    v.frame()
    v.inactive()
    finish(v.bitmap)
    await vi.waitFor(() => expect(v.bitmap.close).toHaveBeenCalledTimes(1))
    expect(v.drawImage).not.toHaveBeenCalled()
  })
  it('rejects wrong decoded dimensions without reporting live video', async () => {
    const v = fixture()
    v.bitmap.width = 5
    v.start()
    await opened(v)
    v.auth()
    v.frame()
    await vi.waitFor(() => expect(v.state).toHaveBeenLastCalledWith('videoError'))
    expect(v.drawImage).not.toHaveBeenCalled()
    expect(v.bitmap.close).toHaveBeenCalledTimes(1)
  })
  it('keeps live frames through slow and repeated renewals, then terminates at lease expiry without acknowledgement', async () => {
    vi.useFakeTimers()
    const v = fixture()
    v.start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    v.peer.onopen?.()
    v.auth()
    let renewTicket: ((value: Awaited<ReturnType<typeof v.ticket>>) => void) | undefined
    const grant = await v.ticket({})
    v.ticket.mockRejectedValueOnce(new Error('temporary read-only service failure'))
    v.ticket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          renewTicket = resolve
        }),
    )
    for (let i = 0; i < 7; i++) {
      v.frame()
      await vi.advanceTimersByTimeAsync(4000)
    }
    v.frame()
    await vi.advanceTimersByTimeAsync(2000)
    for (let i = 0; i < 3; i++) {
      v.frame()
      await vi.advanceTimersByTimeAsync(4000)
    }
    expect(v.peer.close).not.toHaveBeenCalled()
    renewTicket?.(grant)
    await vi.advanceTimersByTimeAsync(0)
    expect(v.peer.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'renew', ticket: 'a'.repeat(43) }))
    v.auth()
    // More than ten minutes on the same socket: each new lease must replace the prior expiry.
    for (let renewal = 0; renewal < 20; renewal++) {
      for (let frame = 0; frame < 8; frame++) {
        v.frame()
        await vi.advanceTimersByTimeAsync(4000)
      }
      expect(v.peer.close).not.toHaveBeenCalled()
      expect(v.state).toHaveBeenLastCalledWith('videoLive')
      v.auth()
    }
    for (let i = 0; i < 14; i++) {
      v.frame()
      await vi.advanceTimersByTimeAsync(4000)
    }
    expect(v.peer.close).not.toHaveBeenCalled()
    v.frame()
    await vi.advanceTimersByTimeAsync(4000)
    expect(v.state).toHaveBeenLastCalledWith('videoError')
    expect(v.socket).toHaveBeenCalledTimes(1)
  })
  it('clears the displayed image when an authenticated stream stops delivering frames', async () => {
    vi.useFakeTimers()
    const v = fixture()
    v.start()
    await vi.advanceTimersByTimeAsync(0)
    v.peer.onopen?.()
    v.auth()
    v.frame()
    await vi.advanceTimersByTimeAsync(0)
    expect(v.state).toHaveBeenLastCalledWith('videoLive')
    await vi.advanceTimersByTimeAsync(5000)
    expect(v.state).toHaveBeenLastCalledWith('videoError')
    expect(v.canvas.width).toBe(0)
  })
})
