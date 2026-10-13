# 前后端联动：让面板读到业务结果

[English](fullstack.md) | 简体中文

[文档导航](../README.zh-CN.md) · 前提：[后端](backend.zh-CN.md)与[前端](frontend.zh-CN.md)

这一步把界面和后端连起来。完成后，面板会显示后端返回的版本；你还会验证更新、回滚和撤权后的变化。它可以作为只读业务状态面板的起点。

复用 [client-service-panel/v1](../../examples/packages/client-service-panel/v1/package.json)。当前示例由**同一个受信 Cordis 行注册 query service，并声明对应的浏览器模块**；浏览器通过同源 BFF 发起受限调用。

## 结构与调用链

```text
package.json
  agnes.plugins → runtime 命名导出（后端 Cordis 行）
  agnes.clientDescriptors → 同 rowId 的 agnes.client.json
extensions/main/index.mjs
  runtime.apply(ctx) → ctx.services.register(panel.version)
extensions/main/client/index.js
  ctx.agnes.services.call('panel.version', {}) → 显示版本
```

浏览器 Context → 当前 client row 的 service allow-list → 本地同源 BFF → daemon 的身份/状态校验 → worker/Host 的行服务授权 → handler。

`ctx.provide()` 只在本端 Context 发布 Cordis 依赖，不会自动成为远程服务。后端行应通过 `ctx.services.register()` 注册受 Host 约束的服务；`ctx.extension().registerService()` 仍被拒绝。不要创建第二个浏览器 SDK/daemon socket 来绕过 BFF。

## 运行前显式配置能力上限

默认 local-dev 的 capabilityCeiling 不含 `services`。因此该示例在未配置时应出现 policy blocker，不能把 blocker 当成文档失败而跳过。

在**独立实验 home** 的 `profiles/local-dev/profile.yaml` 中使用下面覆盖；它保留当前默认能力集合，只额外加入 `services`，不应用到日常实例：

```yaml
name: local-dev
policy:
  capabilityCeiling:
    - tools
    - hooks
    - slots
    - events
    - resources
    - ui
    - services
    - network
    - network.publicRead
    - tools.invoke
    - artifacts
    - subagent
```

