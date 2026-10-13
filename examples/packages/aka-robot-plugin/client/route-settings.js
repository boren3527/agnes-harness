import { createElement as h } from 'react'

const row = () => ({ action: 'up', speed: '30', milliseconds: '1000' })
export function routeForm(routes) {
  const rows = (steps) =>
    steps?.map((s) => ({ ...s, speed: String(s.speed), milliseconds: String(s.milliseconds) })) ?? [row()]
  return {
    patrolEnabled: !!routes?.patrol,
    deliveryEnabled: !!routes?.delivery,
    steps: rows(routes?.patrol?.steps),
    returnSteps: rows(routes?.patrol?.returnSteps),
    homeLabels: routes?.patrol?.homeLabels.join(',') ?? '',
    deliverySteps: rows(routes?.delivery?.steps),
    destinationLabels: routes?.delivery?.destinationLabels.join(',') ?? '',
  }
}
export function savedRoutes(form) {
  const labels = (s) =>
    s
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
  const steps = (list) =>
    list.map((s) => ({ action: s.action, speed: Number(s.speed), milliseconds: Number(s.milliseconds) }))
  return form.patrolEnabled || form.deliveryEnabled
    ? {
        ...(form.patrolEnabled
          ? {
              patrol: {
                steps: steps(form.steps),
                returnSteps: steps(form.returnSteps),
                homeLabels: labels(form.homeLabels),
              },
            }
          : {}),
        ...(form.deliveryEnabled
          ? {
              delivery: {
                steps: steps(form.deliverySteps),
                destinationLabels: labels(form.destinationLabels),
              },
            }
          : {}),
      }
    : undefined
}
export function RouteSettings({ value, change, disabled, t }) {
  const edit = (key, next) => change({ ...value, [key]: next })
  const rows = (key, label, max) =>
    h(
      'fieldset',
      { disabled },
      h('legend', null, label),
      value[key].map((step, index) =>
        h(
          'div',
          { key: index },
          h(
            'label',
            null,
            `${label} ${index + 1} ${t('routeAction')}`,
            h(
              'select',
              {
                name: `${key}.${index}.action`,
                value: step.action,
                onChange: (e) =>
                  edit(
                    key,
                    value[key].map((s, i) => (i === index ? { ...s, action: e.currentTarget.value } : s)),
                  ),
              },
              ['up', 'down', 'left', 'right'].map((action) =>
                h('option', { key: action, value: action }, t(`route_${action}`)),
              ),
            ),
          ),
          ['speed', 'milliseconds'].map((field) =>
            h(
              'label',
              { key: field },
              t(`route_${field}`),
              h('input', {
                name: `${key}.${index}.${field}`,
                type: 'number',
                min: field === 'speed' ? 30 : 500,
                max: field === 'speed' ? 50 : 3000,
                step: 1,
                required: true,
                value: step[field],
                onChange: (e) =>
                  edit(
                    key,
                    value[key].map((s, i) => (i === index ? { ...s, [field]: e.currentTarget.value } : s)),
                  ),
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: value[key].length <= 1,
              'aria-label': `${label} ${index + 1} ${t('routeRemove')}`,
              onClick: () =>
                edit(
                  key,
                  value[key].filter((_, i) => i !== index),
                ),
            },
            t('routeRemove'),
          ),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: value[key].length >= max,
          onClick: () => edit(key, [...value[key], row()]),
        },
        t('routeAdd'),
      ),
    )
  const text = (key, label) =>
    h(
      'label',
      null,
      label,
      h('input', {
        name: key,
        required: true,
        value: value[key],
        onChange: (e) => edit(key, e.currentTarget.value),
      }),
    )
  return h(
    'fieldset',
    { disabled },
    h('legend', null, t('routeTitle')),
    h('p', null, t('routeHint')),
    ['patrol', 'delivery'].map((kind) =>
      h(
        'label',
        { key: kind },
        h('input', {
          type: 'checkbox',
          name: `${kind}RouteEnabled`,
          checked: value[`${kind}Enabled`],
          onChange: (e) => edit(`${kind}Enabled`, e.currentTarget.checked),
        }),
        t(`route_${kind}`),
      ),
    ),
    value.patrolEnabled &&
      h(
        'div',
        null,
        rows('steps', t('routeOutbound'), 12 - value.returnSteps.length),
        rows('returnSteps', t('routeReturn'), 12 - value.steps.length),
        text('homeLabels', t('routeHome')),
      ),
    value.deliveryEnabled &&
      h(
        'div',
        null,
        rows('deliverySteps', t('routeDelivery'), 12),
        text('destinationLabels', t('routeDestination')),
      ),
  )
}
