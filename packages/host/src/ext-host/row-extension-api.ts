import {
  checkToolDef,
  type Disposer,
  type ExtensionAPI,
  type ExtensionContext,
  ExtensionError,
  extEventType,
  HOOK_TABLE,
  type HookEvent,
  type HookHandler,
  type PluginExtensionAPI,
  type ToolDef,
} from '@agnes/extension-api'
import { inspectJsonData, isHookEvent } from '@agnes/protocol'
import { deviceSessionPort } from './device-session-port.js'
import type { Lease } from './lease.js'
import type { KernelPorts, RegMeta } from './ports.js'
import { projectionReader } from './projection-reader.js'
import { invalidToolMessage } from './tool-def-message.js'

/** Hook events whose kernel table entry is observe-only; a plugin row may listen to these and nothing else. */
export const OBSERVE_HOOK_EVENTS: readonly HookEvent[] = Object.freeze(
  (Object.keys(HOOK_TABLE) as HookEvent[]).filter((event) => HOOK_TABLE[event].category === 'observe'),
)
const OBSERVE = new Set<string>(OBSERVE_HOOK_EVENTS)

export type RowExtensionApiInput = {
  imageGenerationConfiguration?: NonNullable<
    NonNullable<import('@agnes/extension-api').ToolContext['imageGeneration']>['configuration']
  >
  imageGeneration?: (
    input: Parameters<
      NonNullable<import('@agnes/extension-api').ToolContext['imageGeneration']>['subject']
    >[0],
    signal: AbortSignal,
  ) => ReturnType<NonNullable<import('@agnes/extension-api').ToolContext['imageGeneration']>['subject']>
  deviceMedia?: PluginExtensionAPI['deviceMedia']
  deviceSession?: (
    sessionKey: string,
    signal: AbortSignal,
    view?: 'connection' | 'recognition',
  ) => Promise<unknown>
  mcpManage?: (
    invocation: Pick<
      import('../resources/mcp-manage-port.js').McpManageInvocation,
      'input' | 'toolUseId' | 'sessionKey'
    >,
    signal: AbortSignal,
  ) => Promise<unknown>
  pluginManage?: (
    invocation: Pick<
      import('../resources/plugin-manage-port.js').PluginManageInvocation,
      'input' | 'toolUseId' | 'sessionKey'
    >,
    signal: AbortSignal,
  ) => Promise<unknown>
  skillInstall?: (
    invocation: Pick<
      import('../resources/skill-install-port.js').SkillInstallInvocation,
      'input' | 'toolUseId' | 'sessionKey'
    >,
    signal: AbortSignal,
  ) => Promise<import('@agnes/extension-api').SkillInstallResult>
  /** Host-stamped `plugin/<hash>` owner id; never chosen by the plugin. */
  source: string
  version: string
  packageIdentity: string
  packageVersion: string
  lease: Lease
  signal: AbortSignal
  /** Set only when this row claims a builtin extension's own row id (third-party-transform-directive
   *  -hooks design §3 point 3); an ordinary third-party row never receives one. Gives every hook this
   *  row registers the replaced builtin's fixed dispatch rank, so it keeps running ahead of the
   *  third-party layer instead of being pushed behind it. */
  hookRank?: number
  /** Runs `create` against the kernel now, or once the kernel is bound. The disposer cancels either. */
  attach(kind: 'tool' | 'hook', name: string, create: (ports: KernelPorts) => Disposer): Disposer
  /** The kernel ports, or undefined while the Host is still assembling. */
  ports(): KernelPorts | undefined
  /** True when a tool name belongs to a builtin extension this row does not replace. */
  reservedTool(name: string): boolean
  info: ExtensionContext['info']
  /** Read on every access: the facts only exist once the Host has assembled its platform. */
  platform(): ExtensionContext['platform']
  log: ExtensionContext['log']
}

/**
 * The API a plugin row gets: tools, observe-only hooks and ledger events. There is no manifest for a
 * plugin row, so nothing here reads one; the lease and the fixed rules below are the whole policy.
 */
