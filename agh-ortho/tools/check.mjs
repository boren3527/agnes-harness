#!/usr/bin/env node
/**
 * agh-ortho 自检。零依赖，不需要 Blender。
 *
 *   node agh-ortho/tools/check.mjs
 *
 * 覆盖三件事：
 *   1. 工具定义的结构合法（约束 A/B/J/K/L 的本地复刻：Kind 标记 / 8 键 meta / 尺寸上限）
 *   2. emit_ops / views / verify 的行为
 *   3. **负例**：把 lowering 改坏，numeric 残差必须非 0 —— 否则"残差为 0"没有意义
 *
 * 若能在工作区里找到 @sinclair/typebox 的副本，还会用内核真正用的 Value.Check 再验一遍
 * schema（只读它，不新增依赖）。找不到就明确跳过，不假装验过。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'package')
const repoRoot = join(here, '..', '..')

const { runtime } = await import(pathToFileURL(join(pkgDir, 'extensions', 'main', 'index.mjs')).href)
const geometry = await import(pathToFileURL(join(pkgDir, 'extensions', 'main', 'geometry.mjs')).href)
const viewsMod = await import(pathToFileURL(join(pkgDir, 'extensions', 'main', 'views.mjs')).href)

let failures = 0
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

// --- 收集工具定义（不依赖 extension 运行时）---
const tools = []
runtime.apply({
  extension: () => ({
    registerTool: (def) => {
      tools.push(def)
      return () => {}
    },
  }),
})

const TB_KIND = Symbol.for('TypeBox.Kind')
const TB_KINDS = { object: 'Object', array: 'Array', string: 'String', number: 'Number', integer: 'Integer', boolean: 'Boolean', null: 'Null' }
const META_KEYS = ['isReadOnly', 'isDestructive', 'isConcurrencySafe', 'isOpenWorld', 'replay', 'costHint', 'deferLoading', 'requiresApproval']

/** 约束 A 的本地复刻：逐个节点确认标记存在且与 type 相符。 */
function markerProblems(node, path = '$') {
  const problems = []
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return problems
  for (const branch of ['oneOf', 'allOf', 'not']) {
    if (node[branch] !== undefined) problems.push(`${path}.${branch}: not supported by this marker pass`)
  }
  if (node.type === 'object' && node.properties === undefined) problems.push(`${path}: object node without properties`)
  const kind = node[TB_KIND]
  if (node.type !== undefined) {
    const expected = TB_KINDS[node.type]
    if (expected === undefined) problems.push(`${path}.type: unknown "${node.type}"`)
    else if (kind !== expected) problems.push(`${path}: Kind ${String(kind)} !== ${expected}`)
  } else if (Array.isArray(node.anyOf)) {
    if (kind !== 'Union') problems.push(`${path}: union node must carry Kind "Union"`)
    for (const [i, branch] of node.anyOf.entries()) problems.push(...markerProblems(branch, `${path}.anyOf[${i}]`))
  } else {
    problems.push(`${path}: node without type and without anyOf`)
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) problems.push(...markerProblems(child, `${path}.${key}`))
  if (node.items !== undefined) problems.push(...markerProblems(node.items, `${path}.items`))
  return problems
}

const depthOf = (value, d = 0) => {
  if (value === null || typeof value !== 'object') return d
  const kids = Array.isArray(value) ? value : Object.values(value)
  return kids.reduce((m, k) => Math.max(m, depthOf(k, d + 1)), d)
}

// --- 1. 工具定义 ---
check('runtime registers 6 tools', tools.length === 6, tools.map((t) => t.name).join(', '))
for (const tool of tools) {
  const problems = [
    ...(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.name) ? [] : ['name pattern']),
    ...(typeof tool.description === 'string' && tool.description.length > 0 && tool.description.length <= 4096 ? [] : ['description']),
    ...(typeof tool.execute === 'function' ? [] : ['execute']),
    ...markerProblems(tool.parameters),
    ...META_KEYS.filter((k) => !Object.hasOwn(tool.meta ?? {}, k)).map((k) => `meta missing ${k}`),
    ...Object.keys(tool.meta?.costHint ?? {}).filter((k) => k !== 'credits' && k !== 'wallMs'),
    ...(tool.meta?.isReadOnly === true && tool.meta?.isDestructive === true ? ['contradictorySafetyFlags'] : []),
    ...(depthOf(tool.parameters) > 32 ? ['parameters too deep'] : []),
    ...(Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8') > 262144 ? ['parameters too large'] : []),
  ]
  check(`tool definition: ${tool.name}`, problems.length === 0, problems.join('; '))
}

// 工具的 description 就是**模型唯一必然读到的**东西（尤其冷启动：它不会去读 notes）。
// 所以"进来先做什么""哪一步不能跳过"必须写在里面，且**不能与现状矛盾** —— 两处都实测踩过。
const byNameDesc = Object.fromEntries(tools.map((t) => [t.name, t.description]))
check(
  'fit description teaches the cold-start essentials (photo_check, the anchor declaration, the candidate gate)',
  /photo_check/.test(byNameDesc.agh_ortho_fit) &&
    /w_over_h_min/.test(byNameDesc.agh_ortho_fit) &&
    /proportions_only/.test(byNameDesc.agh_ortho_fit) &&
    /-candidate/.test(byNameDesc.agh_ortho_fit) &&
    /另一个\**\s*run_id/.test(byNameDesc.agh_ortho_fit),
  byNameDesc.agh_ortho_fit.slice(0, 60),
)
// 下游 0.1.8 已经发布 dimensions ⇒ 描述里"验不了最终尺寸"就成了假话（实测：读回 20/20 断言了尺寸）。
check(
  'verify description matches reality: size IS assertable now, primitive kind is not',
  /能\**断言最终尺寸/.test(byNameDesc.agh_ortho_verify) && !/验不了\**最终尺寸/.test(byNameDesc.agh_ortho_verify),
  byNameDesc.agh_ortho_verify.slice(0, 60),
)

// --- 2. 可选：用内核真正用的校验 ---
let typeboxDir = null
for (const entry of existsSync(join(repoRoot, 'packages')) ? readdirSync(join(repoRoot, 'packages')) : []) {
  const candidate = join(repoRoot, 'packages', entry, 'node_modules', '@sinclair', 'typebox')
  if (existsSync(join(candidate, 'build', 'esm', 'value', 'index.mjs'))) {
    typeboxDir = candidate
    break
  }
}
if (typeboxDir) {
  const { Value } = await import(pathToFileURL(join(typeboxDir, 'build', 'esm', 'value', 'index.mjs')).href)
  const sample = { schema_version: '0.1', unit: 'm', projection: 'first_angle', assembly: [{ id: 'a', feature: 'box', w: { v: 1 }, d: { v: 1 }, h: { v: 1 } }] }
  check('typebox Value.Check accepts a minimal payload', Value.Check(tools[3].parameters, sample))
  check('typebox Value.Check rejects a bare-number leaf', !Value.Check(tools[3].parameters, { ...sample, assembly: [{ id: 'a', feature: 'box', w: 1 }] }))
  check('typebox Value.Check rejects an extra top-level key', !Value.Check(tools[3].parameters, { ...sample, oops: 1 }))
} else {
  console.log('SKIP  typebox Value.Check (no @sinclair/typebox copy found under packages/*/node_modules; structural marker check above still ran)')
}

// --- 3. 行为 ---
const SAMPLE = {
  schema_version: '0.1',
  unit: 'm',
  frame: { up: 'Z', front: '-Y', handed: 'right' },
  projection: 'first_angle',
  scale_anchor: { pixel_len: 340, real_len: 2.1, ref: 'door_height' },
  assumptions: ['manhattan_world'],
  assembly: [
    { id: 'site', feature: 'slab', w: { v: 60.0, conf: 0.4 }, d: { v: 40.0, conf: 0.4 }, z: { v: 0 } },
    { id: 'body', feature: 'box', w: { v: 12.4, conf: 0.9 }, d: { v: 8.6, conf: 0.65 }, h: { v: 9.3, conf: 0.71 }, at: { v: [0, 0, 4.65], conf: 0.85 } },
    { id: 'roof', feature: 'roof.gable', pitch: { v: 0.42 } },
  ],
  unresolved: ['屋面厚度'],
}
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const call = async (name, args) => (await byName[name].execute(args, {})).structured

const emission = await call('agh_ortho_emit_ops', SAMPLE)
check('emit_ops: ok with only slab+box lowered', emission.ok === true && emission.ops.length === 2, JSON.stringify(emission.blockers))
// 断言"它是**从快照推导**出来的"，而不是断言某个具体版本 —— 版本号会随下游重新测量而**合法变化**。
// 实测被抓到过：把 0.1.7 写死在断言里，快照更新成 0.1.8 后这条测试就红了（测试本身成了维护负担）。
const capFile = JSON.parse(readFileSync(join(pkgDir, 'extensions', 'main', 'agh.capability.json'), 'utf8'))
check('emit_ops: target_capability_set is derived from the snapshot, not hardcoded', emission.target_capability_set === `${capFile.target}:${capFile.capabilitySet}`, `${emission.target_capability_set} vs ${capFile.target}:${capFile.capabilitySet}`)
// M2 之后 "emitter_not_yet" 这个桶空了（五种意图都 lower 了），但**区分本身**必须留着：
// "下游做不到"（roof.gable）仍要与"我还没做"分开，否则 M3 扩下游时会误读。
check('emit_ops: unsupported reason codes stay separate (M2 emptied emitter_not_yet)',
  emission.unlowered.every((u) => u.reason_code !== 'not_implemented_in_m1') && emission.unlowered.some((u) => u.reason_code === 'no_downstream_op'),
  emission.unlowered.map((u) => `${u.feature}:${u.reason_code}`).join(' '))
check('emit_ops: unresolved reaches the caller', emission.unresolved[0] === '屋面厚度')

const rendered = await call('agh_ortho_views', SAMPLE)
check('views: 6 SVGs', rendered.svgs.length === 6 && rendered.svgs.every((s) => s.svg.startsWith('<svg') && s.svg.endsWith('</svg>')))
check('views: writes no files', rendered.delivered_as.includes('no files'))

const verified = await call('agh_ortho_verify', SAMPLE)
check('verify: residual is exactly 0', verified.ok === true && verified.residual_max === 0, JSON.stringify(verified.blockers))
check('verify: each axis cross-checked by 4 views', verified.rows.every((r) => r.observed_by.length === 4))

