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
import { basename, join } from 'node:path'
import { SCENE_ABSOLUTE_FLOOR, SCENE_RELATIVE_TOLERANCE, declarationRelativeTolerance, boxesFromOps, compareScene, expectedObjectsFromOps, extentsFromBoxes, extentsFromParams, placementOf } from './geometry.mjs'
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
import {
  SHEET_NOTE,
  SHEET_REVIEW_ITEMS,
  VIEW_CONVENTION,
  commonScale,
  numericOutline,
  renderSheet,
  residual,
  sheetPlacement,
  sixViewRects,
  svgFor,
} from './views.mjs'
import { silhouetteOf, compareSilhouette } from './silhouette.mjs'

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
  // 容差是**每行各自算出来的**（相对 SCENE_RELATIVE_TOLERANCE，绝对值下限 SCENE_ABSOLUTE_FLOOR），
  // 所以这里**不能写死一个 1e-6**。实测被抓到过：载荷里写着 "within 1e-6"，同一份载荷的
  // rows[].tolerance 却最大到 9.6e-6 —— 断言清单与它旁边的数字互相矛盾，读者只能拒绝背书。
  // 这正是"把会变的事实写成常量"那一族，所以三个数都从常量拼出来。
  const relative = SCENE_RELATIVE_TOLERANCE.toExponential()
  const floor = SCENE_ABSOLUTE_FLOOR.toExponential()
  const within = `within the tolerance printed on that row (relative ${relative} of the largest coordinate, floor ${floor} m) — NOT a fixed 1e-6`
  const base = [
    'every intended object exists under its exact name (Blender renames collisions to name.001, so a missing exact name is caught)',
    'type is MESH',
    `location equals the location we asked for, ${within}`,
    `scale equals the scale we asked for, ${within}`,
  ]
  if (sizeAsserted) {
    base.push(`the final size in metres equals scale x size, ${within} — dimensions ARE published by this downstream`)
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
    out.push('the primitive KIND: the downstream catalog publishes no per-kind vertex/face counts; agreement with the original photograph is NOT connected yet (see the entry below)')
  }
  out.push('the primitive kind beyond type=MESH: the downstream catalog publishes no per-kind vertex/face counts, so vertices/polygons are reported as evidence and not asserted')
  // 这一条**不是"永远不可能"，而是"还没接上"**。我此前写成"下游没有相机 op / 这一档永远升不上去"，
  // 是**错的**（下游 op 表里 camera.add / object.look_at / light.add 都在，实测核对过）。真实缺口是两件：
  //   ① 下游：camera.add 只有透视（没有 ORTHO/ortho_scale），且没有"用**场景相机**渲到文件"的 op
  //      （capture 渲的是**视口**）；
  //   ② 我们这侧：渲出来的像素**进不了模型** ⇒ 还要把剪影转成**数值**（比例数列）才能机器比对。
  out.push('agreement with the original photograph: the downstream can now render the scene camera (camera.add with type ORTHO plus render.still) and this plugin can compare such a render\u2019s silhouette against its own outline and against a photo_check range when you pass `silhouette` \u2014 what no tier does is judge *aesthetics*, because pixels never reach a model, and a picture is only ever evidence for a human or for a derived number.')
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

/**
 * 生成网格的**来源**（`source`）—— 网格不可复算，所以这几项必须记全。
 *
 * **必须声明在 ASSEMBLY_ITEM 之前** —— 后者在模块求值时就要引用它（const 有 TDZ，
 * 放后面会 ReferenceError）。这条已经咬过两次（另一次是 PHOTO_CHECK）。
 *
 * 为什么这条和参数化模型完全不同：参数化模型**可以复算** —— 实测同样的参数产出的 ops 与六视图
 * **逐字节相同**。而一个生成的网格，只有**同一个模型、同一份权重、同一个 seed** 才可能重现。
 * **不记这几项，产物就是一个永远导不回来的孤儿。**
 *
 * 两个轴必须分清（历史上混过一次 acquisition/provenance，教训在 notes §9.9）：
 *   part   —— 这东西**是什么**（body / clothing / hair / …）
 *   source —— 它**怎么来的**（parametric / generated_mesh / …）   ← 本表
 *
 * `kind` 必填；`model` / `seed` 不是必填，但**声明成 generated_mesh 却缺它们会被 fit 报出来**
 * —— 与"声明了 photo_check 就要对得上"同一条纪律：**你声明了什么，就要能自证什么。**
 */
const MESH_SOURCE = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    model: { type: 'string' },
    weights: { type: 'string' },
    seed: { type: 'integer' },
    input_image_sha256: { type: 'string' },
    // 文件**自己的空间**：网格不可复算，所以它必须自报"哪根轴朝上、什么单位、生成器保证的长度是多少"。
    // 这三项都**不是**猜测的余地：缺了 buildMesh 直接报 blocker（静默猜轴向会出一个"看起来对、量起来错"的模型）。
    up_axis: { type: 'string' },
    unit: { type: 'string' },
    declared_height: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['kind'],
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
    // 部件分类 —— **这是"这东西是什么"，不是"它怎么做的"**（后者是 provenance，见描述符）。
    // 单独一张共享词汇表的理由：网格生成器（StdGEN 那种）按 body/clothes/hair **语义分解**，
    // 而我们的 assembly 本来就是**带名字的部件** —— 两边撞到了同一个答案，但名字不同。
    // 有了共同分类，两条路的产物才能在**部件级**互相比对与记账；否则只比得了总数，比不了"哪一个"。
    // **可选**（缺了只给 warning）：已有模型不带它，不该因此失效。
    part: { type: 'string' },
    // 这东西**怎么来的**（与 `part` 是两个轴）：这轮只有 `mesh` 这一种生成物用得上。
    // 声明成 generated_mesh 的部件**不能进受管理场景**（下游没有导入 op），所以它会走
    // `mesh` 这条 feature 落到 unsupported —— 但**来源信息必须先被记下来**，否则将来无从追溯。
    source: MESH_SOURCE,
    // 生成物在磁盘上的位置（可选）。落进描述符时同样带 sha256。
    path: { type: 'string' },
  },
  required: ['id', 'feature'],
  additionalProperties: false,
}

/** assembly 项的**规范键序** = 声明顺序（id → feature → 尺寸 → 位置 → 分类 → 来源）。 */
const ASSEMBLY_ITEM_ORDER = Object.keys(ASSEMBLY_ITEM.properties)

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

/**
 * `photo_check` 的形状：每个视图一个"照片里看起来的宽高比"。
 *
 * 必须**声明在 EMIT_OPS_INPUT 之前** —— 后者在模块求值时就要引用它（const 有 TDZ，
 * 放在后面会 ReferenceError）。
 *
 * 六个视图**写成可选属性**，而不是用 `additionalProperties: <schema>`：后者需要 tb()
 * 递归进 additionalProperties 才带 Kind 标记，那是另一处未覆盖的空档（与 Union 节点同类）。
 * 显式列出还能顺便校验视图名。
 */
