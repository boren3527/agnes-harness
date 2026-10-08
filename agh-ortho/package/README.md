# agh-ortho

单张图片 → **参数化模型** → 六视图 + ops 批次。

方向是反的：参数是唯一真值源，六视图只是它的确定性投影与校验回路。单张图只含一个
投影方向的信息，另外五个视图在原图中不存在，任何"生成"都是猜；从五张互相矛盾的生成图
反推参数，是两个误差串联。

## 状态：M1 闭环（0.1.0）

五个工具。前四个是只读纯函数、不写盘；第五个是唯一的变更型工具：

| 工具 | 作用 |
|---|---|
| `agh_ortho_catalog` | 回报**协商后**的下游能力面（op 白名单、限额、基元）。写 ops 之前先调它。 |
| `agh_ortho_emit_ops` | 意图层参数 JSON → `agh_blender_apply_ops` 的 `ops` 批次。**只算不写。** |
| `agh_ortho_views` | 参数 → **正交六视图 SVG**（自己算投影，不依赖下游的相机）。返回文本，不落盘。 |
| `agh_ortho_verify` | `numeric` 档校验：参数 → 六视图 → 反解 → 与参数比对，**残差必须为 0**。 |
| `agh_ortho_save` | 唯一写盘的工具（`requiresApproval: always`）。落一个 run：六个视图 SVG、参数、ops、校验结果、`marker.json`、`report.json`（描述符）。 |

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

覆盖工具定义结构、四个工具的行为、5 个负例（把 lowering 改坏残差必须非 0）、落位假设、
单位/投影的拒绝路径。当前 **ALL PASS**。


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