// --- 4. 负例 ---
const params = geometry.extentsFromParams(SAMPLE.assembly)
const good = [
  { op: 'mesh.primitive_add', args: { kind: 'plane', name: 'site', size: 1, scale: [60, 40, 1], location: [0, 0, 0] } },
  { op: 'mesh.primitive_add', args: { kind: 'cube', name: 'body', size: 1, scale: [12.4, 8.6, 9.3], location: [0, 0, 4.65] } },
]
const res = (ops) => viewsMod.residual(params, viewsMod.sixViewRects(geometry.boxesFromOps(ops)), geometry.boxesFromOps(ops)).max
check('baseline: real ops give residual 0', res(good) === 0)
check('negative: swapped extents are caught', res(good.map((o, i) => (i === 1 ? { ...o, args: { ...o.args, scale: [12.4, 9.3, 8.6] } } : o))) > 0)
check('negative: unapplied scale is caught', res(good.map((o, i) => (i === 1 ? { ...o, args: { ...o.args, scale: [1, 1, 1] } } : o))) > 0)
check('negative: shifted centre is caught', res(good.map((o, i) => (i === 1 ? { ...o, args: { ...o.args, location: [0.5, 0, 4.65] } } : o))) > 0)
check('negative: missing object is caught', res([good[1]]) > 0)

// --- 5. 无 at / 无 z 的方块按"底面落地"落位，且不破坏自洽 ---
const noAt = { ...SAMPLE, assembly: [{ id: 'plain', feature: 'box', w: { v: 2 }, d: { v: 3 }, h: { v: 4 } }] }
const noAtEmission = await call('agh_ortho_emit_ops', noAt)
check('box without at/z lands with its base on the ground', JSON.stringify(noAtEmission.ops[0].args.location) === '[0,0,2]', JSON.stringify(noAtEmission.ops[0].args.location))
check('and it is reported as an assumption, not hidden', noAtEmission.notes.some((n) => n.includes('base-on-ground')), noAtEmission.notes.join(' | '))
const noAtVerified = await call('agh_ortho_verify', noAt)
check('and the reduced model still verifies to 0', noAtVerified.ok === true && noAtVerified.residual_max === 0)

// --- 6. 单位与投影的拒绝必须带可操作提示 ---
const mm = await call('agh_ortho_emit_ops', { ...SAMPLE, unit: 'mm' })
check('mm is refused with an actionable hint', mm.ok === false && mm.blockers[0].message.includes('Divide by 1000'))
const badProjection = await call('agh_ortho_emit_ops', { ...SAMPLE, projection: 'second_angle' })
check('unknown projection is refused', badProjection.ok === false && badProjection.blockers.some((b) => b.code === 'E_PROJECTION_UNSET'))

// --- 7. 能力表快照与包同源 ---
const caps = JSON.parse(readFileSync(join(pkgDir, 'extensions', 'main', 'agh.capability.json'), 'utf8'))
check('capability snapshot names 6 primitives', caps.primitives.length === 6, caps.primitives.join(','))
check('capability snapshot records mutates per op (drives approval)', caps.ops.every((o) => typeof o.mutates === 'boolean' && typeof o.destructive === 'boolean'))

// --- 8. 描述符层 + agh_ortho_save（上游契约 §3/§4/§5/§9）---
const save = byName['agh_ortho_save']
check('save is the only mutating tool', save.meta.isReadOnly === false)
check('save is not destructive but always approved', save.meta.isDestructive === false && save.meta.requiresApproval === 'always')
check('save is not concurrency safe and never replays', save.meta.isConcurrencySafe === false && save.meta.replay === 'never')
check('every other tool stays read-only + safe + never-approved',
  tools.filter((t) => t.name !== 'agh_ortho_save').every((t) => t.meta.isReadOnly === true && t.meta.replay === 'safe' && t.meta.requiresApproval === 'never'))

/** 内存 fs，复刻宿主 fs.ts:223 的行为：write 会 mkdir 父目录（recursive）。 */
function memoryFs() {
  const files = new Map()
  const dirs = new Set()
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')
  return {
    files,
    dirs,
    async read(path) {
      const key = norm(path)
      if (!files.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
      return Buffer.from(files.get(key), 'utf8')
    },
    async write(path, data) {
      const key = norm(path)
      files.set(key, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
      const parts = key.split('/')
      parts.pop()
      for (let i = parts.length; i > 0; i -= 1) dirs.add(parts.slice(0, i).join('/'))
    },
    async list(path) {
      const key = norm(path).replace(/\/$/, '')
      if (!dirs.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
      const prefix = `${key}/`
      const names = new Set()
      for (const f of files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0])
      for (const d of dirs) if (d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0])
      return [...names].map((name) => ({ name, kind: files.has(prefix + name) ? 'file' : 'dir' }))
    },
    async stat(path) {
      const key = norm(path)
      if (files.has(key)) return { kind: 'file', size: files.get(key).length, mtimeMs: 0 }
      if (dirs.has(key)) return { kind: 'dir', size: 0, mtimeMs: 0 }
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
    },
  }
}

const { createHash } = await import('node:crypto')
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const ws = 'D:\\ws'
// Windows 路径归一化：描述符里是反斜杠的绝对路径，内存 fs 的键是正斜杠的相对路径。
const normWs = `${ws.replace(/\\/g, '/')}/`
const relKey = (absolutePath) => absolutePath.replace(/\\/g, '/').replace(normWs, '')
const fs1 = memoryFs()
const saved = (await save.execute(SAMPLE, { fs: fs1, session: { workspaceRoot: ws } })).structured

check('save writes a run and reports ok', saved.ok === true && saved.idempotent_replay === false, JSON.stringify(saved.blockers))
check('save returns 10 artifacts (the sheet + 6 views + 3 json)', saved.artifacts.length === 10 && saved.artifacts.some((a) => a.path.endsWith('sheet.svg')), saved.artifacts.map((a) => a.path.split('\\').pop()).join(','))

// 交付包里"验了什么"的结论必须落盘。没有这一块，一个 numeric 档的包里证据只有残差 ——
// 实测：kuson / kuson-candidate 的 report.json 里根本没有 anchor/photo_check/... 任何一个键。
const reportOnDisk = JSON.parse(fs1.files.get(`.agnes/agh-ortho/runs/${saved.run_id}/report.json`))
check(
  'report.json carries the cheap-tier verdicts, not just the residual',
  ['anchor', 'photo_check', 'overlaps', 'parts', 'placement', 'generated'].every((k) => reportOnDisk.checks?.[k] !== undefined) &&
    reportOnDisk.checks.photo_check.rows.length === 0 &&
    /no photo_check/.test(reportOnDisk.checks.photo_check.note) &&
    Array.isArray(reportOnDisk.checks.parts.taxonomy) &&
    reportOnDisk.checks.anchor.present === true &&
    reportOnDisk.checks.overlaps.listing_threshold === 0.5,
  Object.keys(reportOnDisk.checks ?? {}).join(','),
)
check('report.json says out loud that this pack has no model file', reportOnDisk.scene_file === null)

// `scene_file`：把下游导出的 .blend **登记**进包里（不复制），二进制必须按**字节**算。
const fsSceneReg = memoryFs()
const blendText = 'BLENDER-v1-角色-不是-ascii'
// 内存 fs 的键是**归一化后的绝对路径**（反斜杠 → 正斜杠），不是工作区相对路径。
fsSceneReg.files.set('D:/ws/outputs/kuson.blend', blendText)
const blendPath = 'D:\\ws\\outputs\\kuson.blend'
const sceneSaved = (await save.execute({ ...SAMPLE, run_id: 'scene-a', scene_file: blendPath }, { fs: fsSceneReg, session: { workspaceRoot: ws } })).structured
const external = sceneSaved.artifacts.find((a) => a.kind === 'scene')
check('scene_file is registered as an 11th artifact, last, and does not break the first-is-sheet rule', sceneSaved.artifacts.length === 11 && sceneSaved.artifacts[0].path.endsWith('sheet.svg') && sceneSaved.artifacts[10] === external, sceneSaved.artifacts.map((a) => a.kind).join(','))
check(
  'the external descriptor keeps its own path and binary-correct bytes/sha256 (not UTF-8 text arithmetic)',
  external?.path === blendPath &&
    external?.mime === 'application/x-blender' &&
    external?.bytes === Buffer.byteLength(blendText, 'utf8') &&
    external?.bytes !== blendText.length &&
    external?.sha256 === createHash('sha256').update(Buffer.from(blendText, 'utf8')).digest('hex'),
  `${external?.path} ${external?.bytes} ${external?.sha256?.slice(0, 8)}`,
)
check('the model file is registered, never copied into the run directory', ![...fsSceneReg.files.keys()].some((k) => k.includes('/runs/') && k.endsWith('.blend')))
check('report.json records which scene file this pack points at', JSON.parse(fsSceneReg.files.get('.agnes/agh-ortho/runs/scene-a/report.json')).scene_file?.path === blendPath)
const fsSceneMiss = memoryFs()
const missing = (await save.execute({ ...SAMPLE, run_id: 'scene-b', scene_file: 'D:\\ws\\outputs\\nope.blend' }, { fs: fsSceneMiss, session: { workspaceRoot: ws } })).structured
check('a scene_file that cannot be read is a blocker, not a silent absence', missing.blockers.some((b) => b.code === 'E_SCENE_FILE_UNREADABLE') && missing.artifacts.length === 10, JSON.stringify(missing.blockers.map((b) => b.code)))
check('marker.json and report.json are on disk', fs1.files.has(`.agnes/agh-ortho/runs/${saved.run_id}/marker.json`) && fs1.files.has(`.agnes/agh-ortho/runs/${saved.run_id}/report.json`))
check('write created the parent directories itself', fs1.dirs.has(`.agnes/agh-ortho/runs/${saved.run_id}`))

const REQUIRED = ['contract', 'id', 'path', 'sha256', 'bytes', 'mime', 'kind', 'createdAt', 'producer', 'preview']
check('every descriptor carries all required fields', saved.artifacts.every((a) => REQUIRED.every((k) => a[k] !== undefined && a[k] !== null)))
check('contract is an integer 1', saved.artifacts.every((a) => a.contract === 1 && Number.isInteger(a.contract)))
check('descriptor paths are absolute', saved.artifacts.every((a) => a.path.startsWith(ws + '\\')), saved.artifacts[0]?.path)
check('descriptor sha256 is 64 lowercase hex', saved.artifacts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)))
check('createdAt is ISO-8601', saved.artifacts.every((a) => !Number.isNaN(Date.parse(a.createdAt))))
check('preview is present, substantive and <= 200 chars',
  saved.artifacts.every((a) => a.preview.length > 20 && a.preview.length <= 200 && !/^(一张图|an image|image)$/i.test(a.preview)),
  saved.artifacts.map((a) => a.preview.length).join(','))

