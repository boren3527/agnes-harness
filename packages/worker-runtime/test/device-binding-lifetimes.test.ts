import { expect, it, vi } from 'vitest'
import { DeviceBindingLifetimes } from '../src/device-binding-lifetimes.js'

const snapshot = (key = 'one', revision = 1, root = 'a') => ({
  workspace: {
    workspaceId: root.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    revision,
    active: true,
  },
  session: {
    sessionId: key,
    workspaceId: root.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    bindingRevision: revision,
    active: true,
  },
})
const signal = () => new AbortController().signal
const connection = (revision = 1) => ({
  deviceId: snapshot().session.deviceId,
  bindingRevision: 1,
  profile: {
    driver: 'aka-00',
    ip: '192.168.1.42',
    port: 80,
    macAddress: '12:34:56:78:90:ab',
    configRevision: revision,
  },
})

it('retains frozen configuration and revokes on a newer endpoint while leaving binding-only leases intact', async () => {
  const raw = connection()
  let current = raw
  const configured = new DeviceBindingLifetimes(
    async (key) => snapshot(key),
    async () => current,
  )
  const ordinary = new DeviceBindingLifetimes(async (key) => snapshot(key))
  const held = await configured.retain('one', signal(), signal())
  const bindingOnly = await ordinary.retain('one', signal(), signal())
  expect(held.connection).toEqual(raw)
  expect(Object.isFrozen(held.connection?.profile)).toBe(true)
  raw.profile.ip = '192.168.1.43'
  expect(held.connection?.profile?.ip).toBe('192.168.1.42')
  configured.connectionChanged(connection())
  expect(held.revoked.aborted).toBe(false)
  expect(() => configured.connectionChanged(raw)).toThrow('Conflicting')
  const newer = {
    ...connection(2),
    profile: { ...connection(2).profile, ip: '192.168.1.44' },
  }
  configured.connectionChanged(newer)
  expect(held.revoked.aborted).toBe(true)
  current = newer
  const fresh = await configured.retain('one', signal(), signal())
  configured.connectionChanged(connection())
  expect(fresh.revoked.aborted).toBe(false)
  ordinary.connectionChanged(connection(2))
  expect(bindingOnly.revoked.aborted).toBe(false)
  configured.close()
  ordinary.close()
})

it.each(['configuration', 'binding', 'session', 'worker', 'cancel'] as const)(
  'rejects a late retained configuration after %s changes',
  async (mode) => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve
    })
    const lifetimes = new DeviceBindingLifetimes(
      async () => snapshot(),
      () => pending,
    )
    const cancel = new AbortController()
    const held = lifetimes.retain('one', cancel.signal, signal())
    const refused = expect(held).rejects.toThrow()
    await Promise.resolve()
    if (mode === 'configuration') lifetimes.connectionChanged(connection(2))
    if (mode === 'binding') lifetimes.changed({ ...snapshot().workspace, revision: 2, active: false })
    if (mode === 'session') lifetimes.closeSession('one')
    if (mode === 'worker') lifetimes.close()
    if (mode === 'cancel') cancel.abort()
    finish(connection())
    await refused
    lifetimes.close()
  },
)

it('revokes an unconfigured snapshot on first save and preserves binding history', async () => {
  const lifetimes = new DeviceBindingLifetimes(
    async () => snapshot(),
    async () => ({ ...connection(), profile: null }),
  )
  const held = await lifetimes.retain('one', signal(), signal())
  expect(held.connection?.profile).toBeNull()
  lifetimes.connectionChanged(connection())
  expect(held.revoked.aborted).toBe(true)
  expect(held.snapshot.session.active).toBe(true)
  lifetimes.close()
})

it.each(['old-reader', 'device', 'binding', 'malformed'] as const)(
  'refuses retained configuration from %s',
  async (mode) => {
    const lifetimes = new DeviceBindingLifetimes(
      async () => snapshot(),
      async () => {
        if (mode === 'old-reader') return snapshot()
        if (mode === 'malformed') return { ...connection(), profile: { ip: 'fake' } }
        return {
          ...connection(),
          ...(mode === 'device'
            ? { deviceId: '22222222-2222-4222-8222-222222222222' }
            : { bindingRevision: 2 }),
        }
      },
    )
    await expect(lifetimes.retain('one', signal(), signal())).rejects.toThrow()
    lifetimes.close()
  },
)

