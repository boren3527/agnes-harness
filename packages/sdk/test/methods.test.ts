import { describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }

// Handlers return exactly the shape each method's real generated result schema allows
// (additionalProperties: false throughout _agnes/v1) - a kitchen-sink echo object would
// fail checkResult() now that these four methods carry real schemas (protocol 67348f1),
// unlike when Task 11 was drafted against an unvalidated method table.
function harness() {
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    'session/new': () => ({ sessionId: 'new-session' }),
    '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    '_agnes/v1/session.setPreset': () => ({ effectiveFromSeq: 2 }),
    '_agnes/v1/session.setModel': () => ({ effectiveFromSeq: 2 }),
    '_agnes/v1/session.setYolo': () => ({ effectiveFromSeq: 2 }),
    '_agnes/v1/session.list': () => ({ items: [] }),
    '_agnes/v1/workspace.list': () => ({ items: [] }),
    '_agnes/v1/config.imageGeneration.get': () => ({
      revision: 0,
      enabled: false,
      size: '1K',
      model: 'agnes-image-2.5-flash',
      endpoint: 'https://api.agnes-ai.cn/v1/images/generations',
      credentialConfigured: false,
    }),
    '_agnes/v1/config.imageGeneration.save': () => ({
      revision: 1,
      enabled: true,
      size: '2K',
      model: 'agnes-image-2.5-flash',
      endpoint: 'https://api.agnes-ai.cn/v1/images/generations',
      credentialConfigured: true,
    }),
    '_agnes/v1/device.bindings.list': () => ({ items: [] }),
    '_agnes/v1/device.recognition.save': () => ({
      deviceId: '11111111-1111-4111-8111-111111111111',
      bindingRevision: 1,
      configRevision: 1,
      settings: null,
    }),
    '_agnes/v1/device.recognition.get': () => ({
      deviceId: '11111111-1111-4111-8111-111111111111',
      bindingRevision: 1,
      configRevision: 0,
      settings: null,
    }),
    '_agnes/v1/device.connection.get': () => ({
      deviceId: '11111111-1111-4111-8111-111111111111',
      bindingRevision: 1,
      profile: null,
    }),
    '_agnes/v1/device.connection.save': () => ({
      deviceId: '11111111-1111-4111-8111-111111111111',
      bindingRevision: 1,
      profile: null,
    }),
    '_agnes/v1/device.session.get': () => ({ workspace: null, session: null }),
    '_agnes/v1/device.session.bind': () => ({ workspace: null, session: null }),
    '_agnes/v1/device.session.detach': () => ({ workspace: null, session: null }),
    '_agnes/v1/workspace.add': () => ({
      workspace: {
        path: '/canonical',
        name: 'canonical',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
      },
    }),
    '_agnes/v1/submit': () => ({ replayed: false, result: { sessionId: 'child' } }),
    '_agnes/v1/submit.ack': () => ({}),
    '_agnes/v1/approval.decide': () => ({ seq: 3 }),
    '_agnes/v1/approvalGrants.list': () => ({ grants: [] }),
    '_agnes/v1/approvalGrants.revoke': () => ({
      grantId: 'grant-1',
      profileHash: `sha256-${'a'.repeat(64)}`,
      actorId: 'local',
      actorOrg: 'local',
      toolId: 'computer_use',
      scope: 'cua:click:background',
      policyVersion: 'computer-use-v1',
      createdAt: '2026-09-19T00:00:00Z',
      revokedAt: '2026-09-19T01:00:00Z',
    }),
    '_agnes/v1/surfaces.mounts': () => ({
      mounts: [
        {
          package: 'agnes/demo-surface',
          surfaceId: 'demo',
          mount: '/demo',
          host: '127.0.0.1',
          port: 51234,
        },
      ],
    }),
  })
  const c = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  return { f, c, s: () => c.session.attach('s') }
}

