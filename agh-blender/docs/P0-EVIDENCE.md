# P0 证据台账（AGH × Blender 插件包）

> 对应外部设计文档《AGH Blender 插件包：详细设计与逐步实施指南》v1.0 的 §25 P0、§30 证据要求。
> 规则：每条都写**怎么得到的**（命令/文件/行号）与**当前状态**（已核实 / 待验证 / 与文档不符）。
> 本机环境：Windows；Blender 5.2.2 LTS（`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`，build hash `d13f752e3b9c`，**内置 Python 3.13.13**）；AGH 仓库 `D:\agnes-harness`，HEAD `c1180fc0d1a7b54b7a624dee276c8b7c3a9f937f`（main）；Node `24.21.0`。

## A. 环境与实例（本方自行验证）

| 编号 | 结论 | 依据 | 状态 |
|---|---|---|---|
| P0-F1 | **只传 `--data-dir` 而不设 `AGH_HOME` 会让 daemon 起不来**：报 `E_PACKAGE_INTEGRITY: runtime snapshot store requires recovery`（内部 legacy code 是 `E_LOCK_MISMATCH`） | 复现两次；`packages/package-manager/src/runtime-snapshots.ts:128`；脚本 `start-local-windows.ps1` 注释原话："it must not name a different root than the CLI resolves for the same environment" | **已核实** |
| P0-F2 | **修正后的做法可用**：`AGH_HOME=D:\agh-p0-home` + `serve --port 4181`（**不传** `--data-dir`）→ 启动成功 | `D:\agh-p0-home\data\daemon\discovery.json`：`dataDir: D:\agh-p0-home\data`、`ready: true`、`web.origin: http://127.0.0.1:4181` | **已核实** |
| P0-F3 | **两个实例可以并存**（不同 home）：4180 用 `C:\Users\erfet\.agh\data`，4181 用 `D:\agh-p0-home\data`；socket 管道与端口都不同，互不干扰 | 两侧 `discovery.json` 对比；`Get-NetTCPConnection` 显示 4180/4181 各有独立 PID | **已核实** |
| P0-F4 | **新 home 不会带上 provider 配置**：新 `profile.json` 只有 `{package, adapters}`，没有 `routes` | 新 home `profile.json`（1879 B）vs 旧 home（3603 B，含 deepseek 路由 + 2 模型） | **已核实** |
| P0-F5 | Blender 5.2.2 内置 **Python 3.13.13** | `blender --background --python-expr "import sys; print(sys.version)"` | **已核实** |

## B. 宿主契约（读源码核实，函数/行号为 `D:\agnes-harness` HEAD）

| 编号 | 结论 | 依据 |
|---|---|---|
| P0-F6 | 描述符的 **`services` 允许清单在运行时强制**：客户端调服务/effect 前检查 `config.services?.includes(name)`，否则抛 `client service is unavailable` | `packages/web-client/src/client-module.ts`（`boundServiceApi` / `registerEffect`） |
| P0-F7 | 客户端 **`slots.register` 需要 React 组件**（`ComponentType<SlotProps>`），并由宿主 import map 提供 `react` 等共享单例 | `packages/web-client/src/registry.ts:59`；`packages/web-client/src/externals.ts`（shared externals 列表） |
| P0-F8 | **`workbench.panel` 真实且已挂载**；`shell.overlay` 也在运行时支持清单里 | `packages/web/src/client-modules/boot.ts:196-209`（`data-agnes-slot-mount` + `SlotOutlet`）；`packages/protocol/src/package-admin.ts:10`；`packages/web-client/src/dsh-slot-catalog.ts` 的 `DSH_RUNTIME_SUPPORTED_SLOT_NAMES` |
| P0-F9 | ⚠️ **两套槽位合同不是一回事**：`workbench.panel` 属 client-module 路径，DSH 目录（含 `shell.overlay`）是另一套 | `examples/packages/README.md:21` 原话："它与上述 DSH browser-row fixture 的槽位合同和验收目标不同" → **同一描述符同时声明二者未经验证**（P0-1 要测） |
| P0-F10 | ⚠️ **`registerEffect` 每次调用生成新的 `crypto.randomUUID()` 作 clientActionId** | `client-module.ts` 的 `execute()` → 与文档 §15.4「网络重试必须复用同一 clientActionId」**不一致**（差值记录，待定方案） |
| P0-F11 | 客户端服务调用**需要活跃会话**：无 `session.sessionId` 时抛 `client service requires an active session` | 同上 |
| P0-F12 | **`sandbox.confine` 是"工具唯一可用的沙箱开口"** | `packages/extension-api/src/tool.ts:205` 及其注释；我们的 v0 直接 `spawn(blender.exe)` **绕过了它** |
| P0-F13 | 默认 `standard` 预设 = `{level: L0, required: false, on_unavailable: allow}`；Host 允许时 `confine` 返回**校验过的原 argv** 并报 `enforcement: {level:'partial', scope:['file']}` | `packages/code/presets/standard.yaml:23`；`packages/host/templates/local-dev.yaml`；`packages/base/extensions/sandbox/src/workspace-probe.ts:43-46` |

## C. P0-1 实验包（`@agh-p0/wiring-probe`）

| 编号 | 结论 | 依据 |
|---|---|---|
| P0-F14 | 真实 Host **接受**这份声明（插件行 + client descriptor） | `package inspect file:./.agnes/work/p0-wiring-probe` → `Preview @agh-p0/wiring-probe@0.1.0` + `contributions client`（v0 无 descriptor 时是 `contributions none`） |
| P0-F15 | `blockers` 是否为空**不能**由 CLI 预览判断（该输出不打印 blockers）→ 需查 `daemon/package-operations/operations.json` | CLI `formatPreview` 只输出 5 行（`packages/cli-tui/src/package-admin.ts`） |

待验证（P0-1 尚未完成）：
- 装包 → 浏览器里 `workbench.panel` / `shell.overlay` 是否真的渲染出组件
- effect 是否经宿主确认并更新后端 counter
- 工具的 `moduleId` 与服务的 `moduleId` 是否相同（→ 是否同一实例）
- A/B 不同 cwd 是否隔离

## D. 与文档的已确认偏离（需在最终报告里写明）

| 项 | 文档要求 | 实际做法 | 原因 |
|---|---|---|---|
| 独立 AGH_HOME | §25 P0："装到独立 AGH_HOME" | ✅ 已做到：`D:\agh-p0-home`，4181 端口，与主实例并存 | 见 P0-F2/F3 |
| 静态 `services` 数组 / `inject: ["services"]` | §8.1 | P0-1 包**未加**（只用已验证可用的 `inject: ["extension"]`） | 已知可用 fixture 不需要它们；作为下一轮差异测试项，避免 P0 败在字段形状 |

## E. 设计文档 v1.1（2026-10-05 复核版）带来的变更

> v1.1 是**主合同**。§33 原话："实现者以 1.1 主节为准，**不继续使用 1.0 保存/False checkpoint/末尾覆写合同**。"

| 编号 | 主题 | v1.0 | **v1.1（现行）** | 影响 |
|---|---|---|---|---|
| P0-F16 | checkpoint 重映射 | `relative_remap=False` | **`copy=True, relative_remap=True`** | **反了**：相对贴图/链接库在副本里必须指回原资源 |
| P0-F17 | 未保存判定 | 可用 `bpy.data.is_dirty` | **不可独依**：pluginDirty/nativeDirty/baseline/unknown 联合判定 | 作者实测：Python 改 transform 后 `is_dirty` 仍 false |
| P0-F18 | 文件保存 | `agh_blender_save`（可 overwrite） | **删除该工具**；只有 `agh_blender_export_copy`（全新 UUID 目标、≤64MiB、经 Host `tctx.fs.write`、**无 overwrite**） | Core `fs.write` 会先 checkpoint 旧目标，而 fs-checkpoint **拒绝前 8192B 含 NUL / 过大的已有文件**；真实 .blend 含 NUL |
| P0-F19 | 许可同步 | 有 `control.sync` | **删除**；Node 持全部许可 + 唯一 inflight + Bridge 非递减 generation | 少一个状态机与 ack 竞态 |
| P0-F20 | 去重层级 | 按 operationId | **两层**：业务 `operationId` + Bridge `request.id`（每阶段不同） | checkpoint 回执不能当 mutation 完成 |
| P0-F21 | 文档切换回执 | 未明确 | envelope 回显**原** doc；result 带 `newDocumentEpoch`；`scene.changed` 带 old/new | 避免成功的 open 被当旧消息丢弃 |
| P0-F22 | dispose 与锁 | 未明确 | **必须释放自己持有的 owner-lock** | 否则同 worker PID 下新版本被旧锁永久挡住（实施死锁） |
| P0-F23 | handler 信号 | 未明确 | `sctx.signal` 在 handler 结束会 abort → **后台任务不得绑定它** | 改用 operation 取消标记 + row signal |
| P0-F24 | 图片编码 | `Image.save_render` 可能二次调色 | **一次 GPU 颜色管理 + 标准库 RGB PNG**（不用 Pillow、无临时 bpy Image） | 颜色一致性 |
| P0-F25 | checkpoint 期间 pause | 仅开始时检查 | checkpoint 完成后**再核** signal/generation/revision；Bridge 执行前 flush native dirty | 防止 pause 后仍发 mutation |
| P0-F26 | 私有目录归属 | 只写数据 | 增加 `marker.json`（pluginId/schemaVersion/workspaceDigest）；未归属目录**拒绝接管** | 防止误用同名目录 |
| P0-F27 | 启动重建入口 | 无 | `start` 增 `mode=fresh/replaceDisconnected` + `previousInstanceId` | unknown 实例的安全重建路径 |
| P0-F28 | 配置面 | 未明确 | PluginConfig 用 **Standard Schema**，只允许 3 个可调项（previewWidth / previewHeight / nativePreviewMinIntervalMs） | 其余为固定安全常量 |
| P0-F29 | 新增错误码 | — | `E_BLENDER_EXPORT_EXISTS / EXPORT_FAILED / EXPORT_PATH_DEPENDENCY / PRIVATE_DIR_CONFLICT` | 导出与目录归属 |
| P0-F30 | 验收清单 | A–E | 增加 **F 组 10 项回归门槛** | 交付门槛更严 |
| P0-F31 | P0 项数 | 4 项 | **5 项**（新增"实际文件链"） | P0-1/P0-2 与已建的探针包一致；③④⑤为新 |

**⚠️ v1.1 的"本机证据"仍不属于这台机器**：§34.1 的证据目录是 `C:\Users\28123\AppData\Local\Temp\...`，而本机用户名是 **`erfet`**；仓库根（`D:\workbench\agnes001\agnes-harness`）、Blender 路径、Node 版本也都不同。

→ 作者实测数字**只作参考**。其中**影响设计的三条必须在本机独立复核**：
1. 真实 .blend 的文件头与"前 8192B 含 NUL"（决定 export-only 是否必要）
2. Python 改 transform 后 `bpy.data.is_dirty` 是否仍为 false（决定 pluginDirty 设计）
3. `copy=True` 下 `relative_remap=True/False` 的对照（相对贴图 exists true/false）

## F. 本机只读复核结果（2026-10-05）—— 验证 v1.1 §34.1 的三条关键依据

> 方法：`blender --background --factory-startup --python p0-probe.py` / `p0-probe3.py`，
> 全部在 `.agnes/work/` 隔离目录内用**合成数据**；**未打开用户项目、未装插件、未改用户偏好**。

| 编号 | 复核项 | **本机结果** | 与 v1.1 §34.1 对照 |
|---|---|---|---|
| P0-F32 | 真实 .blend 头 + 前 8192B | 大小 **567084B**（与作者数字**完全一致**）；头 `BLENDER17-01`；**前 8192B 含 8143 个 NUL，首个在偏移 21** | ✅ **一致** → export-only 决定有本机依据 |
| P0-F33 | 保存后 Python 修改是否翻 `is_dirty` | 改 `location.x=9` / `scale` / 改 mesh 名 / `view_layer.update()` 之后**全部仍为 False**；**连 `bpy.ops.mesh.primitive_cube_add` 之后也为 False** | ✅ 一致且**更强**：background 下 `is_dirty` 对 operator 改动也不翻 → `pluginDirty` 必须插件自持。**GUI 行为仍需 GUI 验证**（本机 background 不能证明 GUI） |
| P0-F34 | `relative_remap` True/False 对照 | **False**：字段保持 `//assets\tex.png` → 解析到**副本旁目录** → `EXISTS=False`（**复现反例**）；**True**：字段被改写为 `//proj2\assets\tex.png` → 指回原资源 → `EXISTS=True` | ✅ **一致** → checkpoint 必须 `copy=True, relative_remap=True` |
| P0-F35 | `copy=True` 是否改动当前主文件 filepath | 两种对照下 `bpy.data.filepath` 都保持 `live.blend` | ✅ 与文档一致 |
| P0-F36 | 顺带产出 | 自写的**标准库 PNG 编码器**（`zlib`+`struct`，每 scanline `filter=0`）产出的 PNG 能被 Blender 正常载入 | 可作为未来 `bridge/png.py` 的起点 |

**探针自身的返工留档**（避免复现）：
1. P3 第一版失败原因：**在保存 `live.blend` 之前**就给 image 设相对路径 → `//` 基准错误 → 两条对照 `EXISTS` 都是 false，**失去对照意义**（这是我布景错，不是 Blender 行为）。
2. 修正：**先保存** .blend 确立基准，再用 `bpy.path.relpath()` 生成相对形式 → 对照成立。

## G. P0-1 首个真实故障（2026-10-05）—— 客户端模块未进花名册

| 编号 | 现象 | 根因（源码依据） | 修复 |
|---|---|---|---|
| P0-F37 | 包 `actual=running`、install/trust/enable 全部 completed 且无 blockers，但 daemon 的 client-modules 花名册是空的（`{"version":1,"profile":"local-dev","packages":{}}`）→ **浏览器看不到组件** | `packages/daemon/src/packages/client-modules.ts:1157-1172`：只要声明了**任一 DSH 槽位**（如 `shell.overlay`）而 `client.slotCatalogVersion !== "dsh-client-slots/v1"`，整行被判 `blocked / unsupported-slot` 并 **`continue` 跳过**，完全不进花名册 | 描述符补 `"slotCatalogVersion": "dsh-client-slots/v1"` |

**教训**：这不是"没生效"，而是**被静默过滤**。判定入口是花名册的 `statuses[].reason`，不是包状态。
**副产品**：确认了 `workbench.panel` 必须通过 `isWebClientModuleSlotName`，而 DSH 槽位必须带目录版本 —— 即 §8.2 的字段是**必需**的，我先前"先不加、作为差异测试项"的取舍是错的。

### G.1 另一个副产品：capabilityHash 覆盖客户端描述符

| 编号 | 观察 | 依据 |
|---|---|---|
| P0-F38 | 只改了**描述符**（加 `slotCatalogVersion`）与版本号，`capabilityHash` 就从 `208dbf19f9…`（0.1.0）变成 `7b0a1331…`（0.1.1） | P0 home 的 `daemon/package-operations/operations.json`：0.1.0 的 trust/enable 记录 vs 0.1.1 的 install 记录 |

**含义**：capabilityHash **不只覆盖 `services`**，也覆盖客户端描述符字段 →
**改动描述符 = 新的能力摘要 = 必须重新 trust**。这也解释了为什么"更新包"必须走 install/trust/enable 三步而不是只覆盖文件。

## H. P0-1 / P0-2 验收结果（2026-10-05，本机通过）

**环境**：独立 home `D:\agh-p0-home`（用 `AGH_HOME` 设定），实例端口 **4181**，与主实例 4180 并存；工作区 `D:\agnes-harness`。
**包**：`@agh-p0/wiring-probe@0.1.1`（`file:./.agnes/work/p0-wiring-probe`），`desired=enabled / actual=running / trusted=true`。

| 判据 | 结果 | 依据 |
|---|---|---|
| 客户端模块被浏览器加载并执行 | ✅ | 组件渲染，槽位 `data-slot-state="ready"`、条目 `ready` |
| **宿主 import map 提供 `react`** | ✅ | 客户端入口 `import { createElement, useCallback, useEffect, useState } from 'react'` 成功（§8.3 假设成立） |
| 描述符 slots / services 生效 | ✅ | 花名册 declarations：`slots:["shell.overlay","workbench.panel"]`、`services:["p0.bump","p0.counter"]`、`backendRowId` 正确 |
| **query 链路** client-web → BFF → daemon → Host | ✅ | `audit/host.jsonl`：`service=p0.counter kind=query mode=call outcome=ok` |
| **effect 链路 + 宿主授权** | ✅ | `service=p0.bump kind=effect mode=call outcome=ok`；用户看到 `window.confirm` 确认框 |
| **effect 持久 journal** | ✅ | `command_journal` 1 行：`kind=client-module.effect`、`binding_algorithm=agnes-command-jcs-sha256-v1`、`session_id=client-module:web:@agh-p0/wiring-probe:<sessionId>` |
| **工具与服务共享同一实例** | ✅ | 工具 `moduleId=517437f8-cbfb-4d43-bb90-c763092f3c94` 与 journal 记录**完全一致** |
| **工作区路由一致** | ✅ | 服务侧 `sctx.cwd=D:\agnes-harness`→`d:/agnes-harness`；工具侧 `tctx.cwd` 同值 → 同一 `workspaceKey` |
| 同一份状态 | ✅ | `counter=1`/`bumps=1` 由 effect 更新，工具读到同值；`serviceReads=1`/`toolReads=1` |
| **`ToolContext.session.key` 可作 owner** | ✅ | 工具返回 `sessionKey=1451df13-97f2-46f8-b659-d4723027838d`，与会话列表一致（§6.2 前提成立） |

**尚未做的 P0 项**：③ 实际启动链（审批 + `confine` + L0 真实 GUI）④ 真实图片链 ⑤ 实际文件链。

## I. P0-3 实测：Blender 启动链（2026-10-05）

### I.1 Stage A —— 不经过 AGH，直接用固定 argv 起一次（已通过）

实际命令行（本机实测）：

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --factory-startup --disable-autoexec
  --python-exit-code 1 --python <包>/extensions/main/bridge/bootstrap.py
  -- --agh-bridge-config <instanceDir>/bootstrap.json
