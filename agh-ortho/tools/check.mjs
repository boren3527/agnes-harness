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
check('runtime registers 7 tools', tools.length === 7, tools.map((t) => t.name).join(', '))
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
check('save is a mutating tool', save.meta.isReadOnly === false)
check('save is not destructive but always approved', save.meta.isDestructive === false && save.meta.requiresApproval === 'always')
check('save is not concurrency safe and never replays', save.meta.isConcurrencySafe === false && save.meta.replay === 'never')
// 变更型工具的**集合**必须是显式的：新增一个就必须在这里写明，否则"哪些工具会改工作区"就没人知道了。
const MUTATING = ['agh_ortho_save', 'agh_ortho_mesh_run']
check(
  'exactly the declared mutating tools are mutating + always approved + never replayed',
  tools.filter((t) => t.meta.isReadOnly === false).map((t) => t.name).sort().join(',') === [...MUTATING].sort().join(',') &&
    tools.filter((t) => MUTATING.includes(t.name)).every((t) => t.meta.requiresApproval === 'always' && t.meta.replay === 'never'),
  tools.map((t) => `${t.name}:${t.meta.isReadOnly ? 'ro' : 'rw'}`).join(' '),
)
check(
  'every other tool stays read-only + safe + never-approved',
  tools.filter((t) => !MUTATING.includes(t.name)).every((t) => t.meta.isReadOnly === true && t.meta.replay === 'safe' && t.meta.requiresApproval === 'never'),
)

// ---- 一键生成段：agh_ortho_mesh_run（spawnImpl 是参数化的 ⇒ 不起真进程也能测全流程）----
const meshRunTool = byName['agh_ortho_mesh_run']
const meshRunFs = memoryFs()
meshRunFs.files.set('D:/ws/photo.png', Buffer.from('fake-jpeg-bytes', 'utf8'))
const runMissingConfig = (await meshRunTool.execute({ name: 'fake', image_file: 'D:/ws/photo.png' }, { fs: meshRunFs })).structured
check(
  'mesh_run: without a config and without a command it REFUSES and prints the template',
  runMissingConfig.ok === false &&
    runMissingConfig.blockers.some((b) => b.code === 'E_MESH_RUN_NOT_CONFIGURED' && b.template?.command?.length >= 1),
  JSON.stringify(runMissingConfig.blockers.map((b) => b.code)),
)
const runBadName = (await meshRunTool.execute({ name: 'bad name!', image_file: 'D:/ws/photo.png' }, { fs: meshRunFs })).structured
check('mesh_run: the name becomes a directory, so its charset is checked', runBadName.blockers.some((b) => b.code === 'E_ARG_RANGE'), JSON.stringify(runBadName.blockers.map((b) => b.code)))
const runNoSeam = (await meshRunTool.execute({ name: 'fake', image_file: 'D:/ws/photo.png', command: ['x'] }, { fs: meshRunFs })).structured
check(
  'mesh_run: no sandbox seam ⇒ refuse rather than spawn unconfined',
  runNoSeam.blockers.some((b) => b.code === 'E_NO_SANDBOX_SEAM'),
  JSON.stringify(runNoSeam.blockers.map((b) => b.code)),
)
// 全流程（stub 掉 spawnImpl：它把一份已知 GLB 写进 {out}/0/）：命令模板替换、递归找产出、
// 按真实字节量、写 mesh.glb + sidecar（声明 = 实测）、返回 measured。
const meshRunFs2 = memoryFs()
meshRunFs2.files.set('D:/ws/photo.png', Buffer.from('fake-jpeg-bytes', 'utf8'))
// 就地造一个最小 GLB（不依赖文件后部才定义的 makeGlb）：一个立方体的 POSITION accessor，
// 尺寸由**节点 scale** 施加 ⇒ glbWorldBounds 量到的世界尺寸 = 2 × scale。
const inlineGlb = (scale) => {
  const corners = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]
  const positions = Buffer.alloc(corners.length * 12)
  corners.forEach((c, i) => c.forEach((v, k) => positions.writeFloatLE(v, (i * 3 + k) * 4)))
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'geometry_0', mesh: 0, scale }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: corners.length, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
  }
  const pad = (b, byte) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), byte)]))
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const binChunk = pad(positions, 0)
  const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length)
  out.writeUInt32LE(0x46546c67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  let at = 12
  out.writeUInt32LE(jsonChunk.length, at)
  out.writeUInt32LE(0x4e4f534a, at + 4)
  jsonChunk.copy(out, at + 8)
  at += 8 + jsonChunk.length
  out.writeUInt32LE(binChunk.length, at)
  out.writeUInt32LE(0x004e4942, at + 4)
  binChunk.copy(out, at + 8)
  return out
}
const fakeGlb = inlineGlb([0.4819, 0.2079, 0.2136]) // 世界尺寸 = 2×scale = [0.9638, 0.4159, 0.4272]
let sawArgv = null
const fakeSpawn = async (argv) => {
  sawArgv = argv
  const out = argv[argv.length - 1]
  // memoryFs 的 list 要求目录**逐级存在**（真实 fs 也是）⇒ 夹具把祖先也建上。
  for (const d of ['.agnes', '.agnes/agh-ortho', '.agnes/agh-ortho/mesh-run', out, `${out}/0`]) meshRunFs2.dirs.add(d)
  meshRunFs2.files.set(`${out}/0/mesh.glb`, fakeGlb)
  return { code: 0, signal: null, timedOut: false, log: 'fake generator ok' }
}
const runOk = (await meshRunTool.execute(
  { name: 'fake', image_file: 'D:/ws/photo.png', command: ['/fake/python', 'gen.py', '--image', '{image}', '--out', '{out}'], up_axis: 'X', unit: 'normalised' },
  { fs: meshRunFs2, sandbox: { confine: async (a) => a }, meshRunSpawn: fakeSpawn },
)).structured
check(
  'mesh_run: the whole flow works end to end with an injected spawn (argv substitution, recursive find, measured sidecar)',
  runOk.ok === true &&
    sawArgv[3] === 'D:/ws/photo.png' &&                                    // {image} 被替换
    sawArgv[sawArgv.length - 1] === '.agnes/agh-ortho/mesh-run/fake' &&    // {out} 被替换
    runOk.mesh_run.measured.up_axis === 'X' &&
    runOk.mesh_run.measured.declared_height === 0.9638 &&                  // 沿声明的上轴实测（= 2×0.4819）
    runOk.mesh_run.file.bytes === fakeGlb.length,
  JSON.stringify({ argv: sawArgv, measured: runOk.mesh_run?.measured, codes: runOk.blockers?.map((b) => b.code) }),
)
const sidecarText = meshRunFs2.files.get('.agnes/agh-ortho/meshes/fake/source.json')
const sidecarObj = sidecarText ? JSON.parse(Buffer.isBuffer(sidecarText) ? sidecarText.toString('utf8') : sidecarText) : null
check(
  'mesh_run: the sidecar it writes declares MEASURED values, and records the command and the photograph hash',
  sidecarObj !== null &&
    sidecarObj.declaredHeight === 0.9638 &&
    sidecarObj.declaredHeightKind === 'measured' &&
    sidecarObj.upAxis === 'X' &&
    typeof sidecarObj.imageSha256 === 'string' &&
    Array.isArray(sidecarObj.command),
  JSON.stringify(sidecarObj && { h: sidecarObj.declaredHeight, kind: sidecarObj.declaredHeightKind, up: sidecarObj.upAxis }),
)
check(
  'mesh_run: the produced mesh is written where the rest of the path expects it',
  meshRunFs2.files.has('.agnes/agh-ortho/meshes/fake/mesh.glb'),
  [...meshRunFs2.files.keys()].join(' '),
)
const fakeFail = async () => ({ code: 3, signal: null, timedOut: false, log: 'boom: model file missing' })
const runFail = (await meshRunTool.execute(
  { name: 'fake2', image_file: 'D:/ws/photo.png', command: ['/fake/python', 'gen.py'] },
  { fs: meshRunFs2, sandbox: { confine: async (a) => a }, meshRunSpawn: fakeFail },
)).structured
check(
  'mesh_run: a non-zero exit is a blocker that carries the log tail, and nothing is written',
  runFail.ok === false && runFail.blockers.some((b) => b.code === 'E_MESH_RUN_FAILED' && /boom/.test(String(b.log))) && !meshRunFs2.files.has('.agnes/agh-ortho/meshes/fake2/mesh.glb'),
  JSON.stringify(runFail.blockers?.map((b) => b.code)),
)

// **不许覆盖**：`meshes/<name>/` 里已经有东西时必须拒绝，而且必须在**起生成器之前**拒绝 ——
// 那里可能是手工写的 sidecar（记着朝向那三轮的来历），被本工具那份整份换掉就永久丢了。
// 判据第二半是"没有起过子进程"：便宜的一步必须先挡，否则"拒写"救不了已经烧掉的那 15 分钟。
let clobberSpawned = false
const runClobber = (await meshRunTool.execute(
  { name: 'fake', image_file: 'D:/ws/photo.png', command: ['/fake/python', 'gen.py'], up_axis: 'X', unit: 'normalised' },
  {
    fs: meshRunFs2,
    sandbox: { confine: async (a) => a },
    meshRunSpawn: async () => {
      clobberSpawned = true
      return { code: 0, signal: null, timedOut: false, log: 'should not have run' }
    },
  },
)).structured
check(
  'mesh_run: an existing mesh directory is a blocker, decided BEFORE the generator is started (§9.11.2)',
  runClobber.ok === false && runClobber.blockers.some((b) => b.code === 'E_MESH_TARGET_EXISTS') && clobberSpawned === false,
  JSON.stringify({ codes: runClobber.blockers?.map((b) => b.code), spawned: clobberSpawned }),
)

