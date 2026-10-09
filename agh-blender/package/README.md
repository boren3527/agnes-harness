# agh-blender

Drive a **local Blender** from [Agnes Harness](https://github.com/AgnesAI-Labs/agnes-harness):
open it, build geometry through a whitelisted opcode protocol, render the viewport, checkpoint the
work and export a copy — all from a normal chat message.

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
  agh_blender_capture       → offscreen render of the viewport to a PNG on disk
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
| `agh_blender_capture` | read | offscreen viewport render → PNG on disk (**does not inline the image**, see Limitations) |
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

**Opcode protocol.** The bridge holds the only authoritative table of operations. A request is
validated against a small declarative schema before anything runs, and an unknown name is refused
(`E_UNKNOWN_OP`) — the caller cannot name a Python symbol. A batch stops at the first refusal and
reports what already ran, so a partial build is never presented as a complete one.

## Safety model — what cannot happen

- **No arbitrary code execution.** No `eval`, no `getattr` by name, no `exec.python`; the ability to
  name arbitrary Python was removed deliberately.
- **No overwrite.** `file.checkpoint` refuses an existing label; `agh_blender_export` refuses an
  existing destination **and** the host's own file write refuses it again.
- **No silent partial success.** A refused op changes nothing, and the refusal carries a code.
- **No user-preference mutation.** `--factory-startup` throughout, and the bridge never calls
  `save_userpref()`.

Reported honestly rather than hidden: on this machine the sandbox reports
`enforcement = { level: "partial", scope: ["file"] }`. That is not OS-level isolation, and the tool
reports the level it actually got instead of claiming confinement it does not have.

## Limitations (measured, not guessed)

- **An image produced by a tool cannot reach the model.** The request media surface only admits
  artifacts that came from the computer-use channel, so an image inside a tool result fails to read
  back and settles the turn as `E_STEP_FAILED` — permanently for that session. `agh_blender_capture`
  therefore writes the PNG and returns its path; the picture is for the human.
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
