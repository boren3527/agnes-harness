# Full-stack plugins: show business results in a panel

English | [简体中文](fullstack.zh-CN.md)

<a id="前后端联动让面板读到业务结果"></a>

[Documentation](../README.md) · Prerequisites: [Backend](backend.md) and [frontend](frontend.md)

Connect the interface and backend so a panel displays the version returned by a service. Then verify updates, rollback, and revoked access. This provides a starting point for a read-only business status panel.

Reuse [client-service-panel/v1](../../examples/packages/client-service-panel/v1/package.json). **The same trusted Cordis row registers a query service and declares its browser module.** The browser makes a constrained call through a same-origin BFF.

<a id="结构与调用链"></a>

## Structure and call chain

```text
package.json
  agnes.plugins → runtime named export (backend Cordis row)
  agnes.clientDescriptors → agnes.client.json with the same rowId
extensions/main/index.mjs
  runtime.apply(ctx) → ctx.services.register(panel.version)
extensions/main/client/index.js
  ctx.agnes.services.call('panel.version', {}) → display the version
```

Browser Context → current client row's service allow-list → local same-origin BFF → daemon identity/state checks → worker/Host row-service authorization → handler.

`ctx.provide()` publishes a Cordis dependency only in its local Context; it does not automatically become a remote service. Backend rows register Host-constrained services through `ctx.services.register()`. `ctx.extension().registerService()` remains forbidden. Do not create a second browser SDK/daemon socket to bypass the BFF.

<a id="运行前显式配置能力上限"></a>

## Configure the capability ceiling before running

The default local-dev capabilityCeiling does not include `services`. Without configuration, this example should produce a policy blocker. Do not bypass it as a documentation inconvenience.

In an **isolated trial home**, place this override in `profiles/local-dev/profile.yaml`. It retains the current default capability set and adds `services`. Do not apply it to your everyday instance:

```yaml
name: local-dev
policy:
  capabilityCeiling:
    - tools
    - hooks
    - slots
    - events
    - resources
    - ui
    - services
    - network
    - network.publicRead
    - tools.invoke
    - artifacts
    - subagent
```

