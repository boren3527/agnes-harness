# M1 骨架 —— 实测状态

> 2026-10-08 · 记录这一轮**实测**到的结论，以及哪些还只是推断。
> 标【实测】的有本机证据；标【推断】的还没验过，不要当成事实用。

---

## 1. 包骨架（已完成）

```
agh-ortho/
  notes/CONTRACT.md                   设计契约（从临时目录拷入，唯一副本在这）
  notes/SKELETON-STATUS.md            本文件：实测记录 + 未决项
  notes/DOWNSTREAM-REQUEST-readback.md  给下游的一个请求（攒进 M3）
  tools/check.mjs                     自检：node agh-ortho/tools/check.mjs
  tools/reinstall.ps1                 照 agh-blender 的版本改的完整重装循环（纯 ASCII）
  package/
    package.json                      Apache-2.0 · agnes.plugins[0].id = ext:agh-ortho/runtime
    LICENSE                           Apache-2.0 全文（从 agh-blender 逐字复制）
    NOTICE                            本包是整包单一许可，无 bridge/GPL 部分
    README.md
    extensions/main/index.mjs         tb() + 六个工具
    extensions/main/geometry.mjs      意图 → 几何规则
    extensions/main/views.mjs         正交投影 / 六视图 / SVG / numeric 残差 / 一张整图纸（renderSheet）
    extensions/main/run.mjs           描述符层：run 目录 / marker / report / 幂等 / 保留
    extensions/main/agh.capability.json   能力表快照
```

### 1.1 【实测】包插件**不能**有 `agnes.extension.json`

`packages/package-manager/src/inspect.ts:156`：

```
'third-party agnes.extensions is retired; migrate the backend to agnes.plugins'
```

只要包内存在 `agnes.extension.json`，或 `package.json` 里出现 `agnes.extensions`，inspect 直接
以 `E_EXT_LOAD / legacy-extension-format` 拒绝。所以 `capabilities.tools.prefix` 那套清单
（模板见 `packages/base/extensions/subagent/agnes.extension.json`）**只适用于 base 扩展，不适用于包插件**。

### 1.2 【实测】包插件的工具名**不受前缀校验**

`packages/host/src/ext-host/row-extension-host.ts:113` 给 `agnes.plugins` 行授予
`tools: { prefix: '' }`；配合 `api.ts` 的 `checkDeclared()`，`prefix: ''` 意味着只受
`TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/`（`tool.ts:74`）约束。
**`agh_ortho_` 是命名约定，不是被强制的规则。** ⇒ CONTRACT §13-1「前缀待确认」不再是卡点，
`agh_ortho_` 已定，改名不再有安装成本。

### 1.3 【实测】不带 UI 就不加 `clientDescriptors`

不带 UI 时 `inspect` 报 `contributions none`（agh-blender 报 `client`，因为它有 client 行）。
这符合 CONTRACT §13-3。附带收益：`capabilityHash` 覆盖客户端描述符（agh-blender 的 P0-F38），
不动描述符就不会因它而变化。

---

## 2. 【实测】`tb()` 有一支空档：联合节点

agh-blender 的 `tb()` 只在 `typeof node.type === 'string'` 时打 `Kind` 标记，因此**从不使用
anyOf 的它不会碰到问题**；而我们的数值叶子必须同时接受标量 `{v: 0}` 与向量 `{v: [0,0,4.65]}`
（CONTRACT §4.4），联合绕不开。

在 `packages/extension-api` 的 `@sinclair/typebox` 上实测（`Value.Check`）：

| 节点 | 结果 |
|---|---|
| `{ type:'number' }`（无标记） | 抛 `ValueCheckUnknownTypeError` |
| `{ [K]:'Number', type:'number' }` | ✔ |
| `{ [K]:'Union', anyOf:[num, arr] }` | ✔ 标量与向量都通过 |
| 同上，`v: 'x'` | ✘ 拒绝 |
| 同上，多一个键 `q` | ✘ 拒绝（`additionalProperties:false` 生效） |

⇒ 联合节点的 `Kind` 值就是字符串 `'Union'`。本包 `tb()` 补了这支，并对 `oneOf/allOf/not`
**构造期直接抛错**（fail fast），而不是让它在调用期变成无提示的 `TOOL_ARGS_INVALID`。

对 agh-blender 的建议（M3 再动，不现在改）：它的 `tb()` 若将来被用于任何 union schema，
会静默产出无法校验的 schema。

---

## 3. 【实测】能力表的两个"来源"是两个轴，混用会互相覆盖

第一版把「这次能力从哪个渠道取到」和「这份表说自己是哪来的」都叫 `source`，结果
`agh.capability.json` 里的 `source`（出处文字）把 acquisition 覆盖掉了 —— 冒烟测试抓到。
现在分开：

- `acquisition` —— `tool:… | file:agh.capability.json | fallback`，取值集合由本插件定义；
- `provenance` —— 那张表记录的下游出处（哪个文件、哪个版本），由数据自己写。

emit_ops 的输出里对应 `capability_source` / `capability_provenance` 两个字段。

---

## 4. 【实测】`ctx.tools.invoke` 的用量比函数调用重得多

`packages/core/src/effects/tool-context.ts:216` + `packages/core/src/step/reentry.ts`：

- 它是嵌套工具调用，走完整 `approveAndExecute`，记独立的 `tool/call` + `tool/result`；
- 占 turn 的 depth（`E_DEPTH_EXCEEDED`）、要求处于 tools phase（`E_RELATION`）；
- 目标工具必须在本轮已披露的工具集里（`t.snapshot.byName`），否则 `TOOL_NOT_FOUND`；
- **目标工具若需审批会 PARK**（抛 `PARKED`）。

⇒ 插件内**绝不可**去 invoke `agh_blender_apply_ops`（`always` 审批）。CONTRACT §7.2 的
"由模型编排，不做插件间调用"是硬约束，不是风格偏好。

另外 `ctx.tools.list()` 存在，可作为能力协商第 1 级的候选通道。

### 4.1 能力协商第 1 级的真实前置条件（比 CONTRACT §6 写的更苛刻）

`agh_blender_ops_catalog` **不是静态表**：`agh-blender/.../index.mjs:1283` 的 `runCatalog` 先取
`managedInstance(tctx)`，没有实例就直接返回
`{ ok:false, blockers:['no managed Blender instance; call agh_blender_start first'] }`。

⇒ 第 1 级来源**要求 Blender 已启动**，而 M1 的定位是"完全不依赖下游"。两者不能同时成立，
所以第 1 级必须是**可选**来源，缺席是正常分支。本包目前只实现第 2/3 级（file / fallback）。

---

## 5. 能力表快照的来源

`agh.capability.json` 的 `ops` / `limits` 逐条对照 `agh-blender/.../bridge/agh_ops.py`：
`OPS`（第 396 行）、`OP_MANIFEST`（第 412 行起）、`catalog()`。

【实测】两处**与 CONTRACT §3.1 表格的印象不同**，必须以 `OP_MANIFEST` 为准，因为它驱动审批：

- `mesh.primitive_add`、`object.duplicate`、`material.set`、`file.checkpoint`、
  `file.stage_export` 的 `mutates` 都是 **false**；
- `scale` 的实际上界是 **10000**（CONTRACT §3.2 只写了 `≥1e-6`）。

`capabilitySet: "primitives-6"` 是**本插件合成的**：下游 `catalog()` 不发布能力集标识
（它只给 `version: 1` + limits + ops）。这是 CONTRACT §5.2 要求 `target_capability_set`
与下游实际发布内容之间的一个已知缺口 —— M3 扩下游时可以顺手提出让 `catalog()` 带一个能力集名。

---

## 6. 冒烟测试（已跑通，探针已删）

用内核真正使用的那条路径（`Value.Check` + 8 键 meta + `4096/262144/32` 三个常量）验证，
从 `runtime.apply()` 取回注册的工具定义。**ALL PASS**，要点：

- 两个工具的定义合法：`meta` 8 键齐、`costHint` 只有 `wallMs`、参数
  `3828 bytes / depth 13`（限额 262144 / 32）；
- schema 接受 CONTRACT §4.4 的样例（标量与向量叶子共存），拒绝：裸数字叶子、叶子里的未知键、
  缺 `assembly`、顶层多余键、2 元向量；
- `emit_ops` 对 §4.4 样例产出 **2 个 op**：`plane(scale=[60,40,1])` 与
  `cube(scale=[12.4,8.6,9.3], location=[0,0,4.65])`；
- `target_capability_set` 是**生成**的（`agh-blender@0.1.7:primitives-6`），不是手写；
- 带空格的 id `col grid:1` 被 sanitize；
- `unresolved` 原样传到输出；`unsupported` 清单兼顾"下游表达不了"（`no_downstream_op`）与
  "本 emitter 还没做"（`not_implemented_in_m1`）与"作者自己声明"（`declared_by_parameter_file`）；
- `repeat` 不静默半产出：可 lower 的意图带 `repeat` 时报 `undecided` 且**产出 0 个 op**；
- `unit:"mm"` 与非法 `projection` 被拒，且错误信息带可操作提示。

两处曾失败、且都是**探针写错**而非代码错（一个把 `unsupported` 来源弄混，一个对
`repeat` 的优先级假设错了）—— 顺序上"特征本身不支持"优先于"repeat 未决"是对的。

---

## 7. 【实测】`package inspect` 通过

```
Preview agh-ortho@0.1.0
integrity sha256-fe6494ac173f141844239d6fd45b6f207e477779dbff327941666ce76a4f7d26
contributions none
warnings Package provenance has not been independently verified.
```

（integrity 随包内任何一个字节变化 —— 改一次 README 它就不同了。**不要把它当常量**，
也不要写进任何会被打包的文件。）

⚠ **`capabilityHash` 不在 CLI 文字预览里** —— `packages/cli-tui/src/package-admin.ts:106` 的
`formatPreview()` 只印 id@version / integrity / contributions / warnings，而
`trust <id> <integrity> <capabilityHash>` 要三个值。

**已解决（2026-10-08）**：两个值都从 **daemon 的 operation log** 读：

```
%USERPROFILE%\.agh\data\daemon\package-operations\operations.json
```

每个 `installed` 记录带 `id / version / trusted / integrity / capabilityHash`。
profile home 是 `%USERPROFILE%\.agh\data`（**不是** `.agnes`，所以第一次没找到）。

本机实测（`agh-blender@0.1.7`）：

```
integrity      sha256-9c3ebbeae75fda11ec54dab169f99ee6a9d20f2cb8b1ddd2c55c6aaafd7e265e
capabilityHash 7e7b2182ed1e108b78f8f721c9e1c988c7a02042510af11dfac138571fda11ad
```

与 `P0-EVIDENCE.md` 记的一致，也与 `package inspect` 出的 integrity 一致 ⇒ 本机的安装循环是通的。
`agh-blender/tools/reinstall.ps1` 早就在自动做这件事（它的 `Get-InstalledRecord`），
`agh-ortho/tools/reinstall.ps1` 照它改的。

## 8. M1 闭环：`views` + `verify`（已完成）

工具面现在是四个，全部只读：`catalog` / `emit_ops` / `views` / `verify`。

### 8.1 为什么 `views` 只返回文本、不落盘

这是本轮一个**刻意的减配**，换来的是 M1 不需要描述符层：

- 上游契约 §5.2 要求副作用型工具先落盘 `report.json`；工具一旦写文件就是副作用；
- 但 `tctx.fs` 只暴露 `read / write / list / stat`（`packages/core/src/effects/tool-context.ts`
  的 `fs`），**没有 mkdir**，且 `write` 之前会取 checkpoint 快照（快照作用域不可用就直接
  `E_SEAM_MISSING` 拒绝写入）；
- 而 SVG **本来就是文本** ⇒ 直接放进 `structured`（进模型）即可，零副效应、零审批、无需描述符。
  这同时兑现了 §8.2 选 SVG 的初衷：模型看不到工具产出的图片像素，但读得到 SVG。

所以"落盘 + 描述符（run-uuid / `report.json` / 幂等 / 清理）"整体归 `agh_ortho_save`，
和 CONTRACT §7.1 的分工一致。

顺带定死了 `views` 若将来写文件时的 meta：`requiresApproval` 对静态工具的默认值是
`isDestructive ? 'destructive' : 'never'`（`packages/extension-api/src/tool.ts:384`），
而 `isReadOnly` **与审批正交** —— 所以"写自己的 run 目录"可以是
`isReadOnly:false + isDestructive:false + replay:'safe' + requiresApproval:'never'`。
CONTRACT §7.2 说"`save` 是唯一的变更型工具"需要松一格：`views` 将来也是写者，只是非破坏性。

### 8.2 模块分层

```
geometry.mjs   意图层 → 几何规则：placementOf / lowersToOp / boxesFromOps / extentsFromParams
views.mjs      正交投影、六视图排布、SVG、numeric 残差
index.mjs      lowering + 四个工具
```

分开的理由不是洁癖：`verify` 必须从**两条独立路径**看同一个模型 —— 一条直接读参数叶子
（`extentsFromParams`），一条读 lowering 产出的 ops（`boxesFromOps`）。共用一条路径的话，
校验就是同义反复。

### 8.3 numeric 校验做了什么、没做什么

做了：参数 → ops → 包围盒 → 六视图 → **从视图反解** → 与参数比对，残差必须**恰好为 0**；
并且同一个轴被 **4 张视图**观测，4 个观测值必须彼此相等（`cross_view_spread`）。
X 由 front/back/top/bottom 观测，Y 由 top/bottom/left/right，Z 由 front/back/left/right。

**没做（必须在产物里说，不能藏）**：

- 只证明**几何自洽**，不证明几何与真实照片一致。后者是 `against_blender` 档，M1 不做；
- `placementOf` 是两条路径**共享**的落位规则 ⇒ 规则本身若把中心算错，两边一起错，残差仍为 0。
  这是已知盲区；
- 每张视图的 u/v 轴向是本插件采用的约定，**尚未逐条对照 GB/T 17451 核过**。

残差为 0 之所以有意义，是因为有**负例**在测：改坏 lowering（交换两个尺寸、忘了乘 scale、
挪动中心、丢掉一个对象）残差都会变成非 0。

### 8.4 【实测】第三角法的排布是两轴都反，不只是左右

CONTRACT §8.1 的注写"第三角法排布**左右**相反"。标准（第一角法俯视图在下、左视图在右；
第三角法俯视图在上、左视图在左）是**上下也反**。第一版只翻了左右，被自检抓出来。
现在两轴都反，代码注释里写明了这是按标准而不是按契约的字面说法实现的。

### 8.5 自检脚本

```
node agh-ortho/tools/check.mjs
```

零依赖、不需要 Blender。覆盖：工具定义的结构合法（Kind 标记 / 8 键 meta / 尺寸上限的本地复刻）、
`emit_ops` / `views` / `verify` 的行为、5 个负例、无 `at` 方块的落位假设、单位与投影的拒绝路径、
能力表快照。若能在工作区里找到 `@sinclair/typebox` 的副本（`packages/*/node_modules/`），
还会用内核真正使用的 `Value.Check` 再验一遍 schema；找不到就明确打印 SKIP，不假装验过。

**当前状态：ALL PASS**（含 `Value.Check` 三项）。

> 为什么不用 vitest：`agh-ortho` 不在 `pnpm-workspace.yaml` 里，而 CONTRACT §12.1 明确
> "不动 workspace"。所以自检做成包内的独立脚本，和 agh-blender 的 `tools/reinstall.ps1` 同一形式。

## 9. 描述符层 + `agh_ortho_save`（已完成）

### 9.1 为什么必须"落盘 + 描述符"，而不是回一段 JSON

上游契约给了三条硬边界，都不是风格问题：

- §2.1 第三方插件放进工具结果的**内容块**（尤其图片）会让该轮失败并**永久毒化会话**；
- §2.2 写进产物存储 ≠ 消费方读得到（还缺归属索引投影），而失败同样导致 §2.1 那种终局失败；
- §5.2 **变更型工具的结果可能被宿主替换成 `TOOL_OUTCOME_UNKNOWN`，结果与失败原因一起永久丢失**
  ⇒ 唯一可靠的补救是先把报告写到磁盘，返回值只是"方便读的副本"。

所以 `save` 的写入顺序是刻意的：**产物 → `marker.json` → `report.json`**，report 最后落盘、
且在返回之前。

### 9.2 落点与产物

```
<workspace>/.agnes/agh-ortho/runs/<run-id>/
  marker.json        { contract:1, producer, runId, createdAt }
  report.json        描述符数组（消费者以它为准）
  front.svg top.svg left.svg right.svg bottom.svg back.svg
  parameters.json ops.json verify.json
```

