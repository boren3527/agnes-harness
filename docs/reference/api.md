# API and schema reference

English | [简体中文](api.zh-CN.md)

<a id="api-与-schema-参考"></a>

[Documentation](../README.md) · [Plugin boundaries](../develop/plugins.md)

When integrating AGH into an application, choose an entry point for your runtime first, then consult methods and schemas. This page lists traceable interface contracts. For your first plugin, start with the [tutorial](../develop/plugins.md).

APIs evolve with the source. `@agnes/*` packages currently resolve through the repository workspace. Use interfaces and examples matching your source revision.

<a id="选择正确入口"></a>

## Choose an entry point

| Consumer | Entry point | Typical operations |
| --- | --- | --- |
| Node client | Node conditional export of `@agnes/sdk` | createClient, session, config, packages, resources, skills, mcp |
| Browser host | `@agnes/sdk/browser` | Sessions and browser-allowed protocol methods, without Node management capabilities |
| Browser plugin | Host-supplied ClientContext | slots, session, theme, locale, commands, agnes.services |
| Backend Cordis plugin row | `@agnes/plugin-runtime` / Cordis Context | Config, inject/provide, effect, ctx.extension, ctx.skills, and ctx.services/slots/projections/resources on verified rows |
| Constrained extension capabilities | PluginExtensionAPI from `@agnes/extension-api` | Tools, `on` observation hooks, all `registerHook` categories, and events; service and similar contributions use row Cordis APIs |

Current SDK exports: [index.node.ts](../../packages/sdk/src/index.node.ts) and [index.browser.ts](../../packages/sdk/src/index.browser.ts). Consume only package `exports`; source links explain behavior and do not authorize deep imports.

<a id="sdk-调用顺序"></a>

## SDK call sequence

A Node client with trusted connection configuration can follow this sequence. The deployment supplies `options`, including address and authentication:

```ts
import { createClient, type CreateClientOptions } from '@agnes/sdk'

async function listSessions(options: CreateClientOptions) {
  const client = createClient(options)
  try {
    await client.initialize()
    return await client.session.list({})
  } finally {
    await client.close()
  }
}
```

Create sessions with `client.session.new({ cwd, preset?, sessionKey? })`, or load them with `client.session.load(id, { cwd? })`. Execute with `session.prompt(text)` and cancel with `session.cancel()`. Register the workspace and handle permission requests according to current server requirements before business use. Closing the client cleans up the connection; it does not cancel backend tasks.

Read pending messages from the UI projection's `pendingInputs`. `session.removeQueued(itemId, { commandId? })` removes one pending message and returns its committed sequence through `_agnes/v1/submit` with kind `removeQueued`; `session.sendNow(itemId, { commandId? })` stops the current turn and prioritizes that queued message. Both require session ownership and reject an already claimed or missing item with `QUEUED_INPUT_GONE`. Removal preserves the other messages and does not start or stop a turn. Reuse the same command ID when retrying an unknown outcome.

Node transports include unix, stdio, and ws. Deployment contracts determine authentication, named-pipe process identity, TLS, and Origin checks. Start with automatic discovery through CLI/Web when possible. Embedders must retain handshake and server identity checks. The runnable [documentation smoke](../../tools/public-docs/smoke.mjs) demonstrates connections and package management using local fixture credentials and models. [Shared local acceptance](../../tools/acceptance/shared-local-delivery.test.ts) covers flows including distribution relocation. See [verification](../maintainers/verification.md) for reproduction and coverage.

<a id="协议方法分组"></a>

## Protocol method groups

Persistent local supervisor deployments expose device associations through `client.device.bindings()`,
`client.device.session(sessionId)`, `client.device.bindSession(sessionId, expectedRevision)` and
`client.device.detachSession(sessionId, expectedRevision)`. These map to `_agnes/v1/device.bindings.list`,
`device.session.get`, `device.session.bind` and `device.session.detach`.
The `device` API family is advertised only to local owner connections when association storage is
fitted; standalone in-memory embeddings do not advertise it. A connection must still pass the
session-owner gate and fresh workspace validation for get/bind/detach.

