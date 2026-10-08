/**
 * agh-ortho runtime — M1 骨架。
 *
 * 设计契约：../notes/CONTRACT.md（不在包内 —— 包内任何改动都会改 integrity）。
 *
 * 本文件目前只做两件事，且都是只读纯函数：
 *   agh_ortho_catalog   —— 回报**协商后**的下游能力面
 *   agh_ortho_emit_ops  —— 意图层参数 JSON → agh_blender_apply_ops 的 ops 批次
 *
 * 尚未实现（按 CONTRACT §11 的里程碑顺序）：analyze / fit / views / verify / save。
 * 六视图渲染器是下一步，它自己写正交投影 → SVG，不依赖下游（下游没有相机 op）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boxesFromOps, compareScene, expectedObjectsFromOps, extentsFromBoxes, extentsFromParams, placementOf } from './geometry.mjs'
import {
  ARTIFACT_ROOT_SEGMENTS,
  CONTRACT_VERSION,
  PRODUCER,
  RETENTION,
  listRuns,
  loadRun,
  newRunId,
  planRetention,
  writeRun,
} from './run.mjs'
import { VIEW_CONVENTION, commonScale, numericOutline, residual, sheetPlacement, sixViewRects, svgFor } from './views.mjs'

const EMITTER_VERSION = '0.1.0'

/**
 * numeric 档的盲区。**必须同时出现在工具结果和落盘的 verify.json 里** ——
 * 落盘那份才是长期可消费的，只写在返回值里等于在最该生效的地方失效。
 */
const VERIFY_CAVEATS = [
  'numeric proves geometric self-consistency only, not agreement with the original image',
  'the placement rule (placementOf) is shared by both paths, so a wrong placement rule cancels out and stays invisible to this check',
  'the u/v axis sense per view follows this plugin convention and has not been checked line by line against GB/T 17451',
]

/**
 * `scene_readback` 半档**能**断言的（名字如实，不冒充 against_blender）。
 * 它与 `numeric` 档的本质区别：本档第一次引入**外部事实**（下游场景），
 * 所以它能抓到 numeric 抓不到的东西 —— 例如"ops 发出了但下游没建出来"或"名字被占用改成了 .001"。
 * `size_asserted` 由下游是否发布 `dimensions` 决定，所以这一项必须是参数，不能写死。
 */
function sceneAsserts(sizeAsserted) {
  const base = [
    'every intended object exists under its exact name (Blender renames collisions to name.001, so a missing exact name is caught)',
    'type is MESH',
    'location equals the location we asked for, within 1e-6',
    'scale equals the scale we asked for, within 1e-6',
  ]
  if (sizeAsserted) {
    base.push('the final size in metres equals scale x size, within 1e-6 — dimensions ARE published by this downstream')
  }
  return base
}

/**
 * 本档**验不了**的。必须与"验到了什么"一样明确地报出去 —— 否则半档会被读成整档。
 * 这张表就是 notes/DOWNSTREAM-REQUEST-readback.md 那份请求的可复现理由。
 */
function sceneCannotAssert(sizeAsserted) {
  const out = []
  if (!sizeAsserted) {
    out.push('the final size in metres: scene.describe publishes no dimensions, so whether size=1 means a unit edge is still unverified')
  }
  out.push('the primitive kind beyond type=MESH: the downstream catalog publishes no per-kind vertex/face counts, so vertices/polygons are reported as evidence and not asserted')
  // 即使下游补上 dimensions，这一条也永远补不上 —— 所以它必须一直在这里，不能靠"以后再说"。
  out.push('agreement with the original photograph: that needs an orthographic render of the real scene, and the downstream has no camera op — so this tier can never become an image-level against_blender comparison')
  return out
}

// ---------------------------------------------------------------------------
// 平台约束 A：工具 schema 的每个节点都必须带 Symbol.for('TypeBox.Kind')。
// 手写节点缺标记 ⇒ Value.Check 抛 "Unknown type" ⇒ kernel 只回**无任何提示**的
// TOOL_ARGS_INVALID。这里的 tb() 抄自 agh-blender 并补了一支（见下）。
// ---------------------------------------------------------------------------
const TB_KIND = Symbol.for('TypeBox.Kind')

const TB_KINDS = {
  object: 'Object',
  array: 'Array',
  string: 'String',
  number: 'Number',
  integer: 'Integer',
  boolean: 'Boolean',
  null: 'Null',
}

// 我们不支持的分支组合：宁可在这里构造期就炸，也不要让它在调用期变成无提示的
// TOOL_ARGS_INVALID（约束 A 的整个教训就是"静默"最贵）。
const TB_UNSUPPORTED_BRANCHES = ['oneOf', 'allOf', 'not']

function tb(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  if (out.type === 'object' && out.properties === undefined) {
    // TypeBox 对没有 properties 的 object 节点会抛 "Cannot convert undefined or null to
    // object"。{ type: 'object' } 的意图是"任意对象" —— 把空 properties 写出来让校验能跑。
    out.properties = {}
  }
  const kind = typeof out.type === 'string' ? TB_KINDS[out.type] : undefined
  if (kind !== undefined && out[TB_KIND] === undefined) out[TB_KIND] = kind

  // ★ 相对 agh-blender 的 tb() 的补充支：联合节点没有 `type`，因此上面那行永远不会给
  //   它打标记，Value.Check 会抛 "Unknown type"。agh-blender 从不使用 anyOf，所以那支
  //   空档从未被触发；本插件的数值叶子必须同时接受标量 `{ v: 0 }` 与向量
  //   `{ v: [0,0,4.65] }`（CONTRACT §4.4），联合是绕不开的。
  //   实测（2026-10-08，packages/extension-api 的 @sinclair/typebox）：联合节点的
  //   Kind 值就是字符串 'Union'，且标量/向量都通过、错类型与多余键都被拒。
  if (Array.isArray(out.anyOf)) {
    if (out[TB_KIND] === undefined) out[TB_KIND] = 'Union'
    out.anyOf = out.anyOf.map(tb)
  } else if (out.anyOf !== undefined) {
    throw new Error('tb(): anyOf must be an array')
  }
  for (const branch of TB_UNSUPPORTED_BRANCHES) {
    if (out[branch] !== undefined)
      throw new Error(`tb(): "${branch}" is not marked by this pass; add a Kind rule before using it`)
  }
  if (node.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, tb(value)]),
    )
  }
  if (node.items !== undefined) out.items = tb(node.items)
  return out
}

// ---------------------------------------------------------------------------
// 输入 schema
// ---------------------------------------------------------------------------
// 服务 schema 的规则相反：ctx.services.register({ inputSchema, outputSchema }) 先走
// JCS(RFC 8785) 规范化，符号键被判非法 ⇒ extension factory failed ⇒ 整个插件加载不了。
// 本插件目前不注册服务；将来若注册，那两个 schema 必须是纯 JSON，不能过 tb()。

const EMPTY_INPUT = { type: 'object', properties: {}, required: [], additionalProperties: false }

// 数值叶子（CONTRACT §4.2）：一律 { v, conf?, min?, max? }，v 可以是标量或 3 维向量。
// assembly 里不允许出现裸数字。
const VALUE_LEAF = {
  type: 'object',
  properties: {
    v: {
      anyOf: [
        { type: 'number' },
        { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      ],
    },
    conf: { type: 'number', minimum: 0, maximum: 1 },
    min: { type: 'number' },
    max: { type: 'number' },
  },
  required: ['v'],
  additionalProperties: false,
}

const REPEAT_LEAF = {
  type: 'object',
  properties: {
    of: { type: 'string' },
    mode: { type: 'string' },
    axis: { type: 'string' },
    count: { type: 'integer', minimum: 1 },
    step: VALUE_LEAF,
  },
  required: ['of', 'mode'],
  additionalProperties: false,
}

const ASSEMBLY_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    feature: { type: 'string' },
    w: VALUE_LEAF,
    d: VALUE_LEAF,
    h: VALUE_LEAF,
    z: VALUE_LEAF,
    dia: VALUE_LEAF,
    pitch: VALUE_LEAF,
    at: VALUE_LEAF,
    repeat: REPEAT_LEAF,
  },
  required: ['id', 'feature'],
  additionalProperties: false,
}

const DECLARED_UNSUPPORTED = {
  type: 'object',
  properties: {
    feature: { type: 'string' },
    reason: { type: 'string' },
    pitch: VALUE_LEAF,
  },
  required: ['feature'],
  additionalProperties: false,
}

