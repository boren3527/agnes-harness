# MESH PATH —— 网格路的约定（v0.1，2026-10-09）

> 这份文件回答"外部生成器 → AGH → 下游 Blender"这条路上**必须先定死**的四件事。
> 依据是**两个项目的真实代码**（不是它们的宣传语），逐条给出处。

## 0. 结论速览

| 问题 | 结论 | 依据 |
|---|---|---|
| 格式 | **GLB（glTF 2.0 binary）**；OBJ 只作参考 | 两者都 `import pygltflib` / 用 trimesh 导 `.glb` |
| 单位 | **不猜**：由 sidecar 声明 + 我们测量校验 | 两者导出的都是"重建空间"坐标，**没有一处声明单位** |
| 轴向 | **不猜**：由 sidecar 声明 + 我们测量校验（见 §2 实测到的两个不同约定） | StdGEN 导出前 `vertices[:, [1,2,0]]`；CharacterGen 导出前 -90°X + 180°Y |
| 落盘 | `<workspace>/.agnes/agh-ortho/meshes/<名字>/{mesh.glb, source.json}` | 工作区内、gitignore、输入与交付物分开 |
| 关节绑定 | 不在本约定内；**已知有开源答案：UniRig**（CharacterGen README 指向） | CharacterGen README 第一段 |

## 1. 格式：GLB（两者都能吐）

- **StdGEN** `infer_slrm.py`：`from slrm.utils.mesh_util import save_obj, save_glb`，
  `make_mesh()` 里 `save_glb(vertices, faces, vertex_colors, mesh_glb_fpath)` ——
  **同时**写 `.obj` 与 `.glb`，且是**逐语义层**各写一份（`for j in [0,3,4,2]`，
  文件名 `<name>_<level>.obj/.glb`），另有每层一个 `.mp4` 转盘视频。
- **CharacterGen** `3D_Stage/webui.py`：`traverse()` 里 `mesh.export(f'{path}/output.glb', file_type='glb')`，
  并把 `output.obj` 一起给你；界面自己写着 "OBJ 那个是 flipped，下载用 GLB 的才对"。
- **选 GLB 的理由**（不只是"两者都吐"）：glTF 规范**把 1 单位定义为 1 米**，而 OBJ **没有单位**；
  GLB 单文件自带贴图/顶点色 ⇒ **sha256 天然覆盖整个资产**，不会有"哪些附属文件算数"的歧义。
- **注意两者的"资产"范围不同**：StdGEN 是**顶点色**（`use_texture_map=False`），
  CharacterGen 会外挂 `texture_kd.jpg` / `refined_texture_kd.jpg`。所以**登记 sha256 时要以 GLB 单体为准**，
  附属 jpg 若存在则另列。

## 2. 轴向与单位：实测到的两套约定（都不许猜）

- **StdGEN**：`vertices = vertices[:, [1, 2, 0]]` —— 导出前做了一次**轴重排**（x,y,z → y,z,x），
  即把内部的 Y-up 换成 **Z-up**。这与我们的链路（`up=Z`）**天然一致**。
- **CharacterGen**：`traverse()` 里连着两次旋转
  `rotation_matrix(90°, [-1,0,0])` 然后 `rotation_matrix(180°, [0,1,0])`，再导 GLB ——
  即它的 GLB 轴向是**它自己那两步旋转的结果**，不是"glTF 默认 Y-up"。
- **两者都没有声明单位**：坐标落在重建空间里（InstantMesh / TripoSR 家族），
  **可能被归一化到某个尺度**（不保证 1.0，也不保证米）。所以：

**规矩（唯一允许的做法）**：`source.json` 里声明 `unit` / `upAxis` / `declaredHeight`，
导入后我们**用包围盒测量复核**；**不符即 blocking**（不是 warning）。
和 `scale_anchor` 同一招：**拿一个声明过的长度去校一个测出来的长度**。
**明确不做**：从包围盒尺寸"自动猜"单位 —— 那是猜测。

## 3. 落盘：`.agnes/agh-ortho/meshes/<名字>/`

```
D:\agnes-harness\.agnes\agh-ortho\meshes\<名字>\
    mesh.glb        生成器产物（若生成器还给了 jpg/mtl，一并放这里）
    source.json     生成脚本必须写的声明（见 §4）
```

理由三条：**① 必须在工作区内**（我们的 fs 缝读字节算 sha256、下游的 `sandbox.confine()` 都以工作区为界）；
**② `.agnes` 已在 `.gitignore`**（几十 MB 的网格不该进仓库）；**③ `outputs/` 留给交付物**
（`.blend` 在那儿），**输入与交付物不混** —— 这也是"两条轴不要混"的延续。

## 4. `source.json` 的字段（生成脚本负责写，我们负责核）

```json
{
  "generator": "StdGEN",
  "generatorRevision": "<commit 或 release>",
  "stage": "refine",                       // StdGEN: slrm | refine；CharacterGen: 3d_stage
  "model": "<权重名/仓库>",
  "weights": "<可识别版本或 sha256>",
  "seed": 0,
  "inputImage": "<照片的绝对路径>",
  "inputImageSha256": "<照片的 sha256：我们算的，不是脚本自报的>",
  "file": "mesh.glb",
  "unit": "normalised",                    // m | cm | mm | normalised —— 声明，不猜
  "upAxis": "Z",                           // X | Y | Z
  "forwardAxis": "-Y",
  "declaredHeight": 1.0,                   // 生成器保证的一个长度（例如"总高归一化到 1.0"）
  "declaredHeightKind": "normalised",      // normalised | metres
  "parts": { "body": "mesh.glb" },         // StdGEN 分层时：每个语义层一个文件
  "notes": "…"
}
```

