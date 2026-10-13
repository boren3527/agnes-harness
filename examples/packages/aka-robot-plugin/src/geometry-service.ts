import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ServiceContext, ServiceDef } from '@agnes/extension-api'
import type { CaptureDependencies } from './capture-frame.js'
import { readRegistration } from './connection-profile.js'
import { estimateGround, fitGround } from './geometry.js'
import { AkaProtocolError } from './protocol.js'

type GeometryContext = Pick<ServiceContext, 'device' | 'session' | 'fs' | 'signal'>
type Image = {
  selectedAt?: string
  receivedAt?: number
  frameId?: string
  artifact?: { sha256: string; size: number; mime: string }
  id: string
  deviceId: string
  bindingRevision: number
  width: number
  height: number
  detections: readonly {
    label: string
    confidence?: number
    box: readonly [number, number, number, number]
  }[]
}
type Source = { image: Image; sessionId: string; workspaceId: string; configRevision: number }
export class GroundGeometry {
  private readonly saving = new Set<string>()
  private readonly results = new Map<string, Source>()
  private readonly calibrations = new Map<string, ReturnType<typeof fitGround>>()
  constructor(private readonly deps: CaptureDependencies) {}
  private calibrationKey(
    binding: { workspaceId: string; deviceId: string; bindingRevision: number },
    configRevision: number,
  ) {
    return JSON.stringify([binding.workspaceId, binding.deviceId, binding.bindingRevision, configRevision])
  }
  cached(
    binding: { workspaceId: string; deviceId: string; bindingRevision: number },
    configRevision: number,
  ) {
    const value = this.calibrations.get(this.calibrationKey(binding, configRevision))
    return value ? structuredClone(value) : null
  }
  async remember(ctx: GeometryContext, image: Image, configRevision: number) {
    const binding = await ctx.device?.binding()
    if (
      !binding?.active ||
      binding.sessionId !== ctx.session?.key ||
      binding.deviceId !== image.deviceId ||
      binding.bindingRevision !== image.bindingRevision
    )
      throw new AkaProtocolError('Image scope changed')
    this.results.set(image.id, {
      image: structuredClone(image),
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      configRevision,
    })
    while (this.results.size > 128) {
      const oldest = this.results.keys().next().value
      if (!oldest) break
      this.results.delete(oldest)
    }
  }
  latest(sessionId: string | undefined, deviceId: string, bindingRevision: number) {
    const source = [...this.results.values()]
      .reverse()
      .find(
        (item) =>
          item.sessionId === sessionId &&
          item.image.deviceId === deviceId &&
          item.image.bindingRevision === bindingRevision,
      )
    return source
      ? {
          resultId: source.image.id,
          selectedAt: source.image.selectedAt ?? null,
          width: source.image.width,
          height: source.image.height,
          detectionCount: source.image.detections.length,
          detections: structuredClone(source.image.detections.slice(0, 4)),
        }
      : null
  }
  async observation(
    ctx: GeometryContext,
    input: { bindingRevision: number; configRevision: number },
    since: number,
    afterReceivedAt?: number,
    maxAgeMs = 2000,
  ) {
    // Longer cloud waits are allowed only for frames captured after a task's last stop.
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000)
      throw new AkaProtocolError('Invalid observation age')
    const scope = await this.scope(ctx, input)
    const source = [...this.results.values()]
      .reverse()
      .find(
        (item) =>
          item.sessionId === scope.binding.sessionId &&
          item.workspaceId === scope.binding.workspaceId &&
          item.image.deviceId === scope.binding.deviceId &&
          item.image.bindingRevision === input.bindingRevision &&
          item.configRevision === input.configRevision &&
          item.image.selectedAt &&
          (afterReceivedAt === undefined ||
            (typeof item.image.receivedAt === 'number' &&
              Number.isFinite(item.image.receivedAt) &&
              item.image.receivedAt > afterReceivedAt)) &&
          Date.parse(item.image.selectedAt) >= since &&
          Date.parse(item.image.selectedAt) <= Date.now() &&
          Date.now() - Date.parse(item.image.selectedAt) <= maxAgeMs &&
          item.image.artifact &&
          item.image.frameId,
      )
    return source ? structuredClone(source.image) : null
  }
  private async scope(ctx: GeometryContext, input: { bindingRevision: number; configRevision: number }) {
    const binding = await ctx.device?.binding()
    if (
      !binding?.active ||
      !ctx.device ||
      !ctx.session ||
      binding.sessionId !== ctx.session.key ||
      binding.bindingRevision !== input.bindingRevision
    )
      throw new AkaProtocolError('Geometry scope unavailable')
    const profile = await readRegistration(ctx.device, binding, this.deps.registrations)
    if (!profile || profile.configRevision !== input.configRevision)
      throw new AkaProtocolError('Geometry configuration changed')
    return {
      binding,
      path: join(ctx.session.workspaceRoot, '.agh-device', 'calibration', `${binding.deviceId}.json`),
    }
  }
  async read(ctx: GeometryContext, input: { bindingRevision: number; configRevision: number }) {
    const scope = await this.scope(ctx, input)
    const key = this.calibrationKey(scope.binding, input.configRevision)
    this.calibrations.delete(key)
    let text: string
    try {
      const stat = await ctx.fs.stat(scope.path)
      if (stat.kind !== 'file' || stat.size > 65536) throw new Error('Invalid calibration size')
      text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.fs.read(scope.path))
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw new AkaProtocolError('Ground calibration read failed')
    }
    if (text.length > 65536) throw new AkaProtocolError('Ground calibration too large')
    try {
      const stored = JSON.parse(text)
      if (
        stored.deviceId !== scope.binding.deviceId ||
        stored.bindingRevision !== input.bindingRevision ||
        stored.configRevision !== input.configRevision
      )
        return null
      const c = stored.calibration
      if (!c || !/^[a-f0-9-]{36}$/.test(c.id) || !Number.isSafeInteger(c.revision) || c.revision < 1)
        throw new Error('Invalid calibration')
      const calibration = fitGround(
        {
          width: c.width,
          height: c.height,
          installation: c.installation,
          labels: c.labels,
          points: c.points,
          checks: c.checks,
          measurementErrorMeters: c.measurementErrorMeters,
          ...(c.motion === undefined ? {} : { motion: c.motion }),
          ...(c.grasp === undefined ? {} : { grasp: c.grasp }),
          ...(c.routes === undefined ? {} : { routes: c.routes }),
        },
        c.id,
        c.revision,
      )
      this.calibrations.set(key, calibration)
      while (this.calibrations.size > 128) {
        const oldest = this.calibrations.keys().next().value
        if (!oldest) break
        this.calibrations.delete(oldest)
      }
      return calibration
    } catch {
      throw new AkaProtocolError('Ground calibration invalid')
    }
  }
  async save(
    ctx: GeometryContext,
    input: {
      bindingRevision: number
      configRevision: number
      expectedRevision: number
      calibration: unknown
    },
  ) {
    const scope = await this.scope(ctx, input)
    if (this.saving.has(scope.path)) throw new AkaProtocolError('Ground calibration save busy')
    this.saving.add(scope.path)
    try {
      const current = await this.read(ctx, input)
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
        input.expectedRevision !== (current?.revision ?? 0)
      )
        throw new AkaProtocolError('Ground calibration version changed')
      const calibration = fitGround(
        input.calibration,
        current?.id ?? randomUUID(),
        input.expectedRevision + 1,
      )
      const record = {
        deviceId: scope.binding.deviceId,
        bindingRevision: input.bindingRevision,
        configRevision: input.configRevision,
        calibration,
      }
      ctx.signal.throwIfAborted()
      await this.scope(ctx, input)
      await ctx.fs.write(scope.path, JSON.stringify(record))
      const verified = await this.read(ctx, input)
      if (!verified || JSON.stringify(verified) !== JSON.stringify(calibration))
        throw new AkaProtocolError('Ground calibration save unconfirmed')
      return verified
    } finally {
      this.saving.delete(scope.path)
    }
  }

  async estimate(
    ctx: GeometryContext,
    input: { bindingRevision: number; configRevision: number; resultId: string },
  ) {
    const scope = await this.scope(ctx, input),
      source = this.results.get(input.resultId)
    if (
      !source ||
      source.sessionId !== ctx.session?.key ||
      source.workspaceId !== scope.binding.workspaceId ||
      source.image.deviceId !== scope.binding.deviceId ||
      source.image.bindingRevision !== input.bindingRevision ||
      source.configRevision !== input.configRevision
    )
      throw new AkaProtocolError('Original recognition result unavailable')
    const calibration = await this.read(ctx, input)
    return {
      resultId: input.resultId,
      selectedAt: source.image.selectedAt ?? null,
      frameId: source.image.frameId ?? null,
      calibration: calibration
        ? {
            id: calibration.id,
            revision: calibration.revision,
            installation: calibration.installation,
            ...(calibration.motion ? { motion: calibration.motion } : {}),
            ...(calibration.grasp ? { grasp: calibration.grasp } : {}),
          }
        : null,
      estimates: source.image.detections.map((item, index) => ({
        index,
        label: item.label,
        confidence: item.confidence ?? null,
        box: [...item.box],
        ...estimateGround(calibration, source.image, item.label, item.box),
      })),
    }
  }
}
export function registerGeometry(register: (def: ServiceDef) => unknown, geometry: GroundGeometry) {
  for (const operation of ['read', 'save', 'estimate'] as const) {
    const extra =
      operation === 'save'
        ? { expectedRevision: { type: 'integer', minimum: 0 }, calibration: { type: 'object' } }
        : operation === 'estimate'
          ? { resultId: { type: 'string', maxLength: 64 } }
          : {}
    register({
      name: `aka.geometry.${operation}`,
      kind: operation === 'save' ? 'effect' : 'query',
      timeoutMs: 5000,
      maxResultBytes: operation === 'estimate' ? 512 * 1024 : 65536,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bindingRevision: { type: 'integer', minimum: 1 },
          configRevision: { type: 'integer', minimum: 1 },
          ...extra,
        },
        required: ['bindingRevision', 'configRevision', ...Object.keys(extra)],
      },
      outputSchema: { type: ['object', 'null'] },
      async handler(input, ctx) {
        const v = input as {
          bindingRevision: number
          configRevision: number
          expectedRevision: number
          calibration: unknown
          resultId: string
        }
        if (operation === 'read') return geometry.read(ctx, v) as unknown as ReturnType<ServiceDef['handler']>
        if (operation === 'save') return geometry.save(ctx, v) as unknown as ReturnType<ServiceDef['handler']>
        return geometry.estimate(ctx, v)
      },
    })
  }
}