const PHOTO_VIEW_READING = {
  type: 'object',
  properties: {
    // **区间，不是一个点。** 实测：同一个模型对同一张照片两次读数给出 0.60 与 0.77（差 28%），
    // 所以"一个数 + 一个我猜的容差"是假严谨 —— 让模型自己申明它能保证的范围，判定才有意义。
    w_over_h_min: { type: 'number' },
    w_over_h_max: { type: 'number' },
    // 模型自己的备注（它看到了什么、为什么这么读）—— 不加判断，原样带给读者。
    note: { type: 'string' },
  },
  required: ['w_over_h_min', 'w_over_h_max'],
  additionalProperties: false,
}
const PHOTO_CHECK = {
  type: 'object',
  properties: {
    front: PHOTO_VIEW_READING,
    top: PHOTO_VIEW_READING,
    left: PHOTO_VIEW_READING,
    right: PHOTO_VIEW_READING,
    bottom: PHOTO_VIEW_READING,
    back: PHOTO_VIEW_READING,
  },
  required: [],
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
    // 模型**读照片**得到的读数 —— 这是"一口气跑完"里唯一能把照片纳进来的机制：
    // 它把"像不像照片"从自觉变成有输出、可核对（fit 会拿它与自己算出的 outline 比）。
    // 每个视图一个"照片里看起来的宽高比"。**不要求全填**（看不到就留空），但填了就要对得上。
    photo_check: PHOTO_CHECK,
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
// 剪影输入（SILHOUETTE-PLAN）：一张**正交渲染**的、带透明通道的 PNG + 它的投影参数。
// `ortho_scale` **必填** —— 它是像素↔米的**唯一**依据；没有它就只能猜，而猜出来的尺度会**静默决定**判定结果。
// `width/height` 可选：给了就必须与 PNG 实际尺寸一致（又一条免费的独立核对）。尺寸本身以 PNG 为准。
// **声明必须早于 SAVE_INPUT**：它在 SAVE_INPUT 里就被引用了（TDZ 第三次栽在这里，前两次是 PHOTO_CHECK / MESH_SOURCE）。
const SILHOUETTE_INPUT = {
  type: 'object',
  properties: {
    view: { type: 'string', enum: ['front', 'top', 'left', 'right', 'bottom', 'back'] },
    path: { type: 'string', minLength: 2 },
    ortho_scale: { type: 'number', exclusiveMinimum: 0 },
    sensor_fit: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL', 'AUTO'] },
    width: { type: 'integer', exclusiveMinimum: 0 },
    height: { type: 'integer', exclusiveMinimum: 0 },
  },
  required: ['path', 'ortho_scale'],
  additionalProperties: false,
}

const SAVE_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    run_id: { type: 'string' },
    // 产物包是交付物，所以它必须能记录**读回验证** —— 否则包里只有"我自洽"，
    // 而证明不了"下游照做了"，等于交付物比这一轮实际验过的少。
    against_scene: { type: 'boolean' },
    // 下游导出的场景文件（`.blend`）的**真实路径**。给了它，交付包里才第一次有"模型本身"。
    // 它由 agh_blender_export 落盘在 run 目录之外（例如 outputs/xxx.blend），这里只登记、不复制：
    // 描述符的 path 指向那个文件，sha256/bytes 按**原始字节**算。
    scene_file: { type: 'string', minLength: 2 },
    // 外部生成的网格（StdGEN 那类）的**真实路径**：登记成描述符（只登记不复制），
    // 并顺带读同目录的 source.json（unit/upAxis/declaredHeight 的声明）。
    mesh_file: { type: 'string', minLength: 2 },
    // 剪影图（可选）：交付包里也记下"轮廓像不像"这一档的结论。
    silhouette: SILHOUETTE_INPUT,
    // 源照片的真实路径（可选）：登记进包，并核 `source.input_image_sha256` 的声明。
    image_file: { type: 'string', minLength: 2 },
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
 * 下游 0.1.8 起发布 `primitives` 与 `capabilitySet`（见 notes/DOWNSTREAM-REQUEST-readback.md §1），
 * 这里**原样透传**；字段缺席时仍给 null，让 primitiveAvailable 退回"无法判定"而不是假装判定过。
 */
function capabilitiesFromCatalog(catalog) {
  return {
    target: 'agh-blender@live',
    // 优先用下游自报的 capabilitySet；缺席才退回按 catalog.version 合成，避免编造一个看起来
    // 像下游版本号的标识。
    capabilitySet:
      typeof catalog.capabilitySet === 'string' ? catalog.capabilitySet : `catalog-v${catalog.version ?? '?'}`,
    primitives: Array.isArray(catalog.primitives) ? catalog.primitives : null,
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
  // 尺寸必须为正：0 或负数会让 Blender 翻面/退化，而且是**静默**错的。
  if (SIZE_KEYS.includes(key) && leaf.v <= 0) {
    blockers.push({
      code: 'E_ARG_RANGE',
      message: `"${item.id}"."${key}" must be greater than zero (got ${leaf.v}); a non-positive size silently degenerates or flips in Blender`,
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

/** 外部生成的网格（StdGEN / CharacterGen 那类）：**声明驱动**。
 *
 *  emit 阶段是纯函数、**不读盘**，所以这里只认参数里写下的声明：`path`（文件在哪）、
 *  `source.up_axis` / `source.unit` / `source.declared_height`（**文件自己的空间**）。
 *  缩放不是猜的：`scale = h / declared_height`（h = 参数里声明的目标高度，单位米）。
 *
 *  分工（这是本设计的要点）：**纯层只管"声明齐不齐"，有盘的那层（`save`）管"声明真不真"** ——
 *  save 会读 source.json 与文件本身、量出包围盒，与声明不符即 **blocking**。
 *  `size` 是**声明过的意图尺寸**（米）：op 侧靠它算包围盒，于是两条路径比对的是同一组数。
 */
function buildMesh(item, name, blockers) {
  const source = item.source ?? {}
  const path = typeof item.path === 'string' && item.path.length > 0 ? item.path : null
  const w = leafNumber(item, 'w', blockers)
  const d = leafNumber(item, 'd', blockers)
  const h = leafNumber(item, 'h', blockers)
  const upAxis = typeof source.up_axis === 'string' ? source.up_axis.toUpperCase() : null
  const unit = typeof source.unit === 'string' ? source.unit : null
  const declared = Number(source.declared_height)
  if (!path) {
    blockers.push({
      code: 'E_ARG_MISSING',
      message: `"${item.id}": a mesh item must declare the file it came from (path, e.g. .agnes/agh-ortho/meshes/<name>/mesh.glb) — without it the mesh cannot be imported and its provenance cannot be re-checked`,
    })
    return []
  }
  if (upAxis === null || !['X', 'Y', 'Z'].includes(upAxis)) {
    blockers.push({
      code: 'E_ARG_MISSING',
      message: `"${item.id}": source.up_axis must name the axis the FILE is up (X/Y/Z). Guessing it silently produces a rotated, plausible-looking model — that is a silent error, so it is refused.`,
    })
    return []
  }
  // 对外宽容：两种拼写都收（美式 normalized / 英式 normalised），也收 unitless —— 别让一个拼写
  // 把整轮挡住（实测踩过：sidecar 写 normalized，枚举只有 normalised ⇒ 参数校验先失败，
  // 连带 lowering 没产出 op，于是又冒出"内部不一致"的第二条误导性 blocker）。
  if (unit === null || !['m', 'cm', 'mm', 'normalised', 'normalized', 'unitless'].includes(unit)) {
    blockers.push({
      code: 'E_ARG_RANGE',
      message: `"${item.id}": source.unit must be one of m/cm/mm/normalised — a mesh file (esp. OBJ) carries no unit at all, so it has to be declared.`,
    })
    return []
  }
  if (!Number.isFinite(declared) || declared <= 0) {
    blockers.push({
      code: 'E_ARG_RANGE',
      message: `"${item.id}": source.declared_height must be a positive number — the length the generator guarantees INSIDE the file. It is what turns the file's own space into metres.`,
    })
    return []
  }
  if (w === null || d === null || h === null) return []
  return [
    {
      op: 'mesh.import',
      args: {
        path,
        name,
        upAxis,
        scale: h / declared,
        // **不发 location**：导入那一刻对象还没被摆放（下游明写 size/location"只比对不施加"），
        // 所以它会拿"声明的落点"比"导入后的实际位置"——**必然报 false**。那是噪音不是发现
        // （实测：location.ok:false，而随后那条 object.transform 把位置设对了）。
        // 落点交给下面那条 object.transform，读回自会核对它。
        size: [w, d, h],
      },
    },
    // **两条 op，不是一条**：下游在 agh_ops.py 里明写 "size/location are the caller's expectation,
    // not a transform: compared and reported, never [applied]" —— 也就是说 mesh.import 只会**核对**我们
    // 报的期望值并回报，**不会**把对象摆到那里。所以摆放必须另发一条 object.transform，
    // 否则对象停在原点（实测：第 3 步 location 未生效，正是这个原因）。
    {
      op: 'object.transform',
      args: { name, location: placementOf(item, h) },
    },
  ]
}

// ---------------------------------------------------------------------------
// M2 的 lowering：CONTRACT §4.3 里另外五种意图
//
// 每个 build 只负责"把意图翻译成 op"；**能力闸门**与**三态记账**在 emitOps 里统一做
// （见 LOWERING 表里的 `kind` 与 `errorNote`）。
// ---------------------------------------------------------------------------

/** 目标有没有这种基元。三态：可用 / 不可用 / **无法判定**（下游 catalog 未发布 primitives）。 */
function primitiveAvailable(caps, kind) {
  const list = Array.isArray(caps?.primitives) ? caps.primitives : null
  if (!list) {
    return { ok: true, gated: false, why: 'the catalog publishes no primitives list, so this could not be gated' }
  }
  if (list.includes(kind)) return { ok: true, gated: true, why: null }
  return { ok: false, gated: true, why: `the target declares primitives ${list.join('/')} and has no "${kind}"` }
}

/** 目标有没有这张 **op**。与基元闸门是**两件事**：基元闸门管 `mesh.primitive_add` 的 kind，
 *  这里管"该操作在不在目标的 op 表里"（例如 `mesh.import`）。
 *
 *  保守方向与 primitiveAvailable 一致：**目录里没有 op 表时返回 ok（无法判定，不假装拒绝）**；
 *  有表而不含该项 ⇒ 如实 `ok:false`，由调用方报成 unlowered / no_downstream_op。
 *  下游**没有义务**支持导入 —— 缺就如实说缺，这跟"我还没实现"是两回事。 */
function opAvailable(caps, name) {
  const list = Array.isArray(caps?.ops)
    ? caps.ops.map((o) => o?.name).filter((n) => typeof n === 'string')
    : null
  if (!list || list.length === 0) {
    return { ok: true, gated: false, why: 'the catalog publishes no op table, so this could not be gated' }
  }
  if (list.includes(name)) return { ok: true, gated: true, why: null }
  return { ok: false, gated: true, why: `the target's op table has no "${name}" (it publishes: ${list.join(', ')})` }
}

/** 把 caps 变成 geometry 侧要的判据。
 *  **参数侧必须应用与 op 侧相同的闸门**：否则闸门拒绝某项时，op 侧少一个而参数侧多一个
 *  ⇒ 报成"内部不一致"，把"下游没有这种基元"这个真实原因掩盖成一条假告警。 */
const kindAvailableFor = (caps) => (kind) =>
  // 带点的名字是一条 **op**（`mesh.import`），不是基元 kind：按 op 表判定。
  // 两条路径（参数侧 / op 侧）必须用同一个判定，否则闸门拒绝时会出现"参数侧多一个、op 侧少一个"
  // 的假"内部不一致"，把"下游没有这张 op"这个真实原因掩盖掉。
  typeof kind === 'string' && kind.includes('.')
    ? opAvailable(caps, kind).ok
    : primitiveAvailable(caps, kind).ok

/** 只读取、不报错（用于"可选"的字段，别把可选当缺失）。 */
function optionalLeaf(item, key) {
  const leaf = item[key]
  if (!leaf || typeof leaf !== 'object' || typeof leaf.v !== 'number' || !Number.isFinite(leaf.v)) return null
  return leaf.v
}

/** 竖板 / 墙片：**薄的竖向 cube**，不是 plane。
 *  契约表写的是 plane，但 plane 的法线是 +Z（水平），而 sheet 的语义是竖直面板；
 *  要在竖直方向立起来就必须发 rotation —— 本 emitter 不发旋转，而且对象一旦旋转，
 *  `dimensions` 就不再是世界 AABB、尺寸断言会被迫关闭。所以"薄 cube"才是诚实的建模：
 *  它多出来的那点厚度**就是**面板的厚度，由 `d` 显式给出，不是编的。
 *  （与 `box` 落到同一个 op —— 意图层的区别在这一层不必体现在 op 上。） */
function buildSheet(item, name, blockers) {
  const w = leafNumber(item, 'w', blockers)
  const h = leafNumber(item, 'h', blockers)
  const t = leafNumber(item, 'd', blockers) // 面板厚度读 `d`
  if (w === null || h === null || t === null) return []
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'cube', name, size: 1, scale: [w, t, h], location: placementOf(item, h) },
    },
  ]
}

/** 柱：cylinder，`dia` 是直径、`h` 是高度。
 *  **`h` 必须显式给** —— CONTRACT §4.4 的样例里 col_nw 只有 dia+at，没有高度；
 *  圆柱需要 depth，凭空给一个高度就是编数据。缺失时按普通缺失字段报 E_ARG_MISSING。 */
function buildColumn(item, name, blockers) {
  const dia = leafNumber(item, 'dia', blockers)
  const h = leafNumber(item, 'h', blockers)
  if (dia === null || h === null) return []
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'cylinder', name, size: 1, scale: [dia, dia, h], location: placementOf(item, h) },
    },
  ]
}

/** 环：torus。`dia` 是**下游语义里的直径**（manifest 写着 diameter/footprint）。
 *  注意下游把管径钉死在 size/8，所以任何一个环都能被精确表达 —— 不需要 approx。 */
/** 环：torus。**`dia` 是"外形直径"** —— 人会这么理解（"这个圈 1.2 米"指的是外廓）。
 *
 *  但下游的 `size` 是**主直径**：`major_radius = size/2`、`minor_radius = size/8`
 *  ⇒ 外廓半径 = size/2 + size/8 = 0.625 × size ⇒ **外径 = 1.25 × size**。
 *  实测抓到过：写 `dia 1.2` 却量到外径 **1.5**（差 25%）—— 字段名承诺的和结果不一致。
 *  所以这里除掉那个系数，让 `dia` 真的等于外径；管径由下游钉死在 size/8 = dia/10。
 *  （`UNIT_EXTENT.torus` 不动 —— 它记的是**下游的真相**，本来就该是 1.25/1.25/0.25。） */
const TORUS_OUTER_OVER_SIZE = 1.25

function buildRing(item, name, blockers) {
  const dia = leafNumber(item, 'dia', blockers)
  if (dia === null) return []
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'torus', name, size: dia / TORUS_OUTER_OVER_SIZE, scale: [1, 1, 1], location: placementOf(item) },
    },
  ]
}

/** 穹顶：下游只有**整球**，没有半球 —— 这是唯一真正的 approx。
 *  做法：把球心放在基面上，于是上半球就是穹顶、下半球埋在地下（拿到正确的**地上轮廓**）。
 *  代价：对象自身的 bbox 是 (dia, dia, dia)，不等于穹顶的高度 —— 这一点写进 error_note，
 *  并且对象名带 `_approx` 后缀，让产物自带自证（CONTRACT §5.1 的强制做法）。 */
function buildDome(item, name, blockers) {
  const dia = leafNumber(item, 'dia', blockers)
  if (dia === null) return []
  return [
    // placementOf 在没有 at/z 时给的是 z=0 —— 对穹顶正好就是"球心在基面"这个约定。
    { op: 'mesh.primitive_add', args: { kind: 'uv_sphere', name, size: dia, scale: [1, 1, 1], location: placementOf(item) } },
  ]
}

/** 尖顶 / 锥体：cone。锥体与 cone **同形**，所以是 exact —— 把它标成 approx 等于谎报降级。
 *  （契约表把它写成 approx，是因为当时设想它用于近似坡屋顶；那种场景应该用 `roof.gable`，
 *   而它仍然是 unsupported。） */
function buildSpire(item, name, blockers) {
  const dia = leafNumber(item, 'dia', blockers)
  const h = leafNumber(item, 'h', blockers)
  if (dia === null || h === null) return []
  return [
    {
      op: 'mesh.primitive_add',
      args: { kind: 'cone', name, size: 1, scale: [dia, dia, h], location: placementOf(item, h) },
    },
  ]
}