// §9 第 2 步：消费方复核 bytes 与 sha256（这里是本地复刻那个消费方）。
const consumerCheck = (fs, artifacts) => {
  const problems = []
  for (const a of artifacts) {
    const key = relKey(a.path)
    if (!fs.files.has(key)) { problems.push({ code: 'E_ARTIFACT_MISSING', path: a.path }); continue }
    const text = fs.files.get(key)
    if (Buffer.byteLength(text, 'utf8') !== a.bytes || sha(text) !== a.sha256) problems.push({ code: 'E_ARTIFACT_MISMATCH', path: a.path })
  }
  return problems
}
check('consumer-side verification passes (bytes + sha256)', consumerCheck(fs1, saved.artifacts).length === 0, JSON.stringify(consumerCheck(fs1, saved.artifacts)))

// §9 第 7 步：人为改坏一个产物，消费方必须拒绝而不是静默接受。
const victim = saved.artifacts.find((a) => a.kind === 'image')
const victimKey = relKey(victim.path)
fs1.files.set(victimKey, `${fs1.files.get(victimKey)}\n<!-- tampered -->`)
check('tampering is caught as E_ARTIFACT_MISMATCH', consumerCheck(fs1, saved.artifacts).some((p) => p.code === 'E_ARTIFACT_MISMATCH'))
fs1.files.set(victimKey, fs1.files.get(victimKey).replace('\n<!-- tampered -->', ''))

// §5.3 幂等：同一 run_id 再调一次，必须原样返回且不重新生成。
const before = fs1.files.size
const replay = (await save.execute({ ...SAMPLE, run_id: saved.run_id }, { fs: fs1, session: { workspaceRoot: ws } })).structured
check('same run_id replays instead of regenerating', replay.ok === true && replay.idempotent_replay === true, JSON.stringify(replay.blockers))
check('replay returns the same descriptor ids', replay.artifacts.map((a) => a.id).join() === saved.artifacts.map((a) => a.id).join())
check('replay wrote nothing new', fs1.files.size === before)

// 幂等会吃掉"想补的那一档"：候选轮先落盘，交付轮的 against_scene 就只会拿回旧描述符。
// 这件事故必须**被看见**（不是失败 —— 重放本身是对的，但读回没被记录）。
const replayWantingReadback = (await save.execute({ ...SAMPLE, run_id: saved.run_id, against_scene: true }, { fs: fs1, session: { workspaceRoot: ws } })).structured
check(
  'replay says out loud that the readback you asked for was NOT recorded',
  replayWantingReadback.idempotent_replay === true &&
    replayWantingReadback.readback_recorded === false &&
    replayWantingReadback.readback_not_recorded === true &&
    /fresh run_id/.test(replayWantingReadback.readback),
  replayWantingReadback.readback,
)
check('and a replay that did not ask for a readback does not cry wolf', replay.readback_not_recorded === false)

// 交付的参数文件必须**同值即同字节**（"同参数 ⇒ 逐字节相同"与"两轮 diff 只看数值"都靠它）。
// 实测被抓到过：同一组参数两次 save，键序跟着调用方走 ⇒ 取值逐项相同、字节不同。
// 这里故意把整个键序倒过来再存一次：两份 parameters.json 必须逐字节相同。
const reversed = (value) => {
  if (Array.isArray(value)) return value.map(reversed)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
}
const shuffledSample = reversed(JSON.parse(JSON.stringify(SAMPLE)))
check('the reordering fixture really reorders (otherwise the next two checks prove nothing)', JSON.stringify(shuffledSample) !== JSON.stringify(SAMPLE))
const fs3 = memoryFs()
const savedOrderA = (await save.execute({ ...SAMPLE, run_id: 'order-a' }, { fs: fs3, session: { workspaceRoot: ws } })).structured
const savedOrderB = (await save.execute({ ...shuffledSample, run_id: 'order-b' }, { fs: fs3, session: { workspaceRoot: ws } })).structured
check('both key orders saved', savedOrderA.ok === true && savedOrderB.ok === true, JSON.stringify([savedOrderA.blockers, savedOrderB.blockers]))
const paramText = (result) => fs3.files.get(relKey(result.artifacts.find((a) => a.path.endsWith('parameters.json')).path))
const paramsA = paramText(savedOrderA)
const paramsB = paramText(savedOrderB)
check('parameters.json is canonical: same values in a different key order give identical bytes', paramsA === paramsB, `${paramsA?.length} vs ${paramsB?.length} bytes`)
check(
  'and the canonical order is the declared one (id then feature), not alphabetical, with the values untouched',
  (() => {
    const p = JSON.parse(paramsA)
    return (
      Object.keys(p.assembly[0]).slice(0, 2).join() === 'id,feature' &&
      Object.keys(p.frame).join() === 'front,handed,up' &&
      p.assembly[1].w.v === 12.4 &&
      p.assembly[1].at.v.join() === '0,0,4.65' &&
      p.unresolved[0] === '屋面厚度'
    )
  })(),
)

// §6 E_RUN_NOT_OWNED：别人的 run 目录必须拒绝，并回报 marker 的实际内容。
const fs2 = memoryFs()
await fs2.write('.agnes/agh-ortho/runs/foreign/marker.json', JSON.stringify({ contract: 1, producer: 'someone-else@1.0.0', runId: 'foreign', createdAt: new Date().toISOString() }))
const foreign = (await save.execute({ ...SAMPLE, run_id: 'foreign' }, { fs: fs2, session: { workspaceRoot: ws } })).structured
check('a foreign run directory is refused as E_RUN_NOT_OWNED', foreign.ok === false && foreign.blockers[0].code === 'E_RUN_NOT_OWNED', foreign.blockers[0]?.message)
check('the refusal reports the actual marker content', foreign.blockers[0].marker?.producer === 'someone-else@1.0.0')

// §7 保留：只出计划，且明说做不到删除。
check('retention policy is stated', saved.retention.policy.maxRuns === 20 && saved.retention.policy.maxAgeDays === 30, JSON.stringify(saved.retention.policy))
check('retention honestly says this plugin cannot delete', saved.retention.cannot_delete_here.includes('no rm'))
check('report.json on disk is the authority (contract + artifact count)',
  (() => { const r = JSON.parse(fs1.files.get(`.agnes/agh-ortho/runs/${saved.run_id}/report.json`)); return r.contract === 1 && r.artifacts.length === 10 && r.unlowered.length >= 1 && r.unresolved[0] === '屋面厚度' })())

// 产物里的 preview 必须把降级误差带到用户面前，而不是只留在内部字段。
const opsPreview = saved.artifacts.find((a) => a.path.endsWith('ops.json')).preview
check('ops preview surfaces the unlowered count', /\d+ 项未 lower/.test(opsPreview), opsPreview)
const verifyArtifact = saved.artifacts.find((a) => a.path.endsWith('verify.json'))
const verifyText = fs1.files.get(relKey(verifyArtifact.path))
check('verify.json records residual 0, needs_blender false, and its caveats', (() => { const v = JSON.parse(verifyText); return v.residual_max === 0 && v.needs_blender === false && Array.isArray(v.caveats) && v.caveats.length === 3 })())

// save + 读回：产物包必须记录 ⑤。否则交付物只能证明"我自洽"，证明不了"下游照做了" ——
// **交付物不该比这一轮实际验过的少**。
// 注意场景对象在这里内联，而不是复用后面 8c 段里的 DIM_SCENE：那会踩 TDZ（const 未初始化就访问），
// 这个坑已经咬过我两次。
const SAVE_SCENE = {
  scene: 'Scene',
  objects: [
    { name: 'site', type: 'MESH', location: [0, 0, 0], scale: [60, 40, 1], dimensions: [60, 40, 0], rotation_euler: [0, 0, 0], vertices: 4, polygons: 1, materials: [] },
    { name: 'body', type: 'MESH', location: [0, 0, 4.65], scale: [12.4, 8.6, 9.3], dimensions: [12.4, 8.6, 9.3], rotation_euler: [0, 0, 0], vertices: 8, polygons: 6, materials: [] },
  ],
}
const fs4 = memoryFs()
const savedWithScene = (
  await save.execute({ ...SAMPLE, run_id: 'with-scene', against_scene: true }, { fs: fs4, session: { workspaceRoot: ws }, tools: { invoke: async () => ({ structured: { ok: true, blockers: [], scene: SAVE_SCENE } }) } })
).structured
check('save: asking for the readback keeps it ok', savedWithScene.ok === true, JSON.stringify(savedWithScene.blockers))
const vWithScene = JSON.parse(fs4.files.get(relKey(savedWithScene.artifacts.find((a) => a.path.endsWith('verify.json')).path)))
check('save: verify.json names both tiers and the readback result', vWithScene.tier === 'scene_readback' && vWithScene.needs_blender === true && vWithScene.scene.matched === 2 && vWithScene.scene.size_asserted === true, JSON.stringify({ tier: vWithScene.tier, matched: vWithScene.scene?.matched, size: vWithScene.scene?.size_asserted }))
check('save: report.json carries the readback summary', (() => { const r = JSON.parse(fs4.files.get(`.agnes/agh-ortho/runs/${savedWithScene.run_id}/report.json`)); return r.scene_readback?.available === true && r.scene_readback?.matched === 2 && r.scene_readback?.size_asserted === true })())

// 交付物必须**喂得回去**：parameters.json 里不能夹带工具控制字段（run_id / against_scene），
// 而且要能原样作为 emit_ops / fit 的输入。实测抓到过：第一轮包里带着这两个键，
// 于是那份参数文件被 additionalProperties:false 直接拒掉 —— 交付物不能复用。
const sceneParams = JSON.parse(fs4.files.get(relKey(savedWithScene.artifacts.find((a) => a.path.endsWith('parameters.json')).path)))
check('save: parameters.json carries no tool-control keys', !('run_id' in sceneParams) && !('against_scene' in sceneParams), Object.keys(sceneParams).join(','))
const refed = (await byName['agh_ortho_emit_ops'].execute(sceneParams, {})).structured
check('save: the saved parameters feed straight back into emit_ops', refed.ok === true && refed.ops.length === 2, JSON.stringify(refed.blockers))

// 没有实例时：包里必须写明"读回没有发生"，而不是含糊过去
const fs5 = memoryFs()
const savedNoScene = (
  await save.execute({ ...SAMPLE, run_id: 'no-scene', against_scene: true }, { fs: fs5, session: { workspaceRoot: ws }, tools: { invoke: async () => ({ structured: { ok: false, blockers: ['no managed Blender instance in this workspace'] } }) } })
).structured
const vNoScene = JSON.parse(fs5.files.get(relKey(savedNoScene.artifacts.find((a) => a.path.endsWith('verify.json')).path)))
check('save: an absent instance is recorded as "the readback did NOT happen"', savedNoScene.ok === false && vNoScene.scene.available === false && /did NOT happen/.test(vNoScene.scene.note), JSON.stringify(vNoScene.scene))

