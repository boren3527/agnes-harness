import type { ArtifactRef } from '@agnes/protocol'
import type { ClientImageResource, ClientResourceService, SessionService } from '@agnes/web-client'
import { createDocumentPreview, type DocumentPreviewRenderer } from './document-preview.js'
import type { Translate } from './presentation.js'

/** Reads already recorded main-lane artifacts. Never captures again or publishes a partial read. */
export function createArtifactImagePreview(
  element: HTMLElement,
  services: { resources?: ClientResourceService; session?: SessionService },
  t: Translate,
) {
  const sessionId = services.session?.sessionId,
    handle = services.session?.handle
  let ref: ArtifactRef | undefined,
    name = '',
    key = '',
    disposed = false
  let controller: AbortController | undefined, resource: ClientImageResource | undefined
  let preview: DocumentPreviewRenderer | undefined
  let dialog: HTMLDialogElement | undefined
  const current = () =>
    !disposed && services.session?.sessionId === sessionId && services.session?.handle === handle
  const clear = () => {
    controller?.abort()
    dialog?.close()
    dialog?.remove()
    dialog = undefined
    preview?.dispose()
    resource?.release()
    controller = undefined
    preview = undefined
    resource = undefined
    element.replaceChildren()
  }
  const failure = () => {
    clear()
    if (disposed) return
    const message = document.createElement('p')
    message.setAttribute('role', 'alert')
    message.textContent = t('timeline.artifactImageError')
    element.append(message)
    if (current() && sessionId && services.resources) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = t('timeline.artifactImageRetry')
      retry.addEventListener('click', () => {
        void load()
      })
      element.append(retry)
    }
  }
  const renderImage = () => {
    if (!resource) return
    dialog?.close()
    dialog?.remove()
    dialog = undefined
    preview?.dispose()
    preview = createDocumentPreview(
      element,
      { kind: 'image', title: t('timeline.artifactImageAlt', { name }), resourceUrl: resource.url },
      t,
    )
    const image = element.querySelector('img')
    if (!image) return
    const thumbnail = document.createElement('button')
    thumbnail.type = 'button'
    thumbnail.className = 'artifact-image-thumbnail'
    thumbnail.setAttribute('aria-label', t('timeline.artifactImageOpen', { name }))
    thumbnail.setAttribute('aria-haspopup', 'dialog')
    image.replaceWith(thumbnail)
    thumbnail.append(image)
    thumbnail.addEventListener('click', () => {
      if (!current() || !resource) return
      if (!dialog) {
        dialog = document.createElement('dialog')
        dialog.className = 'artifact-image-dialog'
        dialog.setAttribute('aria-label', image.alt)
        const close = document.createElement('button')
        close.type = 'button'
        close.autofocus = true
        close.textContent = t('timeline.artifactImageClose')
        close.addEventListener('click', () => dialog?.close())
        dialog.append(close, image.cloneNode())
        dialog.addEventListener('close', () => {
          if (thumbnail.isConnected) thumbnail.focus({ preventScroll: true })
        })
        document.body.append(dialog)
      }
      dialog.showModal()
    })
    const displayed = resource
    image?.addEventListener(
      'error',
      () => {
        if (current() && element.contains(image) && resource === displayed) failure()
      },
      { once: true },
    )
  }
  const load = async () => {
    clear()
    if (!ref || !current() || !sessionId || !services.resources) return failure()
    const selected = ref,
      lifetime = new AbortController()
    controller = lifetime
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    status.textContent = t('timeline.artifactImageLoading')
    element.append(status)
    try {
      const loaded = await services.resources.images.load({
        laneId: 'main',
        artifact: selected,
        signal: lifetime.signal,
      })
      if (lifetime.signal.aborted || !current() || controller !== lifetime) {
        loaded.release()
        return
      }
      element.replaceChildren()
      resource = loaded
      renderImage()
    } catch {
      if (!lifetime.signal.aborted && current() && controller === lifetime) failure()
    }
  }
  const unsubscribe = services.session?.subscribe(() => {
    if (!current() && (ref?.mime === 'image/png' || ref?.mime === 'image/jpeg')) failure()
  })
  return {
    update(next: ArtifactRef, title: string) {
      if (disposed) return
      name = title
      const nextKey = `${next.sha256}:${next.size}:${next.mime}`
      if (nextKey === key) {
        renderImage()
        return
      }
      key = nextKey
      ref = Object.freeze({ sha256: next.sha256, size: next.size, mime: next.mime })
      if (next.mime === 'image/png' || next.mime === 'image/jpeg') void load()
      else clear()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      clear()
    },
  }
}
