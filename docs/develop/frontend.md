# Frontend plugins: add a workbench interface

English | [简体中文](frontend.zh-CN.md)

<a id="前端插件为工作台增加一个界面"></a>

[Documentation](../README.md) · [Plugin lifecycle](../guide/packages.md)

Display your own panel, update its version, and confirm that disabling it restores the built-in interface. Learn the lifecycle first, then replace the version label with content useful for the role.

Reuse [client-panel/v1](../../examples/packages/client-panel/v1/package.json). It displays a version label in the supported `ui:sidebar` slot; v2 tests page updates. This is a browser contribution path, distinct from slot registration through ordinary Host `ctx.extension()`.

<a id="声明和代码"></a>

## Declaration and code

The package declares a backend Cordis row with `agnes.plugins`, then binds a browser descriptor to the same row ID through `agnes.clientDescriptors`. The descriptor's `client` section is:

```json
{
  "client": {
    "entry": "./client/index.js",
    "styles": ["./client/index.css"],
    "slots": ["ui:sidebar"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

See [package.json](../../examples/packages/client-panel/v1/package.json) and the complete [agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json). The client entry is resolved relative to the descriptor and must be native ESM executable by the browser:

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    () => config.publicConfig.label,
    { priority: -1 },
  )
}
```

For this singleton slot, a lower priority wins. The example replaces the built-in sidebar, which should return when the example is disabled. Choose a suitable slot for a production plugin. Do not assume unexposed regions can be replaced or depend on private Host DOM/CSS structure.

Device plugins can declare the session-scoped `workbench.device` singleton. The host displays this companion only for an explicitly enrolled device session, with `DeviceWorkbenchProps` containing `sessionId` and frozen binding metadata. An ordinary session in the same workspace does not inherit enrollment; an inactive binding for the same workspace device mounts connection setup with `prepareConnection()` and `connectionConfigured()` callbacks. The plugin calls preparation only on explicit form submission and signals configuration completion to refresh the host. Replaced historical devices still display a notice without controls. The companion defaults to a 60:40 chat/device split with an adjustable ratio, independently of the root `rightbar`. Binding metadata is not control authorization: backend calls must independently validate the actual session and current binding. This slot supplies the UI seam; it does not establish a physical connection or stream video.

Effect commands registered through `ctx.commands.registerEffect` are scoped to the session attachment
at execution start. If the session changes during asynchronous host authorization, including switching away
and back, dispatch is refused. Removing or replacing a command during authorization also refuses the
old command. No request is sent to the effect relay in these cases. This browser guard does not revoke
an effect already dispatched or replace backend session/authorization checks.

`publicConfig` is public presentation metadata from package contents, not backend runtime configuration. Client entry/styles must be validated paths inside the package. They cannot escape the snapshot, import arbitrary local modules, or obtain connection credentials. Bundle React or third-party libraries into independently loadable browser artifacts when needed.

The built-in workspace dialog offers follow-workspace, ordinary, and device conversation modes. Follow-workspace defaults to an explicitly enrolled conversation in a known active device workspace; an ordinary conversation stays unenrolled. New device keeps the device mode selected. Enrollment uses the backend's current binding revision, and a failed enrollment does not send a prompt. Changing mode or workspace after an attempted device creation uses a different creation key; retrying the same device creation retains its key. The companion also offers association detachment, which preserves conversation history and does not stop physical motion.

<a id="安装与观察"></a>

For an explicit effect readback flow, `registerEffect({ id, service, retainOperation: true })` retains a host-generated command ID for the same unchanged input object. Inputs must be flat JSON data (up to 128 own enumerable string keys and 65,536 serialized characters). Reusing that object authorizes each attempt again; changed input or another session is refused, and an active attempt cannot be dispatched twice. A new object starts a new operation. This is identity retention, not automatic retry, backend recovery permission or persistence across module/browser restart. The backend must separately enforce whether the named effect can safely recover.