const LOWERING = {
  slab: { status: 'exact', kind: 'plane', build: buildSlab },
  box: { status: 'exact', kind: 'cube', build: buildBox },
  sheet: { status: 'exact', kind: 'cube', build: buildSheet },
  column: { status: 'exact', kind: 'cylinder', build: buildColumn },
  ring: { status: 'exact', kind: 'torus', build: buildRing },
  dome: {
    status: 'approx',
    kind: 'uv_sphere',
    build: buildDome,
    errorNote:
      'a dome is a hemisphere, but the downstream has only a full uv_sphere: the sphere is centred on the base plane, so its lower half is buried and its upper half gives the dome. The object itself therefore measures (dia, dia, dia), not the dome height.',
  },
  spire: { status: 'exact', kind: 'cone', build: buildSpire },
  // 外部生成的网格（StdGEN / CharacterGen 那类）。**能力驱动**：目标目录里声明了
  // `mesh.import` 就是 exact（emitOps 的 op 闸门会核），没声明就如实落进 unlowered / no_downstream_op。
  // 声明出来而不是丢掉，有三个理由：
  //   ① 来源（模型/权重/seed/输入图哈希）必须随产物走 —— 网格**不可复算**，不记就永远导不回来；
  //   ② 报告要如实说"这一类部件的**形状三档都验不了**"（numeric / photo_check 不适用，
  //      读回只验得到存在 / 位置 / 尺寸）；
  //   ③ 真实尺寸由**文件**决定，所以参数里必须声明文件自己的空间（up_axis / unit / declared_height）。
  mesh: {
    status: 'exact',
    requiresOp: 'mesh.import',
    build: buildMesh,
    reasonCode: 'no_downstream_op',
    reason:
      'the downstream catalog does not declare a mesh import op (mesh.import is on DOWNSTREAM-REQUEST). A generated mesh can only be declared and recorded until it does.',
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
  // 真·approx 的记账（CONTRACT §5.1：对象名带 `_approx` 之外，how / error_note 也必须传出去）
  const approx = []
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

    // 能力闸门：目标没这种基元就不硬发，而是报成 unlowered（这样"下游做不到"与"我还没做"
    // 仍然分得开）。下游 0.1.8 起发布 primitives ⇒ 有实例时也能真判定；只有目录（快照或旧下游）
    // 不发布 primitives 时才 gated=false（无法判定），我们仍然发出并在能力来源里如实标注。
    if (rule.kind) {
      const gate = primitiveAvailable(caps, rule.kind)
      if (!gate.ok) {
        unlowered.push({ id, feature, reason_code: 'no_downstream_primitive', reason: gate.why })
        continue
      }
    }

    // op 闸门（与基元闸门是两件事）：规则要求的那张 op 不在目标目录里，就报 unlowered。
    // 缺 op 与"我还没实现"必须分得开，所以 reason_code 用 no_downstream_op（与 unsupported 规则同一码）。
    if (rule.requiresOp) {
      const gate = opAvailable(caps, rule.requiresOp)
      if (!gate.ok) {
        unlowered.push({ id, feature, reason_code: 'no_downstream_op', reason: gate.why })
        continue
      }
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
      // 哪些意图有"高度"就用 h/2，其余落在 z = 0 平面。别写死成 box —— M2 之后
      // sheet / column / spire 都有 h。
      const h = Number(item.h?.v)
      const assumed = Number.isFinite(h) ? `centre z = h/2 = ${(h / 2).toFixed(3)}` : '落在了 z = 0 平面'
      notes.push(
        `"${id}" had no "at", so its placement was assumed to be base-on-ground (${assumed}) — assert or override this`,
      )
    }
    for (const op of built) ops.push(op)
    // 三态记账：approx 的误差必须落到**产物**里，而不是只活在 lowering 表里。
    if (built.length > 0 && rule.status === 'approx') {
      approx.push({ id, feature, object_name: name, how: rule.kind, error_note: rule.errorNote ?? null })
    }
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
    // 真·approx 的误差（对象名已带 `_approx` 后缀）。必须一路传到用户面前：CONTRACT §10 说
    // "降级误差可能最大、且最隐蔽"，所以它不能只活在 lowering 表里。
    approx,
    // 能力闸门到底有没有生效？目录不发布 primitives 列表 ⇒ 闸门没生效。
    // 必须写出来，否则读者会以为"发出去的每个基元都被确认过存在"。
    primitive_gate: Array.isArray(caps?.primitives)
      ? 'applied'
      : 'not_applied: the catalog publishes no primitives list',
    // —— 输入侧的坦白，原样带出 ——
    assumptions: Array.isArray(params.assumptions) ? params.assumptions : [],
    unresolved: Array.isArray(params.unresolved) ? params.unresolved : [],
  }
}

// ---------------------------------------------------------------------------
// 落盘：把一个 run 的全部产物算出来（纯计算，不碰 fs）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 外部网格：**世界**包围盒
// ---------------------------------------------------------------------------
/** 从 GLB 字节里读出**世界**包围盒。
 *
 *  **为什么必须是"世界"**：glTF 允许把变换放在**节点**上，accessor 只描述局部坐标。
 *  实测抓到过：一个 0.4×2×0.4 的方块被 Blender 导出成 accessor ±1 + 节点 `scale(0.2,1,0.2)` ——
 *  只看 accessor 会把它读成 2×2×2，**尺寸量错 5 倍**。所以 scale/translation 必须乘进去。
 *
 *  **明确的局限**（宁可说"量不了"，也不给错数）：
 *   - 带**旋转**的节点：轴对齐盒子本来就表述不了 ⇒ 返回 `rotated: true`，调用方**拒绝给出尺寸判定**；
 *   - 只处理**顶层**节点（`nodes[].children` 里的嵌套变换没跟） ⇒ 由 `nodes` 计数与调用方的说明兜住。
 */
function glbWorldBounds(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') return { ok: false, why: 'not a GLB (bad magic)' }
  let off = 12
  let json = null
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'JSON') {
      try {
        json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
      } catch (error) {
        return { ok: false, why: `the JSON chunk did not parse (${error?.message ?? error})` }
      }
    }
    off += 8 + len
  }
  if (!json) return { ok: false, why: 'no JSON chunk' }
  const nodes = Array.isArray(json.nodes) ? json.nodes : []
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let counted = 0
  let rotated = false
  for (const node of nodes) {
    if (node?.mesh === undefined) continue
    const prim = meshes[node.mesh]?.primitives?.[0]
    const acc = prim && json.accessors ? json.accessors[prim.attributes?.POSITION] : null
    if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max)) continue
    const q = Array.isArray(node.rotation) ? node.rotation : null
    if (q && q.some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-6)) rotated = true
    const s = Array.isArray(node.scale) ? node.scale.map((v) => Math.abs(v)) : [1, 1, 1]
    const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0]
    counted += 1
    for (let i = 0; i < 3; i += 1) {
      const a = acc.min[i] * s[i] + t[i]
      const b = acc.max[i] * s[i] + t[i]
      lo[i] = Math.min(lo[i], a, b)
      hi[i] = Math.max(hi[i], a, b)
    }
  }
  if (counted === 0) return { ok: false, why: 'no mesh node with a POSITION accessor could be read' }
  return { ok: true, size: hi.map((v, i) => v - lo[i]), min: lo, max: hi, nodes: counted, rotated }
}

