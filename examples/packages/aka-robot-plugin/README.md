# AKA-00 integration

## Four recording workflows and empirical movement presets

Pickup confirmation records the trusted runtime turn number. Both the demo release
checkpoint and ordinary model control refuse release during that same turn, even if
the model queued multiple calls in a batch; `terminate` alone does not cancel queued
calls. A later user release request is still required. Direct panel release remains
available. Older runtimes without tool-turn identity cannot confirm this demo pickup.
An unavailable camera does not block an already confirmed release: the accepted arm
receipt is returned without presenting old images as post-release pictures. Restore
the camera before beginning the next search/model workflow.

Multipart GLBs are imported first, then only their newly imported parts are joined
with the existing Blender opcode before placing the subject. Prior scene objects are
not included in that join.

Call `aka_modeling_status({})` before the modeling demo. It only reads the current
workspace configuration and available tools: no Blender launch, paid generation or
robot motion. An available image-generation port does not certify the saved key.
`imageGenerationPortAvailable:null` means this read-only invocation cannot inspect
the execution port, not that image settings are missing. Host grants that port only
to approved mutating calls; use the saved image settings and `aka_prepare_subject`
for the actual operation rather than treating this status as a configuration failure.
If no mesh generator is configured, use the existing ortho/Blender primitive route
instead of inventing an executable. `aka_build_model` now uses unique subject/camera/
light names and positions new subjects beside existing geometry when reusing Blender;
it preserves the prior scene and exports the whole managed document. Returned
`visualReview:pending_model_comparison` requires comparing the actual preview against
the source originals before claiming an acceptable likeness. Truncated previews and
failed geometry checks are refused before delivery export.

If model reasoning makes an observation older than thirty seconds, demo checkpoints
return a fresh original without sending the proposed motion. Analyze the new photo and
use its new frame ID to continue; this recovery never replays the old action.

These presets are operator observations for this particular car and floor, not a
linear calibration. Chassis tools accept speed **30–50** and **500–3000 ms**.
Speed below 30 or a 250 ms pulse did not move this car. Do not use them for a demo.

| Intent | `aka_control` arguments | Operator-observed effect |
| --- | --- | --- |
| Forward about 10 cm | `{"action":"up","speed":30,"milliseconds":1000}` | About 10 cm |
| Forward about 5 cm | `{"action":"up","speed":30,"milliseconds":700}` | About 5 cm |
| Forward about 3 cm | `{"action":"up","speed":30,"milliseconds":500}` | About 3 cm |
| First left alignment adjustment | `{"action":"left","speed":30,"milliseconds":500}` | Recheck the new image; angle is unmeasured |
| Right alignment adjustment | `{"action":"right","speed":30,"milliseconds":700}` | At most 700 ms for demo alignment |

Never extrapolate these samples to another speed, arbitrary duration, reverse distance,
or turn angle. Each movement stops, waits about one second and selects a subsequently
received frame. A frame arriving at the bridge is not a hardware exposure timestamp.
The model compares old/new originals and the last command, explains that comparison in
`summary`, and chooses the next bounded step. Interface success alone is not physical success.

1. **Describe the surroundings:** call `aka_surround({})`. It captures the initial
   original and then performs exactly six left turns at speed 30 for 1000 ms,
   stopping and waiting before every new photo: seven originals total. Normal collection
   completes before model summarization; cancellation, connection loss and uncertain
   actions still stop it. Six turns are the operator-observed sampling plan, not verified 360°.
   The result contains `taskId`. Read **all** originals using
   `aka_read_observations({"taskId":"<returned>","offset":0,"limit":2})`,
   then offsets 2, 4 and 6. Analyze every page with its photo index, round, direction,
   speed, duration and receipt. Finally use
   `{"taskId":"<returned>","offset":0,"limit":2,"compareEnds":true}` to compare
   the first and last originals together. Paging stays within model image limits;
   retain each page's observations when writing the final combined summary.
2. **Find a tennis ball:** call `aka_find_tennis({})` (or `aka_demo_start({"goal":"find_tennis"})`) and inspect
   its initial original. Call `aka_demo_step` with returned `workflowId`, latest
   `frameId`, `decision:"not_found"` and an image-based `summary` to perform one
   left 30/1000 turn and capture a settled new photo. Analyze and repeat, at most six
   turns. If the sixth new photo is also negative, one final `not_found` checkpoint
   reports the unsuccessful result **without another turn**. A visible ball instead
   uses `decision:"found"`, a normalized `[x1,y1,x2,y2]` `box` and a `summary`; it
   stops searching immediately, reports the ball was found and asks whether to approach.
   Wait for a new user request; backend guards also refuse same-turn case switching
   or direct-control bypasses. Low-confidence Aliyun labels or missing detections
   do not replace analysis of the actual ball original.
3. **Approach, pick up and await release:** call `aka_pickup_tennis({})` after a new user approach request.
   Analyze its new current original, then `found` with its box and evidence. A prior
   found photo alone does not permit movement. If absent, `not_found` ends without
   searching and asks the user to find the ball first. Use
   `align_left`/`align_right`, fixed speed 30, `milliseconds:500` first, optionally 700.
   After repeated default adjustments or overshoot, try 300 ms for approach alignment only;
   do not infer a fixed angle or use it for search/surround sampling. Recheck
   with the latest box and image comparison summary. Alignment has at most eight
   adjustments. Once the horizontal centre is roughly 0.4–0.6, choose
   `forward_10cm`, `forward_5cm` or `forward_3cm` from the actual image; approaching
   steps are bounded to twelve. A user-confirmed successful-grasp occupancy reference
   is required; absence returns `await_reference` without moving forward or grabbing.
   No default reference threshold is invented. Reaching or exceeding the reference
   prevents another forward step. `grab` is sent once only when the box matches that
   reference. After the fixed arm sequence and settling, two new originals are returned.
   `gone` plus the analysis of both photos reports visual pickup success under the
   operator's criterion: the ball disappeared from its original ground position.
   This is not a hardware possession measurement. `still_visible` ends unsuccessfully
   without automatically grabbing again. Successful pickup ends at `await_release`:
   call `release` only following a **new user release prompt**. A later release is not
   blocked merely because the navigation observation became old.
   The operator reference can include `imageFile:"reference.png"`, `note`, and
   `minCenterY`/`maxCenterY`. Store the screenshot under the device UUID directory
   beside its reference JSON. It is returned with the before/after originals; its
   image-derived occupancy ranges are approximate, not live centimetre measurements.
   `motionHistory` records each direction, pulse, before/after frame ID, receipt and
   model summary. Read it before reversing an alignment adjustment to avoid overshoot.