9 个产物 + marker + report。`preview` 逐条**生成**而不是写死（长度 63–86 字符），
且必须承载语义 —— 因为模型看不到图片像素，`preview` 是它唯一必然读到的内容。
ops 的 preview 会把"几项未 lower"写在脸上（CONTRACT §10：降级误差必须一路传到用户面前）。

六个视图**共用比例尺**（`views.mjs` 的 `commonScale`）：逐视图各自自适应缩放在工程图上是错的。

### 9.3 【实测】写盘这条路的三条事实

| 事实 | 出处 | 后果 |
|---|---|---|
| 工具写盘**不需要 mkdir** | `packages/host/src/adapters/fs.ts:223-226`：`write()` 内部先 `io.mkdir(dirname(real))`（recursive 才 `writeFile`） | 直接写 `<...>/runs/<id>/report.json` 就会建出整条目录链 |
| 工具面的 fs seam 只有 **read / write / list / stat** | `packages/core/src/effects/tool-context.ts` 的 `fs` | **没有 rm** ⇒ §7"谁删：生产方"在本插件的工具面做不到（见 §9.5） |
| `write` 之前会取 checkpoint 快照；快照作用域不可用即 `E_SEAM_MISSING` 拒绝写入。探测用的 `assertNotDenied` 走 `stat`，且**"文件缺失不算拒绝"** | 同上；`packages/core/src/effects/fs-guard.ts:253` | 写新路径是允许的；但一个没有 checkpoint 的接入方式会让 `save` 直接失败 |

另：唯一被拒绝写入的是**安装自身的状态目录**（凭据 / profile，`fullAccessReadOnlyRoots`），
不是工作区里的 `.agnes`。而 `.agnes` 恰好被 `.gitignore` 忽略 ⇒ 运行产物不会污染 `git status`。

### 9.4 `save` 的 meta 与为什么

```
isReadOnly:false  isDestructive:false  isConcurrencySafe:false
isOpenWorld:false replay:'never'       requiresApproval:'always'
```

它是本插件唯一的变更型工具。`true` 的关键在 `isReadOnly:false` —— 按约束 D，变更型工具的结果
一旦被判非法就会被替换，所以 §5.2 的"先落盘报告"对它不是可选优化。不作为读-破坏性（false）
但仍 `always` 审批：写进用户工作区应当被确认。`isConcurrencySafe:false` 是因为同一个 run 目录
并发写会互相覆盖。

### 9.5 幂等、归属、保留

- **幂等 (§5.3)**：传同一个 `run_id` 再调一次 → 从磁盘读回 `report.json`，**原样返回同一批描述符**
  （id 都不变），一个字节都不重写；
- **归属 (§4/§6)**：写之前先读 `marker.json`。producer 不是自己就拒绝，报 `E_RUN_NOT_OWNED`
  并**回报 marker 的实际内容**；
- **保留 (§7)**：每次返回都带 `retention` 计划（策略 20 次 / 30 天、盘上有几次、该删谁）。
  【实测】工具面没有 `rm`，所以**插件永远不执行删除**，只出计划，并在返回值里明说这一点。
  这是对 §7 的一处**刻意保守偏离**：契约还要求"不得静默删除被引用的运行"，而本插件无法知道
  谁引用过谁 —— 宁可不删。

### 9.6 校验（两层）

- **内存 fs**：复刻宿主 `write` 会建父目录的行为，测描述符字段、sha256/bytes、幂等、归属拒绝、
  保留计划，以及**消费方视角**的复核（§9 第 2 步）与**篡改必须被拒**（§9 第 7 步，
  人改一个产物后必须报 `E_ARTIFACT_MISMATCH`，不许静默接受）。
- **真实文件系统**：在 `tmp` 下真的写一遍，验证描述符路径在盘上真实存在、字节数/SHA256 与真实
  文件一致、父目录链被创建、`report.json` 解析得出来、重放幂等、SVG 是完整文档，**用后即清**。
  这一层专门抓"内存 fs 会把路径差异糊掉"的那类问题（Windows 拼接）。

上游契约 §9 的 8 步验收表：第 1–7 步已覆盖。第 8 步（"把图片作为内容块返回必须做不出来"）是
**结构性地满足**的 —— 本插件的任何工具都没有出现图片块的代码路径，连一个 `inline` 参数都没有。

**尚未测的**：真实的 tool fs seam 本身。上面两层都用注入的 fs，`save` 还没在一次真实会话里
被调用过（那需要 daemon 跑起来）。这是下一个里程碑前最该补的一次实测。

### 9.7 真实会话的结果（2026-10-08）

**打包 / 注册链路：完全验证通过。** 按 `tools/reinstall.ps1` 装进真实 AGH：

```
install agh-ortho  state=completed      integrity 与源码 inspect 完全一致
trust → enable → status                agh-ortho@0.1.0 desired=enabled actual=running trusted=true
audit/host.jsonl                       5 × extension.registered + 1 × extension.loaded
```

5 个工具全过 `checkToolDef`（工具名/描述长度/8 键 meta/参数尺寸/无符号键）——
`extension.failed` 一条都没有。**`capabilityHash = e3de4e5f2da4b8aa2650af5c4f822d397c2dadd7a6695e5071c0444d26a22b01`**
（与 `agh-blender-bridge` 相同：两者声明的能力面一样都是"一个 in-process 插件行、无客户端"，
所以哈希相同 —— 这是符合预期的，不是巧合 bug）。

**真实会话：只差最后一步。** 用 `agh -p ... --mode json` 跑了一次指定 `run_id: m1-probe-1` 的调用：

| 环节 | 结果 |
|---|---|
| 工具被发现并披露给模型 | ✅ |
| **参数通过内核 schema 校验** | ✅（长串 assembly 叶子全过） |
| 调用被派发 | ✅ `tool/call` 事件在 |
| **审批闸门** | ⛔ `APPROVAL_REJECTED`，`enforcement.level=partial` `scope=['file']` |
| fs 写入 | ⬜ 未触达（`runs/` 目录不存在，确认一个字节都没写） |

原因不是 `save` 的缺陷，而是 `requiresApproval:'always'` 在**无人应答的非交互跑法里 fail-closed**。
这正符合 CONTRACT §7.1 的意图，但也意味着 **`save` 无法在无头流程里被验证或使用**。

顺带两条观察（都不阻塞）：

- 模型没有编造 `report_path`，并明确说"没有文件可读、数字都是我编的" —— 说明工具描述里
  "以磁盘上的 `report.json` 为准" 那句是有效的；
- 模型的运行时上下文里写 `enforcement: "unavailable"`，而工具结果里写
  `level: "partial", scope: ["file"]` —— 两处口径不一致，值得单独查一次（可能是
  Windows 上文件策略只能部分强制）。记在 §10。

**修掉的两件事（都在 `tools/`，包外，不触发重装）：**

1. `reinstall.ps1` 的 install 步骤以前被 PowerShell 的函数管道吃掉 stdout ⇒ 子进程 `isTTY` 为假
   ⇒ CLI 走非交互分支**静默取消**（什么都不打印）。实测三种调用方式下子进程 stdout 都被收走。
   现在这一句不再经过管道，并在注释里带上实测数据。**结论：AGH 的安装必须手跑一行原始命令**
   （`node packages/cli/dist/local/agnes.mjs install file:./agh-ortho/package --profile local-dev`），
   脚本只负责它擅长的那部分（trust/enable/status/audit）。
2. 加了**防"装成旧版本"守卫**：`Get-InstalledRecord` 返回的是该 id 的**最后一条**记录，
   安装静默失败时它拿到的是**上一次的旧记录**，脚本会拿旧 integrity 去 trust 然后报成功。
   现在强制 `$record.integrity -eq $sourceIntegrity`，不等就红字退出。本条对
   `agh-blender/tools/reinstall.ps1` 同样成立（同一写法），值得一并核。

### 9.8 真实会话的写入验证：全部通过（2026-10-08）

在 TUI 里批准一次之后，`agh_ortho_save` 真的写盘了。**从磁盘独立复核（不信返回值）：**

```
目录  .agnes/agh-ortho/runs/m1-probe-1/   11 个文件
      marker.json  report.json  front/top/left/right/bottom/back.svg  parameters.json  ops.json  verify.json
report.json  contract=1 · producer=agh-ortho@0.1.0 · runId 与目录一致 · artifacts=9
9 个描述符   path 全部存在 · bytes 与真实文件一致 · sha256 与真实文件一致
             全部绝对路径且指向本 run 目录 · sha256 全为 64 位小写 hex
             十一个必填字段齐全 · preview 长度 20–200
marker.json  归属字段正确
六个 SVG      全部是完整文档 · **共用同一比例尺 0.149**
ops.json     2 个 primitive_add（plane scale=[60,40,1] loc=[0,0,0]；cube scale=[12.4,8.6,9.3] loc=[0,0,4.65]）
             target_capability_set = agh-blender@0.1.7:primitives-6（生成值）
verify.json  residual_max = 0 · worst = null · 6 行（2 对象 × 3 轴）· 每行被 4 张视图交叉观测
             每行 cross_view_spread = 0
parameters.json 保住了模型传入的参数
```

**结论：真实 fs seam 与 checkpoint 快照都工作正常** —— 写入没有报 `E_SEAM_MISSING`，
所以 §8.1 里那条"写前必须取 checkpoint 快照、快照不可用就拒绝写"的风险在这台机器上不存在。
`tool/call` 事件还把静态策略解析原样记了下来，与本插件声明的 meta 一位不差：

```json
"resolvedPolicy":{ "isReadOnly":false, "isDestructive":false, "isConcurrencySafe":false,
                   "isOpenWorld":false, "replay":"never", "requiresApproval":"always",
                   "approvalScopes":[], "policyVersion":"static-v1" },
"executionDomain":"workspace"
```

**这一轮复核抓到并修掉的缺陷：** `verify.json` 里 `caveats`（盲区自述）**条数为 0** ——
因为我在 `index.mjs` 里写了两份 verify payload：工具返回那份带三条盲区，**落盘那份没有**。
落盘那份才是长期可消费的，所以这条规矩恰好在最该生效的地方失效了。
现已提成共享常量 `VERIFY_CAVEATS`，两处共用，并在自检里加了一条"落盘的 verify.json 必须带三条盲区"
的断言（这条断言在修复前会失败）。

**一处失败是我自己的断言写错了**：我照抄了 4 件套样例的预期，断言 `unlowered` 有 2 种原因码，
但这次的 assembly 只有 `slab` 和 `box`、**两个都可 lower**，所以 `unlowered` 本就该为空。

> 顺带：`TUI` 的审批模态框**初始选中项是「拒绝」**，回车/`Esc`/`Ctrl-C` 都是拒绝
> （`cli-tui/src/permission-modal.ts`：`Enter initially selects rejection`）。
> 要批准必须先用 ↓ 把光标移到选项上再回车；且模态框拿不到 ≥4 行时（`canSelect = rows >= 4`）
> 只能 resize 或拒绝。

**⚠ 包已改动 ⇒ 源码的 integrity 变成了 `sha256-8c44580ce599b7e525d1877df1eefbf3eeb21e606dae35f425c0f9d2b8d03373`，
而已装的是 `sha256-117f18ff…`（旧）。两者漂移了，再想用 `save` 之前必须重装一次。**

### 9.9 能力协商第 1 级：**接通**（2026-10-08）

CONTRACT §13 第 6 项那个悬了很久的"待实测"有答案了：**跨插件 `ctx.tools.invoke` 可用。**

在真实会话里（`agh_blender_start` 拉起受管理实例后）调用 `agh_ortho_catalog`，从转录里独立核出的载荷：

```
"acquisition":"tool:agh_blender_ops_catalog"      ← 第 1 级真的接通了
"stale":false                                      ← 活实例，不是快照
limits: maxOpsPerBatch=64, maxObjects=512, nameCharset=A-Za-z0-9_-.", nameMaxLength=96
ops: 10（与直接调 agh_blender_ops_catalog 拿到的完全一致，逐项带 mutates/destructive）
```

深度也够：`preset.ts:84` 的 `depthLimit: 2`，嵌套调用是"调用方深度 + 1"，模型调我们的工具（1）→
内部 invoke（2）**正好卡在上限内**，允许一级嵌套。

### 9.9.1 这次实测同时抓到一个"载荷在说谎"的缺陷（已修）

同一份载荷里出现了**自相矛盾**：

```json
"acquisition": "tool:agh_blender_ops_catalog",          // 真实
"sources": { "tool": { "available": false,              // 假话：骨架期硬编码的
                       "why": "not wired yet; ..." } }   // 而第 1 级已经接通了
```

而且 catalog 的**工具描述**里也还写着"从下游在线取能力是下一步" —— 那句是**直接给模型看的**。
模型没有出错：它忠实转述了这两处假话（回报里同时出现"acquisition 是 tool"和"source 是 fallback"）。

修法：`sources` 里每一级改成报告 **`inUse`**（由 `acquisition` 反推）+ `attempted` + `reason`，
**不再有任何硬编码的可用性**；两处工具描述同步改准。
并在自检里加了针对这条的回归断言（正例 `sources.tool.inUse === true`，降级例翻转为 `file.inUse`）。

> 教训与 §5.2 同源：**一旦某个"未接通"的常量被写进载荷或描述，接通之后它就变成假话，
> 而下游（模型）会忠实转述。** 所以"可用性"这类事实必须每次从状态反推，不能写死。

### 9.9.2 【实测】YOLO 模式会静默越过 `always` 审批

那个会话里有 `x/core/yolo-switch`：`{"to": true, "operatorId": "local", "profileHash": "sha256-2fff1058…"}`。
于是 `requiresApproval:'always'` 的 `agh_blender_start` **不弹任何提示就执行了**。

这条对安全姿态很重要：**YOLO 一开，所有 `always` 闸门都失效** —— 包括会写场景的
`agh_blender_apply_ops` 和本插件的 `agh_ortho_save`。跑无人实验时务必知道当前模式。

顺带把四个会话的审批语义全部对齐（从转录核实）：

| 会话 | save 调用 | YOLO | 结果 |
|---|---|---|---|
| `f02877c7` | 0 | **true** | YOLO ⇒ `always` 的 `agh_blender_start` 静默执行 |
| `88f6d419` | 2 | false | **save 成功那次，走的是真实审批路径** |
| `3594ea0f` | 1 | false | `APPROVAL_REJECTED` —— 关 TUI 时模态框还挂着，`PermissionModal.close()` 把它判为拒绝 |
| `0ae47e3c` | 1 | false | `APPROVAL_REJECTED` —— 无头 `-p`，无 TTY ⇒ fail-closed |

所以 §9.7 的"审批路径也验过了"这句是有证据的，不是转述。

### 9.9.3 【实测】"防装成旧版本"守卫在真实场景下生效了

2026-10-08 的那次重装里，我的流程漏了 `disable` + `remove`（前两次都做了，这次忘了），
包仍处于 **enabled** 状态。结果：

```
install  operation: state=failed, progress=50
         error: { code: "E_PACKAGE_STATE",
                  safeMessage: "The package operation cannot run in the current state." }
```

**install 在包已安装/已启用时会被拒绝** —— 所以"重装"从来不是幂等的替换，它必须走完整循环。
更关键的是：install 失败后 `Get-InstalledRecord` 返回的是**上一次**的记录。没有守卫的话，
脚本会拿**旧的** integrity/capabilityHash 去 trust + enable，然后报"成功"
（`trust` 也确实返回了 `completed`，`enable` 也返回了 `completed`），**而装上去的还是旧版**。

守卫当场判 `False` 并拦住了这次静默失败。**这是它第一次在真实场景下起作用**（不是自检里的构造用例）。

正确顺序（`tools/reinstall.ps1` 就是按这个写的，我不该手写流程）：

```
inspect → disable → remove → install → trust → enable → status → audit 核对
```

> 结论：脚本存在的意义不是省打字，而是**把顺序固化下来**。我手写流程时漏了一步就踩了这个坑 ——
> 而脚本里那一步是被注释解释过的。

### 9.9.4 【实测】修复后的复测通过，并发现**同会话热重载生效**

同一个会话里出现了两份 `sources` 载荷，构成前后对照：

```
第 1 处（旧构建）: {"tool":{"available":false,"why":"not wired yet..."},"file":{"available":false,...},"fallback":{"available":true}}
第 2 处（新构建）: {"tool":{"inUse":true,"attempted":true,"reason":null},"file":{"inUse":false,...},"fallback":{"inUse":false}}
```

