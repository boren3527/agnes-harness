import { platformView, type SeamImplementations } from '@agnes/core'
import type { Logger, ServiceContext } from '@agnes/extension-api'
import { type Decision, inspectJsonData, validateAgainst } from '@agnes/protocol'
import { Action, Decision as DecisionSchema, Target } from '@agnes/protocol/gen/authz'
import { createNetFetch } from '../adapters/net.js'
import { deviceCaptureArtifactsPort } from './device-capture-artifacts-port.js'
import {
  type DeviceRecognitionAuthorizationRegistrar,
  recognitionIOAuthorization,
} from './device-recognition-authorization.js'
import {
  type DeviceRecognitionBudgetBridge,
  deviceRecognitionBudgetPort,
} from './device-recognition-budget-port.js'
import { deviceRecognitionPort } from './device-recognition-port.js'
import { deviceSessionPort } from './device-session-port.js'
import { frozenJson } from './frozen-json.js'
import { pluginRowSource } from './row-extension-host.js'
import type { ServiceInvocationDeps } from './service-invocation.js'

/** Queries cannot open a side-effect path around the deferred durable effect executor. */
export function serviceContext(deps: {
  seams: SeamImplementations
  networkAllow: readonly string[]
  recognitionNetworkAllow?: readonly string[]
  log: Logger
  deviceSession?: (
    sessionKey: string,
    signal: AbortSignal,
    view?: 'connection' | 'recognition',
  ) => Promise<unknown>
  deviceRecognitionBudget?: DeviceRecognitionBudgetBridge
  deviceRecognitionAuthorization?: DeviceRecognitionAuthorizationRegistrar
  deviceRecognitionExecute?: import('../assembly-deps.js').AssembleDeps['deviceRecognitionExecute']
  deviceCaptureSelection?: import('../assembly-deps.js').AssembleDeps['deviceCaptureSelection']
  deviceSessionRetain?: import('./device-session-port.js').DeviceSessionRetainer
  capturePublisher?: import('./device-capture-publisher.js').DeviceCapturePublisher
}): ServiceInvocationDeps['context'] {
  return (entry, identity, alive, workspace, admission, authorization) => {
    const refuse = (): never => {
      throw new Error('service operation unavailable')
    }
    const read = async <T>(fn: () => Promise<T>): Promise<T> => {
      alive()
      const result = await fn()
      alive()
      return result
    }
    const artifacts = () => {
      alive()
      if (entry.manifest.capabilities.artifacts !== true) refuse()
      return deps.seams.artifacts
    }
    const device =
      identity.session && deps.deviceSession
        ? deviceSessionPort(
            identity.session.key,
            deps.deviceSession,
            identity.signal,
            alive,
            deps.deviceSessionRetain
              ? { retain: deps.deviceSessionRetain, lifetime: entry.signal }
              : undefined,
          )
        : undefined
    if (authorization && identity.session && admission?.callId && deps.deviceRecognitionAuthorization) {
      deps.deviceRecognitionAuthorization(
        identity.session.key,
        admission.callId,
        recognitionIOAuthorization(authorization, entry, deps.recognitionNetworkAllow ?? [], alive),
      )
    }
    const recognitionBudget =
      device &&
      identity.session &&
      deps.deviceRecognitionBudget &&
      entry.capability.kind === 'effect' &&
      entry.owner === pluginRowSource('ext:agnes-examples/aka-robot') &&
      [
        'aka.recognition.round.read',
        'aka.recognition.round.start',
        'aka.recognition.test',
        'aka.recognition.enable',
      ].includes(entry.capability.name) &&
      admission?.callId &&
      /^[a-f0-9]{32}$/.test(admission.callId)
        ? deviceRecognitionBudgetPort(
            identity.session.key,
            admission.callId,
            entry.capability.name,
            deps.deviceRecognitionBudget,
            device,
            identity.signal,
            alive,
          )
        : undefined
    const recognition =
      device?.retainRecognition &&
      identity.session &&
      deps.deviceRecognitionExecute &&
      authorization &&
      entry.owner === pluginRowSource('ext:agnes-examples/aka-robot') &&
      entry.capability.kind === 'effect' &&
      ['aka.recognition.test', 'aka.recognition.enable'].includes(entry.capability.name) &&
      admission?.callId &&
      /^[a-f0-9]{32}$/.test(admission.callId) &&
      !admission.recoverOnly
        ? deviceRecognitionPort(
            identity.session.key,
            admission.callId,
            deps.deviceRecognitionExecute,
            device,
            authorization,
            identity.signal,
            alive,
          )
        : undefined
    const captureArtifacts =
      device &&
      identity.session &&
      deps.deviceCaptureSelection &&
      entry.capability.kind === 'effect' &&
      ['aka.capture', 'aka.recognition.test'].includes(entry.capability.name) &&
      (!admission?.recoverOnly || entry.capability.name === 'aka.capture') &&
      entry.owner === pluginRowSource('ext:agnes-examples/aka-robot') &&
      entry.manifest.capabilities.artifacts === true &&
      admission?.callId &&
      /^[a-f0-9]{32}$/.test(admission.callId)
        ? deviceCaptureArtifactsPort({
            sessionKey: identity.session.key,
            callId: admission.callId,
            ...(entry.capability.name === 'aka.recognition.test' ? { purpose: 'recognition' as const } : {}),
            ...(admission.recoverOnly ? { recoverOnly: true as const } : {}),
            bridge: deps.deviceCaptureSelection,
            device,
            actor: identity.actor,
            seams: deps.seams,
            signal: identity.signal,
            alive,
            ...(deps.capturePublisher ? { publish: deps.capturePublisher } : {}),
          })
        : undefined
    return Object.freeze({
      ...identity,
      ...(recognitionBudget ? { recognitionBudget } : {}),
      ...(recognition ? { recognition } : {}),
      ...(captureArtifacts ? { captureArtifacts } : {}),
      actor: Object.freeze(identity.actor),
      ...(identity.session
        ? { session: Object.freeze({ key: identity.session.key, workspaceRoot: workspace.root }) }
        : {}),
      ...(device ? { device } : {}),
      cwd: workspace.root,
      // Facts at call time, probe live; services never get sandbox (spec 2026-09-15 §5.1).
      platform: platformView(deps.seams.platform),
      log: Object.freeze({
        debug: deps.log.debug.bind(deps.log),
        info: deps.log.info.bind(deps.log),
        warn: deps.log.warn.bind(deps.log),
        error: deps.log.error.bind(deps.log),
      }),
      exec: refuse,
      fs: Object.freeze({
        read: (path, opts) => read(() => workspace.fs().read(path, opts)),
        list: (path) => read(() => workspace.fs().list(path)),
        stat: (path) => read(() => workspace.fs().stat(path)),
        write: refuse,
      } satisfies ServiceContext['fs']),
      net: Object.freeze({
        fetch: async (url, init) => {
          alive()
          const target = new URL(url),
            caps = entry.manifest.capabilities.network
          const hosts = caps && !Array.isArray(caps) ? caps.hosts : []
          const host = target.hostname.toLowerCase(),
            port = target.port || (target.protocol === 'https:' ? '443' : '80')
          const matches = (list: readonly string[]) =>
            list.some((value) => value.toLowerCase() === host || value.toLowerCase() === `${host}:${port}`)
          if (
            !['http:', 'https:'].includes(target.protocol) ||
            target.username ||
            target.password ||
            !matches(hosts) ||
            !matches(deps.networkAllow) ||
            !['GET', 'HEAD'].includes(init?.method ?? 'GET') ||
            init?.body !== undefined
          )
            refuse()
          return createNetFetch({ signal: identity.signal, redirect: 'error' })(url, {
            method: init?.method ?? 'GET',
            ...(init?.headers ? { headers: init.headers } : {}),
            timeoutMs: Math.min(init?.timeoutMs ?? identity.timeoutMs, identity.timeoutMs),
          })
        },
      } satisfies ServiceContext['net']),
      artifacts: Object.freeze({
        get: (ref) => artifacts().get(ref),
        // Core ArtifactJob lacks public JobStatus fields. S5 owns that jobs adapter.
        poll: refuse,
        put: refuse,
        submitJob: refuse,
        cancel: refuse,
      } satisfies ServiceContext['artifacts']),
      authorize: async (action, target) => {
        alive()
        const request = inspectJsonData({ action, target })
        if (!request.ok) return refuse()
        const checkedRequest = frozenJson(request.value) as { action: typeof action; target: typeof target }
        if (
          !validateAgainst(Action, checkedRequest.action).ok ||
          !validateAgainst(Target, checkedRequest.target).ok
        )
          return refuse()
        const result = inspectJsonData(
          await deps.seams.principals.authorize(identity.actor, checkedRequest.action, checkedRequest.target),
        )
        alive()
        if (!result.ok) return refuse()
        const checked = validateAgainst<Decision>(DecisionSchema, result.value)
        return checked.ok ? checked.value : refuse()
      },
    } satisfies ServiceContext)
  }
}
