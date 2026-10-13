// Which run directories are still referenced by the written record?
// A mention counts only when the run id stands alone: "kuson-clean" does NOT
// count as a reference to "kuson", and "mesh-probe-mismatch3b" does not count
// as a reference to "mesh-probe-mismatch3".
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/agnes-harness'
const RUNS = ROOT + '/.agnes/agh-ortho/runs'
const roots = [ROOT + '/agh-ortho', ROOT + '/.agnes/work']

const runs = fs
  .readdirSync(RUNS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const SKIP_DIRS = new Set(['runs', 'node_modules', '.git', '.agnes', '__pycache__'])
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + '/' + e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, out)
    } else if (/\.(md|json|mjs|ps1|py|txt|log|yml)$/i.test(e.name)) out.push(p)
  }
  return out
}

const files = []
for (const r of roots) if (fs.existsSync(r)) walk(r, files)
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.md')) files.push(ROOT + '/' + e.name)
}

const text = new Map()
for (const f of files) {
  try {
    text.set(f, fs.readFileSync(f, 'utf8'))
  } catch {}
}

const keep = []
const drop = []
for (const r of runs) {
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?<![\\w-])' + esc + '(?![\\w-])')
  const hits = []
  for (const [f, t] of text) if (re.test(t)) hits.push(f.slice(ROOT.length + 1))
  ;(hits.length ? keep : drop).push({ r, hits })
}

console.log('RUNS ON DISK: ' + runs.length)
console.log('\n== REFERENCED (keep, they are the record) ==')
for (const k of keep)
  console.log(
    '  ' +
      k.r.padEnd(26) +
      ' <- ' +
      k.hits.slice(0, 2).join(', ') +
      (k.hits.length > 2 ? ` (+${k.hits.length - 2})` : ''),
  )
console.log('\n== UNREFERENCED (candidates to delete) ==')
for (const d of drop) console.log('  ' + d.r)
console.log('\ncounts: keep=' + keep.length + ' drop=' + drop.length)
console.log('\nDROP LIST (json):')
console.log(JSON.stringify(drop.map((d) => d.r)))
