import {
  createElement as h,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { CaptureControl } from './capture-control.js'
import { catalog } from './catalog.js'
import { GroundSettings } from './ground-settings.js'
import { ManualControl } from './manual-control.js'
import { createMediaPlayer } from './media-player.js'
import { RecognitionControl } from './recognition-control.js'
import { RecognitionSettings } from './recognition-settings.js'
import { RobotSettings } from './robot-settings.js'

const commands = {
  probe: 'aka.pair.probe',
  connect: 'aka.pair.connect',
  disconnect: 'aka.pair.disconnect',
  camera: 'aka.pair.camera',
  capture: 'aka.capture.photo',
}

function validEndpoint(ip, port) {
  if (typeof ip !== 'string' || !Number.isSafeInteger(port) || port < 1 || port > 65535) return false
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255))
    return false
  const [a, b] = parts.map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function AkaVideo({ ctx, sessionId, binding, configRevision, enabled }) {
  const canvas = useRef(null)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState('videoIdle')
  const [failure, setFailure] = useState(null)
  const t = (key) => ctx.locale.t(`aka.panel.${key}`)
  const playbackId = `${binding.deviceId}:${binding.bindingRevision}:${configRevision}:${attempt}`
  const playback = useRef(playbackId)
  playback.current = playbackId
  useEffect(() => {
    if (!enabled || !canvas.current) return
    let active = true
    const valid = () =>
      active &&
      playback.current === playbackId &&
      ctx.session.sessionId === sessionId &&
      ctx.agnes.connectionState === 'connected'
    const stop = createMediaPlayer({
      origin: window.location.origin,
      rowId: ctx.module.rowId,
      sessionId,
      deviceId: binding.deviceId,
      configRevision,
      bindingRevision: binding.bindingRevision,
      ticket: (input) => ctx.agnes.services.call('aka.media.ticket', input),
      valid,
      canvas: canvas.current,
      state: (value) => {
        if (active) {
          if (value !== 'videoError') setFailure(null)
          setPhase(value)
        }
      },
      error: (value) => {
        if (active) setFailure(value)
      },
    })
    const invalidate = () => {
      active = false
      stop()
      setPhase('videoIdle')
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    return () => {
      active = false
      stop()
      for (const release of off) release?.()
    }
  }, [ctx, sessionId, binding.deviceId, binding.bindingRevision, configRevision, enabled, playbackId])
  return h(
    'div',
    { className: 'aka-live-video' },
    h('canvas', { ref: canvas, role: 'img', 'aria-label': t('videoAlt'), hidden: phase !== 'videoLive' }),
    phase !== 'videoLive' &&
      h(
        'div',
        { className: 'aka-video-placeholder', role: 'status' },
        h('span', { className: 'aka-video-mark', 'aria-hidden': true }, 'CAM'),
        h('strong', null, t(enabled ? phase : 'cameraIdle')),
        h('span', null, t(enabled && phase === 'videoError' && failure ? failure : 'previewHint')),
      ),
    h(
      'div',
      { className: 'aka-video-caption' },
      h('span', null, 'LIVE CAMERA'),
      h('span', null, phase === 'videoLive' ? t('videoLive') : t('videoIdle')),
    ),
    enabled &&
      phase === 'videoError' &&
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            setAttempt((value) => value + 1)
          },
        },
        t('startVideo'),
      ),
  )
}