## Install and inspect

Run from the repository root using an isolated instance:

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-panel/v1
```

Trust and enable using hashes from the preview, then open Web for the same instance. You should see v1. Update to `file:./examples/packages/client-panel/v2` through Web management or TUI and check v2. Finally, disable it and confirm the built-in sidebar returns. Because this example may replace management navigation, keep a terminal ready to disable it through the shell.

Package desired=enabled, backend web row ready, and successful loading in this page are distinct stages. A closed browser, failed script/CSS fetch, unauthorized slot, or exception in apply can prevent frontend activation. Inspect per-row actual state as well as package enablement.

After initial configuration establishes the profile, Web reads models, workspaces and sessions concurrently. Client module reconciliation reads up to four independent backend activation states concurrently; snapshot publication and retirement remain serialized, and failed activation reads do not grant readiness.

<a id="验证"></a>

## Verification

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

These tests check actual example ESM, Cordis bindings, slots, cleanup, and update failure handling. Without a browser, they are not real rendering acceptance. See [verification](../maintainers/verification.md) for browser coverage and source-candidate results.

Next: [Connect a backend service to the panel](fullstack.md). Declare public configuration fields and callable services separately. Keep secrets on the backend.

Implementation: [loading coordination](../../packages/web/src/client-modules/reconcile.ts), [ClientContext](../../packages/web-client/src/client-module.ts), [asset checks](../../packages/package-manager/src/client-assets.ts), [slots](../../packages/web-client/src/slots.ts).

Session-authorized `resources.images.load` accepts PNG/JPEG artifacts up to 4 MiB. Images above 1 MiB use sequential byte-range reads through the existing artifact RPC; every response remains at most 1 MiB. The loader validates identity and exact ranges before publishing a Blob URL and refuses late results after session/handle changes or disposal. Other document kinds retain their 1 MiB limit. Backend authorization and configured artifact limits can still refuse a read; this capability does not grant file access.

Both resource loaders accept an optional `signal`. An aborted read issues no further range requests and publishes no URL; an already sent RPC remains subject to its existing SDK deadline and is not recalled by this signal.

For the verified AKA capture and single-image test contributions, `persistCapture: true` additionally saves the unresolved host identity and exactly its operation revisions in tab-local session storage. `aka.capture` takes bindingRevision/configRevision; `aka.recognition.test` additionally takes recognitionRevision/roundRevision. Their storage keys are separate, and neither accepts secrets or arbitrary extra fields. It requires `retainOperation` and the named AKA package/service; arbitrary inputs and secrets are refused. `ctx.commands.pendingEffect(id)` returns the frozen original input for the current session, never the command ID, and performs no backend call. Render pending readback before enabling a new photo or recognition test. Recognition readback returns an already completed journal receipt, or lets the daemon verify the same uncertain original against its independent archive, capture event and owner-authorized CAS bytes. Missing journals or unverified originals stay unknown; recovery never invokes the service, uploads a frame or starts inference. Capture-only artifact reconstruction remains separate. Explicit execution of that restored input uses `readbackOnly: true`; the backend refuses a missing original journal entry without creating a new effect. Corrupt or unavailable storage refuses dispatch. Every attempt still passes command authorization and current backend ownership. After validating the receipt and current session/configuration, call `ctx.commands.completeEffect(id, originalInput)` to clear the pending hint. A resolved backend promise alone does not clear it; invalid or late results retain readback. Completion is refused while the operation is pending or before a successful response. This does not recover a closed tab, another origin, cleared storage or grant robot authority.

Tool image previews: tool-result resource links retain optional byte size. The UI projects bounded PNG/JPEG artifact links into the existing artifact cards; reads still require session/lane authority and exact byte identity. Legacy render receipts can supply a matching structured artifact.ref size. The latest image stays visible when a turn collapses; earlier images remain in its process history. This does not grant access to arbitrary URLs or local paths.
