import { randomUUID } from 'node:crypto'
import {
  parseAliDetections,
  type RecognitionFrame,
  type RecognitionPipeline,
  RecognitionProtocolError,
  RecognitionServiceError,
} from './cloud-recognition.js'

// Node and bundled ESM expose CommonJS SDK exports differently.
function sdk<T>(module: { default: unknown }): T {
  return (typeof module.default === 'function' ? module : module.default) as T
}

const OSS_ENDPOINT = 'oss-cn-shanghai.aliyuncs.com'
const terminal = () =>
  new RecognitionServiceError('terminal', 'Cloud recognition configuration or response is invalid')
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    throw terminal()
  return value
}
function cloudError(error: unknown): RecognitionServiceError {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  // SDK messages can contain signed URLs and credentials. Never retain them as causes or messages.
  return new RecognitionServiceError(
    typeof code === 'string' &&
      /^(InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden|Unauthorized|InvalidParameter|MissingParameter|AccessDenied|ServiceNotOpened|InsufficientBalance)(\.|$)/.test(
        code,
      )
      ? 'terminal'
      : 'transient',
    'Cloud recognition request failed',
  )
}

/** Private adapter: instantiate only after Host admission and credential resolution.
 * Construction does no I/O; upload and the billable operation remain separate.
 * SDK calls do not expose AbortSignal: retain their in-flight slot until they settle.
 */