profile 必须在该实例启动前写好；若已运行，结束实验任务后显式停止并重启该实验实例。不要编辑现有用户 profile 来做教程。启动后 inspect、install、trust、enable：

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-service-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-service-panel/v1
```

后续 trust/enable 使用实际预览摘要，流程见[插件管理](../guide/packages.zh-CN.md)。

## 后端与前端各声明一次

[包声明](../../examples/packages/client-service-panel/v1/package.json)中的 `agnes.plugins` 声明后端行，`agnes.clientDescriptors` 将[客户端描述](../../examples/packages/client-service-panel/v1/extensions/main/agnes.client.json)绑定到同一行。描述文件的 `client.services` 只列出浏览器可调用的服务名；Host 仍核对服务是否由该行真实注册并允许当前会话访问。

[后端入口](../../examples/packages/client-service-panel/v1/extensions/main/index.mjs)通过 `ctx.services.register` 定义 `panel.version` 的 `kind: query`、输入/输出 Schema、超时和最大结果字节；handler 返回当前示例版本。[浏览器入口](../../examples/packages/client-service-panel/v1/extensions/main/client/index.js)使用 `ctx.agnes.services.call('panel.version', {})`；不会收到 Host grant 或 daemon 凭据。

调用要求当前会话。先在 Web 配置模型并创建/选择会话，再启用插件或刷新页面，让 apply 在会话就绪后执行。示例在 apply 时只查询一次；无会话时显示 `unavailable`，不会在后来选会话后自动重试。这是最小样例的限制，正式应用应围绕当前会话生命周期安排刷新。

宿主的会话服务调用会提供冻结的 `ServiceContext.session`，包含 `key` 和 `workspaceRoot`。
这些值来自已经验证的会话和工作区调用域，不读取服务 input 自报的身份。
旧宿主或非会话嵌入可以没有这个可选字段；需要会话归属的操作必须在缺失时拒绝。
身份数据本身不授予其他会话的访问权限，原有服务授权检查仍然生效。

具备设备登记存储的宿主还可提供 `ServiceContext.device.binding()`。
每次查询通过已认证的会话通道读取本次调用的登记，重新核对所有者和工作区身份；
返回冻结的 `DeviceSessionBinding`，普通会话返回 `null`。
历史失效登记只是数据，不授予替换设备的操作权限。旧宿主/非会话嵌入可没有此端口，
调用结束后不能继续使用。查询不会连接设备、开启识别或授权物理动作；
设备操作还需独立核对当前绑定、控制权和配置。

同一端口还可提供 `device.connection()`，读取实际登记会话的冻结 `DeviceConnectionResult`：
设备身份、关联版本和可为空的端点配置。Host 在读取前后核对关联，拒绝普通/失效会话、
身份变化及调用结束后的迟到结果；不能返回配置合同的旧读取器会被拒绝，不回退到其他设备。
该查询不连接设备、不调用云端，也不授予实体权限或配置生命周期。新版 worker 支持的
`device.retain()` 还可返回 `connection`；存在该字段时，信号覆盖其配置版本，存储事务提交新端点
后撤销，相同保存不撤销。未配置返回 `profile: null`，第一次保存会撤销该租约。旧保留器可以
省略 `connection`，其信号只覆盖关联。使用持久端点的插件必须要求带配置的保留结果，实体操作
前仍复核当前状态。AKA 示例已读取该 profile，要求匹配的配置租约，并在显式连接时替换退役端点；
配置缺失或读取失败不回退行配置。行配置仅兼容没有 `connection()` 的旧宿主，迁移到新宿主时
所有者须显式保存 profile。查询返回配置版本及匹配的既有 Runtime，不创建或替换实例。
完整连接界面与实车验收仍待交付。

可选的启动器端 `WebServerOptions.deviceMedia` 解析器接入固定同源 WS 路由
`/api/client-modules/device-media`。首条消息传插件行/会话和一次性票据，内部 loopback 凭据
只留在解析器，不送给浏览器。解析器须核对当前 profile、插件行、会话及登记，并提供撤销信号。
桥接限制消息和观看者数量，按完整元数据/JPEG 组转发，慢接收端跳过中间帧；未配置解析器时拒绝升级。
AKA 内部出口与 Web 桥接已用真实本机 socket 和合成媒体测试；Host 行归属私有登记、worker 内部查询及
示例的 `aka.media.ticket` 服务已实现。浏览器 canvas 播放器已有合成解码和生命周期测试。
生产启动器现经私有本地 `clientModules.resolveMedia` RPC 解析媒体：daemon 将获准浏览器行映射到
真实后端行，核对会话所有者、设备/配置及插件版本后返回私有元数据。生产 daemon 在 worker 池就绪后，
将解析器绑定到已创建的包服务，普通 CLI 启动路径也使用同一绑定。普通 Web 连接和浏览器 SDK
拒绝该 RPC。启动器限制租约数量，串行核对端点和各连续性版本，变化或查询失败即撤销播放。
本机 socket 测试已使用合成媒体覆盖启动器租约与桥接；真实浏览器/实车播放验收仍未完成。
JSON 服务调用不是二进制传输。

会话服务还可提供可选的 `device.retain()`，返回冻结的绑定、连续性撤销信号和清理用的 `release()`。
须在调用有效期间取得；成功返回的信号可在本次调用结束后继续使用，绑定变化、会话关闭、插件行卸载或
worker 退出时撤销，资源退役时主动 release。旧嵌入可没有该方法，工具/Hook 端口不提供它。
这不是物理操作授权、实车停车保证或所有权限策略变化的通知；持续物理效果仍需独立授权、需求租约和停止合同。

`device.recognition()` 沿同一所有者检查的 worker 路径读取当前会话的脱敏识别配置，不返回秘密或存储引用；
已配置不等于已测试或运行。Service 可用 `device.retainRecognition()` 保留冻结的绑定/配置及识别范围撤销信号。
已提交的识别修改或清空撤销该范围；仅连接的 `retain()` 保持有效，让视频继续播放。绑定、端点、会话和插件行
失效仍撤销相应租约。缺少或损坏的识别支持会拒绝，不能把仅绑定的租约冒充识别配置连续性。
这两个方法不授予推理权限、不调用云接口；识别效果准入与调度消费仍待接通。

受信服务嵌入现在可在命令日志准入中携带 daemon 生成的在途 `callId`。Host 仅在服务授权、主体执行权限、
输入及命令准入校验后，复制并冻结它交给内部上下文工厂，不放进业务插件的 `ServiceContext`。
daemon worker 链路在调用等待期间保留有界、冻结的派发身份；回复、超时、取消、会话/链路退役或写入失败即撤销。
它只证明传输连续性，不证明 Host 权限通过，也不授予读取凭据或推理资格。没有关联值的旧版/直接嵌入仍兼容；
后续识别效果消费者须拒绝缺失关联，并另外核对所有者、设备与配置。本底座不新增公开请求字段、凭据读取路径或推理端口。

worker 私有 `device-recognition-budget` 请求现可读取、开始或预留当前会话设备预算。Pool 从实际发送链路的
在途派发取得效果身份，拒绝其他会话通道，返回前再次核对撤销；supervisor 检查 AKA 插件行、允许的识别服务、
当前所有者/工作区及绑定/配置版本。开始轮次与检测预留分别限制；输入不能选择其他设备，不返回凭据引用。
预算轮次效果服务现已注册，检测与 enable 身份仍是后续消费目标；不能据此宣称推理服务已注册。
检测的真实权限准入、凭据消费、持续需求与账号限流仍须接通生产效果链路。

支持该能力的宿主现会给已准入的 AKA 识别效果服务提供可选的
`ServiceContext.recognitionBudget.request(...)`。Host 从调用准入固定会话和在途关联，不读服务输入中的身份。
查询、工具、其他插件/服务及缺少关联的调用不获该端口。闭合请求仅含版本及操作；开始服务不能预留检测，
检测服务不能重置轮次。结果复制冻结，拒绝额外字段和不可能的计数，并在返回前核对新鲜绑定。
后台私有凭据解析现从当前设备配置取得固定 home CredentialStore 引用，必须等待授权，并核对所有者、
新鲜工作区与配置；返回内部闭包句柄，序列化不带 AK/token。受信后台每次消费都在派发前及真实结束后重查；
同句柄拒绝并发和撤销后的迟到结果。传输关联不能替代授权；该解析器没有注册 RPC、插件服务或模型 API。
上传/检测准入、设备/账号并发和客户端结果合同仍由识别执行端承担；句柄随在途调用失效，后台连续识别还要
有明确任务授权生命周期。合成私有存储测试不读取真实秘密、不派发 SDK 请求，也不证明云端验收。

worker 的两个 Host 构造路径都接入预算桥。该操作不授予密钥、推理或后台需求权限；真实识别服务及排空/派发
仍待集成，旧宿主没有端口时须明确拒绝。



受信插件行在 `ToolContext` 和 `HookContext` 中也可使用同一可选的 `device.binding()` 端口。
上下文贡献通过 `ctx.extension().registerHook('context', handler)` 注册；简化的 `on` 仍只允许观察事件。
端口在插件代码运行前固定宿主会话身份，与 service 共用结果校验。每次工具/Hook 调用有独立生命周期；
调用结束、取消或插件行移除后，保留的回调和迟到结果会被拒绝。shutdown Hook 不提供设备端口。
已绑定工作区中的普通会话仍返回 `null`，工作区关联不会自动登记该会话。
上下文摘要只是快照，后续操作仍需核对当前状态。

成功显示 `backend 1.0.0`；更新到 v2 后重新核对前后端均为 `2.0.0`。只显示前端 v2 不能证明后端已切换。

## 失败与清理

移除后端行、关闭对应浏览器行、撤信任、缺少 allow-list 或当前会话，都应拒绝服务调用；前端会显示 unavailable。普通插件的安装代码不能自行授予 `services`。

禁用后端与前端贡献后旧句柄不应继续生效。回滚需要保留的受信快照和当前策略；不自动回滚外部业务数据。不要把该 query 样例改成写操作却保留 `kind: query`；有副作用服务另需 effect/命令身份与授权合同。

## 验证命令

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon/test/client-modules.test.ts --maxWorkers=1
```