第 2 份正是修复后的形状，且与 `acquisition:"tool:agh_blender_ops_catalog"` / `stale:false` 完全自洽。
**结论：载荷不再自相矛盾；第 1 级来源在真实会话里稳定可用。**

顺带一条**运维事实**：会话 `f02877c7` 是在旧构建下启动的，重装之后**没有新开会话**，
下一次工具调用就用上了新构建 —— 说明扩展的重载会作用到已运行的会话。
（这是单次观察，但至少说明"重装后必须新开会话"这个担心不成立。我之前对用户说过的那句话是错的。）

### 9.9.5 【实测·下游】`agh_blender_stop` 在关闭竞态下报失败，而进程实际已退出

```
两次调用均 ok:false, blockers:["transport: fetch failed"], mode:"token", stage:"close", forceKilled:false
随后 agh_blender_probe:  alive:false, health:"fetch failed", processAlive:false
磁盘上的 stop-report.json 与返回值一致
```

即：**bridge 在关闭过程中断连，stop 拿不到确认**，而实例其实已经退出。
这是**保守方向**的失败 —— 它没有谎报成功（这一点比反过来好得多），但意味着
"**一次受控关闭已被确认**"这件事下游目前给不出保证。任何依赖"stop 返回 ok 才继续"的编排都会误判。

候选加入给下游的清单（见 `DOWNSTREAM-REQUEST-readback.md` §8），并提醒：本插件不受影响
（我们不调用 stop），但**凡是把它当闸门的编排都会踩到**。

### 9.9.6 `scene_readback` 半档（已完成）

新增在 `agh_ortho_verify` 上：传 `against_scene:true` 时，它嵌套调用只读的 `agh_blender_scene`，
把"我打算创建的对象"与真实场景比对。

**能断言（精确）**：对象按**确切名字**存在、`type` 是 MESH、`location` 与 `scale` 与我们发出的 ops
一致（容差 1e-6）。这一档的意义在于它是本插件**第一次引入外部事实**，因此能抓到 `numeric` 抓不到的：

- ops 发出了但下游**没建出来**；
- 名字被占用 —— Blender 会改名成 `name.001`，于是"精确名字找不到"直接报 `missing`；
- 位置/缩放被下游改了或被别的东西覆盖。

**验不了（必须在返回里逐条写出来）**：

1. **最终尺寸（`w×d×h`）** —— `describe_scene()` 不发布 `dimensions`，所以"`size=1` 是不是单位边长"
   仍然没被验证过；
2. **基元种类本身**（除 `type=MESH` 外）—— 下游 catalog 不发布每种基元的顶点/面数，
   所以 `vertices`/`polygons` **只作为证据报出来，不据此判成败**。

这两条就是 `notes/DOWNSTREAM-REQUEST-readback.md` 那份请求的**可复现理由**，而不是一句设计意见。

**命名纪律**：这一档的 `tier` 如实写 `scene_readback`，**绝不写 `against_blender`** ——
尺寸语义还验不了，它够不上契约 §9 那一档。`upgrade_path` 字段把"下游加 `dimensions` 之后
同一份比对代码就升级成真正的 against_blender"写进了载荷本身。

缺实例/读不到场景时**不抛错**：报 `E_SCENE_UNAVAILABLE`，`scene.available:false`，
并明确说明"本档没有发生"（`note` 字段），同时**保留 numeric 的结果** —— 半档不能因为读不到外部事实
就把已经算出来的东西丢掉，但也绝不能被读成"读回通过了"。

### 9.9.7 一条性能/噪音上的代价（如实记下）

`resolveTargetCapabilities` 每次都会尝试嵌套调用 `agh_blender_ops_catalog`，而
`reentry.ts` 的注释写明嵌套调用会**各自记一条 `tool/call` 与 `tool/result`**。所以：
**每个会 lower ops 的只读工具（`emit_ops`/`views`/`verify`/`save`）在有能力源时都会多出一对可见事件。**

- 好的一面：能力来源变得**可追溯**（转录里能看见它到底问过谁）；
- 代价：转录噪音 + 每次一个到 Blender 的 HTTP 往返；
- 风险（暂未发生）：如果将来某个下游 catalog 工具改成需要审批，我们的**只读**工具会 PARK ——
  目前 `agh_blender_ops_catalog` 是 `never`，且失败即降级能兜住抛错，但这值得在 M3 扩下游时再看一眼。

## 9.10 M2 第一轮：闭环在真实照片上跑通，并暴露三个缺陷（2026-10-08）

`agh_ortho_fit`（闭环里"便宜的那一半"）落地后，拿**一张真实照片**跑了两轮完整的
①→⑥。这是第一次在真实输入上把闭环合上，也是第一次量到几件一直只是"设计主张"的事。

### 9.10.1 跑通的流程

```
① 模型看图 → 20 个 box（人形：shoe/leg/shorts/shirt/head/hair/eyes/arms/stick/ball…）
② fit（不碰 Blender）→ verdict: fit
④ agh_blender_apply_ops → 20/20 applied，场景 3 → 23 对象
⑤ fit + against_scene → matched 20/20、size_asserted=true、extra_objects=[Camera,Cube,Light]
⑥ save → 11 项（9 产物 + marker + report），verify.json 同时记 numeric 与 scene_readback
```

### 9.10.2 量到了：确定性

**同一组参数 → ops.json 与六个 SVG 的 sha256 逐字节相同**（两轮对比，见
`photo-round-1` 与 `photo-round-1b`）。契约里"参数是唯一真值源、六视图是它的确定性投影"
这句话，从主张变成了可对账的事实。意义：参数可以长期保存、随时重算，且重算结果可复现。

### 9.10.3 这一轮暴露的三个**真**缺陷（都已修，各带回归断言）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | **numeric 判据用了"残差必须恰好为 0"** | 20 对象产生 **34 条 blocking，全是 1 ulp**（`residual_max` 1.11e-16）→ **整条闭环堵死在 `verdict=revise`**，⑥ 永不可达 | 引入**具名容差 `NUMERIC_TOLERANCE = 1e-9`**（噪声 ~1e-16，真实误差 ≥1e-6，中间是宽空档），并**始终报告实际数值 + 容差**，从不声称"恰好是 0"。**这是对契约 §9 字面说法的有意偏离** —— 两侧是两条独立算术路径，箱体中心经过 `c ± half → (min+max)/2` 的往返，浮点下不位精确 |
| 2 | **`save` 记录不了读回** | 产物包只证明"我自洽"，证明不了"下游照做了" —— **交付物比这一轮实际验过的少** | `SAVE_INPUT` 加 `against_scene`；`verify.json` 同时写两档；`report.json` 带 `scene_readback` 摘要；没有实例时写明"读回**没有发生**" |
| 3 | **`parameters.json` 夹带工具控制字段** | 落盘的是 `JSON.stringify(args)`，含 `run_id` / `against_scene` ⇒ 这份交付物带着两个额外键，而 schema 是 `additionalProperties:false` ⇒ **喂不回 `emit_ops`/`fit`** | 改成**白名单**，字段名从 `Object.keys(EMIT_OPS_INPUT.properties)` 推 ⇒ 加真实参数字段会自动进产物，工具字段永远漏不进去。断言：`the saved parameters feed straight back into emit_ops` |

**三个都是"跑真实数据才暴露"的类型。** 两个是交付物的诚实性问题（一个少证明、一个多夹带），
一个是判据本身错。

### 9.10.4 难度阶梯的第一份实测校准

输入是**一张平线图**（人形，无已知真实长度，含曲线轮廓）。结果落在预估阶梯的
**⚠️ 勉强档**，且表现与预测一致。模型的自我声明质量很高，正好覆盖契约警告过的每个坑：

```
proportions_only + unit_is_figure_height（所有"米"其实是相对图形总高的比例）
cutout_relief（单张前视图看不见深度，Y 厚度全是声明假设）
fronto_parallel（按正交前视图处理，未校正透视）
face_marks_as_relief / no_symmetry_assumed
unresolved 6 条：圆形轮廓只能用方块近似、背面完全不可知、头发形状只能近似 …
anchor.present = false
```

**所以这一轮的"全绿"证明的是自洽 + 下游照做，不证明与照片一致。** 要与照片比对，
只能用 `outline` 或那 6 张 SVG 配合人眼 —— 工具读不到图片像素。这条边界是设计，不是缺陷。

### 9.10.5 顺手确认的两件事

- **`stop` 可以给出干净确认**：`ok=true, requested=true, confirmed=true`（对比之前两次：
  一次 `E_DIRTY` 拒绝、一次 `transport: fetch failed`）。
- **旧实例无需善后**：手工关窗或重装导致的"无 stop-report 死亡"，由插件的**进程存活检查**
  兜住 —— 下一次 `start` 正常，不会读错记录。

---

## 9.11 M2 第一轮完整闭环（`photo-round-2`）+ 一次**交付包被就地改坏**的实测

### 9.11.1 闭环跑全了（磁盘独立核过）
七步全过：`fit` → `start` → `emit_ops` → `apply_ops` → `fit(against_scene)` → `save(against_scene)` → `stop{force:true}`。

`photo-round-2` 的复核（按描述符逐产物重算 sha256 与字节数）：

```
11 项 · 9 描述符 · 全部一致
verify.json 两档：numeric 1.11e-16（容差 1e-9）+ scene 20/20 match、missing 0、size_asserted true
20 行 dimensions_delta 全 0，且每行报出实际 tolerance（~1.9e-6）—— 相对容差生效
parameters.json 只有意图层字段；两处改动值在；photo_check 在
ops：20 个 primitive_add、1 批、能力来自 live catalog
```

### 9.11.2 **交付的包被就地改坏** —— 且**无法精确回退**

`photo-round-1b` 的 `parameters.json` 在交付后被人**就地**修改（读—改—写同一个文件）。
它的 sha256 记在**同一个包**的 `report.json` 里 ⇒ **包自相矛盾**：

```
report 记录 e78794a2bc…377b  /  磁盘 5374f77d81…4fa9
```

- **拦不住**：`save` 会拒绝写别人的 run 目录（`E_RUN_NOT_OWNED`），但**文件工具直接改拦不住**
- **退不回**：同长度 8752 B 的副本、字节不同 ⇒ sha256 不同。**已交付的包一旦被改，就没有精确回退的路**
- **但可检出** —— 任何消费者按描述符核一次就会看到不符。这正是描述符 + sha256 存在的意义：
  把"静默损坏"变成"可检出的不符"。**它确实被检出了**（被核验脚本检出）
- 它的模型仍完整留在 `ops.json` 里，可从那儿复原
- 规矩已写进 `LOOP-PROCEDURE.md` §3.8：要改，先复制到 run 目录之外

### 9.11.3 两种 sha256 格式共存 —— 核验脚本先踩了

| 出处 | 格式 |
|---|---|
| 描述符的 `sha256`（`report.json` 里） | **64 位裸十六进制，不带前缀** |
| harness 的包 integrity | **带 `sha256-` 前缀** |

核验脚本混用这两者 ⇒ 9 个产物**全部**误报"不符"（而它们其实都对）。**先看清要读的是哪一种。**

### 9.11.4 本轮我犯的四个错（同一族）

全部属于"**没把我看到的那个数 / 那份文件，与它真正代表的东西对齐**"：

1. 把"**某个底座上**的结果值"当成"到处成立的事实"（`−0.2625`）⇒ 指令基于**混合底座**
2. 重叠判定用**未舍入**值、报告用**舍入**值（0.5000… 印成 `0.5` 却被列出）⇒ 已修：判定改用报告里的那个数
3. 核验脚本混了两种 sha256 格式
4. 措辞"读 …只做两处改动"未说"先复制" ⇒ **直接导致 §9.11.2**

---

## 9.12 M3 前置四件事：①④ → ② → ③（2026-10-09）

顺序是刻意的：**先把"能对齐的坐标"建起来，再往里放东西**。四件的共同理由是"生成网格不可复算、
参数可复算"，所以两条路必须在**部件级**和**图上**能对齐，而不是靠人记。

### ① `part`：共享部件词汇表（已完成）

`PART_TAXONOMY = body · clothing · hair · prop · structure · furniture · ground`（借 StdGEN 的语义分解），
`partCensus()` 报 `undeclared` / `unknown_values`，**只 warning 不挡路**。文档：LOOP-PROCEDURE §3.9①。

### ④ 规范摆放（已完成）

`placementReport()`：底面贴 z=0、水平居中；容差 = 包络最大维度的 1%（**相对**，不是绝对值），
**只报只挡时不挡** —— 这是"便于比较"的约定，不是几何正确性。文档：LOOP-PROCEDURE §3.9④。

### ② 生成网格的来源与"哪一档验不了它"（已完成）

- 新增 `MESH_SOURCE` 模式（`kind` 必填，`model`/`weights`/`seed`/`input_image_sha256`/`note`）
  与 `generatedReport()`：**生成物不可复算**（要 模型 + 权重 + seed），参数化物可复算（同参数 → 逐字节相同）
- `LOWERING.mesh` = `unsupported / no_downstream_op`：**它是一个"我知道做不到"的特征**，
  不是"未知特征" —— 两者在报告里必须分开（未知会 blocking，已知不会）
- **形状验不了这件事必须写在明处**：`numeric` 不适用、`photo_check` 不适用、读回只管
  存在/位置/尺寸。报告里给 `note` + 每项一条 warning

**修掉的一个缺陷（自己引入的）**：第一版对**每一个**声明了 `source` 的部件都发
"its SHAPE cannot be verified" —— 连 `source.kind = 'parametric'` 也发。
那等于把一个**不成立**的警告盖在一个**成立**的部件上：参数化来源的形状恰恰**是** `numeric` 覆盖的。
§"把会变的事实写成常量"这一族又添一例。现在只有 `reproducible === false` 才发，
并且载荷 `note` 也按实际声明分岔（只有参数化来源时不许说"形状验不了"）。
（回归断言：`mesh: a parametric source is reproducible and gets no generated warning` + 载荷 note 那条。）

### ③ 六视图 → **一张图纸**：复核的唯一对象，且必须在贵的那一步之前（已完成）

`renderSheet()`（views.mjs）：六视图按 `sheetPlacement` 排到**一张 SVG** 上、**全图一个比例尺**，
标题栏给出 convention / projection / `shared_scale`，每格给出 `col/row` 与 `extent u/v`。

- 它让 `sheetPlacement` **从"算出来只打印文本"变成真正被使用** —— 之前那段是"正确但没人用"，
  而正确但没人用的东西迟早和现实脱钩（§9.11.4 同族）
- **为什么必须是"一张"**：六张分图放在一起，人看到的是六个数；排到一张图上之后，
  "第三角法的左视图在左、俯视图在上"才是**图上可见的**，排错会被一眼看出
- 落在哪：`save` 的第一号产物 `sheet.svg`（`report.json.artifacts[0]`，交付包从 9 → **10 个描述符**）；
  `agh_ortho_views` 的 `sheet_svg`（文本）；`fit` 的 `sheet` 是**指针**（`shared_scale` / `cells` /
  `review_before_apply_ops`），**正文有意不重复发** —— 20 个对象的图纸约 30 KB，同一份几何发两遍就是翻倍上下文
- **顺序硬规矩**（LOOP-PROCEDURE §1 / §3.10 / §6①）：`fit` 给 `verdict=fit` 之后，先 `save` 一次**候选**
  （`run_id` 带 `-candidate`，不需要 Blender）→ 人打开 `sheet.svg` 复核 → **通过后才 `apply_ops`**

**真实数据探针**（拿 `photo-round-2` 交付的 `ops.json` 渲染，两种角法各一遍）：20 个对象 →
**120 个对象矩形**（6 视图 × 20）、**0 个越出画布**、978×602、全图比例尺 114.229、
两种角法**比例尺相同**（镜像不改比例尺）、格位确实整体镜像
（第一角法 `top@0/1 left@1/0 back@2/0` ↔ 第三角法 `top@0/-1 left@-1/0 back@-2/0`）。
20 个对象的图纸约 **30 KB** —— 这正是"正文不进 `fit` 载荷"的量化理由。

**顺带堵掉 ③ 自己引入的坑**：`save` 按 `run_id` 幂等 ⇒ 候选轮若用了交付的 id，
交付轮的 `against_scene` 只会拿回旧描述符、**读回永远不会被记录**。现在重放分支会明说
`readback_recorded` / `readback_not_recorded`（不是失败 —— 重放本身是对的，但这件事必须被看见）。

### 自检与 integrity

