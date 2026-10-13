/** Tab-local hints only. The daemon must enforce readback-only admission and current authority. */
export class CaptureOperationStore {
  private cached: { raw: string; commandId: string; input: Record<string, unknown> } | undefined

  constructor(
    private readonly owner: string,
    private readonly packageId: string,
    private readonly service: 'aka.capture' | 'aka.recognition.test' = 'aka.capture',
  ) {}

  private key(sessionId: string): string {
    const kind = this.service === 'aka.capture' ? 'capture' : 'recognition'
    return `agnes.${kind}-operation.v1:${JSON.stringify([this.packageId, this.owner, sessionId])}`
  }

  read(sessionId: string): { commandId: string; input: Record<string, unknown> } | null {
    const raw = globalThis.sessionStorage.getItem(this.key(sessionId))
    if (raw === null) return null
    if (raw.length > 1024) throw new Error('capture recovery record unavailable')
    if (this.cached?.raw === raw) return this.cached
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('capture recovery record unavailable')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !== 'commandId,input' ||
      typeof record.commandId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.commandId) ||
      !this.validInput(record.input)
    )
      throw new Error('capture recovery record unavailable')
    this.cached = {
      raw,
      commandId: record.commandId,
      input: Object.freeze({ ...(record.input as Record<string, unknown>) }),
    }
    return this.cached
  }

  write(sessionId: string, commandId: string, input: Record<string, unknown>): void {
    if (!this.validInput(input)) throw new Error('capture recovery input unavailable')
    const current = this.read(sessionId)
    if (current && current.commandId !== commandId) throw new Error('original capture requires readback')
    const raw = JSON.stringify({ commandId, input })
    globalThis.sessionStorage.setItem(this.key(sessionId), raw)
    if (globalThis.sessionStorage.getItem(this.key(sessionId)) !== raw)
      throw new Error('capture recovery storage unavailable')
  }

  clear(sessionId: string, commandId: string): void {
    const current = this.read(sessionId)
    if (current?.commandId !== commandId) throw new Error('capture recovery identity changed')
    globalThis.sessionStorage.removeItem(this.key(sessionId))
    if (globalThis.sessionStorage.getItem(this.key(sessionId)) !== null)
      throw new Error('capture recovery storage unavailable')
    this.cached = undefined
  }

  private validInput(input: unknown): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false
    const descriptors = Object.getOwnPropertyDescriptors(input)
    return (
      Reflect.ownKeys(descriptors).sort().join(',') ===
        (this.service === 'aka.capture'
          ? 'bindingRevision,configRevision'
          : 'bindingRevision,configRevision,recognitionRevision,roundRevision') &&
      Object.values(descriptors).every(
        (field) =>
          'value' in field && field.enumerable && Number.isSafeInteger(field.value) && field.value > 0,
      )
    )
  }
}
