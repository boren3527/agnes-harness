import type { Host } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { handleServiceCommand } from '../src/commands.js'
import type { WorkerCommandFrame } from '../src/frames.js'

const command = (params: Record<string, unknown>): WorkerCommandFrame => ({
  kind: 'command',
  requestId: 'media-read',
  method: 'deviceMedia.endpoint',
  params,
})
describe('private supervisor media endpoint read', () => {
  it('returns only bounded endpoint metadata, keeping the local revocation signal off the wire', async () => {
    const owner = new AbortController()
    const endpoint = {
      port: 4192,
      authorization: `Bearer ${'a'.repeat(43)}`,
      rowRevision: 'fixture-row',
      registrationId: '11111111-1111-4111-8111-111111111111',
      revoked: owner.signal,
    }
    const read = vi.fn(() => endpoint)
    const host = { deviceMediaEndpoint: read } as unknown as Host
    const result = await handleServiceCommand(host, command({ rowId: 'ext:acme/media' }), new Map())
    expect(result).toEqual({
      port: endpoint.port,
      authorization: endpoint.authorization,
      rowRevision: endpoint.rowRevision,
      registrationId: endpoint.registrationId,
    })
    expect(read).toHaveBeenCalledWith('ext:acme/media')
    owner.abort()
    await expect(
      handleServiceCommand(host, command({ rowId: 'ext:acme/media' }), new Map()),
    ).resolves.toBeNull()
  })
  it.each([
    { rowId: '' },
    { rowId: 1 },
    { rowId: 'a'.repeat(257) },
    { rowId: 'ext:acme/media', port: 80 },
    { rowId: 'ext:acme/media', sessionKey: 'forged' },
  ])('refuses invalid private params %j before reading credentials', async (params) => {
    const read = vi.fn()
    await expect(
      handleServiceCommand({ deviceMediaEndpoint: read } as unknown as Host, command(params), new Map()),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(read).not.toHaveBeenCalled()
  })
  it('refuses a resource-only worker or an older Host without this private port', async () => {
    for (const host of [undefined, {} as Host])
      await expect(
        handleServiceCommand(host, command({ rowId: 'ext:acme/media' }), new Map()),
      ).rejects.toThrow()
  })
  it('returns null after the owner removes its endpoint', async () => {
    const host = { deviceMediaEndpoint: () => null } as unknown as Host
    await expect(
      handleServiceCommand(host, command({ rowId: 'ext:acme/media' }), new Map()),
    ).resolves.toBeNull()
  })
})