自检从 168 → **190 条断言全部通过**（新增：8h 的 6 条 mesh 断言 + 8i 的 6 条图纸断言 +
2 条重放读回断言 + 1 条载荷 note 断言 + 4 条"参数文件规范键序"断言 + 1 条"断言清单容差不写死"断言
+ 2 条"工具描述必须教冷启动要点"断言）。`notes/` 里改字不动 integrity；动了 `package/` 就要重装。

**统计口径的一个坑（实测）**：用 PowerShell 管道数自检行数会**少算** —— 很长的一行会把下一行
并进同一行（实测 **188 vs 190**，我差点把 188 写进报告）。要数就用
`cmd /c "node agh-ortho\tools\check.mjs > out.txt"` 重定向再数。

**真实安装（2026-10-09 15:34，本机实测）**：源码与已装记录同为
`sha256-f2c7943a7f90dd1b3bfc67826620b1b4bd9ad387eac138d2c606bc208a24a4cf`，
`capabilityHash e3de4e5f…`（**与上一版相同** —— 图纸只改了载荷与产物，没动声明的能力面），
`package status` = `desired=enabled actual=running trusted=true`，audit 里 12 秒后
`extension.loaded` + **6 个 `extension.registered`**（`agh_ortho_catalog/emit_ops/views/verify/fit/save`）。

## 9.13 重装脚本的三层缺陷：**前一个把后一个挡住了**（2026-10-09）

三次失败逐层剥开，每一次都只能看见"当前这一层"（另见 §9.9.3：守卫上一次也真的拦下过一次静默失败）：

| # | 症状 | 根因 | 为什么之前看不见 |
|---|---|---|---|
| 1 | `Start-Process : 无法将"System.Object[]"转换为参数"-FilePath"所需的类型"System.String"` | `$nodeExe = @(…Select-Object -First 1 -ExpandProperty Source)` —— `@()` 让它成为 `Object[]`。**实测**：`& $nodeExe`（调用运算符）吃数组，`Start-Process -FilePath` 不吃 | install 那步在 PowerShell 里就死了，提示符根本没机会出现 |
| 2 | 提示符没出现、什么都没装（静默） | 子进程的 stdout 不是 TTY ⇒ `confirmPackageInstall` 直接返回 false **且不打印任何东西** | 需要 1 先修好才轮得到它暴露 |
| 3 | `Cannot find module 'D:\agnes-harness\install'` | `Invoke-CliInteractive` **漏了 `$cli`**：node 收到的第一个参数是 `install`，被当成脚本路径 | 需要 1、2 先修好才轮得到它暴露；`agh-blender` 那份有同一个漏写 |

**三条留下的规矩**：

1. `Start-Process -FilePath` 只接受字符串 —— 解析可执行文件路径时**不要用 `@()` 包**（`&` 和 `Start-Process` 的容忍度不同）
2. **一条 install 记录 ≠ 磁盘上有一份副本**：`remove` 之后旧记录仍在 ⇒ 新的"跳过安装"条件收紧为
   **记录一致 ∧ `package status` 里真的列出该 id ∧ 未传 `-ForceReinstall`**
3. 守卫失败时**打印可以手敲的兜底命令行**（`& node <cli> install <source> --profile <p>`）——
   这次就是靠手敲那条路过的；工具链自己出问题时，别让用户只剩下"再试一次"

**这一层层的教训归到一句**：`@()` 包一层、少写一个 `$cli`，都是"看起来等价"的写法。
它们不是靠读代码发现的，是靠**跑**发现的 —— 与 §9.11.4 同一族（六处改动边界的伤也是"看"没发现、"跑"才发现）。

## 9.14 第一轮"图纸复核 → 建模"完整闭环（`photo-round-3`，2026-10-09）

第一次把 ③ 的**人看图纸**那一关真的插进流程里跑了一遍，并因此抓出两个缺陷。

**流程（与规程 §1 一致）**：候选那轮**没有实例** ⇒ 能力表回落到 `file:agh.capability.json`
（`agh-blender@0.1.8:primitives-6`，闸门 applied）；人打开 `sheet.svg` 看过并放行；④⑤⑥ 时**有实例**
⇒ 走 `tool:agh_blender_ops_catalog`（`agh-blender@live:catalog-v1`，闸门 not_applied）；
⑦ `stop {force:true}` 这次**没有**出现 §9.9.5 的关闭竞态（`elapsedMs 2037`、`confirmed:true`、
`forceKilled:false`）。

**交付包独立核过（不依赖模型转述）**：10 个描述符、`artifacts[0]` 是 `sheet.svg`、
每个描述符的 sha256/bytes 与磁盘一致；`verify.json` 的 `tier = scene_readback`（两档都在）、
`caveats` 3 条；numeric 残差 `1.1102230246251565e-16 ≤ 1e-9`；读回 **20/20 match**、
missing/mismatched 0、`size_asserted: true`、**20 行 `dimensions_delta` 全 0**、
每行容差 1.5e-6 … 9.6e-6；`--factory-startup` 的 3 个对象（Cube/Light/Camera）报成 `extra`
（不是失败）；`head` 读回 `[0.39, 0.16, 0.352]`、`arm_L` 位置 `[−0.2625, 0, 0.656]` —— 与参数一字不差。

**候选与交付的关系**：`ops` 数组**逐字节相同**，只有 6 个能力来源字段不同（live vs 快照）；
候选那份**仍然没有读回**（没被回填），这正是"候选 = 复核时看到的版本"该有的样子。

**这一轮核验抓到的两个缺陷（都已修，各带回归断言）**：

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | `parameters.json` 的**键序跟着调用方走** ⇒ 同值不同字节 | 同一组参数，`photo-round-3-candidate` 是 `id,feature,w,d,h,at` / `frame = up,front,handed`，`photo-round-3` 是 `at,d,feature,h,id,w` / `front,handed,up` | `canonicalParams()`：顶层按 `INTENT_KEYS`、assembly 项按声明顺序、其余按键名排序（JSON 键序无语义，规范化不丢信息） |
| 2 | `scene_readback.asserts` **写死 "within 1e-6"**，而同一份载荷的 `rows[].tolerance` 最大到 **9.6e-6** | 断言清单与它旁边的数字自相矛盾，读者只能拒绝背书 | 三个容差数字都从 `SCENE_RELATIVE_TOLERANCE` / `SCENE_ABSOLUTE_FLOOR` 拼出来（断言里也不抄字面量，而是从常量推） |

两条是同一族（"把会变的事实写成常量" / "判定与报告必须是同一个数"）的第 4、第 5 次现身。

**一条读法（必须随交付说出去）**：这份参数的 6 条 `unresolved` 里最根本的是
"画面里没有任何已知真实长度的物体" ⇒ 所有数值只是**相对于图形总高的比例**，
所以图纸只该核**比例、体量个数、排布**，**不该拿去量绝对米数**。

自检 183 → **188 条断言全部通过**。

## 9.15 为"冷启动"铺路：把要点写进**工具描述**（2026-10-09）

冷启动那一轮（新会话、从零、只贴一张照片）里，模型**唯一必然读到的**东西是**工具描述** ——
它不会去读 `notes/`。所以那次开跑之前，把三件"不写就必然踩"的事写进了 `agh_ortho_fit` 的描述：

1. 进来先按顺序看 `validation`/`revise_hints` → `photo_check` → `anchor`
2. **必须在参数里写下 `photo_check` 区间**（`photo_check.front.w_over_h_min/_max`，相对半宽 ≤30%）——
   不写它就等于这一档没有发生，"像不像照片"会静默退回纯人眼
3. **没有已知长度参照物时必须显式声明 `assumptions: ["proportions_only"]`**（或 `authored_dimensions`），
   不要编一个看起来合理的米数
4. `verdict=fit` 之后**不要直接 apply_ops**：先落候选 `run_id`（带 `-candidate`）→ 人看 `sheet.svg` →
   再 apply_ops → 交付包用**另一个** `run_id`

**同时改掉一句与现状矛盾的话**：`agh_ortho_verify` 的描述里写着"验不了最终尺寸（下游不发布
dimensions）"——**下游 0.1.8 早就发布了**，读回也确实在断言尺寸（§9.14：20 行 `dimensions_delta`
全 0）。这是"把会变的事实写成常量"的第 6 次现身，只是这次它写在**给模型看的文字**里。
两条都加了断言（描述里必须出现冷启动要点；描述不得再说"验不了最终尺寸"）。

## 9.16 冷启动一轮：从零到交付（`kuson`，2026-10-09）

第一次**全新会话、只贴一张照片**跑完 ①→⑥。三件"不写就必然踩"的事**都没踩**，而且 photo_check
**第一次真的抓到了东西**。

**流程**：① 读照片出候选参数（`proportions_only`，无编造的绝对米数）→ ② fit 第 1 轮 `revise`
（**blocking 1**）→ ② fit 第 2 轮 `fit` → ③b 候选包 `kuson-candidate`（10 描述符，`sheet.svg`
是第 1 号，14512 B）→ ④ 起实例 + 8/8 ops → ⑤ 读回 8/8 → ⑥ 交付包 `kuson` → ⑦ 干净关闭
（`elapsedMs 2019`，不是那个竞态）。

**photo_check 的第一次实战收获**：第 1 轮它声明主视图宽高比 `0.33–0.42`，而模型自己算出 `0.296`
⇒ **blocking**。根因不是"读数写错"，是**几何本身错了**：它当时的头只有 0.36（照片约 0.57），
腿又多伸 0.23 挂到地面以下，两个错误正好把比值压到 0.296。修正后声明 `0.53–0.60`、算出 `0.567`、
`inside: true`（相对半宽 0.0619 ≤ 0.3）。**这一档的边界也第一次被实证**：它能抓量级错误，
第 2 轮之后它就**没有分辨力**了 —— 它比对的是"模型自己写的两个数"，不是照片。

**归因纪律的一次真实越界（模型主动交代）**：第 1 轮它做的不是"改一处"，而是**重排了整条竖向标尺**
（同一套像素读数重算 z），`frame` 的修正只是解掉一个独立校验项。所以"fit 通过了"**不能归因到某一步**。

**交付包独立核过**：10 描述符 sha256/bytes 全符；`verify.json` 两档（numeric 残差
`5.551115123125783e-17 ≤ 1e-9` + `scene_readback` 8/8 `match`、`missing`/`mismatched` 空、
`size_asserted: true`、**8 行 `dimensions_delta` 全 0**、逐行容差 2.16e-6…7.96e-6）；
`Camera/Cube/Light` 报成 `extra` 不算失败；`capability_source = tool:agh_blender_ops_catalog`、
`target = agh-blender@live:catalog-v1`、`primitive_gate = not_applied: the target publishes no primitives list`。
与候选对比：`parameters.json` **逐字节相同**、`ops` 数组**逐字节相同**、`sheet.svg` **sha256 相同**
（`0496f803…`）—— 只有 `verify.json` 变大（9699 → 18836 B，多出读回那一档）。候选那份**仍无读回**。

**这一轮暴露的两个真窟窿**：

1. **交付包不含便宜档的结论**：`report.json` / `verify.json` 里都**没有** `anchor` / `photo_check` /
   `parts` / `overlaps` / `placement` 任何一个键。也就是说 `numeric` 档的交付包**落盘的证据只有残差**，
   "验了什么"只存在于对话里；审计者只能自己重跑 fit。（补丁：把这几段的结论摘要写进 `report.json`
   的 `checks` 段 —— **已在 §9.17 修掉**。）
2. **交付包里没有模型本身**：这一轮 8 个网格真实存在于实例里，但 `stop` 之后场景就没了，
   `.blend` 没有落盘。模型文件目前**不在**产物里。（补丁：`save` 的 `scene_file` —— **已在 §9.17 修掉**。）

**关于"能不能看见模型"，我更正自己前面两个判断**（两处都写在会话里过，这里是更正）：
下游**有** `agh_blender_capture`（离屏渲染当前 3D 视图 → 只回报 PNG 的 path/sha256/bytes，
**从不把图片作为内容块返回**，理由是"实测两次"那样会毒化会话）与 `agh_blender_export`
（把场景导出成独立 `.blend`，`destination` 是不存在的路径，**绝不覆盖**）。
所以我之前说的"没有相机 op ⇒ 看不到"只对**图像级自动比对**成立（那一档确实永远做不到）；
**给人看**这条路是通的 —— 而且 `agh_blender_capture` 与 `file.stage_export` / `file.checkpoint`
（写进实例目录、拒绝覆盖）是同一个形状。

**并且这一轮跳过了**：人**没有看图纸**就进了 ④（用户明确选择跳过）。所以这一轮的结论里
**不含任何"像照片"的成分**，只有"自洽 + 下游照做"。这条要如实记着，别把"全绿"读成"像"。

## 9.17 补上 §9.16 的两个窟窿（2026-10-09）

两个都在同一次改动里修掉，各带回归断言（自检 190 → **197**）：

**① `report.json` 现在带 `checks`**：`anchor` / `declared_confidence` / `photo_check` / `overlaps` /
`parts` / `placement` / `generated` 的**结论摘要**，与已有的 `scene_readback` 摘要并列。
在此之前，一个 `numeric` 档的交付包**落盘的证据只有残差** —— "验了什么"只活在对话里。
（实测依据：`kuson` 与 `kuson-candidate` 的 `report.json` 里这三个键一个都没有。）

**② `save` 能登记模型本身**：新可选入参 `scene_file`（下游 `agh_blender_export` 落盘的 `.blend`
的**真实路径**）⇒ 成为第 11 个描述符，`kind: 'scene'`、`mime: 'application/x-blender'`、
**按原始字节**算 sha256/bytes（不是 UTF-8 文本算术 —— 二进制那样算一定是错的），
并且**只登记、不复制**（描述符的 `path` 指向工作区里那个文件，run 目录保持"只由我们写"的形状）。
读不到它时是 `E_SCENE_FILE_UNREADABLE`（blocker）而不是"悄悄没有"：**别把包里的缺席读成"没有模型"**。
`report.json` 另有一项 `scene_file`（`null` = 这一轮没有导出，不是"有但没登记"）。

这一轮同时确认（写进 §8 的命令序列与用户须知）：

- `agh_blender_capture` 渲的是**当前 GL 视口（透视）**，不是正交六视图；工具**从不**把图片放进结果
  —— 这回答了 §10 里那个悬了很久的问题：**工具产出的图片进不了模型，只能进人的眼睛**
  （要让模型看，必须由人把图**贴进对话**）。
- 导出的 `.blend` 里**会带上** `--factory-startup` 的 Cube/Light/Camera（ops 里没有删除指令）。
  这不是缺陷，但打开时会多一个 2×2×2 的方块；要"只有我们那 8 个对象"的干净件，得另跑一批
  `object.delete` + `data.purge_unused`，而那会让"ops.json 描述这个场景"不再成立 —— 未决。

## 9.18 第一个"含模型本身"的交付包（`kuson-scene`）+ `.blend` 不可复现的实测（2026-10-09）

`kuson-scene` 是第一个把 §9.17 那两个补丁用上的包，独立核过：

- **11 个描述符**：7 个 `image`（图纸 + 六视图）→ 3 个 `json` → **1 个 `scene`**（最后一个）；
  sha256/bytes 与磁盘全符。第 11 个：`kind: 'scene'`、`mime: 'application/x-blender'`、
  `path = D:\agnes-harness\outputs\kuson-scene.blend`、`bytes 645556`、
  `meta = {external: true, register_only: true, producer_tool: 'agh_blender_export'}`，
  **文件确实存在且尺寸相符** 且**没有被复制进 run 目录**。
- **`report.json` 的 `checks` 填上了**（§9.16 的窟窿①）：`anchor.present=false / declared_ratios_only=true`、
  `photo_check.rows[0].inside=true`（`computed 0.567`）、`overlaps.significant=[]`、
  `parts = body(2) + clothing(6)`、`placement.on_ground/centred = true/true`、`generated.declared=[]`。
  此后一个包**落盘的证据**不再只有残差。
- 两档校验：numeric `5.55e-17 ≤ 1e-9`；读回 8/8 match、8 行 `dimensions_delta` 全 0。

**`.blend` 不可复现，这是实测**：`kuson.blend`（`516c24e0…`）与 `kuson-scene.blend`（`0be28679…`）
**字节数完全相同（645556）、逐字节比有 7419 字节不同**，首个差异在偏移 20064、最后一个在 454944
（散布全文件，不是尾部一小段）。这就是 Blender 把会话/内存标识写进文件的结果 —— 与"生成网格不可复现"
是同一条道理，只是对象换成了场景文件。后果必须写清楚：

