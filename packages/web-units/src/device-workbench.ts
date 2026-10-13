import { Dialog } from '@agnes/web-ui'
import { cloneElement, createElement, isValidElement, type ReactNode, useId } from 'react'

export interface DeviceWorkbenchShellProps {
  title: string
  refreshLabel: string
  chatShareLabel: string
  chatShare: number
  onRefresh(): void
  onShare(value: number): void
  detach?: {
    label: string
    description: string
    cancelLabel: string
    pendingLabel: string
    open: boolean
    pending: boolean
    onOpen(): void
    onCancel(): void
    onConfirm(): void
  }
  error?: string | undefined
  children?: ReactNode
}

/** Presentation only: enrollment and plugin ownership remain with the host. */
export function DeviceWorkbenchShell(props: DeviceWorkbenchShellProps) {
  const titleId = useId()
  const descriptionId = useId()
  const detach = props.detach
  return createElement(
    'div',
    { className: 'device-workbench-content' },
    createElement(
      'header',
      { className: 'device-workbench-header' },
      createElement('h2', null, props.title),
      detach &&
        createElement(
          'button',
          {
            type: 'button',
            disabled: detach.pending,
            onClick: detach.onOpen,
          },
          detach.pending ? detach.pendingLabel : detach.label,
        ),
    ),
    props.error && createElement('p', { className: 'device-workbench-empty', role: 'alert' }, props.error),
    props.children,
    createElement(
      'details',
      { className: 'device-workbench-layout-options' },
      createElement('summary', null, props.chatShareLabel),
      createElement(
        'label',
        { className: 'device-workbench-ratio' },
        props.chatShareLabel,
        createElement('input', {
          type: 'range',
          min: 35,
          max: 70,
          step: 1,
          defaultValue: props.chatShare,
          'aria-controls': 'session-workbench',
          onInput: (event: { currentTarget: HTMLInputElement }) =>
            props.onShare(Number(event.currentTarget.value)),
        }),
      ),
      createElement(
        'button',
        { type: 'button', onClick: props.onRefresh, disabled: detach?.pending },
        props.refreshLabel,
      ),
    ),
    detach &&
      createElement(
        Dialog,
        {
          open: detach.open,
          destroyOnHidden: true,
          transitionName: '',
          maskTransitionName: '',
          title: createElement('span', { id: titleId }, detach.label),
          okText: detach.label,
          cancelText: detach.cancelLabel,
          confirmLoading: detach.pending,
          okButtonProps: { disabled: detach.pending },
          cancelButtonProps: { disabled: detach.pending },
          mask: { closable: false },
          keyboard: !detach.pending,
          closable: !detach.pending,
          onCancel: detach.onCancel,
          onOk: detach.onConfirm,
          // Keep the existing primitive's focus and keyboard behavior, with one alert-dialog landmark.
          modalRender: (node) =>
            isValidElement<Record<string, unknown>>(node)
              ? cloneElement(node, {
                  ref: (content: HTMLElement | null) => {
                    queueMicrotask(() => {
                      const modal = content?.isConnected
                        ? content.closest('[role="dialog"], [role="alertdialog"]')
                        : undefined
                      if (
                        modal?.getAttribute('role') === 'dialog' ||
                        modal?.getAttribute('role') === 'alertdialog'
                      ) {
                        modal.setAttribute('role', 'alertdialog')
                        modal.setAttribute('aria-labelledby', titleId)
                        modal.setAttribute('aria-describedby', descriptionId)
                      }
                    })
                  },
                })
              : node,
        },
        createElement('p', { id: descriptionId }, detach.description),
      ),
  )
}
