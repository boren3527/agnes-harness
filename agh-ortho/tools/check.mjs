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
check('runtime registers 5 tools', tools.length === 5, tools.map((t) => t.name).join(', '))
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
