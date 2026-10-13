// client/index.js
import {
  createElement as h8,
  useCallback as useCallback5,
  useEffect as useEffect7,
  useId as useId6,
  useRef as useRef7,
  useState as useState7,
  useSyncExternalStore
} from "react";

// client/capture-control.js
import { createElement as h, useEffect, useRef, useState } from "react";
function CaptureControl({ ctx, sessionId, binding, configRevision, enabled }) {
  const [phase, setPhase] = useState("idle");
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const operation = useRef(null);
  const observedRevision = useRef(configRevision);
  const t = (key) => ctx.locale.t(`aka.capture.control.${key}`);
  const available = () => binding.active && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected";
  useEffect(() => {
    if (configRevision !== observedRevision.current && busy.current) setPhase("unknown");
    observedRevision.current = configRevision;
    mounted.current = true;
    try {
      const pending = ctx.commands.pendingEffect("aka.capture.photo");
      if (pending) {
        operation.current = pending;
        setPhase("unknown");
      }
    } catch {
      setPhase("unknown");
    }
    const changed = () => {
      generation.current++;
      if (busy.current) setPhase("unknown");
    };
    const off = [
      ctx.session.subscribe(changed),
      ctx.agnes.on("closed", changed),
      ctx.agnes.on("reconnecting", changed)
    ];
    return () => {
      mounted.current = false;
      generation.current++;
      for (const stop of off) stop?.();
    };
  }, [ctx, configRevision]);
  const recoverable = () => available() && operation.current && operation.current.bindingRevision === binding.bindingRevision && operation.current.configRevision === configRevision;
  async function capture(recover = false) {
    if (!available() || busy.current || (recover ? !recoverable() : !enabled || phase === "unknown")) return;
    if (!recover)
      operation.current = Object.freeze({ bindingRevision: binding.bindingRevision, configRevision });
    const input = operation.current;
    const epoch = generation.current;
    const current = () => mounted.current && generation.current === epoch && available();
    busy.current = true;
    setSaving(true);
    setPhase("pending");
    try {
      const result = await ctx.commands.execute("aka.capture.photo", input);
      if (!current()) return;
      if (result?.deviceId !== binding.deviceId || result.bindingRevision !== binding.bindingRevision || result.configRevision !== configRevision || typeof result.frameId !== "string" || !result.frameId || !Number.isSafeInteger(result.eventSeq) || result.eventSeq < 1 || !/^[a-f0-9]{64}$/.test(result.artifact?.sha256) || result.artifact?.mime !== "image/jpeg" || !Number.isSafeInteger(result.artifact?.size) || result.artifact.size < 1 || result.artifact.size > 4 * 1024 * 1024)
        throw new Error("Unverified capture receipt");
      ctx.commands.completeEffect("aka.capture.photo", input);
      setPhase("recorded");
    } catch {
      if (current()) setPhase("unknown");
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return h(
    "div",
    { className: "aka-capture-control", "aria-busy": saving },
    h(
      "button",
      {
        type: "button",
        disabled: !enabled || !available() || phase === "pending" || phase === "unknown",
        onClick: () => void capture()
      },
      t("capture")
    ),
    phase === "unknown" && h(
      "button",
      {
        type: "button",
        disabled: !recoverable() || saving,
        onClick: () => void capture(true)
      },
      t("recover")
    ),
    phase !== "idle" && h("p", { role: phase === "unknown" ? "alert" : "status" }, t(phase))
  );
}

// client/catalog.js
var catalog = {
  en: {
    "aka.panel.recover": "Restore connection and camera",
    "aka.recognition.control.details": "Observation details",
    "aka.recognition.configured": "Configuration saved \xB7 credentials retained",
    "aka.manual.parameters": "Step parameters",
    "aka.panel.editConnection": "Change connection",
    "aka.panel.connectionDetails": "Connection settings",
    "aka.panel.controls": "Device controls",
    "aka.panel.previewHint": "The live camera feed appears here when available.",
    "aka.panel.backConsole": "Back to console",
    "aka.panel.connectionAdvanced": "Probe separately",
    "aka.panel.pair": "Connect and save",
    "aka.panel.connectionHint": "Enter the robot address on your local network.",
    "aka.panel.newConnection": "Configure a connection",
    "aka.modeling.title": "3D modeling setup",
    "aka.modeling.hint": "Quick demo: generate from one of four captured photos, retain the other views for review, then render and export in Blender. Requires enabled agh-ortho and agh-blender plugins and an installed image-to-mesh generator. Saving does not start a process.",
    "aka.modeling.executable": "Blender executable (optional)",
    "aka.modeling.autoDiscover": "Discover installed Blender automatically",
    "aka.modeling.height": "Demo display height (m; not a measurement)",
    "aka.modeling.generator": "Generator configuration (JSON)",
    "aka.modeling.placeholders": "Replace the generator path. command is an argv array: {image} = photo, {out} = output directory, {prep} = preprocessed input. Optional preprocessCommand/output. Declare the actual file upAxis and unit. Keep credentials in environment variables, not this JSON.",
    "aka.modeling.save": "Save",
    "aka.modeling.close": "Close",
    "aka.modeling.saved": "Saved to this device workspace. Ask the assistant to take four views, then build a demo model.",
    "aka.modeling.loadError": "Cannot read modeling configuration",
    "aka.modeling.saveError": "Cannot save modeling configuration",
    "aka.ground.graspEnabled": "Add measured grasp calibration",
    "aka.ground.graspTitle": "Grasp window and observation regions",
    "aka.ground.graspHint": "Measure the reachable target window and verify the camera can distinguish empty, held and slipped objects. Pixel regions use x1,y1,x2,y2, separated by commas. Held and release regions must not overlap.",
    "aka.ground.grasp_forwardMin": "Minimum grasp distance (m)",
    "aka.ground.grasp_forwardMax": "Maximum grasp distance (m)",
    "aka.ground.grasp_lateralTolerance": "Lateral grasp tolerance (m)",
    "aka.ground.grasp_settleMilliseconds": "Arm observation settling time (ms, at least 4000)",
    "aka.ground.grasp_heldBox": "Held-object pixel region",
    "aka.ground.grasp_releaseBox": "Release landing pixel region",
    "aka.ground.motionEnabled": "Add measured motion calibration",
    "aka.ground.motionTitle": "Measured short-step motion",
    "aka.ground.motionHint": "On the same clear floor, measure at least three forward and left/right pulses at this speed and duration, including stopping displacement. Enter samples separated by commas. Keep the camera fixed; these observations do not provide obstacle avoidance.",
    "aka.ground.motion_speed": "Measured speed (%)",
    "aka.ground.motion_milliseconds": "Pulse duration (ms)",
    "aka.ground.motion_forwardMeters": "Forward displacement samples including stop (m)",
    "aka.ground.motion_leftDegrees": "Left turn samples including stop (degrees)",
    "aka.ground.motion_rightDegrees": "Right turn samples including stop (degrees)",
    "aka.ground.motion_marginMeters": "Displacement allowance (m)",
    "aka.ground.motion_marginDegrees": "Turn allowance (degrees)",
    "aka.ground.motion_minimumStandoff": "Minimum permitted target standoff (m)",
    "aka.ground.motion_turningClearance": "Minimum target range for turns (m)",
    "aka.ground.motion_lateralTolerance": "Lateral alignment tolerance (m)",
    "aka.ground.motion_maximumVisionError": "Maximum accepted visual error (m)",
    "aka.manual.targetFound": "Target detected; review the original image",
    "aka.manual.targetAbsent": "No target detected in sampled views",
    "aka.manual.targetSearching": "Target not confirmed",
    "aka.manual.home_unknown": "Return position not confirmed",
    "aka.manual.home_observed_candidate": "Home marker pose matches; check the original image",
    "aka.manual.viewpoints": "Estimated viewpoints",
    "aka.manual.stage_search": "Finding the target",
    "aka.manual.stage_approach": "Approaching the target",
    "aka.manual.stage_grasp": "Picking up and checking",
    "aka.manual.stage_transport": "Carrying and checking the destination",
    "aka.manual.stage_release": "Releasing and checking",
    "aka.manual.stage_find": "Finding the target",
    "aka.manual.stage_grab": "Picking up and checking",
    "aka.recognition.control.distance": "Estimated ground distance",
    "aka.recognition.control.observedError": "Observed error + measurement allowance",
    "aka.recognition.control.distanceUnknown": "Distance unknown: calibration or ground contact not verified",
    "aka.ground.title": "Ground distance calibration",
    "aka.ground.hint": "Keep the camera fixed. Enter 6 ground references and 3 separate validation points; origin at the midpoint of the wheel axle, x forward and y left, in metres. Estimates alone do not enable grabbing.",
    "aka.ground.installation": "Camera installation",
    "aka.ground.labels": "Verified ground-contact labels (comma separated, exact detection names)",
    "aka.ground.error": "Measurement error (metres)",
    "aka.ground.points": "Reference points",
    "aka.ground.checks": "Independent checks",
    "aka.ground.u": "Pixel horizontal",
    "aka.ground.v": "Pixel vertical",
    "aka.ground.x": "Forward (m)",
    "aka.ground.y": "Left (m)",
    "aka.ground.save": "Save calibration",
    "aka.ground.saved": "Saved. Maximum observed error:",
    "aka.ground.failed": "Calibration was not saved. Check points, labels, coordinates and revision.",
    "aka.ground.close": "Close",
    "aka.ground.routeTitle": "Saved routes",
    "aka.ground.routeHint": "Save a route verified on the current clear floor. Saving never moves the robot. Patrol and return share a 12-step limit.",
    "aka.ground.route_patrol": "Save patrol and return route",
    "aka.ground.route_delivery": "Save delivery route",
    "aka.ground.routeOutbound": "Outbound",
    "aka.ground.routeReturn": "Return",
    "aka.ground.routeDelivery": "From pickup to destination",
    "aka.ground.routeHome": "Home marker detection labels, separated by commas",
    "aka.ground.routeDestination": "Destination detection labels, separated by commas",
    "aka.ground.routeAction": "Action",
    "aka.ground.route_up": "Forward",
    "aka.ground.route_down": "Backward",
    "aka.ground.route_left": "Turn left",
    "aka.ground.route_right": "Turn right",
    "aka.ground.route_speed": "Speed (30\u201350)",
    "aka.ground.route_milliseconds": "Duration (ms)",
    "aka.ground.routeAdd": "Add step",
    "aka.ground.routeRemove": "Remove step",
    "aka.manual.task_capturing": "Taking photos",
    "aka.manual.task_gripping": "Arm action in progress",
    "aka.manual.task_verifying": "Checking new observation images",
    "aka.manual.grip_unknown": "Possession or landing not confirmed",
    "aka.manual.grip_held_candidate": "Visual holding evidence; review original images",
    "aka.manual.grip_released_candidate": "Visual landing evidence; review original images",
    "aka.manual.task_approaching": "Approaching",
    "aka.manual.outcome_at_standoff": "At estimated stopping distance",
    "aka.manual.outcome_paused": "Paused for review",
    "aka.manual.outcome_step_limit": "Step budget exhausted",
    "aka.manual.task_turning": "Turning",
    "aka.manual.task_completed": "Observation finished",
    "aka.manual.task_cancelled": "Cancelled",
    "aka.manual.task_failed": "Observation failed",
    "aka.manual.task": "Observation task",
    "aka.manual.cancelTask": "Cancel observation",
    "aka.panel.speedSettings": "Driving speed settings",
    "aka.panel.armSettings": "Servo settings",
    "aka.robotSettings.save": "Save to robot",
    "aka.robotSettings.close": "Close",
    "aka.robotSettings.loading": "Reading robot settings\u2026",
    "aka.robotSettings.saved": "Saved and verified by reading back.",
    "aka.robotSettings.error": "Settings could not be confirmed. Close and read again before saving.",
    "aka.robotSettings.hint": "Saving changes configuration without moving the servos. Manual actions retain their separate speed limit.",
    "aka.robotSettings.unit": "Driver unit: ",
    "aka.recognition.control.continuousOn": "Enable continuous recognition",
    "aka.recognition.control.continuousOff": "Disable continuous recognition",
    "aka.recognition.control.continuousRunning": "Recognition is active within the existing budget. One image at a time, up to the configured rate; hiding this page stops new requests.",
    "aka.manual.title": "Manual control",
    "aka.manual.hint": "One finite step per click. Wheel readings are reported, not verified. A receipt does not prove stopped, held or delivered.",
    "aka.manual.speed": "Manual speed (30\u201350%)",
    "aka.manual.duration": "Step duration (500\u20133000 ms)",
    "aka.manual.up": "Forward",
    "aka.manual.down": "Backward",
    "aka.manual.left": "Turn left",
    "aka.manual.right": "Turn right",
    "aka.manual.stop": "Stop motors",
    "aka.manual.grab": "Grip",
    "aka.manual.release": "Release",
    "aka.manual.leftWheel": "Left wheel (reported)",
    "aka.manual.rightWheel": "Right wheel (reported)",
    "aka.manual.phase": "Action status",
    "aka.manual.idle": "Ready for a manual action",
    "aka.manual.moving": "Movement in progress",
    "aka.manual.gripping": "Gripper sequence in progress",
    "aka.manual.unknown": "Outcome unknown. Check the device; do not repeat the action.",
    "aka.manual.unavailable": "Unknown / stale",
    "aka.manual.pending": "Executing one finite action\u2026",
    "aka.manual.stopping": "Requesting motor stop\u2026",
    "aka.manual.receipt": "Device receipt received. Physical result remains unverified.",
    "aka.manual.sent": "Control packet sent. Check the live view for movement.",
    "aka.manual.stopReceipt": "Stop receipt received. Stationary state and arm cancellation remain unverified.",
    "aka.manual.invalid": "Speed must be 30\u201350 and duration must be 500\u20133000 milliseconds.",
    "aka.recognition.control.selected": "Frame selected (bridge receive qualification, not exposure time):",
    "aka.recognition.control.received": "Result received by this page:",
    "aka.recognition.control.title": "Single-image recognition",
    "aka.recognition.control.hint": "Read the current budget first. Starting a new round replaces its allowance; testing makes one paid cloud request. Continuous recognition requires its explicit switch.",
    "aka.recognition.control.read": "Read current recognition budget",
    "aka.recognition.control.recover": "Read the original recognition receipt",
    "aka.recognition.control.start": "Start a new recognition budget round",
    "aka.recognition.control.test": "Test one camera image",
    "aka.recognition.control.usage": "Reserved requests / effective allowance:",
    "aka.recognition.control.readFirst": "Read the current configuration and budget before testing.",
    "aka.recognition.control.configureFirst": "Save an Alibaba Cloud recognition configuration first.",
    "aka.recognition.control.localUnavailable": "Local YOLO execution is not connected to this test entry.",
    "aka.recognition.control.startFirst": "No budget round exists. Explicitly start one before testing.",
    "aka.recognition.control.exhausted": "The effective budget is exhausted. Reading or reconnecting does not reset it.",
    "aka.recognition.control.cameraRequired": "Connect the robot and receive camera data before testing.",
    "aka.recognition.control.idle": "Ready",
    "aka.recognition.control.ready": "Current result checked.",
    "aka.recognition.control.pending": "Waiting for the requested operation\u2026",
    "aka.recognition.control.error": "Current settings or budget could not be checked. Read again before testing.",
    "aka.recognition.control.notStarted": "The original operation did not enter cloud detection. Enable recognition or test again after stopping and receiving a settled frame; configuration and usage were not reset.",
    "aka.recognition.control.lowConfidence": "Low confidence; class unconfirmed",
    "aka.recognition.control.unknown": "Outcome unknown. Check session history and usage; this control will not repeat detection or reset the budget.",
    "aka.recognition.control.result": "Most recent submitted original and detections",
    "aka.recognition.control.alt": "Original robot camera image submitted for recognition",
    "aka.recognition.control.imageLoading": "Reading the saved original\u2026",
    "aka.recognition.control.imageError": "The saved original could not be verified or displayed.",
    "aka.recognition.control.readImage": "Read saved original again",
    "aka.recognition.control.historical": "Saved observation, separate from live video. Detection confidence is not distance accuracy or proof of a grasp.",
    "aka.recognition.control.empty": "No objects returned for this image.",
    "aka.capture.control.capture": "Save current camera photo",
    "aka.capture.control.recover": "Check the original photo result",
    "aka.capture.control.pending": "Saving the selected photo to this session\u2026",
    "aka.capture.control.recorded": "Photo recorded. See the session history.",
    "aka.capture.control.unknown": "Capture outcome is unknown and may already be recorded. Check session history; this control will not automatically take another photo.",
    "aka.capture.title": "Saved robot photo",
    "aka.capture.alt": "Saved camera frame from the robot",
    "aka.capture.loading": "Loading the saved photo\u2026",
    "aka.capture.pending": "Waiting for the capture result\u2026",
    "aka.capture.error": "The saved photo could not be displayed. It may be unavailable or exceed the current image reader limit.",
    "aka.capture.selectedAt": "Frame selected at",
    "aka.capture.historical": "Saved observation; this is not a live position or proof of a successful grasp.",
    "aka.capture.retry": "Read saved photo again",
    "aka.recognition.endpoint": "Endpoint (fixed)",
    "aka.recognition.region": "Region (fixed)",
    "aka.recognition.apiVersion": "API (fixed)",
    "aka.recognition.title": "Image recognition settings",
    "aka.recognition.hint": "Saving only updates settings. It does not start the camera or paid recognition. Use the recognition switch below to start.",
    "aka.recognition.provider": "Recognition source",
    "aka.recognition.cloud": "Cloud (Aliyun)",
    "aka.recognition.local": "Local YOLO",
    "aka.recognition.cloudHint": "Fixed Shanghai DetectObject; requires product access and an AccessKey ID / Secret, not a DashScope key.",
    "aka.recognition.localHint": "Local YOLO is untested. Use a local or private LAN HTTP(S) service origin without paths, query parameters or credentials.",
    "aka.recognition.frequency": "Maximum request frequency",
    "aka.recognition.halfHz": "0.5 requests/second",
    "aka.recognition.oneHz": "1 request/second",
    "aka.recognition.twoHz": "2 requests/second",
    "aka.recognition.budget": "Request budget (1\u2013100000)",
    "aka.recognition.baseUrl": "Local service origin",
    "aka.recognition.credentials": "Credentials",
    "aka.recognition.keep": "Keep stored credentials",
    "aka.recognition.replace": "Set or replace credentials",
    "aka.recognition.noToken": "Use no local token",
    "aka.recognition.accessKeyId": "AccessKey ID",
    "aka.recognition.accessKeySecret": "AccessKey Secret",
    "aka.recognition.token": "Local service token",
    "aka.recognition.save": "Save recognition settings",
    "aka.recognition.refresh": "Read settings again",
    "aka.recognition.close": "Close",
    "aka.recognition.pending": "Reading or saving recognition settings\u2026",
    "aka.recognition.saved": "Settings saved; recognition has not started.",
    "aka.recognition.readFailure": "Could not read current settings. Read again before saving.",
    "aka.recognition.saveFailure": "Save outcome is unknown and may have succeeded. Read back before retrying; no automatic resubmission.",
    "aka.recognition.invalid": "Check frequency, budget, origin and complete credentials. Secret inputs have been cleared; enter them again.",
    "aka.panel.videoAlt": "Live image from the current robot camera",
    "aka.panel.videoIdle": "Live view is stopped.",
    "aka.panel.videoWaiting": "Waiting for an authenticated camera image\u2026",
    "aka.panel.videoLive": "Live camera image received.",
    "aka.panel.videoError": "Live view ended or could not be verified. Check connection before restarting.",
    "aka.panel.videoTicketError": "Camera access could not be obtained. The backend may be unavailable or timed out.",
    "aka.panel.videoChannelError": "The video connection closed or its authorization timed out. Retry the live view.",
    "aka.panel.videoFrameError": "The video connection received no complete camera frame for 5 seconds.",
    "aka.panel.videoFrameFormatError": "The video connection received an invalid or incomplete camera frame.",
    "aka.panel.videoDecodeError": "The camera image could not be decoded or its dimensions did not match.",
    "aka.panel.videoRenewalError": "The video access renewal failed. Retry the live view.",
    "aka.panel.startVideo": "Watch live camera",
    "aka.panel.stopVideo": "Stop watching",
    "aka.panel.title": "AKA robot connection",
    "aka.panel.ip": "Robot LAN IPv4 address",
    "aka.panel.port": "HTTP port",
    "aka.panel.probe": "Check device identity",
    "aka.panel.save": "Confirm and save configuration",
    "aka.panel.connect": "Connect saved device",
    "aka.panel.disconnect": "Disconnect subscriptions",
    "aka.panel.refresh": "Refresh configuration and state",
    "aka.panel.openCamera": "Open camera",
    "aka.panel.closeCamera": "Close camera",
    "aka.panel.loading": "Reading current configuration\u2026",
    "aka.panel.pending": "Operation pending\u2026",
    "aka.panel.failure": "Could not verify the result. Refresh current configuration before retrying.",
    "aka.panel.unavailable": "Current session or connection is unavailable. Device operations are disabled.",
    "aka.panel.identity": "Reported MAC",
    "aka.panel.identityHint": "This is the device\u2019s reported identity, not proof of authenticity. Confirm the intended robot before saving.",
    "aka.panel.saved": "Saved endpoint",
    "aka.panel.revision": "Configuration revision",
    "aka.panel.connection": "Connection",
    "aka.panel.camera": "Camera",
    "aka.panel.notConnected": "Not connected",
    "aka.panel.connecting": "Connecting",
    "aka.panel.connected": "Connected",
    "aka.panel.degraded": "Connection unavailable",
    "aka.panel.disposed": "Connection retired",
    "aka.panel.cameraIdle": "Not subscribed",
    "aka.panel.cameraOpening": "Opening camera",
    "aka.panel.cameraStreaming": "Camera data received",
    "aka.panel.cameraError": "Camera data unavailable",
    "aka.panel.snapshotHint": "State reflects the latest refresh. Refresh to check again.",
    "aka.panel.unknown": "Unknown",
    "aka.panel.noProfile": "Enter the robot\u2019s LAN address and check its identity. Saving does not connect, open the camera or start recognition.",
    "aka.panel.localDisconnect": "Disconnecting retires local subscriptions; it does not stop the robot or close its hardware camera.",
    "aka.panel.noVideo": "Opening the camera is not proof that this page has received video. Use live view to check.",
    "aka.panel.invalid": "Enter a canonical private IPv4 address and an HTTP port from 1 to 65535."
  },
  "zh-CN": {
    "aka.panel.recover": "\u6062\u590D\u8FDE\u63A5\u548C\u753B\u9762",
    "aka.recognition.control.details": "\u89C2\u5BDF\u8BE6\u60C5",
    "aka.recognition.configured": "\u914D\u7F6E\u5DF2\u4FDD\u5B58 \xB7 \u51ED\u636E\u5DF2\u4FDD\u7559",
    "aka.manual.parameters": "\u5355\u6B65\u53C2\u6570",
    "aka.panel.editConnection": "\u66F4\u6362\u8FDE\u63A5",
    "aka.panel.connectionDetails": "\u8FDE\u63A5\u8BBE\u7F6E",
    "aka.panel.controls": "\u8BBE\u5907\u63A7\u5236",
    "aka.panel.previewHint": "\u76F8\u673A\u5F00\u542F\u540E\u5728\u8FD9\u91CC\u5B9E\u65F6\u663E\u793A\u753B\u9762",
    "aka.panel.backConsole": "\u8FD4\u56DE\u63A7\u5236\u53F0",
    "aka.panel.connectionAdvanced": "\u5355\u72EC\u63A2\u6D4B\u4E0E\u4FDD\u5B58",
    "aka.panel.pair": "\u8FDE\u63A5\u5E76\u4FDD\u5B58",
    "aka.panel.connectionHint": "\u586B\u5199\u5C0F\u8F66\u5728\u5F53\u524D\u5C40\u57DF\u7F51\u4E2D\u7684\u5730\u5740\u3002",
    "aka.panel.newConnection": "\u914D\u7F6E\u65B0\u8FDE\u63A5",
    "aka.modeling.title": "\u4E09\u7EF4\u5EFA\u6A21\u914D\u7F6E",
    "aka.modeling.hint": "\u5FEB\u901F\u6F14\u793A\uFF1A\u56DB\u5F20\u5B9E\u62CD\u7167\u7247\u9009\u4E00\u5F20\u751F\u6210\u6A21\u578B\uFF0C\u5176\u4F59\u7528\u4E8E\u590D\u6838\uFF0C\u518D\u7528 Blender \u6E32\u67D3\u3001\u5BFC\u51FA\u3002\u9700\u542F\u7528 agh-ortho\u3001agh-blender \u5E76\u5B89\u88C5\u56FE\u7247\u751F\u6210\u7F51\u683C\u7A0B\u5E8F\u3002\u4FDD\u5B58\u914D\u7F6E\u4E0D\u4F1A\u542F\u52A8\u7A0B\u5E8F\u3002",
    "aka.modeling.executable": "Blender \u7A0B\u5E8F\u8DEF\u5F84\uFF08\u53EF\u9009\uFF09",
    "aka.modeling.autoDiscover": "\u7559\u7A7A\u81EA\u52A8\u67E5\u627E\u672C\u673A Blender",
    "aka.modeling.height": "\u6F14\u793A\u5C55\u793A\u9AD8\u5EA6\uFF08\u7C73\uFF0C\u4E0D\u662F\u5B9E\u6D4B\u5C3A\u5BF8\uFF09",
    "aka.modeling.generator": "\u751F\u6210\u5668\u914D\u7F6E\uFF08JSON\uFF09",
    "aka.modeling.placeholders": "\u66FF\u6362\u751F\u6210\u5668\u8DEF\u5F84\u3002command \u662F\u547D\u4EE4\u53C2\u6570\u6570\u7EC4\uFF1A{image} \u4E3A\u539F\u56FE\uFF0C{out} \u4E3A\u8F93\u51FA\u76EE\u5F55\uFF0C{prep} \u4E3A\u9884\u5904\u7406\u56FE\u7247\u3002\u53EF\u586B preprocessCommand\u3001output\u3002upAxis \u548C unit \u987B\u6309\u751F\u6210\u5668\u5B9E\u9645\u8F93\u51FA\u586B\u5199\u3002\u5BC6\u94A5\u653E\u73AF\u5883\u53D8\u91CF\uFF0C\u4E0D\u5199\u8FDB\u6B64\u914D\u7F6E\u3002",
    "aka.modeling.save": "\u4FDD\u5B58",
    "aka.modeling.close": "\u5173\u95ED",
    "aka.modeling.saved": "\u5DF2\u4FDD\u5B58\u5230\u8BBE\u5907\u5DE5\u4F5C\u533A\u3002\u53EF\u4EE5\u8BA9\u52A9\u624B\u56DB\u89C6\u89D2\u62CD\u7167\uFF0C\u518D\u751F\u6210\u6F14\u793A\u6A21\u578B\u3002",
    "aka.modeling.loadError": "\u5EFA\u6A21\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25",
    "aka.modeling.saveError": "\u5EFA\u6A21\u914D\u7F6E\u4FDD\u5B58\u5931\u8D25",
    "aka.ground.graspEnabled": "\u6DFB\u52A0\u5B9E\u6D4B\u6293\u53D6\u6807\u5B9A",
    "aka.ground.graspTitle": "\u6293\u53D6\u7A97\u53E3\u4E0E\u89C2\u5BDF\u533A\u57DF",
    "aka.ground.graspHint": "\u91CF\u6D4B\u5B9E\u9645\u53EF\u6293\u53D6\u7684\u4F4D\u7F6E\u8303\u56F4\uFF0C\u6838\u5BF9\u6444\u50CF\u5934\u80FD\u533A\u5206\u7A7A\u722A\u3001\u6301\u7269\u548C\u6ED1\u843D\u3002\u50CF\u7D20\u533A\u57DF\u586B\u5199 x1,y1,x2,y2\uFF0C\u7528\u82F1\u6587\u9017\u53F7\u5206\u9694\uFF1B\u6301\u7269\u4E0E\u843D\u70B9\u533A\u57DF\u4E0D\u5F97\u91CD\u53E0\u3002",
    "aka.ground.grasp_forwardMin": "\u6700\u5C0F\u6293\u53D6\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.grasp_forwardMax": "\u6700\u5927\u6293\u53D6\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.grasp_lateralTolerance": "\u5DE6\u53F3\u6293\u53D6\u5BB9\u5DEE\uFF08\u7C73\uFF09",
    "aka.ground.grasp_settleMilliseconds": "\u673A\u68B0\u81C2\u89C2\u5BDF\u7B49\u5F85\u65F6\u95F4\uFF08\u6BEB\u79D2\uFF0C\u81F3\u5C114000\uFF09",
    "aka.ground.grasp_heldBox": "\u6301\u7269\u89C2\u5BDF\u533A\u57DF\uFF08\u50CF\u7D20\uFF09",
    "aka.ground.grasp_releaseBox": "\u91CA\u653E\u843D\u70B9\u533A\u57DF\uFF08\u50CF\u7D20\uFF09",
    "aka.ground.motionEnabled": "\u6DFB\u52A0\u5B9E\u6D4B\u8FD0\u52A8\u6807\u5B9A",
    "aka.ground.motionTitle": "\u77ED\u6B65\u79FB\u52A8\u5B9E\u6D4B\u53C2\u6570",
    "aka.ground.motionHint": "\u5728\u76F8\u540C\u4E14\u6E05\u7A7A\u7684\u5730\u9762\uFF0C\u4EE5\u6B64\u901F\u5EA6\u548C\u65F6\u957F\u5206\u522B\u91CF\u6D4B\u81F3\u5C11\u4E09\u6B21\u524D\u8FDB\u3001\u5DE6\u8F6C\u3001\u53F3\u8F6C\uFF0C\u5305\u542B\u505C\u8F66\u540E\u7684\u5B9E\u9645\u4F4D\u79FB\uFF1B\u6837\u672C\u7528\u82F1\u6587\u9017\u53F7\u5206\u9694\u3002\u56FA\u5B9A\u6444\u50CF\u5934\uFF0C\u8FD9\u4E9B\u5B9E\u6D4B\u53C2\u6570\u4E0D\u63D0\u4F9B\u907F\u969C\u80FD\u529B\u3002",
    "aka.ground.motion_speed": "\u5B9E\u6D4B\u901F\u5EA6\uFF08%\uFF09",
    "aka.ground.motion_milliseconds": "\u5355\u6B21\u52A8\u4F5C\u65F6\u957F\uFF08\u6BEB\u79D2\uFF09",
    "aka.ground.motion_forwardMeters": "\u5305\u542B\u505C\u8F66\u7684\u524D\u8FDB\u4F4D\u79FB\u6837\u672C\uFF08\u7C73\uFF09",
    "aka.ground.motion_leftDegrees": "\u5305\u542B\u505C\u8F66\u7684\u5DE6\u8F6C\u89D2\u5EA6\u6837\u672C\uFF08\u5EA6\uFF09",
    "aka.ground.motion_rightDegrees": "\u5305\u542B\u505C\u8F66\u7684\u53F3\u8F6C\u89D2\u5EA6\u6837\u672C\uFF08\u5EA6\uFF09",
    "aka.ground.motion_marginMeters": "\u4F4D\u79FB\u8BEF\u5DEE\u4F59\u91CF\uFF08\u7C73\uFF09",
    "aka.ground.motion_marginDegrees": "\u8F6C\u89D2\u8BEF\u5DEE\u4F59\u91CF\uFF08\u5EA6\uFF09",
    "aka.ground.motion_minimumStandoff": "\u76EE\u6807\u6700\u5C0F\u5141\u8BB8\u505C\u8F66\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.motion_turningClearance": "\u5141\u8BB8\u8F6C\u5411\u7684\u6700\u5C0F\u76EE\u6807\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.motion_lateralTolerance": "\u5DE6\u53F3\u5BF9\u9F50\u5BB9\u5DEE\uFF08\u7C73\uFF09",
    "aka.ground.motion_maximumVisionError": "\u5141\u8BB8\u7684\u6700\u5927\u89C6\u89C9\u8BEF\u5DEE\uFF08\u7C73\uFF09",
    "aka.recognition.control.distance": "\u4F30\u8BA1\u5730\u9762\u8DDD\u79BB",
    "aka.recognition.control.observedError": "\u89C2\u6D4B\u504F\u5DEE\u52A0\u91CF\u6D4B\u4F59\u91CF",
    "aka.recognition.control.distanceUnknown": "\u8DDD\u79BB\u672A\u77E5\uFF1A\u672A\u6807\u5B9A\u6216\u63A5\u5730\u70B9\u672A\u6838\u9A8C",
    "aka.ground.title": "\u5730\u9762\u6D4B\u8DDD\u6807\u5B9A",
    "aka.ground.hint": "\u56FA\u5B9A\u76F8\u673A\u548C\u5206\u8FA8\u7387\uFF0C\u586B\u5199\u81F3\u5C116\u4E2A\u53C2\u8003\u70B9\u53CA3\u4E2A\u72EC\u7ACB\u6838\u9A8C\u70B9\u3002\u4EE5\u8F6E\u8F74\u4E2D\u70B9\u4E3A\u539F\u70B9\uFF0Cx\u5411\u524D\u3001y\u5411\u5DE6\uFF0C\u5355\u4F4D\u7C73\u3002\u53EA\u7528\u4E8E\u4F30\u8BA1\u63A5\u5730\u7269\u54C1\u8DDD\u79BB\uFF0C\u4E0D\u76F4\u63A5\u5F00\u653E\u81EA\u52A8\u6293\u53D6\u3002",
    "aka.ground.installation": "\u76F8\u673A\u5B89\u88C5\u63CF\u8FF0",
    "aka.ground.labels": "\u5DF2\u6838\u9A8C\u63A5\u5730\u70B9\u7684\u8BC6\u522B\u7C7B\u522B\uFF08\u82F1\u6587\u9017\u53F7\u5206\u9694\uFF0C\u4F7F\u7528\u8BC6\u522B\u7ED3\u679C\u539F\u540D\u79F0\uFF09",
    "aka.ground.error": "\u4EBA\u5DE5\u91CF\u6D4B\u8BEF\u5DEE\uFF08\u7C73\uFF09",
    "aka.ground.points": "\u53C2\u8003\u70B9",
    "aka.ground.checks": "\u72EC\u7ACB\u6838\u9A8C\u70B9",
    "aka.ground.u": "\u56FE\u50CF\u6A2A\u5750\u6807",
    "aka.ground.v": "\u56FE\u50CF\u7EB5\u5750\u6807",
    "aka.ground.x": "\u524D\u65B9\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.y": "\u5DE6\u4FA7\u8DDD\u79BB\uFF08\u7C73\uFF09",
    "aka.ground.save": "\u4FDD\u5B58\u6807\u5B9A",
    "aka.ground.saved": "\u4FDD\u5B58\u6210\u529F\uFF0C\u89C2\u6D4B\u6700\u5927\u504F\u5DEE\uFF1A",
    "aka.ground.failed": "\u6807\u5B9A\u672A\u4FDD\u5B58\uFF0C\u8BF7\u68C0\u67E5\u53C2\u8003\u70B9\u3001\u7C7B\u522B\u3001\u5750\u6807\u53CA\u7248\u672C\u3002",
    "aka.ground.close": "\u5173\u95ED",
    "aka.ground.routeTitle": "\u9884\u8BBE\u8DEF\u7EBF",
    "aka.ground.routeHint": "\u4FDD\u5B58\u5DF2\u5728\u5F53\u524D\u6E05\u7A7A\u573A\u5730\u9A8C\u8BC1\u7684\u8DEF\u7EBF\u3002\u4FDD\u5B58\u4E0D\u4F1A\u79FB\u52A8\u5C0F\u8F66\uFF1B\u5DE1\u903B\u53BB\u8FD4\u7A0B\u5408\u8BA1\u6700\u591A12\u6BB5\u3002",
    "aka.ground.route_patrol": "\u4FDD\u5B58\u5DE1\u903B\u4E0E\u8FD4\u7A0B\u8DEF\u7EBF",
    "aka.ground.route_delivery": "\u4FDD\u5B58\u642C\u8FD0\u8DEF\u7EBF",
    "aka.ground.routeOutbound": "\u53BB\u7A0B",
    "aka.ground.routeReturn": "\u8FD4\u7A0B",
    "aka.ground.routeDelivery": "\u4ECE\u5939\u53D6\u4F4D\u7F6E\u5230\u76EE\u7684\u5730",
    "aka.ground.routeHome": "\u8D77\u70B9\u6807\u8BB0\u8BC6\u522B\u7C7B\u522B\uFF0C\u9017\u53F7\u5206\u9694",
    "aka.ground.routeDestination": "\u76EE\u7684\u5730\u8BC6\u522B\u7C7B\u522B\uFF0C\u9017\u53F7\u5206\u9694",
    "aka.ground.routeAction": "\u52A8\u4F5C",
    "aka.ground.route_up": "\u524D\u8FDB",
    "aka.ground.route_down": "\u540E\u9000",
    "aka.ground.route_left": "\u5DE6\u8F6C",
    "aka.ground.route_right": "\u53F3\u8F6C",
    "aka.ground.route_speed": "\u901F\u5EA6\uFF0830\u201350\uFF09",
    "aka.ground.route_milliseconds": "\u6301\u7EED\u65F6\u95F4\uFF08\u6BEB\u79D2\uFF09",
    "aka.ground.routeAdd": "\u6DFB\u52A0\u8DEF\u6BB5",
    "aka.ground.routeRemove": "\u5220\u9664\u8DEF\u6BB5",
    "aka.manual.targetFound": "\u5DF2\u8BC6\u522B\u76EE\u6807\uFF0C\u8BF7\u6838\u5BF9\u539F\u56FE",
    "aka.manual.targetAbsent": "\u91C7\u6837\u8303\u56F4\u5185\u672A\u8BC6\u522B\u5230\u76EE\u6807",
    "aka.manual.targetSearching": "\u76EE\u6807\u5C1A\u672A\u786E\u8BA4",
    "aka.manual.home_unknown": "\u8FD4\u56DE\u4F4D\u7F6E\u5C1A\u672A\u786E\u8BA4",
    "aka.manual.home_observed_candidate": "\u8D77\u70B9\u6807\u8BB0\u4F4D\u7F6E\u543B\u5408\uFF0C\u8BF7\u6838\u5BF9\u539F\u56FE",
    "aka.manual.viewpoints": "\u4F30\u8BA1\u62CD\u6444\u89C6\u89D2",
    "aka.manual.stage_search": "\u6B63\u5728\u5BFB\u627E\u76EE\u6807",
    "aka.manual.stage_approach": "\u6B63\u5728\u63A5\u8FD1\u76EE\u6807",
    "aka.manual.stage_grasp": "\u6B63\u5728\u5939\u53D6\u5E76\u6838\u5BF9",
    "aka.manual.stage_transport": "\u6B63\u5728\u642C\u8FD0\u5E76\u6838\u5BF9\u76EE\u7684\u5730",
    "aka.manual.stage_release": "\u6B63\u5728\u91CA\u653E\u5E76\u6838\u5BF9",
    "aka.manual.stage_find": "\u6B63\u5728\u5BFB\u627E\u76EE\u6807",
    "aka.manual.stage_grab": "\u6B63\u5728\u5939\u53D6\u5E76\u6838\u5BF9",
    "aka.manual.task_capturing": "\u6B63\u5728\u62CD\u7167",
    "aka.manual.task_gripping": "\u6B63\u5728\u6267\u884C\u5939\u722A\u52A8\u4F5C",
    "aka.manual.task_verifying": "\u6B63\u5728\u6838\u5BF9\u65B0\u7684\u89C2\u5BDF\u539F\u56FE",
    "aka.manual.grip_unknown": "\u6301\u7269\u6216\u843D\u70B9\u5C1A\u672A\u786E\u8BA4",
    "aka.manual.grip_held_candidate": "\u5DF2\u89C2\u5BDF\u5230\u6301\u7269\u8FF9\u8C61\uFF0C\u8BF7\u6838\u5BF9\u539F\u56FE",
    "aka.manual.grip_released_candidate": "\u5DF2\u89C2\u5BDF\u5230\u843D\u70B9\u8FF9\u8C61\uFF0C\u8BF7\u6838\u5BF9\u539F\u56FE",
    "aka.manual.task_approaching": "\u6B63\u5728\u63A5\u8FD1",
    "aka.manual.outcome_at_standoff": "\u5DF2\u8FDB\u5165\u4F30\u8BA1\u505C\u8F66\u8303\u56F4",
    "aka.manual.outcome_paused": "\u5DF2\u6682\u505C\uFF0C\u8BF7\u6838\u5BF9\u73B0\u573A\u4E0E\u539F\u56FE",
    "aka.manual.outcome_step_limit": "\u5DF2\u7528\u5B8C\u672C\u6B21\u6B65\u6570",
    "aka.manual.task_turning": "\u6B63\u5728\u8F6C\u5411",
    "aka.manual.task_completed": "\u89C2\u5BDF\u7ED3\u675F",
    "aka.manual.task_cancelled": "\u5DF2\u53D6\u6D88",
    "aka.manual.task_failed": "\u89C2\u5BDF\u672A\u5B8C\u6210",
    "aka.manual.task": "\u89C2\u5BDF\u4EFB\u52A1",
    "aka.manual.cancelTask": "\u53D6\u6D88\u89C2\u5BDF\u4EFB\u52A1",
    "aka.panel.speedSettings": "\u884C\u9A76\u901F\u5EA6\u8BBE\u7F6E",
    "aka.panel.armSettings": "\u8235\u673A\u89D2\u5EA6\u8BBE\u7F6E",
    "aka.robotSettings.save": "\u4FDD\u5B58\u5230\u5C0F\u8F66",
    "aka.robotSettings.close": "\u5173\u95ED",
    "aka.robotSettings.loading": "\u6B63\u5728\u8BFB\u53D6\u5C0F\u8F66\u53C2\u6570\u2026",
    "aka.robotSettings.saved": "\u5DF2\u4FDD\u5B58\uFF0C\u56DE\u8BFB\u6838\u5BF9\u901A\u8FC7\u3002",
    "aka.robotSettings.error": "\u53C2\u6570\u672A\u786E\u8BA4\uFF0C\u8BF7\u5173\u95ED\u540E\u91CD\u65B0\u8BFB\u53D6\u518D\u4FDD\u5B58\u3002",
    "aka.robotSettings.hint": "\u4FDD\u5B58\u4FEE\u6539\u5C0F\u8F66\u914D\u7F6E\uFF0C\u4E0D\u6267\u884C\u8235\u673A\u52A8\u4F5C\u9884\u89C8\u3002\u624B\u52A8\u884C\u9A76\u4ECD\u4F7F\u7528\u72EC\u7ACB\u7684\u9650\u901F\u53C2\u6570\u3002",
    "aka.robotSettings.unit": "\u9A71\u52A8\u5355\u4F4D\uFF1A",
    "aka.recognition.control.continuousOn": "\u5F00\u542F\u8FDE\u7EED\u8BC6\u522B",
    "aka.recognition.control.continuousOff": "\u5173\u95ED\u8FDE\u7EED\u8BC6\u522B",
    "aka.recognition.control.continuousRunning": "\u5728\u73B0\u6709\u989D\u5EA6\u5185\u6301\u7EED\u8BC6\u522B\uFF0C\u4E00\u6B21\u5904\u7406\u4E00\u5F20\uFF0C\u9891\u7387\u4E0D\u8D85\u8FC7\u914D\u7F6E\u503C\uFF1B\u9875\u9762\u9690\u85CF\u540E\u505C\u6B62\u65B0\u8BF7\u6C42\u3002",
    "aka.manual.title": "\u624B\u52A8\u63A7\u5236",
    "aka.manual.hint": "\u6BCF\u6B21\u70B9\u51FB\u6267\u884C\u4E00\u4E2A\u6709\u9650\u52A8\u4F5C\u3002\u8F6E\u901F\u4E3A\u8BBE\u5907\u4E0A\u62A5\uFF0C\u672A\u6838\u5B9E\uFF1B\u56DE\u6267\u4E0D\u8BC1\u660E\u505C\u7A33\u3001\u6301\u7269\u6216\u6295\u653E\u6210\u529F\u3002",
    "aka.manual.speed": "\u624B\u52A8\u901F\u5EA6\uFF0830\u201450%\uFF09",
    "aka.manual.duration": "\u5355\u6B65\u65F6\u957F\uFF08500\u20143000 \u6BEB\u79D2\uFF09",
    "aka.manual.up": "\u524D\u8FDB",
    "aka.manual.down": "\u540E\u9000",
    "aka.manual.left": "\u5DE6\u8F6C",
    "aka.manual.right": "\u53F3\u8F6C",
    "aka.manual.stop": "\u505C\u6B62\u5E95\u76D8",
    "aka.manual.grab": "\u5939\u53D6",
    "aka.manual.release": "\u91CA\u653E",
    "aka.manual.leftWheel": "\u5DE6\u8F6E\uFF08\u8BBE\u5907\u4E0A\u62A5\uFF09",
    "aka.manual.rightWheel": "\u53F3\u8F6E\uFF08\u8BBE\u5907\u4E0A\u62A5\uFF09",
    "aka.manual.phase": "\u52A8\u4F5C\u72B6\u6001",
    "aka.manual.idle": "\u53EF\u6267\u884C\u624B\u52A8\u52A8\u4F5C",
    "aka.manual.moving": "\u5E95\u76D8\u52A8\u4F5C\u8FDB\u884C\u4E2D",
    "aka.manual.gripping": "\u5939\u722A\u5E8F\u5217\u8FDB\u884C\u4E2D",
    "aka.manual.unknown": "\u52A8\u4F5C\u7ED3\u679C\u672A\u77E5\uFF0C\u8BF7\u73B0\u573A\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u590D\u64CD\u4F5C\u3002",
    "aka.manual.unavailable": "\u672A\u77E5\uFF0F\u5DF2\u8FC7\u671F",
    "aka.manual.pending": "\u6B63\u5728\u6267\u884C\u4E00\u4E2A\u6709\u9650\u52A8\u4F5C\u2026",
    "aka.manual.stopping": "\u6B63\u5728\u8BF7\u6C42\u5E95\u76D8\u505C\u6B62\u2026",
    "aka.manual.receipt": "\u5DF2\u6536\u5230\u8BBE\u5907\u56DE\u6267\uFF0C\u7269\u7406\u7ED3\u679C\u4ECD\u672A\u6838\u5B9E\u3002",
    "aka.manual.sent": "\u63A7\u5236\u6307\u4EE4\u5DF2\u53D1\u9001\uFF0C\u8BF7\u901A\u8FC7\u5B9E\u65F6\u753B\u9762\u786E\u8BA4\u52A8\u4F5C\u3002",
    "aka.manual.stopReceipt": "\u5DF2\u6536\u5230\u505C\u6B62\u56DE\u6267\uFF0C\u5C1A\u672A\u8BC1\u660E\u5B9E\u8F66\u505C\u7A33\uFF0C\u4E5F\u4E0D\u8868\u793A\u673A\u68B0\u81C2\u5DF2\u53D6\u6D88\u3002",
    "aka.manual.invalid": "\u901F\u5EA6\u987B\u4E3A 30\u201450\uFF0C\u65F6\u957F\u987B\u4E3A 500\u20143000 \u6BEB\u79D2\u3002",
    "aka.recognition.control.selected": "\u9009\u5E27\u65F6\u95F4\uFF08\u7F51\u6865\u63A5\u6536\u8D44\u683C\uFF0C\u4E0D\u662F\u66DD\u5149\u65F6\u95F4\uFF09\uFF1A",
    "aka.recognition.control.received": "\u7ED3\u679C\u5230\u8FBE\u5F53\u524D\u9875\u9762\uFF1A",
    "aka.recognition.control.title": "\u56FE\u50CF\u8BC6\u522B",
    "aka.recognition.control.hint": "\u5148\u8BFB\u53D6\u5F53\u524D\u989D\u5EA6\u3002\u5F00\u59CB\u65B0\u8F6E\u6B21\u4F1A\u66FF\u6362\u672C\u8F6E\u989D\u5EA6\uFF1B\u6D4B\u8BD5\u5C06\u53D1\u8D77\u4E00\u6B21\u6536\u8D39\u4E91\u68C0\u6D4B\u3002\u4E5F\u53EF\u4F7F\u7528\u5F00\u5173\u5728\u73B0\u6709\u989D\u5EA6\u5185\u5F00\u542F\u8FDE\u7EED\u8BC6\u522B\u3002",
    "aka.recognition.control.read": "\u8BFB\u53D6\u5F53\u524D\u8BC6\u522B\u989D\u5EA6",
    "aka.recognition.control.recover": "\u6838\u5BF9\u539F\u8BC6\u522B\u7ED3\u679C",
    "aka.recognition.control.start": "\u5F00\u59CB\u65B0\u7684\u8BC6\u522B\u989D\u5EA6\u8F6E\u6B21",
    "aka.recognition.control.test": "\u6D4B\u8BD5\u56FE\u7247",
    "aka.recognition.control.usage": "\u5DF2\u9884\u7559\u6B21\u6570 / \u5F53\u524D\u6709\u6548\u989D\u5EA6\uFF1A",
    "aka.recognition.control.readFirst": "\u8BF7\u5148\u8BFB\u53D6\u5F53\u524D\u914D\u7F6E\u53CA\u989D\u5EA6\uFF0C\u518D\u6D4B\u8BD5\u8BC6\u522B\u3002",
    "aka.recognition.control.configureFirst": "\u8BF7\u5148\u4FDD\u5B58\u963F\u91CC\u4E91\u8BC6\u522B\u914D\u7F6E\u3002",
    "aka.recognition.control.localUnavailable": "\u672C\u5730 YOLO \u6267\u884C\u5C1A\u672A\u63A5\u5165\u6B64\u6D4B\u8BD5\u5165\u53E3\u3002",
    "aka.recognition.control.startFirst": "\u5F53\u524D\u6CA1\u6709\u8BC6\u522B\u989D\u5EA6\u8F6E\u6B21\uFF0C\u8BF7\u660E\u786E\u5F00\u59CB\u4E00\u8F6E\u540E\u518D\u6D4B\u8BD5\u3002",
    "aka.recognition.control.exhausted": "\u5F53\u524D\u6709\u6548\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF1B\u8BFB\u53D6\u72B6\u6001\u6216\u91CD\u8FDE\u4E0D\u4F1A\u91CD\u7F6E\u989D\u5EA6\u3002",
    "aka.recognition.control.cameraRequired": "\u8BF7\u8FDE\u63A5\u5C0F\u8F66\u5E76\u53D6\u5F97\u76F8\u673A\u6570\u636E\u540E\u518D\u6D4B\u8BD5\u3002",
    "aka.recognition.control.idle": "\u51C6\u5907\u5C31\u7EEA",
    "aka.recognition.control.ready": "\u5F53\u524D\u7ED3\u679C\u5DF2\u6838\u5BF9\u3002",
    "aka.recognition.control.pending": "\u6B63\u5728\u7B49\u5F85\u672C\u6B21\u64CD\u4F5C\u2026",
    "aka.recognition.control.error": "\u65E0\u6CD5\u6838\u5BF9\u5F53\u524D\u914D\u7F6E\u6216\u989D\u5EA6\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u6D4B\u8BD5\u3002",
    "aka.recognition.control.notStarted": "\u5DF2\u786E\u8BA4\u539F\u64CD\u4F5C\u672A\u9001\u68C0\u3002\u505C\u8F66\u4E14\u753B\u9762\u7A33\u5B9A\u540E\u53EF\u91CD\u65B0\u5F00\u542F\u8BC6\u522B\u6216\u6D4B\u8BD5\u56FE\u7247\uFF1B\u914D\u7F6E\u548C\u5DF2\u7528\u989D\u5EA6\u672A\u91CD\u7F6E\u3002",
    "aka.recognition.control.lowConfidence": "\u4F4E\u7F6E\u4FE1\u5EA6\uFF0C\u7C7B\u522B\u672A\u786E\u8BA4",
    "aka.recognition.control.unknown": "\u64CD\u4F5C\u7ED3\u679C\u672A\u786E\u8BA4\u3002\u8BF7\u67E5\u770B\u4F1A\u8BDD\u8BB0\u5F55\u548C\u7528\u91CF\uFF1B\u6B64\u63A7\u4EF6\u4E0D\u4F1A\u91CD\u590D\u68C0\u6D4B\u6216\u91CD\u7F6E\u989D\u5EA6\u3002",
    "aka.recognition.control.result": "\u6700\u8FD1\u9001\u68C0\u539F\u56FE\u4E0E\u8BC6\u522B\u7ED3\u679C",
    "aka.recognition.control.alt": "\u5C0F\u8F66\u672C\u6B21\u63D0\u4EA4\u8BC6\u522B\u7684\u539F\u59CB\u76F8\u673A\u56FE\u7247",
    "aka.recognition.control.imageLoading": "\u6B63\u5728\u8BFB\u53D6\u5DF2\u4FDD\u5B58\u7684\u9001\u68C0\u539F\u56FE\u2026",
    "aka.recognition.control.imageError": "\u65E0\u6CD5\u6838\u9A8C\u6216\u5C55\u793A\u5DF2\u4FDD\u5B58\u7684\u9001\u68C0\u539F\u56FE\u3002",
    "aka.recognition.control.readImage": "\u91CD\u65B0\u8BFB\u53D6\u9001\u68C0\u539F\u56FE",
    "aka.recognition.control.historical": "\u8FD9\u662F\u5DF2\u4FDD\u5B58\u7684\u89C2\u5BDF\uFF0C\u4E0E\u76F4\u64AD\u5206\u5F00\u3002\u8BC6\u522B\u7F6E\u4FE1\u5EA6\u4E0D\u8868\u793A\u8DDD\u79BB\u7CBE\u5EA6\u6216\u6293\u53D6\u6210\u529F\u3002",
    "aka.recognition.control.empty": "\u672C\u5F20\u56FE\u7247\u672A\u8FD4\u56DE\u76EE\u6807\u3002",
    "aka.capture.control.capture": "\u4FDD\u5B58\u5F53\u524D\u76F8\u673A\u7167\u7247",
    "aka.capture.control.recover": "\u6838\u5BF9\u539F\u62CD\u7167\u7ED3\u679C",
    "aka.capture.control.pending": "\u6B63\u5728\u5C06\u9009\u4E2D\u7684\u7167\u7247\u4FDD\u5B58\u5230\u5F53\u524D\u4F1A\u8BDD\u2026",
    "aka.capture.control.recorded": "\u7167\u7247\u5DF2\u7559\u6863\uFF0C\u8BF7\u67E5\u770B\u4F1A\u8BDD\u8BB0\u5F55\u3002",
    "aka.capture.control.unknown": "\u62CD\u7167\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u53EF\u80FD\u5DF2\u7ECF\u7559\u6863\u3002\u8BF7\u68C0\u67E5\u4F1A\u8BDD\u8BB0\u5F55\uFF1B\u6B64\u5165\u53E3\u4E0D\u4F1A\u81EA\u52A8\u518D\u62CD\u4E00\u5F20\u3002",
    "aka.capture.title": "\u5C0F\u8F66\u7559\u6863\u7167\u7247",
    "aka.capture.alt": "\u5C0F\u8F66\u6444\u50CF\u5934\u4FDD\u5B58\u7684\u753B\u9762",
    "aka.capture.loading": "\u6B63\u5728\u8BFB\u53D6\u7559\u6863\u7167\u7247\u2026",
    "aka.capture.pending": "\u7B49\u5F85\u62CD\u7167\u7ED3\u679C\u2026",
    "aka.capture.error": "\u65E0\u6CD5\u5C55\u793A\u7559\u6863\u7167\u7247\uFF1A\u56FE\u7247\u53EF\u80FD\u4E0D\u53EF\u7528\uFF0C\u6216\u8D85\u8FC7\u5F53\u524D\u56FE\u7247\u8BFB\u53D6\u63A5\u53E3\u7684\u5927\u5C0F\u9650\u5236\u3002",
    "aka.capture.selectedAt": "\u753B\u9762\u9009\u53D6\u65F6\u95F4",
    "aka.capture.historical": "\u8FD9\u662F\u5386\u53F2\u89C2\u5BDF\uFF0C\u4E0D\u4EE3\u8868\u5F53\u524D\u76EE\u6807\u4F4D\u7F6E\u6216\u6293\u53D6\u6210\u529F\u3002",
    "aka.capture.retry": "\u91CD\u65B0\u8BFB\u53D6\u7559\u6863\u7167\u7247",
    "aka.recognition.endpoint": "\u670D\u52A1\u7AEF\u70B9\uFF08\u56FA\u5B9A\uFF09",
    "aka.recognition.region": "\u5730\u57DF\uFF08\u56FA\u5B9A\uFF09",
    "aka.recognition.apiVersion": "\u63A5\u53E3\u7248\u672C\uFF08\u56FA\u5B9A\uFF09",
    "aka.recognition.title": "\u56FE\u50CF\u8BC6\u522B\u914D\u7F6E",
    "aka.recognition.hint": "\u4FDD\u5B58\u540E\uFF0C\u901A\u8FC7\u63A7\u5236\u53F0\u5F00\u5173\u5F00\u542F\u8BC6\u522B\u3002\u4E91\u7AEF\u8BC6\u522B\u6309\u8C03\u7528\u91CF\u8BA1\u8D39\u3002",
    "aka.recognition.provider": "\u8BC6\u522B\u6765\u6E90",
    "aka.recognition.cloud": "\u4E91\u7AEF\uFF08\u963F\u91CC\u4E91\uFF09",
    "aka.recognition.local": "\u672C\u5730 YOLO",
    "aka.recognition.cloudHint": "\u4F7F\u7528\u963F\u91CC\u4E91\u89C6\u89C9\u667A\u80FD\u5F00\u653E\u5E73\u53F0\u7684 AccessKey ID \u548C Secret\u3002",
    "aka.recognition.localHint": "\u672C\u5730 YOLO \u670D\u52A1\u5C1A\u672A\u8054\u8C03\u3002\u586B\u5199\u672C\u673A\u6216\u79C1\u6709\u5C40\u57DF\u7F51 HTTP(S) \u670D\u52A1\u6839\u5730\u5740\uFF0C\u4E0D\u542B\u8DEF\u5F84\u3001\u53C2\u6570\u6216\u8D26\u53F7\u3002",
    "aka.recognition.frequency": "\u6700\u5927\u8BF7\u6C42\u9891\u7387",
    "aka.recognition.halfHz": "0.5 \u6B21/\u79D2",
    "aka.recognition.oneHz": "1 \u6B21/\u79D2",
    "aka.recognition.twoHz": "2 \u6B21/\u79D2",
    "aka.recognition.budget": "\u8BF7\u6C42\u9884\u7B97\uFF081\uFF5E100000\uFF09",
    "aka.recognition.baseUrl": "\u672C\u5730\u670D\u52A1\u5730\u5740",
    "aka.recognition.credentials": "\u51ED\u636E\u5904\u7406",
    "aka.recognition.keep": "\u4FDD\u7559\u5DF2\u4FDD\u5B58\u51ED\u636E",
    "aka.recognition.replace": "\u8BBE\u7F6E\u6216\u66F4\u6362\u51ED\u636E",
    "aka.recognition.noToken": "\u4E0D\u4F7F\u7528\u672C\u5730\u4EE4\u724C",
    "aka.recognition.accessKeyId": "AccessKey ID",
    "aka.recognition.accessKeySecret": "AccessKey Secret",
    "aka.recognition.token": "\u672C\u5730\u670D\u52A1\u4EE4\u724C",
    "aka.recognition.save": "\u4FDD\u5B58\u8BC6\u522B\u914D\u7F6E",
    "aka.recognition.refresh": "\u91CD\u65B0\u8BFB\u53D6\u914D\u7F6E",
    "aka.recognition.close": "\u5173\u95ED",
    "aka.recognition.pending": "\u6B63\u5728\u8BFB\u5199\u8BC6\u522B\u914D\u7F6E\u2026",
    "aka.recognition.saved": "\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF1B\u8BC6\u522B\u672A\u542F\u52A8\u3002",
    "aka.recognition.readFailure": "\u65E0\u6CD5\u8BFB\u53D6\u5F53\u524D\u914D\u7F6E\uFF0C\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u4FDD\u5B58\u3002",
    "aka.recognition.saveFailure": "\u4FDD\u5B58\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u53EF\u80FD\u5DF2\u751F\u6548\u3002\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u64CD\u4F5C\uFF0C\u4E0D\u81EA\u52A8\u91CD\u590D\u63D0\u4EA4\u3002",
    "aka.recognition.invalid": "\u8BF7\u68C0\u67E5\u9891\u7387\u3001\u9884\u7B97\u3001\u5730\u5740\u53CA\u5B8C\u6574\u51ED\u636E\uFF1B\u51ED\u636E\u5DF2\u6E05\u7A7A\uFF0C\u8BF7\u91CD\u65B0\u586B\u5199\u3002",
    "aka.panel.videoAlt": "\u5F53\u524D\u5C0F\u8F66\u6444\u50CF\u5934\u5B9E\u65F6\u753B\u9762",
    "aka.panel.videoIdle": "\u5B9E\u65F6\u753B\u9762\u672A\u89C2\u770B\u3002",
    "aka.panel.videoWaiting": "\u6B63\u5728\u7B49\u5F85\u5DF2\u9274\u6743\u7684\u76F8\u673A\u753B\u9762\u2026",
    "aka.panel.videoLive": "\u5DF2\u6536\u5230\u5B9E\u65F6\u76F8\u673A\u753B\u9762\u3002",
    "aka.panel.videoError": "\u5B9E\u65F6\u753B\u9762\u5DF2\u7ED3\u675F\u6216\u65E0\u6CD5\u6838\u5B9E\uFF0C\u8BF7\u68C0\u67E5\u8FDE\u63A5\u540E\u91CD\u65B0\u89C2\u770B\u3002",
    "aka.panel.videoTicketError": "\u672A\u80FD\u53D6\u5F97\u76F8\u673A\u64AD\u653E\u51ED\u636E\uFF0C\u540E\u53F0\u670D\u52A1\u53EF\u80FD\u4E0D\u53EF\u7528\u6216\u54CD\u5E94\u8D85\u65F6\u3002",
    "aka.panel.videoChannelError": "\u89C6\u9891\u8FDE\u63A5\u5DF2\u65AD\u5F00\u6216\u9274\u6743\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u89C2\u770B\u3002",
    "aka.panel.videoFrameError": "\u89C6\u9891\u8FDE\u63A5\u8FDE\u7EED 5 \u79D2\u672A\u6536\u5230\u5B8C\u6574\u76F8\u673A\u753B\u9762\u3002",
    "aka.panel.videoFrameFormatError": "\u89C6\u9891\u8FDE\u63A5\u6536\u5230\u7684\u753B\u9762\u683C\u5F0F\u65E0\u6548\u6216\u6570\u636E\u4E0D\u5B8C\u6574\u3002",
    "aka.panel.videoDecodeError": "\u76F8\u673A\u56FE\u7247\u65E0\u6CD5\u89E3\u7801\uFF0C\u6216\u56FE\u7247\u5C3A\u5BF8\u4E0E\u8BBE\u5907\u4FE1\u606F\u4E0D\u4E00\u81F4\u3002",
    "aka.panel.videoRenewalError": "\u89C6\u9891\u64AD\u653E\u51ED\u636E\u7EED\u671F\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u89C2\u770B\u3002",
    "aka.panel.startVideo": "\u89C2\u770B\u5B9E\u65F6\u753B\u9762",
    "aka.panel.stopVideo": "\u505C\u6B62\u89C2\u770B",
    "aka.panel.title": "AKA \u5C0F\u8F66\u8FDE\u63A5",
    "aka.panel.ip": "\u5C0F\u8F66 IP \u5730\u5740",
    "aka.panel.port": "HTTP \u7AEF\u53E3",
    "aka.panel.probe": "\u63A2\u6D4B\u8BBE\u5907\u8EAB\u4EFD",
    "aka.panel.save": "\u786E\u8BA4\u5E76\u4FDD\u5B58\u914D\u7F6E",
    "aka.panel.connect": "\u8FDE\u63A5\u5DF2\u4FDD\u5B58\u8BBE\u5907",
    "aka.panel.disconnect": "\u65AD\u5F00\u672C\u5730\u8BA2\u9605",
    "aka.panel.refresh": "\u5237\u65B0\u914D\u7F6E\u4E0E\u72B6\u6001",
    "aka.panel.openCamera": "\u5F00\u542F\u6444\u50CF\u5934",
    "aka.panel.closeCamera": "\u5173\u95ED\u6444\u50CF\u5934",
    "aka.panel.loading": "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u914D\u7F6E\u2026",
    "aka.panel.pending": "\u64CD\u4F5C\u8FDB\u884C\u4E2D\u2026",
    "aka.panel.failure": "\u65E0\u6CD5\u6838\u5B9E\u64CD\u4F5C\u7ED3\u679C\uFF0C\u8BF7\u5237\u65B0\u5F53\u524D\u914D\u7F6E\u540E\u518D\u91CD\u8BD5\u3002",
    "aka.panel.unavailable": "\u5F53\u524D\u4F1A\u8BDD\u6216\u8FDE\u63A5\u4E0D\u53EF\u7528\uFF0C\u8BBE\u5907\u64CD\u4F5C\u5DF2\u5173\u95ED\u3002",
    "aka.panel.identity": "\u8BBE\u5907\u81EA\u62A5 MAC",
    "aka.panel.identityHint": "\u8FD9\u662F\u8BBE\u5907\u81EA\u62A5\u8EAB\u4EFD\uFF0C\u4E0D\u4EE3\u8868\u9632\u4F2A\u8BA4\u8BC1\u3002\u8BF7\u786E\u8BA4\u662F\u8981\u8FDE\u63A5\u7684\u5C0F\u8F66\u518D\u4FDD\u5B58\u3002",
    "aka.panel.saved": "\u5DF2\u4FDD\u5B58\u7AEF\u70B9",
    "aka.panel.revision": "\u914D\u7F6E\u7248\u672C",
    "aka.panel.connection": "\u8FDE\u63A5\u72B6\u6001",
    "aka.panel.camera": "\u6444\u50CF\u5934\u72B6\u6001",
    "aka.panel.notConnected": "\u5C1A\u672A\u8FDE\u63A5",
    "aka.panel.connecting": "\u6B63\u5728\u8FDE\u63A5",
    "aka.panel.connected": "\u5DF2\u8FDE\u63A5",
    "aka.panel.degraded": "\u8FDE\u63A5\u5F02\u5E38",
    "aka.panel.disposed": "\u8FDE\u63A5\u5DF2\u7ED3\u675F",
    "aka.panel.cameraIdle": "\u672A\u8BA2\u9605",
    "aka.panel.cameraOpening": "\u6B63\u5728\u5F00\u542F\u76F8\u673A",
    "aka.panel.cameraStreaming": "\u5DF2\u6536\u5230\u76F8\u673A\u6570\u636E",
    "aka.panel.cameraError": "\u76F8\u673A\u6570\u636E\u5F02\u5E38",
    "aka.panel.snapshotHint": "\u72B6\u6001\u6765\u81EA\u6700\u8FD1\u4E00\u6B21\u5237\u65B0\uFF0C\u53EF\u5237\u65B0\u91CD\u65B0\u6838\u5BF9\u3002",
    "aka.panel.unknown": "\u672A\u77E5",
    "aka.panel.noProfile": "\u586B\u5199\u5C0F\u8F66\u7684\u5C40\u57DF\u7F51\u5730\u5740\u5E76\u63A2\u6D4B\u8EAB\u4EFD\u3002\u4FDD\u5B58\u914D\u7F6E\u4E0D\u4F1A\u8FDE\u63A5\u3001\u5F00\u542F\u76F8\u673A\u6216\u542F\u52A8\u8BC6\u522B\u3002",
    "aka.panel.localDisconnect": "\u65AD\u5F00\u4EC5\u9000\u5F79\u672C\u5730\u8BA2\u9605\uFF0C\u4E0D\u4F1A\u4F7F\u5C0F\u8F66\u505C\u8F66\u6216\u5173\u95ED\u786C\u4EF6\u6444\u50CF\u5934\u3002",
    "aka.panel.noVideo": "\u76F8\u673A\u5F00\u542F\u4E0D\u4EE3\u8868\u672C\u9875\u9762\u5DF2\u6536\u5230\u89C6\u9891\uFF0C\u53EF\u70B9\u51FB\u89C2\u770B\u5B9E\u65F6\u753B\u9762\u6838\u5BF9\u3002",
    "aka.panel.invalid": "\u8BF7\u586B\u5199\u89C4\u8303\u7684\u79C1\u6709 IPv4 \u5730\u5740\uFF0C\u4EE5\u53CA 1\uFF5E65535 \u7684 HTTP \u7AEF\u53E3\u3002"
  }
};

// client/ground-settings.js
import { createElement as h3, useEffect as useEffect2, useId, useRef as useRef2, useState as useState2 } from "react";

// client/route-settings.js
import { createElement as h2 } from "react";
var row = () => ({ action: "up", speed: "30", milliseconds: "1000" });
function routeForm(routes) {
  const rows = (steps) => steps?.map((s) => ({ ...s, speed: String(s.speed), milliseconds: String(s.milliseconds) })) ?? [row()];
  return {
    patrolEnabled: !!routes?.patrol,
    deliveryEnabled: !!routes?.delivery,
    steps: rows(routes?.patrol?.steps),
    returnSteps: rows(routes?.patrol?.returnSteps),
    homeLabels: routes?.patrol?.homeLabels.join(",") ?? "",
    deliverySteps: rows(routes?.delivery?.steps),
    destinationLabels: routes?.delivery?.destinationLabels.join(",") ?? ""
  };
}
function savedRoutes(form) {
  const labels = (s) => s.split(",").map((label) => label.trim()).filter(Boolean);
  const steps = (list) => list.map((s) => ({ action: s.action, speed: Number(s.speed), milliseconds: Number(s.milliseconds) }));
  return form.patrolEnabled || form.deliveryEnabled ? {
    ...form.patrolEnabled ? {
      patrol: {
        steps: steps(form.steps),
        returnSteps: steps(form.returnSteps),
        homeLabels: labels(form.homeLabels)
      }
    } : {},
    ...form.deliveryEnabled ? {
      delivery: {
        steps: steps(form.deliverySteps),
        destinationLabels: labels(form.destinationLabels)
      }
    } : {}
  } : void 0;
}
function RouteSettings({ value, change, disabled, t }) {
  const edit = (key, next) => change({ ...value, [key]: next });
  const rows = (key, label, max) => h2(
    "fieldset",
    { disabled },
    h2("legend", null, label),
    value[key].map(
      (step, index) => h2(
        "div",
        { key: index },
        h2(
          "label",
          null,
          `${label} ${index + 1} ${t("routeAction")}`,
          h2(
            "select",
            {
              name: `${key}.${index}.action`,
              value: step.action,
              onChange: (e) => edit(
                key,
                value[key].map((s, i) => i === index ? { ...s, action: e.currentTarget.value } : s)
              )
            },
            ["up", "down", "left", "right"].map(
              (action) => h2("option", { key: action, value: action }, t(`route_${action}`))
            )
          )
        ),
        ["speed", "milliseconds"].map(
          (field) => h2(
            "label",
            { key: field },
            t(`route_${field}`),
            h2("input", {
              name: `${key}.${index}.${field}`,
              type: "number",
              min: field === "speed" ? 30 : 500,
              max: field === "speed" ? 50 : 3e3,
              step: 1,
              required: true,
              value: step[field],
              onChange: (e) => edit(
                key,
                value[key].map((s, i) => i === index ? { ...s, [field]: e.currentTarget.value } : s)
              )
            })
          )
        ),
        h2(
          "button",
          {
            type: "button",
            disabled: value[key].length <= 1,
            "aria-label": `${label} ${index + 1} ${t("routeRemove")}`,
            onClick: () => edit(
              key,
              value[key].filter((_, i) => i !== index)
            )
          },
          t("routeRemove")
        )
      )
    ),
    h2(
      "button",
      {
        type: "button",
        disabled: value[key].length >= max,
        onClick: () => edit(key, [...value[key], row()])
      },
      t("routeAdd")
    )
  );
  const text = (key, label) => h2(
    "label",
    null,
    label,
    h2("input", {
      name: key,
      required: true,
      value: value[key],
      onChange: (e) => edit(key, e.currentTarget.value)
    })
  );
  return h2(
    "fieldset",
    { disabled },
    h2("legend", null, t("routeTitle")),
    h2("p", null, t("routeHint")),
    ["patrol", "delivery"].map(
      (kind) => h2(
        "label",
        { key: kind },
        h2("input", {
          type: "checkbox",
          name: `${kind}RouteEnabled`,
          checked: value[`${kind}Enabled`],
          onChange: (e) => edit(`${kind}Enabled`, e.currentTarget.checked)
        }),
        t(`route_${kind}`)
      )
    ),
    value.patrolEnabled && h2(
      "div",
      null,
      rows("steps", t("routeOutbound"), 12 - value.returnSteps.length),
      rows("returnSteps", t("routeReturn"), 12 - value.steps.length),
      text("homeLabels", t("routeHome"))
    ),
    value.deliveryEnabled && h2(
      "div",
      null,
      rows("deliverySteps", t("routeDelivery"), 12),
      text("destinationLabels", t("routeDestination"))
    )
  );
}

// client/ground-settings.js
var motionFields = [
  "speed",
  "milliseconds",
  "forwardMeters",
  "leftDegrees",
  "rightDegrees",
  "marginMeters",
  "marginDegrees",
  "minimumStandoff",
  "turningClearance",
  "lateralTolerance",
  "maximumVisionError"
];
var sampleFields = ["forwardMeters", "leftDegrees", "rightDegrees"];
var motionRanges = {
  speed: [30, 50, 1],
  milliseconds: [500, 3e3, 1],
  marginMeters: [1e-3, 0.05, 1e-3],
  marginDegrees: [0.1, 5, 0.1],
  minimumStandoff: [0.05, 2, 0.01],
  turningClearance: [0.15, 2, 0.01],
  lateralTolerance: [0.01, 0.15, 1e-3],
  maximumVisionError: [1e-3, 0.05, 1e-3]
};
var blankMotion = () => Object.fromEntries(
  motionFields.map((key) => [key, key === "speed" ? "30" : key === "milliseconds" ? "1000" : ""])
);
var graspFields = [
  "forwardMin",
  "forwardMax",
  "lateralTolerance",
  "settleMilliseconds",
  "heldBox",
  "releaseBox"
];
var blankGrasp = () => Object.fromEntries(graspFields.map((key) => [key, key === "settleMilliseconds" ? "5000" : ""]));
var blank = (count) => Array.from({ length: count }, () => ({ u: "", v: "", x: "", y: "" }));
function GroundSettings({ ctx, sessionId, binding, configRevision, frame, close }) {
  const id = useId(), dialog = useRef2(null), active = useRef2(false), busy = useRef2(false);
  const [view, setView] = useState2({
    pending: true,
    error: false,
    saved: false,
    revision: 0,
    width: frame.width,
    height: frame.height,
    installation: "",
    labels: "",
    measurementErrorMeters: "0.01",
    points: blank(6),
    checks: blank(3),
    motionEnabled: false,
    motion: blankMotion(),
    graspEnabled: false,
    grasp: blankGrasp(),
    routes: routeForm()
  });
  const t = (key) => ctx.locale.t(`aka.ground.${key}`);
  useEffect2(() => {
    active.current = true;
    dialog.current.showModal();
    const invalidate = () => {
      active.current = false;
      close();
    };
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    void ctx.agnes.services.call("aka.geometry.read", { bindingRevision: binding.bindingRevision, configRevision }).then(
      (c) => {
        if (active.current)
          setView(
            (v) => c ? {
              ...v,
              pending: false,
              revision: c.revision,
              routes: routeForm(c.routes),
              graspEnabled: !!c.grasp,
              grasp: c.grasp ? Object.fromEntries(
                graspFields.map((key) => [
                  key,
                  Array.isArray(c.grasp[key]) ? c.grasp[key].join(",") : String(c.grasp[key])
                ])
              ) : blankGrasp(),
              motionEnabled: !!c.motion,
              motion: c.motion ? Object.fromEntries(
                motionFields.map((key) => [
                  key,
                  Array.isArray(c.motion[key]) ? c.motion[key].join(",") : String(c.motion[key])
                ])
              ) : blankMotion(),
              width: c.width,
              height: c.height,
              installation: c.installation,
              labels: c.labels.join(","),
              points: c.points,
              checks: c.checks,
              measurementErrorMeters: String(c.measurementErrorMeters)
            } : { ...v, pending: false }
          );
      },
      () => {
        if (active.current) setView((v) => ({ ...v, pending: false, error: true }));
      }
    );
    return () => {
      active.current = false;
      for (const stop of off) stop?.();
      dialog.current?.close();
    };
  }, [ctx, binding.bindingRevision, configRevision, close]);
  const edit = (key, value) => setView((v) => ({ ...v, [key]: value, saved: false }));
  async function save(event) {
    event.preventDefault();
    if (busy.current || view.pending || !active.current || ctx.session.sessionId !== sessionId) return;
    busy.current = true;
    setView((v) => ({ ...v, pending: true, saved: false, error: false }));
    try {
      const routes = savedRoutes(view.routes);
      const c = await ctx.commands.execute("aka.geometry.save", {
        bindingRevision: binding.bindingRevision,
        configRevision,
        expectedRevision: view.revision,
        calibration: {
          ...routes ? { routes } : {},
          ...view.graspEnabled ? {
            grasp: Object.fromEntries(
              graspFields.map((key) => [
                key,
                key.endsWith("Box") ? view.grasp[key].split(",").map((v) => v.trim() ? Number(v) : NaN) : Number(view.grasp[key])
              ])
            )
          } : {},
          ...view.motionEnabled ? {
            motion: Object.fromEntries(
              motionFields.map((key) => [
                key,
                sampleFields.includes(key) ? view.motion[key].split(",").map((v) => v.trim() ? Number(v) : NaN) : Number(view.motion[key])
              ])
            )
          } : {},
          width: view.width,
          height: view.height,
          installation: view.installation,
          labels: view.labels.split(",").map((label) => label.trim()).filter(Boolean),
          measurementErrorMeters: Number(view.measurementErrorMeters),
          points: view.points.map(
            (p) => Object.fromEntries(Object.entries(p).map(([k, value]) => [k, Number(value)]))
          ),
          checks: view.checks.map(
            (p) => Object.fromEntries(Object.entries(p).map(([k, value]) => [k, Number(value)]))
          )
        }
      });
      if (active.current)
        setView((v) => ({
          ...v,
          revision: c.revision,
          observedError: c.observedErrorMeters,
          pending: false,
          saved: true
        }));
    } catch {
      if (active.current) setView((v) => ({ ...v, pending: false, error: true }));
    } finally {
      busy.current = false;
    }
  }
  const table = (name, label) => h3(
    "fieldset",
    { disabled: view.pending },
    h3("legend", null, label),
    h3(
      "table",
      null,
      h3(
        "thead",
        null,
        h3(
          "tr",
          null,
          ["u", "v", "x", "y"].map((key) => h3("th", { key, scope: "col" }, t(key)))
        )
      ),
      h3(
        "tbody",
        null,
        view[name].map(
          (point, row2) => h3(
            "tr",
            { key: row2 },
            ["u", "v", "x", "y"].map(
              (key) => h3(
                "td",
                { key },
                h3("input", {
                  type: "number",
                  name: `${name}.${row2}.${key}`,
                  required: true,
                  step: "any",
                  "aria-label": `${label} ${row2 + 1} ${t(key)}`,
                  value: point[key],
                  onChange: (e) => edit(
                    name,
                    view[name].map(
                      (p, index) => index === row2 ? { ...p, [key]: e.currentTarget.value } : p
                    )
                  )
                })
              )
            )
          )
        )
      )
    )
  );
  return h3(
    "dialog",
    {
      ref: dialog,
      className: "aka-recognition-dialog aka-ground-dialog",
      "aria-labelledby": id,
      onCancel: close,
      onClose: close
    },
    h3("h2", { id }, t("title")),
    h3("p", null, t("hint")),
    h3("p", null, `${view.width} \xD7 ${view.height}`),
    h3(
      "form",
      { onSubmit: save },
      h3(
        "label",
        null,
        t("installation"),
        h3("input", {
          name: "groundInstallation",
          required: true,
          maxLength: 128,
          disabled: view.pending,
          value: view.installation,
          onChange: (e) => edit("installation", e.currentTarget.value)
        })
      ),
      h3(
        "label",
        null,
        t("labels"),
        h3("input", {
          name: "groundLabels",
          required: true,
          disabled: view.pending,
          value: view.labels,
          onChange: (e) => edit("labels", e.currentTarget.value)
        })
      ),
      h3(
        "label",
        null,
        t("error"),
        h3("input", {
          name: "groundError",
          type: "number",
          min: 1e-3,
          max: 0.5,
          step: 1e-3,
          required: true,
          disabled: view.pending,
          value: view.measurementErrorMeters,
          onChange: (e) => edit("measurementErrorMeters", e.currentTarget.value)
        })
      ),
      table("points", t("points")),
      table("checks", t("checks")),
      h3(
        "label",
        null,
        h3("input", {
          type: "checkbox",
          name: "motionEnabled",
          checked: view.motionEnabled,
          disabled: view.pending,
          onChange: (e) => edit("motionEnabled", e.currentTarget.checked)
        }),
        t("motionEnabled")
      ),
      view.motionEnabled && h3(
        "fieldset",
        { disabled: view.pending },
        h3("legend", null, t("motionTitle")),
        h3("p", null, t("motionHint")),
        motionFields.map(
          (key) => h3(
            "label",
            { key },
            t(`motion_${key}`),
            h3("input", {
              name: `motion.${key}`,
              required: true,
              value: view.motion[key],
              type: sampleFields.includes(key) ? "text" : "number",
              ...motionRanges[key] ? {
                min: motionRanges[key][0],
                max: motionRanges[key][1],
                step: key === "speed" || key === "milliseconds" ? 1 : "any"
              } : {},
              onChange: (e) => edit("motion", { ...view.motion, [key]: e.currentTarget.value })
            })
          )
        )
      ),
      h3(
        "label",
        null,
        h3("input", {
          type: "checkbox",
          name: "graspEnabled",
          checked: view.graspEnabled,
          disabled: view.pending,
          onChange: (e) => edit("graspEnabled", e.currentTarget.checked)
        }),
        t("graspEnabled")
      ),
      view.graspEnabled && h3(
        "fieldset",
        { disabled: view.pending },
        h3("legend", null, t("graspTitle")),
        h3("p", null, t("graspHint")),
        graspFields.map(
          (key) => h3(
            "label",
            { key },
            t(`grasp_${key}`),
            h3("input", {
              name: `grasp.${key}`,
              required: true,
              value: view.grasp[key],
              type: key.endsWith("Box") ? "text" : "number",
              step: key === "settleMilliseconds" ? 1 : "any",
              onChange: (e) => edit("grasp", { ...view.grasp, [key]: e.currentTarget.value })
            })
          )
        )
      ),
      h3(RouteSettings, {
        value: view.routes,
        change: (routes) => edit("routes", routes),
        disabled: view.pending,
        t
      }),
      h3("button", { type: "submit", disabled: view.pending }, t("save"))
    ),
    view.saved && h3("p", { role: "status" }, `${t("saved")} ${(view.observedError * 100).toFixed(1)} cm`),
    view.error && h3("p", { role: "alert" }, t("failed")),
    h3("button", { type: "button", onClick: close }, t("close"))
  );
}

// client/manual-control.js
import { createElement as h4, useCallback, useEffect as useEffect3, useId as useId2, useRef as useRef3, useState as useState3 } from "react";
function ManualControl({ ctx, sessionId, binding, configRevision, enabled, onStatus }) {
  const prefix = useId2(), epoch = useRef3(0), alive = useRef3(false), busy = useRef3(false), stopBusy = useRef3(false), refreshStatus = useRef3(null);
  const [speed, setSpeed] = useState3("30"), [duration, setDuration] = useState3("1000");
  const [pending, setPending] = useState3(false), [stopping, setStopping] = useState3(false);
  const [task, setTask] = useState3(null);
  const [snapshot, setSnapshot] = useState3(null), [message, setMessage] = useState3(null);
  const t = (key) => ctx.locale.t(`aka.manual.${key}`);
  const valid = useCallback(
    () => alive.current && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected",
    [ctx, sessionId]
  );
  useEffect3(() => {
    alive.current = true;
    let timer, polling = true, reading = false;
    const generation = ++epoch.current;
    const poll = async () => {
      if (!valid() || !enabled || !polling || reading || generation !== epoch.current) return;
      reading = true;
      clearTimeout(timer);
      try {
        const result = await ctx.agnes.services.call("aka.status", {});
        if (!polling || !valid() || generation !== epoch.current) return;
        if (result?.deviceId !== binding.deviceId || result.enrollment !== "active" || result.configRevision !== configRevision)
          throw new Error("Device changed");
        onStatus?.(result);
        setSnapshot(result.runtime ?? null);
        setTask(result.task ?? null);
      } catch {
        if (polling && generation === epoch.current) setSnapshot(null);
      } finally {
        reading = false;
        if (polling && valid() && enabled && generation === epoch.current) timer = setTimeout(poll, 500);
      }
    };
    refreshStatus.current = poll;
    const invalidate = () => {
      epoch.current++;
      setSnapshot(null);
      setTask(null);
    };
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    void poll();
    return () => {
      polling = false;
      if (refreshStatus.current === poll) refreshStatus.current = null;
      alive.current = false;
      epoch.current++;
      clearTimeout(timer);
      for (const fn of off) fn?.();
    };
  }, [ctx, valid, binding.deviceId, configRevision, enabled, onStatus]);
  async function act(action) {
    const stop = action === "stop";
    if (!valid() || !enabled || (stop ? stopBusy.current : busy.current)) return;
    const nSpeed = Number(speed), nDuration = Number(duration);
    if (!stop && (!/^\d+$/.test(speed) || !/^\d+$/.test(duration) || !Number.isSafeInteger(nSpeed) || nSpeed < 30 || nSpeed > 50 || !Number.isSafeInteger(nDuration) || nDuration < 500 || nDuration > 3e3)) {
      setMessage("invalid");
      return;
    }
    const generation = epoch.current;
    if (stop) {
      stopBusy.current = true;
      setStopping(true);
    } else {
      busy.current = true;
      setPending(true);
    }
    setMessage(null);
    try {
      const result = await ctx.commands.execute(stop ? "aka.control.stop" : "aka.control.action", {
        bindingRevision: binding.bindingRevision,
        configRevision,
        action,
        speed: stop ? 1 : nSpeed,
        milliseconds: stop ? 1 : nDuration
      });
      if (!valid() || generation !== epoch.current) return;
      if (result?.deviceId !== binding.deviceId || result.bindingRevision !== binding.bindingRevision || result.configRevision !== configRevision || result.action !== action || result.physicalResult !== "unverified" || !["completed", "acknowledged", "sent"].includes(result.state))
        throw new Error("Unverified receipt");
      setMessage(stop ? "stopReceipt" : result.state === "sent" ? "sent" : "receipt");
      void refreshStatus.current?.();
    } catch {
      if (valid() && generation === epoch.current) setMessage("unknown");
    } finally {
      if (stop) {
        stopBusy.current = false;
        if (alive.current) setStopping(false);
      } else {
        busy.current = false;
        if (alive.current) setPending(false);
      }
    }
  }
  const motionEnabled = enabled && valid() && snapshot?.connection === "connected" && snapshot?.control?.phase === "idle" && !pending && !stopping;
  const wheel = (side) => {
    const report = snapshot?.wheels;
    return report && report.ageMs <= 1500 && Number.isFinite(report[side]) ? `${report[side]} cm/s` : t("unavailable");
  };
  const button = (action, label) => h4("button", { type: "button", disabled: !motionEnabled, onClick: () => void act(action) }, t(label));
  return h4(
    "section",
    { className: "aka-manual-control", "aria-labelledby": `${prefix}-title` },
    task && h4(
      "div",
      { className: "aka-task-status", role: "status" },
      h4(
        "p",
        null,
        `${t("task")}: ${t(`task_${task.phase}`)} \xB7 ${task.completedViews}/${task.requestedViews}`
      ),
      task.kind === "search" && h4(
        "p",
        null,
        `${(task.targetLabels ?? []).join(" / ")} \xB7 ${t(task.targetFound ? "targetFound" : task.phase === "completed" ? "targetAbsent" : "targetSearching")}`
      ),
      task.outcome && h4("p", null, t(`outcome_${task.outcome}`)),
      task.gripEvidence && h4("p", null, t(`grip_${task.gripEvidence}`)),
      task.stage && h4("p", null, t(`stage_${task.stage}`)),
      task.homeEvidence && h4("p", null, t(`home_${task.homeEvidence}`)),
      task.viewpoints?.length > 0 && h4(
        "p",
        null,
        `${t("viewpoints")}: ${task.viewpoints.map((view) => `${view.index}: ${Math.round(view.angleDegrees)}\xB0 \xB1${view.uncertaintyDegrees.toFixed(1)}\xB0`).join(" \xB7 ")}`
      ),
      !task.endedAt && h4(
        "button",
        {
          type: "button",
          onClick: async () => {
            try {
              await ctx.commands.execute("aka.task.cancel", { taskId: task.taskId });
            } catch {
              if (valid()) setMessage("error");
            }
          }
        },
        t("cancelTask")
      )
    ),
    h4("h3", { id: `${prefix}-title` }, t("title")),
    h4(
      "dl",
      { className: "aka-telemetry" },
      h4("dt", null, t("leftWheel")),
      h4("dd", null, wheel("leftCmPerSecond")),
      h4("dt", null, t("rightWheel")),
      h4("dd", null, wheel("rightCmPerSecond")),
      h4("dt", null, t("phase")),
      h4("dd", null, t(snapshot?.control?.phase ?? "unavailable"))
    ),
    h4(
      "details",
      { className: "aka-manual-settings" },
      h4("summary", null, t("parameters")),
      h4(
        "label",
        { htmlFor: `${prefix}-speed` },
        t("speed"),
        h4("input", {
          id: `${prefix}-speed`,
          name: "manualSpeed",
          type: "number",
          min: 30,
          max: 50,
          step: 1,
          value: speed,
          disabled: pending || stopping,
          onChange: (e) => setSpeed(e.currentTarget.value)
        })
      ),
      h4(
        "label",
        { htmlFor: `${prefix}-duration` },
        t("duration"),
        h4("input", {
          id: `${prefix}-duration`,
          name: "manualDuration",
          type: "number",
          min: 500,
          max: 3e3,
          step: 1,
          value: duration,
          disabled: pending || stopping,
          onChange: (e) => setDuration(e.currentTarget.value)
        })
      )
    ),
    h4(
      "div",
      { className: "aka-direction-pad" },
      button("up", "up"),
      button("left", "left"),
      h4(
        "button",
        {
          type: "button",
          className: "aka-stop",
          disabled: !enabled || !valid() || stopping,
          onClick: () => void act("stop")
        },
        t("stop")
      ),
      button("right", "right"),
      button("down", "down")
    ),
    h4("div", { className: "aka-device-actions" }, button("grab", "grab"), button("release", "release")),
    (pending || stopping) && h4("p", { role: "status" }, t(stopping ? "stopping" : "pending")),
    message && h4("p", { role: message === "unknown" || message === "invalid" ? "alert" : "status" }, t(message))
  );
}

// client/media-player.js
var MAX_FRAME = 3 * 1024 * 1024;
var PATH = "/api/client-modules/device-media";
function createMediaPlayer({
  origin,
  rowId,
  sessionId,
  deviceId,
  configRevision,
  bindingRevision,
  ticket,
  valid,
  canvas,
  state,
  error = () => {
  },
  socket = (url) => new WebSocket(url),
  decode = (blob) => createImageBitmap(blob)
}) {
  let stopped = false;
  let peer;
  let timer;
  let frameTimer;
  let metadata = null;
  let newest = null;
  let decoding = false;
  let authorized = false;
  let renewing = false;
  let rowRevision;
  let leaseUntil = 0;
  let stage = "videoTicketError";
  const live = () => !stopped && valid();
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(frameTimer);
    newest = null;
    metadata = null;
    if (peer) {
      peer.onopen = peer.onmessage = peer.onerror = peer.onclose = null;
      peer.close();
    }
    canvas.width = canvas.height = 0;
  };
  const fail = () => {
    if (!stopped) {
      close();
      error(stage);
      state("videoError");
    }
  };
  const mint = async (attempt = 0) => {
    let value;
    try {
      value = await ticket({ configRevision, bindingRevision });
    } catch (cause) {
      if (!live() || !renewing || attempt >= 2 || leaseUntil - performance.now() <= 1e3) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      if (!live() || performance.now() >= leaseUntil) throw cause;
      return mint(attempt + 1);
    }
    if (!live()) throw new Error("Media owner changed");
    if (!value || typeof value.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) || value.expiresInMs !== 3e4 || value.deviceId !== deviceId || value.configRevision !== configRevision || value.bindingRevision !== bindingRevision || typeof value.rowRevision !== "string" || !value.rowRevision || rowRevision && rowRevision !== value.rowRevision)
      throw new Error("Invalid media ticket");
    rowRevision = value.rowRevision;
    return value.ticket;
  };
  const renew = () => {
    if (!live() || renewing || !authorized) return fail();
    renewing = true;
    authorized = false;
    stage = "videoRenewalError";
    timer = setTimeout(fail, Math.max(1, leaseUntil - performance.now()));
    void mint().then((value) => {
      if (!live() || peer.readyState !== 1) return fail();
      peer.send(JSON.stringify({ type: "renew", ticket: value }));
    }).catch(fail);
  };
  const paint = async () => {
    if (decoding || !newest || !live()) return;
    decoding = true;
    const frame = newest;
    newest = null;
    let bitmap;
    try {
      bitmap = await decode(new Blob([frame.bytes], { type: "image/jpeg" }));
      if (!live()) return;
      if (bitmap.width !== frame.meta.width || bitmap.height !== frame.meta.height)
        throw new Error("Decoded dimensions changed");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      context.drawImage(bitmap, 0, 0);
      state("videoLive");
    } catch {
      stage = "videoDecodeError";
      fail();
    } finally {
      bitmap?.close();
      decoding = false;
      if (live() && newest) void paint();
    }
  };
  const receive = (event) => {
    if (!live()) return close();
    try {
      if (typeof event.data === "string") {
        if (event.data.length > 1024 || metadata) throw new Error("Invalid metadata");
        const value = JSON.parse(event.data);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid message");
        if (value.type === "authorized") {
          if (authorized || value.leaseMs !== 6e4 || Object.keys(value).some((key) => !["type", "leaseMs"].includes(key)))
            throw new Error("Invalid lease");
          clearTimeout(timer);
          authorized = true;
          renewing = false;
          stage = "videoFrameError";
          leaseUntil = performance.now() + value.leaseMs;
          timer = setTimeout(renew, 3e4);
          if (!frameTimer) frameTimer = setTimeout(fail, 5e3);
          return;
        }
        if (!authorized && !renewing || value.type !== "frame" || Object.keys(value).some(
          (key) => !["type", "id", "width", "height", "byteLength", "timeBasis", "ageMs"].includes(key)
        ) || typeof value.id !== "string" || !value.id || value.id.length > 256 || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 4096 || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 4096 || value.width * value.height > 16e6 || !Number.isSafeInteger(value.byteLength) || value.byteLength < 4 || value.byteLength > MAX_FRAME || value.timeBasis !== "bridge_receive" || !Number.isFinite(value.ageMs) || value.ageMs < 0)
          throw new Error("Invalid frame");
        metadata = value;
      } else {
        if (!(event.data instanceof ArrayBuffer) || !metadata || event.data.byteLength !== metadata.byteLength)
          throw new Error("Unpaired frame");
        const bytes = new Uint8Array(event.data);
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
          throw new Error("Invalid JPEG");
        newest = { bytes: event.data, meta: metadata };
        metadata = null;
        clearTimeout(frameTimer);
        frameTimer = setTimeout(fail, 5e3);
        void paint();
      }
    } catch {
      stage = "videoFrameFormatError";
      fail();
    }
  };
  state("videoWaiting");
  const start = async () => {
    try {
      timer = setTimeout(fail, 15e3);
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
        throw new Error("Invalid media origin");
      const value = await mint();
      if (!live()) return close();
      clearTimeout(timer);
      stage = "videoChannelError";
      timer = setTimeout(fail, 15e3);
      url.pathname = PATH;
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      peer = socket(url.href);
      peer.binaryType = "arraybuffer";
      peer.onopen = () => {
        if (!live()) return close();
        peer.send(JSON.stringify({ type: "auth", rowId, sessionId, ticket: value }));
      };
      peer.onmessage = receive;
      peer.onerror = peer.onclose = () => {
        stage = renewing ? "videoRenewalError" : "videoChannelError";
        fail();
      };
    } catch {
      fail();
    }
  };
  void start();
  return close;
}