4. **Model the requested visible object:** call `aka_model_object({})`; this is not
   a ball search and is not limited to tennis balls. Analyze the new current original,
   use `found` with the requested object's box and description, then `capture_subject`
   with that box and summary if the object is wholly visible with 2% margin. Horizontal
   centering is not required, and no automatic forward/alignment movement occurs.
   The export keeps this analyzed original and its selected object metadata. If absent,
   `not_found` ends without movement. For a cropped/too-close object, `back_up` is a
   separate model-selected 30/500 pulse followed by a settled new photo, at most six.
   Prepare the subject with `aka_prepare_subject`, compare the cutout with the requested
   object before proceeding, then build using the image-model/ortho/Blender pipeline
   and verify the actual rendered preview. A single original does not establish metric
   dimensions or a four-view reconstruction. `model_tennis` remains a compatibility
   alias for this current-object flow; it no longer starts a ball search.

The ambiguous `aka_demo_start` remains deferred for compatibility. Prefer the four
explicit case entries. Old workflow state is observation data, not permission to resume
it. `aka_demo_step` returns an explicit `not-started` error with the refusal reason when
a checkpoint is rejected before any motor dispatch; actual uncertain actions remain
fail-closed and must not be replayed.

Example model-selected next step (the box is illustrative; use the actual latest image):

```json
{
  "workflowId": "<returned workflowId>",
  "frameId": "<latest returned frameId>",
  "decision": "forward_3cm",
  "box": [0.4, 0.4, 0.6, 0.6],
  "summary": "The ball is centred; it grew after the previous 30/700 step, so choose the smaller 30/500 step and compare again."
}
```

Successful-grasp references are private workspace records at
`.agh-device/demo-grasp-reference/<deviceId>.json`. Their closed schema is
`version:1`, `deviceId`, original camera `width`/`height`, `minWidthRatio`,
`maxWidthRatio`, `minHeightRatio`, `maxHeightRatio`; each ratio is in (0,1] and
each minimum is smaller than its maximum. Save only values established from the
operator's successful-grasp reference image, for that device and resolution.
The workflow binds session, binding/configuration revisions and runtime/camera
generations, refuses stale movement checkpoints and never automatically replays
unknown actions. Stop/connection changes invalidate the workflow. These in-memory
checkpoints do not resume motor actions across a plugin/worker restart.

## Recognition network permission and recovery

Use the owner profile's `policy.recognitionNetworkAllow` for the approved destinations:
`openplatform.aliyuncs.com`, `oss-cn-shanghai.aliyuncs.com`, and
`objectdet.cn-shanghai.aliyuncs.com`. Keep the session preset `standard-windows`.
Update the Host and restart after changing this policy. Do not put these hosts in
`sandbox.network_allow`: current OS sandbox backends cannot enforce host allowlists and
will refuse to open sessions. The compatibility preset `aka-standard-windows` now inherits
standard Windows behavior without adding network permissions. Omission denies recognition
network access; workspace overlays cannot enable it. Credentials stay in the secret store.

Original-result readback waits for the original effect to settle. If the daemon confirms
that no capture exists for that command, no recognition upload could have started; the
page unlocks and allows an explicit new attempt. An existing capture can also be classified
as not started when the original effect has settled and the unchanged recognition round
has zero durable reservations: detection admission always reserves before dispatch. A
nonzero or replaced round without a verified receipt remains unknown. Neither recovery
path automatically submits an image or repeats detection.
After a page reload, an unresolved recognition checks its original receipt once automatically.
Only a confirmed result or a confirmed never-submitted operation unlocks the recognition controls;
unknown outcomes remain available for explicit readback and never restart continuous recognition.
An active recognition loop checks a failed original once without resubmitting it. A confirmed
receipt or proof that all reservations already have receipts unlocks the next fresh frame;
an unmatched reservation stays unknown. The same round and allowance are retained.

Multi-view observations keep every original in the session record. The model request selects only
the newest image nodes and the views fitting the configured per-request image/block caps; remaining
originals can be loaded in explicit batches instead of blocking the next conversation turn.

Video renewal waits until the current authorized lease expires, rather than imposing a
shorter five-second deadline on a still-valid stream. Revocation and frame-stall checks
remain active; renewal does not extend permission without a server acknowledgement.
Temporary failures of the read-only ticket request may retry twice within that same lease;
invalid grants, server revocation and missing frames still stop the player.

Directional speed is a percentage, converted to the vendor's signed 127-step joystick
range. Direct natural-language movement and gripper requests use `aka_control`, the same
backend as the panel buttons. `aka_grasp` remains the calibrated visual task tool. A sent
command or arm acknowledgement is not proof of physical movement or held objects.
Missing approach or grasp calibration is reported as `not-started` before any movement,
so a rejected precondition does not leave the model waiting for an unknown physical result.

The Host loads the pinned Aliyun SDKs through literal dynamic imports so the CLI bundles
them and defers their initialization until recognition is admitted. Construction performs
no network IO; SDK or provider failures never trigger automatic paid retries.

## Image-to-image and modeling

Configure **Settings → Model and accounts → Image generation model** with an Agnes API key,
1K/2K resolution and enabled image-to-image. Keys stay in the deployment credential store;
configuration is read at the next generation without restarting workers. Saving sends no image request.
The enabled AKA plugin registers `aka_prepare_subject` and `aka_build_model` automatically on every
startup, including before the robot connects. Follow the [official image model manual](https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash):
reference images go in `extra_body.image`, and inline output uses `extra_body.response_format: "b64_json"`.

Use `aka_modeling_configure` with an existing generator's real command/axis/unit and optional
Blender path; the workspace file remains `.agnes/agh-ortho/mesh-run.json`. Enable `agh-ortho`
and `agh-blender`. In a device session, run `aka_orbit_capture`, then `aka_prepare_subject`
with its `taskId` and a main-view `photoIndex`, inspect the cutout, and run `aka_build_model`.
The image model receives all four reference views; the mesh generator receives one transparent PNG.
The subject prompt explicitly requests camera-grain/compression denoising, clearer details and gentle
edge sharpening without halos or oversmoothing, while preserving the reference object's identity.
The same references/main view reuse the generated subject cache, including after a local preview
publication failure. `force: true` explicitly regenerates the subject; `prepareSubject: false`
on the build tool explicitly uses the original photo without an image-model request.

