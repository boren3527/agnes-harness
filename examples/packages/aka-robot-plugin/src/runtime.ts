import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { AkaControlChannel, type ControlObservation, type ControlReceipt } from './control-channel.js'
import { AkaHttpDriver, type AkaTransportCode, AkaTransportError, type RobotSettings } from './http-driver.js'
import { type JpegFrame, jpegDimensions } from './mjpeg.js'
import {
  AkaProtocolError,
  type Motion,
  type MotionLimits,
  motionPath,
  robotEndpoint,
  type WheelReport,
} from './protocol.js'

export interface RuntimeSnapshot {
  instanceId: string
  connection: 'idle' | 'connecting' | 'connected' | 'degraded' | 'disposed'
  generation: number
  mediaGeneration: number
  identity: 'unchecked' | 'matched' | 'mismatch'
  cameraOn: boolean | null
  media: 'idle' | 'opening' | 'streaming' | 'error'
  motor: { connected: boolean | null; state: string | null }
  wheels: (WheelReport & { ageMs: number }) | null
  frame: { id: string; width: number; height: number; ageMs: number; timeBasis: 'bridge_receive' } | null
  error: AkaTransportCode | 'identity' | null
  control: { phase: 'idle' | 'moving' | 'gripping' | 'unknown'; lastStop: 'completed' | 'unknown' | null }
}

export interface RuntimeFrame extends JpegFrame {
  readonly id: string
  readonly receivedAt: number
  readonly timeBasis: 'bridge_receive'
}

/** Internal per-device coordinator; never a public authorization surface.
 * The trusted plugin owner must supply fresh enrollment and explicit camera-effect authorization.
 * It does not retain invocation handles or grant physical authority from observation data.
 */
export class AkaRuntime {
  private readonly instanceId = randomUUID()
  private readonly http: AkaHttpDriver
  private control: AkaControlChannel | undefined
  private connectionAbort: AbortController | undefined
  private cameraAbort: AbortController | undefined
  private cameraClosing = false
  private generation = 0
  private mediaGeneration = 0
  private sequence = 0
  private connection: RuntimeSnapshot['connection'] = 'idle'
  private identity: RuntimeSnapshot['identity'] = 'unchecked'
  private cameraOn: boolean | null = null
  private media: RuntimeSnapshot['media'] = 'idle'
  private motor: RuntimeSnapshot['motor'] = { connected: null, state: null }
  private wheels: { report: WheelReport; at: number } | undefined
  private frame: RuntimeFrame | undefined
  private error: RuntimeSnapshot['error'] = null
  private activeControl: AbortController | undefined
  private controlPhase: RuntimeSnapshot['control']['phase'] = 'idle'
  private unresolvedMotion = false
  private lastStop: RuntimeSnapshot['control']['lastStop'] = null
  private captureNotBefore = 0
  private stopping: Promise<Awaited<ReturnType<AkaHttpDriver['stop']>>> | undefined
  private readonly expectedMac: string
  private readonly removeLifetime: () => void

  constructor(
    private readonly ip: string,
    private readonly port: number,
    expectedMac: string,
    lifetime: AbortSignal,
  ) {
    robotEndpoint(ip, port)
    if (
      !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(expectedMac) ||
      /^(?:00:){5}00$|^(?:ff:){5}ff$/i.test(expectedMac)
    )
      throw new AkaProtocolError('A reported device identity must be confirmed before runtime use')
    this.expectedMac = expectedMac.toLowerCase()
    this.http = new AkaHttpDriver(ip, port)
    const dispose = () => this.dispose()
    lifetime.addEventListener('abort', dispose, { once: true })
    this.removeLifetime = () => lifetime.removeEventListener('abort', dispose)
    if (lifetime.aborted) this.dispose()
  }