```

| 编号 | 判据 | 本机结果 |
|---|---|---|
| P0-F39 | 版本发现 | `Blender 5.2.2 LTS`，build hash `d13f752e3b9c`，与 §2 本机事实一致 |
| P0-F40 | 真 GUI（非 background） | `handshake.background=false`、`factoryStartup=true` |
| P0-F41 | 就绪耗时 | spawn → `/health` 200：**约 3.2 s**（含冷启动） |
| P0-F42 | `/health` 免鉴权 | 200，并显式回 `authRequired: true` |
| P0-F43 | `/hello` 强制 token | 无 token → **401**；带 `X-AGH-Token` → 200 |
| P0-F44 | **主线程执行** | `executedOnMainThread=true`、`mainThreadId=14136`（HTTP 线程只入队，`bpy.app.timers` 泵主线程）；`mainThreadTicks` 5→7 |
| P0-F45 | 默认场景可读 | `objectCount=3`：Cube(MESH)/Light(LIGHT)/Camera(CAMERA)，`scene=Scene` |
| P0-F46 | **用户偏好未被碰** | `%APPDATA%\Blender Foundation\Blender\5.2\config\userpref.blend` 的 `LastWriteTimeUtc` 前后都是 `10/05/2026 01:44:57` |
| P0-F47 | 关闭链 | `POST /shutdown` → `{ok:true,closing:true}`，2 s 内退出（`alive=False`） |
| P0-F48 | **fail closed 生效** | 首次跑时配置带 BOM → `json.load` 抛错 → 因 `--python-exit-code 1`，Blender **带非零码退出并打印回溯**，没有留下"窗口开着但没桥"的假成功 |

**副产品（要记住的）**：

1. PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM** → bootstrap 改为按 `utf-8-sig` 读，容错更稳。
2. `wm.quit_blender()` 会让 Blender 往 `%TEMP%\quit.blend` 写一份 session recovery。不碰用户工程与偏好，但**不是零写入**，记在这里。
3. 启动画面：bootstrap 只在会话内把 `view.show_splash = False`，**绝不 `save_userpref()`**。`--factory-startup` 下偏好只在内存里，一旦保存就会把出厂设置写进用户配置——这是必须守的红线。

### I.2 我自己的操作事故（记在台账里，避免重犯）

| 编号 | 事故 | 后果 | 修法 |
|---|---|---|---|
| P0-F49 | `Get-Content -Raw`（PS 5.1 默认按 ANSI 解码）读 `index.mjs` → 字符串替换 → `Set-Content -Encoding UTF8` 写回 | 文件里**全部中文变乱码**，Node 报 `SyntaxError: Invalid or unexpected token` | 用 `write` 工具**整文件重写**，再验 `IMPORT OK` + 扫乱码特征串。**规则：UTF-8 源文件绝不经过 PS 5.1 的 Get-Content/Set-Content 往返** |
| P0-F50 | 在同一个函数作用域里又声明了一个 `const EMPTY_INPUT` | 同作用域内**更早**的引用会撞 TDZ → 插件加载即抛错 | 改名 `PROBE_EMPTY_INPUT` |

教训：**装包之前先跑一次真 import 检查**。这次正是 import 检查抓到的 P0-F49。

### I.3 Stage B（经过 AGH）——进行中

`agh_blender_start` / `agh_blender_probe` / `agh_blender_stop` 已写入探针包 0.2.0，
必须经过真实 Host 才算数；要如实记录 `enforcement`、`rawArgv` vs `confinedArgv`、
`argvChanged`、`tokenEnforced`。**`enforcement.level='partial'` 不是失败，是事实。**

### I.4 Stage B 实测结果（2026-10-05 13:05，经过真实 AGH）

会话 `1451df13-97f2-46f8-b659-d4723027838d`（preset `standard-windows`、模型 `deepseek-flash`）。
证据来源：`agh export 1451df13… --format agnes`（120 行 JSONL，含 `tool/call`、`approval/*`、`effect/intent`、`tool/result`）。

| 编号 | 判据 | 本机结果 |
|---|---|---|
| P0-F51 | **审批门生效** | `tool/call` 里 `resolvedPolicy.requiresApproval:"always"`、`policyVersion:"static-v1"`、`policyHash d215fdad…`（说明 8 个 meta 键全过校验）；`approval/asked` 给出 4 个选项（allowed-once/session/permanent/rejected），`deadline` = +60 s（= `approval.timeout_ms` 默认 60000）；用户选 `allowed-session`，`approval/decided.verdict=allowed-session via=sync`，`scope=tool:agh_blender_start:execute` |
| P0-F52 | **`sandbox.confine` 放行** | `tool/result.enforcement = {"level":"partial","scope":["file"]}`。confine **没有拒绝**这次启动；但 `partial/file` 就是事实，不是 OS 级隔离 |
| P0-F53 | **GUI 真的起来了** | Blender pid 40924，`/health` 200，`blenderVersion 5.2.2 LTS`，`background:false`、`factoryStartup:true`；桥从 spawn 到就绪约 0.34 s |
| P0-F54 | **env token 足够** | 桥的 `handshakes=1` → 启动工具那次带 `X-AGH-Token` 的 `/hello` 成功了；`/health` 明文回 `authRequired:true` |
| P0-F55 | **argv 未被套壳（间接）** | 桥侧 `handshake.sysArgv` 就是 `blender.exe --factory-startup --disable-autoexec --python-exit-code 1 --python <snapshot>/bootstrap.py -- --agh-bridge-config <instanceDir>/bootstrap.json`，`sysArgv[0]` 仍是 blender.exe 本身。**但 raw vs confined 的直接对照这一轮丢了**（见 I.5），下轮补测 |
| P0-F56 | **实例活过了工具调用** | 0.5 s 后 `agh_blender_probe`：`source:"memory"`、`processAlive:true`、`/health` 200 → 命中同一模块实例的 Map，P0-1 的"同实例"性质在同一次运行里再次成立 |

### I.5 ⚠️ 本轮最重要的发现：`TOOL_OUTCOME_UNKNOWN` 会**吞掉整个工具结果**

**现象**：`agh_blender_start` 的 `tool/result` 变成
`{"isError":true,"code":"TOOL_OUTCOME_UNKNOWN","content":[{"text":"the outcome of agh_blender_start is unknown after dispatch"}]}`，
而磁盘上 `instance.json`/`port.json` 明明都写成了 → **工具其实跑完了，模型却什么也看不到**。

**根因（源码定位，不是猜）**：

1. `packages/core/src/effects/tool-dispatch.ts:157-165`：workspace 域工具走
   `isToolResult(result) ? {phase:'responded',result} : invalidObservation('workspace tool returned an invalid ToolResult')`，
   而 `invalidObservation` 返回 `{phase:'may_have_sent', error:E_ENVELOPE}` —— **不是抛错，而是"可能已产生副作用"**。
2. `isToolResult` 要求 `structured` 通过 `isJsonValue`；`isJsonValue`（同文件 49-59 行）：
   `typeof value !== 'object' → false` ⇒ **`undefined` 不是 JSON 值**；数字还要求 `Number.isFinite`；
   对象还要求 `Object.getPrototypeOf(value) === Object.prototype`。
3. 我的返回值里 `handshake.text = hello.ok ? undefined : hello.text` 命中 `undefined` ⇒ 整个结果被判非法。
4. `packages/core/src/step/tools.ts:1136-1147`：`phase==='may_have_sent'` 时 `ac.abort()`，
   且因 `isReadOnly:false` 判为 mutation，只能结算成 `TOOL_OUTCOME_UNKNOWN`；
   `unknownOutcomeMessage` 在 `!cause` 时正是那句 `the outcome of X is unknown after dispatch`
   ⇒ 说明 `timedOut=false && cancelled=false`，**既不是超时也不是取消**。

**结论（要写进 v1.1 的硬约束）**：

| 编号 | 约束 |
|---|---|
| P0-F57 | **工具返回值必须先过 `JSON.parse(JSON.stringify(x))`** 再放进 `content`/`structured`：它一次消灭 `undefined`、`NaN`/`Infinity` 和非普通对象。这是"结果静默作废"的唯一防线 |
| P0-F58 | **副作用型工具不能把唯一一份结果放在返回值里**：`isReadOnly:false` 的工具一旦被判 `may_have_sent`，结果永久变成 "unknown"，而且**不抛异常、不写日志**。所以 `agh_blender_start` 必须**先把报告落盘**（`<instanceDir>/start-report.json`）再返回，返回值只是方便读的副本 |
| P0-F59 | 结果的可信来源是**磁盘报告 + `/health` 自查**，不是模型上下文里的那段 JSON |

### I.6 另外两条会影响分发形态的本机事实

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F60 | **插件是"复制 + 内容寻址快照"加载的**：源目录被复制到 `<home>/data/profiles/local-dev/packages/@agh-p0__wiring-probe/`，运行时真正 `--python` 的是 `.runtime-snapshots/sha256-c5242f66…/extensions/main/bridge/bootstrap.py` | 桥侧 `handshake.sysArgv[5]`；两处 `Get-FileHash` 与源一致 |
| P0-F61 | **`capabilityHash` 不覆盖 `registerTool`**：0.1.1→0.2.0 新增 3 个工具后 `capabilityHash` 仍是 `7b0a1331…`（而 0.1.0 加 `slotCatalogVersion` 时从 `208dbf19…` 变了）；`integrity` 变了（`a8b96833…`→`c80806ad…`），所以仍要重新 `trust` | `data/daemon/package-operations/operations.json` 的 install 记录 |

**含义**：信任摘要覆盖 `services` 与客户端描述符，**不覆盖工具名**。这不代表能绕过审批
（每次工具调用仍各自过 `requiresApproval`，P0-F51 已实测），但"信任摘要"与"工具集合"是两回事，文档必须写清楚。

## J. P0-3 最终判词：**通过**（2026-10-05 16:18）

### J.1 三方证据（互不依赖）

| 来源 | 内容 |
|---|---|
| 桥侧（Blender 内部） | `handshake.executedOnMainThread=true`、`mainThreadTicks` 持续增长、`objects = Cube/Light/Camera` |
| Node 侧（磁盘） | `<workspace>/.agh-blender/instances/da6bba63-…/start-report.json` 与 `instance.json` |
| Host 侧（ledger） | `agh export`：`tool/result` 的 **`origin` 是 `tool:agh_blender_start`、`isError:false`**，`effect/settled outcome:"ok" durationMs:3167` |

### J.2 判据逐条

| 编号 | 判据 | 结果 |
|---|---|---|
| P0-F62 | `sandbox.confine()` 对固定 argv 放行 | ✅ `enforcement = {"level":"partial","scope":["file"]}` |
| P0-F63 | **rawArgv 与 confinedArgv 逐字相同**（真实宿主下的直接对照） | ✅ 两串完全一致，`confinedArgv[0]` 就是 `blender.exe` 本身——没有套壳、没有降级 |
| P0-F64 | 真 GUI 打开且不读用户配置 | ✅ `background:false`、`factoryStartup:true`；`userpref.blend` 未被写 |
| P0-F65 | 随机端口 + 仅 loopback | ✅ 端口 64235 由 `pickFreePort` 选出，绑 `127.0.0.1` |
| P0-F66 | token 只经环境变量 | ✅ `tokenEnforced:true`；`tokenFingerprint 2d6e5bfabb95261e` = `instance.json.tokenSha256Prefix`；**token 明文从未落盘、从未进会话** |
| P0-F67 | 主线程执行 | ✅ `/hello` 报 `executedOnMainThread:true`、`mainThreadId 50332`；`mainThreadTicks` 6→21（约 20 Hz 泵） |
| P0-F68 | 实例活过工具调用 | ✅ 约 4 s 后 `probe` 命中**同一** pid/port/instanceId，`source:"memory"`，`uptimeMs 1236` |
| P0-F69 | 审批门（且 session 级授权可复用） | ✅ 第一轮 `approval/asked → allowed-session`；**第二轮没有 `approval/asked`**，直接进 `tool/result` |
| P0-F70 | **结果不再被吞** | ✅ `tool/result` origin `tool:agh_blender_start`、`isError:false`、正文 5066 字符；对照第一轮那条 `origin:"system"`、`code:TOOL_OUTCOME_UNKNOWN`、58 字符。两次 `tool/call.policyHash` 同为 `d215fdad…`（工具定义没变） |
| P0-F71 | 落盘报告可用 | ✅ `probe.diskStartReport` 与 `start` 返回值一致；**旧实例目录 `b6742399-…` 没有 `start-report.json`**——正是"结果被吞后无从追查"的对照 |

### J.3 `tctx.timeoutMs` 的真值

工具看到的是 **118000 ms**（不是 120000）→ preset `tools.timeout_ms` 默认 120000，调用侧留了 2 s 余量。
**这反过来证明第一轮被吞不是超时**：当时只过了 2.76 s。

### J.4 对 v1.1 的三条硬结论

1. **推荐形态在本机成立**：`--factory-startup --disable-autoexec --python-exit-code 1 --python <bootstrap> -- --agh-bridge-config <json>` + env token，
   可以经 `sandbox.confine()` 拉起真 GUI，且 `argvChanged=false`。**不需要**让用户安装 Blender 扩展。
2. **但 enforcement 只有 `partial/file`**：confine 给的是文件范围的"部分"约束，**没有**进程/网络隔离。
   按文档自己的标准，这属于"必须如实显示等级"，**不属于**阻断交付。
3. **两条返回值规则必须写进规范**（见 P0-F57 / P0-F58）：JSON 归一化 + 副作用型工具的报告先落盘。

### J.5 遗留与清理

| 项 | 状态 |
|---|---|
| 两个 Blender 实例 | `b6742399…`(pid 40924) 的 token 已随模块重载丢失，只能手关；`da6bba63…`(pid 48920) 可由 `agh_blender_stop` 正常停 |
| 探针包 | `@agh-p0/wiring-probe@0.2.1`，`enabled / running / trusted`，注册 4 个工具 |
| `.agh-blender/` | 已加入 `.gitignore` |
| 下一项 | P0-4 真实图片链（GPUOffScreen → 标准库 PNG → 私有缓存 → query → 显示 → tool artifact） |

## K. P0-4 图片链：前半段通过，媒体面受阻（2026-10-05 16:28）

### K.1 P0-4a 通过 —— 桥侧离屏渲染 + 自写 PNG

判据：**两套独立实现对账**（编码在 Blender 的 `zlib`+`struct`，解码是我另写的 Node 解码器，并校验每个 chunk 的 CRC）。

| 量 | Blender 侧 | Node 独立解码 |
|---|---|---|
| P0-F72 | `sha256` | `a43b358bc0839e1e`（91154 B，色管开）/ `021cd53c…`（68639 B，色管关） | 同 |
| P0-F73 | 顶带 / 底带均值 | 69.225 / 64.439 | **逐值相同** |
| P0-F74 | 中间行前 12 像素 | `[63×9, 75,75,75]` | **逐值相同** |
| P0-F75 | 不空白 | `distinct colours = 168`、红通道 0..255 | 同 |
| P0-F76 | **方向正确** | 顶带 69.2 > 底带 64.4（主题向底部变暗） | 同 |
| P0-F77 | 「一次颜色管理」有效 | `do_color_management` 开/关：69.2 vs 14.6，91 KB vs 68 KB | — |
| P0-F78 | IHDR 合法 | `640x360, bitDepth 8, colorType 2, filter 0, interlace 0` | 解码器强制校验通过 |

`gpu.types.GPUOffScreen` 在 5.2 的签名已实测确认（不是猜）：
`draw_view3d(scene, view_layer, view3d, region, view_matrix, projection_matrix, *, do_color_management=False, draw_background=True)`；
`read_color(x, y, xsize, ysize, channels, slot, format, *, data=None)` 返回左下原点的行 ⇒ 必须自行翻转一次。
另：background 模式下 GPU 未初始化，需要 `gpu.init()`；`/capture` 因此**要求 GUI**（需要真实 `SpaceView3D` + `WINDOW` region）。

### K.2 P0-4b：`put` 成功，但请求媒体面读不回来

真实会话（4181，`deepseek-flash`）跑 `agh_blender_capture` 的结果：

```
E_STEP_FAILED · 6.0 s
artifact 85657c6161e9c4a1e2d6b78184a7ac03d98aa9ff871bb10ed33b4fde826be46e could not be read
```

| 编号 | 观察到的事实 | 依据 |
|---|---|---|
| P0-F79 | **PNG 是真的产出了** | `<workspace>/.agh-blender/instances/0bee7749-…/captures/f197418b-….png`，393424 B |
| P0-F80 | **`tctx.artifacts.put` 真的写进去了**（字节完全一致） | `D:\agh-p0-home\data\artifacts\sha256\85\85657c61…`：长度 393424，`Get-FileHash` = 文件名本身，前 8 字节是 PNG 签名 |
| P0-F81 | 失败发生在**读**，不在写 | 报错来自 `packages/core/src/orchestrator/request-media-surface.ts`：`readArtifact(request)` 抛错 ⇒ `fail('ARTIFACT_BYTES_MISSING', ...)` |
| P0-F82 | 读取请求的形状是**会话作用域**的 | 同上：`request = {…authority, nodeSeq, sha256}`，`authority = {sessionKey, lane, signal}`；读取器类型 `TrustedSessionArtifactRead`（`packages/daemon/src/local/artifact-read.ts`） |
| P0-F83 | 不是"文件不存在"，也不是"太大" | `data/artifacts` 下**只有我们这一个 blob**（无 sidecar）；同类错误码另有 `artifact_too_large` / `artifact_not_found` |
| P0-F84 | 图片块的**类型转换是通的** | 媒体面对 `block.type === 'image'` 会直接 `fail('INLINE_IMAGE_UNSUPPORTED')`；我们拿到的是 `ARTIFACT_BYTES_MISSING`，说明块已被翻译成 `resource_link`，卡在读字节 |

**当前最可能的根因（待证，不是结论）**：该 artifacts 存储带 `computer-use-artifact-mutation-lock.db`，
错误码里有 `artifact_reclaimed`、注释写着 "screenshot retention" ⇒ 这条读取通道看起来是**为 computer-use 截图设计的会话级通道**。
工具通过 `artifacts.put` 写入的字节可能**没有被登记进这个通道**在意的索引里（或缺少 owner/retention 记录），
因此 `put` 成功、blob 存在，但按 `sessionKey` 读时被判不可读。

**下一步探针（待做）**：
1. 换块形状再试一次：返回 `{type:'ref', ref, mime}` 而不是 `{type:'image', ref, mime}`（排除翻译层差异）。
2. 看 `TrustedSessionArtifactRead` 的准入条件（谁构造它、是否校验 owner/retention）。
3. 若确认该通道只服务截图类产物，则 v1.1 的"图片经 tool artifact 进模型"要改成**别的落点**（例如把 PNG 交给 Host 的 fs + 由资源系统登记），并把这条写进 §3.7。

### K.3 探针 2：闸门找到（`packages/daemon/src/local/artifact-read.ts`）

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F85 | 读取请求带**四元组**：`{sessionId, laneId, ownerId, sha256}`（缺一个都拒） | `artifact-read.ts:456` `exactOwn(requestValue, ['sessionId','laneId','ownerId','sha256'])` |
| P0-F86 | 真正的判据是 **owner 绑定一致** | `artifact-read.ts:484` `authority.ownerId !== request.ownerId` → 拒绝；`authority` 来自**受信的会话主体权威**，不是请求数据 |
| P0-F87 | owner 来源是 `SessionPrincipalOwnershipIndex`，注释写明「**待决预留从来不是 owner**」 | `supervisor/artifact-read.ts:11,42` |
| P0-F88 | 核心侧只给了 `{sessionKey, lane, nodeSeq, sha256}`，**没有 ownerId** | `request-media-surface.ts:287` 的 `request` 构造 ⇒ ownerId 必须由 daemon/Host 侧按会话绑定补上 |
| P0-F89 | 同一条通道的注释点明用途：`TrustedArtifactReclaimed` = "**screenshot** retention reclaimed" | `artifact-read.ts:72` |

**由此收敛出的结论（仍是假设，但已缩到一处）**：`artifacts.put` 写入时**记录的 owner**，与读取时**按会话主体推出的 owner** 不是同一个
⇒ `authority.ownerId !== request.ownerId` ⇒ 读拒绝 ⇒ 核心报 `ARTIFACT_BYTES_MISSING`。
工具是在 `executionDomain: 'workspace'` 的 workspace invocation 里跑的，这一步很可能就是 owner 不一致的来源。

**待读的最后一个文件**（确认 ownerId 到底取自"会话主体"还是"产物登记"）：
`packages/daemon/src/supervisor/artifact-read.ts` 第 200~260 行（`createTrustedSessionArtifactReadHandler` 的调用点与 authority 装配）。

### K.4 探针 2 收口：**可登记**（分支 B）

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F90 | 读取链上有**两个不同的索引**：`artifactAuthority: PersistentArtifactReadAuthorityIndex`（"Dedicated durable artifact authority index"，管**归属**）与 `sessionOwnership: SessionPrincipalOwnershipIndex`（会话主体权威，用于校验读归属）；另有一个 `writer: ArtifactAuthorityProjectionWriter` 负责把归属**投影**进那个持久索引 | `packages/daemon/src/supervisor/artifact-read.ts:38-49` |
| P0-F91 | 字节存储与归属登记是**分开**的：`createLocalArtifactReadStore({dataDir})` 只管字节（我们的 blob 就在那，完全正确），能不能读由归属索引决定 | 同上 207-212 行 |

**结论**：`tctx.artifacts.put` 把字节写进了 store，但**没有以该会话主体身份写入 artifact authority 索引** ⇒ 读时查不到归属 ⇒ 拒读。
这解释了全部现象：**写成功、字节一致、路径正确、大小正常、块类型翻译正确，唯独读不回来**。
⇒ v1.1 的"图片经 tool artifact 进模型"在本机 AGH 上**需要额外一步登记**，不是 `put` 一个调用就能完成。

**下一轮**：找 `ArtifactAuthorityProjectionWriter` 的调用方 —— 看有没有"工具侧可用、且带登记"的 put 路径。
有 ⇒ 改一行；没有 ⇒ P0-4 改投递落点（Host `fs.write` + 资源登记），并把"图片不经 tool artifact"写进 §3.7。

### K.8 会话中毒实验：挪开字节**不能**救（2026-10-05 20:32）

**背景**：旧会话（`1451df13…`）因历史里挂着读不回的 `resource_link` 而永久 `E_STEP_FAILED`，任何输入（含 `hello`）都在组装请求阶段（约 10 ms）就死。

**实验**：把该 artifact 的字节从内容寻址路径移开
（`data/artifacts/sha256/85/85657c61…` → `…unreadable-backup`），再在同一会话发一句 `hello`。

| 编号 | 结果 | 含义 |
|---|---|---|
| P0-F128 | **报错完全一样**：`artifact 85657c61… could not be read` | 失败**不在文件 IO**，而在读取前的**校验**（归属/索引层）⇒ 与 §K.4 归属未登记的结论一致；"文件丢失"这条解释被排除 |
| P0-F129 | 媒体面里那条"已回收"优雅路径（`REQUEST_MEDIA_ARTIFACT_RECLAIMED` → 跳过）**没有被触发** | 单纯移除字节 ≠ 回收；该路径需要存储层给出回收标记，外部挪文件做不到 |
| P0-F130 | 字节已放回原路径（未留半改动） | 该产物仍读不回，但保持存储一致，不做无谓改动 |

**产品结论（要写进 §8.1）**：**工具产出的图一旦进入 `tool/result`，那条会话即永久不可用，且没有任何补救手段** ——
不能靠删字节、不能靠重新 `put`、不能靠改块形状。因此"把工具产出的图放进 tool/result"必须被**绝对禁止**；
图片的受众只能是**人**（客户端面板）。

## N. ⚠️ 重大更正：上游更新后，"模型能看图"成立（2026-10-05 20:53）

**背景**：仓库从 `c1180fc0` 快进到 **`7819b23c`**（13 个提交，163 文件）。其中包含
`feat/web-attachments-model-picker`：新增 `packages/core/src/request/user-message-images.ts`、
`packages/web-units/src/composer.ts`（+754 行）、`packages/web-units/test/composer-images.test.ts`（+489 行）、
`packages/web-ui/src/conversation/messages.tsx`、`packages/protocol-validation/src/safe-image.ts`。

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F131 | 旧前端确实**没有**粘贴入口：`app.js` 里 `clipboardData` 命中 0、`image/png` 0 | §M 的实测（基于旧构建） |
| P0-F132 | 新构建的前端**有**了：重建后 `app.js` 824483 B（旧 755193），`clipboardData` **1**、`image/png` **4**、`attachments` 47；**仍没有** `type="file"`/`upload`/`DataTransfer` | 从 4181 取回真实 bundle 后计数 ⇒ 新版支持的是**粘贴**，不是文件选择/拖拽/上传 |
| P0-F133 | **用户上传的图真的进了会话，而且是 inline base64** | `sessions.db` 会话 `37c500ee…` 的 `events`：`seq 30 user/message origin=principal`，`content` 块类型 `text,image`，image 块是 `{"type":"image","data":"iVBORw0KGgo…"}`（PNG 签名） |
| P0-F134 | **它走的不是媒体面/artifact 通道** | 同会话 `seq 36 request/header` 的 `media` 仍是 `{version:1, route:"text-only", selectionOrder:[], manifest:[]}` ⇒ 图片由 **user 消息内容**直接携带，与 `artifact://` 那条路无关 |
| P0-F135 | 模型确实读取了像素（非文本猜测） | 模型答出画面细节（人像特写、深色背景、伦勃朗侧光、格纹衬衫、针织开衫，且明确拒绝编造头身比） |

**结论**：
1. §M 的"协议层从未实现附件"**只对 `c1180fc0` 成立**，已作废；上游 `7819b23c` 已提供。
2. 两条图片通道**性质不同**，必须分开记：
   - **用户上传** → inline image block（`user/message`）⇒ **可用**
   - **工具产出** → 必须经 `artifact://` + 媒体面 ⇒ 仍被 `origin === 'tool:computer_use'` 关闭
3. 因此"人在环"**不再是唯一解**：模型可以看图，(B) 那一环由"人做"降级为"可选"。

**仍未解决（不属于这次更正范围）**：(A) 多视角参考图仍需外部 3D 生成模型；工具产图进模型仍不可用（P0-F79~F91、P0-F128~F130）。

## O. 第 ⑤ 环收口：相对贴图夹具实测（2026-10-05 21:40）

**夹具**：`p0-texfixture/proj/scene.blend`，贴图设为相对路径 `//assets/tex.png`（真实 PNG 复制到 `proj/assets/`）。
用 `agh_ops.OPS['file.checkpoint']` / `['file.stage_export']` **直接调用 op 函数**（bypass HTTP，检验 op 实现本身）。

| 编号 | 判据 | 结果 |
|---|---|---|
| P0-F136 | checkpoint 不动主文件 | `mainFileUntouched=True`、`bytes=594726` |
| P0-F137 | **checkpoint 副本的相对贴图指回原资源** | 副本里 `filepath` 被改写为 `//..\..\proj\assets\tex.png`，解析到 `…\proj\assets\tex.png`，**`exists=True`**（副本在 `instance/checkpoints/`，与原工程是不同目录树） |
| P0-F138 | stage_export 报告相对依赖而不是静默改写 | `relativeImages=1`，`relativeWarning` 文本存在；`mainFileUntouched=True`、`bytes=594726` |
| P0-F139 | **checkpoint 会改写运行中会话的内存贴图路径**（新发现） | 对照组本应是 `//assets\tex.png`，实测却是已被 checkpoint 改写的 `//..\..\proj\assets\tex.png` ⇒ `save_as_mainfile(relative_remap=True)` **会变更 in-memory 的 `image.filepath`** |
| P0-F140 | 因此"对照组"无效（诚实标注） | `remap=False 且跨目录 → 指向空目录` 这条早先已由独立运行验证（P0-F32~F36）；**本次的 control 因继承已改写值而不构成对照**，不要引用它 |

**要写进 §3.7 的新约束**：**checkpoint 不是纯读操作** —— 它会把当前会话的 `image.filepath` 重映射。
功能上无害（仍解析到原资源），但它改变了会话状态，所以：① 规范里要写明；② 若将来需要"checkpoint 前后会话状态不变"，必须用 `copy=True` 之外的手段（或记录并接受这个副作用）。

## P. 发布形态（B）：进度、坑、当前卡点（2026-10-05 21:56）

### P.1 已就位

正式包在 `D:\agnes-harness\.agnes\work\agh-blender\`（**注意：`.agnes/` 被 gitignore，commit 不上去**）：

| 文件 | 说明 |
|---|---|
| `package.json` | `name agh-blender`、`id ext:agh-blender/runtime`、`license GPL-3.0-or-later` |
| `README.md` | 对外说明：需求 / 安装 / 8 工具表 / 原理 / 安全模型 / 诚实局限 |
| `LICENSE` | GPL-3.0 全文（本机取自 Blender 发行包内的 gpl-3-0.txt） |
| `docs/DESIGN.md`, `docs/P0-EVIDENCE.md` | 规范与台账的副本（**会滞后，更新时记得同步**） |
| `extensions/main/index.mjs` | **8 个工具 + 1 个服务**（探针服务与 `p0_read_counter` 已删） |
| `extensions/main/agnes.client.json` | 服务白名单 `["blender.status"]`，`rowId = ext:agh-blender/runtime` |
| `extensions/main/client/index.js` | 正式面板：实例 pid/端口/存活/版本 + refresh |
| `extensions/main/bridge/*.py` | bootstrap / agh_ops（10 op）/ agh_capture |

清洁度：`__pycache__/*.pyc`（43KB）已剔除；上线前自检 `p0-publish-check.mjs` 结果 **failures: 0**。

### P.2 坑：`clientDescriptors[].rowId` 必须等于插件行 id

| 编号 | 事实 |
|---|---|
| P0-F141 | `clientDescriptors[].rowId` 写成任意名字（如 `agh-blender`）时，描述符挂不上任何插件行 → `package inspect` 直接报 **`E_PACKAGE_STATE: The package operation cannot run in the current state.`**，**报错里完全不提 rowId**。必须写成 **`ext:<name>/runtime`**（与 `agnes.plugins[].id` 一致）。用变量对照法排除（先怀疑 `"private": true`，实测不是） |
| P0-F142 | 旧探针包 `@agh-p0/wiring-probe` 已 `disable` + `remove`（避免与正式包同时注册面板） |

### P.3 ⚠️ 当前卡点：`trust agh-blender` 被拒

```
package trust agh-blender <integrity> <capabilityHash>  →  E_PACKAGE_TRUST
safeMessage: The package does not meet the required trust policy.
记录里 blockers: []          ← 策略判定拒绝，不给理由
```
- 包**已安装**（`desired=installed-disabled`），只是 trust 不过 → 无法 enable。
- 与"trust 成功的探针包"相比，**只有两处实质差异**：
  1. `license`：探针 **MIT** ↔ 本包 **GPL-3.0-or-later**
  2. `name`：探针 `@agh-p0/wiring-probe`（**带 scope**）↔ 本包 `agh-blender`（无 scope）
- 早先 lock 记录里出现过 **"trusted MIT status"** 字样 ⇒ **许可可能是信任策略的一部分**。
- **若确认为许可** ⇒ 这是产品级发现：**GPL 代码可能进不了 AGH 的信任策略**，"整仓 GPL"必须重新决策。
- **判定位置**：`packages/daemon/src/packages/handler.ts`（已找到 E_PACKAGE_TRUST 的含义表，真正的策略判定函数**还没读到**）。

**最短验证（每次一个变量，一次 `y`）**：
1. `license` 改 `MIT`、name 不变 → 装 + trust ⇒ 通过则是**许可**
2. 否则 name 改 `@<scope>/agh-blender` 再试 ⇒ 通过则是 **scope**

> 更好的办法：先在 `packages/daemon` 里找到 trust 策略的实现读一遍（不用装包就能定论）。

### P.4 待办（按优先级）

| 优先级 | 项 |
|---|---|
| P0 | 解决 trust 被拒（否则装不上） |
| P0 | 把 P.2/P.3 两条写进 **包内** `docs/DESIGN.md` §9（包内文档已滞后） |
| P1 | `file.open` / `open`/`recover`（打开已有 .blend；目前只能从默认场景起步） |
| P1 | 孤儿实例优雅停止（方案在 §9.y，未实现） |
| P2 | 姿态打磨（`object.transform` 摆关节）、更多 opcode |
| P2 | 面板做实（现在只有 pid/端口/存活） |
| P3 | §7.1 状态行仍按 P0-x 编号，已过时 |
| P3 | 发布仓库位置未定（`.agnes/` 不可提交；建议独立 `D:\agh-blender\`，写工作区外需批准） |

### P.5 卡点定论：**license 不在信任白名单**（2026-10-05 22:10）

> §P.3 的卡点已解。答案**既不是 workspace 信任丢失，也不是 scope，也不是"层"或能力集**。
> 抛出点是 `E_PACKAGE_QUARANTINED`（**license 白名单**），只是在对外换算时被折成 `E_PACKAGE_TRUST`，
> 而 `blockers: []` 是**设计使然**，不是"策略拒绝不给理由"。

#### P.5.1 两个错误码的真实抛出点（源码，HEAD `7819b23c`）

`packages/package-manager/src/errors.ts:5-12` 把两个 legacy code 映射到**同一个对外码**：

```ts
E_WORKSPACE_UNTRUSTED: 'E_PACKAGE_TRUST',
E_PACKAGE_QUARANTINED:  'E_PACKAGE_TRUST',
```

⇒ **对外码无法区分两者**，必须回到 legacy code 才能定论。全部抛出点：

| legacy code | 抛出点 | 判据类别 |
|---|---|---|
| `E_WORKSPACE_UNTRUSTED` | `trust-gate.ts` 无（该文件只抛 QUARANTINED / API_RANGE / CEILING） | — |
| `E_WORKSPACE_UNTRUSTED` | `lifecycle.ts:79`、`lock-state.ts:82`、`inventory.ts:147/210`、`manager.ts:775` | ① **决策/快照与 lock 不一致**（integrity 或 capabilityHash 对不上） |
| `E_WORKSPACE_UNTRUSTED` | `manager.ts:761/807/817/1033` | ② **状态或策略不允许**（builtin 不可 untrust / 无信任决策 / profile 策略 deny） |
| `E_WORKSPACE_UNTRUSTED` | `manager.ts:303/308`、`workspace.ts:48`、`workspace.ts:155`（`verifyWorkspace` 的 `not-signed-off`） | ③ **workspace 部署目录相关**（不可读 / 不在 profile 内 / 无签名 workspace 段） |
| `E_PACKAGE_QUARANTINED` | **`trust-gate.ts:59`** | **license 不在 allowlist** |
| `E_PACKAGE_QUARANTINED` | `trust-gate.ts:67` | release-age 隔离期未满 |

#### P.5.2 判据是 LICENSE_ALLOWLIST —— 且它不包含任何 GPL 变体

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F143 | `LICENSE_ALLOWLIST` = **MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, MPL-2.0, Unlicense**（8 项，**无 GPL 任何变体**） | `trust-gate.ts:9-18` |
| P0-F143 | 该闸门只读一个字段：`entry.license`（来自包 `package.json` 的 `license`，经 `entryFrom` 落到 lock：`manager.ts` 的 `license: pkg.license`） | `trust-gate.ts:58`；`manager.ts` `entryFrom()` |
| P0-F143 | 闸门**顺序固定**：license → release-age → apiRange → capability ceiling。license 是**第一处**，后面的能力集再合法也走不到 | `trust-gate.ts:57-91`；`test/trust-gate.test.ts:44-54`（单测名就是 "checks license before API range and capability ceiling"） |
| P0-F144 | **"层"不可能是卡点**：`layer` 字段只存在于 `PackageErrorSource`，而 `manager.ts` 里**没有任何一处**给抛出的 `PackageError` 传 `source` ⇒ `PackageErrorSource` 从未被设置 | `errors.ts:16-20`；`manager.ts` 全文 |
| P0-F144 | **"能力集"也不可能是卡点**：能力集超限走 `E_CEILING_EXCEEDED` → 对外码是 **`E_PACKAGE_BLOCKED`**（不是 TRUST）；本包预览的 `capabilityDiff` 五个字段全为空 | `errors.ts:9`；`operations.json` 的 inspect 预览 |
| P0-F145 | **release-age 分支被整段跳过**：该分支要求 `source.type ∈ {npm, market}`，本包 `source.type = 'file'` | `trust-gate.ts:62`；lock |

#### P.5.3 两个可重跑核对器（互不依赖，均 exit 0）

| 编号 | 脚本 | 做法 | 用法 |
|---|---|---|---|
| P0-F146 | `p0-trust-cause.check.cjs` | 复刻 `canonical()`/`snapshotHash()`/`capabilityHash()`，对真实 lock + `operations.json` 逐条件求值；**含自校准**：用探针包历史 preview 的 capabilityHash 验证复刻正确 | `node p0-trust-cause.check.cjs <agnes-lock.json> <operations.json>` |
| P0-F146 | `p0-trust-gate-probe.test.ts` | **直接 import 真实 `runTrustGate`**（不是复刻）喂真实 lock 条目 | `node node_modules/vitest/vitest.mjs run .agnes/work/blender-workbench-spec/p0-trust-gate-probe.test.ts --maxWorkers=1` |

**实测实值**（两个脚本一致）：

| 量 | 值 | 判定 |
|---|---|---|
| `lock.integrity` vs `trust.expectedIntegrity` | 两侧同为 `sha256-2e07217c…1d0ff` | ✅ 一致 |
| 送入的 `capabilityHash` vs `capabilityHash(lock entry)` | 两侧同为 `7e7b2182ed1e108b…fda11ad` | ✅ 一致 ⇒ **`lifecycle.ts:73-79` 的 "trust decision differs…" 分支不会触发** |
| `entry.license ∈ allowlist` | `"GPL-3.0-or-later"` ∈ 8 项白名单？ **否** | ❌ **必然抛出** |
| `runTrustGate` 真实返回值（真实条目） | `legacyCode=E_PACKAGE_QUARANTINED` / `code=E_PACKAGE_TRUST` / `detail.reason="license"` / msg *"agh-blender has a license outside the allowlist"* | ❌ |
| 对照：仅把 license 换成 `MIT` | `PASS`（与 `minimumReleaseAgeMin`、ceiling 全无关） | ✅ |
| 对照：改出越界的 apiRange/能力集 | 仍先抛 `license`（不写路径改不了它） | ❌ |

`p0-trust-cause.check.cjs` 的自校准先跑通（两个探针包 preview 的 capabilityHash 逐字复算一致），才用它下判断。

#### P.5.4 结论

1. **抛出点是 `trust-gate.ts:59`（license 不在白名单）**，对外折成 `E_PACKAGE_TRUST`。
   `E_WORKSPACE_UNTRUSTED` 的全部 11 个抛出点逐个核对后**全部不适用**（决策一致、状态正常、无 workspace 段）。
2. **"重新授予"这件事不存在** —— §P.3 的假设（"工作区信任随旧包删除一起丢了"）**不成立**：
   本包 `source.type='file'`，lock 里**没有 `workspace` 段**；`trustWorkspace()` 走的是"宿主部署目录"那一整条线，与它无关。
   路径上也没有可用的"重新授予"开关：`manager.add()` 的 `trust:'verify'` 只影响是否**自动**盖 `state.trusted`，**它内部照样调 `runTrustGate`**，license 一样挡。
3. **`blockers: []` 是设计使然**：这两处抛点写的是 `detail.reason` / `detail.license`，
   而对外错误形状的 `blockers` 只从 `detail.blockers` 取（`daemon/src/packages/handler.ts` 的 `safeBlockers()`）；
   `detail.blockers` 只有"活动引用"类错误会填。所以**看不到理由不等于没有理由**。
4. **真正的唯一阻塞是一个产品级决定**：`package.json` 的 `license` 字段必须落在 8 项白名单内。

#### P.5.5 明确的选项（**属于发布决定，本轮未改任何文件**）

> ⚠ **本节已被 P.5.7 修正了一处**：原 A4 行（"去掉 `license` 字段"）**已实测证伪**，不再是可行选项。

| # | 选项 | 后果 | 诚实性 |
|---|---|---|---|
| A1 | 根包 `license` 改 `MIT`/`Apache-2.0`，删掉 `LICENSE` 里的 GPL 全文 | 必须重装（integrity 变）；`capabilityHash` **不变**（工具集合不参与摘要，P0-F61） | 仅当**没有** GPL 派生代码时成立。**但本包的 `.py` 会用 `bpy`（Blender 自己的 API）⇒ 是否存在派生是一个许可判断题，不是技术题**（见 P.5.7） |
| A2 | 保留 GPL，不发布为 AGH 包 | 走 `workspace:` 部署通道**也挡不住**：`trustWorkspace` 内部对每个扩展同样调 `runTrustGate`（`manager.ts:1066`） | — |
| A3 | 声明 `MIT` 但内含 GPL 文本 | **拒绝**（声明不实；且这份包会被分发到别人机器上） | ✗ |
| ~~A4~~ | ~~只带 `LICENSE` 文件、`package.json` 去掉 `license` 字段~~ | **已实测证伪（P.5.7）**：缺失字段同样被拒 | ✗ |

**建议**：先做 A1/A2 的**事实判定**（见 P.5.7 的三个具体问题），再决定许可；
这一步是**发布决定**，不是技术阻塞，本轮**不改任何仓库或包内文件**。

#### P.5.7 两处后续实测（2026-10-05 22:40）—— A4 证伪 + 白名单不可配置

| 编号 | 实测 | 依据 |
|---|---|---|
| P0-F147 | **`license` 字段缺失同样被拒**：`{...真实条目, license: undefined}` → `E_PACKAGE_QUARANTINED` / `detail.reason="license"`（注意 `detail` 里**没有** `license` 键，说明值确实是 `undefined`） | `p0-trust-gate-probe.test.ts`（真实 `runTrustGate`） |
| P0-F147 | **显式 `license: "UNLICENSED"` 同样被拒** —— 预览层会把缺失折成 `UNLICENSED`（`inspect.ts:285`），而那个值**也不在白名单里** ⇒ 缺失这条路的两种走向都死 | 同上；`inspect.ts:264-285` |
| P0-F148 | **白名单不可配置**：`runTrustGate` 的入参只有 `{id, entry, manifest, ceiling, now, minimumReleaseAgeMin}`；`LICENSE_ALLOWLIST` 是模块级 `const`（`trust-gate.ts:9`），**无任何覆盖参数** | `trust-gate.ts:49-56`；实跑打印入参键 |
| P0-F148 | ⇒ **本包 `extensions/main/bridge/*.py` 会随包一起分发，所以"拆许可"（Node 侧 MIT + Blender 侧 GPL）绕不开这道闸门** —— `root package.json` 只有**一个** `license` 字段，而 `"MIT AND GPL-3.0-or-later"` 这类组合表达式**也不在白名单里** | `trust-gate.ts:58`（只做精确成员判定） |

**依赖审计（P0-F149，纯 `import` 扫描，不构成法律意见）**：

| 文件 | 导入 |
|---|---|
| `extensions/main/bridge/bootstrap.py` | `json os queue secrets sys threading time traceback` + `http.server` —— **纯标准库，不碰 `bpy`** |
| `extensions/main/bridge/agh_ops.py` | `math os `+ **`bpy`** |
| `extensions/main/bridge/agh_capture.py` | `array hashlib os struct time uuid zlib` + **`bpy`** |
| `extensions/main/index.mjs` | 仅 `node:child_process` / `node:crypto` / `node:net` / `node:path` / `node:url` + `@agnes/extension-api` 等宿主包 |
| `extensions/main/client/index.js` | 仅 `react`（宿主 import map 提供） |

**没有** import 任何第三方 GPL 项目（`blender-mcp` / Blender AI Agent 等均未引用，与 D2 一致）。
⚠ 但"未 import"**不等于**"未参考/未抄录"—— `import` 扫描只能证明没有直接依赖，**不能证明没有行级派生**。

**由此收敛出三个需要人来回答的问题**（我不做法律判断）：

1. `agh_ops.py` / `agh_capture.py` 里凡是**直接调用 Blender API**（`bpy.*`）的部分，是否构成 GPL 的派生作品？
   —— Blender 官方许可页对此的表述是：*"The GNU GPL license therefore requires that such scripts (if published) are being shared under a GPL compliant license."*
   （同时该页也留了口子：*"Under certain conditions, it is possible to make Blender, or scripts that make use of the Blender Python API (bpy), work with proprietary or commercial software."*）
   来源：https://www.blender.org/about/license/ （2026-10-05 抓取）
2. 有无**参考过 GPL 项目的具体代码**（不只是概念）？—— 这与题 1 独立，需人工回想/比对。
3. `bootstrap.py`（不碰 `bpy`）能不能拆出来单独用更宽松的许可？ → **能，但不改变 AGH 包只能有一个 `license` 字段这个事实**（P0-F148）。

## P.5.8 选项① 执行：v0.1.1 混合许可（2026-10-05 22:25，**本文件在包外，可以写死哈希**）

**用户决定**：采用选项①（混合许可）。根 `license` → `Apache-2.0`，`extensions/main/bridge/` 声明 `GPL-3.0-or-later`，版本 → 0.1.1。

### 逐文件核实：bridge 确实需要 GPL（P0-F149）

方法：对包内全部 `.py`/`.mjs`/`.js` 统计 `\bbpy\.` 实际引用数，并逐行看 import 与其在代码中的位置。

| 文件 | 行数 | `bpy.` 实际引用 | 首个 `import bpy` | 判定 |
|---|---|---|---|---|
| `extensions/main/bridge/bootstrap.py` | 420 | **17** | `L31`（带 `try/except ImportError`） | **需要 GPL** |
| `extensions/main/bridge/agh_ops.py` | 634 | **42** | `L16` | **需要 GPL** |
| `extensions/main/bridge/agh_capture.py` | 187 | **3** | `L19`（另有 `L22: import gpu`） | **需要 GPL** |
| `extensions/main/index.mjs` | 1133 | **0** | 无（仅 `node:*` + 宿主包） | 不需要 |
| `extensions/main/client/index.js` | 60 | **0** | 无（仅 `react`） | 不需要 |

`bootstrap.py` 的 `bpy` 调用是**实际行为**（不是注释）：`:111` `bpy.context.preferences.view`；`:122` `bpy.context.scene`；
`:128-135` `bpy.app.*` / `bpy.data.*`；`:177` `bpy.ops.wm.quit_blender()`；`:254`/`:396` `bpy.app.timers.register(...)`；
`:327` `bpy.ops.ed.undo_push(...)`；`:340` `bpy.context.view_layer.update()`。

> ⚠ **本轮先犯了一次错**：最初按"顶层 `import` 行"扫，把 `bootstrap.py` 归为"纯标准库、不碰 `bpy`"。
> 那行 `import bpy` 在文件中部的一个导入区内，不在文件头，而且文件头有一条 `try/except` 包着 —— 只看头部会漏。
> **纠正方法**：不数 import 行，数 `bpy.` **引用**。已在两版 DESIGN.md 的 §3.8 记档。

**第三方 GPL 派生审计（同轮）**：三个 `.py` 除标准库（+ `gpu`）外**只** import `bpy`；未出现 `blender-mcp`/BlenderKit 等项目名，
也未出现 `adapted from`/`based on` 类来源注释。⚠ `import` 扫描**只能证无直接依赖，不能证无行级抄录**。

### 本轮实际生成/修改的文件

| 文件 | 动作 |
|---|---|
| `package.json` | `license`: `GPL-3.0-or-later` → **`Apache-2.0`**；`version`: `0.1.0` → **`0.1.1`** |
| `LICENSE` | 换成 **Apache-2.0 全文**（11358 B，自 apache.org 抓取，非手写） |
| `LICENSE-GPL` | 新增，GPL-3.0 全文（35824 B，拷自原 `LICENSE`，即 Blender 发行包里那份） |
| `NOTICE` | 新增：说明哪个目录持哪份许可、为什么、以及范围限定 |
| `extensions/main/bridge/HEADER.txt` | 新增：给 `bridge/` 的机器可读副本 |
| `README.md` | `## License` 段重写（"两套声明，一个包"），并在 Repository layout 里补上三个许可文件 |
| `docs/DESIGN.md` | 新增 §3.10；§3.8 补全两条硬约束；§9 新增两条踩坑；§11 记录 |
| `docs/P0-EVIDENCE.md` | §P.4 待办更新 |

### ⚠ 自失效现象（P0-F151，本轮实测的坑）

`docs/` 在包**内** ⇒ **任何文档编辑都会改 `integrity`**。本轮因此多跑了一轮：

| 次序 | 事件 | integrity |
|---|---|---|
| 1 | 改 `package.json`/许可文件后 inspect | `sha256-7a378366…` |
| 2 | 随后又改了 **包内两份 docs** | ↑ 当场作废 |
| 3 | 再 inspect | `sha256-aa59f957…` |
| 4 | 又在包内 `P0-EVIDENCE.md` 写了上一轮哈希（自我矛盾） | ↑ 再次作废 |
| 5 | 把哈希改为"以最后一次 inspect 为准" + 在**包外**记真值 | `sha256-33348edf…` |

**规矩**：**不要把该包自己的 `integrity` 写进任何将被打包的文档**；要写就写"以最后一次 `package inspect` 为准"。
（本文件在包外，所以这里可以写死。）

### 冻结值（包内最后写入 2026-10-05 22:22:33；inspect 2026-10-05T14:22:36Z）

| 项 | 值 |
|---|---|
| version | **0.1.1** |
| license（预览回显） | **Apache-2.0** |
| **integrity** | **`sha256-33348edfb562e21369cdfcf5d51608d8f018f25688f767672e91494c895c1ef4`** |
| **capabilityHash** | **`7e7b2182ed1e108b78f8f721c9e1c988c7a02042510af11dfac138571fda11ad`**（与 0.1.0 **相同** ⇒ 印证 P0-F61：工具集合不参与摘要） |
| preview blockers | `[]` |

### 已执行 / 待执行（**全链已走完**）

| 步骤 | 状态 |
|---|---|
| `package disable agh-blender` | ✅ completed 100% |
| `package remove agh-blender` | ✅ completed 100%（remove 后包已不在 `package status` 中） |
| `package inspect` | ✅ v0.1.1 / Apache-2.0 |
| **`agh install <source>`** | ✅ **completed**（`14:25:47.369Z`；人类在 TTY 按 `y`） |
| **`package trust agh-blender <integrity> <capabilityHash>`** | ✅ **completed 100%，`trusted true`** |
| **`package enable agh-blender`** | ✅ **completed 100%，`desired=enabled actual=running trusted=true`** |
| **`host.jsonl` 确认 8 工具 + `blender.status`** | ✅ 见 P0-F152 |

**部署副本**：`data/profiles/local-dev/packages/agh-blender/`（14 个文件 291821 B）；
`client-modules/local-dev/_client-modules.json` 里 `agh-blender.current` = `sha256-33348edf…`，
`backendRowId: ext:agh-blender/runtime`（与插件行一致 ⇒ 未踩 P0-F141 那个静默错）。

### P0-F152 上架确认（host.jsonl，2026-10-05T14:26:21–23Z）

证据源：`D:\agh-p0-home\data\audit\host.jsonl`（**Host 侧账本，不是工具自报**）。

| 编号 | 判据 | 实测 |
|---|---|---|
| P0-F152 | `extension.loaded` | `package=agh-blender`、`version=0.1.1`、`id=plugin/42d5f5b313c99291` |
| P0-F152 | **工具注册数** | **8 个，全部 `extension.registered / kind=tool`**：`agh_blender_start`、`_probe`、`_stop`、`_capture`、`_apply_ops`、`_scene`、`_ops_catalog`、`_export`（与 `p0-publish-check.mjs` 的 `failures: 0` 逐字一致） |
| P0-F152 | 行号一致 | 全部落在 `row=ext:agh-blender/runtime` |
| P0-F152 | **`blender.status` 服务** | `extension.service-call` **4 行**（`14:26:23.895Z` 起）：`service=blender.status`、`kind=query`、**`outcome=["inspected","ok"]`** ⇒ **面板真的把服务调通了**（不是"实例里注册了但没人用"） |
| P0-F152 | 重载清场 | `14:26:21.5xx` 有旧探针包的 `extension.revoked`（`reason=unload`）⇒ 新旧包未同时注册面板 |

> ⚠ **一处残留（非阻塞，如实记）**：`_client-modules.json` 里仍留着 `@agh-p0/wiring-probe` 的旧 `declarations`（该包已 `remove`，且不在 `package status` 中）。
> 它不影响本包（两者 `rowId` 不同），但说明**花名册对已移除包不会自动清声明**；
> 以后若发现"面板上多出一个僵尸条目"，先查这个文件。

> ⚠ **包已安装后的纪律**：本文件在包外；**包内的 `docs/` 不能再动** —— 任何编辑都会改 `integrity`，
> 那就得重走一轮 `disable→remove→install→trust→enable`。所以本轮结果只回写到包外台账。

**本机 CLI 的两处差异（记下避免复现）**：

| 语句 | 结果 |
|---|---|
| `agh package install <source>` | ✗ `unknown package action install` —— **dist 里的 `bin.ts` 比 src 旧**（`src` 有 `p.command === 'install' ? ['add', ...]` 映射，dist 没有；dist 构建于 20:36，src 改于 10-04） |
| **`agh install <source>`** | ✓ 正确形式（`usage: agh install <source>`），README 里写的就是这个 |

> 合规提醒：我只替用户避免了一个**拼写歧义**（`package install` 不存在的子命令），
> **没有**替用户回答确认提示 —— 那是 `confirmPackageInstall` 的 TTY 门，设计上只能由人按 `y`（INV-33）。
> 另：`computer_use` 在本机不可用（P0-F120），所以我无法代开终端窗口。

## Q. v0.1.2：孤儿停止 + 文档出包（2026-10-05 23:05）

两个变更合并为一次安装（用户决定）：

| # | 变更 | 类型 |
|---|---|---|
| 1 | 孤儿实例**优雅停止**（token 已丢时走无 token 路径，PID 复用防护，绝不强杀） | 安全 |
| 2 | **`docs/` 移出包外**（删副本，README 改为指向包外） | 结构 |

### Q.1 许可决定（用户明确确认，落档）

用户原话（2026-10-05）：

> 我确认 `agh-blender` 采用 Apache-2.0（根）+ GPL-3.0-or-later（`extensions/main/bridge/`），这是我的决定。

⇒ 该声明现为**作者决定**，不再是"文档代做"。已同步到 `DESIGN.md` §3.10。
**连带承诺**（已告知用户）：再分发需同时保留 `LICENSE` 与 `LICENSE-GPL`；本项目**未做法律审查**，`import` 扫描不能证明无行级抄录。

### Q.2 孤儿停止的实现要点（P0-F153）

| 编号 | 要点 | 依据 |
|---|---|---|
| P0-F153 | `agh_blender_stop` 在**内存无句柄**时，读磁盘 `instance.json` 并改走无 token 路径；内存里有句柄时行为**不变**（走原有 `/shutdown`） | `index.mjs` `runStop()` 的 `if (!record)` 分支；回包带 `mode: 'graceful (tokenless)'` |
| P0-F153 | **PID 复用防护**：`instance.json` 新增 `processIdentity = {imageName, ticks, ticksRaw}`；发关闭前重新查，三项必须一致，否则拒并回报 observed/expected | 新增 `queryProcess()`；Windows 会复用 pid |
| P0-F153 | 身份读取：Node 侧 `Get-CimInstance Win32_Process` → `ManagementDateTimeConverter::ToFileTime`；**先过 `tctx.sandbox.confine()`**，拒绝则失败关闭（不静默无沙箱调用） | 新增 `queryProcess()`；`bootstrap.py` 侧 `_win32_creation_ticks()` 用 `ctypes` + `GetProcessTimes`（无子进程） |
| P0-F153 | 关闭用 `[Process]::CloseMainWindow()` + `WaitForExit(8000)`；回 `EXITED` / `STILL_RUNNING`；回包固定 `forceKilled: false` | 新增 `tokenlessStop()` |
| P0-F153 | **代码里不存在任何强杀路径**：全文件检索 `taskkill` / `Stop-Process` / `SIGKILL` 的命中均为**注释**（其中一条注释正是"never escalate to taskkill /F"） | 检索实测 |
| P0-F153 | 三个新函数都只读磁盘/只查进程；`tokenlessStop` 全程**不引用 token** | 检索 `X-AGH-Token`：命中均在其它工具，不在新路径 |

**预检与静态验证**（均通过）：

| 检查 | 结果 |
|---|---|
| `node --check index.mjs` | exit 0 |
| `p0-publish-check.mjs` | 8 工具 + `blender.status`，**failures: 0** |
| `python -c "py_compile"` × 3 个 bridge 文件（用 Blender 自带 Python 3.13） | 全部 OK，`all compile clean` |
| 新增函数就位 | `queryProcess` L271、`findDiskInstance` L313、`tokenlessStop` L728、`processIdentity` 落盘 L616、`graceful (tokenless)` L821 |

**⚠ 未做（必须明说）**：

| 未做 | 为何 |
|---|---|
| **未做活体运行测试** | 要真实触发需要：起一个实例 → 重载插件丢掉 token → 再跑 `stop`。本轮未做，因为重载需要重启 daemon，而当前 daemon 上跑着本轮安装链。⇒ **新路径的实际行为未经运行验证**，只有静态与语法级证据 |
| **未验证 Blender 5.2 对 `CloseMainWindow()` 的反应** | 未实测有无"是否保存"对话框。这正是文档里写"只能请求、不能保证"的原因 |
| 未验证 `pgrep` 式身份查询在**非 pwsh** 环境 | 本机只有 Windows PowerShell 5.1，已实测兼容（见 Q.4） |

### Q.3 文档出包（P0-F151 的处置）

| 动作 | 结果 |
|---|---|
| 删除包内 `docs/DESIGN.md`、`docs/P0-EVIDENCE.md` | 已删（`docs/` 目录整个删掉） |
| `README.md` 的 Repository layout | 移除两行 doc，改为一段说明：文档**刻意不随包分发**，因为包管理器对整棵树取哈希 ⇒ 改文档就改 `integrity` ⇒ 逼迫重装 |
| 版本 | `0.1.1` → **`0.1.2`** |

**包内现在只有代码与许可文本**（12 个文件）：`LICENSE` / `LICENSE-GPL` / `NOTICE` / `package.json` / `README.md` /
`extensions/main/{agnes.client.json,index.mjs}` / `extensions/main/bridge/{bootstrap.py,agh_ops.py,agh_capture.py,HEADER.txt}` / `extensions/main/client/index.js`。

⇒ 后续改设计文档**不再触发重装**。

### Q.4 本机 PowerShell 兼容性核查

| 项 | 实测 |
|---|---|
| shell 方言 | Windows PowerShell **5.1.26100.9168**（Desktop），可执行文件 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| `Get-CimInstance Win32_Process -Filter "ProcessId=N"` | 可用（PS 3.0+） |
| `[System.Management.ManagementDateTimeConverter]::ToFileTime()` | 可用（.NET Framework，加载 `System.Management` 即可） |
| `Get-Process -Id N` / `.CloseMainWindow()` / `.WaitForExit(ms)` / `.HasExited` | 可用（`System.Diagnostics.Process`） |
| 链接行分段 | ~~`-Command` 接受换行~~ **未验证** ⇒ 为降低风险，实现里改为**单行分号拼接**，不用多行字符串 |

### Q.6 v0.1.3：修掉一个**未验证错误断言**（2026-10-05 23:30）

**起因**：准备孤儿停止的活体测试时，先单独验证那两段 PowerShell（§Q.4 列过它们"可用"）。结果**实测证伪了 §Q.4 的一行**：

| 断言（§Q.4 原话） | 实测 |
|---|---|
| `[System.Management.ManagementDateTimeConverter]::ToFileTime()` **可用** | ❌ **不存在**：`Method invocation failed because [System.Management.ManagementDateTimeConverter] does not contain a method named 'ToFileTime'`（PS 5.1.26100.9168） |

⇒ **已装的 v0.1.2 里身份探针是坏的**。它**失败关闭**（不降级为强杀），所以**安全**，但孤儿停止功能**不通过**。
这正是一类典型错误：**把"未验证"写成了"可用"**（§Q.4 原表就是用 `CimInstance`/`Get-Process` 存在性推定出来的，未逐行实跑）。

**修正（P0-F155）**：改用一个**可独立运行、可单独测试**的 .ps1：

| 文件 | 作用 |
|---|---|
| `extensions/main/helpers/ps_identity.ps1` | `Get-Process -Id N` → `ProcessName + '\|' + StartTime.ToFileTime()`；进程不存在 → `GONE`（exit 3） |
| `extensions/main/helpers/ps_close.ps1` | `CloseMainWindow()` + `WaitForExit(8000)` → `EXITED\|requested=…` / `STILL_RUNNING\|requested=…` |

**独立验证结果（不经插件，直接跑脚本）**：

| 调用 | 输出 | exit |
|---|---|---|
| `ps_identity.ps1 -TargetPid 48252` | `node\|134356817127664390` | 0 |
| `ps_identity.ps1 -TargetPid 999999` | `GONE` | 3 |
| `ps_close.ps1 -TargetPid 24032`（node，无主窗口） | `STILL_RUNNING\|requested=False` | 0 |
| 事后核对 | pid 24032 **仍然存活**（无强杀、无副作用） | — |

**与 Python 侧的交叉验证（重要）**：

| 实现 | 取值 |
|---|---|
| `bootstrap.py` 的 `_win32_creation_ticks()`（`ctypes` + `GetProcessTimes`，进程内、零子进程） | `134356817127664390` |
| `ps_identity.ps1`（`Get-Process StartTime.ToFileTime()`） | `134356817127664390` |
| `daemon/discovery.json` 的 `owner.processStartId` | `win32:48252:134356817127664390` |

⇒ **两套实现逐字相同**，且正是 daemon 自己的进程身份编码。⇒ 用创建时间做 PID 复用防护是**同一语义**，不是另造一套。

**许可边界修正（顺手抓到的）**：这两个 `.ps1` 一开始被放进 `bridge/` —— 而 `bridge/` 是 **GPL 声明区**，
它们是 Node 侧助手、**不碰 `bpy`** ⇒ 已移到新目录 `extensions/main/helpers/`（Apache-2.0 侧），
并同步 `README.md`、`NOTICE` 的目录清单。新常量 `HELPERS_DIR` 注释里写明了这个理由。

**一次自伤（留档）**：本轮又两次用 `powershell.exe node -e "…"` 内联带引号的脚本，被 PS 5.1 撕碎（§9 第一条的坑），
另有一次 splice 把旧 argv 块残留下来导致 `SyntaxError`（后经匹配式修复）。⇒ **凡带引号/换行的脚本一律写成 .cjs 文件再跑**。

### Q.8 v0.1.3 上架 + 活体测试的**流程障碍**（2026-10-05 23:50）

#### Q.8.1 上架结果

| 项 | 值 |
|---|---|
| `install` | ✅ completed（`14:47:33.845Z`），人类 TTY 按 y；integrity 与冻结值逐字一致 |
| `trust` | ✅ completed 100% |
| `enable` | ✅ completed 100% |
| 最终状态 | `agh-blender@0.1.3 desired=enabled actual=running trusted=true` |
| `host.jsonl` | `14:48:05.529Z` `extension.loaded` version **0.1.3**；**8 个工具**全部注册；`blender.status` 4 次调用 `outcome=["inspected","ok"]` |

#### Q.8.2 发现：已安装的工具**不会自动进主代理会话的工具面**（P0-F156）

准备做活体测试时，本会话直接调 `agh_blender_start` 得到 **`unknown tool agh_blender_start`**，
而 Host 侧花名册里 8 个工具**确实注册了**（`host.jsonl` 逐行可查）。

⇒ 两者不等价：**Host 注册 ≠ 当前 agent 会话的工具面**。这解释了 P0-F152/P0-F154 里那个现象：
本会话里只有 `blender.status` 服务被调（面板侧），8 个工具从未被本会话调用过。

**未做**：没有去定位工具面暴露的具体条件（可能是 preset / `deferLoading` / 会话启动时的快照）——
本轮只把它记为**流程事实**，够用即可。

#### Q.8.3 驱动方案与其效果（P0-F157）

| 步骤 | 验证 | 结果 |
|---|---|---|
| 用 CLI 起子会话调 `agh_blender_probe` | 子会话返回真实 JSON（`source:"none"`） | ✅ 子会话**能**调这些工具 |
| 它连的是哪个 daemon？ | 对比 `host.jsonl`：子会话那次调用**未产生新的** `extension.loaded`；daemon pid `48252`、`startedAt 13:48:33.657Z` **未变** | ✅ **走同一个 4181 daemon** ⇒ 与 daemon 内存共享句柄，**驱动方案成立** |
| 用 CLI 子会话调 `agh_blender_start` | 返回「**the user rejected this action**」 | ❌ **非 TTY 下审批自动拒绝**，起不了实例 |

⇒ **结论：活体测试仍有一步必须由人在 TTY 完成**（起实例那一下）。
沙箱与审批门在这里是**正确工作**的 —— 非交互下"未应答"被判为"不同意"（INV-33），与安装门同一设计。
**未绕过，也不应绕过。**

### Q.9 为什么三次都“拒绝”：**`-p` 模式没有审批 UI**（2026-10-05）

用户按我给的命令试了两次，都是「the user rejected this action」；加我自己那次，一共三次。
**原因不是用户没点，也不是 TTY 缺失，而是我给的命令是 one-shot 的 `-p`（print）模式。**

#### Q.9.1 证据链（源码级）

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F158 | **`-p` / `--mode text\|json` → print（one-shot）模式**，与 TUI 是两个不同的"面" | `cli/src/args.ts:162-164`（`if (p.mode === 'json' \|\| p.mode === 'text') p.print = true`）、`:186-196`（`resolveMode`：`--mode` → print；**任一**端不是 TTY → print；否则 tui） |
| P0-F158 | **print 模式里根本没有审批交互的接线**：该模式下没有任何回答 `approval/asked` 的代码；它只会把"已 parked"当成一种结果报告（`parked ticket=… session=…`） | `cli/src/modes/print.ts`（全文无 approval 处置）；`modes/result-line.ts:25-35` 只是**读** parked 票据 |
| P0-F158 | **只有 `tui` 模式跑 `TuiApp`**（真正的交互面） | `cli/src/bin.ts:789-801`；`modes/tui.ts` |
| P0-F158 | 拒绝文案就是 **`user_rejected`** 那一支 | `core/src/effects/approval-answer.ts:53-55` |
| P0-F158 | **有资格回答审批的面只有四类**：`via ∈ {sync, callback, timeout, guardian}` | `core/src/log/validate.ts:7`（`DECIDED_VIA`）；P0-F51 实测那次是 `via=sync`，与会话 `1451df13…` 的 TUI 相符 |
| ⇒ | 结论：**`-p` 模式**下没人回答问题 ⇒ 判为 `user_rejected`。**这不是审批门坏了，是审批门正确地拒绝了"没人回答"的场合；错在我把 TUI 才有的能力用在了 print 模式上** | 同上 |

#### Q.9.2 本轮的两次自伤（留档）

| 事故 | 后果 | 教训 |
|---|---|---|
| 我先用 `-p`（无 TTY）试，被自动拒绝，我把它当成"非 TTY 审批门"的用例 | 方向对，但**因果写错了**：真正原因是"模式"而非"TTY"（两者都指向 print 模式，所以现象一样） | 同一种现象可能有**两个**叠加的充分条件；定论前要把每个条件单独排除 |
| 我给用户的命令也是 `-p` | 用户两次白跑 | **要人参与的步骤，命令必须用交互模式（不带 `-p`）** |

#### Q.9.3 正确做法（待用户执行）

```powershell
cd D:\agnes-harness
$env:AGH_HOME='D:\agh-p0-home'
node .\packages\cli\dist\local\agnes.mjs
```

（**不带 `-p`** —— 这样才是 TUI。）然后在 TUI 里让它调用 `agh_blender_start`（若模型不主动调，可直接黏上：
`调用 agh_blender_start 起一个 Blender 实例，然后停下，不要 stop`），**在 TUI 里回答审批**。

### Q.11 孤儿停止的第一次真实运行（2026-10-05 23:07）——**机制验证成功，工具路径失败，且失败不可诊断**

用户用 web/TUI 起了一个真实实例（pid 49456，端口 55692，`isDirty:false`），本机完成了整条链路。

#### Q.11.1 先抦下一个**新发现的破坏性缺陷**：运行时污染快照（P0-F160）

`disable`/`enable` 一开始全部报 **`E_PACKAGE_INTEGRITY`**。根因：

```
<packages>/.runtime-snapshots/sha256-723e5424…/extensions/main/bridge/__pycache__/
    agh_capture.cpython-313.pyc   8842 B
    agh_ops.cpython-313.pyc      34696 B
```

**Blender 一跑，Python 就把字节码缓存写进了内容寻址快照** ⇒ 树哈希变了 ⇒
**仟何包操作（disable/enable/uninstall/update）都失败**，直到手删。
时间线完全对应：快照在 14:47 安装时干净，14:59 起实例，15:05 首次包操作就报错。

| 编号 | 事实 |
|---|---|
| P0-F160 | `.pyc` 写在 **runtime snapshot** 里（不只是部署副本）——快照是内容寻址的，本该不可变 |
| P0-F160 | 后果：**跑一次 Blender 就能把包管理器锁死**；经手删掉 `__pycache__` 后 `disable` 立即恢复正常（实测） |
| P0-F160 | **修法（未实施）**：起 Blender 时在 env 里加 `PYTHONDONTWRITEBYTECODE=1`；另在 `bootstrap.py` 导入兄弟模块前设 `sys.dont_write_bytecode = True` 作为双保险。需重装一轮 |

#### Q.11.2 孤儿条件确实成立，而且观测到了

| 编号 | 观测 | 依据 |
|---|---|---|
| P0-F161 | `instance.json` 里 `processIdentity` **确实写入了**，且与 `port.json` 交叉一致 | `ticksRaw="134356859898245176"` = `startedAtWin32` |
| P0-F161 | 用**已安装包里的**脚本查 pid 49456 → `blender\|134356859898245176`，与记录**逐字相同** ⇒ 身份校验会通过 | 实跑 |
| P0-F161 | `disable` 后调 `probe` 回 **`E_LEASE_EXPIRED: lease revoked`** —— 插件已被卸载（内存句柄没了） | 实测 |
| P0-F161 | `enable` 后 **Blender 49456 仍活着**（`(Unsaved) - Blender 5.2.2 LTS`）而内存表为空 ⇒ **孤儿条件成立** | 实测 |

#### Q.11.3 结果：机制对了，工具路径错了

`agh_blender_stop`（已批准）跑了 **19 秒**（token 路径只需约 2 秒 ⇒ 确实走了新路径），然后：

```
#6809 15:07:00.694Z tool/result origin=system
  code=TOOL_OUTCOME_UNKNOWN  "the outcome of agh_blender_stop is unknown after dispatch"
```

而且**窗口没有关**。旁证：bridge 日志里**没有 `/shutdown`**（符合无 token 路径）。

**决定性实验（本轮最有价值的一步）**：直接对 49456 跑已安装包里的 `ps_close.ps1`：

```
EXITED|requested=True        （进程后来确认已退出）
```

⇒ 结论：**机制（`CloseMainWindow()` + 不加 `/F`）在本机对真实 Blender 有效**，
**身份脚本也正确**；失败在**工具调用这条路径**上。

**最可能的原因（未证实，下轮第一件事）**：`tctx.sandbox.confine()` 给的是 **file 作用域**约束，
而 helper `.ps1` 位于 **AGH home 内（工作区之外）**；在 confine 下执行工作区外的脚本可能被阻或挂住。
19 秒这个数字与 `queryProcess` 的 15 秒超时大致对得上（超时 → 身份校验失败 → 拒绝执行）。

#### Q.11.4 我的代码违反了 P0-F58（必须自记一笔）

P0-F58 写着：**副作用型工具不能把唯一一份结果放在返回值里**。
`agh_blender_stop` 的旧路径只需 2 秒、从未被吞过，所以我一直没给它落盘报告。
结果这次它一跑 19 秒就被判定“可能已发副作用”，结果**直接变 `TOOL_OUTCOME_UNKNOWN`，
工具不报错、日志里也没有** —— 失败原因永久丢失。

**必修项（下轮）**：

1. `agh_blender_stop` 也必须**先落盘 `<instanceDir>/stop-report.json` 再返回**（含 `stage`、身份比对实值、confine 结果、exec 退出码/stdout/stderr）；
2. 把 helper 路径改为**工作区内**（或改为把脚本内容通过 `-EncodedCommand` 传入，完全避开路径/confine 的交互）——后者更干净，但需先确认 `-EncodedCommand` 在 PS 5.1 下可用；
3. 删除 `processIdentity.ticks: Number(...)` 这个丢精度的字段（FILETIME `1343…176 > 2^53` 存不住；比较已正确使用 `ticksRaw` 字符串，但那字段有误导性）。

#### Q.11.5 本轮结束时的现场（已收干净）

| 项 | 状态 |
|---|---|
| Blender 49456 | 已通过 `ps_close.ps1` **优雅退出**（非强杀） |
| 实例目录 | `instances/` 为空 |
| `__pycache__` | 已从 snapshot 与部署副本删除 |
| 包状态 | `agh-blender@0.1.3 desired=enabled actual=running trusted=true`（健康） |
| **孤儿停止功能** | ❌ **未完成**（机制已验证；工具路径待修，见 Q.11.4） |


用户在 TUI（不带 `-p`）里跑了同一句，结果依然没起实例。从 ledger 读到的完整链条：

| seq | 时间 | 类型 | 关键字段 |
|---|---|---|---|
| #19 | `14:54:49.660Z` | `tool/call` | `name=agh_blender_start` |
| #22 | `14:55:49.681Z` | `approval/asked` | `summary=agh_blender_start`、`risk=always`、`scope=tool:agh_blender_start:execute`、`policyVersion=static-v1` |
| #23 | `14:55:49.681Z` | `approval/decided` | **`verdict=rejected`、`via=sync`、`reason=timeout`** |

⇒ 与 `-p` 那三次（`user_rejected`）**不同**：这次 `via=sync` 说明 **TUI 真的把问题摆出来了**，
但**60 秒内没人回答**（`approval.timeout_ms=60000`，与 §2 本机事实一致）⇒ 记为 `timeout`。
工具**没有执行**，无 Blender 进程，`.agh-blender/instances/` 也是空的。

#### Q.10.1 为什么"可能看不见也按不动"：`canSelect = rows >= 4`（P0-F159）

从 `cli/dist/local/agnes.mjs` 里摘出的 `PermissionModal`：

```js
question.canSelect = rows >= 4
if (rows < 4) return [fitLine(t2("permission.resize", locale2), width)]
```

⇒ **审批卡片只有在窗口能给出 ≥ 4 行时才可选中**；行数不够时它**只显示一句 resize 提示**，
此时按数字键/回车**都无效**（`handleInput` 里的分支都要求 `canSelect && visible.has(...)`）。

另一个容易踩的细节：`selected` 的初值是 **`reject_once` 那一项**（`selected: options.findIndex(o => o.kind === 'reject_once')`）——
所以**直接按回车 = 拒绝**。要批准必须**先把光标移到 allow 项**（↑/↓）**再回车**，或直接按 allow 项对应的**数字键**。

#### Q.10.2 因此下次请这样操作

1. **把终端窗口拉大**（高度足够，别用很小的面板）—— 否则卡片只显示 resize 提示，按什么键都没用；
2. 粘上那句话后**盯着屏幕**，出现审批卡片就选 allow 项：按 allow 那一项的**数字键**，或 ↑/↓ 移到它再回车；
3. **60 秒内完成**（超时即 `reason=timeout`）。

> 注：审批门的这些行为都是**正常设计**（默认光标在"拒绝"上、超时即放弃、窗口不够就不让选）。
> 本轮没有、也不应去绕过它们；上面三条只是"怎么在正常 UI 里把它答完"。

| 环节 | 状态 | 证据 |
|---|---|---|
| 两个 `.ps1` 助手的行为 | ✅ **已独立验证** | `ps_identity` 活/死进程分别 `node\|1343…` / `GONE`；`ps_close` 对无窗口进程 `STILL_RUNNING\|requested=False` 且目标仍存活 |
| 创建时间与 Python/daemon 三方一致 | ✅ **已验证** | PS / `ctypes` / `discovery.owner.processStartId` 三者同为 `134356817127664390` |
| 代码路径静态正确 | ✅ | `node --check`、`p0-publish-check` failures 0 |
| **端到端（起实例 → 重载丢 token → stop）** | ❌ **仍未完成** | 卡在起实例需要 TTY 审批 |

#### Q.8.5 v0.1.3 冻结值（注：上面 Q.7 的标题已被 Q.8 替换，值仍有效）

| 项 | 值 |
|---|---|
| 包内最后写入 | 2026-10-05 22:5x（冻结后**未再动**） |
| version | **0.1.3** |
| **integrity** | **`sha256-c2e8b8d0a7b9d6c3ad234973244aa6ae414b1d020b476c31a6237606a0d1aa0b`** |
| capabilityHash | 预期仍为 `7e7b2182…`（以 install 回执为准） |
| 预检 | `node --check` exit 0；`p0-publish-check` failures 0；`ps_*.ps1` 独立实跑通过 |

| 步骤 | 状态 |
|---|---|
| `disable` → `remove` → `inspect`（v0.1.3） | ✅ 已做 |
| **`install`（人工 TTY 按 `y`）** | ⬜ **非 TTY 下 CLI 返回 `Installation cancelled.`（exit -1）** —— 本会话无法代按，也不应绕过（INV-33） |
| `trust` → `enable` | ⬜ |
| **孤儿停止活体测试**（起实例 → 重载插件丢 token → stop） | ⬜ **随 v0.1.3 一起做**；不需重启 daemon（`disable/enable` 就会产生 `extension.revoked` 并清空内存句柄），所以**不会打断本会话** |

**v0.1.2 冻结值**（包内最后写入 2026-10-05 22:36:04；inspect 2026-10-05T14:37:02Z）：

| 项 | 值 |
|---|---|
| version | **0.1.2** |
| license | **Apache-2.0** |
| **integrity** | **`sha256-6e9e838d4471d57c6fcd8dbb375a80dd75493f6396deaa351a67d8f9f36f61ce`** |
| **capabilityHash** | **`7e7b2182ed1e108b78f8f721c9e1c988c7a02042510af11dfac138571fda11ad`**（与 0.1.0/0.1.1 **相同**，再次印证 P0-F61） |

| 步骤 | 状态 |
|---|---|
| `disable` → `remove` | ✅ completed 100% |
| `inspect`（v0.1.2） | ✅ |
| **`install`**（人类 TTY 按 `y`） | ✅ **completed**（`14:38:03.059Z`）；integrity 与冻结值**逐字一致** |
| **`trust`** | ✅ completed 100%，`trusted true`（`license` 已是白名单值 ⇒ 一次过） |
| **`enable`** | ✅ completed 100%，`desired=enabled actual=running trusted=true` |
| **`host.jsonl` 确认 8 工具重新注册** | ✅ 见下方 P0-F154 |
| **活体验证孤儿停止** | ⬜ **本轮未做**（需重载 daemon 丢 token；当前 daemon 在跑安装链） |

#### P0-F154 v0.1.2 上架确认（host.jsonl，`14:36:50Z` 起）

| 判据 | 实测 |
|---|---|
| 旧版本清场 | `14:36:50.165Z` `extension.revoked`（`package=agh-blender`, `reason=unload`） |
| `extension.loaded` | **version `0.1.2`**（`14:38:56.762Z`） |
| **工具注册数** | **8 个**，全部 `row=ext:agh-blender/runtime`：`start`/`probe`/`stop`/`capture`/`apply_ops`/`scene`/`ops_catalog`/`export` |
| **`blender.status`** | **4 次调用**，`service=blender.status`、`kind=query`、**`outcome=["inspected","ok"]`**（`14:38:58.875Z`–`.890Z`） |

> **一个我自己踩到的检索坑（记下）**：`extension.service-call` 行**不带 `detail.package`**，它用 `detail.extension`（值形如 `plugin/42d5f5b313c99291`）。
> 只按 `detail.package==='agh-blender'` 过滤会把 8 个工具行数对、**服务调用数成 0**。
> 另：注册行（`extension.registered`）出现在 `extension.loaded`**之前**，所以窗口起点应取 `extension.revoked` 而不是 `extension.loaded`。
> 两个坑合起来会得出"服务没注册"的**假阴性**，实际两次都是 4 次调用正常。


| 未做 | 为何 |
|---|---|
| 未改 `package.json` / `LICENSE` | 改 license 会改 integrity，且属发布决定；需人确认后走 `disable→remove→install→trust→enable` |
| 未跑真实 `trust` | 结论已由**真实函数 + 真实 lock 输入**给出，重装一次只会得到一个已知结果，且会消耗一次 `y` |
| 未改 agnes-harness 仓库任何文件 | 仅**读取**源与锁；新增文件都落在工作区的 `.agnes/work/blender-workbench-spec/` |
| **未做法律判断** | P.5.7 的三个问题属许可判断，超出"读源码"能给出的证据强度 |





### K.5 探针 3 收口：**没有带登记的工具侧 put**（分支 B 成立，2026-10-05 16:47）

判据：`ArtifactAuthorityProjectionWriter` 的**全部**调用方（源码级，非活体）。

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F92 | 该 writer 类型只有 `append` / `revoke` 两个方法，且**只被构造一次**：把持久索引的原型方法绑上去 | `supervisor/artifact-authority-projection.ts:18-21`；`supervisor/artifact-read.ts:131-134`（`PersistentArtifactReadAuthorityIndex.prototype.append/revoke`） |
| P0-F93 | `writer.append/revoke` 的**唯一调用者**是投影器自己：`observe()` 里的 append、`revokeLane()`/`resetSession()` 里的 revoke | `artifact-authority-projection.ts:235`（append）、`:251`、`:320`（revoke） |
| P0-F94 | `observe()` 的**唯一调用者**是 `WorkerRegistry`：实时投递与重放两处 | `supervisor/registry.ts:112`、`:357`、`:382`；注册表接线 `supervisor.ts:1203`（`new WorkerRegistry(pool, projectedArtifactRead?.projection)`） |
| P0-F95 | **工具侧没有通向该 writer 的能力**：`ToolContext.artifacts` 只暴露 `put/get/submitJob/poll/cancel` | `host/src/ext-host/tool-context-capabilities.ts:56-65` |
| P0-F96 | `ctx.artifacts.put` 只写 CAS 字节；仅当 `meta.name` 恰为 `computer-use-screenshot.png/.jpg` 时额外写一份 CU 保留期元数据，**对归属索引一无所知** | `base/extensions/artifacts-local/src/seam.ts:53-106`；印证 P0-F91 |
| P0-F97 | 登记资格由**事件形状**决定：`tool/result` 必须 `origin === 'tool:computer_use'` **且** `trust === 'untrusted'` **且** `isError === false`，且块是 `resource_link` + `artifact://<sha256>` + mime 为 png/jpeg | `artifact-authority-projection.ts:107-143`（`mediaRoots`） |
| P0-F98 | 我们的行两条都不满足：core 写的 `origin` 是 `` `tool:${call.name}` ``，`trust` 由 `isOpenWorld === false ⇒ 'trusted'` 决定 | `core/src/step/tools.ts:1227-1228`；`agh_blender_capture` 声明 `isOpenWorld:false`（`.agnes/work/p0-wiring-probe/extensions/main/index.mjs:824-831`）⇒ 实际为 `tool:agh_blender_capture` / `trusted` |
| P0-F99 | 对照：`computer_use` 恰好是 `isOpenWorld:true`（⇒ `untrusted`），工具名也匹配那条 `origin` 判据 | `base/extensions/computer-use/src/tool.ts:430-437` |
| P0-F100 | 失败机制自洽：`ensureArtifactAuthority` 只等到"该 seq 已投影过"，而投影在 `mediaRoots` 返回空时**不登记任何东西也不报错** | `supervisor.ts:1167`；`registry.ts:115-118`（无条件推进 `artifactProjectedThrough`）；`artifact-authority-projection.ts:213`（`if (!roots?.length) return`） |
| P0-F101 | 随后 `workerRead` 查持久索引取不到 binding（四元组 + authority 一致性校验），返回 `undefined` ⇒ core 报 `ARTIFACT_BYTES_MISSING` | `supervisor/artifact-read.ts:455-487`；`local/artifact-read.ts:456-487`；`core/src/orchestrator/request-media-surface.ts:289-295` |
| P0-F102 | CLI 的直读路径卡同一个门：要求 `origin === 'tool:computer_use'`、`trust === 'untrusted'`（该路径**不查**归属索引，直接读 CAS） | `cli/src/boot/local.ts:292-308`、`boot/screenshot-read.ts:12-27` |

**结论（本轮）**

1. **§K.4 的"有 ⇒ 改一行"不成立**：不存在"工具侧可用、且带登记"的 put 路径。登记不是工具能做的动作，它由 daemon 从 ledger 事件推导，且只认 `tool:computer_use` / `untrusted` 这一种形状。
2. **§K.3 的 owner 假设降级**：owner 一致性校验（P0-F86）真实存在，但在我们的场景里行连投影资格都没有（P0-F97/F98），**轮不到 owner 比对**。它是这条通道的第二个门，不是本次失败的第一道门。
3. ⇒ **落分支 B**：P0-4 改投递落点（Host `fs.write` + 资源登记）。
4. **§3.7 的措辞要写准**：不是"图片不经 tool artifact"，而是"**经 tool artifact 的图片，只有 `tool:computer_use`/`untrusted` 这条截图通道会被登记归属**；别的工具名/信任级拿不到这条通道"。
5. **一条必须否掉的近路**：把自己扮成 `computer_use`（改名，或为拿 `untrusted` 而谎报 `isOpenWorld:true`）能让字节过门，但语义错位 —— 会把渲染图塞进 computer-use 截图保留期/回收契约；且 `host-computer-use` 执行域在 core 里要求确切内建包背书（`core/src/registry/tools.ts:213-231`）。

**证据强度（如实记录）**：以上均为**源码级**（file:line 如上）。**未做活体取证** —— 当时 P0 数据目录 `D:\agh-p0-home` 在工作区之外，`find` 直接拒绝（`find refused: ... outside the workspace`），`shell` 读取两次审批被拒。因此"该真实 ledger 行的 origin 是 `tool:agh_blender_capture`、trust 是 `trusted`"当时是由代码规则**推出**的（P0-F98）。

**补证的最小路径**：在**工作区内**另设受管 `AGH_HOME`（例：`.agnes/work/p0-preflight-ws`）起本地会话，跑一次 `agh_blender_capture`，再用 `node:sqlite` 读该会话 ledger 里那条 `tool/result` 行，打印 `origin` / `trust` / `content`，与 P0-F98 逐值对齐。

> **已执行 —— 见 §K.6。P0-F98 已由"代码规则推出"升为活体取证（P0-F103~F106）。**

### K.6 补证：P0-F98 升为活体取证（2026-10-05 17:14）

**走的路**：优先读**已存在的真实会话 ledger**，而不是新起 home 空跑一次 —— 因为 ledger 就是 Host 侧的权威存储，里面的行就是"那条行"本身。

**为什么读取这次不再被拒**：本工作区的 daemon 会话按 `AGH_HOME` 寻址。实测本轮的 agent 会话（`209ec8d1-…`）本身就落在 `D:\agh-p0-home\data\sessions.db` 里，而该文件**在工作区之外**。但 `shell` 工具以 agent 身份跑，可直接读它；先前"被拒"的是 `find`/`read` 这类**受工作区约束**的工具。这正是本轮得以取证的原因（也说明 §7.3 要的"独立于 agent 转述"在这一步只能靠原始 DB 字节）。

`events` 表结构（`node:sqlite` 只读打开，`pragma table_info`）：
`session_key, seq, ts, id, type, lane, v, actor, origin, trust, register, ignorable, surface_op, source_event_seqs, data, integrity_mode, integrity_prev, integrity_digest`
—— **`origin` / `trust` 是行上的独立列**，不是从 `data` 里推的。

#### 目标行（活体）

| 编号 | 字段 | 实测值 | 与 P0-F98 的推断对照 |
|---|---|---|---|
| P0-F103 | `session_key` | `1451df13-97f2-46f8-b659-d4723027838d` | — |
| P0-F103 | `seq` | `226` | — |
| P0-F103 | `type` | `tool/result` | 一致 |
| P0-F103 | **`origin`** | **`tool:agh_blender_capture`** | ✅ **逐字一致**（推断式：`` `tool:${call.name}` ``，`core/src/step/tools.ts:1228`） |
| P0-F103 | **`trust`** | **`trusted`** | ✅ **逐字一致**（`isOpenWorld:false ⇒ 'trusted'`，同文件 1227） |
| P0-F103 | `integrity_mode` | `chain` | 行受完整性链保护（有 `integrity_prev`/`integrity_digest`） |
| P0-F103 | `source_event_seqs` | `[222]` | 指向配对的那条 `tool/call` |
| P0-F103 | `ts` | `2026-10-05T08:27:56.869Z` | 与 §K.2 记录的 P0-4b 实跑同一次 |

**配对行 `#222`（`tool/call`）把策略也落在 ledger 里**（所以"`isOpenWorld` 决定了 `trust`"不是事后解释，是可核对的）：

```
resolvedPolicy = {"isReadOnly":true,"isDestructive":false,"isConcurrencySafe":true,
                  "isOpenWorld":false,"replay":"safe","requiresApproval":"never",
                  "approvalScopes":[],"policyVersion":"static-v1"}
name = agh_blender_capture
```

⇒ 一条链上**三个值互相印证**：工具声明 `isOpenWorld:false`（`index.mjs:827`）→ 落盘策略 `isOpenWorld:false` → 结果行 `trust=trusted`。

#### 投影谓词的两个条件，同一行上都实测为"不满足"

`mediaRoots`（`artifact-authority-projection.ts:107-143`）要求 `origin === 'tool:computer_use'` **且** `trust === 'untrusted'` **且** `isError === false`，块为 `resource_link` + `artifact://<sha256>` + mime ∈ {png,jpeg}：

| 编号 | 谓词条件 | 该行的实测值 | 结果 |
|---|---|---|---|
| P0-F105 | `origin === 'tool:computer_use'` | `tool:agh_blender_capture` | ❌ 不满足（**第一道门**） |
| P0-F105 | `trust === 'untrusted'` | `trusted` | ❌ 不满足（第二道门） |
| P0-F105 | `isError === false` | `false` | ✅ 满足 |
| P0-F105 | 块形状 | `content[1] = {type:'resource_link', uri:'artifact://85657c61…', mimeType:'image/png', name:'image'}` | ✅ **满足**（块级条件全过） |

⇒ **块级四个条件全部满足，行级两个条件全不满足**。这把 §K.5 的收口从"推断"钉成实测：**卡点确实只在行级的 `origin`/`trust`，与块形状无关**；也再次否定 §K.2 的"块形状"猜想（P0-F84 的旁证由此获得直接对照）。

#### 独立旁证：`trust` 跟着 `isOpenWorld` 走（两套工具、两个 home）

| 编号 | 观察 | 依据 |
|---|---|---|
| P0-F104 | 主 home ledger 里 v0 的 `blender_run_python` 行是 `origin=tool:blender_run_python` / **`trust=untrusted`**；而 `blender_scene_info`（只读）是 `trust=trusted` | `%USERPROFILE%\.agh\data\sessions.db` 的 `events` 按 `origin,trust` 分组统计 |
| P0-F104 | 与 v0 源码一致：写型工具 `WRITE_META` = `isOpenWorld:true`，只读 `READ_ONLY_META` = `isOpenWorld:false` | `.agnes/work/blender-bridge/index.mjs:177-208` |
| P0-F104 | 两个 home 里**全部 12 组** `tool/result` 的 `origin`/`trust` 组合，无一例外满足 `trust = isOpenWorld ? 'untrusted' : 'trusted'` | `1451df13-…` / `209ec8d1-…` / `23902724-…` / 主 home 四个会话的分组统计 |

#### 同一条"补证路径"的结构性阻塞（如实记录，未完成的部分）

§K.5 原提的路径是"**另起**受管 home 实跑"。这一步**试了，且卡在安装门**：

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F106 | **工作区内的受管 home 能起来**：`AGH_HOME=.agnes/work/p0-preflight-ws/home2`（全新路径）直接跑 `daemon.mjs --profile local-dev --workspace D:\agnes-harness --data-dir <home>\data` → daemon ready，只出现 `@agnes/mcp-helper`、`@agnes/plugin-helper`、`@agnes/skill-helper`（**含 `agh_blender_capture` 的探针包不在**） | 端口监听 + `daemon status` + `package status`；`data/` 下建出 `audit/ checkpoints/ daemon/` 等 |
| P0-F106 | **干净 home 里装不上探针包（本轮无解）**：非 TTY 下 `confirmPackageInstall` 直接 resolve(false) | `cli/src/bin.ts:849-863`；`package.ts:103-117` 的 `'add'` 也走同一个 `confirm`（`bin.ts:646`）；服务端无"自动安装"方法 |
| P0-F106 | 即便装上也还不够：跑一次会话需要 **provider 路由 + 可用凭据**。p0 home 的 `profiles/local-dev/configuration.json` 靠 `credentialRef` 指向 `D:\agh-p0-home\secrets\deepseek\account-6dcb7b6e…`（**另一个 home 的 secrets**）。要复现就要把这份明文凭据再拷一份进工作区——本轮**主动不做**：它会把一个真实凭据的副本落在工作树里，而取证本身并不需要走到这一步 | `.agnes/` 确实被 `.gitignore` 覆盖（不会误提交），但"不会误提交"不等于"该多造一份凭据" |
| P0-F106 | 副作用：home 目录**必须先不存在**。用一个已存在的普通目录当 `AGH_HOME` 会让 daemon 起不来，stderr 只有 `Private directory validation failed`（native `agnes-system.node` 的 Windows need-private-DACL 校验） | 复现两次；换成全新路径即成功 |

**所以本轮取证的形态是**：`origin`/`trust` **已经是活体实测**（P0-F103/F104/F105），但"**在一个全新 home 里**跑"这个加强版仍是**待人类一步**（需要在 TTY 里按 `y` 装包，见 INV-33）。这不削弱 P0-F98 的结论——它要的是"从那条行读出"，而行的来源就是一个**真实的 daemon 会话**，不是构造的 fixture。

**操作留档（避免复现）**：受管 home 目录若已存在且 DACL 非私有，Windows 上 daemon 会以 `Private directory validation failed` 退出；起 home 时用**全新路径**。

### K.7 P0-4 收尾：行级两条条件具名 + 分支 A 关闭（2026-10-05 17:30）

**本轮要答的问题**：§K.5/§K.6 反复提到"行级条件"，但从没把它们当**一个对象**写清楚 —— 哪两条、各自由谁判定、谁有能力改。先把这三问答死，再决定是补齐（工具侧）还是改落点（分支 B）。

#### 那两条行级条件（具名）

判定谓词只有一处，`mediaRoots()`，`packages/daemon/src/supervisor/artifact-authority-projection.ts:128`：

```ts
if (event.origin !== 'tool:computer_use' || event.trust !== 'untrusted' || data.isError !== false)
  return undefined
```

⇒ **行级两条**：① `origin === 'tool:computer_use'`；② `trust === 'untrusted'`。
另两条是**块级**（`isError === false` + `resource_link` / `artifact://<64hex>` / png|jpeg）—— 本轮实测**已全部满足**，与 P0-F105 一致。**卡点只在行级**。

#### 由谁判定

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F109 | **判定者是 daemon 侧投影器，不是工具**：`createArtifactAuthorityProjection().observe()` 在 `WorkerRegistry` 投递/重放时被调用；`mediaRoots` 返回空则 `if(!roots?.length) return` —— 不登记、不报错 | `supervisor/artifact-authority-projection.ts:128`、`:213`；`supervisor/registry.ts:112`、`:357`、`:382` |
| P0-F109 | 工具**只提供输入、不参与判定**：`origin` 由 core 写死 `` `tool:${call.name}` ``，`trust` 由 `policy.isOpenWorld` 决定 | `core/src/step/tools.ts:1227-1228` |
| P0-F110 | **工具侧没有通往登记的接口**（分支 A 关闭的直接依据）：`ToolContext` 能力面为 `fs / net / sandbox / platform / authorize / tools / artifacts / subagent`（`extension-api/src/tool.ts:190-234`），其中 `artifacts` 只有 `put/get/submitJob/poll/cancel`（`:214-222`）；`put` 只写 CAS 字节 | 同上；`base/extensions/artifacts-local/src/seam.ts:53-106` |
| P0-F110 | 改名冒充也不行：`host-computer-use` 执行域要求**内建包精确背书**（`trust:'builtin'` + `packageIdentity` + `source` + `packageVersion`），自报 `untrusted` 或改名都在 core 定义期被拒 | `core/src/registry/tools.ts:213-231` |

**结论**：两条条件**都不在工具的可写范围内** ⇒ **分支 A（工具侧补齐）关闭**，落分支 B。这是 §K.5 第 1 条的确认，不是新结论。

#### 分支 B 的复核：原措辞找不到对应接口（本节最重要的一条）

规范原话是"改走 **Host `fs.write` + 资源登记**"。本轮去源码里找"**资源登记**"本身，结论是：**它作为面向工具/插件的接口不存在**。

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F111 | `@agnes/resource-control-*` 是 **MCP 服务器 / Skills 的资源控制**子系统，与"图片资源登记"无关（它管的是 `skill-lkg`、`worker-snapshots`、`mcp.json` 这类） | `packages/resource-control-*/`；`D:\agh-p0-home\data\resource-control\` 实际内容 |
| P0-F111 | **媒体面确有一条非 computer-use 的登记路径**，但它是 `request/header`：要求 `event.origin === 'system'`、`event.trust === 'trusted'`、`data.media.manifest[]` 每项 `{sha256, mime, artifactUri}` 且 `artifactUri === artifact://<sha256>` | `supervisor/artifact-authority-projection.ts:108-125` |
| P0-F111 | 该 header 由 **core 自己的推理步**从**已选中的 surface 图片**写出来（`s.ev('request/header', header)`，`header = out.header`）；manifest 的 `artifactUri` 又与 `derive.ts` 的 surface 校验强绑（`block?.uri !== image.artifactUri` ⇒ 抛 `E_ENVELOPE`） | `core/src/step/inference.ts:803-812`；`core/src/request/derive.ts:549-557` |
| P0-F111 | ⇒ 这条 header 是**下游产物**（从已经能被读的图片生成），**不是**"把新图片登记进去"的上游入口 ⇒ 对 P0-4 **不可用** | 同上 |
| P0-F112 | 结论：分支 B 的"资源登记"**无现成接口**；现有全部通道要么是 computer-use 专用，要么从 surface 反推。⇒ 写规范时应当作**开放设计项**，不能当"已有机制" | 本节 |