it('retains an immutable binding beyond lookup completion, and release/row removal revoke only its own lifetime', async () => {
  const raw = snapshot()
  const lifetimes = new DeviceBindingLifetimes(async () => raw)
  const row = new AbortController()
  const one = await lifetimes.retain('one', signal(), row.signal)
  const two = await lifetimes.retain('one', signal(), signal())
  raw.session.active = false
  expect(one.snapshot.session.active).toBe(true)
  expect(Object.isFrozen(one.snapshot.session)).toBe(true)
  row.abort()
  expect(one.revoked.aborted).toBe(true)
  expect(two.revoked.aborted).toBe(false)
  two.release()
  two.release()
  expect(two.revoked.aborted).toBe(true)
  lifetimes.close()
})

it('revokes all retained sessions in a detached workspace but leaves another workspace untouched', async () => {
  let revision = 1
  const lifetimes = new DeviceBindingLifetimes(async (key) =>
    snapshot(key, key === 'other' ? 1 : revision, key === 'other' ? 'b' : 'a'),
  )
  const one = await lifetimes.retain('one', signal(), signal())
  const two = await lifetimes.retain('two', signal(), signal())
  const other = await lifetimes.retain('other', signal(), signal())
  lifetimes.changed({ ...snapshot().workspace, revision: 2, active: false })
  expect(one.revoked.aborted).toBe(true)
  expect(two.revoked.aborted).toBe(true)
  expect(other.revoked.aborted).toBe(false)
  revision = 3
  lifetimes.changed(snapshot('one', revision).workspace)
  const rebound = await lifetimes.retain('one', signal(), signal())
  expect(rebound.snapshot.session.bindingRevision).toBe(3)
  expect(rebound.revoked.aborted).toBe(false)
  expect(one.revoked.aborted).toBe(true)
  expect(two.revoked.aborted).toBe(true)
  expect(other.revoked.aborted).toBe(false)
  lifetimes.close()
})

it.each(['detached', 'session-close', 'worker-close'])('rejects a late lookup after %s', async (mode) => {
  let resolve!: (value: ReturnType<typeof snapshot>) => void
  const pending = new Promise<ReturnType<typeof snapshot>>((yes) => {
    resolve = yes
  })
  const lifetimes = new DeviceBindingLifetimes(() => pending)
  const held = lifetimes.retain('one', signal(), signal())
  if (mode === 'detached') lifetimes.changed({ ...snapshot().workspace, revision: 2, active: false })
  else if (mode === 'session-close') lifetimes.closeSession('one')
  else lifetimes.close()
  resolve(snapshot())
  await expect(held).rejects.toThrow()
  lifetimes.close()
})

it('does not let a stale notification revoke a newer lookup, and refuses contradictory same-version data', async () => {
  const lifetimes = new DeviceBindingLifetimes(async () => snapshot('one', 3))
  lifetimes.changed(snapshot('one', 1).workspace)
  const lease = await lifetimes.retain('one', signal(), signal())
  lifetimes.changed({ ...snapshot('one', 2).workspace, active: false })
  expect(lease.revoked.aborted).toBe(false)
  expect(() => lifetimes.changed({ ...snapshot('one', 3).workspace, active: false })).toThrow('Conflicting')
  lifetimes.close()
})

it.each(['ordinary', 'historical', 'forged', 'malformed'])('refuses %s enrollment', async (mode) => {
  const raw = snapshot()
  const lifetimes = new DeviceBindingLifetimes(async () =>
    mode === 'ordinary'
      ? { workspace: raw.workspace, session: null }
      : mode === 'malformed'
        ? {}
        : {
            ...raw,
            session: {
              ...raw.session,
              active: mode !== 'historical',
              sessionId: mode === 'forged' ? 'other' : 'one',
            },
          },
  )
  await expect(lifetimes.retain('one', signal(), signal())).rejects.toThrow()
  lifetimes.close()
})

