import { createHash } from 'node:crypto'
import { AkaProtocolError } from './protocol.js'

export type { Detection, RecognitionFrame, RecognitionPipeline } from '@agnes/host'

import type { Detection, RecognitionFrame, RecognitionPipeline } from '@agnes/host'
import {
  parseAliDetections as parseBackendDetections,
  RecognitionProtocolError,
  RecognitionServiceError,
} from '@agnes/host'

export { RecognitionServiceError } from '@agnes/host'

export interface RecognitionResult {
  readonly id: string
  readonly generation: number
  readonly frame: RecognitionFrame
  readonly hash: string
  readonly submittedAt: number
  readonly completedAt: number
  readonly providerRequestId?: string
  readonly detections: readonly Detection[]
}

export function parseAliDetections(value: unknown, width: number, height: number): Detection[] {
  try {
    return parseBackendDetections(value, width, height)
  } catch (error) {
    if (error instanceof RecognitionProtocolError) throw new AkaProtocolError(error.message)
    throw error
  }
}

export type RecognitionAttempt =
  | { state: 'idle' | 'busy' | 'throttled' | 'stale' | 'discarded' | 'budget-exhausted' }
  | { state: 'result'; result: RecognitionResult }
  | { state: 'error'; consecutiveFailures: number }

/** One device's continuous recognition gate. Host owns session demand and account-wide limits.
 * Awaiters must not release the in-flight slot merely because an abort/deadline was signalled.
 */
export class RecognitionScheduler {
  private enabled = false
  private demand = false
  private ready = false
  private generation = 0
  private inFlight: AbortController | undefined
  private lastSentAt = Number.NEGATIVE_INFINITY
  private sent = 0
  private failures = 0
  private retryAt = 0
  private sequence = 0

  constructor(
    private readonly pipeline: RecognitionPipeline,
    private readonly reserve: (frame: RecognitionFrame, signal: AbortSignal) => Promise<boolean>,
    private readonly now: () => number = () => performance.now(),
    private readonly frequency: 0.5 | 1 | 2 = 2,
    private readonly budget = 3600,
    private readonly deadlineMs = 10000,
  ) {
    if (
      typeof reserve !== 'function' ||
      ![0.5, 1, 2].includes(frequency) ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > 100000 ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 10000
    ) {
      throw new AkaProtocolError('Invalid recognition limits')
    }
  }

  setEnabled(value: boolean): void {
    this.invalidate()
    this.enabled = value
    this.failures = 0
    this.retryAt = 0
  }

  setDemand(value: boolean): void {
    if (this.demand !== value) this.invalidate()
    this.demand = value
  }

  setReady(value: boolean): void {
    if (this.ready !== value) this.invalidate()
    this.ready = value
    if (!value) this.enabled = false
  }

  invalidate(): void {
    this.generation++
    this.inFlight?.abort()
  }

  /** Profile changes must close authorization; reconnect must not resume paid calls. */
  reconfigure(): void {
    this.enabled = false
    this.invalidate()
  }

  startNewRound(): void {
    if (this.enabled || this.inFlight)
      throw new AkaProtocolError('Stop recognition and wait for the request before resetting budget')
    this.sent = 0
    this.failures = 0
    this.retryAt = 0
    this.invalidate()
  }

  get status(): { enabled: boolean; inFlight: boolean; sent: number; generation: number } {
    return {
      enabled: this.enabled,
      inFlight: this.inFlight !== undefined,
      sent: this.sent,
      generation: this.generation,
    }
  }

