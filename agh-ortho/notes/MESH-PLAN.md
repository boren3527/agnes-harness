# MESH PLAN —— 网格路的执行流程（v0.1，2026-10-09）

> 目标：**打开 AGH → 给一张图 → 两个插件产出 3D 模型**，中间无人手操作。
> 分工：**A 段（生成，重、带卡）** 与 **B 段（装配，轻、本机）** 只通过
> `meshes/<名字>/{*.glb, source.json}` 交接（见 `MESH-PATH.md`）。
> 详细技术依据一律在 `MESH-PATH.md`，本文只排"谁在什么时候做什么、拿什么当验收"。

## 阶段 0（你，在那台 Windows GPU 机器上）——**先做，它是最高风险点**

| # | 做什么 | 验收（可判定） |
|---|---|---|
| 0.1 | Blender：已有 ✓。装完 AGH 后用 `agh_blender_probe` 确认能**发现**它 | 不再报 `no blender.exe candidate found` |
| 0.2 | **StdGEN 环境**：Python 3.11 + **cu128 的 torch 2.7+**（不是 README 钉的 cu118）+ 依赖。`nvdiffrast` / `pytorch3d` / `torch-scatter` 要**编译**（MSVC Build Tools + CUDA Toolkit）—— **这一环最脆** | `python -c "import torch;print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"` → `True` + 卡名 |
| 0.3 | 权重：HF `hyz317/StdGEN` + `sam_vit_h_4b8939.pth` → `./ckpt/` | 无报错加载 |
| 0.4 | 跑四阶段（脚本：`agh-ortho/tools/cloud/run_stdgen.sh`，Windows 用同序命令） | **`result/refined/<名字>/out_{0,1,2}.glb` 存在** |
| 0.5 | 把产物放进本地工作区：`.agnes/agh-ortho/meshes/<名字>/`（含 `source.json`，模板已在 `meshes/README.md`） | 目录里 3 个 `.glb` + `source.json` |

**0.4 是整条路的门槛**：那三个 `.glb` 出不来，后面全是空中楼阁。**不需要**为了它先装 AGH —— 先证明生成段能跑。

## 阶段 1（我，本机，不依赖卡）—— 与阶段 0 并行

| # | 做什么 | 状态 |
|---|---|---|
| 1.1 | `LOWERING.mesh` 从 `unsupported/no_downstream_op` 翻成**能力驱动**：下游目录里出现 `mesh.import` 就 `exact`，否则如实 `unsupported`（不假装支持） | 进行中 |
| 1.2 | 网格项校验：声明（`unit`/`upAxis`/`declaredHeight`）**必须**齐；`save` 侧读盘复核（`source.json` + GLB 的 accessor 包围盒）→ **不符即 blocking** | 待做（依赖 1.1） |
| 1.3 | 第 12 个描述符 `mesh`（像 `scene` 那样**登记不复制**） | 待做 |
| 1.4 | `mesh_run` 工具（用 `tctx.sandbox.confine()` 拉起 StdGEN 脚本，收产物、写 `source.json`）—— **"一键"的最后一公里**。接口先定，命令等 0.2/0.4 的真实路径 | 待做 |
| 1.5 | 编排写进 `LOOP-PROCEDURE.md`（A→B 顺序、两个 `run_id`、part 级账本） | 待做 |

## 阶段 2（下游）——**我会主动提醒你**

| # | 做什么 | 触发条件 |
|---|---|---|
| 2.1 | 新增 `mesh.import` op（签名草案在 `MESH-PATH.md` §6，含四种必须明确报错的拒绝语义） | **1.1 完成、且手上有一个真实 `.glb`（0.4 的产出）时** —— 早改也没法验 |
| 2.2 | 顺带：`capture` 取景（请求 §6）、`stop` 的 PID 回落、实例目录保留 | 同上，一次发过去 |

## 阶段 3（接成一键）

1. 把 1.4 的 `mesh_run` 接上 0.2 的真实 python 命令 → 工具可用。
2. 会话里走全流程：给图 → `mesh_run` → `mesh.import` → `fit {against_scene:true}` → `save`
   （12 个描述符：图纸 + 六视图 + 参数 + ops + 校验 + `scene` + `mesh`）→ `stop {force:true}`。
3. 验收（`MESH-PATH.md` §8 那四条）：包围盒与声明一致、part 级账本齐、图可复核、交付含模型本身。

## 硬规矩（沿用既有那几条，不因网格路放宽）

- 声明**不是**真相：`unit`/`upAxis`/`declaredHeight` 一律**测量复核**，不符 **blocking**。
- 生成网格**不可复现** ⇒ 记全 `model`/`weights`/`seed`/输入图 sha256；**不要**用哈希判断两次生成"是不是同一个网格"。
- 形状**验不了** ⇒ 只能靠人看图（`capture`），而"两张图可比"依赖**统一取景**。
- 已落盘的 run **只读**；复核轮与交付轮用**不同** `run_id`。