**为何不自行实现**：这一层属于 core/daemon 的 artifact 权限模型（会话主体 owner 校验、CU 保留期/回收合同）。在插件侧找一个"绕开它"的落点，等于绕开媒体访问控制；这超出探针包的范围，应当先成为**设计决定**。

#### 本轮唯一一处与台账叙述不符的观察（如实记）

| 编号 | 观察 | 依据 | 状态 |
|---|---|---|---|
| P0-F107 | 同一 `sessions.db` 里，**P0-F103 之前**的主 home 表列显示 v0 的 `blender_run_python` 行是 `trust=untrusted`（与 `isOpenWorld:true` 的规则一致）；但**本次会话（`1ce35018`）正在读的那个 `events` 表**实测 `tool:shell` ⇒ **`untrusted`**、而 `tool:read` ⇒ `trusted`、`tool:grep` ⇒ `trusted`、`tool:find` ⇒ `trusted`。即：同一工具族里**只有开放世界的那一个**才拿 `untrusted` | 本轮只读统计（`group by origin, trust`），四个会话 + 本会话 | **待解释**（不影响 P0-4 结论：`agh_blender_capture` 的 `trusted` 已被 P0-F103 + 本轮 check.cjs 两次钉死） |

> 说明：这条是**如实记录一个我没解释完的观测**，不是结论。它反而**加强**本行关键点 —— `agh_blender_capture` 实测 `trusted` 与规则一致，而 `untrusted` 不是随手可得的（要拿它得是开放世界工具）。

