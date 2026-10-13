import {
  type DeviceConnectionResult,
  type DeviceRecognitionResult,
  type DeviceSessionResult,
  type DeviceWorkspaceBinding,
  inspectJsonData,
  validateMethod,
} from '@agnes/protocol'

function recognitionFingerprint(value: DeviceRecognitionResult): string {
  const settings = value.settings
  return JSON.stringify(
    settings
      ? [
          settings.provider,
          settings.frequency,
          settings.requestBudget,
          settings.credentialConfigured,
          settings.provider === 'local-yolo' ? settings.baseUrl : null,
        ]
      : null,
  )
}

/** Trusted worker-local binding lifetimes. This grants no physical-operation permission. */
export class DeviceBindingLifetimes {
  private readonly current = new Map<string, Readonly<DeviceWorkspaceBinding>>()
  private readonly configurations = new Map<
    string,
    { revision: number; profile: DeviceConnectionResult['profile'] }
  >()
  private readonly recognitions = new Map<string, Readonly<DeviceRecognitionResult>>()
  private readonly held = new Set<{
    sessionKey: string
    binding: NonNullable<DeviceSessionResult['session']>
    configRevision?: number
    recognitionRevision?: number
    abort: AbortController
    release(): void
  }>()
  private closed = false
  private readonly pending = new Set<{ sessionKey: string; closed: boolean }>()

  constructor(
    private readonly read: (key: string, signal: AbortSignal) => Promise<unknown>,
    private readonly readConnection?: (key: string, signal: AbortSignal) => Promise<unknown>,
    private readonly readRecognition?: (key: string, signal: AbortSignal) => Promise<unknown>,
  ) {}

  connectionChanged(raw: unknown): void {
    const inspected = inspectJsonData(raw)
    if (!inspected.ok || !validateMethod('_agnes/v1/device.connection.get', 'result', inspected.value).ok)
      throw new Error('Invalid device configuration notification')
    const value = inspected.value as unknown as DeviceConnectionResult
    const revision = value.profile?.configRevision ?? 0
    const old = this.configurations.get(value.deviceId)
    if (old && revision < old.revision) return
    if (old && revision === old.revision) {
      if (
        old.profile?.ip !== value.profile?.ip ||
        old.profile?.port !== value.profile?.port ||
        old.profile?.macAddress !== value.profile?.macAddress
      )
        throw new Error('Conflicting device configuration notification')
      return
    }
    if (old === undefined && this.configurations.size >= 10000)
      throw new Error('Device configuration notification limit')
    this.configurations.set(value.deviceId, {
      revision,
      profile: value.profile ? Object.freeze({ ...value.profile }) : null,
    })
    for (const lease of this.held)
      if (
        lease.binding.deviceId === value.deviceId &&
        lease.configRevision !== undefined &&
        revision > lease.configRevision
      )
        lease.release()
  }

  recognitionChanged(raw: unknown): void {
    const inspected = inspectJsonData(raw)
    if (!inspected.ok || !validateMethod('_agnes/v1/device.recognition.get', 'result', inspected.value).ok)
      throw new Error('Invalid device recognition notification')
    const value = inspected.value as unknown as DeviceRecognitionResult
    const old = this.recognitions.get(value.deviceId)
    if (old && value.configRevision < old.configRevision) return
    if (old && value.configRevision === old.configRevision) {
      if (recognitionFingerprint(old) !== recognitionFingerprint(value))
        throw new Error('Conflicting device recognition notification')
      return
    }
    if (!old && this.recognitions.size >= 10000) throw new Error('Device recognition notification limit')
    this.recognitions.set(
      value.deviceId,
      Object.freeze({ ...value, settings: value.settings ? Object.freeze({ ...value.settings }) : null }),
    )
    for (const lease of this.held)
      if (
        lease.binding.deviceId === value.deviceId &&
        lease.recognitionRevision !== undefined &&
        value.configRevision > lease.recognitionRevision
      )
        lease.release()
  }

  changed(raw: unknown): void {
    const inspected = inspectJsonData({ items: [raw] })
    if (!inspected.ok || !validateMethod('_agnes/v1/device.bindings.list', 'result', inspected.value).ok)
      throw new Error('Invalid device binding notification')
    const value = (inspected.value as unknown as { items: DeviceWorkspaceBinding[] }).items[0]
    if (!value) throw new Error('Missing device binding notification')
    const old = this.current.get(value.workspaceId)
    if (old && value.revision < old.revision) return
    if (
      old &&
      value.revision === old.revision &&
      (value.deviceId !== old.deviceId || value.active !== old.active)
    )
      throw new Error('Conflicting device binding notification')
    if (!old && this.current.size >= 10000) throw new Error('Device binding notification limit')
    this.current.set(value.workspaceId, Object.freeze({ ...value }))
    for (const lease of this.held) {
      if (
        lease.binding.workspaceId === value.workspaceId &&
        value.revision >= lease.binding.bindingRevision &&
        (!value.active ||
          value.deviceId !== lease.binding.deviceId ||
          value.revision !== lease.binding.bindingRevision)
      )
        lease.release()
    }
  }

