import type { DeviceConnectionResult } from '@agnes/protocol'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  DeviceRecognitionBudgetPort,
  DeviceRecognitionBudgetRequest,
  DeviceSessionPort,
  HookContext,
  PlatformView,
  ServiceContext,
  SessionRef,
  ToolContext,
} from '../src/index.js'

describe('service context surface', () => {
  it('pins the exact key set: no sandbox, no seam objects, platform view present (spec §5.1 / §6.1)', () => {
    expectTypeOf<keyof ServiceContext>().toEqualTypeOf<
      | 'actor'
      | 'device'
      | 'recognitionBudget'
      | 'recognition'
      | 'captureArtifacts'
      | 'session'
      | 'source'
      | 'requestId'
      | 'cwd'
      | 'exec'
      | 'fs'
      | 'net'
      | 'artifacts'
      | 'authorize'
      | 'signal'
      | 'timeoutMs'
      | 'log'
      | 'platform'
    >()
    expectTypeOf<ServiceContext['platform']>().toEqualTypeOf<PlatformView>()
    expectTypeOf<ServiceContext['device']>().toEqualTypeOf<Readonly<DeviceSessionPort> | undefined>()
    expectTypeOf<ServiceContext['recognitionBudget']>().toEqualTypeOf<
      Readonly<DeviceRecognitionBudgetPort> | undefined
    >()
    expectTypeOf<DeviceRecognitionBudgetRequest>().not.toHaveProperty('callId')
    expectTypeOf<DeviceRecognitionBudgetRequest>().not.toHaveProperty('deviceId')
    expectTypeOf<DeviceRecognitionBudgetRequest>().not.toHaveProperty('credentialRef')
    expectTypeOf<ToolContext>().not.toHaveProperty('recognition')
    expectTypeOf<HookContext>().not.toHaveProperty('recognition')
    expectTypeOf<ToolContext>().not.toHaveProperty('recognitionBudget')
    expectTypeOf<HookContext>().not.toHaveProperty('recognitionBudget')
    expectTypeOf<ToolContext>().not.toHaveProperty('captureArtifacts')
    expectTypeOf<HookContext>().not.toHaveProperty('captureArtifacts')
    expectTypeOf<DeviceSessionPort>().not.toHaveProperty('authorize')
    expectTypeOf<Awaited<ReturnType<NonNullable<DeviceSessionPort['connection']>>>>().toEqualTypeOf<
      Readonly<DeviceConnectionResult>
    >()
    expectTypeOf<DeviceSessionPort>().not.toHaveProperty('saveConnection')
    expectTypeOf<
      Awaited<ReturnType<NonNullable<DeviceSessionPort['retain']>>>['revoked']
    >().toEqualTypeOf<AbortSignal>()
    expectTypeOf<keyof Awaited<ReturnType<NonNullable<DeviceSessionPort['retain']>>>>().toEqualTypeOf<
      'binding' | 'connection' | 'revoked' | 'release'
    >()
    expectTypeOf<ServiceContext['session']>().toEqualTypeOf<
      Readonly<Pick<SessionRef, 'key' | 'workspaceRoot'>> | undefined
    >()
    expectTypeOf<ServiceContext>().not.toHaveProperty('sandbox')
  })
})
