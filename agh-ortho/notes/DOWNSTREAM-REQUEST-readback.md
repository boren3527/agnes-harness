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
2. 同一条链路对 `plane` 成立：`dimensions` 的第 3 个分量为 `0`（平面零厚）。
3. 对 `cylinder` / `cone` 再各来一条：这一条会顺带把"`size` 是直径"这个语义也钉死
   （我们的 capability 快照里记的是 `radius = size/2`，但没被真实场景验过）。
4. `describe_scene()` 在有相机/空物体存在的场景里仍然成功返回（不抛）。
5. `dimensions` 为 `None` 的对象不得让 `agh_blender_scene` 或 `/scene` 报错。

第 1、2 条通过之后，`agh-ortho` 的 `against_blender` 档就有意义了。

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
