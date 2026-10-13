import type { ServiceInvocationAuthorization } from './service-invocation.js'
import type { ServiceRegistration } from './services.js'

export type DeviceRecognitionIOStage = 'upload-authorize' | 'upload' | 'detect'
export type DeviceRecognitionIOAuthorization = ServiceInvocationAuthorization &
  Readonly<{
    assertIOAuthorized(stage: DeviceRecognitionIOStage, signal: AbortSignal): Promise<void>
  }>
export type DeviceRecognitionAuthorizationRegistrar = (
  sessionKey: string,
  callId: string,
  authorization: DeviceRecognitionIOAuthorization,
) => void
const hosts = Object.freeze({
  'upload-authorize': 'openplatform.aliyuncs.com',
  upload: 'oss-cn-shanghai.aliyuncs.com',
  detect: 'objectdet.cn-shanghai.aliyuncs.com',
})

/** Internal declaration shared with the Host-owned row grant; never author-configured. */
export const recognitionNetworkHosts = Object.freeze(Object.values(hosts))

/** Fixed SDK destinations, checked inside Host. No author-supplied URL or serialized grant. */
export function recognitionIOAuthorization(
  authorization: ServiceInvocationAuthorization,
  entry: ServiceRegistration,
  networkAllow: readonly string[],
  alive: () => void,
): DeviceRecognitionIOAuthorization {
  const refuse = (): never => {
    throw new Error('recognition IO unavailable')
  }
  return Object.freeze({
    ...authorization,
    assertIOAuthorized: async (stage, signal) => {
      alive()
      signal.throwIfAborted()
      authorization.revoked.throwIfAborted()
      if (!Object.hasOwn(hosts, stage)) refuse()
      if ((await authorization.assertAuthorized()) !== undefined) refuse()
      alive()
      signal.throwIfAborted()
      authorization.revoked.throwIfAborted()
      const host = hosts[stage]
      const caps = entry.manifest.capabilities.network
      const allowed = caps && !Array.isArray(caps) ? caps.hosts : []
      const matches = (values: readonly string[]) =>
        values.some((value) => value.toLowerCase() === host || value.toLowerCase() === `${host}:443`)
      if (!matches(allowed) || !matches(networkAllow)) refuse()
    },
  })
}
