/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { DeviceSessionResult } from '@agnes/protocol'
import {
  type DeviceWorkbenchProps,
  type HostAgnesClient,
  LocaleService,
  SessionService,
  SlotRegistry,
} from '@agnes/web-client'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountDeviceWorkbench } from '../src/device-workbench.js'
import { WEB_LOCALE_NAMESPACE, webLocaleCatalog } from '../src/locale-catalog.js'

const association = (sessionId: string, active = true) => ({
  workspace: {
    workspaceId: 'a'.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    active,
  },
  session: {
    sessionId,
    workspaceId: 'a'.repeat(64),
    deviceId: '11111111-1111-4111-8111-111111111111',
    bindingRevision: 1,
    active,
  },
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  document.body.replaceChildren()
})
async function setup(
  lookup: (id: string) => Promise<DeviceSessionResult>,
  detach?: (id: string, revision: number) => Promise<DeviceSessionResult>,
  initialState: 'connecting' | 'connected' = 'connected',
  bind?: (id: string, revision: number) => Promise<DeviceSessionResult>,
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  const session = new SessionService(ctx)
  const locale = new LocaleService(ctx, 'zh-CN')
  locale.register(WEB_LOCALE_NAMESPACE, webLocaleCatalog)
  const events = new Map<string, () => void>()
  const client = {
    connectionState: initialState,
    device: {
      session: vi.fn(lookup),
      ...(detach ? { detachSession: vi.fn(detach) } : {}),
      ...(bind ? { bindSession: vi.fn(bind) } : {}),
    },
    on: (name: string, fn: () => void) => {
      events.set(name, fn)
      return () => events.delete(name)
    },
  } as unknown as HostAgnesClient
  const layout = document.createElement('div')
  layout.id = 'session-workbench'
  const container = document.createElement('aside')
  layout.append(container)
  document.body.append(layout)
  const changed = vi.fn()
  const mount = mountDeviceWorkbench({
    client,
    session,
    locale,
    registry,
    container,
    layout,
    onBindingChanged: changed,
  })
  cleanup.push(
    () => ctx.fiber.dispose(),
    () => mount.dispose(),
  )
  return { session, locale, registry, client, events, layout, container, mount, changed }
}

const detachResult = (id: string) => {
  const result = association(id, false)
  if (result.workspace) result.workspace.revision = 2
  return result
}
async function openDetach(container: HTMLElement): Promise<HTMLElement> {
  clickLabel(container, '解绑设备')
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  return document.querySelector('[role="alertdialog"]') as HTMLElement
}
function confirmDetach(dialog: HTMLElement): void {
  clickLabel(dialog, '解绑设备')
}
function clickLabel(parent: HTMLElement, label: string): void {
  const button = Array.from(parent.querySelectorAll('button')).find(
    (node) => node.textContent?.replace(/\s/g, '') === label,
  )
  if (!button) throw new Error(`Missing button: ${label}`)
  button.click()
}