- 描述符里的 sha256 是**这一份文件**的身份，**不是这个场景**的身份；
- **不要**用哈希去判断两次导出"是不是同一份东西"。要判同一性，看 `ops.json` 与读回；
- 对照一下我们**自己**那一侧：`kuson-candidate` / `kuson` / `kuson-scene` 三个 run 的 `sheet.svg`
  **sha256 完全相同**（`0496f803…`）—— 参数→ops→图纸这条路是**可复现**的，
  下游导出**不可复现**。两条路的可复现性不同，**别混**。

**仍未做**：`.blend` 里带着 `--factory-startup` 的 Cube/Light/Camera（Cube 是 2×2×2 带 Material）。
要"只含那 8 个对象"的干净件，需要另加 `object.delete` + `data.purge_unused`，而那会让
"`ops.json` 描述这个场景"不再成立（ops 里会多出删除指令）—— 属于未决，见 §10。

## 9.19 下游把两条请求都收了：能力闸门不再"反着生效"，出厂物件不再进交付件（2026-10-09）

下游侧（另一个会话）一次改动收了 §9.16/§9.18 记着的两条：

**① `catalog()` 发布 `primitives` + `capabilitySet`**（请求 #1）。关键是**它不再编一个标识**：
`CAPABILITY_SET = 'primitives-%d' % len(PRIMITIVE_KINDS)` —— 从**校验 `kind` 的同一个元组**推出来，
所以"发布出去的清单"与"真正会被接受的枚举"**不可能不一致**；并且注释明确"基元种类/op 表/限额变了
就要 bump"。上游只做一件事：**原样透传**，并且优先用下游自报的 `capabilitySet`，缺席才退回
`catalog-v${version}`（少编一个看起来像版本号的标识）。

**闸门方向被翻回来了**（这是 §9.16 记的"恰好是反的"）：

| 来源 | 有 `primitives` | `primitive_gate` |
|---|---|---|
| 活实例的 `catalog()`（改后） | 有 | **applied** |
| 旧下游 / 无实例的快照 | 视情况 | `not_applied`（**如实说"无法判定"，不是假装通过**） |

**而且这次是行为证据，不是断言文字**：`check.mjs` 新增 6 条，其中一条**造了一份"没有 `cone`"的
能力面**，`spire`（cone）确实被拒成 `unlowered`、`reason_code: no_downstream_primitive` ——
闸门要是装的，这条会红。自检 **203 PASS / 0 FAIL**（我自己复跑确认）。

**一个值得单独记的教训**：那条被修掉的旧 fixture **注释写着"下游没有 primitives 列表"、断言
`primitives === null`** —— 也就是说，**测试把 bug 固化成了要求**。fixture 描述的是"当时的下游是
什么样"，而不是"正确的行为是什么"；下游一变，它就替 bug 站台。以后写夹具要写**形状**（"有就透传、
没有就 null"），不要写**当时的值**。

**② `agh_blender_start { empty: true }`**（请求 #5）：bootstrap 启动路径上清场，并在 `scene_summary()`
里**如实上报** `clearedAtStartup`（未请求时是 `null`，不是编一个"已清场"）。它把"场景 = 我们的 ops
建出来的东西"重新变成真的 —— 于是导出的 `.blend` 与 `ops.json` 描述同一件事，不需要上游补一批
`object.delete`（那才会破坏这条等式）。**上游零改动**，只需在 §8 的命令序列里加 `"empty": true`。

**两边源码都变了 ⇒ 两个包都要重装**（`agh-ortho` 已装 `sha256-643b0c43…` ≠ 源码；`agh-blender` 同理）。
装之前，运行中的实例仍加载旧快照 `.runtime-snapshots\sha256-97cee327…`，所以实时目录**还不会**返回
`primitives`、`empty: true` **还不会**清场 —— 这与"源码已改且被测试证明"不矛盾，两者都要说清楚。

## 9.20 第一个"干净"交付件（`kuson-clean`）+ `capture` 的取景问题（2026-10-09）

`empty: true` 在**运行时不**生效了（不是源码级）：`clearedAtStartup = {removed:[Camera,Cube,Light], removedCount:3, objectCount:0, isDirtyAfterClear:false}`，
握手里 `objectCount: 0`，bridge stderr 也写了 `startup scene cleared: removed 3 object(s), 0 left`。

**独立核过**（11 描述符 sha256/bytes 全符；第 11 个 = `scene`，`600662 B`，sha 与磁盘相符）：

| 项 | 值 | 对比之前 |
|---|---|---|
| `objects_in_scene` / `expected` | **8 / 8** | was 11 / 8 |
| `extra_objects` | **`[]`** | was `["Camera","Cube","Light"]` |
| `primitive_gate` | **`applied`** | was `not_applied: ...` |
| `target_capability_set` | **`agh-blender@live:primitives-6`** | was `agh-blender@live:catalog-v1` |
| 读回 | 8/8 match、8 行 delta 全 0、`size_asserted: true` | 同 |
| numeric | `5.55e-17 ≤ 1e-9` | 同 |
| `report.checks` | 7 个键**全填上**（`photo_check.inside=true`、`overlaps=[]`、`parts` 2 类、placement ok） | was 无此段 |
| `.blend` | `600662 B`（**只有那 8 个对象**） | was 645556（含出厂 3 件） |

**`ops.json` 的 sha 变了（`d174e4d0…` vs `004aae74…`），但 `ops` 数组逐字节相同** ——
差的是同层两个字段：`target_capability_set` 与 `primitive_gate`。这正是"能力来源变了"该有的样子：
**数组是可复现的，描述数组来源的那两行如实跟着变**。

### 一个真问题：`capture` 那张图没法用（有图有真相）

空场景之后**没有相机**了，`capture` 渲的是**视口当前视图**，而那张 1600×1200 的 PNG 显示的是
**原点附近的极近景**：一个很粗的圆柱、两个盒子、以及带橙色选中框、位于地面/原点处的那一块
（很可能是 `feet`），**整个人形被裁在画面之外**。它不是"模型效果图"，而是"视口当前状态"。

- **不是**"没灯就发黑"：着色与地面网格正常 —— 这一条排除了我上一轮的担心（视口渲染确实不依赖场景灯光）。
- 文件从 320358 → 123791 B 也与"少了方块和远景构图"一致，但**别把字节数当判据**。
- **今天就能看整个人形**：用 Blender GUI 打开 `outputs/kuson-clean.blend`，按 **`Home`**（Frame All）。
  这是眼下最省事的路径，不需要改任何代码。
- **要自动化出"能看的图"**，得让 `capture` 先取景到场景包围盒（下游加一个 `frame: "all"` 之类的入参，
  渲前 `view_all` 一次）—— 已记进请求清单 §6。这也顺带解决了"复核轮的图必须有统一取景"这件事：
  没有统一取景，两张图之间**没有可比性**，而"可比"才是复核要的东西。

### 追记：我自己解了 PNG 量了一遍（2026-10-09）

下游也量了（自写 zlib 解码），我**独立复现**（`.agnes/work/png-measure.mjs` + `png-hist.mjs`，zlib + 反 filter）：

| 图 | 背景占比 | 模型本体 | 内容（含网格线） | 说明 |
|---|---|---|---|---|
| `kuson-clean`（`empty:true`） | 88.75%（`rgb(63,63,63)`） | **6.5%**（亮度 105–145） | **8.1%** | 与下游报的 8.2% 一致 |
| `kuson`（带出厂 3 件） | 83.5% | 1.6% | 4.7% | 另有一个 **12.9% 的暗色大块**（亮度 64–95，应是那个 2×2×2 方块） |

**而且是两个不同的结论，不是同一个**（我裁了顶部一条 `x600–1020, y0–200` 直接看）：

- 可见部分 **占约 8%** —— 下游的数（对）；
- **上端被画幅裁掉**（那段裁剪里圆柱的竖棱一直顶到 y=0，顶部**没有椭圆口**）—— 我那句"整个人形在画面外"（也对）。

所以"这张图能不能用"**判据要两条一起**：**① 贴边 = 被裁**（`touchesEdges` 必须全 false）、
**② 占比足够**（否则等于没取景）。**只看占比会把"裁掉一半的图"判成合格**。

**一处要修的诊断**：下游写"默认距离约 12 m，对 1 m 级的模型就是极近景" —— 12 m 看 1 m 是**远景**
（所以它才只占 8%），不是极近景；上端被裁说明**视口中心/俯仰不在模型身上**，与距离无关。
它的修法（显式取景）不依赖这个诊断，所以修法仍对，只是记录要准。

**提议（写进请求 §6 的追补）**：让 `capture` 在返回里带上**可测量的取景判据** ——
`bounds` / `touchesEdges` / `coveredFraction`，于是"这张图能用于复核"不再靠眼睛，也才能说
"两次 capture 的取景相同"（同视角 + 同余量 ⇒ 可比）。

## 9.21 网格路第一步：`mesh` 从"硬编码 unsupported"翻成**能力驱动**（2026-10-09）

MESH-PLAN 任务 1.1。自检 203 → **208 全过**；新 integrity `sha256-8ed3741e…`。

**改法（四处判定必须同源，这是关键）**：

1. **op 闸门 ≠ 基元闸门**：新增 `opAvailable(caps, name)`（管"目标 op 表里有没有这张操作"），
   与 `primitiveAvailable`（管 `mesh.primitive_add` 的 kind）分开。保守方向一致：
   **目录里没有 op 表时返回 ok（无法判定，不假装拒绝）**；有表而不含 ⇒ `unlowered / no_downstream_op`。
2. **参数侧与 op 侧用同一个判定**：`kindAvailableFor` 现在对**带点的名字**走 `opAvailable`，
   而 `PARAM_KIND.mesh = 'mesh.import'` ⇒ 闸门拒绝时两边一起少一个，**不会再出现 M2 那种
   "参数侧多一个、op 侧少一个"的假内部不一致**。
3. **纯层只管"声明齐不齐"，有盘的那层管"声明真不真"**：`emit` 阶段不读盘 ⇒ `buildMesh` 只认参数里的
   `path` / `source.up_axis` / `source.unit` / `source.declared_height`，`scale = h / declared_height`；
   缺任何一项都是 **blocker**（`E_ARG_MISSING` / `E_ARG_RANGE`），**绝不静默猜轴向或单位** ——
   猜错会出一个"看起来对、量起来错"的模型，那是静默错误。真伪由 `save` 读盘量（任务 1.2）。
4. **两条几何路径算同一组数**：`mesh.import` 的 args 里带**声明过的意图尺寸** `size`（米），
   `boxesFromOps` 与 `PARAM_SIDE_GEOMETRY.mesh = boxLike` 因此一致 ⇒ numeric 仍对齐（实测残差 0）。
5. **不声称能力**：`three_state.emitter_ready_features` **不再**包含 `mesh`；改为单独一项
   `emitter_ready_when_target_declares: [{feature:'mesh', requires_op:'mesh.import'}]` ——
   "本版已经能 lower"与"目标真的能做"是两件事，混在一张清单里就是谎话。

**这一轮我自己的两个错（都是"靠打印才抓到"）**：改了测试后连撞两次 `Identifier already declared`
（`meshFit`/`fs4` 那类），以及把 fit 载荷的字段写成 `within_tolerance` 而真名是
`residual_within_tolerance` —— **又一次"猜字段名"**（另一个会话刚犯过同一类错：把 `emit_ops` 的
`unlowered` 写成 `three_state.downstream_cannot`）。规矩再确认一次：**断言里不许猜字段名，
先让载荷把真名打出来。**

**对既有行为零影响**：随包快照与实时目录**都没有** `mesh.import`，所以今天任何网格项仍然如实
报 `unsupported / no_downstream_op` —— 这一版只是把"能不能"从硬编码改成**跟着目标目录走**。

## 9.22 网格路收口（`mesh-round-5`，2026-10-09）

**结论：网格路端到端通了**，而且是**磁盘自证**（不是工具返回的转述）：11 个描述符末条是 `kind: "mesh"`
（外部 `.glb`，只登记不复制，1808 B），`report.json` 自己写着 `ok: true` / `blockers: []`，
`mesh_measured` 三条差全 0，两档校验都在（numeric 残差 0 + scene_readback **1/1**），
`ops` = `mesh.import { path, name, upAxis, scale, size }` + `object.transform { name, location }`。

**这一轮由下游会话的独立复现/反例抓出的六个缺陷（全是我的）**：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | `Uint8Array.toString('utf8')` 不存在（继承 `Object.prototype`） | sidecar 永远读不到 ⇒ **第三道闸门从未生效**，且网格路 `save` 必失败 | `Buffer.from(raw).toString('utf8')`；**夹具改成按 seam 的形状存字节**（假 PASS 的根因是夹具不忠实于 seam） |
| 2 | 闸门键在**可选的** `mesh_file` 入参上 | 不传就**静默通过**：声明被读、被记、无人比较 | 键在**项自己的 `path`** 上；`mesh_file` 只决定要不要登记描述符 |
| 3 | `ok` 不含 `blockers` | 带 blocker 的包报 `ok: true` | `ok = blockers.length === 0 && …` |
| 4 | `ok`/`blockers` 不写进 `report.json` | 磁盘副本不完整 ⇒ "产物齐全"会被读成"通过了" | 两者写进报告（报告是权威副本，工具结果可能被替换） |
| 5 | `expectedObjectsFromOps` 只认 `mesh.primitive_add` | 网格对象**进不了期望集** ⇒ 读回 0/0、什么都没证实 | 认 `mesh.import`，并把 `object.transform` 的摆放折进去 |
| 6 | `mesh.import` 里发了 `location` | 导入那刻还没摆放 ⇒ 自检**必然报 false**（噪音不是发现） | 不发 `location`，落点交给 `object.transform`；`boxesFromOps` 也改成从 transform 取摆放 |

**两条流程教训**（都花了真实时间）：

- **安装后必须用 `package status` 核到 `actual=running`**：`reinstall.ps1` 的 `enable` 步被中断时，包停在
  `desired=installed-disabled`，而**新对话里整包工具直接不存在**（症状：工具清单里没有 `agh_ortho_*`）。
- **`edit` 的锚点是子串匹配**：把 `function assembleArtifacts(...)` 当锚点，它其实匹配在 `async function …`
  的尾部 ⇒ 那个 `async` 被留在注释块前变成孤立表达式。`node --check` **不报**（语法合法），运行才炸。

**证据保留**：`photo-round-1b`（被就地改坏、由描述符层抓到 sha256 不符的那一份）**不参与任何清理** ——
它是"产物层能抓到篡改"的唯一实证。保留策略的 `would_prune` 会点名它，**照名单清之前先排除它**。

**销账**：`describe_scene().dimensions` 的语义变化（0.2.0 起 = 世界 AABB）**不需要改期望值算法** ——
`compareScene` 对**带旋转**的对象本来就不做尺寸断言，而无旋转时"世界 AABB"与"局部包围盒 × scale"是同一个数。
欠账关闭，理由在此。

## 9.23 剪影档 + 源图档（2026-10-09 夜，`agh-blender@0.4.0`）

**这一晚补的两档，都是"声明必须可核对"这条主线的延伸。**

### 剪影档（"轮廓像不像"第一次可判）

- 新模块 `silhouette.mjs`（零依赖，只用 `node:zlib`）：解 PNG（手写反 filter 1–5 型）→ 覆盖率 / 包围盒 /
  四边是否贴边 / 宽高比；**只接受带 alpha 的图**，RGB 图**直接拒绝**（猜背景色会静默决定判定结果）。
- 像素↔米**只认** `ortho_scale + sensor_fit + 图像尺寸`；`AUTO` 按**较长边**。
- 容差 = `max(2 像素折算成米, 相对 1%)` —— **判据精度不超过渲染精度**（渲染是采样，1 像素就是它的极限）。
- 接进 `fit`（进 verdict）与 `save`（进 `report.json.checks`）；**读不到图 = blocker**，且**单独列在**
  `silhouette_blockers`（否则"没发生"会在载荷里消失）。
- 下游实测教训**升级成 blocking**：相机偏半格 ⇒ 2.0 m 量成 **1.2 m**（被裁的图给出"看起来合法"的数）
  ⇒ `E_SILHOUETTE_CROPPED`。
- 16 条断言**全部用自造 PNG**（已知面积/包围盒/aspect；两种分辨率在**米**上一致；已知对/已知错各一；
  RGB 图被拒；空图为空；无尺度则无判定）。

### 源图档（"源自这张图"第一次可核）

- 声明了 `source.input_image_sha256` 而**没给 `image_file`** ⇒ **blocking**（没有东西能核的声明就是装饰）；
  给了则按**真实字节**算 sha256 比对，**不符/读不到都 blocking**；源图**登记进包**（只登记不复制）。
