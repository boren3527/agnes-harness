# agh-blender

用 Agnes Harness（AGH）驱动本机 Blender 建模的插件。

> 分支：`BOREN`。这是开发分支，成品在 `package/`（可安装），设计与证据在 `docs/`。

## 目录

| 路径 | 内容 |
|---|---|
| `package/` | **可安装的 AGH 插件包**（12 个文件）。别人装的就是这个 |
| `docs/DESIGN.md` | 权威设计与实现规范（每条约束都标了来源：v1.1 要求 / 本机 P0 实测） |
| `docs/P0-EVIDENCE.md` | 证据台账（P0-F1 ~ P0-F210）：每条都写了**怎么得到的**与**当前状态** |
| `docs/CONTRACT-STABILITY.md` | 给上游生产方（`agh-ortho`）的**读回契约稳定性承诺** + 精确期望值表 |
| `docs/UPSTREAM-ARTIFACT-CONTRACT.md` | 与"产物产出型插件"的两方契约草案（描述符 schema、落点、错误码） |
| `docs/UPSTREAM-ISSUE-license-allowlist.md` | 给 Agnes Harness 上游的 issue 草稿：许可白名单拒绝时**不说原因** |
| `tools/reinstall.ps1` | 一条命令走完 `inspect → disable → remove → install → trust → enable → 核对` |

**为什么文档不放进 `package/` 里**：AGH 对已安装包整棵树取哈希，包内任何文档编辑都会改变 `integrity`，导致必须重走 `disable → remove → install → trust → enable`（含一次人工确认）。所以文档与包平级、不进入包内。

## 它是什么

一句话：**让模型用一组固定的、可审批的"建模动词"去操作你本机真实的 Blender —— 不是跑任意脚本。**

- **Blender 侧零安装**：插件用 `blender.exe --factory-startup --disable-autoexec --python <bootstrap.py>` 启动一个受自己管理的实例，不用装任何 add-on、不改你的偏好。
- **只有白名单动作**：一组结构化 opcode（当前 **16** 个；**权威清单是运行时的 `agh_blender_ops_catalog`，不在这里列举** —— 列在这里必然漂移）。**没有** `eval`、**没有**任意 Python 执行。
- **改不坏、丢不掉**：一批 op = 一次 undo；存档点用 `copy=True/relative_remap=True`；导出永远写**新文件**、**永不覆盖**；停止时脏场景会被**拒绝**（`E_DIRTY`），绝不强杀。
- **过程可见**：一次一小步，你在**自己的 Blender 视口**里看构件一块块长出来。

## 工具（9 个）

| 工具 | 作用 | 审批 |
|---|---|---|
| `agh_blender_start` | 发现 blender.exe、校验版本、经 `sandbox.confine()` 启动受管理实例并完成 token 握手 | 总是 |
| `agh_blender_probe` | 只读：实例是否存活、`/health`、握手 | 免 |
| `agh_blender_stop` | 停止实例；脏场景默认**拒绝**（`E_DIRTY`），`force:true` 才丢弃 | 总是 |
| `agh_blender_apply_ops` | 执行一批白名单 opcode（≤64 条） | 总是 |
| `agh_blender_scene` | 只读：场景对象/材质/位置/缩放/顶点数 | 免 |
| `agh_blender_ops_catalog` | 只读：opcode 契约（每个 op 的参数、类型、范围、示例） | 免 |
| `agh_blender_capture` | 离屏渲染一张 PNG 到实例目录，**只回路径/sha/字节数** | 免 |
| `agh_blender_open` | 打开已有 `.blend`（`documentEpoch` 自增；脏则拒绝） | 总是 |
| `agh_blender_export` | 把当前状态导出成**新** `.blend`（经 Host 落盘、永不覆盖） | 总是 |

## 安装

前置：**AGH**（本仓库） + **Blender 4.2+**。Blender 侧**不需要**安装任何东西。

```sh
# 1) 装（出现 [y/N] 时按 y；非交互终端会拒绝安装，这是刻意的安全不变式）
node packages/cli/dist/local/agnes.mjs install "file:./agh-blender/package" --profile local-dev

# 2) 取 integrity 与 capabilityHash（从上一步的输出或 daemon 的 operations.json）
node packages/cli/dist/local/agnes.mjs package trust  agh-blender <integrity> <capabilityHash> --profile local-dev
node packages/cli/dist/local/agnes.mjs package enable agh-blender --profile local-dev
```

**必须在 AGH 里配置一次模型/账户** —— 凭据是**按 home 存储**的，新 home 不继承（`secrets/` 里没有它时模型不会回应）。这不是插件的问题，是"每个人用自己的 key"。

两个已知陷阱（详见 `docs/DESIGN.md` §9）：

- **不要预建 `AGH_HOME` 目录**：`New-Item` 造出的普通目录会让 daemon 以 `Private directory validation failed` 拒启（它只"冻结"已是私有的 ACL，从不主动授权）。**交给 CLI 自己建。**
- **许可**：AGH 的信任闸门只接受 MIT / Apache-2.0 / BSD / ISC / 0BSD / MPL-2.0 / Unlicense；**所有 GPL 变体都会被拒**（`E_PACKAGE_TRUST`，且不告诉你原因）。

## 诚实的边界

| 做不到 | 原因 |
|---|---|
| 把**插件生成的图**送进模型 | AGH 的请求媒体面只接受来自 computer-use 通道的产物；工具结果里出现图片块会让该轮失败（`E_STEP_FAILED`）并**永久毒化该会话**。所以 `capture` 只回路径，图给人看 |
| **自动多视角参考图** | 需要专门的 3D 生成模型（Zero123 / MVDream / TripoSR 一类），不在本插件范围 |
| 单张照片 → **写实**网格 | 开放问题。本插件走的是**参数化低模**（卡通/人形/道具/建筑） |
| 打开 `documentEpoch` 之前的历史 | 纪元只标识"打开前/后"，不提供跨纪元的引用解析 |

## 许可

本仓库采用**两套声明**（因为 Blender 侧脚本 `import bpy`，属 Blender 的衍生作品）：

- 根目录与 AGH 侧代码：**Apache-2.0**（`package/LICENSE`）
- `package/extensions/main/bridge/`：**GPL-3.0-or-later**（`package/LICENSE-GPL`、`package/extensions/main/bridge/HEADER.txt`）

再分发时**必须同时保留两份许可**并保持这个目录拆分。许可选择已由仓库所有者确认；本项目只做过 `bpy.` 引用扫描，**没有做法律审查**。
