import type { ClientModuleMediaResolveResult } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeviceMediaResolver } from './device-media.js'

const endpoint = {
  found: true as const,
  port: 12345,
  authorization: `Bearer ${'a'.repeat(43)}`,
  rowRevision: 'snapshot',
  registrationId: '11111111-1111-4111-8111-111111111111',
  workerGeneration: 1,
  deviceId: 'robot',
  bindingRevision: 1,
  configRevision: 1,
  rosterRevision: 'roster',
}
const request = { rowId: 'web:robot', sessionId: 'session', ticket: 'one-use-test-ticket' }
afterEach(() => vi.useRealTimers())

describe('launcher private media leases', () => {
  it('keeps secrets private, renews serially and closes all leases on shutdown', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => endpoint)
    const resolver = createDeviceMediaResolver(read)
    const first = await resolver.resolve(request, new AbortController().signal)
    const second = await resolver.resolve(request, new AbortController().signal)
    expect(first).toMatchObject({ port: endpoint.port, authorization: endpoint.authorization })
    expect(Object.keys(first ?? {}).sort()).toEqual(['authorization', 'port', 'revoked'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(first?.revoked.aborted).toBe(false)
    resolver.close()
    expect(first?.revoked.aborted).toBe(true)
    expect(second?.revoked.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await expect(resolver.resolve(request, new AbortController().signal)).resolves.toBeNull()
  })

  it.each([
    { port: 12346 },
    { authorization: `Bearer ${'b'.repeat(43)}` },
    { rowRevision: 'new' },
    { registrationId: '22222222-2222-4222-8222-222222222222' },
    { workerGeneration: 2 },
    { deviceId: 'other' },
    { bindingRevision: 2 },
    { configRevision: 2 },
    { rosterRevision: 'new' },
  ])('revokes a lease when its continuity changes: %j', async (change) => {
    vi.useFakeTimers()
    const read = vi.fn(async () => endpoint).mockResolvedValueOnce(endpoint)
    read.mockResolvedValue({ ...endpoint, ...change })
    const resolver = createDeviceMediaResolver(read)
    const lease = await resolver.resolve(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(lease?.revoked.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    resolver.close()
  })

  it.each(['cancel', 'shutdown', 'missing', 'failure'] as const)(
    'refuses a pending initial lookup after %s',
    async (reason) => {
      let complete!: (value: ClientModuleMediaResolveResult) => void
      let fail!: (error: Error) => void
      const read = vi.fn(
        () =>
          new Promise<ClientModuleMediaResolveResult>((resolve, reject) => {
            complete = resolve
            fail = reject
          }),
      )
      const resolver = createDeviceMediaResolver(read)
      const ac = new AbortController()
      const pending = resolver.resolve(request, ac.signal)
      if (reason === 'cancel') ac.abort()
      if (reason === 'shutdown') resolver.close()
      if (reason === 'failure') fail(new Error('private error'))
      else complete(reason === 'missing' ? { found: false } : endpoint)
      await expect(pending).resolves.toBeNull()
      resolver.close()
    },
  )

  it('does not overlap pending revalidation and releases the viewer cap on cancellation', async () => {
    vi.useFakeTimers()
    let complete!: (value: ClientModuleMediaResolveResult) => void
    const read = vi.fn<() => Promise<ClientModuleMediaResolveResult>>(async () => endpoint)
    const resolver = createDeviceMediaResolver(read)
    const controllers = Array.from({ length: 32 }, () => new AbortController())
    const leases = await Promise.all(controllers.map((ac) => resolver.resolve(request, ac.signal)))
    expect(leases.every(Boolean)).toBe(true)
    await expect(resolver.resolve(request, new AbortController().signal)).resolves.toBeNull()
    for (const controller of controllers) controller.abort()
    const ac = new AbortController()
    const lease = await resolver.resolve(request, ac.signal)
    read.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(read.mock.calls.length).toBe(calls + 1)
    ac.abort()
    complete(endpoint)
    await Promise.resolve()
    expect(lease?.revoked.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    resolver.close()
  })
})
