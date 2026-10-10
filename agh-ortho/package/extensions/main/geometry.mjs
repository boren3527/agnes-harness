/**
 * geometry.mjs —— 意图层 → 几何的规则（纯函数，零依赖）。
 *
 * 为什么单独一个模块：`agh_ortho_verify` 的 numeric 校验必须从**两条独立路径**看同一个模型 ——
 *   ① extentsFromParams  直接读参数叶子（w / d / h / at / z）
 *   ② extentsFromBoxes   读 lowering 产出的 ops
 * 校验比的就是这两者。共用一条路径的话校验就是同义反复。
 *
 * 唯一被两条路径共享的是落位规则 `placementOf` —— 这是**已知的校验盲区**：如果这条规则本身
 * 把中心算错了，两条路径会一起错，残差仍为 0。记在 notes/SKELETON-STATUS.md 里，别当成已覆盖。
 */

const FINITE = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * 落位规则（唯一真值）。下游的 primitive_cube_add 把方块放在**中心**，所以返回值是中心点。
 *   - 有 `at`  → 用它的向量
 *   - 有 `z`   → [0, 0, z]
 *   - 都没有   → 方块"底面落地"（中心在 h/2）；板落在 z = 0
 */
export function placementOf(item, h) {
  const at = item?.at?.v
  if (Array.isArray(at) && at.length === 3 && at.every(FINITE)) return [...at]
  if (FINITE(item?.z?.v)) return [0, 0, item.z.v]
  return [0, 0, FINITE(h) ? h / 2 : 0]
}

/**
 * 每种意图在**参数侧**的几何：lower 出来是什么尺寸、放在哪。
 *
 * 它必须与 `index.mjs` 里 LOWERING 的每个 build 产出**完全一致的数** —— 这是 numeric 校验的
 * 立足点：一侧读参数、另一侧读 ops，两条独立路径比同一件事。
 * 所以**每加一种 intent，这里也要加一行** —— 这是"独立"的代价，也正是它能抓到转写错误的原因。
 * （`placementOf` 是两条路径共享的落位规则，那是已知盲区，见 notes。）
 */
const boxLike = (it) =>
  FINITE(it.w?.v) && FINITE(it.d?.v) && FINITE(it.h?.v)
    ? { size: [it.w.v, it.d.v, it.h.v], base: placementOf(it, it.h.v) }
    : null
const diaLike = (it, needsHeight) => {
  if (!FINITE(it.dia?.v)) return null
  if (needsHeight && !FINITE(it.h?.v)) return null
  return { size: [it.dia.v, it.dia.v, it.h.v], base: placementOf(it, it.h.v) }
}

const PARAM_SIDE_GEOMETRY = {
  // 板：w × d，Z 上零厚
  slab: (it) => (FINITE(it.w?.v) && FINITE(it.d?.v) ? { size: [it.w.v, it.d.v, 0], base: placementOf(it, undefined) } : null),
  // 体块 / 竖板：w × d × h（sheet 的 d 是板厚）
  box: boxLike,
  sheet: boxLike,
  // 外部网格：**声明过的意图尺寸**（w × d × h，米）。文件本身的真实大小由 save 读盘复核。
  mesh: boxLike,
  // 柱 / 锥体：dia × dia × h
  column: (it) => diaLike(it, true),
  spire: (it) => diaLike(it, true),
  // 环：`dia` 是**外形**直径 ⇒ 期望尺寸直接是 dia（下游的 size 只是实现细节）。
  // z 跨度 = 2 × 管半径 = 2 × (size/8) = 2 × (dia/1.25/8) = 0.2 × dia。
  ring: (it) => (FINITE(it.dia?.v) ? { size: [it.dia.v, it.dia.v, it.dia.v * 0.2], base: placementOf(it, undefined) } : null),
  // 穹顶：整个球，直径 dia，球心落在基面
  dome: (it) => (FINITE(it.dia?.v) ? { size: [it.dia.v, it.dia.v, it.dia.v], base: placementOf(it, undefined) } : null),
}

