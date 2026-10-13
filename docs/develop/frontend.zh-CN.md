# 前端插件：为工作台增加一个界面

[English](frontend.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件生命周期](../guide/packages.zh-CN.md)

做完本教程，你会在工作台里看到自己的面板，完成一次版本更新，并确认停用后内置界面恢复。先理解生命周期，再把版本文字替换成岗位需要的内容。

复用 [client-panel/v1](../../examples/packages/client-panel/v1/package.json)。它在已支持的 `ui:sidebar` 槽展示版本文字，v2 用于验证页面更新。它是浏览器贡献路径，不是普通 Host `ctx.extension()` 的 slot 注册。

## 声明和代码

该包用 `agnes.plugins` 声明后端 Cordis 行，再用 `agnes.clientDescriptors` 将浏览器描述文件绑定到同一个 row ID。浏览器描述文件中的 `client` 部分为：

```json
{
  "client": {
    "entry": "./client/index.js",
    "styles": ["./client/index.css"],
    "slots": ["ui:sidebar"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

包声明见[package.json](../../examples/packages/client-panel/v1/package.json)，完整客户端描述见[agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json)。客户端 entry 相对于描述文件定位，是浏览器可执行的原生 ESM：

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    () => config.publicConfig.label,
    { priority: -1 },
  )
}
```

该单实例槽的较小 priority 优先，示例替换内置侧栏。停用后应恢复内置侧栏。正式插件选择合适槽位，不能指望覆盖未迁移区域，也不要依赖宿主私有 DOM/CSS 结构。

设备插件可声明会话作用域的单实例槽 `workbench.device`。宿主只在显式登记的设备会话展示伴随面板，传入 `DeviceWorkbenchProps` 的 `sessionId` 和冻结的关联数据。同工作区普通会话不继承登记；同一工作区设备的失效关联直接显示连接配置表单，并提供 `prepareConnection()` 和 `connectionConfigured()` 回调；插件只在用户提交表单时准备关联，完成配置后通知宿主刷新。已被其他设备替换的历史关联仍只显示提示，不挂载控制界面。面板默认会话/设备占比 60:40，可调整，独立于根作用域的 `rightbar`。关联数据不等于控制授权，后端调用仍须校验真实会话和当前关联。此槽只提供界面接缝，不代表实车连接或视频流已经接通。

`ctx.commands.registerEffect` 注册的效果命令固定执行开始时的会话关联。异步宿主授权期间切换会话
（包括切走再切回），或移除/替换命令，旧命令拒绝派发，不向效果中继发送请求。
这项浏览器检查不能撤回已经派发的效果，也不能替代后端的会话和授权校验。

`publicConfig` 来自随包内容，是公开展示元数据，不是后端 runtime config。客户端 entry/styles 必须是经过校验的包内路径；不能逃出快照、任意 import 本机模块或获取连接凭据。需要 React/第三方库时应生成可独立加载的浏览器产物。

内置工作区弹窗提供跟随工作区、普通会话和设备会话三种选择。跟随工作区时，已知有效的设备工作区默认创建显式登记的设备会话；普通会话不登记设备。“新设备”固定选择设备模式。登记使用后端当前关联版本，失败时不发送消息。尝试创建设备会话后更改模式或工作区会使用新的创建标识，同一设备创建的重试保留标识。伴随面板也提供关联解绑，保留会话历史，但不停止实体运动。

显式效果读回可用 `registerEffect({ id, service, retainOperation: true })`：同一个未改变的输入对象保留宿主生成的命令 ID。输入限于扁平 JSON 数据，最多 128 个自身可枚举字符串键和 65,536 个序列化字符。每次仍重新授权；输入改变、换会话或原请求仍在途时拒绝。新对象代表新操作。此选项只保留身份，不自动重试、不授予后台恢复权限，也不跨模块/浏览器重启持久化；后台仍须单独限定哪些效果允许安全恢复。

## 安装与观察