- `fit` 把它纳入 verdict（断言写的是**因果**：相符仍是 fit、不符变 revise）；`save` 记进 `checks.image`。

### 这一晚踩的坑（都记着）

| 现象 | 教训 |
|---|---|
| `SILHOUETTE_INPUT` 被 `SAVE_INPUT` 引用却声明在后面 → TDZ | **TDZ 第三次**（前两次 `PHOTO_CHECK` / `MESH_SOURCE`）：schema 常量一律声明在最前 |
| 照抄 `verify` 的写法，在 `fit` 里 `blockers.push(...)` → `ReferenceError` | **`fit` 没有 `blockers` 数组**（结论走 verdict）：别把另一个工具的局部变量当通用件 |
| `const { createHash } = await import('node:crypto')` → 重名 | 文件里已有；**先看已有 import 再加** |
| 夹具的 `photo_check` 写的是 0（别处用例留下的）→ 把"一致"用例挡了 | 断言要对准**本档**，并知道夹具其它字段在说什么 |
| 用 `1e-9` 去比一个 `toFixed(6)` 的报告值 | **"判据精度不能超过输入精度"第 7 次** —— 这次输在自己手里 |

### 快照与下游

`agh.capability.json` 升到 **`agh-blender@0.4.0`**：`capabilitySet` 换新格式
（`primitives-6.ops-16.limits-64-512`，只影响**兜底常量**），op 表加入 `camera.add` / `render.still`，
并记下两条现场事实：**下游把 `sensor_fit` 钉死为 VERTICAL**（⇒ `ortho_scale` 就是画幅世界高度，与本插件
`metresPerPixel = ortho_scale / height` 完全对齐）、**`ortho_scale` 读回是 float32**（对本插件无影响：
只用它推容差、不用它推 aspect —— aspect 与尺度无关）。

提交：`511f5d7b`（剪影档）· `9aa0febb`（裁切 blocking + 快照 0.4.0）· `8fedc041`（源图档）。

## 9.24 A 段（生成段）从零到出网格 + 网格路真实闭环（2026-10-10）

这一天的目标：**把"照片 → 网格"这一段真的跑起来**，然后让真实网格走完网格路。

### A 段环境（Windows 11 / RTX 5060 Laptop 8 GB）

- **装成的**：torch 2.11.0+cu128（`cuda True`、`cc (12,0)`）；CUDA Toolkit 12.8（`nvcc V12.8.61`）；VS 2022 Build Tools（`cl.exe 19.44`）；`nvdiffrast 0.4.0`（**必须 `--no-build-isolation`**，否则构建环境里没有 torch）；`torch-scatter 2.1.2+pt211cu128`（pyg 有预编译轮子）；StdGEN 环境（PyMCubes、LoRA-Torch）+ TripoSR 环境（独立 venv）。
- **权重**：StdGEN 47 个文件 / 20.59 GB。下载的三条经验：① `huggingface_hub` 客户端对 mirror 会报 `missing commit header` ⇒ **改用 curl 直接抓 `/resolve/main/...`**；② 有的文件**只有走代理**才通（`config.yaml`），有的直连就行（`model.ckpt`）⇒ 脚本要"直连失败自动改代理"；③ **0 字节残留必须删掉再重下**，否则尺寸校验会把它当"已下好"。

### StdGEN 在这台机器上跑不动（四个补丁之后仍然）

- 四个上游问题（都已补丁化，见 `patch-stdgen.py`）：`rm_anime_bg` **上游漏发**（PyPI/仓库都没有）→ 容错 stub + 用带 alpha 的图；`xformers` 未装而 `infer_multiview.py` 硬调 `enable_xformers_...` → try/except（xformers 只是加速，两个模型文件里本来就有 `is_xformers_available()` 守卫）；`MVAttnProcessor.__call__` **缺 `cross_domain_attention` 参数**（xformers 版有、非 xformers 版漏了，装了 xformers 的人永远碰不到）→ 补参数（全仓 grep 确认没有调用点传 True）；`main()` 里分辨率是**硬编码 640×1024**，配置文件的 `validation.width_input` **根本没人读** → 做成 CLI 参数。
- **8 GB 装不下**：640×1024 要 ~13 GB，靠 Windows 共享内存硬撑到 OOM（`Tried to allocate 1.95 GiB`；把 `get_attention_scores` 换成融合注意力后 OOM 点后移，但总量仍超）；**384×640 能跑完，但产出是一张全黑图**（`decodePng` 实测：384×640、1 种颜色、全 0）。
- **结论：这台机器不适合 StdGEN**（它是为 ~24 GB 设计的）。要它就得云卡/WSL。

### 改用 TripoSR（本机自足，单网格）

- 权重 `model.ckpt` 1.6 GB、**每张图约 7 秒**（8 GB 完全够）。
- 四个坑：① `torchmcubes` 编译失败（缺 `scikit-build-core`；且 pip 走代理会挂）→ **改用 PyMCubes**（CPU 同算法）+ 补丁；② **`trimesh 4.0.5` 与 numpy 2 不兼容**（`ndarray.ptp()` 在 numpy 2 被删）→ 升级 trimesh；③ `--render`（它自带渲染器）因输出子目录缺失而崩，且**网格还没保存** → 去掉它（我们有自己的 `capture`/`render.still`）；④ 默认路径调 **rembg**，首次要下 u2net（github，不走代理会**静默挂住**）→ 自备"灰底 + 前景占 90%"的图 + `--no-remove-bg`。
- 产物：`ayaka.glb` = 1,022,256 B / **25,534 顶点 / 51,060 面**；世界包围盒 0.9638×0.4159×0.4271（TripoSR 归一化 ⇒ `unit: normalised`）。

### 网格路真实闭环（`mesh-triposr-4`）

| 步 | 结果 |
|---|---|
| `fit` | blockers []、**2 条 op**（`mesh.import`{path,name,upAxis:Z,scale:1,size}+`object.transform`{location[0,0,0.21355]}）、image 档相符、numeric 残差 0 |
| `apply_ops` | 2/2，真网格进场景（导入实测 `[0.963763,0.415857,0.427124]`） |
| `fit{against_scene}` | **1/1 match**、`dimensions_delta 0.000043 < 容差 0.00005`、`scale_asserted:false`（附理由） |
| `save` | **ok:true**、blockers []、**12 个描述符**（源图+sheet+6 视图+3 json+**mesh** 只登记不复制） |
| 磁盘核验 | **12/12 描述符逐字节相符**；`mesh_measured` 两组容差与实测差都印出来 |

**human 那一档的实据**：capture 的渲染"有点泥塑感、线条细节不完善" —— 这是 TripoSR 的真实特征（无贴图、仅顶点色、几何平滑），也印证了"线条要么由上游 `.glb` 内嵌、要么做成几何"这条边界。

### 这一天修的 7 处（都被实测咬出来）

1. `unit` 枚举**对外宽容**：接受 `normalized`/`normalised`/`unitless`（一个拼写不该挡整轮）。
2. **容差按"声明写了几位小数"推**（`declarationRelativeTolerance`）—— **第 8 次**撞"判据精度不能超过输入精度"：4 位小数（0.9638）vs 真值 0.963763 被固定 1e-5 判成不符，连带读回 `ok:false`。
3. **整数写法不当作"舍入过的测量"**：`2` 读成 ±0.5 ⇒ 25% 容差 ⇒ 什么都挡不住（自检一分钟内抓出，并留下"差异不超过声明精度就不是 mismatch"这条断言）。
4. **`E_MESH_MEASUREMENT_BUG`**：我们自己的 bug（ReferenceError/TypeError）不再伪装成"文件读不了"（起因：漏一个 import，8 条断言全变成同一个谜）。
5. **重放必须回报磁盘的结论**：首跑被挡（`ok:false`）→ 补传后走重放 → 工具曾回报 `ok:true` 而磁盘仍写 `ok:false` ⇒ 现在 `ok`/`blockers` 取自磁盘那份报告。
6. **过时文案**：`cannot_assert` 不再说"没有正交/没有场景相机渲染"，改成事实版（能渲、能数值化比对，只有审美留给人）。
7. 断言同步 + 新增："重放回报磁盘结论"、"差异不超声明精度不算 mismatch"。

### 三条流程教训（都咬了两次以上）

- **装完必须核 `actual=running`**：`enable` 那步被中断时，整包工具在新会话里"不存在"（咬了两次，两次都表现为"工具查不到"）。
- **`edit` 的锚点要唯一、且注意单行 import**：`SCENE_RELATIVE_TOLERANCE,` 这种锚点在逗号分隔的单行 import 里匹配不到（我因此漏了 import，8 条断言全红）；`async function` 的锚点是 `function` 子串会把 `async` 留在注释前（第 2 次犯）。
- **改了必须跑**：语法检查过不等于对（括号没配平只会在运行时炸）；catch 里的编程错误会把多条断言变成同一个谜。

## 9.25 网格路 9 轮：五个缺陷 + 一个下游根因 + 两条方法论（2026-10-10 下午）

承接 §9.24：A 段跑通、第一根真网格进场之后，网格路又迭代 9 轮（`mesh-triposr-1` … `-8`），
把"声明 → 事实 → 字段 → 效果"这四层逐个撞了一遍。

### 这一段的五个缺陷（都在**比较**这一层，不在几何）

| 症状 | 根因 | 修法 |
|---|---|---|
| 两条假 blocker（尺寸/高度"不符"）+ 读回 `ok:false` | 声明写 4 位小数（0.9638）而文件真值 0.963763，容差却是固定 1e-5 | 容差按**声明自己写了几位小数**推（`declarationRelativeTolerance`）；**整数写法不算"舍入过的测量"**（把 `2` 读成 ±0.5 ⇒ 25% 容差 ⇒ 什么也挡不住） |
| 8 条断言全变成同一个 `E_MESH_UNMEASURABLE` | 漏一个 import（ReferenceError）被 catch 吞成"文件读不了" | 新增 `E_MESH_MEASUREMENT_BUG`：**我们自己的 bug 必须响亮** |
| 补传参数后重放，工具回报 `ok:true` 而磁盘写着 `ok:false` | 重放分支无条件返回 `ok:true` | 重放的 `ok`/`blockers` **取自磁盘那份报告**（磁盘才是权威） |
| `photo_check` 缺席时抛"expects 0"的 blocker | `Number(null) === 0` —— 中点助手返回 null 被强转成 0 | 库侧 null 守卫 + 调用方不再传中点；**缺席 = "没发生"** |
| `matched 0/1`，唯一差异是 rotation | 读回写死"现场不该有旋转"，而**我们自己发了**一次翻正 | 比对**期望旋转**；且"绕单轴转半圈"只把各轴取反 ⇒ **尺寸断言保留** |
| `rotation_matches_ops:false`（期望 π、实读 3.141593） | 下游发布 6 位小数，我们拿 1e-9 比 | 旋转容差 = **半个末位**（5e-7），并把容差印进行内 |

**其中 1、6 是"判据精度不能超过输入精度"的第 8、9 次**；4 是"缺席不能读成不通过"。

### 一个下游根因：旋转是**惰性**的

他们用 A/B/C/D 四组对照量出来：`mesh.import` 走 glTF 导入器 ⇒ 对象 `rotation_mode='QUATERNION'`
⇒ **Blender 忽略 `rotation_euler`** ⇒ 值被存下、`matrix_world` 不动、四张渲染**像素全等**
（`rotX 90°`「站→躺」也没变 ⇒ 是真 bug，不是对称性）。影响面：**所有 glTF/FBX 导入的网格**，
也就是整条网格路 —— 我们之前那几次"翻正"**从来没生效过**。

**我们这边补的判据**：读回新增 `rotation_mode` / `rotation_effective`（下游发布 mode 才判；
非欧拉模式 + 要求非零旋转 ⇒ mismatch；**没发布就不假装判定**）✓ 已请下游在 `describe_scene`
里发布 `rotationMode`，之后这一类"字段设了、几何没动"会被自动抓住。

### 一条被如实留档的偏差

`mesh-triposr-8`：照片剪影 **0.4000**（`ayaka.png` 301×753 与预处理图 184×460 两处互证）
vs 网格前视 **0.4315** ⇒ 差 **8%**，`E_SILHOUETTE_OFF_PHOTO` 落进包里。
**不改参数**（改 w/h 会与 .glb 实测尺寸冲突，等于把正确模型改坏）；**不放宽区间**；**不抄算出来的值**。
处理方式：**接受为已知偏差并留档** —— 这一档的设计职责是抓量级错误（它抓到过 5.6 倍），
**明确不认证 10% 以内**；8% 大概率来自 TripoSR 的体积化（"泥塑感"），而我的预处理**保持宽高比不变**。

### 两条方法论（都值得单独记）

1. **"零变化"的探针必须有正对照**：`rotX 90°`（站→躺）与 `rotZ 90°`（面内 90°）就是正对照 ——
   没有它们，"什么都没变"只是观察；有了它们，才成为**发现**。
2. **读回字段 ≠ 效果**：同族第 4 层 —— 声明 → 事实 → 字段 → 效果。
   "读回确认 `rotation_euler` 已生效"和"几何真的动了"是两件事。

### 一个绕开下游的解法（当天落地）

**把翻转烘进顶点数据**（`.agnes/work/bake-flip.mjs`：绕文件自身 Y 轴 180°，`(x,y,z)→(−x,y,−z)`）——
选 Y 不选 Z 是因为绕 Z 会 `y→−y`（**左右镜像**，静默的错），而绕 Y 只换"面朝方向"。
核对：尺寸逐项不变、x/z 的 min/max 精确取反、原件留档 `mesh.raw.glb`（sha256 记录在 sidecar）。
⇒ 声明回到正号 `up_axis: "X"`，**不需要任何旋转 op**。

## 9.26 一键生成段（`agh_ortho_mesh_run`）：A 段从"人交一次文件"收进**一次工具调用**（2026-10-10）

§9.24 里 A 段在**插件外**：PowerShell 建环境、下权重、跑生成器，然后"人把文件拷过来"。
本节把它收进 AGH：照片 → 调**外部生成器** → 网格落盘 + sidecar，之后照旧走 `fit`（数值 / 剪影 / 图源）与 `save`。

### 它只做一件新事：产出**可核对的**输入

- 落 `.agnes/agh-ortho/meshes/<name>/{mesh.glb, source.json}`；
- sidecar 里的 `declaredHeight` / `measuredSizeInFile` / `upAxis` / `fileSha256` / `imageSha256` 全部是**实测**
  （`glbWorldBounds` 按真实字节量），**不是**抄生成器的自述；
- 登记与校验**不在这里** —— 仍然是 `fit` + `save`。所以"网格从哪来"与"网格是否可信"依旧是两件事（§9.12 ②）。

### 三条纪律，各有实测来源

① **命令只能来自配置**（`.agnes/agh-ortho/mesh-run.json`）或调用方参数；插件**不内置任何一台机器的路径**。
   缺席 ⇒ `E_MESH_RUN_NOT_CONFIGURED`，并把模板原样打出来（fail-closed，不猜默认值）。
   我们这台是 `D:\cod\TripoSR`，别人的不是；写进插件等于把"一台机器的路径"伪装成"事实"。
② **argv 先过 `tctx.sandbox.confine()`**（与下游拉 Blender 同一条缝）。没有这条缝 ⇒ `E_NO_SANDBOX_SEAM`；
   缝抛错 ⇒ `E_SANDBOX_REFUSED`。不 confine 就是**静默绕过沙箱** —— 而那正是我们在别处一直在防的事。
③ **上轴与单位必须显式声明**（参数或配置）：**不可从文件推断** —— 包围盒对 ± 不敏感，
   "最长轴就是上轴"在本机 TripoSR 上**正好错**（§9.24：声明 Z 翻车三次）。缺 ⇒ `E_ARG_MISSING`。

### 第四条纪律（本轮**补**的）：不许覆盖已存在的网格目录

实现时我漏了这条：`meshes/<name>/` 会被**无条件覆盖**。而本项目已经真实吃过一次"交付包被就地改坏"
（§9.11.2，且**无法精确回退**）；这里更糟 —— 被覆盖的可能是**手工写过的** sidecar
（`meshes/ayaka/source.json` 里记着朝向那三轮的来历、烘焙变换、`mesh.raw.glb` 的 sha256），
本工具写出的 sidecar 会把它**整份换掉**。
⇒ 新增 `E_MESH_TARGET_EXISTS`，判据两条：**拒绝**，且**在起生成器之前拒绝**（断言里同时要求"没有起过子进程"）。
理由是最便宜的那一步必须先挡：一个跑 15 分钟的子进程交付之后才说"我不写"，等于白烧那 15 分钟。