The documented image API does not guarantee alpha. Real alpha is verified; border-connected
near-white pixels may be removed locally, and an unverified result blocks mesh execution.
Generated images stay separate from recognition and physical evidence. Subject generation and
modeling do not move the robot. See the [demo setup](../../aka-modeling-tools/README.md).

## Device console

New device sessions show a centered IP/port form. **Connect and save** probes the device,
saves the verified endpoint using the existing revision contract, connects and opens the camera.
A previously saved endpoint opens the console directly. The camera preview has a fixed area;
an opened camera starts live viewing automatically. Refreshing the same connection preserves
video and ongoing captures. Connection details and layout controls are collapsed by default.
After detaching, the same session returns directly to the IP/port configuration form. Opening
this form does not renew enrollment. **Connect and save** explicitly prepares the association,
reads its current configuration revision, probes and saves the entered endpoint, then connects.
New devices do not require a runtime-status query before their configuration form is usable.
If the robot loses power, use **Restore connection and camera** after restarting
it. Recovery replaces stale local connections and reopens the camera; it does not replay movement
or resume continuous recognition. A workspace that switched to another device cannot renew the
old enrollment. No new conversation is required when reconnecting the original device.
The camera switch calls `POST /api/camera/open` before subscribing to
`GET /api/camera/stream?fps=30`; closing calls `POST /api/camera/close`.
If the video stream fails while control remains connected, **Restore connection and camera**
remains available to reopen the stream on the retained connection without resaving the endpoint.
Read-only media tickets do not reserve the manual-control operation slot.
Manual actions refresh telemetry without reloading the saved connection or disabling the console.
An overlapping telemetry read is reused; polling stops when its session or connection is invalidated.

Recognition settings are edited in an opaque modal. Its saved summary shows provider, rate,
budget and retained credential status without revealing credentials. The red/green switch and
compact image-test button read the current settings and allowance on explicit interaction and
prepare a missing round; continuous recognition stops at its configured allowance. Saving
settings alone never starts inference. Latest detection boxes stay on their matching source
image beside the result list, separately from live video. Blender is invoked from the conversation;
there is no modeling settings form in this console.

The web host accepts the installed robot console's explicitly enumerated commands without
an extra browser confirmation. Other plugins retain their confirmation policy, and backend
binding/revision/service checks still apply. Rebuild this example and update the installed local
source snapshot to load UI changes; rebuilding the host alone does not replace plugin snapshots.

Finite directional controls use the vendor `/api/control` timed HTTP operation: the car
starts its timer after dispatch and replies after stopping. A separate HTTP stop request
remains independent of that operation; the runtime also neutralizes the control channel.
The vendor page's binary joystick transport is retained for telemetry and compatibility,
but local socket enqueueing is not used as evidence that a timed movement completed.
Verify physical movement through the stopped before/after originals.
Fresh recognition waits in search, pickup and four-view capture use a 10-second elapsed-time
budget, including completed status reads. A result returned after that budget is not used to
continue movement. Status polls are spaced 200 ms apart; an in-flight read still follows the
task's cancellation signal and overall deadline.


## Local installation

Observation frames and pickup reference examples remain available to the model but are not
conversation image cards. A successful `find_tennis` checkpoint publishes the selected current
photo as an explicit `ref` deliverable. The Web transcript shows image deliverables as small
thumbnails that open a modal preview. Final replies describe the result, visible evidence and
action state in natural paragraphs; there is no fixed one-to-three-sentence limit.

For `aka_demo_step`, `found`, alignment, forward steps, `grab`, `back_up` and
`capture_subject` require the current frame's normalized target `box`. A missing box is rejected
without dispatching movement. Connection, camera and unresolved-action failures report separate
reasons; they must be resolved before another movement request.
An uncertain chassis movement remains blocked until its pending request has ended and a later
explicit stop is acknowledged. That stop permits a new action but never replays the old one.
A chassis stop does not clear an uncertain arm result. Start a new approach with a fresh photo
after recovery, rather than reusing the old checkpoint.

Run `pnpm --filter @agnes-examples/aka-robot-plugin build` after changing backend source.
The installable entry is `runtime.cjs`, which includes the runtime dependencies so the
installed copy does not need workspace package resolution. Install or update from
`file:./examples/packages/aka-robot-plugin`, review the new preview and enable it.
Restarting alone does not update an installed package snapshot. The browser client remains
in `client/agnes.client.json`. The bundled WebSocket implementation's license is in `LICENSE-ws`.

## Implementation notes and earlier acceptance stages

The notes below record incremental implementation stages; current entry points are described above.
This package implements the AKA integration described in the root implementation plan.
The implementation is in progress. The package now declares a backend plugin entry and registers
readonly observation contributions, session-bound connection/camera effects and an explicit recognition
budget-round effect; production packaging/installation and the connected workbench
are not yet accepted.

Implemented foundation:

- The trusted service transport can now correlate a daemon-dispatched journaled call across the
  worker and Host context factory. Pending dispatch scopes are bounded, immutable and revoked on
  reply/timeout/abort/session/link/write failure; the private call correlation is not exposed in
  author ServiceContext. This does not grant inference or credential access. Production recognition
  admission must still combine it with current ownership/configuration, Host grants and budget;
  no credential/inference request route has been registered yet. The daemon worker-bound executor entry now
  rechecks Host authority over the original live WorkerLink, including each fixed cloud stage and
  the first destination before reading credentials. Late, malformed, retired and recovery-only
  calls are refused. The supervisor now handles the bounded private frame request through the same
  executor; one-use frame windows conservatively account for transport time without comparing
  process clock origins. The worker/packaged Host forward the bridge. Author context consumption,
  the actual plugin inference service, row cloud declarations and result publication are still unwired.

- The actual browser device panel now opens a recognition settings modal through native dialog.
  It reads/saves the existing owner SDK contract with binding/configuration CAS. Cloud settings use
  the fixed Shanghai DetectObject product and AK pair; local settings accept the service origin and
  optional token. Frequency and budget are explicit. Reads reject wrong identity and secret-bearing
  extra fields; neither reads nor saves start camera/inference. Credentials are never refilled and
  are cleared on submission, source changes, close and session/connection retirement. Uncertain save
  locks further submission until readback; closing does not claim to cancel a committed backend save.
  React StrictMode replay, late results and mocked persistence are tested in the real client module.
  The recognition runtime, enable switch and same-frame result card are still required. No real-browser
  visual, local YOLO or paid cloud acceptance is claimed.