该组合覆盖示例模块、Host 装配撤权和 daemon 浏览器调用边界；完整 browser → BFF → daemon → worker → Host 的可选验收程序为 [web-workbench.mjs](../../tools/acceptance/web-workbench.mjs)，实际运行版本与覆盖范围单列于[验证记录](../maintainers/verification.zh-CN.md)。

事实源：[Host 动态 client 扩展](../../packages/host/src/assemble.ts)、[动态装配测试](../../packages/host/test/assemble/dynamic-client-extension.test.ts)、[ClientContext 的服务门控](../../packages/web-client/src/client-module.ts)。

阿里云 SDK 的唯一实现现位于 Host，AKA 插件通过声明的 Host 根出口转出；SDK 版本未变，后台创建管线时才加载。
daemon 私有单图执行器把当前凭据检查、分别等待的上传鉴权/图片上传/检测 IO 准入和 DetectObject 前的持久预算
预留连接起来。先复制结构有效的 JPEG、核对真实尺寸和本进程帧年龄；取消不提前释放仍未结束的设备请求槽。
结果保留确切图片/hash 与请求 ID，归属/配置变化或迟到结果拒绝。该执行器尚未注册 RPC 或插件服务，生产
调用/任务授权、账号共享限频、共同需求、页面开关/结果及实机/云账号验收仍须交付。

