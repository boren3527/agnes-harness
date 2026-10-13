import { randomUUID } from 'node:crypto'
import { type SeamImplementations, type WorkspaceInvocationView, withTimeout } from '@agnes/core'
import { type ServiceContext, satisfiesApiRange } from '@agnes/extension-api'
import {
  type ExtensionCallParams,
  type ExtensionCallResult,
  inspectJsonData,
  rpcError,
  validateAgainst,
  validateMethod,
} from '@agnes/protocol'
import { Actor, Decision } from '@agnes/protocol/gen/authz'
import type { AuditSink } from '../audit.js'
import { canonicalJson } from '../profile/canonical.js'
import { frozenJson } from './frozen-json.js'
import { pluginRowSource } from './row-extension-host.js'
import type { ServiceRegistration, ServiceRegistry } from './services.js'

/** Supplied by the trusted embedding at assembly, never by a wire request or author. */
export interface ServiceAuthority {
  resolve(credential: unknown): Promise<{
    source: string
    subjectCredential: unknown
    grants: readonly { extension: string; name: string; range: string }[]
  }>
}
/** A daemon-owned proof that an effect has already entered the durable command journal. This is
 * intentionally not part of ExtensionCallParams: a wire caller may name commandId, but cannot mint
 * the matching trusted admission. */
export type ServiceEffectAdmission = Readonly<{
  commandId: string
  /** Private daemon-generated live call correlation; absent on older/direct embeddings. */
  callId?: string
  /** Trusted photo readback only: no fresh selection or artifact writes. Never a public input. */
  recoverOnly?: true
}>
/** Host-private live proof for the verified recognition effect. Never serialized to a plugin. */
export type ServiceInvocationAuthorization = Readonly<{
  revoked: AbortSignal
  assertAuthorized(): Promise<void>
}>
export type ServiceInspection = Readonly<{ kind: 'query' | 'effect' }>
export type PreparedServiceInvocation = Readonly<{
  params: ExtensionCallParams
  entry: ServiceRegistration
}>
export type ServiceInvocationDeps = {
  registry: ServiceRegistry
  authority?: ServiceAuthority
  principals: SeamImplementations['principals']
  audit: AuditSink
  signal: AbortSignal
  context(
    entry: ServiceRegistration,
    identity: Pick<ServiceContext, 'actor' | 'source' | 'requestId' | 'signal' | 'timeoutMs' | 'session'>,
    alive: () => void,
    workspace: WorkspaceInvocationView,
    admission?: ServiceEffectAdmission,
    recognitionAuthorization?: ServiceInvocationAuthorization,
  ): ServiceContext
}

const preDispatchFailures = new WeakSet<object>()

/** Trusted callers use this only to decide whether an effect journal row can be abandoned. It is
 * intentionally process-local: public RPC errors do not reveal which authorization stage failed. */
export function isServicePreDispatchFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && preDispatchFailures.has(error)
}

/** Marks a trusted lifecycle failure that happened before author code could run. */
export function markServicePreDispatchFailure<T extends object>(error: T): T {
  preDispatchFailures.add(error)
  return error
}