// --- 8b. 能力协商第 1 级（跨插件 invoke）与它的四级降级 ---
// 下游 catalog 的真实形状（读自 agh_ops.py 的 catalog()）：ops 是**字典**，没有 primitives 列表。
const LIVE_CATALOG = {
  version: 1,
  limits: { maxOpsPerBatch: 8, maxObjects: 3, nameCharset: 'A-Za-z0-9_-.', nameMaxLength: 12 },
  ops: {
    'mesh.primitive_add': { mutates: false, destructive: false, summary: 'add a primitive' },
    'mesh.prism_add': { mutates: false, destructive: false, summary: 'an M3 op that does not exist yet' },
  },
  errorCodes: { E_ARG_RANGE: 'argument out of range' },
  notes: ['read the scene before and after a build'],
}
const catalogTool = byName['agh_ortho_catalog']
const withLive = { tools: { invoke: async () => ({ structured: { ok: true, blockers: [], catalog: LIVE_CATALOG } }) } }

const live = (await catalogTool.execute({}, withLive)).structured
check('live: acquisition names the tool it came from', live.negotiated.acquisition === 'tool:agh_blender_ops_catalog', live.negotiated.acquisition)
// 这一条是针对真实缺陷加的回归：sources 里曾经硬编码 tool.available=false，
// 结果同一份载荷里 acquisition 已经是 tool:... —— 一句自我矛盾的假话。
check('live: sources.tool.inUse follows the acquisition, not a hardcoded flag', live.sources.tool.inUse === true && live.sources.file.inUse === false, JSON.stringify(live.sources))
check('live: not stale - it saw the real downstream', live.negotiated.stale === false)
check('live: limits come from the catalog', live.negotiated.limits.maxOpsPerBatch === 8 && live.negotiated.limits.nameMaxLength === 12)
check('live: the ops dictionary is converted to our list, flags included', live.negotiated.ops.length === 2 && live.negotiated.ops.every((o) => o.mutates === false) && live.negotiated.ops.some((o) => o.name === 'mesh.prism_add'))
check('live: the missing primitives list stays null instead of being faked', live.negotiated.primitives === null)

// 降级 1：下游没有受管理实例 —— 这是**正常分支**，不是异常
const noInstance = (await catalogTool.execute({}, { tools: { invoke: async () => ({ structured: { ok: false, blockers: ['no managed Blender instance in this workspace; call agh_blender_start first'] } }) } })).structured
check('absent instance degrades to the shipped snapshot', noInstance.negotiated.acquisition === 'file:agh.capability.json', noInstance.negotiated.acquisition)
check('degraded: sources flips to file, and the reason survives', noInstance.sources.tool.inUse === false && noInstance.sources.file.inUse === true && noInstance.sources.tool.attempted === true, JSON.stringify(noInstance.sources))
check('and the reason is recorded, not swallowed', /no managed Blender instance/.test(noInstance.negotiated.negotiation.reason ?? ''), noInstance.negotiated.negotiation.reason)

// 降级 2：目标工具不在本轮披露集里 —— invoke 抛 TOOL_NOT_FOUND
const notFound = (await catalogTool.execute({}, { tools: { invoke: async () => { throw Object.assign(new Error('unknown tool agh_blender_ops_catalog'), { code: 'TOOL_NOT_FOUND' }) } } })).structured
check('a throwing invoke degrades and records the code', notFound.negotiated.acquisition === 'file:agh.capability.json' && /TOOL_NOT_FOUND/.test(notFound.negotiated.negotiation.reason ?? ''), notFound.negotiated.negotiation.reason)

// 降级 3：这个上下文根本没有 tools seam（自检、裸调用）
const noSeam = (await catalogTool.execute({}, {})).structured
check('no tools seam: recorded as not attempted, still degrades', noSeam.negotiated.acquisition === 'file:agh.capability.json' && noSeam.negotiated.negotiation.attempted === false, JSON.stringify(noSeam.negotiated.negotiation))

// 降级 4：形状不对（少了 limits/ops）
const junk = (await catalogTool.execute({}, { tools: { invoke: async () => ({ structured: { ok: true, catalog: { version: 1 } } }) } })).structured
check('a payload without limits/ops degrades', junk.negotiated.acquisition === 'file:agh.capability.json' && /lacks limits or ops/.test(junk.negotiated.negotiation.reason ?? ''), junk.negotiated.negotiation.reason)

// 最要紧的一条：实时限额必须真的**约束行为**，而不只是被显示出来。
const tooMany = { ...SAMPLE, assembly: Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, feature: 'box', w: { v: 1 }, d: { v: 1 }, h: { v: 1 } })) }
const emitLive = (await byName['agh_ortho_emit_ops'].execute(tooMany, withLive)).structured
check('live limits actually constrain the emitter (4 objects against a limit of 3)', emitLive.ok === false && emitLive.blockers.some((b) => b.code === 'E_LIMIT_OBJECTS'), JSON.stringify(emitLive.blockers.map((b) => b.code)))
check('and the capability set is reported as the live one', emitLive.target_capability_set === 'agh-blender@live:catalog-v1', emitLive.target_capability_set)
const emitFile = (await byName['agh_ortho_emit_ops'].execute(tooMany, {})).structured
check('the same 4 objects pass against the shipped snapshot limit of 512', emitFile.ok === true, JSON.stringify(emitFile.blockers.map((b) => b.code)))

// --- 8c. scene_readback 半档（引入外部事实的那一档）---
const verifyTool = byName['agh_ortho_verify']
const GOOD_SCENE = {
  scene: 'Scene',
  objectCount: 3,
  objects: [
    { name: 'site', type: 'MESH', location: [0, 0, 0], scale: [60, 40, 1], vertices: 4, polygons: 1, materials: [] },
    { name: 'body', type: 'MESH', location: [0, 0, 4.65], scale: [12.4, 8.6, 9.3], vertices: 8, polygons: 6, materials: [] },
    // --factory-startup 带来的对象：不是我们建的，**不是失败**
    { name: 'Cube', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], vertices: 8, polygons: 6, materials: [] },
  ],
  materials: [],
  knownOps: [],
}
const withScene = (scene) => ({ tools: { invoke: async () => ({ structured: { ok: true, blockers: [], scene } }) } })

const sceneGood = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(GOOD_SCENE))).structured
check('scene: the tier is named honestly, not against_blender', sceneGood.tier === 'scene_readback' && sceneGood.needs_blender === true, sceneGood.tier)
check('scene: objects match by exact name with location and scale', sceneGood.ok === true && sceneGood.scene.matched === 2 && sceneGood.scene.missing.length === 0 && sceneGood.scene.mismatched.length === 0, JSON.stringify(sceneGood.scene.rows.map((r) => r.verdict)))
check('scene: factory objects are reported as extra, not treated as failure', sceneGood.scene.extra_objects.includes('Cube'))
check('scene: the gap is stated, not hidden', sceneGood.scene.cannot_assert.some((t) => /dimensions/.test(t)) && sceneGood.scene.cannot_assert.some((t) => /primitive kind/.test(t)), JSON.stringify(sceneGood.scene.cannot_assert))
check('scene: size is NOT asserted while the downstream publishes no dimensions', sceneGood.scene.size_asserted === false && sceneGood.scene.dimensions_published === false)
check('scene: the camera gap is permanent and always stated', sceneGood.scene.cannot_assert.some((t) => /camera op/.test(t)))

// 下游一旦发布 dimensions，同一份比对必须**自动**获得尺寸断言（这正是那份请求的接收端）
const DIM_SCENE = {
  ...GOOD_SCENE,
  objects: [
    { name: 'site', type: 'MESH', location: [0, 0, 0], scale: [60, 40, 1], dimensions: [60, 40, 0], vertices: 4, polygons: 1, materials: [] },
    { name: 'body', type: 'MESH', location: [0, 0, 4.65], scale: [12.4, 8.6, 9.3], dimensions: [12.4, 8.6, 9.3], vertices: 8, polygons: 6, materials: [] },
    { name: 'Cube', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], dimensions: [1, 1, 1], vertices: 8, polygons: 6, materials: [] },
  ],
}
const sceneDims = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(DIM_SCENE))).structured
check('dimensions: the size assertion turns on by itself', sceneDims.scene.size_asserted === true && sceneDims.scene.dimensions_published === true && sceneDims.ok === true, JSON.stringify(sceneDims.scene.rows.map((r) => r.dimensions_delta)))
check('dimensions: and the size gap leaves cannot_assert', !sceneDims.scene.cannot_assert.some((t) => /publishes no dimensions/.test(t)), JSON.stringify(sceneDims.scene.cannot_assert))
check('dimensions: the camera gap still stays', sceneDims.scene.cannot_assert.some((t) => /camera op/.test(t)))

// 载荷里的断言清单**不能写死容差**：容差是每行按相对规则算出来的（实测 rows 到 9.6e-6，
// 而清单当时写着 "within 1e-6" —— 自相矛盾）。期望值从 geometry 的常量推出来，不是抄的字面量。
const relText = geometry.SCENE_RELATIVE_TOLERANCE.toExponential()
const floorText = geometry.SCENE_ABSOLUTE_FLOOR.toExponential()
check(
  'scene: the asserts list derives its tolerance from the constants instead of claiming a fixed 1e-6',
  sceneDims.scene.asserts.every((t) => !/within 1e-6/.test(t)) &&
    sceneDims.scene.asserts.filter((t) => /equals/.test(t)).length >= 3 &&
    sceneDims.scene.asserts.filter((t) => /equals/.test(t)).every((t) => t.includes(relText) && t.includes(floorText)),
  JSON.stringify(sceneDims.scene.asserts),
)
// 尺寸不符必须被抓到 —— 这正是 size=1 语义错误的现场
const BAD_DIM_SCENE = { ...DIM_SCENE, objects: DIM_SCENE.objects.map((o) => (o.name === 'body' ? { ...o, dimensions: [12.4, 8.6, 9.299] } : o)) }
const sceneBadDim = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(BAD_DIM_SCENE))).structured
check('dimensions: a size that disagrees with scale x size is a mismatch', sceneBadDim.ok === false && sceneBadDim.scene.mismatched.includes('body'), JSON.stringify(sceneBadDim.scene.rows.find((r) => r.object === 'body').dimensions_delta))