### 第五条纪律（本轮**补**的）：多于一个 `.glb` 时**不许按文件名挑**

原来的取法是 `glbs.sort()` 后取**最后一个** —— 那等于让一个与内容无关的字符串（文件名的字典序）决定
"量的是哪一个"，而 sidecar 随后会把量到的值写成"**这个**网格的声明"。本路**真的会走到这里**：
带后处理的命令（预处理、翻正、减面）通常既留原始件又留成品件；而 `mesh.raw.glb` 这种备份名
按字典序刚好排在 `mesh.glb` **后面** ⇒ 量到的是**原始件**，声明却写着"这个网格"。
⇒ `mesh-run.json` 里可以声明 `output`（路径模板，如 `{out}/final/mesh.glb`）⇒ **只量那一份**；
声明了却找不到 ⇒ `E_MESH_RUN_NO_OUTPUT` 并把它找到的都列出来；
没声明又找到多个 ⇒ `E_MESH_RUN_AMBIGUOUS_OUTPUT`，**拒绝，而不是替它选一个**。

### 本机的一键命令：包装脚本 + 配置（本轮落地并**实测复现**）

`.agnes/agh-ortho/mesh-run.json`（机器本地，插件里没有这些路径）+ `.agnes/work/mesh-run-triposr.ps1`
（三步：预处理 → TripoSR `run.py` → 烘焙翻正；原始件留在 `{out}/gen/0/`，成品落在 `{out}/final/mesh.glb`，
由配置的 `output` 指名 —— 所以"量的是哪一个"是**声明过的**，不是按文件名挑的）。

**实测复现（2026-10-10，输入 `D:\cod\StdGEN\input_cases\ayaka.png`）**：

| 产物 | 本次 sha256 | 与已记录的那份 |
|---|---|---|
| `final/mesh.glb`（烘焙件） | `42b84b83…` | **= 已交付的网格**（§9.24 的 `meshes/ayaka/mesh.glb`） |
| `gen/0/mesh.glb`（原始件） | `38dda93e…` | **= sidecar 记录的 `originalSha256`** |
| `prep/ayaka_prep.png` | `2a3475c8…` | **= `mesh-triposr-9` 里登记的输入图** |

⇒ 整条生成段**逐字节可复现**，耗时约 40 秒（模型加载 4.3 s、推理 2.9 s、提取 2.0 s、烘焙 <1 s）。
这条同时把"照片 → 生成器实际读到的那张"这件事**钉住了**：那一步是确定性的，且产物在盘上。

**一个 PowerShell 坑（值得记）**：包装脚本里一开始写了 `$ErrorActionPreference = 'Stop'`，
而 `run.py` 的进度日志走 **stderr** ⇒ PowerShell 把子进程的 stderr 当**终止性错误**，脚本在
"Initializing model" 处就死了（退出码 1，生成器其实还在正常跑）。改成按**退出码**判断，不再用 `Stop`。

### 失败面（每一类都有码 + 下一步；函数**不抛**）

| 码 | 触发 |
|---|---|
| `E_ARG_RANGE` / `E_ARG_MISSING` | `name` 要变成目录名 ⇒ 字符集受检；`image_file` / `up_axis` / `unit` 缺 |
| `E_NO_FS` | 上下文没有文件缝 |
| `E_IMAGE_FILE_UNREADABLE` | 照片 stat 不到（拿不存在的路径去跑生成器 = 烧几分钟换一条核不了的来历链） |
| `E_MESH_RUN_NOT_CONFIGURED` / `E_MESH_RUN_CONFIG_INVALID` | 没配置 / 配置不是合法 JSON / `command` 不是非空字符串数组 |
| `E_NO_SANDBOX_SEAM` / `E_SANDBOX_REFUSED` | 没有沙箱缝 / 缝拒绝 |
| `E_MESH_RUN_TIMEOUT` / `E_MESH_RUN_FAILED` | 超时被杀（默认 15 min）/ 非零退出（**带日志尾部 8 KB**） |
| `E_MESH_RUN_NO_OUTPUT` | 退出 0 但 `{out}` 下（递归深度 3）没有 `.glb`；**只出 `.obj` 也走这条**，并明说"量不了 OBJ" —— 一份"声明的尺寸没有任何东西量过"的 sidecar，就是一条无法核对的声明 |
| `E_MESH_UNMEASURABLE` / `E_MESH_MEASUREMENT_LIMITED` | 量不出来 / 节点带旋转（轴对齐盒会说谎）⇒ 宁可不写 |
| `E_MESH_RUN_AMBIGUOUS_OUTPUT` | 找到多个 `.glb` 而配置没声明 `output` ⇒ 拒绝，不按文件名替它选 |
| `E_MESH_TARGET_EXISTS` | 目标目录里已经有东西（见上） |
| `E_WRITE_FAILED` | 落盘失败 |

### 自检与状态

`tools/check.mjs` **269 条全过**。其中 mesh_run 10 条：配置缺席拒绝并打模板、名字字符集、无沙箱缝拒绝、
**注入 spawn 的端到端**（`{image}`/`{out}` 替换、递归找产出、按字节量、sidecar 声明 = 实测）、
非零退出带日志且**什么都没写**、覆盖拒绝且**没起子进程**（第四条）、
多产出拒绝且**不按名字挑** + 声明 `output` 时量到的正是**声明的那一份**（第五条）。
`spawnImpl` 是**参数化**的 ⇒ "跑真进程"与"测全流程"是两件事，自检里不起真进程（也不想烧 15 分钟）。
**首次真实会话运行成功了**（2026-10-10 16:29，见下）。

### 首次真实会话运行 + 闸门首次真的拦住了东西（2026-10-10 16:29）

`agh_ortho_mesh_run { name: "police1", image_file: "…police_woman.png" }` 在**会话里**跑通
（命令来自 `.agnes/agh-ortho/mesh-run.json`，sidecar 的 `command` 逐字记下了那条 wrapper）。
四个实测数与**事前独立预测**逐字节一致：

| 量 | 工具写进 sidecar | 事前在草稿目录独立跑一遍 |
|---|---|---|
| `fileSha256` | `0df3b02d…0afc099f` | 同 |
| `fileBytes` | `3154704` | 同 |
| `measuredSizeInFile` | `[0.986693, 0.877974, 0.780104]` | 同 |
| `declaredHeight` | `0.986693`（`declaredHeightKind: measured`） | 同 |

⇒ 生成段在这台机器上**确定性成立**，而且是"工具报的数"与"另一次独立跑出来的数"互证（不是同一条路自证）。

**紧接着第二次调用被 `E_MESH_TARGET_EXISTS` 拒了**（"police1 already holds 2 entries"）——
这条新分支**第一次在真实会话里真的挡下东西**，挡的正是"覆盖手工 sidecar"那一类（§9.11.2）。
同一次拒绝对话里那句"没有配置好生成器命令"是**推测，不成立**：配置被读到并用了（sidecar 的 `command`
就是证据）；被挡的真实原因是目标目录非空，而目标检查排在配置读取**之前**（顺序是故意的：便宜的一步先挡）。

## 9.27 一条穿过所有档位的 1.3 cm：`placement` 的证词比它能证的多（2026-10-10 16:33）

`police1` 这一轮 ②→⑤ 全过：numeric 残差 0、readback 名字/位置/尺寸全对、图像→网格→场景在**字节层面**接上。
但 `mesh.import` 的**回报**里露出了一个我们自己从未量到的量：

| 事实 | 值 | 谁量的 |
|---|---|---|
| 文件空间包围盒中心 | `[-0.012617, 0.010535, -0.001873]` | 我（`.agnes/work/glb-bounds6.mjs`，与 `glbWorldBounds` 同算术） |
| 导入后几何底面 | z = **0.012618**（= h/2 − 文件 x 的 min） | **两处独立算出，完全一致** |
| 我们的 `placement` 档 | `on_ground: true` / `centred: true` | `fit` |

**根因**：`mesh.import` 的摆放是 `object.transform { location: [0, 0, h/2] }` —— 把**文件原点**放到 h/2，
而生成器的文件原点**不是**几何包围盒中心（TripoSR 归一化之后仍偏 1.3 cm）。于是"底面贴 z=0、水平居中"
这条**约定**在**声明层**成立、在**几何层**差了 1.3 cm。

**为什么没有一档拦住它**：`placement` 比的是**我们自己声明的信封**（w/d/h 加我们发的 location）——
那是**自洽性**检查，却被当成几何断言来读（与 §9.11 那次"读回只证下游照做、不证形状"同族）。
**这是同族第二次**："我假设的那个盒子" vs "真实存在的那个盒子"（第一次是 `scale × size` 之于 torus）。

**为什么这不是偏好问题**：这一轮的 1.3% 只是运气 —— 同一个缺陷换一个"内容离原点半米"的网格就是**半米浮空**。
而"碎片几何"不构成反对理由：我们声明的 w/d/h **本来就取自同一个包围盒**，
按它居中**不引入任何新的敏感性**（碎片问题早就在声明尺寸里了）。

**修法（还没动代码：这一轮交付完再改，改代码要重装）**：
1. `boxesFromOps` 对 `mesh.import` 用**文件实测包围盒**（min/max，而不只是 size）当那个盒子；
2. 摆放改成"把**测到的包围盒**底贴 z=0、按它水平居中"，并把**原始偏移**记进报告（不悄悄修掉）；
3. 加断言：内容离原点的网格，`placement` 必须报出 applied_offset（或判 false）；
4. 请下游在 `describe_scene` 里发布**世界包围盒**（现在只有 `dimensions`）—— 否则这一档永远只能自证。

**另外两条警告的裁定**：

- **`seed` 那条的结论是反的**：TripoSR 没有 seed，但我们有**比 seed 更强的证据** —— 同一输入两次独立跑出
  **逐字节相同**的文件（`0df3b02d…`，16:26 草稿一趟 / 16:29 工具一趟）。要消警告不是"编一个 seed"，
  而是声明 `weights`（`…\ckpt-stabilityai-TripoSR\model.ckpt` 1677246742 字节）与"该生成器无 seed"。
- **`conf` 那三条不要靠补一个数消掉**：`w/d/h` 是**测量值**（`declaredHeightKind: measured`），
  给测量值编一个 conf，会让"用 conf 排序猜测"这件事失真。该改的是工具：生成物且与文件实测一致时，
  这三项归为"measured ⇒ conf 不适用"，并把这个措辞写进 warning。

## 9.28 `police1-candidate` 的独立复核：两条真发现（2026-10-10 16:37）

我自己解了盘上的字节（不看转述）：`sheet.svg` sha `f2fd022a…` 对；渲染图用**同一个解码器**独立量出
aspect `0.889151`（正是报告里的数）；`mesh_measured` 最差相对差 4.06e-7、up 轴 9.6e-8、容差 1e-5；
`placement` 报 `on_ground/centred: true`，而**几何**实际在 z `0.012618…0.999310` ——
§9.27 那条被这份报告**再次证实**（它证的是**声明的信封**，不是几何）。

图纸本身（我解 SVG 文本逐格核过）：全图一个比例尺 `117.5644 px/m`；六格排布 **first_angle 正确**
（俯视在**下**、左视在**右**、后视 col 2）；每格 `u/v` 跨度与参数逐项一致
（front `0.878×0.987`、top `0.878×0.780`、left/right `0.780×0.987`、bottom 同 top、back 同 front），
矩形像素尺寸 ÷ 117.5644 也精确对上。

### 发现一：网格路的"图纸"上画的是**盒子**，不是形状

六格里每个对象画的是一个**矩形 + 标签**（`body_mesh` 一个方块）。这对参数化部件是对的（盒子就是形状），
但对**生成网格**它把形状整个丢掉了 —— 于是 §3.16 那句"人看过 `sheet.svg`"对网格路**几乎没有信息量**：
人能判的只剩排布与自洽，**形状复核实质上只能靠 `render.still` 的图**。
⇒ 待做（不在这一轮）：图纸对 `mesh` 部件**从 GLB 顶点投影出轮廓**画上去（顶点就在文件里，沿各视图方向
投影 → 按图纸比例栅格化 → 填充路径）。那才让"人看图纸"对网格路重新有意义。

**另外**：剪影档看不见**朝向**（正面/背面在轮廓上几乎同形），这一档从设计上就不判它（`forwardAxis: null`）
—— 要判朝向得看有明暗/材质的渲染或直接看网格本体。

### 发现二：retention 的清单会删掉**记录里被引用**的 run

工具按 `maxRuns: 20` 列出"该清的 13 个"，名单是 `kuson*` / `photo-round-*` / `m1-probe-1` 等 ——
而那些**正是记录里逐条引用过的轮次**（§9.10–9.20 的原话就靠它们）。保留策略只认"新/旧"，
**不可能知道谁被引用**。⇒ **不要照工具那份清单删**（用会话里给的那份：13 个 diag/mesh-probe/mesh-round）；
并且"引用即钉住"是可实现的（`marker.json` 加 `pinned: true`，或配置里给一份 pinned 清单）。

## 9.29 `police1` 交付包终检（我解盘）+ 两处"认证了却认不出来"的缺口（2026-10-10 16:42）

终检（`audit-run.mjs`：逐字节复算，不看转述）：

- `ok: true`、`blockers: []`、**13 个描述符**（3 个外部：照片 / `mesh.glb` / `police1.blend`）。
- 包内 10 个自有文件的 sha **与磁盘字节逐一相符**（sheet `f2fd022a…`、parameters `06d5c642…`、
  ops `ab851139…`、verify `11957da0…`、六视图各一）；`sheet.svg` 与 candidate 那份**同 sha**（5553 B）
  ⇒ 交付没有偷偷改参数。
- 三个外部产物在盘上都在、sha 对得上：场景 `57985d84…`（10761755 B）、网格 `0df3b02d…`（3154704 B）、
  照片 `0f9e688e…`（240269 B）。

### 缺口一：包**认不出**它认证过的那张渲染图

`checks.silhouette` 的键是 `path / view / declared_ortho_scale / declared_sensor_fit / compared` —— **没有 sha256**。
所以"盘上那张 `outputs/police1-front.png` 是不是当时被量的那一张"，从包里**判不了**。
（下游 `render.still` 其实**返回了** sha256/bytes，是我们这侧没记。）今天能说到的程度：我**重新量了一遍**盘上那张，
aspect `0.889151` 与包里的 measured 值一致 ⇒ **内容一致**，但那是"数值巧合的一致性"，不是**身份**。
⇒ 剪影输入要记 `sha256`/`bytes`（与 `mesh_file`/`image_file` 同一纪律）。

### 缺口二：认证了一张图，却没记下**能再拍出它的位姿**

`render.still` 的回报里没有相机位姿，我们的剪影输入也只记 `ortho_scale` + `sensor_fit` ⇒
那张被认证的渲染图**无法从包里复现**（`ortho_scale` 只定画幅高度，位姿定的是看到什么）。
这一轮现场还多一层：相机后来被手调过（`[3.2068, -8.3898, 0.2274]`），而导出的 `.blend` 是**调过之后**的现场
⇒ 包里的"模型本身"与"被认证的那张图"**不是同一个位姿**。
⇒ 剪影输入加一个可选 `camera: {name, location, rotation_euler}`（相机是我们自己 emit 的，是我们的知识，
不该向外要）；下游那边同时提一条：`render.still` 顺带回报相机位姿。

### 一条对方说对的事（记成规矩）

工具按 `seed` 是否为数字判 `reproducible`；我那句"两次跑出逐字节相同"**只是 note 里的一句话**，
`source.json` 里也没有它的记录 ⇒ **交付包里"网格可复现"这个说法靠的是我，不是包里的证据**。
这与"你声明了什么就要能自证什么"是同一条：**更强的保障如果没有落成证据，就仍然只是声明**。
⇒ 待做：`meshes/<name>/history.json`（每次产出追加 `{producedAt, sha256, bytes, command, image sha}`），
`reproducible: true` 只在**同 sha ≥2 次**时给出 —— 那时它才是**包里的事实**。

## 9.30 交付后的第一批工具侧修正（2026-10-10 晚，自检 277 条全过）

`§9.29` 的两条缺口 + `§9.28` 的 retention 危险，一次改完。**每条都带断言**：