Write the profile before starting the instance. If it is already running, finish trial tasks, then explicitly stop and restart that instance. Do not edit an existing user's profile for the tutorial. After startup, inspect, install, trust, and enable:

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-service-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-service-panel/v1
```

Use the actual preview hashes for trust/enable, following [plugin management](../guide/packages.md).

<a id="后端与前端各声明一次"></a>

## Declare both sides

In the [package manifest](../../examples/packages/client-service-panel/v1/package.json), `agnes.plugins` declares the backend row and `agnes.clientDescriptors` binds the [client descriptor](../../examples/packages/client-service-panel/v1/extensions/main/agnes.client.json) to the same row. `client.services` lists only the service names the browser may call. Host still verifies that the row actually registered the service and permits access from the current session.

The [backend entry](../../examples/packages/client-service-panel/v1/extensions/main/index.mjs) defines `panel.version` using `ctx.services.register`, with `kind: query`, input/output schemas, timeout, and maximum result bytes. Its handler returns the example version. The [browser entry](../../examples/packages/client-service-panel/v1/extensions/main/client/index.js) calls `ctx.agnes.services.call('panel.version', {})` without receiving a Host grant or daemon credentials.

Calls require a current session. Configure a model in Web and create/select a session before enabling the plugin or refreshing the page so apply runs with a session ready. The example queries only once during apply. Without a session it displays `unavailable` and does not automatically retry when a session is later selected. This is a limitation of the minimal example; real applications should refresh according to the session lifecycle.

Session-backed Host calls expose a frozen `ServiceContext.session` containing `key` and
`workspaceRoot`. Host derives these from the validated session and workspace invocation, not from
service input. The optional field remains absent in older or non-session embeddings; operations
requiring session ownership must refuse when it is absent. Identity data does not grant authority
to access a different session, and the service's other authorization checks still apply.

Hosts with device-enrollment storage may also provide `ServiceContext.device.binding()`.
Each call reads the current invocation's enrollment through the authenticated session channel and
revalidates ownership and workspace identity. It returns a frozen `DeviceSessionBinding`, or `null`
for an ordinary session. An inactive historical enrollment remains data, not permission to operate
a replacement device. The port is optional in older/non-session embeddings and becomes unusable
when the invocation ends. This read does not connect, start recognition or authorize physical actions;
device operation must separately verify current binding, control ownership and configuration.

The same port may provide `device.connection()`, which reads a frozen `DeviceConnectionResult`
for the actual enrolled session: device identity, binding revision and nullable endpoint profile.
Host checks enrollment before and after the metadata lookup, rejecting ordinary/inactive sessions,
identity changes and late invocation results. Older readers that cannot return the profile contract
are refused; this does not fall back to another device. It performs no device I/O or cloud calls.
The snapshot grants neither physical authority nor a configuration lifetime. A newer worker-backed
`device.retain()` may also return `connection` alongside the binding. When present, its signal covers
the returned configuration revision: saving a newer endpoint revokes it after the storage transaction
commits. Identical saves do not revoke it. A missing profile is returned as `profile: null` and its
lease is revoked on the first save. Older retainers can omit `connection`; their signal only covers
enrollment. A plugin using persisted endpoints must require the configuration-bearing result and
still recheck current state before each effect. The AKA example consumes this profile, requires a
matching configuration-bearing lease and explicitly replaces retired endpoints on connect. It never
falls back to row configuration after a missing or failed profile read. Row configuration is a legacy
path only for hosts without `connection()`; owners must save a profile when moving to newer hosts.
Queries return the configuration revision and only a matching existing runtime, without allocating
or replacing one. The connected workbench and real-device acceptance remain unfinished.

The optional launcher-owned `WebServerOptions.deviceMedia` resolver supports a fixed same-origin
WS route at `/api/client-modules/device-media`. Its first message carries a row/session and one-use
ticket; private loopback credentials stay in the resolver, not browser messages. The resolver must
verify current profile/row/session registration and supply its revocation signal. The bridge bounds
messages and viewers and forwards whole metadata/JPEG groups, skipping intermediate frames for a
slow receiver. Without a resolver it refuses upgrades. The AKA loopback example and Web bridge have
real local-socket tests with synthetic media. Host row-owned private registration, an internal worker
lookup and the example's `aka.media.ticket` service are implemented. Its browser canvas player has
synthetic decode/lifecycle tests. The production launcher now resolves media over a private local
`clientModules.resolveMedia` RPC: the daemon maps an admitted browser row to its backend row and
checks session ownership, device/configuration and plugin revision before returning private metadata.
The production daemon binds this resolver into its already-created package service when the worker pool is ready, including the normal CLI startup path.
Ordinary Web connections and the browser SDK refuse that RPC. Bounded launcher leases revalidate
the endpoint and all continuity stamps sequentially; changes or lookup failures revoke playback.
Local-socket tests exercise the launcher lease and bridge with synthetic media. Real-browser/device
playback acceptance remains unfinished. JSON service calls are not the binary transport.

Session-backed services may additionally provide `device.retain()`. It returns a frozen binding,
an abort signal for binding continuity, and `release()` for cleanup. Call the method during the
invocation; a successfully returned signal can outlive that invocation and is revoked on a binding
change, session closure, plugin-row removal or worker shutdown. Release it when retiring the resource.
Older embeddings may omit the method, and tool/hook ports do not supply it. This is not an operation
grant, a physical stop guarantee or notification of every authorization-policy change; long-lived
physical effects still need their own authorization, demand leases and stopping contract.

`device.recognition()` reads the current session's redacted recognition configuration through the
same owner-checked worker route. It returns no secret or storage reference; configured is not tested
or running. Services can use `device.retainRecognition()` to retain a frozen binding/configuration
with a recognition-scoped revocation signal. A committed recognition change or clear revokes that
scope; a connection-only `retain()` remains valid so video can keep playing. Binding, endpoint,
session and row retirement still revoke dependent leases. Missing or malformed recognition support
is refused rather than silently treating a binding-only lease as recognition continuity. Neither
method authorizes inference or performs a cloud request; the inference effect seam remains pending.

The trusted service embedding now carries an optional daemon-generated live `callId` alongside
journal admission. Host validates/copies it only after grants, principal execution policy, input
validation and command admission; it is given to the internal context factory, not author-facing
`ServiceContext`. The daemon worker link retains a bounded, frozen dispatch identity while that
call is pending and revokes it on reply, timeout, abort, session/link retirement or write failure.
It is transport continuity, not proof of Host grants or permission to read credentials or infer.
Older/direct embeddings without a live call correlation remain compatible; a future recognition
effect consumer must refuse missing correlation and independently check owner/device/configuration.
No public request field, credential-read route or inference port is introduced by this foundation.

The private worker `device-recognition-budget` request now reads, starts or reserves the current
session's device budget. Pool derives the effect from the actual sending link's pending dispatch,
refuses other session channels and rechecks revocation before returning a result. Supervisor
checks the AKA row identity, permitted recognition service, current owner/workspace and binding/
configuration revisions. Round start is separate from detection reservation; input cannot select
another device or expose credential references. These service identities are intended consumers,
not currently registered inference services. Host grant admission, draining real in-flight work,
credential consumption, demand and account limits still require production effect wiring.

On supporting hosts, the admitted AKA recognition effect service now receives optional
`ServiceContext.recognitionBudget.request(...)`. Host captures the session and live call correlation
from invoker admission, never from service input. Queries, tools, other rows/services and missing
correlation receive no port. Closed requests carry versions and the operation only; round start
cannot reserve detection and detector services cannot reset rounds. Results are copied/frozen,
reject extra fields and impossible counts, and are checked against fresh binding before return.
The backend-only credential resolver now reads the current device's fixed-home CredentialStore
reference after mandatory awaited authorization and owner/workspace/configuration checks. It
returns an internal closure handle with no serialized AK/token. Each trusted backend consumption
rechecks before dispatch and after actual settlement; one handle refuses concurrent use and late
revoked results. Transport correlation alone is insufficient. The resolver is not registered as
RPC, plugin service or model API; upload/detect admission, device/account concurrency and closed
client result contracts still belong to the inference engine. Its handle ends with the in-flight
service scope, so background recognition additionally needs an explicit job authorization lifetime.
No real secrets, SDK requests or cloud acceptance are exercised by synthetic private-store tests.

The worker bridge is wired into both Host construction paths. This budget operation is not a
credential, inference or background-demand grant; real recognition services and draining/dispatch
integration are still required. A supporting service must refuse an absent port on older hosts.



Trusted plugin rows can use the same optional `device.binding()` port in `ToolContext` and
`HookContext`. Register a context contributor with `ctx.extension().registerHook('context', handler)`;
the simplified `on` entry remains observe-only. The port captures Host session identity before
author code runs and shares the service result validator. Each tool/hook invocation gets its own
lifetime; retained callbacks and late responses are refused after completion, cancellation or row
removal. Shutdown hooks receive no device port. An ordinary session in a bound workspace still
returns `null`; a workspace association alone never enrolls that session. Context summaries remain
snapshots, so any subsequent operation must recheck current state.

Success displays `backend 1.0.0`. After updating to v2, check that both frontend and backend report `2.0.0`. A frontend v2 label alone does not prove a backend switch.

<a id="失败与清理"></a>

## Failure and cleanup

Removing the backend row, closing the browser row, revoking trust, or lacking an allow-list entry or current session must refuse service calls. The frontend displays unavailable. Ordinary plugin installation code cannot grant itself `services`.

After disabling backend and frontend contributions, old handles must stop working. Rollback requires retained trusted snapshots and current policy; it does not undo external business data changes. Do not turn this query into a write while retaining `kind: query`. Services with side effects need separate effect, command-identity, and authorization contracts.

<a id="验证命令"></a>

## Verification commands

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon/test/client-modules.test.ts --maxWorkers=1
```

