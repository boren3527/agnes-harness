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
    { id: 'col', feature: 'column', dia: { v: 0.6 } },
    { id: 'roof', feature: 'roof.gable', pitch: { v: 0.42 } },
  ],
  unresolved: ['屋面厚度'],
}
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const call = async (name, args) => (await byName[name].execute(args, {})).structured

const emission = await call('agh_ortho_emit_ops', SAMPLE)
check('emit_ops: ok with only slab+box lowered', emission.ok === true && emission.ops.length === 2, JSON.stringify(emission.blockers))
check('emit_ops: target_capability_set is generated', emission.target_capability_set === 'agh-blender@0.1.7:primitives-6', emission.target_capability_set)
check('emit_ops: not_implemented_in_m1 vs no_downstream_op are distinguished',
  emission.unlowered.some((u) => u.reason_code === 'not_implemented_in_m1') && emission.unlowered.some((u) => u.reason_code === 'no_downstream_op'),
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
check('save returns 9 artifacts (6 views + 3 json)', saved.artifacts.length === 9, saved.artifacts.map((a) => a.path.split('\\').pop()).join(','))
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
  (() => { const r = JSON.parse(fs1.files.get(`.agnes/agh-ortho/runs/${saved.run_id}/report.json`)); return r.contract === 1 && r.artifacts.length === 9 && r.unlowered.length >= 2 && r.unresolved[0] === '屋面厚度' })())

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
check('fit: three-state keeps downstream gaps apart from emitter gaps', fitOk.three_state.emitter_ready_features.length === 2 && Array.isArray(fitOk.three_state.downstream_cannot) && Array.isArray(fitOk.three_state.emitter_not_yet), JSON.stringify(fitOk.three_state.emitter_ready_features))
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
  check('real fs: report.json is the authority and carries the descriptors', reportOnDisk.contract === 1 && reportOnDisk.artifacts.length === 9)
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