  async poll(input: RecognitionFrame): Promise<RecognitionAttempt> {
    if (!this.enabled || !this.demand || !this.ready) return { state: 'idle' }
    if (this.inFlight) return { state: 'busy' }
    if (this.sent >= this.budget) {
      this.setEnabled(false)
      return { state: 'budget-exhausted' }
    }
    const startedAt = this.now()
    if (startedAt < this.retryAt || startedAt - this.lastSentAt < 1000 / this.frequency)
      return { state: 'throttled' }
    if (
      !Number.isFinite(input.receivedAt) ||
      input.receivedAt > startedAt ||
      startedAt - input.receivedAt > 1000
    )
      return { state: 'stale' }
    if (
      !input.id ||
      input.bytes.length > 2.5 * 1024 * 1024 ||
      !input.bytes.length ||
      !Number.isSafeInteger(input.width) ||
      !Number.isSafeInteger(input.height) ||
      input.width <= 20 ||
      input.height <= 20 ||
      input.width >= 4096 ||
      input.height >= 4096
    )
      throw new AkaProtocolError('Invalid recognition frame')
    const frame: RecognitionFrame = { ...input, bytes: Buffer.from(input.bytes) }
    const hash = createHash('sha256').update(frame.bytes).digest('hex')
    const generation = this.generation
    const controller = new AbortController()
    this.inFlight = controller
    const timer = setTimeout(() => controller.abort(), this.deadlineMs)
    timer.unref()
    const current = () =>
      this.enabled &&
      this.demand &&
      this.ready &&
      generation === this.generation &&
      !controller.signal.aborted &&
      this.now() - startedAt <= this.deadlineMs
    const discardedOrTimeout = (): RecognitionAttempt => {
      if (this.enabled && this.demand && this.ready && generation === this.generation)
        throw new RecognitionServiceError('transient', 'Recognition deadline exceeded')
      return { state: 'discarded' }
    }
    try {
      const imageUrl = await this.pipeline.upload(frame, controller.signal)
      // Recheck after upload. Closing during upload must never start a billable detection.
      if (!current()) return discardedOrTimeout()
      if (this.now() - frame.receivedAt > 5000) return { state: 'stale' }
      if (this.now() - this.lastSentAt < 1000 / this.frequency) return { state: 'throttled' }

      {
        const granted = await this.reserve(frame, controller.signal)
        // A durable claim can wait: repeat all effect checks before dispatch, not just before upload.
        if (!current()) return discardedOrTimeout()
        if (typeof granted !== 'boolean') throw new AkaProtocolError('Invalid recognition budget admission')
        if (!granted) {
          this.setEnabled(false)
          return { state: 'budget-exhausted' }
        }
        if (this.now() - frame.receivedAt > 5000) return { state: 'stale' }
        if (this.now() - this.lastSentAt < 1000 / this.frequency) return { state: 'throttled' }
      }
      this.lastSentAt = this.now()
      this.sent++
      const response = await this.pipeline.detect(imageUrl, controller.signal)
      if (!current()) return discardedOrTimeout()
      const detections = parseAliDetections(response, frame.width, frame.height)
      const providerRequestId = (response as Record<string, unknown>).RequestId
      if (
        providerRequestId !== undefined &&
        (typeof providerRequestId !== 'string' ||
          !providerRequestId ||
          providerRequestId.length > 256 ||
          [...providerRequestId].some(
            (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
          ))
      )
        throw new AkaProtocolError('Invalid recognition request reference')
      this.failures = 0
      return {
        state: 'result',
        result: {
          id: `${generation}:${++this.sequence}`,
          generation,
          frame,
          hash,
          submittedAt: this.lastSentAt,
          completedAt: this.now(),
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          detections,
        },
      }
    } catch (error) {
      if (generation !== this.generation || !this.enabled || !this.demand || !this.ready)
        return { state: 'discarded' }
      this.failures++
      const consecutiveFailures = this.failures
      this.retryAt = this.now() + 1000 * 2 ** (this.failures - 1)
      if (
        this.failures >= 3 ||
        error instanceof AkaProtocolError ||
        error instanceof RecognitionProtocolError ||
        (error instanceof RecognitionServiceError && error.kind === 'terminal')
      )
        this.setEnabled(false)
      return { state: 'error', consecutiveFailures }
    } finally {
      clearTimeout(timer)
      // Even an adapter which ignores abort occupies this slot until it actually settles.
      this.inFlight = undefined
    }
  }
}
