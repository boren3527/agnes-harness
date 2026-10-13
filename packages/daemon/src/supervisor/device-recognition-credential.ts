import {
  type CredentialStore,
  pluginRowSource,
  readDeviceRecognitionCredential,
  readDeviceRecognitionToken,
} from '@agnes/host'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import type { DeviceBindingIndex } from '../storage/device-bindings.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../storage/workspaces.js'
import type { WorkerServiceEffectScope } from './worker-link.js'

type DeviceRecognitionCredential = Awaited<ReturnType<typeof readDeviceRecognitionCredential>>
export type RecognitionCredentialAccess =
  | Readonly<{
      provider: 'aliyun'
      check(): Promise<void>
      run<T>(
        operation: (credentials: DeviceRecognitionCredential, signal: AbortSignal) => Promise<T>,
      ): Promise<T>
    }>
  | Readonly<{
      provider: 'local-yolo'
      baseUrl: string
      check(): Promise<void>
      run<T>(operation: (token: string | null, signal: AbortSignal) => Promise<T>): Promise<T>
    }>
const denied = (): never => {
  throw rpcError('CAPABILITY_DENIED')
}
/** Backend engine only: never register this return value as an RPC/service/model result.
 * Transport correlation is insufficient: the trusted engine must supply current Host grant checks.
 * This resolves credentials, not IO authority; upload and detection still require separate admission.
 */
export async function resolveDeviceRecognitionCredentialForEffect(
  deps: {
    bindings: DeviceBindingIndex | undefined
    credentials: CredentialStore | undefined
    ownership: Pick<SessionPrincipalOwnership, 'resolve'>
    workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>
  },
  sessionKey: string,
  expected: Readonly<{ bindingRevision: number; configRevision: number }>,
  scope: WorkerServiceEffectScope | undefined,
  authorization: Readonly<{ revoked: AbortSignal; assertAuthorized(): void | Promise<void> }>,
  signal: AbortSignal,
): Promise<RecognitionCredentialAccess> {
  const input = inspectJsonData(expected, 1024)
  if (!input.ok || !input.value || typeof input.value !== 'object' || Array.isArray(input.value))
    return denied()
  const versions = input.value as Record<string, unknown>
  if (
    Object.keys(versions).sort().join(',') !== 'bindingRevision,configRevision' ||
    !Number.isSafeInteger(versions.bindingRevision) ||
    (versions.bindingRevision as number) < 1 ||
    !Number.isSafeInteger(versions.configRevision) ||
    (versions.configRevision as number) < 1
  )
    return denied()
  const bindings = deps.bindings,
    credentials = deps.credentials
  let owner: ReturnType<SessionPrincipalOwnership['resolve']>
  const current = () => {
    const current = deps.ownership.resolve(sessionKey)
    if (
      !bindings ||
      !credentials ||
      deps.bindings !== bindings ||
      deps.credentials !== credentials ||
      !owner?.active ||
      !current?.active ||
      current.principalId !== owner.principalId ||
      !scope ||
      scope.revoked.aborted ||
      scope.sessionKey !== sessionKey ||
      scope.extension !== pluginRowSource('ext:agnes-examples/aka-robot') ||
      !['aka.recognition.test', 'aka.recognition.enable'].includes(scope.service) ||
      !/^[a-f0-9]{32}$/.test(scope.callId) ||
      signal.aborted ||
      authorization.revoked.aborted
    )
      return denied()
  }
  const live = async () => {
    current()
    if ((await authorization.assertAuthorized()) !== undefined) return denied()
    current()
  }
  try {
    owner = deps.ownership.resolve(sessionKey)
    await live()
    const authority = await deps.workspaces.restoreBinding(sessionKey)
    await live()
    if (authority.sessionKey !== sessionKey || !bindings || !credentials || !scope) return denied()
    const before = bindings.recognition.read(authority)
    if (
      before.bindingRevision !== versions.bindingRevision ||
      before.configRevision !== versions.configRevision ||
      !before.settings
    )
      return denied()
    const settings = before.settings
    const cancellation = AbortSignal.any([signal, authorization.revoked, scope.revoked])
    const secret =
      settings.provider === 'aliyun'
        ? Object.freeze({
            provider: 'aliyun',
            credentials: await readDeviceRecognitionCredential(
              credentials,
              before.deviceId,
              settings.credentialRef,
              cancellation,
            ),
          })
        : Object.freeze({
            provider: 'local-yolo',
            baseUrl: settings.baseUrl,
            token:
              settings.credentialRef === null
                ? null
                : await readDeviceRecognitionToken(
                    credentials,
                    before.deviceId,
                    settings.credentialRef,
                    cancellation,
                  ),
          })
    const matchingConfiguration = (fresh: typeof authority) => {
      current()
      if (fresh.sessionKey !== sessionKey || fresh.workspaceId !== authority.workspaceId) return denied()
      const after = bindings.recognition.read(fresh)
      if (
        after.deviceId !== before.deviceId ||
        after.bindingRevision !== before.bindingRevision ||
        after.configRevision !== before.configRevision ||
        JSON.stringify(after.settings) !== JSON.stringify(before.settings)
      )
        return denied()
    }
    const currentConfiguration = async () => {
      await live()
      const fresh = await deps.workspaces.restoreBinding(sessionKey)
      await live()
      matchingConfiguration(fresh)
    }
    await currentConfiguration()
    matchingConfiguration(authority)
    const check = async () => {
      try {
        await currentConfiguration()
        matchingConfiguration(authority)
      } catch {
        return denied()
      }
    }
    let busy = false
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (busy) return denied()
      busy = true
      try {
        await currentConfiguration()
        await live()
        matchingConfiguration(authority)
        const value = await operation()
        await currentConfiguration()
        matchingConfiguration(authority)
        return value
      } catch {
        return denied()
      } finally {
        busy = false
      }
    }
    // Secret strings stay in a backend closure; serializing the access handle cannot reveal them.
    // Each upload/detect consumer separately checks IO admission and the shared in-flight slot.
    return secret.provider === 'aliyun'
      ? Object.freeze({
          provider: 'aliyun',
          check,
          run: <T>(
            operation: (credentials: DeviceRecognitionCredential, signal: AbortSignal) => Promise<T>,
          ) => guarded(() => operation(secret.credentials, cancellation)),
        })
      : Object.freeze({
          provider: 'local-yolo',
          baseUrl: secret.baseUrl,
          check,
          run: <T>(operation: (token: string | null, signal: AbortSignal) => Promise<T>) =>
            guarded(() => operation(secret.token, cancellation)),
        })
  } catch {
    // Neither secret references nor storage/authorization exception messages leave this boundary.
    return denied()
  }
}