实际 AKA 插件现注册 `aka.recognition.round.start` 效果服务，并同步后端及浏览器服务允许列表。服务要求当前
保留的识别配置和经过 Host 准入的预算端口，只提交闭合的绑定/配置/轮次版本及 startId；成功、失败或取消后
迟到的租约都释放。同一轮次的幂等回复可以已有占用次数，不能表示预算被清零。生产 supervisor 持有一个识别
执行器，在变更轮次前同步核对该设备在途槽；缺失或异步检查拒绝，未来实际识别调用必须复用该实例。
开启轮次不会连接、开相机、上传或开启持续识别。单图/enable 推理服务、真实云派发路由及页面控制仍须交付。

支持此能力的宿主只给已准入、具备产物能力且有有效调用关联的 AKA `aka.capture` / `aka.recognition.test` 效果提供
可选 `ServiceContext.captureArtifacts`，包含 read/save/recover/publish。私有 worker 桥固定真实会话和命令；
save 在异步操作前复制并校验有界 JPEG，先保存不可替换的选帧记录，再复用既有产物接缝写入。
daemon 核对实际文件字节；只有回收元数据不能确认保存。recover 核对原结果，不重新拍摄。
取消后仍等待实际写入结束才释放写入占用。通用 artifacts.put、查询、工具、钩子和其他插件不获该权限。
stored 不等于拍照完成：publish 分别验证事件和原图可读。示例现已注册页面效果/按钮，完整 daemon 到浏览器验收仍待完成。
缺端口的旧宿主明确拒绝；该可选合同不开放运动或推理。

captureArtifacts.publish() 取得 daemon 已持久化的原照片编号，通过当前 Host 会话写者追加私有照片事件；
重试核对同一事件，重复或损坏的同编号事件拒绝。取消后仍等待真实追加结束才释放占用。后台只在受信只读
账本查询匹配编号/原图、产物投影完成、所有者限定原图可读，并再次核对绑定/配置后确认 recorded。
worker JSON 不能选择事件内容、照片编号或另一个会话。生产组合提供有界只读操作，不暴露 SQL 或另建账本写者。
此端口已接 Host/worker 装配。示例已注册 aka.capture 和页面按钮，与模型拍照共用帧资格检查；Host 只为该已核对插件行的拍照和单图识别 test 效果授予产物声明，通用服务写入仍拒绝。页面抑制双击和换会话迟到回执。未知拍照提供显式原结果核对，复用宿主保留的原操作身份和原输入，无需实时相机。只有已核对 AKA 拍照服务可以进入受信只恢复范围，禁止选新帧或写新图，失败保留原 uncertain 记录；其他未知效果仍拒绝重放。AKA 页面待核对句柄可保存在当前标签页存储并在刷新后显式只读核对，清空存储或关闭标签页不属于恢复范围，重启后可查看已有会话产物，不自动重拍。完整 daemon 到页面验收仍待完成。

私有客户端模块效果中继支持 AKA 拍照的可选 `readbackOnly: true`。launcher 校验并保留此标记；daemon 核对已验证的后台所有者/服务，以只读方式查询持久操作日志。原身份缺失时返回未知，不建立日志行或调用 Host。原输入冲突、日志损坏及当前授权仍有效；未确认记录只能进入既有受信拍照恢复范围。该标记不进入原效果指纹，因为它限制同一操作的执行，不代表新效果或权限；false 和非布尔值非法。浏览器记录是不可信提示，不能代替后台准入。