Create a normal empty session in a registered workspace, read its association, then bind with the
returned workspace revision or `0` if none exists. The daemon assigns the device UUID; callers do
not supply a workspace ID, device ID or robot IP to these methods. Binding explicitly enrolls that
session and does not convert ordinary historical sessions. An inactive historical enrollment stays
associated with its original device. Revision conflicts return `SEMANTIC_REJECTED` with
`data.code: DEVICE_BINDING_CONFLICT`; re-read before deciding whether to retry. None of these
methods connects, commands, stops or starts recognition on a physical device.

The owner can explicitly bind an inactive historical session again using the current workspace
revision, provided it still refers to that session's original device. This renews only that session's
enrollment and preserves the saved connection and recognition settings; other historical sessions
remain inactive until explicitly renewed. A replacement device or an endpoint occupied by another
active workspace is rejected. After a lost reply, read the association before retrying.

Detach requires the current enrolled session and positive current workspace revision. It disables the
workspace association, increments its revision and preserves all session enrollments as inactive
history. Ordinary sessions and replaced historical enrollments cannot detach the current device.
An already-detached enrollment can read the unchanged result using the current inactive revision;
replaying the old revision returns a conflict. Binding revocation retires retained plugin connections,
but a robot may continue moving after its socket closes: this API is not physical stopping. A future
motion workbench must cancel its task and request/verify stopping before presenting a safe detach flow.

`client.device.recognition(sessionId)` calls `_agnes/v1/device.recognition.get` for the
current local owner and active device session, after fresh workspace validation. It returns a
redacted configuration view: independent revision, provider, frequency, request budget, credential
configured flag and the local service origin where applicable. It never returns credential values
or private references. Configured does not mean tested or running; this read does not open the
camera or dispatch inference. `client.device.saveRecognition(input)` calls `_agnes/v1/device.recognition.save` with the same owner
and workspace checks. The closed input includes the session and expected binding/config revisions.
Cloud settings use `aliyun`, frequency (0.5, 1 or 2), request budget and credential action `keep` or
`replace` with AccessKey ID/Secret. Local settings use `local-yolo`, a private/loopback origin, and
`keep`, `replace` with a token, or `clear`. Null settings clear the configuration; callers cannot
supply a private credential reference or storage path. Secrets are stored under the fixed daemon
home in its private CredentialStore, never the workspace. Fresh credentials are staged before CAS;
failed publication cleans only a provably unpublished stage. Uncertain publication preserves it
and returns a safe error so the owner can read back the current version. Identical replace retries
reuse the reference; a missing old credential can be replaced only at the current config version.
Saving performs no inference, camera or network operation. Runtime consumption, demand invalidation,
credential retirement and the settings UI are still pending.

Endpoint metadata is separate from association state. `client.device.connection(sessionId)` and
`client.device.saveConnection(input)` map to `_agnes/v1/device.connection.get` and
`_agnes/v1/device.connection.save`. Both require a local owner, a fresh workspace and an active,
explicitly enrolled session. The result contains `deviceId`, `bindingRevision` and a nullable `profile`.
A profile records `driver: 'aka-00'`, a canonical private IPv4 `ip`, `port`, self-reported
`macAddress` and its independent `configRevision`. This is metadata, not authenticated hardware identity.

Save supplies `sessionId`, `expectedBindingRevision`, `expectedConfigRevision` and the three endpoint
fields; use config revision `0` for the first save. MAC addresses normalize to lowercase. Unchanged
values do not increment the version, and retrying an identical immediately preceding save returns its
recorded result. A stale different change is rejected. An endpoint or reported MAC cannot be recorded
for two active device associations; reattaching a stored profile also checks current occupancy.
Configuration conflicts return `SEMANTIC_REJECTED` with
`data.code: DEVICE_CONFIGURATION_CONFLICT`. Schema constraints and exact types live in the protocol.

