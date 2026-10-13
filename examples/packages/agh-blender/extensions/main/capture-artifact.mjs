import { createHash } from 'node:crypto'

/** Publish only the verified render bytes through the Host's call-scoped artifact port. */
export async function publishCapture(ctx, bytes, shot) {
  if (
    !bytes ||
    bytes.length < 45 ||
    bytes.length > 8 * 1024 * 1024 ||
    !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    Buffer.from(bytes).toString('ascii', 12, 16) !== 'IHDR' ||
    Buffer.from(bytes).toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND' ||
    bytes.length !== shot.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== shot.sha256
  )
    throw new Error('Capture PNG bytes or digest do not match the bridge')
  ctx.signal?.throwIfAborted()
  if (!ctx.artifacts?.put) throw new Error('Capture image artifacts unavailable; update the AGH runtime')
  const ref = await ctx.artifacts.put(bytes, { mime: 'image/png', name: 'blender-capture.png' })
  if (ref.sha256 !== shot.sha256 || ref.size !== bytes.length || ref.mime !== 'image/png')
    throw new Error('Capture artifact does not match the rendered PNG')
  return { ref, registered: true }
}
