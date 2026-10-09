# 读回契约的稳定性承诺（回 `agh-ortho` 的 `DOWNSTREAM-REQUEST-readback.md`）

> 上游：`agh-ortho`（生产网格）。下游：`agh-blender`（本包）。
> 本文面向 `agh-ortho` 的 lowering 与校验档，说明：**哪些字段可以钉死、哪些必须容忍增长、哪些会变**，
> 以及四条你方请求的交付状态、一处**语义差异**和一张**精确期望值表**。
> 版本：`agh-blender@0.4.0`（2026-10-10）。数字全部来自本机实测，证据在 `docs/P0-EVIDENCE.md`。

---

## 1. 你方四项请求的交付状态

| 你方请求 | 状态 | 我们的实现/差异 |
|---|---|---|
| `describe_scene()` 加 `dimensions` | **已交付**（0.1.8 起） | 语义从 0.2.0 起改为**世界 AABB**（见 §3、§5）；**没有**用 `hasattr`，原因见 §5 |
| `describe_scene()` 加 `rotation_euler`（可选） | **已交付** | 弧度，`round(v, 6)`；非几何对象给 `null` |
| `catalog()` 发布 `primitives` 与能力集标识 | **已交付** | 见 §2。`primitives` 由**校验 `kind` 的同一个元组**导出，发布集与强制集不可能不一致 |
| `stop` 在 bridge 断连时回落到 PID 判定 | **已交付** | 并区分"未能确认"与"确认失败" |
| 实例目录只增不减 | **已交付**（0.2.0） | `start` 前裁剪实例目录：**保留最新 20 个**，永不删 pid 仍活着的、永不删即将使用的那个 |

你方 §3 表里 `catalog() 发布 primitives` 一行写的"**待重装生效**" —— 已生效。
当前版本 **`agh-blender@0.4.0`**：`primitives` 是六种基元，`ops` 是 **16** 个，
`capabilitySet` 是 **`primitives-6.ops-16.limits-64-512`**（格式有变，见 §2）。

---

## 2. 能力面：请按 `catalog()` 闸门，**不要按包版本**

`catalog()` 的顶层形状是稳定的：

```json
{ "version": 1, "capabilitySet": "primitives-6.ops-16.limits-64-512",
  "primitives": ["cube","uv_sphere","cylinder","cone","torus","plane"],
  "limits": { "maxOpsPerBatch": 64, "maxObjects": 512,
              "nameCharset": "A-Za-z0-9_-.", "nameMaxLength": 96 },
  "ops": [ ... ], "errorCodes": [ ... ], "notes": [ ... ] }
```

| 字段 | 承诺 |
|---|---|
| `primitives` | **权威**，判"目标支不支持 `cylinder`"就用它。当前 6 个 |
| `ops` | **权威**，每个 op 带参数类型/范围/示例与拒绝码。当前 **16** 个 |
| `errorCodes` | 权威，拒绝码的可读清单 |
| `limits` | 稳定；上限变化会同时改 `capabilitySet` |
| `capabilitySet` | **"能力面换过代"的指纹**：基元集合、op 表、限额**任一**变化都会变。**不要**拿它当"基元集合没变"的证明 |

> **0.4.0 起格式变了**：`primitives-6` → **`primitives-6.ops-16.limits-64-512`**。
> 原因：旧实现只由**基元数**导出，op 表 10→15 时它**没变** ⇒ 你们存进 `target_capability_set`
> 的那串溯源指纹**分不出两代能力面**（而你们记它就是为了"产物可长期依赖"）。
> 你们只需要改**兜底常量**（`agh.capability.json` / fixture）一次；闸门逻辑读的是
> `primitives` 与 `ops` 两个清单，**不受影响**。
| `version` | 整数；**形状**变化才 bump（0.3.1 仍为 1） |

**结论**：闸门逻辑 = 读 `primitives` + 读 `ops`；把 `capabilitySet` 记进报告做溯源。
你方 §4 那张"随包快照 `applied` / 活实例 `not_applied`"的表，0.1.8 起两个来源都会给同一个集合了。

---

### 2.1 `0.4.0` 新增的两条 op（正交相机 + `render.still`）