- The owner-confined daemon store has durable recognition budget rounds and one-use reservations.
  Session sharing and process restart preserve usage; toggles/config changes never reset it.
  Lowered limits apply immediately; raised limits do not expand the frozen round. Explicit new
  rounds require separate owner admission and draining real in-flight work before invoking the store.
  RecognitionScheduler requires an injected asynchronous budget gate and rechecks lifetime and frame
  freshness after it resolves. Cancelled gates retain the in-flight slot until settlement. Reserved
  slots and actual detection dispatch counts are distinct; neither proves cloud billing.
  This is private storage/scheduler infrastructure, not a registered production recognition service.
  A private daemon single-image executor now combines credential and staged IO admission with this durable budget.
  No inference RPC/service is registered; production demand/effect wiring and account-level rate limits remain unfinished.

- Committed recognition changes now notify the shared worker with redacted settings only.
  Host device ports expose readonly `recognition()` and service-only `retainRecognition()`;
  the latter is revoked on recognition change/clear as well as binding/endpoint/session/row
  retirement. Video connection leases survive recognition-only changes. Old, conflicting,
  malformed and late recognition snapshots are refused. This is configuration continuity,
  not inference admission; the scheduler still needs demand/credential/effect wiring.

- The daemon device store now owns persistent recognition settings separately from connection
  profiles, with device-scoped credential refs, independent CAS, clear tombstones and a redacted
  immutable client projection. Local service origins are normalized and restricted; saving makes
  no camera, inference or network request. SQLite persistence and the existing production owner
  storage adapter are covered. The owner-only recognition read RPC and
  SDK now return the redacted view after fresh workspace/ownership validation. Owner-only save
  stages cloud AK pairs or optional local tokens in the fixed daemon-home CredentialStore and
  publishes through revision CAS; identical replace retries reuse credentials, failed unpublished
  stages are cleaned, and uncertain publication preserves the secret for owner readback. Save
  performs no network/inference/camera operation. Demand invalidation, credential retirement,
  Host runtime consumption and recognition enable/result UI are not wired yet.

- Host now has an internal device-recognition credential helper backed by the existing private
  CredentialStore. It stages both AK halves atomically under a fresh device-scoped reference,
  refuses cross-device reads, and cleans unpublished cancelled/failed stages without replacing
  a published credential. Owner admission and settings CAS are wired; credential retirement and SDK
  inference service wiring are still required; the helper is not a public client or model secret API.
  Tests use synthetic credentials in isolated private stores, not a real cloud account.

- `ali-recognition.ts` now re-exports the sole private SDK implementation from Host through its declared root.
  The same pinned SDKs are Host runtime dependencies and example test dependencies; constructors load on pipeline creation.
  Construction does no I/O and takes explicit credentials, with no environment fallback. Upload
  authorization and the final DetectObject call are separate. Shanghai OSS destinations are checked,
  multipart upload uses HTTPS without redirects, and returned upload handles are opaque and one-use.
  SDK retries are disabled; SDK calls retain their in-flight slot until settlement because their
  interface does not expose AbortSignal. Late/cancelled replies are refused and SDK errors are
  redacted. Detection results retain their provider request ID and submission/completion times.
  Tests construct real SDK models with replaced SDK dispatch and upload transport; they do not
  contact Aliyun. This adapter is not yet registered as a service: persistent recognition settings,
  Host-admitted credential resolution, single-test/continuous demand and the result UI remain unfinished; owner settings UI is now present.

- The shipped client descriptor mounts the device-session panel. Pairing, explicit metadata save,
  connection/disconnection and camera effects use the existing SDK and Host service/command paths.
  Saving does not connect or open a camera. Session changes, offline state and late outcomes are
  guarded in the panel. An explicit live-view control now mounts a same-origin canvas player;
  production launcher wiring is present, while real-browser/device playback remains unaccepted.

- Internal `media-egress.ts` implements a lazily started, ephemeral loopback WS endpoint using the
  existing `ws` dependency. A private host credential and a separate one-use 30-second ticket are
  both required; ticket authentication is the first WS message, never a URL. Renewable 60-second
  leases bind session/device/plugin revision, configuration/binding revisions and runtime/connection/
  camera epochs. Live output is ordered JSON metadata followed by JPEG binary; slow receivers skip
  whole intermediate groups, and revoked/expired/retired sources close. It bounds peers, tickets,
  input and frames. Runtime readers only copy already available media and never open a camera.
  Web now has an optional launcher-owned same-origin WS bridge with separate endpoint registration
  authority and whole-group backpressure. Host registers row-owned private endpoints and worker
  commands can read them. The actual plugin registers `aka.media.ticket`, requiring the current
  retained configuration, authorized media read and already-open camera; it never opens a camera.
  The daemon has a private one-shot worker reader with process-generation continuity checks, tested
  through a real service worker. Production daemon resolution now checks the admitted browser/backend
  row mapping and session/device/configuration continuity. A private local-only RPC feeds bounded
  launcher leases; sequential revalidation revokes changed endpoints or generations. The browser
  SDK and ordinary Web transport cannot read private endpoint credentials. A real-socket test crosses
  the production launcher lease and Web bridge using synthetic media and a synthetic daemon reply;
  it is not a full production daemon-to-device acceptance. The browser player authenticates in
  the first message, renews its lease and decodes bounded JPEG groups to canvas. Wrong dimensions,
  frame stalls, invalid data and changed session ownership terminate playback and clear the image.
  A slow decoder keeps one newest waiting frame; disposal closes late bitmaps without painting.
  Local tests cross both real socket legs with synthetic media; they do not prove browser playback.

- `aka.probe` is a finite Host-admitted pairing effect. It accepts a canonical private IP/port and
  the current binding/configuration revisions, authorizes device pairing and retains the matching
  configuration lifetime, then reads only the vendor heartbeat. It rechecks ownership/configuration
  before and after I/O and returns the reported MAC and save revisions. It does not persist the
  profile, open a camera, allocate a Runtime, connect WS or move the robot. Probe and connection
  effects share the same per-device operation lock. Missing identity, stale metadata, cancellation
  or revocation refuse the result; late retained leases are released. Reported MAC is continuity
  data, not authenticated hardware identity. Browser pairing/save source is present; real-device
  pairing and production installation remain unaccepted.

