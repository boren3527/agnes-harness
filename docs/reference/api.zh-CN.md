# API 与 Schema 参考

[English](api.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件边界](../develop/plugins.zh-CN.md)

为自己的应用接入 AGH 时，先选择与你的运行环境对应的入口，再查方法和 Schema。这里只列可追溯的接口合同；开发第一个插件可以先看[教程](../develop/plugins.zh-CN.md)。

API 随源码演进，`@agnes/*` 目前通过仓库 workspace 解析。使用与源码版本匹配的接口和示例。

## 选择正确入口

| 使用方 | 入口 | 典型操作 |
| --- | --- | --- |
| Node 客户端 | `@agnes/sdk` 的 Node 条件出口 | createClient、session、config、packages、resources、skills、mcp |
| 浏览器宿主 | `@agnes/sdk/browser` | 会话与浏览器允许的协议，未提供 Node 管理能力 |
| 浏览器插件 | 宿主传入的 ClientContext | slots、session、theme、locale、commands、agnes.services |
| 后端 Cordis 插件行 | `@agnes/plugin-runtime` / Cordis Context | Config、inject/provide、effect、ctx.extension、ctx.skills、已验证行上的 ctx.services/slots/projections/resources |
| 受限扩展能力 | `@agnes/extension-api` 的 PluginExtensionAPI | 工具、`on` 观察 hook、`registerHook` 全类 hook 与事件；服务等贡献走行上的 Cordis 入口 |

SDK 的现行 Node 出口：[index.node.ts](../../packages/sdk/src/index.node.ts)；浏览器出口：[index.browser.ts](../../packages/sdk/src/index.browser.ts)。应用只能使用各包 exports 暴露的入口；源码深链接用于解释，不是鼓励消费者深导入。

## SDK 调用顺序

已经获得可信连接配置的 Node 客户端可按以下顺序操作。下例接收部署层提供的 `options`；连接地址与认证方式由该部署确定：

```ts
import { createClient, type CreateClientOptions } from '@agnes/sdk'

async function listSessions(options: CreateClientOptions) {
  const client = createClient(options)
  try {
    await client.initialize()
    return await client.session.list({})
  } finally {
    await client.close()
  }
}
```

新会话为 `client.session.new({ cwd, preset?, sessionKey? })`，恢复用 `client.session.load(id, { cwd? })`；执行是 `session.prompt(text)`，取消是 `session.cancel()`。业务使用前按当前服务端要求登记工作区、处理权限请求。关闭 client 是连接清理，不等价于取消后台任务。

从 UI 投影的 `pendingInputs` 读取待执行消息。`session.removeQueued(itemId, { commandId? })` 通过 `_agnes/v1/submit` 的 `removeQueued` 类型删除一条待执行消息，返回已提交的事件序号；`session.sendNow(itemId, { commandId? })` 停止当前轮并优先执行该条排队消息。两者都校验会话所有权；消息已开始执行或已不存在时返回 `QUEUED_INPUT_GONE`。删除保留其他消息，不会启动或停止执行。结果未知时，重试应复用同一个 command ID。

传输支持 Node 的 unix/stdio/ws 等入口，生产连接的认证、命名管道进程身份、TLS/Origin 由部署合同决定。建议用户先从 CLI/Web 入口走自动发现；嵌入者不能跳过握手和服务端身份校验。可运行的连接与包管理示例见[文档 smoke](../../tools/public-docs/smoke.mjs)，其凭据与模型由本地夹具产生。另有[共享本地验收](../../tools/acceptance/shared-local-delivery.test.ts)覆盖分发迁移等流程。复现步骤与检查范围见[验证记录](../maintainers/verification.zh-CN.md)。

## 协议方法分组

有持久存储的本地 supervisor 提供设备关联接口：`client.device.bindings()`、
`client.device.session(sessionId)`、`client.device.bindSession(sessionId, expectedRevision)`、
`client.device.detachSession(sessionId, expectedRevision)`，分别对应 `_agnes/v1/device.bindings.list`、
`device.session.get`、`device.session.bind`、`device.session.detach`。
只有具备关联存储的本地所有者连接才会看到 `device` 方法族；独立内存嵌入不声明此能力。
查询/登记/解绑会话还必须通过真实会话所有权和工作区新鲜度校验。