const EMIT_OPS_INPUT = {
  type: 'object',
  properties: {
    schema_version: { type: 'string' },
    unit: { type: 'string' },
    frame: {
      type: 'object',
      properties: {
        up: { type: 'string' },
        front: { type: 'string' },
        handed: { type: 'string' },
      },
      required: ['up', 'front', 'handed'],
      additionalProperties: false,
    },
    projection: { type: 'string' },
    scale_anchor: {
      type: 'object',
      properties: {
        pixel_len: { type: 'number' },
        real_len: { type: 'number' },
        ref: { type: 'string' },
      },
      required: ['pixel_len', 'real_len'],
      additionalProperties: false,
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    assembly: { type: 'array', items: ASSEMBLY_ITEM },
    unsupported: { type: 'array', items: DECLARED_UNSUPPORTED },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['schema_version', 'unit', 'projection', 'assembly'],
  additionalProperties: false,
}

// verify 的输入 = emit_ops 的输入 + 一个可选的"是否引入外部事实"开关。
const VERIFY_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    against_scene: { type: 'boolean' },
  },
  required: EMIT_OPS_INPUT.required,
  additionalProperties: false,
}

// save 的输入 = emit_ops 的输入 + 一个幂等键（上游契约 §5.3：同一 id 必须对应同一内容）。
const SAVE_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    run_id: { type: 'string' },
    // 产物包是交付物，所以它必须能记录**读回验证** —— 否则包里只有"我自洽"，
    // 而证明不了"下游照做了"，等于交付物比这一轮实际验过的少。
    against_scene: { type: 'boolean' },
  },
  required: EMIT_OPS_INPUT.required,
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// 能力协商层（CONTRACT §6）
// ---------------------------------------------------------------------------
// 绝不在代码里硬编码 PRIMITIVE_KINDS。今天只实现第 2/3 级来源：
//
//   1) ctx.tools.invoke('agh_blender_ops_catalog', {})   ← 尚未实现，见下
//   2) agh.capability.json（随包发布的能力表快照）
//   3) 内置 fallback
//
// 关于第 1 级：ctx.tools.invoke 确实存在（packages/core/src/effects/tool-context.ts），
// 但它是**嵌套工具调用** —— 走完整 approveAndExecute、占 turn 的 depth、要求处于 tools
// phase、目标工具必须在本轮已披露，且目标工具若需审批会 PARK。更要紧的是
// agh_blender_ops_catalog 需要一个**已启动的 Blender 实例**（它的 runCatalog 先取
// managedInstance），而 M1 的定位恰恰是"完全不依赖下游"。
// 所以第 1 级必须是*可选*来源，缺席是正常分支而不是异常路径。

const FALLBACK_LIMITS = {
  maxOpsPerBatch: 64,
  maxObjects: 512,
  sizeRange: '(0, 1000]',
  locationAbsMax: 10000,
  scaleRange: '(0, 10000]',
  nameCharset: 'A-Za-z0-9_-.',
  nameMaxLength: 96,
}

const FALLBACK_CAPABILITIES = {
  target: 'agh-blender@0.1.7',
  capabilitySet: 'primitives-6',
  primitives: ['cube', 'uv_sphere', 'cylinder', 'cone', 'torus', 'plane'],
  limits: FALLBACK_LIMITS,
  ops: [
    { name: 'mesh.primitive_add', mutates: false, destructive: false },
    { name: 'object.transform', mutates: true, destructive: false },
    { name: 'object.duplicate', mutates: false, destructive: false },
    { name: 'object.delete', mutates: true, destructive: true },
    { name: 'material.set', mutates: false, destructive: false },
    { name: 'material.assign', mutates: true, destructive: false },
    { name: 'object.join', mutates: true, destructive: true },
    { name: 'data.purge_unused', mutates: true, destructive: true },
    { name: 'file.checkpoint', mutates: false, destructive: false },
    { name: 'file.stage_export', mutates: false, destructive: false },
  ],
}

function readShippedCapability() {
  try {
    const text = readFileSync(new URL('./agh.capability.json', import.meta.url), 'utf8')
    return {
      value: JSON.parse(text),
      digest: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
      error: null,
    }
  } catch (error) {
    return { value: null, digest: null, error: String(error?.message ?? error) }
  }
}

/**
 * CONTRACT §6 的第 1 级来源：直接问下游的受管理实例。
 *
 * 三条**实测**约束决定了这段必须写成"失败即降级"：
 *  - `agh_blender_ops_catalog` **需要一个已启动的受管理实例**（`runCatalog` → `managedInstance`），
 *    没有实例时它返回 `{ ok:false, blockers:['no managed Blender instance ...'] }` ——
 *    所以"缺席"是**正常分支**，不是异常；
 *  - `ctx.tools.invoke` 是**嵌套工具调用**，失败一律**抛异常**而不是返回错误码
 *    （TOOL_NOT_FOUND / TOOL_ARGS_INVALID / E_RELATION / E_DEPTH_EXCEEDED / BUDGET_EXCEEDED；
 *    目标工具若需审批还会 PARK —— 见 core/src/step/reentry.ts 的 invokeTool）；
 *  - 目标工具必须在本轮**已披露**的工具集里。
 *
 * 所以这一层**永远不抛**：任何异常、任何非 ok、任何形状不对，都记下原因并退回第 2/3 级。
 */
async function negotiateFromDownstream(tctx) {
  const invoke = tctx?.tools?.invoke
  if (typeof invoke !== 'function') return { attempted: false, reason: 'no tools seam on this tool context' }
  let result
  try {
    result = await invoke('agh_blender_ops_catalog', {})
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : ''
    return { attempted: true, reason: `nested invoke failed (${code}${error?.message ?? error})` }
  }
  const report = result?.structured
  if (!report || report.ok !== true) {
    const why =
      Array.isArray(report?.blockers) && report.blockers.length
        ? report.blockers.join('; ')
        : 'the nested result carried no ok:true report'
    return { attempted: true, reason: `downstream answered without a catalog (${why})` }
  }
  const catalog = report.catalog
  if (!catalog || !catalog.limits || !catalog.ops) {
    return { attempted: true, reason: 'catalog payload lacks limits or ops' }
  }
  return { attempted: true, reason: null, catalog }
}

/**
 * `scene_readback` 半档要的外部事实：下游的场景读回。
 * 与能力协商同源：`agh_blender_scene` 是只读工具（never 审批），所以它可以被嵌套调用；
 * 而"没有受管理实例"和"调用失败"都是**正常分支**，一律不抛，只把原因报出来。
 */
async function readSceneForComparison(tctx) {
  const invoke = tctx?.tools?.invoke
  if (typeof invoke !== 'function') return { available: false, reason: 'no tools seam on this tool context' }
  let result
  try {
    result = await invoke('agh_blender_scene', {})
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : ''
    return { available: false, reason: `nested invoke failed (${code}${error?.message ?? error})` }
  }
  const report = result?.structured
  if (!report || report.ok !== true || !report.scene) {
    const why =
      Array.isArray(report?.blockers) && report.blockers.length
        ? report.blockers.join('; ')
        : 'the nested result carried no ok:true scene'
    return { available: false, reason: `downstream answered without a scene (${why})` }
  }
  return { available: true, reason: null, scene: report.scene }
}

/**
 * 下游 catalog → 本插件的能力面。这是**唯一**做形状转换的地方。
 * 下游的 `ops` 是**字典**（按 op 名索引，带 mutates/destructive/summary/args），我们内部用列表。
 * 下游**没有** `primitives` 列表、也**没有** capabilitySet 标识 —— 这是已知缺口
 * （见 notes/DOWNSTREAM-REQUEST-readback.md §1 记的第二条候选），所以这里如实给 null / 合成一个 id。
 */
function capabilitiesFromCatalog(catalog) {
  return {
    target: 'agh-blender@live',
    capabilitySet: `catalog-v${catalog.version ?? '?'}`,
    primitives: null,
    limits: catalog.limits,
    ops: Object.entries(catalog.ops).map(([name, spec]) => ({
      name,
      mutates: spec?.mutates === true,
      destructive: spec?.destructive === true,
      summary: typeof spec?.summary === 'string' ? spec.summary : null,
    })),
    errorCodes: catalog.errorCodes ?? null,
    downstreamNotes: Array.isArray(catalog.notes) ? catalog.notes : [],
  }
}

async function resolveTargetCapabilities(tctx) {
  const negotiated = await negotiateFromDownstream(tctx)
  if (negotiated.catalog) {
    return {
      acquisition: 'tool:agh_blender_ops_catalog',
      provenance: 'agh-blender（活实例，实时读取）',
      // 活实例读到的就是当下的真相 ⇒ 这里**不**标 stale。这是第 1 级相对第 2 级的实质好处。
      stale: false,
      staleReason: null,
      digest: null,
      negotiation: negotiated,
      ...capabilitiesFromCatalog(negotiated.catalog),
    }
  }
  const shipped = readShippedCapability()
  if (shipped.value) {
    // 两个"来源"是两个不同的轴，**不能混**：
    //   acquisition —— 这次能力是从*哪个渠道*取到的（tool / file / fallback），取值集合由本插件定义
    //   provenance  —— 那张表*记录的下游出处*（哪个文件、哪个包版本），由数据自己写
    // 混用会让"我这次是从哪来的"和"这份表说的是谁"互相覆盖。
    const { source: provenance, ...rest } = shipped.value
    return {
      acquisition: 'file:agh.capability.json',
      provenance: provenance ?? null,
      // 快照必然漂移：下游加 op 或改限额后它就过期。本插件不假装它新鲜。
      stale: true,
      staleReason: 'shipped snapshot; it cannot observe a downstream change by itself',
      digest: shipped.digest,
      negotiation: negotiated,
      ...rest,
    }
  }
  return {
    acquisition: 'fallback',
    provenance: null,
    stale: true,
    staleReason: `built-in fallback, not the real downstream${shipped.error ? `; agh.capability.json unreadable: ${shipped.error}` : ''}`,
    digest: null,
    negotiation: negotiated,
    ...FALLBACK_CAPABILITIES,
  }
}