#### 本轮未做之事（避免读者以为已覆盖）

| 编号 | 未做 | 为何 |
|---|---|---|
| P0-F108 | **未做活体反证**：没有真的加一个 `isOpenWorld:true` 的变体工具跑一次，看它是否能让图片进模型 | 那会把自己扮成开放世界工具；而且会撞上 `host-computer-use` 执行域的**内建背书**（P0-F110）与 CU 保留期合同。拒绝走这条近路，与 §K.5 第 5 条一致 |
| P0-F108 | **未把分支 B 的落点定下** | 上节：无可复用接口，属设计决定；本轮只负责把"它还不存在"这一步**变成已核实的负面结论**，不捉刀实现 |

#### 可独立核对的证据

1. **可重跑核对器**（本轮新增，不依赖 agent 转述）：
   `\.agnes\work\blender-workbench-spec\p0-4-row-conditions.check.cjs`
   用法：`node <该脚本> <sessions.db> <session_key> <seq>`；已实测 `exit 0`。
   它自己按 `mediaRoots` 逐条件求值并打印实值，任何人重跑应有：
   `origin=tool:agh_blender_capture`（❌）、`trust=trusted`（❌）、`isError=false`（✅）、块为 `resource_link artifact://85657c61…` / `image/png`（✅），且 `asExpected:true`。