// 单位尺寸必须**按种查表**：torus 在 size=8 时是 10 x 10 x 2，不是 8 x 8 x 8。
// 这条分支走不到工具里（M1 不 lower `ring`），所以直接测纯函数 —— 但 M2 一上就会走工具。
check('unit extent: torus is NOT 1x1x1', JSON.stringify(geometry.UNIT_EXTENT.torus) === JSON.stringify([1.25, 1.25, 0.25]), JSON.stringify(geometry.UNIT_EXTENT))
const torusRows = geometry.compareScene(
  [{ name: 'ring', kind: 'torus', size: 8, location: [0, 0, 0], scale: [1, 1, 1] }],
  { objects: [{ name: 'ring', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], rotation_euler: [0, 0, 0], dimensions: [10, 10, 2], vertices: 48, polygons: 48 }] },
)
check('unit extent: a torus of size 8 expects 10 x 10 x 2', torusRows.rows[0].verdict === 'match' && torusRows.rows[0].size_asserted === true, JSON.stringify(torusRows.rows[0].expected_size_m))

// 旋转过的对象：`dimensions` 是"本地包围盒 × scale"，不再是世界 AABB ⇒ **不许**断言尺寸。
// 而且 M1 的 ops 从不设置 rotation_euler，所以现场出现旋转本身就是不符。
const rotated = geometry.compareScene(
  [{ name: 'b', kind: 'cube', size: 1, location: [0, 0, 0], scale: [2, 2, 2] }],
  { objects: [{ name: 'b', type: 'MESH', location: [0, 0, 0], scale: [2, 2, 2], rotation_euler: [0, 0, 0.785], dimensions: [2, 2, 2], vertices: 8, polygons: 6 }] },
)
check('rotation: a rotated object is a mismatch AND its size is not asserted', rotated.rows[0].verdict === 'mismatch' && rotated.rows[0].size_asserted === false && /rotated/.test(rotated.rows[0].size_not_asserted_reason), JSON.stringify(rotated.rows[0].size_not_asserted_reason))

const noDim = geometry.compareScene(
  [{ name: 'b', kind: 'cube', size: 1, location: [0, 0, 0], scale: [2, 2, 2] }],
  { objects: [{ name: 'b', type: 'MESH', location: [0, 0, 0], scale: [2, 2, 2], rotation_euler: [0, 0, 0], vertices: 8, polygons: 6 }] },
)
check('no dimensions on this object: size is not asserted and the reason is stated', noDim.rows[0].size_asserted === false && /no dimensions/.test(noDim.rows[0].size_not_asserted_reason), JSON.stringify(noDim.rows[0].size_not_asserted_reason))

const movedScene = { ...GOOD_SCENE, objects: GOOD_SCENE.objects.map((o) => (o.name === 'body' ? { ...o, location: [0, 0, 5.0] } : o)) }
const sceneMoved = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(movedScene))).structured
check('scene: a moved object is a mismatch', sceneMoved.ok === false && sceneMoved.scene.mismatched.includes('body'), JSON.stringify(sceneMoved.scene.rows.find((r) => r.object === 'body')))
check('scene: and the numeric tier still passes beside it', sceneMoved.residual_max === 0)

// Blender 会把重名改成 name.001 —— "精确名字找不到"必须报 missing，而不是悄悄放过
const renamedScene = { ...GOOD_SCENE, objects: GOOD_SCENE.objects.map((o) => (o.name === 'body' ? { ...o, name: 'body.001' } : o)) }
const sceneRenamed = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(renamedScene))).structured
check('scene: a renamed object (body -> body.001) is caught as missing', sceneRenamed.ok === false && sceneRenamed.scene.missing.includes('body'), JSON.stringify(sceneRenamed.scene.missing))

const sceneAbsent = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, { tools: { invoke: async () => ({ structured: { ok: false, blockers: ['no managed Blender instance in this workspace; call agh_blender_start first'] } }) } })).structured
check('scene: absent instance fails the tool but keeps the numeric result', sceneAbsent.ok === false && sceneAbsent.residual_max === 0 && sceneAbsent.tier === 'numeric', JSON.stringify(sceneAbsent.blockers.map((b) => b.code)))
check('scene: and it says the tier did not happen', sceneAbsent.scene.available === false && /no managed Blender instance/.test(sceneAbsent.scene.reason), sceneAbsent.scene.reason)

// 不带 against_scene 时**不该读场景**。
// 注意：能力协商仍然会（且应该）尝试 agh_blender_ops_catalog —— 那是"限额不硬编码"的代价，
// 所以这里只断言 agh_blender_scene 没被调用，而不是"没有任何嵌套调用"。
const called = []
const spy = {
  tools: {
    invoke: async (name) => {
      called.push(name)
      throw Object.assign(new Error('not needed for this assertion'), { code: 'TOOL_NOT_FOUND' })
    },
  },
}
const plainVerify = (await verifyTool.execute(SAMPLE, spy)).structured
check('scene: without against_scene, agh_blender_scene is never read', plainVerify.tier === 'numeric' && plainVerify.scene === undefined && plainVerify.ok === true && !called.includes('agh_blender_scene'), JSON.stringify(called))
check('scene: and the negotiation layer still asks for the live catalog', called.includes('agh_blender_ops_catalog'), JSON.stringify(called))

// --- 8d. fit：闭环里"便宜的那一半" ---
const fitTool = byName['agh_ortho_fit']
// 完整候选：有锚点、叶子自带 conf，所以应当判 fit
const FIT_OK = { ...SAMPLE, scale_anchor: { pixel_len: 340, real_len: 2.1, ref: 'door_height' } }

const fitOk = (await fitTool.execute(FIT_OK, {})).structured
check('fit: a complete candidate is judged fit', fitOk.verdict === 'fit' && fitOk.ok === true, JSON.stringify(fitOk.revise_hints))
check('fit: validation reports every check with its own ok', fitOk.validation.checks.length > 0 && fitOk.validation.checks.every((c) => typeof c.ok === 'boolean'), fitOk.validation.checks.length + ' checks')
check('fit: outline is numeric, per view and per object', fitOk.outline.length === 6 && fitOk.outline[1].objects.length === 2 && typeof fitOk.outline[1].objects[0].u_span_m === 'number', JSON.stringify(fitOk.outline[1].objects[0]))
check('fit: outline carries the sheet position', fitOk.outline.every((o) => o.sheet && typeof o.sheet.col === 'number'))
check('fit: conf is labelled DECLARED, not a probability', /DECLARED/.test(fitOk.declared_relative_confidence.warning) && fitOk.declared_relative_confidence.least_certain_first.length > 0, JSON.stringify(fitOk.declared_relative_confidence.least_certain_first.slice(0, 3)))
check('fit: the anchor records the one ratio and its fragility', fitOk.anchor.present === true && fitOk.anchor.metres_per_pixel > 0 && /EVERY size/.test(fitOk.anchor.fragility), JSON.stringify(fitOk.anchor))
check('fit: three-state keeps downstream gaps apart from emitter gaps', fitOk.three_state.emitter_ready_features.length === 7 && Array.isArray(fitOk.three_state.downstream_cannot) && Array.isArray(fitOk.three_state.emitter_not_yet), JSON.stringify(fitOk.three_state.emitter_ready_features))
check('fit: the six SVGs still come along', fitOk.views.length === 6 && fitOk.views.every((v) => /^<svg/.test(v.svg)))
check('fit: it hands you the ops, so one round is one call', Array.isArray(fitOk.ops) && fitOk.ops.length === 2 && fitOk.ops[0].op === 'mesh.primitive_add', JSON.stringify(fitOk.ops?.map((o) => o.op)))
const fitBytes = JSON.stringify(fitOk).length
check('fit: the whole report stays a sane size', fitBytes < 200000, fitBytes + ' bytes')
check('fit: both boundaries are stated as caveats', fitOk.caveats.some((c) => /neither proves agreement with the photograph/.test(c)) && fitOk.caveats.some((c) => /not a measurement/.test(c)))

// 缺锚点 ⇒ blocking。否则会产出一批"没有依据却很自信的米"。
// 注意 SAMPLE 本身带 scale_anchor（§4.4 的样例就有），所以要**删掉**它才算"缺锚点"。
const NO_ANCHOR = { ...SAMPLE }
delete NO_ANCHOR.scale_anchor
const noAnchor = (await fitTool.execute(NO_ANCHOR, {})).structured
check('fit: a missing scale_anchor is blocking, not a silent pass', noAnchor.verdict === 'revise' && noAnchor.revise_hints.some((h) => h.where === 'scale_anchor' && h.severity === 'blocking'), JSON.stringify({ verdict: noAnchor.verdict, anchor: noAnchor.anchor }))
const ratiosOnly = (await fitTool.execute({ ...NO_ANCHOR, assumptions: ['proportions_only'] }, {})).structured
// "真米数不需要锚点"：设计给定的尺寸不是从照片量出来的，不该被要求锚点。
// **实测被指出过**：一轮 M2 尺寸校验用的就是真米数（8 米的板、3 米的柱），却被"缺 scale_anchor"判成 blocking
// —— 那个检查默认了"参数一定来自照片"。当时模型**拒绝**用 proportions_only 去消掉它（那会是谎报），是对的。
const authoredDims = (await fitTool.execute({ ...NO_ANCHOR, assumptions: ['authored_dimensions'] }, {})).structured
check('fit: authored_dimensions suppresses the anchor blocking (a design brief needs no photograph)', authoredDims.anchor.declared_authored === true && !authoredDims.revise_hints.some((h) => h.where === 'scale_anchor' && h.severity === 'blocking'), JSON.stringify(authoredDims.revise_hints.filter((h) => h.where === 'scale_anchor')))
// 场景容差必须随尺寸缩放：限制精度的是**下游的多边形化**（实测 uv_sphere 直径 2 → 1.999999，
// 刚好等于原来的绝对容差 1e-6 ⇒ 只差 1e-15 就翻面），不是浮点算术。
check('scene tolerance scales with size so tessellation is not mistaken for a defect', geometry.sceneToleranceFor(2) > 1e-6 && geometry.sceneToleranceFor(2) < 1e-4 && geometry.sceneToleranceFor(0) >= 1e-9, `tol(2)=${geometry.sceneToleranceFor(2)} tol(0)=${geometry.sceneToleranceFor(0)}`)
check('fit: declaring proportions_only makes the missing anchor acceptable', ratiosOnly.anchor.declared_ratios_only === true && !ratiosOnly.revise_hints.some((h) => h.where === 'scale_anchor' && h.severity === 'blocking'), JSON.stringify({ verdict: ratiosOnly.verdict, blocking: ratiosOnly.revise_summary.blocking }))

