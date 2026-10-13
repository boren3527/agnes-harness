import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { RouteSettings, routeForm, savedRoutes } from './route-settings.js'

const motionFields = [
  'speed',
  'milliseconds',
  'forwardMeters',
  'leftDegrees',
  'rightDegrees',
  'marginMeters',
  'marginDegrees',
  'minimumStandoff',
  'turningClearance',
  'lateralTolerance',
  'maximumVisionError',
]
const sampleFields = ['forwardMeters', 'leftDegrees', 'rightDegrees']
const motionRanges = {
  speed: [30, 50, 1],
  milliseconds: [500, 3000, 1],
  marginMeters: [0.001, 0.05, 0.001],
  marginDegrees: [0.1, 5, 0.1],
  minimumStandoff: [0.05, 2, 0.01],
  turningClearance: [0.15, 2, 0.01],
  lateralTolerance: [0.01, 0.15, 0.001],
  maximumVisionError: [0.001, 0.05, 0.001],
}
const blankMotion = () =>
  Object.fromEntries(
    motionFields.map((key) => [key, key === 'speed' ? '30' : key === 'milliseconds' ? '1000' : '']),
  )
const graspFields = [
  'forwardMin',
  'forwardMax',
  'lateralTolerance',
  'settleMilliseconds',
  'heldBox',
  'releaseBox',
]
const blankGrasp = () =>
  Object.fromEntries(graspFields.map((key) => [key, key === 'settleMilliseconds' ? '5000' : '']))
