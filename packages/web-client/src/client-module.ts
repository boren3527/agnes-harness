/** Client-module adapter: plugin registrations are owned by their Cordis fiber. */
import type { Context } from '@agnes/cordis'
import { CaptureOperationStore } from './capture-operation.js'
import {
  DSH_SLOT_CATALOG_VERSION,
  getDshSlotDefinition,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from './dsh-slot-catalog.js'
import { type RegisterOptions, SlotRegistry } from './registry.js'
import {
  AgnesClientService,
  type ClientCommand,
  type ClientEffectCommand,
  ClientResourceService,
  CommandService,
  LocaleService,
  type ModuleIdentity,
  SessionService,
  ThemeService,
} from './services.js'
import type { SlotName } from './slots.js'

export interface ClientModule {
  inject?: readonly string[]
  apply(ctx: ClientContext, config: ModuleIdentity): unknown
}

export interface ClientContext extends Context {
  slots: SlotRegistry
  agnes: import('./services.js').AgnesClient
  commands: {
    register(command: ClientCommand): () => void
    registerEffect(command: ClientEffectCommand): () => void
    pendingEffect(id: string): Readonly<Record<string, unknown>> | null
    completeEffect(id: string, input: unknown): void
    execute(id: string, input: unknown): Promise<unknown>
  }
  module: ModuleIdentity
  session: import('./services.js').SessionService
  theme: import('./services.js').ThemeService
  locale: import('./services.js').LocaleService
  resources: ClientResourceService
}

export function clientModule(mod: ClientModule): {
  inject: string[]
  apply(ctx: Context, config: ModuleIdentity): unknown
} {
  return {
    // `ctx.agnes` is a host-owned, already-authenticated browser SDK.  Make
    // it an explicit Cordis dependency so client modules never race a partial
    // context and never manufacture a second client.
    inject: [...new Set([...(mod.inject ?? []), 'slots', 'agnes', 'commands', 'session', 'theme', 'locale'])],
    apply(ctx, config) {
      const registry = (ctx as ClientContext).slots
      if (!(registry instanceof SlotRegistry)) {
        throw new Error('clientModule requires the host-provided slots service')
      }
      const bound = createFiberBoundRegistry(
        registry,
        ctx,
        config.rowId ?? config.packageId,
        config.allowedSlots,
        config.slotCatalogVersion,
      )
      const getService = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
      const agnes = getService?.('agnes', false)
      if (!(agnes instanceof AgnesClientService)) {
        throw new Error('clientModule requires the host-provided agnes service')
      }
      const commands = getService?.('commands', false)
      if (!(commands instanceof CommandService)) {
        throw new Error('clientModule requires the host-provided commands service')
      }
      const session = getService?.('session', false)
      if (!(session instanceof SessionService)) {
        throw new Error('clientModule requires the host-provided session service')
      }
      const resources =
        getService?.('resources', false) instanceof ClientResourceService
          ? (getService?.('resources', false) as ClientResourceService)
          : new ClientResourceService(ctx, agnes.client, session)
      const serviceApi = Object.freeze({
        call: async (name: string, input: Record<string, unknown>) => {
          if (!agnes.serviceCaller || !config.services?.includes(name))
            throw new Error(`client service is unavailable: ${name}`)
          const sessionId = session.sessionId
          if (!sessionId) throw new Error('client service requires an active session')
          return await agnes.serviceCaller(config, sessionId, name, input)
        },
      })
      const moduleAgnes = Object.freeze(
        Object.assign(Object.create(agnes.client) as import('./services.js').AgnesClient, {
          services: serviceApi,
        }),
      )
      Object.defineProperty(ctx, 'agnes', { value: moduleAgnes, configurable: true })
      const theme = getService?.('theme', false)
      if (!(theme instanceof ThemeService)) {
        throw new Error('clientModule requires the host-provided theme service')
      }
      const locale = getService?.('locale', false)
      if (!(locale instanceof LocaleService)) {
        throw new Error('clientModule requires the host-provided locale service')
      }
      let effectScope = Symbol('session')
      const stopEffectScope = session.subscribe(() => {
        effectScope = Symbol('session')
      })
      ctx.effect(() => () => {
        effectScope = Symbol('disposed')
        stopEffectScope()
      })
      const completedEffects = new Map<string, (input: unknown) => void>()
      const pendingEffects = new Map<string, () => Record<string, unknown> | null>()
      const boundCommands = {
        register(command: ClientCommand, scope?: () => unknown) {
          const off = commands.register(config.rowId ?? config.packageId, command, scope)
          ctx.effect(() => off)
          return off
        },
        registerEffect(command: ClientEffectCommand) {
          const effectCaller = agnes.effectCaller
          if (!effectCaller || !config.services?.includes(command.service))
            throw new Error(`client effect service is unavailable: ${command.service}`)
          if (
            command.persistCapture &&
            (!command.retainOperation ||
              !['aka.capture', 'aka.recognition.test'].includes(command.service) ||
              config.packageId !== '@agnes-examples/aka-robot-plugin')
          )
            throw new Error('persistent capture is unavailable for this command')
          const captureStore = command.persistCapture
            ? new CaptureOperationStore(
                config.rowId ?? config.packageId,
                config.packageId,
                command.service as 'aka.capture' | 'aka.recognition.test',
              )
            : undefined
          const operations = new WeakMap<
            object,
            {
              sessionId: string
              commandId: string
              input: Record<string, unknown>
              signature: string
              pending: boolean
              completed?: boolean
            }
          >()
          const activeOperations = new Map<string, NonNullable<ReturnType<typeof operations.get>>>()
          const off = this.register(
            {
              id: command.id,
              ...(command.title ? { title: command.title } : {}),
              effectService: command.service,
              execute: async (input: unknown) => {
                if (!input || typeof input !== 'object' || Array.isArray(input))
                  throw new TypeError('client effect input must be an object')
                const sessionId = session.sessionId
                if (!sessionId) throw new Error('client effect requires an active session')
                if (command.retainOperation) {
                  const descriptors = Object.getOwnPropertyDescriptors(input)
                  if (
                    (Object.getPrototypeOf(input) !== Object.prototype &&
                      Object.getPrototypeOf(input) !== null) ||
                    Reflect.ownKeys(descriptors).length > 128 ||
                    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
                    Object.values(descriptors).some(
                      (field) =>
                        !('value' in field) ||
                        !field.enumerable ||
                        !(
                          field.value === null ||
                          typeof field.value === 'string' ||
                          typeof field.value === 'boolean' ||
                          (typeof field.value === 'number' && Number.isFinite(field.value))
                        ),
                    )
                  )
                    throw new TypeError('retained effect input must be flat JSON data')
                  const snapshot = Object.fromEntries(
                    Object.entries(descriptors).map(([key, field]) => [key, field.value]),
                  )
                  const signature = JSON.stringify(snapshot)
                  if (signature.length > 65536) throw new TypeError('retained effect input is too large')
                  let operation = operations.get(input)
                  if (operation && (operation.sessionId !== sessionId || operation.signature !== signature))
                    throw new Error('retained effect identity changed')
                  operation ??= {
                    sessionId,
                    commandId: crypto.randomUUID(),
                    input: Object.freeze(snapshot),
                    signature,
                    pending: false,
                  }
                  if (operation.pending) throw new Error('retained effect is still pending')
                  operations.set(input, operation)
                  const stored = captureStore?.read(sessionId)
                  if (stored && stored.commandId !== operation.commandId)
                    throw new Error('original capture requires readback')
                  captureStore?.write(sessionId, operation.commandId, operation.input)
                  operation.pending = true
                  operation.completed = false
                  activeOperations.set(operation.commandId, operation)
                  try {
                    const result = await effectCaller(
                      config,
                      sessionId,
                      command.service,
                      operation.commandId,
                      operation.input,
                      stored ? { readbackOnly: true } : undefined,
                    )
                    operation.completed = true
                    return result
                  } finally {
                    activeOperations.delete(operation.commandId)
                    operation.pending = false
                  }
                }
                return await effectCaller(
                  config,
                  sessionId,
                  command.service,
                  crypto.randomUUID(),
                  input as Record<string, unknown>,
                )
              },
            },
            () => effectScope,
          )
          let clearRecovery = () => {}
          if (captureStore) {
            const complete = (input: unknown) => {
              const operation = input && typeof input === 'object' ? operations.get(input) : undefined
              if (!operation?.completed || operation.pending || operation.sessionId !== session.sessionId)
                throw new Error('capture completion is unavailable')
              captureStore.clear(operation.sessionId, operation.commandId)
            }
            const read = () => {
              const sessionId = session.sessionId
              if (!sessionId) return null
              const record = captureStore.read(sessionId)
              if (!record) return null
              if (!operations.has(record.input))
                operations.set(
                  record.input,
                  activeOperations.get(record.commandId) ?? {
                    sessionId,
                    commandId: record.commandId,
                    input: record.input,
                    signature: JSON.stringify(record.input),
                    pending: false,
                  },
                )
              return record.input
            }
            completedEffects.set(command.id, complete)
            pendingEffects.set(command.id, read)
            clearRecovery = () => {
              if (completedEffects.get(command.id) === complete) completedEffects.delete(command.id)
              if (pendingEffects.get(command.id) === read) pendingEffects.delete(command.id)
            }
          }
          const stop = () => {
            off()
            clearRecovery()
          }
          ctx.effect(() => stop)
          return stop
        },
        completeEffect(id: string, input: unknown) {
          const complete = completedEffects.get(id)
          if (!complete) throw new Error('capture completion is unavailable')
          complete(input)
        },
        pendingEffect(id: string) {
          return pendingEffects.get(id)?.() ?? null
        },
        execute(id: string, input: unknown) {
          return commands.executeOwned(config.rowId ?? config.packageId, id, input)
        },
      }
      const stop = registry.bindSession(session)
      ctx.effect(() => stop)
      registry.setLocaleSource(locale)
      Object.defineProperty(ctx, 'slots', { value: bound, configurable: true })
      Object.defineProperty(ctx, 'module', { value: config, configurable: true })
      Object.defineProperty(ctx, 'commands', { value: boundCommands, configurable: true })
      Object.defineProperty(ctx, 'session', { value: session, configurable: true })
      Object.defineProperty(ctx, 'resources', { value: resources, configurable: true })
      Object.defineProperty(ctx, 'theme', { value: theme, configurable: true })
      Object.defineProperty(ctx, 'locale', { value: locale, configurable: true })
      return mod.apply(ctx as ClientContext, config)
    },
  }
}

function createFiberBoundRegistry(
  registry: SlotRegistry,
  fiberCtx: Context,
  owner: string,
  allowedSlots: readonly string[] | undefined,
  configCatalogVersion: string | undefined,
): SlotRegistry {
  const bound = Object.create(registry) as SlotRegistry
  bound.register = ((
    nameOrOptions: SlotName | Record<string, unknown>,
    component: unknown,
    options?: RegisterOptions,
  ) => {
    const requestedName =
      typeof nameOrOptions === 'string' ? nameOrOptions : (nameOrOptions as { name?: SlotName }).name
    const registration =
      typeof nameOrOptions === 'string'
        ? { name: nameOrOptions, ...(options ?? {}), owner }
        : { ...nameOrOptions, owner }
    const dshDefinition = getDshSlotDefinition(requestedName as string)
    if (dshDefinition !== undefined) {
      if (!isPublicDshSlot(requestedName as string))
        throw new Error(`client module ${owner} cannot register host-only slot ${requestedName}`)
      if (configCatalogVersion !== DSH_SLOT_CATALOG_VERSION)
        throw new Error(`client module ${owner} uses unsupported slot catalog version`)
      if (!isRuntimeSupportedDshSlot(requestedName as string))
        throw new Error(`client module ${owner} registered an unmounted slot ${requestedName}`)
    }
    if (allowedSlots !== undefined && !allowedSlots.includes(requestedName as string))
      throw new Error(`client module ${owner} registered undeclared slot ${String(requestedName)}`)
    const off = registry.register(registration as never, component)
    fiberCtx.effect(() => off)
    return off
  }) as SlotRegistry['register']
  bound.inject = ((name: string, factory: () => unknown) => {
    const off = registry.inject(name, factory)
    fiberCtx.effect(() => off)
    return off
  }) as SlotRegistry['inject']
  return bound
}
