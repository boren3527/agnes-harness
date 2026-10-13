import type { ImageGenerationSettings } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { tr } from './locale-bridge.js'

/** Delegation survives replacement of the model pane. Clear secrets on close and disconnect. */
export function imageModelSettings(client: Client, dialog: HTMLDialogElement) {
  let snapshot: ImageGenerationSettings | undefined,
    generation = 0,
    pending = false,
    connected = true
  const el = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#image-model-${id}`)
  const message = (key: string) => {
    const node = el('message')
    if (node) node.textContent = key ? tr(key) : ''
  }
  const controls = () => {
    const save = el<HTMLButtonElement>('save'),
      reload = el<HTMLButtonElement>('reload')
    if (save) save.disabled = pending || !connected || !snapshot
    if (reload) reload.disabled = pending || !connected
    for (const id of ['model', 'size', 'key', 'enabled']) {
      const field = el<HTMLInputElement | HTMLSelectElement>(id)
      if (field) field.disabled = pending || !connected
    }
  }
  const render = () => {
    const state = el('status'),
      size = el<HTMLSelectElement>('size'),
      enabled = el<HTMLInputElement>('enabled')
    const model = el<HTMLSelectElement>('model'),
      endpoint = el<HTMLParagraphElement>('endpoint'),
      documentation = el<HTMLAnchorElement>('documentation')
    if (snapshot && model) model.value = snapshot.model
    if (snapshot && endpoint) endpoint.textContent = snapshot.endpoint
    if (snapshot && documentation)
      documentation.href =
        snapshot.model === 'qwen-image-2.1-pro'
          ? 'https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference'
          : 'https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash'
    if (state)
      state.textContent = tr(
        !snapshot?.credentialConfigured
          ? 'imageModel.unconfigured'
          : snapshot.enabled
            ? 'imageModel.ready'
            : 'imageModel.disabled',
      )
    if (size && snapshot) size.value = snapshot.size
    if (enabled && snapshot) enabled.checked = snapshot.enabled
    controls()
  }
  const clear = () => {
    const key = el<HTMLInputElement>('key')
    if (key) key.value = ''
  }
  const refresh = async () => {
    if (!connected) return
    const token = ++generation
    pending = true
    controls()
    message('imageModel.loading')
    try {
      const value = await client.config.imageGeneration.get()
      if (token !== generation) return
      snapshot = value
      render()
      message('')
    } catch {
      if (token === generation) {
        snapshot = undefined
        message('imageModel.readFailed')
      }
    } finally {
      if (token === generation) {
        pending = false
        controls()
      }
    }
  }
  const save = async () => {
    const key = el<HTMLInputElement>('key'),
      size = el<HTMLSelectElement>('size'),
      enabled = el<HTMLInputElement>('enabled')
    if (pending || !connected || !snapshot || !size || !enabled) return
    const apiKey = key?.value.trim(),
      token = ++generation
    pending = true
    controls()
    message('imageModel.saving')
    clear()
    try {
      const result = await client.config.imageGeneration.save({
        expectedRevision: snapshot.revision,
        size: size.value === '2K' ? '2K' : '1K',
        enabled: enabled.checked,
        model:
          el<HTMLSelectElement>('model')?.value === 'agnes-image-2.5-flash'
            ? 'agnes-image-2.5-flash'
            : 'qwen-image-2.1-pro',
        ...(apiKey ? { apiKey } : {}),
      })
      if (token !== generation) return
      snapshot = result
      render()
      message('imageModel.saved')
    } catch {
      if (token === generation) message('imageModel.failed')
    } finally {
      if (token === generation) {
        pending = false
        controls()
      }
    }
  }
  dialog.addEventListener('click', (event) => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null
    if (target?.closest?.('#image-model-save')) void save()
    if (target?.closest?.('#image-model-reload')) void refresh()
  })
  return {
    refresh,
    render,
    close: () => {
      generation++
      pending = false
      clear()
      controls()
    },
    setConnected: (value: boolean) => {
      connected = value
      if (!value) {
        generation++
        pending = false
        clear()
      }
      controls()
    },
  }
}
