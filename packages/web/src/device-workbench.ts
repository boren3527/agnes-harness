import { type DeviceSessionBinding, type DeviceSessionResult, validateMethod } from '@agnes/protocol'
import {
  type HostAgnesClient,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { DeviceWorkbenchShell } from '@agnes/web-units'
import { createElement } from 'react'

export interface DeviceWorkbenchMount {
  refresh(): Promise<void>
  dispose(): void
}

/** The shell owns enrollment/layout, while the device plugin owns connection and control UI.
 * An ordinary session in a device workspace never inherits another session's enrollment.
 */
export function mountDeviceWorkbench(options: {
  client: HostAgnesClient
  session: SessionService
  locale: LocaleService
  registry: SlotRegistry
  container: HTMLElement
  layout: HTMLElement
  onBindingChanged?(): void
}): DeviceWorkbenchMount {
  const { client, session, locale, registry, container, layout } = options
  const root = createAntdRoot(container)
  let disposed = false
  let generation = 0
  let online = client.connectionState === 'connected'
  let binding: Readonly<DeviceSessionBinding> | undefined
  let configurationBinding: Readonly<DeviceSessionBinding> | undefined
  let bindingWorkspace: DeviceSessionResult['workspace'] = null
  let rebinding = false
  let chatShare = 60
  let confirmation: Readonly<DeviceSessionBinding> | undefined
  let detaching = false
  let error: string | undefined
  let errorSession: string | undefined
  const t = (key: string) => locale.t(key)
  const setShare = (value: number) => {
    if (!Number.isFinite(value)) return
    chatShare = Math.max(35, Math.min(70, Math.round(value)))
    layout.style.setProperty('--device-chat-share', `${chatShare}fr`)
    layout.style.setProperty('--device-panel-share', `${100 - chatShare}fr`)
  }
  const render = () => {
    const visible =
      !disposed &&
      online &&
      ((binding !== undefined && binding.sessionId === session.sessionId) ||
        (error !== undefined && errorSession === session.sessionId))
    container.hidden = !visible
    layout.classList.toggle('has-device-workbench', visible)
    if (!visible) {
      root.render(null)
      return
    }
    const selected = binding
    const setupBinding = configurationBinding ?? (selected?.active ? undefined : selected)
    root.render(
      createElement(
        SlotsProvider,
        { registry, session, locale },
        createElement(
          DeviceWorkbenchShell,
          {
            key: selected?.sessionId ?? errorSession,
            title: t('device.workbench.title'),
            refreshLabel: t('device.workbench.refresh'),
            chatShareLabel: t('device.workbench.chatShare'),
            chatShare,
            onRefresh: () => void refresh(),
            onShare: setShare,
            error: error && errorSession === session.sessionId ? t(error) : undefined,
            ...(selected?.active && typeof client.device?.detachSession === 'function'
              ? {
                  detach: {
                    label: t('device.workbench.detach'),
                    description: t('device.workbench.detachDescription'),
                    cancelLabel: t('device.workbench.cancel'),
                    pendingLabel: t('device.workbench.detaching'),
                    open: confirmation === selected,
                    pending: detaching,
                    onOpen: () => {
                      if (!detaching) {
                        confirmation = selected
                        render()
                      }
                    },
                    onCancel: () => {
                      if (!detaching) {
                        confirmation = undefined
                        render()
                      }
                    },
                    onConfirm: () => void detach(selected),
                  },
                }
              : {}),
          },
          selected &&
            (selected.active ||
              (bindingWorkspace?.deviceId === selected.deviceId &&
                typeof client.device?.bindSession === 'function'))
            ? createElement(SlotOutlet<'workbench.device'>, {
                name: 'workbench.device',
                props: {
                  sessionId: selected.sessionId,
                  binding: setupBinding ?? selected,
                  ...(setupBinding
                    ? {
                        prepareConnection: () => prepareConnection(setupBinding),
                        connectionConfigured: () => {
                          if (
                            !disposed &&
                            session.sessionId === selected.sessionId &&
                            configurationBinding === setupBinding
                          ) {
                            configurationBinding = undefined
                            void refresh()
                          }
                        },
                      }
                    : {}),
                },
                fallback: createElement(
                  'p',
                  { className: 'device-workbench-empty', role: 'status' },
                  t('device.workbench.unavailable'),
                ),
                abdicateOnError: true,
              })
            : createElement(
                'div',
                { className: 'device-workbench-empty' },
                createElement(
                  'p',
                  { role: 'status' },
                  t(selected ? 'device.workbench.inactive' : 'device.workbench.lookupUnavailable'),
                ),
              ),
        ),
      ),
    )
  }
  async function prepareConnection(
    selected: Readonly<DeviceSessionBinding>,
  ): Promise<Readonly<DeviceSessionBinding>> {
    const workspace = bindingWorkspace
    if (
      disposed ||
      !online ||
      rebinding ||
      detaching ||
      (binding !== selected && configurationBinding !== selected) ||
      selected.active ||
      session.sessionId !== selected.sessionId ||
      !workspace ||
      !client.device?.bindSession
    )
      throw new Error('Device connection preparation unavailable')
    if (configurationBinding === selected && binding?.active) return binding
    if (workspace.deviceId !== selected.deviceId) throw new Error('Device connection preparation changed')
    const epoch = generation
    const current = () =>
      !disposed && online && generation === epoch && session.sessionId === selected.sessionId
    rebinding = true
    configurationBinding = selected
    try {
      const result = await client.device
        .bindSession(
          selected.sessionId,
          workspace.revision,
          workspace.active ? undefined : { replaceInactiveDevice: true },
        )
        .catch(async () => {
          // A lost reply may have committed. Inspect without repeating the mutation.
          return client.device.session(selected.sessionId)
        })
      const next = result.session
      const owner = result.workspace
      if (
        !validateMethod('_agnes/v1/device.session.bind', 'result', result).ok ||
        !next?.active ||
        !owner?.active ||
        next.sessionId !== selected.sessionId ||
        next.workspaceId !== selected.workspaceId ||
        owner.workspaceId !== selected.workspaceId ||
        next.deviceId !== owner.deviceId ||
        (workspace.active ? next.deviceId !== selected.deviceId : next.deviceId === selected.deviceId) ||
        owner.revision !== workspace.revision + (workspace.active ? 0 : 1) ||
        next.bindingRevision !== owner.revision
      )
        throw new Error('Invalid connection preparation result')
      if (!current()) throw new Error('Device connection preparation expired')
      binding = Object.freeze({ ...next })
      bindingWorkspace = owner
      options.onBindingChanged?.()
      render()
      return binding
    } finally {
      rebinding = false
    }
  }
  async function detach(selected: Readonly<DeviceSessionBinding>): Promise<void> {
    if (
      disposed ||
      !online ||
      detaching ||
      confirmation !== selected ||
      binding !== selected ||
      session.sessionId !== selected.sessionId ||
      !selected.active ||
      !client.device?.detachSession
    )
      return
    const epoch = generation
    detaching = true
    error = undefined
    errorSession = selected.sessionId
    render()
    const current = () =>
      !disposed && online && generation === epoch && session.sessionId === selected.sessionId
    try {
      const result = await client.device.detachSession(selected.sessionId, selected.bindingRevision)
      const workspace = result?.workspace
      const enrolled = result?.session
      if (
        !validateMethod('_agnes/v1/device.session.detach', 'result', result).ok ||
        !workspace ||
        !enrolled ||
        workspace.active ||
        enrolled.active ||
        workspace.workspaceId !== selected.workspaceId ||
        workspace.deviceId !== selected.deviceId ||
        workspace.revision !== selected.bindingRevision + 1 ||
        enrolled.sessionId !== selected.sessionId ||
        enrolled.workspaceId !== selected.workspaceId ||
        enrolled.deviceId !== selected.deviceId ||
        enrolled.bindingRevision !== selected.bindingRevision
      )
        throw new Error('Invalid detach result')
      if (!disposed) options.onBindingChanged?.()
      if (current()) {
        binding = Object.freeze({ ...enrolled })
        bindingWorkspace = workspace
        configurationBinding = undefined
        confirmation = undefined
      } else if (!disposed && online) await refresh()
    } catch {
      if (current()) {
        error = 'device.workbench.detachFailed'
        confirmation = undefined
        await refresh()
        if (!disposed && binding?.sessionId === selected.sessionId && !binding.active)
          options.onBindingChanged?.()
      }
    } finally {
      detaching = false
      if (!disposed) render()
    }
  }
  async function refresh(): Promise<void> {
    if (disposed) return
    const epoch = ++generation
    const id = session.sessionId
    confirmation = undefined
    binding = undefined
    configurationBinding = undefined
    bindingWorkspace = null
    render()
    if (disposed || !online || !id || !client.device?.session) return
    try {
      const result = await client.device.session(id)
      if (disposed || epoch !== generation || !online || session.sessionId !== id) return
      if (!validateMethod('_agnes/v1/device.session.get', 'result', result).ok) return
      const { workspace, session: enrolled } = result as DeviceSessionResult
      if (!enrolled) return
      if (enrolled.sessionId !== id || (workspace && workspace.workspaceId !== enrolled.workspaceId)) return
      if (
        enrolled.active &&
        (!workspace?.active ||
          workspace.deviceId !== enrolled.deviceId ||
          workspace.revision !== enrolled.bindingRevision)
      )
        return
      binding = Object.freeze({ ...enrolled })
      bindingWorkspace = workspace
      render()
    } catch {
      // An unavailable/old daemon cannot certify enrollment. Never expose the previous device.
    }
  }
  const stopSession = session.subscribe(() => void refresh())
  const stopLocale = locale.subscribe(render)
  const stops = [
    client.on('connectionStateChanged', () => {
      const next = client.connectionState === 'connected'
      if (next === online) return
      online = next
      void refresh()
    }),
    client.on('reconnected', () => {
      online = true
      void refresh()
    }),
    client.on('reconnecting', () => {
      online = false
      void refresh()
    }),
    client.on('closed', () => {
      online = false
      void refresh()
    }),
  ]
  setShare(chatShare)
  void refresh()
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      binding = undefined
      configurationBinding = undefined
      confirmation = undefined
      container.hidden = true
      layout.classList.remove('has-device-workbench')
      layout.style.removeProperty('--device-chat-share')
      layout.style.removeProperty('--device-panel-share')
      stopSession()
      stopLocale()
      for (const stop of stops) stop?.()
      root.unmount()
    },
  }
}