Host 调用入口现在仅为具有真实调用关联的已入日志 AKA `aka.recognition.test`/`aka.recognition.enable` 效果，向内部上下文构造器提供实时授权检查。每次重新解析当前来源许可及同一用户身份，校验新的 execute 决定；拒绝禁止、待审批、过期、取消或调用结束。它不是 ServiceContext 字段或可序列化凭据；查询、其他效果及预算启动均没有这个检查器。这是识别桥接的前置接线：生产上下文构造器已通过 Host 私有注册器消费它，按上传授权、上传和检测的固定目的地同时检查插件及宿主网络允许范围。session worker 按确切调用/会话身份索引，撤销后移除，并通过私有 deviceRecognition.authorize 命令回查；普通和打包宿主构造均保留注册器。daemon 执行器已增加按原 worker 调用消费回查的入口；每阶段发送前及回复后核对确切的仍在途效果，拒绝只读恢复、取消和错误回复，读取凭据前也核对首个网络目的地。supervisor 已将私有 device-recognition-execute 请求接到同一共享执行器；WorkerPool 提供实际承载链接及仍有效的效果范围，限制 JSON/base64 容量，并在回复前再检查生命周期。Host 回查后签发一次性选帧窗口，以后台窗口耗时加 worker 报告的帧年龄作保守准入，不相减不同进程时钟；失败或已用窗口不能在同一效果下重开。普通 worker 与打包 Host 已传递私有请求桥。作者 ServiceContext 消费者及示例单图 test 效果现已接线，具体合同见下文；持续任务和结果卡发布尚未完成。Host 现已仅为该 AKA 行的 test/enable 效果声明三个固定云目的地，预算轮次和其他行不获此声明。服务网络检查使用已解析的 Host 默认 preset 网络允许列表，不读取始终为空的启动文件围栏；默认仍拒绝。实际注册行与 Host 装配测试覆盖三个目的地、仅上传允许、空列表、取消及调用结束；没有访问收费云服务。实际单图上下文和示例服务已接，持续识别与页面交付仍待完成。

支持的宿主现在为已准入、有有效调用关联和设备识别租约的 AKA test/enable 效果提供可选 `ServiceContext.recognition.run(expected, select, verifySelection)`。expected 是绑定、识别配置和轮次版本；select 在私有窗口准入后选择有界 JPEG，接收时间使用本 worker 单调时钟。调用身份、ticket、凭据和网络准入均由后台控制。端口每次效果只能执行一次，撤销后不可用；复制/校验图片并核对回复设备、版本、原图 hash、尺寸和框，释放租约。查询、预算轮次、只读恢复及其他插件没有此端口；工具和钩子也没有。示例现已注册 `aka.recognition.test`，输入 bindingRevision、连接 configRevision、recognitionRevision 和 roundRevision，复用当前流帧资格，在检测前保存并发布确切原图，返回同帧检测元数据及原图产物引用、事件序号。留档复用受信照片链，只扩大到该 test 效果；持续识别与只读 test 恢复仍无照片端口。已有原图时拒绝替换和重复检测；保存后由 Host 再核对帧龄，失败保留原图而不报告检测成功。不开启相机，不开始持续推理。配置保存和页面刷新仍不调用收费接口。实际 Host 装配使用替身私有执行桥验证允许/拒绝，不代表公开 HTTP、页面、云端或实车验收；单图显式入口与原图结果卡现已接线，见下文；持续需求仍待完成。

选帧回调接收当前调用/识别租约的组合 AbortSignal，配置撤销会取消选帧。可选 verifySelection 在后台结果校验后、租约释放前复查媒体；AKA 示例总是传入该检查。租约释放后不得再用同一信号进行发布资格验证。时间依据仍是流桥接收，不能证明曝光新鲜或用于物理接近。

设备面板现在通过 `aka.recognition.round.read` 显式读取当前轮次，仅按用户操作开始新轮次，并通过 `aka.recognition.test` 测试一张图片。读取效果沿认证、入日志服务准入，不授予云网络或预算修改能力。闭合输入为 expectedBindingRevision 与识别配置的 expectedConfigRevision；返回既有轮次或 null，不重置额度。页面将已保存原图及匹配框与直播分开展示；重新读图不重复推理。选帧时间采用 `bridge_receive`，不是曝光时间，页面到达时间另记为本地观察。有效额度取存量轮次与当前 requestBudget 的较小值，提高配置不会扩大旧轮次。测试不可用时说明配置、本地执行、轮次、额度或相机数据缺项。未知测试结果在标签页/模块重载后保留原操作。显式核对先返回原命令的已完成日志回执；同一原操作未完成时，daemon 可核对独立检测归档、原照片事件和当前所有者可读的 CAS 原图，再补全同一日志回执。缺原日志或无法核对的归档保持未知，不需相机数据，不进入作者服务、上传或再次检测。页面校验原结果后才清除提示。关闭标签页、清空存储、长期历史查询及持续需求不属于此标签页提示恢复路径。daemon 在读取凭据/上传前拒绝缺失、替换或耗尽的轮次，检测准入仍原子预留以处理期间的额度变化。上述代码及分层检查不等于真实云端、浏览器图片解码或实车验收。