先在已注册工作区创建标准空会话，查询关联，再以返回的工作区 revision（没有关联则为 `0`）登记。
设备 UUID 由 daemon 分配，调用者不能传工作区 ID、设备 ID 或机器人 IP。
登记只影响明确登记的会话，不把普通历史会话转成设备会话；失效的历史登记仍保留原设备身份。
版本冲突返回 `SEMANTIC_REJECTED`，其中 `data.code` 为 `DEVICE_BINDING_CONFLICT`；重新读取后再决定是否重试。
这些接口不会连接、控制、停止实体设备，也不会开启图像识别。

所有者可以使用当前工作区版本，在原会话中明确重新绑定失效登记，但工作区必须仍关联该会话的原设备。
重新绑定只更新这个会话的登记版本，保留连接和识别配置；其他历史会话仍失效，直到各自明确重新绑定。
已更换设备，或原端点被其他有效工作区占用时拒绝重新绑定。回复丢失时先查询实际关联，再决定是否重试。

解绑要求当前登记会话和正数的当前工作区版本。它停用工作区关联、增加版本，并保留所有会话登记为失效历史。
普通会话和已被替换的历史登记不能解绑当前设备。已解绑登记可用当前失效版本读取不变的结果；重放旧版本返回冲突。
绑定撤销会退役插件持有的连接，但机器人在 socket 关闭后仍可能运动，因此该接口不是停车操作。
后续运动工作台必须取消任务并请求/核实停车，才能提供表示安全停止的解绑流程。

`client.device.recognition(sessionId)` 调用 `_agnes/v1/device.recognition.get`，要求当前本地所有者、
有效设备会话和新鲜工作区。返回脱敏的配置视图：独立版本、提供方、频率、请求预算、凭据已配置标记及
适用的本地服务原点，不返回密钥值或私有引用。已配置不代表已测试或正在运行；读取不开相机、不派发推理。
`client.device.saveRecognition(input)` 调用 `_agnes/v1/device.recognition.save`，复用上述所有者与工作区检查。
闭合输入包含会话、预期绑定和配置版本。云设置固定 `aliyun`、频率（0.5/1/2）、请求预算，以及
凭据 `keep` 或带 AK ID/Secret 的 `replace`。本地设置为 `local-yolo`、私网/回环服务原点，凭据支持
`keep`、带令牌的 `replace` 或 `clear`；settings 为 null 清空配置。不能提交私有引用或存储路径。
秘密写入固定 daemon home 的私有 CredentialStore，不进入工作区；先暂存再 CAS，失败只清理能够证明
未发布的新引用。提交状态不明则保留并返回固定错误，所有者读回版本核对。相同替换重试复用引用；
旧秘密缺失时仅允许持当前版本显式替换。保存不开相机、不识别、不联网。
运行消费、需求失效、旧秘密退役和设置界面仍待接通。

端点元数据独立于设备关联。`client.device.connection(sessionId)` 和
`client.device.saveConnection(input)` 分别调用 `_agnes/v1/device.connection.get` 和
`_agnes/v1/device.connection.save`，均要求本地所有者、新鲜工作区及有效的显式设备会话登记。
结果包含 `deviceId`、`bindingRevision` 和可为空的 `profile`；配置记录 `driver: 'aka-00'`、
规范私有 IPv4 `ip`、`port`、设备自报 `macAddress` 及独立 `configRevision`。
这些是元数据，自报 MAC 不构成硬件身份认证。

保存提交 `sessionId`、`expectedBindingRevision`、`expectedConfigRevision` 及三个端点字段；
首次保存使用配置版本 `0`，MAC 规范为小写。值不变不增加版本，相同的紧邻保存请求重试返回
已保存结果；过期的不同修改被拒绝。两个有效设备关联不能登记相同端点或自报 MAC，
重新启用已保存配置的设备关联时也会核对当前占用。
配置冲突返回 `SEMANTIC_REJECTED`，`data.code` 为 `DEVICE_CONFIGURATION_CONFLICT`。
字段限制和准确类型以协议 schema 为准。