2. **源码位置**：三处直接定位 —— 谓词 `supervisor/artifact-authority-projection.ts:128`；`origin`/`trust` 写入 `core/src/step/tools.ts:1227-1228`；工具能力面 `extension-api/src/tool.ts:214-222`。
3. **旁证**：`supervisor/artifact-authority-projection.ts:213` 的 `if (!roots?.length) return`——解释了为何"不登记也不报错"。

**一句话判词**：两条行级条件已具名、判定者已定位（daemon 侧投影器，非工具），**分支 A 因工具侧无接口而关闭**；**分支 B 落点仍未定义**，本轮把这个"不存在"核实为事实，而不是把 v1.1 的代称当成机制。

## L. 近期三步第 1 步审计：**未执行**，但产出一条修正、一条新事实与一条自己犯的推理错误（2026-10-05）

> **本节的性质必须先说清**：本轮**没有**跑到"上传一张图 → 看模型能否输出结构化参数"那个实验。
> 下面全部是**源码级**（file:line）与**环境级**（本会话实测的工具行为）证据。
> **它不是 vision 通或不通的结论。**
>
> ⚠ **本节 19:05 初版含一处越界推理，已于 19:40 修正**：初版把 §L.2 的 P0-F118（扫描结果为空）
> 当成对「图片能否进模型」的**否定**。这是**错**的——见 §L.3。保留此处提示，以免读者只读到初版结论。

