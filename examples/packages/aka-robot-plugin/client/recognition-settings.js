import { createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'

/** Only accept the public, redacted configuration contract; never render an error payload. */
export function checked(value, binding) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'bindingRevision,configRevision,deviceId,settings' ||
    value.deviceId !== binding.deviceId ||
    value.bindingRevision !== binding.bindingRevision ||
    !Number.isSafeInteger(value.configRevision) ||
    value.configRevision < 0
  )
    throw new Error('Invalid settings')
  const s = value.settings
  if (s !== null) {
    if (
      !s ||
      !['aliyun', 'local-yolo'].includes(s.provider) ||
      ![0.5, 1, 2].includes(s.frequency) ||
      !Number.isSafeInteger(s.requestBudget) ||
      s.requestBudget < 1 ||
      s.requestBudget > 100000 ||
      typeof s.credentialConfigured !== 'boolean' ||
      (s.provider === 'aliyun' && !s.credentialConfigured) ||
      Object.keys(s).sort().join(',') !==
        (s.provider === 'aliyun'
          ? 'credentialConfigured,frequency,provider,requestBudget'
          : 'baseUrl,credentialConfigured,frequency,provider,requestBudget') ||
      (s.provider === 'local-yolo' && (typeof s.baseUrl !== 'string' || s.baseUrl.length > 2048))
    )
      throw new Error('Invalid settings')
  }
  return value
}

