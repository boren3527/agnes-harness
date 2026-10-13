// Verify the live retention plan against the real runs directory, using the plugin's own
// run.mjs (listRuns/planRetention) plus the pinning filter from index.mjs. The claim to
// check: with 21 pinned runs and maxRuns 20, nothing is left to propose.
import { readdirSync, readFileSync } from 'node:fs'
import { listRuns, planRetention } from '../../agh-ortho/package/extensions/main/run.mjs'

const fsSeam = {
  async list(path) {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? 'dir' : 'file',
    }))
  },
  async read(path) {
    return readFileSync(path)
  },
}
const pinned = JSON.parse(readFileSync('.agnes/agh-ortho/retention.json', 'utf8')).pinned
const runs = await listRuns(fsSeam)
const plan = planRetention(runs, { currentRunId: null })
const pinnedKept = plan.wouldPrune.filter((r) => pinned.includes(r.runId)).map((r) => r.runId)
const wouldPrune = plan.wouldPrune.filter((r) => !pinned.includes(r.runId)).map((r) => r.runId)
console.log(
  JSON.stringify(
    {
      runs_on_disk: runs.length,
      kept_by_policy: plan.kept,
      raw_would_prune: plan.wouldPrune.map((r) => ({ id: r.runId, why: r.reasons })),
      pinned_kept: pinnedKept,
      would_prune_after_pinning: wouldPrune,
      pinned_not_on_disk: pinned.filter((p) => !runs.some((r) => r.runId === p)),
    },
    null,
    1,
  ),
)