### L.1 本轮要答的问题

`DESIGN.md` §1.3 第 1 步写的是："在会话里上传一张人物图片，要求输出结构化比例参数…通 ⇒ (B) 成立"。
要回答它，先得回答一个更前置的问题：**在本机上，图片有没有任何一条能到达模型的路径？**

### L.2 新增事实（全部可核对）

| 编号 | 事实 | 依据 |
|---|---|---|
| P0-F113 | **本会话唯一的图片可达通道 `computer_use` 实测不可用**：`capture(app='screen', mode='vision')` → `timeout`；`list_apps` → `read ECONNRESET`；`list_windows` → `timeout`，随后 `aborted` | 本会话工具返回（非推测） |
| P0-F113 | 而 `computer_use` **正是唯一会被登记归属的图片来源**（行级两条条件 `origin==='tool:computer_use'` 且 `trust==='untrusted'`） | `supervisor/artifact-authority-projection.ts:126-143`；与 §K.7 具名的两条行级条件一致 |
| P0-F113 | `computer_use` 出现在本会话，**蕴含主模型声明了图片输入**（`supportsComputerUse` 要求 `input` 同时含 `text` 与 `image`） | `core/src/step/inference.ts:481-486`；`core/src/step/model-tools.ts:31-33` |
| P0-F114 | **模型可见的图片块只可能来自 `tool/result` 行上的 `resource_link`**：扫描时非 `tool_result` 节点直接跳过；`block.type === 'image'` 直接判 `INLINE_IMAGE_UNSUPPORTED` | `core/src/orchestrator/request-media-surface.ts:371-399` |
| P0-F115 | **无合格图选即 `text-only`**，且 `text-only` **不允许**选中任何图片字节（选中即校验失败） | `core/src/orchestrator/request-media.ts:219-221`（`routeFor`）；`protocol/src/request-media.ts:48` |
| P0-F116 | **未找到"用户上传 → 模型可见图片块"的入口**：上传物（`.agnes/uploads/20261005_1/upload_f7dd2878-….jpg`）在磁盘上存在，但既不在 surface 扫描范围内，也不在 media roots 谓词的任何一支里；`conversation.input.attachments` 只是 `attachments?: ReactNode` 渲染位 | 前两行；`web-units/src/composer.ts:121-123` |
| P0-F116 | ⚠ **本条的适用范围要限定**：它说的是「**在 `tool/result` + `resource_link` 这条链上**没有用户上传的载体」，**不等于**「用户上传在任何路径下都到不了模型」。不要把它读成对能力的否定（见 §L.3.1） | 2026-10-05 修正 |
| P0-F117 | **分支 B 的受众若改为"人"，同样缺登记接口**：面板侧 `resources.images.load` 要求传入**已登记**的 `ArtifactRef`（读通道，不是登记入口）；服务侧 `ServiceContext` 能力面是 `exec/fs/net/artifacts/authorize/platform`，**无任何"登记进会话可见面"的方法** | `web-client/src/services.ts:396-407`；`extension-api/src/services.ts:8-23` |
| **P0-F118** | **跨两个 home 的全部历史会话里，从未有图片被送进模型**：`request/header` 合计 **378 行**（p0 home 327 + 主 home 51），**全部**是 `route=text-only` 且 `manifest=0`；`tool/result` 里 inline image 块 **0** 个；`resource_link` 仅 **3** 个 | **可重跑核对器**：本目录 `p0-media-scan.cjs`，用法 `node p0-media-scan.cjs <sessions.db>`；实测 `node:sqlite` 只读直读 `events` 表，**exit 0** |
| **P0-F118** | 含义（**严格限定**）：这是「**未发生**」，**不是**「不可能」——从未有会话尝试上传，零次尝试的扫描**必然**为空（absence of evidence）。它只能说明「过去没有先例」，**不能**否定图片入链的存在 | 逻辑限定；由用户 2026-10-05 指出 |
| P0-F118 | 附带含义（这一条成立）：P0-4 的 `agh_blender_capture` 那三行带着合法图片 `resource_link` 却**也**未被选进 manifest（`manifest=0`）——与 §K.7 两条行级条件卡住一致 | 同上；与 P0-F103~F105 一致 |
| **P0-F120** | **`computer_use` 在本机完全不可用**（单独编号，环境级新事实）：`capture(mode='vision', app='screen')` → `timeout`；`list_apps` → `read ECONNRESET`；`list_windows` → `timeout`（又试一次）→ `aborted`。四种调用无一成功 | 本会话工具返回，非推测 |
| P0-F120 | 意义（按用户 2026-10-05 的定性）：这把「图片进模型」从「**被规则挡住**」加强为「**连唯一合规通道也不可用**」——但它是**环境级**事实，**不篡改** §3.7 的**规则级**结论；两者必须分开记 | 同上 |

