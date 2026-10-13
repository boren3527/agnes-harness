// Final audit of a delivered run: read the pack from disk and check it against itself
// and against the files it points at. Nothing here trusts the session's prose.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'

const R = process.argv[2] ?? 'D:/agnes-harness/.agnes/agh-ortho/runs/police1/'
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

console.log('== files in ' + R)
for (const f of readdirSync(R).sort()) {
  const s = statSync(R + f)
  if (s.isFile())
    console.log('  ' + f.padEnd(18) + String(s.size).padStart(9) + '  ' + sha(R + f).slice(0, 16))
}
const j = JSON.parse(readFileSync(R + 'report.json', 'utf8'))
const v = JSON.parse(readFileSync(R + 'verify.json', 'utf8'))
console.log('\n== report.json')
console.log('  ok=' + j.ok + '  blockers=' + JSON.stringify(j.blockers) + '  tier=' + j.tier)
console.log('  scene_file=' + JSON.stringify(j.scene_file))
console.log('  artifacts=' + (j.artifacts ?? []).length)
for (const a of j.artifacts ?? []) {
  const isOwn = String(a.path ?? '').startsWith('D:\\agnes-harness\\.agnes\\agh-ortho\\runs\\')
  console.log(
    '    ' +
      (isOwn ? 'own ' : 'EXT ') +
      String(a.kind).padEnd(14) +
      String(a.bytes).padStart(9) +
      '  ' +
      String(a.sha256).slice(0, 16) +
      '  ' +
      a.path,
  )
}

console.log('\n== 那张被认证的渲染图：包里有没有它的身份？')
const blob = JSON.stringify(j) + JSON.stringify(v)
console.log('  report/verify 里提到 police1-front.png: ' + /police1-front\.png/.test(blob))
console.log('  silhouette 段的键: ' + JSON.stringify(Object.keys(j.checks?.silhouette ?? {})))
console.log('  其中 compared: ' + JSON.stringify(j.checks?.silhouette?.compared))
console.log('  verify.json 顶层键: ' + JSON.stringify(Object.keys(v)))

console.log('\n== 盘上那张渲染图')
const p = 'D:/agnes-harness/outputs/police1-front.png'
const s = statSync(p)
console.log('  ' + sha(p) + '  ' + s.size + ' B  mtime=' + s.mtime.toISOString())

console.log('\n== 包内文件与盘中外部产物对照')
for (const f of ['mesh_file', 'scene_file', 'image_file']) {
  const path = j[f] ?? v[f]
  if (!path) continue
  try {
    console.log('  ' + f + ': ' + sha(path).slice(0, 16) + '  ' + path)
  } catch (e) {
    console.log('  ' + f + ': MISSING ' + path)
  }
}