**`camera.add` 加两个参数**（不传时旧行为逐字不变）：

| arg | 语义 |
|---|---|
| `type` | `"PERSP"`（默认）\| `"ORTHO"` |
| `ortho_scale` | **ORTHO 时必填**，`(0, 1e5]` 米；**传给 PERSP 会被拒**（`E_ARG_CONFLICT`，不静默忽略） |

返回新增：`type`、`ortho_scale`、`sensorFit`、`resolution`、`metresPerPixel`。

- ⚠️ **`sensor_fit` 被钉死为 `VERTICAL`** ⇒ **`ortho_scale` 就是画幅的"世界高度"**，与你们 §3 的
  `米/像素 = ortho_scale / height` **一致**。我们**没有**用 Blender 的 AUTO —— 它跟着较长边，
  画幅比例一翻面 `ortho_scale` 的含义就变。
- ⚠️ **`ortho_scale` 读回是 float32**：写 `2.4` 读回 `2.4000000953674316` ⇒ **断言请用相对容差（1e-6 量级）**，用 `==` 会假红。
- ⚠️ `metresPerPixel` 是**声明**，由 `ortho_scale` + `sensorFit` + **当时的** `resolution`（一并返回）推出。
  `camera.add` 用**场景当前的渲染分辨率**，`render.still` 用它**自己设定的** width/height —— 两者不同是正常的，
  各自都带 `resolution` 供你复核。**PERSP 下是 `null`**（没有距离就没有"每像素多少米"）。

**`render.still`（新 op）**

```
args: { camera, width, height, path, transparent? }
→  { path, sha256, bytes, width, height, camera, previousCamera, transparent, overwrote,
     ortho_scale, sensor_fit, metresPerPixel }
```

- 用 **`scene.camera`** 渲（**不是**视口 —— 那是 `capture` 的活）。`camera` 指定的相机会**成为** `scene.camera`，原值在 `previousCamera` 里。
- `transparent: true` ⇒ `film_transparent` + RGBA ⇒ **剪影 = alpha>0**（不需要猜背景色）。
- 强制 `resolution_percentage=100` 与**像素 1:1** —— 否则像素比 ≠ 世界比，而你们的容差是**米**。
- 已存在的文件**会覆盖**，返回里 `overwrote` 告诉你是第几次写。**理由**：渲染是**测量读数**不是交付物；
  "永不覆盖"那条规则属于 `file.stage_export` / `agh_blender_export`（交付件）。
- 拒绝码：`E_ARG_MISSING`（缺 camera/path）、`E_NO_SUCH_OBJECT`（相机名不存在）、`E_NOT_A_CAMERA`（对网格渲）、
  `E_UNSUPPORTED_FORMAT`（非 `.png`）、`E_ARG_RANGE`（width/height 越界）、`E_INTERNAL`（operator 没产出文件）。
- **返回里没有任何像素/图片字段**（`image`/`pixels`/`base64`/`data`/`inline`/`content` 全不出现，有断言锁着）。

**我们自测过的数**（样本 = 你们那个 0.4×0.4×2 m 方块，正交前视，`ortho_scale=2.4`，`transparent`）：

| 渲染 | 剪影像素框 | 折算（米） | aspect |
|---|---|---|---|
| 512×512 | 86 × 426 px | `0.403125 × 1.996875` | **0.201878** |
| 2048×2048 | 342 × 1706 px | `0.400781 × 1.999219` | **0.200469** |

容差按你们的规则（≥2 像素折算成米，或 1%，取大者）。挪动一个部件（加一块 1.6 m 宽的板）⇒ 量到
**1.598438 m**，远超容差 ⇒ 判据确实在判（你们的 A3）。

- ⚠️ **一条请你们照抄的自检**：**剪影必须完整落在画幅内**（`x0>0, y0>0, x1<w-1, y1<h-1`）。
  我们第一次跑时剪影贴满整幅 ⇒ 量出"高 **1.2 m**"，真值是 2.0 m —— **被裁掉的图会给出一个看起来合法的数**。
  只看比值，会把裁一半的图判成合格（与 `capture` 的 `touchesEdges` 同一个道理）。

## 3. `describe_scene()`：字段级稳定性（这是你断言尺寸唯一要读的东西）