Reads and saves perform no device probing, connection, camera operation, motion or recognition, and
do not grant physical authority. Host can expose invocation-scoped `device.connection()` to backend
plugins over the authenticated session channel; see the [full-stack contract](../develop/fullstack.md).
The AKA plugin still consumes its owner-managed row configuration;
this persisted profile is not yet wired to the runtime or device configuration panel. Configuration
save does not certify a working connection. New worker-backed configuration leases are revoked
after a changed profile commits, retiring their retained local connections. If notification delivery
throws, the worker channel is retired and save reports the error; re-read the committed profile before
retrying. Old retainers without a configuration snapshot do not provide this coverage. Profiles persist
across daemon restarts; ordinary and inactive historical sessions cannot read or change them.

| Method family | Purpose |
| --- | --- |
| `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel` | Handshake and basic sessions |
| `session/update`, `session/request_permission` | Server notifications and approval requests |
| `_agnes/v1/session.*` | Attach, list, fork, projections, models/presets, follow-ups, and other extensions |
| `_agnes/v1/config.*` | Configuration summary, testing, saving, and accounts; sensitive inputs must not become ordinary logs |
| `_agnes/v1/packages.*` | Package inspection, installation, governance, updates, and operation queries |
| Resource/Skill/MCP management methods | Separate control-plane permissions and revision checks; see the resource method table |
| `_agnes/v1/clientModules.*` | Rosters and constrained client relay, rather than arbitrary browser RPC |
| `_agnes/v1/extension.call` | Authorized extension-service calls |

Exact method names, directions, params/results, and management permissions are defined by the [method table](../../packages/protocol/src/methods.ts), [package-management table](../../packages/protocol/src/package-admin.ts), and [resource-management table](../../packages/protocol/src/resource-control.ts). Do not derive fields from the shorthand above.

`client.config.imageGeneration.get()` and `.save({ expectedRevision, enabled, size, model?, apiKey? })`
use `_agnes/v1/config.imageGeneration.get/save`. They require deployment-local authentication,
use a revision independent of chat-model settings, and do not restart workers or generate images.
Reads return only `revision`, `enabled`, `size` (`1K` or `2K`), the fixed model/endpoint and
`credentialConfigured`. An omitted key preserves the private saved credential; keys never return
through RPC or enter workspace configuration. A save conflict requires a fresh read. The next
generation reads the committed configuration without a restart.

The default provider is `qwen-image-2.1-pro` at the fixed DashScope image endpoint. Existing Agnes
configurations remain readable; changing providers requires a new credential. No automatic provider fallback occurs.

Supporting Hosts provide optional `ToolContext.imageGeneration.subject({ images, subjectBox?, description?, view? })` to mutating
plugin tools declared with `requiresApproval: 'always'` and no dynamic classifier. This bounded,
invocation-scoped capability permits one request with up to four validated PNG/JPEG references;
explicit four-view generation may instead request front, right, back and left once each with one
unchanged description. The front request comes first; the remaining three may run concurrently.
an optional normalized `[left, top, right, bottom]` box selects the requested object in the first
reference, rather than whichever object is largest. Hosts validate finite, ordered 0–1 coordinates;
omitting the box retains main-subject behavior. No arbitrary prompt text is accepted.
Read-only tools, hooks and services do not receive it. It uses the configured image model,
returns a verified transparent PNG and its background-processing method, and never exposes keys
or permits endpoint overrides. Cancellation revokes late results, and failures are not retried.
White-border removal is a cutout heuristic; generated images are not physical robot evidence.
The optional `imageGeneration.configuration()` returns only revision, model, size and enabled state
within the same admitted tool invocation. It makes no image request and exposes no credential or
endpoint override. Supporting plugins include this identity in their caches so configuration changes
do not silently reuse another provider's images. Access expires with the invocation.

