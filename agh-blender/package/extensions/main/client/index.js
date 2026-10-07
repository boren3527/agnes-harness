// agh-blender client panel: shows whether a managed Blender instance is running for this workspace.
//
// Contract facts this file relies on (all verified in the harness source):
//   - slots.register(id, component, options) needs a React component; React comes from the host
//     import map (packages/web-client/src/externals.ts), so it is imported, never bundled twice.
//   - a client module may only call services named in its descriptor's `services` allow-list
//     (packages/web-client/src/client-module.ts).
//   - client services need an active session; before one exists the call fails with
//     "client service requires an active session", which this panel renders as plain text.

import { createElement, useCallback, useEffect, useState } from 'react'

export function apply(ctx, config) {
  const label = config?.publicConfig?.label ?? 'Blender'
  const services = ctx.agnes.services

  function Panel() {
    const [view, setView] = useState({ phase: 'loading' })

    const load = useCallback(async () => {
      try {
        const result = await services.call('blender.status', {})
        setView({ phase: 'ok', data: result?.data ?? result })
      } catch (error) {
        setView({ phase: 'error', message: String(error?.message ?? error) })
      }
    }, [])

    useEffect(() => {
      void load()
    }, [load])

    const instance = view.phase === 'ok' ? view.data?.instance ?? null : null
    const line = (() => {
      if (view.phase === 'loading') return 'checking…'
      if (view.phase === 'error') return view.message
      if (!instance) return 'no Blender instance for this workspace'
      return `pid ${instance.pid} · port ${instance.port} · ${instance.alive ? 'running' : 'gone'} · ${instance.blenderVersion ?? ''}`
    })()

    return createElement(
      'div',
      { style: { padding: '6px 8px', fontSize: '12px', lineHeight: 1.6 } },
      createElement('div', null, `${label} · ${line}`),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => void load(),
          style: { marginTop: '4px', fontSize: '11px' },
        },
        'refresh',
      ),
    )
  }

  ctx.slots.register('workbench.panel', Panel, { id: 'agh-blender-panel' })
  ctx.slots.register('shell.overlay', Panel, { id: 'agh-blender-overlay' })
}