```json
{ "scene": "Scene", "objectCount": 6,
  "objects": [ { "name": "v", "type": "MESH",
                 "location": [0,0,0], "scale": [12.4,8.6,9.3],
                 "dimensions": [12.4,8.6,9.3], "rotation_euler": [0,0,0],
                 "vertices": 8, "polygons": 6, "materials": ["Skin"] } ],
  "materials": ["Hair","Skin"], "knownOps": ["..."] }
```

| 字段 | 稳定性 | 语义 |
|---|---|---|
| `name` / `type` | **稳定** | `type` 是 Blender 的 `Object.type`（`MESH`/`CAMERA`/`LIGHT`/`EMPTY`/…） |
| `location` | **稳定** | 对象自身字段，`round 6`。**不是**世界坐标 |
| `scale` | **稳定** | 对象自身字段，`round 6` |
| `rotation_euler` | **稳定** | 弧度，`round 6`；非几何对象给 `null` |
| `dimensions` | **稳定（语义已冻结）** | **世界 AABB 边长**：`matrix_world @ bound_box` 八角求轴对齐范围。**已经包含旋转与 scale**。没有几何的对象给 `null` |
| `vertices` / `polygons` | **稳定** | 仅 `MESH` |
| `materials` | 加性 | 仅 `MESH`；顺序未承诺 |
| `objectCount` / `materials` / `knownOps` | 稳定 | `knownOps` 是"当前实例认识的 op 名"，长度会随加 op 增长 |
| `objects` 数组顺序 | **不承诺** | 按名字查，别按下标 |

**关于"读得是不是新鲜的"**（0.3.1 起的新保证，对你直接有利）：
`dimensions` 由求值结果推出，0.3.1 起 `describe_scene()` **自己**在读数前结算 depsgraph。
所以**紧接着一批 op 之后调用它，一定拿到新值**，不需要你方做任何事。
（实测：直接 Python 调用序列在 0.3.0 上会读到旧值 `[1,1,1]`，0.3.1 上正确 `[1,2,4]`。
详见 `P0-EVIDENCE.md` §W。）

---

## 4. 精确期望值表（本机实测，可直接当断言常量）

全部用 `mesh.primitive_add` 造，`size` 是**声明的那个参数**；`dimensions` 是世界 AABB。

| 调用 | `dimensions` | 备注 |
|---|---|---|
| `cube, size=1, scale=[12.4,8.6,9.3]` | `[12.4, 8.6, 9.3]` | 逐位精确，用来做你 §4#1 |
| `plane, size=2` | `[2.0, 2.0, 0.0]` | 第 3 分量**恰好 0.0**（平面零厚），你 §4#2 |
| `cylinder, size=2` | `[2.0, 2.0, 2.0]` | **`size` = 直径**（`radius = size/2`, `depth = size`），你 §4#3 |
| `cone, size=2` | `[2.0, 2.0, 2.0]` | 同上 |
| `uv_sphere, size=2` | `[1.999999, 1.999999, 2.0]` | **多边形近似**：这正是你方用**相对容差**而不是 1e-6 的理由 |
| `torus, size=2` | `[2.5, 2.5, 0.5]` | `major = size/2`, `minor = size/8` ⇒ 外径 `1.25×2`、高 `0.25×2` |
| 相机 / 灯光 / 空物体 | `null` | **不是** `[0,0,0]`，也**不抛异常** —— 见 §5 |

精度：所有分量 `round(v, 6)`。你方的 `SCENE_RELATIVE_TOLERANCE = 1e-5`（下限 1e-9）在
`uv_sphere` 与 `torus` 上都需要，其余可收紧到 1e-6。

---

## 5. 必须说明的一处**语义差异**：`hasattr` 换成**类型闸门**

你方请求原文是：

```python
'dimensions': [round(v, 6) for v in item.dimensions] if hasattr(item, 'dimensions') else None
```

**这条写法得不到 `None`。** 实测（Blender 5.2.2）：`dimensions` 在**每个**对象上都有；
相机/灯光/空物体返回 `[0, 0, 0]` 而**不抛异常**。照原样实现的话，相机会被报成"一个零尺寸的盒子"，
你的断言会拿到一个**看起来合法**的谎言。

