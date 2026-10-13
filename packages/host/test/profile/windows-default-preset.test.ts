import { validateProfileManifest, validateResolvedProfile } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env = (os: ResolveEnv['platform']['os']): ResolveEnv => ({
  platform: { os, arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-14T00:00:00Z',
  homeDir: 'C:/agnes',
})
describe('Windows builtin default preset selection', () => {
  it('keeps recognition destinations separate from the Windows session preset', async () => {
    const recognitionNetworkAllow = [
      'openplatform.aliyuncs.com',
      'oss-cn-shanghai.aliyuncs.com',
      'objectdet.cn-shanghai.aliyuncs.com',
    ]
    const user = { name: 'local-dev', policy: { recognitionNetworkAllow } }
    const profile = await resolveProfile({ builtin: 'local-dev', user }, env('win32'))
    expect(profile.presets.default).toBe('standard-windows')
    expect(profile.policy.recognitionNetworkAllow).toEqual(recognitionNetworkAllow)
    expect(validateProfileManifest(user).ok).toBe(true)
    expect(validateResolvedProfile(profile).ok).toBe(true)
    expect(
      (await resolveProfile({ builtin: 'local-dev' }, env('win32'))).policy.recognitionNetworkAllow,
    ).toBeUndefined()
  })
  it.each(
    [
      ['*'],
      ['example.com'],
      ['openplatform.aliyuncs.com', 'openplatform.aliyuncs.com'],
      'openplatform.aliyuncs.com',
    ].map((hosts) => ({ hosts })),
  )('rejects invalid recognition destinations %j', async ({ hosts }) => {
    const user = { name: 'local-dev', policy: { recognitionNetworkAllow: hosts } }
    expect(validateProfileManifest(user).ok).toBe(false)
    await expect(resolveProfile({ builtin: 'local-dev', user: user as never }, env('win32'))).rejects.toThrow(
      'recognition network policy',
    )
  })
  it('refuses a workspace adding recognition network permission', async () => {
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          workspaceOverlay: { policy: { recognitionNetworkAllow: ['openplatform.aliyuncs.com'] } } as never,
          lock: { packages: {}, workspace: { path: 'C:/repo', hash: 'hash', manifestId: 'fixture' } },
        },
        env('win32'),
      ),
    ).rejects.toThrow()
  })
  it.each(['linux', 'darwin', 'win32'] as const)('selects the builtin default for %s', async (os) => {
    const profile = await resolveProfile({ builtin: 'local-dev' }, env(os))
    const expected = os === 'win32' ? 'standard-windows' : 'standard'
    expect(profile.presets).toEqual({ default: expected, allowed: [expected] })
  })
  it.each([
    { default: 'standard' },
    { allowed: ['standard'] },
    {},
    { default: 'custom', allowed: ['custom'] },
  ])('preserves explicit user selection %j', async (presets) => {
    const inputs: ProfileInputs = { builtin: 'local-dev', user: { name: 'custom', presets } }
    const before = structuredClone(inputs)
    const profile = await resolveProfile(inputs, env('win32'))
    expect(profile.presets).toEqual({ default: 'standard', allowed: ['standard'], ...presets })
    expect(inputs).toEqual(before)
  })
  it('keeps a verified workspace fragment from changing the builtin selection', async () => {
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        workspaceOverlay: {},
        lock: { packages: {}, workspace: { path: 'C:/repo', hash: 'hash', manifestId: 'fixture' } },
      },
      env('win32'),
    )
    expect(profile.presets).toEqual({ default: 'standard-windows', allowed: ['standard-windows'] })
  })
  it('does not change enterprise defaults or waive workspace verification', async () => {
    expect((await resolveProfile({ builtin: 'enterprise' }, env('win32'))).presets.default).toBe('standard')
    await expect(
      resolveProfile({ builtin: 'local-dev', workspaceOverlay: {} }, env('win32')),
    ).rejects.toThrow('E_WORKSPACE_UNTRUSTED')
  })
  it('keeps the resolved hash deterministic and leaves later POSIX resolution unchanged', async () => {
    const inputs = { builtin: 'local-dev' }
    const a = await resolveProfile(inputs, env('win32'))
    const b = await resolveProfile(inputs, env('win32'))
    expect(a.hash).toBe(b.hash)
    expect((await resolveProfile(inputs, env('linux'))).presets.default).toBe('standard')
  })
})
