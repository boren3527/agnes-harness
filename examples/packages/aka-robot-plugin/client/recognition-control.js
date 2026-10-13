import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'
import { checked as checkedSettings } from './recognition-settings.js'

const positive = (v) => Number.isSafeInteger(v) && v > 0
function round(value, binding) {
  if (value === null) return null
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'budget,deviceId,reserved,roundRevision' ||
    value.deviceId !== binding.deviceId ||
    !positive(value.roundRevision) ||
    !positive(value.budget) ||
    value.budget > 100000 ||
    !Number.isSafeInteger(value.reserved) ||
    value.reserved < 0 ||
    value.reserved > value.budget
  )
    throw new Error('Invalid round')
  return Object.freeze({ ...value })
}
export function checkedResult(value, binding, input) {
  if (
    value?.outcome === 'not-started' &&
    Object.keys(value).sort().join(',') ===
      'bindingRevision,configRevision,deviceId,outcome,recognitionRevision,roundRevision' &&
    value.deviceId === binding.deviceId &&
    ['bindingRevision', 'configRevision', 'recognitionRevision', 'roundRevision'].every(
      (key) => positive(value[key]) && value[key] === input[key],
    )
  )
    return null
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'ageAtSelectionMs,artifact,bindingRevision,configRevision,detections,deviceId,elapsedMs,eventSeq,frameId,height,id,providerRequestId,roundRevision,selectedAt,sha256,timeBasis,width' ||
    value.deviceId !== binding.deviceId ||
    value.bindingRevision !== input.bindingRevision ||
    value.configRevision !== input.recognitionRevision ||
    value.roundRevision !== input.roundRevision ||
    !positive(value.eventSeq) ||
    value.timeBasis !== 'bridge_receive' ||
    typeof value.selectedAt !== 'string' ||
    value.selectedAt.length > 64 ||
    !Number.isFinite(Date.parse(value.selectedAt)) ||
    !Number.isFinite(value.ageAtSelectionMs) ||
    value.ageAtSelectionMs < 0 ||
    value.ageAtSelectionMs > 1000 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) ||
    typeof value.frameId !== 'string' ||
    !value.frameId ||
    value.frameId.length > 512 ||
    typeof value.providerRequestId !== 'string' ||
    !value.providerRequestId ||
    value.providerRequestId.length > 512 ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    !positive(value.width) ||
    value.width < 21 ||
    value.width > 4095 ||
    !positive(value.height) ||
    value.height < 21 ||
    value.height > 4095 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !value.artifact ||
    Object.keys(value.artifact).sort().join(',') !== 'mime,sha256,size' ||
    value.artifact.sha256 !== value.sha256 ||
    value.artifact.mime !== 'image/jpeg' ||
    !positive(value.artifact.size) ||
    value.artifact.size > 2.5 * 1024 * 1024 ||
    !Array.isArray(value.detections) ||
    value.detections.length > 1000 ||
    value.detections.some(
      (d) =>
        !d ||
        Object.keys(d).sort().join(',') !== 'box,confidence,label' ||
        typeof d.label !== 'string' ||
        !d.label ||
        d.label.length > 256 ||
        !Number.isFinite(d.confidence) ||
        d.confidence < 0 ||
        d.confidence > 1 ||
        !Array.isArray(d.box) ||
        d.box.length !== 4 ||
        !d.box.every(Number.isFinite) ||
        d.box[0] < 0 ||
        d.box[1] < 0 ||
        d.box[2] > value.width ||
        d.box[3] > value.height ||
        d.box[2] <= d.box[0] ||
        d.box[3] <= d.box[1],
    )
  )
    throw new Error('Invalid recognition result')
  return Object.freeze({
    ...value,
    artifact: Object.freeze({ ...value.artifact }),
    receivedAt: new Date().toISOString(),
    detections: Object.freeze(
      value.detections.map((d) => Object.freeze({ ...d, box: Object.freeze([...d.box]) })),
    ),
  })
}