- The daemon/SDK provide local-owner endpoint metadata reads and version-checked saves through
  `device.connection` / `device.saveConnection`. These persist private IPv4/port/reported MAC for
  active enrolled sessions, without device I/O or physical authorization. The plugin consumes the
  persisted profile through invocation-scoped readonly
  `device.connection()` over the authenticated worker channel. Worker-backed retained bindings may
  include the configuration snapshot and revoke on a newer persisted revision. Persisted connections
  require a matching configuration-bearing lease and recheck the endpoint at each connection gate.
  Missing/failed profiles never fall back to row configuration. Immutable row configuration is
  supported only when an older Host has no connection port; moving to a newer Host requires the
  owner to save a profile explicitly. Switching sources cannot reuse a binding-only connection.
  Endpoint replacement is explicit and retires the old runtime; queries never allocate/replace one.
  Same-origin video and real-device acceptance remain unfinished.
  Saving a profile does not connect the robot.

- `aka.camera.set` is a separate Host-admitted effect with `{ configRevision, open }`.
  It requires the current retained connection, a fresh active session binding and device-camera
  authorization. Opening uses the vendor MJPEG endpoint at 15 FPS, returns `opening` until a frame
  confirms state, and reuses an existing stream. It does not move the robot or run cloud recognition.
  Closing invalidates media before the hardware close request; a failed reply preserves unknown
  hardware state. Camera and connection effects share the per-device operation lock. Binding
  revocation/unload retires the local stream; it does not prove hardware camera closure or motor stop.
  A newly started stream is retired if the invocation fails its post-open check. After a successful
  call, its local lifetime belongs to the retained connection, not the completed invocation.

- `aka.connect` / `aka.disconnect` are Host-admitted effects with current owner-managed endpoint metadata,
  device-specific authorization and fresh binding checks before each connection I/O stage.
  They do not open the camera or move the robot. Permission/binding waits end on cancellation;
  partial runtimes are retired before releasing the device operation lock, and late outcomes cannot
  acquire ownership of a replacement connection. A successful invocation leaves the passive connection
  owned by the plugin lifetime, rather than the completed invocation's signal.
  A retained lease arriving after a cancelled wait is released instead of acquiring ownership.
- A sustained connection also requires the service-only `device.retain()` port. Its binding lifetime
  survives invocation completion but retires the runtime on trusted binding notifications, session
  closure, row removal or worker shutdown. Older hosts without this port refuse connection before I/O.
  The signal does not grant physical authority or prove that a motor has stopped.

- Canonical private IPv4 endpoints; bounded, direction-specific movement requests with explicit units.
- Signed little-endian wheel telemetry, preserving unknown measurement validity.
- Action receipts distinguish execution completion from verified physical outcomes.
- Bounded Content-Length MJPEG assembly, arbitrary transport splits, JPEG size checks, and latest-frame retention.
- Continuous recognition scheduler with explicit enable/demand/readiness, two-stage gating,
  one in-flight pipeline, late-result rejection, limits, budget accounting and finite error retries.
- Alibaba response normalization rejects mismatched image dimensions and invalid pixel boxes.
  Recognition admission precedes original capture/publication, but the daemon's cross-process
  age ticket is issued after publication. This avoids counting persistence twice as frame age;
  the 1000 ms admission age limit, one-use tickets and paid-operation reservation still apply.
  Distance queries include each detection's label, box and confidence with the original frame ID
  and selection time. Only calibrated ground-contact targets get metre estimates. Differences
  between unrelated detections, moving targets or changed camera poses are not vehicle odometry.
- Internal native HTTP driver pins a validated private IPv4 endpoint, uses fixed routes and dedicated
  sockets, refuses redirects/retries, bounds JSON responses and total deadlines, and preserves unknown
  physical outcomes after a lost receipt. Its MJPEG subscription uses the existing bounded parser,
  releases sockets on cancellation/failure, and renews its idle deadline only on valid complete frames.
- Internal native WS transport uses the existing pinned `ws` version, caps inbound messages,
  permits one bounded time-action request and retires unknown/negative replies without replay.
  A success ACK never certifies physical completion; distance/angle and independent stop remain HTTP.
  Directional `aka_control` and console actions use the vendor's timed HTTP route: `time` is in
  milliseconds, counted on the car after its motor command is written, and the car stops before
  returning its completion receipt. Ordinary control accepts speed 30–50 and 500–3000 ms, with
  console and uncalibrated scan defaults of speed 30 and 1000 ms. On the current demonstration
  car, the operator observed no movement below speed 30; this is not universal calibration.
  Routes and motion calibration use the same range; older profiles below the range need new measurements. After stopping or an arm action,
  photo and recognition selection waits one second and requires a subsequently received frame,
  discarding buffered motion images. This settling interval does not prove sharpness or possession.
  Compare another original if blurred; absence of a target alone can also mean rolling or leaving view.
  The runtime
  still sends an independent stop on cancellation or an uncertain outcome; it never replays motion.
- A supervised surround sweep uses one `aka_scan` call, with up to 13 photos and 12 turns.
  `views=9` records the starting direction and eight speed-30 / 1000-ms turns, selecting a new
  frame after each post-stop settling interval. The operator's roughly 45-degree observation is
  an estimate, not an angular calibration. After sampling, `aka_read_observations` reads the exact
  originals in pages of at most two photos without moving, capturing, exporting or calling cloud
  detection. Analyze every page and compare the first and last views before reporting coverage;
  a completed sampling receipt alone does not verify 360 degrees.
- Internal per-device runtime and shared-owner registry reuse one channel/stream, check reported MAC
  continuity before connection, reject conflicting registrations and require explicit replacement.
  Connecting reads camera status without opening it. Camera effects are separate, close is serialized,
  and cancellation/owner disposal/connection loss invalidate late observations and release media.
  Only the latest bounded frame is retained and copied for readers, with unique instance/connection
  IDs and monotonic bridge-receive time. Stream failure preserves unknown hardware camera state.
- Actual `runtime` plugin factory registers `aka.status`, `aka_observe` and a device-scoped context
  contributor through the existing Host APIs. It resolves enrollment from invocation-owned ports,
  keeps ordinary sessions uninherited, prevents inactive history from reading a replacement runtime,
  and reports missing Host support as unavailable. Its owner-managed optional `devices` config is
  validated and immutable for older hosts; newer hosts use persisted profiles exclusively. Status
  reports the current configuration revision and only a matching existing runtime, with null before
  connection; querying creates no runtime, network connection or camera effect.
  Bounded control and calibrated tasks are exposed separately from queries; a successful request
  does not certify physical movement or unrestricted autonomous operation.

