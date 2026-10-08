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
import { boxesFromOps, extentsFromBoxes, extentsFromParams, placementOf } from './geometry.mjs'
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
import { VIEW_CONVENTION, commonScale, residual, sheetPlacement, sixViewRects, svgFor } from './views.mjs'

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

// save 的输入 = emit_ops 的输入 + 一个幂等键（上游契约 §5.3：同一 id 必须对应同一内容）。
const SAVE_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    run_id: { type: 'string' },
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

function resolveTargetCapabilities() {
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
      ...rest,
    }
  }
  return {
    acquisition: 'fallback',
    provenance: null,
    stale: true,
    staleReason: `built-in fallback, not the real downstream${shipped.error ? `; agh.capability.json unreadable: ${shipped.error}` : ''}`,
    digest: null,
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
function assembleArtifacts(args, createdAt) {
  const caps = resolveTargetCapabilities()
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
    text: `${JSON.stringify(args, null, 2)}\n`,
    preview: `参数模型（意图层）：${(args.assembly ?? []).length} 个 assembly 项、${(args.unsupported ?? []).length} 个声明 unsupported、${(args.unresolved ?? []).length} 个 unresolved；单位 ${args.unit}；投影 ${args.projection}`,
    meta: { unit: args.unit, projection: args.projection },
  })
  files.push({
    name: 'ops.json',
    text: `${JSON.stringify(emission, null, 2)}\n`,
    preview: `ops 批次：${emission.op_count} 个 op、${emission.batches} 批，目标 ${emission.target_capability_set}；${emission.unlowered.length} 项未 lower（见 unlowered 的原因码）`,
    meta: { op_count: emission.op_count, batches: emission.batches, target_capability_set: emission.target_capability_set },
  })
  files.push({
    name: 'verify.json',
    text: `${JSON.stringify({ tier: 'numeric', needs_blender: false, alignment: aligned ? 'aligned' : 'misaligned', residual_max: checked.max, worst: checked.worst, object_count: fromParams.length, convention: VIEW_CONVENTION, caveats: VERIFY_CAVEATS, rows: checked.rows }, null, 2)}\n`,
    preview: `numeric 校验：残差 max=${checked.max}（必须为 0），${fromParams.length} 个对象 × 3 轴、每轴 4 张视图交叉一致；不需要 Blender`,
    meta: { tier: 'numeric', residual_max: checked.max, worst: checked.worst },
  })

  return {
    files,
    ok: emission.ok && aligned && checked.max === 0,
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
      tier: 'numeric',
      residual_max: checked.max,
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
        '只读。回报**协商后**的下游能力面：op 白名单（含每个 op 的 mutates/destructive）、限额、基元种类，以及这份能力是从哪来的（source）与是否可能过期（stale）。**在拼 ops 批次之前先调它**，不要凭记忆猜参数名、限额或单位。当前协商只用了随包发布的能力表快照与内置兜底；从下游工具在线取能力（需要一个已启动的 Blender）是下一步，缺席属于正常分支。',
      parameters: EMPTY_INPUT,
      meta: READ_ONLY_META,
      async execute() {
        const caps = resolveTargetCapabilities()
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
          sources: {
            tool: { available: false, why: 'not wired yet; needs a running Blender instance and a disclosed tool in this turn' },
            file: { available: caps.acquisition === 'file:agh.capability.json', path: 'extensions/main/agh.capability.json' },
            fallback: { available: true },
          },
          blockers: [],
        }
        return respond(payload)
      },
    })

    registerTool({
      name: 'agh_ortho_emit_ops',
      description:
        '只读、纯函数。把**意图层**参数 JSON lowering 成可以直接塞进 agh_blender_apply_ops 的 ops 数组：不做插件间调用，也不写任何东西 —— 真正写场景由调用方交给下游的 agh_blender_apply_ops（它已是 always 审批）。写出 emitter_version 与 target_capability_set，使产物可长期依赖。落不下去的意图进 unlowered[]，并区分 "下游表达不了" 与 "本 emitter 还没做" 两种原因 —— 这个区分必须一路传到用户面前。单位必须是米（mm 会爆 E_ARG_RANGE）。',
      parameters: EMIT_OPS_INPUT,
      meta: READ_ONLY_META,
      async execute(args) {
        return respond(emitOps(args, resolveTargetCapabilities()))
      },
    })

    registerTool({
      name: 'agh_ortho_views',
      description:
        '只读、纯函数、**不落盘**。把参数 JSON 渲染成正交六视图的 SVG（主视图/俯视图/左视图/右视图/仰视图/后视图），并给出第一角法或第三角法的图面排布。下游没有相机 op，严格正交六视图下游给不了，所以这里自己算正交投影 —— 零依赖。SVG 是文本，因此**模型可以直接读视图几何**：工具产出的图片像素进不了模型，文本可以。M1 只返回文本；"落盘 + 描述符（run-uuid / report.json / 幂等 / 清理）"归 agh_ortho_save。',
      parameters: EMIT_OPS_INPUT,
      meta: READ_ONLY_META,
      async execute(args) {
        const caps = resolveTargetCapabilities()
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
        '只读、纯函数。numeric 档校验（CONTRACT §9）：参数 → ops → 包围盒 → 六视图 → **从视图反解** → 与参数比对，残差必须为 0，且同一个轴被 4 张视图观测、4 个观测值必须彼此相等。走的是两条**独立路径**：一侧直接读参数叶子，另一侧读 lowering 产出的 ops —— 共用一条路径的话校验就是同义反复。**不需要 Blender**，这就是"扩下游之前就能交付价值"的关键解耦。它只证明几何自洽，不证明几何与真实照片一致（那是 against_blender 档，M1 不做）。',
      parameters: EMIT_OPS_INPUT,
      meta: READ_ONLY_META,
      async execute(args) {
        const caps = resolveTargetCapabilities()
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
        return respond({
          ok: emission.ok && aligned && checked.max === 0,
          blockers,
          tier: 'numeric',
          needs_blender: false,
          alignment: aligned ? 'aligned' : 'misaligned',
          residual_max: checked.max,
          worst: checked.worst,
          object_count: fromParams.length,
          views_per_axis: 4,
          convention: VIEW_CONVENTION,
          rows: checked.rows,
          caveats: VERIFY_CAVEATS,
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

        const assembled = assembleArtifacts(args, new Date().toISOString())
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
