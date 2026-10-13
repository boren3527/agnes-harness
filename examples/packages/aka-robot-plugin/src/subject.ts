import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ToolContext } from '@agnes/extension-api'

export async function prepareSubject(
  ctx: ToolContext,
  exported: { directory: string; manifest: string; photoCount: number },
  photoIndex: number,
  output: string,
  force = false,
) {
  if (!ctx.imageGeneration)
    throw new Error(
      'AGH image generation unavailable; update AGH and configure Settings → Image generation model',
    )
  if (!Number.isInteger(photoIndex) || photoIndex < 1 || photoIndex > 4)
    throw new Error('Photo index must be 1–4')
  const manifestInfo = await ctx.fs.stat(exported.manifest)
  if (manifestInfo.kind !== 'file' || manifestInfo.size > 128 * 1024)
    throw new Error('Invalid photo manifest')
  const manifest = JSON.parse(new TextDecoder().decode(await ctx.fs.read(exported.manifest)))
  if (
    !(
      (manifest.kind === 'orbit-four-view' && exported.photoCount === 4) ||
      (manifest.kind === 'object-observation' && exported.photoCount === 1)
    ) ||
    !Array.isArray(manifest.photos) ||
    manifest.photos.length !== exported.photoCount
  )
    throw new Error('Complete a four-view orbit or a model subject checkpoint first')
  const selectedSubject = manifest.kind === 'object-observation' ? manifest.subject : undefined
  if (
    selectedSubject !== undefined &&
    (typeof selectedSubject?.description !== 'string' ||
      !selectedSubject.description.trim() ||
      selectedSubject.description.length > 1000 ||
      !Array.isArray(selectedSubject.box) ||
      selectedSubject.box.length !== 4 ||
      !selectedSubject.box.every(
        (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
      ) ||
      selectedSubject.box[2] <= selectedSubject.box[0] ||
      selectedSubject.box[3] <= selectedSubject.box[1])
  )
    throw new Error('Invalid selected model subject')
  const subjectBox = selectedSubject?.box as number[] | undefined
  const images: { bytes: Uint8Array; mime: 'image/jpeg' }[] = []
  const references: { path: string; sha256: string }[] = []
  for (let i = 0; i < exported.photoCount; i++) {
    const photo = manifest.photos[i]
    if (
      photo?.name !== `observation-${i + 1}.jpg` ||
      !/^[a-f0-9]{64}$/.test(photo?.ref?.sha256) ||
      !Number.isSafeInteger(photo?.ref?.size) ||
      photo.ref.size < 1 ||
      photo.ref.size > 8 * 1024 * 1024
    )
      throw new Error('Invalid reference image')
    const path = join(exported.directory, photo.name)
    const info = await ctx.fs.stat(path)
    if (info.kind !== 'file' || info.size !== photo.ref.size) throw new Error('Reference image changed')
    const bytes = await ctx.fs.read(path)
    if (
      bytes.length !== photo.ref.size ||
      createHash('sha256').update(bytes).digest('hex') !== photo.ref.sha256
    )
      throw new Error('Reference image changed')
    images.push({ bytes, mime: 'image/jpeg' })
    references.push({ path, sha256: photo.ref.sha256 })
  }
  const primary = images.splice(photoIndex - 1, 1)[0]
  if (!primary) throw new Error('Primary image unavailable')
  const configuration = await ctx.imageGeneration.configuration?.()
  if (configuration && !configuration.enabled) throw new Error('IMAGE_NOT_CONFIGURED')
  const checkConfiguration = async () => {
    if (
      JSON.stringify((await ctx.imageGeneration?.configuration?.()) ?? null) !==
      JSON.stringify(configuration ?? null)
    )
      throw new Error('Image configuration changed during subject preparation')
  }
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        version: 5,
        photoIndex,
        references,
        subjectBox,
        description: selectedSubject?.description,
        configuration,
      }),
    )
    .digest('hex')
  const cache = join(exported.directory, `subject-${key}.png`),
    metadata = `${cache}.json`
  let cached:
    | {
        bytes: Uint8Array
        sha256: string
        model: string
        background: 'model-alpha' | 'white-border'
        width: number
        height: number
      }
    | undefined
  if (!force) {
    try {
      const info = await ctx.fs.stat(metadata)
      if (info.kind !== 'file' || info.size > 4096) throw new Error('Invalid subject cache')
      const saved = JSON.parse(new TextDecoder().decode(await ctx.fs.read(metadata)))
      const imageInfo = await ctx.fs.stat(cache)
      if (
        saved.key !== key ||
        !['agnes-image-2.5-flash', 'qwen-image-2.1-pro'].includes(saved.model) ||
        !['model-alpha', 'white-border'].includes(saved.background) ||
        !Number.isSafeInteger(saved.width) ||
        saved.width < 1 ||
        saved.width > 2048 ||
        !Number.isSafeInteger(saved.height) ||
        saved.height < 1 ||
        saved.height > 2048 ||
        imageInfo.kind !== 'file' ||
        imageInfo.size < 8 ||
        imageInfo.size > 16 * 1024 * 1024
      )
        throw new Error('Invalid subject cache')
      const bytes = await ctx.fs.read(cache)
      if (createHash('sha256').update(bytes).digest('hex') !== saved.sha256)
        throw new Error('Subject cache changed')
      cached = {
        bytes,
        sha256: saved.sha256 as string,
        model: saved.model as string,
        background: saved.background as 'model-alpha' | 'white-border',
        width: saved.width as number,
        height: saved.height as number,
      }
    } catch {
      ctx.signal.throwIfAborted() /* Missing or changed cache is regenerated. */
    }
  }
  if (cached) {
    await checkConfiguration()
    ctx.signal.throwIfAborted()
    await ctx.fs.write(output, cached.bytes)
    const artifact = await ctx.artifacts.put(cached.bytes, { mime: 'image/png' })
    const { bytes: _bytes, ...info } = cached
    return {
      ...info,
      path: output,
      artifact,
      references,
      ...(selectedSubject ? { selectedSubject } : {}),
      reused: true,
    }
  }
  ctx.signal.throwIfAborted()
  const requestMarker = `${cache}.request.json`
  if (!force) {
    try {
      await ctx.fs.stat(requestMarker)
      throw new Error(
        'An earlier image request has no verified cache. Do not repeat it automatically; inspect its failure. Regenerate with force=true only when the user explicitly requests it.',
      )
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }
  // Admission is durable before a paid request, including worker restarts.
  await ctx.fs.write(requestMarker, JSON.stringify({ key, state: 'dispatched' }))
  await checkConfiguration()
  const generated = await ctx.imageGeneration.subject({
    images: [primary, ...images],
    ...(subjectBox ? { subjectBox } : {}),
    ...(selectedSubject ? { description: selectedSubject.description as string } : {}),
  })
  await checkConfiguration()
  ctx.signal.throwIfAborted()
  if (
    generated.mime !== 'image/png' ||
    !['model-alpha', 'white-border'].includes(generated.background) ||
    generated.bytes.length < 8 ||
    generated.bytes.length > 16 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => generated.bytes[i] === v)
  )
    throw new Error('Invalid subject generation result')
  const digest = createHash('sha256').update(generated.bytes).digest('hex')
  await ctx.fs.write(cache, generated.bytes)
  await ctx.fs.write(
    metadata,
    JSON.stringify({
      key,
      sha256: digest,
      model: generated.model,
      background: generated.background,
      width: generated.width,
      height: generated.height,
    }),
  )
  await ctx.fs.write(output, generated.bytes)
  const artifact = await ctx.artifacts.put(generated.bytes, { mime: 'image/png' })
  return {
    path: output,
    sha256: digest,
    artifact,
    model: generated.model,
    background: generated.background,
    width: generated.width,
    height: generated.height,
    references,
    ...(selectedSubject ? { selectedSubject } : {}),
    reused: false,
  }
}
