import { expect, it, vi } from 'vitest'
import { DeviceRecognitionAuthorizations } from '../src/device-recognition-authorizations.js'

const callId = 'a'.repeat(32)
it('fixes the call/session/stage, revokes after real lifetime and never returns a grant', async () => {
  const registry = new DeviceRecognitionAuthorizations()
  const lifetime = new AbortController()
  const check = vi.fn(async () => {})
  registry.register('session', callId, {
    revoked: lifetime.signal,
    assertAuthorized: check,
    assertIOAuthorized: check,
  })
  expect(() =>
    registry.register('session', callId, {
      revoked: lifetime.signal,
      assertAuthorized: check,
      assertIOAuthorized: check,
    }),
  ).toThrow()
  for (const input of [
    { callId, sessionKey: 'other', stage: 'detect' },
    { callId, sessionKey: 'session', stage: 'arbitrary' },
    { callId, sessionKey: 'session', stage: 'detect', authorized: true },
  ])
    await expect(registry.authorize(input)).rejects.toThrow('unavailable')
  expect(check).not.toHaveBeenCalled()
  await expect(registry.authorize({ callId, sessionKey: 'session', stage: 'detect' })).resolves.toEqual({
    authorized: true,
  })
  expect(check).toHaveBeenCalledWith('detect', lifetime.signal)
  check.mockResolvedValueOnce(false as never)
  await expect(registry.authorize({ callId, sessionKey: 'session', stage: 'detect' })).rejects.toThrow(
    'unavailable',
  )
  lifetime.abort()
  await expect(registry.authorize({ callId, sessionKey: 'session', stage: 'detect' })).rejects.toThrow()
  expect(check).toHaveBeenCalledTimes(2)
})
it('refuses a late check after retirement and allows reuse only under a new Host lifetime', async () => {
  const registry = new DeviceRecognitionAuthorizations()
  const first = new AbortController()
  let finish!: () => void
  registry.register('session', callId, {
    revoked: first.signal,
    assertAuthorized: async () => {},
    assertIOAuthorized: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  })
  const pending = registry.authorize({ callId, sessionKey: 'session', stage: 'upload' })
  first.abort()
  const next = new AbortController()
  const check = vi.fn(async () => {})
  registry.register('session', callId, {
    revoked: next.signal,
    assertAuthorized: check,
    assertIOAuthorized: check,
  })
  finish()
  await expect(pending).rejects.toThrow('unavailable')
  await expect(registry.authorize({ callId, sessionKey: 'session', stage: 'upload' })).resolves.toEqual({
    authorized: true,
  })
  next.abort()
})
