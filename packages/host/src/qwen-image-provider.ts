/** Fixed DashScope adapter. No model-supplied endpoint, redirect or credential forwarding to result storage. */
export async function generateQwenImage(input: {
  request: typeof fetch
  endpoint: string
  key: string
  prompt: string
  images: string[]
  size: '1K' | '2K'
  signal: AbortSignal
}): Promise<Uint8Array> {
  const fail = (code: string): never => {
    throw Object.assign(new Error(code), { code })
  }
  const read = async (response: Response, limit: number) => {
    if (!response.body) return fail('IMAGE_RESPONSE_INVALID')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        input.signal.throwIfAborted()
        size += value.length
        if (size > limit) fail('IMAGE_RESPONSE_TOO_LARGE')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks)
  }
  const response = await input.request(input.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: input.signal,
    headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-image-2.1-pro',
      input: {
        messages: [
          { role: 'user', content: [...input.images.map((image) => ({ image })), { text: input.prompt }] },
        ],
      },
      parameters: {
        size: input.size === '2K' ? '2048*2048' : '1024*1024',
        prompt_extend: false,
        watermark: false,
      },
    }),
  })
  const json = JSON.parse((await read(response, 1024 * 1024)).toString('utf8'))
  if (!response.ok || json?.code) {
    const code = typeof json?.code === 'string' ? json.code : ''
    if (code.includes('AllocationQuota') || code.includes('FreeTierOnly')) fail('IMAGE_FREE_QUOTA_EXHAUSTED')
    if (
      ['InvalidApiKey', 'InvalidAccessKeyId', 'InvalidApiKeyScope'].includes(code) ||
      response.status === 401
    )
      fail('IMAGE_CREDENTIAL_INVALID')
    if (response.status === 429) fail('IMAGE_RATE_LIMIT')
    if (code === 'ModelNotFound' || code === 'ModelNotSupported') fail('IMAGE_MODEL_UNAVAILABLE')
    if (response.status === 403) fail('IMAGE_ACCESS_DENIED')
    fail('IMAGE_REQUEST_FAILED')
  }
  const choices = json?.output?.choices
  if (!Array.isArray(choices) || choices.length !== 1) fail('IMAGE_RESPONSE_INVALID')
  const rows = choices[0]?.message?.content
  const images = Array.isArray(rows) ? rows.filter((row) => typeof row?.image === 'string') : []
  if (images.length !== 1) fail('IMAGE_RESPONSE_INVALID')
  const url = new URL(images[0].image)
  // The API's documented image-result buckets. Every redirect is refused and no
  // Bearer token is sent to OSS; arbitrary URLs in upstream error bodies are ignored.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      /^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname) ||
      /^dashscope-[a-z0-9]{4,32}\.oss-accelerate\.aliyuncs\.com$/.test(url.hostname)
    )
  )
    fail('IMAGE_RESULT_URL_REFUSED')
  const image = await input.request(url.href, { method: 'GET', redirect: 'error', signal: input.signal })
  if (!image.ok) {
    await image.body?.cancel()
    fail('IMAGE_RESULT_DOWNLOAD_FAILED')
  }
  return read(image, 16 * 1024 * 1024)
}
