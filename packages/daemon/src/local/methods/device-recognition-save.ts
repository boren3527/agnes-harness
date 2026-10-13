import {
  type CredentialStore,
  DeviceRecognitionCredentialError,
  discardDeviceRecognitionCredential,
  readDeviceRecognitionCredential,
  readDeviceRecognitionToken,
  stageDeviceRecognitionCredential,
  stageDeviceRecognitionToken,
} from '@agnes/host'
import { type DeviceRecognitionSaveParams, rpcError, validateMethod } from '@agnes/protocol'
import { DeviceBindingConflict, type DeviceBindingIndex } from '../../storage/device-bindings.js'
import {
  type DeviceRecognitionSettings,
  deviceRecognitionLocalOrigin,
} from '../../storage/device-recognition.js'
import type { WorkspaceBindingEnvelope } from '../../storage/workspaces.js'

type Authority = { store: DeviceBindingIndex; authority: WorkspaceBindingEnvelope }
const writes = new WeakMap<DeviceBindingIndex, Set<string>>()
/** Only a current session-owner RPC supplies authorize. No network, camera or inference here. */
export async function saveDeviceRecognition(
  input: DeviceRecognitionSaveParams,
  credentials: CredentialStore | undefined,
  authorize: () => Promise<Authority>,
  signal: AbortSignal,
) {
  if (!validateMethod('_agnes/v1/device.recognition.save', 'params', input).ok)
    throw rpcError('INVALID_PARAMS')
  const initial = await authorize()
  const before = initial.store.recognition.read(initial.authority)
  const busy = writes.get(initial.store) ?? new Set<string>()
  writes.set(initial.store, busy)
  if (busy.has(before.deviceId) || busy.size >= 64)
    throw rpcError('OVERLOADED', { code: 'DEVICE_RECOGNITION_BUSY' })
  busy.add(before.deviceId)
  let staged: string | undefined
  let authorityFailed = false
  const current = async () => {
    if (signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    let fresh: Authority
    try {
      fresh = await authorize()
    } catch {
      authorityFailed = true
      throw rpcError('CAPABILITY_DENIED')
    }
    const snapshot = fresh.store.recognition.read(fresh.authority)
    if (
      signal.aborted ||
      fresh.store !== initial.store ||
      fresh.authority.workspaceId !== initial.authority.workspaceId ||
      fresh.authority.sessionKey !== initial.authority.sessionKey ||
      snapshot.deviceId !== before.deviceId ||
      snapshot.bindingRevision !== before.bindingRevision ||
      snapshot.configRevision !== before.configRevision
    )
      throw new DeviceBindingConflict('revision')
    return fresh
  }
  try {
    if (signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    if (
      input.expectedBindingRevision !== before.bindingRevision ||
      (input.expectedConfigRevision !== before.configRevision &&
        input.expectedConfigRevision + 1 !== before.configRevision)
    )
      throw new DeviceBindingConflict('revision')
    let next: DeviceRecognitionSettings | null = null
    const value = input.settings
    if (value) {
      const previous = before.settings?.provider === value.provider ? before.settings : null
      let ref = previous?.credentialRef ?? null
      const baseUrl =
        value.provider === 'local-yolo' ? deviceRecognitionLocalOrigin(value.baseUrl) : undefined
      if (value.credentials.action === 'keep') {
        if (!previous) throw new DeviceRecognitionCredentialError('invalid')
      } else if (value.credentials.action === 'clear') {
        ref = null
      } else {
        if (!credentials) throw new DeviceRecognitionCredentialError('unavailable')
        let identical = false
        if (ref) {
          try {
            if (value.provider === 'aliyun') {
              const pair = await readDeviceRecognitionCredential(credentials, before.deviceId, ref, signal)
              identical =
                pair.accessKeyId === value.credentials.accessKeyId &&
                pair.accessKeySecret === value.credentials.accessKeySecret
            } else {
              identical =
                (await readDeviceRecognitionToken(credentials, before.deviceId, ref, signal)) ===
                value.credentials.token
            }
          } catch (error) {
            // Explicit current-version replacement may repair a missing/damaged old record.
            // A stale retry cannot claim equality without reading the old credential.
            if (
              input.expectedConfigRevision !== before.configRevision ||
              !(error instanceof DeviceRecognitionCredentialError) ||
              !['invalid', 'storage'].includes(error.code)
            )
              throw error
          }
          await current()
        }
        if (!identical) {
          if (input.expectedConfigRevision !== before.configRevision)
            throw new DeviceBindingConflict('revision')
          staged =
            value.provider === 'aliyun'
              ? await stageDeviceRecognitionCredential(
                  credentials,
                  before.deviceId,
                  {
                    accessKeyId: value.credentials.accessKeyId,
                    accessKeySecret: value.credentials.accessKeySecret,
                  },
                  signal,
                )
              : await stageDeviceRecognitionToken(
                  credentials,
                  before.deviceId,
                  value.credentials.token,
                  signal,
                )
          ref = staged
        }
      }
      if (value.provider === 'aliyun') {
        if (!ref) throw new DeviceRecognitionCredentialError('invalid')
        next = {
          provider: 'aliyun',
          frequency: value.frequency,
          requestBudget: value.requestBudget,
          credentialRef: ref,
        }
      } else {
        next = {
          provider: 'local-yolo',
          frequency: value.frequency,
          requestBudget: value.requestBudget,
          credentialRef: ref,
          baseUrl: baseUrl as string,
        }
      }
    }
    const fresh = await current()
    fresh.store.recognition.save(fresh.authority, {
      expectedBindingRevision: input.expectedBindingRevision,
      expectedConfigRevision: input.expectedConfigRevision,
      settings: next,
    })
    return fresh.store.recognition.view(fresh.authority)
  } catch (error) {
    if (staged && credentials) {
      let referenced: boolean
      try {
        referenced = initial.store.recognition.references(before.deviceId, staged)
      } catch {
        throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_PUBLICATION_UNCERTAIN' })
      }
      if (!referenced) {
        try {
          await discardDeviceRecognitionCredential(credentials, before.deviceId, staged)
        } catch {
          throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_CLEANUP_FAILED' })
        }
      }
    }
    if (signal.aborted) throw rpcError('REQUEST_TIMEOUT')
    if (authorityFailed) throw rpcError('CAPABILITY_DENIED')
    if (error instanceof DeviceBindingConflict)
      throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_CONFLICT', reason: error.reason })
    if (error instanceof DeviceRecognitionCredentialError)
      throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_CREDENTIAL', reason: error.code })
    throw rpcError('SEMANTIC_REJECTED', { code: 'DEVICE_RECOGNITION_SAVE_FAILED' })
  } finally {
    busy.delete(before.deviceId)
  }
}