export function serviceInvoker(deps: ServiceInvocationDeps) {
  const prepare = (input: ExtensionCallParams): PreparedServiceInvocation => {
    if (!validateMethod('_agnes/v1/extension.call', 'params', input).ok) throw rpcError('INVALID_PARAMS')
    const request = inspectJsonData(input, 1049600)
    if (!request.ok) throw rpcError('INVALID_PARAMS')
    const params = request.value as ExtensionCallParams
    const entry = deps.registry.resolve(params.extension, params.service)
    if (!entry) throw rpcError('CAPABILITY_DENIED')
    return Object.freeze({ params, entry })
  }
  const invoke = async (
    prepared: PreparedServiceInvocation,
    credential: unknown,
    workspace: WorkspaceInvocationView,
    signal?: AbortSignal,
    mode: Readonly<{ kind: 'inspect' }> | Readonly<{ kind: 'call'; admission?: ServiceEffectAdmission }> = {
      kind: 'call',
    },
    session?: ServiceContext['session'],
  ): Promise<ExtensionCallResult | ServiceInspection> => {
    const { params, entry } = prepared
    const cap = entry.capability,
      requestId = randomUUID(),
      ac = new AbortController()
    const combined = AbortSignal.any([ac.signal, deps.signal, entry.signal, ...(signal ? [signal] : [])])
    let active = true,
      admitted = false,
      outcome = 'INTERNAL_ERROR'
    let sourceId: string | undefined, actorId: string | undefined
    const failures = new WeakMap<
      object,
      'CAPABILITY_DENIED' | 'INVALID_PARAMS' | 'REQUEST_TIMEOUT' | 'INTERNAL_ERROR'
    >()
    const fail = (code: 'CAPABILITY_DENIED' | 'INVALID_PARAMS' | 'REQUEST_TIMEOUT' | 'INTERNAL_ERROR') => {
      const error = rpcError(code)
      failures.set(error, code)
      return error
    }
    const timer = setTimeout(() => ac.abort(), cap.timeoutMs)
    const alive = () => {
      if (!active || combined.aborted) throw fail('REQUEST_TIMEOUT')
      try {
        admitted ? entry.assertRunning() : entry.assertAlive()
      } catch {
        throw fail('CAPABILITY_DENIED')
      }
    }
    const run = async (): Promise<ExtensionCallResult | ServiceInspection> => {
      alive()
      if (!deps.authority) throw fail('CAPABILITY_DENIED')
      let source: Awaited<ReturnType<ServiceAuthority['resolve']>>
      try {
        source = await deps.authority.resolve(credential)
      } catch {
        throw fail('CAPABILITY_DENIED')
      }
      if (
        !source.source ||
        !source.grants.some(
          (grant) =>
            grant.extension === entry.owner &&
            grant.name === cap.name &&
            satisfiesApiRange(grant.range, entry.version),
        )
      )
        throw fail('CAPABILITY_DENIED')
      alive()
      sourceId = source.source
      let resolvedActor: ServiceContext['actor']
      try {
        resolvedActor = await deps.principals.resolve(source.subjectCredential, 'service')
      } catch {
        throw fail('CAPABILITY_DENIED')
      }
      const checkedActor = inspectJsonData(resolvedActor)
      if (!checkedActor.ok || !validateAgainst(Actor, checkedActor.value).ok) throw fail('CAPABILITY_DENIED')
      const actor = frozenJson(checkedActor.value) as ServiceContext['actor']
      actorId = actor.id
      alive()
      let decision: Awaited<ReturnType<ServiceInvocationDeps['principals']['authorize']>>
      try {
        decision = await deps.principals.authorize(actor, 'execute', {
          kind: 'datasource',
          id: `${entry.owner}/${cap.name}`,
        })
      } catch {
        throw fail('CAPABILITY_DENIED')
      }
      alive()
      if (decision.effect !== 'allow') throw fail('CAPABILITY_DENIED')
      const input = inspectJsonData(params.input, 1048576)
      if (!input.ok || !entry.input(input.value)) throw fail('INVALID_PARAMS')
      if (mode.kind === 'inspect') return { kind: cap.kind }
      if (cap.kind === 'effect') {
        if (!params.commandId) throw fail('INVALID_PARAMS')
        if (mode.admission?.commandId !== params.commandId) throw fail('CAPABILITY_DENIED')
        if (
          mode.admission.recoverOnly !== undefined &&
          (mode.admission.recoverOnly !== true ||
            entry.owner !== pluginRowSource('ext:agnes-examples/aka-robot') ||
            cap.name !== 'aka.capture')
        )
          throw fail('CAPABILITY_DENIED')
        if (
          mode.admission.callId !== undefined &&
          (typeof mode.admission.callId !== 'string' || !/^[a-f0-9]{32}$/.test(mode.admission.callId))
        )
          throw fail('CAPABILITY_DENIED')
      } else if (mode.admission) throw fail('CAPABILITY_DENIED')
      const recognitionAuthorization: ServiceInvocationAuthorization | undefined =
        mode.kind === 'call' &&
        cap.kind === 'effect' &&
        mode.admission?.callId &&
        entry.owner === pluginRowSource('ext:agnes-examples/aka-robot') &&
        ['aka.recognition.test', 'aka.recognition.enable'].includes(cap.name)
          ? Object.freeze({
              revoked: combined,
              assertAuthorized: async () => {
                alive()
                try {
                  if (!deps.authority) throw fail('CAPABILITY_DENIED')
                  const current = await deps.authority.resolve(credential)
                  alive()
                  if (
                    current.source !== source.source ||
                    !current.grants.some(
                      (grant) =>
                        grant.extension === entry.owner &&
                        grant.name === cap.name &&
                        satisfiesApiRange(grant.range, entry.version),
                    )
                  )
                    throw fail('CAPABILITY_DENIED')
                  const resolved = inspectJsonData(
                    await deps.principals.resolve(current.subjectCredential, 'service'),
                  )
                  alive()
                  if (
                    !resolved.ok ||
                    !validateAgainst(Actor, resolved.value).ok ||
                    canonicalJson(resolved.value) !== canonicalJson(actor)
                  )
                    throw fail('CAPABILITY_DENIED')
                  const checked = inspectJsonData(
                    await deps.principals.authorize(actor, 'execute', {
                      kind: 'datasource',
                      id: `${entry.owner}/${cap.name}`,
                    }),
                  )
                  alive()
                  if (!checked.ok || !validateAgainst(Decision, checked.value).ok)
                    throw fail('CAPABILITY_DENIED')
                  const decision = checked.value as { effect: string; expiresAt?: string }
                  if (
                    decision.effect !== 'allow' ||
                    (decision.expiresAt !== undefined && Date.parse(decision.expiresAt) <= Date.now())
                  )
                    throw fail('CAPABILITY_DENIED')
                } catch {
                  alive()
                  throw fail('CAPABILITY_DENIED')
                }
              },
            })
          : undefined
      const context = deps.context(
        entry,
        {
          actor,
          source: sourceId,
          requestId,
          signal: combined,
          timeoutMs: cap.timeoutMs,
          ...(session ? { session } : {}),
        },
        alive,
        workspace,
        cap.kind === 'effect' && mode.admission
          ? Object.freeze({
              commandId: mode.admission.commandId,
              ...(mode.admission.callId ? { callId: mode.admission.callId } : {}),
              ...(mode.admission.recoverOnly ? { recoverOnly: true as const } : {}),
            })
          : undefined,
        recognitionAuthorization,
      )
      alive()
      entry.consume()
      admitted = true
      const value = await entry.handler(input.value, context)
      alive()
      const output = inspectJsonData(value, cap.maxResultBytes)
      if (!output.ok || !entry.output(output.value)) throw fail('INTERNAL_ERROR')
      return { output: output.value }
    }
    let result: ExtensionCallResult | ServiceInspection | undefined,
      failure: ReturnType<typeof rpcError> | undefined
    try {
      result = await withTimeout(run(), cap.timeoutMs, 'service', combined)
      outcome = mode.kind === 'inspect' ? 'inspected' : 'ok'
    } catch (error) {
      const code = error && typeof error === 'object' ? failures.get(error) : undefined
      const safe = code ?? (combined.aborted ? 'REQUEST_TIMEOUT' : 'INTERNAL_ERROR')
      outcome = safe
      failure = rpcError(safe)
      if (!admitted) markServicePreDispatchFailure(failure)
    } finally {
      active = false
      clearTimeout(timer)
      ac.abort()
    }
    try {
      deps.audit.write({
        kind: 'extension.service-call',
        detail: {
          extension: entry.owner,
          service: cap.name,
          requestId,
          kind: cap.kind,
          mode: mode.kind,
          outcome,
          ...(sourceId ? { source: sourceId } : {}),
          ...(actorId ? { actorId } : {}),
        },
      })
    } catch {
      const auditFailure = rpcError('INTERNAL_ERROR')
      if (!admitted) markServicePreDispatchFailure(auditFailure)
      throw auditFailure
    }
    if (failure) throw failure
    if (!result) throw rpcError('INTERNAL_ERROR')
    return result
  }
  return {
    prepare,
    callPrepared: (
      prepared: PreparedServiceInvocation,
      credential: unknown,
      workspace: WorkspaceInvocationView,
      signal?: AbortSignal,
      admission?: ServiceEffectAdmission,
      session?: ServiceContext['session'],
    ): Promise<ExtensionCallResult> =>
      invoke(
        prepared,
        credential,
        workspace,
        signal,
        {
          kind: 'call',
          ...(admission ? { admission } : {}),
        },
        session,
      ) as Promise<ExtensionCallResult>,
    inspectPrepared: (
      prepared: PreparedServiceInvocation,
      credential: unknown,
      workspace: WorkspaceInvocationView,
      signal?: AbortSignal,
    ): Promise<ServiceInspection> =>
      invoke(prepared, credential, workspace, signal, { kind: 'inspect' }) as Promise<ServiceInspection>,
    call: (
      params: ExtensionCallParams,
      credential: unknown,
      workspace: WorkspaceInvocationView,
      signal?: AbortSignal,
      admission?: ServiceEffectAdmission,
    ): Promise<ExtensionCallResult> =>
      Promise.resolve().then(
        () =>
          invoke(prepare(params), credential, workspace, signal, {
            kind: 'call',
            ...(admission ? { admission } : {}),
          }) as Promise<ExtensionCallResult>,
      ),
    inspect: (
      params: ExtensionCallParams,
      credential: unknown,
      workspace: WorkspaceInvocationView,
      signal?: AbortSignal,
    ): Promise<ServiceInspection> =>
      Promise.resolve().then(
        () =>
          invoke(prepare(params), credential, workspace, signal, {
            kind: 'inspect',
          }) as Promise<ServiceInspection>,
      ),
  }
}