const blank = (count) => Array.from({ length: count }, () => ({ u: '', v: '', x: '', y: '' }))
export function GroundSettings({ ctx, sessionId, binding, configRevision, frame, close }) {
  const id = useId(),
    dialog = useRef(null),
    active = useRef(false),
    busy = useRef(false)
  const [view, setView] = useState({
    pending: true,
    error: false,
    saved: false,
    revision: 0,
    width: frame.width,
    height: frame.height,
    installation: '',
    labels: '',
    measurementErrorMeters: '0.01',
    points: blank(6),
    checks: blank(3),
    motionEnabled: false,
    motion: blankMotion(),
    graspEnabled: false,
    grasp: blankGrasp(),
    routes: routeForm(),
  })
  const t = (key) => ctx.locale.t(`aka.ground.${key}`)
  useEffect(() => {
    active.current = true
    dialog.current.showModal()
    const invalidate = () => {
      active.current = false
      close()
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on('closed', invalidate),
      ctx.agnes.on('reconnecting', invalidate),
    ]
    void ctx.agnes.services
      .call('aka.geometry.read', { bindingRevision: binding.bindingRevision, configRevision })
      .then(
        (c) => {
          if (active.current)
            setView((v) =>
              c
                ? {
                    ...v,
                    pending: false,
                    revision: c.revision,
                    routes: routeForm(c.routes),
                    graspEnabled: !!c.grasp,
                    grasp: c.grasp
                      ? Object.fromEntries(
                          graspFields.map((key) => [
                            key,
                            Array.isArray(c.grasp[key]) ? c.grasp[key].join(',') : String(c.grasp[key]),
                          ]),
                        )
                      : blankGrasp(),
                    motionEnabled: !!c.motion,
                    motion: c.motion
                      ? Object.fromEntries(
                          motionFields.map((key) => [
                            key,
                            Array.isArray(c.motion[key]) ? c.motion[key].join(',') : String(c.motion[key]),
                          ]),
                        )
                      : blankMotion(),
                    width: c.width,
                    height: c.height,
                    installation: c.installation,
                    labels: c.labels.join(','),
                    points: c.points,
                    checks: c.checks,
                    measurementErrorMeters: String(c.measurementErrorMeters),
                  }
                : { ...v, pending: false },
            )
        },
        () => {
          if (active.current) setView((v) => ({ ...v, pending: false, error: true }))
        },
      )
    return () => {
      active.current = false
      for (const stop of off) stop?.()
      dialog.current?.close()
    }
  }, [ctx, binding.bindingRevision, configRevision, close])
  const edit = (key, value) => setView((v) => ({ ...v, [key]: value, saved: false }))
  async function save(event) {
    event.preventDefault()
    if (busy.current || view.pending || !active.current || ctx.session.sessionId !== sessionId) return
    busy.current = true
    setView((v) => ({ ...v, pending: true, saved: false, error: false }))
    try {
      const routes = savedRoutes(view.routes)
      const c = await ctx.commands.execute('aka.geometry.save', {
        bindingRevision: binding.bindingRevision,
        configRevision,
        expectedRevision: view.revision,
        calibration: {
          ...(routes ? { routes } : {}),
          ...(view.graspEnabled
            ? {
                grasp: Object.fromEntries(
                  graspFields.map((key) => [
                    key,
                    key.endsWith('Box')
                      ? view.grasp[key].split(',').map((v) => (v.trim() ? Number(v) : NaN))
                      : Number(view.grasp[key]),
                  ]),
                ),
              }
            : {}),
          ...(view.motionEnabled
            ? {
                motion: Object.fromEntries(
                  motionFields.map((key) => [
                    key,
                    sampleFields.includes(key)
                      ? view.motion[key].split(',').map((v) => (v.trim() ? Number(v) : NaN))
                      : Number(view.motion[key]),
                  ]),
                ),
              }
            : {}),
          width: view.width,
          height: view.height,
          installation: view.installation,
          labels: view.labels
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean),
          measurementErrorMeters: Number(view.measurementErrorMeters),
          points: view.points.map((p) =>
            Object.fromEntries(Object.entries(p).map(([k, value]) => [k, Number(value)])),
          ),
          checks: view.checks.map((p) =>
            Object.fromEntries(Object.entries(p).map(([k, value]) => [k, Number(value)])),
          ),
        },
      })
      if (active.current)
        setView((v) => ({
          ...v,
          revision: c.revision,
          observedError: c.observedErrorMeters,
          pending: false,
          saved: true,
        }))
    } catch {
      if (active.current) setView((v) => ({ ...v, pending: false, error: true }))
    } finally {
      busy.current = false
    }
  }
  const table = (name, label) =>
    h(
      'fieldset',
      { disabled: view.pending },
      h('legend', null, label),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['u', 'v', 'x', 'y'].map((key) => h('th', { key, scope: 'col' }, t(key))),
          ),
        ),
        h(
          'tbody',
          null,
          view[name].map((point, row) =>
            h(
              'tr',
              { key: row },
              ['u', 'v', 'x', 'y'].map((key) =>
                h(
                  'td',
                  { key },
                  h('input', {
                    type: 'number',
                    name: `${name}.${row}.${key}`,
                    required: true,
                    step: 'any',
                    'aria-label': `${label} ${row + 1} ${t(key)}`,
                    value: point[key],
                    onChange: (e) =>
                      edit(
                        name,
                        view[name].map((p, index) =>
                          index === row ? { ...p, [key]: e.currentTarget.value } : p,
                        ),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    )
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
    h('p', null, `${view.width} × ${view.height}`),
    h(
      'form',
      { onSubmit: save },
      h(
        'label',
        null,
        t('installation'),
        h('input', {
          name: 'groundInstallation',
          required: true,
          maxLength: 128,
          disabled: view.pending,
          value: view.installation,
          onChange: (e) => edit('installation', e.currentTarget.value),
        }),
      ),
      h(
        'label',
        null,
        t('labels'),
        h('input', {
          name: 'groundLabels',
          required: true,
          disabled: view.pending,
          value: view.labels,
          onChange: (e) => edit('labels', e.currentTarget.value),
        }),
      ),
      h(
        'label',
        null,
        t('error'),
        h('input', {
          name: 'groundError',
          type: 'number',
          min: 0.001,
          max: 0.5,
          step: 0.001,
          required: true,
          disabled: view.pending,
          value: view.measurementErrorMeters,
          onChange: (e) => edit('measurementErrorMeters', e.currentTarget.value),
        }),
      ),
      table('points', t('points')),
      table('checks', t('checks')),
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          name: 'motionEnabled',
          checked: view.motionEnabled,
          disabled: view.pending,
          onChange: (e) => edit('motionEnabled', e.currentTarget.checked),
        }),
        t('motionEnabled'),
      ),
      view.motionEnabled &&
        h(
          'fieldset',
          { disabled: view.pending },
          h('legend', null, t('motionTitle')),
          h('p', null, t('motionHint')),
          motionFields.map((key) =>
            h(
              'label',
              { key },
              t(`motion_${key}`),
              h('input', {
                name: `motion.${key}`,
                required: true,
                value: view.motion[key],
                type: sampleFields.includes(key) ? 'text' : 'number',
                ...(motionRanges[key]
                  ? {
                      min: motionRanges[key][0],
                      max: motionRanges[key][1],
                      step: key === 'speed' || key === 'milliseconds' ? 1 : 'any',
                    }
                  : {}),
                onChange: (e) => edit('motion', { ...view.motion, [key]: e.currentTarget.value }),
              }),
            ),
          ),
        ),
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          name: 'graspEnabled',
          checked: view.graspEnabled,
          disabled: view.pending,
          onChange: (e) => edit('graspEnabled', e.currentTarget.checked),
        }),
        t('graspEnabled'),
      ),
      view.graspEnabled &&
        h(
          'fieldset',
          { disabled: view.pending },
          h('legend', null, t('graspTitle')),
          h('p', null, t('graspHint')),
          graspFields.map((key) =>
            h(
              'label',
              { key },
              t(`grasp_${key}`),
              h('input', {
                name: `grasp.${key}`,
                required: true,
                value: view.grasp[key],
                type: key.endsWith('Box') ? 'text' : 'number',
                step: key === 'settleMilliseconds' ? 1 : 'any',
                onChange: (e) => edit('grasp', { ...view.grasp, [key]: e.currentTarget.value }),
              }),
            ),
          ),
        ),
      h(RouteSettings, {
        value: view.routes,
        change: (routes) => edit('routes', routes),
        disabled: view.pending,
        t,
      }),
      h('button', { type: 'submit', disabled: view.pending }, t('save')),
    ),
    view.saved && h('p', { role: 'status' }, `${t('saved')} ${(view.observedError * 100).toFixed(1)} cm`),
    view.error && h('p', { role: 'alert' }, t('failed')),
    h('button', { type: 'button', onClick: close }, t('close')),
  )
}