This combination covers example modules, Host assembly/revocation, and daemon browser-call boundaries. [web-workbench.mjs](../../tools/acceptance/web-workbench.mjs) is an optional acceptance program for the full browser → BFF → daemon → worker → Host path. Recorded versions and coverage are listed separately in [verification](../maintainers/verification.md).

Source: [Host dynamic client extensions](../../packages/host/src/assemble.ts), [dynamic assembly tests](../../packages/host/test/assemble/dynamic-client-extension.test.ts), [ClientContext service gates](../../packages/web-client/src/client-module.ts).

The sole Aliyun SDK adapter now lives in Host; the AKA plugin re-exports it through the declared
Host root. SDK versions are unchanged and are loaded when a backend pipeline is constructed.
A private daemon single-image executor combines current credential checks with separately awaited
upload-authorization, image-upload and detection IO admission, then reserves durable budget before
DetectObject. It copies a structurally validated JPEG, checks actual dimensions and local frame age,
and retains the per-device slot until real settlement even after cancellation. Results carry the
exact image/hash and provider request ID; changed ownership/configuration or late replies are refused.
This executor is not registered as an RPC or plugin service. Production invoker/job authorization,
account-wide limiting, shared demand, enable/result UI and real device/cloud acceptance remain required.

The actual AKA plugin now registers `aka.recognition.round.start` as an effect and declares it in
both backend and browser service allow-lists. It requires current retained recognition settings
and the Host-admitted budget port, forwards closed binding/configuration/round revisions and start ID,
and releases the retained lifetime on success, failure or late cancellation. Idempotent replies may
already include used reservations; they are not reported as a reset. The production supervisor owns
one recognition executor and checks its device slot synchronously before changing a round; a missing
or asynchronous guard is refused. Future inference consumers must reuse that executor. Starting a
round never connects, opens a camera, uploads an image or enables continuous demand. Test/enable
inference services, the real cloud dispatch route and workbench controls remain unfinished.