/** Display uses the saved original, never the latest live frame. Reading again cannot infer. */
export function RecognitionResult({ ctx, sessionId, result, binding, connectionRevision }) {
  const [distances, setDistances] = useState(null)
  useEffect(() => {
    let active = true
    setDistances(null)
    if (binding && connectionRevision)
      void ctx.agnes.services
        .call('aka.geometry.estimate', {
          bindingRevision: binding.bindingRevision,
          configRevision: connectionRevision,
          resultId: result.id,
        })
        .then(
          (value) => {
            if (active && value?.resultId === result.id && Array.isArray(value.estimates))
              setDistances(value.estimates)
          },
          () => {},
        )
    return () => {
      active = false
    }
  }, [ctx, binding, connectionRevision, result.id])
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState(null)
  const t = (key) => ctx.locale.t(`aka.recognition.control.${key}`)
  useEffect(() => {
    const controller = new AbortController()
    let resource,
      active = true
    const release = () => {
      const previous = resource
      resource = undefined
      previous?.release()
    }
    setView(null)
    const off = ctx.session.subscribe(() => {
      active = false
      controller.abort()
      release()
      setView(null)
    })
    void ctx.resources.images
      .load({ laneId: 'main', artifact: result.artifact, signal: controller.signal })
      .then(
        (loaded) => {
          if (!active || controller.signal.aborted || ctx.session.sessionId !== sessionId) {
            loaded.release()
            return
          }
          resource = loaded
          setView({ result, attempt, resource })
        },
        () => {
          if (active) setView({ result, attempt, error: true })
        },
      )
    return () => {
      active = false
      controller.abort()
      off?.()
      release()
    }
  }, [ctx, sessionId, result, attempt])
  const current = view?.result === result && view?.attempt === attempt ? view : null
  return h(
    'figure',
    { className: 'aka-recognition-result' },
    h('figcaption', null, t('result')),
    current?.resource
      ? h(
          'div',
          { className: 'aka-recognition-image' },
          h('img', {
            src: current.resource.url,
            width: result.width,
            height: result.height,
            alt: t('alt'),
            onError: () => setView({ result, attempt, error: true }),
            onLoad: (e) => {
              if (
                e.currentTarget.naturalWidth !== result.width ||
                e.currentTarget.naturalHeight !== result.height
              )
                setView({ result, attempt, error: true })
            },
          }),
          h(
            'svg',
            { viewBox: `0 0 ${result.width} ${result.height}`, 'aria-hidden': true },
            result.detections.map((d, i) =>
              h('rect', {
                key: i,
                x: d.box[0],
                y: d.box[1],
                width: d.box[2] - d.box[0],
                height: d.box[3] - d.box[1],
              }),
            ),
          ),
        )
      : h(
          'p',
          { role: current?.error ? 'alert' : 'status' },
          t(current?.error ? 'imageError' : 'imageLoading'),
        ),
    current?.error &&
      h('button', { type: 'button', onClick: () => setAttempt((v) => v + 1) }, t('readImage')),
    h(
      'details',
      { className: 'aka-advanced aka-result-meta' },
      h('summary', null, t('details')),
      h('p', null, t('historical')),
      h('p', null, `${t('selected')} ${result.selectedAt}`),
      h('p', null, `${t('received')} ${result.receivedAt}`),
    ),
    result.detections.length
      ? h(
          'ol',
          null,
          result.detections.map((d, i) =>
            h(
              'li',
              { key: i },
              `${d.label} · ${(d.confidence * 100).toFixed(1)}%`,
              d.confidence < 0.6 && h('span', null, ` · ${t('lowConfidence')}`),
              h(
                'p',
                null,
                distances?.[i]?.state === 'estimated' &&
                  Number.isFinite(distances[i].groundDistance) &&
                  Number.isFinite(distances[i].observedErrorMeters)
                  ? `${t('distance')}: ${(distances[i].groundDistance * 100).toFixed(1)} cm · ${t('observedError')} ${(distances[i].observedErrorMeters * 100).toFixed(1)} cm`
                  : t('distanceUnknown'),
              ),
            ),
          ),
        )
      : h('p', null, t('empty')),
  )
}

