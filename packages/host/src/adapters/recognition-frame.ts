import { decodeSafeImageBytes } from '@agnes/protocol-validation'
import { type RecognitionFrame, RecognitionProtocolError } from './cloud-recognition.js'

/** Copy at the backend boundary before asynchronous admission; no getter or caller-owned bytes. */
export function copyRecognitionFrame(input: RecognitionFrame): RecognitionFrame {
  const invalid = (): never => {
    throw new RecognitionProtocolError('Invalid recognition frame')
  }
  try {
    const fields = Object.getOwnPropertyDescriptors(input)
    if (
      Object.keys(fields).sort().join(',') !== 'bytes,height,id,receivedAt,width' ||
      Object.values(fields).some((field) => !('value' in field))
    )
      return invalid()
    const value = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))
    if (
      typeof value.id !== 'string' ||
      !value.id ||
      value.id.length > 128 ||
      typeof value.receivedAt !== 'number' ||
      !Number.isFinite(value.receivedAt) ||
      value.receivedAt < 0
    )
      return invalid()
    const maxBytes = 2.5 * 1024 * 1024
    const image = decodeSafeImageBytes(
      { bytes: value.bytes, mimeType: 'image/jpeg' },
      {
        maxBytesPerImage: maxBytes,
        maxAggregateBytes: maxBytes,
        maxPixelsPerImage: 4095 * 4095,
        maxAggregatePixels: 4095 * 4095,
      },
    )
    if (
      image.width !== value.width ||
      image.height !== value.height ||
      image.width <= 20 ||
      image.height <= 20 ||
      image.width >= 4096 ||
      image.height >= 4096
    )
      return invalid()
    return Object.freeze({
      id: value.id,
      receivedAt: value.receivedAt,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
    })
  } catch {
    return invalid()
  }
}