读写不探测设备、不连接、不操作相机、不移动、不发识别请求，也不授予实体操作权限。
Host 可经受信会话通道向后端插件提供调用期间的 `device.connection()`，见[全栈合同](../develop/fullstack.zh-CN.md)。
AKA 插件目前仍使用所有者插件行配置，持久端点尚未接入 Runtime 或设备配置页面，保存不证明连车成功。
新版 worker 配置租约在新配置提交后撤销，其持有的本地连接随之退役；通知发送报错时退役通道并报告错误，
应先读回已提交配置再决定重试。没有配置快照的旧保留器不提供此覆盖。配置跨 daemon 重启保留，普通会话及失效历史会话
不能读写。

| 方法族 | 作用 |
| --- | --- |
| `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` | 握手与基础会话 |
| `session/update`、`session/request_permission` | 服务端通知与审批请求 |
| `_agnes/v1/session.*` | 附加、列表、分叉、投影、模型/预设、follow-up 等扩展 |
| `_agnes/v1/config.*` | 配置摘要、测试、保存、账号；敏感输入不可当普通日志 |
| `_agnes/v1/packages.*` | 包检查、安装、治理、更新与操作查询 |
| resource/skill/MCP 管理方法 | 独立控制面权限和 revision 检查，见资源 method table |
| `_agnes/v1/clientModules.*` | 名册与受限 client relay；不是任意 browser RPC |
| `_agnes/v1/extension.call` | 受授权的扩展服务调用 |

具体方法拼写、方向、params/result、管理权限以[method table](../../packages/protocol/src/methods.ts)、[包管理表](../../packages/protocol/src/package-admin.ts)、[资源管理表](../../packages/protocol/src/resource-control.ts)为准。字段不要从本表简写推导。

`client.config.imageGeneration.get()` 和 `.save({ expectedRevision, enabled, size, model?, apiKey? })`
对应 `_agnes/v1/config.imageGeneration.get/save`，只接受部署本地认证。图片配置有独立版本号，
不修改聊天模型，不重启 worker，也不生成图片。读取只返回版本号、启用状态、`1K`/`2K`、固定模型和端点、
`credentialConfigured`；密钥保存在私有凭据库，不回传、不写入工作区。省略密钥保留原凭据。
版本冲突后需要重新读取；下次生成直接使用新配置。

默认图片模型为 `qwen-image-2.1-pro`，通过固定 DashScope 接口调用。已有 Agnes 配置仍可读取；
切换模型提供方必须重新提供密钥，不自动回退到其他提供方。可选 `description` 描述主体，
`view` 指定 `front/right/back/left`，使用角度参数时必须同时提供主体描述。

支持该能力的 Host 通过可选 `ToolContext.imageGeneration.subject({ images, subjectBox?, description?, view? })` 向声明
`requiresApproval: 'always'`、非只读且没有动态分类器的插件工具提供图生图能力。每次工具调用最多
发起一次请求，接收最多四张经过校验的 PNG/JPEG，返回检查过实际透明度的 PNG 和背景处理方式。
可选 `subjectBox` 用归一化 `[左, 上, 右, 下]` 指定第一张图里的目标，避免选错更大的物体；
坐标必须有限、在 0–1 内且有正面积。不传仍处理主要物体，不接收任意提示词。
端口随调用结束、取消或插件卸载失效；不暴露凭据、不接受端点覆盖、失败不自动重试。
明确使用四视角时，同一调用最多允许正面、右侧、背面、左侧各一次，且主体描述必须一致；
正面先请求，其余三个角度可并行。普通主体处理仍限一次，失败不自动重试。
只读工具、hook 和 service 不获得该能力。纯白边缘去除是抠图启发式，AIGC 图片不能作为实车物理证据。
可选 `imageGeneration.configuration()` 在同一个已批准的工具调用里只返回版本、模型、尺寸和
启用状态，不发起生图、不返回密钥或允许覆盖端点。插件将这份配置身份加入缓存，避免切换模型后
复用旧提供方的图片；调用结束后读取权限也失效。

