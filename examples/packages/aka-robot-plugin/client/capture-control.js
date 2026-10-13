import { createElement as h, useEffect, useRef, useState } from 'react'

/** An unknown effect is never resubmitted as a new photo command. Live video remains independent. */
export function CaptureControl({ ctx, sessionId, binding, configRevision, enabled }) {
  const [phase, setPhase] = useState('idle')
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const busy = useRef(false)
  const operation = useRef(null)
  const observedRevision = useRef(configRevision)
  const t = (key) => ctx.locale.t(`aka.capture.control.${key}`)
  const available = () =>
    binding.active && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === 'connected'
  useEffect(() => {
    if (configRevision !== observedRevision.current && busy.current) setPhase('unknown')
    observedRevision.current = configRevision
    mounted.current = true
    try {
      const pending = ctx.commands.pendingEffect('aka.capture.photo')
      if (pending) {
        operation.current = pending
        setPhase('unknown')
      }
    } catch {
      setPhase('unknown')
    }
    const changed = () => {
      generation.current++
      if (busy.current) setPhase('unknown')
    }
    const off = [
      ctx.session.subscribe(changed),
      ctx.agnes.on('closed', changed),
      ctx.agnes.on('reconnecting', changed),
    ]
    return () => {
      mounted.current = false
      generation.current++
      for (const stop of off) stop?.()
    }
  }, [ctx, configRevision])
  const recoverable = () =>
    available() &&
    operation.current &&
    operation.current.bindingRevision === binding.bindingRevision &&
    operation.current.configRevision === configRevision
  async function capture(recover = false) {
    if (!available() || busy.current || (recover ? !recoverable() : !enabled || phase === 'unknown')) return
    if (!recover)
      operation.current = Object.freeze({ bindingRevision: binding.bindingRevision, configRevision })
    const input = operation.current
    const epoch = generation.current
    const current = () => mounted.current && generation.current === epoch && available()
    busy.current = true
    setSaving(true)
    setPhase('pending')
    try {
      const result = await ctx.commands.execute('aka.capture.photo', input)
      if (!current()) return
      if (
        result?.deviceId !== binding.deviceId ||
        result.bindingRevision !== binding.bindingRevision ||
        result.configRevision !== configRevision ||
        typeof result.frameId !== 'string' ||
        !result.frameId ||
        !Number.isSafeInteger(result.eventSeq) ||
        result.eventSeq < 1 ||
        !/^[a-f0-9]{64}$/.test(result.artifact?.sha256) ||
        result.artifact?.mime !== 'image/jpeg' ||
        !Number.isSafeInteger(result.artifact?.size) ||
        result.artifact.size < 1 ||
        result.artifact.size > 4 * 1024 * 1024
      )
        throw new Error('Unverified capture receipt')
      ctx.commands.completeEffect('aka.capture.photo', input)
      setPhase('recorded')
    } catch {
      if (current()) setPhase('unknown')
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }
  return h(
    'div',
    { className: 'aka-capture-control', 'aria-busy': saving },
    h(
      'button',
      {
        type: 'button',
        disabled: !enabled || !available() || phase === 'pending' || phase === 'unknown',
        onClick: () => void capture(),
      },
      t('capture'),
    ),
    phase === 'unknown' &&
      h(
        'button',
        {
          type: 'button',
          disabled: !recoverable() || saving,
          onClick: () => void capture(true),
        },
        t('recover'),
      ),
    phase !== 'idle' && h('p', { role: phase === 'unknown' ? 'alert' : 'status' }, t(phase)),
  )
}