**分工**：脚本声明 → 我们测量 → 不符 blocking。脚本**不许**声明它没量过的东西
（例如 `declaredHeight` 必须是生成器本身保证的归一化量，不是它目测的）。

## 5. 断言边界（写清楚，免得以后指望它）

- **能断言**：对象**存在**、类型是 MESH、**位置/缩放/尺寸**（`scene_readback`，逐行相对容差）、
  **命名**、`part` 归属（body/clothing/hair/…）、**来源**（`source`：model/weights/seed/输入图 sha256）。
- **不能断言**：**形状**（网格长什么样没有任何一档能验）、与照片的一致性（需要相机渲染 + 人眼）。
- **不可复现**：生成网格**不是**可复现产物（不像我们的参数/ops/图纸）——
  所以 `source.json` 记全 model/weights/seed/输入图 sha256，并且**不要**用哈希判断两次生成"是不是同一个网格"。

## 6. 下游需要什么：`mesh.import` 的请求签名（草案）

```
mesh.import {
  path:      绝对路径（工作区内），指向 .glb
  name?:     对象名（不合法字符按下游规则处理）
  upAxis?:   "X"|"Y"|"Z"   默认 "Z"      // 由 sidecar 的声明驱动，不由下游猜
  scale?:    number        默认 1        // 把 declaredHeight 换算成米的那个倍数
  location?: [x,y,z]
}
```

拒绝语义（都要明确报错，不许静默）：文件不存在 / 格式不支持（非 .glb/.obj）/ 读到的字节与声明不符 /
导入后**没有任何 MESH 对象**。并在 `describe_scene()` 里对导入对象照常给出 `dimensions` 与 `polygons`
（已有能力），于是"声明 vs 测量"这一比对在上游就能做完。

## 7. 还缺的两块（不在本约定内）

1. **关节绑定**：两个项目都不提供（CharacterGen 只说它"适合下游装配"）。
   **新发现**：CharacterGen README 指向 VAST-AI-Research 的 **UniRig**（自动绑骨）——
   这是"正交的第三块"目前最有希望的开源答案，值得单独评估。
2. **网格的"人复核"**：形状验不了 ⇒ 只能靠 `capture` 出图给人看；
   而"两张图可比"依赖 **统一取景**（见 DOWNSTREAM-REQUEST-readback.md §6）。

## 8. 两段式：生成段在哪里跑（成品取向）

**"成品"不是"在本机装完 StdGEN"**，而是把两段分清楚：

| 段 | 是什么 | 跑在哪 | 特征 |
|---|---|---|---|
| **A 生成段** | 单图 → 网格（`agh-ortho/tools/cloud/run_stdgen.sh`） | 有足够显存的机器：**云 GPU（按小时）或带卡的工作站** | 重、一次性/离线、可批量；**与 AGH 不要求同机** |
| **B 装配段** | 参数路 + 网格路 → 校验 → `.blend` + 描述符包 | **本机（这台笔记本）** | 轻、可重复、可审计、每次改动都跑 |

两段之间**只有一个接口**：`meshes/<名字>/{*.glb, source.json}`（§3/§4）。这条线定死之后，
A 段换机器、换版本、换模型都不影响 B 段。

三条**不建议**的 A 段落法，理由各自不同：

- **官方 HF Space**：零装、今天就能用，但**排队/限流/随时可变或撤下**，且要把立绘**上传给第三方**
  （版权 + 隐私）。→ 只当"今天先攒一个样本"的桥，不当成品。
- **本机 Windows**：RTX 5060 Laptop 只有 8 GB，且 50 系（sm_120）**没有 cu118 的轮子**
  （README 钉的 torch 2.1.0 会直接 "no kernel image for execution"）；要跑得换 cu128 的 torch 2.7+，
  再连带编译 `nvdiffrast` / `pytorch3d` / `torch-scatter` / `xformers`。**又贵又脆**。
- **本机 WSL2**：编译成功率高得多，但 8 GB 显存仍是硬约束（S-LRM + SAM-ViT-H 权重 + pytorch3d 渲染）。次优。

**建议（方便且有效）**：租一台云 GPU，**一次性**装好环境并**打成镜像/快照**，之后每次
"开机 → 跑 `run_stdgen.sh` → 关机"。一次装、长期用，成本与风险都可控；产出物**只经由上面
那一个接口**回到本机。而 B 段这条闭环（参数路 + 读回 + 描述符包）已经在本机反复跑通、可审计。

### 成品验收（可判定，不靠感觉）

1. **导入后包围盒与声明一致**：`declaredHeight` / `upAxis` 与实测不符 ⇒ **blocking**。
2. **part 级账本**：三个语义层分别登记 `body` / `clothing` / `hair`；缺哪层要看得见。
3. **图可用于复核**：`capture` 出图满足"**不贴边 + 占比足够**"两条（见请求 §6）。
4. **交付包含模型本身**：`scene`（已实现）；网格路再加 `mesh`。
