# Working on Agnes Harness

Read [README.md](README.md), the [documentation](docs/README.md), and the relevant module before making changes. Development pull requests are currently limited to invited internal collaborators; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map

- `packages/`: protocol, Core, Host, daemon, clients, extensions and supporting libraries.
- `examples/`: runnable plugin examples and explicit test fixtures.
- `docs/`: user guides, extension tutorials, architecture and maintenance policies.
- `tools/`: generation, acceptance checks, documentation verification and repository guards.
- `third-party/`: dependency provenance; root `NOTICE` and package-local licenses cover attribution.

Use the [source map](docs/develop/source-map.md) to locate the owning module. Preserve package boundaries and consume declared exports. Protocol schemas and generators own generated types and reference documents.

## Workflow

1. Inspect Git status, the configured remotes and recent changes. Preserve other contributors' work; integrate remote changes without rewriting shared history.
2. For changes to public APIs, architecture, storage or security boundaries, describe the design and compatibility impact before implementation.
3. Keep changes focused. Update the affected guides, contracts and meaningful tests in the same change.
4. Run checks appropriate to the affected behavior. Report the commands, results, failures and untested environments accurately.
5. Review the final diff before committing. Commit, push and publish only within the user's or maintainer's authorization.

## Build and checks

Use the Node.js requirement and pinned pnpm version in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
pnpm typecheck
pnpm lint
pnpm gen:check
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/guards/src --maxWorkers=1
```

Run affected package tests from the repository root. `pnpm test` runs the fast tier, `pnpm test:heavy` runs the real-process and large-data tests (`*.e2e.test.ts`, `*.slow.test.ts`), and `pnpm test:all` runs both. Run a single file of either tier with `pnpm exec vitest run <file>`. A focused test command must actually execute matching tests. For a complete local runtime, follow the [installation guide](docs/guide/install.md).

## Tests

Keep the suite growing only where behavior grows.

- Prefer extending an existing test over adding a new one. For a bug fix, add the failing case to the nearest existing test (a new row in a parameterized table, or a stronger assertion) so it fails before the fix and passes after it. Add a new test or test file only for behavior no existing test covers.
- Test observable behavior at the module's contract: inputs, outputs, persisted state, emitted events and errors. Do not pin internal call counts, private helpers, incidental ordering or exact byte layouts unless that layout is itself the contract, such as a wire format, a prompt prefix or the ledger.
- Delete tests together with the code they cover. When a change makes a test redundant because its assertions are covered elsewhere, remove or merge it in the same change and name the covering test in the commit message.
- Choose the tier by file name. A test that starts real daemon, worker or CLI processes is `*.e2e.test.ts`; one that builds large ledgers or waits on real timers is `*.slow.test.ts`. Both run in the heavy tier; every other test file runs in the fast tier.

## Engineering boundaries

- Keep session facts and authorization decisions in their owning backend modules; clients render and request operations through supported interfaces.
- Maintain fail-closed behavior, lifecycle cleanup, cancellation and recovery semantics. Test refusal and failure paths when changing them.
- External UI libraries belong in `packages/web-ui`; other packages use its exports. Preserve the shared theme tokens, accessibility, CSP and public skin hooks.
- Keep guards meaningful. Update exact line budgets or fixture allowances only for reviewed changes; do not remove checks to hide a regression.
- Preserve third-party licenses, copyright notices and source attribution. Update dependency provenance when changing dependencies.
- Keep credentials, customer data, private traces, machine-specific configuration and internal project records out of the repository. Use isolated homes and synthetic accounts for tests.

Release requirements are in [release checks](docs/maintainers/release.md); document maintenance is described in [the maintenance guide](docs/maintainers/maintenance.md).

## Building a model from an image (agh-ortho + agh-blender)

When the user hands you an image and says "build a model", do NOT spend turns hunting for a
procedure and do NOT write a plan. The `build-model` skill may not be in your tool set - the six
steps below are enough. Keep messages short.

1. `agh_ortho_mesh_run { "name": "<new>", "image_file": "<path>" }` and approve it. Prefer a PATH:
   a pasted image costs minutes while its bytes are copied out of the session ledger. The name must
   be unused under `.agnes/agh-ortho/meshes/` (an existing one is refused, by design).
2. Get the photo reading from the CUT that step 1 produced - measure it, do not eyeball it:
   `node .agnes/work/alpha-bbox.mjs .agnes/agh-ortho/mesh-run/<name>/prep/<stem>_cut.png`
   take `aspect_px`, and make the interval that plus/minus 10%. It is a criterion: never adjust it
   after seeing a result.
3. `agh_ortho_fit` with the measured sizes (for `up_axis: "X"`: w = file Y, d = file Z, h = file X),
   `source.subject: "cutout"`, that interval in `photo_check.front`, and `image_file`.
4. `agh_ortho_save` with `run_id: "<name>-candidate"`; then the human looks at `sheet.svg`.
5. `agh_blender_start { "empty": true }` then `agh_blender_apply_ops` (the 2 ops) then, in ONE batch:
   `camera.add` (ORTHO, ortho_scale 1.2, location [0, -8, h/2]) + `object.look_at` (target [0,0,h/2])
   + `render.still` (transparent, path `outputs/<name>-front.png`); then `agh_ortho_fit` with
   `silhouette` (sha256 + bytes + camera, taken from the render's own reply) and `against_scene: true`.
6. `agh_blender_export`, then `agh_ortho_save` with a NEW run id (plus `human_review`). LEAVE BLENDER
   RUNNING afterwards; stop it only when the user asks.

Never cancel a step to hurry it - a cancel kills the step in flight and leaves nothing on disk.
Never tune a size or a tolerance to make a check pass: attribute the failure instead. No tier proves
shape - say so, and hand the sheet and the render to the user's eye.
