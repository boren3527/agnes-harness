# agh-blender

Drive a **local Blender** from [Agnes Harness](https://github.com/AgnesAI-Labs/agnes-harness):
open it, build geometry through a whitelisted opcode protocol, render the viewport, checkpoint the
work and export a copy — all from a normal chat message.

Repeated `agh_blender_start` calls now authenticate and reuse the live managed instance
in that workspace instead of launching another window. `empty:true` applies only to a
new launch; reuse preserves the existing document. Give each generated subject, camera
and light a unique name. A failed live-instance handshake is refused rather than starting
another process. Plugin reload still loses the private token as described below.

Tools return `isError:true` for unsuccessful reports. Operation results distinguish
`completed`, `partial` and `unknown`; inspect the scene and the journal before deciding
what remains to be done, and never replay a whole partially applied batch. Operations
may wait up to 29 seconds within the calling tool's limit, instead of the old fixed
five-second network cutoff. This is a bounded wait, not a render-speed guarantee.

Export verifies the staging path, byte count and digest **before** writing the destination,
and refuses permission/stat errors when absence cannot be established. The Host file
port does not provide exclusive-create semantics: concurrent external writers to the
same destination cannot be protected by the preceding stat check. Use a unique path
for each export (the AKA recording workflow uses a fresh run UUID). Export remains a
copy of the **whole managed scene**, not an isolated selected object. A saved file or a
successful operation receipt does not prove resemblance to a source photograph: return
the actual image with `agh_blender_capture`, compare it, then refine using the catalog.

The point of this package is that **nothing arbitrary ever runs**. There is no "execute this Python"
tool: the plugin can only ask Blender to perform operations that are declared in a fixed table, with
typed arguments and hard limits.

---

## What it looks like

```
you: "build a 3-head-tall figure, dark brown hair, red plaid shirt"

  agh_blender_ops_catalog   → what may be called, with argument schemas
  agh_blender_start         → starts Blender itself (no add-on, no setup)
  agh_blender_apply_ops     → the whitelisted opcodes, applied in order, on Blender's main thread
  agh_blender_scene         → read the result back
  agh_blender_capture       → verified PNG artifact returned to the model and saved on disk
  agh_blender_open          → open an existing .blend (a dirty scene is refused)
  agh_blender_export        → deliver a standalone .blend (never overwrites)
```

You watch the model appear in **your own Blender viewport** while it is being built.

---

## Requirements

| | |
|---|---|
| Agnes Harness | a build whose tool schema validation uses TypeBox (both `toolArgumentError` and `TOL_ARGS_INVALID` present) |
| Blender | **4.2 or newer**, installed normally. Verified on 5.2.2 LTS (Windows) |
| Blender add-ons | **none.** This package never installs anything into Blender |

## Install

```sh
# from a checkout of this repository
agh install file:./path/to/agh-blender --profile <your-profile>
# answer y at the confirmation prompt (the CLI refuses to install without a TTY — that refusal is
# deliberate: an unanswered prompt is never read as consent)
agh package trust  agh-blender <integrity> <capabilityHash> --profile <your-profile>
agh package enable agh-blender --profile <your-profile>
```

`integrity` and `capabilityHash` are printed by the install and are also recorded in
`<data-dir>/daemon/package-operations/operations.json`. Then open the web UI and ask for something.

---

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `agh_blender_start` | effect | discovers `blender.exe`, launches it confined, exchanges a loopback token; **asks for approval** |
| `agh_blender_probe` | read | is the managed instance still alive? |
| `agh_blender_stop` | effect | graceful shutdown through the bridge; a dirty scene is refused unless `force` |
| `agh_blender_open` | effect | open an existing `.blend` (same dirty-scene guard); **asks for approval** |
| `agh_blender_ops_catalog` | read | the full opcode contract: argument names, types, ranges, examples, limits, refusal codes |
| `agh_blender_apply_ops` | effect | apply a batch; **asks for approval**; the whole batch shares one undo step |
| `agh_blender_scene` | read | objects, materials, transforms, known ops |
| `agh_blender_capture` | read | offscreen viewport render → verified PNG on disk and a model-readable image artifact |
| `agh_blender_export` | effect | stage a standalone copy in Blender, deliver it with the host's own file write; **asks for approval** |

The op table covers modelling (`mesh.primitive_add`, `object.transform`, `object.duplicate`,
`object.delete`, `material.set`, `material.assign`, `object.join`), import (`mesh.import`),
modifiers, lights and cameras (`modifier.add`, `light.add`, `camera.add`, `object.look_at`),
cleanup (`data.purge_unused`) and durability (`file.checkpoint`, `file.stage_export`). It grows as
the whitelist grows: `agh_blender_ops_catalog` is the authoritative list, **no document is.**

## How it works

**Launch chain.** The plugin spawns

```
blender.exe --factory-startup --disable-autoexec --python-exit-code 1 \
    --python <snapshot>/bridge/bootstrap.py -- --agh-bridge-config <instanceDir>/bootstrap.json
```

through the host's sandbox seam, with the per-instance token passed **only** in the environment.
`--factory-startup` means the user's preferences are never read or written. The bridge binds
`127.0.0.1` on a free port, writes the chosen port into the instance directory, and runs every
request on Blender's main thread through `bpy.app.timers`.

Startup registers an instance only after `/health` succeeds, a token-free `/hello` is refused,
and the authenticated handshake returns HTTP 200 with `ok: true`. If startup fails or is cancelled after launch,
the plugin requests termination of that newly launched process and writes `start-report.json`;
it does not leave an `instance.json` that downstream tools could mistake for a ready instance.

**Opcode protocol.** The bridge holds the only authoritative table of operations. A request is
validated against a small declarative schema before anything runs, and an unknown name is refused
(`E_UNKNOWN_OP`) — the caller cannot name a Python symbol. A batch stops at the first refusal and
reports what already ran, so a partial build is never presented as a complete one.

## Safety model — what cannot happen

- **No arbitrary code execution.** No `eval`, no `getattr` by name, no `exec.python`; the ability to
  name arbitrary Python was removed deliberately.
- **Existing destinations are refused.** `file.checkpoint` refuses an existing label;
  `agh_blender_export` checks for an existing destination. Same-path concurrent writes
  are not covered by an atomic creation gate; see the limitation above.
- **No silent partial success.** A refused op changes nothing, and the refusal carries a code.
- **No user-preference mutation.** `--factory-startup` throughout, and the bridge never calls
  `save_userpref()`.

Reported honestly rather than hidden: on this machine the sandbox reports
`enforcement = { level: "partial", scope: ["file"] }`. That is not OS-level isolation, and the tool
reports the level it actually got instead of claiming confinement it does not have.

## Limitations (measured, not guessed)

- **Capture requires current AGH image-result support.** The tool declares `returnsImages` and
  publishes the verified PNG through the call-scoped artifact port. The Host checks its recorded
  tool call before admitting the image to the model. Older runtimes without this port are refused;
  a file path alone is not reported as a model-visible screenshot. Use an image-capable chat model.
- **Reloading the plugin orphans a running Blender.** The token lives only in daemon memory, so after
  a reload the instance can be neither driven nor stopped gracefully. Close the window by hand.
- **Parametric low-poly only.** Heads, bodies, props, buildings — proportions and primitives. Single
  image to photoreal mesh is a different technology and is out of scope.
- **`file.checkpoint` is not a pure read.** It remaps the live session's `image.filepath` values as a
  side effect of saving with `relative_remap=True`.

## Repository layout

```
package.json                     plugin + client descriptor declaration
LICENSE                          Apache-2.0, for everything outside bridge/ below
LICENSE-GPL                      GPL-3.0, for bridge/ below
NOTICE                           which directory carries which licence, and why
extensions/main/index.mjs        the AGH-side plugin: tools, sandbox-aware launch, artifact seam
extensions/main/bridge/          the Blender-side bridge (stdlib only, no third-party imports)
    HEADER.txt                   machine-readable copy of the GPL notice for this directory
    bootstrap.py                 config, port, token, main-thread queue, HTTP routes
    agh_ops.py                   the opcode whitelist: schema, limits, refusals, execution
    agh_capture.py               offscreen viewport render + standard-library PNG encoder
extensions/main/client/index.js  the panel (managed instance status)
extensions/main/helpers/         PowerShell probes for token-less stop (Apache-2.0)
    ps_identity.ps1              image name + creation time, so a reused pid cannot be mistaken
    ps_close.ps1                 asks a window to close; never force-kills
```

The authoritative design spec and the evidence ledger are deliberately **not** shipped in this
package. They live outside it, in the `blender-workbench-spec/` directory of the development
workspace. The reason is mechanical: `docs/` used to sit inside the package, and the package
manager hashes the whole tree, so **every documentation edit changed `integrity`** and forced a
full `disable → remove → install → trust → enable` cycle before anything could run again. Keeping
the docs outside removes that coupling; the package now only contains code and licence texts.

If you are reading this from a redistributed copy and need the design rationale, ask the
maintainer for the spec directory rather than expecting it here.

## License — two notices, one package

**The package-level SPDX id is `Apache-2.0`** (`package.json` → `"license"`). AGH's package
manager only admits a fixed allowlist of licences (MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, MPL-2.0, Unlicense — no GPL variant is in it), so a GPL value in that
field means the package can never be trusted or enabled. That field is therefore Apache-2.0.

**`extensions/main/bridge/` is `GPL-3.0-or-later`**, and it is not covered by the field above.
Those three Python scripts run inside Blender and call Blender's Python API (`bpy`) —
`bootstrap.py` 17 references, `agh_ops.py` 42, `agh_capture.py` 3; all three `import bpy`.
Blender's own licence page states that such scripts, if published, must be shared under a
GPL-compliant licence (<https://www.blender.org/about/license/>).

So: Apache-2.0 for `index.mjs`, `client/index.js`, `agnes.client.json` and the `helpers/`
PowerShell probes; GPL-3.0-or-later for everything under `extensions/main/bridge/`. Full texts
are in `LICENSE` and `LICENSE-GPL`; `NOTICE` and `bridge/HEADER.txt` say the same thing next to
the files. If you redistribute this package, keep both texts and this split intact.

> This is a conservative handling of "the scripts call Blender's Python API", not legal advice.
> The package imports no third-party GPL project; that scan shows no direct dependency, not the
> absence of any line-level derivation.

For final presentation call agh_blender_capture with camera:<existing scene camera name>. It renders the actual materials and lighting, restores scene render settings, verifies PNG bytes and publishes an image artifact directly in the AGH conversation. The default without camera remains a viewport image for geometry inspection. mesh.revolve_profile creates hollow cup walls from a closed section; mesh.sweep_tube creates curved handles from a centreline and radius.
Long bridge jobs (render, export, open and operation batches) wait up to 95 seconds, bounded by the calling tool deadline; health checks keep their short timeout. Both explicit and implicit profile closure are accepted, while intersecting profiles are refused before scene mutation. Published previews must contain PNG header and end chunks as well as matching bytes and digest.
The Host sends its request budget to the bridge. Operations that expire while queued are cancelled and cannot mutate the scene later. An operation already executing cannot safely be interrupted; a timeout reports an unknown outcome, so inspect the scene and journal before continuing and never resend the batch automatically. Reloading the plugin does not upgrade an already running Blender bridge; save/export and close the old managed instance before starting a new one.
Swept tube handles weld the coincident end-cap seams produced by Blender curve conversion. This keeps the caps connected to the side surface; the native regression checks both cup-body and handle manifold connectivity and nonzero volume, as well as camera rendering and export. It does not guarantee that arbitrary self-intersecting control paths are printable solids.

For visible progress, capture after the initial geometry is built and again after materials/lighting and visual review. AGH presents returned image artifacts directly; the newest image remains outside the collapsed process, and earlier captures stay in the process history. Do not invent Markdown image URLs from artifact:// or local filesystem paths.
