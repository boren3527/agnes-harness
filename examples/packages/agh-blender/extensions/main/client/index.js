// agh-blender client panel: what the managed Blender instance for this workspace is doing.
//
// Contract facts this file relies on (all verified in the harness source):
//   - slots.register(id, component, options) needs a React component; React comes from the host
//     import map (packages/web-client/src/externals.ts), so it is imported, never bundled twice.
//   - a client module may only call services named in its descriptor's `services` allow-list
//     (packages/web-client/src/client-module.ts).
//   - client services need an active session; before one exists the call fails with
//     "client service requires an active session". The panel subscribes to session opening.
//
// The panel reports two independent things, and it says which one failed rather than collapsing
// them: whether the instance process is alive (pid), and what the scene currently holds (read back
// over the bridge by the service). A bridge read can fail while the process is fine, and that
// distinction is the difference between "Blender died" and "the bridge did not answer".

import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export function apply(ctx, config) {
  const label = config?.publicConfig?.label ?? 'Blender'
  const services = ctx.agnes.services

  const line = (text, muted) =>
    createElement('div', { style: muted ? { color: '#8a8a8a' } : undefined }, text)

  function Panel() {
    const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
    const pending = useRef(0)
    const [view, setView] = useState({ phase: 'loading' })
    const [checkedAt, setCheckedAt] = useState(null)

    const load = useCallback(async () => {
      const request = ++pending.current
      setCheckedAt(null)
      if (!sessionId) {
        setView({ phase: 'idle' })
        return
      }
      setView({ phase: 'loading' })
      const current = () => pending.current === request && ctx.session.sessionId === sessionId
      try {
        const result = await services.call('blender.status', {})
        if (!current()) return
        setView({ phase: 'ok', data: result?.data ?? result })
        setCheckedAt(new Date().toLocaleTimeString())
      } catch (error) {
        if (!current()) return
        setView({ phase: 'error', message: String(error?.message ?? error) })
      }
    }, [sessionId])

    useEffect(() => {
      void load()
      return () => {
        pending.current++
      }
    }, [load])

    const data = view.phase === 'ok' ? view.data : null
    const instance = data?.instance ?? null
    const scene = data?.scene ?? null

    const status = (() => {
      if (view.phase === 'idle') return 'select a session'
      if (view.phase === 'loading') return 'checking…'
      if (view.phase === 'error') return view.message
      if (!instance) return 'no instance for this workspace'
      if (!instance.alive) return `pid ${instance.pid} · gone (records kept)`
      return `pid ${instance.pid} · port ${instance.port} · running · ${instance.blenderVersion ?? ''}`
    })()

    const sceneLine = (() => {
      if (view.phase !== 'ok' || !instance || !instance.alive) return null
      if (data.sceneError) return `scene unreadable: ${data.sceneError}`
      if (!scene) return 'scene: no readback'
      return `scene "${scene.scene}" · ${scene.objectCount} objects · ${scene.meshCount} meshes · ${scene.materialCount} materials · ${scene.knownOps} ops`
    })()

    return createElement(
      'div',
      { style: { padding: '6px 8px', fontSize: '12px', lineHeight: 1.6 } },
      line(`${label} · ${status}`),
      sceneLine ? line(sceneLine, true) : null,
      checkedAt ? line(`checked ${checkedAt}`, true) : null,
      createElement(
        'button',
        {
          type: 'button',
          disabled: !sessionId,
          onClick: () => void load(),
          style: { marginTop: '4px', fontSize: '11px' },
        },
        'refresh',
      ),
    )
  }

  ctx.slots.register('workbench.panel', Panel, { id: 'agh-blender-panel' })
}