// 叶子自相矛盾（v 落在自己声明的 [min,max] 之外）必须被点名到**具体项、具体轴**
const contradiction = { ...FIT_OK, assembly: [...FIT_OK.assembly] }
contradiction.assembly[1] = { ...contradiction.assembly[1], h: { v: 9.3, conf: 0.7, min: 12.0, max: 12.8 } }
const cOut = (await fitTool.execute(contradiction, {})).structured
check('fit: a leaf contradicting its own min/max is named precisely', cOut.verdict === 'revise' && cOut.revise_hints.some((h) => h.where.startsWith('assembly[1]') && /\.h\.v$/.test(h.where) && h.severity === 'blocking'), JSON.stringify(cOut.revise_hints.map((h) => h.where)))

// 坐标系：本插件的投影写死 Z-up / -Y-front，声明成别的等于视图是错的
const badFrame = (await fitTool.execute({ ...FIT_OK, frame: { up: 'Y', front: '-Z', handed: 'right' } }, {})).structured
check('fit: a non-Z-up frame fails validation', badFrame.verdict === 'revise' && badFrame.validation.failed.includes('frame is the Z-up / -Y-front one this plugin projects'), JSON.stringify(badFrame.validation.failed))

// 下游做不到的形体 ⇒ warning（不是 blocking）：删掉、或在 unresolved 里声明。
// SAMPLE 的 assembly 里本来就含一个 roof.gable 项，所以直接断言它。
check('fit: a downstream-impossible feature warns instead of blocking', fitOk.verdict === 'fit' && fitOk.three_state.downstream_cannot.some((u) => u.feature === 'roof.gable'), JSON.stringify(fitOk.three_state.downstream_cannot))
// 重复 id 必须被校验抓到（这条是从我自己的测试写错里来的：我加了一个与既有项同 id 的项）
const dupId = { ...FIT_OK, assembly: [...FIT_OK.assembly, { ...FIT_OK.assembly[1] }] }
const dupOut = (await fitTool.execute(dupId, {})).structured
check('fit: duplicate ids are caught by validation', dupOut.verdict === 'revise' && dupOut.validation.failed.includes('ids are unique'), JSON.stringify(dupOut.validation.failed))

// 带读回时：归因纪律必须写在载荷里（用 DIM_SCENE：它有 dimensions，才能验尺寸）
const fitScene = (await fitTool.execute({ ...FIT_OK, against_scene: true }, withScene(DIM_SCENE))).structured
check('fit: with against_scene it reports the readback tier', fitScene.scene?.tier === 'scene_readback' && fitScene.scene.size_asserted === true && fitScene.scene.matched === 2, JSON.stringify([fitScene.scene?.tier, fitScene.scene?.matched, fitScene.scene?.size_asserted]))
check('fit: the readback states the attribution rule', /corrupts a correct model/.test(fitScene.scene.attribution), fitScene.scene.attribution)

// numeric 的容差边界：1 ulp 的往返噪声必须仍然算通过，而 1e-6 的真实误差必须不算。
// 这条断言来自一次真实事故：我用"残差必须恰好为 0"当判据，于是 34 条 1-ulp 噪声
// 把整条闭环堵死在 verdict=revise 上。
const epsUnit = { name: 'a', x: { centre: 0, size: 12.4 }, y: { centre: 0, size: 1 }, z: { centre: 0, size: 1 } }
const epsBoxes = [{ name: 'a', kind: 'cube', min: [-6.2, -0.5, -0.5], max: [6.2, 0.5, 0.5] }]
const viewsWithX = (sizeX) => [
  { id: 'front', label: 'front', u: [1, 0, 0], v: [0, 0, 1], names: ['a'], rects: [{ u: [-sizeX / 2, sizeX / 2], v: [-0.5, 0.5] }], bbox: { u: [-sizeX / 2, sizeX / 2], v: [-0.5, 0.5] } },
  { id: 'top', label: 'top', u: [1, 0, 0], v: [0, -1, 0], names: ['a'], rects: [{ u: [-sizeX / 2, sizeX / 2], v: [-0.5, 0.5] }], bbox: { u: [-sizeX / 2, sizeX / 2], v: [-0.5, 0.5] } },
]
// 用 12.4 这个量级。注意**在 1 附近加 1 ulp 是不可表示的**（1 + 2^-53 会舍回 1），
// 所以第一版测试拿 1.0 去加 1 ulp，测出来是 0 —— 那条断言本身写错了。
const ULP_12_4 = 2 ** -49 // 12.4 落在 [8,16)，该区间的 ulp 就是 2^-49
const noisy = viewsMod.residual([epsUnit], viewsWithX(12.4 + ULP_12_4), epsBoxes)
check('numeric: 1 ulp of round-trip noise is within tolerance (and still reported)', noisy.within_tolerance === true && noisy.max > 0 && noisy.tolerance === viewsMod.NUMERIC_TOLERANCE, JSON.stringify({ max: noisy.max, tol: noisy.tolerance }))
const realError = viewsMod.residual([epsUnit], viewsWithX(12.4 + 1e-6), epsBoxes)
check('numeric: a 1e-6 discrepancy is NOT within tolerance', realError.within_tolerance === false && realError.max > 1e-7, JSON.stringify({ max: realError.max, tol: realError.tolerance }))

// --- 8e. M2 的 lowering：sheet / column / ring / dome / spire ---
const M2 = {
  schema_version: '0.1',
  unit: 'm',
  projection: 'first_angle',
  frame: { up: 'Z', front: '-Y', handed: 'right' },
  scale_anchor: { pixel_len: 340, real_len: 2.1, ref: 'door_height' },
  assembly: [
    { id: 'wall_n', feature: 'sheet', w: { v: 8, conf: 0.8 }, d: { v: 0.24, conf: 0.5 }, h: { v: 3, conf: 0.8 } },
    { id: 'col_a', feature: 'column', dia: { v: 0.4, conf: 0.7 }, h: { v: 3, conf: 0.7 } },
    { id: 'ring_a', feature: 'ring', dia: { v: 1.2, conf: 0.6 } },
    { id: 'dome_a', feature: 'dome', dia: { v: 2, conf: 0.5 } },
    { id: 'spire_a', feature: 'spire', dia: { v: 1, conf: 0.6 }, h: { v: 2.5, conf: 0.6 } },
  ],
}
const m2 = await call('agh_ortho_emit_ops', M2)
check('M2: a ring is measured through UNIT_EXTENT, not scale x size (the bug that produced 0.3/0.3/0.9)', (() => { const b = geometry.boxesFromOps([{ op: 'mesh.primitive_add', args: { kind: 'torus', name: 'r', size: 1.2, scale: [1, 1, 1], location: [0, 0, 0] } }])[0]; return Math.abs((b.max[0] - b.min[0]) - 1.5) < 1e-12 && Math.abs((b.max[2] - b.min[2]) - 0.3) < 1e-12 })())
const m2args = Object.fromEntries(m2.ops.map((o) => [o.args.name, o.args]))
check('M2: sheet becomes a thin VERTICAL cube, not a plane', m2args.wall_n.kind === 'cube' && JSON.stringify(m2args.wall_n.scale) === '[8,0.24,3]', JSON.stringify(m2args.wall_n))
check('M2: column becomes a cylinder from dia + h, base on ground', m2args.col_a.kind === 'cylinder' && JSON.stringify(m2args.col_a.scale) === '[0.4,0.4,3]' && JSON.stringify(m2args.col_a.location) === '[0,0,1.5]', JSON.stringify(m2args.col_a))
check('M2: ring dia means the OUTER diameter (size is divided by 1.25)', m2args.ring_a.kind === 'torus' && Math.abs(m2args.ring_a.size - 0.96) < 1e-12, JSON.stringify(m2args.ring_a))
check('M2: spire becomes a cone and stays exact (same shape, so approx would be a false claim)', m2args.spire_a.kind === 'cone' && JSON.stringify(m2args.spire_a.scale) === '[1,1,2.5]' && !m2.approx.some((a) => a.feature === 'spire'), JSON.stringify(m2args.spire_a))
check('M2: dome becomes a uv_sphere and IS recorded as approx', m2args.dome_a_approx.kind === 'uv_sphere' && m2.approx.length === 1 && m2.approx[0].feature === 'dome', JSON.stringify(m2.approx))
check('M2: the approx object name carries the _approx suffix', m2args.dome_a_approx.name === 'dome_a_approx', m2args.dome_a_approx.name)
check('M2: approx carries how + error_note, not just a flag', /uv_sphere/.test(m2.approx[0].how) && /hemisphere/.test(m2.approx[0].error_note), m2.approx[0].error_note?.slice(0, 60))
check('M2: no not_implemented_in_m1 entries are left', !m2.unlowered.some((u) => u.reason_code === 'not_implemented_in_m1'), JSON.stringify(m2.unlowered.map((u) => u.reason_code)))
check('M2: the primitive gate is reported honestly', /not_applied|applied/.test(m2.primitive_gate ?? ''), m2.primitive_gate)

// column 缺 h：不许凭空给一个高度 —— 这正是 CONTRACT §4.4 样例的情形
const noColH = await call('agh_ortho_emit_ops', { ...M2, assembly: [{ id: 'col_x', feature: 'column', dia: { v: 0.4 } }] })
check('M2: a column without h is refused, never invented', noColH.ok === false && noColH.blockers.some((b) => b.code === 'E_ARG_MISSING' && /"col_x"\."h"/.test(b.message)), JSON.stringify(noColH.blockers.map((b) => b.message)))
check('M2: and h-less is the CONTRACT §4.4 sample itself (a contract gap, surfaced loudly)', /col_x/.test(noColH.blockers[0]?.message ?? ''))

// 作者自己声明的 unsupported 必须归进自己的桶里，而不是掉进"未知原因码"变成 blocking。
// （这两处 reason_code 曾经不一致，是读代码时发现的潜伏 bug —— 现在有测试兜着。）
const declaredEmit = await call('agh_ortho_emit_ops', { ...M2, unsupported: [{ feature: 'roof.gable', pitch: { v: 0.42 } }] })
check('M2: a declared unsupported gets its own reason code', declaredEmit.unlowered.some((u) => u.reason_code === 'declared_by_parameter_file'), JSON.stringify(declaredEmit.unlowered.map((u) => u.reason_code)))
const declaredFit = (await fitTool.execute({ ...M2, unsupported: [{ feature: 'roof.gable', pitch: { v: 0.42 } }] }, {})).structured
check('M2: and it stays a warning, never a blocking unknown-reason error', declaredFit.three_state.declared_by_author.length === 1 && !declaredFit.revise_hints.some((h) => h.severity === 'blocking'), JSON.stringify(declaredFit.revise_hints.filter((h) => h.severity === 'blocking').map((h) => h.problem)))