export function buildRowExtensionAPI(input: RowExtensionApiInput): PluginExtensionAPI {
  const { source, lease, signal } = input
  const meta: RegMeta = Object.freeze({
    source,
    trust: 'trusted',
    ...(input.hookRank === undefined ? {} : { hookRank: input.hookRank }),
  })
  const toolMeta: RegMeta = Object.freeze({
    source,
    trust: 'trusted',
    packageIdentity: input.packageIdentity,
    packageVersion: input.packageVersion,
  })
  const log = Object.freeze({
    debug: input.log.debug.bind(input.log),
    info: input.log.info.bind(input.log),
    warn: input.log.warn.bind(input.log),
    error: input.log.error.bind(input.log),
  })
  const refuse = (message: string): never => {
    throw new ExtensionError('E_CAPABILITY_UNDECLARED', message, { extId: source })
  }
  const alive = () => {
    lease.assertAlive('execute')
    if (signal.aborted) throw new ExtensionError('E_LEASE_EXPIRED', 'extension is closed', { extId: source })
  }
  // Registration is open for as long as the row is mounted: a Cordis restart re-runs apply without
  // any lifecycle state that marks the window, and everything registered dies with the row anyway.
  const registering = alive
  const ctx: ExtensionContext = Object.freeze({
    extId: source,
    version: input.version,
    trust: 'trusted',
    get lease() {
      return lease.view()
    },
    info: Object.freeze({ ...input.info }),
    get platform() {
      return input.platform()
    },
    log,
    signal,
  })
  const denied = (what: string) => () => refuse(`${what} is not open to plugin rows`)
  const invokeHook = async <E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    payload: Parameters<HookHandler<E>>[0],
    hctx: Parameters<HookHandler<E>>[1],
    projections: import('@agnes/extension-api').ProjectionReader,
  ) => {
    if (event !== 'shutdown') alive()
    const { device: _device, ...hookContext } = hctx
    const lifetime = new AbortController()
    const callSignal = AbortSignal.any([
      hctx.signal,
      ...(event === 'shutdown' ? [] : [signal]),
      lifetime.signal,
    ])
    const assertLive = () => {
      lease.assertInvocationAlive()
      callSignal.throwIfAborted()
    }
    try {
      return await handler(
        payload,
        Object.freeze({
          ...hookContext,
          ...(event !== 'shutdown' && input.deviceSession
            ? { device: deviceSessionPort(hctx.session.key, input.deviceSession, callSignal, assertLive) }
            : {}),
          projections,
          lease: lease.view(),
          log,
          signal: callSignal,
        }),
      )
    } finally {
      lifetime.abort()
    }
  }
  const api = {
    ...(input.deviceMedia ? { deviceMedia: input.deviceMedia } : {}),
    ctx,
    registerTool(def: ToolDef) {
      registering()
      let copy: ToolDef
      try {
        copy = {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          meta: structuredClone(def.meta),
          ...(def.policyVersion === undefined ? {} : { policyVersion: def.policyVersion }),
          ...(def.classify === undefined ? {} : { classify: def.classify }),
          execute: def.execute,
        }
      } catch {
        throw new ExtensionError('E_TOOLDEF_META', 'invalid tool definition', { extId: source })
      }
      const checked = checkToolDef(copy, { prefix: '' })
      if (!checked.ok)
        throw new ExtensionError('E_TOOLDEF_META', invalidToolMessage(copy.name, checked.problems), {
          extId: source,
        })
      if (input.reservedTool(copy.name)) refuse('tool name is reserved for a builtin extension')
      if (!lease.allows('toolPrefix', copy.name)) refuse('tool outside lease scope')
      const execute = copy.execute.bind(copy)
      return input.attach('tool', copy.name, (ports) => {
        const projections = projectionReader(ports.projections, meta, lease, alive, [])
        const wrapped: ToolDef = {
          ...copy,
          execute: async (args, tctx) => {
            alive()
            lease.consume()
            let finished = false
            let imageRequested = false
            const imageViews = new Set<string>()
            let referenceDescription: string | undefined
            let referenceViews = false
            const lifetime = new AbortController()
            const callSignal = AbortSignal.any([tctx.signal, signal, lifetime.signal])
            const skillInstall = input.skillInstall
            const imageGeneration = input.imageGeneration
            const imageGenerationConfiguration = input.imageGenerationConfiguration
            const mcpManage = input.mcpManage
            const pluginManage = input.pluginManage
            const { device: _device, imageGeneration: _imageGeneration, ...toolContext } = tctx
            try {
              return await execute(args, {
                ...toolContext,
                ...(imageGeneration &&
                copy.meta.requiresApproval === 'always' &&
                !copy.meta.isReadOnly &&
                !copy.classify
                  ? {
                      imageGeneration: Object.freeze({
                        ...(imageGenerationConfiguration
                          ? {
                              configuration: async () => {
                                lease.assertInvocationAlive()
                                if (finished || callSignal.aborted)
                                  throw new Error('Image generation invocation expired')
                                const result = await imageGenerationConfiguration()
                                lease.assertInvocationAlive()
                                if (finished || callSignal.aborted)
                                  throw new Error('Image generation invocation expired')
                                return {
                                  revision: result.revision,
                                  model: result.model,
                                  size: result.size,
                                  enabled: result.enabled,
                                }
                              },
                            }
                          : {}),
                        subject: async (
                          request: Parameters<NonNullable<typeof tctx.imageGeneration>['subject']>[0],
                        ) => {
                          const assertLive = () => {
                            lease.assertInvocationAlive()
                            if (finished || callSignal.aborted)
                              throw new Error('Image generation invocation expired')
                          }
                          assertLive()
                          const referenceView =
                            request.view && ['front', 'right', 'back', 'left'].includes(request.view)
                          if (
                            imageRequested &&
                            (!referenceViews ||
                              !referenceView ||
                              request.description !== referenceDescription ||
                              imageViews.has(request.view ?? '') ||
                              imageViews.size >= 4)
                          )
                            throw new Error('Only one image generation request per tool invocation')
                          if (!imageRequested) {
                            referenceViews =
                              Boolean(referenceView) &&
                              typeof request.description === 'string' &&
                              request.description.trim().length >= 20
                            referenceDescription = request.description
                          }
                          imageRequested = true
                          if (request.view) imageViews.add(request.view)
                          const result = await imageGeneration(request, callSignal)
                          assertLive()
                          return result
                        },
                      }),
                    }
                  : {}),
                ...(input.deviceSession
                  ? {
                      device: deviceSessionPort(tctx.session.key, input.deviceSession, callSignal, () => {
                        lease.assertInvocationAlive()
                        if (finished || callSignal.aborted) throw new Error('Device invocation expired')
                      }),
                    }
                  : {}),
                projections,
                ...(mcpManage
                  ? {
                      mcpManage: Object.freeze({
                        request: async (request: unknown) => {
                          const assertLive = () => {
                            lease.assertInvocationAlive()
                            if (finished || callSignal.aborted)
                              throw new Error('MCP management invocation expired')
                            if (tctx.session.depth !== 0) throw new Error('Subagents cannot manage MCP')
                          }
                          assertLive()
                          const result = await mcpManage(
                            {
                              input: structuredClone(request),
                              toolUseId: tctx.session.toolUseId,
                              sessionKey: tctx.session.key,
                            },
                            callSignal,
                          )
                          assertLive()
                          return result
                        },
                      }),
                    }
                  : {}),
                ...(pluginManage
                  ? {
                      pluginManage: Object.freeze({
                        request: async (request: unknown) => {
                          const assertLive = () => {
                            lease.assertInvocationAlive()
                            if (finished || callSignal.aborted)
                              throw new Error('plugins management invocation expired')
                            if (tctx.session.depth !== 0) throw new Error('Subagents cannot manage plugins')
                          }
                          assertLive()
                          const result = await pluginManage(
                            {
                              input: structuredClone(request),
                              toolUseId: tctx.session.toolUseId,
                              sessionKey: tctx.session.key,
                            },
                            callSignal,
                          )
                          assertLive()
                          return result
                        },
                      }),
                    }
                  : {}),
                ...(skillInstall
                  ? {
                      skillInstall: Object.freeze({
                        request: async (request: import('@agnes/extension-api').SkillInstallRequest) => {
                          lease.assertInvocationAlive()
                          if (finished || callSignal.aborted)
                            throw new Error('Skill installation invocation expired')
                          if (tctx.session.depth !== 0)
                            throw new Error('Subagents cannot request Skill installation')
                          const result = await skillInstall(
                            {
                              input: structuredClone(request),
                              toolUseId: tctx.session.toolUseId,
                              sessionKey: tctx.session.key,
                            },
                            callSignal,
                          )
                          lease.assertInvocationAlive()
                          if (finished || callSignal.aborted)
                            throw new Error('Skill installation invocation expired')
                          return result
                        },
                      }),
                    }
                  : {}),
              })
            } finally {
              finished = true
              lifetime.abort()
            }
          },
        }
        return ports.tools.add(wrapped, toolMeta)
      })
    },
    on<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>) {
      registering()
      if (!OBSERVE.has(event) || typeof handler !== 'function')
        return refuse('only observe-only hook events are open to plugin rows')
      return input.attach('hook', event, (ports) => {
        const projections = projectionReader(ports.projections, meta, lease, alive, [])
        const observed = async (
          payload: Parameters<HookHandler<E>>[0],
          hctx: Parameters<HookHandler<E>>[1],
        ) => {
          // Observe-only: whatever the handler returns is dropped, a throw is the kernel's to report.
          await invokeHook(event, handler, payload, hctx, projections)
        }
        return ports.hooks.on(event, observed as unknown as HookHandler<E>, meta)
      })
    },
    events: Object.freeze({
      append(name: string, value: Parameters<ExtensionAPI['events']['append']>[1]) {
        alive()
        if (!lease.allows('event', name)) refuse('events not granted')
        const ports = input.ports()
        if (!ports) throw new ExtensionError('E_EVENT_NAMESPACE', 'extension event has no active session')
        const type = extEventType(source, name)
        const data = inspectJsonData(value)
        if (!data.ok)
          throw new ExtensionError('E_EVENT_NAMESPACE', 'invalid event JSON payload', { extId: source })
        return ports.extEvents.append(type, data.value, meta)
      },
    }),
    registerHook<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>) {
      registering()
      if (typeof handler !== 'function' || !isHookEvent(event)) return refuse('invalid hook registration')
      return input.attach('hook', event, (ports) => {
        const projections = projectionReader(ports.projections, meta, lease, alive, [])
        // Unlike `on` above, the handler's real return value reaches the kernel: this is what lets a
        // transform/intercept-category event actually chain or short-circuit, not just observe.
        const wrapped = (payload: Parameters<HookHandler<E>>[0], hctx: Parameters<HookHandler<E>>[1]) => {
          return invokeHook(event, handler, payload, hctx, projections)
        }
        return ports.hooks.on(event, wrapped as unknown as HookHandler<E>, meta)
      })
    },
    registerSlot: denied('slots'),
    registerService: denied('services'),
    registerProjection: denied('projections'),
    registerResource: denied('resources'),
  }
  return Object.freeze(api) as unknown as PluginExtensionAPI
}