For full recorded tool details, `_agnes/v1/session.readToolDetail` reads the tool call and its matching result on demand. Pass `sessionId` and the tool node's `seq` as `callSeq`; pass its `resultSeq` when available. Optional `offset` and `maxBytes` select a UTF-8 byte chunk, capped at 262,144 bytes per response. The result includes base64 `data`, `totalBytes`, and `nextOffset` (`null` after the last chunk). Decode and concatenate chunks before parsing the JSON object `{call, result?}`. The daemon authorizes access to the session before reading events. Both the RPC and the SDK's `Session.readToolDetail(callSeq, resultSeq?)` limit the complete serialized detail to 64 MiB; pagination does not permit larger records. The RPC rejects an oversized detail with `INVALID_PARAMS` and reason `detail-too-large`. The ordinary UI projection retains bounded previews and exposes `resultSeq` as an optional tool-node field.

Writes commonly use clientId/commandId and expected revision/integrity to return a persistent operation receipt, followed by a final-state query. Receiving a receipt does not mean an effect succeeded. Do not change commandId to repeat an external effect with an unknown outcome.

<a id="skills-写接口"></a>

## Skill write interfaces

The Node SDK and server expose these management methods, subject to control-plane permissions:

| Node SDK / RPC | Inputs and result |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile, clientId, commandId, resourceId, expectedRevision; returns ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | The same fields plus expectedPriority and priority (integer 50–500 or null); returns ResourceOperationReceipt |

Both require admin authority and `resources.skills.write`. `remove` accepts only deletable workspace/user sources; `prioritySet` rejects runtime sources. Web BFF routes are `/admin/resources/api/skills/remove` and `/admin/resources/api/skills/priority`. They do not add direct resource-management permission to the browser SDK. Shell/TUI has no new commands with these names.

Use `client.resources.operation.get({ profile, operationId })` to wait for succeeded/failed, retain errors, and inspect actual state. Accepted deletion cannot be canceled. Saving priority does not change trust or enablement. See [Skills](../guide/skills.md) for deletion scope, persistent markers, and candidate replacement. Sources: [schema](../../packages/protocol/schema/resource-control.json), [method/permission table](../../packages/resource-control-contracts/src/resource-control.ts), [Node facade](../../packages/resource-control-client-node/src/resource-control.ts).

<a id="schema-导航"></a>

## Schema navigation

| Contract | Handwritten source |
| --- | --- |
| Core protocol / sessions | [agnes-v1](../../packages/protocol/schema/agnes-v1.json), [session-v1](../../packages/protocol/schema/session-v1.json) |
| Profiles / presets / models | [profile](../../packages/protocol/schema/profile.json), [preset](../../packages/protocol/schema/preset.json), [model](../../packages/protocol/schema/model.json) |
| Tools / extensions / hooks | [tooldef](../../packages/protocol/schema/tooldef.json), [extension-manifest](../../packages/protocol/schema/extension-manifest.json), [hooks](../../packages/protocol/schema/hooks.json) |
| Extension services / projections | [extension-service](../../packages/protocol/schema/extension-service.json), [projection](../../packages/protocol/schema/projection.json) |
| Package / resource control | [package-admin](../../packages/protocol/schema/package-admin.json), [resource-control](../../packages/protocol/schema/resource-control.json), [lockfile](../../packages/protocol/schema/lockfile.json) |
| Identity / deployment / surfaces | [authz](../../packages/protocol/schema/authz.json), [deploy-manifest](../../packages/protocol/schema/deploy-manifest.json), [surface](../../packages/protocol/schema/surface.json) |
| ACP provenance and deviations | [UPSTREAM](../../packages/protocol/schema/acp/UPSTREAM.md), [DEVIATIONS](../../packages/protocol/schema/acp/DEVIATIONS.md) |

Generated types are under [gen/ts](../../packages/protocol/gen/ts). Passing schema validation establishes shape. Implementations still verify cross-object relationships, authorization, transactions, and execution.