  async retain(sessionKey: string, signal: AbortSignal, lifetime: AbortSignal, recognitionScope = false) {
    signal.throwIfAborted()
    lifetime.throwIfAborted()
    if (this.closed || this.held.size + this.pending.size >= 256)
      throw new Error('Device binding lifetime unavailable')
    const waiting = { sessionKey, closed: false }
    this.pending.add(waiting)
    let raw: unknown
    let rawConnection: unknown
    let rawRecognition: unknown
    try {
      raw = await this.read(sessionKey, signal)
      if (this.readConnection) {
        signal.throwIfAborted()
        lifetime.throwIfAborted()
        if (this.closed || waiting.closed) throw new Error('Device binding lifetime unavailable')
        rawConnection = await this.readConnection(sessionKey, signal)
      }
      if (recognitionScope) {
        signal.throwIfAborted()
        lifetime.throwIfAborted()
        if (this.closed || waiting.closed || !this.readRecognition)
          throw new Error('Device recognition lifetime unavailable')
        rawRecognition = await this.readRecognition(sessionKey, signal)
      }
    } finally {
      this.pending.delete(waiting)
    }
    signal.throwIfAborted()
    lifetime.throwIfAborted()
    const inspected = inspectJsonData(raw)
    if (!inspected.ok || !validateMethod('_agnes/v1/device.session.get', 'result', inspected.value).ok)
      throw new Error('Invalid device binding lifetime')
    const snapshot = inspected.value as unknown as DeviceSessionResult
    const binding = snapshot.session
    const workspace = snapshot.workspace
    if (
      this.closed ||
      waiting.closed ||
      this.held.size >= 256 ||
      !binding?.active ||
      binding.sessionId !== sessionKey ||
      !workspace?.active ||
      workspace.workspaceId !== binding.workspaceId ||
      workspace.deviceId !== binding.deviceId ||
      workspace.revision !== binding.bindingRevision
    )
      throw new Error('Device binding lifetime unavailable')
    const latest = this.current.get(binding.workspaceId)
    if (
      latest &&
      (latest.revision > binding.bindingRevision ||
        (latest.revision === binding.bindingRevision &&
          (!latest.active || latest.deviceId !== binding.deviceId)))
    )
      throw new Error('Device binding lifetime revoked during lookup')
    this.changed(workspace)
    let connection: Readonly<DeviceConnectionResult> | undefined
    if (this.readConnection) {
      const inspected = inspectJsonData(rawConnection)
      if (!inspected.ok || !validateMethod('_agnes/v1/device.connection.get', 'result', inspected.value).ok)
        throw new Error('Invalid retained device configuration')
      const value = inspected.value as unknown as DeviceConnectionResult
      const revision = value.profile?.configRevision ?? 0
      if (
        value.deviceId !== binding.deviceId ||
        value.bindingRevision !== binding.bindingRevision ||
        (this.configurations.get(value.deviceId)?.revision ?? 0) > revision
      )
        throw new Error('Device configuration revoked during lookup')
      this.connectionChanged(value)
      connection = Object.freeze({
        ...value,
        profile: value.profile ? Object.freeze({ ...value.profile }) : null,
      })
    }
    let recognition: Readonly<DeviceRecognitionResult> | undefined
    if (recognitionScope) {
      const inspected = inspectJsonData(rawRecognition)
      if (!inspected.ok || !validateMethod('_agnes/v1/device.recognition.get', 'result', inspected.value).ok)
        throw new Error('Invalid retained device recognition')
      const value = inspected.value as unknown as DeviceRecognitionResult
      if (
        value.deviceId !== binding.deviceId ||
        value.bindingRevision !== binding.bindingRevision ||
        (this.recognitions.get(value.deviceId)?.configRevision ?? 0) > value.configRevision
      )
        throw new Error('Device recognition revoked during lookup')
      this.recognitionChanged(value)
      recognition = Object.freeze({
        ...value,
        settings: value.settings ? Object.freeze({ ...value.settings }) : null,
      })
    }
    const abort = new AbortController()
    const lease = {
      sessionKey,
      binding: Object.freeze({ ...binding }),
      ...(connection ? { configRevision: connection.profile?.configRevision ?? 0 } : {}),
      ...(recognition ? { recognitionRevision: recognition.configRevision } : {}),
      abort,
      release: () => {
        this.held.delete(lease)
        lifetime.removeEventListener('abort', lease.release)
        abort.abort(new Error('Device binding lifetime revoked'))
      },
    }
    this.held.add(lease)
    lifetime.addEventListener('abort', lease.release, { once: true })
    if (lifetime.aborted) lease.release()
    return Object.freeze({
      snapshot: Object.freeze({ workspace: Object.freeze({ ...workspace }), session: lease.binding }),
      ...(connection ? { connection } : {}),
      ...(recognition ? { recognition } : {}),
      revoked: abort.signal,
      release: lease.release,
    })
  }

  closeSession(key: string): void {
    for (const waiting of this.pending) if (waiting.sessionKey === key) waiting.closed = true
    for (const lease of this.held) if (lease.sessionKey === key) lease.release()
  }

  close(): void {
    this.closed = true
    for (const lease of this.held) lease.release()
    this.current.clear()
    this.configurations.clear()
    this.recognitions.clear()
  }
}