it('bounds pending lookups as well as retained leases and recovers capacity after a row is retired', async () => {
  const read = vi.fn(async (key: string) => snapshot(key))
  const lifetimes = new DeviceBindingLifetimes(read)
  const row = new AbortController()
  const leases = await Promise.all(
    Array.from({ length: 256 }, (_, i) => lifetimes.retain(`s-${i}`, signal(), row.signal)),
  )
  await expect(lifetimes.retain('over-limit', signal(), row.signal)).rejects.toThrow('unavailable')
  for (const lease of leases) lease.release()
  await expect(lifetimes.retain('new', signal(), row.signal)).resolves.toHaveProperty('revoked')
  lifetimes.close()
})

const recognition = (revision = 1) => ({
  deviceId: snapshot().session.deviceId,
  bindingRevision: 1,
  configRevision: revision,
  settings: {
    provider: 'aliyun' as const,
    frequency: 2 as const,
    requestBudget: 100,
    credentialConfigured: true as const,
  },
})
it('revokes recognition-scoped leases on changes and clear, without cancelling the video connection', async () => {
  let current = recognition()
  const lifetimes = new DeviceBindingLifetimes(
    async () => snapshot(),
    async () => connection(),
    async () => current,
  )
  const video = await lifetimes.retain('one', signal(), signal())
  const detected = await lifetimes.retain('one', signal(), signal(), true)
  expect(Object.isFrozen(detected.recognition?.settings)).toBe(true)
  current.settings.requestBudget = 99
  expect(detected.recognition?.settings?.requestBudget).toBe(100)
  lifetimes.recognitionChanged(recognition())
  expect(detected.revoked.aborted).toBe(false)
  expect(() => lifetimes.recognitionChanged(current)).toThrow('Conflicting')
  current = recognition(2)
  lifetimes.recognitionChanged(current)
  expect(detected.revoked.aborted).toBe(true)
  expect(video.revoked.aborted).toBe(false)
  const fresh = await lifetimes.retain('one', signal(), signal(), true)
  lifetimes.recognitionChanged(recognition())
  expect(fresh.revoked.aborted).toBe(false)
  lifetimes.recognitionChanged({ ...recognition(3), settings: null })
  expect(fresh.revoked.aborted).toBe(true)
  expect(video.revoked.aborted).toBe(false)
  lifetimes.close()
  expect(video.revoked.aborted).toBe(true)
})
it.each(['newer', 'binding', 'session', 'worker', 'cancel', 'device', 'malformed', 'secret'] as const)(
  'rejects pending recognition leases after %s changes',
  async (mode) => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve
    })
    let entered!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const lifetimes = new DeviceBindingLifetimes(
      async () => snapshot(),
      async () => connection(),
      () => {
        entered()
        return pending
      },
    )
    const cancel = new AbortController()
    const lease = lifetimes.retain('one', cancel.signal, signal(), true)
    const refused = expect(lease).rejects.toThrow()
    await reading
    if (mode === 'newer') lifetimes.recognitionChanged(recognition(2))
    if (mode === 'binding') lifetimes.changed({ ...snapshot().workspace, revision: 2, active: false })
    if (mode === 'session') lifetimes.closeSession('one')
    if (mode === 'worker') lifetimes.close()
    if (mode === 'cancel') cancel.abort()
    finish(
      mode === 'device'
        ? { ...recognition(), deviceId: '22222222-2222-4222-8222-222222222222' }
        : mode === 'malformed'
          ? { configRevision: 1 }
          : mode === 'secret'
            ? { ...recognition(), credentialRef: 'secret://private' }
            : recognition(),
    )
    await refused
    lifetimes.close()
  },
)
it('refuses recognition retention with an old reader and accepts reordered equivalent settings', async () => {
  const old = new DeviceBindingLifetimes(async () => snapshot())
  await expect(old.retain('one', signal(), signal(), true)).rejects.toThrow('unavailable')
  const lifetimes = new DeviceBindingLifetimes(
    async () => snapshot(),
    undefined,
    async () => recognition(),
  )
  const held = await lifetimes.retain('one', signal(), signal(), true)
  lifetimes.recognitionChanged({
    ...recognition(),
    settings: { credentialConfigured: true, requestBudget: 100, frequency: 2, provider: 'aliyun' },
  })
  expect(held.revoked.aborted).toBe(false)
  old.close()
  lifetimes.close()
})
