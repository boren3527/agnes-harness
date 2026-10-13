import { randomUUID } from 'node:crypto'
import type { CredentialStore } from '@agnes/host'
import {
  type DeviceConnectionSaveParams,
  type DeviceRecognitionSaveParams,
  type DeviceSessionBindParams,
  type DeviceSessionDetachParams,
  type DeviceSessionGetParams,
  type DeviceSessionResult,
  rpcError,
} from '@agnes/protocol'
import { DeviceBindingConflict, type DeviceBindingIndex } from '../../storage/device-bindings.js'
import type { WorkspaceBindingEnvelope, WorkspaceCatalog } from '../../storage/workspaces.js'
import type { CallContext, LocalEndpoint } from '../endpoint.js'
import { saveDeviceRecognition } from './device-recognition-save.js'
import { throwWorkspaceRpcError } from './workspaces.js'

type DeviceBindingMethods = {
  store: DeviceBindingIndex | undefined
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  requireSessionOwner(method: string, sessionId: string, context: CallContext): void
  recognitionCredentials?: CredentialStore | undefined
}

/** Shared read projection for owner-checked RPC and the authenticated worker channel. */
export function deviceSessionResult(
  store: DeviceBindingIndex,
  authority: WorkspaceBindingEnvelope,
): DeviceSessionResult {
  const workspace = store.workspace(authority.workspaceId) ?? null
  const session = store.session(authority.sessionKey)
  if (session && session.workspaceId !== authority.workspaceId) throw rpcError('INTERNAL_ERROR')
  return {
    workspace,
    session: session
      ? {
          sessionId: session.sessionKey,
          workspaceId: session.workspaceId,
          deviceId: session.deviceId,
          bindingRevision: session.bindingRevision,
          active:
            workspace?.active === true &&
            workspace.deviceId === session.deviceId &&
            workspace.revision === session.bindingRevision,
        }
      : null,
  }
}

/** Association RPC never commands a robot; detaching must not be presented as physical stopping. */
export function registerDeviceBindings(endpoint: LocalEndpoint, deps: DeviceBindingMethods): void {
  const storeFor = (context: CallContext): DeviceBindingIndex => {
    if (context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { reason: 'local owner required' })
    if (context.signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    if (!deps.store) throw rpcError('CAPABILITY_DENIED', { reason: 'device binding storage unavailable' })
    return deps.store
  }
  const authorize = async (method: string, sessionId: string, context: CallContext) => {
    storeFor(context)
    deps.requireSessionOwner(method, sessionId, context)
    let authority: WorkspaceBindingEnvelope
    try {
      authority = await deps.workspaces.restoreBinding(sessionId)
    } catch (error) {
      throwWorkspaceRpcError(error)
    }
    // Session ownership can change while filesystem workspace validation yields.
    const store = storeFor(context)
    deps.requireSessionOwner(method, sessionId, context)
    return { store, authority }
  }

  endpoint.register('_agnes/v1/device.bindings.list', async (_params, context) => {
    const items = storeFor(context).activeWorkspaces()
    if (items.length > 10000) throw rpcError('OVERLOADED', { reason: 'too many device bindings' })
    return { items }
  })
  endpoint.register('_agnes/v1/device.session.get', async (params, context) => {
    const { sessionId } = params as DeviceSessionGetParams
    const { store, authority } = await authorize('_agnes/v1/device.session.get', sessionId, context)
    return deviceSessionResult(store, authority)
  })
  endpoint.register('_agnes/v1/device.recognition.get', async (params, context) => {
    const { sessionId } = params as DeviceSessionGetParams
    const { store, authority } = await authorize('_agnes/v1/device.recognition.get', sessionId, context)
    try {
      return store.recognition.view(authority)
    } catch (error) {
      if (error instanceof DeviceBindingConflict)
        throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_CONFLICT', reason: error.reason })
      // Private refs, persisted JSON and storage diagnostics never cross this public view.
      throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_UNAVAILABLE' })
    }
  })
  endpoint.register('_agnes/v1/device.recognition.save', async (params, context) => {
    const input = params as DeviceRecognitionSaveParams
    return saveDeviceRecognition(
      input,
      deps.recognitionCredentials,
      () => authorize('_agnes/v1/device.recognition.save', input.sessionId, context),
      context.signal,
    )
  })
  for (const action of ['get', 'save'] as const) {
    endpoint.register(`_agnes/v1/device.connection.${action}`, async (params, context) => {
      const input = params as DeviceConnectionSaveParams
      const { store, authority } = await authorize(
        `_agnes/v1/device.connection.${action}`,
        input.sessionId,
        context,
      )
      try {
        return action === 'get' ? store.connection(authority) : store.saveConnection(authority, input)
      } catch (error) {
        if (error instanceof DeviceBindingConflict)
          throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_CONFIGURATION_CONFLICT', reason: error.reason })
        throw error
      }
    })
  }
  endpoint.register('_agnes/v1/device.session.bind', async (params, context) => {
    const { sessionId, expectedRevision, replaceInactiveDevice } = params as DeviceSessionBindParams
    const { store, authority } = await authorize('_agnes/v1/device.session.bind', sessionId, context)
    const current = store.workspace(authority.workspaceId)
    const enrolled = store.session(sessionId)
    // Identity is assigned by the daemon, not selected by a browser-provided IP/device UUID.
    const deviceId =
      current?.active || (!replaceInactiveDevice && enrolled && enrolled.deviceId === current?.deviceId)
        ? current!.deviceId
        : randomUUID()
    try {
      store.attach(authority, deviceId, expectedRevision, true, replaceInactiveDevice)
    } catch (error) {
      if (error instanceof DeviceBindingConflict)
        throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_BINDING_CONFLICT', reason: error.reason })
      throw error
    }
    return deviceSessionResult(store, authority)
  })
  endpoint.register('_agnes/v1/device.session.detach', async (params, context) => {
    const { sessionId, expectedRevision } = params as DeviceSessionDetachParams
    const { store, authority } = await authorize('_agnes/v1/device.session.detach', sessionId, context)
    try {
      const current = store.workspace(authority.workspaceId)
      const enrolled = store.session(sessionId)
      // Only the current enrollment may detach, including reading an already-detached result.
      // An ordinary or replaced historical session cannot operate on a new device association.
      if (
        !current ||
        !enrolled ||
        enrolled.workspaceId !== authority.workspaceId ||
        enrolled.deviceId !== current.deviceId ||
        enrolled.bindingRevision !== current.revision - (current.active ? 0 : 1)
      )
        throw new DeviceBindingConflict('inactive')
      store.detach(authority, expectedRevision)
    } catch (error) {
      if (error instanceof DeviceBindingConflict)
        throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_BINDING_CONFLICT', reason: error.reason })
      throw error
    }
    return deviceSessionResult(store, authority)
  })
}