/** Existing budgeted effects serve explicit tests and the visible-page recognition switch. */
export function RecognitionControl({
  ctx,
  sessionId,
  binding,
  configRevision,
  enabled,
  settingsVersion = 0,
}) {
  const reasonId = useId()
  const [continuous, setContinuous] = useState(false)
  const running = useRef(false)
  const resumeRecognition = useRef(false)
  const [view, setView] = useState({ phase: 'idle', settings: null, round: undefined, result: null })
  const effectiveBudget =
    view.round && view.settings?.settings
      ? Math.min(view.round.budget, view.settings.settings.requestBudget)
      : 0
  const scope = `${sessionId}:${binding.deviceId}:${binding.bindingRevision}:${configRevision}:${settingsVersion}`
  const observed = useRef(scope)
  const epoch = useRef(0),
    mounted = useRef(false),
    busy = useRef(false),
    uncertain = useRef(false),
    restorePending = useRef(false),
    original = useRef(null)
  const t = (key) => ctx.locale.t(`aka.recognition.control.${key}`)
  const available = useCallback(
    () => binding.active && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === 'connected',
    [binding.active, ctx, sessionId],
  )
  useEffect(() => {
    observed.current = scope
    mounted.current = true
    const invalidate = () => {
      running.current = false
      resumeRecognition.current = false
      setContinuous(false)
      epoch.current++
      setView((v) => ({
        ...v,
        result: null,
        settings: null,
        round: undefined,
        phase: busy.current || uncertain.current ? 'unknown' : 'idle',
      }))
      if (busy.current) uncertain.current = true
    }
    invalidate()
    try {
      original.current = ctx.commands.pendingEffect('aka.recognition.test')
      restorePending.current = !!original.current
      if (original.current) {
        uncertain.current = true
        setView((v) => ({ ...v, phase: 'unknown' }))
      }
    } catch {
      original.current = null
      uncertain.current = true
      setView((v) => ({ ...v, phase: 'unknown' }))
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    return () => {
      mounted.current = false
      running.current = false
      epoch.current++
      for (const stop of off) stop?.()
    }
  }, [ctx, scope])
  const run = useCallback(
    async (action, automatic = false) => {
      if (automatic && !running.current) return
      if (!available() || busy.current || (uncertain.current && !['read', 'recover'].includes(action))) return
      if (action === 'recover' && !original.current) return
      if (action === 'test' && (!enabled || !view.round || view.round.reserved >= effectiveBudget)) return
      if (action === 'start' && (!view.settings || view.round === undefined)) return
      busy.current = true
      const generation = epoch.current
      const current = () =>
        mounted.current && epoch.current === generation && observed.current === scope && available()
      setView((v) => ({
        ...v,
        phase: 'pending',
        ...(action === 'test' && !automatic ? { result: null } : {}),
      }))
      let submitted = false
      try {
        if (action === 'recover') {
          const input = ctx.commands.pendingEffect('aka.recognition.test')
          if (!input) throw new Error('Original identity unavailable')
          const result = checkedResult(
            await ctx.commands.execute('aka.recognition.test', input),
            binding,
            input,
          )
          if (!current()) return
          ctx.commands.completeEffect('aka.recognition.test', input)
          original.current = null
          uncertain.current = false
          setView((v) => ({ ...v, round: undefined, result, phase: result ? 'ready' : 'notStarted' }))
          if (resumeRecognition.current && enabled) {
            running.current = true
            setContinuous(true)
            setView((v) => ({ ...v, phase: 'ready' }))
          }
          return
        }
        const settings = checkedSettings(await ctx.agnes.device.recognition(sessionId), binding)
        if (!current()) return
        const expected = {
          expectedBindingRevision: binding.bindingRevision,
          expectedConfigRevision: settings.configRevision,
        }
        let activeRound = view.round
        if (action === 'enable' || action === 'sample') {
          if (!enabled || settings.settings?.provider !== 'aliyun') {
            setView((v) => ({ ...v, settings }))
            throw new Error('Configure recognition first')
          }
          activeRound = round(await ctx.commands.execute('aka.recognition.round.read', expected), binding)
          if (!current()) return
          if (
            !activeRound ||
            activeRound.reserved >= Math.min(activeRound.budget, settings.settings.requestBudget)
          ) {
            const input = {
              ...expected,
              expectedRoundRevision: activeRound?.roundRevision ?? 0,
              startId: crypto.randomUUID(),
            }
            submitted = true
            activeRound = round(await ctx.commands.execute('aka.recognition.round.start', input), binding)
            if (!activeRound || activeRound.roundRevision !== input.expectedRoundRevision + 1)
              throw new Error('Invalid round')
            if (!current()) return
          }
          if (action === 'enable') {
            setView((v) => ({ ...v, settings, round: activeRound, phase: 'ready' }))
            running.current = true
            resumeRecognition.current = true
            setContinuous(true)
            return
          }
        }
        if (action === 'read') {
          const value = round(await ctx.commands.execute('aka.recognition.round.read', expected), binding)
          if (current())
            setView((v) => ({ ...v, settings, round: value, phase: uncertain.current ? 'unknown' : 'ready' }))
          return
        }
        if (
          settings.settings?.provider !== 'aliyun' ||
          (action !== 'sample' && settings.configRevision !== view.settings?.configRevision)
        )
          throw new Error('Configuration changed')
        if (action === 'start') {
          const input = Object.freeze({
            ...expected,
            expectedRoundRevision: view.round?.roundRevision ?? 0,
            startId: crypto.randomUUID(),
          })
          submitted = true
          const value = round(await ctx.commands.execute('aka.recognition.round.start', input), binding)
          if (!value || value.roundRevision !== input.expectedRoundRevision + 1)
            throw new Error('Invalid round')
          if (!current()) return
          setView((v) => ({ ...v, settings, round: value, phase: 'ready' }))
        } else {
          if (activeRound.reserved >= Math.min(activeRound.budget, settings.settings.requestBudget))
            throw new Error('Budget exhausted')
          const input = Object.freeze({
            bindingRevision: binding.bindingRevision,
            configRevision,
            recognitionRevision: settings.configRevision,
            roundRevision: activeRound.roundRevision,
          })
          if (automatic && !running.current) {
            setView((v) => ({ ...v, phase: 'ready' }))
            return
          }
          submitted = true
          const result = checkedResult(
            await ctx.commands.execute('aka.recognition.test', input),
            binding,
            input,
          )
          if (!current()) return
          ctx.commands.completeEffect('aka.recognition.test', input)
          original.current = null
          setView((v) => ({ ...v, settings, round: undefined, result, phase: 'ready' }))
        }
      } catch {
        running.current = false
        setContinuous(false)
        if (submitted) uncertain.current = true
        try {
          original.current = ctx.commands.pendingEffect('aka.recognition.test')
          if (automatic && original.current) restorePending.current = true
        } catch {
          original.current = null
          uncertain.current = true
        }
        if (current()) setView((v) => ({ ...v, phase: submitted || uncertain.current ? 'unknown' : 'error' }))
      } finally {
        busy.current = false
        if (mounted.current) {
          try {
            original.current = ctx.commands.pendingEffect('aka.recognition.test')
          } catch {
            original.current = null
            uncertain.current = true
            setView((v) => ({ ...v, phase: 'unknown' }))
          }
        }
        if (mounted.current && epoch.current !== generation)
          setView((v) => ({ ...v, phase: uncertain.current ? 'unknown' : 'idle' }))
      }
    },
    [
      available,
      binding,
      configRevision,
      ctx,
      effectiveBudget,
      enabled,
      scope,
      sessionId,
      view.round,
      view.settings,
    ],
  )
  useEffect(() => {
    if (!restorePending.current || view.phase !== 'unknown' || !available() || busy.current) return
    restorePending.current = false
    // A reloaded page checks the same original receipt once, through the host's readback-only path.
    // It never creates a new recognition command or restarts continuous inference.
    void run('recover')
  }, [available, run, view.phase])
  useEffect(() => {
    if (!continuous) return
    if (!enabled || !available() || document.visibilityState === 'hidden' || uncertain.current) {
      running.current = false
      setContinuous(false)
      return
    }
    if (busy.current) return
    if (view.round === null || (view.round && view.round.reserved >= effectiveBudget)) {
      running.current = false
      setContinuous(false)
      return
    }
    if (view.phase !== 'ready') return
    // One image at a time; latency lowers achieved rate. Backend enforcement remains authoritative.
    const timer = setTimeout(
      () => void run(view.round === undefined ? 'read' : 'test', true),
      view.round === undefined ? 0 : 1000 / (view.settings?.settings?.frequency ?? 2),
    )
    return () => clearTimeout(timer)
  }, [continuous, available, effectiveBudget, enabled, run, view.phase, view.round, view.settings])
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        running.current = false
        resumeRecognition.current = false
        setContinuous(false)
      }
    }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [])
  const pending = view.phase === 'pending'
  const configured = view.settings?.settings?.provider === 'aliyun'
  const reason =
    pending || uncertain.current
      ? null
      : !view.settings
        ? 'readFirst'
        : !view.settings.settings
          ? 'configureFirst'
          : !configured
            ? 'localUnavailable'
            : view.round === undefined
              ? 'readFirst'
              : !view.round
                ? 'startFirst'
                : view.round.reserved >= effectiveBudget
                  ? 'exhausted'
                  : !enabled
                    ? 'cameraRequired'
                    : null
  return h(
    'section',
    { className: 'aka-recognition-control', 'aria-label': t('title'), 'aria-busy': pending },
    h(
      'div',
      { className: 'aka-recognition-toolbar' },
      h(
        'label',
        { className: 'aka-switch-field' },
        h('span', null, t('title')),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'aka-toggle',
            'aria-checked': continuous,
            disabled:
              !continuous &&
              (!available() ||
                !enabled ||
                pending ||
                uncertain.current ||
                (view.settings && !configured) ||
                (view.round && view.round.reserved >= effectiveBudget)),
            onClick: () => {
              if (continuous) {
                running.current = false
                resumeRecognition.current = false
                setContinuous(false)
                return
              }
              if (configured && view.round && view.round.reserved < effectiveBudget) {
                running.current = true
                resumeRecognition.current = true
                setContinuous(true)
              } else void run('enable')
            },
          },
          h('span', { 'aria-hidden': true }),
          h('span', { className: 'aka-sr-only' }, t(continuous ? 'continuousOff' : 'continuousOn')),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          disabled:
            !available() ||
            !enabled ||
            pending ||
            continuous ||
            uncertain.current ||
            (view.settings && !configured) ||
            (view.round && view.round.reserved >= effectiveBudget),
          'aria-describedby': reason ? reasonId : undefined,
          onClick: () =>
            void run(configured && view.round && view.round.reserved < effectiveBudget ? 'test' : 'sample'),
        },
        t('test'),
      ),
    ),
    continuous && h('p', { role: 'status' }, t('continuousRunning')),
    h(
      'details',
      { className: 'aka-advanced aka-budget-details' },
      h('summary', null, t('usage')),
      h(
        'button',
        { type: 'button', disabled: !available() || pending || continuous, onClick: () => void run('read') },
        t('read'),
      ),
      h(
        'button',
        {
          type: 'button',
          disabled:
            !available() ||
            pending ||
            continuous ||
            uncertain.current ||
            !configured ||
            view.round === undefined,
          onClick: () => void run('start'),
        },
        t('start'),
      ),
    ),
    view.round && h('p', null, `${t('usage')} ${view.round.reserved} / ${effectiveBudget}`),
    reason && view.settings && h('p', { id: reasonId }, t(reason)),
    uncertain.current &&
      original.current &&
      h(
        'button',
        {
          type: 'button',
          disabled: !available() || pending,
          onClick: () => void run('recover'),
        },
        t('recover'),
      ),
    ['pending', 'error', 'unknown', 'notStarted'].includes(view.phase) &&
      h('p', { role: ['error', 'unknown'].includes(view.phase) ? 'alert' : 'status' }, t(view.phase)),
    view.result &&
      available() &&
      h(RecognitionResult, {
        key: view.result.id,
        ctx,
        sessionId,
        result: view.result,
        binding,
        connectionRevision: configRevision,
      }),
  )
}
