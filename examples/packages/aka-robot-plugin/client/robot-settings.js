import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'

export function RobotSettings({ ctx, sessionId, binding, configRevision, kind, close }) {
  const id = useId(),
    dialog = useRef(null),
    busy = useRef(false)
  const [view, setView] = useState({ settings: null, pending: true, error: false, saved: false })
  const t = (key) => ctx.locale.t(`aka.robotSettings.${key}`)
  const title = ctx.locale.t(`aka.panel.${kind === 'speed' ? 'speedSettings' : 'armSettings'}`)
  const current = useRef(false)
  const input = { bindingRevision: binding.bindingRevision, configRevision }
  const checked = useCallback(
    (value) => {
      if (
        value?.deviceId !== binding.deviceId ||
        value.bindingRevision !== binding.bindingRevision ||
        value.configRevision !== configRevision ||
        !value.settings?.speed ||
        !value.settings?.arm ||
        !['zp10s', 'sts3215'].includes(value.settings.arm.driver)
      )
        throw new Error('Invalid settings')
      return value.settings
    },
    [binding.deviceId, binding.bindingRevision, configRevision],
  )
  useEffect(() => {
    current.current = true
    dialog.current.showModal()
    const invalidate = () => {
      current.current = false
      close()
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    void ctx.commands
      .execute('aka.settings.read', { bindingRevision: binding.bindingRevision, configRevision })
      .then(
        (value) => {
          if (current.current)
            setView({ settings: checked(value), pending: false, error: false, saved: false })
        },
        () => {
          if (current.current) setView({ settings: null, pending: false, error: true, saved: false })
        },
      )
      .catch(() => {
        if (current.current) setView({ settings: null, pending: false, error: true, saved: false })
      })
    return () => {
      current.current = false
      for (const stop of off) stop?.()
      dialog.current?.close()
    }
  }, [ctx, binding.bindingRevision, configRevision, close, checked])
  const fields = view.settings
    ? kind === 'speed'
      ? [
          ['speed.forward_speed', '前进速度 (%)', 100],
          ['speed.turn_speed', '转向速度 (%)', 100],
        ]
      : Object.entries(view.settings.arm.angles).flatMap(([key, value]) =>
          typeof value === 'object'
            ? Object.keys(value).map((servo) => [
                `arm.angles.${key}.${servo}`,
                `${key} · ${servo}`,
                view.settings.arm.driver === 'zp10s' ? 270 : 4095,
              ])
            : [[`arm.angles.${key}`, key, view.settings.arm.driver === 'zp10s' ? 270 : 4095]],
        )
    : []
  const at = (object, path) => path.split('.').reduce((value, key) => value[key], object)
  const edit = (path, value) => {
    const settings = structuredClone(view.settings)
    const keys = path.split('.'),
      key = keys.pop()
    at(settings, keys.join('.'))[key] = value
    setView({ ...view, settings, saved: false })
  }
  async function save(event) {
    event.preventDefault()
    if (
      busy.current ||
      view.pending ||
      !view.settings ||
      !current.current ||
      ctx.session.sessionId !== sessionId
    )
      return
    if (
      fields.some(
        ([path, , max]) =>
          !Number.isSafeInteger(at(view.settings, path)) ||
          at(view.settings, path) < 0 ||
          at(view.settings, path) > max,
      )
    )
      return
    busy.current = true
    setView((v) => ({ ...v, pending: true, saved: false, error: false }))
    try {
      const settings = checked(
        await ctx.commands.execute('aka.settings.save', { ...input, kind, settings: view.settings }),
      )
      if (current.current) setView({ settings, pending: false, saved: true, error: false })
    } catch {
      if (current.current) setView((v) => ({ ...v, pending: false, error: true }))
    } finally {
      busy.current = false
    }
  }
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'aka-recognition-dialog',
      'aria-labelledby': id,
      onCancel: () => close(),
      onClose: () => close(),
    },
    h('h2', { id }, title),
    h('p', null, t('hint')),
    kind === 'arm' &&
      view.settings &&
      h('p', null, t('unit') + (view.settings.arm.driver === 'zp10s' ? '度 (0–270)' : '位置刻度 (0–4095)')),
    h(
      'form',
      { onSubmit: save },
      fields.map(([path, label, max]) =>
        h(
          'label',
          { key: path },
          label,
          h('input', {
            name: path,
            type: 'number',
            min: 0,
            max,
            step: 1,
            required: true,
            disabled: view.pending,
            value: at(view.settings, path),
            onChange: (event) =>
              edit(path, event.currentTarget.value === '' ? '' : Number(event.currentTarget.value)),
          }),
        ),
      ),
      h('button', { type: 'submit', disabled: view.pending || !view.settings || view.error }, t('save')),
    ),
    view.pending && h('p', { role: 'status' }, t('loading')),
    view.saved && h('p', { role: 'status' }, t('saved')),
    view.error && h('p', { role: 'alert' }, t('error')),
    h('button', { type: 'button', onClick: close }, t('close')),
  )
}
