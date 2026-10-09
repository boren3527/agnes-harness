# 给下游的一个请求：场景读回里缺尺寸

> 面向 `agh-blender`（下游）。**不是现在做** —— 按 CONTRACT §11 的纪律攒进 M3 一批做。
> 这份文件放在 `agh-ortho/notes/`（包外），改它零成本；改下游要重装 + 重新 trust。

## 1. 为什么要

`agh-ortho` 的校验分两档（CONTRACT §9）：

| 档 | 验什么 | 需要 Blender |
|---|---|---|
| `numeric` | 参数 → 六视图 → 从视图反解 → 与参数比对，残差必须为 0（**几何自洽**） | 不需要 |
| `against_blender` | ops → 真实场景 → 读回 → 与我们预测的几何比对（**下游真的照做了**） | 需要 |

`numeric` 有三条已知盲区，其中**第二条只能靠下游闭合**：

1. 落位规则 `placementOf` 是两条路径共享的；
2. **尺寸语义桥从来没被真实场景验证过** —— 我们把 `box` lower 成
   `mesh.primitive_add{kind:'cube', size:1, scale:[w,d,h]}`，这依赖一个假设：下游的
   `primitive_cube_add(size=1)` 真的产生单位边长。这个假设只是从源码读出来的；
3. 下游的拒绝（`E_LIMIT` / `E_ARG_*`）不在 `numeric` 的覆盖范围内。

第 2 条的验证只需要"读回真实场景里每个对象的**最终尺寸**"，不需要渲染。

## 2. 现状（实测）

`agh-blender/package/extensions/main/bridge/agh_ops.py` 的 `describe_scene()`（约第 612 行）
每个对象只回：

```
name · type · location(round 6) · scale(round 6) · vertices · polygons · materials
```

`vertices` / `polygons` 是个很好的**基元种类指纹**，`location` / `scale` 也在。
**缺的只有一个：尺寸。**

`agh_blender_scene` 工具（`extensions/main/index.mjs`，`runScene` → `/scene`）只做转发，
所以改动点在下游的 Python 侧一处。

## 3. 请求

在 `describe_scene()` 的 `entry` 里加两个字段：

```python
entry = {
    'name': item.name,
    'type': item.type,
    'location': [round(v, 6) for v in item.location],
    'scale': [round(v, 6) for v in item.scale],
    # 新增（必需）—— 这是 requests 的全部要点
    'dimensions': [round(v, 6) for v in item.dimensions] if hasattr(item, 'dimensions') else None,
    # 新增（可选）—— M1 不用；等 M2/M3 出现旋转时会需要
    'rotation_euler': [round(v, 6) for v in item.rotation_euler] if hasattr(item, 'rotation_euler') else None,
}
```

几点说明，都是刻意的：

- **`dimensions` 而不是 `bound_box`**：`object.dimensions` 就是 `bound_box` 的尺寸乘上物体
  scale，正好是"最终外廓"，与我方预测的 `w×d×h` 可直接比。`bound_box` 是 scale 之前的 8 个
  局部角点，比之前还得再乘一次，多一层出错空间。
- **精度与既有字段一致**：`round(v, 6)`，和 `location` / `scale` 同规矩。
- **非 mesh 对象**：`dimensions` 对 empty/camera 这类对象没有意义。用 `hasattr` 给
  `None`，**不要抛** —— `describe_scene()` 是只读诊断路径，不能因为一个相机对象就整条失败。
- **不加相机 / 正交渲染 op**：严格正交六视图当然更"正统"，但要动 Blender 的渲染与投影控制，
  改动面和风险都大得多；而且上游产物契约 §2.3 说**模型看不到工具产出的图片像素**，
  抓到的图对我方闭环没用。读回数值就足以闭合尺寸语义这一环。
- `objectCount` / `materials` / `knownOps` 不用动。

## 4. 验收标准（可执行）