// ---------------------------------------------------------------------------
// 三态 lowering（CONTRACT §5.1）
// ---------------------------------------------------------------------------
// M1 只 lower `slab` 与 `box`。其余意图分两种**必须区分**的原因：
//   no_downstream_op        —— 下游表达不了（等 M3/M4 扩下游）
//   not_implemented_in_m1   —— 下游能做，本 emitter 还没做
// 把两者混成一句 "unsupported" 会在 M3 扩下游时把"我还没实现"误读成"下游能力缺失"。

function leafNumber(item, key, blockers) {
  const leaf = item[key]
  if (!leaf || typeof leaf !== 'object' || typeof leaf.v !== 'number' || !Number.isFinite(leaf.v)) {
    blockers.push({
      code: 'E_ARG_MISSING',
      message: `"${item.id}"."${key}" must be a numeric leaf { v: number, conf?: 0..1, min?, max? }; CONTRACT §4.2 forbids a bare number in assembly`,
    })
    return null
  }
  return leaf.v
}

function buildSlab(item, name, blockers) {
  const w = leafNumber(item, 'w', blockers)
  const d = leafNumber(item, 'd', blockers)
  if (w === null || d === null) return []
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'plane', name, size: 1, scale: [w, d, 1], location: placementOf(item) },
    },
  ]
}

function buildBox(item, name, blockers) {
  const w = leafNumber(item, 'w', blockers)
  const d = leafNumber(item, 'd', blockers)
  const h = leafNumber(item, 'h', blockers)
  if (w === null || d === null || h === null) return []
  // 下游的 primitive_cube_add 把方块放在**中心**，所以 `at` 是中心；没有给 `at` 时
  // placementOf 退到"底面落地"（中心在 h/2），由 notes 显式报出去
  // （CONTRACT §4.2：假设必须列出来，不允许悄悄填值）。
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'cube', name, size: 1, scale: [w, d, h], location: placementOf(item, h) },
    },
  ]
}

const LOWERING = {
  slab: { status: 'exact', build: buildSlab },
  box: { status: 'exact', build: buildBox },
  sheet: {
    status: 'unsupported',
    reasonCode: 'not_implemented_in_m1',
    reason: 'downstream has plane; this emitter does not lower sheet yet',
  },
  column: {
    status: 'unsupported',
    reasonCode: 'not_implemented_in_m1',
    reason: 'downstream has cylinder; this emitter does not lower column yet',
  },
  ring: {
    status: 'unsupported',
    reasonCode: 'not_implemented_in_m1',
    reason: 'downstream has torus; this emitter does not lower ring yet',
  },
  dome: {
    status: 'unsupported',
    reasonCode: 'not_implemented_in_m1',
    reason: 'downstream has uv_sphere; the approx lowering is M2',
  },
  spire: {
    status: 'unsupported',
    reasonCode: 'not_implemented_in_m1',
    reason: 'downstream has cone; the approx lowering is M2',
  },
  'roof.gable': {
    status: 'unsupported',
    reasonCode: 'no_downstream_op',
    reason: 'no prism/boolean op downstream; a cone or a rotated cube could only approximate it',
  },
  prism: {
    status: 'unsupported',
    reasonCode: 'no_downstream_op',
    reason: 'no prism op downstream (M3: mesh.prism_add)',
  },
  extrude: {
    status: 'unsupported',
    reasonCode: 'no_downstream_op',
    reason: 'no 2D-profile extrude op downstream (M3: mesh.extrude_profile)',
  },
  opening: {
    status: 'unsupported',
    reasonCode: 'no_downstream_op',
    reason: 'no boolean op downstream (M4: mesh.boolean)',
  },
}

// 下游 name 字符集 A-Za-z0-9_-. ，长度 ≤ 96。approx 必须带 _approx 后缀自证
// （CONTRACT §5.1：不标的话，近似会 bake 进产物且没人知道当初糊过）。
const APPROX_SUFFIX = '_approx'

function objectName(id, status) {
  const budget = status === 'approx' ? 96 - APPROX_SUFFIX.length : 96
  const base = String(id).replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, budget) || 'unnamed'
  return status === 'approx' ? `${base}${APPROX_SUFFIX}` : base
}

function uniqueName(name, used) {
  let n = 2
  let candidate = `${name}_${n}`.slice(0, 96)
  while (used.has(candidate)) candidate = `${name}_${++n}`.slice(0, 96)
  return candidate
}

