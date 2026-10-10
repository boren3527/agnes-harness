# 下游请求（第二份，2026-10-10）：世界包围盒、渲染位姿、取景

写给 `agh-blender`。每条都有**为什么**和**可复算的验收值** —— 不接受"已支持"的口头声明。
（第一份是 `DOWNSTREAM-REQUEST-readback.md`，那份里的 §8 与本文 P1 是同一条。）

---

## P1. `describe_scene` 发布每个对象的**世界包围盒**（min/max）

**为什么**：我们这一档现在只能证"名字 / 类型 / 位置 / 尺寸"。而"**几何真的落在哪**"核不了 ——
实测两轮：`police1c` 的几何底面比约定高 **1.3 cm**、`ayaka3` 偏 **−0.206 m**（20 cm！），
两轮都**穿过了所有档位**（我们自己的 `placement` 只证"我声明的信封按我发的 location 摆好了"）。
没有包围盒，这类偏差只能靠人眼，而人眼不会去量 20 cm 与 1.3 cm 的区别。

**验收（可复算）**：对 `runs/toy1-delivery` 那一份场景，
`bounds.min` 应为 `[-0.398227, -0.327651, -0.006172]`、`bounds.max` 应为 `[0.384945, 0.270593, 1.004803]`
（我们这边独立解 GLB 字节算过，见该包 `report.json` 的 `placement.geometry_*`）。
等我们把摆放改成"按实测包围盒贴地居中"之后，同一份模型应报 `min[2] == 0`。

**注意**：`dimensions` 不够 —— 它只有尺寸，没有**位置**；而偏差恰恰全在位置上。

---

## P2. `render.still` 的回报里带上**相机位姿**

**为什么**：被认证的那张渲染图**复现不出来**。我们现在的做法是从场景读数里**抄** `location`/`rotation_euler`
再声明出去（这一轮就是这么做的，报告里也如实标了"抄自场景读数，不是 render.still 亲口回报"）。
`ortho_scale` 只定画幅高度，**位姿定的是"看到了什么"** —— 没有它，"这张图"与"这个相机"之间没有可核的关系。

**验收**：回报里出现 `camera: { name, location, rotation_euler }`（`sensor_fit` 已由你们钉死 VERTICAL，也带上），
数值与调用方 `camera.add` 发的**在 1e-6 内一致**。配合已有的 `sha256`，那一档就从"我知道答案"变成"包能证明答案"。

---

## P3. 取景 op：`view.frame { target }`（**先确认是否已有更省事的**）

**为什么**：打开 Blender 想看清模型，得**手动放大**。这对"录一段演示"或"人看一眼形状"都是常态摩擦。

**先决条件**：请先看现有的 `capture` 是否**已经按对象取景**。
若已经取好 ⇒ **这条可以不做**，我们只要在流程里写清"要看效果就看那张 capture / 正交渲染图"。
若只是默认远景 ⇒ 再做这个 op。

**实现注意**：Blender 4.x 里 `view_selected`/`view_all` 需要 3D 视图上下文，
必须 `temp_override(area=<VIEW_3D>)`，否则报 `context is incorrect`。

**验收**：`view.frame { "target": "body_mesh" }` 之后 `capture` 里**模型占画幅 ≥ 60%**。

---

## 附：我们自己这一侧在做的（不用下游动手）

- `subject: "cutout" | "whole_frame"` 声明 ⇒ `photo_check` 自动知道该跟**主体**还是**整幅画面**比；
- `silhouette` 从单个对象改成**数组**（现在一份包只能带一张剪影，front 与 left 得分两个 run）；
- 剪影渲染图**路径统一**成 `outputs/<name>-front.png`（不再落进 run 的临时目录）。