  snapshot(): Readonly<RuntimeSnapshot> {
    const now = performance.now()
    return Object.freeze({
      instanceId: this.instanceId,
      connection: this.connection,
      generation: this.generation,
      mediaGeneration: this.mediaGeneration,
      identity: this.identity,
      cameraOn: this.cameraOn,
      media: this.media,
      motor: Object.freeze({ ...this.motor }),
      wheels: this.wheels
        ? Object.freeze({ ...this.wheels.report, ageMs: Math.max(0, now - this.wheels.at) })
        : null,
      frame: this.frame
        ? Object.freeze({
            id: this.frame.id,
            width: this.frame.width,
            height: this.frame.height,
            ageMs: Math.max(0, now - this.frame.receivedAt),
            timeBasis: this.frame.timeBasis,
          })
        : null,
      error: this.error,
      control: Object.freeze({ phase: this.controlPhase, lastStop: this.lastStop }),
    })
  }

  /** Only copies a current frame. No snapshot request, camera side effect or historical substitution. */
  latestFrame(): RuntimeFrame | null {
    return this.frame ? Object.freeze({ ...this.frame, bytes: Buffer.from(this.frame.bytes) }) : null
  }

  /** Discard frames received during movement and the bounded post-stop settling interval. */
  captureReadyAfter(): number {
    return this.captureNotBefore
  }

  async settings(signal: AbortSignal, value?: RobotSettings, kind?: 'speed' | 'arm') {
    if (this.connection !== 'connected' || this.identity !== 'matched' || this.controlPhase !== 'idle')
      throw new AkaProtocolError('Robot settings unavailable')
    return value && kind ? this.http.saveSettings(value, kind, signal) : this.http.readSettings(signal)
  }

  async connect(signal: AbortSignal, beforeIO: () => Promise<void> = async () => {}): Promise<void> {
    if (this.connection === 'disposed' || this.connection === 'connecting' || this.connection === 'connected')
      throw new AkaProtocolError('Runtime connection unavailable or already active')
    if (signal.aborted) throw new AkaTransportError('cancelled')
    const generation = ++this.generation
    const ac = new AbortController()
    this.connectionAbort = ac
    this.connection = 'connecting'
    this.identity = 'unchecked'
    this.error = null
    const cancel = () => this.retire(generation, 'cancelled')
    signal.addEventListener('abort', cancel, { once: true })
    const operation = AbortSignal.any([signal, ac.signal])
    try {
      await beforeIO()
      this.assertCurrent(generation, operation)
      const heartbeat = await this.http.heartbeat(operation)
      this.assertCurrent(generation, operation)
      if (heartbeat.identity.macAddress !== this.expectedMac) {
        this.identity = 'mismatch'
        this.retire(generation, 'identity')
        throw new AkaProtocolError('Device identity mismatch')
      }
      this.identity = 'matched'
      await beforeIO()
      this.assertCurrent(generation, operation)
      const cameraOn = await this.http.cameraStatus(operation)
      this.assertCurrent(generation, operation)
      this.cameraOn = cameraOn
      await beforeIO()
      this.assertCurrent(generation, operation)
      const control = new AkaControlChannel(this.ip, this.port)
      this.control = control
      void control.closed.then((reason) => {
        if (!ac.signal.aborted) this.retire(generation, reason === 'closed' ? 'network' : reason)
      })
      await control.open(ac.signal, (value) => this.observe(generation, value))
      this.assertCurrent(generation, operation)
      this.connection = 'connected'
    } catch (error) {
      if (!ac.signal.aborted)
        this.retire(generation, error instanceof AkaTransportError ? error.code : 'response')
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  /** Match the vendor switch: open hardware before subscribing to its MJPEG stream. */
  async openCamera(fps: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 30)
      throw new AkaProtocolError('Invalid stream frame rate')
    this.assertConnected()
    if (this.cameraClosing || this.cameraAbort) throw new AkaProtocolError('Camera is busy')
    const generation = this.generation
    const operation = AbortSignal.any([signal, this.connectionAbort?.signal ?? AbortSignal.abort()])
    const cameraOn = await this.http.setCamera(true, operation)
    this.assertCurrent(generation, operation)
    if (!cameraOn) throw new AkaProtocolError('Camera open not confirmed')
    this.startCamera(fps)
  }

  /** Subscribe only after a camera operation has been authorized by the trusted owner. */
  startCamera(fps: number): void {
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 30)
      throw new AkaProtocolError('Invalid stream frame rate')
    this.assertConnected()
    if (this.cameraClosing) throw new AkaProtocolError('Camera is closing')
    if (this.cameraAbort) throw new AkaProtocolError('Camera stream already active')
    const generation = this.generation
    const mediaGeneration = ++this.mediaGeneration
    const ac = new AbortController()
    this.cameraAbort = ac
    this.media = 'opening'
    // An open receipt does not prove that this stream has delivered a frame.
    this.cameraOn = null
    const finish = (error?: unknown) => {
      if (this.generation !== generation || this.mediaGeneration !== mediaGeneration || ac.signal.aborted)
        return
      this.cameraAbort = undefined
      ac.abort()
      this.frame = undefined
      this.cameraOn = null
      this.media = 'error'
      this.error = error instanceof AkaTransportError ? error.code : 'network'
    }
    try {
      void this.http
        .stream(fps, ac.signal, (frame) => {
          if (this.generation !== generation || this.mediaGeneration !== mediaGeneration || ac.signal.aborted)
            return
          const size = jpegDimensions(frame.bytes)
          if (
            frame.bytes.length > 4 * 1024 * 1024 ||
            size.width !== frame.width ||
            size.height !== frame.height
          )
            throw new AkaProtocolError('Invalid runtime frame')
          this.frame = Object.freeze({
            bytes: Buffer.from(frame.bytes),
            width: frame.width,
            height: frame.height,
            id: `${this.instanceId}:${generation}:${mediaGeneration}:${++this.sequence}`,
            receivedAt: performance.now(),
            timeBasis: 'bridge_receive' as const,
          })
          this.cameraOn = true
          this.media = 'streaming'
          this.error = null
        })
        .then(() => finish(), finish)
    } catch (error) {
      finish(error)
      throw error
    }
  }