/** Browser data is display/input only; daemon/Host enforce identity, revisions and authorization. */
export function AkaDevicePanel({ ctx, sessionId, binding, prepareConnection, connectionConfigured }) {
  const prefix = useId()
  const canPrepare = typeof prepareConnection === 'function'
  const [groundOpen, setGroundOpen] = useState(false)
  const closeGround = useCallback(() => setGroundOpen(false), [])
  const [settingsOpen, setSettingsOpen] = useState(null)
  const closeSettings = useCallback(() => setSettingsOpen(null), [])
  const [recognitionOpen, setRecognitionOpen] = useState(false)
  const [recognitionVersion, setRecognitionVersion] = useState(0)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const recognitionSaved = useCallback(() => setRecognitionVersion((value) => value + 1), [])
  const receiveStatus = useCallback(
    (status) =>
      setView((old) => (old.profile?.configRevision === status.configRevision ? { ...old, status } : old)),
    [],
  )
  const closeRecognition = useCallback(() => setRecognitionOpen(false), [])
  useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
  const t = (key) => ctx.locale.t(`aka.panel.${key}`)
  const [view, setView] = useState({
    ready: false,
    phase: 'loading',
    ip: '',
    port: '80',
    profile: null,
    status: null,
    probe: null,
    error: null,
  })
  const generation = useRef(0)
  const mounted = useRef(false)
  const busy = useRef(false)
  const available = useCallback(
    () => mounted.current && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === 'connected',
    [ctx, sessionId],
  )
  const current = useCallback((epoch) => available() && generation.current === epoch, [available])
  const identityMatches = useCallback(
    (result) =>
      result && result.deviceId === binding.deviceId && result.bindingRevision === binding.bindingRevision,
    [binding.deviceId, binding.bindingRevision],
  )

  const load = useCallback(async () => {
    if (!available()) return
    if (!binding.active) {
      generation.current++
      setView({
        ready: canPrepare,
        phase: 'idle',
        ip: '',
        port: '80',
        profile: null,
        status: null,
        probe: null,
        error: null,
      })
      return
    }
    if (busy.current) return
    const epoch = ++generation.current
    setView((old) => ({ ...old, phase: 'loading', probe: null, error: null }))
    try {
      if (!ctx.agnes.device?.connection) throw new Error('Configuration unavailable')
      const result = await ctx.agnes.device.connection(sessionId)
      if (!current(epoch)) return
      if (!identityMatches(result)) throw new Error('Configuration changed')
      // A new device has no runtime to inspect. Its form must not depend on robot status.
      const status = result.profile ? await ctx.agnes.services.call('aka.status', {}) : null
      if (!current(epoch)) return
      if (
        result.profile &&
        (status?.deviceId !== binding.deviceId ||
          status.enrollment !== 'active' ||
          status.configRevision !== result.profile.configRevision)
      )
        throw new Error('Configuration changed')
      setView({
        ready: true,
        phase: 'idle',
        profile: result.profile,
        status,
        probe: null,
        error: null,
        ip: result.profile?.ip ?? '',
        port: String(result.profile?.port ?? 80),
      })
    } catch {
      if (current(epoch)) setView((old) => ({ ...old, ready: false, phase: 'idle', error: 'failure' }))
    }
  }, [available, current, ctx, identityMatches, sessionId, binding.deviceId, binding.active, canPrepare])

  useEffect(() => {
    mounted.current = true
    const invalidate = () => {
      generation.current++
      setView((old) => ({
        ...old,
        ready: false,
        phase: 'idle',
        profile: ctx.session.sessionId === sessionId ? old.profile : null,
        status: null,
        probe: null,
        error: 'unavailable',
      }))
    }
    const stops = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('reconnecting', invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnected', () => {
        invalidate()
        if (!busy.current) void load()
      }),
    ]
    void load()
    return () => {
      mounted.current = false
      generation.current++
      for (const stop of stops) stop?.()
    }
  }, [ctx, load, sessionId])

  function edit(field, value) {
    if (!available() || (busy.current && view.phase !== 'probe')) return
    generation.current++
    setView((old) => ({ ...old, [field]: value, probe: null, error: null }))
  }

  async function run(action) {
    if (!available() || busy.current || !view.ready) return
    const ip = view.ip.trim()
    const port = /^\d{1,5}$/.test(view.port) ? Number(view.port) : NaN
    if (['probe', 'save', 'pair'].includes(action) && !validEndpoint(ip, port)) {
      setView((old) => ({ ...old, error: 'invalid', probe: null }))
      return
    }
    let profile = view.profile
    let operationBinding = binding
    if (!binding.active && action !== 'pair') return
    if (!['probe', 'save', 'pair'].includes(action) && !profile) return
    if (action === 'save' && !view.probe) return
    const epoch = generation.current
    busy.current = true
    setView((old) => ({ ...old, phase: action, error: null }))
    try {
      if (!binding.active) {
        operationBinding = await prepareConnection()
        if (!current(epoch)) return
        if (
          !operationBinding?.active ||
          operationBinding.sessionId !== sessionId ||
          operationBinding.workspaceId !== binding.workspaceId
        )
          throw new Error('Connection preparation changed')
        const saved = await ctx.agnes.device.connection(sessionId)
        if (!current(epoch)) return
        if (
          saved?.deviceId !== operationBinding.deviceId ||
          saved.bindingRevision !== operationBinding.bindingRevision
        )
          throw new Error('Connection configuration changed')
        profile = saved.profile
      }
      const matchesOperation = (result) =>
        result?.deviceId === operationBinding.deviceId &&
        result.bindingRevision === operationBinding.bindingRevision
      let result
      if (action === 'probe' || action === 'pair') {
        const expectedConfigRevision = profile?.configRevision ?? 0
        result = await ctx.commands.execute(commands.probe, {
          ip,
          port,
          bindingRevision: operationBinding.bindingRevision,
          expectedConfigRevision,
        })
        if (!current(epoch)) return
        if (
          !matchesOperation(result) ||
          result.ip !== ip ||
          result.port !== port ||
          result.expectedConfigRevision !== expectedConfigRevision ||
          result.identity !== 'reported' ||
          typeof result.macAddress !== 'string' ||
          !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(result.macAddress)
        )
          throw new Error('Invalid probe')
        setView((old) => ({ ...old, probe: Object.freeze({ ...result }) }))
        if (action === 'pair') {
          const savedResult = await ctx.agnes.device.saveConnection({
            sessionId,
            expectedBindingRevision: operationBinding.bindingRevision,
            expectedConfigRevision,
            ip,
            port,
            macAddress: result.macAddress,
          })
          if (!current(epoch)) return
          const saved = savedResult?.profile
          if (
            !matchesOperation(savedResult) ||
            saved?.driver !== 'aka-00' ||
            saved.ip !== ip ||
            saved.port !== port ||
            saved.macAddress !== result.macAddress ||
            ![expectedConfigRevision, expectedConfigRevision + 1].includes(saved.configRevision)
          )
            throw new Error('Invalid save result')
          if (binding.active) {
            setView((old) => ({ ...old, profile: saved, status: null, probe: null }))
            setConnectionOpen(false)
          }
          await ctx.commands.execute(commands.connect, { configRevision: saved.configRevision })
          if (!current(epoch)) return
          await ctx.commands.execute(commands.camera, { configRevision: saved.configRevision, open: true })
          if (!current(epoch)) return
          const status = await ctx.agnes.services.call('aka.status', {})
          if (!current(epoch)) return
          if (
            status?.deviceId !== operationBinding.deviceId ||
            status.enrollment !== 'active' ||
            status.configRevision !== saved.configRevision
          )
            throw new Error('Device state changed')
          setView((old) => ({ ...old, status }))
          if (!binding.active) connectionConfigured?.()
        }
      } else if (action === 'save') {
        const probe = view.probe
        if (probe.ip !== ip || probe.port !== port || !identityMatches(probe))
          throw new Error('Probe changed')
        result = await ctx.agnes.device.saveConnection({
          sessionId,
          expectedBindingRevision: binding.bindingRevision,
          expectedConfigRevision: probe.expectedConfigRevision,
          ip,
          port,
          macAddress: probe.macAddress,
        })
        if (!current(epoch)) return
        const saved = result?.profile
        if (
          !identityMatches(result) ||
          saved?.driver !== 'aka-00' ||
          saved.ip !== ip ||
          saved.port !== port ||
          saved.macAddress !== probe.macAddress ||
          ![probe.expectedConfigRevision, probe.expectedConfigRevision + 1].includes(saved.configRevision)
        )
          throw new Error('Invalid save result')
        setView((old) => ({ ...old, profile: saved, status: null, probe: null }))
      } else {
        const input = { configRevision: profile.configRevision }
        if (action === 'camera-open' || action === 'camera-close') input.open = action === 'camera-open'
        await ctx.commands.execute(
          action.startsWith('camera-')
            ? commands.camera
            : commands[action === 'recover' ? 'connect' : action],
          input,
        )
        if (!current(epoch)) return
        if (action === 'recover') {
          await ctx.commands.execute(commands.camera, { configRevision: profile.configRevision, open: true })
          if (!current(epoch)) return
        }
        // Read current backend state rather than treating an effect receipt as a live snapshot.
        const status = await ctx.agnes.services.call('aka.status', {})
        if (!current(epoch)) return
        if (
          status?.deviceId !== binding.deviceId ||
          status.enrollment !== 'active' ||
          status.configRevision !== profile.configRevision
        )
          throw new Error('Device state changed')
        setView((old) => ({ ...old, status, probe: null }))
      }
    } catch {
      if (current(epoch))
        setView((old) => ({
          ...old,
          probe: null,
          error: 'failure',
        }))
    } finally {
      busy.current = false
      if (available()) setView((old) => ({ ...old, phase: 'idle' }))
    }
  }

  const pending = view.phase !== 'idle'
  const enabled = available() && view.ready && !pending
  const runtime = view.status?.runtime
  const connected = runtime?.connection === 'connected'
  const connectionLabel = {
    idle: 'notConnected',
    connecting: 'connecting',
    connected: 'connected',
    degraded: 'degraded',
    disposed: 'disposed',
  }
  const errorId = `${prefix}-error`
  const field = (name, label, value, extra = {}) =>
    h(
      'label',
      { htmlFor: `${prefix}-${name}` },
      t(label),
      h('input', {
        id: `${prefix}-${name}`,
        name,
        value,
        required: true,
        disabled: !view.ready || (pending && view.phase !== 'probe'),
        'aria-describedby': view.error ? errorId : `${prefix}-hint`,
        'aria-invalid': view.error === 'invalid',
        onChange: (event) => edit(name, event.currentTarget.value),
        ...extra,
      }),
    )
  const button = (label, action, disabled = !enabled) =>
    h('button', { type: 'button', disabled, onClick: () => void run(action) }, t(label))
  const connectionForm = h(
    'div',
    { className: 'aka-connection-card' },
    h('span', { className: 'aka-eyebrow' }, 'DEVICE CONNECTION'),
    h('h3', { id: `${prefix}-title` }, t('newConnection')),
    h('p', { id: `${prefix}-hint` }, t('connectionHint')),
    h(
      'form',
      {
        onSubmit: (event) => {
          event.preventDefault()
          void run('pair')
        },
      },
      field('ip', 'ip', view.ip, {
        placeholder: '192.168.43.232',
        inputMode: 'decimal',
        autoComplete: 'off',
        maxLength: 15,
      }),
      field('port', 'port', view.port, { inputMode: 'numeric', autoComplete: 'off', maxLength: 5 }),
      h(
        'button',
        { type: 'submit', className: 'aka-primary', disabled: !enabled },
        t(pending ? 'pending' : 'pair'),
      ),
    ),
    h(
      'details',
      { className: 'aka-advanced' },
      h('summary', null, t('connectionAdvanced')),
      binding.active && button('probe', 'probe'),
      h(
        'button',
        { type: 'button', disabled: pending || !available(), onClick: () => void load() },
        t('refresh'),
      ),
      view.probe &&
        h(
          'div',
          { className: 'aka-pairing-confirmation' },
          h('p', null, `${t('identity')}: ${view.probe.macAddress}`),
          button('save', 'save'),
        ),
    ),
    view.profile &&
      h('button', { type: 'button', onClick: () => setConnectionOpen(false) }, t('backConsole')),
  )
  return h(
    'section',
    {
      className: `aka-device-panel ${binding.active && view.profile && !connectionOpen ? 'aka-console' : 'aka-onboarding'}`,
      'aria-label': t('title'),
      'aria-busy': pending,
    },
    view.error && h('p', { id: errorId, className: 'aka-notice', role: 'alert' }, t(view.error)),
    pending &&
      h(
        'p',
        { role: 'status', className: 'aka-progress' },
        t(view.phase === 'loading' ? 'loading' : 'pending'),
      ),
    !binding.active || !view.profile || connectionOpen
      ? connectionForm
      : h(
          'div',
          { className: 'aka-console-body' },
          h(
            'header',
            { className: 'aka-console-header' },
            h(
              'div',
              null,
              h('span', { className: 'aka-eyebrow' }, 'ROBOT CONSOLE'),
              h('h3', { id: `${prefix}-title` }, `${view.profile.ip}:${view.profile.port}`),
            ),
            h(
              'div',
              { className: 'aka-console-header-actions' },
              h(
                'span',
                { className: `aka-connection-status ${connected ? 'is-connected' : ''}` },
                t(connectionLabel[runtime?.connection] ?? 'notConnected'),
              ),
              (!connected || runtime?.media === 'error') && button('recover', 'recover', !enabled),
              h(
                'button',
                { type: 'button', disabled: !available(), onClick: () => setRecognitionOpen(true) },
                ctx.locale.t('aka.recognition.title'),
              ),
            ),
          ),
          h(AkaVideo, {
            key: `${view.profile.configRevision}:${runtime?.mediaGeneration ?? 0}`,
            ctx,
            sessionId,
            binding,
            configRevision: view.profile.configRevision,
            enabled: connected && ['opening', 'streaming'].includes(runtime?.media),
          }),
          h(
            'div',
            { className: 'aka-camera-toolbar' },
            h(
              'label',
              { className: 'aka-switch-field' },
              h('span', null, t('camera')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aka-toggle',
                  role: 'switch',
                  'aria-label': t('camera'),
                  'aria-checked': connected && ['opening', 'streaming'].includes(runtime?.media),
                  disabled: !enabled || !connected,
                  onClick: () =>
                    void run(
                      ['opening', 'streaming'].includes(runtime?.media) ? 'camera-close' : 'camera-open',
                    ),
                },
                h('span', { 'aria-hidden': true }),
              ),
            ),
            h(CaptureControl, {
              key: `capture:${sessionId}:${binding.deviceId}:${binding.bindingRevision}`,
              ctx,
              sessionId,
              binding,
              configRevision: view.profile.configRevision,
              enabled: enabled && connected && runtime?.media === 'streaming',
            }),
          ),
          h(RecognitionControl, {
            key: `recognition:${sessionId}:${binding.deviceId}:${binding.bindingRevision}`,
            ctx,
            sessionId,
            binding,
            configRevision: view.profile.configRevision,
            settingsVersion: recognitionVersion,
            enabled: connected && runtime?.media === 'streaming',
          }),
          h(
            'div',
            { className: 'aka-control-tools' },
            h('strong', null, t('controls')),
            h(
              'div',
              { className: 'aka-device-actions' },
              h(
                'button',
                { type: 'button', disabled: !connected || pending, onClick: () => setSettingsOpen('speed') },
                t('speedSettings'),
              ),
              h(
                'button',
                { type: 'button', disabled: !connected || pending, onClick: () => setSettingsOpen('arm') },
                t('armSettings'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !connected || !runtime?.frame || pending,
                  onClick: () => setGroundOpen(true),
                },
                ctx.locale.t('aka.ground.title'),
              ),
            ),
          ),
          h(ManualControl, {
            key: `manual:${sessionId}:${binding.deviceId}:${binding.bindingRevision}:${view.profile.configRevision}`,
            ctx,
            sessionId,
            binding,
            configRevision: view.profile.configRevision,
            enabled: view.ready,
            onStatus: receiveStatus,
          }),
          h(
            'details',
            { className: 'aka-advanced' },
            h('summary', null, t('connectionDetails')),
            h(
              'p',
              { className: 'aka-saved-state' },
              `${t('saved')}: ${view.profile.ip}:${view.profile.port}`,
            ),
            h(
              'div',
              { className: 'aka-device-actions' },
              button('connect', 'connect', !enabled || connected),
              button('disconnect', 'disconnect', !enabled || !connected),
              button(
                'openCamera',
                'camera-open',
                !enabled || !connected || ['opening', 'streaming'].includes(runtime?.media),
              ),
              button('closeCamera', 'camera-close', !enabled || !connected || runtime?.cameraOn === false),
              h(
                'button',
                { type: 'button', disabled: pending, onClick: () => setConnectionOpen(true) },
                t('editConnection'),
              ),
              h(
                'button',
                { type: 'button', disabled: pending || !available(), onClick: () => void load() },
                t('refresh'),
              ),
            ),
          ),
        ),
    recognitionOpen &&
      h(RecognitionSettings, { ctx, sessionId, binding, close: closeRecognition, onSaved: recognitionSaved }),
    groundOpen &&
      view.profile &&
      runtime?.frame &&
      h(GroundSettings, {
        ctx,
        sessionId,
        binding,
        configRevision: view.profile.configRevision,
        frame: runtime.frame,
        close: closeGround,
      }),
    settingsOpen &&
      view.profile &&
      h(RobotSettings, {
        ctx,
        sessionId,
        binding,
        configRevision: view.profile.configRevision,
        kind: settingsOpen,
        close: closeSettings,
      }),
  )
}