/** Native modal dialog supplies focus containment/Escape; no custom keyboard trap or secret persistence. */
export function RecognitionSettings({ ctx, sessionId, binding, close, onSaved }) {
  const id = useId()
  const { deviceId, bindingRevision } = binding
  const dialog = useRef(null)
  const form = useRef(null)
  const epoch = useRef(0)
  const alive = useRef(false)
  const busy = useRef(false)
  const [view, setView] = useState({
    ready: false,
    pending: false,
    saved: false,
    error: null,
    provider: 'aliyun',
    frequency: '2',
    requestBudget: '3600',
    baseUrl: '',
    action: 'replace',
    current: null,
  })
  const t = (key) => ctx.locale.t(`aka.recognition.${key}`)
  const available = useCallback(
    () =>
      alive.current &&
      binding.active &&
      ctx.session.sessionId === sessionId &&
      ctx.agnes.connectionState === 'connected',
    [ctx, sessionId, binding.active],
  )
  const clearSecrets = useCallback(() => {
    for (const input of form.current?.querySelectorAll('input[type="password"]') ?? []) input.value = ''
  }, [])
  const dismiss = () => {
    epoch.current++
    clearSecrets()
    close()
  }
  useEffect(() => {
    alive.current = true
    dialog.current.showModal()
    const invalidate = () => {
      epoch.current++
      clearSecrets()
      close()
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    return () => {
      alive.current = false
      epoch.current++
      clearSecrets()
      dialog.current?.close()
      for (const stop of off) stop?.()
    }
  }, [ctx, close, clearSecrets])
  useEffect(() => {
    if (!binding.active) {
      epoch.current++
      clearSecrets()
      close()
    }
  }, [binding.active, clearSecrets, close])
  const load = useCallback(
    async (force = false) => {
      if (!available() || (busy.current && !force)) return
      busy.current = true
      const revision = ++epoch.current
      setView((old) => ({ ...old, ready: false, pending: true, saved: false, error: null }))
      clearSecrets()
      try {
        if (!ctx.agnes.device?.recognition) throw new Error('Unavailable')
        const result = checked(await ctx.agnes.device.recognition(sessionId), { deviceId, bindingRevision })
        if (!available() || epoch.current !== revision) return
        const s = result.settings
        setView({
          ready: true,
          pending: false,
          saved: false,
          error: null,
          current: result,
          provider: s?.provider ?? 'aliyun',
          frequency: String(s?.frequency ?? 2),
          requestBudget: String(s?.requestBudget ?? 3600),
          baseUrl: s?.baseUrl ?? '',
          action: s?.credentialConfigured ? 'keep' : s?.provider === 'local-yolo' ? 'clear' : 'replace',
        })
      } catch {
        if (available() && epoch.current === revision)
          setView((old) => ({ ...old, ready: false, pending: false, error: 'readFailure' }))
      } finally {
        if (epoch.current === revision) busy.current = false
      }
    },
    [available, ctx, sessionId, deviceId, bindingRevision, clearSecrets],
  )
  useEffect(() => {
    void load(true)
  }, [load])
  function edit(name, value) {
    if (!available() || busy.current || !view.ready) return
    if (name === 'provider') {
      clearSecrets()
      setView((old) => ({
        ...old,
        provider: value,
        saved: false,
        error: null,
        action:
          old.current?.settings?.provider === value && old.current.settings.credentialConfigured
            ? 'keep'
            : value === 'local-yolo'
              ? 'clear'
              : 'replace',
      }))
    } else {
      if (name === 'action') clearSecrets()
      setView((old) => ({ ...old, [name]: value, saved: false, error: null }))
    }
  }
  async function save(event) {
    event.preventDefault()
    if (!available() || busy.current || view.pending || !view.ready || !view.current) return
    const data = new FormData(form.current)
    const frequency = Number(view.frequency)
    const requestBudget = /^\d{1,6}$/.test(view.requestBudget) ? Number(view.requestBudget) : NaN
    const printable = (value, max) =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      [...value].every((c) => c.charCodeAt(0) >= 33 && c.charCodeAt(0) <= 126)
    let credentials = { action: view.action }
    if (view.action === 'replace')
      credentials =
        view.provider === 'aliyun'
          ? {
              action: 'replace',
              accessKeyId: data.get('accessKeyId'),
              accessKeySecret: data.get('accessKeySecret'),
            }
          : { action: 'replace', token: data.get('token') }
    if (
      ![0.5, 1, 2].includes(frequency) ||
      !Number.isSafeInteger(requestBudget) ||
      requestBudget < 1 ||
      requestBudget > 100000 ||
      (view.provider === 'local-yolo' && !view.baseUrl.trim()) ||
      (view.action === 'keep' &&
        (view.current.settings?.provider !== view.provider || !view.current.settings.credentialConfigured)) ||
      (view.action === 'replace' &&
        (view.provider === 'aliyun'
          ? !printable(credentials.accessKeyId, 256) || !printable(credentials.accessKeySecret, 256)
          : !printable(credentials.token, 4096)))
    ) {
      clearSecrets()
      setView((old) => ({ ...old, saved: false, error: 'invalid' }))
      return
    }
    const input = {
      sessionId,
      expectedBindingRevision: binding.bindingRevision,
      expectedConfigRevision: view.current.configRevision,
      settings: {
        provider: view.provider,
        frequency,
        requestBudget,
        credentials,
        ...(view.provider === 'local-yolo' ? { baseUrl: view.baseUrl.trim() } : {}),
      },
    }
    for (const key of ['accessKeyId', 'accessKeySecret', 'token']) data.delete(key)
    clearSecrets()
    busy.current = true
    const revision = ++epoch.current
    setView((old) => ({ ...old, pending: true, saved: false, error: null }))
    try {
      if (!ctx.agnes.device?.saveRecognition) throw new Error('Unavailable')
      const result = checked(await ctx.agnes.device.saveRecognition(input), binding)
      if (!available() || epoch.current !== revision) return
      if (
        !result.settings ||
        result.settings.provider !== input.settings.provider ||
        result.configRevision < input.expectedConfigRevision ||
        result.settings.frequency !== frequency ||
        result.settings.requestBudget !== requestBudget
      )
        throw new Error('Changed settings')
      onSaved?.(result)
      setView((old) => ({
        ...old,
        current: result,
        ready: true,
        pending: false,
        saved: true,
        action: result.settings.credentialConfigured ? 'keep' : 'clear',
        baseUrl: result.settings.baseUrl ?? '',
      }))
    } catch {
      if (available() && epoch.current === revision)
        setView((old) => ({ ...old, ready: false, pending: false, saved: false, error: 'saveFailure' }))
    } finally {
      busy.current = false
      // Do not retain credentials in a component/request object after RPC settlement.
      for (const key of Object.keys(credentials)) if (key !== 'action') credentials[key] = ''
    }
  }
  const canKeep =
    view.current?.settings?.provider === view.provider && view.current.settings.credentialConfigured
  const disabled = !view.ready || view.pending || !available()
  const label = (name, text, child) => h('label', { htmlFor: `${id}-${name}` }, t(text), child)
  const select = (name, items) =>
    h(
      'select',
      {
        id: `${id}-${name}`,
        name,
        value: view[name],
        disabled,
        onChange: (e) => edit(name, e.currentTarget.value),
      },
      ...items.map(([value, text]) => h('option', { key: value, value }, t(text))),
    )
  const input = (name, text, extra = {}) =>
    label(
      name,
      text,
      h('input', {
        id: `${id}-${name}`,
        name,
        disabled,
        'aria-describedby': `${id}-hint${view.error ? ` ${id}-error` : ''}`,
        'aria-invalid': view.error === 'invalid',
        ...extra,
      }),
    )
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'aka-recognition-dialog',
      'aria-labelledby': `${id}-title`,
      onCancel: (e) => {
        e.preventDefault()
        dismiss()
      },
    },
    h('h3', { id: `${id}-title` }, t('title')),
    h('p', { id: `${id}-hint` }, t('hint')),
    view.pending && h('p', { role: 'status' }, t('pending')),
    view.error && h('p', { id: `${id}-error`, role: 'alert' }, t(view.error)),
    view.current?.settings &&
      h(
        'div',
        { className: 'aka-saved-state', role: 'status' },
        h('strong', null, t(view.saved ? 'saved' : 'configured')),
        h(
          'span',
          null,
          `${t(view.current.settings.provider === 'aliyun' ? 'cloud' : 'local')} · ${view.current.settings.frequency} Hz · ${view.current.settings.requestBudget}`,
        ),
      ),
    h(
      'form',
      { ref: form, onSubmit: save, 'aria-busy': view.pending },
      label(
        'provider',
        'provider',
        select('provider', [
          ['aliyun', 'cloud'],
          ['local-yolo', 'local'],
        ]),
      ),
      h('p', null, t(view.provider === 'aliyun' ? 'cloudHint' : 'localHint')),
      view.provider === 'aliyun' &&
        h(
          'details',
          { className: 'aka-advanced' },
          h('summary', null, 'DetectObject · cn-shanghai'),
          h('dt', null, t('endpoint')),
          h('dd', null, 'objectdet.cn-shanghai.aliyuncs.com'),
          h('dt', null, t('region')),
          h('dd', null, 'cn-shanghai'),
          h('dt', null, t('apiVersion')),
          h('dd', null, '2019-12-30 / DetectObject'),
        ),
      label(
        'frequency',
        'frequency',
        select('frequency', [
          ['0.5', 'halfHz'],
          ['1', 'oneHz'],
          ['2', 'twoHz'],
        ]),
      ),
      input('requestBudget', 'budget', {
        value: view.requestBudget,
        inputMode: 'numeric',
        maxLength: 6,
        onChange: (e) => edit('requestBudget', e.currentTarget.value),
      }),
      view.provider === 'local-yolo' &&
        input('baseUrl', 'baseUrl', {
          value: view.baseUrl,
          maxLength: 2048,
          autoComplete: 'off',
          onChange: (e) => edit('baseUrl', e.currentTarget.value),
        }),
      label(
        'action',
        'credentials',
        select('action', [
          ...(canKeep ? [['keep', 'keep']] : []),
          ['replace', 'replace'],
          ...(view.provider === 'local-yolo' ? [['clear', 'noToken']] : []),
        ]),
      ),
      view.action === 'replace' &&
        (view.provider === 'aliyun'
          ? h(
              'div',
              null,
              input('accessKeyId', 'accessKeyId', {
                type: 'password',
                autoComplete: 'new-password',
                maxLength: 256,
              }),
              input('accessKeySecret', 'accessKeySecret', {
                type: 'password',
                autoComplete: 'new-password',
                maxLength: 256,
              }),
            )
          : input('token', 'token', { type: 'password', autoComplete: 'new-password', maxLength: 4096 })),
      h('button', { type: 'submit', className: 'aka-primary', disabled }, t('save')),
    ),
    h(
      'div',
      { className: 'aka-device-actions' },
      h(
        'button',
        { type: 'button', disabled: view.pending || !available(), onClick: () => void load() },
        t('refresh'),
      ),
      h('button', { type: 'button', onClick: dismiss }, t('close')),
    ),
  )
}