// approx 必须一路传到 fit 的读者面前（CONTRACT §10：降级误差最隐蔽）
const m2fit = (await fitTool.execute(M2, {})).structured
check('M2: fit surfaces the approximation as a warning with the gap spelled out', m2fit.three_state.approximated.length === 1 && m2fit.revise_hints.some((h) => h.severity === 'warning' && /dome/.test(h.where)), JSON.stringify(m2fit.three_state.approximated.map((a) => a.object_name)))

// --- 8f. photo_check：把"模型对照片的读数"变成可核对的输出（③ 不再靠自觉）---
// SAMPLE 的前视图：u 跨度 60（site 主导）、v 跨度 9.3（body 最高）⇒ 60/9.3 ≈ 6.45
const photoAgree = (await fitTool.execute({ ...FIT_OK, photo_check: { front: { w_over_h_min: 6.3, w_over_h_max: 6.6, note: '主体宽约是高的 6.4 倍' } } }, {})).structured
check('photo_check: a computed value inside the declared interval passes', photoAgree.verdict === 'fit' && photoAgree.photo_check.rows.length === 1 && photoAgree.photo_check.rows[0].inside === true, JSON.stringify(photoAgree.photo_check.rows))
const photoDisagree = (await fitTool.execute({ ...FIT_OK, photo_check: { front: { w_over_h_min: 1.8, w_over_h_max: 2.2 } } }, {})).structured
check('photo_check: a computed value OUTSIDE the declared interval BLOCKS', photoDisagree.verdict === 'revise' && photoDisagree.revise_hints.some((h) => h.where === 'photo_check.front' && h.severity === 'blocking'), JSON.stringify(photoDisagree.revise_hints.filter((h) => h.where.startsWith('photo_check')).map((h) => h.problem)))
check('photo_check: and it forbids widening the interval or copying the number', /tautology/.test(photoDisagree.revise_hints.find((h) => h.where === 'photo_check.front')?.suggestion ?? ''), photoDisagree.revise_hints.find((h) => h.where === 'photo_check.front')?.suggestion)
// 区间太宽 = 等于没读。**必须有这条**，否则模型可以靠声明一个很宽的区间让什么都通过（新的同义反复）。
const photoTooWide = (await fitTool.execute({ ...FIT_OK, photo_check: { front: { w_over_h_min: 1, w_over_h_max: 20 } } }, {})).structured
check('photo_check: an interval too wide to discriminate is itself blocking', photoTooWide.verdict === 'revise' && photoTooWide.photo_check.rows[0].interval_is_too_wide === true && /cannot discriminate/.test(photoTooWide.revise_hints.find((h) => h.where === 'photo_check.front')?.problem ?? ''), JSON.stringify(photoTooWide.photo_check.rows))
const photoAbsent = (await fitTool.execute(FIT_OK, {})).structured
check('photo_check: absent is stated as unchecked, never silently passed', photoAbsent.photo_check.declared_views === 0 && /self-discipline/.test(photoAbsent.photo_check.note), photoAbsent.photo_check.note)
// 擦边：只超 0.09%，在**申明的写法精度**内算通过 —— 与"残差必须恰好为 0"是同一课。
// SAMPLE 的 front 算出 6.451613；声明 [5.4, 6.4516]（4 位小数 ⇒ 边界容差 5e-5）。
const photoRazor = (await fitTool.execute({ ...FIT_OK, photo_check: { front: { w_over_h_min: 5.4, w_over_h_max: 6.4516 } } }, {})).structured
check('photo_check: a hair outside the WRITTEN bound is inside once the written precision is respected', photoRazor.verdict === 'fit' && photoRazor.photo_check.rows[0].inside === true && photoRazor.photo_check.rows[0].inside_ignoring_bound_precision === false && photoRazor.photo_check.rows[0].bound_tolerance > 0, JSON.stringify(photoRazor.photo_check.rows[0]))
check('photo_check is part of the intent schema (so it lands in parameters.json too)', Object.hasOwn(tools.find((t) => t.name === 'agh_ortho_emit_ops').parameters.properties, 'photo_check'))

// 尺寸必须为正：0 或负数会让 Blender 翻面/退化，而且是静默错的
const zeroSize = await call('agh_ortho_emit_ops', { ...SAMPLE, assembly: [{ id: 'zp', feature: 'box', w: { v: 0 }, d: { v: 1 }, h: { v: 1 } }] })
check('a non-positive size is refused as E_ARG_RANGE', zeroSize.ok === false && zeroSize.blockers.some((b) => b.code === 'E_ARG_RANGE'), JSON.stringify(zeroSize.blockers.map((b) => b.code)))
const negSize = await call('agh_ortho_emit_ops', { ...SAMPLE, assembly: [{ id: 'zn', feature: 'column', dia: { v: -0.4 }, h: { v: 3 } }] })
check('a negative size is refused too, not silently flipped', negSize.ok === false && negSize.blockers.some((b) => b.code === 'E_ARG_RANGE'), JSON.stringify(negSize.blockers.map((b) => b.code)))

// 重叠：两个物体几乎占同一空间 = 建模手滑（warning，不是 blocking：墙嵌进楼板是合理的）
const overlapped = (await fitTool.execute({ ...FIT_OK, assembly: [
  { id: 'oa', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0, 0, 1] } },
  { id: 'ob', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0, 0, 1] } },
] }, {})).structured
check('overlap: near-total containment says the object is almost invisible', overlapped.overlaps.significant.length === 1 && overlapped.overlaps.significant[0].almost_hidden === true && overlapped.revise_hints.some((h) => h.severity === 'warning' && /contributes almost nothing visible/.test(h.problem)), JSON.stringify(overlapped.overlaps.significant))
const partialOverlap = (await fitTool.execute({ ...FIT_OK, assembly: [
  { id: 'pa', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0, 0, 1] } },
  { id: 'pb', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0.5, 0, 1] } },
] }, {})).structured
check('overlap: partial overlap keeps the milder wording (not "almost hidden")', partialOverlap.overlaps.significant[0].almost_hidden === false && partialOverlap.revise_hints.some((h) => /almost the same space/.test(h.problem)), JSON.stringify(partialOverlap.overlaps.significant))
const touching = (await fitTool.execute({ ...FIT_OK, assembly: [
  { id: 'ta', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0, 0, 1] } },
  { id: 'tb', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [2, 0, 1] } },
] }, {})).structured
check('overlap: objects that merely touch are NOT reported (no noise)', touching.overlaps.significant.length === 0 && touching.overlaps.checked_pairs === 1, JSON.stringify(touching.overlaps))
// 判定必须用**印出来的那个数**：分数正好 0.5 时，报告会印 `0.5`，那就不能又被列出来
// （实测被抓到过：未舍入的 0.5000000… 通过了 > 0.5，输出却显示 0.5）。
const exactHalf = (await fitTool.execute({ ...FIT_OK, assembly: [
  { id: 'ha', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [0, 0, 1] } },
  { id: 'hb', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: [1, 0, 1] } },
] }, {})).structured
check('overlap: a fraction that PRINTS as 0.5 must not be listed (decision uses the reported value)', exactHalf.overlaps.significant.length === 0, JSON.stringify(exactHalf.overlaps.significant))
check('overlap: BOTH thresholds are published so a reader can interpret a row itself', touching.overlaps.listing_threshold === 0.5 && touching.overlaps.almost_hidden_threshold === 0.9 && /almost_hidden is a second/.test(touching.overlaps.note), touching.overlaps.note)

// --- 8g. 跨路对齐：共享部件词汇表（①）+ 规范摆放（④）---
// ① 的动机来自 StdGEN 那种"语义分解"，而 ④ 借的是 CharacterGen 的"规范化" —— 两条都不需要
// 真去跑那些项目，是设计层的东西。
const partsModel = {
  ...FIT_OK,
  assembly: [
    { id: 'h1', feature: 'box', part: 'body', w: { v: 0.4 }, d: { v: 0.2 }, h: { v: 0.4 }, at: { v: [0, 0, 0.8] } },
    { id: 'c1', feature: 'box', part: 'clothing', w: { v: 0.5 }, d: { v: 0.3 }, h: { v: 0.4 }, at: { v: [0, 0, 0.4] } },
    { id: 's1', feature: 'box', part: 'shoe', w: { v: 0.3 }, d: { v: 0.2 }, h: { v: 0.2 }, at: { v: [0, 0, 0.1] } },
  ],
}
const partsFit = (await fitTool.execute(partsModel, {})).structured
check('parts: the shared taxonomy is published', Array.isArray(partsFit.parts.taxonomy) && ['body', 'clothing', 'hair'].every((p) => partsFit.parts.taxonomy.includes(p)), JSON.stringify(partsFit.parts.taxonomy))
check('parts: declared parts are bucketed with their ids', partsFit.parts.by_part.body?.count === 1 && partsFit.parts.by_part.clothing?.ids?.[0] === 'c1', JSON.stringify(partsFit.parts.by_part))
check('parts: an unshared value is flagged, not silently accepted', partsFit.parts.unknown_values.includes('shoe') && partsFit.revise_hints.some((h) => /not in the shared vocabulary/.test(h.problem)), JSON.stringify(partsFit.parts.unknown_values))
const noParts = (await fitTool.execute(FIT_OK, {})).structured
check('parts: a missing part is a warning, never a blocker (existing models keep working)', noParts.parts.undeclared.length > 0 && !noParts.revise_hints.some((h) => h.severity === 'blocking' && /part/.test(h.problem)), JSON.stringify(noParts.parts.undeclared))
check('parts: the note keeps the two axes apart (part = what it is, provenance = how it was made)', /provenance/.test(noParts.parts.note), noParts.parts.note)

// ④ 规范摆放：底面贴 z=0、水平居中 —— 为的是两次迭代能干净地 diff
const oneBox = (at) => ({ ...FIT_OK, assembly: [{ id: 'b', feature: 'box', w: { v: 2 }, d: { v: 2 }, h: { v: 2 }, at: { v: at } }] })
const canonicalFit = (await fitTool.execute(oneBox([0, 0, 1]), {})).structured
check('placement: a grounded, centred model passes both', canonicalFit.placement.on_ground === true && canonicalFit.placement.centred === true, JSON.stringify({ base: canonicalFit.placement.base_z, centre: canonicalFit.placement.horizontal_centre }))
const offCentreFit = (await fitTool.execute(oneBox([5, 0, 1]), {})).structured
check('placement: an off-centre model is reported so iterations stay diffable', offCentreFit.placement.centred === false && offCentreFit.revise_hints.some((h) => h.where === 'placement'), JSON.stringify(offCentreFit.placement.horizontal_centre))
const airborneFit = (await fitTool.execute(oneBox([0, 0, 3]), {})).structured
check('placement: a model floating above z=0 is reported', airborneFit.placement.on_ground === false && /does not sit on z=0/.test(airborneFit.revise_hints.find((h) => h.where === 'placement')?.problem ?? ''), String(airborneFit.placement.base_z))
check('placement: the tolerance is relative, so it scales with the model', canonicalFit.placement.tolerance > 0 && canonicalFit.placement.tolerance < 0.05, String(canonicalFit.placement.tolerance))