function emitOps(params, caps) {
  const blockers = []
  const notes = []
  const unlowered = []
  const usedNames = new Set()
  const ops = []

  if (params.unit !== 'm') {
    blockers.push({
      code: 'E_UNIT_NOT_METRE',
      message: `unit must be "m" (got ${JSON.stringify(params.unit)}): downstream caps size at 1000 and |location| at 10000, so millimetres turn into E_ARG_RANGE. Divide by 1000 and re-emit.`,
    })
  }
  if (params.projection !== 'first_angle' && params.projection !== 'third_angle') {
    blockers.push({
      code: 'E_PROJECTION_UNSET',
      message:
        'projection must be "first_angle" (GB/T 17451) or "third_angle" (ANSI): the two place the six views in opposite directions, so a parameter set without it cannot be read back into views.',
    })
  }

  const assembly = Array.isArray(params.assembly) ? params.assembly : []
  for (const [index, item] of assembly.entries()) {
    if (!item || typeof item !== 'object') {
      blockers.push({ code: 'E_ARG_TYPE', message: `assembly[${index}] must be an object` })
      continue
    }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `item_${index}`
    const feature = typeof item.feature === 'string' ? item.feature : ''
    const rule = Object.hasOwn(LOWERING, feature) ? LOWERING[feature] : null

    if (!rule) {
      unlowered.push({
        id,
        feature,
        reason_code: 'unknown_feature',
        reason: 'no entry for this intent feature; the vocabulary is CONTRACT §4.3',
      })
      continue
    }
    if (rule.status === 'unsupported') {
      unlowered.push({ id, feature, reason_code: rule.reasonCode, reason: rule.reason })
      continue
    }
    if (item.repeat !== undefined) {
      unlowered.push({
        id,
        feature,
        reason_code: 'undecided',
        reason:
          'repeat/array lowering is undecided (CONTRACT §13-2); emit the instances explicitly for now',
      })
      continue
    }

    let name = objectName(id, rule.status)
    if (usedNames.has(name)) {
      const renamed = uniqueName(name, usedNames)
      notes.push(`object name "${name}" was already used; this instance became "${renamed}"`)
      name = renamed
    }
    usedNames.add(name)

    const built = rule.build(item, name, blockers)
    if (built.length > 0 && !item.at) {
      const assumed =
        feature === 'box'
          ? `centre z = h/2 = ${((Number(item.h?.v) || 0) / 2).toFixed(3)}`
          : '落在 z = 0 平面'
      notes.push(
        `"${id}" had no "at", so its placement was assumed to be base-on-ground (${assumed}) — assert or override this`,
      )
    }
    for (const op of built) ops.push(op)
  }

  // 作者自己声明的 unsupported 必须一起传下去（CONTRACT §10：这张清单要一路到用户面前）。
  for (const [index, entry] of (Array.isArray(params.unsupported) ? params.unsupported : []).entries()) {
    if (!entry || typeof entry !== 'object') continue
    unlowered.push({
      id: typeof entry.feature === 'string' ? entry.feature : `declared_${index}`,
      feature: typeof entry.feature === 'string' ? entry.feature : '',
      reason_code: 'declared_by_parameter_file',
      reason: typeof entry.reason === 'string' ? entry.reason : 'declared unsupported by the parameter file',
      declared: true,
    })
  }

  // 限额一律来自协商层，不硬编码（CONTRACT §6）。
  const maxOpsPerBatch = caps?.limits?.maxOpsPerBatch ?? FALLBACK_LIMITS.maxOpsPerBatch
  const maxObjects = caps?.limits?.maxObjects ?? FALLBACK_LIMITS.maxObjects
  const nameMaxLength = caps?.limits?.nameMaxLength ?? FALLBACK_LIMITS.nameMaxLength

  // M1 只会产出 mesh.primitive_add，所以 op 数 == 新增对象数。将来加了 transform /
  // duplicate 之后这两者不再相等，那时要把对象数单独统计。
  const opCount = ops.length
  const batches = opCount === 0 ? 0 : Math.ceil(opCount / maxOpsPerBatch)

  if (opCount > maxObjects) {
    blockers.push({
      code: 'E_LIMIT_OBJECTS',
      message: `this batch would add ${opCount} objects but the target allows ${maxObjects}; split the model into stages`,
    })
  }
  for (const op of ops) {
    if (typeof op.args.name === 'string' && op.args.name.length > nameMaxLength) {
      blockers.push({
        code: 'E_LIMIT_NAME',
        message: `object name "${op.args.name}" exceeds ${nameMaxLength} characters`,
      })
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    notes,
    // —— CONTRACT §5.2 的输出契约 ——
    emitter_version: EMITTER_VERSION,
    // 这两行让产物可长期依赖：没有它们，参数文件就是一次性产物。
    target_capability_set: `${caps.target}:${caps.capabilitySet}`,
    capability_source: caps.acquisition,
    capability_provenance: caps.provenance ?? null,
    capability_stale: caps.stale === true,
    capability_digest: caps.digest,
    ops,
    op_count: opCount,
    batches,
    max_ops_per_batch: maxOpsPerBatch,
    unlowered,
    // —— 输入侧的坦白，原样带出 ——
    assumptions: Array.isArray(params.assumptions) ? params.assumptions : [],
    unresolved: Array.isArray(params.unresolved) ? params.unresolved : [],
  }
}

// ---------------------------------------------------------------------------
// 落盘：把一个 run 的全部产物算出来（纯计算，不碰 fs）
// ---------------------------------------------------------------------------
async function assembleArtifacts(args, createdAt, tctx) {
  const caps = await resolveTargetCapabilities(tctx)
  const emission = emitOps(args, caps)
  const boxes = boxesFromOps(emission.ops)
  const views = sixViewRects(boxes)
  const placement = sheetPlacement(args.projection)
  const scale = commonScale(views)
  const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [])
  const aligned = fromParams.length === boxes.length
  const checked = aligned
    ? residual(fromParams, views, boxes)
    : { max: Infinity, worst: 'parameter/ops list misalignment', rows: [] }

  // ⑤ 读回验证：save 也支持它。产物包是**交付物**，不该比这一轮实际验过的少 ——
  // 没有这一块，包里只记录了"我自洽"，而证明不了"下游照做了、尺寸也对"。
  let scene = null
  if (args.against_scene === true) {
    const expected = expectedObjectsFromOps(emission.ops)
    const read = await readSceneForComparison(tctx)
    if (!read.available) {
      scene = {
        tier: 'scene_readback',
        available: false,
        reason: read.reason,
        note: 'the readback did NOT happen — do not read available:false as "the readback passed"',
      }
    } else {
      const comparison = compareScene(expected, read.scene)
      scene = {
        tier: 'scene_readback',
        available: true,
        ok: comparison.rows.length > 0 && comparison.missing.length === 0 && comparison.mismatched.length === 0,
        scene_name: read.scene.scene ?? null,
        objects_in_scene: Array.isArray(read.scene.objects) ? read.scene.objects.length : null,
        expected_objects: expected.length,
        matched: comparison.matched,
        missing: comparison.missing,
        mismatched: comparison.mismatched,
        extra_objects: comparison.extra_objects,
        size_asserted: comparison.size_asserted,
        dimensions_published: comparison.dimensions_published,
        rows: comparison.rows,
        asserts: sceneAsserts(comparison.size_asserted),
        cannot_assert: sceneCannotAssert(comparison.size_asserted),
      }
    }
  }

  const files = []
  for (const view of views) {
    const sheet = placement[view.id] ?? { col: 0, row: 0 }
    const uSpan = view.bbox ? view.bbox.u[1] - view.bbox.u[0] : 0
    const vSpan = view.bbox ? view.bbox.v[1] - view.bbox.v[0] : 0
    files.push({
      name: `${view.id}.svg`,
      text: svgFor(view, sheet, { scale }),
      // preview 是模型唯一必然读到的内容 —— 它必须承载语义，不能写"一张图"。
      preview: `${view.label}（${placement.convention}）：${view.names.length} 个对象；u 跨度 ${uSpan.toFixed(3)} m、v 跨度 ${vSpan.toFixed(3)} m；图纸格 col/row ${sheet.col}/${sheet.row}；与其余五视图共用比例尺`,
      meta: { view: view.id, sheet, u_span_m: uSpan, v_span_m: vSpan, shared_scale: scale, convention: VIEW_CONVENTION },
    })
  }
  files.push({
    name: 'parameters.json',
    // 落盘的必须是**意图层参数模型**，不能夹带 run_id / against_scene 这类工具控制字段 ——
    // 否则这份交付物喂不回 emit_ops / fit（additionalProperties:false 会拒）。
    text: `${JSON.stringify(intentParamsOf(args), null, 2)}\n`,
    preview: `参数模型（意图层）：${(args.assembly ?? []).length} 个 assembly 项、${(args.unsupported ?? []).length} 个声明 unsupported、${(args.unresolved ?? []).length} 个 unresolved；单位 ${args.unit}；投影 ${args.projection}；只含意图层字段，可直接作为 emit_ops / fit 的输入复现`,
    meta: { unit: args.unit, projection: args.projection, intent_only: true },
  })
  files.push({
    name: 'ops.json',
    text: `${JSON.stringify(emission, null, 2)}\n`,
    preview: `ops 批次：${emission.op_count} 个 op、${emission.batches} 批，目标 ${emission.target_capability_set}；${emission.unlowered.length} 项未 lower（见 unlowered 的原因码）`,
    meta: { op_count: emission.op_count, batches: emission.batches, target_capability_set: emission.target_capability_set },
  })
  files.push({
    name: 'verify.json',
    text: `${JSON.stringify({ tier: scene ? 'scene_readback' : 'numeric', needs_blender: Boolean(scene), alignment: aligned ? 'aligned' : 'misaligned', residual_max: checked.max, residual_tolerance: checked.tolerance, residual_within_tolerance: checked.within_tolerance, worst: checked.worst, object_count: fromParams.length, convention: VIEW_CONVENTION, caveats: VERIFY_CAVEATS, rows: checked.rows, scene }, null, 2)}\n`,
    preview: scene
      ? scene.available
        ? `两档校验。numeric：残差 max=${checked.max}，容差 ${checked.tolerance}，within=${checked.within_tolerance}（**不声称恰好为 0**）。scene_readback：${scene.matched}/${scene.expected_objects} match、missing ${scene.missing.length}、mismatched ${scene.mismatched.length}、size_asserted=${scene.size_asserted}`
        : `numeric 已给出；scene_readback **没有发生**（${scene.reason}）—— 不要把 available:false 读成通过`
      : `numeric 校验：残差 max=${checked.max}，容差 ${checked.tolerance}，判定 within=${checked.within_tolerance}（**不声称恰好为 0**）；${fromParams.length} 个对象 × 3 轴、每轴 4 张视图交叉一致；不需要 Blender`,
    meta: {
      tier: scene ? 'scene_readback' : 'numeric',
      residual_max: checked.max,
      residual_tolerance: checked.tolerance,
      scene_available: scene ? scene.available : null,
    },
  })

  return {
    files,
    ok: emission.ok && aligned && checked.within_tolerance && (!scene || (scene.available === true && scene.ok === true)),
    blockers: [
      ...emission.blockers,
      ...(aligned
        ? []
        : [
            {
              code: 'E_INTERNAL_ALIGNMENT',
              message: `parameter side sees ${fromParams.length} objects, emitted ops carry ${boxes.length}`,
            },
          ]),
    ],
    extra: {
      createdAt,
      tier: scene ? 'scene_readback' : 'numeric',
      residual_max: checked.max,
      residual_tolerance: checked.tolerance,
      residual_within_tolerance: checked.within_tolerance,
      // 交付物里要能一眼看出"读回到底发生了没有、对不对"
      scene_readback: scene
        ? {
            available: scene.available,
            reason: scene.reason ?? null,
            matched: scene.matched ?? null,
            expected: scene.expected_objects ?? null,
            missing: scene.missing ?? null,
            mismatched: scene.mismatched ?? null,
            size_asserted: scene.size_asserted ?? null,
          }
        : null,
      object_count: fromParams.length,
      unit: args.unit,
      projection: args.projection,
      capability_source: emission.capability_source,
      target_capability_set: emission.target_capability_set,
      assumptions: Array.isArray(args.assumptions) ? args.assumptions : [],
      // 降级误差必须一路传到最终用户面前（CONTRACT §10）：
      unlowered: emission.unlowered,
      unresolved: Array.isArray(args.unresolved) ? args.unresolved : [],
    },
  }
}

async function retentionPlan(fs, currentRunId) {
  const runs = await listRuns(fs)
  const plan = planRetention(runs, { currentRunId })
  return {
    policy: { maxRuns: RETENTION.maxRuns, maxAgeDays: RETENTION.maxAgeDays },
    runs_on_disk: runs.length,
    kept: plan.kept,
    would_prune: plan.wouldPrune,
    // 【实测】工具侧的 fs seam 只有 read / write / list / stat
    // （packages/core/src/effects/tool-context.ts 的 fs），**没有 rm**。
    // 契约 §7 说"谁删：生产方"，但本插件的工具面做不到删除 ⇒ 只出计划，不执行。
    cannot_delete_here:
      'the tool fs seam exposes read/write/list/stat only (no rm), so retention is planned but never executed by this plugin; delete outside the plugin, or the seam needs an rm',
  }
}