从仓库根和独立实例运行：

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-panel/v1
```

使用预览摘要完成 trust、enable，然后打开同一实例 Web。应看到 v1 字样。通过 Web 管理或 TUI 更新到 `file:./examples/packages/client-panel/v2`，检查 v2；最后 disable，确认内置侧栏恢复。示例可能替换管理导航，必要时保留终端使用 shell disable。

包 desired=enabled、后端 web row ready 和本页面成功加载是不同阶段。浏览器未打开、脚本/CSS 读取失败、槽位越权或 apply 抛错都可能导致前端失败；查看逐行实际状态，不仅看包级 enabled。

首次配置确定 profile 后，Web 并行读取模型、工作区和会话。客户端模块对账最多并行读取四个独立的后端激活状态；快照发布和退役仍按顺序执行，激活状态读取失败不会授予就绪状态。

## 验证

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

这些测试验证实际示例 ESM、Cordis 绑定、槽位与清理，以及更新失败处理；没有浏览器参与时不称为真实渲染验收。浏览器验收边界与源码候选结果见[验证记录](../maintainers/verification.zh-CN.md)。

下一步：[为面板接入后端服务](fullstack.zh-CN.md)。需要公开配置的字段和可调用服务要分别声明；密钥留在后端。

实现依据：[加载协调](../../packages/web/src/client-modules/reconcile.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)、[资源检查](../../packages/package-manager/src/client-assets.ts)、[槽位](../../packages/web-client/src/slots.ts)。

会话授权的 `resources.images.load` 支持最多 4 MiB 的 PNG/JPEG 产物。超过 1 MiB 的图片通过现有产物 RPC 顺序分段读取，每次响应仍不超过 1 MiB；全部身份及范围校验通过后才生成 Blob URL。会话/句柄改变或服务销毁后的迟到结果拒绝发布。其他文档类型仍限制为 1 MiB；后台授权及配置的产物上限仍可拒绝读取，这项能力不授予文件访问权限。

两个资源读取器都支持可选 `signal`：取消后不再请求后续分段，也不发布图片 URL；已经发送的 RPC 仍由现有 SDK 超时机制约束，这个信号不撤回已发请求。

已验证的 AKA 拍照和单图测试贡献可额外设置 `persistCapture: true`，把未确认的宿主操作身份和确切版本保存在当前标签页的 sessionStorage。aka.capture 保存 bindingRevision/configRevision；aka.recognition.test 另含 recognitionRevision/roundRevision。两种操作使用独立存储键，均拒绝秘密和额外字段。必须同时设置 retainOperation，且限定 AKA 包及上述两种服务；其他输入与秘密均拒绝保存。`ctx.commands.pendingEffect(id)` 只返回当前会话的冻结原输入，不暴露命令编号、不调用后台。页面先显示原结果核对，再允许新拍照或检测。识别核对先返回已完成日志回执；同一原操作未完成时，可由 daemon 核对独立检测归档、原照片事件和当前所有者可读的 CAS 原图，再补全同一日志回执。缺原日志或无法核对的归档保持未知，不再次进入服务、上传或推理；照片产物重建仍仅用于拍照。显式执行恢复输入会附带 readbackOnly，后台缺少原日志时拒绝，不创建新效果。存储损坏或不可用时拒绝派发。每次仍经命令授权和后台归属检查；核验回执与当前会话/配置后，调用 `ctx.commands.completeEffect(id, 原输入)` 清除待核对提示；后台 Promise 返回本身不会清除，坏回执或迟到结果仍保留核对。在途或尚无成功响应时拒绝完成确认。关闭标签页、换来源或清空存储不属于此恢复范围，也不会授予机器人控制权。

工具图片预览：工具结果的资源链接保留可选的字节数。界面将大小有效的 PNG/JPEG 产物链接投影为现有图片卡片；读取仍须通过会话/通道权限及完整字节身份校验。旧渲染回执可从摘要和 MIME 一致的 structured.artifact.ref 取得字节数。回合收起后最新图片仍显示，早期图片保留在过程记录。此变更不开放任意网址或本地文件路径。