/** 每种意图要用的下游基元 —— 用来让参数侧应用**与 op 侧相同的闸门**。
 *  不这么做的话，闸门一旦拒绝某项，op 侧少一个而参数侧多一个 ⇒ 报成"内部不一致"，
 *  把"下游没有这种基元"这个真实原因掩盖成一条假告警。 */
const PARAM_KIND = {
  slab: 'plane',
  box: 'cube',
  sheet: 'cube',
  column: 'cylinder',
  ring: 'torus',
  dome: 'uv_sphere',
  spire: 'cone',
  // 带点的名字是一条 **op**（不是基元 kind）：参数侧用**同一个**闸门判定，见 kindAvailableFor。
  mesh: 'mesh.import',
}

/** 一个 assembly item 是否会被 lowering 成 op —— 两条路径必须用同一个判定，否则会错位。 */
export function lowersToOp(item, kindAvailable = () => true) {
  if (!item || typeof item !== 'object') return false
  if (item.repeat !== undefined) return false
  const rule = PARAM_SIDE_GEOMETRY[item.feature]
  if (!rule || !rule(item)) return false
  const kind = PARAM_KIND[item.feature]
  return kind === undefined ? true : kindAvailable(kind) === true
}

/** lowering 的产物 → 轴对齐包围盒。
 *
 *  **每种基元的 bbox 不是 `scale × size`**：torus 是 (1.25, 1.25, 0.25) × size、plane 在 Z 上零厚。
 *  所以这里必须查 `UNIT_EXTENT`（与场景读回那边**同一张表**）。
 *  实测抓到过：查表之前，一个 ring 在 op 侧被算成 (size,size,size)、在参数侧是 (1.5,1.5,0.3)，
 *  于是 numeric 报出 0.3/0.3/0.9 三个假不一致 —— 而它其实只是两张表不同步。
 *  （旧实现在这里对 plane 打了特例补丁；查表之后那个特例自然消失。） */
export function boxesFromOps(ops) {
  const boxes = []
  // 外部网格的**摆放**在另一条 op 上（mesh.import 只声明几何、不摆放）⇒ 先把 transform 收一遍，
  // 否则 op 侧的盒子会落在原点，与参数侧（底边贴地、中心 z=h/2）不一致 —— 那是**假**的内部不一致。
  const placement = new Map()
  for (const op of ops ?? []) {
    if (op?.op === 'object.transform' && op.args?.name && Array.isArray(op.args.location)) placement.set(op.args.name, op.args.location)
  }
  for (const op of ops ?? []) {
    // 外部网格：文件自身的包围盒只有文件知道，而 emit 阶段不读盘（纯函数）。
    // 所以 op 里带的是**声明过的意图尺寸** `size`（米），op 侧就用它 ——
    // 于是参数侧与 op 侧算的是同一组数；"文件真的这么大吗"由 save 读盘量（不符即 blocking）。
    if (op?.op === 'mesh.import') {
      const a = op.args ?? {}
      const size = Array.isArray(a.size) && a.size.length === 3 && a.size.every(FINITE) ? a.size : null
      if (!size) continue
      const c = Array.isArray(placement.get(a.name)) ? [...placement.get(a.name)] : Array.isArray(a.location) && a.location.length === 3 ? a.location : [0, 0, 0]
      const half = size.map((v) => v / 2)
      boxes.push({
        name: String(a.name),
        kind: 'mesh',
        centre: [...c],
        min: [c[0] - half[0], c[1] - half[1], c[2] - half[2]],
        max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]],
      })
      continue
    }
    if (!op || op.op !== 'mesh.primitive_add') continue
    const a = op.args ?? {}
    const size = FINITE(a.size) ? a.size : 1
    const scale = Array.isArray(a.scale) && a.scale.length === 3 ? a.scale : [1, 1, 1]
    const c = Array.isArray(a.location) && a.location.length === 3 ? a.location : [0, 0, 0]
    const unit = UNIT_EXTENT[a.kind] ?? [1, 1, 1]
    const half = scale.map((v, i) => (v * size * (unit[i] ?? 1)) / 2)
    const min = [c[0] - half[0], c[1] - half[1], c[2] - half[2]]
    const max = [c[0] + half[0], c[1] + half[1], c[2] + half[2]]
    boxes.push({ name: String(a.name), kind: a.kind, centre: [...c], min, max })
  }
  return boxes
}