async function assembleArtifacts(args, createdAt, tctx) {
  const caps = await resolveTargetCapabilities(tctx)
  const emission = emitOps(args, caps)
  const boxes = boxesFromOps(emission.ops)
  const views = sixViewRects(boxes)
  const placement = sheetPlacement(args.projection)
  const scale = commonScale(views)
  const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [], kindAvailableFor(caps))
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
  // `scene_file` 读不到时必须**显式失败**，不能当成"没有给" —— 否则交付包看起来是完整的，
  // 而里面其实没有模型。
  const blockers = [...emission.blockers]
  const outline = numericOutline(views)
  // 剪影那一档：**读不到就是 blocker**（不是"没给"）—— 它同时与 outline（几何自洽）
  // 和 photo_check（像不像照片）比，所以它必须和别的档一样影响 ok。
  const silhouetteCheck = await silhouetteFinding(tctx, args.silhouette, outline, args.photo_check)
  blockers.push(...silhouetteCheck.blockers)
  // 源图那一环：声明必须可核对（同时把源图登记进包，让"这张图 → 这个网格"可核）。
  const imageCheck = await imageFinding(tctx, args)
  blockers.push(...imageCheck.blockers)
  if (imageCheck.bytes) {
    files.push({
      name: basename(args.image_file),
      data: imageCheck.bytes,
      absolutePath: args.image_file,
      preview: `源照片（外部输入）：${basename(args.image_file)}，${imageCheck.bytes.length} 字节，sha256 ${String(imageCheck.finding.computed).slice(0, 12)}…；描述符**只登记不复制**。有了它，"这个网格源自这张图"才是可核对的事实，而不只是一句声明`,
      meta: {
        external: true,
        register_only: true,
        role: 'source_image',
        sha256_verified: (imageCheck.finding.matches ?? []).every((m) => m.matches),
      },
    })
  }
  // ③ 图纸先落：这是复核者该打开的那个文件。六张分图仍在，但"一张图纸"才是 review 对象。
  const sheet = renderSheet(views, placement, { projection: args.projection })
  files.push({
    name: 'sheet.svg',
    text: sheet.svg,
    preview: `六视图图纸（${sheet.layout.convention}）：${views.length} 张视图排在一张图纸上、全图共用比例尺 ${sheet.scale.toFixed(4)} px/m；格位 ${sheet.cells.map((c) => `${c.view}@col${c.col}/row${c.row}`).join(' ')}；这是"贵的那一步之前"的单一复核对象`,
    meta: {
      artifact: 'six_view_sheet',
      convention: sheet.layout.convention,
      shared_scale: sheet.scale,
      cells: sheet.cells,
      projection: args.projection,
    },
  })
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
    text: `${JSON.stringify(canonicalParams(args), null, 2)}\n`,
    preview: `参数模型（意图层）：${(args.assembly ?? []).length} 个 assembly 项、${(args.unsupported ?? []).length} 个声明 unsupported、${(args.unresolved ?? []).length} 个 unresolved；单位 ${args.unit}；投影 ${args.projection}；只含意图层字段、键序已规范化，可直接作为 emit_ops / fit 的输入复现`,
    meta: { unit: args.unit, projection: args.projection, intent_only: true, key_order: 'canonical' },
  })
  files.push({
    name: 'ops.json',
    text: `${JSON.stringify(emission, null, 2)}\n`,
    preview: `ops 批次：${emission.op_count} 个 op、${emission.batches} 批，目标 ${emission.target_capability_set}；${emission.unlowered.length} 项未 lower、${(emission.approx ?? []).length} 项 approx（对象名带 _approx）；闸门 ${emission.primitive_gate}`,
    meta: {
      op_count: emission.op_count,
      batches: emission.batches,
      target_capability_set: emission.target_capability_set,
      approx_count: (emission.approx ?? []).length,
    },
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

  // 交付包里的"模型本身"。下游 `agh_blender_export` 已经把场景落成 `.blend`（在 run 目录之外，
  // 例如 `outputs/xxx.blend`），这里**登记**它：描述符按原始字节算 sha256/bytes，path 指向真实文件。
  // 不复制：复制一份 .blend 会把 run 目录从"我们写的产物"变成"混进外来二进制的地方"。
  let sceneFile = null
  if (typeof args.scene_file === 'string' && args.scene_file.length > 0) {
    try {
      const data = await tctx.fs.read(args.scene_file)
      const name = basename(args.scene_file)
      files.push({
        name,
        data,
        absolutePath: args.scene_file,
        preview: `模型本身（外部产物）：${name}，${data.length} 字节，由下游导出后落在 run 目录之外；描述符**只登记不复制**，消费方按 path 打开。它证明"这个场景真的被建出来过"，与 ops.json 描述的是同一份几何`,
        meta: { external: true, register_only: true, producer_tool: 'agh_blender_export' },
      })
      sceneFile = { name, path: args.scene_file, bytes: data.length }
    } catch (error) {
      blockers.push({
        code: 'E_SCENE_FILE_UNREADABLE',
        message: `scene_file could not be read (${error?.message ?? error}). The pack will NOT contain the model file — do not read its absence as "there is no model".`,
        path: args.scene_file,
      })
    }
  }

  // 外部**网格**（StdGEN/CharacterGen 那类）：同样**只登记不复制**，但比 .blend 多一件事 ——
  // 网格的**真实尺寸只有文件知道**，所以顺带读同目录的 `source.json`（生成脚本写的声明）。
  // 闸门挂在**项自己的 path** 上，而不是可选的 `mesh_file` 入参 —— 实测抓到过：不传 mesh_file 时，
  // 声明被读了、被记了，却**没有任何一道闸门看它一眼**，而且 ok:true / blockers:[]（静默通过）。
  // 声明不被比较就是装饰，所以判定从"项"出发；mesh_file 只决定"要不要把它登记成描述符"。
  const meshItemWithPath = (Array.isArray(args.assembly) ? args.assembly : []).find(
    (it) => it && it.feature === 'mesh' && typeof it.path === 'string' && it.path.length > 0,
  )
  const wantDescriptor = typeof args.mesh_file === 'string' && args.mesh_file.length > 0
  const meshPath = wantDescriptor ? args.mesh_file : (meshItemWithPath?.path ?? null)


  // 没有 sidecar 就是 blocker：unit/upAxis/declaredHeight 缺一个，都会静默地把模型转错方向或缩放错。
  let meshFile = null
  let meshSource = null
  let meshMeasured = null
  const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '')
  if (meshPath !== null) {
    try {
      const data = await tctx.fs.read(meshPath)
      const name = basename(meshPath)
      files.push({
        name,
        data,
        absolutePath: meshPath,
        preview: `外部生成的网格：${name}，${data.length} 字节；描述符**只登记不复制**。网格**不可复算**，所以必须与 source.json 的声明（unit/upAxis/declaredHeight）一起交付`,
        meta: { external: true, register_only: true, producer_tool: 'external mesh generator' },
      })
      meshFile = { name, path: meshPath, bytes: data.length }
    } catch (error) {
      blockers.push({
        code: 'E_MESH_FILE_UNREADABLE',
        message: `mesh_file could not be read (${error?.message ?? error}). The pack will NOT contain the mesh — do not read its absence as "there is no mesh".`,
        path: meshPath,
      })
    }
    const sidecarPath = `${dirOf(meshPath)}/source.json`
    try {
      const raw = await tctx.fs.read(sidecarPath)
      const parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
      meshSource = {
        path: sidecarPath,
        generator: parsed.generator ?? null,
        unit: parsed.unit ?? null,
        upAxis: parsed.upAxis ?? null,
        declaredHeight: parsed.declaredHeight ?? null,
        declaredHeightKind: parsed.declaredHeightKind ?? null,
      }
    } catch (error) {
      blockers.push({
        code: 'E_MESH_SOURCE_UNREADABLE',
        message: `the mesh's source.json could not be read next to ${meshPath} (${error?.message ?? error}). Without it the mesh's unit/upAxis/declaredHeight are unknown — and guessing them silently rotates or rescales the model.`,
        path: sidecarPath,
      })
    }

    // ---- 声明 vs 测量：这是"不静默"的最后一道闸 ----
    const item = (Array.isArray(args.assembly) ? args.assembly : []).find((x) => x && x.path === meshPath)
    if (meshSource && item?.source) {
      const pairs = [
        ['unit', meshSource.unit, item.source.unit],
        ['up_axis', meshSource.upAxis, item.source.up_axis],
        ['declared_height', meshSource.declaredHeight, item.source.declared_height],
      ]
      const bad = pairs.filter(([, fileSays, paramsSay]) => paramsSay !== undefined && fileSays !== null && String(fileSays) !== String(paramsSay))
      if (bad.length > 0) {
        blockers.push({
          code: 'E_MESH_SOURCE_MISMATCH',
          message: `the file's source.json disagrees with the parameters: ${bad.map(([key, fileSays, paramsSay]) => `${key}: file says ${JSON.stringify(fileSays)}, parameters say ${JSON.stringify(paramsSay)}`).join('; ')}`,
          path: sidecarPath,
        })
      }
    }
    try {
      const bytes = await tctx.fs.read(meshPath)
      const bounds = glbWorldBounds(bytes)
      if (!bounds.ok) {
        blockers.push({
          code: 'E_MESH_UNMEASURABLE',
          message: `the mesh could not be measured (${bounds.why}). A size claim that cannot be measured must not be recorded as verified.`,
          path: meshPath,
        })
      } else if (bounds.rotated) {
        blockers.push({
          code: 'E_MESH_MEASUREMENT_LIMITED',
          message: `a node carries a rotation, so an axis-aligned world box would be wrong. Size is NOT asserted — we would rather say "cannot measure" than print a wrong number.`,
          path: meshPath,
        })
      } else if (item?.source && typeof item.source.up_axis === 'string') {
        const up = String(item.source.up_axis).toUpperCase()
        const num = (key) => (item[key] && typeof item[key].v === 'number' && Number.isFinite(item[key].v) ? item[key].v : null)
        const w = num('w')
        const d = num('d')
        const h = num('h')
        if (w !== null && d !== null && h !== null) {
          // 参数用我们的空间（up=Z）；文件用自己的空间（由 up_axis 声明）⇒ 按声明换轴再比。
          const declared = up === 'Y' ? [w, h, d] : up === 'Z' ? [w, d, h] : [h, w, d]
          const rel = declared.map((v, i) => Math.abs(bounds.size[i] - v) / Math.max(Math.abs(v), 1e-9))
          const worst = Math.max(...rel)
          // 容差按**声明的精度**推，而不是固定 1e-5：写 4 位小数的人不可能比 5e-5 更准（实测踩过）。
          const sizeTol = Math.max(...declared.map((v) => declarationRelativeTolerance(v)))
          meshMeasured = {
            up_axis: up,
            size_in_file: bounds.size.map((v) => Number(v.toFixed(9))),
            size_declared: declared,
            relative_tolerance: Number(sizeTol.toFixed(9)),
            nodes_measured: bounds.nodes,
            worst_relative_difference: Number(worst.toFixed(9)),
          }
          // 第三道闸门：**文件自己的声明 vs 文件的实测**。
          // 前两道各管一半（sidecar vs 参数、参数 vs 实测），于是 sidecar 的 declaredHeight 被读进来、
          // 被记下来，却从来没有一道闸门看它一眼 —— 实测抓到过：sidecar 声明 3、实测 2，无人拦。
          if (meshSource && Number.isFinite(Number(meshSource.declaredHeight))) {
            const declaredHeight = Number(meshSource.declaredHeight)
            const axisIndex = up === 'Y' ? 1 : up === 'Z' ? 2 : 0
            const measuredAlongUp = bounds.size[axisIndex]
            const relUp = Math.abs(measuredAlongUp - declaredHeight) / Math.max(Math.abs(declaredHeight), 1e-9)
            const tolUp = declarationRelativeTolerance(declaredHeight)
            meshMeasured.declared_height_from_file = declaredHeight
            meshMeasured.measured_along_up_axis = Number(measuredAlongUp.toFixed(9))
            meshMeasured.up_axis_relative_difference = Number(relUp.toFixed(9))
            meshMeasured.up_axis_relative_tolerance = Number(tolUp.toFixed(9))
            if (relUp > tolUp) {
              blockers.push({
                code: 'E_MESH_DECLARED_HEIGHT_MISMATCH',
                message: `the file's own source.json declares declaredHeight=${declaredHeight}, but the mesh measures ${measuredAlongUp.toFixed(9)} along the declared ${up} axis (relative difference ${relUp.toExponential(3)}, tolerance ${tolUp.toExponential(3)} — the tolerance follows the declaration's own precision). A declaration that nothing compares is decoration, so this gate exists: either the declaration or the generator's output is wrong.`,
                path: sidecarPath,
              })
            }
          }
          if (worst > sizeTol) {
            blockers.push({
              code: 'E_MESH_SIZE_MISMATCH',
              message: `declared ${declared.map((v) => String(v)).join(' × ')} (up=${up}) but the file measures ${bounds.size.map((v) => v.toFixed(9)).join(' × ')} — worst relative difference ${worst.toExponential(3)}, tolerance ${sizeTol.toExponential(3)} (the tolerance follows the declaration's own precision). A generated mesh is not reproducible, so this cannot be "fixed" by regenerating: either the declaration or the file is wrong.`,
              path: meshPath,
            })
          }
        }
      }
    } catch (error) {
      // **区分"文件读不了"和"我们自己的代码炸了"**：后者必须是响亮的 bug，不能伪装成数据问题。
      // （实测：漏了一个 import，8 条断言全变成 E_MESH_UNMEASURABLE，一条线索都没有。）
      const name = error?.name ?? ''
      if (name === 'ReferenceError' || name === 'TypeError' || name === 'SyntaxError') {
        blockers.push({
          code: 'E_MESH_MEASUREMENT_BUG',
          message: `measuring the mesh threw ${name} (${error?.message ?? error}) — that is a bug in this plugin, not something about the file.`,
          path: meshPath ?? sidecarPath,
        })
      } else {
        blockers.push({
          code: 'E_MESH_UNMEASURABLE',
          message: `the mesh could not be re-read for measurement (${error?.message ?? error}).`,
          path: meshPath,
        })
      }
    }
  }

  return {
    files,
    ok: blockers.length === 0 && emission.ok && aligned && checked.within_tolerance && (!scene || (scene.available === true && scene.ok === true)),
    blockers: [
      ...blockers,
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
      // **失败也必须能只靠磁盘读出来**：report.json 是权威副本（宿主可能把工具结果换成
      // TOOL_OUTCOME_UNKNOWN，结果与失败原因会一起丢）。所以 ok 与 blockers 必须写进报告本身 ——
      // 否则消费方看到"产物齐全"就会误读成"这单通过了"（实测被这样提醒过）。
      ok: blockers.length === 0,
      blockers: blockers.map((b) => ({ code: b.code, message: b.message, path: b.path ?? null })),
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
      // 便宜那一档的**结论**必须进交付物。没有它，一个 `numeric` 档的交付包落盘的证据只有残差，
      // "验了什么"只活在对话里 —— 审计者只能自己重跑 fit。这里放**摘要**（与 scene_readback 摘要并列），
      // 不是全文：正文仍在 fit 的返回里。
      checks: {
        anchor: anchorReport(args),
        declared_confidence: declaredConfidence(args),
        photo_check: photoCheckFindings(args, outline),
        silhouette: silhouetteCheck.finding,
        // 源图那一环的结论（声明 vs 真实字节的 sha256）。
        image: imageCheck.finding,
        overlaps: overlapFindings(boxes),
        parts: partCensus(args),
        placement: placementReport(boxes),
        generated: generatedReport(args),
      },
      // 包里到底有没有模型本身？null = 这一轮没有导出，不是"有但没登记"。
      scene_file: sceneFile,
    mesh_file: meshFile,
    mesh_source: meshSource,
    mesh_measured: meshMeasured,
      // ③ 交付物里必须有"图纸"这一项：复核对象是它，不是六张分图。
      sheet: {
        artifact: 'sheet.svg',
        convention: sheet.layout.convention,
        shared_scale: sheet.scale,
        width: sheet.width,
        height: sheet.height,
        cells: sheet.cells,
      },
      // ③ 复核对象：整张图纸（含全图比例尺与格位），消费者不必自己拼六张分图。
      sheet: {
        artifact: 'sheet.svg',
        convention: sheet.layout.convention,
        shared_scale: sheet.scale,
        width: sheet.width,
        height: sheet.height,
        cells: sheet.cells,
        review_before_apply_ops: SHEET_REVIEW_ITEMS,
      },
      capability_source: emission.capability_source,
      target_capability_set: emission.target_capability_set,
      assumptions: Array.isArray(args.assumptions) ? args.assumptions : [],
      // 降级误差必须一路传到最终用户面前（CONTRACT §10）：
      unlowered: emission.unlowered,
      // 真·approx 单独列出来：它**建出来了**，只是形状被近似过 —— 与 unlowered 不是一件事。
      approximated: emission.approx ?? [],
      primitive_gate: emission.primitive_gate ?? null,
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

/** 尺寸类字段：必须为正。z / at 不在此列 —— 负标高（地下室）是合法的。 */
const SIZE_KEYS = ['w', 'd', 'h', 'dia']

/**
 * 模型申明的读数区间**允许有多宽**（相对半宽）。
 *
 * 0.30 不是猜的，是**实测来的**：同一个模型对**同一张照片**两次读数给出 w_over_h = 0.60 与 0.77，
 * 相差 28%。也就是说它自己的读数噪声就在这个量级。三件事随之确定：
 *
 *  1. 容差不能小于噪声 —— 原先固定 ±25% 恰好在噪声里，那次"13.4% 通过"其实没有意义。
 *  2. 所以判定改成"**算出来的值落不落在模型申明的区间里**"，而不是与一个点比。
 *  3. 但申明的区间**必须有上限**，否则声明 ±100% 就什么都通过了 —— 那是新的同义反复。
 *
 * 定位要说清楚：**这一档只能抓量级性的错误**（比如差 2 倍），
 * **certify 不了 10% 级别的一致** —— 那是眼睛读数根本做不到的事。载荷里必须这么写，不能含糊。
 */
const PHOTO_CHECK_MAX_RELATIVE_HALF_WIDTH = 0.3

/**
 * 边界容差的绝对上限（相对区间中点）。
 *
 * **实测抓到过一次**：模型申明区间 [0.55, 0.78]、几何算出 0.780736 —— **只超上界 0.0007（0.09%）**，
 * 却被判成和"差 2 倍"一样的 blocking。这是**用比输入精度更高的判据**去比，
 * 与当初"残差必须恰好为 0"（1 ulp 把闭环堵死）**是同一类错误，只是换了个地方**。
 */
const PHOTO_CHECK_MAX_BOUND_TOLERANCE_RELATIVE = 0.02

/** 模型写下的数有几位小数，它的边界就有多大误差：写 `0.78` 就是 2 位 ⇒ ±0.005。
 *  再封顶在中点的 2%，免得写整数（`1` ⇒ 0.5）时容差宽得失去意义。 */
function declaredBoundTolerance(lo, hi) {
  const decimalsOf = (n) => {
    const s = String(Math.abs(n))
    const i = s.indexOf('.')
    return i < 0 ? 0 : s.length - i - 1
  }
  const quantum = 0.5 * 10 ** -Math.max(decimalsOf(lo), decimalsOf(hi))
  const mid = Math.abs((lo + hi) / 2)
  return Math.min(quantum, PHOTO_CHECK_MAX_BOUND_TOLERANCE_RELATIVE * mid)
}

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

/**
 * 参数文件的**规范键序**（canonical）。
 *
 * 为什么必须有这一步：`parameters.json` 的值来自**调用方写的参数对象**，而嵌套对象的键序
 * 跟着调用方走。实测（2026-10-09，同一组参数、两次 save）：
 *   photo-round-3-candidate  →  assembly 项 `id, feature, w, d, h, at`、`frame` = `up, front, handed`
 *   photo-round-3            →  同值，但 `at, d, feature, h, id, w`、`frame` = `front, handed, up`
 * **取值逐项相同，字节不同**。于是两件事同时失效：交付物"同参数 ⇒ 逐字节相同"这条不成立，
 * 以及 ④ 规范摆放所服务的那件事（"两轮 diff 只看数值"）—— diff 里每一行都在动。
 *
 * JSON 的键序**没有语义**，所以规范化不丢任何信息，只是把**不该属于判据的那个自由度**收掉：
 * 顶层按 `INTENT_KEYS`（= `intentParamsOf` 已保证），assembly 项按声明顺序，其余对象按键名排序，
 * 数组顺序不动。
 */
function canonicalParams(args) {
  const order = (value, preferred) => {
    if (Array.isArray(value)) return value.map((item) => order(item, null))
    if (!value || typeof value !== 'object') return value
    const keys = Object.keys(value)
    const known = (preferred ?? []).filter((k) => keys.includes(k))
    const rest = keys.filter((k) => !known.includes(k)).sort()
    return Object.fromEntries([...known, ...rest].map((k) => [k, order(value[k], null)]))
  }
  const params = intentParamsOf(args)
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) => order(item, key === 'assembly' ? ASSEMBLY_ITEM_ORDER : null))
        : order(value, null),
    ]),
  )
}