  /** Abort media before the hardware close request, preventing late frames from resurrecting state. */
  async closeCamera(signal: AbortSignal): Promise<void> {
    this.assertConnected()
    if (this.cameraClosing) throw new AkaProtocolError('Camera is closing')
    if (signal.aborted) throw new AkaTransportError('cancelled')
    this.cameraClosing = true
    const generation = this.generation
    const operation = AbortSignal.any([signal, this.connectionAbort?.signal ?? AbortSignal.abort()])
    this.detachMedia()
    this.cameraOn = null
    try {
      const cameraOn = await this.http.setCamera(false, operation)
      this.assertCurrent(generation, operation)
      if (cameraOn) throw new AkaProtocolError('Camera close not confirmed')
      this.cameraOn = false
    } catch (error) {
      if (this.generation === generation && this.connection === 'connected') {
        this.error = error instanceof AkaTransportError ? error.code : 'response'
        this.cameraOn = null
      }
      throw error
    } finally {
      this.cameraClosing = false
    }
  }

  disconnect(): void {
    if (this.connection === 'disposed') return
    this.retire(this.generation, null)
    this.connection = 'idle'
  }

  dispose(): void {
    if (this.connection === 'disposed') return
    this.disconnect()
    this.connection = 'disposed'
    this.removeLifetime()
  }