describe('session device companion', () => {
  it.each(['success', 'lost-reply', 'rejected'] as const)(
    'prepares an inactive connection only on submission: %s',
    async (outcome) => {
      let saved = detachResult('device')
      const restored = association('device')
      restored.workspace.revision = restored.session.bindingRevision = 3
      restored.workspace.deviceId = restored.session.deviceId = '22222222-2222-4222-8222-222222222222'
      const { session, client, container, registry, changed } = await setup(
        async () => saved,
        async (id) => detachResult(id),
        'connected',
        async () => {
          if (outcome === 'rejected') throw new Error('private backend failure')
          saved = restored
          if (outcome === 'lost-reply') throw new Error('reply lost')
          return saved
        },
      )
      let props!: DeviceWorkbenchProps
      registry.register(
        'workbench.device',
        (value) => {
          props = value
          return createElement(
            'p',
            null,
            value.binding.active ? 'robot controls' : 'connection configuration',
          )
        },
        { owner: 'robot' },
      )
      session.setSession('device')
      await vi.waitFor(() => expect(container.textContent).toContain('connection configuration'))
      expect(container.textContent).not.toContain('重新绑定原设备')
      expect(client.device.bindSession).not.toHaveBeenCalled()
      if (outcome === 'rejected') {
        await expect(props.prepareConnection?.()).rejects.toThrow('Invalid connection preparation')
        expect(container.textContent).toContain('connection configuration')
        expect(changed).not.toHaveBeenCalled()
      } else {
        const prepared = await props.prepareConnection?.()
        expect(prepared?.active).toBe(true)
        expect(prepared?.bindingRevision).toBe(3)
        expect(Object.isFrozen(prepared)).toBe(true)
        // Preparing an association alone must not reveal controls or discard the entered address.
        expect(container.textContent).toContain('connection configuration')
        await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
        expect(await props.prepareConnection?.()).toEqual(prepared)
        props.connectionConfigured?.()
        await vi.waitFor(() => expect(container.textContent).toContain('robot controls'))
        expect(changed).toHaveBeenCalledOnce()
      }
      expect(client.device.bindSession).toHaveBeenCalledExactlyOnceWith('device', 2, {
        replaceInactiveDevice: true,
      })
      expect(session.sessionId).toBe('device')
    },
  )
  it.each(['device', 'session', 'revision'] as const)(
    'rejects an inconsistent connection preparation %s result',
    async (field) => {
      const result = association('device')
      result.workspace.revision = result.session.bindingRevision = 3
      result.workspace.deviceId = result.session.deviceId = '22222222-2222-4222-8222-222222222222'
      if (field === 'device') result.session.deviceId = '33333333-3333-4333-8333-333333333333'
      if (field === 'session') result.session.sessionId = 'other'
      if (field === 'revision') result.session.bindingRevision = 2
      const { session, container, registry, changed } = await setup(
        async () => detachResult('device'),
        undefined,
        'connected',
        async () => result,
      )
      let props!: DeviceWorkbenchProps
      registry.register(
        'workbench.device',
        (value) => {
          props = value
          return createElement('p', null, 'connection configuration')
        },
        { owner: 'robot' },
      )
      session.setSession('device')
      await vi.waitFor(() => expect(container.textContent).toContain('connection configuration'))
      await expect(props.prepareConnection?.()).rejects.toThrow('Invalid connection preparation')
      expect(props.binding.active).toBe(false)
      expect(changed).not.toHaveBeenCalled()
    },
  )
  it.each(['switch', 'dispose'] as const)('discards late connection preparation after %s', async (action) => {
    let finish!: (result: DeviceSessionResult) => void
    const pending = new Promise<DeviceSessionResult>((resolve) => {
      finish = resolve
    })
    const { session, container, mount, registry, changed } = await setup(
      async (id) => (id === 'device' ? detachResult(id) : { workspace: null, session: null }),
      undefined,
      'connected',
      async () => pending,
    )
    let props!: DeviceWorkbenchProps
    registry.register(
      'workbench.device',
      (value) => {
        props = value
        return createElement('p', null, 'connection configuration')
      },
      { owner: 'robot' },
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('connection configuration'))
    const prepared = props.prepareConnection?.()
    const refused = expect(prepared).rejects.toThrow('expired')
    if (action === 'switch') session.setSession('other')
    else mount.dispose()
    const result = association('device')
    result.workspace.revision = result.session.bindingRevision = 3
    result.workspace.deviceId = result.session.deviceId = '22222222-2222-4222-8222-222222222222'
    finish(result)
    await refused
    expect(container.hidden).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })
  it('does not offer rebinding when the workspace has switched to a different device', async () => {
    const replaced = detachResult('device')
    replaced.workspace.deviceId = '22222222-2222-4222-8222-222222222222'
    const { session, container } = await setup(
      async () => replaced,
      undefined,
      'connected',
      async () => association('device'),
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('关联已失效'))
    expect(container.textContent).not.toContain('重新绑定原设备')
  })
  it('loads the device panel after the initial connection becomes ready', async () => {
    const { session, client, events, container } = await setup(
      async (id) => association(id),
      undefined,
      'connecting',
    )
    session.setSession('device')
    expect(container.hidden).toBe(true)
    Object.defineProperty(client, 'connectionState', { value: 'connected' })
    events.get('connectionStateChanged')?.()
    await vi.waitFor(() => expect(container.hidden).toBe(false))
    expect(container.textContent).toContain('设备')
  })
  it('returns directly to connection configuration after detach without renewing enrollment', async () => {
    let active = true
    const { session, client, container, changed, registry } = await setup(
      async (id) => (active ? association(id) : detachResult(id)),
      async (id) => {
        active = false
        return detachResult(id)
      },
      'connected',
      async (id) => association(id),
    )
    registry.register(
      'workbench.device',
      ({ binding }) =>
        createElement('p', null, binding.active ? 'robot controls' : 'connection configuration'),
      { owner: 'robot' },
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    const dialog = await openDetach(container)
    expect(dialog.textContent).toContain('解绑不会使小车停车')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(client.device.detachSession).not.toHaveBeenCalled()
    confirmDetach(dialog)
    await vi.waitFor(() => expect(container.textContent).toContain('connection configuration'))
    expect(container.textContent).not.toContain('robot controls')
    expect(container.textContent).not.toContain('重新绑定原设备')
    expect(client.device.bindSession).not.toHaveBeenCalled()
    expect(client.device.detachSession).toHaveBeenCalledWith('device', 1)
    expect(changed).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('解绑设备')
    expect(session.sessionId).toBe('device')
  })

  it('dismisses confirmation without issuing an association mutation', async () => {
    const { session, client, container } = await setup(
      async (id) => association(id),
      async (id) => detachResult(id),
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    const dialog = await openDetach(container)
    clickLabel(dialog, '取消')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
    expect(client.device.detachSession).not.toHaveBeenCalled()
  })

  it.each(['failure', 'active', 'wrong-session', 'wrong-device', 'wrong-revision', 'malformed'] as const)(
    'refreshes instead of trusting a %s detach response',
    async (mode) => {
      const { session, client, container, changed } = await setup(
        async (id) => association(id),
        async (id) => {
          if (mode === 'failure') throw new Error('private details must not appear')
          if (mode === 'malformed') return {} as DeviceSessionResult
          if (mode === 'active') return association(id)
          const result = detachResult(id)
          if (mode === 'wrong-session' && result.session) result.session.sessionId = 'foreign'
          if (mode === 'wrong-device' && result.workspace)
            result.workspace.deviceId = '22222222-2222-4222-8222-222222222222'
          if (mode === 'wrong-revision' && result.workspace) result.workspace.revision = 3
          return result
        },
      )
      session.setSession('device')
      await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
      confirmDetach(await openDetach(container))
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法核实解绑结果'),
      )
      expect(client.device.session).toHaveBeenCalledWith('device')
      expect(changed).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('private details')
      expect(container.textContent).toContain('解绑设备')
    },
  )

  it.each(['switch', 'disconnect', 'dispose', 'refresh'] as const)(
    'refuses a stale confirmation after %s',
    async (mode) => {
      const { session, client, container, events, mount } = await setup(
        async (id) => association(id),
        async (id) => detachResult(id),
      )
      session.setSession('device')
      await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
      const dialog = await openDetach(container)
      if (mode === 'switch') session.setSession('other')
      else if (mode === 'disconnect') events.get('reconnecting')?.()
      else if (mode === 'dispose') mount.dispose()
      else await mount.refresh()
      // A still-mounted old DOM callback must not target its former device session.
      confirmDetach(dialog)
      await Promise.resolve()
      expect(client.device.detachSession).not.toHaveBeenCalled()
    },
  )

  it('retains an actionable error when detach and the following lookup both fail', async () => {
    let readable = true
    const { session, container, client, mount, locale } = await setup(
      async (id) => {
        if (!readable) throw new Error('private lookup error')
        return association(id)
      },
      async () => {
        readable = false
        throw new Error('private detach error')
      },
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    confirmDetach(await openDetach(container))
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法核实解绑结果'),
    )
    expect(container.hidden).toBe(false)
    expect(container.textContent).toContain('当前设备关联无法读取')
    expect(container.textContent).not.toContain('private')
    expect(container.textContent).not.toContain('解绑设备')
    expect(container.querySelector('button')?.disabled).toBe(false)
    locale.setLocale('en')
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not verify'),
    )
    readable = true
    await mount.refresh()
    await vi.waitFor(() => expect(container.textContent).toContain('Unbind device'))
    expect(client.device.detachSession).toHaveBeenCalledOnce()
  })

  it('does not resend an uncertain detach that lookup proves already committed', async () => {
    let active = true
    const { session, container, client, changed } = await setup(
      async (id) => (active ? association(id) : detachResult(id)),
      async () => {
        active = false
        throw new Error('reply lost')
      },
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    confirmDetach(await openDetach(container))
    await vi.waitFor(() => expect(container.textContent).toContain('关联已失效'))
    expect(container.textContent).toContain('无法核实解绑结果')
    expect(changed).toHaveBeenCalledOnce()
    expect(client.device.detachSession).toHaveBeenCalledOnce()
  })

  it('serializes double confirmation and refreshes the new session after a late detach result', async () => {
    let resolve!: (value: DeviceSessionResult) => void
    const pending = new Promise<DeviceSessionResult>((done) => {
      resolve = done
    })
    const { session, client, container, changed } = await setup(
      async (id) => association(id),
      async () => pending,
    )
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    const dialog = await openDetach(container)
    confirmDetach(dialog)
    confirmDetach(dialog)
    expect(client.device.detachSession).toHaveBeenCalledOnce()
    session.setSession('other')
    resolve(detachResult('device'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(container.textContent).toContain('解绑设备'))
    expect(session.sessionId).toBe('other')
    expect(container.textContent).not.toContain('关联已失效')
    expect(client.device.session).toHaveBeenCalledWith('other')
  })

  it('shows only explicitly enrolled sessions and passes frozen host metadata to the plugin', async () => {
    const seen: unknown[] = []
    const { session, registry, container, layout } = await setup(async (id) =>
      id === 'device' ? association(id) : { workspace: association(id).workspace, session: null },
    )
    registry.register(
      'workbench.device',
      ({ binding, sessionId }) => {
        seen.push(binding)
        return createElement('p', { 'data-device-control': true }, sessionId)
      },
      { owner: 'robot' },
    )
    expect(container.hidden).toBe(true)
    session.setSession('ordinary')
    await vi.waitFor(() => expect(container.hidden).toBe(true))
    session.setSession('device')
    await vi.waitFor(() =>
      expect(container.querySelector('[data-device-control]')?.textContent).toBe('device'),
    )
    expect(layout.classList.contains('has-device-workbench')).toBe(true)
    expect(Object.isFrozen(seen[0])).toBe(true)
    session.setSession('ordinary')
    expect(container.hidden).toBe(true)
    await vi.waitFor(() => expect(container.querySelector('[data-device-control]')).toBeNull())
  })

  it.each(['switch', 'dispose'] as const)('discards a late enrollment response after %s', async (action) => {
    let resolve!: (result: DeviceSessionResult) => void
    const pending = new Promise<DeviceSessionResult>((done) => {
      resolve = done
    })
    const { session, container, mount } = await setup(async () => pending)
    session.setSession('device')
    if (action === 'switch') session.setSession(undefined)
    else mount.dispose()
    resolve(association('device'))
    await pending
    await Promise.resolve()
    expect(container.hidden).toBe(true)
    mount.dispose()
    await mount.refresh()
    expect(container.hidden).toBe(true)
  })

  it.each([
    'inactive',
    'failure',
    'mismatch',
    'malformed',
    'workspace-mismatch',
    'revision-mismatch',
  ] as const)('never exposes active control for %s', async (mode) => {
    const { session, registry, container, mount } = await setup(async (id) => {
      if (mode === 'failure') throw new Error('unavailable')
      if (mode === 'malformed') return { session: { sessionId: id } } as DeviceSessionResult
      if (mode === 'mismatch') return association('another-session')
      if (mode === 'workspace-mismatch' || mode === 'revision-mismatch') {
        const result = association(id)
        if (result.workspace) {
          if (mode === 'workspace-mismatch') result.workspace.workspaceId = 'b'.repeat(64)
          else result.workspace.revision = 2
        }
        return result
      }
      return association(id, false)
    })
    const control = vi.fn(() => createElement('p', null, 'controls'))
    registry.register('workbench.device', control, { owner: 'robot' })
    session.setSession('device')
    await mount.refresh()
    await vi.waitFor(() => {
      if (mode === 'inactive') expect(container.textContent).toContain('关联已失效')
      else expect(container.hidden).toBe(true)
    })
    expect(control).not.toHaveBeenCalled()
  })

  it('preserves other workbench slots, refreshes after reconnect, and adjusts the width', async () => {
    const { session, registry, events, container, layout, locale } = await setup(async (id) =>
      association(id),
    )
    const rightbar = registry.register('workbench.panel', () => createElement('p', null, 'other'), {
      owner: 'mhs',
    })
    session.setSession('device')
    await vi.waitFor(() => expect(container.textContent).toContain('控制台尚未就绪'))
    const range = container.querySelector('input') as HTMLInputElement
    expect(range.type).toBe('range')
    range.value = '70'
    range.dispatchEvent(new Event('change', { bubbles: true }))
    range.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(layout.style.getPropertyValue('--device-chat-share')).toBe('70fr'))
    events.get('reconnecting')?.()
    expect(container.hidden).toBe(true)
    events.get('reconnected')?.()
    await vi.waitFor(() => expect(container.hidden).toBe(false))
    expect(registry.entries('workbench.panel')).toHaveLength(1)
    locale.setLocale('en')
    await vi.waitFor(() => expect(container.textContent).toContain('device control panel is not ready'))
    rightbar()
  })
})