1. 起一个受管理实例 → `mesh.primitive_add{kind:'cube', name:'v', size:1, scale:[12.4,8.6,9.3]}`
   → `agh_blender_scene`：`objects['v'].dimensions` 必须等于 `[12.4, 8.6, 9.3]`，各分量差 ≤ 1e-6。
   ⚠️ 注意这一条的精度**高于我方判据**：立方体尺寸应当逐位精确，所以拿 1e-6 当验收是对的；
   但我方读回的容差是**相对**的（`SCENE_RELATIVE_TOLERANCE = 1e-5` × 最大坐标，下限 1e-9），
   因为限制精度的是曲面基元的多边形近似（实测 `uv_sphere` 直径 2 报回 1.999999）。
2. 同一条链路对 `plane` 成立：`dimensions` 的第 3 个分量为 `0`（平面零厚）。
3. 对 `cylinder` / `cone` 再各来一条：这一条会顺带把"`size` 是直径"这个语义也钉死
   （我们的 capability 快照里记的是 `radius = size/2`，但没被真实场景验过）。
4. `describe_scene()` 在有相机/空物体存在的场景里仍然成功返回（不抛）。
5. `dimensions` 为 `None` 的对象不得让 `agh_blender_scene` 或 `/scene` 报错。

第 1、2 条**已通过**（0.1.8 起 `describe_scene()` 发布 `dimensions`），读回因此能断言尺寸。
但这一档的名字是 `scene_readback`（半档），**不是** `against_blender`：图像级比对仍然做不到，
理由见上一节"不加相机 / 正交渲染 op"这条决定 —— 它是**永久**的，不是"以后再说"。

## 5. 成对要改的东西（同一次变更）

按仓库规矩"同一变更里更新受影响的 guide / contract / 测试"：

- `agh_ops.py` 的 `describe_scene()`（主改动）
- 若 `docs/DESIGN.md` 或任何 doc/test 断言了场景回读的形状 → 同步
- `docs/DESIGN.md` 的缺口表、`docs/P0-EVIDENCE.md` → 各记一条（给这条请求留可追溯的编号）
- 包版本号 + 一次 `reinstall`（改 `package/` 内任何字节 ⇒ `integrity` 变 ⇒ 必须重新 trust）

**不要**顺手改 `OPS` / `OP_MANIFEST`：这次请求只动只读侧，不动任何 op 的语义。这也是为什么它
比"加一个 op"便宜得多。

## 6. 不做也不阻塞

`numeric` 档与 M1 的全部功能面（参数 → ops → 六视图 → 残差 0 → 落盘）都不依赖它。
这条请求只影响"最后那 30% 的确信"。

## 7. 我方同时要做的（不是下游的活）

`agh-ortho` 侧增加 `tier: 'scene_readback'`（消费 `agh_blender_scene` 的报告）：
用 `(type, vertices, polygons)` 当基元指纹、比 `location` / `scale` / `objectCount`，
并在 `dimensions` 缺失时**明确报"这一档验不了尺寸语义，只验转写"**，
而不是按 `against_blender` 报出去 —— 名字必须如实，否则就是制造静默缺口。

`dimensions` 到位后，同一份比对代码只需多读一个字段，即可升级为真正的 `against_blender`。

## 8. 另外发现的下游缺陷（不是请求，但同一批做更省事）

**`agh_blender_stop` 在关闭竞态下报失败，而进程实际已退出。** 实测（2026-10-08）：

```
两次调用均 ok:false, blockers:["transport: fetch failed"], mode:"token",
         stage:"close", forceKilled:false
随后 agh_blender_probe:  alive:false, processAlive:false
```

判定：这是**保守方向**的失败（没谎报成功），但"受控关闭已被确认"下游给不出保证 ——
任何"stop 返回 ok 才继续"的编排都会误判。建议：让 stop 在 bridge 断连时回退到
"按 PID/端口确认进程已退出"并据此给结论，或在返回值里明确区分
"未能确认" 与 "确认失败"。

（`agh-ortho` 自己不调用 stop，所以这条不影响本插件；记在这里是为了 M3 一起处理。）

