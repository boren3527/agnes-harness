/** Backend recognition transport contracts. They do not authorize inference or expose device secrets. */
export class RecognitionProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecognitionProtocolError'
  }
}
export interface RecognitionFrame {
  readonly id: string
  readonly receivedAt: number
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
}

export interface Detection {
  readonly label: string
  readonly confidence: number
  readonly box: readonly [number, number, number, number]
}

/** An authorized cloud adapter supplies upload and detect separately, never one opaque advance call. */
export interface RecognitionPipeline {
  upload(frame: RecognitionFrame, signal: AbortSignal): Promise<string>
  detect(imageUrl: string, signal: AbortSignal): Promise<unknown>
}

export class RecognitionServiceError extends Error {
  constructor(
    readonly kind: 'terminal' | 'transient',
    message: string,
  ) {
    super(message)
    this.name = 'RecognitionServiceError'
  }
}

export function parseAliDetections(value: unknown, width: number, height: number): Detection[] {
  if (typeof value !== 'object' || value === null)
    throw new RecognitionProtocolError('Missing detection response')
  const data = (value as Record<string, unknown>).Data
  if (typeof data !== 'object' || data === null) throw new RecognitionProtocolError('Missing detection data')
  const record = data as Record<string, unknown>
  if (
    record.Width !== width ||
    record.Height !== height ||
    !Array.isArray(record.Elements) ||
    record.Elements.length > 1000
  ) {
    throw new RecognitionProtocolError('Detection image does not match the submitted image')
  }
  return record.Elements.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new RecognitionProtocolError('Invalid detection')
    const item = entry as Record<string, unknown>
    const box = item.Boxes
    if (
      typeof item.Type !== 'string' ||
      !item.Type ||
      item.Type.length > 256 ||
      typeof item.Score !== 'number' ||
      !Number.isFinite(item.Score) ||
      item.Score < 0 ||
      item.Score > 1 ||
      !Array.isArray(box) ||
      box.length !== 4 ||
      box.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      throw new RecognitionProtocolError('Invalid detection fields')
    }
    const [x1, y1, x2, y2] = box as [number, number, number, number]
    if (x1 < 0 || y1 < 0 || x2 > width || y2 > height || x2 <= x1 || y2 <= y1)
      throw new RecognitionProtocolError('Invalid detection bounds')
    return { label: item.Type, confidence: item.Score, box: [x1, y1, x2, y2] as const }
  })
}