Supporting Hosts expose optional `ServiceContext.captureArtifacts` only to the admitted AKA
`aka.capture` effect with the artifact capability and a live invocation correlation. Its `read`,
`save` and `recover` methods fix the session/command through the private worker bridge. Save copies
and validates the bounded JPEG before asynchronous work, journals an immutable selection before
writing, and uses the existing artifact seam. Daemon confirmation verifies actual persisted bytes;
retention metadata alone is insufficient. Recovery checks the original selection without recapture.
The write slot remains occupied until persistence settles even after cancellation. Ordinary
`artifacts.put`, query services, tools, hooks and other plugins receive no such write authority.
A stored record is not capture completion: publish verifies the event and readable original separately. The example now registers the manual effect/button; full daemon-to-browser acceptance remains pending. Older Hosts without
this port must refuse the operation; this optional contract does not enable motion or inference.

`captureArtifacts.publish()` obtains the daemon's persisted original identity, uses the current
Host session writer to append the private capture event, and recovers an existing matching event
on retry. Duplicate or malformed matching events are refused. Invocation cancellation retains
publication occupancy until the real append settles. Daemon accepts `recorded` only after its
trusted readonly ledger lookup matches the identity and original, projects the event, verifies
owner-scoped original readability, and rechecks binding/configuration. Worker JSON cannot select
the event payload, capture identity or another session. Production composition supplies bounded
readonly ledger access, not a raw SQL handle or another ledger writer. This port is wired into
Host/worker assembly. The example registers `aka.capture` and its page button, sharing frame qualification with the model tool. The verified Cordis row grants the artifact capability only to this named effect; generic service writes remain refused. The page suppresses double clicks and late-session receipts. Unknown capture offers explicit readback with the same host-owned operation identity and original input, without requiring a live camera. Only the verified AKA capture service may enter the trusted recovery-only scope; it cannot select or write a new frame, and failed recovery retains the original uncertain row. Other uncertain effects remain refused. The AKA page may retain its pending handle in tab-local storage and explicitly request readback-only recovery after reload; cleared storage or a closed tab requires inspecting session artifacts without automatic recapture. Complete daemon-to-page acceptance remains pending.

The private client-module effect relay accepts optional `readbackOnly: true` for AKA capture. The launcher validates and preserves the flag; the daemon checks the verified backend owner/service and opens the durable journal in read-only mode. A missing identity returns unknown without creating a journal row or dispatching the Host. Existing binding conflicts/corruption and current authorization remain effective; uncertain entries enter only the existing trusted capture recovery scope. The flag is excluded from the original effect binding because it restricts execution of that same operation; it is not a new effect or permission. False and non-boolean values are invalid. Browser hints are untrusted and never replace daemon admission.