### L.3 一条必须降级的断言 —— 以及我上一轮在这里犯的错

#### L.3.1 我上一轮的错误（必须留档）

19:05 版在 §L.3 写道：该断言「在本机**找不到载体**」⇒「从已确认降为未获证」，
并在 §L.6 写成「源码里没有入口（P0-F114/F115/F116），**历史里也没有先例**（P0-F118）」。

**后半句是越界推理**（用户 2026-10-05 指出）：

- P0-F118 的扫描结果是**全空**，但原因是**零次尝试**——没有任何会话上传过图。
- **零次尝试的扫描必然为空**，它对「能不能」**不提供任何信息**。
- 这是 **absence of evidence，不是 evidence of absence**。

**同时前半句也要收窄**：P0-F114/F115/F116 说的是「**在 `tool/result` 行 + `resource_link` 这条链上**，我没有找到用户上传的载体」；
它**不等于**「用户上传在**任何**路径下都无法到达模型」（面板/客户端/未来入口均未被穷举）。

#### L.3.2 正确的表述（已按此回写 DESIGN.md）

| 位置 | 错误写法（19:05） | **修正后（19:40）** |
|---|---|---|
| §1.1 第 4 条 | 「未获证」 | 「**本机从未观测到图片进模型**」（记录未发生，不记录不可能） |
| §1.3 段 (B) | 「降级为未获证」 | 「**仍未验证**」（**不是**「不可行」） |
| §8.1 vision 行 | 「已进一步收紧」 | 「**仍未验证，不是已否定**」 |

⇒ 原 §1.3 那句「模型**能**看**用户上传**的图」的处置，**只有一句是正确的降级**：

> **本机从未观测到图片进模型。**

它既不断言能，也不断言不能。

### L.4 因此，第 1 步的实验形态必须改（原设计不成立）

| 原设计的缺陷 | 为何致命 | 修正 |
|---|---|---|
| "上传一张图，看模型输出参数" | 我**看不到** `uploads/…jpg` 的像素，无法判断模型输出对不对；且该图未必进得了模型可见面（P0-F116） | 改为**盲测**：ground truth 由**另一个人**持有，我只提交模型给出的参数，由持图者判定 |
| 未指定模型侧前提 | 必须是**声明了 `image` 输入的模型**才可能走 `native-image`；否则恒为 `text-only` | 先确认目标模型的 `input` 含 `image`，再看 `request/header` 的路由是不是 `native-image` |
| 未先验证通道 | 通道死了，实验只会得到噪声 | **先**验证 `computer_use`（或其替代）可用，再谈 vision。但见 P0-F120：本机该通道**完全不可用**，所以第 1 步**先要解决通道** |
| 用「扫库」代替实验 | 扫库只能得到「未发生」（P0-F118），**得不到**「能/不能」 | 第 1 步必须**真去上传一张图**，不是扫库推断（用户 2026-10-05 指示） |

### L.5 本轮未做之事（避免读者以为已覆盖）

| 编号 | 未做 | 为何 |
|---|---|---|
| P0-F119 | **未执行第 1 步实验**（没有任何"模型读图"的肯定或否定结论） | 通道不可用 + 读不到像素 + 需 ground truth 持有方配合 |
| P0-F119 | **未执行第 2、3 步** | 第 2 步被 P0-F117 卡成设计决定；第 3 步（P0-5 实际文件链）本轮未开始 |
| P0-F119 | **未做活体验证**：没有真跑一次带图请求去读 `request/header.media.route` | 同上；这是第 1 步的正确第一步，仍是待办 |

### L.6 当前可下的最小结论

0. **可重跑的扫描证据**：`p0-media-scan.cjs` —— 两个 home 的 **378 条 `request/header` 全是 `text-only`/`manifest=0`**，inline image 块 **0**（P0-F118）。
   **它证明的是「未发生」，不是「不可能」**（§L.3.1）。
1. **(B) 段（分析指标参数）仍未验证** —— 既不能判通、也不能判不通。判它需要：一条活着的图片通道 + 真去上传一张图。
2. 主模型侧**声明**了图片输入（P0-F113），但**本机从未观测到图片进模型**。
3. **新事实 P0-F120**：唯一合规图片通道 `computer_use` 在本机**完全不可用** ⇒ 「图片进模型」现在是「**连通道都不在**」，但这是环境级事实，**不动** §3.7 的规则级结论。
4. 分支 B 若只是"换个受众"，**可能**绕不开 P0-F112/P0-F117 指出的登记缺口 —— **待第 1 步结果再定，本轮不改 §3.7**（依用户 2026-10-05 指示）。

**下一步的最小可核动作**（任一）：
- 先修复/确认 `computer_use` 通道，再跑一次真实带图请求并读 `request/header` 的 `route`；
- 或由人在另一条已证可用的通道上传图，做 §L.4 的盲测。

## M. 「附件模块缺失」审计（2026-10-05）—— 结论：**不是模块缺失，是入口从未实现**

> **起因**：4181（`D:\agh-p0-home`）的输入框粘不进图片，怀疑 `@agnes/web-conversation-attachments` 未装配。
> **线索**：`packages/web/src/client-modules/boot.ts:221`、`packages/web/src/region-slots.ts:94`。
> **本机环境**：仓库 `D:\agnes-harness` HEAD `c1180fc0d1a7b54b7a624dee276c8b7c3a9f937f`；两个 daemon 都在跑（4180 / 4181，`discovery.json` 均 `ready:true`）。
> **证据强度**：**源码级**（file:line，HEAD）+ **运行态观测**（4181 实际服务的 `/app.js`、`agh package status`、磁盘花名册）。
> ⚠ **未做**：没有在浏览器 UI 里直接复现粘贴失败（`computer_use` 本机不可用，P0-F120）。用户观测与下述证据**一致**，但这一步不是活体 UI 复现。

### M.1 该模块是**内置单元**，不是可安装包（第一条线索的答案）

| 编号 | 结论 | 依据 |
|---|---|---|
| P0-F121 | `@agnes/web-conversation-attachments` 是 **built-in web unit**，属于 `@agnes/web-units` 里冻结的 `BUILTIN_WEB_UNITS` 花名册（第 201~207 项），**由构建期打包进 `packages/web`，随应用发布** | `web-units/src/index.ts:173-222`（`unit('@agnes/web-conversation-attachments','./conversation/attachments.js',['conversation.attachments'],'session-maybe',['@agnes/web-conversation'])`） |
| P0-F121 | 它在客户端是**本地注册表**，不走 daemon 的包花名册：`boot.ts` 从 `@agnes/web-units` 导入 `BuiltinWebUnitRegistry` 并 `new` 出来，与包管理器无关 | `web/src/client-modules/boot.ts:27`、`:147`；`web-units/src/index.ts:244-283` |
| P0-F121 | 因此 `boot.ts:221` / `region-slots.ts:94` 这两处都只是**常量名**（`unmountConversationChildUnits()` 的差集列表、`COMPOSER_DSH_CHILDREN` 的槽位声明），不代表"一个包该装配却没装配" | `boot.ts:218-226`；`region-slots.ts:93-102` |

⇒ 要求 1 的答案是：**内置，不需要单独安装/启用；也不按 profile 装配**（它随 web 构建走，与 profile 无关）。

### M.2 两个 home 的包列表**没有差异**（要求 2 不可执行）

| 编号 | 结论 | 依据 |
|---|---|---|
| P0-F122 | 4181（`AGH_HOME=D:\agh-p0-home`）与 4180（主 home）的**唯一差异是探针包**：4181 多一个 `@agh-p0/wiring-probe@0.3.0`（P0 自己的包）；其余三个（`@agnes/mcp-helper`、`@agnes/plugin-helper`、`@agnes/skill-helper`）**版本与状态逐字相同** | `agh package status` 两处实跑（4181 4 行 / 4180 3 行） |
| P0-F122 | **根本没有这个包可装**：`agh package catalog attach` / `conversation` / `web` 三次查询全部返回 `No catalog packages found.` | 4181 实跑（read-only） |
| P0-F122 | daemon 的**客户端模块花名册**两侧都几乎为空：主 home `{"packages":{}}`；p0 home 只有探针包那一项。**没有任何 attachments 相关条目** | `%USERPROFILE%\.agh\data\daemon\client-modules\local-dev\_client-modules.json`；`D:\agh-p0-home\data\daemon\client-modules\local-dev\_client-modules.json` |

⇒ 要求 2（`agnes package enable/install` 补齐）**没有对象可操作**：可安装包集合两侧一致，catalog 里也不存在该包。
**本节未执行任何 enable/install**（没有可执行目标，且非 TTY 下安装会走 INV-33 拒答门）。

### M.3 模块其实**已经在装配**——缺的不是装配，是功能

| 编号 | 结论 | 依据 |
|---|---|---|
| P0-F123 | 4181 **实际在服务**的前端产物里，该槽位与 composer 挂载点**都在**：`app.js` 755193 B，命中 `conversation.input.attachments`（偏移 504226）、`conversation.attachments`（334540）、`data-agnes-composer-dsh`（516947） | `Invoke-WebRequest http://127.0.0.1:4181/app.js`（真实 HTTP 取回的运行态 bundle，不是仓库 dist 猜测） |
| P0-F124 | **同一个 bundle 里没有任何上传/粘贴代码**：`upload` / `Upload` / `clipboardData` / `DataTransfer` / `type="file"` **全部为 none** | 同上，逐串 `IndexOf` 求值 |
| P0-F125 | `attachments.ts` 是**空占位**：`createConversationAttachmentsRenderer()` 只造一个 `hidden=true` 的 div，注释原话 *"The current protocol has no attachment node. Keep the surface explicit and empty rather than manufacturing attachment content"* | `web-units/src/conversation/attachments.ts:6-22` |
| P0-F125 | 该占位函数的**唯一出现处只有它自己的定义文件**：`index.ts` 没有 re-export，`packages/web` 里也没有任何调用点；它的标识串同样**不在** `app.js` 里（构建期被摇掉 / 从未被引用） | 全仓检索 `createConversationAttachmentsRenderer`（仅 `attachments.ts:10`）；`app.js` 串检索为 none |
| P0-F126 | 反过来看"容器"侧：`Conversation` 确实渲染了 `data-agnes-conversation-slot="attachments"` 的 DOM 容器并把它交给 `onMount`，但**客户端没有任何代码消费 `children.attachments` 去挂载该单元**（`web/src` 全目录无 `createConversationAttachmentsRenderer` 调用） | `web-units/src/conversation.ts:145-149`、`:89-97`；`web-units/src/index.ts:12-20` |
| P0-F127 | **本工作区没有一个"用户上传物"的产出者**：`.agnes/uploads/20261005_1/upload_f7dd2878-….jpg`（83333 B）存在于磁盘，但全仓（含 `packages/` 与 dist）**没有任何代码引用 `uploads`** —— 仅有的两处是 privacy 遥测的注释与 host 测试名，均与用户附件无关 | 全仓检索（`packages`、`docs`、`tools`、`examples`、`cli/dist`）；该文件 CreationTime = `2026/10/5 10:45:59` |
| P0-F127 | ledger 侧**零次尝试**（复核，非新结论）：p0 home `request/header` 现为 **393 行**（较 P0-F118 的 327 行增长，是本轮新会话所增），**全部** `text-only` / `manifest=0`；inline image 块 0 | 重跑 `p0-media-scan.cjs D:\agh-p0-home\data\sessions.db`（exit 0） |

### M.4 结论（按证据强度）

| 判词 | 强度 | 依据 |
|---|---|---|
| `@agnes/web-conversation-attachments` **不是客户端包**，是内置 web unit，随 web 构建发布，**不按 profile 装配、无需安装/启用** | **源码级 + 运行态**（`app.js` 实测命中） | P0-F121 / P0-F123 |
| **不存在"附件模块缺失"**：两个 home 可安装包集合一致，catalog 里无此包 | **运行态**（两次 `agh package status` + 三次 catalog 查询） | P0-F122 |
| 输入框粘不进图片的**真实原因不是装配问题**，而是**该能力在 HEAD 上不存在**：客户端无粘贴/拖入/文件选择处理，`attachments.ts` 是显式空占位且未被任何代码引用；后端亦无用户上传物的产出者 | **源码级 + 运行态**（`app.js` 逐串求值为 none） | P0-F124 / P0-F125 / P0-F126 / P0-F127 |
| 要求 2（用 `enable/install` 补齐）**不可执行**；要求 3（粘贴 PNG 验证 `manifest>0`）**当前不可执行** | **运行态 + 源码级** | P0-F122 / P0-F124 |

> ⚠ **对要求 3 的处置（重要，避免浪费用户时间）**：判据本身（并发送消息 → 扫同一会话 ledger → `request/header.manifest > 0`）**不改**，但现在**不应当**请用户去粘贴图片 —— 粘贴通道不存在，该实验**必然**得到 `manifest=0`，与"模型看不看图"无关。
> 正确顺序是：**先有入口（M.5 提案），再做该实验**。届时 `manifest>0` 才具备判别力。

### M.5 涉及仓库源码的改动方案（**未实施** —— 本项目对 agnes-harness 无提交授权）

按护栏要求，只列方案与影响，**未改任何文件**。要让"粘一张 PNG"成立，缺口跨客户端、协议、后端三层：

| # | 改动点 | 影响 |
|---|---|---|
| A1 | `web-units/src/composer.ts`：给输入区加 `onPaste` / `dragover` / 文件选择，用 `DataTransfer` 读 `File` | 触及内置 composer 单元与其测试；需定义草稿态与附件态的交互 |
| A2 | `web-units/src/conversation/attachments.ts`：把空占位改成真实附件列表（缩略图/移除） | 该文件当前注释明确写着 *协议没有 attachment 节点* —— 改它等于**先要扩协议**，否则只能hack 本地态 |
| A3 | `web/src/region-slots.ts` / `boot.ts`：把 `children.attachments` 容器真正接给该单元（或改由 DSH 槽位 `conversation.input.attachments` 的第三方包提供） | 涉及会话子单元的挂载契约 |
| A4 | **后端**：需要一个用户附件上传端点 + `attachments` 在被提交时的承载节点（`packages/protocol`），并把上传物**登记进会话可见面** | **这是真正的大头**：与 §3.7 / §K.7 的"登记缺口"是**同一个问题**（现有登记只认 `tool:computer_use`/`untrusted`）。不解决它，图能传上去也进不了模型 |

**影响面**：至少跨 `web-units` / `web` / `protocol` / `core(+daemon)` 四个包，且落在**媒体面访问控制的权限模型**上。
**建议**：这属于"产品能力缺口"，应先成为设计决定（与 §K.7 的分支 B 落点合并考虑），**不应由本工作区直接改源码**。

**本轮未做之事**：未改任何仓库文件；未执行任何 `enable/install`；未在 UI 中复现粘贴失败；未请用户做粘贴实验（见 M.4 的处置）。

## R. v0.1.5：五项修补 + 脏数据保护（2026-10-06，全部实测）

背景：§Q.11.4 的三项必修 + §Q.11 过程中新发现的两项。

| 编号 | 事实 |
|---|---|
| P0-F163 | **孤儿停止的失败点是 `-File <包外路径>`**：helper `.ps1` 在包内（工作区外），在 file 作用域 confine 下按路径执行会挂住（19 s ≈ 身份探针的 15 s 超时）。改为 **`-EncodedCommand` 内联**（UTF-16LE base64；`-EncodedCommand` 不转发位置参数，故 pid 烘焙进正文）。**实测走通**：`stage=close`、`exec.stdout="EXITED\|requested=True"`、`confirmed=true`、`forceKilled=false`、ledger `origin=tool:agh_blender_stop`（不是 `TOOL_OUTCOME_UNKNOWN`） |
| P0-F164 | **token 路径不写报告**（0.1.4 只接了无 token 分支）：09:02 那次 token 停止有结果送达，但**没有 `stop-report.json`**，与无 token 那次（有 968 B 报告）不对称。0.1.5 起**两条路都落盘** |
| **P0-F165** | **Blender 的嵌入式 CPython 忽略 `PYTHONDONTWRITEBYTECODE`**。探针实测：env `PYTHONDONTWRITEBYTECODE='1'` 确在进程内，`sys.dont_write_bytecode` 仍为 `False`，`__pycache__` 照写。**0.1.4 的"env + 双保险"是无效修复**；且我把它写在 import **之后**，等于没写。0.1.5 改为**导入兄弟模块之前赋值**，实测：起一次 Blender 后快照 `__pycache__` 数 **0** |
| **P0-F166** | **`bpy.ops.wm.quit_blender()`（`/shutdown`）不触发保存确认流程**：脏场景被**静默关闭**，只在系统 temp 留一份 session-recovery。而这是**最常见**的路径（daemon 手里有 token 时都走它）⇒ 真实数据风险 |
| P0-F167 | 处置（用户选 A）：`/shutdown` 新增 `force` 语义 —— 先经主线程读 `bpy.data.is_dirty`；脏且未 force ⇒ **409 `E_DIRTY`**（含提示"先在 Blender 保存，或传 force=true"），**不关窗**；读数失败 ⇒ 500 且"什么都没关"（fail closed） |
| P0-F168 | **脏数据保护的完整实测链**：脏（窗口标题 `*`）→ `stop` **被拒**（`stop-report.json`: `refused:true`、`blockers:["E_DIRTY"]`、`bridge.status:409`、`elapsedMs:44`；桥日志**无** `shutdown requested`；进程仍在）→ `file.checkpoint{label:cube-a-01}` → `stop{force:true}`（报告 `isDirty:true`、`forced:true`、`ok:true`）。**独立佐证**：无头打开该 checkpoint ⇒ `objectCount=4` 且含 `cube_a` —— 脏状态真被存住 |
| P0-F169 | CLIXML 噪声：PowerShell 把进度流以 CLIXML 写进 stderr（污染 `exec.stderr`）。改用 `$ProgressPreference='SilentlyContinue'`（脚本内）+ `-OutputFormat Text` |
| P0-F170 | 操作者（我）两个错误：① 用 `$home` 当变量名，撞 PowerShell **只读自动变量 `$HOME`**，路径拼歪 → trust 收到空参数（`$pid` 那次同类）；② 替换 `parameters: {[Kind]:'Object', ...PROBE_EMPTY_INPUT}` 这个**多处共用的样板**时命中 3 处，把 `force` 误加给 `start`/`probe` ⇒ 已还原并核验（只有 `stop` 声明 `force`） |
| P0-F171 | 模型给出一处**不实陈述**：称实例 `7441a351` 下"start-report / stop-report / journal 仍保留"，实测该目录**没有 `stop-report.json`**。规矩：**引用文件是否存在，先 `Test-Path`，不要据推断陈述** |