// client/recognition-control.js
import { createElement as h6, useCallback as useCallback3, useEffect as useEffect5, useId as useId4, useRef as useRef5, useState as useState5 } from "react";

// client/recognition-settings.js
import { createElement as h5, useCallback as useCallback2, useEffect as useEffect4, useId as useId3, useRef as useRef4, useState as useState4 } from "react";
function checked(value, binding) {
  if (!value || Object.keys(value).sort().join(",") !== "bindingRevision,configRevision,deviceId,settings" || value.deviceId !== binding.deviceId || value.bindingRevision !== binding.bindingRevision || !Number.isSafeInteger(value.configRevision) || value.configRevision < 0)
    throw new Error("Invalid settings");
  const s = value.settings;
  if (s !== null) {
    if (!s || !["aliyun", "local-yolo"].includes(s.provider) || ![0.5, 1, 2].includes(s.frequency) || !Number.isSafeInteger(s.requestBudget) || s.requestBudget < 1 || s.requestBudget > 1e5 || typeof s.credentialConfigured !== "boolean" || s.provider === "aliyun" && !s.credentialConfigured || Object.keys(s).sort().join(",") !== (s.provider === "aliyun" ? "credentialConfigured,frequency,provider,requestBudget" : "baseUrl,credentialConfigured,frequency,provider,requestBudget") || s.provider === "local-yolo" && (typeof s.baseUrl !== "string" || s.baseUrl.length > 2048))
      throw new Error("Invalid settings");
  }
  return value;
}
function RecognitionSettings({ ctx, sessionId, binding, close, onSaved }) {
  const id = useId3();
  const { deviceId, bindingRevision } = binding;
  const dialog = useRef4(null);
  const form = useRef4(null);
  const epoch = useRef4(0);
  const alive = useRef4(false);
  const busy = useRef4(false);
  const [view, setView] = useState4({
    ready: false,
    pending: false,
    saved: false,
    error: null,
    provider: "aliyun",
    frequency: "2",
    requestBudget: "3600",
    baseUrl: "",
    action: "replace",
    current: null
  });
  const t = (key) => ctx.locale.t(`aka.recognition.${key}`);
  const available = useCallback2(
    () => alive.current && binding.active && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected",
    [ctx, sessionId, binding.active]
  );
  const clearSecrets = useCallback2(() => {
    for (const input2 of form.current?.querySelectorAll('input[type="password"]') ?? []) input2.value = "";
  }, []);
  const dismiss = () => {
    epoch.current++;
    clearSecrets();
    close();
  };
  useEffect4(() => {
    alive.current = true;
    dialog.current.showModal();
    const invalidate = () => {
      epoch.current++;
      clearSecrets();
      close();
    };
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    return () => {
      alive.current = false;
      epoch.current++;
      clearSecrets();
      dialog.current?.close();
      for (const stop of off) stop?.();
    };
  }, [ctx, close, clearSecrets]);
  useEffect4(() => {
    if (!binding.active) {
      epoch.current++;
      clearSecrets();
      close();
    }
  }, [binding.active, clearSecrets, close]);
  const load = useCallback2(
    async (force = false) => {
      if (!available() || busy.current && !force) return;
      busy.current = true;
      const revision = ++epoch.current;
      setView((old) => ({ ...old, ready: false, pending: true, saved: false, error: null }));
      clearSecrets();
      try {
        if (!ctx.agnes.device?.recognition) throw new Error("Unavailable");
        const result = checked(await ctx.agnes.device.recognition(sessionId), { deviceId, bindingRevision });
        if (!available() || epoch.current !== revision) return;
        const s = result.settings;
        setView({
          ready: true,
          pending: false,
          saved: false,
          error: null,
          current: result,
          provider: s?.provider ?? "aliyun",
          frequency: String(s?.frequency ?? 2),
          requestBudget: String(s?.requestBudget ?? 3600),
          baseUrl: s?.baseUrl ?? "",
          action: s?.credentialConfigured ? "keep" : s?.provider === "local-yolo" ? "clear" : "replace"
        });
      } catch {
        if (available() && epoch.current === revision)
          setView((old) => ({ ...old, ready: false, pending: false, error: "readFailure" }));
      } finally {
        if (epoch.current === revision) busy.current = false;
      }
    },
    [available, ctx, sessionId, deviceId, bindingRevision, clearSecrets]
  );
  useEffect4(() => {
    void load(true);
  }, [load]);
  function edit(name, value) {
    if (!available() || busy.current || !view.ready) return;
    if (name === "provider") {
      clearSecrets();
      setView((old) => ({
        ...old,
        provider: value,
        saved: false,
        error: null,
        action: old.current?.settings?.provider === value && old.current.settings.credentialConfigured ? "keep" : value === "local-yolo" ? "clear" : "replace"
      }));
    } else {
      if (name === "action") clearSecrets();
      setView((old) => ({ ...old, [name]: value, saved: false, error: null }));
    }
  }
  async function save(event) {
    event.preventDefault();
    if (!available() || busy.current || view.pending || !view.ready || !view.current) return;
    const data = new FormData(form.current);
    const frequency = Number(view.frequency);
    const requestBudget = /^\d{1,6}$/.test(view.requestBudget) ? Number(view.requestBudget) : NaN;
    const printable = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && [...value].every((c) => c.charCodeAt(0) >= 33 && c.charCodeAt(0) <= 126);
    let credentials = { action: view.action };
    if (view.action === "replace")
      credentials = view.provider === "aliyun" ? {
        action: "replace",
        accessKeyId: data.get("accessKeyId"),
        accessKeySecret: data.get("accessKeySecret")
      } : { action: "replace", token: data.get("token") };
    if (![0.5, 1, 2].includes(frequency) || !Number.isSafeInteger(requestBudget) || requestBudget < 1 || requestBudget > 1e5 || view.provider === "local-yolo" && !view.baseUrl.trim() || view.action === "keep" && (view.current.settings?.provider !== view.provider || !view.current.settings.credentialConfigured) || view.action === "replace" && (view.provider === "aliyun" ? !printable(credentials.accessKeyId, 256) || !printable(credentials.accessKeySecret, 256) : !printable(credentials.token, 4096))) {
      clearSecrets();
      setView((old) => ({ ...old, saved: false, error: "invalid" }));
      return;
    }
    const input2 = {
      sessionId,
      expectedBindingRevision: binding.bindingRevision,
      expectedConfigRevision: view.current.configRevision,
      settings: {
        provider: view.provider,
        frequency,
        requestBudget,
        credentials,
        ...view.provider === "local-yolo" ? { baseUrl: view.baseUrl.trim() } : {}
      }
    };
    for (const key of ["accessKeyId", "accessKeySecret", "token"]) data.delete(key);
    clearSecrets();
    busy.current = true;
    const revision = ++epoch.current;
    setView((old) => ({ ...old, pending: true, saved: false, error: null }));
    try {
      if (!ctx.agnes.device?.saveRecognition) throw new Error("Unavailable");
      const result = checked(await ctx.agnes.device.saveRecognition(input2), binding);
      if (!available() || epoch.current !== revision) return;
      if (!result.settings || result.settings.provider !== input2.settings.provider || result.configRevision < input2.expectedConfigRevision || result.settings.frequency !== frequency || result.settings.requestBudget !== requestBudget)
        throw new Error("Changed settings");
      onSaved?.(result);
      setView((old) => ({
        ...old,
        current: result,
        ready: true,
        pending: false,
        saved: true,
        action: result.settings.credentialConfigured ? "keep" : "clear",
        baseUrl: result.settings.baseUrl ?? ""
      }));
    } catch {
      if (available() && epoch.current === revision)
        setView((old) => ({ ...old, ready: false, pending: false, saved: false, error: "saveFailure" }));
    } finally {
      busy.current = false;
      for (const key of Object.keys(credentials)) if (key !== "action") credentials[key] = "";
    }
  }
  const canKeep = view.current?.settings?.provider === view.provider && view.current.settings.credentialConfigured;
  const disabled = !view.ready || view.pending || !available();
  const label = (name, text, child) => h5("label", { htmlFor: `${id}-${name}` }, t(text), child);
  const select = (name, items) => h5(
    "select",
    {
      id: `${id}-${name}`,
      name,
      value: view[name],
      disabled,
      onChange: (e) => edit(name, e.currentTarget.value)
    },
    ...items.map(([value, text]) => h5("option", { key: value, value }, t(text)))
  );
  const input = (name, text, extra = {}) => label(
    name,
    text,
    h5("input", {
      id: `${id}-${name}`,
      name,
      disabled,
      "aria-describedby": `${id}-hint${view.error ? ` ${id}-error` : ""}`,
      "aria-invalid": view.error === "invalid",
      ...extra
    })
  );
  return h5(
    "dialog",
    {
      ref: dialog,
      className: "aka-recognition-dialog",
      "aria-labelledby": `${id}-title`,
      onCancel: (e) => {
        e.preventDefault();
        dismiss();
      }
    },
    h5("h3", { id: `${id}-title` }, t("title")),
    h5("p", { id: `${id}-hint` }, t("hint")),
    view.pending && h5("p", { role: "status" }, t("pending")),
    view.error && h5("p", { id: `${id}-error`, role: "alert" }, t(view.error)),
    view.current?.settings && h5(
      "div",
      { className: "aka-saved-state", role: "status" },
      h5("strong", null, t(view.saved ? "saved" : "configured")),
      h5(
        "span",
        null,
        `${t(view.current.settings.provider === "aliyun" ? "cloud" : "local")} \xB7 ${view.current.settings.frequency} Hz \xB7 ${view.current.settings.requestBudget}`
      )
    ),
    h5(
      "form",
      { ref: form, onSubmit: save, "aria-busy": view.pending },
      label(
        "provider",
        "provider",
        select("provider", [
          ["aliyun", "cloud"],
          ["local-yolo", "local"]
        ])
      ),
      h5("p", null, t(view.provider === "aliyun" ? "cloudHint" : "localHint")),
      view.provider === "aliyun" && h5(
        "details",
        { className: "aka-advanced" },
        h5("summary", null, "DetectObject \xB7 cn-shanghai"),
        h5("dt", null, t("endpoint")),
        h5("dd", null, "objectdet.cn-shanghai.aliyuncs.com"),
        h5("dt", null, t("region")),
        h5("dd", null, "cn-shanghai"),
        h5("dt", null, t("apiVersion")),
        h5("dd", null, "2019-12-30 / DetectObject")
      ),
      label(
        "frequency",
        "frequency",
        select("frequency", [
          ["0.5", "halfHz"],
          ["1", "oneHz"],
          ["2", "twoHz"]
        ])
      ),
      input("requestBudget", "budget", {
        value: view.requestBudget,
        inputMode: "numeric",
        maxLength: 6,
        onChange: (e) => edit("requestBudget", e.currentTarget.value)
      }),
      view.provider === "local-yolo" && input("baseUrl", "baseUrl", {
        value: view.baseUrl,
        maxLength: 2048,
        autoComplete: "off",
        onChange: (e) => edit("baseUrl", e.currentTarget.value)
      }),
      label(
        "action",
        "credentials",
        select("action", [
          ...canKeep ? [["keep", "keep"]] : [],
          ["replace", "replace"],
          ...view.provider === "local-yolo" ? [["clear", "noToken"]] : []
        ])
      ),
      view.action === "replace" && (view.provider === "aliyun" ? h5(
        "div",
        null,
        input("accessKeyId", "accessKeyId", {
          type: "password",
          autoComplete: "new-password",
          maxLength: 256
        }),
        input("accessKeySecret", "accessKeySecret", {
          type: "password",
          autoComplete: "new-password",
          maxLength: 256
        })
      ) : input("token", "token", { type: "password", autoComplete: "new-password", maxLength: 4096 })),
      h5("button", { type: "submit", className: "aka-primary", disabled }, t("save"))
    ),
    h5(
      "div",
      { className: "aka-device-actions" },
      h5(
        "button",
        { type: "button", disabled: view.pending || !available(), onClick: () => void load() },
        t("refresh")
      ),
      h5("button", { type: "button", onClick: dismiss }, t("close"))
    )
  );
}

