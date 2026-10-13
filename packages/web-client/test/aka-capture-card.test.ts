/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  document.body.replaceChildren()
})
async function fixture() {
  const entry = '../../../examples/packages/aka-robot-plugin/client/capture-card.js'
  const { loadCapture, CaptureCard } = await import(entry)
  const hash = 'a'.repeat(64)
  const owner = {
    callId: 'call',
    toolName: 'aka_capture',
    block: { name: 'aka_capture', toolUseId: 'call', seq: 14, resultSeq: 18 },
  }
  const facts = {
    hash,
    size: 100,
    width: 320,
    height: 240,
    timeBasis: 'bridge_receive',
    selectedAt: '2026-10-10T01:00:00Z',
  }
  const detail = {
    call: { name: 'aka_capture', toolUseId: 'call' },
    result: {
      toolUseId: 'call',
      isError: false,
      partial: false,
      interrupted: false,
      structured: facts,
      content: [{ type: 'resource_link', uri: `artifact://${hash}`, mimeType: 'image/jpeg' }],
    },
  }
  const resource = { url: 'blob:photo-test', release: vi.fn() }
  const readToolDetail = vi.fn(async () => detail),
    load = vi.fn(async () => resource)
  const listeners = new Set<() => void>()
  const ctx = {
    session: {
      sessionId: 'device',
      handle: { readToolDetail },
      getSnapshot: () => ctx.session.sessionId,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    resources: { images: { load } },
    locale: { locale: 'en', subscribe: () => () => {}, t: (key: string) => key },
  }
  const invoke = () => loadCapture(ctx, 'device', owner, new AbortController().signal)
  const mount = () => {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    root.render(createElement(CaptureCard, { ctx, owner }))
    cleanup.push(() => root.unmount())
    return { el, root }
  }
  return { ctx, detail, facts, owner, resource, readToolDetail, load, invoke, mount, listeners }
}
describe('AKA saved photo card through existing session resources', () => {
  it('reads the durable result coordinates and loads the exact artifact without capturing again', async () => {
    const v = await fixture()
    await expect(v.invoke()).resolves.toMatchObject({ resource: v.resource, width: 320 })
    expect(v.readToolDetail).toHaveBeenCalledWith(14, 18, { signal: expect.any(AbortSignal) })
    expect(v.load).toHaveBeenCalledWith({
      laneId: 'main',
      artifact: { sha256: v.facts.hash, size: 100, mime: 'image/jpeg' },
      signal: expect.any(AbortSignal),
    })
  })
  it.each(['wrong-call', 'error', 'partial', 'interrupted', 'wrong-link', 'bad-size', 'wrong-tool'] as const)(
    'refuses %s before loading any photo',
    async (mode) => {
      const v = await fixture()
      if (mode === 'wrong-call') v.detail.result.toolUseId = 'other'
      if (mode === 'error') v.detail.result.isError = true
      if (mode === 'partial') v.detail.result.partial = true
      if (mode === 'interrupted') v.detail.result.interrupted = true
      if (mode === 'wrong-link' && v.detail.result.content[0])
        v.detail.result.content[0].uri = `artifact://${'b'.repeat(64)}`
      if (mode === 'bad-size') v.facts.size = 0
      if (mode === 'wrong-tool') v.owner.toolName = 'other'
      await expect(v.invoke()).rejects.toThrow('capture unavailable')
      expect(v.load).not.toHaveBeenCalled()
    },
  )
  it('releases a late image resource after a session switch instead of publishing it', async () => {
    const v = await fixture()
    v.load.mockImplementation(async () => {
      v.ctx.session.sessionId = 'other'
      return v.resource
    })
    await expect(v.invoke()).rejects.toThrow('capture unavailable')
    expect(v.resource.release).toHaveBeenCalledTimes(1)
  })
  it('renders a saved image and releases its URL on unmount', async () => {
    const v = await fixture(),
      mounted = v.mount()
    await vi.waitFor(() =>
      expect(mounted.el.querySelector('img')?.getAttribute('src')).toBe('blob:photo-test'),
    )
    expect(mounted.el.querySelector('img')?.getAttribute('alt')).toBe('aka.capture.alt')
    expect(mounted.el.textContent).toContain('aka.capture.historical')
    mounted.root.unmount()
    cleanup.pop()
    expect(v.resource.release).toHaveBeenCalledTimes(1)
  })
  it('reports a read failure and retries only reading the saved image', async () => {
    const v = await fixture()
    v.load.mockRejectedValueOnce(new Error('private-path'))
    const mounted = v.mount()
    await vi.waitFor(() => expect(mounted.el.querySelector('[role="alert"]')).not.toBeNull())
    expect(mounted.el.textContent).not.toContain('private-path')
    mounted.el.querySelector('button')?.click()
    await vi.waitFor(() => expect(mounted.el.querySelector('img')).not.toBeNull())
    expect(v.load).toHaveBeenCalledTimes(2)
  })
})