// ---------------------------------------------------------------------------
// fit：闭环里"便宜的那一半"
//
// 它是 M2 循环的**唯一入口** —— 收敛判定、三态清单、数值轮廓、修改指向一次给全。
// 为什么聚合、而不是让调用方自己串 4 个工具：每多一次工具调用就多一次嵌套的能力协商
// （一次到 Blender 的 HTTP 往返、外加一对可见事件）。一轮循环只该付一次这个代价。
// 它保持**只读、不落盘** —— 落盘归 agh_ortho_save，等循环收敛了再存。
// ---------------------------------------------------------------------------

const round6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * 意图层的字段名 —— 从 schema 直接推出来，所以将来**加一个真实参数字段**会自动进入产物，
 * 而任何工具控制字段（run_id / against_scene …）都不可能漏进去。
 *
 * 为什么必须是白名单：落盘的 parameters.json 必须是**意图层参数模型本身**，不能夹带工具管道。
 * 实测抓到过：第一轮的 parameters.json 里带着 run_id / against_scene，于是它既不是一份干净的
 * 参数文件，也**喂不回** emit_ops / fit（schema 是 additionalProperties:false，会被直接拒）。
 */
const INTENT_KEYS = Object.keys(EMIT_OPS_INPUT.properties)

/** 从工具参数里剥出纯意图层参数。 */
function intentParamsOf(args) {
  return Object.fromEntries(INTENT_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]))
}

// fit 的输入 = emit_ops 的输入 + 一个可选的"是否引入外部事实"开关。
const FIT_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    against_scene: { type: 'boolean' },
  },
  required: EMIT_OPS_INPUT.required,
  additionalProperties: false,
}

/** 已知的 blocker 码 → 可操作的下一步。比一句"参数错了"有用得多。 */
const BLOCKER_SUGGESTIONS = {
  E_UNIT_NOT_METRE: 'if you measured millimetres, divide every length by 1000 and set unit to "m"',
  E_PROJECTION_UNSET:
    'set projection to "first_angle" (GB/T 17451) or "third_angle" (ANSI) — the two place the views in opposite directions',
  E_LIMIT_OBJECTS: 'split the model into stages, or raise the limit after measuring it with agh_ortho_catalog',
  E_ARG_MISSING: 'that quantity is missing: give it a numeric leaf { v: <number>, conf: <0..1> }',
}