The wire contract was checked against official source revision
`68883db4ebb6d3072043c7c6eca9fc421bfe9a19`:
[motor routes](https://github.com/chenlongos/AKA-00/blob/68883db4ebb6d3072043c7c6eca9fc421bfe9a19/cpp/capp/src/routes/motor.cpp),
[camera routes](https://github.com/chenlongos/AKA-00/blob/68883db4ebb6d3072043c7c6eca9fc421bfe9a19/cpp/capp/src/routes/camera.cpp),
[system heartbeat](https://github.com/chenlongos/AKA-00/blob/68883db4ebb6d3072043c7c6eca9fc421bfe9a19/cpp/capp/src/routes/system.cpp),
[WebSocket](https://github.com/chenlongos/AKA-00/blob/68883db4ebb6d3072043c7c6eca9fc421bfe9a19/cpp/capp/src/websocket.cpp).
These files are interface evidence; no vendor source is copied into this package.

Protocol/framing modules do no network I/O. Internal HTTP/WS drivers and runtime perform native requests;
raw driver methods are not public services or tools. The registered connection and camera effects enforce
session authorization, device identity continuity, ownership and cancellation before using the runtime.
Reported MAC continuity is not authenticated hardware identity. MJPEG subscription itself opens the camera
on the vendor firmware, so it must enter an explicitly authorized camera-effect path, never a query.
An independent client stop request does not prove that the firmware can interrupt an active action.
JPEG framing checks do not replace the forthcoming decoder's validation.

The Host now exposes a copied, frozen service session reference and an optional readonly
`ServiceContext.device.binding()` lookup for session-backed calls. The lookup uses the authenticated
worker session channel, revalidates owner/workspace state and returns frozen enrollment data;
ordinary sessions remain unenrolled and historical bindings remain inactive after replacement.
Device associations have persistent daemon storage and local-owner RPC/SDK methods.
`client.device.detachSession(sessionId, expectedRevision)` deactivates only the current enrolled
association and retains inactive session history. It does not stop physical motion; the workbench
must integrate cancellation and independent stopping before offering a safe detach flow with motion.
Trusted plugin tool/hook invocations now have the same optional readonly enrollment port. Identity
is captured before author code runs; completion, cancellation and row removal expire lookup handles,
and shutdown hooks receive no lookup port. The actual AKA factory contributes status, observation and
device context and gates connection effects. Binding lifetime notifications and passive connection cleanup
are implemented. The companion offers association-only detachment; physical task cancellation/stopping,
principal/permission-revocation integration, persistent operation authorization and the connected workbench
remain incomplete.
Readonly enrollment data does not grant permission to connect or control a robot.

The Web shell now includes an explicit device-session creation flow. These source changes do not
yet provide a connected device workbench or end-to-end physical acceptance. Its workspace dialog defaults
to follow-workspace and offers ordinary/device modes; ordinary conversations remain unenrolled.

Still required: binding lifecycle completion, persistent camera authorization and motion effects, packaging/installation acceptance, same-origin media bridge,
device UI, camera/motion integration and control arbitration, Alibaba detection, immutable captures, task controller,
calibration, Blender handoff and physical/cloud acceptance. Local YOLO remains configuration-only.

Run from the repository root:

```powershell
pnpm exec vitest run examples/packages/aka-robot-plugin/test --maxWorkers=1
pnpm exec tsc -b examples/packages/aka-robot-plugin
```

Tests use synthetic wire data, mocked robot HTTP/WS events and real loopback sockets for internal media
egress; the latter is `media-egress.e2e.test.ts` in the heavy tier. They exercise refusal paths but do not certify real hardware,
JPEG decoding, Alibaba requests, model behavior or Blender.

The Host regression in `packages/host/test/assemble/plugin-extension.test.ts` mounts the actual exported
factory and runs its status service, observation tool and context hook through real Host calls with synthetic
enrollment and a test provider. It does not prove production installation or a daemon-to-robot connection.
The connection-effect case additionally checks missing/mismatched trusted journal admission, active versus
historical enrollment, passive connection status and row-unload cleanup. Native HTTP/WS are mocked and
the admission is synthetic; this is not a daemon command-journal or physical robot acceptance test.

The daemon private recognition budget request is now fenced by an actual in-flight service dispatch
on the sending session worker, AKA row/service identity, owner/workspace and binding/configuration
CAS. It distinguishes round start from detection reservation and rejects revoked late replies.
It returns budget state only, never secret references. Intended recognition service identities are
not yet registered; this does not complete Host effect admission, credential consumption, shared
demand, account QPS or the UI recognition switch/result card.

Supporting Host service contexts now expose optional `recognitionBudget.request` only for admitted
AKA recognition effect services with live correlation. The worker bridge is wired; identities are
Host-captured, requests/results are closed, immutable results are checked against fresh binding.
Ordinary queries/tools and older contexts get no port. This does not register the recognition
services or authorize credentials/inference/demand; the plugin still needs that integration.

A backend-only credential resolver now reads current device-scoped private credentials after
awaited authorization and fresh owner/workspace/config checks. The returned opaque consumption
handle serializes no AK/token, rechecks before/after consumption, and refuses concurrent/late
revoked use. It is not an RPC or plugin/model credential API and is not yet connected to SDK
execution. Invocation scope does not grant a background-job lifetime; production continuous
recognition still needs job authorization, upload/detect gates and device/account concurrency.
Tests use isolated synthetic credential stores and no paid requests.

The private single-image executor copies and structurally validates the JPEG before awaiting admission.
It rechecks grants/current configuration at each upload/detection stage, uses one durable reservation,
and keeps the shared device slot until actual settlement. Returned image/hash/request ID are tied to
the submitted frame. This backend contract is covered with isolated stores and substituted transports;
it is not production service registration, continuous recognition, real cloud billing or robot acceptance.

The actual registered `aka.recognition.round.start` effect uses current retained recognition settings
and the Host budget port. Backend/browser descriptors declare the service. Closed revision/start-ID
inputs cannot select another device; late leases are released and late publication replies refused.
Idempotent readback preserves used reservations. The production daemon's shared executor must be idle
before a new round is committed; future inference routes must use the same instance. This operation
performs no camera/upload/inference IO and does not enable recognition. Test/enable services and their
production IO authorization, continuous demand and user controls still need wiring and acceptance.

The actual plugin now registers `aka_capture`, a non-replayable tool returning an image artifact and
current device/frame facts. It saves only the latest already-streaming, identity-matched camera frame;
it performs no robot snapshot request, camera opening, movement or cloud inference. Current session,
owner, binding, profile, runtime/media generation and read authorization are checked before saving and
before publishing. Selection is limited to a frame received within one second in the worker clock;
`selectedAt` and bridge-receive age do not establish hardware exposure time. A newer frame in the same
stream does not replace the selected artifact. Cancellation suppresses publication but cannot undo a
blob already stored; the capture slot stays occupied until persistence settles. Storage failures are
redacted, and the returned image reference contains only hash/size/MIME.

Tests cover real runtime coordination with substituted robot transport and persistence, plus actual
Host mounting, model tool dispatch and a ledger image reference using a byte-preserving artifact
substitute. JPEG samples are structural fixtures, not decoded camera photos. The browser capture
button, actual disk persistence/reopen acceptance, real image/model rendering, robot and cloud
acceptance are still pending; this tool registration alone does not complete the photo UI.

The shared client image loader now assembles PNG/JPEG artifacts up to 4 MiB using existing session-authorized byte ranges, with each RPC response capped at 1 MiB. No partial image URL is published on a failed range, changed session/handle or disposed service. Client tests validate assembled bytes and failure paths; daemon RPC tests exercise the existing authenticated range contract. This does not establish real-browser decoding, real robot photos or complete capture-button acceptance. The preceding acceptance notes retain their historical test scope.

The photo card passes its lifetime signal to the shared resource loader. Unmounting or retrying cancels further image ranges and publication. Already sent SDK RPCs cannot be recalled; their late responses are discarded, without retrying capture.

The actual Web timeline now previews authorized JPEG/PNG artifact nodes using the shared resource loader and document preview. Session changes, removal, replaced references and late reads release image resources; read retries do not recapture. DOM tests and Web bundling passed, but real-browser decoding and the production manual-capture producer/button remain pending.

The production worker transport has a private exact-frame selection journal and actual-storage
confirmation path. WorkerPool binds it to a live journaled service call; daemon fixes principal,
session and command, rechecks workspace and endpoint versions, and persists closed immutable
selection metadata. The admitted AKA capture effect can use the optional Host captureArtifacts
port to save copied, structurally validated JPEG bytes through the existing artifact seam. Daemon
confirms actual bytes, not a worker receipt or retention tombstone. Recovery verifies the original
record without recapture; stored does not mean an artifact has been published to the session.
The private port cannot append arbitrary events or prove exposure time. Its publish operation now
uses the Host session writer and verifies the durable event and owner-scoped readable original.
The manual capture effect and button still need integration. No new
model tool or browser RPC is exposed by this port.

Capture storage confirmation atomically assigns a daemon-generated UUID to the actual owner/session/command.
The private `publication` operation verifies real bytes and returns this stable correlation plus the
original record, never accepting a worker-selected UUID or event sequence. Restart and retry preserve
the same identity; legacy stored records can acquire one, but recorded events without an identity are
refused rather than assigned a replacement. This prepares the trusted Host producer and does not
append an event or grant image-read authority. Core's live session remains its sole ledger writer.

The trusted publisher scans bounded pages of the current session's capture events for the fixed
identity before appending through Core. Cancellation and session replacement suppress completion;
retry can recover the committed event without a second append. Daemon recorded acknowledgement
uses its real readonly production ledger lookup and existing projection/read path. These components
are wired. The manual service/button are now registered as described below; whole daemon-to-page acceptance remains pending.


The actual `aka.capture` effect now uses the narrow Host capture port. It accepts current binding and endpoint revisions, never a caller-selected device/session/frame/command identity. Frame qualification is shared with `aka_capture`; save and publication retain device occupancy until actual I/O settles. An existing selected operation cannot switch to a newer frame; stored/recorded recovery uses the original bytes even without a current stream. Only a verified recorded event is returned as completion.

The browser button executes the declared effect through the existing command authorizer. New capture requires a currently connected, streaming device; the existing state refresh reads runtime transitions. Unknown capture disables new capture and offers explicit original-result readback, which retains the same host-owned command ID and immutable revisions. Readback does not require an active camera stream and never selects or writes another frame. Each attempt is authorized again. The durable effect lane permits only the verified AKA capture service to enter a trusted recovery-only scope; failed recovery preserves the original uncertain journal row. Other uncertain effects remain refused. The host saves unresolved capture identity and its two revisions in tab-local session storage before dispatch. Module/page reload restores a frozen input handle and shows explicit original readback without automatically dispatching. Readback uses the private relay restriction: missing original journal identity cannot create a new capture. Corrupt/unavailable storage refuses new dispatch; closed tabs or cleared storage require inspecting existing session artifacts. No image bytes or credentials are persisted. The page acknowledges completion only after validating the receipt and current scope; an invalid or late successful response retains the pending hint across module reload. DOM, durable-journal restart, actual worker dispatch and Host/disk/session tests cover separate layers; complete daemon-to-browser recovery, real-browser decoding and robot acceptance remain pending. Earlier notes retain their historical scope.

Backend recovery integration now has a real-process acceptance fixture at
`packages/daemon/test/aka-capture-pipeline.e2e.test.ts`. It composes the production worker pool,
Host, AKA runtime, durable command journal, capture store, disk artifacts, Core event publisher and
projected artifact reader. The fixture substitutes physical robot transport and explicitly injects
reply loss after the original event is recorded. It restarts the worker and persistent daemon indexes,
refuses recovery while the original file is missing, then restores the exact bytes and verifies the
original receipt and one event without another frame selection. Package installation, the public
HTTP/browser relay, exposure freshness, robot and paid cloud behavior are outside this fixture.
Session-scoped worker services now enter the existing async session channel, preserving identity
across awaits and wake-up; device reads still require the pool's live registered session channel.

The daemon-owned single-image executor now uses one shared cloud SDK slot for all devices/accounts in that daemon, with a total dispatch ceiling of 2 Hz and each device's configured 0.5/1/2 Hz interval. A busy or too-early request is refused before credentials or upload; no old-frame queue is created. Dispatch timestamps advance immediately before paid detection, so cancellation or a lost reply does not refund frequency or durable usage. The slot remains occupied until the actual SDK operation settles, and cleanup releases it even if pipeline close throws. This conservative limit is stricter than separate per-account limits. It neither coordinates other daemon processes/external callers nor persists timing across a daemon restart; real production IO admission, continuous demand and provider-specific account quota remain pending. It is not a claim that the registered budget-start effect already runs recognition.

The Host now declares the three fixed Alibaba destinations only for the verified AKA row's recognition test/enable effects. Budget-start, queries and unrelated rows receive no such declaration. Service networking uses the resolved Host default preset allowlist instead of the closed bootstrap file fence; the default stays closed. Actual row/Host assembly tests cover full, upload-only and empty policy, cancellation and effect settlement. No cloud request is made by these tests; the author context consumer and real single-image/continuous service remain pending.

Supporting Hosts now expose optional `ServiceContext.recognition.run(expected, select, verifySelection)` only to the admitted AKA test/enable effects with a live call correlation and recognition lease. expected fixes binding, recognition configuration and round revisions; select obtains a bounded JPEG after private admission, using the worker monotonic receive clock. Call identity, tickets, credentials and staged network admission stay backend-owned. The port is one-use per effect, copies/validates the image and checks reply identity, versions, hash, dimensions and boxes before releasing its lease. Queries, budget-start, readback-only recovery, unrelated plugins, tools and hooks receive no port. The example now registers `aka.recognition.test` with bindingRevision, connection configRevision, recognitionRevision and roundRevision. It qualifies the current stream frame, persists and publishes that exact original before detection, and returns detection metadata with its artifact reference and event sequence. Storage and publication use the existing trusted capture chain, narrowly enabled for this test effect; continuous recognition and recovery-only test calls receive no capture port. A stored prior original prevents replacing the frame or repeating detection. After storage the Host rechecks frame age; failure retains the original without reporting detection success. The service neither opens the camera nor starts continuous inference. Saving settings or refreshing a page makes no paid request. Real Host assembly tests substitute the private execution bridge; public HTTP/browser, cloud and robot acceptance remain pending. The explicit single-image UI and original result card are now wired as described below; continuous demand remains unfinished.

The selector receives the combined invocation/recognition-lease AbortSignal. Optional verifySelection rechecks media after result validation and before releasing the lease; the AKA example always supplies it. Do not verify with that revoked signal after run returns. Bridge receive time does not establish exposure freshness or physical approach eligibility.

The device panel now explicitly reads the current round through `aka.recognition.round.read`, starts a new round only on request, and calls `aka.recognition.test` for one image. The read effect uses authenticated journaled service admission but grants neither cloud IO nor budget mutation. Its closed input carries expectedBindingRevision and the recognition expectedConfigRevision; it returns the existing round or null without resetting it. The page displays the saved original with its matching boxes separately from live video; image-read retries do not run inference. Selection time uses `bridge_receive`, not exposure time, and page arrival time is a separate local observation. The effective allowance is the smaller of the stored round budget and current configured requestBudget; configuration increases do not enlarge an existing round. Disabled test controls explain missing configuration, local-provider execution, missing rounds, exhaustion or camera data. Unknown test outcomes retain the original operation across a tab/module reload. Explicit readback first returns a completed journal receipt. For an uncertain original, the production daemon can instead verify its independent detection archive, original capture event and owner-authorized CAS bytes, then complete that same journal receipt. Missing journals or unverified archives stay unknown; neither path invokes author code, uploads a frame or repeats detection. The page validates the original result before clearing its hint. Closed tabs, cleared storage, standalone history discovery and continuous demand remain outside this UI recovery path. The daemon now separately archives validated single-image metadata before replying to the worker, bound to the actual owner/session/original command and its recorded original. This private archive creates no artifact-read grant. The existing explicit original-result button can recover the same uncertain journal command after daemon verification; standalone history discovery remains unimplemented. The daemon rejects missing, replaced or exhausted rounds before credential access/upload, then still reserves atomically at detection admission to handle intervening consumption. These checks do not claim real cloud, browser-image decode or robot acceptance.

The private frame gateway now requires a matching recorded original before credential access/upload. It rechecks current connection, owner and live effect after detection, then transactionally saves immutable bounded metadata in the existing device store. Binding/frame/hash/dimensions must match the original; connection and recognition revisions remain distinct. Missing/unpublished originals, replaced connections and invalid metadata are refused. A storage failure never retries detection or refunds its consumed budget; a result already archived before reply loss survives storage reopen. The production client-effect lane now wires a daemon-only readback consumer for the same uncertain original journal command. It rechecks its original revisions, current owner/session association, original capture event and CAS authority, then completes that same receipt. No camera or current cloud configuration is needed; ordinary retries and missing/unverified original records remain unknown. Public HTTP/browser and standalone history acceptance remain pending. Tests substitute cloud IO and do not establish real Alibaba, browser or physical acceptance.

Modeling stays stationary. Describe the selected original first; use agh-ortho surface parameters and six-view review before building with agh-blender. Generated references are optional for difficult shapes: aka_generate_reference_views anchors the front and generates right/back/left in parallel. Successful bytes are retained for local save/publication recovery; a dispatched request without a saved result is not repeated automatically. Supporting Hosts provide a non-secret configuration identity to invalidate caches when settings change. Read four successful views in two groups using aka_read_reference_views. The single-view deadline is 200 seconds, and the front-plus-parallel-batch deadline is 400 seconds. Image credentials remain in the Host credential store. Final presentation must use agh_blender_capture with a scene camera, then export and reply briefly in natural language. No generator configured means use photo-guided parametric modeling, rather than preparing an image unnecessarily or substituting an unrelated ball model.
New stationary-subject archives and reference manifests persist their session/device binding, configuration identity and image hashes. They can be recovered after a worker restart for modeling only, without restoring executable motion state. Legacy archives without ownership metadata, changed bindings/configurations, and damaged images fail closed. Reference request admission is persisted before provider dispatch; unknown outcomes are not regenerated after restart. Local publication failures may recover the same saved bytes. Changing image settings during generation refuses the result instead of mixing reference sets. A failed reference read can be retried in the same inference step; successful reads and concurrent groups still enforce one two-image group per step.

Internal workflow movement carries its validated workflow identity through the shared control guard. Direct model controls and scans remain blocked during stationary modeling and after a selected task, while matching surround/search/pickup steps retain the real tool invocation identity. A pre-dispatch denial records no motion and does not become an unknown motor outcome. Mesh-building results return the generated reference first and the actual Blender render last, matching both clients' final-preview convention.