**受管理实例目录只增不减。** 实测（2026-10-08）：当前工作区的 `.agh-blender/instances/` 已经累积
**13 个实例目录、101 个文件、2.21 MB**，其中 `.blend` 检查点 3 个共 1829 KB、截图 PNG 2 个共 323 KB。
每跑一次 `agh_blender_start` 就多一份，而**没有任何清理机制**。

影响：不是正确性问题，但它是**缓慢的磁盘泄漏**（我们这一下午就产生了 2.21 MB），而且让
"当前活着的实例是哪个"变得不容易一眼看出 —— 记录越多，读错记录的机会越大。

建议：在 `stop` 成功之后按"保留最近 N 次 / 保留 M 天"清理该实例自己的目录，并**明确不删仍活着的那个**。
（顺便：`agh-ortho` 也有同一类问题 —— 我们的保留策略只能出计划、执行不了，因为工具面的 fs seam
没有 `rm`。两个插件都清不掉自己的垃圾，只是原因不同；它其实能在 Blender 侧用 Python 删，比我们更有条件修。）

## 9. 优先级

| 项 | 依赖什么 | 建议顺序 |
|---|---|---|
| `describe_scene()` 加 `dimensions` | 无（只读侧） | ~~**1**~~ —— **已完成**（0.1.8），`scene_readback` 的 `size_asserted` 已翻成 `true` |
| `catalog()` 发布 `primitives` 与能力集标识 | 无 | **1** —— 消掉合成的 `capabilitySet`，**并让能力闸门真正生效**（见下） |
| `stop` 的确认语义（bridge 断连时回退到按 PID 确认） | 无 | 2 |

**实测两次，形态完全一样**（2026-10-08）：

| 次 | stop-report | 独立探针 | 意味着 |
|---|---|---|---|
| 1 | `ok:false` `transport: fetch failed` `stage:close` | `alive:false` `processAlive:false` | 进程已不在 |
| 2 | `ok:false` `transport: fetch failed` `elapsedMs:2` `forceKilled:false` | `alive:false` `processAlive:false` | 进程已不在 |

**`elapsedMs: 2` 是关键线索**：2 毫秒就 `fetch failed` ⇒ **没有监听者** ⇒ HTTP close 请求发出时进程早就没了（窗口已被手动关闭）。
所以 `ok:false` 表达的是"我没能确认你说的那件事"，而不是"我没做成"。**方向是保守的（没有谎报成功）**，但调用方无法区分：

- 「进程还在，关闭失败」 ← 需要重试
- 「进程早就没了，我只是没拿到回执」 ← 不需要做任何事

建议：`stop` 在 `transport: fetch failed` 时**回退到按 PID 探活**，再决定报成功还是失败。
| 实例目录的保留与清理 | 无 | 3 —— 与上两条同一批 |

### 为什么第 1 条现在更要紧（实测，不是推测）

`agh-ortho` 里有一道**能力闸门**：发 ops 之前先查目标有没有那种基元（比如本该用 `cylinder` 却只有六种里的五种，就该报 `no_downstream_primitive` 而不是硬发）。但它依赖 `primitives` 列表，而两个来源的形状不同：

| 来源 | 有 `primitives` 吗 | 闸门 |
|---|---|---|
| 随包快照 `agh.capability.json` | 有 | **applied** |
| 活实例的 `catalog()` | **没有** | `not_applied: the target publishes no primitives list` |

于是闸门**只在用旧快照时才生效、对着实时真相时反而不生效** —— 正好是反的。

实测证据：两轮 `fit` 的 `three_state.primitive_gate`，一轮 `applied`（快照 `agh-blender@0.1.7`）、
一轮 `not_applied`（实时 `agh-blender@live:catalog-v1`）。

**只要 `catalog()` 把它自己已经知道的 `PRIMITIVE_KINDS`（六种基元）一并发布，闸门就双向生效。**
这是"扩下游不改上游"那条主张里唯一还差的一块拼图 —— 现在它一半是活的，另一半靠一张会过期的表。
