# agh-ortho 设计契约 v0.1

> 冻结日期：2026-10-08
> 位置约定：本文件属于 `notes/`，**不属于 `package/`**。包内任何改动都会改 integrity，逼你重走安装。
> 目标：任何人只读这一份文件，就能从零把 M1 建起来；且**扩下游时不需要改上游 Schema**。

---

## 0. 一句话

把「图 → 六视图 → 参数」的方向**反过来**：

```
图片 ──(推测，带置信度)──▶ 参数化模型 ──(确定性投影)──▶ 六视图
                              ▲                          │
                              └──── 重投影误差闭环 ───────┘
```

**参数是唯一真值源，六视图是它的确定性输出。** 单张图只含一个投影方向的信息，另外五个视图在原图中不存在，任何"生成"都是猜；而从五张互相矛盾的生成图反推参数，是两个误差串联。所以六视图只能作为**输出 + 校验回路**，绝不能作为参数的输入。

---

## 1. 范围

| 项 | 内容 |
|---|---|
| 输入 | 单张图片（透视照片 **或** 正交立面图） |
| 输出① | 参数 JSON（**意图层**，每个数值带置信度） |
| 输出② | 六视图（**SVG 为主**，PNG 可选） |
| 输出③ | 可直接作为 `agh_blender_apply_ops` 的 `ops` 参数传入的 opcode 批次 |
| 下游 | `D:\agnes-harness\agh-blender`（本地 Blender 驱动插件） |
| 非目标 | 真实感渲染、自由曲面、点云/网格重建 |

---

## 2. 平台硬约束（AGH）

### A–G：已知实测约束（来自踩坑记录）

| # | 约束 |
|---|---|
| **A** | 工具 `parameters` 必须逐节点带 `Symbol.for('TypeBox.Kind')`（值 `Object`/`String`/`Number`/`Integer`/`Boolean`/`Array`）。缺了 → `Value.Check` 抛 "Unknown type" → kernel 只回**无任何提示**的 `TOOL_ARGS_INVALID`。Object 节点必须有 `properties`（哪怕是 `{}`）。用 `additionalProperties: false`。**做法：写一个 `tb()` 递归函数只在校验时补标记，不手写节点。** |
| **B** | `meta` 必须给全 8 键：`isReadOnly` / `isDestructive` / `isConcurrencySafe` / `isOpenWorld` / `replay('safe'\|'never'\|'idempotent')` / `costHint{wallMs}` / `deferLoading` / `requiresApproval('never'\|'destructive'\|'always')` |
| **C** | **服务的** schema 规则相反：**绝对不能带符号键**。`ctx.services.register({inputSchema, outputSchema})` 先走 JCS(RFC 8785) 规范化，符号键被判非法 → extension factory failed → 整个插件加载不了。⇒ **工具要打标记，服务不能打标记。** |
| **D** | 返回值必须是纯 JSON 能表达的值：不含 `undefined` / `NaN` / `Infinity` / 类实例。返回前过一遍 `JSON.parse(JSON.stringify(x))`。**变更型工具**（`isReadOnly:false` 或 `replay:'never'`）结果一旦被判非法，会被替换成 `TOOL_OUTCOME_UNKNOWN` —— 结果与失败原因一起**永久丢失**。 |
| **E** | 包清单：`agnes.plugins[] = { export, id:'ext:<name>/runtime', runtime:'in-process' }`；`agnes.clientDescriptors[] = { rowId, path }`，**`rowId` 必须等于插件行 id**（`ext:<name>/runtime`），自己起名 → `E_PACKAGE_STATE`（报错完全不提 rowId）。`license` 必须在允许清单内：`MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / 0BSD / MPL-2.0 / Unlicense`；**GPL 任何变体都被拒**（`E_PACKAGE_TRUST`，且不告诉你原因）。 |
| **F** | 带前端 UI 时，`agnes.client.json` 声明 DSH 槽位（如 `shell.overlay`）**必须同时给 `slotCatalogVersion: "dsh-client-slots/v1"`**，否则静默判 `blocked/unsupported-slot`，组件永远不出现、也没有任何报错。 |
| **G** | 安装需人在**真实终端**按一次 `y`（非 TTY 直接拒装，刻意的不变式）。插件是**复制成内容寻址快照**加载 → 改了源文件必须重装才生效。**不要把文档放进包内**。 |