读取完整工具记录时，使用 `_agnes/v1/session.readToolDetail` 按需读取工具调用及其匹配的结果。传入 `sessionId`，并把工具节点的 `seq` 作为 `callSeq`；有 `resultSeq` 时一并传入。可选的 `offset` 和 `maxBytes` 按 UTF-8 字节分页，单次响应最多 262,144 字节。响应包含 base64 编码的 `data`、`totalBytes` 和 `nextOffset`（最后一块为 `null`）。先解码并拼接各块，再解析 `{call, result?}` JSON。daemon 读取事件前会校验会话访问权限。RPC 和 SDK 的 `Session.readToolDetail(callSeq, resultSeq?)` 都将完整序列化记录限制在 64 MiB；分页不能读取更大的记录。超限时 RPC 返回 `INVALID_PARAMS`，原因是 `detail-too-large`。常规 UI 投影仍使用长度受限的预览，工具节点新增可选 `resultSeq`。

写操作通常通过 clientId/commandId、expected revision/integrity 返回持久化 operation receipt，再查询最终状态。不要收到 receipt 就记录效果成功；不要未知结果后换 commandId 重做外部效果。

## Skills 写接口

Node SDK 与服务端提供以下管理接口；调用者必须持有对应控制面权限。

| Node SDK / RPC | 输入与结果 |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile、clientId、commandId、resourceId、expectedRevision；返回 ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | 同上，加 expectedPriority 与 priority（50–500 整数或 null）；返回 ResourceOperationReceipt |

两项均要求 admin authority 和 `resources.skills.write`。`remove` 只接受可删除的 workspace/user 来源；`prioritySet` 拒绝 runtime 来源。Web BFF 分别映射为 `/admin/resources/api/skills/remove` 和 `/admin/resources/api/skills/priority`；这不增加浏览器 SDK 的直接资源管理权限。shell/TUI 也没有同名新增命令。

通过 `client.resources.operation.get({ profile, operationId })` 等待 succeeded/failed，记录错误并检查 actual；删除受理后不能取消。优先级保存不改变信任/启用；删除的目录范围、永久标记和同名接替见[Skills 指南](../guide/skills.zh-CN.md)。权威来源：[Schema](../../packages/protocol/schema/resource-control.json)、[方法/权限表](../../packages/resource-control-contracts/src/resource-control.ts)、[Node facade](../../packages/resource-control-client-node/src/resource-control.ts)。

## Schema 导航

| 合同 | 手写源 |
| --- | --- |
| 核心协议/会话 | [agnes-v1](../../packages/protocol/schema/agnes-v1.json)、[session-v1](../../packages/protocol/schema/session-v1.json) |
| Profile/预设/模型 | [profile](../../packages/protocol/schema/profile.json)、[preset](../../packages/protocol/schema/preset.json)、[model](../../packages/protocol/schema/model.json) |
| 工具/扩展/hook | [tooldef](../../packages/protocol/schema/tooldef.json)、[extension-manifest](../../packages/protocol/schema/extension-manifest.json)、[hooks](../../packages/protocol/schema/hooks.json) |
| 扩展服务/投影 | [extension-service](../../packages/protocol/schema/extension-service.json)、[projection](../../packages/protocol/schema/projection.json) |
| 包/资源控制 | [package-admin](../../packages/protocol/schema/package-admin.json)、[resource-control](../../packages/protocol/schema/resource-control.json)、[lockfile](../../packages/protocol/schema/lockfile.json) |
| 身份/部署/Surface | [authz](../../packages/protocol/schema/authz.json)、[deploy-manifest](../../packages/protocol/schema/deploy-manifest.json)、[surface](../../packages/protocol/schema/surface.json) |
| ACP 差异与来源 | [UPSTREAM](../../packages/protocol/schema/acp/UPSTREAM.md)、[DEVIATIONS](../../packages/protocol/schema/acp/DEVIATIONS.md) |

生成类型在[gen/ts](../../packages/protocol/gen/ts)。Schema 通过只证明形状，跨对象关联、授权、事务和实际执行仍由相应实现验证。

模型记录可选的 `inputLimits` 透传 pi-ai 的 `maxRequestBytes` 和 `images` 限制（`maxPerMessage`、`maxPerRequest`、`resize`）。`resize.maxBytes` 以 Base64 编码字节计，`jpegQuality` 以 1–100 计；未声明的限制仍受产品上限约束。图片支持仍由 `input` 是否包含 `image` 决定。

