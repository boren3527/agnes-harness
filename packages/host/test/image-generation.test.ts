import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { createImageGenerationService } from '../src/image-generation.js'
import { transparentSubject } from '../src/image-subject.js'

const white = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAFklEQVR4nGP4DwMM////3yciAmVBxAB06RjPjubZYQAAAABJRU5ErkJggg==',
  'base64',
)
const alpha = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAGElEQVR4nGP4//8/AwyDiX0iIv/hHJgMAAL1Gc497znIAAAAAElFTkSuQmCC',
  'base64',
)
const KEY = ['fixture', 'only', 'key'].join('-')
const ROTATED_KEY = ['rotated', 'fixture', 'key'].join('-')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture(
  request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ data: [{ b64_json: white.toString('base64') }] })),
  ),
) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-image-'))
  roots.push(root)
  const home = join(root, 'home')
  createPrivateDirectorySync(home)
  return { home, request, service: createImageGenerationService({ home, profile: 'test', request }) }
}
it('keeps existing alpha and removes only border-connected pure white pixels', () => {
  expect(transparentSubject(alpha).background).toBe('model-alpha')
  const result = transparentSubject(white)
  expect(result).toMatchObject({ background: 'white-border', width: 3, height: 3 })
  const png = Buffer.from(result.bytes),
    chunks: Buffer[] = []
  for (let pos = 8; pos < png.length; ) {
    const len = png.readUInt32BE(pos)
    if (png.toString('ascii', pos + 4, pos + 8) === 'IDAT') chunks.push(png.subarray(pos + 8, pos + 8 + len))
    pos += len + 12
  }
  const raw = inflateSync(Buffer.concat(chunks))
  expect([...raw.subarray(18, 22)]).toEqual([190, 20, 20, 255])
  expect(raw[4]).toBe(0)
  expect(() => transparentSubject(Buffer.from('not png'))).toThrow()
  // A transparent hole surrounded by an opaque background is not a background-free subject.
  const hole = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAFUlEQVR4nGOQ0zD6D8MMUAYDMgeMAeNDDDH3RjNaAAAAAElFTkSuQmCC',
    'base64',
  )
  expect(() => transparentSubject(hole)).toThrow('IMAGE_BACKGROUND_UNVERIFIED')
})
it('saves a private credential, redacts reads and reloads settings in a separate instance', async () => {
  const f = await fixture()
  expect(await f.service.get()).toMatchObject({ revision: 0, enabled: false, credentialConfigured: false })
  const saved = await f.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  expect(saved).toMatchObject({ revision: 1, enabled: true, credentialConfigured: true })
  const file = await readFile(join(f.home, 'profiles', 'test', 'image-generation.json'), 'utf8')
  expect(file).not.toContain(KEY)
  expect(JSON.stringify(saved)).not.toContain(KEY)
  const other = createImageGenerationService({ home: f.home, profile: 'test', request: f.request })
  expect(await other.get()).toEqual(saved)
  expect(
    await other.save({ expectedRevision: 1, model: 'agnes-image-2.5-flash', enabled: false, size: '2K' }),
  ).toMatchObject({
    revision: 2,
    enabled: false,
    credentialConfigured: true,
  })
  await expect(
    f.service.save({ expectedRevision: 1, model: 'agnes-image-2.5-flash', enabled: true, size: '1K' }),
  ).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  expect(f.request).not.toHaveBeenCalled()
  await other.save({
    expectedRevision: 2,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: ROTATED_KEY,
  })
  await f.service.subject({ images: [{ bytes: white, mime: 'image/png' }] }, new AbortController().signal)
  expect(f.request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer rotated-fixture-key' })
  expect(JSON.stringify(await other.get())).not.toContain(ROTATED_KEY)
})
it.each([undefined, [0.1, 0.2, 0.4, 0.8]])(
  'uses the documented multi-image request and selected subject %j',
  async (subjectBox) => {
    const f = await fixture()
    await f.service.save({
      expectedRevision: 0,
      model: 'agnes-image-2.5-flash',
      enabled: true,
      size: '1K',
      apiKey: KEY,
    })
    const result = await f.service.subject(
      {
        ...(subjectBox ? { subjectBox } : {}),
        images: [
          { bytes: white, mime: 'image/png' },
          { bytes: alpha, mime: 'image/png' },
        ],
      },
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      mime: 'image/png',
      model: 'agnes-image-2.5-flash',
      background: 'white-border',
    })
    expect(transparentSubject(result.bytes).background).toBe('model-alpha')
    const [url, init] = f.request.mock.calls[0]!
    expect(url).toBe('https://api.agnes-ai.cn/v1/images/generations')
    expect(init?.redirect).toBe('error')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'agnes-image-2.5-flash',
      size: '1K',
      ratio: '1:1',
      extra_body: { response_format: 'b64_json' },
    })
    expect(body.extra_body.image).toEqual([
      `data:image/png;base64,${white.toString('base64')}`,
      `data:image/png;base64,${alpha.toString('base64')}`,
    ])
    expect(body.response_format).toBeUndefined()
    expect(body.prompt).toContain('Reduce compression noise and mild motion blur')
    expect(body.prompt).toContain('Denoise camera grain and JPEG compression artifacts')
    expect(body.prompt).toContain('Improve clarity')
    expect(body.prompt).toContain('without halos or oversmoothing')
    expect(body.prompt).toContain('do not invent textures')
    expect(body.prompt).toContain('preserve markings on the subject')
    if (subjectBox) {
      expect(body.prompt).toContain(JSON.stringify(subjectBox))
      expect(body.prompt).toContain('even if another object is larger or more central')
    } else expect(body.prompt).not.toContain('normalized bounding box')
    expect(JSON.stringify(result)).not.toContain(KEY)
  },
)
it('refuses disabled generation, invalid inputs and cancellations before any network request', async () => {
  const f = await fixture(),
    controller = new AbortController()
  await expect(f.service.subject({ images: [] }, controller.signal)).rejects.toMatchObject({
    code: 'IMAGE_NOT_CONFIGURED',
  })
  await f.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  await expect(f.service.subject({ images: [] }, controller.signal)).rejects.toMatchObject({
    code: 'IMAGE_INVALID_INPUT',
  })
  for (const subjectBox of [
    [],
    [0, 0, 1],
    [0.8, 0, 0.2, 1],
    [0, 1, 1, 0],
    [0, 0, Infinity, 1],
    [0, 0, 2, 1],
    ['0', 0, 1, 1],
  ]) {
    await expect(
      f.service.subject(
        { images: [{ bytes: white, mime: 'image/png' }], subjectBox: subjectBox as number[] },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_INVALID_INPUT' })
  }
  controller.abort()
  await expect(
    f.service.subject({ images: [{ bytes: white, mime: 'image/png' }] }, controller.signal),
  ).rejects.toThrow()
  expect(f.request).not.toHaveBeenCalled()
})
it.each([
  new Response(KEY, { status: 403 }),
  new Response(JSON.stringify({ data: [{ url: 'https://untrusted.invalid/img.png' }] })),
])('never forwards upstream bodies or fetches unexpected output URLs', async (response) => {
  const f = await fixture(vi.fn<typeof fetch>(async () => response))
  await f.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  await expect(
    f.service.subject({ images: [{ bytes: white, mime: 'image/png' }] }, new AbortController().signal),
  ).rejects.toThrow(/^IMAGE_/)
  expect(f.request).toHaveBeenCalledTimes(1)
})
it('rejects tampered saved metadata rather than changing the target endpoint', async () => {
  const f = await fixture()
  await f.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  await writeFile(
    join(f.home, 'profiles', 'test', 'image-generation.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      enabled: true,
      size: '8K',
      credentialRef: 'secret://other/key',
    }),
  )
  await expect(f.service.get()).rejects.toMatchObject({ code: 'CONFIG_INVALID_STATE' })
  expect(f.request).not.toHaveBeenCalled()
})
it('bounds output bodies and propagates cancellation without retrying generation', async () => {
  const oversized = await fixture(
    vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(24 * 1024 * 1024 + 1))
              controller.close()
            },
          }),
        ),
    ),
  )
  await oversized.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  await expect(
    oversized.service.subject(
      { images: [{ bytes: white, mime: 'image/png' }] },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_RESPONSE_TOO_LARGE' })
  expect(oversized.request).toHaveBeenCalledTimes(1)
  const controller = new AbortController()
  const cancelled = await fixture(
    vi.fn<typeof fetch>(async (_url, options) => {
      controller.abort(new Error('fixture cancelled'))
      options?.signal?.throwIfAborted()
      return new Response('{}')
    }),
  )
  await cancelled.service.save({
    expectedRevision: 0,
    model: 'agnes-image-2.5-flash',
    enabled: true,
    size: '1K',
    apiKey: KEY,
  })
  await expect(
    cancelled.service.subject({ images: [{ bytes: white, mime: 'image/png' }] }, controller.signal),
  ).rejects.toThrow('fixture cancelled')
  expect(cancelled.request).toHaveBeenCalledTimes(1)
})

