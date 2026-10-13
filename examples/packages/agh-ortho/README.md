# agh-ortho

每次生成尝试都使用独立的临时 `{out}` 目录；失败后用同名重试不会拿上一次残留网格
冒充本轮产物。交付目录仍是 `meshes/<name>`，已存在的交付不覆盖。

生成前会检查上轴和单位声明，缺项不会先运行耗时生成器。源图在生成前固定摘要，
生成结束后再次核对；中途换图或源图消失会拒绝登记，避免把网格错误归因给新图片。
失败、需要修正的结果明确返回 `isError:true`。尺寸与六视图的数值自洽不等于外形还原：
使用 `agh_blender_capture` 把实际渲染图交给模型，与小车原图/透明主体对照再修正。
用户已授权建模时，工具说明不再额外要求人工放行候选图纸；仍须检查参数、
查看实际渲染图再判断外形是否通过。需要修正或证据不足时不能跳过复核。
当前没有真实尺度来源时只能做比例模型，不把图片估计写成准确实测尺寸。

先 `agh_ortho_catalog` 查实际能力，再 `agh_ortho_fit` 验参数，
通过后 `agh_ortho_emit_ops` → `agh_blender_apply_ops` → `agh_blender_scene` →
`agh_blender_capture`。外部生成器未配置时，可以根据原图选择已有基元做参数化模型；
不要编造本机生成器命令。AI 去背景图片用于建模参考，不能替代小车实际照片作为移动依据。

网格生成使用 AGH 的命令执行器，在会话工作区执行并跟随工具取消。预处理和生成共享剩余工具时间；`timeout_ms` 不能延长 AGH 预设的硬上限。继承 `base` 的新会话为 `agh_ortho_mesh_run` 提供 600 秒，旧会话或自定义预设需核对实际期限。

单张图片 → **参数化模型** → 六视图 + ops 批次。

方向是反的：参数是唯一真值源，六视图只是它的确定性投影与校验回路。单张图只含一个
投影方向的信息，另外五个视图在原图中不存在，任何"生成"都是猜；从五张互相矛盾的生成图
反推参数，是两个误差串联。

## 状态：M1 闭环（0.1.0）

七个工具。其中五个是只读纯函数、不写盘；另两个是**变更型**（`requiresApproval: always`，且永不重放）：