/**
 * 源图那一环：**声明必须可核对**。
 *
 * 背景（实测抓到的）：包里的 `source.input_image_sha256` 曾是 64 个 a 的占位符，而**没有任何一道闸门
 * 看它一眼** —— 于是"此网格源自那张图"在包内**不可核对**，交付包在**声称**一条它证明不了的链。这里把它
 * 变成可核对的：
 *   - 声明了 sha 却**没给 `image_file`** ⇒ blocker（没有东西能核的声明就是装饰）；
 *   - 给了 `image_file` ⇒ 按**真实字节**算 sha256 与每个声明比，不符即 blocker；
 *   - 源图同时被登记成描述符（只登记不复制）—— 包里因此第一次能同时看到"这张图 → 这个网格"。
 */
async function imageFinding(tctx, args) {
  const blockers = []
  const declared = (Array.isArray(args?.assembly) ? args.assembly : [])
    .filter((item) => item && typeof item.source?.input_image_sha256 === 'string' && item.source.input_image_sha256.trim() !== '')
    .map((item) => ({ id: item.id ?? null, declared: item.source.input_image_sha256.trim().toLowerCase() }))
  const file = typeof args?.image_file === 'string' && args.image_file.length > 0 ? args.image_file : null
  if (declared.length === 0 && !file) return { finding: null, blockers, bytes: null }
  if (!file) {
    blockers.push({
      code: 'E_IMAGE_NOT_VERIFIED',
      message: `${declared.length} item(s) declare source.input_image_sha256 (${declared
        .map((d) => d.id)
        .join(', ')}) but no image_file was given, so nothing can check that claim. Either pass image_file (the photograph itself) or drop the field: a digest that nothing compares is decoration, and the pack would advertise a provenance chain it cannot show.`,
    })
    return { finding: { declared, computed: null, path: null, matches: null }, blockers, bytes: null }
  }
  if (typeof tctx?.fs?.read !== 'function') {
    blockers.push({ code: 'E_NO_FS', message: 'reading the source image needs the fs seam', path: file })
    return { finding: { declared, computed: null, path: file, matches: null }, blockers, bytes: null }
  }
  let bytes
  try {
    bytes = await tctx.fs.read(file)
  } catch (error) {
    blockers.push({
      code: 'E_IMAGE_FILE_UNREADABLE',
      message: `image_file could not be read (${error?.message ?? error}); the claimed provenance cannot be checked, and an unverifiable claim is worse than no claim.`,
      path: file,
    })
    return { finding: { declared, computed: null, path: file, matches: null }, blockers, bytes: null }
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const computed = createHash('sha256').update(buf).digest('hex')
  const matches = []
  for (const d of declared) {
    const ok = d.declared === computed
    matches.push({ id: d.id, declared: d.declared, matches: ok })
    if (!ok) {
      blockers.push({
        code: 'E_IMAGE_SHA_MISMATCH',
        message: `"${d.id}" declares input_image_sha256 ${d.declared.slice(0, 12)}… but ${file} hashes to ${computed.slice(0, 12)}… — the pack claims this mesh came from that photograph, and that claim is wrong.`,
        path: file,
      })
    }
  }
  return { finding: { declared, computed, path: file, matches, bytes: buf.length }, blockers, bytes: buf }
}

// fit 的输入 = emit_ops 的输入 + 一个可选的"是否引入外部事实"开关。
/** 照片读数（区间）→ 中点。没有读数就返回 null：那一档是**没发生**，不是"通过"。 */
function photoCheckMidAspect(photoCheck, view) {
  const reading = photoCheck?.[view]
  if (!reading || typeof reading.w_over_h_min !== 'number' || typeof reading.w_over_h_max !== 'number') return null
  return (reading.w_over_h_min + reading.w_over_h_max) / 2
}

/**
 * 读一张剪影图，并与参数侧 `outline`（几何自洽）和 `photo_check`（像不像照片）比。
 * 返回 `{ finding, blockers }`；**绝不抛错** —— 读不到/解不开/没有尺度都是**明确 blocker**，
 * 因为"没发生"必须和"通过了"分开说。
 */
async function silhouetteFinding(tctx, spec, outline, photoCheck) {
  const blockers = []
  if (!spec) return { finding: null, blockers }
  if (typeof tctx?.fs?.read !== 'function') {
    blockers.push({ code: 'E_NO_FS', message: 'the silhouette comparison needs the fs seam to read the render', path: spec.path })
    return { finding: null, blockers }
  }
  let bytes
  try {
    bytes = await tctx.fs.read(spec.path)
  } catch (error) {
    blockers.push({
      code: 'E_SILHOUETTE_UNREADABLE',
      message: `the silhouette render could not be read (${error?.message ?? error}). No silhouette comparison happened — do not read its absence as agreement.`,
      path: spec.path,
    })
    return { finding: null, blockers }
  }
  let metrics
  try {
    metrics = silhouetteOf(bytes)
  } catch (error) {
    blockers.push({ code: 'E_SILHOUETTE_UNREADABLE', message: `the silhouette render could not be decoded (${error?.message ?? error}).`, path: spec.path })
    return { finding: null, blockers }
  }
  if (Number.isInteger(spec.width) && spec.width !== metrics.width) {
    blockers.push({ code: 'E_SILHOUETTE_SIZE_MISMATCH', message: `the caller declared width ${spec.width} but the PNG is ${metrics.width} px wide`, path: spec.path })
  }
  if (Number.isInteger(spec.height) && spec.height !== metrics.height) {
    blockers.push({ code: 'E_SILHOUETTE_SIZE_MISMATCH', message: `the caller declared height ${spec.height} but the PNG is ${metrics.height} px tall`, path: spec.path })
  }
  const view = spec.view ?? 'front'
  const entry = (outline ?? []).find((o) => o.view === view) ?? null
  const compared = compareSilhouette(
    { ...metrics, view },
    {
      orthoScale: spec.ortho_scale,
      sensorFit: spec.sensor_fit,
      // numericOutline 给的是 `u_span_m` / `v_span_m`（米），这里对齐字段名。
      outline: entry && Number.isFinite(entry.u_span_m) && Number.isFinite(entry.v_span_m) ? { u_span: entry.u_span_m, v_span: entry.v_span_m } : null,
      expectedAspect: photoCheckMidAspect(photoCheck, view),
    },
  )
  blockers.push(...compared.blockers)
  return {
    finding: {
      path: spec.path,
      view,
      declared_ortho_scale: spec.ortho_scale,
      declared_sensor_fit: spec.sensor_fit ?? null,
      compared,
    },
    blockers,
  }
}

const FIT_INPUT = {
  type: 'object',
  properties: {
    ...EMIT_OPS_INPUT.properties,
    against_scene: { type: 'boolean' },
    // 正交渲染出的剪影图（可选）：给了就多一档"轮廓像不像"的可判结论（SILHOUETTE-PLAN）。
    silhouette: SILHOUETTE_INPUT,
    // 源照片的**真实路径**（可选但强烈建议）：给了才会去核 `source.input_image_sha256` 那些声明。
    image_file: { type: 'string', minLength: 2 },
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
  E_ARG_RANGE: 'that size must be greater than zero — a non-positive size silently degenerates or flips in Blender',
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
      .filter(([, r]) => r.status !== 'unsupported' && r.requiresOp === undefined)
      .map(([f]) => f),
    // 这些规则**本版已经能 lower**，但要真发出去还取决于目标是否声明了那张 op ⇒
    // **不能**混进 emitter_ready_features（那等于声称一个目标可能没有的能力）。
    emitter_ready_when_target_declares: Object.entries(LOWERING)
      .filter(([, r]) => r.status !== 'unsupported' && r.requiresOp !== undefined)
      .map(([f, r]) => ({ feature: f, requires_op: r.requiresOp })),
    unlowered_total: un.length,
    downstream_cannot: pick('no_downstream_op'),
    downstream_has_no_primitive: pick('no_downstream_primitive'),
    emitter_not_yet: pick('not_implemented_in_m1'),
    declared_by_author: pick('declared_by_parameter_file'),
    needs_attention: [...pick('unknown_feature'), ...pick('undecided')],
    // 真·approx：**已经 low 出来了，但形状被近似过** —— 与 unlowered 是两件事。
    approximated: (emission.approx ?? []).map((a) => ({ id: a.id, feature: a.feature, object_name: a.object_name, how: a.how, error_note: a.error_note })),
    primitive_gate: emission.primitive_gate ?? null,
    note: 'downstream_cannot, downstream_has_no_primitive and emitter_not_yet are different problems with different fixes: keep them apart. approximated means it WAS built, only approximately.',
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
  // **一条真米数不需要锚点**，只要它明说"这些值是设计给定的"。
  // 实测抓到过：一轮 M2 尺寸校验用的就是真米数（8 米的板、3 米的柱），却被"缺 scale_anchor"
  // 判成 blocking —— 那个检查默认了"参数一定来自照片"，而设计给定的尺寸根本不需要锚点。
  const authored = Array.isArray(params.assumptions) && params.assumptions.includes('authored_dimensions')
  if (!a || typeof a.pixel_len !== 'number' || typeof a.real_len !== 'number' || a.pixel_len === 0) {
    return {
      present: false,
      declared_ratios_only: ratiosOnly,
      declared_authored: authored,
      consequence: ratiosOnly
        ? 'these metres are declared to be ratios, not absolute lengths'
        : authored
          ? 'these metres are declared to be authored (a design brief), not measured from a photograph'
          : 'every metre in this file is really a RATIO until a scale_anchor grounds it',
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
 * 把"模型对照片的读数"与**我们自己算出来的数值轮廓**对一遍。
 *
 * 这是"一口气跑完"里唯一能把照片纳进来的机制：模型看得见照片、看不见我们的图，
 * 所以只能借它**说出来的数字**当输入。它躲不掉 —— 要么改几何、要么改它自己的读数，
 * 两者都摆在明面上。而随手填一个跟几何一样的数字，等于承认"我按模型反推的"，
 * 那就等于没读（这一点写在建议里，逼它自己说清楚）。
 */
function photoCheckFindings(params, outline) {
  const declared = params.photo_check
  if (!declared || typeof declared !== 'object' || Object.keys(declared).length === 0) {
    return {
      declared_views: 0,
      max_relative_half_width: PHOTO_CHECK_MAX_RELATIVE_HALF_WIDTH,
      rows: [],
      note: 'no photo_check: nothing in the parameter file records what the model saw in the photograph, so the shape-vs-photo step stays unchecked self-discipline',
    }
  }
  const computed = Object.fromEntries((outline ?? []).map((o) => [o.view, o.w_over_h]))
  const rows = []
  for (const [view, reading] of Object.entries(declared)) {
    if (!reading || typeof reading.w_over_h_min !== 'number' || typeof reading.w_over_h_max !== 'number') continue
    const lo = Math.min(reading.w_over_h_min, reading.w_over_h_max)
    const hi = Math.max(reading.w_over_h_min, reading.w_over_h_max)
    const mid = (lo + hi) / 2
    const relHalf = mid === 0 ? Infinity : (hi - lo) / 2 / mid
    const mine = computed[view]
    const boundTol = declaredBoundTolerance(lo, hi)
    rows.push({
      view,
      declared_interval: [lo, hi],
      relative_half_width: Number.isFinite(relHalf) ? round6(relHalf) : null,
      interval_is_too_wide: relHalf > PHOTO_CHECK_MAX_RELATIVE_HALF_WIDTH,
      computed: typeof mine === 'number' ? mine : null,
      // 按**申明的精度**判：写 0.78 就是 2 位小数 ⇒ 边界有 ±0.005 的写法误差。
      // 同时如实给出不含容差的严格判定，让"擦边"这件事看得见。
      bound_tolerance: round6(boundTol),
      inside: typeof mine === 'number' ? mine >= lo - boundTol && mine <= hi + boundTol : null,
      inside_ignoring_bound_precision: typeof mine === 'number' ? mine >= lo && mine <= hi : null,
      note: reading.note ?? null,
    })
  }
  return {
    declared_views: rows.length,
    max_relative_half_width: PHOTO_CHECK_MAX_RELATIVE_HALF_WIDTH,
    rows,
    note: 'declared_interval comes from the model reading the photograph; computed comes from this model\'s own projection of its own parameters. This tier can catch errors of magnitude, not certify agreement to within 10% - an eyeballed silhouette cannot support that.',
  }
}

/**
 * 共享部件词汇表 —— 跨"参数化"与"生成网格"两条路对齐用的。
 *
 * 为什么需要它：StdGEN 那类项目的核心贡献是**语义分解**（身体/衣服/头发分开），而我们的
 * `assembly` 本来就是**带名字的部件**。两边在"命名部件"上撞到了同一个答案，但**名字不同** ——
 * 没有共同分类，就只能比"总数"，比不了"哪一个"。
 *
 * 两个轴必须分清（历史上混过一次 acquisition/provenance，教训在 notes §9.9）：
 *   part   —— 这东西**是什么**（body / clothing / hair / …）   ← 本表
 *   source —— 它**怎么来的**（参数化 / 生成的网格）             ← 描述符的 provenance
 */
const PART_TAXONOMY = {
  body: '人物/生物的本体部件：头、躯干、四肢、五官',
  clothing: '穿在身上的：衣、裤、鞋、帽',
  hair: '毛发',
  prop: '手持或随场景的小物：棒、球、器具',
  structure: '建筑构件：墙、柱、板、屋面、楼板',
  furniture: '家具',
  ground: '地面/基座/场地',
}

/**
 * 部件清点：哪些部件存在、各自几个对象、以及**缺分类的**。
 *
 * 缺 `part` 只给 **warning** 不给 blocking —— 已有模型（photo-round-1b/2）都不带这个字段，
 * 不该因此失效。但报告必须把它列出来，否则这张表永远不会被用上。
 */
function partCensus(params) {
  const items = Array.isArray(params.assembly) ? params.assembly : []
  const byPart = {}
  const undeclared = []
  const unknown = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : null
    const part = typeof item.part === 'string' ? item.part : null
    if (part === null) {
      if (id) undeclared.push(id)
      continue
    }
    if (!Object.hasOwn(PART_TAXONOMY, part)) unknown.add(part)
    const bucket = byPart[part] ?? (byPart[part] = { count: 0, ids: [] })
    bucket.count += 1
    if (id) bucket.ids.push(id)
  }
  return {
    taxonomy: Object.keys(PART_TAXONOMY),
    declared_parts: Object.keys(byPart),
    by_part: byPart,
    undeclared,
    unknown_values: [...unknown],
    note: 'part says what a thing IS; how it was made (parametric vs generated mesh) is a separate axis, recorded as provenance.',
  }
}

/**
 * 规范摆放 —— **让同一模型的两次迭代可以直接 diff**。
 *
 * 借的是 CharacterGen "规范化"的思路，但用在另一半上：它统一的是**姿势**，我们缺的是**摆放**。
 * 我们已经有 `frame`（轴对了），可整体可能偏在一边 —— 实测 `photo-round-2` 的水平包络是
 * x[-0.33, 0.38]，并没有居中。不居中的话，两次改动里的整体位移会混进**每个对象**的坐标，
 * 看 diff 全是噪音。
 *
 * 约定：**底面贴 z=0、水平居中**。容差按模型自身尺寸取**相对值**（"判据精度不能超过输入精度"
 * 那条同样适用）。**只报不挡** —— 这是"便于比较"的约定，不是几何正确性。
 */
function placementReport(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { available: false, convention: 'envelope bottom on z=0, centred on x and y', note: 'no objects to measure' }
  }
  const min = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k])))
  const max = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])))
  const size = [0, 1, 2].map((k) => max[k] - min[k])
  const tol = Math.max(1e-9, 0.01 * Math.max(...size))
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]
  return {
    available: true,
    convention: 'envelope bottom on z=0, centred on x and y, so two versions of the same model diff cleanly',
    envelope_min: min.map(round6),
    envelope_max: max.map(round6),
    envelope_size: size.map(round6),
    base_z: round6(min[2]),
    horizontal_centre: centre.map(round6),
    tolerance: round6(tol),
    on_ground: Math.abs(min[2]) <= tol,
    centred: Math.abs(centre[0]) <= tol && Math.abs(centre[1]) <= tol,
  }
}

