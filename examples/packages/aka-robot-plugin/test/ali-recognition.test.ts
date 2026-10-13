import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAliRecognitionPipeline } from '../src/ali-recognition.js'
import { type RecognitionFrame, RecognitionScheduler } from '../src/recognition.js'

const require = createRequire(import.meta.url)
const Objectdet = require('@alicloud/objectdet20191230') as typeof import('@alicloud/objectdet20191230')
const Openplatform =
  require('@alicloud/openplatform20191219') as typeof import('@alicloud/openplatform20191219')
const credentials = { accessKeyId: 'test-access-id', accessKeySecret: 'test-secret-only' }
const image = (): RecognitionFrame => ({
  id: 'frame',
  receivedAt: performance.now(),
  width: 320,
  height: 240,
  bytes: Buffer.from([1, 2, 3]),
})
const authorized = () =>
  new Openplatform.AuthorizeFileUploadResponse({
    statusCode: 200,
    body: new Openplatform.AuthorizeFileUploadResponseBody({
      bucket: 'viapi-test-bucket',
      endpoint: 'oss-cn-shanghai.aliyuncs.com',
      objectKey: 'uploads/image.jpg',
      accessKeyId: 'temporary-test-id',
      encodedPolicy: 'synthetic-policy',
      signature: 'synthetic-signature',
    }),
  })
const detected = () =>
  new Objectdet.DetectObjectResponse({
    statusCode: 200,
    body: new Objectdet.DetectObjectResponseBody({
      requestId: 'test-request-id',
      data: new Objectdet.DetectObjectResponseBodyData({
        width: 320,
        height: 240,
        elements: [
          new Objectdet.DetectObjectResponseBodyDataElements({
            type: 'tennis ball',
            score: 0.8,
            boxes: [1, 2, 30, 40],
          }),
        ],
      }),
    }),
  })
