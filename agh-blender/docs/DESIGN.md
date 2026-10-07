# AGH ↔ Blender 工作台 · 设计与实现规范

| 项 | 值 |
|---|---|
| 文档状态 | **权威（single source of truth）** |
| 建立时间 | 2026-10-05 |
| 依据 | 外部设计文档《AGH Blender 插件包：详细设计与逐步实施指南》**v1.1** + 本机 P0 实测 |
| 证据台账 | 同目录 `P0-EVIDENCE.md`（P0-F1 ~ P0-F71，含原始命令与原始输出） |
| 物理位置 | `D:\agnes-harness\.agnes\work\blender-workbench-spec\`（工作区受管目录；发布插件时整体迁到插件仓库的 `docs/`） |
| 变更记录 | 文末 §11 |

**读法约定**：正文里每条约束都标了来源。

- `v1.1` = 外部设计文档的要求
- `P0 实测` = 本机实测后新增或修正的要求（**与 v1.1 冲突时以实测为准**，并在 §10 记录理由）

---

## 1. 目标与非目标

### 1.1 目标（必须做到）

1. 用户在自己的 AGH 里**一句话** → Blender **自动打开** → 分步建模 → 用户**在自己的视口里实时看到**生成过程。
2. 别人拿到我们的 GitHub 仓库后，**能直接操控本机 Blender 生成三维模型**。
3. Blender 侧**零安装**：不要求对方装任何 Blender 扩展。

**范围上必须先说清的两件事（2026-10-05 确认）**

4. **入口是"人给的图"，而且模型确实能看见它**（2026-10-05 实测，P0-F133~F135）：用户上传的截图/照片走 `user/message` 的 inline image block 直接进模型，**不经过** artifact/媒体面那条路。因此 2D→3D 里"图 → 参数"这一环**可以交给模型**；"人在环"降级为可选（当模型看图不可靠或需要人工判断时才用）。仍不成立的是"插件生成的图 → 模型"（见 §1.3 架构边界）。
5. **目标收窄为参数化低模**：可达范围是卡通/人形角色的**参数化低模 + 风格化**；**写实还原不承诺**。并且**多视角参考图需要外部 diffusion 模型**，属插件范围之外，不在目标里承诺。

### 1.2 非目标（明确不做）

| 非目标 | 理由 |
|---|---|
| 任意 Python 执行端点 | v1.1：只走结构化 opcode 白名单。`run_python` 是 v0 的错路，已废弃 |
| 依赖 `blender-mcp` / Blender AI Agent 作为运行时 | 只能借鉴其工程模式（MIT），不能当接入载体 |
| 让用户手动装扩展来接入 | v1.1 的 `--python bootstrap.py` 已证明可以零安装 |
| 写用户偏好、改用户启动文件 | 见 §3.1 |
| 声称"有沙箱隔离" | 本机实测只有 `partial/file`，见 §3.2 / §8 |

---

### 1.3 终局目标与可达性判断（2026-10-05，用户明确）

**终局目标**：用户随手给一张动漫人物 / 照片 → 插件自动生成**多视角参考图** → **分析指标参数** → 调用 Blender 造出 3D 模型（2D→3D）。

**判断：当前成果不能实现；缺的正是链条的前三段。** 已有的 P0-1~P0-4 全部落在"最后一公里"（AGH 能可靠驱动本机 Blender），而不是"图 → 三维"。

| 段 | 现状 | 结论 |
|---|---|---|
| (A) 多视角参考图 | 需要多视角 diffusion（Zero123 / MVDream 类）。`/capture` 只是**截 Blender 视口**，它不生成新视角 | 缺，且**非脚本可补** |
| (B) 分析指标参数 | 需要 vision 模型 + 结构化输出。**部分已澄清**：主模型侧**声明**了图片输入能力（本会话 `computer_use` 被提供，按 `inference.ts:481-486` + `model-tools.ts:31-33` 这蕴含 `mainModelInput` 含 `image`）；但**本机从未观测到图片进模型**（零次尝试，见 §L / P0-F118），且唯一会被登记归属的图片通道 `computer_use` 在本会话**完全不可用**（见 §L / P0-F120） | 缺，**仍未验证**（不是「不可行」）；取证形态须改（见 §L.4），且需先修复通道
| (C) Blender 建模 | 结构化 opcode 白名单**尚未实现**；单图重建本身是开放问题 | 参数化低模**可达**；写实还原**不可达** |

**已确认的架构边界（它决定后面一切路线）**

- 模型**能**看**用户上传**的图 —— 走 `user/message` 的 inline image block（**2026-10-05 实测成立**，见 §N / P0-F133~F135）。此前"从未观测到"的结论是**版本落后**造成的：旧 HEAD `c1180fc0` 确实没有附件功能，更新到 `7819b23c` 后可用。
- 模型**看不见插件生成的图** —— 媒体面只接受
  `origin === 'tool:computer_use'` **且** `trust === 'untrusted'`（`packages/daemon/src/supervisor/artifact-authority-projection.ts:128` 的 `mediaRoots()`），
  而第三方工具行的 `origin` 由 core 写死为 `` `tool:${call.name}` ``（`packages/core/src/step/tools.ts:1228`）。
- ⇒ **"插件生成图 → 模型看图"在本机不成立**，且不是"还没找到方法"，是设计闭合。必须改为**人在环**或**客户端面板**。

**近期三步（下一步计划）**

1. **验证 vision 是否真通**（最高优先，成本 1 次实验）。在会话里上传一张人物图片，要求输出**结构化比例参数**（头身比 / 肩宽比 / 姿态 / 主色）。
   通 ⇒ (B) 成立，路线为"人上传图 → 模型读图出参数 → 参数化低模 → 分步建模"；不通 ⇒ 全链改成"人看图、人给参数"。
2. **定分支 B 的落点**：多视角图与视口截图的受众改为**人**（客户端面板读受管理缓存），并入 UI 阶段；**不再尝试投递给模型**。
3. **P0-5 实际文件链**照原计划推进（checkpoint `copy=True/relative_remap=True` + 新 UUID 目标经真实 `tctx.fs.write`）。

---

## 2. 本机事实（已核实）

| 项 | 值 |
|---|---|
| Blender | **5.2.2 LTS**，build hash `d13f752e3b9c`（2026-09-15 构建）；`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`（约 113 MB） |
| Blender 内建 Python | 3.11（含 `http.server`、`zlib`、`struct`，够用，不需要 Pillow） |
| AGH 仓库 | `D:\agnes-harness`，HEAD `c1180fc0d1a7b54b7a624dee276c8b7c3a9f937f` |
| Node | 24.21.0（`C:\Program Files\nodejs\node.exe`） |
| CLI | `packages/cli/dist/local-dev-20261005-082718963/agnes.mjs`（子命令名是 `agh`） |
| profile / preset | `local-dev` / `standard-windows`（继承 `standard`） |
| 沙箱默认 | `{ level: L0, required: false, on_unavailable: allow }` |
| 超时默认 | `tools.timeout_ms = 120000`（工具实际看到 **118000**）；`approval.timeout_ms = 60000` |
| 主实例 | 端口 4180，数据目录 `%USERPROFILE%\.agh\data` |
| P0 实例 | 端口 4181，数据目录 `D:\agh-p0-home`（靠环境变量 `AGH_HOME` 隔离） |
| 用户偏好文件 | `%APPDATA%\Blender Foundation\Blender\5.2\config\userpref.blend`（**不许被写**） |

---

## 3. 硬约束（规范正文）

### 3.1 进程与启动

**唯一允许的启动 argv**（`v1.1`，十条，顺序固定）：

```
<blender.exe> --factory-startup --disable-autoexec --python-exit-code 1 \
    --python <bootstrap.py> -- --agh-bridge-config <instanceDir>/bootstrap.json
```

| 约束 | 来源 | 说明 |
|---|---|---|
| 必须用 `--factory-startup` | v1.1 | 不读用户偏好、不读用户启动文件 |
| **禁止调用 `wm.save_userpref()`** | P0 实测 | `--factory-startup` 下偏好只在内存里，一旦保存就会把**出厂设置**写进用户配置。这是不可逆破坏 |
| 必须用 `--disable-autoexec` | v1.1 | 不执行 .blend 内嵌脚本 |
| 必须用 `--python-exit-code 1` | P0 实测 | bootstrap 抛异常 ⇒ Blender 带非零码退出（fail closed），不留"窗口开着但没桥"的假成功。已实测生效 |
| 启动画面只在**会话内**关：`bpy.context.preferences.view.show_splash = False` | P0 实测 | 不持久化 |
| `spawn` 必须 `shell:false`、`windowsHide:true`、`detached:true` + `unref()` | P0 实测 | 用户关掉 AGH 不该带走 Blender |
| Blender 版本门槛 ≥ 4.2 | v1.1 | 4.2 起才是新扩展体系；实测要求主要版本/次版本 |

### 3.2 授权与沙箱

| 约束 | 来源 | 说明 |
|---|---|---|
| **必须** `await tctx.sandbox.confine(rawArgv)`，并用**返回的 argv** 去 spawn | v1.1 | `confine` 是工具唯一可用的沙箱开口 |
| 必须如实上报 `enforcement()` | v1.1 | 本机实测 `{"level":"partial","scope":["file"]}` |
| `enforcement.level === 'partial'` **不是失败**，假装它是 `full` 才是失败 | P0 实测 | 见 §8 |
| 危险动作走审批门：`requiresApproval: 'always'` | v1.1 | 实测审批支持 `allowed-once / allowed-session / allowed-permanent / rejected` |
| 授权决定只属于后端 | v1.1 | 客户端只渲染、只请求 |

### 3.3 工具返回值（三条铁律）

> 这三条是 P0 实测最贵的教训，**优先级高于任何"代码好看"的考虑**。

| 约束 | 来源 | 说明 |
|---|---|---|
| **① 返回值先过 `JSON.parse(JSON.stringify(x))`** | P0 实测 | kernel 的 `isJsonValue`（`packages/core/src/effects/tool-dispatch.ts`）不认 `undefined`、不认 `NaN`/`Infinity`、不认非普通对象。`isReadOnly:false` 的工具一旦返回非法 `ToolResult`，整个结果被结算成 `TOOL_OUTCOME_UNKNOWN`，**工具侧不抛异常、日志里也没有**。实测吞掉过一次完整的成功结果 |
| **② 副作用型工具的执行报告必须先落盘再返回** | P0 实测 | 返回值只是副本；磁盘上的 `<instanceDir>/start-report.json` 才是结果的可信来源 |
| **③ 结果的取证来源 = 磁盘报告 + `/health` 自查** | P0 实测 | 不要依赖模型上下文里那段 JSON |

补充：`content` 只放 `{type:'text',text}`；token 明文**永不**出现在返回值、磁盘或会话里，只留 `sha256` 前 16 位指纹。

### 3.4 目录与所有权

```
<workspace>/.agh-blender/
  marker.json                     归属校验（schema/workspaceRoot/owner/createdAt）
  instances/<UUID>/
    bootstrap.json                传给 Blender 的唯一配置（含 port、instanceDir）
    port.json                     真实端口 + pid（原子写；原子替换）
    instance.json                 无 token 的实例档案
    start-report.json             启动链的完整报告（先落盘再返回）
    bridge.stdout.log / bridge.stderr.log
