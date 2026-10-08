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
    extensions/main/index.mjs         tb() + 五个工具
    extensions/main/geometry.mjs      意图 → 几何规则
    extensions/main/views.mjs         正交投影 / 六视图 / SVG / numeric 残差
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
6. **`against_blender` 档**：需要下游给 `describe_scene()` 加 `dimensions`，
   见 `notes/DOWNSTREAM-REQUEST-readback.md`。在那之前只做诚实的 `scene_readback` 半档。
7. ~~`capabilityHash` 的取法~~ —— 已解决，见 §7。
8. 逐条核对六视图的 u/v 轴向与 GB/T 17451 / ANSI Y14.3（§8.3 的第三条盲区）。
9. M2 的 lowering：`column` / `sheet` / `ring` / `dome` / `spire`；
   M3/M4 才轮到 `roof.gable` / `prism` / `extrude` / `opening`（要扩下游）。