/**
 * 生成物（`source.kind` 存在）的清单与来源。
 *
 * 这一段存在的唯一理由是**诚实**：这一类部件的**形状，我们三档校验一个都验不了** ——
 * `numeric` 不适用（没有参数）、`photo_check` 不适用、读回只管存在/位置/尺寸。
 * 所以报告必须把"验不了什么"写在明处，**而不是让一个绿勾暗示它被验过了**。
 *
 * 顺带把"能不能复算"标出来：参数化产物可以（实测同参数 → ops 与六视图逐字节相同），
 * 生成物不可以（要 模型 + 权重 + seed）。
 */
function generatedReport(params) {
  const items = Array.isArray(params.assembly) ? params.assembly : []
  const declared = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || !item.source) continue
    const kind = typeof item.source.kind === 'string' ? item.source.kind : null
    const missing = []
    if (kind === 'generated_mesh') {
      if (typeof item.source.model !== 'string') missing.push('model')
      if (typeof item.source.seed !== 'number') missing.push('seed')
      if (typeof item.source.input_image_sha256 !== 'string') missing.push('input_image_sha256')
    }
    declared.push({
      id: item.id ?? null,
      part: item.part ?? null,
      source_kind: kind,
      reproducible: kind === null || kind === 'parametric',
      provenance: {
        model: item.source.model ?? null,
        weights: item.source.weights ?? null,
        seed: item.source.seed ?? null,
        input_image_sha256: item.source.input_image_sha256 ?? null,
      },
      missing_for_reproducibility: missing,
      path: item.path ?? null,
    })
  }
  const nonReproducible = declared.filter((item) => !item.reproducible)
  return {
    declared,
    // 这句话必须**描述实际声明了什么**，不能一律套生成物的口径：
    // 只有参数化来源时，说"形状验不了"是假的（numeric 就验它）。
    note:
      nonReproducible.length === 0
        ? 'every declared source is parametric: such a part is reproducible from these parameters and its shape IS covered by numeric.'
        : 'a non-parametric source is NOT reproducible from these parameters: re-deriving it needs the same model, weights and seed. And its SHAPE cannot be verified by any tier here — numeric and photo_check do not apply, and the readback covers only existence, placement and dimensions.',
  }
}

/**
 * 墙嵌进楼板是合理的。
 *
 * **两个阈值，且都必须写进载荷**：>0.5 才列出来，>0.9 才标 almost_hidden。
 * 实测被抓到过：早期只解释了 0.5、`almost_hidden` 的阈值一个字没写 ——
 * 于是 0.8845 那一行"报了却不算 almost_hidden"，读者无法自己判断，只能拒绝背书。
 * **载荷里的每个数字都要能被读者自己解释，否则它就是不可核的。**
 */
const OVERLAP_LISTING_THRESHOLD = 0.5
const OVERLAP_ALMOST_HIDDEN_THRESHOLD = 0.9

