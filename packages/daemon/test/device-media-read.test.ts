import type { ResolvedProfile } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { workerDeviceMediaReader } from '../src/supervisor/device-media-read.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

const endpoint = {
  port: 12345,
  authorization: `Bearer ${'a'.repeat(43)}`,
  rowRevision: 'snapshot',
  registrationId: '11111111-1111-4111-8111-111111111111',
}
function setup() {
  const command = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => endpoint)
  const link = { alive: true, command }
  let worker: { generation: number; link: typeof link } | undefined = { generation: 1, link }
  let hash = 'profile'
  const pool = { businessWorker: () => worker } as unknown as Pick<WorkerPool, 'businessWorker'>
  const read = workerDeviceMediaReader(pool, () => ({ hash }) as ResolvedProfile)
  const ac = new AbortController()
  return {
    command,
    link,
    read,
    ac,
    clear: () => {
      worker = undefined
    },
    replace: () => {
      worker = { generation: 2, link: { alive: true, command } }
    },
    generation: () => {
      if (worker) worker = { ...worker, generation: 2 }
    },
    profile: () => {
      hash = 'different'
    },
  }
}
describe('private daemon media endpoint reader', () => {
  it('returns frozen validated metadata stamped with the current worker generation', async () => {
    const v = setup()
    const result = await v.read('ext:robot', v.ac.signal)
    expect(result).toEqual({ ...endpoint, workerGeneration: 1 })
    expect(Object.isFrozen(result)).toBe(true)
    expect(v.command).toHaveBeenCalledWith(
      'deviceMedia.endpoint',
      { rowId: 'ext:robot' },
      { timeoutMs: 3000 },
    )
  })
  it('does not start a missing business worker and preserves a missing row', async () => {
    const v = setup()
    v.clear()
    await expect(v.read('ext:robot', v.ac.signal)).resolves.toBeNull()
    expect(v.command).not.toHaveBeenCalled()
    const w = setup()
    w.command.mockResolvedValue(null)
    await expect(w.read('ext:robot', w.ac.signal)).resolves.toBeNull()
  })
  it.each(['replace', 'generation', 'profile', 'exit', 'cancel'] as const)(
    'rejects a reply crossing %s while the worker read is pending',
    async (kind) => {
      const v = setup()
      v.command.mockImplementation(async () => {
        if (kind === 'exit') v.link.alive = false
        else if (kind === 'cancel') v.ac.abort()
        else v[kind]()
        return endpoint
      })
      await expect(v.read('ext:robot', v.ac.signal)).rejects.toMatchObject({
        data: { code: kind === 'cancel' ? 'REQUEST_TIMEOUT' : 'CAPABILITY_DENIED' },
      })
    },
  )
  it.each([
    {},
    { ...endpoint, port: 0 },
    { ...endpoint, authorization: 'invalid' },
    { ...endpoint, registrationId: 'invalid' },
    { ...endpoint, rowRevision: '' },
    { ...endpoint, host: 'attacker.invalid' },
  ])('rejects malformed endpoint %j', async (value) => {
    const v = setup()
    v.command.mockResolvedValue(value)
    await expect(v.read('ext:robot', v.ac.signal)).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
  })
  it('redacts private worker errors and refuses pre-cancelled reads before dispatch', async () => {
    const v = setup()
    v.command.mockRejectedValue(new Error(endpoint.authorization))
    let observed: unknown
    try {
      await v.read('ext:robot', v.ac.signal)
    } catch (error) {
      observed = error
    }
    expect(observed).toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
    expect(JSON.stringify(observed)).not.toContain(endpoint.authorization)
    v.command.mockClear()
    v.ac.abort()
    await expect(v.read('ext:robot', v.ac.signal)).rejects.toMatchObject({
      data: { code: 'REQUEST_TIMEOUT' },
    })
    expect(v.command).not.toHaveBeenCalled()
  })
})