// 产出多于一个 .glb 时**不许按文件名顺序挑**：那等于让一个与内容无关的字符串决定"量的是哪一个"，
// 而 sidecar 会把量到的值写成"这个网格的声明"。声明了 `output` 就只量声明的那一份。
const meshRunFs3 = memoryFs()
meshRunFs3.files.set('D:/ws/photo.png', Buffer.from('fake-jpeg-bytes', 'utf8'))
const cfgRel = '.agnes/agh-ortho/mesh-run.json'
const writeCfg = (extra) => meshRunFs3.files.set(cfgRel, JSON.stringify({ command: ['/fake/python', 'gen.py', '--out', '{out}'], upAxis: 'X', unit: 'normalised', generator: 'fakegen', ...extra }))
writeCfg({})
const twoGlbSpawn = async (argv) => {
  const out = argv[argv.length - 1]
  for (const d of ['.agnes', '.agnes/agh-ortho', '.agnes/agh-ortho/mesh-run', out, `${out}/gen`, `${out}/gen/0`, `${out}/final`]) meshRunFs3.dirs.add(d)
  meshRunFs3.files.set(`${out}/gen/0/mesh.glb`, inlineGlb([0.4819, 0.2079, 0.2136])) // 世界 0.9638（原始件）
  meshRunFs3.files.set(`${out}/final/mesh.glb`, inlineGlb([0.1, 0.1, 0.1])) // 世界 0.2（后处理后的成品件）
  return { code: 0, signal: null, timedOut: false, log: 'two outputs' }
}
const runAmbiguous = (await meshRunTool.execute(
  { name: 'fake3', image_file: 'D:/ws/photo.png' },
  { fs: meshRunFs3, sandbox: { confine: async (a) => a }, meshRunSpawn: twoGlbSpawn },
)).structured
check(
  'mesh_run: two .glb outputs without a declared "output" is a blocker (a file name must not decide what got measured)',
  runAmbiguous.ok === false && runAmbiguous.blockers.some((b) => b.code === 'E_MESH_RUN_AMBIGUOUS_OUTPUT'),
  JSON.stringify(runAmbiguous.blockers?.map((b) => b.code)),
)
writeCfg({ output: '{out}/final/mesh.glb' })
const runDeclared = (await meshRunTool.execute(
  { name: 'fake4', image_file: 'D:/ws/photo.png' },
  { fs: meshRunFs3, sandbox: { confine: async (a) => a }, meshRunSpawn: twoGlbSpawn },
)).structured
check(
  'mesh_run: a declared "output" measures exactly that file (here the smaller one, not the name-last one)',
  runDeclared.ok === true && runDeclared.mesh_run.measured.declared_height === 0.2,
  JSON.stringify({ h: runDeclared.mesh_run?.measured?.declared_height, codes: runDeclared.blockers?.map((b) => b.code) }),
)

