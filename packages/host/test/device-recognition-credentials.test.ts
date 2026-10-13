import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CredentialStore, createCredentialStore } from '../src/adapters/credential-store.js'
import {
  discardDeviceRecognitionCredential,
  readDeviceRecognitionCredential,
  readDeviceRecognitionToken,
  stageDeviceRecognitionCredential,
  stageDeviceRecognitionToken,
} from '../src/device-recognition-credentials.js'

const deviceId = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const pair = { accessKeyId: 'synthetic-access-id', accessKeySecret: 'synthetic-secret-only' }
const signal = () => new AbortController().signal
const roots: string[] = []
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'agh-device-credential-'))
  roots.push(parent)
  const root = join(parent, 'home')
  return { root, store: createCredentialStore({ root }) }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('owner device recognition credentials', () => {
  it('persists one private pair, reopens it, and preserves a published ref when discarding a new stage', async () => {
    const { store, root } = fixture()
    expect(store.enforcement.level).toBe('full')
    const ref = await stageDeviceRecognitionCredential(store, deviceId, pair, signal())
    expect(ref).not.toContain(pair.accessKeyId)
    expect(ref).not.toContain(pair.accessKeySecret)
    const reopened = createCredentialStore({ root })
    expect(await readDeviceRecognitionCredential(reopened, deviceId, ref, signal())).toEqual(pair)
    const replacement = await stageDeviceRecognitionCredential(
      store,
      deviceId,
      { ...pair, accessKeySecret: 'replacement' },
      signal(),
    )
    expect(replacement).not.toBe(ref)
    await discardDeviceRecognitionCredential(store, deviceId, replacement)
    expect(await store.read(replacement)).toBeNull()
    expect(await readDeviceRecognitionCredential(reopened, deviceId, ref, signal())).toEqual(pair)
  })

  it('rejects cross-device and unrelated references before reading or removing anything', async () => {
    const { store } = fixture()
    const ref = await stageDeviceRecognitionCredential(store, deviceId, pair, signal())
    const read = vi.spyOn(store, 'read')
    const remove = vi.spyOn(store, 'remove')
    for (const invalid of [ref, 'secret://openai/default', 'secret://aka-robot/../../key']) {
      await expect(readDeviceRecognitionCredential(store, otherId, invalid, signal())).rejects.toMatchObject({
        code: 'invalid',
      })
      await expect(discardDeviceRecognitionCredential(store, otherId, invalid)).rejects.toMatchObject({
        code: 'invalid',
      })
    }
    expect(read).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { ...pair, endpoint: 'https://example.invalid' },
    { ...pair, accessKeySecret: '' },
    { ...pair, accessKeyId: 'id\n' },
    { ...pair, accessKeySecret: 'x'.repeat(257) },
  ])('rejects invalid input without storing it: case %#', async (value) => {
    const { store } = fixture()
    const write = vi.spyOn(store, 'putApiKey')
    await expect(stageDeviceRecognitionCredential(store, deviceId, value, signal())).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects cancelled and unenforced operations before IO', async () => {
    const { store } = fixture()
    const write = vi.spyOn(store, 'putApiKey')
    await expect(
      stageDeviceRecognitionCredential(store, deviceId, pair, AbortSignal.abort('private reason')),
    ).rejects.toMatchObject({ code: 'cancelled' })
    const unavailable = {
      ...store,
      enforcement: { level: 'unavailable', mechanism: 'windows-acl', reason: 'fixture' },
    } as CredentialStore
    await expect(
      stageDeviceRecognitionCredential(unavailable, deviceId, pair, signal()),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(write).not.toHaveBeenCalled()
  })

  it('removes only a late cancelled write and never publishes its reference', async () => {
    const { store } = fixture()
    const controller = new AbortController()
    const original = store.putApiKey.bind(store)
    let staged = ''
    vi.spyOn(store, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      controller.abort('private reason')
    })
    await expect(
      stageDeviceRecognitionCredential(store, deviceId, pair, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(await store.read(staged)).toBeNull()
  })

  it('cleans a write that fails after persistence and strips original secret-bearing errors', async () => {
    const { store } = fixture()
    const original = store.putApiKey.bind(store)
    let staged = ''
    vi.spyOn(store, 'putApiKey').mockImplementation(async (ref, value) => {
      staged = ref
      await original(ref, value)
      throw new Error(pair.accessKeySecret)
    })
    const failed = stageDeviceRecognitionCredential(store, deviceId, pair, signal())
    await expect(failed).rejects.toMatchObject({
      code: 'storage',
      message: 'Device recognition credential operation failed',
    })
    expect(await store.read(staged)).toBeNull()
    vi.spyOn(store, 'remove').mockRejectedValue(new Error(pair.accessKeySecret))
    const error = await stageDeviceRecognitionCredential(store, deviceId, pair, signal()).catch(
      (value: unknown) => value,
    )
    expect(error).toMatchObject({
      code: 'cleanup',
      message: 'Device recognition credential operation failed',
    })
    expect(error).not.toHaveProperty('cause')
    expect(String(error)).not.toContain(pair.accessKeySecret)
  })

  it('rejects malformed and wrong-device envelopes and discards reads cancelled during IO', async () => {
    const { store } = fixture()
    const ref = await stageDeviceRecognitionCredential(store, deviceId, pair, signal())
    for (const value of [
      'not-json',
      JSON.stringify({ version: 1, deviceId: otherId, ...pair }),
      JSON.stringify({ version: 1, deviceId, ...pair, extra: true }),
    ]) {
      await store.putApiKey(ref, value)
      await expect(readDeviceRecognitionCredential(store, deviceId, ref, signal())).rejects.toMatchObject({
        code: 'invalid',
      })
    }
    const controller = new AbortController()
    const original = store.read.bind(store)
    vi.spyOn(store, 'read').mockImplementation(async (key) => {
      const result = await original(key)
      controller.abort()
      return result
    })
    await expect(
      readDeviceRecognitionCredential(store, deviceId, ref, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('roundtrips maximum escaped local tokens and refuses cross-kind or cross-device reads', async () => {
    const { store, root } = fixture()
    const token = String.fromCharCode(34, 92).repeat(2048)
    const ref = await stageDeviceRecognitionToken(store, deviceId, token, signal())
    const reopened = createCredentialStore({ root })
    expect(await readDeviceRecognitionToken(reopened, deviceId, ref, signal())).toBe(token)
    await expect(readDeviceRecognitionCredential(store, deviceId, ref, signal())).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(readDeviceRecognitionToken(store, otherId, ref, signal())).rejects.toMatchObject({
      code: 'invalid',
    })
    const cloud = await stageDeviceRecognitionCredential(store, deviceId, pair, signal())
    await expect(readDeviceRecognitionToken(store, deviceId, cloud, signal())).rejects.toMatchObject({
      code: 'invalid',
    })
    await discardDeviceRecognitionCredential(store, deviceId, ref)
    expect(await store.read(ref)).toBeNull()
    expect(await readDeviceRecognitionCredential(store, deviceId, cloud, signal())).toEqual(pair)
  })
})
