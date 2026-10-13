import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'

export function ManualControl({ ctx, sessionId, binding, configRevision, enabled, onStatus }) {
  const prefix = useId(),
    epoch = useRef(0),
    alive = useRef(false),
    busy = useRef(false),
    stopBusy = useRef(false),
    refreshStatus = useRef(null)
  const [speed, setSpeed] = useState('30'),
    [duration, setDuration] = useState('1000')
  const [pending, setPending] = useState(false),
    [stopping, setStopping] = useState(false)
  const [task, setTask] = useState(null)
  const [snapshot, setSnapshot] = useState(null),
    [message, setMessage] = useState(null)
  const t = (key) => ctx.locale.t(`aka.manual.${key}`)
  const valid = useCallback(
    () => alive.current && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === 'connected',
    [ctx, sessionId],
  )
  useEffect(() => {
    alive.current = true
    let timer,
      polling = true,
      reading = false
    const generation = ++epoch.current
    const poll = async () => {
      if (!valid() || !enabled || !polling || reading || generation !== epoch.current) return
      reading = true
      clearTimeout(timer)
      try {
        const result = await ctx.agnes.services.call('aka.status', {})
        if (!polling || !valid() || generation !== epoch.current) return
        if (
          result?.deviceId !== binding.deviceId ||
          result.enrollment !== 'active' ||
          result.configRevision !== configRevision
        )
          throw new Error('Device changed')
        onStatus?.(result)
        setSnapshot(result.runtime ?? null)
        setTask(result.task ?? null)
      } catch {
        if (polling && generation === epoch.current) setSnapshot(null)
      } finally {
        reading = false
        if (polling && valid() && enabled && generation === epoch.current) timer = setTimeout(poll, 500)
      }
    }
    refreshStatus.current = poll
    const invalidate = () => {
      epoch.current++
      setSnapshot(null)
      setTask(null)
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    void poll()
    return () => {
      polling = false
      if (refreshStatus.current === poll) refreshStatus.current = null
      alive.current = false
      epoch.current++
      clearTimeout(timer)
      for (const fn of off) fn?.()
    }
  }, [ctx, valid, binding.deviceId, configRevision, enabled, onStatus])
  async function act(action) {
    const stop = action === 'stop'
    if (!valid() || !enabled || (stop ? stopBusy.current : busy.current)) return
    const nSpeed = Number(speed),
      nDuration = Number(duration)
    if (
      !stop &&
      (!/^\d+$/.test(speed) ||
        !/^\d+$/.test(duration) ||
        !Number.isSafeInteger(nSpeed) ||
        nSpeed < 30 ||
        nSpeed > 50 ||
        !Number.isSafeInteger(nDuration) ||
        nDuration < 500 ||
        nDuration > 3000)
    ) {
      setMessage('invalid')
      return
    }
    const generation = epoch.current
    if (stop) {
      stopBusy.current = true
      setStopping(true)
    } else {
      busy.current = true
      setPending(true)
    }
    setMessage(null)
    try {
      const result = await ctx.commands.execute(stop ? 'aka.control.stop' : 'aka.control.action', {
        bindingRevision: binding.bindingRevision,
        configRevision,
        action,
        speed: stop ? 1 : nSpeed,
        milliseconds: stop ? 1 : nDuration,
      })
      if (!valid() || generation !== epoch.current) return
      if (
        result?.deviceId !== binding.deviceId ||
        result.bindingRevision !== binding.bindingRevision ||
        result.configRevision !== configRevision ||
        result.action !== action ||
        result.physicalResult !== 'unverified' ||
        !['completed', 'acknowledged', 'sent'].includes(result.state)
      )
        throw new Error('Unverified receipt')
      setMessage(stop ? 'stopReceipt' : result.state === 'sent' ? 'sent' : 'receipt')
      void refreshStatus.current?.()
    } catch {
      if (valid() && generation === epoch.current) setMessage('unknown')
    } finally {
      if (stop) {
        stopBusy.current = false
        if (alive.current) setStopping(false)
      } else {
        busy.current = false
        if (alive.current) setPending(false)
      }
    }
  }
  const motionEnabled =
    enabled &&
    valid() &&
    snapshot?.connection === 'connected' &&
    snapshot?.control?.phase === 'idle' &&
    !pending &&
    !stopping
  const wheel = (side) => {
    const report = snapshot?.wheels
    return report && report.ageMs <= 1500 && Number.isFinite(report[side])
      ? `${report[side]} cm/s`
      : t('unavailable')
  }
  const button = (action, label) =>
    h('button', { type: 'button', disabled: !motionEnabled, onClick: () => void act(action) }, t(label))
  return h(
    'section',
    { className: 'aka-manual-control', 'aria-labelledby': `${prefix}-title` },
    task &&
      h(
        'div',
        { className: 'aka-task-status', role: 'status' },
        h(
          'p',
          null,
          `${t('task')}: ${t(`task_${task.phase}`)} · ${task.completedViews}/${task.requestedViews}`,
        ),
        task.kind === 'search' &&
          h(
            'p',
            null,
            `${(task.targetLabels ?? []).join(' / ')} · ${t(task.targetFound ? 'targetFound' : task.phase === 'completed' ? 'targetAbsent' : 'targetSearching')}`,
          ),
        task.outcome && h('p', null, t(`outcome_${task.outcome}`)),
        task.gripEvidence && h('p', null, t(`grip_${task.gripEvidence}`)),
        task.stage && h('p', null, t(`stage_${task.stage}`)),
        task.homeEvidence && h('p', null, t(`home_${task.homeEvidence}`)),
        task.viewpoints?.length > 0 &&
          h(
            'p',
            null,
            `${t('viewpoints')}: ${task.viewpoints.map((view) => `${view.index}: ${Math.round(view.angleDegrees)}° ±${view.uncertaintyDegrees.toFixed(1)}°`).join(' · ')}`,
          ),
        !task.endedAt &&
          h(
            'button',
            {
              type: 'button',
              onClick: async () => {
                try {
                  await ctx.commands.execute('aka.task.cancel', { taskId: task.taskId })
                } catch {
                  if (valid()) setMessage('error')
                }
              },
            },
            t('cancelTask'),
          ),
      ),
    h('h3', { id: `${prefix}-title` }, t('title')),

    h(
      'dl',
      { className: 'aka-telemetry' },
      h('dt', null, t('leftWheel')),
      h('dd', null, wheel('leftCmPerSecond')),
      h('dt', null, t('rightWheel')),
      h('dd', null, wheel('rightCmPerSecond')),
      h('dt', null, t('phase')),
      h('dd', null, t(snapshot?.control?.phase ?? 'unavailable')),
    ),
    h(
      'details',
      { className: 'aka-manual-settings' },
      h('summary', null, t('parameters')),
      h(
        'label',
        { htmlFor: `${prefix}-speed` },
        t('speed'),
        h('input', {
          id: `${prefix}-speed`,
          name: 'manualSpeed',
          type: 'number',
          min: 30,
          max: 50,
          step: 1,
          value: speed,
          disabled: pending || stopping,
          onChange: (e) => setSpeed(e.currentTarget.value),
        }),
      ),
      h(
        'label',
        { htmlFor: `${prefix}-duration` },
        t('duration'),
        h('input', {
          id: `${prefix}-duration`,
          name: 'manualDuration',
          type: 'number',
          min: 500,
          max: 3000,
          step: 1,
          value: duration,
          disabled: pending || stopping,
          onChange: (e) => setDuration(e.currentTarget.value),
        }),
      ),
    ),
    h(
      'div',
      { className: 'aka-direction-pad' },
      button('up', 'up'),
      button('left', 'left'),
      h(
        'button',
        {
          type: 'button',
          className: 'aka-stop',
          disabled: !enabled || !valid() || stopping,
          onClick: () => void act('stop'),
        },
        t('stop'),
      ),
      button('right', 'right'),
      button('down', 'down'),
    ),
    h('div', { className: 'aka-device-actions' }, button('grab', 'grab'), button('release', 'release')),
    (pending || stopping) && h('p', { role: 'status' }, t(stopping ? 'stopping' : 'pending')),
    message &&
      h('p', { role: message === 'unknown' || message === 'invalid' ? 'alert' : 'status' }, t(message)),
  )
}