  /** One finite manually authorized action. Completion is a wire receipt, not physical evidence. */
  async controlAction(
    action: 'up' | 'down' | 'left' | 'right' | 'grab' | 'release',
    speed: number,
    milliseconds: number,
    limits: MotionLimits,
    signal: AbortSignal,
  ): Promise<{ state: ControlReceipt['state'] | 'completed'; stop: 'completed' | 'unknown' | null }> {
    this.assertConnected()
    if (this.activeControl || this.stopping || this.controlPhase === 'unknown')
      throw new AkaProtocolError('Previous device action is busy or unresolved')
    signal.throwIfAborted()
    const motion: Motion = { action: action as 'up', mode: 'time', speed, milliseconds }
    const moving = ['up', 'down', 'left', 'right'].includes(action)
    if (moving) motionPath(motion, limits)
    else if (action !== 'grab' && action !== 'release') throw new AkaProtocolError('Invalid control action')
    const controller = new AbortController()
    this.activeControl = controller
    this.controlPhase = moving ? 'moving' : 'gripping'
    const operation = AbortSignal.any([
      signal,
      controller.signal,
      this.connectionAbort?.signal ?? AbortSignal.abort(),
    ])
    let state: ControlReceipt['state'] | 'completed' = 'unknown'
    let stop: 'completed' | 'unknown' | null = null
    const cancelMovement = () => {
      if (moving) void this.stopControl(false).catch(() => undefined)
    }
    operation.addEventListener('abort', cancelMovement, { once: true })
    try {
      if (moving) {
        // Vendor /api/control?time= starts its timer after writing the motor command
        // and replies after stopping. A local WS send callback only proves enqueueing:
        // a local duration could expire before a delayed car processes that packet.
        state = (await this.http.move(motion, limits, operation)).state
      } else {
        state = (await this.http.grip(action as 'grab' | 'release', operation)).state
        // The official arm endpoint accepts an asynchronous sequence. Keep local controls exclusive
        // through its documented sleeps and stall timeout; this wait does not prove possession.
        if (state !== 'unknown')
          await delay(action === 'grab' ? 5000 : 1500, undefined, { signal: operation })
      }
      operation.throwIfAborted()
      if (!moving) this.captureNotBefore = performance.now() + 1000
    } catch {
      state = 'unknown'
    } finally {
      operation.removeEventListener('abort', cancelMovement)
      if (moving) {
        // Even a revoked/disconnected action uses the already-admitted endpoint and a fresh deadline.
        stop = (await this.stopControl(false)).state
        if (stop !== 'completed') state = 'unknown'
      }
      if (this.activeControl === controller) {
        this.activeControl = undefined
        this.controlPhase = state === 'unknown' ? 'unknown' : 'idle'
        this.unresolvedMotion = state === 'unknown' && moving
      }
    }
    return { state, stop }
  }

  /** Independent motor stop; never waits behind movement or implies cancellation of the arm. */
  async stopControl(interrupt = true): Promise<Awaited<ReturnType<AkaHttpDriver['stop']>>> {
    if (this.identity !== 'matched') throw new AkaProtocolError('Confirmed device identity required')
    if (interrupt) this.activeControl?.abort()
    this.control?.stopMotion()
    if (!this.stopping) {
      this.lastStop = 'unknown'
      this.stopping = this.http.stop(AbortSignal.timeout(3000)).catch(() => ({ state: 'unknown' as const }))
    }
    const pending = this.stopping
    const result = await pending
    this.lastStop = result.state
    this.captureNotBefore = performance.now() + 1000
    if (this.stopping === pending) this.stopping = undefined
    // A later explicit, acknowledged chassis stop can retire an uncertain movement.
    // It cannot cancel an arm sequence or release a still-pending transport operation.
    if (interrupt && result.state === 'completed' && !this.activeControl && this.unresolvedMotion) {
      this.controlPhase = 'idle'
      this.unresolvedMotion = false
    }
    return result
  }

  private detachMedia(): void {
    ++this.mediaGeneration
    this.cameraAbort?.abort()
    this.cameraAbort = undefined
    this.frame = undefined
    this.media = 'idle'
  }

  private retire(generation: number, error: RuntimeSnapshot['error']): void {
    if (generation !== this.generation || this.connection === 'disposed') return
    this.connectionAbort?.abort()
    this.control?.close()
    this.control = undefined
    this.connectionAbort = undefined
    this.detachMedia()
    this.cameraOn = null
    this.wheels = undefined
    this.motor = { connected: null, state: null }
    this.error = error
    this.connection = error ? 'degraded' : 'idle'
  }

