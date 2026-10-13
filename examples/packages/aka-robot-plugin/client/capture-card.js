import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

/** Read a durable tool result through the current session; no capture or other side effect. */
export async function loadCapture(ctx, sessionId, owner, signal) {
  signal.throwIfAborted()
  const node = owner?.block
  const handle = ctx.session.handle
  if (
    ctx.session.sessionId !== sessionId ||
    !handle ||
    owner?.toolName !== 'aka_capture' ||
    node?.name !== 'aka_capture' ||
    node.toolUseId !== owner.callId ||
    !Number.isSafeInteger(node.seq) ||
    !Number.isSafeInteger(node.resultSeq)
  )
    throw new Error('capture unavailable')
  const detail = await handle.readToolDetail(node.seq, node.resultSeq, { signal })
  signal.throwIfAborted()
  if (
    ctx.session.sessionId !== sessionId ||
    ctx.session.handle !== handle ||
    detail.call.name !== 'aka_capture' ||
    detail.call.toolUseId !== owner.callId ||
    detail.result?.toolUseId !== owner.callId ||
    detail.result.isError ||
    detail.result.partial ||
    detail.result.interrupted
  )
    throw new Error('capture unavailable')
  const facts = detail.result.structured
  if (
    !facts ||
    typeof facts.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(facts.hash) ||
    !Number.isSafeInteger(facts.size) ||
    facts.size < 1 ||
    facts.size > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(facts.width) ||
    facts.width < 1 ||
    facts.width > 4096 ||
    !Number.isSafeInteger(facts.height) ||
    facts.height < 1 ||
    facts.height > 4096 ||
    facts.timeBasis !== 'bridge_receive' ||
    typeof facts.selectedAt !== 'string' ||
    !Number.isFinite(Date.parse(facts.selectedAt)) ||
    !detail.result.content.some(
      (block) =>
        block.type === 'resource_link' &&
        block.uri === `artifact://${facts.hash}` &&
        block.mimeType === 'image/jpeg',
    )
  )
    throw new Error('capture unavailable')
  const resource = await ctx.resources.images.load({
    laneId: 'main',
    artifact: { sha256: facts.hash, size: facts.size, mime: 'image/jpeg' },
    signal,
  })
  if (signal.aborted || ctx.session.sessionId !== sessionId || ctx.session.handle !== handle) {
    resource.release()
    throw new Error('capture unavailable')
  }
  return { resource, selectedAt: facts.selectedAt, width: facts.width, height: facts.height }
}

export function CaptureCard({ ctx, owner }) {
  const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
  useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
  const t = (key) => ctx.locale.t(`aka.capture.${key}`)
  const [attempt, retry] = useState(0)
  const [view, setView] = useState({ key: '', state: 'loading' })
  const callId = owner?.callId,
    toolName = owner?.toolName,
    seq = owner?.block?.seq,
    resultSeq = owner?.block?.resultSeq,
    nodeName = owner?.block?.name,
    nodeToolUseId = owner?.block?.toolUseId
  const key = `${sessionId}:${callId}:${toolName}:${nodeName}:${nodeToolUseId}:${seq}:${resultSeq}:${attempt}`
  useEffect(() => {
    const controller = new AbortController()
    let resource,
      active = true
    setView({ key, state: resultSeq ? 'loading' : 'pending' })
    const coordinates = {
      callId,
      toolName,
      block: { seq, resultSeq, name: nodeName, toolUseId: nodeToolUseId },
    }
    if (resultSeq)
      void loadCapture(ctx, sessionId, coordinates, controller.signal).then(
        (result) => {
          if (!active) {
            result.resource.release()
            return
          }
          resource = result.resource
          setView({ key, state: 'ready', ...result })
        },
        () => {
          if (active) setView({ key, state: 'error' })
        },
      )
    return () => {
      active = false
      controller.abort()
      resource?.release()
    }
  }, [ctx, sessionId, key, callId, toolName, seq, resultSeq, nodeName, nodeToolUseId])
  const current = view.key === key ? view : { state: 'loading' }
  return h(
    'figure',
    { className: 'aka-capture-card' },
    h('figcaption', null, t('title')),
    current.state === 'ready'
      ? h('img', {
          src: current.resource.url,
          alt: t('alt'),
          width: current.width,
          height: current.height,
          style: { maxWidth: '100%', height: 'auto' },
          onError: () => {
            current.resource.release()
            setView({ key, state: 'error' })
          },
        })
      : h('p', { role: current.state === 'error' ? 'alert' : 'status' }, t(current.state)),
    current.state === 'ready' && h('p', null, `${t('selectedAt')}: ${current.selectedAt}`),
    h('p', null, t('historical')),
    current.state === 'error' &&
      h('button', { type: 'button', onClick: () => retry((v) => v + 1) }, t('retry')),
  )
}