/** 包围盒 → { name, x|y|z: { centre, size } }。中心/尺寸的表示法让符号约定不影响比较。 */
export function extentsFromBoxes(boxes) {
  return boxes.map((b) => ({
    name: b.name,
    x: { centre: (b.min[0] + b.max[0]) / 2, size: b.max[0] - b.min[0] },
    y: { centre: (b.min[1] + b.max[1]) / 2, size: b.max[1] - b.min[1] },
    z: { centre: (b.min[2] + b.max[2]) / 2, size: b.max[2] - b.min[2] },
  }))
}

/** 参数叶子 → 同一种表示法。只收会被 lowering 的 item，保证与 ops 列表**按序对齐**。 */
export function extentsFromParams(items, kindAvailable = () => true) {
  const out = []
  for (const item of items ?? []) {
    if (!lowersToOp(item, kindAvailable)) continue
    const { size, base } = PARAM_SIDE_GEOMETRY[item.feature](item)
    out.push({
      name: String(item.id ?? out.length),
      x: { centre: base[0], size: size[0] },
      y: { centre: base[1], size: size[1] },
      z: { centre: base[2], size: size[2] },
    })
  }
  return out
}

/**
 * 从 lowering 产出的 ops 里取出"我打算让下游创建什么"。
 * 只取 primitive_add —— 它是唯一会创建对象的 op，也正是场景读回要比对的目标。
 */
export function expectedObjectsFromOps(ops) {
  const out = []
  // 外部网格的**摆放**在第二条 op 上（`mesh.import` 只比对不施加）⇒ 位置要先收一遍。
  const transforms = new Map()
  for (const op of ops ?? []) {
    if (op?.op === 'object.transform' && op.args?.name) transforms.set(op.args.name, op.args)
  }
  for (const op of ops ?? []) {
    if (!op) continue
    // 外部网格：期望的**世界尺寸**就是 import 里声明的 size（文件自身的尺寸已经在文件里），
    // 而 scale **不可知** —— 它来自文件的节点变换，emit 阶段不读盘 ⇒ 置 null，
    // 由 compareScene 跳过 scale 断言并写明原因（"不知道"要比"编一个"诚实）。
    if (op.op === 'mesh.import') {
      const args = op.args ?? {}
      const t = transforms.get(args.name)
      out.push({
        name: args.name,
        kind: 'mesh',
        dimensions: Array.isArray(args.size) && args.size.length === 3 ? [...args.size] : null,
        location: Array.isArray(t?.location) ? [...t.location] : Array.isArray(args.location) ? [...args.location] : [0, 0, 0],
        scale: null,
        // **我们自己发的那次旋转也要被期望**：`object.transform` 可能带 `rotation_euler`（例如把
        // 倒过来的内容翻正）。若读回只要求"旋转为零"，就会把我们自己发的一转报成"下游没照做" ——
        // 实测：mesh-triposr-7 的 matched 掉到 0/1，唯一差异就是它（location/名字/类型全对）。
        rotation_euler: Array.isArray(t?.rotation_euler) ? [...t.rotation_euler] : null,
      })
      continue
    }
    if (op.op !== 'mesh.primitive_add') continue
    const args = op.args ?? {}
    out.push({
      name: args.name,
      kind: args.kind,
      // 缺 `size` 时用 1.0：这不是猜 —— 下游的默认值就是 1.0，双处可查
      // （OP_MANIFEST 的 'size': {'default': 1.0}，以及 agh_ops.py 的 `else 1.0`）。
      size: typeof args.size === 'number' ? args.size : 1,
      location: Array.isArray(args.location) ? [...args.location] : [0, 0, 0],
      scale: Array.isArray(args.scale) ? [...args.scale] : [1, 1, 1],
    })
  }
  return out
}