// **可复现性落成证据**（§9.29）：每次产出追加进**生成器层面的** history.json，于是"同一张照片 + 同一条命令
// 跑出过几次同一个文件"是**可数的事实**（第一次 ⇒ 1）。名字必须换（同名重跑会被闸门拒），
// 这正是为什么历史不放在 meshes/<name>/ 里 —— 放那儿它永远长不到第二条。
check(
  'mesh_run: the run is appended to a generator-level history, so "identical_runs" is a count and not a claim',
  meshRunFs2.files.has('.agnes/agh-ortho/mesh-run/history.json') && runOk.mesh_run?.reproduction?.identical_runs === 1,
  JSON.stringify({ repro: runOk.mesh_run?.reproduction, has: meshRunFs2.files.has('.agnes/agh-ortho/mesh-run/history.json') }),
)
const runAgain = (
  await meshRunTool.execute(
    { name: 'fake5', image_file: 'D:/ws/photo.png', command: ['/fake/python', 'gen.py', '--out', '{out}'], up_axis: 'X', unit: 'normalised' },
    { fs: meshRunFs2, sandbox: { confine: async (a) => a }, meshRunSpawn: fakeSpawn },
  )
).structured
check(
  'mesh_run: a second run of the same photo and command counts as a second identical production (2, not "reproducible: true")',
  runAgain.ok === true && runAgain.mesh_run?.reproduction?.identical_runs === 2,
  JSON.stringify({ ok: runAgain.ok, repro: runAgain.mesh_run?.reproduction, codes: runAgain.blockers?.map((b) => b.code) }),
)



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
// `mesh_file`：外部网格 + **同目录的 source.json**。判据是"声明 vs 测量"，而测量必须是**世界**尺寸：
// glTF 可以把变换放在**节点**上（accessor 只描述局部坐标）—— 实测抓到过 Blender 把 0.4×2×0.4 的方块
// 导成 accessor ±1 + 节点 scale(0.2,1,0.2)，**只看 accessor 会量错 5 倍**。
const makeGlb = (scale) => {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: scale ? [{ name: 'body', mesh: 0, scale }] : [{ name: 'body', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 8, min: [-1, -1, -1], max: [1, 1, 1] }],
  })
  const body = Buffer.from(json, 'utf8')
  const padded = body.length % 4 === 0 ? body : Buffer.concat([body, Buffer.alloc(4 - (body.length % 4), 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'latin1')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunkHead = Buffer.alloc(8)
  chunkHead.writeUInt32LE(padded.length, 0)
  chunkHead.write('JSON', 4, 'latin1')
  return Buffer.concat([header, chunkHead, padded])
}
const MESH_DIR = 'D:/ws/.agnes/agh-ortho/meshes/kuson'
const MESH_PATH_WIN = 'D:\\ws\\.agnes\\agh-ortho\\meshes\\kuson\\mesh.glb'
const meshItem = (over = {}) => ({
  id: 'body_mesh',
  feature: 'mesh',
  part: 'body',
  w: { v: 0.4 },
  d: { v: 0.4 },
  h: { v: 2 },
  path: MESH_PATH_WIN,
  source: { kind: 'generated_mesh', unit: 'm', up_axis: 'Y', declared_height: 2 },
  ...over,
})
const meshFs = (glb) => {
  const f = memoryFs()
  f.files.set(`${MESH_DIR}/mesh.glb`, glb)
  // **按真实 seam 的形状存**：host 的 fs.read 返回 Uint8Array，不是字符串。
  // （这里若存字符串，`raw.toString('utf8')` 那条错分支就永远跑不到 —— 曾经的假 PASS 就是这么来的。）
  f.files.set(`${MESH_DIR}/source.json`, Buffer.from(JSON.stringify({ generator: 'StdGEN', unit: 'm', upAxis: 'Y', declaredHeight: 2 }), 'utf8'))
  return f
}
const readReport = (fs, runId) => {
  const key = [...fs.files.keys()].find((k) => k.endsWith(`/runs/${runId}/report.json`))
  if (!key) throw new Error(`report.json for ${runId} not found in the memory fs (keys: ${[...fs.files.keys()].slice(0, 8).join(', ')})`)
  return JSON.parse(fs.files.get(key))
}

const fsMeshOk = meshFs(makeGlb([0.2, 1, 0.2])) // 世界 = 0.4 × 2 × 0.4
const meshSaved = (await save.execute({ ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-a', mesh_file: MESH_PATH_WIN }, { fs: fsMeshOk, session: { workspaceRoot: ws } })).structured
const meshDesc = meshSaved.artifacts.find((a) => a.kind === 'mesh')
check(
  'mesh_file is registered as a descriptor with its own path (not copied) and binary-correct bytes',
  meshDesc?.path === MESH_PATH_WIN && meshDesc?.bytes === makeGlb([0.2, 1, 0.2]).length && meshDesc?.sha256 === createHash('sha256').update(makeGlb([0.2, 1, 0.2])).digest('hex'),
  JSON.stringify(meshDesc),
)

// **网格的身份 + 可复现性的证据**（§9.29）：sidecar 的 `fileSha256` 也是**声明**（与真实字节比一次）；
// history.json 一并登记成描述符 ⇒ "同一个 sha 跑出过 N 次"这句话**在包里可核**。
const glbForHist = makeGlb([0.2, 1, 0.2])
const glbHistSha = createHash('sha256').update(glbForHist).digest('hex')
const fsMeshHist = meshFs(glbForHist)
fsMeshHist.files.set(
  '.agnes/agh-ortho/mesh-run/history.json',
  Buffer.from(
    JSON.stringify({
      shape: 'agh-ortho/mesh-history/1',
      runs: [
        { name: 'a', sha256: glbHistSha, imageSha256: 'aa' },
        { name: 'b', sha256: glbHistSha, imageSha256: 'bb' },
      ],
    }),
    'utf8',
  ),
)
const histSaved = (await save.execute({ ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-hist', mesh_file: MESH_PATH_WIN }, { fs: fsMeshHist, session: { workspaceRoot: ws } })).structured
const histReport = readReport(fsMeshHist, 'mesh-hist')
check(
  'mesh identity: the pack counts how many times this exact file was produced, and registers the history as a descriptor',
  histSaved.ok === true &&
    histReport.mesh_reproduction?.identical_runs === 2 &&
    histReport.mesh_reproduction?.sha256 === glbHistSha &&
    (histSaved.artifacts ?? []).some((a) => String(a.path).endsWith('history.json')),
  JSON.stringify({ repro: histReport.mesh_reproduction, codes: histReport.blockers?.map((b) => b.code) }),
)
const fsMeshBadSha = meshFs(glbForHist)
fsMeshBadSha.files.set(`${MESH_DIR}/source.json`, Buffer.from(JSON.stringify({ generator: 'StdGEN', unit: 'm', upAxis: 'Y', declaredHeight: 2, fileSha256: 'ff'.repeat(32) }), 'utf8'))
const badShaSaved = (await save.execute({ ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-badsha', mesh_file: MESH_PATH_WIN }, { fs: fsMeshBadSha, session: { workspaceRoot: ws } })).structured
check(
  'mesh identity: a sidecar whose declared fileSha256 does not match the file BLOCKS the pack',
  badShaSaved.ok === false && badShaSaved.blockers.some((b) => b.code === 'E_MESH_SHA_MISMATCH'),
  JSON.stringify(badShaSaved.blockers?.map((b) => b.code)),
)
const meshReport = readReport(fsMeshOk, 'mesh-a')
check(
  'mesh: the measured size is the WORLD size (accessor ±1 × node scale 0.2/1/0.2 = 0.4×2×0.4)',
  meshReport.mesh_measured?.worst_relative_difference === 0 && meshReport.mesh_measured?.size_in_file.join(',') === '0.4,2,0.4',
  JSON.stringify(meshReport.mesh_measured),
)
check(
  'mesh: the file sidecar is carried into the pack next to the measurement',
  meshReport.mesh_source?.upAxis === 'Y' && meshReport.mesh_source?.unit === 'm' && meshReport.mesh_source?.declaredHeight === 2,
  JSON.stringify(meshReport.mesh_source),
)

// 同一条几何，声明成 3 m 高 ⇒ 必须挡住（而不是默默记下"验过了"）
const meshBad = (await save.execute({ ...SAMPLE, assembly: [meshItem({ h: { v: 3 } })], run_id: 'mesh-b', mesh_file: MESH_PATH_WIN }, { fs: meshFs(makeGlb([0.2, 1, 0.2])), session: { workspaceRoot: ws } })).structured
check(
  'mesh: a declaration that disagrees with the file is a BLOCKER, not a warning',
  meshBad.blockers.some((b) => b.code === 'E_MESH_SIZE_MISMATCH'),
  JSON.stringify(meshBad.blockers.map((b) => b.code)),
)

// 没有 sidecar ⇒ 缺 unit/upAxis ⇒ 挡（猜轴向会出一个"看起来对、量起来错"的模型）
const fsNoSidecar = memoryFs()
fsNoSidecar.files.set(`${MESH_DIR}/mesh.glb`, makeGlb([0.2, 1, 0.2]))
const meshNoSidecar = (await save.execute({ ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-c', mesh_file: MESH_PATH_WIN }, { fs: fsNoSidecar, session: { workspaceRoot: ws } })).structured
check(
  'mesh: a missing source.json is a blocker (unit/upAxis are not guessable)',
  meshNoSidecar.blockers.some((b) => b.code === 'E_MESH_SOURCE_UNREADABLE'),
  JSON.stringify(meshNoSidecar.blockers.map((b) => b.code)),
)

// 只看 accessor 的实现会把这条**判成合格** ⇒ 这是"世界 vs 局部"的回归锚
const fsLocalOnly = meshFs(makeGlb(null))
const meshLocalOnly = (await save.execute({ ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-d', mesh_file: MESH_PATH_WIN }, { fs: fsLocalOnly, session: { workspaceRoot: ws } })).structured
check(
  'mesh: a mesh whose size lives only in the accessor is caught (2×2×2 vs declared 0.4×0.4×2)',
  meshLocalOnly.blockers.some((b) => b.code === 'E_MESH_SIZE_MISMATCH'),
  JSON.stringify(readReport(fsLocalOnly, 'mesh-d').mesh_measured),
)

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

// 幂等重放必须回报**磁盘上那份报告**的结论，而不是"重放这个动作成功了"。
// 实测抓到过：第一次因漏传 image_file 被挡（报告 ok:false + E_IMAGE_NOT_VERIFIED），补传后走重放，
// 工具回报 ok:true —— 调用方会以为这单通过了，而权威副本（磁盘）说的是没通过。
const fsReplay = memoryFs()
const replayImg = Buffer.from('fake-png-bytes-for-the-replay-check', 'utf8')
const replaySha = createHash('sha256').update(replayImg).digest('hex')
fsReplay.files.set('D:/ws/photo.png', replayImg)
const replayArgs = {
  ...SAMPLE,
  run_id: 'replay-a',
  assembly: SAMPLE.assembly.map((it, i) => (i === 0 ? { ...it, source: { ...(it.source ?? {}), input_image_sha256: replaySha } } : it)),
}
const replayFirst = (await save.execute(replayArgs, { fs: fsReplay, session: { workspaceRoot: ws } })).structured
check(
  'replay: a blocked pack is written with ok:false, so the disk copy is self-sufficient',
  replayFirst.ok === false && replayFirst.blockers.some((b) => b.code === 'E_IMAGE_NOT_VERIFIED'),
  JSON.stringify(replayFirst.blockers?.map((b) => b.code)),
)
const replaySecond = (await save.execute({ ...replayArgs, image_file: 'D:/ws/photo.png' }, { fs: fsReplay, session: { workspaceRoot: ws } })).structured
check(
  'replay: the second call is a replay and reports the DISK verdict (ok:false + its blockers), not "the replay worked"',
  replaySecond.idempotent_replay === true &&
    replaySecond.ok === false &&
    replaySecond.blockers.some((b) => b.code === 'E_IMAGE_NOT_VERIFIED') &&
    /fresh run_id/.test(String(replaySecond.note)),
  JSON.stringify({ ok: replaySecond.ok, note: replaySecond.note }),
)
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
// **引用即钉住**（§9.28 发现二）：一个 owned 但已过保留期的 run，若在 `retention.json` 里被点名，
// 就**不得**出现在待清清单里 —— "被记录引用过"是工具**不可能知道**的事，只能由调用方点名。
await fs2.write('.agnes/agh-ortho/runs/oldsim/marker.json', JSON.stringify({ contract: 1, producer: 'agh-ortho@0.1.0', createdAt: '2020-01-01T00:00:00.000Z' }))
const retPlain = (await save.execute({ ...SAMPLE, run_id: 'ret-plain' }, { fs: fs2, session: { workspaceRoot: ws } })).structured
await fs2.write('.agnes/agh-ortho/retention.json', JSON.stringify({ pinned: ['oldsim'] }))
const retPinned = (await save.execute({ ...SAMPLE, run_id: 'ret-pinned' }, { fs: fs2, session: { workspaceRoot: ws } })).structured
check(
  'retention: a run named in retention.json is never proposed for pruning (the tool cannot know what the record cites)',
  (retPlain.retention?.would_prune ?? []).some((r) => r.runId === 'oldsim') &&
    !(retPinned.retention?.would_prune ?? []).some((r) => r.runId === 'oldsim') &&
    (retPinned.retention?.pinned_kept ?? []).includes('oldsim'),
  JSON.stringify({
    plain: (retPlain.retention?.would_prune ?? []).map((r) => r.runId),
    pinned_prune: (retPinned.retention?.would_prune ?? []).map((r) => r.runId),
    pinned_kept: retPinned.retention?.pinned_kept,
  }),
)
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
// 下游 catalog 的真实形状（读自 agh_ops.py 的 catalog()）：ops 是**字典**，且自 0.1.8 起
// 发布 primitives 与 capabilitySet。fixture 必须跟着下游走，否则这些用例只是在测旧的形状。
const LIVE_CATALOG = {
  version: 1,
  capabilitySet: 'primitives-6',
  primitives: ['cube', 'uv_sphere', 'cylinder', 'cone', 'torus', 'plane'],
  limits: { maxOpsPerBatch: 8, maxObjects: 3, nameCharset: 'A-Za-z0-9_-.', nameMaxLength: 12 },
  ops: {
    'mesh.primitive_add': { mutates: false, destructive: false, summary: 'add a primitive' },
    'mesh.prism_add': { mutates: false, destructive: false, summary: 'an M3 op that does not exist yet' },
  },
  errorCodes: { E_ARG_RANGE: 'argument out of range' },
  notes: ['read the scene before and after a build'],
}
// 旧下游（0.1.8 之前）的真实形状：没有这两个字段。降级路径必须仍然成立。
const OLD_CATALOG = {
  version: 1,
  limits: { maxOpsPerBatch: 8, maxObjects: 3, nameCharset: 'A-Za-z0-9_-.', nameMaxLength: 12 },
  ops: { 'mesh.primitive_add': { mutates: false, destructive: false, summary: 'add a primitive' } },
  errorCodes: {},
  notes: [],
}
const catalogTool = byName['agh_ortho_catalog']
const withLive = { tools: { invoke: async () => ({ structured: { ok: true, blockers: [], catalog: LIVE_CATALOG } }) } }
const withOld = { tools: { invoke: async () => ({ structured: { ok: true, blockers: [], catalog: OLD_CATALOG } }) } }

const live = (await catalogTool.execute({}, withLive)).structured
check('live: acquisition names the tool it came from', live.negotiated.acquisition === 'tool:agh_blender_ops_catalog', live.negotiated.acquisition)
// 这一条是针对真实缺陷加的回归：sources 里曾经硬编码 tool.available=false，
// 结果同一份载荷里 acquisition 已经是 tool:... —— 一句自我矛盾的假话。
check('live: sources.tool.inUse follows the acquisition, not a hardcoded flag', live.sources.tool.inUse === true && live.sources.file.inUse === false, JSON.stringify(live.sources))
check('live: not stale - it saw the real downstream', live.negotiated.stale === false)
check('live: limits come from the catalog', live.negotiated.limits.maxOpsPerBatch === 8 && live.negotiated.limits.nameMaxLength === 12)
check('live: the ops dictionary is converted to our list, flags included', live.negotiated.ops.length === 2 && live.negotiated.ops.every((o) => o.mutates === false) && live.negotiated.ops.some((o) => o.name === 'mesh.prism_add'))
// 这一条以前断言的是"下游不发布 primitives ⇒ 我们如实给 null"。下游改了，断言也得跟着改：
// 现在要断言的是**我们真的把它读进来了**，否则闸门会永远停在 not_applied。
check('live: the primitives the downstream publishes are carried through, not dropped', Array.isArray(live.negotiated.primitives) && live.negotiated.primitives.length === 6 && live.negotiated.primitives.includes('uv_sphere'), JSON.stringify(live.negotiated.primitives))
check('live: the downstream capabilitySet wins over the synthesised catalog-vN', live.negotiated.capabilitySet === 'primitives-6', live.negotiated.capabilitySet)
// 旧下游仍须退回"无法判定"，而不是猜。
const oldLive = (await catalogTool.execute({}, withOld)).structured
check('old downstream: no primitives list still reads as null, not guessed', oldLive.negotiated.primitives === null)
check('old downstream: capabilitySet falls back to the synthesised catalog-vN', oldLive.negotiated.capabilitySet === 'catalog-v1', oldLive.negotiated.capabilitySet)

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
check('and the capability set is the downstream one, not the synthesised catalog-vN', emitLive.target_capability_set === 'agh-blender@live:primitives-6', emitLive.target_capability_set)
const emitFile = (await byName['agh_ortho_emit_ops'].execute(tooMany, {})).structured
check('the same 4 objects pass against the shipped snapshot limit of 512', emitFile.ok === true, JSON.stringify(emitFile.blockers.map((b) => b.code)))

// 这是本次修复的**核心断言**：上游有实例（实时目录）时，能力闸门必须真的生效。
// 修复前：capabilitiesFromCatalog 把 primitives 写死为 null ⇒ primitive_gate 永远是 not_applied，
// 而 primitive_gate 只在**没有实例**（回落快照）时才 applied —— 恰好反了。
const emitGateLive = (await byName['agh_ortho_emit_ops'].execute(SAMPLE, withLive)).structured
check('gate: on a live catalog that publishes primitives, the gate is APPLIED (the inverted case)', emitGateLive.primitive_gate === 'applied', emitGateLive.primitive_gate)
const emitGateOld = (await byName['agh_ortho_emit_ops'].execute(SAMPLE, withOld)).structured
check('gate: an older catalog without the list still reads not_applied, not a fake pass', /^not_applied/.test(emitGateOld.primitive_gate), emitGateOld.primitive_gate)
// 闸门"生效"必须能被**反驳**，否则 applied 只是句话：发布一个不含 cone 的能力面，cone 就必须被拒。
const NO_CONE = {
  ...LIVE_CATALOG,
  capabilitySet: 'primitives-nocone',
  primitives: ['cube', 'uv_sphere', 'cylinder', 'torus', 'plane'],
}
const coneParams = {
  ...SAMPLE,
  assembly: [{ id: 'roof', feature: 'spire', dia: { v: 2 }, h: { v: 3 } }],
}
const emitNoCone = (await byName['agh_ortho_emit_ops'].execute(coneParams, { tools: { invoke: async () => ({ structured: { ok: true, blockers: [], catalog: NO_CONE } }) } })).structured
check(
  'gate: a kind the target does NOT declare is refused as downstream_cannot, not emitted anyway',
  emitNoCone.primitive_gate === 'applied' &&
    emitNoCone.unlowered.some((u) => u.reason_code === 'no_downstream_primitive' && /cone/.test(u.reason ?? '')),
  JSON.stringify({ gate: emitNoCone.primitive_gate, unlowered: emitNoCone.unlowered }),
)

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
check('scene: the gaps are stated, not hidden (the primitive KIND and the photo gap)', sceneGood.scene.cannot_assert.some((t) => /kind/i.test(t)) && sceneGood.scene.cannot_assert.some((t) => /silhouette/.test(t)), JSON.stringify(sceneGood.scene.cannot_assert))
check('scene: size is NOT asserted while the downstream publishes no dimensions', sceneGood.scene.size_asserted === false && sceneGood.scene.dimensions_published === false)
// 这条断言的**方向**要跟事实走：下游 0.4.0 起真的能渲场景相机（camera.add ORTHO + render.still），
// 我们也有剪影档；所以正确的说法是"能渲、能数值化比对，只有审美判定留给人"，不是"永远不可能"。
check('scene: the photo gap is stated truthfully — the camera ops exist, the silhouette tier exists, only aesthetics stay human', sceneGood.scene.cannot_assert.some((t) => /camera\.add/.test(t)) && sceneGood.scene.cannot_assert.some((t) => /render\.still/.test(t)) && sceneGood.scene.cannot_assert.some((t) => /silhouette/.test(t)) && !sceneGood.scene.cannot_assert.some((t) => /has no camera op|can never|no orthographic option/.test(t)), JSON.stringify(sceneGood.scene.cannot_assert))

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
check('dimensions: the photo gap still stays stated once dimensions are published — with the ops that exist named, never as impossible', sceneDims.scene.cannot_assert.some((t) => /camera\.add/.test(t)) && sceneDims.scene.cannot_assert.some((t) => /silhouette/.test(t)) && !sceneDims.scene.cannot_assert.some((t) => /has no camera op|no orthographic option/.test(t)), JSON.stringify(sceneDims.scene.cannot_assert))

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
// 尺寸不符必须被抓到 —— 这正是 size=1 语义错误的现场。
// 注意错误量要**超过声明的精度**：9.3 只写了一位小数 ⇒ 它自己只准到 ±0.05，拿 0.001 去判它不符
// 是判据的错（第 8 次撞"判据精度不能超过输入精度"）。所以这里用 9.5（差 0.2）。
const BAD_DIM_SCENE = { ...DIM_SCENE, objects: DIM_SCENE.objects.map((o) => (o.name === 'body' ? { ...o, dimensions: [12.4, 8.6, 9.5] } : o)) }
const sceneBadDim = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(BAD_DIM_SCENE))).structured
check('dimensions: a size that disagrees with scale x size is a mismatch', sceneBadDim.ok === false && sceneBadDim.scene.mismatched.includes('body'), JSON.stringify(sceneBadDim.scene.rows.find((r) => r.object === 'body').dimensions_delta))
// 反方向：**不超过声明精度**的差异不能被判不符 —— 否则等于要求输入比它写下的更准。
const NEAR_DIM_SCENE = { ...DIM_SCENE, objects: DIM_SCENE.objects.map((o) => (o.name === 'body' ? { ...o, dimensions: [12.4, 8.6, 9.299] } : o)) }
const sceneNearDim = (await verifyTool.execute({ ...SAMPLE, against_scene: true }, withScene(NEAR_DIM_SCENE))).structured
check(
  'dimensions: a difference within the declaration\u2019s own precision is NOT a mismatch (judging finer than the input is the criterion\u2019s fault)',
  sceneNearDim.scene.mismatched.length === 0 && sceneNearDim.ok === true,
  JSON.stringify(sceneNearDim.scene.rows.find((r) => r.object === 'body')),
)

// 单位尺寸必须**按种查表**：torus 在 size=8 时是 10 x 10 x 2，不是 8 x 8 x 8。
// 这条分支走不到工具里（M1 不 lower `ring`），所以直接测纯函数 —— 但 M2 一上就会走工具。
check('unit extent: torus is NOT 1x1x1', JSON.stringify(geometry.UNIT_EXTENT.torus) === JSON.stringify([1.25, 1.25, 0.25]), JSON.stringify(geometry.UNIT_EXTENT))
const torusRows = geometry.compareScene(
  [{ name: 'ring', kind: 'torus', size: 8, location: [0, 0, 0], scale: [1, 1, 1] }],
  { objects: [{ name: 'ring', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], rotation_euler: [0, 0, 0], dimensions: [10, 10, 2], vertices: 48, polygons: 48 }] },
)
check('unit extent: a torus of size 8 expects 10 x 10 x 2', torusRows.rows[0].verdict === 'match' && torusRows.rows[0].size_asserted === true, JSON.stringify(torusRows.rows[0].expected_size_m))

// 旋转过的对象：`dimensions` 是"本地包围盒 × scale"，不再是世界 AABB ⇒ **不许**断言尺寸。
// 注意"不符"的判据变了：**期望旋转为零时**现场出现旋转才算不符；我们**自己发过** rotation_euler
// 时（mesh 路的翻正）则要求相符 —— 见下面那条断言。
const rotated = geometry.compareScene(
  [{ name: 'b', kind: 'cube', size: 1, location: [0, 0, 0], scale: [2, 2, 2] }],
  { objects: [{ name: 'b', type: 'MESH', location: [0, 0, 0], scale: [2, 2, 2], rotation_euler: [0, 0, 0.785], dimensions: [2, 2, 2], vertices: 8, polygons: 6 }] },
)
check(
  'rotation: an UNEXPECTED rotation is a mismatch AND its size is not asserted, with a stated reason',
  rotated.rows[0].verdict === 'mismatch' && rotated.rows[0].size_asserted === false && /not a half turn/.test(rotated.rows[0].size_not_asserted_reason),
  JSON.stringify(rotated.rows[0].size_not_asserted_reason),
)
// 我们**自己发**的旋转（mesh 路的翻正）必须被期望，否则读回会把"我们要求的"报成"下游没照做"：
// 实测 mesh-triposr-7 的 matched 掉到 0/1，而 location/名字/类型全对，唯一差异就是 [0, π, 0]。
const halfTurnExpected = geometry.compareScene(
  [{ name: 'm', kind: 'mesh', dimensions: [0.4159, 0.4271, 0.9638], location: [0, 0, 0.4819], scale: null, rotation_euler: [0, Math.PI, 0] }],
  { objects: [{ name: 'm', type: 'MESH', location: [0, 0, 0.4819], scale: [1, 1, 1], rotation_euler: [0, Math.PI, 0], dimensions: [0.415857, 0.427124, 0.963764], vertices: 8, polygons: 6 }] },
)
check(
  'rotation: a half turn WE asked for is expected, so it matches and the size is still asserted',
  halfTurnExpected.rows[0].verdict === 'match' && halfTurnExpected.rows[0].size_asserted === true && halfTurnExpected.rows[0].rotation_matches_ops === true,
  JSON.stringify(halfTurnExpected.rows[0]),
)
// **复刻实测**：下游把 rotation_euler 印成 6 位小数（3.141593）而我们的期望是 π（3.141592653589793），
// 差 3.5e-7 ⇒ 必须判"相符"（容差 = 半个末位 5e-7）。拿 1e-9 比会把"印得短"当成"没照做"。
const roundedRotation = geometry.compareScene(
  [{ name: 'm', kind: 'mesh', dimensions: [1, 1, 1], location: [0, 0, 0], scale: null, rotation_euler: [0, Math.PI, 0] }],
  { objects: [{ name: 'm', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], rotation_euler: [0, 3.141593, 0], dimensions: [1, 1, 1], vertices: 8, polygons: 6 }] },
)
check(
  'rotation: a rotation published to 6 decimals still matches an expected pi (the tolerance follows the published precision)',
  roundedRotation.rows[0].rotation_matches_ops === true && roundedRotation.rows[0].verdict === 'match',
  JSON.stringify({ tol: roundedRotation.rows[0].rotation_tolerance, expected: roundedRotation.rows[0].expected_rotation }),
)
// **字段设了 ≠ 几何动了**（实测 p0-rot-probe：glTF 导入的对象是 QUATERNION 模式，rotation_euler 被忽略，
// 四组不同旋转"全部匹配"）。下游一旦发布 rotation_mode，这条就变成可判的。
const modeRows = (mode) =>
  geometry.compareScene(
    [{ name: 'm', kind: 'mesh', dimensions: [1, 1, 1], location: [0, 0, 0], scale: null, rotation_euler: [0, Math.PI / 2, 0] }],
    { objects: [{ name: 'm', type: 'MESH', location: [0, 0, 0], scale: [1, 1, 1], rotation_euler: [0, Math.PI / 2, 0], ...(mode ? { rotation_mode: mode } : {}), dimensions: [1, 1, 1], vertices: 8, polygons: 6 }] },
  ).rows[0]
const quatRow = modeRows('QUATERNION')
check(
  'rotation: a wanted rotation on a QUATERNION-mode object is a mismatch (the value is stored, the geometry does not move)',
  quatRow.verdict === 'mismatch' && quatRow.rotation_effective === false && quatRow.rotation_mode === 'QUATERNION',
  JSON.stringify({ mode: quatRow.rotation_mode, effective: quatRow.rotation_effective }),
)
const xyzRow = modeRows('XYZ')
check(
  'rotation: the same rotation on an euler-mode object matches and is effective',
  xyzRow.verdict === 'match' && xyzRow.rotation_effective === true,
  JSON.stringify({ mode: xyzRow.rotation_mode, effective: xyzRow.rotation_effective }),
)
const noModeRow = modeRows(null)
check(
  'rotation: when the downstream publishes no rotation_mode we do NOT pretend to judge effectiveness',
  noModeRow.verdict === 'match' && noModeRow.rotation_effective === null && noModeRow.rotation_mode === null,
  JSON.stringify({ mode: noModeRow.rotation_mode, effective: noModeRow.rotation_effective }),
)

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

// ---- 网格路（MESH-PLAN 1.1）：能放下就 lowering，放不下就如实说"目标没有这张 op" ----
const MCAP_CATALOG = {
  ...LIVE_CATALOG,
  capabilitySet: 'primitives-6+import',
  ops: { ...LIVE_CATALOG.ops, 'mesh.import': { mutates: false, destructive: false, summary: 'import a mesh file into the scene' } },
}
const withMCap = { tools: { invoke: async () => ({ structured: { ok: true, blockers: [], catalog: MCAP_CATALOG } }) } }
const MCAP_ITEM = {
  id: 'body_mesh',
  feature: 'mesh',
  part: 'body',
  w: { v: 0.5, conf: 0.4 },
  d: { v: 0.3, conf: 0.4 },
  h: { v: 1.62, conf: 0.5 },
  path: '.agnes/agh-ortho/meshes/kuson/body.glb',
  source: { kind: 'generated_mesh', model: 'StdGEN', seed: 0, input_image_sha256: 'a'.repeat(64), up_axis: 'Z', unit: 'normalised', declared_height: 1 },
}
const MCAP_ARGS = { schema_version: 1, unit: 'm', frame: SAMPLE.frame, projection: 'first_angle', assembly: [MCAP_ITEM] }
const emitMCap = byName['agh_ortho_emit_ops']

const noImportCaps = (await emitMCap.execute(MCAP_ARGS, withLive)).structured
check(
  'mesh: with no mesh.import in the target it is unlowered with the RIGHT reason code',
  noImportCaps.unlowered.length === 1 && noImportCaps.unlowered[0].reason_code === 'no_downstream_op' && noImportCaps.ops.length === 0,
  JSON.stringify(noImportCaps.unlowered),
)
const capFitNoImport = (await fitTool.execute({ ...MCAP_ARGS, against_scene: false }, withLive)).structured
check(
  'mesh: the emitter does not claim it can place meshes just because it owns a rule for them',
  !capFitNoImport.three_state.emitter_ready_features.includes('mesh') &&
    capFitNoImport.three_state.emitter_ready_when_target_declares.some((e) => e.feature === 'mesh' && e.requires_op === 'mesh.import') &&
    capFitNoImport.three_state.downstream_cannot.some((d) => d.feature === 'mesh'),
  JSON.stringify(capFitNoImport.three_state.emitter_ready_when_target_declares),
)

const withImportCaps = (await emitMCap.execute(MCAP_ARGS, withMCap)).structured
const meshOpCaps = withImportCaps.ops.find((o) => o.op === 'mesh.import')
check(
  'mesh: with the op declared it lowers, and scale comes from the DECLARED height (not guessed)',
  withImportCaps.unlowered.length === 0 &&
    Boolean(meshOpCaps) &&
    meshOpCaps.args.scale === 1.62 &&
    meshOpCaps.args.upAxis === 'Z' &&
    meshOpCaps.args.size[2] === 1.62 &&
    /meshes\/kuson\/body\.glb$/.test(meshOpCaps.args.path),
  JSON.stringify(meshOpCaps?.args),
)

check(
  'mesh: it lowers to TWO ops — import (declaring only the geometry expectation) + transform (actually placing it)',
  withImportCaps.ops.filter((o) => o.op === 'mesh.import').length === 1 &&
    withImportCaps.ops.some((o) => o.op === 'object.transform' && o.args.name === 'body_mesh' && Array.isArray(o.args.location)) &&
    // import 里**不能**带 location：那一刻对象还没被摆放，这个自检必然报 false（噪音，不是发现）
    withImportCaps.ops.find((o) => o.op === 'mesh.import').args.location === undefined,
  JSON.stringify(withImportCaps.ops.map((o) => ({ op: o.op, args: Object.keys(o.args) }))),
)

const fsNoMeshFile = meshFs(makeGlb([0.2, 1, 0.2]))
const noMeshFileBad = (await save.execute({ ...SAMPLE, assembly: [meshItem({ h: { v: 3 } })], run_id: 'mesh-e' }, { fs: fsNoMeshFile, session: { workspaceRoot: ws } })).structured
check(
  'mesh: the gate is keyed on the ITEM path, not on the optional mesh_file (no mesh_file = still measured, still blocked)',
  noMeshFileBad.blockers.some((b) => b.code === 'E_MESH_SIZE_MISMATCH') && noMeshFileBad.ok === false,
  JSON.stringify({ ok: noMeshFileBad.ok, codes: noMeshFileBad.blockers.map((b) => b.code) }),
)
check(
  'mesh: a blocked run records ok:false and its blockers in report.json (the disk copy must be self-sufficient)',
  readReport(fsNoMeshFile, 'mesh-e').ok === false && readReport(fsNoMeshFile, 'mesh-e').blockers.some((b) => b.code === 'E_MESH_SIZE_MISMATCH'),
  JSON.stringify({ ok: readReport(fsNoMeshFile, 'mesh-e').ok, codes: readReport(fsNoMeshFile, 'mesh-e').blockers.map((b) => b.code) }),
)

const meshFitCaps = (await fitTool.execute({ ...MCAP_ARGS, against_scene: false }, withMCap)).structured
check(
  'mesh: numeric stays aligned (parameter side vs op side) for a mesh item',
  meshFitCaps.numeric?.residual_within_tolerance === true && Number(meshFitCaps.numeric?.residual_max) <= 1e-9,
  JSON.stringify(meshFitCaps.numeric),
)
check(
  'mesh: when the target declares the import op, no hint claims the item stays out of the scene',
  !meshFitCaps.revise_hints.some((h) => /will NOT enter the scene|will not enter the scene/i.test(h.problem)),
  JSON.stringify(meshFitCaps.revise_hints.map((h) => h.problem).filter((t) => /scene/i.test(t))),
)

const noAxisCaps = (await emitMCap.execute({ ...MCAP_ARGS, assembly: [{ ...MCAP_ITEM, source: { ...MCAP_ITEM.source, up_axis: null } }] }, withMCap)).structured
check(
  'mesh: a missing up_axis is a blocker, not a silent guess (and nothing is emitted)',
  noAxisCaps.blockers.some((b) => b.code === 'E_ARG_MISSING' && /up_axis/.test(b.message)) && noAxisCaps.ops.length === 0,
  JSON.stringify(noAxisCaps.blockers.map((b) => b.code)),
)
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
check('mesh: known, never "unknown" — with the op available but the declarations missing it is a BLOCKER, not a mystery', meshFit.blockers.some((b) => b.code === 'E_ARG_MISSING') && !meshFit.revise_hints.some((h) => /not in the intent vocabulary/.test(h.problem)), JSON.stringify(meshFit.blockers.map((b) => b.code)))
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

// ---------------------------------------------------------------------------
// 剪影数值化（SILHOUETTE-PLAN §5）：**用合成 PNG 验** —— 真值全部已知，不需要下游、不需要 Blender。
// 夹具自带一个最小 PNG 编码器，只为让测试**真的经过解码路径**（而不是喂一个假的"像素数组"）。
// ---------------------------------------------------------------------------
const { deflateSync } = await import('node:zlib')
const silMod = await import('../package/extensions/main/silhouette.mjs')
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
const makePng = (width, height, draw, colorType = 6) => {
  const ch = colorType === 6 ? 4 : 3
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * ch + 1)
    for (let x = 0; x < width; x += 1) {
      const px = draw(x, y) ?? [0, 0, 0, 0]
      for (let k = 0; k < ch; k += 1) row[1 + x * ch + k] = px[k] ?? 255
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
const blockPng = (canvas, bw, bh) =>
  makePng(canvas, canvas, (x, y) => {
    const x0 = Math.round((canvas - bw) / 2)
    const y0 = Math.round((canvas - bh) / 2)
    return x >= x0 && x < x0 + bw && y >= y0 && y < y0 + bh ? [255, 255, 255, 255] : [0, 0, 0, 0]
  })

const sil512 = silMod.silhouetteOf(blockPng(512, 200, 100))
check(
  'silhouette: a synthetic 200x100 block decodes to exact metrics (area, bbox, aspect, edges)',
  sil512.width === 512 &&
    sil512.covered_pixels === 200 * 100 &&
    // 报告的数是 `toFixed(6)` 的 ⇒ 断言也必须在**报告的精度**内比，不能拿 1e-9 去比一个 6 位小数的数
    //（"判据的精度不能超过输入的精度" —— 这是它第 7 次现身）。
    Math.abs(sil512.covered_fraction - (200 * 100) / (512 * 512)) <= 5e-7 &&
    sil512.bbox_px.width === 200 &&
    sil512.bbox_px.height === 100 &&
    sil512.aspect_px === 2 &&
    sil512.touches_edges.left === false &&
    sil512.touches_edges.top === false,
  JSON.stringify(sil512),
)
check(
  'silhouette: pixels touching the frame are reported (a cropped render must not pass as fine)',
  (() => {
    const s = silMod.silhouetteOf(makePng(64, 64, (x, y) => (y < 32 ? [255, 255, 255, 255] : [0, 0, 0, 0])))
    return s.touches_edges.top === true && s.touches_edges.left === true && s.touches_edges.bottom === false
  })(),
)
check(
  'silhouette: an RGB render without alpha is REFUSED instead of guessing a background colour',
  (() => {
    try {
      silMod.silhouetteOf(makePng(8, 8, () => [255, 255, 255], 2))
      return false
    } catch (error) {
      return /no alpha channel/.test(String(error?.message))
    }
  })(),
)
check('silhouette: an empty render is stated as empty, not as a pass', silMod.silhouetteOf(makePng(32, 32, () => [0, 0, 0, 0])).covered_fraction === 0)
// 被裁掉的剪影**必须挡**：轮廓不完整时每个数都"看起来合法但是错的"（下游实测 1.2 m vs 真值 2.0 m）。
const cropped = silMod.silhouetteOf(makePng(64, 64, (x, y) => (y < 40 ? [255, 255, 255, 255] : [0, 0, 0, 0])))
const cropCmp = silMod.compareSilhouette({ ...cropped, view: 'front' }, { orthoScale: 2, sensorFit: 'VERTICAL' })
check(
  'silhouette: a silhouette that touches the frame is BLOCKED, not merely annotated (a cropped outline yields plausible-but-wrong numbers)',
  cropped.touches_edges.top === true && cropCmp.ok === false && cropCmp.blockers.some((b) => b.code === 'E_SILHOUETTE_CROPPED'),
  JSON.stringify({ edges: cropped.touches_edges, codes: cropCmp.blockers.map((b) => b.code) }),
)
check(
  'silhouette: metres per pixel comes only from ortho_scale, sensor_fit and the image size',
  Math.abs(silMod.metresPerPixel({ orthoScale: 2, sensorFit: 'VERTICAL', width: 512, height: 512 }) - 2 / 512) < 1e-12 &&
    Math.abs(silMod.metresPerPixel({ orthoScale: 2, sensorFit: 'HORIZONTAL', width: 1024, height: 512 }) - 2 / 1024) < 1e-12 &&
    Math.abs(silMod.metresPerPixel({ orthoScale: 2, sensorFit: 'AUTO', width: 1024, height: 512 }) - 2 / 1024) < 1e-12 &&
    silMod.metresPerPixel({ orthoScale: 0, sensorFit: 'AUTO', width: 512, height: 512 }) === null,
)
const m512 = silMod.compareSilhouette({ ...silMod.silhouetteOf(blockPng(512, 200, 100)), view: 'front' }, { orthoScale: 2, sensorFit: 'VERTICAL' })
const m2048 = silMod.compareSilhouette({ ...silMod.silhouetteOf(blockPng(2048, 800, 400)), view: 'front' }, { orthoScale: 2, sensorFit: 'VERTICAL' })
check(
  'silhouette: the same shape at two resolutions gives the same size in metres (A1)',
  Math.abs(m512.size_m.width - 0.78125) < 1e-9 && Math.abs(m2048.size_m.width - 0.78125) < 1e-9 && Math.abs(m512.size_m.height - m2048.size_m.height) < 1e-9,
  JSON.stringify({ m512: m512.size_m, m2048: m2048.size_m }),
)
check(
  'silhouette: the tolerance is derived from the render resolution, never a fixed small number',
  m512.tolerance_m >= 2 * m512.metres_per_pixel && /max\(2 px/.test(m512.tolerance_source),
  JSON.stringify({ tol: m512.tolerance_m, mpp: m512.metres_per_pixel }),
)
const known = silMod.compareSilhouette(
  { ...silMod.silhouetteOf(blockPng(512, 40, 200)), view: 'front' },
  { orthoScale: 2, sensorFit: 'VERTICAL', outline: { u_span: 0.4, v_span: 2 } },
)
check(
  'silhouette: a known 0.4x0.4x2 sample measures its 0.200 outline aspect (A2)',
  Math.abs(known.aspect - 0.2) < 1e-9 && known.matches_outline === true && known.ok === true,
  JSON.stringify({ aspect: known.aspect, outline_aspect: known.outline_aspect, delta: known.aspect_delta, tol: known.tolerance_m }),
)
const wrong = silMod.compareSilhouette(
  { ...silMod.silhouetteOf(blockPng(512, 40, 200)), view: 'front' },
  { orthoScale: 2, sensorFit: 'VERTICAL', outline: { u_span: 0.4, v_span: 0.4 } },
)
check('silhouette: a mismatch is a blocker, not a note (A3)', wrong.ok === false && wrong.blockers.some((b) => b.code === 'E_SILHOUETTE_OFF_OUTLINE'), JSON.stringify(wrong.blockers.map((b) => b.code)))
check(
  'silhouette: with no ortho_scale there is no verdict at all (a guessed scale would decide it silently)',
  silMod
    .compareSilhouette({ ...silMod.silhouetteOf(blockPng(512, 40, 200)), view: 'front' }, { outline: { u_span: 0.4, v_span: 2 } })
    .blockers.some((b) => b.code === 'E_SILHOUETTE_NO_SCALE'),
)
check(
  'silhouette: an empty render is a blocker of its own kind',
  silMod.compareSilhouette({ view: 'front', aspect_px: null, width: 512, height: 512 }, { orthoScale: 2, sensorFit: 'VERTICAL' }).blockers.some((b) => b.code === 'E_SILHOUETTE_EMPTY'),
)
const photoOk = silMod.compareSilhouette({ ...silMod.silhouetteOf(blockPng(512, 40, 200)), view: 'front' }, { orthoScale: 2, sensorFit: 'VERTICAL', expectedAspect: 0.2 })
const photoBad = silMod.compareSilhouette({ ...silMod.silhouetteOf(blockPng(512, 40, 200)), view: 'front' }, { orthoScale: 2, sensorFit: 'VERTICAL', expectedAspect: 0.9 })
check(
  'silhouette: the photo comparison is two-sided — it passes near the reading and blocks far from it',
  photoOk.matches_photo === true && photoOk.ok === true && photoBad.matches_photo === false && photoBad.blockers.some((b) => b.code === 'E_SILHOUETTE_OFF_PHOTO'),
  JSON.stringify({ near: photoOk.matches_photo, far: photoBad.matches_photo }),
)

// 接线：fit / save 真的会**用**这一档（对不上、读不到都要进判定，而不是只写进载荷）
const baseFit = (await fitTool.execute({ ...MCAP_ARGS, against_scene: false }, withMCap)).structured
const frontAspect = baseFit.outline.find((o) => o.view === 'front')?.w_over_h
check('silhouette wiring: the fixture knows the front outline aspect it must reproduce', Number.isFinite(frontAspect), `front w_over_h = ${frontAspect}`)
const silFitFs = (bw, bh) => {
  const f = memoryFs()
  f.files.set('D:/ws/out/front.png', blockPng(512, bw, bh))
  return f
}
const silArgs = { path: 'D:/ws/out/front.png', ortho_scale: 2, sensor_fit: 'VERTICAL' }
// 夹具里的 `photo_check` 写的是 0（那是别处用例），这里要一份**与渲染相称**的读数，
// 否则这一档会被"照片读数 0"挡住 —— 那验证的是另一件事。
// up_axis 的**符号**：方向不是任何一档能算出来的（包围盒对 ± 不敏感）—— 实测 mesh-triposr-6 里
// 人物站起来但**是倒的**，只有人眼看渲染图才知道。一旦写进声明，插件要把它翻译成一次确定的旋转，
// 而且必须落在**第二条 op**（object.transform）上：那样它与下游"upAxis 转换与变换谁先谁后"无关。
const upAxisCase = async (upAxis) => {
  const item = {
    id: 'body_mesh',
    feature: 'mesh',
    w: { v: 0.4159 },
    d: { v: 0.4271 },
    h: { v: 0.9638 },
    path: '.agnes/agh-ortho/meshes/x/mesh.glb',
    source: { kind: 'generated_mesh', unit: 'normalised', up_axis: upAxis, declared_height: 0.9638 },
  }
  const res = (await byName.agh_ortho_emit_ops.execute({ ...MCAP_ARGS, assembly: [item] }, {})).structured
  const t = (res.ops ?? []).find((o) => o.op === 'object.transform')
  return t?.args?.rotation_euler ?? null
}
const upAxisTable = [
  ['X', null],
  ['+X', null],
  ['-X', [0, Math.PI, 0]],
  ['Y', null],
  ['-Y', [Math.PI, 0, 0]],
  ['Z', null],
  ['-Z', [Math.PI, 0, 0]],
]
for (const [upAxis, expect] of upAxisTable) {
  const got = await upAxisCase(upAxis)
  check(
    `up_axis "${upAxis}": the flip ${expect ? 'is emitted on the second op' : 'is absent'}`,
    JSON.stringify(got) === JSON.stringify(expect),
    JSON.stringify(got),
  )
}

const silFitArgs = { ...MCAP_ARGS, against_scene: false, silhouette: silArgs, photo_check: { front: { w_over_h_min: 0.29, w_over_h_max: 0.33 } } }

// 与照片比**只认区间**（与 photo_check 同源，宽度按写入精度放宽），不再用"中点 ± 渲染容差"。
// 依据是实测：同一轮里 photo_check 说 inside:true，而中点判据说差 0.033 > 容差 0.0097 ⇒ 挡住。
// 一个事实两套判据、两个结论 —— 读者无从解释。这两条断言把区间语义钉死。
const silPhotoMod = await import(pathToFileURL(join(pkgDir, 'extensions', 'main', 'silhouette.mjs')).href)
const silPhotoUnit = (aspectPx) => ({
  width: 1024,
  height: 1024,
  touches_edges: { left: false, right: false, top: false, bottom: false },
  bbox_px: { width: aspectPx, height: 1 },
  aspect_px: aspectPx,
})
const silPhotoRange = { min: 0.37, max: 0.43, boundTolerance: 0.005 }
const silPhotoEdge = silPhotoMod.compareSilhouette(silPhotoUnit(0.4315), { orthoScale: 1.2, sensorFit: 'VERTICAL', expectedRange: silPhotoRange })
check(
  'photo interval: an aspect just outside the written bound but inside its writing precision does NOT block',
  silPhotoEdge.matches_photo === true && silPhotoEdge.blockers.length === 0 && silPhotoEdge.aspect_vs_photo === 0,
  JSON.stringify({ delta_to_bound: silPhotoEdge.aspect_vs_photo, distance_to_midpoint: silPhotoEdge.aspect_vs_photo_midpoint }),
)
const silPhotoFar = silPhotoMod.compareSilhouette(silPhotoUnit(0.75), { orthoScale: 1.2, sensorFit: 'VERTICAL', expectedRange: silPhotoRange })
check(
  'photo interval: an aspect clearly outside the interval blocks, and says which bound it missed',
  silPhotoFar.matches_photo === false &&
    silPhotoFar.blockers.some((b) => b.code === 'E_SILHOUETTE_OFF_PHOTO') &&
    silPhotoFar.aspect_vs_photo > 0,
  JSON.stringify(silPhotoFar.blockers.map((b) => b.code)),
)
const okSil = (await fitTool.execute({ ...silFitArgs }, { fs: silFitFs(Math.round(200 * frontAspect), 200), session: { workspaceRoot: ws } })).structured
check(
  'silhouette wiring: fit compares the render against its own outline, and agrees when they match',
  // 只看这一档：基座参数本身可能有别的 warning/blocker（那与本档无关），所以"一致"的标准是
  // **本档不产生 blocker**、且 verdict 不被它改写。
  okSil.silhouette?.compared?.ok === true &&
    okSil.silhouette.compared.matches_outline === true &&
    (okSil.silhouette_blockers ?? []).length === 0 &&
    okSil.verdict === baseFit.verdict,
  JSON.stringify({ render: okSil.silhouette?.compared?.aspect, outline: okSil.silhouette?.compared?.outline_aspect, cmp_ok: okSil.silhouette?.compared?.ok, matches: okSil.silhouette?.compared?.matches_outline, delta: okSil.silhouette?.compared?.aspect_delta, tol: okSil.silhouette?.compared?.tolerance_m, blockers: okSil.silhouette_blockers?.map((b) => ({ c: b.code, m: String(b.message).slice(0, 90) })), verdict: okSil.verdict, base: baseFit.verdict }),
)
const badSil = (await fitTool.execute({ ...silFitArgs }, { fs: silFitFs(Math.round(200 * frontAspect * 2), 200), session: { workspaceRoot: ws } })).structured
check(
  'silhouette wiring: a render that disagrees with the outline forces the verdict to revise',
  badSil.verdict === 'revise' && badSil.silhouette?.compared?.ok === false && badSil.silhouette?.compared?.blockers?.some((b) => b.code === 'E_SILHOUETTE_OFF_OUTLINE'),
  JSON.stringify({ verdict: badSil.verdict, codes: badSil.silhouette?.compared?.blockers?.map((b) => b.code) }),
)
const noScale = (await fitTool.execute({ ...MCAP_ARGS, against_scene: false, silhouette: { path: 'D:/ws/out/front.png' } }, { fs: silFitFs(100, 200), session: { workspaceRoot: ws } })).structured
check(
  'silhouette wiring: without ortho_scale there is no verdict (a guessed scale would decide it silently)',
  noScale.silhouette?.compared?.blockers?.some((b) => b.code === 'E_SILHOUETTE_NO_SCALE') && noScale.verdict === 'revise',
  JSON.stringify(noScale.silhouette?.compared?.blockers?.map((b) => b.code)),
)
const missSil = (await fitTool.execute({ ...MCAP_ARGS, against_scene: false, silhouette: { path: 'D:/ws/out/nope.png', ortho_scale: 2 } }, { fs: memoryFs(), session: { workspaceRoot: ws } })).structured
check(
  'silhouette wiring: an unreadable render is a blocker that stays visible even though there is no finding',
  missSil.silhouette === null && missSil.silhouette_blockers?.some((b) => b.code === 'E_SILHOUETTE_UNREADABLE') && missSil.verdict === 'revise',
  JSON.stringify(missSil.silhouette_blockers?.map((b) => b.code)),
)
const silSaveFs = meshFs(makeGlb([0.2, 1, 0.2]))
silSaveFs.files.set('D:/ws/out/front.png', blockPng(512, 40, 200))
const badSave = (
  await save.execute(
    { ...SAMPLE, assembly: [meshItem()], run_id: 'mesh-sil', mesh_file: MESH_PATH_WIN, silhouette: { path: 'D:/ws/out/front.png', ortho_scale: 2, sensor_fit: 'VERTICAL', width: 999 } },
    { fs: silSaveFs, session: { workspaceRoot: ws } },
  )
).structured
const badSaveReport = readReport(silSaveFs, 'mesh-sil')
check(
  'silhouette wiring: save records the comparison in report.json and a declared size that disagrees with the PNG blocks the pack',
  badSave.ok === false &&
    badSaveReport.checks?.silhouette?.compared?.size_m !== undefined &&
    badSaveReport.blockers?.some((b) => b.code === 'E_SILHOUETTE_SIZE_MISMATCH'),
  JSON.stringify({ ok: badSave.ok, codes: badSaveReport.blockers?.map((b) => b.code) }),
)

// **身份**（§9.29 缺口一）：声明了下游回报的 sha256/bytes 就**复算比对**；不符 ⇒ blocking；
// 没声明 ⇒ `declared_sha256_matches: null`（那是"没声明"，不是"通过"）—— 与 photo_check 的缺席同一条纪律。
const silBytes = blockPng(512, Math.round(200 * frontAspect), 200)
const silSha = createHash('sha256').update(silBytes).digest('hex')
const silFsOf = (bw) => {
  const f = memoryFs()
  f.files.set('D:/ws/out/front.png', bw)
  return f
}
const silCamera = { name: 'Front', location: [0, -8, 0.5], rotation_euler: [1.5707963, 0, 0] }
const idOk = (
  await fitTool.execute(
    { ...silFitArgs, silhouette: { ...silArgs, sha256: silSha, bytes: silBytes.length, camera: silCamera } },
    { fs: silFsOf(silBytes), session: { workspaceRoot: ws } },
  )
).structured
check(
  'silhouette identity: a declared sha256/bytes that matches the PNG is recorded, and the camera pose is carried through',
  (idOk.silhouette_blockers ?? []).length === 0 &&
    idOk.silhouette?.render?.declared_sha256_matches === true &&
    idOk.silhouette?.render?.sha256 === silSha &&
    idOk.silhouette?.camera?.name === 'Front',
  JSON.stringify({ render: idOk.silhouette?.render, camera: idOk.silhouette?.camera, codes: idOk.silhouette_blockers?.map((b) => b.code) }),
)
const idBad = (await fitTool.execute({ ...silFitArgs, silhouette: { ...silArgs, sha256: 'deadbeef'.repeat(8) } }, { fs: silFsOf(silBytes), session: { workspaceRoot: ws } })).structured
check(
  'silhouette identity: a sha256 that does not match BLOCKS (otherwise the numbers are about "a render", not the certified one)',
  idBad.verdict === 'revise' && idBad.silhouette_blockers?.some((b) => b.code === 'E_SILHOUETTE_IDENTITY_MISMATCH'),
  JSON.stringify({ verdict: idBad.verdict, codes: idBad.silhouette_blockers?.map((b) => b.code) }),
)
const idNone = (await fitTool.execute({ ...silFitArgs }, { fs: silFsOf(silBytes), session: { workspaceRoot: ws } })).structured
check(
  'silhouette identity: with nothing declared it is recorded as NOT DECLARED (null), never as a pass',
  idNone.silhouette?.render?.declared_sha256_matches === null && idNone.silhouette?.render?.sha256 === silSha,
  JSON.stringify(idNone.silhouette?.render),
)

// ---- 源图那一环：声明必须可核对（E_IMAGE_*）----
// （`createHash` 在文件开头已经 import 过了，这里不再重复声明 —— 刚才正是撞在这个重名上。）
const imgBytes = Buffer.from('a fake photograph — only the bytes matter to the digest', 'utf8')
const imgSha = createHash('sha256').update(imgBytes).digest('hex')
const completeSource = (sha) => ({ kind: 'generated_mesh', model: 'StdGEN', seed: 0, input_image_sha256: sha, unit: 'm', up_axis: 'Y', declared_height: 2 })
const imgArgs = (sha) => ({
  ...SAMPLE,
  assembly: [meshItem({ source: completeSource(sha) })],
  mesh_file: MESH_PATH_WIN,
  image_file: 'D:/ws/out/photo.png',
})
const imgFsOf = (withFile) => {
  const f = meshFs(makeGlb([0.2, 1, 0.2]))
  if (withFile) f.files.set('D:/ws/out/photo.png', imgBytes)
  return f
}
const imgOkFs = imgFsOf(true)
const imgOk = (await save.execute({ ...imgArgs(imgSha), run_id: 'img-ok' }, { fs: imgOkFs, session: { workspaceRoot: ws } })).structured
const imgOkReport = readReport(imgOkFs, 'img-ok')
check(
  'image: a declared input_image_sha256 that matches the file is accepted, and the source image joins the pack',
  imgOk.ok === true && imgOkReport.checks?.image?.computed === imgSha && imgOkReport.artifacts.some((a) => /photo\.png$/.test(String(a.path))),
  JSON.stringify({ ok: imgOk.ok, computed: String(imgOkReport.checks?.image?.computed).slice(0, 12), artifacts: imgOkReport.artifacts.map((a) => a.kind) }),
)
const imgBad = (await save.execute({ ...imgArgs('b'.repeat(64)), run_id: 'img-bad' }, { fs: imgFsOf(true), session: { workspaceRoot: ws } })).structured
check('image: a declared digest that does not match the file blocks the pack', imgBad.ok === false && imgBad.blockers.some((b) => b.code === 'E_IMAGE_SHA_MISMATCH'), JSON.stringify(imgBad.blockers.map((b) => b.code)))
const claimArgs = imgArgs(imgSha)
delete claimArgs.image_file
const imgClaim = (await save.execute({ ...claimArgs, run_id: 'img-claim' }, { fs: imgFsOf(false), session: { workspaceRoot: ws } })).structured
check(
  'image: a declared digest with no image_file is blocked — nothing could have checked it (the 64-a placeholder case)',
  imgClaim.ok === false && imgClaim.blockers.some((b) => b.code === 'E_IMAGE_NOT_VERIFIED'),
  JSON.stringify(imgClaim.blockers.map((b) => b.code)),
)
const imgMiss = (await save.execute({ ...imgArgs(imgSha), image_file: 'D:/ws/out/nope.png', run_id: 'img-miss' }, { fs: imgFsOf(false), session: { workspaceRoot: ws } })).structured
check(
  'image: an unreadable image_file blocks, because an unverifiable claim is worse than no claim',
  imgMiss.ok === false && imgMiss.blockers.some((b) => b.code === 'E_IMAGE_FILE_UNREADABLE'),
  JSON.stringify(imgMiss.blockers.map((b) => b.code)),
)
const imgFit = (await fitTool.execute({ ...imgArgs(imgSha), run_id: 'ignored' }, { fs: imgFsOf(true), session: { workspaceRoot: ws } })).structured
const imgFitBad = (await fitTool.execute({ ...imgArgs('c'.repeat(64)), run_id: 'ignored' }, { fs: imgFsOf(true), session: { workspaceRoot: ws } })).structured
check(
  'image: fit cannot reach "fit" on a wrong provenance claim (matching stays fit, wrong becomes revise)',
  imgFit.verdict === 'fit' && (imgFit.image_blockers ?? []).length === 0 && imgFit.image?.computed === imgSha && imgFitBad.verdict === 'revise' && imgFitBad.image_blockers.some((b) => b.code === 'E_IMAGE_SHA_MISMATCH'),
  JSON.stringify({ good: imgFit.verdict, bad: imgFitBad.verdict, codes: imgFitBad.image_blockers?.map((b) => b.code) }),
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