### R.1 停止功能的四条路径：全部实测完毕（原"仍未验"已关闭）

| 编号 | 场景 | 路径 | 实测结果 |
|---|---|---|---|
| P0-F172 | 干净 | 无 token（WM_CLOSE） | 静默关闭，`confirmed: true`（08:58，实例 899ef712） |
| — | **脏** | 有 token（`/shutdown`） | **拒绝** `E_DIRTY`（409），窗口留着（09:08，实例 bbff500b） |
| — | **脏** | 有 token + `force` | 关闭，`isDirty: true`、`forced: true`（09:10；且此前 `file.checkpoint` 已存住含 `cube_a` 的副本） |
| **P0-F173** | **脏** | **无 token（WM_CLOSE）** | **`STILL_RUNNING`、`confirmed: false`**，Blender 停在保存对话框，`identity.observed/expected` 逐字相同、`exec.stderr` 为空、`forceKilled: false`（09:14，实例 0871d437） |

**同轮顺带验证**：`disable`/`enable` 全程**没有** `E_PACKAGE_INTEGRITY`（修复①在包操作路径上成立，第二次独立验证）；重载前后快照 `__pycache__` 均为 **0**。

**结论**：`agh_blender_stop` 在四种组合下行为一致且如实 —— **永不静默丢弃未保存内容、永不强杀、无法确认时如实回报并把决定权交回人**。0.1.5 的第 ④（identity 实值）与第 ⑤（CLIXML 噪声）两项亦在此轮得到实测确认。

## S. v0.1.6~0.1.7：`file.open` + 一次真实工程闭环 + 四条教训（2026-10-06）

### S.1 `file.open`（0.1.6）

桥侧 `POST /open`（固定操作，非任意 Python）：`path` + `force`；**脏则 409 `E_DIRTY`**（复用 0.1.5 的语义，读 `is_dirty` 走主线程）；**`documentEpoch` 自增**；回 `previousFilepath`/`wasDirty`/`forced`/打开后的场景。工具 `agh_blender_open`：`isDestructive: true` + `requiresApproval: always`，报告先落盘 `open-report.json`。

| 编号 | 实测 |
|---|---|
| P0-F175 | 脏 → **拒绝**（`blockers: ["E_DIRTY"]`）；`force` → 打开成功（`objectCount 4`，夹具）；**干净后再开一次 → 允许**（`epoch: 2`）；报告逐项落盘 |
| P0-F176 | **打开后立刻读 `is_dirty` 会误报 `true`**（Blender 下一拍才归零 —— 紧接着的第二次打开未被拒即证）。字段已改名 `isDirtyImmediatelyAfterOpen` 并加注释，避免被当成"打开后是脏的" |
| — | 安全边界：启动带 `--disable-autoexec` ⇒ **.blend 内嵌脚本不会自动执行**；文件由 Blender 打开，桥不碰文件内容 |

### S.2 真实工程闭环（用户自己的 .blend）

夹具 `p0-project/demo.blend`（8 对象：地面/桌面/4 腿/太阳/相机）。流程与独立核验（**均为我直读磁盘或另开无头 Blender 量的**）：

| 步骤 | 结果 |
|---|---|
| `agh_blender_open demo.blend` | ok；`previousFilepath=""`、`wasDirty:false`、`documentEpoch:1`；场景明细含每个对象的 location/scale/顶点/材质 |
| `apply_ops` 加椅子+书 | 一批 9 op（2 材质 + 7 基元），`applied=9 objectCount 8→15` |
| 修桌腿缺陷 | 一批 4×`object.transform`；**该缺陷是夹具脚本的 bug（我写的），模型发现后如实报告、未擅自修改** |
| `file.checkpoint{label:demo-fixed}` | 647508 B；`mainFileUntouched:true`（前后 filepath 都是原文件） |
| `agh_blender_export` | 落盘 `demo-with-furniture.blend`；**checkpoint = staging = 导出文件三方同 hash**（`1771F180…`） |
| **原文件未被改** | `demo.blend` sha 仍 `02BF6F19…`、mtime 仍是创建时刻 |
| **导出物内容** | 无头打开：15 对象；`DeskLeg_1 z=[0.0000,0.7200]`、`DeskTop [0.72,0.78]`、`Book [0.78,0.815]`、`ChairSeat [0.425,0.475]`、`ChairBack [0.475,0.975]`、`ChairLeg_1 [-0.0,0.45]` —— 逐项对齐 |

⇒ **"AI 在用户真实工程里干活"的完整闭环成立**：打开工程 → 建模 → 修缺陷 → 存档点 → 导出独立文件（Host 落盘、永不覆盖）→ **原文件零改动**。

### S.3 四条教训（三条是我的错）

| 编号 | 教训 |
|---|---|
| **P0-F177** | **`inline` 这种"按需开启"的开关等于没有防护**。第二次毒化会话（`E_STEP_FAILED: artifact 7681295b…`）就是模型**自己传 `inline:true`**（它想"先渲染一张校准"）。0.1.7 起**彻底删除**该参数、图片块与 `artifacts.put` —— 工具只回路径/sha/字节数。代码注释写明：**"off by default is not a guard"** |
| P0-F178 | **别按直觉判断"哪个实例是孤儿"**：我按"旧的 pid 是孤儿"想当然，**把当前受管实例说成孤儿**，差点让用户关掉正在用的窗口。正确做法：用 `instance.json` 里的 pid 在进程表里核对（本次 `c6cb3508.pid=16668` 才是受管的，`23dd4e8f.pid=36472` 才是孤儿） |
| P0-F179 | **预检必须指向发布物**：`p0-preflight.mjs` 一直 import 旧探针包 `p0-wiring-probe`，所以"8 工具全绿"测的是**替身**（也因此它没有 `agh_blender_open`）。已改为指向 `agh-blender` |
| P0-F180 | 两处 PowerShell 变量/常量坑：`$home` 撞**只读自动变量** `$HOME`（路径拼歪 → trust 收到空参数）；提取脚本里**硬编码版本号**（`0.1.5`）导致给 `trust` 传了旧哈希被拒。规矩：**脚本不要复用保留变量名，也不要把版本写死** |












## T. 干净 home 验收：通过（2026-10-06）

### T.1 一个必须写进 README 的陷阱（P0-F181）

| 做法 | 结果 |
|---|---|
| **不预建** `AGH_HOME`，直接 `serve` | ✅ **CLI 自己 provision**（root + `cache`/`data`/`profiles` 全部为私有 ACL：仅 `SYSTEM` + 当前用户），daemon 正常起来（实测端口 4183） |
| **先 `New-Item` 建普通目录**再 `serve` | ❌ `local daemon startup failed: daemon child exited before readiness (1)`，真实原因 `Private directory validation failed` —— 原生校验**只"冻结"已是私有的 DACL，从不主动授权**；普通目录继承自盘根的宽松 ACL 必然不通过 |

⇒ **规矩：不要用普通方式预建 `AGH_HOME`，交给 CLI 自己建。** 若确需预建，必须自己设成"仅 SYSTEM + 当前用户"的受保护 ACL（实测这样做也能起来，但那是绕路）。
附带：PowerShell 里 `"$var:"` 会被解析成驱动器限定变量，必须写 `${var}:`。

### T.2 模型凭据是**按 home** 存的（P0-F183）

| home | 凭据 |
|---|---|
| 主 home | `secrets\deepseek`（有） |
| 全新 home | `auth` 空、**无 `secrets` 目录**（没有） |

⇒ **别人装完插件后，需要在 AGH 里配置一次自己的模型/账户**（两处都有 `daemon\web-credential.json` 238 B，那是**网页访问令牌**，不是模型 key，勿混淆）。README 必须写这一句。

### T.3 验收结果（P0-F184）

全新 `AGH_HOME`（由 CLI provision，非预建）→ `install`（人工 `y`）→ `trust` → `enable`：

| 判据 | 实测 |
|---|---|
| 包状态 | `agh-blender@0.1.7 desired=enabled actual=running trusted=true` |
| 工具注册 | **9 个** `agh_blender_*` 全部 `extension.registered`，`extension.loaded 0.1.7` |
| 字节码 | `__pycache__` = **0**（全新 home 亦成立） |
| HTTP | `GET /` → 200 |
| **模型驱动端到端**（新 home 配好凭据后） | ledger 会话 `a62b2292`：`start`（审批 allowed-session）→ `ops_catalog` → `apply_ops`（审批卡含 op 明细）→ `apply_ops` → `scene`，**全部 `isError=false`** |
| 实例 `cdf84abf` | journal 两批：`applied=7`（`object.delete` Cube + 6×`mesh.primitive_add`）与 `applied=2`（`material.set`），`objectCount=8` |

⇒ **"别人装上就能用"这条从假设变成了实测。** 剩余未验的只有与本次无关的外部配置差异（例如对方机器的 Blender 安装位置与版本探测路径）。

## U. 0.2.0：mesh.import + 取景（原来是空操作）+ 实例目录保留（2026-10-09）

上游提出三项。三项都实测完成；其中两处发现"别人已经写过、但坏着"，记录在案。

### U.1 `mesh.import`（P0-F185 ~ P0-F190）

| 编号 | 事实 |
|---|---|
| P0-F185 | **glTF 导入器没有任何轴参数**：`import_scene.gltf` 的属性里只有 filepath / shading / 骨骼相关项（实测枚举其 RNA）。它**总是**按 glTF 标准（Y up）处理 ⇒ 声明的 up axis 非 Y 时必须由我们旋转纠正：`Z` → 绕 X 转 −90°，`X` → 绕 Y 转 +90° |
| P0-F186 | **OBJ 则相反**：`wm.obj_import` **有** `up_axis`（默认 Y）与 `forward_axis`（默认 NEGATIVE_Z）。实测配对 `(forward_axis=NEGATIVE_Y, up_axis=Z)` 能与我们自己的 OBJ 导出**无损往返** ⇒ 采用该固定 forward 轴 + 由调用方声明的 up 轴。`import_scene.obj` 在 Blender 4+ **已不存在** |
| P0-F187 | **轴声明真的在起作用（对照实验）**：同一份 Z-up glb，声明 `Z` → `[3.7, 1.0, 4.0]`（立起）；故意声明 `Y` → `[3.7, 4.0, 1.0]`（躺倒）。它不是"总能凑对" |
| P0-F188 | 拒绝语义五条全部按码拒绝、**且场景保持干净**：`E_NO_SUCH_FILE`、`E_UNSUPPORTED_FORMAT`（.stl）、`E_BYTE_MISMATCH`（声明 bytes 或 sha256 不符）、`E_NO_MESH_IMPORTED`（只含灯光/相机的 glb；导入产生的非网格对象被移除后再拒） |
| P0-F189 | `scale` 相乘生效（`scale=2` → dims ×2）；`name` 重命名最大网格；`size`/`location` **只比较并回报、绝不改动几何**（`selfCheck.{size,location}.{requested,achieved,ok}`）——把"期望值"当断言而不是变换，避免静默重塑调用方要求原样导入的东西 |
| P0-F190 | `catalog()` 发布 `mesh.import`：ops=11，8 个参数与 4 个拒绝码都在契约里 ⇒ **能力驱动的 lower 能看见它** |

### U.2 `describe_scene()` 的 `dimensions` 改用世界 AABB（P0-F191）

**实测**：`Object.dimensions` 是**本地 bbox × scale，且忽略旋转**（Blender 文档亦如此）。后果：导入器用**旋转**实现轴转换，于是那些对象的"最终尺寸"会报成**旋转前**的值。改为 `matrix_world @ bound_box` 的八个角求轴对齐范围：

- 无旋转对象不变（`[12.4, 8.6, 9.3]`、plane `[2,2,0]`、cyl/cone `[3,3,3]`/`[4,4,4]` 全部照旧）
- **有旋转才看得出差别**：`[1,2,4]` 的盒子绕 X 转 90° → 现在报 `[1,4,2]`（旧实现报 `[1,2,4]`）
- 相机/灯光/空物体 → `null`。**注意**：实测表明**每个对象都有 `dimensions`**，相机等返回 `[0,0,0]` 而**不抛异常** ⇒ 规格里"用 `hasattr` 判 None"是**做不到的**，必须用类型闸门（`MESH/CURVE/SURFACE/META/FONT`）

### U.3 取景：别人写过、但**是空操作**（P0-F192）

**实测**：`frame='none'` 与 `frame='all'` 渲出的 PNG **sha 完全相同**（89 475 B，`788697314009`）。根因：那个实现写 `region_3d.view_location/view_rotation/view_distance`，随后**又读回** `region_3d.view_matrix` —— 没有重绘，region 从不重算这些矩阵，于是 `draw_view3d` 拿到的还是旧矩阵。

**修法**：`framed_matrices()` 自己构造 view 与 projection 并直接交给 `draw_view3d`。附带两个坑：

- **`mathutils.Matrix.Perspective` 在 Blender 5.2 不存在**（实测 `AttributeError`）⇒ 手写标准 GL 透视矩阵
- 修后：`frame='all'` 的 `coveredFraction=0.103`、`touchesEdges=false`、`clipped=false`；`inkFraction` 从 2.2% 升到 **10.1%**；几何 `pixelBox` x∈[280,360] y∈[29,326] 与该塔（2×2×8）形状相符；像素实测 `inkBox` y∈[0.078,0.906] 不贴上下边
- 保留 `'none'` 分支：显式请求时才用旧行为（**缺陷必须是显式选择**，不能是默认）

### U.4 新增返回字段：`bounds` / `coveredFraction` / `touchesEdges`（P0-F193）

几何投影（包围盒 8 角 × 交给 draw_view3d 的同一组矩阵）给出确定性度量；另附**像素独立测量** `coverage.inkBox` 用作交叉验证。

**为什么不用"非背景像素占比"作为主指标**：视口渲染里还有**网格、坐标轴、gizmo**，按颜色统计会把它们算成内容 —— 实测 `inkBox` 因此几乎横跨整幅（x∈[0.003,0.991]）。两个数都给了，但**以几何为准**、像素只作上界与交叉验证。

### U.5 实例目录保留（P0-F194）

**实测**：一个工作区里累积了 11 个死实例目录，**没有任何机制清理**。`start` 现在在创建新目录**之前**裁剪：保留最新 20 个，**永不删** pid 仍活着的、**永不删**即将使用的那个。

验证：预置 25 个死目录 → `kept=20 removed=5`（删的是最旧的）→ 结束后 **21 个**（20 + 1 新）。

### U.6 本轮教训

| 编号 | 教训 |
|---|---|
| **P0-F195** | **"别人写过"不等于"它能工作"**：取景函数存在、参数齐全、注释漂亮，但实测它对画面**毫无影响**。凡是承接别人的实现，**先做一次行为对照**（这里是"两种模式出的图 sha 是否相同"），别读代码就下结论 |
| P0-F196 | **别凭记忆假设 API**：我写了 `Matrix.Perspective(...)`，Blender 5.2 里没有这个属性。**先探测再写** |
| P0-F197 | **测试夹具要选不会被别人清空的落点**：我预置的 25 个目录被预检自己的 `rmSync` 先删掉了，导致第一次裁剪验证得出"只剩 1 个"的**假结论**。换独立台架后才拿到真结果 |
| P0-F198 | **期望值写错会伪装成产品缺陷**：本轮两次 `FAIL` 全是我把期望值抄错（`[6.4,6.4,4.0]`、`[0,0,4]`），产品本身是对的。**FAIL 先怀疑断言，再怀疑实现** |

## V. 0.3.0：opcode 扩到 15 个 + 面板做实（2026-10-09）

### V.1 新增 4 个 op（P0-F199 ~ P0-F204）

| op | 语义 | 拒绝码 |
|---|---|---|
| `modifier.add` | `{name, kind, amount?, segments?, axis?}`；kind = `subdivision`(量=levels 1-6) / `bevel`(量=宽度, segments 1-16) / `mirror`(axis X/Y/Z) / `solidify`(量=厚度)。**刻意不 apply**：留成可编辑的修改器栈，烘焙是调用方没要求的破坏性动作 | `E_NO_SUCH_OBJECT` `E_NOT_A_MESH` `E_ARG_ENUM` `E_ARG_RANGE` `E_LIMIT` |
| `light.add` | `{kind: point/sun/area/spot, name?, energy?, color?, size?, location?, rotation_euler?, replace?}`。**能量按种类给不同默认**（太阳是 W/m²，量级个位数；其余是 W，量级几十到几百）——混用会得到离谱的亮度 | `E_NAME_TAKEN` `E_ARG_ENUM` `E_ARG_RANGE` `E_ARG_TYPE` |
| `camera.add` | `{name?, lens? 1..500mm, location?, rotation_euler?, active?(默认 true → 设为 scene.camera), replace?}` | `E_NAME_TAKEN` `E_ARG_RANGE` `E_ARG_TYPE` |
| `object.look_at` | `{name, target}`，target 可以是**对象名**或世界坐标点。相机与灯都朝各自 −Z、+Y 为上 ⇒ 同一套瞄准对两者都成立 | `E_NO_SUCH_OBJECT` `E_ARG_RANGE`（目标与自身重合）`E_ARG_TYPE` |

| 编号 | 实测 |
|---|---|
| P0-F199 | 4 种修改器全部落到栈上且**未被 apply**（`applied: false`），参数被真正采纳（`levels=3`、`bevel.width≈0.02 & segments=3`、`mirror.use_axis=[True,False,False]`） |
| P0-F200 | 4 种灯全部创建成功，默认能量按种类不同（point/area/spot=100，sun=3），显式 `energy=4.5` 与 `color` 生效 |
| P0-F201 | `camera.add` 设了 `lens=35` 并成为 `scene.camera`；`look_at` 指向对象后旋转**确实变化**（`[1.007, 0, 0.322]`）；指向点时退化为"正下方看原点"= 单位旋转（正确） |
| P0-F202 | 6 条拒绝按码生效：非网格加修改器 `E_NOT_A_MESH`、未知 kind `E_ARG_ENUM`、重名 `E_NAME_TAKEN`、`lens=5000` `E_ARG_RANGE`、目标与自身重合 `E_ARG_RANGE`、subdivision levels=99 `E_ARG_RANGE` |
| P0-F203 | `catalog()` 现发布 **15 个 op**，4 个新 op 的参数与拒绝码全部在契约里（27 项断言全 PASS） |
| P0-F204 | **文档不再枚举 op**：op 的权威清单是 `catalog()`（运行时读取）。写进 DESIGN §3.9 的规矩是"**加 op 不必改文档**"，否则文档与实现必然漂移 |

### V.2 面板做实（P0-F205）

原来的面板只显示"进程在不在"。现在它报**两件独立的事**，并且**分别说明是哪一件坏了**：

```
Blender · pid 1234 · port 5678 · running · Blender 5.2.2 LTS
scene "Scene" · 4 objects · 1 meshes · 2 materials · 15 ops
checked 21:12:03                              [refresh]
```

- `blender.status`（query）在实例存活时**顺带读一次 `/scene`**，只回**紧凑摘要**（对象数/网格数/材质数/op 数）——完整场景载荷在大文件上会撑爆服务的 32 KiB 结果预算，而面板只要形状
- 服务上下文**没有 net seam**（那是工具的），所以这里用普通 `fetch` + `AbortSignal.timeout(1500)`
- **关键区分**：bridge 读不到时显示 `scene unreadable: <原因>`，而**进程**那一行照旧 —— "Blender 死了"与"桥没应答"是两件事，不能塌成一句

| 编号 | 实测（service → bridge → scene 全链路） |
|---|---|
| P0-F205 | 无实例 → `scene=null`；start 后 → `alive=true`、`{objectCount:3, meshCount:1, materialCount:2, knownOps:15}`；跑 3 个 op（删 Cube、加球、加太阳）后 → `objectCount:4`、`meshCount:1`；stop 后 → `scene=null` |


