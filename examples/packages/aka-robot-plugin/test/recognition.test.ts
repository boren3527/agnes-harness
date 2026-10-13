import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseAliDetections,
  type RecognitionFrame,
  type RecognitionPipeline,
  RecognitionScheduler,
  RecognitionServiceError,
} from '../src/recognition.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const frame = (receivedAt = 0): RecognitionFrame => ({
  id: '1:1',
  receivedAt,
  width: 320,
  height: 240,
  bytes: Buffer.from([1, 2, 3]),
})
const empty = { Data: { Width: 320, Height: 240, Elements: [] } }

function ready(pipeline: RecognitionPipeline, now: () => number = () => 0, budget = 3600) {
  const scheduler = new RecognitionScheduler(pipeline, async () => true, now, 2, budget)
  scheduler.setReady(true)
  scheduler.setDemand(true)
  scheduler.setEnabled(true)
  return scheduler
}

afterEach(() => vi.useRealTimers())

describe('continuous recognition authorization and accounting', () => {
  it('does not upload merely because a device connects or a page subscribes', async () => {
    const upload = vi.fn(async () => 'opaque-upload')
    const scheduler = new RecognitionScheduler({ upload, detect: async () => empty }, async () => true)
    scheduler.setReady(true)
    scheduler.setDemand(true)
    expect(await scheduler.poll(frame())).toEqual({ state: 'idle' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('closing during upload prevents the final paid call, even if the adapter ignores abort', async () => {
    const uploaded = deferred<string>()
    const detect = vi.fn(async () => empty)
    const scheduler = ready({ upload: () => uploaded.promise, detect })
    const pending = scheduler.poll(frame())
    scheduler.setEnabled(false)
    scheduler.setEnabled(true)
    expect(await scheduler.poll(frame())).toEqual({ state: 'busy' })
    uploaded.resolve('opaque-upload')
    expect(await pending).toEqual({ state: 'discarded' })
    expect(detect).not.toHaveBeenCalled()
    expect(scheduler.status.sent).toBe(0)
  })

  it('a late detection after disable/re-enable cannot become the current result', async () => {
    const detected = deferred<unknown>()
    const entered = deferred<void>()
    const scheduler = ready({
      upload: async () => 'opaque-upload',
      detect: () => {
        entered.resolve()
        return detected.promise
      },
    })
    const pending = scheduler.poll(frame())
    await entered.promise
    expect(scheduler.status.sent).toBe(1)
    scheduler.setEnabled(false)
    scheduler.setEnabled(true)
    detected.resolve(empty)
    expect(await pending).toEqual({ state: 'discarded' })
  })

  it('pins the exact submitted frame independently of caller mutations', async () => {
    const uploaded = deferred<string>()
    const scheduler = ready({ upload: () => uploaded.promise, detect: async () => empty })
    const input = frame()
    const pending = scheduler.poll(input)
    input.bytes.fill(99)
    uploaded.resolve('opaque-upload')
    const result = await pending
    expect(result.state).toBe('result')
    if (result.state !== 'result') throw new Error('Expected recognition result')
    expect(result.result.frame.bytes).toEqual(Buffer.from([1, 2, 3]))
    expect(result.result.hash).toHaveLength(64)
    expect(result.result.detections).toEqual([])
  })

  it('limits final detection dispatch to 2 Hz and does not replenish budget on toggles', async () => {
    let now = 0
    const scheduler = ready({ upload: async () => 'opaque-upload', detect: async () => empty }, () => now, 2)
    expect((await scheduler.poll(frame(now))).state).toBe('result')
    now = 499
    expect((await scheduler.poll(frame(now))).state).toBe('throttled')
    now = 500
    expect((await scheduler.poll(frame(now))).state).toBe('result')
    scheduler.setEnabled(false)
    scheduler.setEnabled(true)
    now = 1000
    expect((await scheduler.poll(frame(now))).state).toBe('budget-exhausted')
    expect(scheduler.status.enabled).toBe(false)
    scheduler.startNewRound()
    scheduler.setEnabled(true)
    expect((await scheduler.poll(frame(now))).state).toBe('result')
  })

  it('rechecks frame age after upload instead of dispatching old images', async () => {
    let now = 0
    const uploaded = deferred<string>()
    const detect = vi.fn(async () => empty)
    const scheduler = ready({ upload: () => uploaded.promise, detect }, () => now)
    const pending = scheduler.poll(frame())
    now = 5001
    uploaded.resolve('opaque-upload')
    expect((await pending).state).toBe('stale')
    expect(detect).not.toHaveBeenCalled()
  })

  it('does not free the in-flight slot on a deadline while the transport remains live', async () => {
    vi.useFakeTimers()
    const uploaded = deferred<string>()
    const detect = vi.fn(async () => empty)
    const scheduler = ready({ upload: () => uploaded.promise, detect })
    const pending = scheduler.poll(frame())
    await vi.advanceTimersByTimeAsync(10001)
    expect(scheduler.status.inFlight).toBe(true)
    expect((await scheduler.poll(frame())).state).toBe('busy')
    uploaded.resolve('opaque-upload')
    expect(await pending).toEqual({ state: 'error', consecutiveFailures: 1 })
    expect(detect).not.toHaveBeenCalled()
    expect(scheduler.status.inFlight).toBe(false)
  })

  it('locks terminal authentication errors immediately and transient failures after three attempts', async () => {
    const terminal = ready({
      upload: async () => {
        throw new RecognitionServiceError('terminal', 'denied')
      },
      detect: async () => empty,
    })
    expect(await terminal.poll(frame())).toEqual({ state: 'error', consecutiveFailures: 1 })
    expect(terminal.status.enabled).toBe(false)
    let now = 0
    const transient = ready(
      {
        upload: async () => {
          throw new Error('network failed')
        },
        detect: async () => empty,
      },
      () => now,
    )
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await transient.poll(frame(now))).toEqual({ state: 'error', consecutiveFailures: attempt })
      now += 1000 * 2 ** (attempt - 1)
    }
    expect(transient.status.enabled).toBe(false)
  })

  it('reconnection and reconfiguration require a fresh user enable', async () => {
    const scheduler = ready({ upload: async () => 'opaque-upload', detect: async () => empty })
    scheduler.setReady(false)
    scheduler.setReady(true)
    expect((await scheduler.poll(frame())).state).toBe('idle')
    scheduler.setEnabled(true)
    scheduler.reconfigure()
    expect((await scheduler.poll(frame())).state).toBe('idle')
  })
})

describe('Alibaba detection coordinate contract', () => {
  it('preserves labels and pixel boxes without inventing centimeters or object identity', () => {
    expect(
      parseAliDetections(
        {
          Data: {
            Width: 320,
            Height: 240,
            Elements: [{ Type: 'tennis ball', Score: 0.9, Boxes: [10, 20, 30, 40] }],
          },
        },
        320,
        240,
      ),
    ).toEqual([{ label: 'tennis ball', confidence: 0.9, box: [10, 20, 30, 40] }])
  })

  it.each([
    { Data: { Width: 640, Height: 480, Elements: [] } },
    { Data: { Width: 320, Height: 240, Elements: [{ Type: 'ball', Score: 90, Boxes: [1, 1, 2, 2] }] } },
    { Data: { Width: 320, Height: 240, Elements: [{ Type: 'ball', Score: 0.9, Boxes: [-1, 1, 2, 2] }] } },
    { Data: { Width: 320, Height: 240, Elements: [{ Type: 'ball', Score: 0.9, Boxes: [10, 1, 2, 2] }] } },
    {
      Data: {
        Width: 320,
        Height: 240,
        Elements: [{ Type: 'ball', Score: 0.9, Boxes: [1, 1, Number.NaN, 2] }],
      },
    },
  ])('rejects mismatched images or unsafe boxes %#', (response) => {
    expect(() => parseAliDetections(response, 320, 240)).toThrow()
  })
})

describe('durable reservation before final detection dispatch', () => {
  it('refuses construction without an explicit budget admission callback', () => {
    expect(
      () =>
        new RecognitionScheduler(
          { upload: async () => 'opaque', detect: async () => empty },
          undefined as never,
        ),
    ).toThrow('Invalid recognition limits')
  })

  function subject(
    reserve: (frame: RecognitionFrame, signal: AbortSignal) => Promise<boolean>,
    now: () => number = () => 0,
  ) {
    const detect = vi.fn(async () => empty)
    const scheduler = new RecognitionScheduler(
      { upload: async () => 'opaque', detect },
      reserve,
      now,
      2,
      10,
      10000,
    )
    scheduler.setReady(true)
    scheduler.setDemand(true)
    scheduler.setEnabled(true)
    return { scheduler, detect }
  }
  it('does not detect or count dispatch after a refused durable reservation', async () => {
    const { scheduler, detect } = subject(async () => false)
    expect(await scheduler.poll(frame())).toEqual({ state: 'budget-exhausted' })
    expect(detect).not.toHaveBeenCalled()
    expect(scheduler.status).toMatchObject({ sent: 0, enabled: false, inFlight: false })
  })
  it.each(['disable', 'demand', 'camera', 'config', 'age', 'deadline'] as const)(
    'rechecks %s after a pending reservation instead of detecting',
    async (mode) => {
      let now = 0
      const pending = deferred<boolean>()
      const entered = deferred<void>()
      const { scheduler, detect } = subject(
        () => {
          entered.resolve()
          return pending.promise
        },
        () => now,
      )
      const run = scheduler.poll(frame())
      await entered.promise
      expect(scheduler.status.inFlight).toBe(true)
      expect(await scheduler.poll(frame())).toEqual({ state: 'busy' })
      if (mode === 'disable') scheduler.setEnabled(false)
      if (mode === 'demand') scheduler.setDemand(false)
      if (mode === 'camera') scheduler.setReady(false)
      if (mode === 'config') scheduler.reconfigure()
      if (mode === 'age') now = 5001
      if (mode === 'deadline') now = 10001
      if (mode === 'disable') {
        scheduler.setEnabled(true)
        expect(await scheduler.poll(frame())).toEqual({ state: 'busy' })
        expect(() => scheduler.startNewRound()).toThrow()
      }
      expect(scheduler.status.inFlight).toBe(true)
      pending.resolve(true)
      expect((await run).state).toBe(mode === 'age' ? 'stale' : mode === 'deadline' ? 'error' : 'discarded')
      expect(detect).not.toHaveBeenCalled()
      expect(scheduler.status.sent).toBe(0)
      expect(scheduler.status.inFlight).toBe(false)
    },
  )
  it('refuses malformed budget replies and preserves the single in-flight gate', async () => {
    const { scheduler, detect } = subject(async () => 'yes' as never)
    expect(await scheduler.poll(frame())).toEqual({ state: 'error', consecutiveFailures: 1 })
    expect(scheduler.status.enabled).toBe(false)
    expect(detect).not.toHaveBeenCalled()
  })
  it('applies the durable cap across newly constructed schedulers without inventing sent events', async () => {
    let remaining = 1
    const reserve = vi.fn(async () => remaining-- > 0)
    const first = subject(reserve)
    expect((await first.scheduler.poll(frame())).state).toBe('result')
    const restarted = subject(reserve)
    expect((await restarted.scheduler.poll(frame())).state).toBe('budget-exhausted')
    expect(first.scheduler.status.sent).toBe(1)
    expect(restarted.scheduler.status.sent).toBe(0)
    expect(restarted.detect).not.toHaveBeenCalled()
  })
})