it.each([
  'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/cup.png',
  'https://dashscope-a717.oss-accelerate.aliyuncs.com/cup.png',
])('uses Qwen image editing and downloads only its result storage: %s', async (url) => {
  const request = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: url }] } }] } }))
      : new Response(alpha),
  )
  const f = await fixture(request)
  await f.service.save({
    expectedRevision: 0,
    enabled: true,
    size: '1K',
    model: 'qwen-image-2.1-pro',
    apiKey: KEY,
  })
  const result = await f.service.subject(
    {
      images: [{ bytes: white, mime: 'image/png' }],
      view: 'back',
      description: 'A black ceramic cup with a handle',
    },
    new AbortController().signal,
  )
  expect(result.model).toBe('qwen-image-2.1-pro')
  const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
  expect(body.model).toBe('qwen-image-2.1-pro')
  expect(body.parameters).toMatchObject({ size: '1024*1024', prompt_extend: false, watermark: false })
  expect(body.input.messages[0].content[0].image).toMatch(/^data:image/)
  expect(body.input.messages[0].content[1].text).toContain('BACK (180 degrees')
  expect(request.mock.calls[1]?.[1]?.headers).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain(KEY)
})
it.each([
  'https://127.0.0.1/private',
  'https://dashscope-a717.oss-accelerate.aliyuncs.com.evil.test/cup.png',
  'http://dashscope-a717.oss-accelerate.aliyuncs.com/cup.png',
])('refuses untrusted Qwen result %s', async (url) => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: url }] } }] } })),
  )
  const f = await fixture(request)
  await f.service.save({
    expectedRevision: 0,
    enabled: true,
    size: '1K',
    model: 'qwen-image-2.1-pro',
    apiKey: KEY,
  })
  await expect(
    f.service.subject({ images: [{ bytes: white, mime: 'image/png' }] }, new AbortController().signal),
  ).rejects.toThrow('IMAGE_RESULT_URL_REFUSED')
  expect(request).toHaveBeenCalledTimes(1)
})