function overlapFindings(boxes) {
  const xs = boxes ?? []
  if (xs.length > 200) {
    return {
      checked_pairs: 0,
      listing_threshold: OVERLAP_LISTING_THRESHOLD,
      almost_hidden_threshold: OVERLAP_ALMOST_HIDDEN_THRESHOLD,
      significant: [],
      note: `skipped: ${xs.length} objects would be ${(xs.length * (xs.length - 1)) / 2} pairs`,
    }
  }
  const vol = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2])
  const significant = []
  let pairs = 0
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      pairs += 1
      const a = xs[i]
      const b = xs[j]
      const ov = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]))
      if (ov.some((v) => v <= 0)) continue
      const smaller = Math.min(vol(a), vol(b))
      if (smaller <= 0) continue
      const fraction = (ov[0] * ov[1] * ov[2]) / smaller
      // **判定必须用"报告里印出来的那个数"**。实测被抓到过：未舍入的 0.5000000… 通过了 `> 0.5`，
      // 而输出把分数舍成 `0.5` —— 于是出现"印着 0.5 却被列出来"这种读者无法自行解释的行。
      // 判定与报告必须是同一个数（这是"载荷里每个数字都要能自证"那条的又一面）。
      const reported = round6(fraction)
      if (reported > OVERLAP_LISTING_THRESHOLD) {
        significant.push({
          a: a.name,
          b: b.name,
          overlap_fraction_of_smaller: reported,
          almost_hidden: reported > OVERLAP_ALMOST_HIDDEN_THRESHOLD,
        })
      }
    }
  }
  return {
    checked_pairs: pairs,
    listing_threshold: OVERLAP_LISTING_THRESHOLD,
    almost_hidden_threshold: OVERLAP_ALMOST_HIDDEN_THRESHOLD,
    significant,
    note: `listed only when more than ${OVERLAP_LISTING_THRESHOLD} of the smaller object sits inside the other; almost_hidden is a second, stricter threshold at ${OVERLAP_ALMOST_HIDDEN_THRESHOLD}, so an entry can be listed with almost_hidden false. Objects that merely touch are not listed.`,
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
function reviseHints(params, emission, caps, { checked, aligned, fromParams, outline, overlaps, boxes }) {
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
  if (!anchor.present && !anchor.declared_ratios_only && !anchor.declared_authored) {
    add(
      'blocking',
      'scale_anchor',
      'no scale_anchor, so every metre is really a ratio',
      `${anchor.how_to_fix}; or declare assumptions:["proportions_only"] if proportions are all you want, or assumptions:["authored_dimensions"] if the values are a design brief rather than something read off a photograph`,
    )
  }

  for (const u of emission.unlowered) {
    if (u.reason_code === 'no_downstream_op') {
      add('warning', String(u.id), `the downstream cannot express "${u.feature}" (${u.reason})`, 'drop it, or declare it in unresolved[] so the gap reaches the reader instead of being silently lost')
    } else if (u.reason_code === 'no_downstream_primitive') {
      add('warning', String(u.id), `the target has no primitive for "${u.feature}" (${u.reason})`, 'drop it, or declare it in unresolved[]')
    } else if (u.reason_code === 'not_implemented_in_m1') {
      add('warning', String(u.id), `this emitter cannot lower "${u.feature}" yet (${u.reason})`, 'drop it for now, or declare it in unresolved[]')
    } else if (u.reason_code === 'declared_by_parameter_file') {
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

  // 内部不一致 —— 但**别重复报**：如果 lowering 已经报了 blocker（缺声明、单位不合法…），
  // 那么"参数侧 N 个 vs ops 侧 0 条"正是**那些**造成的（被挡下的项不会产出 op），
  // 再报一条 blocking 只会误导（实测：sidecar 里 unit 用美式拼写，就同时冒出 E_ARG_RANGE 和"内部不一致"）。
  const explainedByEmissionBlocker = (emission.blockers ?? []).length > 0
  if (!aligned) {
    if (explainedByEmissionBlocker) {
      add(
        'warning',
        'assembly',
        `the parameter side sees ${fromParams.length} objects but the ops carry ${emission.op_count ?? 0} — this follows from the blocker(s) above, it is not a second problem`,
        'no separate action: fixing what that blocker names makes this disappear',
      )
    } else {
      add('blocking', 'assembly', `the parameter side sees ${fromParams.length} objects but the ops carry a different count`, 'this is an internal inconsistency: report it, do NOT tune the parameters to hide it')
    }
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

  // 真·approx：它**建出来了**，但形状被近似过。降级误差可能最大也最隐蔽（CONTRACT §10），
  // 所以每条都给一条 warning，把 how / error_note 摆到读者面前 —— 而且对象名已带 `_approx`。
  for (const a of emission.approx ?? []) {
    add('warning', String(a.id), `"${a.feature}" was built as "${a.object_name}" with an approximation (${a.how})`, `the gap is baked into the object name on purpose; ${a.error_note ?? 'see CONTRACT §5.1'} — either accept it, or declare it in unresolved[]`)
  }

  // ③ 那一关：模型写下的照片读数区间 vs 我们算出来的轮廓。
  // **这是把照片纳进自动循环的唯一机制。** 判定是"落在它申明的区间里"，不是"与一个点比"。
  const photo = photoCheckFindings(params, outline ?? [])
  for (const row of photo.rows) {
    if (row.interval_is_too_wide) {
      add(
        'blocking',
        `photo_check.${row.view}`,
        `the declared interval ${row.declared_interval[0]}..${row.declared_interval[1]}:1 is wider than ±${Math.round(PHOTO_CHECK_MAX_RELATIVE_HALF_WIDTH * 100)}%, so it cannot discriminate anything`,
        'read the photograph again and give a tighter interval — an interval that wide passes everything, which is the same as not having read it',
      )
      continue
    }
    if (row.inside === false) {
      const nearMiss = row.inside_ignoring_bound_precision === false
      add(
        'blocking',
        `photo_check.${row.view}`,
        `your reading of the photograph is ${row.declared_interval[0]}..${row.declared_interval[1]}:1, but this model projects ${row.computed}:1 — outside that interval${nearMiss ? ` (and beyond the ±${row.bound_tolerance} the written precision allows)` : ''}`,
        'reconcile: either the geometry is wrong or your reading is. Do NOT widen the interval or copy the computed number across — either turns this check into a tautology',
      )
    }
  }

  // 建模手滑：两个物体几乎占同一空间
  for (const o of overlaps?.significant ?? []) {
    add(
      'warning',
      String(o.b),
      o.almost_hidden
        ? `"${o.b}" sits ${Math.round(o.overlap_fraction_of_smaller * 100)}% inside "${o.a}" — it contributes almost nothing visible from any direction`
        : `"${o.a}" and "${o.b}" occupy almost the same space (${Math.round(o.overlap_fraction_of_smaller * 100)}% of the smaller one is inside the other)`,
      o.almost_hidden
        ? 'confirm this is intentional (a face mark sitting on a head block is); otherwise it is a placement error that the front view would hide'
        : 'check for a duplicated or misplaced object',
    )
  }

  // ① 共享部件词汇表：缺分类只 warning，但必须被列出来 —— 否则这张表永远不会被用上。
  const census = partCensus(params)
  if (census.undeclared.length > 0) {
    add(
      'warning',
      'assembly',
      `${census.undeclared.length} item(s) declare no part`,
      `adding part: <one of ${census.taxonomy.join(' / ')}> to each item lets this model be compared at the part level against a generated mesh's decomposition (StdGEN-style body/clothes/hair)`,
      census.undeclared.join(','),
    )
  }
  for (const value of census.unknown_values) {
    add(
      'warning',
      'assembly',
      `part value "${value}" is not in the shared vocabulary`,
      `use one of ${census.taxonomy.join(' / ')}, or add "${value}" to the vocabulary deliberately — an unshared name cannot be aligned across the two paths`,
    )
  }

  // ④ 规范摆放：不居中/不落地会让"两次迭代的 diff"混进整体位移，全是噪音。只报不挡。
  const place = placementReport(boxes)
  if (place.available && (!place.on_ground || !place.centred)) {
    add(
      'warning',
      'placement',
      `${place.on_ground ? '' : `the model does not sit on z=0 (base at ${place.base_z}) `}${place.centred ? '' : `and is not centred (horizontal centre at ${place.horizontal_centre.join(', ')}, tolerance ${place.tolerance})`}`.trim(),
      'this is a comparability convention, not a correctness one: centring and grounding the model makes two versions of it diff cleanly instead of smearing the offset across every object',
    )
  }

  // ② 生成物：来源要记全（不可复算），而且**要明说形状验不了**
  //
  // 只有**不可复算**的来源才吃这条警告。`source.kind === 'parametric'` 是这套参数自己
  // 算出来的，两个可复算性都成立（同参数 → ops 与六视图逐字节相同，且形状由 numeric 覆盖），
  // 早期的实现无差别地对每个声明项都发"形状验不了"，等于把一个**不成立的**警告
  // 盖在一个**成立**的部件上 —— 又一次"把会变的事实写成常量"。仍然会出现在 `generated` 载荷里。
  const generated = generatedReport(params)
  for (const g of generated.declared) {
    if (g.reproducible) continue
    const missingNote = g.missing_for_reproducibility.length > 0 ? ` — and it records no ${g.missing_for_reproducibility.join(' / ')}` : ''
    const kindNote =
      g.source_kind === 'generated_mesh'
        ? 'a generated mesh is not reproducible from these parameters'
        : `a ${g.source_kind} source is not reproducible from these parameters`
    add(
      'warning',
      String(g.id),
      `"${g.id}" is declared as ${g.source_kind}: ${
        (emission.unlowered ?? []).some((u) => u.id === g.id)
          ? 'it will NOT enter the scene (the target declares no import op)'
          : 'it enters the scene through the import op the target declares'
      }, its SHAPE cannot be verified by any tier here, and ${kindNote}${missingNote}`,
      g.missing_for_reproducibility.length > 0
        ? 'record model / seed / input_image_sha256 in source, or the artifact is a one-off you can never regenerate'
        : 'keep the source block with the artifact; shape has to be judged visually, not by these tiers',
    )
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
        '只读、纯函数、**不落盘**。把参数 JSON 渲染成正交六视图的 SVG（主视图/俯视图/左视图/右视图/仰视图/后视图），并给出第一角法或第三角法的图面排布。**另外给出整张图纸（sheet_svg）**：六个视图按图面排布放到一张图上、全图共用同一个比例尺 —— 这是"贵的那一步之前"的单一复核对象。下游没有相机 op，严格正交六视图下游给不了，所以这里自己算正交投影 —— 零依赖。SVG 是文本，因此**模型可以直接读视图几何**：工具产出的图片像素进不了模型，文本可以。M1 只返回文本；"落盘 + 描述符（run-uuid / report.json / 幂等 / 清理）"归 agh_ortho_save。',
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
          sheet_svg: renderSheet(views, placement, { projection: args.projection }),
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
                  sheet_svg: {
                    convention: payload.sheet_svg.layout.convention,
                    shared_scale: payload.sheet_svg.scale,
                    width: payload.sheet_svg.width,
                    height: payload.sheet_svg.height,
                    cells: payload.sheet_svg.cells,
                  },
                  target_capability_set: payload.target_capability_set,
                  object_count: payload.object_count,
                  views: svgs.map((s) => ({ view: s.view, sheet: s.sheet, bytes: s.bytes, sha256: s.sha256 })),
                  unlowered: payload.unlowered,
                  unresolved: payload.unresolved,
                  note: 'six SVG documents are in the structured payload, one per view, PLUS sheet_svg (the whole six-view drawing on one sheet at one shared scale) — the sheet is the thing to review before the expensive step',
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
        '只读、纯函数。numeric 档校验（CONTRACT §9）：参数 → ops → 包围盒 → 六视图 → **从视图反解** → 与参数比对，残差必须为 0，且同一个轴被 4 张视图观测、4 个观测值必须彼此相等。走的是两条**独立路径**：一侧直接读参数叶子，另一侧读 lowering 产出的 ops —— 共用一条路径的话校验就是同义反复。**不需要 Blender**，这就是"扩下游之前就能交付价值"的关键解耦。它只证明几何自洽，不证明几何与真实照片一致。传 against_scene:true 会再跑一档 **scene_readback**（半档，名字如实）：向下游读一次场景（agh_blender_scene，只读、无需审批），比对"我打算创建的对象"是否按**确切名字**存在、类型是 MESH、location 与 scale 与我们发出的 ops 一致 —— 这是本插件第一次引入外部事实，因此能抓到 numeric 抓不到的"ops 发了但下游没建出来 / 名字被占用改成了 .001"。它**能**断言最终尺寸（下游 0.1.8 起发布 dimensions，容差是每行印出来的相对值，不是固定 1e-6）；**验不了**的是基元种类（catalog 不发布每类顶点/面数）与"与照片一致"；这两条会在返回里逐条列在 cannot_assert 里，因为"验不了什么"必须和"验到了什么"一样明确。缺实例或读不到场景时不会抛错，会报 E_SCENE_UNAVAILABLE 并明确说明**本档没有发生**，不要把 available:false 读成通过。',
      parameters: VERIFY_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const emission = emitOps(args, caps)
        const boxes = boxesFromOps(emission.ops)
        const views = sixViewRects(boxes)
        const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [], kindAvailableFor(caps))
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
              ? 'the size assertion is now active because this downstream publishes dimensions. Toward an image-level comparison the remaining pieces are: an orthographic option plus a scene-camera render downstream, and a silhouette-to-numbers step upstream (see cannot_assert)'
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
        '只读、纯函数、**不落盘**。把一份候选参数 JSON 变成一份**可审计的结论**，并明确告诉你**该改哪里**。一次调用给出：逐条 validation（每条都带 ok）、三态清单（区分"下游做不到"与"我还没做"）、numeric 自洽（残差必须为 0）、六视图的**数值轮廓**（outline，供你拿照片做粗核对 —— 你看见用户上传的照片，看不见工具产出的图像素）、六张 SVG，**外加一张整图纸的指针（sheet）**：六视图按第一角法/第三角法排在一张图上、全图一个比例尺 —— 复核就看这一张，而且必须在进 apply_ops 之前看（正文不进这个载荷，见 sheet.inline_from；20 个对象约 30 KB，同一份几何不值得发两遍）、conf 的如实标注、scale_anchor 的换算与脆弱性、以及逐项逐轴的 revise_hints。**进来先按这个顺序看三样**：① `validation` + `revise_hints` —— verdict=revise 时**只改被点名的位置**，一轮只改一处，否则无法归因是哪一步改好的；② `photo_check` —— **你必须在参数里写下从照片读到的比例区间**：`photo_check: { front: { w_over_h_min, w_over_h_max } }`（相对半宽 ≤30%，容差按你声明的小数位推），fit 才会拿它和你算出的 `outline` 自动对一遍；**不写它就等于这一档没有发生**，"像不像照片"会退回纯人眼；③ `anchor` —— 照片里没有已知长度的参照物时，必须**显式**在 `assumptions` 里写 `"proportions_only"`（或 `"authored_dimensions"`），**不要编一个看起来合理的米数**，否则它是 blocking。**verdict=fit 之后不要直接 apply_ops**：先 `agh_ortho_save` 落一个**候选**（run_id 带 `-candidate`，不碰 Blender），请人打开 `sheet.svg` 复核；人放行后才 apply_ops → `against_scene:true` 的 fit → 用**另一个** run_id 落交付包（同一个 run_id 会被幂等吃掉读回）。**边界说清楚**：numeric 与读回只证明"我自洽、下游照做了"，**都不证明与照片一致** —— 那一段只能靠你拿 `outline` / 那张图纸和照片比，加上人的眼睛。**可选**：传 `silhouette: { path, ortho_scale, sensor_fit }`（一张**正交渲染**的、带透明通道的 PNG）就多一档**可判**的"轮廓像不像"：它把剪影折算成米，同时与 `outline`（几何自洽）和 `photo_check`（像不像照片）比；`ortho_scale` 必填（像素↔米的唯一依据，缺了就没有判定），判据容差按**渲染分辨率**推（≥2 像素折算），对不上即 blocking。**另传 `image_file`（源照片的真实路径）会去核参数里声明过的 `source.input_image_sha256`**：相符才算"源自这张图"，**不符即 blocking**，而**声明了却没给 `image_file` 也 blocking**（没有东西能核的声明就是装饰）；同时把源图登记进交付包，让"这张图 → 这个网格"可核。',
      parameters: FIT_INPUT,
      meta: READ_ONLY_META,
      async execute(args, tctx) {
        const caps = await resolveTargetCapabilities(tctx)
        const emission = emitOps(args, caps)
        const boxes = boxesFromOps(emission.ops)
        const views = sixViewRects(boxes)
        const placement = sheetPlacement(args.projection)
        const scale = commonScale(views)
        const fromParams = extentsFromParams(Array.isArray(args.assembly) ? args.assembly : [], kindAvailableFor(caps))
        const fromOps = extentsFromBoxes(boxes)
        const aligned = fromParams.length === fromOps.length
        const checked = aligned
          ? residual(fromParams, views, boxes)
          : { max: Infinity, worst: 'parameter/ops list misalignment', rows: [] }
        const numericOk = emission.ok && aligned && checked.within_tolerance
        const outline = numericOutline(views)
        const overlaps = overlapFindings(boxes)
        // 剪影那一档（fit 侧）：与"几何自洽"和"照片读数"一起判 —— **读不到就是 blocker**，
        // 因为它必须与别的档一样影响 verdict，不能退化成"没提就不发生"的软选项。
        // 注意 fit 里**没有** `blockers` 数组（那是 verify/save 的）：结论走 verdict，所以这里直接进判定。
        const silhouetteFit = await silhouetteFinding(tctx, args.silhouette, outline, args.photo_check)
        const imageFit = await imageFinding(tctx, args)
        const revise = reviseHints(args, emission, caps, { checked, aligned, fromParams, outline, overlaps, boxes })
        const validation = validationReport(args, emission, caps)
        const verdict = numericOk && validation.ok && revise.blocking === 0 && silhouetteFit.blockers.length === 0 && imageFit.blockers.length === 0 ? 'fit' : 'revise'
        // ③ 便宜的那一步的**单一复核对象**：六视图排在一张图纸上，全图一个比例尺。
        const sheet = renderSheet(views, placement, { projection: args.projection })

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
          outline: outline.map((o) => ({ ...o, sheet: placement[o.view] ?? null })),
          // ③ 一张图纸（review 对象）。它和 outline 是同一件事的两种精度：outline 是数字，
          // sheet 是图形；**复核发生在贵的那一步之前**，所以指针必须在这里就有，而不是等 save。
          //
          // **有意不把 SVG 正文抄进来**：同一张图已经以 views[] 的分图形式在载荷里了，
          // 20 个对象的整图纸约 30 KB —— 把同一份几何再发一遍，纯粹是翻倍上下文。要正文就
          // 调 agh_ortho_views（sheet_svg），要文件就 save（sheet.svg）。
          sheet: {
            artifact: 'sheet.svg',
            inline_from: 'agh_ortho_views (returns the same drawing as sheet_svg.svg)',
            projection: args.projection,
            convention: sheet.layout.convention,
            shared_scale: sheet.scale,
            width: sheet.width,
            height: sheet.height,
            cells: sheet.cells,
            note: SHEET_NOTE,
            review_before_apply_ops: SHEET_REVIEW_ITEMS,
          },
          // ③ 那一关的可核部分：模型写下的照片读数 vs 我们算出来的轮廓。
          photo_check: photoCheckFindings(args, outline),
          // 剪影那一档：渲染出的轮廓 vs 上面两个（就像不像照片，这是可判的那一半）。
          silhouette: silhouetteFit.finding,
          // 剪影那一档的 blockers **单独列出**：读不到图时 finding 是 null，若只留 finding，
          // "没发生"就会变成载荷里看不见的东西 —— 那正是我们一直在防的。
          silhouette_blockers: silhouetteFit.blockers,
          // 源图那一环：声明 vs 真实字节的 sha256。
          image: imageFit.finding,
          image_blockers: imageFit.blockers,
          // 建模手滑（warning 级）
          overlaps,
          declared_relative_confidence: declaredConfidence(args),
          anchor: anchorReport(args),
          // ①④ 两条**跨路对齐**的段（都只报不挡）
          parts: partCensus(args),
          placement: placementReport(boxes),
          generated: generatedReport(args),
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
        '这是本插件唯一会写盘的工具，因此 requiresApproval=always。把一个 run 的全部产物落到工作区的 .agnes/agh-ortho/runs/<run-id>/：**一张六视图图纸 sheet.svg**、六个分视图 SVG、参数 JSON、ops 批次、numeric 校验结果，外加 marker.json 与 report.json（描述符数组，依据 agh-blender/docs/UPSTREAM-ARTIFACT-CONTRACT.md）。另可传 `scene_file`（下游 `agh_blender_export` 落盘的 .blend 的**真实路径**）：它会被**登记**成第 11 个产物（按原始字节算 sha256/bytes，**不复制**），于是包里第一次有了"模型本身"。**先落盘报告再返回**：消费者应以磁盘上的 report.json 为准，不以返回值或转述为准（`report.json` 里除了描述符还带 `checks` —— 便宜那一档的结论摘要，以及 `scene_file`）。传同一个 run_id 再调一次是幂等的 —— 直接返回已落盘的描述符，不重新生成（因此**复核用的候选与最终交付必须用两个不同的 run_id**：同一个 id 再调，`against_scene` 只会拿回旧描述符，读回永远不会被记录，返回里会明确报 `readback_not_recorded:true`）。每个描述符都带一句实质 preview，因为模型看不到图片像素，preview 是它唯一必然能读到的内容。',
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
          //
          // 幂等**会吃掉你想补的那一档**：候选那轮如果已经用同一个 run_id 落过盘，
          // 交付那轮的 `against_scene:true` 就只会拿回旧描述符，读回**永远不会被记录**。
          // 所以这里必须把"你要的读回没有发生"明确说出来 —— 这不是失败（重放本身是对的），
          // 但它是**必须被看见**的一件事。
          const hadReadback = existing.report.scene_readback?.available === true
          const wantsReadback = args.against_scene === true
          const reportOk = existing.report.ok === true
          return respond({
            // **重放的 ok 必须来自磁盘上那份报告**，不是"重放这个动作成功了"。实测抓到过：
            // 第一次尝试因漏传 image_file 被挡（报告 ok:false + 一条 blocker），补传后走重放，
            // 工具回报 ok:true，而磁盘仍写着 ok:false —— 调用方会以为这单通过了，而权威副本说没有。
            ok: reportOk,
            blockers: existing.report.blockers ?? [],
            idempotent_replay: true,
            run_id: runId,
            report_path: absolute('report.json'),
            report_contract: existing.report.contract ?? null,
            artifacts: existing.report.artifacts ?? [],
            readback_recorded: hadReadback,
            readback_not_recorded: wantsReadback && !hadReadback,
            readback:
              hadReadback
                ? 'this run already records a scene_readback'
                : wantsReadback
                  ? 'you asked for against_scene but THIS RUN was written without a readback: a replay returns the old descriptors and your readback is NOT recorded. Use a fresh run_id.'
                  : 'no readback was requested for this run, and none is recorded',
            retention: await retentionPlan(fs, runId),
            note: reportOk
              ? 'this run already exists on disk; descriptors returned unchanged and nothing was regenerated'
              : 'this run already exists on disk AND its report says ok:false \u2014 a replay returns that pack unchanged, so whatever you fixed since then is NOT recorded here. Use a fresh run_id to get a pack that reflects the current round.',
          })
        }

        const assembled = await assembleArtifacts(args, new Date().toISOString(), tctx)
        const files = assembled.files.map((file) => ({
          ...file,
          // 外部产物自带真实路径（在 run 目录之外），不能被 run 目录里的同名路径覆盖。
          absolutePath: file.absolutePath ?? absolute(file.name),
        }))
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