`_agnes/v1/apis.list` 的 `profile.models` 条目包含 `input` 和可选的 `inputLimits`，客户端按已解析的模型能力判断。旧服务端可能不返回这两个字段，客户端不能根据模型名称猜测图片支持。

`ToolContext.session.readImages` 是 Core 提供的可选能力，由内置 `read` 工具使用。输入为 `{ path, offset?, limit? }`，返回 `ToolResult`。`session-image://list` 分页列出当前会话、当前 lane 的原图；`session-image://<消息序号>/<图片序号>` 读取一张，逗号分隔的引用可整批读取。分页偏移和图片序号从 1 开始；列表默认每页 20 项，最多 100 项。读取不能指定其他会话或 lane、看到读取开始后的记录，也不能绕过模型和运行环境的图片限制；工具取消会取消读图。旧运行环境不提供此能力，`read` 会明确返回不可用。

支持的宿主现在为已准入、有有效调用关联和设备识别租约的 AKA test/enable 效果提供可选 `ServiceContext.recognition.run(expected, select, verifySelection)`。expected 是绑定、识别配置和轮次版本；select 在私有窗口准入后选择有界 JPEG，接收时间使用本 worker 单调时钟。调用身份、ticket、凭据和网络准入均由后台控制。端口每次效果只能执行一次，撤销后不可用；复制/校验图片并核对回复设备、版本、原图 hash、尺寸和框，释放租约。查询、预算轮次、只读恢复及其他插件没有此端口；工具和钩子也没有。示例现已注册 `aka.recognition.test`，输入 bindingRevision、连接 configRevision、recognitionRevision 和 roundRevision，复用当前流帧资格，在检测前保存并发布确切原图，返回同帧检测元数据及原图产物引用、事件序号。留档复用受信照片链，只扩大到该 test 效果；持续识别与只读 test 恢复仍无照片端口。已有原图时拒绝替换和重复检测；保存后由 Host 再核对帧龄，失败保留原图而不报告检测成功。不开启相机，不开始持续推理。配置保存和页面刷新仍不调用收费接口。实际 Host 装配使用替身私有执行桥验证允许/拒绝，不代表公开 HTTP、页面、云端或实车验收；单图显式入口与原图结果卡现已接线，见下文；持续需求仍待完成。

选帧回调接收当前调用/识别租约的组合 AbortSignal，配置撤销会取消选帧。可选 verifySelection 在后台结果校验后、租约释放前复查媒体；AKA 示例总是传入该检查。租约释放后不得再用同一信号进行发布资格验证。时间依据仍是流桥接收，不能证明曝光新鲜或用于物理接近。

设备面板现在通过 `aka.recognition.round.read` 显式读取当前轮次，仅按用户操作开始新轮次，并通过 `aka.recognition.test` 测试一张图片。读取效果沿认证、入日志服务准入，不授予云网络或预算修改能力。闭合输入为 expectedBindingRevision 与识别配置的 expectedConfigRevision；返回既有轮次或 null，不重置额度。页面将已保存原图及匹配框与直播分开展示；重新读图不重复推理。选帧时间采用 `bridge_receive`，不是曝光时间，页面到达时间另记为本地观察。有效额度取存量轮次与当前 requestBudget 的较小值，提高配置不会扩大旧轮次。测试不可用时说明配置、本地执行、轮次、额度或相机数据缺项。未知测试结果在标签页/模块重载后保留原操作。显式核对先返回原命令的已完成日志回执；同一原操作未完成时，daemon 可核对独立检测归档、原照片事件和当前所有者可读的 CAS 原图，再补全同一日志回执。缺原日志或无法核对的归档保持未知，不需相机数据，不进入作者服务、上传或再次检测。页面校验原结果后才清除提示。关闭标签页、清空存储、长期历史查询及持续需求不属于此标签页提示恢复路径。daemon 在读取凭据/上传前拒绝缺失、替换或耗尽的轮次，检测准入仍原子预留以处理期间的额度变化。上述代码及分层检查不等于真实云端、浏览器图片解码或实车验收。