我们的做法是**按类型闸门**：

```python
_GEOMETRY_TYPES = ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT')
# 只有这些类型报尺寸，其余一律 None；读取路径另有 try/except 兜底，绝不抛。
```

**对你的影响**：`dimensions is None` 仍然是"这个对象没有可判的尺寸"的**唯一**信号，
你方 §7 说的"缺 `dimensions` 时如实降级为 `scene_readback`"**照原样成立** —— 只是触发条件
从"缺字段"变成"字段为 null"。你方 §4#4/#5 两条验收我们都跑了，通过。

---

## 6. `capture` 的取景契约（你方 §6）

| 入参 | 语义 |
|---|---|
| `frame` | `'all'`（**默认**）：先对**整个场景包围盒**取景再渲；`'none'`：保留旧的"视口在哪就渲哪" |

返回里新增的度量字段（都可断言）：

| 字段 | 含义 |
|---|---|
| `bounds` | 场景包围盒（`min`/`max`/`center`/`radius`） |
| `coveredFraction` | 模型在画幅内的**几何投影**占比（**以几何为准**） |
| `touchesEdges` | 四边是否贴边（= 被裁掉） |
| `coverage.pixelBox` / `inkBox` / `inkFraction` / `method` | **像素独立测量**，只作交叉验证 |

**为什么以几何为准**：视口里还有网格、坐标轴、gizmo，按颜色统计会把它们算成内容 ——
实测 `inkBox` 因此几乎横跨整幅。你方 §6 的判别式（`touchesEdges` **且**占比）我们是按
"两条一起看"设计的：**只看占比会把被裁一半的图判成合格**。

一个实测数字供你设阈值：`torus` 场景 `frame='all'` 时 `coveredFraction ≈ 0.103`、
`touchesEdges=false`、`clipped=false`。

---

## 7. 我们**不做**的（尊重你的永久决定）

- **不加相机/正交渲染 op**。你方说明这是永久决定，我们照此办：`dimensions` 的读回足以闭合
  "尺寸语义"这一环，取景是给**人**看的图，不进入闭环。
- 不把 `dimensions` 改回 `Object.dimensions`（它**忽略旋转**，与"最终外延"不符）。
- 不猜 up axis：`mesh.import` 的 `upAxis` 由**调用方声明**（glTF 导入器本身没有轴参数，
  非 Y 声明由我们旋转纠正；OBJ 走 `up_axis`/`forward_axis`）。
- `mesh.import` 的 `size`/`location` **只做自检并回报，绝不改几何** —— 它们是"期望值"不是变换。

---

## 8. 变更流程（你方为对齐需要知道的三件事）

1. **op 的权威清单是 `catalog()`**，不是文档。加 op **不改** `describe_scene()` 的形状，
   所以我们加 op 时你方通常**不需要改代码**，只需要容忍 `ops`/`knownOps` 变长。
2. **改 `package/` 才需要重装**：AGH 以内容寻址快照加载已安装包，改源文件本身不生效，
   要 `disable → remove → install（人工按 y）→ trust → enable`。
   而 **`docs/` 在包外**，所以我们改文档**不会**让你的对账失效、也不需要重装。
3. **每个变更都留痕**：`docs/DESIGN.md` §11（变更记录）与 `docs/P0-EVIDENCE.md`（台账）。
   破坏性变更会同时 bump 版本号与 `capabilitySet`。

---

## 9. 已知读取陷阱（与本契约直接相关）

- **`/scene` 端点自己不做求值**，它原先靠 GUI 重绘兜着；0.3.1 起 `describe_scene()` 自带结算，
  两条路径都稳了。
- **桥只在 GUI 实例下工作**：`--background` 下 Blender 跑完 `--python` 即退出，桥的 HTTP
  线程是 daemon 线程，端口随进程消失（实测 `/health` 直接 connection refused）。
  **无人值守的流水线目前不可用** —— 如果你的对账想跑在 CI 上，这一条要先解决。
- **示例里的 `size` 语义按基元不同**：`cube`/`plane` 是边长、`uv_sphere`/`cylinder`/`cone`/`torus`
  是**直径**。§4 表已钉死，别推断。