/**
 * 场景读回的容差。
 *
 * **为什么是相对值**：限制精度的不是浮点算术，是**下游对曲面基元的多边形近似** ——
 * 球/柱/环/锥的包围盒会比理想形状略小。实测：`uv_sphere` 直径 2 报回 **1.999999**，
 * 即约 1e-6 的绝对偏差 —— **刚好等于原来的绝对容差 1e-6**，也就是说那次"通过"
 * 只差 1e-15 就要翻面。这不是"有余量"，是压线。
 *
 * 这和"判据的精度不能超过输入的精度"是同一条，只是这里输入受**实现**限制：
 *  - 取 1e-5 相对：2 米的球 ⇒ 容差 2e-5，是实测偏差的 20 倍，不再压线
 *  - 对真实建模误差（毫米级 ⇒ 1e-3 相对）仍然极敏感
 *  - 绝对值下限兜住接近 0 的坐标
 * 每行都会把实际用的 `tolerance` 报出来，压线与否看得见。
 */
export const SCENE_RELATIVE_TOLERANCE = 1e-5
export const SCENE_ABSOLUTE_FLOOR = 1e-9
/** 旋转是弧度、无量纲，不能用长度推出的容差；M1 的 ops 从不设旋转，这里取一个极小绝对值。 */
const SCENE_ROTATION_EPSILON = 1e-9

/**
 * 旋转的**比较**容差。下游发布的 `rotation_euler` 带精度：实测读到 `3.141593`（6 位小数），
 * 而我们期望 `3.141592653589793` —— 差 3.5e-7。拿 1e-9 去比，等于把"下游把数印成 6 位小数"
 * 判成"下游没照做"（实测：matched 0/1，唯一不符项就是它，而同一行的尺寸差 4.3e-5 能过容差）。
 *
 * 这是"判据精度不能超过输入精度"的**第 9 次**。容差取**半个末位**（1e-6 / 2），并把依据写在载荷里。
 */
const SCENE_ROTATION_TOLERANCE = 5e-7

export function sceneToleranceFor(...values) {
  const scale = Math.max(0, ...values.map((v) => Math.abs(Number(v) || 0)))
  return Math.max(SCENE_ABSOLUTE_FLOOR, SCENE_RELATIVE_TOLERANCE * scale)
}

/** 一个声明写了几位小数？据此推出"它本来就不该比这更准"。 */
export function decimalsOf(value) {
  const text = String(value)
  const dot = text.indexOf('.')
  if (dot === -1) return 0
  return Math.min(9, text.length - dot - 1)
}

/**
 * **声明带精度**的容差：写了 d 位小数 ⇒ 舍入误差不超过 0.5×10^-d，相对容差就是它除以自身量级。
 *
 * 为什么必须有（实测第 8 次撞同一条规矩）：参数写 0.9638（4 位），文件真值 0.963763，差 0.01%，
 * 而固定的 1e-5 把它判成"不符"，于是交付包被两条 blocker 挡住 —— 判据的精度超过了输入的精度。
 * 写 4 位小数的人**不可能**比 5e-5 更准；拿它当罪证是判据的错，不是数据的错。
 */
export function declarationRelativeTolerance(declared, floor = SCENE_RELATIVE_TOLERANCE) {
  const decimals = decimalsOf(declared)
  // **整数写法不当作"舍入过的测量"**：写 `2` 的人是在陈述一个精确值，把它读成"±0.5"会得到 25% 的容差，
  // 那就什么都挡不住了（自检抓到：一条 0.001 的不一致因此漏过）。只有带小数的写法才是舍入证据。
  if (decimals === 0) return floor
  const value = Math.abs(Number(declared))
  const magnitude = value > 0 ? value : 1
  const half = 0.5 * Math.pow(10, -decimals)
  return Math.max(floor, half / magnitude)
}

