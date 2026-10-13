import { isDeepStrictEqual } from 'node:util'
import type { ClientModuleMediaResolveParams, ClientModuleMediaResolveResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { PackageAdminAuthority } from '../packages/permissions.js'
import type { DeviceBindingIndex } from '../storage/device-bindings.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'
import type { workerDeviceMediaReader } from './device-media-read.js'

export function deviceMediaSessionResolver(deps: {
  profile: string
  bindings: DeviceBindingIndex | undefined
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  read: ReturnType<typeof workerDeviceMediaReader>
}) {
  return async (
    input: ClientModuleMediaResolveParams & { backendRowId: string; rosterRevision: string },
    authority: PackageAdminAuthority,
    signal: AbortSignal,
  ): Promise<ClientModuleMediaResolveResult> => {
    const owner = () => {
      signal.throwIfAborted()
      if (
        input.profile !== deps.profile ||
        !deps.bindings ||
        deps.ownership.resolve(input.sessionId)?.principalId !== authority.principalId
      )
        throw rpcError('CAPABILITY_DENIED')
    }
    owner()
    const binding = await deps.workspaces.restoreBinding(input.sessionId)
    owner()
    if (!deps.bindings) throw rpcError('CAPABILITY_DENIED')
    const before = deps.bindings.connection(binding)
    if (!before.profile) throw rpcError('CAPABILITY_DENIED')
    const endpoint = await deps.read(input.backendRowId, signal)
    owner()
    const current = await deps.workspaces.restoreBinding(input.sessionId)
    owner()
    const after = deps.bindings.connection(current)
    if (!isDeepStrictEqual(binding, current) || !isDeepStrictEqual(before, after))
      throw rpcError('CAPABILITY_DENIED')
    if (!endpoint) return { found: false }
    return {
      found: true,
      ...endpoint,
      deviceId: before.deviceId,
      bindingRevision: before.bindingRevision,
      configRevision: before.profile.configRevision,
      rosterRevision: input.rosterRevision,
    }
  }
}