Host invocation now supplies its context builder with a private live authorization checker only for the journaled AKA `aka.recognition.test`/`aka.recognition.enable` effects with an authenticated call correlation. Each check resolves current source grants and the same authenticated actor, validates a fresh execute decision, and refuses denial, approval, expiry, cancellation or a retired invocation. The checker is not a `ServiceContext` field or a wire proof; queries, unrelated effects and budget-start receive none. This is preparation for the recognition bridge: the production context builder now registers it through the Host-private recognition registrar, with fixed per-stage destinations checked against both manifest and host network allow-lists. The session worker indexes it by exact call/session identity, removes it on revocation and checks it through the private deviceRecognition.authorize command. Ordinary and packaged Host construction preserve the registrar. The daemon executor now has a worker-bound entry that resolves each stage through that private backcheck, checks the exact still-pending dispatch before and after the reply, rejects recovery-only calls and discards cancelled or malformed responses. It also checks the first destination before reading credentials. The supervisor now handles the private device-recognition-execute request through its existing shared executor. WorkerPool supplies the exact hosting link and live effect scope, with a bounded JSON/base64 payload and another lifetime check before replying. A one-use frame window is issued only after the Host backcheck; admission uses the daemon elapsed time plus worker-reported frame age conservatively, without comparing process clock origins. Failed/used windows cannot restart under the same effect. The worker and packaged Host forward the private request bridge. The single-image author context and example test effect are now wired as described below; continuous demand and result artifacts/cards are pending. Verified AKA test/enable effects now have the narrow cloud declaration and resolved Host default preset policy checks. Mocked execution is not real cloud acceptance.

The Host now declares the three fixed Alibaba destinations only for the verified AKA row's recognition test/enable effects. Budget-start, queries and unrelated rows receive no such declaration. Service networking uses the resolved Host default preset allowlist instead of the closed bootstrap file fence; the default stays closed. Actual row/Host assembly tests cover full, upload-only and empty policy, cancellation and effect settlement. No cloud request is made by these tests; the author context consumer and real single-image/continuous service remain pending.

Supporting Hosts now expose optional `ServiceContext.recognition.run(expected, select, verifySelection)` only to the admitted AKA test/enable effects with a live call correlation and recognition lease. expected fixes binding, recognition configuration and round revisions; select obtains a bounded JPEG after private admission, using the worker monotonic receive clock. Call identity, tickets, credentials and staged network admission stay backend-owned. The port is one-use per effect, copies/validates the image and checks reply identity, versions, hash, dimensions and boxes before releasing its lease. Queries, budget-start, readback-only recovery, unrelated plugins, tools and hooks receive no port. The example now registers `aka.recognition.test` with bindingRevision, connection configRevision, recognitionRevision and roundRevision. It qualifies the current stream frame, persists and publishes that exact original before detection, and returns detection metadata with its artifact reference and event sequence. Storage and publication use the existing trusted capture chain, narrowly enabled for this test effect; continuous recognition and recovery-only test calls receive no capture port. A stored prior original prevents replacing the frame or repeating detection. After storage the Host rechecks frame age; failure retains the original without reporting detection success. The service neither opens the camera nor starts continuous inference. Saving settings or refreshing a page makes no paid request. Real Host assembly tests substitute the private execution bridge; public HTTP/browser, cloud and robot acceptance remain pending. The explicit single-image UI and original result card are now wired as described below; continuous demand remains unfinished.

The selector receives the combined invocation/recognition-lease AbortSignal. Optional verifySelection rechecks media after result validation and before releasing the lease; the AKA example always supplies it. Do not verify with that revoked signal after run returns. Bridge receive time does not establish exposure freshness or physical approach eligibility.

The device panel now explicitly reads the current round through `aka.recognition.round.read`, starts a new round only on request, and calls `aka.recognition.test` for one image. The read effect uses authenticated journaled service admission but grants neither cloud IO nor budget mutation. Its closed input carries expectedBindingRevision and the recognition expectedConfigRevision; it returns the existing round or null without resetting it. The page displays the saved original with its matching boxes separately from live video; image-read retries do not run inference. Selection time uses `bridge_receive`, not exposure time, and page arrival time is a separate local observation. The effective allowance is the smaller of the stored round budget and current configured requestBudget; configuration increases do not enlarge an existing round. Disabled test controls explain missing configuration, local-provider execution, missing rounds, exhaustion or camera data. Unknown test outcomes retain the original operation across a tab/module reload. Explicit readback first returns a completed journal receipt. For an uncertain original, the production daemon can instead verify its independent detection archive, original capture event and owner-authorized CAS bytes, then complete that same journal receipt. Missing journals or unverified archives stay unknown; neither path invokes author code, uploads a frame or repeats detection. The page validates the original result before clearing its hint. Closed tabs, cleared storage, standalone history discovery and continuous demand remain outside this tab-hint recovery path. The daemon rejects missing, replaced or exhausted rounds before credential access/upload, then still reserves atomically at detection admission to handle intervening consumption. These checks do not claim real cloud, browser-image decode or robot acceptance.