/**
 * 每种基元在 `size = 1` 时的**单位尺寸**（还要再乘 `size` 与 `scale`）。
 *
 * 出处是下游自己的映射，不是猜的 —— `agh-blender/.../bridge/agh_ops.py:143-155`：
 *   cube      → primitive_cube_add(size=size)       → (1, 1, 1)
 *   plane     → primitive_plane_add(size=size)      → (1, 1, 0)          ← 零厚
 *   uv_sphere → radius = size/2                     → (1, 1, 1)
 *   cylinder  → radius = size/2, depth = size       → (1, 1, 1)
 *   cone      → radius1 = size/2, depth = size      → (1, 1, 1)
 *   torus     → major = size/2, minor = size/8      → (1.25, 1.25, 0.25) ← **不是 1**
 *
 * 所以"期望尺寸 = scale × size"这句**只对其他五种成立**，torus 必须单独给。
 * 这张表本该由下游的 `catalog()` 发布（见 notes/DOWNSTREAM-REQUEST-readback.md §8），
 * 在它发布之前这里是带出处的硬编码；届时删掉这里、改读 catalog 即可。
 */
export const UNIT_EXTENT = {
  cube: [1, 1, 1],
  plane: [1, 1, 0],
  uv_sphere: [1, 1, 1],
  cylinder: [1, 1, 1],
  cone: [1, 1, 1],
  torus: [1.25, 1.25, 0.25],
}

/**
 * `scene_readback` 半档的比对：**只用下游场景读回里真实存在的字段**。
 *
 * 能断言的（精确）：对象按确切名字存在、类型是 MESH、location 与 scale 与我们的 ops 一致。
 * 不能断言的（必须自己说出来）：最终尺寸（w×d×h）—— `describe_scene()` 不发布 `dimensions`；
 * 以及基元种类本身（除 type=MESH 外，下游 catalog 不发布每种基元的顶点/面数）。
 * 这两条正是 notes/DOWNSTREAM-REQUEST-readback.md 那份请求的理由。
 *
 * 本档与 `numeric` 档是**两条独立路径**：numeric 只看我方自洽，本档第一次引入外部事实。
 */