// --- 8h. ② 生成的网格：来源必须记全（不可复算），且**明说形状验不了** ---
const meshFull = {
  ...FIT_OK,
  assembly: [
    {
      id: 'body_m',
      feature: 'mesh',
      part: 'body',
      path: 'D:/x/body.obj',
      source: { kind: 'generated_mesh', model: 'StdGEN', weights: 'v1', seed: 42, input_image_sha256: 'ab'.repeat(32) },
    },
    { id: 'h1', feature: 'box', part: 'clothing', w: { v: 0.4 }, d: { v: 0.2 }, h: { v: 0.4 }, at: { v: [0, 0, 0.8] } },
  ],
}
const meshFit = (await fitTool.execute(meshFull, {})).structured
check('mesh: it is a KNOWN unsupported feature (not an unknown one that blocks)', meshFit.three_state.downstream_cannot.some((u) => u.feature === 'mesh') && !meshFit.revise_hints.some((h) => /not in the intent vocabulary/.test(h.problem)), JSON.stringify(meshFit.three_state.downstream_cannot.map((u) => u.feature)))
check('mesh: declared as a generated part, with its provenance carried', meshFit.generated.declared.length === 1 && meshFit.generated.declared[0].source_kind === 'generated_mesh' && meshFit.generated.declared[0].provenance.model === 'StdGEN' && meshFit.generated.declared[0].provenance.seed === 42, JSON.stringify(meshFit.generated.declared))
check('mesh: complete provenance records nothing missing, and it is NOT reproducible', meshFit.generated.declared[0].missing_for_reproducibility.length === 0 && meshFit.generated.declared[0].reproducible === false)
check('mesh: the report says its SHAPE cannot be verified by any tier here', /SHAPE cannot be verified/.test(meshFit.generated.note) && meshFit.revise_hints.some((h) => /SHAPE cannot be verified/.test(h.problem)), meshFit.generated.note.slice(0, 60))
const meshBareFit = (await fitTool.execute({ ...FIT_OK, assembly: [{ id: 'm2', feature: 'mesh', source: { kind: 'generated_mesh' } }] }, {})).structured
check('mesh: an incomplete provenance names exactly what is missing', JSON.stringify(meshBareFit.generated.declared[0].missing_for_reproducibility) === '["model","seed","input_image_sha256"]' && meshBareFit.revise_hints.some((h) => /records no model \/ seed \/ input_image_sha256/.test(h.problem)), JSON.stringify(meshBareFit.generated.declared[0].missing_for_reproducibility))
const paramSourceFit = (await fitTool.execute({ ...FIT_OK, assembly: [{ id: 'p1', feature: 'box', source: { kind: 'parametric' }, w: { v: 1 }, d: { v: 1 }, h: { v: 1 }, at: { v: [0, 0, 0.5] } }] }, {})).structured
check('mesh: a parametric source is reproducible and gets no generated warning', paramSourceFit.generated.declared[0].reproducible === true && !paramSourceFit.revise_hints.some((h) => /SHAPE cannot be verified/.test(h.problem)), JSON.stringify(paramSourceFit.generated.declared[0]))
check('mesh: and the payload note describes what was actually declared, not the generated-mesh case', /parametric/.test(paramSourceFit.generated.note) && !/SHAPE cannot be verified/.test(paramSourceFit.generated.note), paramSourceFit.generated.note.slice(0, 60))

// --- 8i. ③ 一张图纸：六视图排在一张图上、全图一个比例尺（复核必须发生在贵的那一步之前）---
const sheetBoxes = [{ name: 'b1', min: [-1, -0.5, 0], max: [1, 0.5, 1] }]
const sheetViews = viewsMod.sixViewRects(sheetBoxes)
const firstAngle = viewsMod.renderSheet(sheetViews, viewsMod.sheetPlacement('first_angle'), {})
const thirdAngle = viewsMod.renderSheet(sheetViews, viewsMod.sheetPlacement('third_angle'), {})
const cellOf = (sheet, id) => sheet.cells.find((c) => c.view === id)
check(
  'sheet: all six views get a cell, and the first/third angle layouts are genuinely different (not one drawing renamed)',
  firstAngle.cells.length === 6 &&
    cellOf(firstAngle, 'left').col === 1 &&
    cellOf(firstAngle, 'top').row === 1 &&
    cellOf(firstAngle, 'back').col === 2 &&
    cellOf(thirdAngle, 'left').col === -1 &&
    cellOf(thirdAngle, 'top').row === -1 &&
    cellOf(thirdAngle, 'back').col === -2,
  JSON.stringify(thirdAngle.cells),
)
check(
  'sheet: third angle mirrors BOTH axes (GB/T 17451 / ANSI Y14.3), and mirroring does not change the scale',
  firstAngle.scale === thirdAngle.scale && firstAngle.scale > 0,
  `scale ${firstAngle.scale}`,
)
// 全图一个比例尺必须是**画出来的**，不是只写在头上：一个 2×1×1 的方块，u 跨度 2 的视图里矩形宽 = 2×scale。
const sheetWidths = [...firstAngle.svg.matchAll(/width="([0-9.]+)" height="[0-9.]+" fill="rgba\(40,90,160,0\.10\)"/g)].map((m) => m[1])
check(
  'sheet: one shared scale actually applied — every object rect is span × scale (184 = 2 m, 92 = 1 m)',
  sheetWidths.length === 6 &&
    sheetWidths.filter((w) => w === '184.00').length === 4 &&
    sheetWidths.filter((w) => w === '92.00').length === 2 &&
    Math.abs(firstAngle.scale - 92) < 1e-9,
  JSON.stringify(sheetWidths),
)
check(
  'sheet: it is text the model can read — a well-formed SVG naming every object and every view extent',
  /^<svg[^>]*>/.test(firstAngle.svg) &&
    firstAngle.svg.trimEnd().endsWith('</svg>') &&
    firstAngle.svg.includes('b1') &&
    firstAngle.svg.includes('extent u 2.000') &&
    firstAngle.svg.includes(viewsMod.SHEET_NOTE.slice(0, 30)),
  `${firstAngle.svg.length} chars`,
)
check(
  'sheet: the payload states what this drawing can and cannot answer (it cannot judge shape)',
  viewsMod.SHEET_REVIEW_ITEMS.length === 4 &&
    viewsMod.SHEET_REVIEW_ITEMS.some((s) => /cannot answer/.test(s)) &&
    viewsMod.SHEET_NOTE.includes('review object, not a measurement'),
)
// fit 是每轮都调的：图纸正文**不得**被抄进来（同一份几何发两遍就是翻倍上下文），但指针必须在。
const fitSheet = (await fitTool.execute({ ...FIT_OK, assembly: [{ id: 'b1', feature: 'box', w: { v: 2 }, d: { v: 1 }, h: { v: 1 }, at: { v: [0, 0, 0.5] } }] }, {})).structured.sheet
check(
  'sheet: fit carries the pointer (scale + cells), never the drawing text',
  fitSheet.artifact === 'sheet.svg' &&
    typeof fitSheet.shared_scale === 'number' &&
    fitSheet.cells.length === 6 &&
    fitSheet.svg === undefined &&
    /agh_ortho_views/.test(fitSheet.inline_from),
  JSON.stringify({ artifact: fitSheet.artifact, scale: fitSheet.shared_scale, has_svg: fitSheet.svg !== undefined }),
)

// --- 9. 在真实文件系统上再走一遍（内存 fs 会把路径差异糊掉；Windows 的拼接只有真实 IO 才验得出来）---
const realRoot = join(tmpdir(), `agh-ortho-check-${process.pid}`)
const realFs = {
  async read(p) {
    return readFileSync(join(realRoot, p))
  },
  async write(p, data) {
    const abs = join(realRoot, p)
    // 复刻 hosts/adapters/fs.ts:223 的行为：write 会先 mkdir 父目录（recursive）。
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof data === 'string' ? data : Buffer.from(data))
  },
  async list(p) {
    const abs = join(realRoot, p)
    if (!existsSync(abs)) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' })
    return readdirSync(abs, { withFileTypes: true }).map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? 'dir' : 'file',
    }))
  },
  async stat(p) {
    const abs = join(realRoot, p)
    if (!existsSync(abs)) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' })
    const st = statSync(abs)
    return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs }
  },
}

try {
  const realSaved = (
    await save.execute({ ...SAMPLE, run_id: 'check-real-fs' }, { fs: realFs, session: { workspaceRoot: realRoot } })
  ).structured
  check('real fs: save reports ok', realSaved.ok === true, JSON.stringify(realSaved.blockers))
  check('real fs: every descriptor path exists on disk', realSaved.artifacts.every((a) => existsSync(a.path)), realSaved.artifacts.filter((a) => !existsSync(a.path)).map((a) => a.path).join(' '))
  check('real fs: descriptor bytes match the real file size', realSaved.artifacts.every((a) => statSync(a.path).size === a.bytes))
  check('real fs: descriptor sha256 matches the real file content', realSaved.artifacts.every((a) => sha(readFileSync(a.path, 'utf8')) === a.sha256))
  check('real fs: the parent chain was created', existsSync(join(realRoot, '.agnes', 'agh-ortho', 'runs', 'check-real-fs')))
  const reportOnDisk = JSON.parse(readFileSync(join(realRoot, '.agnes', 'agh-ortho', 'runs', 'check-real-fs', 'report.json'), 'utf8'))
  check('real fs: report.json is the authority and carries the descriptors', reportOnDisk.contract === 1 && reportOnDisk.artifacts.length === 10 && reportOnDisk.artifacts[0].path.endsWith('sheet.svg') && typeof reportOnDisk.sheet?.shared_scale === 'number')
  check('real fs: replay is idempotent on a real filesystem', (
    await save.execute({ ...SAMPLE, run_id: 'check-real-fs' }, { fs: realFs, session: { workspaceRoot: realRoot } })
  ).structured.idempotent_replay === true)
  const svgOnDisk = readFileSync(realSaved.artifacts[0].path, 'utf8')
  check('real fs: the SVG on disk is a real SVG document', svgOnDisk.startsWith('<svg') && svgOnDisk.trimEnd().endsWith('</svg>'), `${svgOnDisk.length} chars`)
} finally {
  rmSync(realRoot, { recursive: true, force: true })
}
check('real fs: scratch directory cleaned up', !existsSync(realRoot))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