const close: Array<() => void> = []
afterEach(() => {
  for (const dispose of close.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function setup() {
  const authorize = vi
    .spyOn(Openplatform.default.prototype, 'authorizeFileUploadWithOptions')
    .mockImplementation(async () => authorized())
  const detect = vi
    .spyOn(Objectdet.default.prototype, 'detectObjectWithOptions')
    .mockImplementation(async () => detected())
  const cancel = vi.fn(async () => {})
  const fetch = vi.fn(async () => ({ status: 201, body: { cancel } }))
  vi.stubGlobal('fetch', fetch)
  const pipeline = await createAliRecognitionPipeline(credentials)
  close.push(() => pipeline.close())
  return { pipeline, authorize, detect, fetch, cancel, ac: new AbortController() }
}

describe('official Aliyun staged recognition adapter', () => {
  it('rechecks frame age at actual SDK dispatch after awaited admission', async () => {
    const v = await setup()
    const frame = image()
    const pipeline = await createAliRecognitionPipeline(credentials, async (stage) => {
      if (stage === 'detect') vi.spyOn(performance, 'now').mockReturnValue(frame.receivedAt + 5001)
    })
    close.push(() => pipeline.close())
    const token = await pipeline.upload(frame, v.ac.signal)
    await expect(pipeline.detect(token, v.ac.signal)).rejects.toThrow('Stale recognition image')
    expect(v.detect).not.toHaveBeenCalled()
  })
  it.each(['upload-authorize', 'upload', 'detect'] as const)(
    'waits for fresh backend admission before %s using actual SDK models',
    async (stage) => {
      const v = await setup()
      const admit = vi.fn(async (value: string) => {
        if (value === stage) throw new Error('private admission detail')
      })
      const pipeline = await createAliRecognitionPipeline(credentials, admit)
      close.push(() => pipeline.close())
      const run = async () => {
        const token = await pipeline.upload(image(), v.ac.signal)
        return pipeline.detect(token, v.ac.signal)
      }
      await expect(run()).rejects.toBeInstanceOf(Error)
      expect(
        stage === 'upload-authorize' ? v.authorize : stage === 'upload' ? v.fetch : v.detect,
      ).not.toHaveBeenCalled()
    },
  )
  it('constructs actual compatible SDKs without I/O, uploads privately and detects only once', async () => {
    const v = await setup()
    expect(v.authorize).not.toHaveBeenCalled()
    expect(v.fetch).not.toHaveBeenCalled()
    const token = await v.pipeline.upload(image(), v.ac.signal)
    expect(token).not.toContain('aliyuncs.com')
    expect(v.authorize.mock.calls[0]?.[0]).toMatchObject({ product: 'objectdet', regionId: 'cn-shanghai' })
    expect(v.authorize.mock.calls[0]?.[1]).toMatchObject({
      autoretry: false,
      maxAttempts: 1,
      ignoreSSL: false,
    })
    const [url, options] = v.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://viapi-test-bucket.oss-cn-shanghai.aliyuncs.com/')
    expect(options.redirect).toBe('error')
    expect(options.body).toBeInstanceOf(FormData)
    expect((options.body as FormData).get('key')).toBe('uploads/image.jpg')
    expect(v.cancel).toHaveBeenCalled()
    expect(v.detect).not.toHaveBeenCalled()
    await expect(v.pipeline.detect(token, v.ac.signal)).resolves.toEqual({
      RequestId: 'test-request-id',
      Data: {
        Width: 320,
        Height: 240,
        Elements: [{ Type: 'tennis ball', Score: 0.8, Boxes: [1, 2, 30, 40] }],
      },
    })
    expect(v.detect.mock.calls[0]?.[0]).toMatchObject({
      imageURL: 'https://viapi-test-bucket.oss-cn-shanghai.aliyuncs.com/uploads/image.jpg',
    })
    await expect(v.pipeline.detect(token, v.ac.signal)).rejects.toMatchObject({ kind: 'terminal' })
    expect(v.detect).toHaveBeenCalledTimes(1)
    const scheduler = new RecognitionScheduler(v.pipeline, async () => true)
    scheduler.setReady(true)
    scheduler.setDemand(true)
    scheduler.setEnabled(true)
    const attempt = await scheduler.poll(image())
    expect(attempt).toMatchObject({ state: 'result', result: { providerRequestId: 'test-request-id' } })
    if (attempt.state !== 'result') throw new Error('Missing result')
    expect(attempt.result.submittedAt).toBeLessThanOrEqual(attempt.result.completedAt)
  })
  it.each([
    { endpoint: 'attacker.invalid' },
    { bucket: 'host.invalid' },
    { objectKey: '../private' },
    { objectKey: 'uploads/image.jpg?private=1' },
  ])('rejects an unsafe upload destination before any upload: %j', async (change) => {
    const v = await setup()
    const response = authorized()
    Object.assign(response.body, change)
    v.authorize.mockResolvedValueOnce(response)
    await expect(v.pipeline.upload(image(), v.ac.signal)).rejects.toMatchObject({ kind: 'terminal' })
    expect(v.fetch).not.toHaveBeenCalled()
    expect(v.detect).not.toHaveBeenCalled()
  })
  it('does not upload after cancellation during SDK authorization, even if the SDK settles late', async () => {
    const v = await setup()
    let complete!: (value: ReturnType<typeof authorized>) => void
    v.authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const pending = v.pipeline.upload(image(), v.ac.signal)
    v.ac.abort()
    complete(authorized())
    await expect(pending).rejects.toMatchObject({ kind: 'transient' })
    expect(v.fetch).not.toHaveBeenCalled()
  })
  it('cannot detect with another request signal or after adapter shutdown', async () => {
    const v = await setup()
    const token = await v.pipeline.upload(image(), v.ac.signal)
    await expect(v.pipeline.detect(token, new AbortController().signal)).rejects.toMatchObject({
      kind: 'terminal',
    })
    v.pipeline.close()
    await expect(v.pipeline.detect(token, v.ac.signal)).rejects.toMatchObject({ kind: 'terminal' })
    expect(v.detect).not.toHaveBeenCalled()
  })
  it('discards a late SDK detection while retaining its busy slot until settlement', async () => {
    const v = await setup()
    const token = await v.pipeline.upload(image(), v.ac.signal)
    let complete!: (value: ReturnType<typeof detected>) => void
    v.detect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const pending = v.pipeline.detect(token, v.ac.signal)
    v.ac.abort()
    await expect(v.pipeline.upload(image(), new AbortController().signal)).rejects.toMatchObject({
      kind: 'transient',
    })
    complete(detected())
    await expect(pending).rejects.toMatchObject({ kind: 'transient' })
  })
  it('redacts SDK credentials and signed URLs from all returned errors', async () => {
    const v = await setup()
    v.authorize.mockRejectedValueOnce({
      code: 'InvalidAccessKeyId.NotFound',
      message: credentials.accessKeySecret,
      stack: 'https://private.invalid/signature',
    })
    let error: unknown
    try {
      await v.pipeline.upload(image(), v.ac.signal)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ kind: 'terminal' })
    expect(String(error)).not.toContain(credentials.accessKeySecret)
    expect(JSON.stringify(error)).not.toContain('private.invalid')
  })
  it('refuses an already cancelled request before SDK dispatch', async () => {
    const v = await setup()
    v.ac.abort()
    await expect(v.pipeline.upload(image(), v.ac.signal)).rejects.toMatchObject({ kind: 'transient' })
    expect(v.authorize).not.toHaveBeenCalled()
    expect(v.fetch).not.toHaveBeenCalled()
  })
  it('rejects mismatched cloud dimensions and does not retry a failed paid stage', async () => {
    const v = await setup()
    const token = await v.pipeline.upload(image(), v.ac.signal)
    const response = detected()
    if (!response.body.data) throw new Error('Missing fixture data')
    response.body.data.width = 640
    v.detect.mockResolvedValueOnce(response)
    await expect(v.pipeline.detect(token, v.ac.signal)).rejects.toThrow('Detection image does not match')
    await expect(v.pipeline.detect(token, v.ac.signal)).rejects.toMatchObject({ kind: 'terminal' })
    expect(v.detect).toHaveBeenCalledTimes(1)
  })
  it('works with the actual scheduler while closing during upload prevents the paid stage', async () => {
    const v = await setup()
    const scheduler = new RecognitionScheduler(v.pipeline, async () => true)
    scheduler.setReady(true)
    scheduler.setDemand(true)
    scheduler.setEnabled(true)
    v.fetch.mockImplementationOnce(async () => {
      scheduler.setEnabled(false)
      return { status: 201, body: { cancel: v.cancel } }
    })
    await expect(scheduler.poll(image())).resolves.toEqual({ state: 'discarded' })
    expect(v.detect).not.toHaveBeenCalled()
    expect(scheduler.status.sent).toBe(0)
  })
})
