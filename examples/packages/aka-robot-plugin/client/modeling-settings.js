import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'

export const defaultGenerator = {
  generator: 'TripoSR',
  command: [
    'python',
    '<TripoSR目录>/run.py',
    '{image}',
    '--output-dir',
    '{out}',
    '--model-save-format',
    'glb',
  ],
  upAxis: '<填写实际轴向 X/Y/Z>',
  unit: 'normalised',
}
export function ModelingSettings({ ctx, sessionId, binding, close }) {
  const id = useId(),
    dialog = useRef(null),
    active = useRef(false),
    busy = useRef(false)
  const closeRef = useRef(close)
  closeRef.current = close
  const bindingRevision = binding.bindingRevision
  const [view, setView] = useState({
    pending: true,
    error: '',
    saved: false,
    executable: '',
    height: '0.3',
    generator: JSON.stringify(defaultGenerator, null, 2),
  })
  const t = useCallback((key) => ctx.locale.t(`aka.modeling.${key}`), [ctx])
  useEffect(() => {
    active.current = true
    dialog.current.showModal()
    const invalidate = () => {
      active.current = false
      closeRef.current()
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    void ctx.agnes.services.call('aka.modeling.settings.read', { bindingRevision }).then(
      (config) => {
        if (!active.current) return
        if (config) {
          const { blenderExecutable = '', displayHeight, ...generator } = config
          setView((v) => ({
            ...v,
            pending: false,
            executable: blenderExecutable,
            height: String(displayHeight),
            generator: JSON.stringify(generator, null, 2),
          }))
        } else setView((v) => ({ ...v, pending: false }))
      },
      () => {
        if (active.current) setView((v) => ({ ...v, pending: false, error: t('loadError') }))
      },
    )
    return () => {
      active.current = false
      for (const stop of off) stop()
    }
  }, [ctx, bindingRevision, t])
  const edit = (key, value) => setView((v) => ({ ...v, [key]: value, saved: false, error: '' }))
  async function save(event) {
    event.preventDefault()
    if (busy.current || !active.current || ctx.session.sessionId !== sessionId) return
    busy.current = true
    setView((v) => ({ ...v, pending: true, saved: false, error: '' }))
    try {
      const config = {
        ...JSON.parse(view.generator),
        displayHeight: Number(view.height),
        ...(view.executable.trim() ? { blenderExecutable: view.executable.trim() } : {}),
      }
      await ctx.commands.execute('aka.modeling.settings.save', {
        bindingRevision: binding.bindingRevision,
        config,
      })
      if (active.current) setView((v) => ({ ...v, pending: false, saved: true }))
    } catch (error) {
      if (active.current)
        setView((v) => ({
          ...v,
          pending: false,
          error: error instanceof Error ? error.message : t('saveError'),
        }))
    } finally {
      busy.current = false
    }
  }
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'aka-recognition-dialog aka-ground-dialog',
      'aria-labelledby': id,
      onCancel: close,
      onClose: close,
    },
    h('h2', { id }, t('title')),
    h('p', null, t('hint')),
    h(
      'form',
      { onSubmit: save },
      h(
        'label',
        null,
        t('executable'),
        h('input', {
          name: 'blenderExecutable',
          value: view.executable,
          disabled: view.pending,
          maxLength: 4096,
          placeholder: t('autoDiscover'),
          onChange: (e) => edit('executable', e.currentTarget.value),
        }),
      ),
      h(
        'label',
        null,
        t('height'),
        h('input', {
          name: 'displayHeight',
          type: 'number',
          min: 0.01,
          max: 10,
          step: 'any',
          required: true,
          value: view.height,
          disabled: view.pending,
          onChange: (e) => edit('height', e.currentTarget.value),
        }),
      ),
      h(
        'label',
        null,
        t('generator'),
        h('textarea', {
          name: 'modelingGenerator',
          rows: 12,
          required: true,
          maxLength: 60000,
          value: view.generator,
          disabled: view.pending,
          onChange: (e) => edit('generator', e.currentTarget.value),
        }),
      ),
      h('p', null, t('placeholders')),
      view.error && h('p', { role: 'alert' }, view.error),
      view.saved && h('p', { role: 'status' }, t('saved')),
      h(
        'div',
        { className: 'aka-device-actions' },
        h('button', { type: 'submit', disabled: view.pending }, t('save')),
        h('button', { type: 'button', onClick: close }, t('close')),
      ),
    ),
  )
}