export async function createAliRecognitionPipeline(
  credentials: Readonly<{ accessKeyId: string; accessKeySecret: string }>,
  admit?: (stage: 'upload-authorize' | 'upload' | 'detect', signal: AbortSignal) => Promise<void>,
): Promise<RecognitionPipeline & { close(): void }> {
  // Load the optional pinned SDKs only when an admitted backend creates a pipeline.
  const modules = await Promise.all([
    import('@alicloud/objectdet20191230'),
    import('@alicloud/openplatform20191219'),
    import('@alicloud/openapi-client'),
    import('@alicloud/tea-util'),
  ])
  const Objectdet = sdk<typeof import('@alicloud/objectdet20191230')>(modules[0])
  const Openplatform = sdk<typeof import('@alicloud/openplatform20191219')>(modules[1])
  const Openapi = sdk<typeof import('@alicloud/openapi-client')>(modules[2])
  const Util = sdk<typeof import('@alicloud/tea-util')>(modules[3])
  const accessKeyId = text(credentials.accessKeyId, 256)
  const accessKeySecret = text(credentials.accessKeySecret, 256)
  const config = (endpoint: string) =>
    new Openapi.Config({
      accessKeyId,
      accessKeySecret,
      type: 'access_key',
      protocol: 'https',
      endpoint,
      regionId: 'cn-shanghai',
    })
  const authorizer = new Openplatform.default(config('openplatform.aliyuncs.com'))
  const detector = new Objectdet.default(config('objectdet.cn-shanghai.aliyuncs.com'))
  const lifetime = new AbortController()
  let busy = false
  let pending:
    | { token: string; url: string; frame: RecognitionFrame; expires: number; signal: AbortSignal }
    | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    pending = undefined
    clearTimeout(expiry)
    expiry = undefined
  }
  const check = (signal: AbortSignal, deadline: number) => {
    if (signal.aborted || lifetime.signal.aborted || performance.now() >= deadline)
      throw new RecognitionServiceError('transient', 'Cloud recognition request ended')
  }
  const checkAge = (frame: RecognitionFrame, maxAge: number) => {
    const age = performance.now() - frame.receivedAt
    if (!Number.isFinite(age) || age < 0 || age > maxAge)
      throw new RecognitionProtocolError('Stale recognition image')
  }
  const runtime = (deadline: number) => {
    const remaining = Math.max(1, Math.floor((deadline - performance.now()) / 2))
    return new Util.RuntimeOptions({
      autoretry: false,
      maxAttempts: 1,
      readTimeout: remaining,
      connectTimeout: remaining,
      ignoreSSL: false,
    })
  }
  return Object.freeze({
    async upload(input: RecognitionFrame, signal: AbortSignal) {
      const deadline = performance.now() + 10000
      check(signal, deadline)
      if (busy) throw new RecognitionServiceError('transient', 'Cloud recognition is busy')
      if (
        !input.bytes.length ||
        input.bytes.length > 2.5 * 1024 * 1024 ||
        !Number.isSafeInteger(input.width) ||
        !Number.isSafeInteger(input.height) ||
        input.width <= 20 ||
        input.height <= 20 ||
        input.width >= 4096 ||
        input.height >= 4096
      )
        throw new RecognitionProtocolError('Invalid cloud recognition image')
      const frame = { ...input, bytes: Buffer.from(input.bytes) }
      clear()
      busy = true
      try {
        if (admit && (await admit('upload-authorize', signal)) !== undefined) throw terminal()
        check(signal, deadline)
        checkAge(frame, 1000)
        const authorized = await authorizer.authorizeFileUploadWithOptions(
          new Openplatform.AuthorizeFileUploadRequest({ product: 'objectdet', regionId: 'cn-shanghai' }),
          runtime(deadline),
        )
        check(signal, deadline)
        const body = authorized.body
        if (authorized.statusCode !== 200 || !body || body.endpoint !== OSS_ENDPOINT) throw terminal()
        const bucket = text(body.bucket, 63)
        if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw terminal()
        const key = text(body.objectKey, 1024)
        if (
          !/^[A-Za-z0-9_./-]+$/.test(key) ||
          key.split('/').some((part) => !part || part === '.' || part === '..')
        )
          throw terminal()
        const form = new FormData()
        form.set('OSSAccessKeyId', text(body.accessKeyId, 256))
        form.set('policy', text(body.encodedPolicy, 65536))
        form.set('Signature', text(body.signature, 4096))
        form.set('key', key)
        form.set('success_action_status', '201')
        form.set('file', new Blob([new Uint8Array(frame.bytes)], { type: 'image/jpeg' }), 'capture.jpg')
        const url = `https://${bucket}.${OSS_ENDPOINT}/${key}`
        if (admit && (await admit('upload', signal)) !== undefined) throw terminal()
        check(signal, deadline)
        checkAge(frame, 5000)
        const response = await fetch(`https://${bucket}.${OSS_ENDPOINT}/`, {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: AbortSignal.any([
            signal,
            lifetime.signal,
            AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
          ]),
        })
        // Do not accumulate OSS success/error XML, which can contain private object names.
        await response.body?.cancel()
        check(signal, deadline)
        if (response.status !== 201)
          throw new RecognitionServiceError(
            response.status === 429 || response.status >= 500 ? 'transient' : 'terminal',
            'Cloud image upload failed',
          )
        const token = randomUUID()
        pending = { token, url, frame, expires: deadline, signal }
        expiry = setTimeout(clear, Math.max(1, Math.ceil(deadline - performance.now())))
        expiry.unref()
        return token
      } catch (error) {
        if (error instanceof RecognitionServiceError || error instanceof RecognitionProtocolError) throw error
        throw cloudError(error)
      } finally {
        busy = false
      }
    },
    async detect(token: string, signal: AbortSignal) {
      const current = pending
      if (!current || token !== current.token || signal !== current.signal) throw terminal()
      check(signal, current.expires)
      if (busy) throw new RecognitionServiceError('transient', 'Cloud recognition is busy')
      clear() // One use, even if the SDK throws or the reply is lost. No automatic paid retries.
      busy = true
      try {
        if (admit && (await admit('detect', signal)) !== undefined) throw terminal()
        check(signal, current.expires)
        checkAge(current.frame, 5000)
        const response = await detector.detectObjectWithOptions(
          new Objectdet.DetectObjectRequest({ imageURL: current.url }),
          runtime(current.expires),
        )
        check(signal, current.expires)
        if (response.statusCode !== 200 || !response.body?.data) throw terminal()
        const data = response.body.data
        if (!Array.isArray(data.elements) || data.elements.length > 1000) throw terminal()
        const output = {
          RequestId: text(response.body.requestId, 256),
          Data: {
            Width: data.width,
            Height: data.height,
            Elements: data.elements?.map((item) => ({
              Type: item.type,
              Score: item.score,
              Boxes: item.boxes,
            })),
          },
        }
        parseAliDetections(output, current.frame.width, current.frame.height)
        return output
      } catch (error) {
        if (error instanceof RecognitionServiceError || error instanceof RecognitionProtocolError) throw error
        throw cloudError(error)
      } finally {
        busy = false
      }
    },
    close() {
      lifetime.abort()
      clear()
    },
  })
}