### H–N：本轮从源码实测补出的约束

| # | 约束 | 出处 |
|---|---|---|
| **H** | **图片不能作为工具结果返回。** 工具结果里的图片块会让这一轮**直接失败并永久毒化会话**（实测两次）。只回报 PNG 的磁盘路径、sha256 与字节数。⚠️ 注意这与 `tool.ts` 里声明的 `{ type:'image'; ref; mime }` **相矛盾** —— 类型存在，但一用就出事。 | `agh-blender/extensions/main/index.mjs`（`agh_blender_capture` 描述） |
| **I** | 工具名必须带 `capabilities.tools.prefix`，且匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`。 | `extension.ts:36` 注释、`checkToolDef({prefix})` |
| **J** | `description` ≤ **4096** UTF-16 单元；`parameters` 序列化 ≤ **262144** bytes、嵌套 ≤ **32** 层。 | `tool.ts` 常量 |
| **K** | **`isReadOnly:true` 与 `isDestructive:true` 不能同时为真**（`contradictorySafetyFlags` 直接判无效）。`costHint` 只允许 `credits` / `wallMs` 两个键，拼错 `credit` 会被判非法（而非静默算 0）。 | `checkToolMeta()` |
| **L** | 8 个 meta 键用 `Object.hasOwn` 检查。`deferLoading` 是 required key，类型 `boolean \| undefined` —— **`undefined` 也要显式写出来**。 | `ToolMeta` 注释 |
| **M** | 存在 `classify` + `policyVersion` 机制：可按**参数**动态决定审批策略；`classify` 存在时 `policyVersion` 必填且 `classify` 必须是**同步函数**。 | `resolveToolCallPolicy()` |
| **N** | `ToolResult.details` **只进 UI、不进模型**；`structured` 进模型。另有 `isError` / `terminate`。 | `tool.ts` |

---

## 3. 下游能力面（agh-blender，M3 之前不可变）

### 3.1 完整 op 白名单（无超出此表的 op）

```python
PRIMITIVE_KINDS = ('cube', 'uv_sphere', 'cylinder', 'cone', 'torus', 'plane')
```

| op | 作用 | 关键参数 | 备注 |
|---|---|---|---|
| `mesh.primitive_add` | 加一个基元 | `kind`(上表6种)、`name`、`size`∈(0,1000]、`location`(±10000)、`rotation_euler`(**弧度**)、`scale`(≥1e-6)、`material`、`replace` | 对象数 ≤ 512 |
| `object.transform` | 绝对 loc/rot/scale | `name` + 至少一个 | **绝对值，不是增量** |
| `object.duplicate` | 复制 | `name`、`newName`、`offset`(相对源位置)、`scale` | **阵列只能靠它** |
| `object.delete` | 删对象 | `name` | destructive |
| `material.set` | 建/改材质 | `name`、`color`(**线性** 0..1，不是 sRGB hex)、`roughness`、`metallic`、`emission` | |
| `material.assign` | 赋材质 | `name`、`material` | 替换全部槽位 |
| `object.join` | 合并 | `names`(2..64)、`name` | destructive |
| `data.purge_unused` | 清孤儿数据 | `dry` | destructive |
| `file.checkpoint` | 快照 | `label`（**不可重名**） | |
| `file.stage_export` | 写导出暂存 | `name`（**不可覆盖**） | |

### 3.2 硬限额

```
MAX_OPS_PER_BATCH = 64          # 单批 ops 上限
MAX_OBJECTS       = 512         # 场景对象上限
size              ∈ (0, 1000]
location 各分量    ∈ [-10000, 10000]
scale 各分量       ≥ 1e-6
name              字符集 A-Za-z0-9_-. ，长度 ≤ 96
所有数值           必须 finite（bool 不算 number）
```

### 3.3 ⚠️ 单位必须用**米**

`size` 上限 1000、`location` 绝对值上限 10000。**若用 mm，一栋 12.4 m 的楼 = 12400 → 直接爆 `E_ARG_RANGE`。**
⇒ **Schema 的 `unit` 字段必须钉死为 `"m"`。** 这是 `unit` 字段存在的根本原因。

### 3.4 下游**没有**的东西

`extrude`、`revolve`、`boolean`、自定义顶点/网格、相机控制。
⇒ **没有 camera op**，`agh_blender_capture` 只接受 `width`(16..4096) / `height`(16..4096) / `colorManagement`，抓的是**当前 GUI 视口**。**严格的正交六视图下游给不了，必须自己渲染。**

---

## 4. 参数 Schema 契约

### 4.1 顶层结构

```json
{
  "schema_version": "0.1",
  "unit": "m",
  "frame": { "up": "Z", "front": "-Y", "handed": "right" },
  "projection": "first_angle",
  "scale_anchor": { "pixel_len": 340, "real_len": 2.1, "ref": "door_height" },
  "assumptions": ["manhattan_world", "symmetry_x", "equal_bay_spacing"],
  "assembly": [ /* ... */ ],
  "unsupported": [ /* ... */ ],
  "unresolved": [ "屋面厚度", "背面是否开窗" ]
}
```

### 4.2 字段规范（强制）

| 字段 | 规范 |
|---|---|
| `unit` | **必须** `"m"`（见 3.3） |
| `frame` | Z-up / front = -Y / 右手系。**坐标系方向必须显式写出**，否则下游无法复现朝向 |
| `projection` | `"first_angle"`(第一角法, GB/T 17451) 或 `"third_angle"`(第三角法, ANSI)。**必须写出** —— 两种投影法的视图排布方向相反 |
| `scale_anchor` | 尺寸锚定。**这一步对精度的贡献比任何 AI 都大** |
| 数值叶子 | **一律** `{ "v": number, "conf": 0..1, "min"?: number, "max"?: number }`，不允许裸数字出现在 `assembly` 里 |
| `assumptions` | 显式列出的几何假设。这是压自由度、保证精度的主要手段 |
| `unresolved` | 单图确实无法确定的量（如背面、厚度）。**必须坦白列出来，不允许悄悄填假值** |

### 4.3 意图词汇表（assembly 节点）

**关键：`assembly` 里写的是「意图」，不是「op 指令」。** 用什么基元实现是 lowering 的事。这是"扩下游不改上游"的全部秘密。

| `feature` | 含义 | M1 状态 | 未来 |
|---|---|---|---|
| `slab` | 板（地面板/楼板） | `exact` → `plane` 或薄 `cube` | |
| `box` | 长方体体块 | `exact` → `cube` + `scale=[w,d,h]` | |
| `column` | 柱 | `exact` → `cylinder` | |
| `sheet` | 竖板/墙片 | `exact` → `plane` | |
| `dome` | 穹顶 | `approx` → `uv_sphere` | |
| `spire` | 尖顶/锥体 | `approx` → `cone` | |
| `ring` | 环 | `exact` → `torus` | |
| **`roof.gable`** | **坡屋顶** | **`unsupported`** ★ 招牌缺口 | M3 → `mesh.prism_add` |
| **`prism`** | **任意多边形棱柱** | **`unsupported`** | M3 → `mesh.prism_add` |
| **`extrude`** | **2D 折线拉伸（L 形平面）** | **`unsupported`** | M3 → `mesh.extrude_profile` |
| **`opening`** | **开洞** | **`unsupported`** | M4 → `mesh.boolean` |

### 4.4 示例

```json
{
  "schema_version": "0.1",
  "unit": "m",
  "frame": { "up": "Z", "front": "-Y", "handed": "right" },
  "projection": "first_angle",
  "scale_anchor": { "pixel_len": 340, "real_len": 2.1, "ref": "door_height" },
  "assumptions": ["manhattan_world", "symmetry_x", "equal_bay_spacing"],
  "assembly": [
    { "id": "site",   "feature": "slab",
      "w": { "v": 60.0, "conf": 0.40 }, "d": { "v": 40.0, "conf": 0.40 }, "z": { "v": 0 } },
    { "id": "body",   "feature": "box",
      "w": { "v": 12.4, "conf": 0.90, "min": 12.0, "max": 12.8 },
      "d": { "v":  8.6, "conf": 0.65, "min":  8.2, "max":  9.0 },
      "h": { "v":  9.3, "conf": 0.71 },
      "at": { "v": [0, 0, 4.65], "conf": 0.85 } },
    { "id": "col_nw", "feature": "column",
      "dia": { "v": 0.6, "conf": 0.60 },
      "at":  { "v": [-5.6, -3.7, 0], "conf": 0.70 } },
    { "id": "col_grid", "repeat": { "of": "col_nw", "mode": "linear",
      "axis": "X", "count": 5, "step": { "v": 2.4, "conf": 0.90 } } }
  ],
  "unsupported": [
    { "feature": "roof.gable", "pitch": { "v": 0.42, "conf": 0.55 },
      "reason": "下游无棱柱/布尔 op；cone 与旋转的 cube 都只能近似" }
  ],
  "unresolved": ["屋面厚度", "背面是否开窗"]
}
```

---

## 5. 三态 lowering 契约

### 5.1 三态，不是两态

```json
{ "status": "exact" }
{ "status": "approx", "how": "cone", "error_note": "坡屋顶被近似为圆锥，屋檐轮廓不对" }
{ "status": "unsupported", "reason": "no prism op" }
```

**为什么必须有 `approx`：** M1~M3 期间会用 `cone` 或旋转的 `cube` 糊坡屋顶。如果这个近似不打标记，它会 bake 进场景和导出物，**扩下游之后历史产物不会自动变好，而且没人知道当初糊过**。

**强制做法：** `approx` 产生的对象，其 Blender 里的**对象名或材质名带 `_approx` 后缀**，让产物本身自带自证。

### 5.2 `emit_ops` 输出契约

```json
{
  "emitter_version": "0.1.0",
  "target_capability_set": "agh-blender@0.1.7:primitives-6",
  "ops": [
    { "op": "mesh.primitive_add",
      "args": { "kind": "cube", "name": "body", "size": 1,
                "scale": [12.4, 8.6, 9.3], "location": [0, 0, 4.65] } }
  ],
  "op_count": 41,
  "batches": 1,
  "unlowered": [ { "id": "roof", "feature": "roof.gable", "reason": "no prism op" } ]
}
```

- `emitter_version` + `target_capability_set` **必须有** —— 没有这两行，参数文件就是不可长期依赖的一次性产物。
- `batches` 由**插件内的拆批模块**算，不指望模型手算（64/批、512 对象）。
- `ops` 数组必须**可以原样塞进** `agh_blender_apply_ops` 的 `ops` 参数（由模型编排，不做插件间调用）。

---

## 6. 能力协商层契约

**绝不在代码里硬编码 `PRIMITIVE_KINDS`。**

```js
const caps = await resolveTargetCapabilities(tctx)
// → {
//     source: 'tool:agh_blender_ops_catalog' | 'file:agh.capability.json' | 'fallback',
//     target: 'agh-blender@0.1.7',
//     capabilitySet: 'primitives-6',
//     ops: [...], primitives: [...],
//     limits: { maxOpsPerBatch: 64, maxObjects: 512, sizeMax: 1000,
//               locationAbsMax: 10000, scaleMin: 1e-6, nameMaxLen: 96,
//               nameCharset: 'A-Za-z0-9_-.' },
//     stale?: true
//   }
```

来源按可靠性排序：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `ctx.tools.invoke('agh_blender_ops_catalog', {})` | `ToolContext.tools.invoke` 确实存在；**但跨插件调用是否受 lease / 加载顺序限制，必须先实测一次** |
| 2 | `agh.capability.json`（带版本 + hash） | 稳，但会漂移 → 必须带 `stale` 警告 |
| 3 | 内置 fallback（本节 3.1/3.2 的值） | 只保证"能跑"，不代表真实下游 |

**收益：下游某天加了 `mesh.prism_add`，本插件不改代码就能用上 —— 只更新一张表。**

---

## 7. 工具面契约

### 7.1 清单

前缀（待确认，默认）：`agh_ortho_`

| 工具 | isReadOnly | isDestructive | isConcurrencySafe | isOpenWorld | replay | costHint.wallMs | requiresApproval |
|---|---|---|---|---|---|---|---|
| `agh_ortho_catalog` | ✅ | ❌ | ✅ | ❌ | `safe` | 1000 | `never` |
| `agh_ortho_analyze` | ✅ | ❌ | ✅ | ❌ | `safe` | 60000 | `never` |
| `agh_ortho_fit` | ✅ | ❌ | ✅ | ❌ | `safe` | 120000 | `never` |
| `agh_ortho_views` | ✅ | ❌ | ✅ | ❌ | `safe` | 60000 | `never` |
| `agh_ortho_emit_ops` | ✅ | ❌ | ✅ | ❌ | `safe` | 1000 | `never` |
| `agh_ortho_verify` | ✅ | ❌ | ✅ | ❌ | `safe` | 60000 | `never` |
| `agh_ortho_save` | ❌ | ❌ | ❌ | ❌ | `never` | 5000 | `always` |

`deferLoading` 一律显式写 `false`（required key）。

### 7.2 设计要点

1. **`emit_ops` 只算不写** —— 纯函数、`isReadOnly: true`、可 `safe` 重放、零审批。真正写场景交给下游 `agh_blender_apply_ops`（它已是 `requiresApproval:'always'`）。**职责切干净，审批只发生一次。**
2. `agh_ortho_save` 是唯一的变更型工具。⚠️ 注意约束 D：**结果一旦非法就变 `TOOL_OUTCOME_UNKNOWN` 且原因永久丢失** → 抄 agh-blender 的做法：**返回前先把报告落盘**。
3. 六视图的路径/sha256/字节数放 `details`（进 UI）或 `structured`（进机器），**绝不返回图片块**（约束 H）。
4. 服务层（若有）：`ctx.services.register({inputSchema, outputSchema})` 的 schema **必须是纯 JSON，不能带符号键**（约束 C）。

---

## 8. 六视图契约

### 8.1 定义

| 视图 | 视线方向 | 第一角法位置 |
|---|---|---|
| 主视图 front | 沿 -Y 看 | 基准 |
| 俯视图 top | 沿 -Z 看 | 主视图**下**方 |
| 左视图 left | 沿 +X 看 | 主视图**右**方 |
| 右视图 right | 沿 -X 看 | 主视图**左**方 |
| 仰视图 bottom | 沿 +Z 看 | 主视图**上**方 |
| 后视图 back | 沿 +Y 看 | 最右侧 |

（第三角法**排布左右相反** → 所以 `projection` 字段必须写进输出。）

### 8.2 输出形式

- **主：SVG**。正交视图本质是线条图；SVG 是文本 → **可度量、可标尺寸、可 diff、完全绕开"图片块毒化会话"（约束 H）**。
- 次：PNG（给人看）。返回**路径 + sha256 + 字节数**。
- 投影：正交。
- 隐藏线：M1 用简化可见性（深度排序/剪影），M2+ 上真 HLR。

### 8.3 渲染器归属

**自己实现，不依赖下游。** 下游没有相机 op（见 3.4）。纯 JS 正交投影 + 深度缓冲足够覆盖 6 种基元的装配体，**零外部依赖**。

---

## 9. 校验契约（两档）

| 档 | 做什么 | 需要 Blender？ |
|---|---|---|
| `numeric` | 参数 → 六视图 → 从视图反解 → 与参数比对，**残差必须为 0**（几何自洽性） | ❌ 不需要 |
| `against_blender` | ops → 真实场景 → 六视图 → 与原图 / 参数的六视图比对 | ✅ 需要 |

**这是"扩下游之前就能交付 70% 价值"的关键解耦**：`analyze` / `fit` / `views` / `numeric verify` 完全不依赖下游。

---

## 10. 误差预算

| 误差源 | 量级 | 治理 |
|---|---|---|
| 相机反演（透视→正交） | 大 | 消失点 + 单应矫正；**有正交立面图就能直接消掉这一项** |
| 语义误判（层数/开间/坡屋顶） | 中 | VLM + 周期性检测交叉验证；**整数约束求整** |
| 拟合残差 | 小 | 重投影闭环最小化；输出残差热图给人看 |
| **降级误差（表达不了而近似）** | **可能最大，且最隐蔽** | **只能靠三态 `approx`/`unsupported` 显式暴露** |

> 第 4 项最容易被忽视：**参数可以拟合得很准，但下游表达不出来，最后模型还是错的。所以 `unsupported` 清单必须一路传到最终用户面前。**

---

## 11. 里程碑

| 阶段 | 内容 | 依赖下游扩展？ |
|---|---|---|
| **M1** | 纯 `cube`/`plane` 体块闭环：手写参数 JSON → `emit_ops` → 六视图 SVG → `numeric` 校验 | ❌ **不碰 AI，不碰下游扩展** |
| **M2** | 接入 `cylinder`/`cone`/`torus`；加 `analyze` / `fit`；输入正交立面图 | ❌ |
| **M3** | **扩下游第一批**：`mesh.prism_add` + `mesh.extrude_profile` → 坡屋顶 + 多边形平面 | ✅ |
| **M4** | **扩下游第二批**：`mesh.boolean` → 开洞 | ✅ |
| **M5** | 生成式初值（多视图扩散）加速收敛 | ❌ |

**M3 扩下游时的纪律：**

1. 改 `agh_ops.py` 的 `OPS` **和** `OP_MANIFEST` 两处。
2. `mutates` / `destructive` 必须当 **schema 单测** —— 写错的后果不是报错，而是**审批行为静默变化**。
3. **攒批做**（一个版本加 2~3 个相关 op），因为每次都要重装（约束 G）。
4. **上游 Schema 一个字段都不改** —— 只改 lowering 映射表。**这是判定"设计做对了"的唯一标准。**

---

## 12. 工程约定

### 12.1 布局

```
D:\agnes-harness\                        ← 项目根绑这里（不是 agh-ortho 子目录）
├─ agh-blender\package\                  ← 下游，M3 之前不动
├─ agh-ortho\
│   ├─ package\                          ← ★ 包本体（会被复制成内容寻址快照）
│   │   ├─ package.json
│   │   ├─ LICENSE                       ← Apache-2.0
│   │   └─ extensions\main\
│   │       ├─ index.mjs                 ← tb() + 8 键 meta + 全部工具
│   │       ├─ agh.capability.json       ← 能力协商层数据
│   │       ├─ agnes.client.json         ← 仅带 UI 时需要
│   │       └─ client\index.js
│   └─ notes\                            ← ★ 文档只放这里
│       └─ CONTRACT.md                   ← 本文件
└─ pnpm-workspace.yaml                   ← **不动**（agh-blender 也不在里面）
```

### 12.2 为什么项目根是仓库根

**M3/M4 要改隔壁的 `agh-blender`。** 若项目绑 `agh-ortho` 子目录，所有对 `agh-blender\...` 的写入都是"工作区外" → 每次都卡。绑仓库根则一路畅通。

### 12.3 零外部依赖

M1 保持**零 npm 依赖**（纯 ESM，六视图用自写正交投影 → SVG 字符串）：

- 不需要 build 步骤、不需要 `pnpm install`、不用动 workspace
- 改一行代码 = 只重装一次，没有"改了源码忘了构建"这一类坑

### 12.4 安装（在真实终端，非 TTY 会被拒）

```bash
# 在 D:\agnes-harness 根目录（相对 file: 路径按 daemon 的 workspace source 解析）
node packages/cli/dist/local/agnes.mjs package inspect file:./agh-ortho/package
node packages/cli/dist/local/agnes.mjs install   file:./agh-ortho/package

# 用 inspect 预览里的真实值（安装成功后默认 disabled）
node packages/cli/dist/local/agnes.mjs package trust  <id> <INTEGRITY> <CAPABILITY_HASH>
node packages/cli/dist/local/agnes.mjs package enable <id>
node packages/cli/dist/local/agnes.mjs package status
```

Web 等价：**Settings → Plugins → Install from source → Inspect/Install → Enable**。

---

## 13. 待确认项

| # | 项 | 默认值 |
|---|---|---|
| 1 | 工具前缀名 | `agh_ortho_` |
| 2 | M1 范围 | `box` + `slab`（可选加 `column` 阵列） |
| 3 | 是否带前端 UI | 否（F 条可忽略） |
| 4 | 输入类型 | 单张透视照片 or 正交立面图（影响 M2 的相机反演） |
| 5 | 六视图形式 | SVG 主 + PNG 次 |
| 6 | 跨插件调用 `ctx.tools.invoke('agh_blender_ops_catalog')` 是否可用 | **待实测**，不可用则退到 `agh.capability.json` |