| 工具 | 作用 |
|---|---|
| `agh_ortho_catalog` | 回报**协商后**的下游能力面（op 白名单、限额、基元）。写 ops 之前先调它。 |
| `agh_ortho_emit_ops` | 意图层参数 JSON → `agh_blender_apply_ops` 的 `ops` 批次。**只算不写。** |
| `agh_ortho_views` | 参数 → **正交六视图 SVG**（自己算投影，不依赖下游的相机），**外加整张图纸 `sheet_svg`**（六视图排在一张图上、全图一个比例尺）。返回文本，不落盘。 |
| `agh_ortho_verify` | 两档校验。默认只跑 `numeric`：参数 → 六视图 → 反解 → 与参数比对，**残差必须为 0**，不需要 Blender。加 `against_scene: true` 再跑 `scene_readback` 半档：读回真实场景，比对名字/位置/缩放/**尺寸**。 |
| `agh_ortho_fit` | **M2 闭环里"便宜那一半"的入口**，一次给全：逐条 validation、三态清单、numeric、六视图 + **数值轮廓**（供你拿照片做粗核对）、**图纸的指针**（`sheet`：全图比例尺 + 每张视图落在哪一格 + "进 `apply_ops` 之前该复核什么"）、`conf` 的如实标注、`scale_anchor` 的换算与脆弱性、逐项逐轴的 `revise_hints`。只读、不落盘。 |
| `agh_ortho_save` | 唯一写盘的工具（`requiresApproval: always`）。落一个 run：**一张图纸 `sheet.svg`（第一个描述符：复核就看它）**、六个分视图 SVG、参数（**键序已规范化** ⇒ 同值即同字节）、ops、校验结果、`marker.json`、`report.json`（共 10 个描述符；另可传 `scene_file` 把下游导出的 `.blend` **登记**成第 11 个）。`report.json` 除描述符外还带 `checks`（便宜那一档的结论摘要）与 `scene_file`。 |
| `agh_ortho_mesh_run` | **一键生成段**：把照片交给**外部生成器**（命令来自 `.agnes/agh-ortho/mesh-run.json`；插件**不内置任何机器的路径**，缺席即拒），把产出的 `.glb` 按**真实字节**量出尺寸、落到 `.agnes/agh-ortho/meshes/<name>/`，并写一份"**声明 = 实测**"的 `source.json`。argv 先过 `tctx.sandbox.confine()`；超时 / 非零退出 / 没有 `.glb` / 量不出尺寸 / **目录已存在** / **多产出且没声明 `output`** 各有明确错误码。它只**生产输入**：登记与校验仍由 `fit` 与 `save` 走同一条路。 |

`views` 只返回 SVG **文本**、不落盘 —— SVG 本来就是文本，模型读得到；文件与描述符归 `save`。
`save` 遵守上游契约 §5.2：**先把 `report.json` 落到磁盘再返回**，消费者以磁盘上的报告为准。

`emit_ops` 的 lowering 覆盖 `slab` 与 `box`（M1 范围）。其余意图进 `unlowered[]`，并区分两
种**必须区分**的原因：`no_downstream_op`（下游表达不了，等 M3/M4）与
`not_implemented_in_m1`（下游能做，本 emitter 还没做）。

这个区分必须一路传到最终用户面前：降级误差是**最隐蔽**的误差源，参数可以拟合得很准而下游
表达不出来，最后模型还是错的。

## 自检

```bash
node agh-ortho/tools/check.mjs     # 零依赖，不需要 Blender
```

覆盖工具定义结构、七个工具的行为、5 个负例（把 lowering 改坏残差必须非 0）、落位假设、
单位/投影的拒绝路径，以及生成段的四条拒绝路径（配置缺席 / 无沙箱缝 / 覆盖已有目录 / 多产出）。当前 **ALL PASS**。


## 设计契约

`../notes/CONTRACT.md`。**文档不放包内**：包会被复制成内容寻址快照，包内任何改动都会改
`integrity`，逼一次重装与重新 trust。改 `notes/` 零成本，改 `package/` 不是。

## 安装（需要在真实终端，非 TTY 会被拒装）

```bash
# 在 D:\agnes-harness 根目录
node packages/cli/dist/local/agnes.mjs package inspect file:./agh-ortho/package
node packages/cli/dist/local/agnes.mjs install        file:./agh-ortho/package

# 用真实值（安装成功后默认 disabled）
node packages/cli/dist/local/agnes.mjs package trust  ext:agh-ortho/runtime <INTEGRITY> <CAPABILITY_HASH>
node packages/cli/dist/local/agnes.mjs package enable ext:agh-ortho/runtime
node packages/cli/dist/local/agnes.mjs package status
```

注意本机 dist 与源码有差异：**没有 `agh package install` 这个子命令**，正确形式是上面的
`install <source>`。`package inspect` / `package trust` / `package enable` 存在。

**`capabilityHash` 不在 inspect 的文字输出里** —— `formatPreview()`
（`packages/cli-tui/src/package-admin.ts`）只印 id@version / integrity / contributions /
warnings。`integrity` 从上面那行取；`capabilityHash` 从安装/信任记录或 Web 端的预览取
（见 `notes/SKELETON-STATUS.md` §7，这一点尚未实测确认）。

## 为什么零依赖

纯 ESM，只用 `node:crypto` 与 `node:fs`。没有 build 步骤、不需要 `pnpm install`、
不动 workspace。改一行代码 = 重装一次，不存在"改了源码忘了构建"这一类坑。
六视图渲染器（M1 下一步）也自写正交投影 → SVG 字符串，同样零依赖。

agh_ortho_surface_ops handles implicitly or explicitly closed revolve profiles and curved tube handles. Self-intersecting sections and duplicate object names are refused before building. It emits all six numerical views in a compact summary; the detailed SVG remains in structured details and, where supported, a readable artifact. scene_readback=true checks actual mesh type, position, scale, rotation and bounds. Tube bounds are conservative control-hull checks, not proof of photographic resemblance. A readback call returns no build operations. Compare the final material render with the original. Do not pass revolve/tube into the legacy intent assembly of agh_ortho_fit.
review.previewFraming gives the modeled parts' combined center and conservative bounding sphere, plus an orthographic scale with a 25% margin for square images. Aim the scene camera at that center; change lens/ortho_scale using camera.add replace=true on your own camera, not object.transform. Other scene objects may still occlude the model, so inspect the actual preview. Start fresh photo-modeling instances with empty=true; reused instances retain existing user work.

GLB measurements and six-view outlines share the active-scene vertex reader. It composes ancestor TRS/matrices and reads every mesh primitive, including negative scale; it does not trust accessor min/max declarations. Unsupported compression, deformation, malformed buffers and cyclic nodes are refused. Run IDs are bounded simple names, never paths. Existing unmarked directories and mismatched marker/report identities are refused before writes.