export function compareScene(expected, scene) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : []
  const byName = new Map(objects.map((o) => [o?.name, o]))
  const axisDelta = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length
      ? Math.max(...a.map((v, i) => Math.abs(v - b[i])))
      : null
  const rows = []
  for (const want of expected) {
    const got = byName.get(want.name)
    if (!got) {
      rows.push({
        object: want.name,
        verdict: 'missing',
        note: '场景里没有这个确切名字的对象。Blender 会把重名改成 name.001，所以"精确名字找不到"意味着要么没创建、要么名字被占了。',
      })
      continue
    }
    const locationDelta = axisDelta(want.location, got.location)
    // 外部网格的 scale **不可知**（来自文件的节点变换，emit 阶段不读盘）⇒ want.scale 为 null，
    // 于是这里得到 null，下面据此**跳过** scale 断言并写明原因。
    const scaleDelta = axisDelta(want.scale, got.scale)
    const scaleAsserted = scaleDelta !== null
    const rotationPublished = Array.isArray(got.rotation_euler)
    const rotationIsZero = !rotationPublished || got.rotation_euler.every((r) => Math.abs(r) <= SCENE_ROTATION_TOLERANCE)
    // "场景与 ops 一致"**包含旋转**：期望为零时要求为零；期望非零（我们发过 object.transform 的
    // rotation_euler）时要求相符 —— 否则我们自己发的那一转会被读成"下游没照做"。
    const wantedRotation = Array.isArray(want.rotation_euler) ? want.rotation_euler : null
    const rotationMatches = !rotationPublished
      ? true
      : wantedRotation
        ? wantedRotation.every((r, i) => Math.abs(Number(r) - Number(got.rotation_euler[i] ?? 0)) <= SCENE_ROTATION_TOLERANCE)
        : rotationIsZero
    // 旋转会把"本地包围盒 × scale"变成另一个世界 AABB —— **除非**它是绕单轴转半圈（各轴只取反、尺寸不变）。
    const turned = (got.rotation_euler ?? []).filter((r) => Math.abs(Number(r)) > SCENE_ROTATION_TOLERANCE)
    const rotationPreservesBox = turned.length === 0 || (turned.length === 1 && Math.abs(Math.sin(Number(turned[0]))) <= 1e-6)
    // **字段设了 ≠ 几何动了**。实测（p0-rot-probe，2026-10-10）：`mesh.import` 走 glTF 导入器，
    // 对象是 `rotation_mode='QUATERNION'` ⇒ Blender **忽略** rotation_euler ⇒ 值被存下、matrix_world 不动。
    // 当时我们的读回只比 rotation_euler 字段，于是四组不同旋转"全部匹配" ✗ —— 这是"读回字段 ≠ 效果"的
    // 又一次现形（前几次：声明 ≠ 事实、测量 ≠ 声明）。
    // 下游发布 rotation_mode 时我们就判"这次旋转在该模式下能不能生效"；**没发布就不假装判定**。
    const rotationMode = typeof got.rotation_mode === 'string' ? got.rotation_mode : null
    const wantsRotation = Array.isArray(wantedRotation) && wantedRotation.some((r) => Math.abs(Number(r)) > SCENE_ROTATION_TOLERANCE)
    const eulerModes = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX']
    const rotationEffective = wantsRotation && rotationMode !== null ? eulerModes.includes(rotationMode) : wantsRotation ? null : true
    // 尺寸断言的三个前置条件，缺一个就不做 —— 而"为什么没做"必须写进 rows：
    //   1. 下游为**这个对象**发布了 dimensions；
    //   2. 我们知道这种基元的单位尺寸（否则"期望值"就是我编的，torus 就是反例）；
    //   3. 对象**没有旋转** —— `obj.dimensions` 是"本地包围盒 × scale"，一旦旋转，世界 AABB ≠ 它。
    const unit = UNIT_EXTENT[want.kind]
    // 外部网格带**显式** dimensions（import 里声明的 size）；基元仍按 unit × size × scale 算。
    const expectedSize = Array.isArray(want.dimensions) ? [...want.dimensions] : unit ? unit.map((u, i) => u * want.size * want.scale[i]) : null
    // 三个前置条件必须**每一个都出现在这个条件里** —— 上面注释写了三条，代码里只写两条就是个 bug
    // （自检抓到过：旋转的对象尺寸仍然被"断言"了，于是 size_not_asserted_reason 成了 null）。
    const dimensionsDelta =
      Array.isArray(got.dimensions) && expectedSize && rotationPreservesBox ? axisDelta(expectedSize, got.dimensions) : null
    const sizeAsserted = dimensionsDelta !== null
    // 这一行用的容差随**这个对象多大**变化 —— 曲面基元的包围盒偏差是按比例缩放的。
    // 期望值来自我们的 ops，而 ops 里的数字**带着参数写入时的精度**（写 4 位小数就只准到 5e-5）。
  // 所以容差取"几何相对容差"与"声明舍入误差"的较大者 —— 判据不能比输入更准（实测第 8 次）。
  const rounding = Math.max(
    0,
    ...(expectedSize ?? []).map((v) => declarationRelativeTolerance(v) * Math.abs(Number(v) || 0)),
    ...(want.location ?? []).map((v) => declarationRelativeTolerance(v) * Math.abs(Number(v) || 0)),
  )
  const tol = Math.max(sceneToleranceFor(...want.location, ...(want.scale ?? []), ...(expectedSize ?? [])), rounding)
    const scaleNotAssertedReason = scaleAsserted
      ? null
      : 'the imported mesh\u2019s scale comes from the file\u2019s own node transform, and the emit stage does not read files — so this line asserts presence, type and location, not scale'
    const sizeNotAssertedReason = sizeAsserted
      ? null
      : !Array.isArray(got.dimensions)
        ? 'this downstream published no dimensions for this object'
        : !unit
          ? `no unit-extent entry for kind "${want.kind}", so an expected size would be a guess`
          : 'the expected size is an axis-aligned box, and this rotation is not a half turn about one axis, so the world AABB would differ from it'
    const typeIsMesh = got.type === 'MESH'
    // 旋转也要一致：**期望为零时要求为零；我们发过 rotation_euler 时要求相符**。
    // （早先这里写死"现场不该有旋转"——那时 M1 的 ops 确实不发旋转；现在 mesh 路会发，
    //  实测因此把 1/1 判成 0/1。）
    const ok =
      typeIsMesh &&
      rotationMatches &&
      rotationEffective !== false &&
      locationDelta !== null &&
      locationDelta <= tol &&
      (!scaleAsserted || scaleDelta <= tol) &&
      (!sizeAsserted || dimensionsDelta <= tol)
    rows.push({
      object: want.name,
      verdict: ok ? 'match' : 'mismatch',
      type_is_mesh: typeIsMesh,
      location_delta: locationDelta,
      scale_delta: scaleDelta,
      scale_asserted: scaleAsserted,
      scale_not_asserted_reason: scaleNotAssertedReason,
      rotation_published: rotationPublished,
      rotation_is_zero: rotationIsZero,
      rotation_matches_ops: rotationMatches,
      expected_rotation: wantedRotation,
      // 旋转比较实际用的容差（弧度）—— 压线与否必须看得见，而且要能解释"为什么 3.5e-7 不算不符"。
      rotation_tolerance: SCENE_ROTATION_TOLERANCE,
      // "这次旋转能不能生效"：下游发布 rotation_mode 才判（null = 发布方没给，不假装判定）。
      // false 表示"我们要求了非零旋转，而该模式忽略 rotation_euler"—— 值会被存下、几何不动。
      rotation_mode: rotationMode,
      rotation_effective: rotationEffective,
      // 这一项的真假说明"尺寸语义"到底验没验；为假时 reason 说明为什么没验。
      size_asserted: sizeAsserted,
      size_not_asserted_reason: sizeNotAssertedReason,
      dimensions_delta: dimensionsDelta,
      // 这一行判定时实际用的容差（绝对值，米）—— 压线与否必须看得见。
      tolerance: tol,
      expected_size_m: expectedSize,
      // 观测到的（不是断言的）：顶点/面数能让人和模型一眼看出 cube(8/6) 还是 plane(4/1)，
      // 但"期望值"下游没有发布，所以我们只报出来，不据此判成败。
      observed: {
        type: got.type,
        location: got.location,
        scale: got.scale,
        rotation_euler: got.rotation_euler ?? null,
        dimensions: got.dimensions ?? null,
        vertices: got.vertices,
        polygons: got.polygons,
        materials: got.materials,
      },
    })
  }
  const expectedNames = new Set(expected.map((e) => e.name))
  return {
    rows,
    matched: rows.filter((r) => r.verdict === 'match').length,
    missing: rows.filter((r) => r.verdict === 'missing').map((r) => r.object),
    mismatched: rows.filter((r) => r.verdict === 'mismatch').map((r) => r.object),
    // 下游这一版到底有没有发布尺寸 —— 决定"尺寸语义"是"验过了"还是"还没验"。
    dimensions_published: objects.some((o) => Array.isArray(o?.dimensions)),
    size_asserted: rows.length > 0 && rows.every((r) => r.size_asserted === true),
    // 场景里不属于本次意图的对象（--factory-startup 会带来 Cube/Light/Camera）。**不是失败。**
    extra_objects: objects.filter((o) => !expectedNames.has(o?.name)).map((o) => o?.name),
  }
}