export function apply(ctx) {
  const off = ctx.locale.register('@agnes-examples/aka-robot-plugin', catalog)
  ctx.effect(() => off)
  for (const [action, service] of [
    ['probe', 'aka.probe'],
    ['connect', 'aka.connect'],
    ['disconnect', 'aka.disconnect'],
    ['camera', 'aka.camera.set'],
    ['capture', 'aka.capture'],
  ])
    ctx.commands.registerEffect({
      id: commands[action],
      service,
      ...(action === 'capture' ? { retainOperation: true, persistCapture: true } : {}),
    })
  for (const service of [
    'aka.control.action',
    'aka.control.stop',
    'aka.settings.read',
    'aka.settings.save',
    'aka.task.cancel',
    'aka.geometry.save',
    'aka.modeling.settings.save',
  ])
    ctx.commands.registerEffect({ id: service, service })
  for (const service of ['aka.recognition.round.read', 'aka.recognition.round.start', 'aka.recognition.test'])
    ctx.commands.registerEffect({
      id: service,
      service,
      retainOperation: service !== 'aka.recognition.round.read',
      ...(service === 'aka.recognition.test' ? { persistCapture: true } : {}),
    })
  ctx.slots.register({ name: 'workbench.device', id: 'aka-device', priority: 10 }, (props) =>
    h(AkaDevicePanel, { ...props, ctx }),
  )
}