// client/recognition-control.js
var positive = (v) => Number.isSafeInteger(v) && v > 0;
function round(value, binding) {
  if (value === null) return null;
  if (!value || Object.keys(value).sort().join(",") !== "budget,deviceId,reserved,roundRevision" || value.deviceId !== binding.deviceId || !positive(value.roundRevision) || !positive(value.budget) || value.budget > 1e5 || !Number.isSafeInteger(value.reserved) || value.reserved < 0 || value.reserved > value.budget)
    throw new Error("Invalid round");
  return Object.freeze({ ...value });
}
function checkedResult(value, binding, input) {
  if (value?.outcome === "not-started" && Object.keys(value).sort().join(",") === "bindingRevision,configRevision,deviceId,outcome,recognitionRevision,roundRevision" && value.deviceId === binding.deviceId && ["bindingRevision", "configRevision", "recognitionRevision", "roundRevision"].every(
    (key) => positive(value[key]) && value[key] === input[key]
  ))
    return null;
  if (!value || Object.keys(value).sort().join(",") !== "ageAtSelectionMs,artifact,bindingRevision,configRevision,detections,deviceId,elapsedMs,eventSeq,frameId,height,id,providerRequestId,roundRevision,selectedAt,sha256,timeBasis,width" || value.deviceId !== binding.deviceId || value.bindingRevision !== input.bindingRevision || value.configRevision !== input.recognitionRevision || value.roundRevision !== input.roundRevision || !positive(value.eventSeq) || value.timeBasis !== "bridge_receive" || typeof value.selectedAt !== "string" || value.selectedAt.length > 64 || !Number.isFinite(Date.parse(value.selectedAt)) || !Number.isFinite(value.ageAtSelectionMs) || value.ageAtSelectionMs < 0 || value.ageAtSelectionMs > 1e3 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) || typeof value.frameId !== "string" || !value.frameId || value.frameId.length > 512 || typeof value.providerRequestId !== "string" || !value.providerRequestId || value.providerRequestId.length > 512 || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || !positive(value.width) || value.width < 21 || value.width > 4095 || !positive(value.height) || value.height < 21 || value.height > 4095 || !/^[a-f0-9]{64}$/.test(value.sha256) || !value.artifact || Object.keys(value.artifact).sort().join(",") !== "mime,sha256,size" || value.artifact.sha256 !== value.sha256 || value.artifact.mime !== "image/jpeg" || !positive(value.artifact.size) || value.artifact.size > 2.5 * 1024 * 1024 || !Array.isArray(value.detections) || value.detections.length > 1e3 || value.detections.some(
    (d) => !d || Object.keys(d).sort().join(",") !== "box,confidence,label" || typeof d.label !== "string" || !d.label || d.label.length > 256 || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 || !Array.isArray(d.box) || d.box.length !== 4 || !d.box.every(Number.isFinite) || d.box[0] < 0 || d.box[1] < 0 || d.box[2] > value.width || d.box[3] > value.height || d.box[2] <= d.box[0] || d.box[3] <= d.box[1]
  ))
    throw new Error("Invalid recognition result");
  return Object.freeze({
    ...value,
    artifact: Object.freeze({ ...value.artifact }),
    receivedAt: (/* @__PURE__ */ new Date()).toISOString(),
    detections: Object.freeze(
      value.detections.map((d) => Object.freeze({ ...d, box: Object.freeze([...d.box]) }))
    )
  });
}
function RecognitionResult({ ctx, sessionId, result, binding, connectionRevision }) {
  const [distances, setDistances] = useState5(null);
  useEffect5(() => {
    let active = true;
    setDistances(null);
    if (binding && connectionRevision)
      void ctx.agnes.services.call("aka.geometry.estimate", {
        bindingRevision: binding.bindingRevision,
        configRevision: connectionRevision,
        resultId: result.id
      }).then(
        (value) => {
          if (active && value?.resultId === result.id && Array.isArray(value.estimates))
            setDistances(value.estimates);
        },
        () => {
        }
      );
    return () => {
      active = false;
    };
  }, [ctx, binding, connectionRevision, result.id]);
  const [attempt, setAttempt] = useState5(0);
  const [view, setView] = useState5(null);
  const t = (key) => ctx.locale.t(`aka.recognition.control.${key}`);
  useEffect5(() => {
    const controller = new AbortController();
    let resource, active = true;
    const release = () => {
      const previous = resource;
      resource = void 0;
      previous?.release();
    };
    setView(null);
    const off = ctx.session.subscribe(() => {
      active = false;
      controller.abort();
      release();
      setView(null);
    });
    void ctx.resources.images.load({ laneId: "main", artifact: result.artifact, signal: controller.signal }).then(
      (loaded) => {
        if (!active || controller.signal.aborted || ctx.session.sessionId !== sessionId) {
          loaded.release();
          return;
        }
        resource = loaded;
        setView({ result, attempt, resource });
      },
      () => {
        if (active) setView({ result, attempt, error: true });
      }
    );
    return () => {
      active = false;
      controller.abort();
      off?.();
      release();
    };
  }, [ctx, sessionId, result, attempt]);
  const current = view?.result === result && view?.attempt === attempt ? view : null;
  return h6(
    "figure",
    { className: "aka-recognition-result" },
    h6("figcaption", null, t("result")),
    current?.resource ? h6(
      "div",
      { className: "aka-recognition-image" },
      h6("img", {
        src: current.resource.url,
        width: result.width,
        height: result.height,
        alt: t("alt"),
        onError: () => setView({ result, attempt, error: true }),
        onLoad: (e) => {
          if (e.currentTarget.naturalWidth !== result.width || e.currentTarget.naturalHeight !== result.height)
            setView({ result, attempt, error: true });
        }
      }),
      h6(
        "svg",
        { viewBox: `0 0 ${result.width} ${result.height}`, "aria-hidden": true },
        result.detections.map(
          (d, i) => h6("rect", {
            key: i,
            x: d.box[0],
            y: d.box[1],
            width: d.box[2] - d.box[0],
            height: d.box[3] - d.box[1]
          })
        )
      )
    ) : h6(
      "p",
      { role: current?.error ? "alert" : "status" },
      t(current?.error ? "imageError" : "imageLoading")
    ),
    current?.error && h6("button", { type: "button", onClick: () => setAttempt((v) => v + 1) }, t("readImage")),
    h6(
      "details",
      { className: "aka-advanced aka-result-meta" },
      h6("summary", null, t("details")),
      h6("p", null, t("historical")),
      h6("p", null, `${t("selected")} ${result.selectedAt}`),
      h6("p", null, `${t("received")} ${result.receivedAt}`)
    ),
    result.detections.length ? h6(
      "ol",
      null,
      result.detections.map(
        (d, i) => h6(
          "li",
          { key: i },
          `${d.label} \xB7 ${(d.confidence * 100).toFixed(1)}%`,
          d.confidence < 0.6 && h6("span", null, ` \xB7 ${t("lowConfidence")}`),
          h6(
            "p",
            null,
            distances?.[i]?.state === "estimated" && Number.isFinite(distances[i].groundDistance) && Number.isFinite(distances[i].observedErrorMeters) ? `${t("distance")}: ${(distances[i].groundDistance * 100).toFixed(1)} cm \xB7 ${t("observedError")} ${(distances[i].observedErrorMeters * 100).toFixed(1)} cm` : t("distanceUnknown")
          )
        )
      )
    ) : h6("p", null, t("empty"))
  );
}
function RecognitionControl({
  ctx,
  sessionId,
  binding,
  configRevision,
  enabled,
  settingsVersion = 0
}) {
  const reasonId = useId4();
  const [continuous, setContinuous] = useState5(false);
  const running = useRef5(false);
  const resumeRecognition = useRef5(false);
  const [view, setView] = useState5({ phase: "idle", settings: null, round: void 0, result: null });
  const effectiveBudget = view.round && view.settings?.settings ? Math.min(view.round.budget, view.settings.settings.requestBudget) : 0;
  const scope = `${sessionId}:${binding.deviceId}:${binding.bindingRevision}:${configRevision}:${settingsVersion}`;
  const observed = useRef5(scope);
  const epoch = useRef5(0), mounted = useRef5(false), busy = useRef5(false), uncertain = useRef5(false), restorePending = useRef5(false), original = useRef5(null);
  const t = (key) => ctx.locale.t(`aka.recognition.control.${key}`);
  const available = useCallback3(
    () => binding.active && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected",
    [binding.active, ctx, sessionId]
  );
  useEffect5(() => {
    observed.current = scope;
    mounted.current = true;
    const invalidate = () => {
      running.current = false;
      resumeRecognition.current = false;
      setContinuous(false);
      epoch.current++;
      setView((v) => ({
        ...v,
        result: null,
        settings: null,
        round: void 0,
        phase: busy.current || uncertain.current ? "unknown" : "idle"
      }));
      if (busy.current) uncertain.current = true;
    };
    invalidate();
    try {
      original.current = ctx.commands.pendingEffect("aka.recognition.test");
      restorePending.current = !!original.current;
      if (original.current) {
        uncertain.current = true;
        setView((v) => ({ ...v, phase: "unknown" }));
      }
    } catch {
      original.current = null;
      uncertain.current = true;
      setView((v) => ({ ...v, phase: "unknown" }));
    }
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    return () => {
      mounted.current = false;
      running.current = false;
      epoch.current++;
      for (const stop of off) stop?.();
    };
  }, [ctx, scope]);
  const run = useCallback3(
    async (action, automatic = false) => {
      if (automatic && !running.current) return;
      if (!available() || busy.current || uncertain.current && !["read", "recover"].includes(action)) return;
      if (action === "recover" && !original.current) return;
      if (action === "test" && (!enabled || !view.round || view.round.reserved >= effectiveBudget)) return;
      if (action === "start" && (!view.settings || view.round === void 0)) return;
      busy.current = true;
      const generation = epoch.current;
      const current = () => mounted.current && epoch.current === generation && observed.current === scope && available();
      setView((v) => ({
        ...v,
        phase: "pending",
        ...action === "test" && !automatic ? { result: null } : {}
      }));
      let submitted = false;
      try {
        if (action === "recover") {
          const input = ctx.commands.pendingEffect("aka.recognition.test");
          if (!input) throw new Error("Original identity unavailable");
          const result = checkedResult(
            await ctx.commands.execute("aka.recognition.test", input),
            binding,
            input
          );
          if (!current()) return;
          ctx.commands.completeEffect("aka.recognition.test", input);
          original.current = null;
          uncertain.current = false;
          setView((v) => ({ ...v, round: void 0, result, phase: result ? "ready" : "notStarted" }));
          if (resumeRecognition.current && enabled) {
            running.current = true;
            setContinuous(true);
            setView((v) => ({ ...v, phase: "ready" }));
          }
          return;
        }
        const settings = checked(await ctx.agnes.device.recognition(sessionId), binding);
        if (!current()) return;
        const expected = {
          expectedBindingRevision: binding.bindingRevision,
          expectedConfigRevision: settings.configRevision
        };
        let activeRound = view.round;
        if (action === "enable" || action === "sample") {
          if (!enabled || settings.settings?.provider !== "aliyun") {
            setView((v) => ({ ...v, settings }));
            throw new Error("Configure recognition first");
          }
          activeRound = round(await ctx.commands.execute("aka.recognition.round.read", expected), binding);
          if (!current()) return;
          if (!activeRound || activeRound.reserved >= Math.min(activeRound.budget, settings.settings.requestBudget)) {
            const input = {
              ...expected,
              expectedRoundRevision: activeRound?.roundRevision ?? 0,
              startId: crypto.randomUUID()
            };
            submitted = true;
            activeRound = round(await ctx.commands.execute("aka.recognition.round.start", input), binding);
            if (!activeRound || activeRound.roundRevision !== input.expectedRoundRevision + 1)
              throw new Error("Invalid round");
            if (!current()) return;
          }
          if (action === "enable") {
            setView((v) => ({ ...v, settings, round: activeRound, phase: "ready" }));
            running.current = true;
            resumeRecognition.current = true;
            setContinuous(true);
            return;
          }
        }
        if (action === "read") {
          const value = round(await ctx.commands.execute("aka.recognition.round.read", expected), binding);
          if (current())
            setView((v) => ({ ...v, settings, round: value, phase: uncertain.current ? "unknown" : "ready" }));
          return;
        }
        if (settings.settings?.provider !== "aliyun" || action !== "sample" && settings.configRevision !== view.settings?.configRevision)
          throw new Error("Configuration changed");
        if (action === "start") {
          const input = Object.freeze({
            ...expected,
            expectedRoundRevision: view.round?.roundRevision ?? 0,
            startId: crypto.randomUUID()
          });
          submitted = true;
          const value = round(await ctx.commands.execute("aka.recognition.round.start", input), binding);
          if (!value || value.roundRevision !== input.expectedRoundRevision + 1)
            throw new Error("Invalid round");
          if (!current()) return;
          setView((v) => ({ ...v, settings, round: value, phase: "ready" }));
        } else {
          if (activeRound.reserved >= Math.min(activeRound.budget, settings.settings.requestBudget))
            throw new Error("Budget exhausted");
          const input = Object.freeze({
            bindingRevision: binding.bindingRevision,
            configRevision,
            recognitionRevision: settings.configRevision,
            roundRevision: activeRound.roundRevision
          });
          if (automatic && !running.current) {
            setView((v) => ({ ...v, phase: "ready" }));
            return;
          }
          submitted = true;
          const result = checkedResult(
            await ctx.commands.execute("aka.recognition.test", input),
            binding,
            input
          );
          if (!current()) return;
          ctx.commands.completeEffect("aka.recognition.test", input);
          original.current = null;
          setView((v) => ({ ...v, settings, round: void 0, result, phase: "ready" }));
        }
      } catch {
        running.current = false;
        setContinuous(false);
        if (submitted) uncertain.current = true;
        try {
          original.current = ctx.commands.pendingEffect("aka.recognition.test");
          if (automatic && original.current) restorePending.current = true;
        } catch {
          original.current = null;
          uncertain.current = true;
        }
        if (current()) setView((v) => ({ ...v, phase: submitted || uncertain.current ? "unknown" : "error" }));
      } finally {
        busy.current = false;
        if (mounted.current) {
          try {
            original.current = ctx.commands.pendingEffect("aka.recognition.test");
          } catch {
            original.current = null;
            uncertain.current = true;
            setView((v) => ({ ...v, phase: "unknown" }));
          }
        }
        if (mounted.current && epoch.current !== generation)
          setView((v) => ({ ...v, phase: uncertain.current ? "unknown" : "idle" }));
      }
    },
    [
      available,
      binding,
      configRevision,
      ctx,
      effectiveBudget,
      enabled,
      scope,
      sessionId,
      view.round,
      view.settings
    ]
  );
  useEffect5(() => {
    if (!restorePending.current || view.phase !== "unknown" || !available() || busy.current) return;
    restorePending.current = false;
    void run("recover");
  }, [available, run, view.phase]);
  useEffect5(() => {
    if (!continuous) return;
    if (!enabled || !available() || document.visibilityState === "hidden" || uncertain.current) {
      running.current = false;
      setContinuous(false);
      return;
    }
    if (busy.current) return;
    if (view.round === null || view.round && view.round.reserved >= effectiveBudget) {
      running.current = false;
      setContinuous(false);
      return;
    }
    if (view.phase !== "ready") return;
    const timer = setTimeout(
      () => void run(view.round === void 0 ? "read" : "test", true),
      view.round === void 0 ? 0 : 1e3 / (view.settings?.settings?.frequency ?? 2)
    );
    return () => clearTimeout(timer);
  }, [continuous, available, effectiveBudget, enabled, run, view.phase, view.round, view.settings]);
  useEffect5(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        running.current = false;
        resumeRecognition.current = false;
        setContinuous(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  const pending = view.phase === "pending";
  const configured = view.settings?.settings?.provider === "aliyun";
  const reason = pending || uncertain.current ? null : !view.settings ? "readFirst" : !view.settings.settings ? "configureFirst" : !configured ? "localUnavailable" : view.round === void 0 ? "readFirst" : !view.round ? "startFirst" : view.round.reserved >= effectiveBudget ? "exhausted" : !enabled ? "cameraRequired" : null;
  return h6(
    "section",
    { className: "aka-recognition-control", "aria-label": t("title"), "aria-busy": pending },
    h6(
      "div",
      { className: "aka-recognition-toolbar" },
      h6(
        "label",
        { className: "aka-switch-field" },
        h6("span", null, t("title")),
        h6(
          "button",
          {
            type: "button",
            role: "switch",
            className: "aka-toggle",
            "aria-checked": continuous,
            disabled: !continuous && (!available() || !enabled || pending || uncertain.current || view.settings && !configured || view.round && view.round.reserved >= effectiveBudget),
            onClick: () => {
              if (continuous) {
                running.current = false;
                resumeRecognition.current = false;
                setContinuous(false);
                return;
              }
              if (configured && view.round && view.round.reserved < effectiveBudget) {
                running.current = true;
                resumeRecognition.current = true;
                setContinuous(true);
              } else void run("enable");
            }
          },
          h6("span", { "aria-hidden": true }),
          h6("span", { className: "aka-sr-only" }, t(continuous ? "continuousOff" : "continuousOn"))
        )
      ),
      h6(
        "button",
        {
          type: "button",
          disabled: !available() || !enabled || pending || continuous || uncertain.current || view.settings && !configured || view.round && view.round.reserved >= effectiveBudget,
          "aria-describedby": reason ? reasonId : void 0,
          onClick: () => void run(configured && view.round && view.round.reserved < effectiveBudget ? "test" : "sample")
        },
        t("test")
      )
    ),
    continuous && h6("p", { role: "status" }, t("continuousRunning")),
    h6(
      "details",
      { className: "aka-advanced aka-budget-details" },
      h6("summary", null, t("usage")),
      h6(
        "button",
        { type: "button", disabled: !available() || pending || continuous, onClick: () => void run("read") },
        t("read")
      ),
      h6(
        "button",
        {
          type: "button",
          disabled: !available() || pending || continuous || uncertain.current || !configured || view.round === void 0,
          onClick: () => void run("start")
        },
        t("start")
      )
    ),
    view.round && h6("p", null, `${t("usage")} ${view.round.reserved} / ${effectiveBudget}`),
    reason && view.settings && h6("p", { id: reasonId }, t(reason)),
    uncertain.current && original.current && h6(
      "button",
      {
        type: "button",
        disabled: !available() || pending,
        onClick: () => void run("recover")
      },
      t("recover")
    ),
    ["pending", "error", "unknown", "notStarted"].includes(view.phase) && h6("p", { role: ["error", "unknown"].includes(view.phase) ? "alert" : "status" }, t(view.phase)),
    view.result && available() && h6(RecognitionResult, {
      key: view.result.id,
      ctx,
      sessionId,
      result: view.result,
      binding,
      connectionRevision: configRevision
    })
  );
}

// client/robot-settings.js
import { createElement as h7, useCallback as useCallback4, useEffect as useEffect6, useId as useId5, useRef as useRef6, useState as useState6 } from "react";
function RobotSettings({ ctx, sessionId, binding, configRevision, kind, close }) {
  const id = useId5(), dialog = useRef6(null), busy = useRef6(false);
  const [view, setView] = useState6({ settings: null, pending: true, error: false, saved: false });
  const t = (key) => ctx.locale.t(`aka.robotSettings.${key}`);
  const title = ctx.locale.t(`aka.panel.${kind === "speed" ? "speedSettings" : "armSettings"}`);
  const current = useRef6(false);
  const input = { bindingRevision: binding.bindingRevision, configRevision };
  const checked2 = useCallback4(
    (value) => {
      if (value?.deviceId !== binding.deviceId || value.bindingRevision !== binding.bindingRevision || value.configRevision !== configRevision || !value.settings?.speed || !value.settings?.arm || !["zp10s", "sts3215"].includes(value.settings.arm.driver))
        throw new Error("Invalid settings");
      return value.settings;
    },
    [binding.deviceId, binding.bindingRevision, configRevision]
  );
  useEffect6(() => {
    current.current = true;
    dialog.current.showModal();
    const invalidate = () => {
      current.current = false;
      close();
    };
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    void ctx.commands.execute("aka.settings.read", { bindingRevision: binding.bindingRevision, configRevision }).then(
      (value) => {
        if (current.current)
          setView({ settings: checked2(value), pending: false, error: false, saved: false });
      },
      () => {
        if (current.current) setView({ settings: null, pending: false, error: true, saved: false });
      }
    ).catch(() => {
      if (current.current) setView({ settings: null, pending: false, error: true, saved: false });
    });
    return () => {
      current.current = false;
      for (const stop of off) stop?.();
      dialog.current?.close();
    };
  }, [ctx, binding.bindingRevision, configRevision, close, checked2]);
  const fields = view.settings ? kind === "speed" ? [
    ["speed.forward_speed", "\u524D\u8FDB\u901F\u5EA6 (%)", 100],
    ["speed.turn_speed", "\u8F6C\u5411\u901F\u5EA6 (%)", 100]
  ] : Object.entries(view.settings.arm.angles).flatMap(
    ([key, value]) => typeof value === "object" ? Object.keys(value).map((servo) => [
      `arm.angles.${key}.${servo}`,
      `${key} \xB7 ${servo}`,
      view.settings.arm.driver === "zp10s" ? 270 : 4095
    ]) : [[`arm.angles.${key}`, key, view.settings.arm.driver === "zp10s" ? 270 : 4095]]
  ) : [];
  const at = (object, path) => path.split(".").reduce((value, key) => value[key], object);
  const edit = (path, value) => {
    const settings = structuredClone(view.settings);
    const keys = path.split("."), key = keys.pop();
    at(settings, keys.join("."))[key] = value;
    setView({ ...view, settings, saved: false });
  };
  async function save(event) {
    event.preventDefault();
    if (busy.current || view.pending || !view.settings || !current.current || ctx.session.sessionId !== sessionId)
      return;
    if (fields.some(
      ([path, , max]) => !Number.isSafeInteger(at(view.settings, path)) || at(view.settings, path) < 0 || at(view.settings, path) > max
    ))
      return;
    busy.current = true;
    setView((v) => ({ ...v, pending: true, saved: false, error: false }));
    try {
      const settings = checked2(
        await ctx.commands.execute("aka.settings.save", { ...input, kind, settings: view.settings })
      );
      if (current.current) setView({ settings, pending: false, saved: true, error: false });
    } catch {
      if (current.current) setView((v) => ({ ...v, pending: false, error: true }));
    } finally {
      busy.current = false;
    }
  }
  return h7(
    "dialog",
    {
      ref: dialog,
      className: "aka-recognition-dialog",
      "aria-labelledby": id,
      onCancel: () => close(),
      onClose: () => close()
    },
    h7("h2", { id }, title),
    h7("p", null, t("hint")),
    kind === "arm" && view.settings && h7("p", null, t("unit") + (view.settings.arm.driver === "zp10s" ? "\u5EA6 (0\u2013270)" : "\u4F4D\u7F6E\u523B\u5EA6 (0\u20134095)")),
    h7(
      "form",
      { onSubmit: save },
      fields.map(
        ([path, label, max]) => h7(
          "label",
          { key: path },
          label,
          h7("input", {
            name: path,
            type: "number",
            min: 0,
            max,
            step: 1,
            required: true,
            disabled: view.pending,
            value: at(view.settings, path),
            onChange: (event) => edit(path, event.currentTarget.value === "" ? "" : Number(event.currentTarget.value))
          })
        )
      ),
      h7("button", { type: "submit", disabled: view.pending || !view.settings || view.error }, t("save"))
    ),
    view.pending && h7("p", { role: "status" }, t("loading")),
    view.saved && h7("p", { role: "status" }, t("saved")),
    view.error && h7("p", { role: "alert" }, t("error")),
    h7("button", { type: "button", onClick: close }, t("close"))
  );
}

// client/index.js
var commands = {
  probe: "aka.pair.probe",
  connect: "aka.pair.connect",
  disconnect: "aka.pair.disconnect",
  camera: "aka.pair.camera",
  capture: "aka.capture.photo"
};
function validEndpoint(ip, port) {
  if (typeof ip !== "string" || !Number.isSafeInteger(port) || port < 1 || port > 65535) return false;
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255))
    return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function AkaVideo({ ctx, sessionId, binding, configRevision, enabled }) {
  const canvas = useRef7(null);
  const [attempt, setAttempt] = useState7(0);
  const [phase, setPhase] = useState7("videoIdle");
  const [failure, setFailure] = useState7(null);
  const t = (key) => ctx.locale.t(`aka.panel.${key}`);
  const playbackId = `${binding.deviceId}:${binding.bindingRevision}:${configRevision}:${attempt}`;
  const playback = useRef7(playbackId);
  playback.current = playbackId;
  useEffect7(() => {
    if (!enabled || !canvas.current) return;
    let active = true;
    const valid = () => active && playback.current === playbackId && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected";
    const stop = createMediaPlayer({
      origin: window.location.origin,
      rowId: ctx.module.rowId,
      sessionId,
      deviceId: binding.deviceId,
      configRevision,
      bindingRevision: binding.bindingRevision,
      ticket: (input) => ctx.agnes.services.call("aka.media.ticket", input),
      valid,
      canvas: canvas.current,
      state: (value) => {
        if (active) {
          if (value !== "videoError") setFailure(null);
          setPhase(value);
        }
      },
      error: (value) => {
        if (active) setFailure(value);
      }
    });
    const invalidate = () => {
      active = false;
      stop();
      setPhase("videoIdle");
    };
    const off = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnecting", invalidate)
    ];
    return () => {
      active = false;
      stop();
      for (const release of off) release?.();
    };
  }, [ctx, sessionId, binding.deviceId, binding.bindingRevision, configRevision, enabled, playbackId]);
  return h8(
    "div",
    { className: "aka-live-video" },
    h8("canvas", { ref: canvas, role: "img", "aria-label": t("videoAlt"), hidden: phase !== "videoLive" }),
    phase !== "videoLive" && h8(
      "div",
      { className: "aka-video-placeholder", role: "status" },
      h8("span", { className: "aka-video-mark", "aria-hidden": true }, "CAM"),
      h8("strong", null, t(enabled ? phase : "cameraIdle")),
      h8("span", null, t(enabled && phase === "videoError" && failure ? failure : "previewHint"))
    ),
    h8(
      "div",
      { className: "aka-video-caption" },
      h8("span", null, "LIVE CAMERA"),
      h8("span", null, phase === "videoLive" ? t("videoLive") : t("videoIdle"))
    ),
    enabled && phase === "videoError" && h8(
      "button",
      {
        type: "button",
        onClick: () => {
          setAttempt((value) => value + 1);
        }
      },
      t("startVideo")
    )
  );
}
function AkaDevicePanel({ ctx, sessionId, binding, prepareConnection, connectionConfigured }) {
  const prefix = useId6();
  const canPrepare = typeof prepareConnection === "function";
  const [groundOpen, setGroundOpen] = useState7(false);
  const closeGround = useCallback5(() => setGroundOpen(false), []);
  const [settingsOpen, setSettingsOpen] = useState7(null);
  const closeSettings = useCallback5(() => setSettingsOpen(null), []);
  const [recognitionOpen, setRecognitionOpen] = useState7(false);
  const [recognitionVersion, setRecognitionVersion] = useState7(0);
  const [connectionOpen, setConnectionOpen] = useState7(false);
  const recognitionSaved = useCallback5(() => setRecognitionVersion((value) => value + 1), []);
  const receiveStatus = useCallback5(
    (status) => setView((old) => old.profile?.configRevision === status.configRevision ? { ...old, status } : old),
    []
  );
  const closeRecognition = useCallback5(() => setRecognitionOpen(false), []);
  useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale);
  const t = (key) => ctx.locale.t(`aka.panel.${key}`);
  const [view, setView] = useState7({
    ready: false,
    phase: "loading",
    ip: "",
    port: "80",
    profile: null,
    status: null,
    probe: null,
    error: null
  });
  const generation = useRef7(0);
  const mounted = useRef7(false);
  const busy = useRef7(false);
  const available = useCallback5(
    () => mounted.current && ctx.session.sessionId === sessionId && ctx.agnes.connectionState === "connected",
    [ctx, sessionId]
  );
  const current = useCallback5((epoch) => available() && generation.current === epoch, [available]);
  const identityMatches = useCallback5(
    (result) => result && result.deviceId === binding.deviceId && result.bindingRevision === binding.bindingRevision,
    [binding.deviceId, binding.bindingRevision]
  );
  const load = useCallback5(async () => {
    if (!available()) return;
    if (!binding.active) {
      generation.current++;
      setView({
        ready: canPrepare,
        phase: "idle",
        ip: "",
        port: "80",
        profile: null,
        status: null,
        probe: null,
        error: null
      });
      return;
    }
    if (busy.current) return;
    const epoch = ++generation.current;
    setView((old) => ({ ...old, phase: "loading", probe: null, error: null }));
    try {
      if (!ctx.agnes.device?.connection) throw new Error("Configuration unavailable");
      const result = await ctx.agnes.device.connection(sessionId);
      if (!current(epoch)) return;
      if (!identityMatches(result)) throw new Error("Configuration changed");
      const status = result.profile ? await ctx.agnes.services.call("aka.status", {}) : null;
      if (!current(epoch)) return;
      if (result.profile && (status?.deviceId !== binding.deviceId || status.enrollment !== "active" || status.configRevision !== result.profile.configRevision))
        throw new Error("Configuration changed");
      setView({
        ready: true,
        phase: "idle",
        profile: result.profile,
        status,
        probe: null,
        error: null,
        ip: result.profile?.ip ?? "",
        port: String(result.profile?.port ?? 80)
      });
    } catch {
      if (current(epoch)) setView((old) => ({ ...old, ready: false, phase: "idle", error: "failure" }));
    }
  }, [available, current, ctx, identityMatches, sessionId, binding.deviceId, binding.active, canPrepare]);
  useEffect7(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
      setView((old) => ({
        ...old,
        ready: false,
        phase: "idle",
        profile: ctx.session.sessionId === sessionId ? old.profile : null,
        status: null,
        probe: null,
        error: "unavailable"
      }));
    };
    const stops = [
      ctx.session.subscribe(invalidate),
      ctx.agnes.on("reconnecting", invalidate),
      ctx.agnes.on("closed", invalidate),
      ctx.agnes.on("reconnected", () => {
        invalidate();
        if (!busy.current) void load();
      })
    ];
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      for (const stop of stops) stop?.();
    };
  }, [ctx, load, sessionId]);
  function edit(field2, value) {
    if (!available() || busy.current && view.phase !== "probe") return;
    generation.current++;
    setView((old) => ({ ...old, [field2]: value, probe: null, error: null }));
  }
  async function run(action) {
    if (!available() || busy.current || !view.ready) return;
    const ip = view.ip.trim();
    const port = /^\d{1,5}$/.test(view.port) ? Number(view.port) : NaN;
    if (["probe", "save", "pair"].includes(action) && !validEndpoint(ip, port)) {
      setView((old) => ({ ...old, error: "invalid", probe: null }));
      return;
    }
    let profile = view.profile;
    let operationBinding = binding;
    if (!binding.active && action !== "pair") return;
    if (!["probe", "save", "pair"].includes(action) && !profile) return;
    if (action === "save" && !view.probe) return;
    const epoch = generation.current;
    busy.current = true;
    setView((old) => ({ ...old, phase: action, error: null }));
    try {
      if (!binding.active) {
        operationBinding = await prepareConnection();
        if (!current(epoch)) return;
        if (!operationBinding?.active || operationBinding.sessionId !== sessionId || operationBinding.workspaceId !== binding.workspaceId)
          throw new Error("Connection preparation changed");
        const saved = await ctx.agnes.device.connection(sessionId);
        if (!current(epoch)) return;
        if (saved?.deviceId !== operationBinding.deviceId || saved.bindingRevision !== operationBinding.bindingRevision)
          throw new Error("Connection configuration changed");
        profile = saved.profile;
      }
      const matchesOperation = (result2) => result2?.deviceId === operationBinding.deviceId && result2.bindingRevision === operationBinding.bindingRevision;
      let result;
      if (action === "probe" || action === "pair") {
        const expectedConfigRevision = profile?.configRevision ?? 0;
        result = await ctx.commands.execute(commands.probe, {
          ip,
          port,
          bindingRevision: operationBinding.bindingRevision,
          expectedConfigRevision
        });
        if (!current(epoch)) return;
        if (!matchesOperation(result) || result.ip !== ip || result.port !== port || result.expectedConfigRevision !== expectedConfigRevision || result.identity !== "reported" || typeof result.macAddress !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(result.macAddress))
          throw new Error("Invalid probe");
        setView((old) => ({ ...old, probe: Object.freeze({ ...result }) }));
        if (action === "pair") {
          const savedResult = await ctx.agnes.device.saveConnection({
            sessionId,
            expectedBindingRevision: operationBinding.bindingRevision,
            expectedConfigRevision,
            ip,
            port,
            macAddress: result.macAddress
          });
          if (!current(epoch)) return;
          const saved = savedResult?.profile;
          if (!matchesOperation(savedResult) || saved?.driver !== "aka-00" || saved.ip !== ip || saved.port !== port || saved.macAddress !== result.macAddress || ![expectedConfigRevision, expectedConfigRevision + 1].includes(saved.configRevision))
            throw new Error("Invalid save result");
          if (binding.active) {
            setView((old) => ({ ...old, profile: saved, status: null, probe: null }));
            setConnectionOpen(false);
          }
          await ctx.commands.execute(commands.connect, { configRevision: saved.configRevision });
          if (!current(epoch)) return;
          await ctx.commands.execute(commands.camera, { configRevision: saved.configRevision, open: true });
          if (!current(epoch)) return;
          const status = await ctx.agnes.services.call("aka.status", {});
          if (!current(epoch)) return;
          if (status?.deviceId !== operationBinding.deviceId || status.enrollment !== "active" || status.configRevision !== saved.configRevision)
            throw new Error("Device state changed");
          setView((old) => ({ ...old, status }));
          if (!binding.active) connectionConfigured?.();
        }
      } else if (action === "save") {
        const probe = view.probe;
        if (probe.ip !== ip || probe.port !== port || !identityMatches(probe))
          throw new Error("Probe changed");
        result = await ctx.agnes.device.saveConnection({
          sessionId,
          expectedBindingRevision: binding.bindingRevision,
          expectedConfigRevision: probe.expectedConfigRevision,
          ip,
          port,
          macAddress: probe.macAddress
        });
        if (!current(epoch)) return;
        const saved = result?.profile;
        if (!identityMatches(result) || saved?.driver !== "aka-00" || saved.ip !== ip || saved.port !== port || saved.macAddress !== probe.macAddress || ![probe.expectedConfigRevision, probe.expectedConfigRevision + 1].includes(saved.configRevision))
          throw new Error("Invalid save result");
        setView((old) => ({ ...old, profile: saved, status: null, probe: null }));
      } else {
        const input = { configRevision: profile.configRevision };
        if (action === "camera-open" || action === "camera-close") input.open = action === "camera-open";
        await ctx.commands.execute(
          action.startsWith("camera-") ? commands.camera : commands[action === "recover" ? "connect" : action],
          input
        );
        if (!current(epoch)) return;
        if (action === "recover") {
          await ctx.commands.execute(commands.camera, { configRevision: profile.configRevision, open: true });
          if (!current(epoch)) return;
        }
        const status = await ctx.agnes.services.call("aka.status", {});
        if (!current(epoch)) return;
        if (status?.deviceId !== binding.deviceId || status.enrollment !== "active" || status.configRevision !== profile.configRevision)
          throw new Error("Device state changed");
        setView((old) => ({ ...old, status, probe: null }));
      }
    } catch {
      if (current(epoch))
        setView((old) => ({
          ...old,
          probe: null,
          error: "failure"
        }));
    } finally {
      busy.current = false;
      if (available()) setView((old) => ({ ...old, phase: "idle" }));
    }
  }
  const pending = view.phase !== "idle";
  const enabled = available() && view.ready && !pending;
  const runtime = view.status?.runtime;
  const connected = runtime?.connection === "connected";
  const connectionLabel = {
    idle: "notConnected",
    connecting: "connecting",
    connected: "connected",
    degraded: "degraded",
    disposed: "disposed"
  };
  const errorId = `${prefix}-error`;
  const field = (name, label, value, extra = {}) => h8(
    "label",
    { htmlFor: `${prefix}-${name}` },
    t(label),
    h8("input", {
      id: `${prefix}-${name}`,
      name,
      value,
      required: true,
      disabled: !view.ready || pending && view.phase !== "probe",
      "aria-describedby": view.error ? errorId : `${prefix}-hint`,
      "aria-invalid": view.error === "invalid",
      onChange: (event) => edit(name, event.currentTarget.value),
      ...extra
    })
  );
  const button = (label, action, disabled = !enabled) => h8("button", { type: "button", disabled, onClick: () => void run(action) }, t(label));
  const connectionForm = h8(
    "div",
    { className: "aka-connection-card" },
    h8("span", { className: "aka-eyebrow" }, "DEVICE CONNECTION"),
    h8("h3", { id: `${prefix}-title` }, t("newConnection")),
    h8("p", { id: `${prefix}-hint` }, t("connectionHint")),
    h8(
      "form",
      {
        onSubmit: (event) => {
          event.preventDefault();
          void run("pair");
        }
      },
      field("ip", "ip", view.ip, {
        placeholder: "192.168.43.232",
        inputMode: "decimal",
        autoComplete: "off",
        maxLength: 15
      }),
      field("port", "port", view.port, { inputMode: "numeric", autoComplete: "off", maxLength: 5 }),
      h8(
        "button",
        { type: "submit", className: "aka-primary", disabled: !enabled },
        t(pending ? "pending" : "pair")
      )
    ),
    h8(
      "details",
      { className: "aka-advanced" },
      h8("summary", null, t("connectionAdvanced")),
      binding.active && button("probe", "probe"),
      h8(
        "button",
        { type: "button", disabled: pending || !available(), onClick: () => void load() },
        t("refresh")
      ),
      view.probe && h8(
        "div",
        { className: "aka-pairing-confirmation" },
        h8("p", null, `${t("identity")}: ${view.probe.macAddress}`),
        button("save", "save")
      )
    ),
    view.profile && h8("button", { type: "button", onClick: () => setConnectionOpen(false) }, t("backConsole"))
  );
  return h8(
    "section",
    {
      className: `aka-device-panel ${binding.active && view.profile && !connectionOpen ? "aka-console" : "aka-onboarding"}`,
      "aria-label": t("title"),
      "aria-busy": pending
    },
    view.error && h8("p", { id: errorId, className: "aka-notice", role: "alert" }, t(view.error)),
    pending && h8(
      "p",
      { role: "status", className: "aka-progress" },
      t(view.phase === "loading" ? "loading" : "pending")
    ),
    !binding.active || !view.profile || connectionOpen ? connectionForm : h8(
      "div",
      { className: "aka-console-body" },
      h8(
        "header",
        { className: "aka-console-header" },
        h8(
          "div",
          null,
          h8("span", { className: "aka-eyebrow" }, "ROBOT CONSOLE"),
          h8("h3", { id: `${prefix}-title` }, `${view.profile.ip}:${view.profile.port}`)
        ),
        h8(
          "div",
          { className: "aka-console-header-actions" },
          h8(
            "span",
            { className: `aka-connection-status ${connected ? "is-connected" : ""}` },
            t(connectionLabel[runtime?.connection] ?? "notConnected")
          ),
          (!connected || runtime?.media === "error") && button("recover", "recover", !enabled),
          h8(
            "button",
            { type: "button", disabled: !available(), onClick: () => setRecognitionOpen(true) },
            ctx.locale.t("aka.recognition.title")
          )
        )
      ),
      h8(AkaVideo, {
        key: `${view.profile.configRevision}:${runtime?.mediaGeneration ?? 0}`,
        ctx,
        sessionId,
        binding,
        configRevision: view.profile.configRevision,
        enabled: connected && ["opening", "streaming"].includes(runtime?.media)
      }),
      h8(
        "div",
        { className: "aka-camera-toolbar" },
        h8(
          "label",
          { className: "aka-switch-field" },
          h8("span", null, t("camera")),
          h8(
            "button",
            {
              type: "button",
              className: "aka-toggle",
              role: "switch",
              "aria-label": t("camera"),
              "aria-checked": connected && ["opening", "streaming"].includes(runtime?.media),
              disabled: !enabled || !connected,
              onClick: () => void run(
                ["opening", "streaming"].includes(runtime?.media) ? "camera-close" : "camera-open"
              )
            },
            h8("span", { "aria-hidden": true })
          )
        ),
        h8(CaptureControl, {
          key: `capture:${sessionId}:${binding.deviceId}:${binding.bindingRevision}`,
          ctx,
          sessionId,
          binding,
          configRevision: view.profile.configRevision,
          enabled: enabled && connected && runtime?.media === "streaming"
        })
      ),
      h8(RecognitionControl, {
        key: `recognition:${sessionId}:${binding.deviceId}:${binding.bindingRevision}`,
        ctx,
        sessionId,
        binding,
        configRevision: view.profile.configRevision,
        settingsVersion: recognitionVersion,
        enabled: connected && runtime?.media === "streaming"
      }),
      h8(
        "div",
        { className: "aka-control-tools" },
        h8("strong", null, t("controls")),
        h8(
          "div",
          { className: "aka-device-actions" },
          h8(
            "button",
            { type: "button", disabled: !connected || pending, onClick: () => setSettingsOpen("speed") },
            t("speedSettings")
          ),
          h8(
            "button",
            { type: "button", disabled: !connected || pending, onClick: () => setSettingsOpen("arm") },
            t("armSettings")
          ),
          h8(
            "button",
            {
              type: "button",
              disabled: !connected || !runtime?.frame || pending,
              onClick: () => setGroundOpen(true)
            },
            ctx.locale.t("aka.ground.title")
          )
        )
      ),
      h8(ManualControl, {
        key: `manual:${sessionId}:${binding.deviceId}:${binding.bindingRevision}:${view.profile.configRevision}`,
        ctx,
        sessionId,
        binding,
        configRevision: view.profile.configRevision,
        enabled: view.ready,
        onStatus: receiveStatus
      }),
      h8(
        "details",
        { className: "aka-advanced" },
        h8("summary", null, t("connectionDetails")),
        h8(
          "p",
          { className: "aka-saved-state" },
          `${t("saved")}: ${view.profile.ip}:${view.profile.port}`
        ),
        h8(
          "div",
          { className: "aka-device-actions" },
          button("connect", "connect", !enabled || connected),
          button("disconnect", "disconnect", !enabled || !connected),
          button(
            "openCamera",
            "camera-open",
            !enabled || !connected || ["opening", "streaming"].includes(runtime?.media)
          ),
          button("closeCamera", "camera-close", !enabled || !connected || runtime?.cameraOn === false),
          h8(
            "button",
            { type: "button", disabled: pending, onClick: () => setConnectionOpen(true) },
            t("editConnection")
          ),
          h8(
            "button",
            { type: "button", disabled: pending || !available(), onClick: () => void load() },
            t("refresh")
          )
        )
      )
    ),
    recognitionOpen && h8(RecognitionSettings, { ctx, sessionId, binding, close: closeRecognition, onSaved: recognitionSaved }),
    groundOpen && view.profile && runtime?.frame && h8(GroundSettings, {
      ctx,
      sessionId,
      binding,
      configRevision: view.profile.configRevision,
      frame: runtime.frame,
      close: closeGround
    }),
    settingsOpen && view.profile && h8(RobotSettings, {
      ctx,
      sessionId,
      binding,
      configRevision: view.profile.configRevision,
      kind: settingsOpen,
      close: closeSettings
    })
  );
}
function apply(ctx) {
  const off = ctx.locale.register("@agnes-examples/aka-robot-plugin", catalog);
  ctx.effect(() => off);
  for (const [action, service] of [
    ["probe", "aka.probe"],
    ["connect", "aka.connect"],
    ["disconnect", "aka.disconnect"],
    ["camera", "aka.camera.set"],
    ["capture", "aka.capture"]
  ])
    ctx.commands.registerEffect({
      id: commands[action],
      service,
      ...action === "capture" ? { retainOperation: true, persistCapture: true } : {}
    });
  for (const service of [
    "aka.control.action",
    "aka.control.stop",
    "aka.settings.read",
    "aka.settings.save",
    "aka.task.cancel",
    "aka.geometry.save",
    "aka.modeling.settings.save"
  ])
    ctx.commands.registerEffect({ id: service, service });
  for (const service of ["aka.recognition.round.read", "aka.recognition.round.start", "aka.recognition.test"])
    ctx.commands.registerEffect({
      id: service,
      service,
      retainOperation: service !== "aka.recognition.round.read",
      ...service === "aka.recognition.test" ? { persistCapture: true } : {}
    });
  ctx.slots.register(
    { name: "workbench.device", id: "aka-device", priority: 10 },
    (props) => h8(AkaDevicePanel, { ...props, ctx })
  );
}
export {
  AkaDevicePanel,
  apply
};