describe('method surface: setPreset / setModel / session.list / session.fork', () => {
  const { f, c, s } = harness()

  it('uses the independent image configuration contracts over the SDK transport', async () => {
    expect(await c.config.imageGeneration.get()).toMatchObject({ revision: 0, credentialConfigured: false })
    const input = {
      expectedRevision: 0,
      enabled: true,
      size: '2K' as const,
      apiKey: ['fixture', 'only', 'key'].join('-'),
    }
    expect(await c.config.imageGeneration.save(input)).toMatchObject({
      revision: 1,
      size: '2K',
      credentialConfigured: true,
    })
    expect(
      f.calls.findLast((call) => call.method === '_agnes/v1/config.imageGeneration.save')?.params,
    ).toEqual(input)
    expect(f.calls.filter((call) => call.method === '_agnes/v1/config.save')).toHaveLength(0)
  })

  it.each([
    [
      'session.setPreset',
      async () => (await s()).setPreset('code'),
      '_agnes/v1/session.setPreset',
      { sessionId: 's', preset: 'code' },
    ],
    [
      'session.setModel',
      async () => (await s()).setModel({ slot: 'primary', route: 'gw', model: 'm' }),
      '_agnes/v1/session.setModel',
      { sessionId: 's', slot: 'primary', route: 'gw', model: 'm' },
    ],
    [
      'session.setModel with thinking',
      async () => (await s()).setModel({ slot: 'primary', route: 'gw', model: 'm', thinking: 'high' }),
      '_agnes/v1/session.setModel',
      { sessionId: 's', slot: 'primary', route: 'gw', model: 'm', thinking: 'high' },
    ],
    [
      'session.setYolo',
      async () => (await s()).setYolo(true),
      '_agnes/v1/session.setYolo',
      { sessionId: 's', enabled: true },
    ],
    ['session.list', () => c.session.list({ limit: 5 }), '_agnes/v1/session.list', { limit: 5 }],
    [
      'approval.decide',
      () => c.approval.decide('ticket-1', 'allowed-once', { kind: 'local' }),
      '_agnes/v1/approval.decide',
      { ticket: 'ticket-1', verdict: 'allowed-once', approverCredential: { kind: 'local' } },
    ],
    [
      'approval.decide permanent',
      () => c.approval.decide('ticket-2', 'allowed-permanent', { kind: 'local' }),
      '_agnes/v1/approval.decide',
      { ticket: 'ticket-2', verdict: 'allowed-permanent', approverCredential: { kind: 'local' } },
    ],
    [
      'approval.listGrants',
      () =>
        c.approval.listGrants('s', {
          toolId: 'computer_use',
          scope: 'cua:click:background',
          policyVersion: 'computer-use-v1',
        }),
      '_agnes/v1/approvalGrants.list',
      {
        sessionId: 's',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'computer-use-v1',
      },
    ],
    [
      'approval.revokeGrant',
      () =>
        c.approval.revokeGrant(
          's',
          {
            toolId: 'computer_use',
            scope: 'cua:click:background',
            policyVersion: 'computer-use-v1',
          },
          'grant-1',
        ),
      '_agnes/v1/approvalGrants.revoke',
      {
        sessionId: 's',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'computer-use-v1',
        grantId: 'grant-1',
      },
    ],
  ] as const)('%s sends the right method and params', async (_n, run, method, params) => {
    await run()
    expect(f.calls.at(-1)).toEqual({ method, params })
  })

  it('fork returns a fresh Session handle with the child id', async () => {
    const child = await c.session.fork('s', 7)
    expect(child.id).toBe('child')
    const submit = f.calls.findLast((call) => call.method === '_agnes/v1/submit')
    expect(submit?.params).toMatchObject({
      clientId: expect.any(String),
      commandId: expect.any(String),
      kind: 'fork',
      payload: { sessionId: 's', at: 7, childKey: expect.stringMatching(/^agnes:fork:/) },
    })
  })

  it('exposes explicit workspace add without making session.new an implicit add', async () => {
    expect(await c.workspace.list()).toEqual({ items: [] })
    expect((await c.workspace.add('/raw')).workspace.path).toBe('/canonical')
    await c.session.new({ cwd: '/raw', sessionKey: 'stable' })
    expect(f.calls.findLast((call) => call.method === 'session/new')?.params).toMatchObject({
      cwd: '/raw',
      _meta: { 'ai.agnes.harness': { sessionKey: 'stable' } },
    })
    expect(f.calls.filter((call) => call.method === '_agnes/v1/workspace.add')).toHaveLength(1)
    expect(await c.device.bindings()).toEqual({ items: [] })
    expect(await c.device.session('stable')).toEqual({ workspace: null, session: null })
    await c.device.bindSession('stable', 0)
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.session.bind')?.params).toEqual({
      sessionId: 'stable',
      expectedRevision: 0,
    })
    await c.device.detachSession('stable', 1)
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.session.detach')?.params).toEqual({
      sessionId: 'stable',
      expectedRevision: 1,
    })
    await c.device.bindSession('stable', 2, { replaceInactiveDevice: true })
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.session.bind')?.params).toEqual({
      sessionId: 'stable',
      expectedRevision: 2,
      replaceInactiveDevice: true,
    })
    expect(await c.device.recognition('stable')).toMatchObject({ configRevision: 0, settings: null })
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.recognition.get')?.params).toEqual({
      sessionId: 'stable',
    })
    const recognition = {
      sessionId: 'stable',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      settings: null,
    }
    expect(await c.device.saveRecognition(recognition)).toMatchObject({ configRevision: 1 })
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.recognition.save')?.params).toEqual(
      recognition,
    )
    await c.device.connection('stable')
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.connection.get')?.params).toEqual({
      sessionId: 'stable',
    })
    const connection = {
      sessionId: 'stable',
      expectedBindingRevision: 1,
      expectedConfigRevision: 0,
      ip: '192.168.1.42',
      port: 80,
      macAddress: '12:34:56:78:90:ab',
    }
    await c.device.saveConnection(connection)
    expect(f.calls.findLast((call) => call.method === '_agnes/v1/device.connection.save')?.params).toEqual(
      connection,
    )
  })

  it('approval.decide returns the server sequence without accepting a caller-supplied Actor', async () => {
    await expect(c.approval.decide('ticket-2', 'rejected', { kind: 'local' })).resolves.toEqual({ seq: 3 })
    // @ts-expect-error the fourth argument must never become an Actor injection path
    void c.approval.decide('ticket-2', 'rejected', { kind: 'local' }, { actor: 'somebody-else' })
  })

  it('exposes the current Surface mount table', async () => {
    await expect(c.surfaces.mounts()).resolves.toEqual({
      mounts: [
        {
          package: 'agnes/demo-surface',
          surfaceId: 'demo',
          mount: '/demo',
          host: '127.0.0.1',
          port: 51234,
        },
      ],
    })
    expect(f.calls.at(-1)).toEqual({ method: '_agnes/v1/surfaces.mounts', params: {} })
  })
})