```

| 约束 | 来源 |
|---|---|
| 目录必须落在工作区内，且加进 `.gitignore` | P0 实测 |
| 所有 JSON 用「临时文件 + `os.replace`/`renameSync`」原子写 | v1.1 |
| `marker.json` 缺失时先建；`owner` 字段写明归属 | v1.1 |
| 一个工作区同一时刻至多一个受管理实例；记录按工作区 Key 索引 | v1.1 |

### 3.5 Bridge（Blender 侧）协议

| 约束 | 来源 | 说明 |
|---|---|---|
| 只绑 `127.0.0.1`，端口由 Node 侧 `pickFreePort()` 选定；被占则回退临时端口并如实写进 `port.json` | v1.1 | 实测两处端口都用了 |
| token **只**从环境变量 `AGH_BLENDER_BRIDGE_TOKEN` 读 | v1.1 | 配置文件里没有 token |
| 用 `secrets.compare_digest` 比较 | P0 实测 | 定时攻击面 |
| 状态读取**全部**在 Blender 主线程 | v1.1 | HTTP 线程只入队；`bpy.app.timers` 泵主线程。实测 `/hello` 报 `executedOnMainThread:true` |
| `GET /health` 免鉴权，但**只**回无敏感信息 | P0 实测 | 用于发现/存活探测与残留判定；回 `authRequired:true` |
| 其余端点（`/hello`、`/shutdown`）必须带 `X-AGH-Token`，否则 401 | P0 实测 |
| **不提供**任何执行任意 Python 的端点 | v1.1 |
| 配置里的 JSON 读取要容 BOM（`utf-8-sig`） | P0 实测 | PowerShell 写的 JSON 带 BOM，曾直接把桥打挂 |

### 3.6 文件与导出

| 约束 | 来源 |
|---|---|
| checkpoint 用 `save_as_mainfile(copy=True, relative_remap=True, compress=False)` | v1.1（本机只读复核已确认） |
| `relative_remap=False` 会让相对贴图解析到副本旁目录（已复现反例） | P0 实测 |
| 只保留 `export_copy`：导出目标是**全新 UUID**，经 `tctx.fs.write` 写，**无 overwrite**、≤64 MiB | v1.1 |
| `bpy.data.is_dirty` **不可独依**：保存后改 location/scale/mesh 名、甚至 `primitive_cube_add` 之后它仍可能为 `False` ⇒ 脏标记必须插件自持 | P0 实测 |
| 相对依赖跨目录导出要**明确拒绝**，不要静默重写 | v1.1 |

### 3.7 图片链

| 约束 | 来源 |
|---|---|
| 一次 GPU 颜色管理 + 标准库 PNG（`zlib` + `struct`，scanline filter=0） | v1.1；本机已验证自写编码器能被 Blender 正常载入 |
| 不用 Pillow、不用 `save_render` | v1.1 |
| 缓存落在 Node 私有目录，不进用户目录 | v1.1 |
| **经 tool artifact 的图片：只有 `tool:computer_use`/`untrusted` 这条截图通道会被登记归属** | P0 实测 | 归属登记由 daemon 从 ledger 事件推导（`artifact-authority-projection.ts:107-143`），要求 `origin === 'tool:computer_use'` **且** `trust === 'untrusted'`（另加 `isError:false` 与块形状）。工具行的 `origin` 是 `` `tool:${call.name}` ``、`trust` 由 `isOpenWorld` 决定 ⇒ 别的工具名/信任级拿不到该通道，`put` 成功也读不回。见 `P0-EVIDENCE.md` §K.5；**已活体取证**（§K.6 / P0-F103~F105）：真实会话 `1451df13-…` 的 `tool/result` 行实测 `origin=tool:agh_blender_capture` / `trust=trusted`，而行级谓词的两个条件正是**这两条**，块级条件反而全部满足 |
| **行级两条条件**：`origin === 'tool:computer_use'` **且** `trust === 'untrusted'` | **P0 实测（P0-F97/F98 源码 + P0-F103/F105 活体；2026-10-05 收尾独立复核）** | 归属登记的判定谓词 `mediaRoots` **逐条判定**这两条（`packages/daemon/src/supervisor/artifact-authority-projection.ts:128`）。**判定者是 daemon 侧的投影器**（`WorkerRegistry → artifact-authority-projection.observe()`），**不是工具**：工具只能声明 `isOpenWorld`（决定 `trust`，`packages/core/src/step/tools.ts:1227`）与工具名（决定 `origin`，同文件 `:1228`），**改不了写出的 `origin`，也没有登记入口**（`ToolContext.artifacts` 只有 `put/get/submitJob/poll/cancel`，`packages/extension-api/src/tool.ts:214-222`）⇒ **工具侧无法补齐，分支 A 关闭**。可重跑核对：本目录 `p0-4-row-conditions.check.cjs`（读 ledger 逐条件求值，exit 0 = 与结论一致） |
| 因此插件截图投递**落分支 B：另定投递落点**（v1.1 的代称是 Host `fs.write` + 资源登记） | P0 实测；**2026-10-05 收尾复核：该机制的具体接口尚未找到** | §K.4/K.5：没有"工具侧可用、且带登记"的 put 路径 ⇒ 落分支 B。但收尾复核**未找到**"资源登记"面向工具/插件的接口：`ToolContext` 的完整能力面是 `fs/net/sandbox/platform/authorize/tools/artifacts/subagent`（`packages/extension-api/src/tool.ts:190-234`），其中**没有**任何"把资源登记进会话可见面"的方法；登记的唯一出口是 daemon 侧从 ledger 事件投影。⇒ 分支 B 的**落点与触发器仍是开放设计项**，定义清楚之前**不得写成"已有机制"**。见 §K.7 |
| **图片要"能被读"必须完成归属登记**（登记是 daemon 侧动作），且**只有 `tool:computer_use`/`untrusted` 一种行形状会被登记** | **P0 实测（P0-F85~F91，收口于 §K.5；行级两条件见上一行）** | 只调 `artifacts.put` 写字节不够：字节存储与归属索引是两套（`PersistentArtifactReadAuthorityIndex` / `ArtifactAuthorityProjectionWriter`），缺登记则请求媒体面按 `sessionKey`/`ownerId` 校验时拒读。§K.5 已查明**工具侧无法自我登记** ⇒ 本约束并入上面两条，不单列新机制 |

### 3.8 打包、安装与分发

| 约束 | 来源 | 说明 |
|---|---|---|
| 包形状：`agnes.plugins[]`（export/id/runtime/inject）+ 可选 `agnes.clientDescriptors[]` | v1.1 / P0 实测 | 客户端描述符走 `workbench.panel` 时必须带 `slotCatalogVersion` |
| 更新一个已安装的包必须走 **`disable → remove → install → trust → enable`** | P0 实测 | 对已安装的包直接 `install` 会 `E_PACKAGE_STATE`；`install` 是"新装"语义 |
| 非 TTY 下 CLI **拒绝**安装（INV-33：未应答≠同意） | P0 实测 | 所以安装这一步必须由人在终端里按 `y` |
| **改源目录不生效**：包被复制到 `<home>/data/profiles/<profile>/packages/<name>/`，运行时从内容寻址快照 `.runtime-snapshots/sha256-<hash>/` 加载 | P0 实测 | 每次改代码都要重装 |
| `integrity` 变了就必须重新 `trust`；`capabilityHash` **不覆盖 `registerTool`** | P0 实测 | 见 §8 缺口 |
| **`package.json` 的 `license` 必须落在 8 项白名单内**，否则**永远 trust 不过** | **P0 实测（P0-F143~F146）** | `LICENSE_ALLOWLIST` = MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / 0BSD / MPL-2.0 / Unlicense（`trust-gate.ts:9-18`），**不含任何 GPL 变体**。闸门 **第一处**就是 license，且在**同一次** `trust` 里对包级 `license` 与每个 `extension` 清单各跑一遍。**`workspace:` 部署通道也挡不住**（`trustWorkspace` 内部同样调 `runTrustGate`）⇒ 含 GPL 的代码要进 AGH，必须走"重许可"而非"换装法" |
| 该错误对外**一律只显示 `E_PACKAGE_TRUST` + `blockers: []`** | P0 实测（P0-F143） | `E_WORKSPACE_UNTRUSTED` 与 `E_PACKAGE_QUARANTINED` **共用同一个对外码**（`errors.ts:5-12`）；且两者都写 `detail.reason` 而不写 `detail.blockers`，而对外错误只从 `detail.blockers` 取 ⇒ **"没有理由"是换算丢的，不是策略不给**。定位必须回到源码/legacy code，不能靠 CLI 输出 |
| **"去掉 `license` 字段"也不能绕过** | P0 实测（P0-F147） | 缺字段（`undefined`）与显式 `"UNLICENSED"` **同样被拒**（预览层会把缺失折成 `UNLICENSED`，`inspect.ts:285`，而它也不在白名单）⇒ **没有"声明豁免"这条路** |
| **"拆许可"（Node 侧 MIT / Blender 侧 GPL）也绕不开** | P0 实测（P0-F148） | `runTrustGate` 的入参无白名单覆盖项，`LICENSE_ALLOWLIST` 是模块级 `const`；而 root `package.json` 只有**一个** `license` 字段，`"MIT AND GPL-3.0-or-later"` 这类组合式**也不在白名单里** |
| **本包实际采用：根 `Apache-2.0` + `extensions/main/bridge/` 声明 `GPL-3.0-or-later`** | **P0 实测（P0-F149/F150）+ 用户 2026-10-05 决定** | Blender 侧三个 `.py` **都 import 并实际调用 `bpy`**（证明见下表）；Blender 官方许可页原话：*"The GNU GPL license therefore requires that such scripts (if published) are being shared under a GPL compliant license."* ⇒ bridge 归 GPL。Node 侧（`index.mjs` / `client/index.js`）**零** `bpy` 引用，可 Apache-2.0。**这是"两套声明"而不是"两个 `license` 字段"**：闸门只读根字段，所以根必须写白名单内的值，GPL 那份靠 `NOTICE` + `LICENSE-GPL` 说清 |

**逐文件核实：`bridge/` 确实需要 GPL（P0-F149，2026-10-05）**

方法：对包内全部 `.py`/`.mjs`/`.js` 统计 `\bbpy\.` 实际引用数，并逐行看 import 与其在代码中的位置。

| 文件 | 行数 | `bpy.` 实际引用 | 是否 import `bpy` | 判定 |
|---|---|---|---|---|
| `extensions/main/bridge/bootstrap.py` | 420 | **17** | 是，`L31`（带 `try/except ImportError`：仅在 Blender 外跑时才走异常） | **需要 GPL** |
| `extensions/main/bridge/agh_ops.py` | 634 | **42** | 是，`L16` | **需要 GPL** |
| `extensions/main/bridge/agh_capture.py` | 187 | **3** | 是，`L19`（另有 `L22: import gpu`） | **需要 GPL** |
| `extensions/main/index.mjs` | 1133 | **0** | 否（仅 `node:*` 与宿主包） | 不需要，可 Apache-2.0 |
| `extensions/main/client/index.js` | 60 | **0** | 否（仅 `react`） | 不需要，可 Apache-2.0 |

**`bootstrap.py` 的 `bpy` 调用是实际行为，不是注释**（这是上一轮我用"顶层 import 行"漏判的，已纠正）：

| 位置 | 调用 |
|---|---|
| `bootstrap.py:111` | `bpy.context.preferences.view`（会话内关启动画面） |
| `bootstrap.py:122` | `bpy.context.scene` |
| `bootstrap.py:128-135` | `bpy.app.version_string` / `binary_path` / `factory_startup` / `background`、`bpy.data.filepath` / `is_dirty` / `scenes` |
| `bootstrap.py:177` | `bpy.ops.wm.quit_blender()` |
| `bootstrap.py:254` / `:396` | `bpy.app.timers.register(...)`（退出计时器与主线程泵） |
| `bootstrap.py:327` | `bpy.ops.ed.undo_push(...)` |
| `bootstrap.py:340` | `bpy.context.view_layer.update()` |

**同时审计了"有无第三方 GPL 派生"**（P0-F149）：三个 `.py` 除标准库（+ `gpu`）外**只** import `bpy`，
未出现 `blender-mcp` / BlenderKit 等第三方项目名，也未出现 `adapted from` / `based on` 一类来源注释
（唯一的 `derived` 命中是 `bootstrap.py:322` 的普通英文用词 *"targets are derived from it"*）。
⚠ **`import` 扫描只能证明"没有直接依赖"，不能证明"没有行级抄录"** —— 后者需人工比对，本规范不声称已排除。

**来源**（2026-10-05 抓取）：<https://www.blender.org/about/license/> ——
*"Blender's Python API is an integral part of the software... The GNU GPL license therefore requires that such scripts (if published) are being shared under a GPL compliant license."*

---

### 3.10 许可与声明（"两套声明"的形状）

| 位置 | 内容 | 依据 |
|---|---|---|
| `package.json` → `"license"` | **`"Apache-2.0"`**（必须落在白名单内，否则 `trust` 不过） | P0-F143；用户 2026-10-05 决定 |
| `LICENSE` | Apache-2.0 全文（根） | 同上 |
| `LICENSE-GPL` | GPL-3.0 全文（供 `bridge/` 使用） | 同上 |
| `NOTICE` | 明确写出：**`extensions/main/bridge/` 下的三个 `.py` 为 `GPL-3.0-or-later`**，因为它们是 Blender 的 Python API（`bpy`）脚本；其余部分 Apache-2.0 | 同上 |
| `extensions/main/bridge/HEADER.txt` | 同一句话的**机器可读副本**，随文件一起分发 | 同上 |
| `README.md` 的 License 段 | 向使用者说明：**包级 SPDX 是 Apache-2.0，但 bridge 子目录是 GPL-3.0-or-later**；不改写、不模糊 | 同上 |

**为什么不写 `"Apache-2.0 AND GPL-3.0-or-later"`**：那是**没有** SPDX `AND` 双许可的准确写法，而且**不在白名单里** ⇒ 一样 trust 不过（P0-F148）。

**许可决定已由用户明确确认**（2026-10-05，原话）：

> 我确认 `agh-blender` 采用 Apache-2.0（根）+ GPL-3.0-or-later（`extensions/main/bridge/`），这是我的决定。

⇒ 该声明是**作者的决定**，不是文档代做。连带承诺：再分发时必须**同时**保留 `LICENSE` 与 `LICENSE-GPL` 并保持目录拆分；
且本项目**未做法律审查**，`import` 扫描不能证明 bridge 里不存在行级抄录——若将来发现，这份声明要重新复核。

---

### 3.11 孤儿实例的优雅停止（token 已丢时）

**背景**（§9.y）：token 只在 daemon 进程内存里（刻意不落盘），所以插件重载后，内存里的 `{token, port, pid}` 句柄一起没。
**但实例进程还活着** ⇒ 变成"在跑但失联的孤儿"。此前只能硬杀 —— 而硬杀会丢掉用户未保存的工作。

**做法**：`agh_blender_stop` 在"内存里没有句柄"时，回退到一条**不依赖 token** 的路径：读磁盘 `instance.json` → 校验身份 → 请求关窗。

| 约束 | 来源 | 说明 |
|---|---|---|
| 关闭请求走 **OS 级窗口消息**，而不是桥的 `/shutdown` | P0 实测（设计） | 桥的路由需要 token；失联时那条路必然死。`CloseMainWindow()` 不需要 token |
| **必须先校验进程身份**，仅 `pid` 不够 | P0 实测（设计） | Windows **会复用 pid** ⇒ "pid 1234 活着"可能是另一个进程。`instance.json` 额外记录 `processIdentity = {imageName, ticks}`（创建时间，Windows FILETIME ticks）；发关闭前必须三项都一致，否则**拒绝**并回报 observed/expected |
| **绝不自动降级为强杀** | P0 实测（设计） | 这条路径的全部价值就是"别丢用户的东西"。自动 `taskkill /F` 等于把它取消。关不掉就如实报告"已请求、未确认" |
| 必须过审批门 | v1.1 | 工具已声明 `requiresApproval:'always'` + `isDestructive:true`。token 逝后，安全性就靠"审批门 + 身份校验"这两道 |
| 子进程仍需 `sandbox.confine()` | v1.1 + P0 实测 | 新引入的 `powershell.exe` 探针与关窗都**先过 confine**；confine 拒绝则**失败关闭**，不静默降级成无沙箱调用 |
| **工具只能"请求"，不能"保证"** | ⚠ **未验证** | 未实测本机 Blender 5.2 在有未保存改动时对 `CloseMainWindow()` 的反应。它很可能弹"是否保存"对话框 ⇒ **需要人在场**，工具无法代答。这对安全是好事，但文档必须照实写 |

**新增的落盘字段**：`instance.json` 与 `start-report.json` 的 `processIdentity`；`bootstrap.py` 另在 `port.json` 写 `startedAtWin32` 作交叉验证。
身份读取有两种实现：Python 侧用 `ctypes` 调 `GetProcessTimes`（桥内，零子进程）；Node 侧用**经 confine 的** `Get-CimInstance Win32_Process`（重载后桥已不可信，只能从外面查）。

---

### 3.13 运行时不污染内容寻址快照（**P0-F160；0.1.5 已实施并实测**）

| 约束 | 来源 | 说明 |
|---|---|---|
| **`bootstrap.py` 必须在导入兄弟模块之前**设 `sys.dont_write_bytecode = True` | **P0 实测（P0-F160 / P0-F165）** | Blender 一跑就把 `__pycache__/*.pyc` 写进 `.runtime-snapshots/<hash>/`，树哈希随之改变 ⇒ **任何包操作（disable/enable/update/remove）全报 `E_PACKAGE_INTEGRITY`**，直到手删。本轮实测因此卡死**两次** |
| **`PYTHONDONTWRITEBYTECODE=1` 无效** | **P0 实测（P0-F165）** | 探针实测：env 里该变量确实进了进程，但 `sys.dont_write_bytecode` 仍读作 `False`，`__pycache__` 照写 ⇒ **Blender 的嵌入式 CPython 不遵守它**。0.1.4 曾据此"修"，**无效**。唯一有效杠杆是**脚本内赋值，且必须早于兄弟导入** |
| spawn 时仍设该 env | 同上 | 无害且表达意图，但**不可依赖**（见上行） |
| 副作用型工具的**停止路径（两条都要）**必须先落盘报告 | P0 实测（P0-F58；我在 `agh_blender_stop` 上重犯两次） | 旧 token 路径只需 2 秒、从未被吞，所以我没给它落盘；换成 19 秒的新路径后结果当场被判 `TOOL_OUTCOME_UNKNOWN`，**失败原因永久丢失**。0.1.5 起 token 与无 token 两条路都写 `stop-report.json` |
| **`/shutdown` 不允许静默丢弃未保存内容** | **P0 实测（P0-F166）** | 实测：`bpy.ops.wm.quit_blender()` **不触发保存确认流程**，脏场景被**静默关闭**（Blender 只在系统 temp 留一份 session-recovery）。而这是**最常见**的路径。0.1.5 起 `/shutdown` 先经主线程读 `bpy.data.is_dirty`：脏且未 `force` ⇒ **409 `E_DIRTY`**，工具回报 `refused` 且**不关窗**；`force:true` 才关，并在报告里记 `isDirty/forced` |
| 不要把大整数存成 `Number` | P0 实测（P0-F161） | FILETIME `134356859898245176 > 2^53` ⇒ JS `Number` 存不住（实测变成 `…180`）。比较已正确用 `ticksRaw` 字符串 |

### 3.12 文档不随包分发（结构性决定，2026-10-05）

| 约束 | 来源 | 说明 |
|---|---|---|
| **`docs/` 不得放进包内** | **P0 实测（P0-F151）** | 包管理器对整棵树取哈希 ⇒ **任何文档编辑都会改 `integrity`**，于是要重走 `disable→remove→install→trust→enable`（含一次人工 `y`）才能再跑。本轮因此白跑了三轮 inspect，还一度把一个当场过期的哈希写进包内文档 |
| 包内只留代码与许可文本，文档放 `blender-workbench-spec/`（包外） | 同上 | 已在 v0.1.2 执行：删除 `docs/DESIGN.md`、`docs/P0-EVIDENCE.md`；`README.md` 里那两行改为解释原因并指向包外 |
| 推论：**不要把该包自己的 `integrity` 写进任何将被打包的文档** | 同上 | 要写就写"以最后一次 `package inspect` 为准"；真值记在包外台账 |

---

### 3.9 结构化 opcode 白名单（第 ④ 环）

**原则**：调用方**只能**说出白名单里的动词 + 参数，**永远不能**指定要执行的 Python 符号。没有 `eval`、没有按名字取属性、没有逃逸口。

| op | 作用 | `mutates` | `destructive` |
|---|---|---|---|
| `mesh.primitive_add` | 加一个基本体（cube / uv_sphere / cylinder / cone / torus / plane） | 否 | — |
| `object.transform` | 设 location / rotation_euler / scale | 是 | — |
| `object.duplicate` | 复制对象 | 否 | — |
| `object.delete` | 删除对象 | 是 | **是** |
| `material.set` | 建材质或改颜色/粗糙度/金属度/自发光 | 否 | — |
| `material.assign` | 替换对象的材质槽 | 是 | — |
| `object.join` | 合并多个对象 | 是 | **是** |
| `scene.describe`（读） | 回报场景对象/材质/已知 op | 否 | — |

（`mutates` / `destructive` 是给 Node 侧判断"要不要审批"用的声明，写在 `OP_MANIFEST` 里。）

**限额**：单批 ≤ 64 个 op；对象数 ≤ 512；名字 ≤ 96 字符且只允许 `[A-Za-z0-9_\-.]`；数值必须有限；颜色分量 0..1。


### 3.9.1 下一批 opcode 的范围声明（2026-10-05 定，**尚未实现**）

**准入条件（三条同时满足才收）**：

1. **参数化** —— 能用白名单动词 + 有限参数完整描述，不需要“按名字取属性”，也不需要任何代码字符串；
2. **可验证** —— 能写出确定性的接受/拒绝用例（沿用第 ④ 环的做法：正常批次 + 畸形请求全拒 + 部分批次停在失败处）；
3. **不引入新逃逸口** —— 不读文件、不发网络、不 import、不 `eval`、不向 `bpy.ops` 传任意字符串。

**收（按优先级）**

| 批 | 内容 | 为何排这个次序 |
|---|---|---|
| A | **层级**：`object.parent`（设/清，含 `keep_transform`）；`object.transform` 补全 rotation / scale | **它是“姿态打磨”的硬前置**：没有层级就只能摆散件，摆不了关节 |
| A | **修改器**：加 / 删 / 改参（`subsurf` / `bevel` / `mirror` / `shade_smooth`），参数严格枚举或区间 | 低模成形主力；全是标量/枚举，最好验证 |
| B | **灯光 / 相机参数**：类型、能量、颜色、焦距、朝向 | 影响渲图质量；结构同 A |
| B | **曲线 / 文本**：贝塞尔控制点、文本内容与字号 | 有界、可验证 |
| C | 材质节点、UV、集合 / 视图图层 | 面积大、收益低 |

**不收（每条都写明理由）**

| 不收 | 理由 |
|---|---|
| 自由网格编辑（顶点/边/面编辑器） | 本质是“任意几何脚本”，无法用有限动词穷举；也是已封路的写实重建那条线的入口 |
| 任何形式的 `run_python` / 表达式 / 宏 | v1.1 已废弃；§1.2 非目标 |
| 自定义节点组 / 驱动器 / 约束脚本 | 它们可以携带代码，等于绕过白名单 |
| `bpy.ops` 的任意字符串透传 | 同上；ops 只能以**已具名动词**出现 |
| 导入外部模型 / 贴图（glTF/OBJ/图片） | 涉及文件路径与不可信资产解析，应单独设计并过审批，不是 opcode 扩展 |

**“姿态打磨”的准确界定**：它指 **用已收回的 op 摆关节 + 再渲一张对照**，**不是**新增一个“姿态”原语；
硬前置是**层级（批 A）**。
**拒绝语义（fail closed，已实测）**：任何一条不合法 → HTTP 400 + `{ok:false, failed:{index, code, message}}`；
**批次在第一个失败处停下**，并回报此前已成功的项（不假装整批成功）。

| 拒绝码 | 触发 |
|---|---|
| `E_UNKNOWN_OP` | op 名不在白名单（含 `exec.python`、`__import__` 这类逃逸尝试） |
| `E_ARG_TYPE` / `E_ARG_RANGE` / `E_ARG_ENUM` / `E_ARG_CHARSET` | 类型错 / 越界 / 枚举外 / 名字含非法字符（含路径穿越） |
| `E_ARG_MISSING` | 必填缺失（如 `transform` 一个字段都没给） |
| `E_BAD_RECORD` | 记录里有多余键 |
| `E_NO_SUCH_OBJECT` / `E_NAME_TAKEN` / `E_NOT_A_MESH` | 目标不存在 / 名字占用 / 对象无网格数据 |
| `E_LIMIT` / `E_BAD_BATCH` | 超限额 / 批次为空 |

**实测证据（2026-10-05，真 Blender GUI）**：

- 8 个 op 的批次 → 全部应用，场景从 3 个对象变成 6 个（head/body/arm_L/arm_R + Camera/Light），材质 `Skin`/`Hair` 建成并指派；
- 10 类畸形请求 → **全部 400 拒绝**，场景对象数**未变**；
- 部分批次 → `applied=1`，`failed={index:1, code:E_ARG_CHARSET}`，批处理在失败处停止；
- 整批一次 `undo_push` ⇒ 一批错误操作是**一次 Ctrl+Z** 就能撤掉。

---

## 4. 架构

### 4.1 进程与责任

```
┌──────────── AGH daemon（长驻） ────────────┐
│  插件模块（我们的包，in-process）           │
│   ├─ 工具 agh_blender_*   ← 模型调用        │
│   └─ 服务/面板            ← 人类操作        │
│  持有：实例表(Map)、token（仅内存）          │
└───────────────┬────────────────────────────┘
                │ ① sandbox.confine(argv)
                │ ② spawn(confined...)  env: TOKEN
                ▼
      Blender GUI（受管理实例，factory-startup）
       └─ bootstrap.py：127.0.0.1 HTTP + token + 主线程队列
                ▲
                │ ③ /health（免鉴权） ④ /hello（token）
                └── Node 侧轮询 + 握手
```

### 4.2 一次 `agh_blender_start` 的时序（实测 3.2 s）

1. `enforcement()` 先读，放进报告（**先读再动**，别等失败了才想起没记录）
2. 发现 `blender.exe`（env → Program Files 扫描 → 版本降序），逐个跑 `<exe> --version` 校验
3. 建 `instances/<UUID>/`，写 `bootstrap.json`，`pickFreePort()`
4. 组 `rawArgv` → `await tctx.sandbox.confine(rawArgv)` → 记录 `confinedArgv` 与 `argvChanged`
5. `spawn`（detached、unref、stdio 重定向到实例目录）
6. 轮询：读 `port.json` → `GET /health`（实测 8 轮 / 每轮 400 ms）
7. `POST /hello` 无 token（期望 401）→ `tokenEnforced`
8. `POST /hello` 带 token → 主线程握手
9. 写 `instance.json`；写 `start-report.json`（**先落盘**）
10. 返回 `jsonSafe(report)`

---

## 5. 接口契约

### 5.1 工具

| 工具 | 语义 | meta |
|---|---|---|
| `agh_blender_start` | 发现 → confine → spawn → 轮询 → 握手 | `isReadOnly:false, isDestructive:false, isConcurrencySafe:false, isOpenWorld:false, replay:'never', requiresApproval:'always', costHint:{wallMs:90000}, deferLoading:false` |
| `agh_blender_probe` | 只读复查（回读磁盘报告 + `/health` + `/hello`） | `isReadOnly:true, isConcurrencySafe:true, replay:'safe', requiresApproval:'never'` |
| `agh_blender_stop` | 走 token 请求退出；**token 已随重载丢失时**，回退到"先校验进程身份再请求关窗"的优雅路径（见 §3.11） | `isDestructive:true, replay:'never', requiresApproval:'always'` |

`parameters` 手写 TypeBox 形状：`{[Symbol.for('TypeBox.Kind')]:'Object', type, properties, required, additionalProperties}`（只需 Object/String/Number/Integer/Boolean/Array/Union/Literal）。

### 5.2 `ToolContext` 实测可用面

可用：`cwd`、`session.key`、`exec(cmd, {timeoutMs})`（返回 `{code, stdout, stderr, truncated}`）、
`fs.read/write/list/stat`、`net.fetch(url, init)`（**loopback 可用，已实测**）、
`sandbox.confine(argv)`、`sandbox.enforcement()`、`timeoutMs`（实测 118000）。
`session.key` 可作 owner 标识（实测与会话列表一致）。

### 5.3 Bridge 端点

| 方法 | 路径 | 鉴权 | 返回 |
|---|---|---|---|
| GET | `/health` | 无 | `{ok, bridge, protocol, version, pid, port, blenderVersion, mainThreadTicks, handshakes, uptimeMs, authRequired}` |
| POST | `/hello` | token | `{ok, ..., echo, handshake:{executedOnMainThread, mainThreadId, mainThreadTicks, blenderVersion, binaryPath, factoryStartup, background, file, isDirty, scene, objectCount, objects[], sysArgv}}` |
| POST | `/shutdown` | token | `{ok:true, closing:true}` 然后退出 |

---

## 6. 分发形态

### 6.1 上传清单（待定稿）

- `package.json`（AGH 包声明）
- `extensions/main/index.mjs`（工具 + 服务）
- `extensions/main/bridge/bootstrap.py`（Blender 侧桥）
- `extensions/main/agnes.client.json` + `client/index.js`（面板，可选）
- `README.md`（安装三步、原理、坑）
- `LICENSE`（待定：建议根 `Apache-2.0` + `addon/LICENSE=GPL-3.0-or-later`，视是否含 addon 而定）
- **不包含**：受管理目录、日志、快照、`.agh-blender/`

### 6.2 别人的安装流程（实测可复用）

1. `agh package inspect file:<repo>` 预览（会显示 `integrity`）
2. `agh install file:<repo>` → 人在终端按 `y`
3. `agh package trust <id> <integrity> <capabilityHash>`（从 `package-operations/operations.json` 取）
4. `agh package enable <id>`

---

## 7. 路线图与验收

### 7.1 环（P0-1 ~ P0-5）状态

> **术语（2026-10-05 修正，即本条文档债）**：本节用的是**环**编号（P0-x），与 §3.9 的“第 ④ 环”、历史里的“第 ⑤ 环”同一套。
> 它与“指令里的步骤编号”**不是一回事** —— §9.y 记过一次混淆（把“指令第 5 步”当成了“第 ⑤ 环已完成”）。
> 另：早期把 P0-1/P0-2 写成“接线 / 面板”而未注明验收载体，实际是由**探针包**验收的，不是正式包；现已补注。

| 环 | 内容 | 验收载体 | 状态 |
|---|---|---|---|
| P0-1 | 接线（工具/服务共享模块实例、工作区路由） | 探针包 `@agh-p0/wiring-probe` | ✅ 通过（§H） |
| P0-2 | 客户端描述符与面板 | 探针包 | ✅ 通过（§H） |
| P0-3 | **启动链（审批 + confine + 真 GUI + 握手）** | 探针包 → 正式包 | ✅ **通过**（§I~§J） |
| P0-4 | 真实图片链 | 正式包 | ⚠ **前半段通过 / 媒体面受阻**：桥侧离屏渲染 + 自写 PNG 已两套实现对账通过（P0-F72~F78）；`artifacts.put` 写入成功且字节一致，但请求媒体面按 `sessionKey` 读不回（P0-F79~F84）⇒ 根因＝**行级两条条件**（`origin`/`trust`）不满足且**工具侧无登记入口**：分支 A 关闭、分支 B **仍无接口**（§3.7 / §K.5~§K.7 / §P.5） |
| P0-5 | 实际文件链 | 正式包 | ⚠ **部分**：`file.checkpoint` / `file.stage_export` + 工具 `agh_blender_export` 已落地并通过预检（`mainFileUntouched`、同 label 再存 → `E_TARGET_EXISTS`、导出 sha 与 stage 一致）；**跨目录相对贴图仍需 P1 的专门夹具复验**（§O / P0-F136~P0-F140） |

### 7.2 后续阶段

`P1` 合同与发行骨架 → `P2` 授权目录/发现/启动/锁 → `P3` 协议与 Bridge →
`P4` 状态/准入/去重/许可 → `P5` 恢复点/对象读写/脏标记 → `P6` 材质灯光相机修改器 →
`P7` GPU→PNG 与 native 检测 → `P8` 8 个 service 与人类操作 → `P9` UI 与模型请求 →
`P10` 文件/崩溃/更新 → `P11` 干净安装验收。

> ⚠ 这里的 `P1~P11` 是**阶段**编号，与 §7.1 的**环**编号（P0-1~P0-5）前缀相同、含义不同。
> 引用时写明“阶段 Pn”或“环 P0-n”，不要混用 —— 这正是 §9.y 记过的那个坑。

### 7.3 验收门槛（P0 结论 + F 组回归）

- 每个阶段都要有**独立于 agent 转述**的证据：磁盘文件 + ledger(ledger/audit) + 桥侧自查
- 禁止把"工具返回 ok"当成唯一证据
- `enforcement` 等级必须逐次如实记录

---

## 8. 风险与已知缺口

| 风险/缺口 | 现状 | 对策 |
|---|---|---|
| **沙箱只有 `partial/file`** | confine 放行且 `argvChanged=false`，但**没有**进程/网络隔离 | 如实显示等级；把危险动作压在审批门后；不宣称隔离 |
| **`TOOL_OUTCOME_UNKNOWN` 会吞结果** | 已实测发生一次 | §3.3 三条铁律 |
| **`capabilityHash` 不覆盖工具名** | 三次复现：加 3 个工具后摘要不变 | 不能把 capabilityHash 当"工具集合"的信任依据；每次调用仍各自审批 |
| **必须重装才生效** | 包被复制 + 快照化 | 改代码后固定走 `disable→remove→install→trust→enable` |
| **非 TTY 拒装** | INV-33 设计使然 | 安装步骤留给人类，CLI 只负责预览与后续 |
| 多实例抢端点 | v0 曾踩过 | `port.json` 原子写 + 端口探测 + 记录 `pid` 并与 `/health` 交叉验证 |
| 退出时写 `%TEMP%\quit.blend` | 实测行为 | 不碰用户工程与偏好，但**不是零写入**，文档要老实写 |
| 启动画面 | 会话内关闭，需重启才见到效果 | 面板给"恢复启动画面"按钮 |
| **图片进模型这条路尚未打通**（根因已定位） | `artifacts.put` 能写、blob 也在（P0-F80），但请求媒体面按 `sessionKey` 读不回：`E_STEP_FAILED: artifact <sha> could not be read`（P0-F81~F84）。根因（§K.5 / §K.6）：归属登记只认 `tool:computer_use`/`untrusted` 事件形状，我们的行**实测**两条都不满足 ⇒ 从未被登记（P0-F97/F98；**已活体取证** P0-F103~F105） | 两条旧猜想已排除/降级：**不是**块形状问题（拿到 `ARTIFACT_BYTES_MISSING` 而非 `INLINE_IMAGE_UNSUPPORTED`，说明块已翻译成 `resource_link`，P0-F84）；**不是** owner 不一致主导（owner 校验收紧真实存在，但行连投影资格都没有，轮不到它，P0-F86 vs P0-F97/F98）。对策：**分支 A 已关闭**（工具侧无登记入口，2026-10-05 收尾复核）；落**分支 B** 另定投递落点 —— `Host fs.write + 资源登记` 只是 v1.1 的代称，收尾复核**未找到**该接口，属**开放设计项**。见 `P0-EVIDENCE.md` §K.5 / §K.7 |

---

### 8.1 终局目标带来的结构性风险（2026-10-05）

| 风险 | 性质 | 处置 |
|---|---|---|
| 「插件生成图 → 模型」被设计关闭 | **架构级**（不是工作量） | 改为人在环 / 客户端面板；**不要**试图绕过 `origin` 条件，也不要改名冒充 computer_use |
| 多视角参考图依赖外部 diffusion 模型 | **能力级**（外部依赖） | 明确列为插件范围之外，不承诺 |
| 单图 → 写实 3D 不可达 | **目标级** | 目标收窄为**参数化低模**（卡通 / 人形）；写实还原不承诺 |
| vision 供应商是否真的收图，未验证 | **未验证（仍未验证，不是已否定）** | 列为近期第一优先实验；它的结果决定 (B) 是否存在。**2026-10-05 追加**：本会话 `computer_use`（唯一图片可达通道）**完全不可用**；且两个 home 全部历史 **378 条 `request/header` 均为 `text-only`/`manifest=0`**（`p0-media-scan.cjs`）—— 但这只说明**从未发生**（零次尝试），**不说明不可能**；该实验的**前置条件**（一条活着的通道 + 真去上传）先要满足 |
| **客户端根本没有"粘图"入口**（2026-10-05 审计） | **能力级缺口（源码级 + 运行态已核实）** | 4181 粘不进图片的根因**不是**客户端模块没装配：`@agnes/web-conversation-attachments` 是 `@agnes/web-units` 的 **内置单元**（随 web 构建发布、不按 profile 装配、无需安装）；两个 home 的可安装包集合一致，catalog 里也无此包。真实缺口是**该能力在 HEAD 上不存在**：`attachments.ts` 是显式空占位、未被任何代码引用，4181 实际服务的 `app.js` 里 `upload`/`clipboardData`/`DataTransfer`/`type="file"` **全为 none**，后端也无用户上传物的产出者。⇒ **"安装/启用"这条路径无对象可操作**；补它须改仓库源码（跨 `web-units`/`web`/`protocol`/`core+daemon`），且与 §K.7 的"登记缺口"是同一个问题。见 `P0-EVIDENCE.md` §M |

---

### 8.2 已作废的结论（保留编号，避免后人误引）

| 作废结论 | 成立范围 | 被什么推翻 |
|---|---|---|
| 「AGH 协议层没有 attachment node / 客户端没有粘图入口」 | **仅 `c1180fc0`** | 更新到 `7819b23c` 后粘贴入口存在（`clipboardData` 1、`image/png` 4），用户图经 inline image block 进模型 → P0-F132~F133 |
| 「模型从未被观测到看见图片」 | **仅旧 HEAD** | 实测会话 `37c500ee…` 的 `seq 30 user/message` 含 inline image block，模型答出画面细节 → P0-F133~F135 |
| 「2D→3D 必须建立在人在环之上」 | 旧 HEAD | 模型能看图 ⇒ "图→参数"这一环可交给模型；人在环降级为可选 |

**仍然成立、且与版本无关的三条**：

1. **工具产出的图 → 模型**被行级条件关闭（`origin === 'tool:computer_use'`，P0-F79~F91/§K.5）
2. 一旦这种图进了 `tool/result`，**该会话永久不可用**，无补救（P0-F128~F130/§K.8）
3. 多视角参考图需要**外部** 3D 生成模型（P0-F126 一类）

---

## 9. 操作手册（踩坑清单）

| 坑 | 症状 | 解法 |
|---|---|---|
| PS 5.1 `Set-Content -Encoding UTF8` 写 BOM | Python `json.load` 报 `Unexpected UTF-8 BOM` | 用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`；代码侧按 `utf-8-sig` 容错 |
| PS 5.1 `Get-Content -Raw` 往返改写 UTF-8 源文件 | 中文全变乱码，Node 报 `SyntaxError` | **绝不**用 PS 5.1 往返读写源文件；用 `write` 工具整文件重写 |
| AgnesCode 目录里的 `node` 是 shim | `node -e` 无输出、`--check` 不报错也没结果 | 用 `C:\Program Files\nodejs\node.exe` |
| 对已安装的包 `install` | `E_PACKAGE_STATE` | `disable → remove → install → trust → enable` |
| 只传 `--data-dir` 不设 `AGH_HOME` | `daemon child exited before readiness (1)` + `E_PACKAGE_INTEGRITY` | 设 `AGH_HOME` 且**不**再传 `--data-dir`；用不同端口并存 |
| 客户端描述符缺 `slotCatalogVersion` | 组件完全不出现，花名册里也没有，`actual=running` 却遍寻不着 | 补 `"slotCatalogVersion":"dsh-client-slots/v1"` 并重装；根因在 `daemon/src/packages/client-modules.ts` 的 `unsupported-slot` 静默 `continue` |
| 同一 bl_idname 注册两次 | `RuntimeError: unregister_class ... may not be registered` | 只保留一份；测试加 `--factory-startup` |
| 工具返回含 `undefined` | `TOOL_OUTCOME_UNKNOWN`，工具却不报错 | §3.3 铁律 ① |
| 包 `license` 写成 GPL（或任何不在白名单的值） | `trust` 永远返回 **`E_PACKAGE_TRUST`**，只给一句 `The package does not meet the required trust policy.`，且 **`blockers: []`** —— 看不到任何理由 | `LICENSE_ALLOWLIST`（`trust-gate.ts:9-18`）**不含任何 GPL 变体**，且它是闸门**第一处**；`license` **缺失**或写 `UNLICENSED` **也一样被拒**；组合式 `"A AND B"` 也不在白名单。→ 混许可时，**根 `license` 只写白名单内的值**（本包用 `Apache-2.0`），GPL 部分靠 `NOTICE`/`LICENSE-GPL`/`bridge/HEADER.txt` 声明。**别写 `"MIT AND GPL-3.0-or-later"`** |
| `trust` 失败时 **`blockers` 恒为 `[]`**，看上去像"策略拒绝不给理由" | **理由存在，是换算丢的**：`PackageError` 写的是 `detail.reason` / `detail.license`，而对外错误的 `blockers` 只从 `detail.blockers` 取（`daemon/src/packages/handler.ts` 的 `safeBlockers()`）；只有"活动引用"类错误会填 `detail.blockers`。另：`E_WORKSPACE_UNTRUSTED` 与 `E_PACKAGE_QUARANTINED` **共用同一个对外码** `E_PACKAGE_TRUST`（`errors.ts:5-12`） | 拿到 `blockers: []` **不等于**没有判据，也**不能**从对外码反推原因。定位手段：直接跑真实 `runTrustGate`（见 `P0-EVIDENCE.md` §P.5.3 的可重跑核对器），不要靠 CLI 输出猜 |
| `docs/` 放在包内 | 包管理器对**整棵树**取哈希 ⇒ 改一次文档就改 `integrity` ⇒ 必须重走 `disable→remove→install→trust→enable`（含一次人工 `y`）。本轮因此白跑了三轮 `inspect`，还一度把一个当场过期的哈希写进包内文档 | 文档放**包外**；**不要把该包自己的 `integrity` 写进任何将被打包的文档**（要写就写"以最后一次 `package inspect` 为准"）。见 §3.12 / P0-F151 |
| `agh package install <source>` | `unknown package action install` | 本机 dist 的 `bin.ts` 比 `src` 旧（`src` 有 `p.command === 'install' ? ['add', ...]` 映射，dist 没有）⇒ 用 **`agh install <source>`** |
| 查 `host.jsonl` 时"工具数对、**服务调用数为 0**" | **`extension.service-call` 行不带 `detail.package`**，它用 **`detail.extension`**（值形如 `plugin/42d5f5b313c99291`）；另：注册行出现在 `extension.loaded` **之前**，窗口起点应取 `extension.revoked` | 同时匹配 `detail.package` **与** `detail.extension`；窗口起点用 `extension.revoked`。两个坑合起来会得到"服务没注册"的**假阴性**（本轮两次都是 4 次调用正常，见 P0-F154） |

---

### 9.x 两条"看起来无关、实际互相冲突"的 schema 约束（2026-10-05，各挡过一轮）

| 症状 | 真因 | 规矩 |
|---|---|---|
| 所有工具调用都返回**光秃秃一句** `tool arguments do not match the registered schema`（无冒号、无提示）→ 那是 `toolArgumentError` 的 `catch` 分支，不是校验失败 | kernel 用 TypeBox `Value.Check` 校验工具参数；**手写 schema 没有 `Symbol.for('TypeBox.Kind')` 标记**时它会抛 `Unknown type`，被 catch 成那句无提示报错 | **工具 `parameters` 必须递归打标记** —— 且要**每个节点**都打（只标根节点不够：嵌套节点会在载荷带该字段时才被走到） |
| `extension.failed` / `E_EXT_LOAD` / `extension factory failed`，包加载不起来 | 服务注册路径会用 **JCS（RFC 8785）规范化** schema，`jcs.ts` 里 `keys.some((key) => typeof key !== 'string') throw invalid()` ⇒ **symbol 键非法** | **服务 `inputSchema`/`outputSchema` 必须保持纯 JSON，绝不能带 symbol 标记** |
| 带 args 的调用被拒、不带 args 的能过 | `tb()` 漏了：`args: { type: 'object' }` **缺 `properties`** ⇒ TypeBox 抛 `Cannot convert undefined or null to object` | `tb()` 对 `type==='object'` 且无 `properties` 的节点**自动补 `{}`** |

**两套要求正好相反**：工具要标记（TypeBox），服务不能有（JCS）。实现上分两路 ——
常量保持纯 JSON 给服务；`registerTool` 包装器用 `tb()` 生成**副本**给工具。

**检测缺口（我的教训）**：预检原先只喂空载荷 `{}`，根节点过了、嵌套节点从未被走到 → 漏检。
现已改成**每个工具再喂一份真实载荷**，并断言"不得抛异常、真实载荷必须被接受、未知顶层键必须被拒"。

---

### 9.y 两条容易犯的错（2026-10-05）

| 症状 / 误解 | 真因 | 规矩 |
|---|---|---|
| 插件重载后，正在跑的 Blender 实例**既不能 capture 也不能优雅 stop**，只能硬杀 | token 只在 **daemon 进程内存**里（v1.1 刻意不落盘），内存里的 `{token, port, pid}` 句柄也随重载一起清掉 ⇒ 实例变成"**在跑但失联的孤儿**" | 说"实例失效"时要分清是**进程死了**还是**凭证丢了**（本次实测：PID 27496 一直活着，丢的是凭证）。**硬杀会丢掉用户未保存的工作**，所以"重载后如何优雅停止"是**待解决的设计项**，建议：停止路径不依赖 token —— Host 记住 pid，用窗口消息（`CloseMainWindow`）走 Blender 的正常退出流程 |
| "第 5 步已完成，第 ⑤ 环也就完成了" | **"指令里的第 5 步"（`agh_blender_scene` 确认对象数）与"第 ⑤ 环（实际文件链）"是两件完全不同的事** | 引用阶段编号时写清是**步骤**还是**环**；本次就因为混淆，让 ⑤ 被当成已完成而漏掉 |

---

## 10. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 放弃 v0（装扩展 + `run_python`），改走 v1.1（零安装 + 结构化 opcode） | v0 的任意 Python 执行与"用户装扩展"两条都与目标冲突；v1.1 的 `--python bootstrap.py` 证明了可以不落盘安装 |
| D2 | 不把 `blender-mcp` 当接入载体 | 不是可安装包、拿不到 per-tool 审批语义、依赖外部 uv 漂移；MIT 只借鉴模式 |
| D3 | P0-3 判定为**通过**，不阻断交付 | 实测 confine 放行、`argvChanged=false`、真 GUI 起来；`partial/file` 属于"如实显示"而非"不成立" |
| D4 | 规范正文放在 `D:\agh-blender-workbench-spec\`（仓库外） | 插件将来是**独立仓库**，不该把它的设计文档塞进 agnes-harness 仓库 |
| D5 | 工具返回值一律 JSON 归一化 | P0 实测代价太高，宁可多一次序列化 |

---

## 11. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-10-06 09:12 | **v0.1.5 五项修补全部实测**：① `sys.dont_write_bytecode` 移到兄弟 import 之前（**修正 0.1.4 的无效修复**：实测 Blender 嵌入式 CPython **忽略** `PYTHONDONTWRITEBYTECODE`）② `/shutdown` 脏则 **409 `E_DIRTY`** 拒绝（用户选 A；实测完整链：拒绝 → checkpoint 存住含 `cube_a` → `force` 关闭）③ 两条停止路径都写 `stop-report.json` ④ 成功分支带 `identity.observed/expected` ⑤ 压掉 CLIXML 噪声。§3.13 重写；台账新增 §R（P0-F163~F171） |
| 2026-10-06 00:45 | **孤儿停止首次真实运行**（`P0-EVIDENCE.md` §Q.11）。① **抦到一个破坏性缺陷（P0-F160）**：Blender 一跑就往 **runtime snapshot** 里写 `__pycache__/*.pyc` ⇒ 内容寻址快照被污染 ⇒ **任何包操作都报 `E_PACKAGE_INTEGRITY`**（本轮实测卡死，手删后 `disable` 立即恢复）；修法：spawn 时加 `PYTHONDONTWRITEBYTECODE=1` + `bootstrap.py` 里 `sys.dont_write_bytecode=True`（**未实施**）。② **机制已验证**：直接对真实 Blender 49456 跑已安装包里的 `ps_close.ps1` → `EXITED`，进程确实退出（非强杀）⇒ 方案可行。③ **工具路径失败**：`agh_blender_stop` 跑 19 秒后结果被 **`TOOL_OUTCOME_UNKNOWN` 吞掉**，窗口未关 —— **我的代码违反了 P0-F58**（副作用型工具没先落盘报告），失败原因永久丢失；最可能是 **confine 下执行工作区外 `.ps1`** 被阻/挂住。下轮三件必修事见 §Q.11.4 |
| 2026-10-06 00:20 | **TUI 那次不是“没问”，是 `reason=timeout`**（`P0-EVIDENCE.md` §Q.10，P0-F159）。ledger 链条：#19 `tool/call agh_blender_start` → **60 秒后** #22 `approval/asked` → #23 `approval/decided verdict=rejected **via=sync** reason=timeout`。与 `-p` 那三次的 `user_rejected` **不同**：`via=sync` 证明 TUI 真问了。又拿到一条非显而易见的机制：**审批卡片 `canSelect = rows >= 4`** —— 窗口行数不够时只显示 resize 提示，**按任何键都选不动**；且 `selected` 初值是 **`reject_once`**，所以**直接回车 = 拒绝**。⇒ 下次操作：拉大窗口 + 按 allow 项的数字键（或 ↑/↓ 再回车）+ **60 秒内** |
| 2026-10-06 00:05 | **找到三次“拒绝”的真因：`-p` 模式没有审批 UI**（`P0-EVIDENCE.md` §Q.9，P0-F158）。用户两次 + 我一次均得「the user rejected this action」，根因不是 TTY、也不是用户没点，而是 **`-p`/`--mode text|json` 是 one-shot print 模式**（`args.ts:191-195`），该模式**根本没有回答 `approval/asked` 的接线**；只有 **TUI**（`bin.ts:789-801` + `modes/tui.ts`）能交互。可回答审批的面只有四类：`via ∈ {sync, callback, timeout, guardian}`（`log/validate.ts:7`）。⇒ **要人参与的步骤，命令必须用 TUI（不带 `-p`）**。已记下本轮两次自伤：把"模式"误归因为"非 TTY TUI 门"，并给了用户一个不可能成功的命令 |
| 2026-10-05 23:50 | **v0.1.3 上架完成**（`P0-EVIDENCE.md` §Q.6/Q.7）：`install`（人类按 y）→ `trust` → `enable` 全绿；integrity 与冻结值逐字一致。新增 **§3.9.1 下一批 opcode 的范围声明**（准入三条 + 收 A/B/C 三批 + 不收五类 + "姿态打磨"的准确界定）。**发现并固化一条流程事实**：被安装的第三方工具**不会自动出现在主代理会话的工具面**（本会话调 `agh_blender_start` 得 `unknown tool`），需用 CLI 起子会话驱动，而子会话实测**连的是同一个 daemon**（无新 `extension.loaded`，daemon pid 不变）⇒ 共享内存句柄；但**非 TTY 下审批自动拒绝**（`the user rejected this action`）⇒ 起实例必须由人在 TTY 做 |
| 2026-10-05 23:35 | **§7 文档债清掉**：§7.1 重写为"**环**（P0-1~P0-5）+ 验收载体"三列（并注明 P0-1/P0-2 的载体是**探针包**）；P0-5 由"⬜ 待做"改为"⚠ 部分"（真实状态）；§7.2 加注：`P1~P11` 是**阶段**、与**环**同前缀不同义。另修 §3.10：决定已由用户明确确认（2026-10-05）。**v0.1.3 已就绪但待安装**（§Q.6） |
| 2026-10-05 23:20 | **v0.1.2 上架确认**（`P0-EVIDENCE.md` §Q.5 / P0-F154）：`install`（人类按 y）→ `trust`（一次过）→ `enable` 全部 completed；最终 `agh-blender@0.1.2 desired=enabled actual=running trusted=true`；integrity 与冻结值逐字一致。`host.jsonl`：**8 工具重新注册**（均 `row=ext:agh-blender/runtime`）+ **`blender.status` 4 次调用 `outcome=["inspected","ok"]`**。§9 新增三条踩坑（`docs/` 在包内 / `agh package install` 拼写 / **host.jsonl 检索假阴性**：服务行不带 `detail.package`，用 `detail.extension`；且注册行早于 `loaded` 行）。**孤儿停止仍无活体验证** |
| 2026-10-05 23:10 | **v0.1.2：孤儿停止 + 文档出包**（`P0-EVIDENCE.md` §Q）。① **孤儿实例优雅停止**（P0-F153）：`agh_blender_stop` 在内存无句柄时改走**不依赖 token** 的路径（`instance.json` → 身份校验 → `CloseMainWindow()`）；两道防护是**PID 复用校验**（新增 `processIdentity={imageName,ticks}`，三项不一致就拒）与**审批门**；**代码里无任何强杀路径**，且新子进程都先过 `sandbox.confine()`（拒则失败关闭）。新增 §3.11。② **`docs/` 移出包**（§3.12，处置 P0-F151）：删包内两份文档副本，README 改为指向包外并解释原因 ⇒ **后续改文档不再触发重装**。许可决定已由用户明确确认，已落档（§3.10）。新增 §3.12。预检：`node --check` / `p0-publish-check`（failures 0）/ 三个 `.py` 的 `py_compile` 均通过。**未做活体运行验证** |
| 2026-10-05 22:30 | **v0.1.1 安装链全通**（`P0-EVIDENCE.md` §P.5.8 / P0-F152）：`disable → remove → install（人类 TTY 按 y）→ trust → enable` 全部 completed；最终 `agh-blender@0.1.1 desired=enabled actual=running trusted=true`。**`host.jsonl` 确认 8 个工具全部注册**（`row=ext:agh-blender/runtime`）+ **`blender.status` 4 次调用 `outcome=["inspected","ok"]`**（面板真调通）。⇒ **许可闸门确实是唯一卡点，改对 `license` 即全解**。另记两处非阻塞观察：花名册里留有已移除探针包的旧声明（不会自动清）；包已安装 ⇒ **包内 `docs/` 不能再改**（会改 `integrity`），本轮结果只回写包外台账 |
| 2026-10-05 22:26 | **选项① 混合许可执行完毕（包侧）**：`package.json` → `version 0.1.1` + `license "Apache-2.0"`；`LICENSE` 换 Apache-2.0 全文、新增 `LICENSE-GPL`/`NOTICE`/`extensions/main/bridge/HEADER.txt`；`README` License 段重写。新增 §3.10（两套声明）、§9 两条踩坑（白名单 / `blockers` 丢失）。**执行链**：`disable` ✅ → `remove` ✅ → `inspect` ✅（v0.1.1 / Apache-2.0 / `integrity sha256-33348edf…` / `capabilityHash 7e7b2182…` **与 0.1.0 相同**）→ `install`/`trust`/`enable` **待人类 TTY 按 `y`**。**新发现的坑（P0-F151）**：`docs/` 在包内 ⇒ **改文档会改 `integrity`**，本轮因此白跑了三轮 inspect；规矩是不把包自己的 `integrity` 写进任何将被打包的文档。**另记本机 CLI 差异**：dist 里 `agh package install` 不存在（`bin.ts` 比 src 旧），正确形式是 `agh install <source>`。完整取证：`P0-EVIDENCE.md` §P.5.8 |
| 2026-10-05 22:40 | **§P.5.5 的 A4 被实测证伪**（见 `P0-EVIDENCE.md` §P.5.7 / P0-F147~F149）：① `license` 字段缺失、以及显式 `"UNLICENSED"`，**同样被拒** ⇒ 没有"声明豁免"；② 白名单**不可配置**（模块级 const），且 root `package.json` 只能有一个 `license` ⇒ **"拆许可"（Node MIT / Blender GPL）也绕不开闸门**。附加事实（非法律意见）：`bootstrap.py` 纯标准库（不碰 `bpy`），`agh_ops.py`/`agh_capture.py` 会导 `bpy`，未 import 任何第三方 GPL 项目。⇒ 剩下的只有"重许可"或"不发 AGH 包"两条路；重许可前需人工回答 Blender 官方许可页涉及的具体问题 |
| 2026-10-05 22:10 | **P.3 卡点定论：卡在 `license`，不是 workspace 信任**（见 `P0-EVIDENCE.md` §P.5，P0-F143~F146）。§P.3 列的两个候选项（license / scope）**第一个成立，且就是它**；但**机制与当时设想不同**：抛出点是 `E_PACKAGE_QUARANTINED`（`trust-gate.ts:59`，license 不在 8 项白名单）—— **不是** `E_WORKSPACE_UNTRUSTED`。两个 legacy code **共用同一个对外码** `E_PACKAGE_TRUST`（`errors.ts:5-12`），且都不写 `detail.blockers` ⇒ **`blockers: []` 是换算丢的，不是"策略不解释"**。另排除两轴：`layer` 从未被赋值（`PackageErrorSource` 无调用方）；能力集超限走 `E_PACKAGE_BLOCKED`，码就不对。两个**可重跑**核对器（`p0-trust-cause.check.cjs` 含自校准；`p0-trust-gate-probe.test.ts` 直接调真实 `runTrustGate`）均 exit 0。
**"重新授予工作区信任"这条路不存在**：本包 `source.type='file'`、lock 无 `workspace` 段；且 `workspace:` 部署通道**同样挡**（`trustWorkspace` 对每个扩展调 `runTrustGate`，`manager.ts:1066`）。释放选项与诚实性分析见 §P.5.5（**属发布决定，本轮未改任何文件**）。§3.8 同步新增两行硬约束 |
| 2026-10-05 21:37 | **第 ⑤ 环落地**：新增 3 个白名单 op（`data.purge_unused` / `file.checkpoint` / `file.stage_export`）+ 1 个工具 `agh_blender_export`（Blender 只 stage，最终落盘经 Host `fs.write`）。预检实证：`mainFileUntouched=true`、同 label 再存 → `E_TARGET_EXISTS`、导出 sha 与 stage 一致、**同目标再导被拒**（永不覆盖）。**仍未验**：跨目录相对贴图（预检场景无贴图，`images:0`），需专门夹具。§9.y 新增两条易犯错误（孤儿实例的凭证 vs 进程、"第 5 步 ≠ 第 ⑤ 环"）。清理：删除 6 个死实例目录（3 张更早的探针 PNG 已挪到 `.agnes/work/p0-old-captures/`） |
| 2026-10-05 21:25 | **里程碑：第 ④ 环端到端成功**。会话 `3de1275e…` 贴图 → 模型读图出参数（拒绝编造头身比/裤装色）→ 先读 `ops_catalog` → `agh_blender_start` → **17 条 opcode 全部 applied**（journal 实证：`ok=true applied=17 objectCount=9`）→ `agh_blender_scene` 确认 7 个网格 + Camera/Light。§9.x 新增两条 schema 冲突规矩（ToolBox 标记 vs JCS 纯 JSON、嵌套 args 缺 properties），并记下"预检只喂空载荷"的检测缺口 |
| 2026-10-05 20:55 | **重大更正**：仓库更新到 `7819b23c` 后，"用户上传图 → 模型"成立（inline image block，实测 P0-F133~F135）。§M 作废；§1.3 架构边界改为"两条通道分开记"；"人在环"从唯一解降级为可选 |
| 2026-10-05 20:30 | **第 ④ 环开工**：新增 §3.9 结构化 opcode 白名单（7 个写 op + 1 个读 op、限额、拒绝码表、实测证据）。真 Blender 实测：8 op 批次建成、11 类畸形请求全部 400 拒绝、场景未变、部分批次在失败处停止 |
| 2026-10-05 21:10 | **新增 §8.1 一行 + `P0-EVIDENCE.md` §M：「附件模块缺失」审计结论＝不是模块缺失，是入口从未实现**。按用户线索读完 `boot.ts:221` / `region-slots.ts:94`：该模块是 `@agnes/web-units` 的**内置单元**（`BUILTIN_WEB_UNITS`，随 web 构建发布，**不按 profile 装配**），不是可装包；两个 home 的 `agh package status` 仅差探针包，catalog 查询无此包 ⇒ **`enable/install` 无对象可操作**。4181 **实际服务**的 `/app.js` 实测含 `conversation.input.attachments` / `data-agnes-composer-dsh`，但 `upload`/`clipboardData`/`DataTransfer`/`type="file"` **全为 none**；`attachments.ts` 是空占位且无调用点。⇒ 真实原因＝**能力在 HEAD 上不存在**；补它须改仓库源码（**未实施**，仅方案与影响，见 §M.5）。**要求 3 的粘贴实验已主动暂缓**（通道不存在，必然 `manifest=0`，无判别力）。证据 P0-F121~P0-F127（源码级 + 运行态） |
| 2026-10-05 19:40 | **§1.3 近期三步·第 1 步审计（修正版）**。**纠正上一轮一处越界推理**：上一轮把「两个 home 全部历史 `request/header` 中 inline image 块 = 0」（P0-F118）当成了对图片入链的**否定**，这是 **absence of evidence 被误用为 evidence of absence** —— 从未有会话尝试上传，零次尝试的扫描**必然**为空。据此：① §1.1 第 4 条与 §1.3 的措辞由「未获证」改回「**本机从未观测到图片进模型**」（记录「未发生」，**不**记录「不可能」）；② §1.3 段 (B) 结论改回 **「仍未验证」**，**不是**「不可行」；③ **新增 P0-F120**（单独编号，按用户要求）：`computer_use` 在本机**完全不可用**（`capture` timeout、`list_apps` ECONNRESET、`list_windows` timeout→aborted）—— 这把「图片进模型」从「被行级规则挡住」进一步加强为「**连唯一合规通道也不可用**」，但仍是**环境级**事实，**不改写** §3.7 的规则级结论；④ **§3.7 本轮不动**（第 2 步等第 1 步结果再定，依用户指示）；⑤ 第 1 步的正确做法是**真去上传一张图**（盲测），不是扫库推断。**第 1/2/3 步本身仍未执行。** |
| 2026-10-05 19:05 | **§1.3 近期三步：第 1 步未执行（受阻），但产出一条修正与四条结论**（全部可核对，见 `P0-EVIDENCE.md` §L / P0-F113~P0-F119）：① **§1.1 第 4 条与 §1.3「模型能看用户上传的图」降级为未获证**——源码里没有「用户上传 → 模型可见图片块」的入口（媒体面只认 `tool/result` 行上的 `resource_link`，`orchestrator/request-media-surface.ts:371-399`）；② |
| 2026-10-05 17:32 | 目标层固化：新增 §1.3（终局目标与可达性判断 + 近期三步）、§8.1（结构性风险）、§1.1 增补第 4/5 条范围声明 |
| 2026-10-05 16:20 | 建立本文档。§3.3 三条铁律、§3.2 沙箱判词、§7.1 P0-3 通过、§8 缺口、§9 踩坑清单，全部来自 P0 实测（证据见 `P0-EVIDENCE.md`） |
| 2026-10-05 16:35 | P0-4：`§3.7` 图片链的**产出侧**通过（两套实现对账逐值相同）；**投递侧受阻**（媒体面按 sessionKey 读不回）。§7.1 / §8 同步更新 |
| 2026-10-05 16:45 | P0-4 受阻根因收口：**归属未登记**（字节与归属是两套索引）。§3.7 补入硬约束，§8 缺口行同步。证据 P0-F85~F91 |
| 2026-10-05 16:47 | P0-4 **投递侧根因定位**：§K.5 追完 `ArtifactAuthorityProjectionWriter` 全部调用方 ⇒ 分支 B（无带登记的工具侧 put）。`§3.7` 再补两条约束（登记只认 computer-use 通道；改走 Host `fs.write`+资源登记），`§8` 缺口改写并排除两条旧猜想。证据 P0-F92~F102，**源码级，活体取证待补** |
| 2026-10-05 17:14 | **P0-F98 由"代码规则推出"升为活体取证**：新增 `P0-EVIDENCE.md` §K.6，从**真实会话 ledger**（`node:sqlite` 直读 `events` 表）读出 `tool/result` 行上的 `origin=tool:agh_blender_capture`、`trust=trusted`，与推断逐字一致；并实测行级谓词两条件均不满足而块级条件全满足（证据 P0-F103~F106 → 见 §K.6）。**遗留**："在全新 home 里跑"受非 TTY 安装门阻塞（INV-33），待人类一步 |
| 2026-10-05 17:30 | **P0-4 收尾**（见 `P0-EVIDENCE.md` §K.7）：① 把 §K.5/§K.6 提到的两条"行级条件"**具名并定位判定者**（daemon 侧投影器 `mediaRoots`，非工具）；② 补证**工具侧无登记入口** ⇒ **分支 A（工具侧补齐）关闭**；③ 新增**可重跑核对器** `p0-4-row-conditions.check.cjs`（读 ledger 逐条件求值，exit 0 = 与结论一致）；④ **分支 B 未按原措辞照抄**：复核**未找到**面向工具/插件的"资源登记"接口 ⇒ 改写为"投递落点待定"的开放设计项。§3.7 三行重写、§7.1 状态同步；另记一条与既有台账叙述不符的 ledger 观察（P0-F107）与两处本轮未做之事（P0-F108） |