/** 逐条校验。**每一条都带 ok**，所以报告能指出"哪一条不过"，而不是一句"不合法"。 */
function validationReport(params, emission, caps) {
  const assembly = Array.isArray(params.assembly) ? params.assembly : []
  const ids = assembly.map((i) => i?.id).filter((v) => typeof v === 'string')
  const frame = params.frame
  const maxObjects = caps?.limits?.maxObjects
  const checks = []
  const add = (check, ok, detail) => checks.push({ check, ok: ok === true, detail: detail === undefined ? null : detail })
  add('schema_version stated', typeof params.schema_version === 'string' && params.schema_version.length > 0, params.schema_version ?? null)
  add('unit is metres', params.unit === 'm', params.unit ?? null)
  add('projection stated', params.projection === 'first_angle' || params.projection === 'third_angle', params.projection ?? null)
  add('assembly is a non-empty list', assembly.length > 0, assembly.length)
  add('every item has a string id', ids.length === assembly.length, `${ids.length}/${assembly.length}`)
  add('ids are unique', new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} duplicate(s)`)
  // 坐标系：本插件的投影写死 up=Z / front=-Y。声明成别的，等于六视图是错的。
  add(
    'frame is the Z-up / -Y-front one this plugin projects',
    !frame || (frame.up === 'Z' && frame.front === '-Y'),
    frame ?? 'absent (assumed Z-up / -Y-front)',
  )
  add(
    'within the target object limit',
    typeof maxObjects !== 'number' || emission.op_count <= maxObjects,
    `${emission.op_count}/${maxObjects ?? '?'}`,
  )
  return { ok: checks.every((c) => c.ok), failed: checks.filter((c) => !c.ok).map((c) => c.check), checks }
}

/**
 * 三态清单。**"下游做不到"与"我还没做"必须分开** —— 问题不同、修法也不同：
 * 前者只能删掉或声明为缺口；后者等 emitter 自己的 lowering。
 */
function threeState(emission) {
  const un = emission.unlowered ?? []
  const pick = (code) => un.filter((u) => u.reason_code === code).map((u) => ({ id: u.id, feature: u.feature, reason: u.reason }))
  return {
    lowered_op_count: emission.op_count,
    // 本版 emitter 里哪些规则是 approx —— 从**表里推**出来，不是写死的数字。
    approx_rules_in_this_emitter: Object.entries(LOWERING)
      .filter(([, r]) => r.status === 'approx')
      .map(([f]) => f),
    emitter_ready_features: Object.entries(LOWERING)
      .filter(([, r]) => r.status !== 'unsupported')
      .map(([f]) => f),
    unlowered_total: un.length,
    downstream_cannot: pick('no_downstream_op'),
    emitter_not_yet: pick('not_implemented_in_m1'),
    declared_by_author: pick('declared_unsupported'),
    needs_attention: [...pick('unknown_feature'), ...pick('undecided')],
    note: 'downstream_cannot and emitter_not_yet are different problems with different fixes: keep them apart.',
  }
}

/** conf 是**声明的相对把握**，不是概率。如实标注，并按"最没把握"优先排序。 */
function declaredConfidence(params) {
  const assembly = Array.isArray(params.assembly) ? params.assembly : []
  const leaves = []
  let missing = 0
  for (const [i, item] of assembly.entries()) {
    if (!item || typeof item !== 'object') continue
    for (const key of ['w', 'd', 'h', 'z', 'dia', 'pitch', 'at']) {
      const leaf = item[key]
      if (!leaf || typeof leaf !== 'object') continue
      if (typeof leaf.conf === 'number') leaves.push({ where: `assembly[${i}].${key}`, id: item.id ?? null, conf: leaf.conf })
      else missing += 1
    }
  }
  return {
    warning:
      'conf is the model\'s DECLARED relative confidence, not a calibrated probability. Use it to rank (which size is least certain); never as a threshold — "conf > 0.8" does not mean 80% right.',
    declared: leaves.length,
    missing,
    least_certain_first: [...leaves].sort((a, b) => a.conf - b.conf).slice(0, 10),
  }
}

/** 绝对尺寸的唯一来源，以及它的脆弱性。没有锚点时，每一个"米"其实都只是比例。 */
function anchorReport(params) {
  const a = params.scale_anchor
  const ratiosOnly = Array.isArray(params.assumptions) && params.assumptions.includes('proportions_only')
  if (!a || typeof a.pixel_len !== 'number' || typeof a.real_len !== 'number' || a.pixel_len === 0) {
    return {
      present: false,
      declared_ratios_only: ratiosOnly,
      consequence: 'every metre in this file is really a RATIO until a scale_anchor grounds it',
      how_to_fix:
        'name a length you know in the photo (a standard door is about 2.1 m) and give its pixel_len and real_len',
    }
  }
  return {
    present: true,
    ref: a.ref ?? null,
    pixel_len: a.pixel_len,
    real_len: a.real_len,
    metres_per_pixel: round6(a.real_len / a.pixel_len),
    fragility:
      'all absolute sizes scale with this one ratio: misidentify ref, or misread pixel_len by 10%, and EVERY size is off by 10%',
  }
}

/**
 * 生成"改哪里"的具体指向 —— **这是闭环能收敛的关键**。
 * 报告只说"不合理"的话，模型只能重猜，循环就退化成随机游走。
 *
 * severity 两档：blocking（不修就不能进下一步）／ warning（值得处理但不挡路）。
 *
 * 特别地：内部不一致类的 hint 会明确写"**不要靠调参数去凑**"。那说明是代码的 bug；
 * 调参数只会为了迎合一个出错的现场，把本来正确的模型改歪。
 */
function reviseHints(params, emission, caps, { checked, aligned, fromParams }) {
  const hints = []
  const add = (severity, where, problem, suggestion, evidence) => {
    const hint = { severity, where, problem, suggestion }
    if (evidence !== undefined) hint.evidence = evidence
    hints.push(hint)
  }

  for (const b of emission.blockers) {
    add('blocking', 'parameters', b.message, BLOCKER_SUGGESTIONS[b.code] ?? 'fix the quantity named in the message', b.code)
  }

  const assembly = Array.isArray(params.assembly) ? params.assembly : []
  for (const [i, item] of assembly.entries()) {
    if (!item || typeof item !== 'object') continue
    const at = `assembly[${i}] (${item.id ?? '?'})`
    for (const key of ['w', 'd', 'h', 'z', 'dia', 'pitch', 'at']) {
      const leaf = item[key]
      if (!leaf || typeof leaf !== 'object') continue
      if (typeof leaf.conf !== 'number') {
        add('warning', `${at}.${key}.conf`, 'no confidence declared', 'declare a relative confidence so the least certain sizes can be seen first')
      } else if (leaf.conf < 0 || leaf.conf > 1) {
        add('blocking', `${at}.${key}.conf`, `conf=${leaf.conf} is outside [0,1]`, 'confidence is a fraction between 0 and 1')
      }
      if (typeof leaf.v === 'number' && typeof leaf.min === 'number' && leaf.v < leaf.min) {
        add('blocking', `${at}.${key}.v`, `v=${leaf.v} is below the declared min=${leaf.min}`, 'the leaf contradicts itself: fix v or fix min')
      }
      if (typeof leaf.v === 'number' && typeof leaf.max === 'number' && leaf.v > leaf.max) {
        add('blocking', `${at}.${key}.v`, `v=${leaf.v} is above the declared max=${leaf.max}`, 'the leaf contradicts itself: fix v or fix max')
      }
    }
  }

  const anchor = anchorReport(params)
  if (!anchor.present && !anchor.declared_ratios_only) {
    add(
      'blocking',
      'scale_anchor',
      'no scale_anchor, so every metre is really a ratio',
      `${anchor.how_to_fix}; or declare assumptions:["proportions_only"] if proportions are all you want`,
    )
  }

  for (const u of emission.unlowered) {
    if (u.reason_code === 'no_downstream_op') {
      add('warning', String(u.id), `the downstream cannot express "${u.feature}" (${u.reason})`, 'drop it, or declare it in unresolved[] so the gap reaches the reader instead of being silently lost')
    } else if (u.reason_code === 'not_implemented_in_m1') {
      add('warning', String(u.id), `this emitter cannot lower "${u.feature}" yet (${u.reason})`, 'drop it for now, or declare it in unresolved[]')
    } else if (u.reason_code === 'declared_unsupported') {
      add('warning', String(u.id), 'you declared this unsupported yourself', 'nothing to do — it is already reported')
    } else if (u.reason_code === 'undecided') {
      // repeat/array 这类"还没定"的情况：不是词汇表问题，也不该判 blocking。
      // （自检抓到过：它落到 else 分支，被报成"不在词汇表里"外加 blocking。）
      add('warning', String(u.id), `"${u.feature}" has no lowering rule for this shape yet (${u.reason})`, 'drop it, or declare it in unresolved[]')
    } else if (u.reason_code === 'unknown_feature') {
      add('blocking', String(u.id), `"${u.feature}" is not in the intent vocabulary`, 'use a feature name from the design contract')
    } else {
      // 真·未知原因码：响亮失败，别静默归到某一类。
      add('blocking', String(u.id), `unhandled unlowered reason "${u.reason_code}"`, 'this is a bug in the emitter: report it')
    }
  }

  // 内部不一致 —— 这些是**代码的 bug**，不是参数的错。说清楚，免得有人靠调参数去凑。
  if (!aligned) {
    add('blocking', 'assembly', `the parameter side sees ${fromParams.length} objects but the ops carry a different count`, 'this is an internal inconsistency: report it, do NOT tune the parameters to hide it')
  }
  if (Number.isFinite(checked.max) && !checked.within_tolerance) {
    for (const row of (checked.rows ?? []).filter((r) => r.delta !== 0 && r.delta !== null)) {
      add('blocking', `${row.object}.${row.axis}`, `the views disagree with the parameters by ${row.delta}, which is beyond the ${checked.tolerance} tolerance`, 'this is an internal inconsistency: report it, do NOT tune the parameters to hide it', row.from_params ?? null)
    }
  }

  const maxObjects = caps?.limits?.maxObjects
  if (typeof maxObjects === 'number' && emission.op_count > maxObjects) {
    add('blocking', 'assembly', `${emission.op_count} objects exceeds the target limit of ${maxObjects}`, 'split the model, or raise the limit after measuring it with agh_ortho_catalog')
  }

  const blocking = hints.filter((h) => h.severity === 'blocking').length
  return { hints, blocking, warning: hints.length - blocking }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
export const runtime = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()

    // 约束 D：返回值必须是纯 JSON 能表达的值。变更型工具的结果一旦被判非法会被替换成
    // TOOL_OUTCOME_UNKNOWN（结果与失败原因一起永久丢失）。本文件的两个工具都是只读，
    // 但仍然过一遍 jsonSafe，免得将来某次改动忘了。
    const jsonSafe = (value) => JSON.parse(JSON.stringify(value))

    const respond = (payload) => ({
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structured: jsonSafe(payload),
    })

    // 每个注册的工具 schema 都过 tb()，手写节点不可能带着未标记的状态到达 kernel。
    const registerTool = (definition) =>
      agnes.registerTool({ ...definition, parameters: tb(definition.parameters) })

    // 约束 B/L：8 个 meta 键必须全部显式给出（Object.hasOwn 检查）。
    // deferLoading 是 required key，类型 boolean | undefined —— undefined 也要写出来。
    // 约束 K：isReadOnly 与 isDestructive 不能同时为真；costHint 只允许 credits / wallMs。
    // CONTRACT §7.2：emit_ops 只算不写 ⇒ 纯函数、isReadOnly、可 safe 重放、零审批。
    const READ_ONLY_META = {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: { wallMs: 1000 },
      deferLoading: false,
      requiresApproval: 'never',
    }

    registerTool({
      name: 'agh_ortho_catalog',
      description:
        '只读。回报**协商后**的下游能力面：op 白名单（含每个 op 的 mutates/destructive）、限额、基元种类，以及这份能力**从哪个渠道取到**（acquisition：tool / file / fallback）与是否可能过期（stale）。**在拼 ops 批次之前先调它**，不要凭记忆猜参数名、限额或单位。三级来源：① 向下游在线取（需要已启动的受管理 Blender 实例，且目标工具在本轮已披露）—— 取到的是实时目录，因此不标 stale；② 随包发布的能力表快照 —— 必然漂移，标 stale；③ 内置兜底。**缺席与失败都是正常分支**：会被降级并在 negotiation.reason 里记下原因，不抛错。sources 里的每一级都报告 inUse，而不是写死的可用性。',
      parameters: EMPTY_INPUT,
      meta: READ_ONLY_META,
      async execute(_args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const payload = {
          ok: true,
          negotiated: caps,
          // 三态 lowering 的当前覆盖面：先让调用方知道哪些意图现在还落不下去。
          emitter: {
            version: EMITTER_VERSION,
            lowerable: Object.entries(LOWERING)
              .filter(([, rule]) => rule.status !== 'unsupported')
              .map(([feature]) => feature),
            notYetLowered: Object.entries(LOWERING)
              .filter(([, rule]) => rule.status === 'unsupported')
              .map(([feature, rule]) => ({ feature, reason_code: rule.reasonCode, reason: rule.reason })),
            unitPolicy: 'all positions and sizes are metres; unit "m" is enforced by agh_ortho_emit_ops',
          },
          // 每一级的**可用性必须来自事实**，不能硬编码：硬写的"未接通"在接通之后会变成载荷里的
          // 假话，而模型会忠实转述它。这次的会话实测就抓到了这一点 —— 同一份载荷里
          // acquisition 已经是 tool:agh_blender_ops_catalog，而 sources.tool.available 还写着 false。
          sources: {
            tool: {
              inUse: caps.acquisition === 'tool:agh_blender_ops_catalog',
              attempted: caps.negotiation?.attempted === true,
              reason: caps.negotiation?.reason ?? null,
            },
            file: {
              inUse: caps.acquisition === 'file:agh.capability.json',
              path: 'extensions/main/agh.capability.json',
            },
            fallback: { inUse: caps.acquisition === 'fallback' },
          },
          blockers: [],
        }
        return respond(payload)
      },
    })

    registerTool({
      name: 'agh_ortho_emit_ops',
      description:
        '只读、纯函数。把**意图层**参数 JSON lowering 成可以直接塞进 agh_blender_apply_ops 的 ops 数组：本工具自己不写任何东西 —— 真正写场景由调用方交给下游的 agh_blender_apply_ops（它已是 always 审批）。它读的是协商层给出的能力面，而协商层为了拿到实时能力可能向下游做一次**只读的嵌套调用**（agh_blender_ops_catalog）—— 那一步是失败即降级的，缺席不会让本工具失败。写出 emitter_version 与 target_capability_set，使产物可长期依赖。落不下去的意图进 unlowered[]，并区分 "下游表达不了" 与 "本 emitter 还没做" 两种原因 —— 这个区分必须一路传到用户面前。单位必须是米（mm 会爆 E_ARG_RANGE）。',
      parameters: EMIT_OPS_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        return respond(emitOps(args, await resolveTargetCapabilities(tctx)))
      },
    })

    registerTool({
      name: 'agh_ortho_views',
      description:
        '只读、纯函数、**不落盘**。把参数 JSON 渲染成正交六视图的 SVG（主视图/俯视图/左视图/右视图/仰视图/后视图），并给出第一角法或第三角法的图面排布。下游没有相机 op，严格正交六视图下游给不了，所以这里自己算正交投影 —— 零依赖。SVG 是文本，因此**模型可以直接读视图几何**：工具产出的图片像素进不了模型，文本可以。M1 只返回文本；"落盘 + 描述符（run-uuid / report.json / 幂等 / 清理）"归 agh_ortho_save。',
      parameters: EMIT_OPS_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const emission = emitOps(args, caps)
        const boxes = boxesFromOps(emission.ops)
        const views = sixViewRects(boxes)
        const placement = sheetPlacement(args.projection)
        // 六个视图共用比例尺：逐视图各自缩放在工程图上是错的。
        const scale = commonScale(views)
        const svgs = views.map((view) => {
          const sheet = placement[view.id] ?? { col: 0, row: 0 }
          const svg = svgFor(view, sheet, { scale })
          return {
            view: view.id,
            label: view.label,
            sheet,
            bytes: Buffer.byteLength(svg, 'utf8'),
            sha256: createHash('sha256').update(svg, 'utf8').digest('hex'),
            svg,
          }
        })
        const payload = {
          ok: emission.ok,
          blockers: emission.blockers,
          convention: VIEW_CONVENTION,
          projection: args.projection,
          sheet: placement,
          target_capability_set: emission.target_capability_set,
          capability_source: emission.capability_source,
          object_count: boxes.length,
          svgs,
          unlowered: emission.unlowered,
          unresolved: emission.unresolved,
          delivered_as: 'inline text (M1): no files, therefore no descriptors and no approval',
        }
        // 文本结果只放摘要，SVG 放 structured（进模型），避免同一份内容进两次上下文。
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: payload.ok,
                  blockers: payload.blockers,
                  projection: payload.projection,
                  sheet: payload.sheet,
                  target_capability_set: payload.target_capability_set,
                  object_count: payload.object_count,
                  views: svgs.map((s) => ({ view: s.view, sheet: s.sheet, bytes: s.bytes, sha256: s.sha256 })),
                  unlowered: payload.unlowered,
                  unresolved: payload.unresolved,
                  note: 'six SVG documents are in the structured payload, one per view',
                },
                null,
                2,
              ),
            },
          ],
          structured: jsonSafe(payload),
        }
      },
    })

    registerTool({
      name: 'agh_ortho_verify',
      description:
        '只读、纯函数。numeric 档校验（CONTRACT §9）：参数 → ops → 包围盒 → 六视图 → **从视图反解** → 与参数比对，残差必须为 0，且同一个轴被 4 张视图观测、4 个观测值必须彼此相等。走的是两条**独立路径**：一侧直接读参数叶子，另一侧读 lowering 产出的 ops —— 共用一条路径的话校验就是同义反复。**不需要 Blender**，这就是"扩下游之前就能交付价值"的关键解耦。它只证明几何自洽，不证明几何与真实照片一致。传 against_scene:true 会再跑一档 **scene_readback**（半档，名字如实）：向下游读一次场景（agh_blender_scene，只读、无需审批），比对"我打算创建的对象"是否按**确切名字**存在、类型是 MESH、location 与 scale 与我们发出的 ops 一致 —— 这是本插件第一次引入外部事实，因此能抓到 numeric 抓不到的"ops 发了但下游没建出来 / 名字被占用改成了 .001"。它**验不了**最终尺寸（下游不发布 dimensions）与基元种类（catalog 不发布每类顶点/面数）；这两条会在返回里逐条列在 cannot_assert 里，因为"验不了什么"必须和"验到了什么"一样明确。缺实例或读不到场景时不会抛错，会报 E_SCENE_UNAVAILABLE 并明确说明**本档没有发生**，不要把 available:false 读成通过。',
      parameters: VERIFY_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const emission = emitOps(args, caps)
        const boxes = boxesFromOps(emission.ops)
        const views = sixViewRects(boxes)
        const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [])
        const fromOps = extentsFromBoxes(boxes)
        const aligned = fromParams.length === fromOps.length
        const checked = aligned
          ? residual(fromParams, views, boxes)
          : { max: Infinity, worst: 'parameter/ops list misalignment', rows: [] }
        const blockers = [...emission.blockers]
        if (!aligned) {
          blockers.push({
            code: 'E_INTERNAL_ALIGNMENT',
            message: `the parameter side sees ${fromParams.length} objects but the emitted ops carry ${fromOps.length}; lowering and parameter reading disagree about which items are buildable`,
          })
        }
        const numericOk = emission.ok && aligned && checked.within_tolerance
        const numeric = {
          blockers,
          tier: 'numeric',
          needs_blender: false,
          alignment: aligned ? 'aligned' : 'misaligned',
          residual_max: checked.max,
          residual_tolerance: checked.tolerance,
          residual_within_tolerance: checked.within_tolerance,
          worst: checked.worst,
          object_count: fromParams.length,
          views_per_axis: 4,
          convention: VIEW_CONVENTION,
          rows: checked.rows,
          caveats: VERIFY_CAVEATS,
        }
        // 默认只跑 numeric 档；against_scene 才引入外部事实（需要一个已启动的受管理实例）。
        if (args.against_scene !== true) return respond({ ok: numericOk, ...numeric })

        const expected = expectedObjectsFromOps(emission.ops)
        const read = await readSceneForComparison(tctx)
        if (!read.available) {
          return respond({
            ok: false,
            ...numeric,
            blockers: [
              ...blockers,
              { code: 'E_SCENE_UNAVAILABLE', message: `against_scene was asked for, but the scene could not be read: ${read.reason}` },
            ],
            scene: {
              tier: 'scene_readback',
              available: false,
              reason: read.reason,
              note: 'numeric 的结果仍然有效并已给出；本档**没有发生** —— 不要把 available:false 读成"读回通过了"。',
              asserts: sceneAsserts(false),
              cannot_assert: sceneCannotAssert(false),
            },
          })
        }
        const comparison = compareScene(expected, read.scene)
        const sceneOk = comparison.rows.length > 0 && comparison.missing.length === 0 && comparison.mismatched.length === 0
        return respond({
          ok: numericOk && sceneOk,
          ...numeric,
          // 有外部事实参与时 tier 如实写 scene_readback，**不写 against_blender**：
          // 尺寸语义仍然验不了（下游不发布 dimensions），所以它还够不上契约里那一档。
          tier: 'scene_readback',
          needs_blender: true,
          scene: {
            tier: 'scene_readback',
            available: true,
            reason: null,
            scene_name: read.scene.scene ?? null,
            objects_in_scene: Array.isArray(read.scene.objects) ? read.scene.objects.length : null,
            expected_objects: expected.length,
            matched: comparison.matched,
            missing: comparison.missing,
            mismatched: comparison.mismatched,
            extra_objects: comparison.extra_objects,
            rows: comparison.rows,
            // 尺寸语义到底验没验 —— 显式给出来，不靠读者推断。
            size_asserted: comparison.size_asserted,
            dimensions_published: comparison.dimensions_published,
            asserts: sceneAsserts(comparison.size_asserted),
            cannot_assert: sceneCannotAssert(comparison.size_asserted),
            upgrade_path: comparison.size_asserted
              ? 'the size assertion is now active because this downstream publishes dimensions; the only remaining gap toward an image-level comparison is the downstream camera op (see cannot_assert)'
              : 'when agh-blender publishes per-object dimensions from scene.describe, this same comparison gains the size assertion — see notes/DOWNSTREAM-REQUEST-readback.md',
          },
        })
      },
    })

    registerTool({
      name: 'agh_ortho_fit',
      // 闭环里"便宜的那一半"的入口。它把一份候选参数变成**可审计的结论 + 该改哪里**，
      // 一次调用给全，让一轮迭代只付一次嵌套协商的代价。只读、不落盘 —— 落盘归 save。
      description:
        '只读、纯函数、**不落盘**。把一份候选参数 JSON 变成一份**可审计的结论**，并明确告诉你**该改哪里**。一次调用给出：逐条 validation（每条都带 ok）、三态清单（区分"下游做不到"与"我还没做"）、numeric 自洽（残差必须为 0）、六视图的**数值轮廓**（outline，供你拿照片做粗核对 —— 你看见用户上传的照片，看不见工具产出的图像素）、六张 SVG、conf 的如实标注、scale_anchor 的换算与脆弱性、以及逐项逐轴的 revise_hints。verdict 为 fit 时才进下一步：apply_ops 建模，再用 against_scene:true 跑一次做读回比对。**边界说清楚**：numeric 与读回只证明"我自洽、下游照做了"，**都不证明与照片一致** —— 那一段只能靠你拿 outline 和照片比，加上人的眼睛。',
      parameters: FIT_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const emission = emitOps(args, caps)
        const boxes = boxesFromOps(emission.ops)
        const views = sixViewRects(boxes)
        const placement = sheetPlacement(args.projection)
        const scale = commonScale(views)
        const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [])
        const fromOps = extentsFromBoxes(boxes)
        const aligned = fromParams.length === fromOps.length
        const checked = aligned
          ? residual(fromParams, views, boxes)
          : { max: Infinity, worst: 'parameter/ops list misalignment', rows: [] }
        const numericOk = emission.ok && aligned && checked.within_tolerance
        const revise = reviseHints(args, emission, caps, { checked, aligned, fromParams })
        const validation = validationReport(args, emission, caps)
        const verdict = numericOk && validation.ok && revise.blocking === 0 ? 'fit' : 'revise'

        const payload = {
          ok: verdict === 'fit',
          verdict,
          revise_summary: { blocking: revise.blocking, warning: revise.warning },
          revise_hints: revise.hints,
          validation,
          three_state: threeState(emission),
          numeric: {
            residual_max: checked.max,
            residual_tolerance: checked.tolerance,
            residual_within_tolerance: checked.within_tolerance,
            alignment: aligned ? 'aligned' : 'misaligned',
            object_count: fromParams.length,
            views_per_axis: 4,
            convention: VIEW_CONVENTION,
            rows: checked.rows,
            caveats: VERIFY_CAVEATS,
          },
          outline: numericOutline(views).map((o) => ({ ...o, sheet: placement[o.view] ?? null })),
          declared_relative_confidence: declaredConfidence(args),
          anchor: anchorReport(args),
          target_capability_set: emission.target_capability_set,
          capability_source: emission.capability_source,
          // 必须带上 ops：否则调用方为了拿到它还得再调一次 emit_ops，就多付一次嵌套协商，
          // "一轮只付一次"的聚合意义就没了。verdict 为 fit 时它就是要喂给 apply_ops 的东西。
          ops: emission.ops,
          op_count: emission.op_count,
          batches: emission.batches,
          blockers: emission.blockers,
          unresolved: args.unresolved ?? [],
          next:
            verdict === 'fit'
              ? 'compare outline (and the SVGs) against the photo, then apply the ops and re-run fit with against_scene:true for the readback check'
              : 'act on revise_hints: each one names the exact item and axis. Change nothing else in the same round.',
          views: views.map((view) => {
            const sheet = placement[view.id] ?? { col: 0, row: 0 }
            return { view: view.id, label: view.label, sheet, svg: svgFor(view, sheet, { scale }) }
          }),
          caveats: [
            'numeric and the readback prove self-consistency, and that the downstream obeyed — neither proves agreement with the photograph',
            'outline is a coarse, human-grade shape check (proportions, mass count, size ordering), not a measurement',
          ],
        }

        if (args.against_scene !== true) return respond(payload)

        const expected = expectedObjectsFromOps(emission.ops)
        const read = await readSceneForComparison(tctx)
        if (!read.available) {
          return respond({
            ...payload,
            ok: false,
            blockers: [
              ...emission.blockers,
              { code: 'E_SCENE_UNAVAILABLE', message: `against_scene was asked for, but the scene could not be read: ${read.reason}` },
            ],
            scene: {
              tier: 'scene_readback',
              available: false,
              reason: read.reason,
              note: 'the readback did NOT happen — do not read available:false as "the readback passed"',
              asserts: sceneAsserts(false),
              cannot_assert: sceneCannotAssert(false),
            },
          })
        }
        const comparison = compareScene(expected, read.scene)
        const sceneOk = comparison.rows.length > 0 && comparison.missing.length === 0 && comparison.mismatched.length === 0
        return respond({
          ...payload,
          ok: verdict === 'fit' && sceneOk,
          scene: {
            tier: 'scene_readback',
            available: true,
            reason: null,
            scene_name: read.scene.scene ?? null,
            objects_in_scene: Array.isArray(read.scene.objects) ? read.scene.objects.length : null,
            expected_objects: expected.length,
            matched: comparison.matched,
            missing: comparison.missing,
            mismatched: comparison.mismatched,
            extra_objects: comparison.extra_objects,
            rows: comparison.rows,
            size_asserted: comparison.size_asserted,
            dimensions_published: comparison.dimensions_published,
            asserts: sceneAsserts(comparison.size_asserted),
            cannot_assert: sceneCannotAssert(comparison.size_asserted),
            // 归因纪律：⑤ 失败时先判**哪一侧错了**，再决定改什么。
            attribution:
              'if a row mismatches, decide WHICH side is wrong first: our ops disagreeing with our parameters is a bug in this plugin; the scene disagreeing with our ops means the downstream did not obey. Changing the parameters to match a wrong scene corrupts a correct model.',
          },
        })
      },
    })

    registerTool({
      name: 'agh_ortho_save',
      // 这是本插件唯一的**变更型**工具。因此它必须遵守上游契约 §5.2：
      // 先把 report.json 落到磁盘再返回 —— 变更型工具的结果一旦被判非法会被替换成
      // TOOL_OUTCOME_UNKNOWN，结果与失败原因会**一起永久丢失**；返回值只是"方便读的副本"。
      description:
        '这是本插件唯一会写盘的工具，因此 requiresApproval=always。把一个 run 的全部产物落到工作区的 .agnes/agh-ortho/runs/<run-id>/：六个视图 SVG、参数 JSON、ops 批次、numeric 校验结果，外加 marker.json 与 report.json（描述符数组，依据 agh-blender/docs/UPSTREAM-ARTIFACT-CONTRACT.md）。**先落盘报告再返回**：消费者应以磁盘上的 report.json 为准，不以返回值或转述为准。传同一个 run_id 再调一次是幂等的 —— 直接返回已落盘的描述符，不重新生成。每个描述符都带一句实质 preview，因为模型看不到图片像素，preview 是它唯一必然能读到的内容。',
      parameters: SAVE_INPUT,
      meta: {
        isReadOnly: false,
        isDestructive: false,
        // 同一个 run 目录并发写入会互相覆盖。
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 5000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const fs = tctx?.fs
        if (!fs || typeof fs.write !== 'function') {
          return respond({
            ok: false,
            blockers: [
              {
                code: 'E_NO_FS',
                message:
                  'this tool context has no workspace file seam; agh_ortho_save needs tctx.fs (read/write/list/stat)',
              },
            ],
          })
        }
        const runId =
          typeof args.run_id === 'string' && args.run_id.length > 0 ? args.run_id : newRunId()
        const workspaceRoot =
          typeof tctx?.session?.workspaceRoot === 'string' && tctx.session.workspaceRoot.length > 0
            ? tctx.session.workspaceRoot
            : '.'
        const absolute = (name) => join(workspaceRoot, ...ARTIFACT_ROOT_SEGMENTS, runId, name)

        // §6：吃/写一个产物之前先做归属校验，避免"读到别的运行留下的东西"。
        const existing = await loadRun(fs, runId)
        if (existing.marker && !existing.owned) {
          return respond({
            ok: false,
            run_id: runId,
            blockers: [
              {
                code: 'E_RUN_NOT_OWNED',
                message: `${existing.reason}. Refusing to write into it. Pass a different run_id, or remove the directory if you know it is stale.`,
                marker: existing.marker,
              },
            ],
          })
        }
        if (existing.owned && existing.report) {
          // §5.3 幂等：同一 id 必须对应同一内容，不重新生成。
          return respond({
            ok: true,
            idempotent_replay: true,
            run_id: runId,
            report_path: absolute('report.json'),
            report_contract: existing.report.contract ?? null,
            artifacts: existing.report.artifacts ?? [],
            retention: await retentionPlan(fs, runId),
            note: 'this run already exists on disk; descriptors returned unchanged and nothing was regenerated',
          })
        }

        const assembled = await assembleArtifacts(args, new Date().toISOString(), tctx)
        const files = assembled.files.map((file) => ({ ...file, absolutePath: absolute(file.name) }))
        try {
          await writeRun(fs, {
            runId,
            createdAt: new Date().toISOString(),
            files,
            extra: assembled.extra,
          })
        } catch (error) {
          return respond({
            ok: false,
            run_id: runId,
            blockers: [
              {
                code: 'E_WRITE_FAILED',
                message: `writing the run failed: ${error?.message ?? error}. Nothing about this run can be trusted; re-run with a fresh run_id.`,
              },
            ],
          })
        }

        // 从磁盘读回来，而不是把内存里的那份当成权威。
        const written = await loadRun(fs, runId)
        return respond({
          ok: assembled.ok && written.report !== null,
          blockers: assembled.blockers,
          idempotent_replay: false,
          run_id: runId,
          producer: PRODUCER,
          report_contract: CONTRACT_VERSION,
          report_path: absolute('report.json'),
          marker_path: absolute('marker.json'),
          artifacts: written.report?.artifacts ?? [],
          retention: await retentionPlan(fs, runId),
          note: 'consumers must read report.json on disk: a mutating tool result can be replaced by TOOL_OUTCOME_UNKNOWN, and then the failure reason is lost with it',
        })
      },
    })
  },
}