  private assertConnected(): void {
    if (this.connection !== 'connected' || this.identity !== 'matched')
      throw new AkaProtocolError('Runtime is not connected to the confirmed device')
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (
      generation !== this.generation ||
      signal.aborted ||
      !this.connectionAbort ||
      this.connectionAbort.signal.aborted
    )
      throw new AkaTransportError('cancelled')
  }

  private observe(generation: number, observation: ControlObservation): void {
    if (generation !== this.generation || !this.connectionAbort || this.connectionAbort.signal.aborted) return
    if (observation.kind === 'wheels')
      this.wheels = { report: { ...observation.report }, at: performance.now() }
    else this.motor = { connected: observation.connected, state: observation.state }
  }
}

export interface RuntimeRegistration {
  readonly deviceId: string
  readonly ip: string
  readonly port: number
  readonly macAddress: string
  readonly configRevision: number
}

/** One registry per shared Host plugin instance, never one per chat or page. */
export class AkaRuntimePool {
  private readonly entries = new Map<
    string,
    { registration: Readonly<RuntimeRegistration>; runtime: AkaRuntime }
  >()
  private readonly lifetime = new AbortController()
  private readonly removeLifetime: () => void

  constructor(owner: AbortSignal) {
    // One bounded owner signal for at most 32 entries; each released runtime removes its listener.
    setMaxListeners(33, this.lifetime.signal)
    const dispose = () => this.dispose()
    owner.addEventListener('abort', dispose, { once: true })
    this.removeLifetime = () => owner.removeEventListener('abort', dispose)
    if (owner.aborted) this.dispose()
  }

  get(registration: RuntimeRegistration): AkaRuntime {
    if (this.lifetime.signal.aborted) throw new AkaProtocolError('Runtime pool disposed')
    const { ip, port, configRevision } = registration
    const deviceId = registration.deviceId.toLowerCase()
    const macAddress = registration.macAddress.toLowerCase()
    const endpoint = robotEndpoint(ip, port)
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deviceId) ||
      !Number.isSafeInteger(configRevision) ||
      configRevision < 1
    )
      throw new AkaProtocolError('Invalid runtime registration')
    const current = this.entries.get(deviceId)
    if (current) {
      const previous = current.registration
      if (
        previous.ip !== ip ||
        previous.port !== port ||
        previous.macAddress !== macAddress ||
        previous.configRevision !== configRevision
      )
        throw new AkaProtocolError('Runtime configuration changed; explicitly release before replacement')
      if (current.runtime.snapshot().connection === 'disposed')
        throw new AkaProtocolError('Runtime disposed; explicitly release before replacement')
      return current.runtime
    }
    for (const { registration: previous } of this.entries.values()) {
      if (previous.macAddress === macAddress || robotEndpoint(previous.ip, previous.port) === endpoint)
        throw new AkaProtocolError('Device or endpoint already registered')
    }
    if (this.entries.size >= 32) throw new AkaProtocolError('Runtime capacity exceeded')
    const runtime = new AkaRuntime(ip, port, macAddress, this.lifetime.signal)
    this.entries.set(deviceId, {
      registration: Object.freeze({ deviceId, ip, port, macAddress, configRevision }),
      runtime,
    })
    return runtime
  }

  /** Read-only lookup: a query cannot replace or allocate an endpoint runtime. */
  find(registration: RuntimeRegistration): AkaRuntime | undefined {
    const entry = this.entries.get(registration.deviceId.toLowerCase())
    if (!entry) return undefined
    const previous = entry.registration
    return previous.ip === registration.ip &&
      previous.port === registration.port &&
      previous.macAddress === registration.macAddress.toLowerCase() &&
      previous.configRevision === registration.configRevision
      ? entry.runtime
      : undefined
  }

  release(deviceId: string): void {
    const key = deviceId.toLowerCase()
    this.entries.get(key)?.runtime.dispose()
    this.entries.delete(key)
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    for (const { runtime } of this.entries.values()) runtime.dispose()
    this.entries.clear()
    this.removeLifetime()
  }
}