Model records optionally carry pi-ai `inputLimits`: `maxRequestBytes` and `images` (`maxPerMessage`, `maxPerRequest`, `resize`). `resize.maxBytes` counts Base64 bytes; `jpegQuality` uses 1–100. Omitted limits do not remove product caps. Image support still requires `image` in `input`.

`_agnes/v1/apis.list` includes `input` and optional `inputLimits` in each `profile.models` entry, so clients use the resolved model capabilities. Older servers may omit both fields; clients must not infer image support from a model name.

`ToolContext.session.readImages` is an optional Core-owned capability used by the built-in `read` tool. It accepts `{ path, offset?, limit? }` and returns a `ToolResult`. `session-image://list` pages the current session lane’s image originals; `session-image://<message-seq>/<image-index>` reads one original, and comma-separated references read a batch. Offsets and image indexes are one-based. Listing defaults to 20 entries and caps at 100. Reads cannot select another session or lane, observe future rows, or bypass model and runtime media limits. Tool cancellation also cancels image reads. Older runtimes omit the capability and `read` reports reloading as unavailable.

Supporting Hosts now expose optional `ServiceContext.recognition.run(expected, select, verifySelection)` only to the admitted AKA test/enable effects with a live call correlation and recognition lease. expected fixes binding, recognition configuration and round revisions; select obtains a bounded JPEG after private admission, using the worker monotonic receive clock. Call identity, tickets, credentials and staged network admission stay backend-owned. The port is one-use per effect, copies/validates the image and checks reply identity, versions, hash, dimensions and boxes before releasing its lease. Queries, budget-start, readback-only recovery, unrelated plugins, tools and hooks receive no port. The example now registers `aka.recognition.test` with bindingRevision, connection configRevision, recognitionRevision and roundRevision. It qualifies the current stream frame, persists and publishes that exact original before detection, and returns detection metadata with its artifact reference and event sequence. Storage and publication use the existing trusted capture chain, narrowly enabled for this test effect; continuous recognition and recovery-only test calls receive no capture port. A stored prior original prevents replacing the frame or repeating detection. After storage the Host rechecks frame age; failure retains the original without reporting detection success. The service neither opens the camera nor starts continuous inference. Saving settings or refreshing a page makes no paid request. Real Host assembly tests substitute the private execution bridge; public HTTP/browser, cloud and robot acceptance remain pending. The explicit single-image UI and original result card are now wired as described below; continuous demand remains unfinished.

The selector receives the combined invocation/recognition-lease AbortSignal. Optional verifySelection rechecks media after result validation and before releasing the lease; the AKA example always supplies it. Do not verify with that revoked signal after run returns. Bridge receive time does not establish exposure freshness or physical approach eligibility.

The device panel now explicitly reads the current round through `aka.recognition.round.read`, starts a new round only on request, and calls `aka.recognition.test` for one image. The read effect uses authenticated journaled service admission but grants neither cloud IO nor budget mutation. Its closed input carries expectedBindingRevision and the recognition expectedConfigRevision; it returns the existing round or null without resetting it. The page displays the saved original with its matching boxes separately from live video; image-read retries do not run inference. Selection time uses `bridge_receive`, not exposure time, and page arrival time is a separate local observation. The effective allowance is the smaller of the stored round budget and current configured requestBudget; configuration increases do not enlarge an existing round. Disabled test controls explain missing configuration, local-provider execution, missing rounds, exhaustion or camera data. Unknown test outcomes retain the original operation across a tab/module reload. Explicit readback first returns a completed journal receipt. For an uncertain original, the production daemon can instead verify its independent detection archive, original capture event and owner-authorized CAS bytes, then complete that same journal receipt. Missing journals or unverified archives stay unknown; neither path invokes author code, uploads a frame or repeats detection. The page validates the original result before clearing its hint. Closed tabs, cleared storage, standalone history discovery and continuous demand remain outside this tab-hint recovery path. The daemon rejects missing, replaced or exhausted rounds before credential access/upload, then still reserves atomically at detection admission to handle intervening consumption. These checks do not claim real cloud, browser-image decode or robot acceptance.
