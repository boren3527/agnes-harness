import { rpcError } from '@agnes/protocol'
import { deviceSessionResult } from '../local/methods/device-bindings.js'
import type { DeviceBindingIndex } from '../storage/device-bindings.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'

/** Pool verifies the sending worker owns the live session channel before invoking this reader. */
export async function readWorkerDeviceSession(
  deps: {
    store: DeviceBindingIndex | undefined
    ownership: Pick<SessionPrincipalOwnership, 'resolve'>
    workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  },
  sessionKey: string,
  params: unknown,
) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw rpcError('INVALID_PARAMS')
  const keys = Reflect.ownKeys(params)
  const view = keys.length === 1 ? (params as { view?: unknown }).view : undefined
  if (
    !(
      keys.length === 0 ||
      (keys.length === 1 && keys[0] === 'view' && (view === 'connection' || view === 'recognition'))
    )
  )
    throw rpcError('INVALID_PARAMS')
  if (!deps.store) throw rpcError('CAPABILITY_DENIED')
  const store = deps.store
  const owner = deps.ownership.resolve(sessionKey)
  if (!owner?.active) throw rpcError('CAPABILITY_DENIED')
  const authority = await deps.workspaces.restoreBinding(sessionKey)
  const current = deps.ownership.resolve(sessionKey)
  if (!current?.active || current.principalId !== owner.principalId || authority.sessionKey !== sessionKey)
    throw rpcError('CAPABILITY_DENIED')
  if (deps.store !== store) throw rpcError('CAPABILITY_DENIED')
  if (view === 'recognition') return store.recognition.view(authority)
  return view === 'connection' ? store.connection(authority) : deviceSessionResult(store, authority)
}