| 改动 | 之前 | 现在 | 断言 |
|---|---|---|---|
| 剪影的**身份** | 只记 `path` ⇒ 认证过的图**认不出来** | `sha256`/`bytes` 声明 + **自己复算比对**；不符 ⇒ `E_SILHOUETTE_IDENTITY_MISMATCH`；没声明 ⇒ `declared_sha256_matches: null`（**不是"通过"**） | 3 条（相符 / 不符 blocking / 未声明为 null） |
| 剪影的**位姿** | 只记 `ortho_scale`/`sensor_fit` ⇒ 那张图**复现不出来** | 可选 `camera: {name, location, rotation_euler}` 原样收进判定载荷 | 1 条（与身份同测） |
| 网格**可复现性** | 只有 note 里的一句声明 | 生成器层面的 `mesh-run/history.json` 每次产出追加一条；`save` 把它**登记成描述符**并给出 `identical_runs`（同一 sha **且**同一张输入照片） | 4 条（第一次=1 / 第二次=2 / 包里算出 2 且登记 / sidecar 的 `fileSha256` 与字节不符 ⇒ `E_MESH_SHA_MISMATCH`） |
| retention 的**"引用即钉住"** | 计划只认新/旧 ⇒ 正好把记录引用过的轮次列进待清 | `.agnes/agh-ortho/retention.json` 里点名的 run **永不进 `would_prune`**；没配置时**如实说明"记录里的轮次不受保护"** | 1 条（点名前后对比） |

**两个设计点值得单记**：

1. **history 不能放在 `meshes/<name>/` 里**：同名重跑会被 §9.26 的闸门拒掉 ⇒ 那份历史**永远长不到第二条**，
   也就永远证明不了"跑出过两次一样的东西"。它记在**生成器层面**（按"同一张照片 + 同一条命令"）。
   ——这是"闸门"与"证据"两条设计第一次互相绊倒，发现方式是**自己推一遍它能不能长到 2**。
2. **`E_MESH_SHA_MISMATCH`**：sidecar 的 `fileSha256` 以前**没有任何一道闸门看过它**（与 `declaredHeight`
   当年那次同族）。现在它与真实字节比一次 —— "文件被换过"必须能被发现。

**仍未做**（`§10` 第 14 条）：`placement` 的**几何口径**（1.3 cm 那条）与"图纸给 mesh 画轮廓"。
前者要动 `boxesFromOps` 的摆放算法（`mesh.import` 用**文件实测包围盒**当那个盒子 + 报出 applied_offset），
后者要给图纸加"顶点投影出轮廓"——两件都值得单独一次重装 + 断言，**不塞进这一批**。

### 落地后的实测（清理时顺手验的）

清掉 13 个之后，盘上剩 **21** 个 —— 正好是 `retention.json` 钉住的全部 21 个（`pinned_not_on_disk: []`）。
拿插件自己的 `listRuns/planRetention` 对**真实目录**跑一遍：策略本身只挑出**一个**候选 ——
`m1-probe-1`，理由是"**beyond the newest 20 runs**"，而它正是 §9.12 引用过的轮次；钉住之后
`would_prune` **为空**。
⇒ `§9.28` 发现二不是理论担忧：**策略唯一想删的那个，恰好就是记录在引用的那个**。

## 9.31 第一次"抠图 → 图纸带轮廓 → 双轴剪影 → 读回"全绿（2026-10-10 19:2x–19:5x）

两轮：`toy1`（**无 alpha + 复杂背景**的玩偶照片）与 `firefly1`（自带 alpha 的插画，490×1024）。
两轮各自走通整条链，而且**第一次**同时具备：`preprocessCommand` 抠图、图纸上的**网格轮廓**（B）、
剪影的**身份 + 位姿**、**多轴**（front + left）像素证据、读回档、以及下面两个新字段。

**实证清单**（都能在盘上复核）：

1. **抠图真的跑了**：`mesh-run/toy1/prep/ims_cut.png`（u2netp，**4.4 MB 权重、离线**）切出玩偶 **20.7%**；
   我**看过那张图** —— 蓝底、蓝圈、台阶都不在了。⇒ "**主体清楚、单一、不贴边的照片**"这一条成立，
   而"任何照片"里的另外三类（前景=背景、多主体、被画幅切断）仍会破功，判据是脚本打印的占比与那张 cut 图。
2. **预处理的 TDZ bug（我的）**：`spawnConfined` 的**形参名** `timeoutMs` 被我抄进了调用处，而它在
   `meshRunFinding` 里不存在 ⇒ 跑到预处理就先 `ReferenceError`，**连第一个子进程都没起**，
   宿主只能报 `outcome unknown after dispatch`，**盘上零痕迹**（连该轮的 run 目录都没建）。
   修法：走**可注入的** `spawnImpl` + 与生成器同一个超时表达式；并加断言把链路钉死
   （`cut.py {image}` → `gen.py {prep}`，且生成器**看不到原图**）。
   **教训**：`outcome unknown` 不等于"还在跑" —— 先去数**盘上有无一阶痕迹**。
3. **双轴剪影**：front 钉 (w,h)、left 钉 (d,h)，`h` 被**两张独立像素图**各观测一次（两次都 1.014844）。
4. **深度的边界（这一轮最重要的结论）**：`left` 那一档**没有任何照片判据**（我们只声明了 `photo_check.front`）。
   `matches_outline` 证的是"渲染像素 vs 参数投影"，**不是"深度 d 是对的"** —— 而深度正是单图重建最不可靠的一维。
   ⇒ **三个轴都自洽、两个轴有像素复核、深度维仍然只是"声明 + 自洽"**，这句话应写进包与结论里。
5. **系统性外扩**：两张都比声明宽 **23 px**（0.0047 / 0.0068 m），与 `alpha>0` 阈值 + 抗锯齿边缘相符，
   落在 `0.010148` 容差内 —— 是**一圈常数**，不是随机误差（`police` 那轮量到的是同一现象）。
6. **重建痕迹**：firefly 的脸整体成了**灰白毛坯** —— 张开的嘴变成凸起、蝴蝶结/长袜图案/手指都没成形。
   归因：**插画输入 + 512 + 薄结构 + 本链不带材质**（`.glb` 0 materials）。**不是尺寸问题，别去调 w/d/h**；
   要更细/带色只能换生成段（更大的模型、带 texture、或多视角输入）。
7. **一份包 vs 多份**：schema 只允许一张剪影 ⇒ 这一轮落了 `toy1-delivery`（无剪影）与
   `toy1-delivery-sil`（有）。**已修**：`silhouettes`（数组），blocker 取并集，单数形式向后兼容。
8. **两个"不许含混"的新字段**：
   - `human_review { performed, declared, note }` —— 不声明就写 `performed: null` + 一句"本包没有说明有没有人看过"；
     "中途不用等我"那种跑法从此**留痕在包里**，而不是消失在对话里。
   - `source.subject`（`cutout` / `whole_frame`）+ 报告里的 `photo_basis` —— 不声明写 **`undeclared`**。
     来历是真实病史：那一轮区间从 0.84（主体）改成 1.78（整幅画面）、**且改在出结果之后**；
     同一张照片两者差 **2.4 倍**（实测 0.755 与 1.78），所以"基准"不写清，区间就没有意义。

**这一批的四条改动**：`preprocessCommand`/`{prep}` 走可注入 spawn（`c0c229e1`）、
`human_review` + `geometry_mapping_note`（`95995b73`）、`photo_basis` + `subject`（`8494ab74`）、
`silhouettes` 数组（`0f00a2e7`）。自检 **289 PASS / 0 FAIL**。

## 9.32 三条下游请求的实测裁决（2026-10-10 19:56）：两减一撤，外加我自己的一个判据错误

**P1（世界包围盒）未做到 —— 仍是唯一挡着的那条。** `agh_blender_scene` / `agh_blender_open` 的对象行只有
`location / scale / dimensions / rotation / vertices / polygons`；`mesh.import` 那个 `bounds` 是**文件空间**的
（在 `object.transform` **之前**）⇒ **世界包围盒无处可读**。同一件东西在两个空间里能差半米
（`firefly1`：import 回报底面 `z=-0.487`，世界几何底面 `z≈0.0002`）。⇒ 那 **1.3 cm 与 20 cm** 的偏差，
**下游读数仍然抓不到**；我们现在的 `geometry_*` 是**自己解 GLB 字节**得来的 —— 是"我们侧的解"，
不是"下游场景的读数"。这正是要修的那条缝。

**P2（渲染位姿）缩小为一句话。** `render.still` 已经有 `camera / location / ortho_scale / sensor_fit`
（`location` 差 5e-7），**只差 `rotation_euler` 不自报** ⇒ 朝向仍在被**抄**（从 `object.look_at` 的回报）。
（请求原文里"把 `sensor_fit` 放进 `camera`"那句是我写得含糊 —— 我们这侧 `sensor_fit` 在顶层，位姿三项在
`camera` 块里，够用。）

**P3（取景 op）撤回。** op 不存在（`E_UNKNOWN_OP`，16 个 op 里没有 `view.*`），**但先决条件成立**：
`capture` 的回报带 `framing.objectsFramed: 1`、`margin: 1.15`、全套 `center/radius/fov` —— **它本来就按对象取景**。
按请求文档开头自己写的"若已取好 ⇒ 这条可以不做"：不必做。

**我自己写错的那条判据（同族第 12 次）。** 我给 P3 定的验收"模型占画幅 **≥60%**"**是错的**：
同一场景同一对象，占**画幅高度**的比例**随画幅长宽比变** —— `1600×1200 → 60.5%`、`700×1000（与主体相称）
→ 41.1%`、`420×1000 → 34%`。⇒ 那个数是一个**没有写明基准的比值**，它测的是**画幅**，不是**对象**。
与这一轮刚给 `photo_check` 补上的 `photo_basis`（主体 vs 整幅画面）**是同一件事**：
**判据必须带着它的基准一起写** —— 否则同一个数字可以被两个基准读成两个结论。

## 10. 未决项


1. ~~在真实会话里跑通 `save` 的 fs 写入~~ —— **已完成**，见 §9.8：真实 seam、checkpoint 快照、
   描述符复核全部通过。审批边界保持 §7.1 的 `always` 不动；TUI 里要用 ↓ 选中"允许一次"再回车。
   （曾被考虑过的选项 B —— 改成 `requiresApproval:'never'` —— 因此不再必要。若将来要做无人流程，
   再回来考虑 `classify` + `policyVersion`，约束 M。）
2. **`enforcement` 口径不一致**（§9.7）：模型运行时上下文说 `unavailable`，工具结果说
   `level:"partial", scope:["file"]`。查清哪个是真的，以及 Windows 上文件策略到底能强制到什么程度。
3. ~~能力协商第 1 级~~ —— **已完成且实测接通**，见 §9.9：`acquisition: tool:agh_blender_ops_catalog`、
   `stale: false`、限额与 op 列表与直接调下游完全一致；深度上限（2）恰好容得下一级嵌套。
   同时修掉了这次实测抓出的"载荷自相矛盾"，并加了回归断言。
4. **工作区热改覆盖层**：`<workspace>/.agnes/agh-ortho/capability.json`。`agh.capability.json`
   在包内 ⇒ 改它要重装 ⇒ §6 承诺的"只更新一张表"被打折。
5. **保留策略执行不了**（§9.5）：工具面没有 `rm`。要么在插件外删，要么给 seam 加一个 rm。
6. ~~`against_blender` 档~~ —— 下游 0.1.8 已给 `describe_scene()` 加 `dimensions`，读回现在**断言尺寸**
   （§9.11.1：20 行 `dimensions_delta` 全 0）。但**真正的 `against_blender`（图像级）仍然没有**：
   下游没有相机 op，而且模型看不见工具产出的图像素 —— 所以这一档的名字只能是 `scene_readback`（半档）。
7. ~~`capabilityHash` 的取法~~ —— 已解决，见 §7。
8. 逐条核对六视图的 u/v 轴向与 GB/T 17451 / ANSI Y14.3（§8.3 的第三条盲区）。
9. ~~M2 的 lowering~~ —— **已完成**（§9.11）：`column` / `sheet` / `ring` / `dome` / `spire` 五件
   都能 lower，`approx` 与 `unsupported` 分开记；M3/M4 才轮到 `roof.gable` / `prism` / `extrude` /
   `opening`（要扩下游）。
10. ~~图纸这一环还没在真实会话里走过~~ —— **2026-10-09 走通了一遍**，见 §9.14：候选（无实例）→
    人看 `sheet.svg` 放行 → ④⑤⑥（有实例）→ ⑦ 干净关闭。仍未验的是"**新会话**里从零跑第一轮"
    （本次是旧会话复用参数），以及 §9.12 ③ 那条"候选与交付必须用两个 `run_id`"的规矩在被违反时
    会不会被看出来（工具会报 `readback_not_recorded:true`，但没人真的踩过一次）。
11. **截图能不能进 AGH 会话**（仍未验，5 分钟实验）：用户**粘贴**=可以；按路径读=未知；
    `computer_use` 截图=未知。它同时卡着参数路与网格路的复核工作流设计（§9.12 ③ 与 StdGEN/CharacterGen 那条路）。
12. **`mesh_run` 已在会话里跑通**（2026-10-10 16:29）：四个数与事前独立预测逐字节一致，紧接着的重复调用被 `E_MESH_TARGET_EXISTS` 拒（新分支首次真实生效，§9.26）。代码 + 10 条断言都在，
    配置（`.agnes/agh-ortho/mesh-run.json`）与本机包装脚本都已落盘，而且**包装脚本单独跑过一次**：
    从原始照片到成品**逐字节复现**了已交付的那根网格（§9.26 的表，约 40 秒）。**经由 AGH 会话调用**这一趟也已完成（16:29）；仍缺的是把 ①→⑦ 整轮走到底
    （`mesh_run` 是 `always` 审批，每次跑都要按一次 y）。
    (a) 一条**已封住但改了语义**的边界：生成器读的**不是** `{image}` 本身，而是它的确定性派生件（预处理），
    所以 sidecar 的 `imageSha256` 现在意味着：**这张照片**，经由**这条声明过的流水线** —— 比"生成器读的就是这个文件"**弱**。
    派生件与原始件都留在 `{out}` 下，可重跑可复核（配置里的 `pipelineDeclares` 写明了这一点），
    所以这是一条**写下来说明的**边界，而不是没记录的缺口。
    (b) **`upAxis` 走声明、不再手工烘焙**：`0.6.0` 起轴纠正会烘进顶点 ⇒ 未烘过的原始件 + `up_axis: "-X"` 也该生效
    —— **未实测**；若失败会表现为"模型躺下"，是人眼可见的失败。
13. **保留策略仍然执行不了**（第 5 条未完）：32 个 run 目录里 **13 个已无人引用**（`agh-ortho/notes`、包内代码、
    工具脚本全都不提它们），按 `maxRuns: 20` 该清 —— 但工具面没有 `rm` ⇒ 由人在插件外删，命令已在会话里给过。
    删完剩 **19** 个，正好落在限额内。保留的 18 个里，`mesh-triposr-2`（尺寸/高度闸门）与 `-3`（图源闸门）
    是两次**闸门真的拦住了**的物证，别跟着删。
14. **图纸对 `mesh` 部件只画盒子**（§9.28 发现一）：于是网格路的"人看图纸"几乎无信息量 ⇒ 待做"从 GLB 顶点
    投影出轮廓画进图纸"。**同上**：报"该清哪些 run"的清单**不能**直接执行 —— 它会删掉 `kuson*` /
    `photo-round-*` / `m1-probe-1` 这些**被记录引用**的轮次 ⇒ "引用即钉住"（`marker.json` 里的 `pinned`）。
15. **`generated_mesh` 的 `missing_for_reproducibility` 口径**：现在的判据要求 `seed` 是**数字**
    （`typeof item.source.seed !== 'number'` ⇒ 记一条）。但前馈生成器**没有** seed，而我们手握更强的证据
    （同一输入两次独立跑出**逐字节相同**的文件）。⇒ 待改：允许"声明该生成器无 seed + 声明 `weights`"算作已交代，
    并把这句写进 warning；**不要**为了消警告编一个 seed。
16. **剪影档要记"身份"与"位姿"**（§9.29 两个缺口）：`sha256`/`bytes`（现在只记 path ⇒ 认证过的图**认不出来**）；
    以及可选 `camera: {name, location, rotation_euler}`（现在只记 `ortho_scale`/`sensor_fit` ⇒ 那张图
    **复现不出来**，而这一轮的 `.blend` 里相机还被手调过，与被认证的那张**不是同一个位姿**）。
17. **"可复现"要从声明变成包里的证据**：`meshes/<name>/history.json` 追加每次产出的
    `{producedAt, sha256, bytes, command, imageSha}`，`reproducible: true` 只在同 sha ≥2 次时给出（§9.29）。


