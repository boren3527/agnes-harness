import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DeviceSessionPort } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { deviceRecognitionPort } from '../../src/ext-host/device-recognition-port.js'

const deviceId = '11111111-1111-4111-8111-111111111111'
const expected = { bindingRevision: 1, configRevision: 2, roundRevision: 3 }
const ticket = '22222222-2222-4222-8222-222222222222'
function fixture() {
  const ac = new AbortController(),
    revoked = new AbortController(),
    row = new AbortController()
  const release = vi.fn()
  const lease = {
    binding: {
      sessionId: 'session',
      deviceId,
      workspaceId: 'a'.repeat(64),
      bindingRevision: 1,
      active: true,
    },
    recognition: {
      deviceId,
      bindingRevision: 1,
      configRevision: 2,
      settings: { provider: 'aliyun', frequency: 2, requestBudget: 100, credentialConfigured: true },
    },
    revoked: revoked.signal,
    release,
  }
  const retain = vi.fn(async () => lease)
  const bytes = readFileSync(new URL('../fixtures/aka-camera-test.jpg', import.meta.url))
  const frame = { id: 'frame', bytes, width: 320, height: 240, receivedAt: performance.now() }
  const select = vi.fn(async () => frame)
  const authorize = vi.fn(async () => {})
  const bridge = vi.fn(async (_session: string, _call: string, input: unknown) => {
    const p = input as { operation: string; frame?: { jpegBase64: string } }
    if (p.operation === 'begin') return { ticket }
    if (!p.frame) throw new Error('missing frame')
    return {
      id: ticket,
      deviceId,
      ...expected,
      frameId: 'frame',
      width: 320,
      height: 240,
      sha256: createHash('sha256').update(Buffer.from(p.frame.jpegBase64, 'base64')).digest('hex'),
      providerRequestId: 'request',
      elapsedMs: 1,
      detections: [{ label: 'ball', confidence: 0.9, box: [10, 10, 30, 30] }],
    }
  })
  const port = deviceRecognitionPort(
    'session',
    'a'.repeat(32),
    bridge,
    { retainRecognition: retain } as unknown as DeviceSessionPort,
    { revoked: row.signal, assertAuthorized: authorize },
    ac.signal,
    () => {},
  )
  return { port, ac, revoked, row, release, lease, retain, bytes, frame, select, authorize, bridge }
}
describe('Host single-image recognition port', () => {
  it('selects only after private admission and returns immutable results for exactly the submitted image', async () => {
    const v = fixture()
    v.select.mockImplementation(async () => {
      expect(v.authorize).toHaveBeenCalled()
      expect(v.bridge).not.toHaveBeenCalled()
      v.frame.receivedAt = performance.now()
      return v.frame
    })
    const result = await v.port.run(expected, v.select)
    expect(result.frameId).toBe(v.frame.id)
    expect(result.sha256).toBe(createHash('sha256').update(v.bytes).digest('hex'))
    expect(Object.isFrozen(result.detections[0]?.box)).toBe(true)
    expect(v.bridge.mock.calls.every((args) => args[0] === 'session' && args[1] === 'a'.repeat(32))).toBe(
      true,
    )
    expect(v.release).toHaveBeenCalledOnce()
    await expect(v.port.run(expected, v.select)).rejects.toThrow()
    expect(v.bridge).toHaveBeenCalledTimes(2)
  })
  it.each([
    'hash',
    'frame',
    'device',
    'version',
    'round',
    'bounds',
    'secret',
    'cancel',
    'lease',
    'authority',
  ])('refuses %s in a late reply and releases the retained lifetime', async (mode) => {
    const v = fixture(),
      original = v.bridge.getMockImplementation()
    if (!original) throw new Error('missing bridge fixture')
    v.bridge.mockImplementation(async (...args) => {
      const value = await original(...args)
      if ((args[2] as { operation: string }).operation === 'begin') return value
      if (mode === 'cancel') v.ac.abort()
      if (mode === 'lease') v.revoked.abort()
      if (mode === 'authority') v.authorize.mockRejectedValue(new Error('denied'))
      return {
        ...value,
        ...(mode === 'hash' ? { sha256: '0'.repeat(64) } : {}),
        ...(mode === 'frame' ? { frameId: 'other' } : {}),
        ...(mode === 'device' ? { deviceId: ticket } : {}),
        ...(mode === 'version' ? { configRevision: 9 } : {}),
        ...(mode === 'round' ? { roundRevision: 9 } : {}),
        ...(mode === 'bounds'
          ? { detections: [{ label: 'ball', confidence: 0.9, box: [0, 0, 999, 999] }] }
          : {}),
        ...(mode === 'secret' ? { credentialRef: 'private' } : {}),
      }
    })
    await expect(v.port.run(expected, v.select)).rejects.toThrow()
    expect(v.release).toHaveBeenCalledOnce()
    await expect(v.port.run(expected, v.select)).rejects.toThrow()
    expect(v.bridge).toHaveBeenCalledTimes(2)
  })
  it.each(['old', 'future', 'bad-jpeg', 'config', 'local', 'cancel-before-select'])(
    'refuses %s before any upload request',
    async (mode) => {
      const v = fixture()
      if (mode === 'old') v.frame.receivedAt = performance.now() - 1001
      if (mode === 'future') v.frame.receivedAt = performance.now() + 10000
      if (mode === 'bad-jpeg') v.frame.bytes = Buffer.from([1, 2, 3])
      if (mode === 'config') v.lease.recognition.configRevision = 3
      if (mode === 'local') v.lease.recognition.settings.provider = 'local'
      if (mode === 'cancel-before-select')
        v.bridge.mockImplementation(async () => {
          v.ac.abort()
          return { ticket }
        })
      await expect(v.port.run(expected, v.select)).rejects.toThrow()
      expect(
        v.bridge.mock.calls.every((args) => (args[2] as { operation: string }).operation === 'begin'),
      ).toBe(true)
      expect(v.release).toHaveBeenCalledOnce()
    },
  )
  it('verifies selected media while the lease is live and releases only after verification', async () => {
    const v = fixture()
    v.release.mockImplementation(() => v.revoked.abort())
    const verify = vi.fn(async () => {
      expect(v.revoked.signal.aborted).toBe(false)
    })
    await expect(v.port.run(expected, v.select, verify)).resolves.toMatchObject({ frameId: 'frame' })
    expect(verify).toHaveBeenCalledOnce()
    expect(v.revoked.signal.aborted).toBe(true)
    const w = fixture()
    await expect(
      w.port.run(expected, w.select, async () => {
        throw new Error('media retired')
      }),
    ).rejects.toThrow('media retired')
    expect(w.release).toHaveBeenCalledOnce()
  })

  it('revokes selection itself when the recognition lease changes before upload', async () => {
    const v = fixture()
    await expect(
      v.port.run(expected, async (signal) => {
        expect(signal.aborted).toBe(false)
        v.revoked.abort()
        expect(signal.aborted).toBe(true)
        return v.frame
      }),
    ).rejects.toThrow()
    expect(v.bridge).not.toHaveBeenCalled()
    expect(v.release).toHaveBeenCalledOnce()
  })

  it.each([600, 1001])(
    'counts %i ms of original persistence once and still rejects expired frames',
    async (delay) => {
      const v = fixture()
      let now = performance.now()
      v.frame.receivedAt = now
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
      const persisted = vi.fn()
      const original = v.bridge.getMockImplementation()!
      let issuedAt = 0
      v.bridge.mockImplementation(async (...args) => {
        const input = args[2] as { operation: string; frame?: { ageAtSendMs: number } }
        if (input.operation === 'begin') issuedAt = now
        else if (!input.frame || now - (issuedAt - input.frame.ageAtSendMs) > 1000)
          throw new Error('Daemon refused expired image')
        return original(...args)
      })
      try {
        const pending = v.port.run(expected, async () => {
          persisted()
          now += delay
          return v.frame
        })
        if (delay > 1000) await expect(pending).rejects.toThrow()
        else await expect(pending).resolves.toMatchObject({ frameId: 'frame' })
        expect(persisted).toHaveBeenCalledOnce()
        expect(v.release).toHaveBeenCalledOnce()
      } finally {
        clock.mockRestore()
      }
    },
  )
  it('does not accept extra selectors or permit a concurrent second run', async () => {
    const v = fixture()
    await expect(v.port.run({ ...expected, callId: 'forged' } as typeof expected, v.select)).rejects.toThrow()
    expect(v.retain).not.toHaveBeenCalled()
    const w = fixture()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    w.select.mockImplementation(async () => {
      await held
      w.frame.receivedAt = performance.now()
      return w.frame
    })
    const first = w.port.run(expected, w.select)
    await expect(w.port.run(expected, w.select)).rejects.toThrow()
    release()
    await expect(first).resolves.toMatchObject({ frameId: 'frame' })
  })
})
