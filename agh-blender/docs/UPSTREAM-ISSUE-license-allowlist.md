# 上游反馈草稿：许可白名单拒绝时，不告诉任何人**为什么**

> 对象：`AgnesAI-Labs/agnes-harness`（本仓库）。
> 状态：**草稿**，尚未提交成 issue。本文件放在 `agh-blender/docs/`（包外），所以可以随时改。
> 正文引用的行号取自本机 `D:\agnes-harness` HEAD = `e67a32d3`。
> 说明：为保持与仓库文档一致，本条用中文写；错误码与消息按产品原文引用。要发英文版可以再出一份。

## 标题建议

```
包许可闸门：不在白名单的 license 以 E_PACKAGE_TRUST 失败，且不携带任何原因（blockers: []）
```

## 现象

安装一个 `package.json` 里 `license` 不在白名单内的插件，`trust` 失败，但**输出里没有任何东西说明是许可问题**：

```
$ node packages/cli/dist/local/agnes.mjs install "file:./my-plugin/package" --profile local-dev
$ node packages/cli/dist/local/agnes.mjs package trust my-plugin <integrity> <capabilityHash> --profile local-dev

code         E_PACKAGE_TRUST
safeMessage  The package does not meet the required trust policy.
blockers     []
```

- **不说是许可**，也**不给白名单**。
- `blockers` 是空数组，看起来像"策略拒绝但策略没解释"。
- 把 `license` 改成 `MIT` 后**立刻通过**，其余一字未动 —— 说明卡点确实只是这一个字符串。

## 根因（读源码核实）

**1. 闸门在 `packages/package-manager/src/trust-gate.ts`**

```ts
 9  export const LICENSE_ALLOWLIST = [
10    'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
14    'ISC', '0BSD', 'MPL-2.0', 'Unlicense',
18  ] as const
...
58    if (!(LICENSE_ALLOWLIST as readonly string[]).includes(entry.license))
59      throw new PackageError('E_PACKAGE_QUARANTINED', `${id} has a license outside the allowlist`, {
60        detail: { id, reason: 'license', license: entry.license },
61      })
```

内部错误**其实知道原因**：`reason: 'license'`、还带着具体的 `license` 值。

**2. 两个 legacy code 塌成同一个对外码** —— `packages/package-manager/src/errors.ts`

```ts
 6    E_WORKSPACE_UNTRUSTED: 'E_PACKAGE_TRUST',
 7    E_PACKAGE_QUARANTINED: 'E_PACKAGE_TRUST',
```

**3. 对外那一层把消息换成固定文案，并从 `detail.blockers` 取 blockers** —— `packages/daemon/src/packages/handler.ts`

```ts
161  const safeMessage: Record<PackageAdminError['code'], string> = {
164    E_PACKAGE_TRUST: 'The package does not meet the required trust policy.',
...
212  function packageError(error: unknown): PackageAdminError {
218    const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail : undefined
220    const blockers = safeBlockers(detail?.blockers)      // ← 只看 detail.blockers
221    return { code, safeMessage: safeMessage[code], blockers }
```

许可闸门写的是 `detail.reason` / `detail.license`，**从不写 `detail.blockers`** ⇒ 对外必然 `blockers: []`。
`safeMessage` 是按 code 查的**固定表**，也不含 `reason`。

于是：`reason: 'license'` + `license: 'GPL-3.0-or-later'` 这两条**最有用**的信息，在
`PackageError → PackageAdminError` 这一跳里**被丢掉**，对外只剩一句泛泛的话。

**4. 文档里没有这个白名单**

`docs/guide/packages.md` 讲了 `install → trust → enable`，但**没有任何一处**提到
"包许可必须是这 8 个之一"。作者只能靠读源码或试错发现。

## 影响

- **正当的单一 GPL 授权包无法发布，且得不到可诊断的失败。** 这不是假想场景：任何
  `import bpy` 的 Blender 侧代码，通常被要求按 GPL 兼容条款分发。
- 闸门读的是**根部单个 `license` 字符串**，所以"拆许可"（根 `Apache-2.0` +
  某个子目录 `GPL-3.0-or-later`）能通过。结果是：**闸门把作者推向一种许可拆分，
  却什么也不说** —— 作者要靠猜。
- 失败是**不可自学**的：没有 `reason`、没有 `license`、`blockers` 空、文档没有白名单。
- 两个 legacy code 共用一个对外码，调用方**无法区分**"工作区未信任"和"许可被隔离"，
  而这两件事的处置完全不同。

## 建议（任一都能解决"不可诊断"）

1. **把原因装进 `blockers`**（不需要改协议形状，`PackageBlocker` 已有 `policy` 码）：
   ```json
   { "code": "policy",
     "references": ["license/GPL-3.0-or-later",
                    "allowlist/MIT", "allowlist/Apache-2.0", "allowlist/BSD-2-Clause",
                    "allowlist/BSD-3-Clause", "allowlist/ISC", "allowlist/0BSD",
                    "allowlist/MPL-2.0", "allowlist/Unlicense"] }
   ```
   `handler.ts:189` 的 `safeReference` 只允许 `[A-Za-z0-9_.:@/-]`，上面这些串都能通过。
   行数只有个位数，且所有 `E_PACKAGE_QUARANTINED` 分支都能受益（`release-age`、`api-range` 同理）。
2. **或在 `safeMessage` 之外补一条 `reason` 字段**（`PackageAdminError` 目前
   `additionalProperties: false`，需要同步 protocol schema 与生成物）。
3. **或拆开对外码**：`E_PACKAGE_QUARANTINED` 与 `E_WORKSPACE_UNTRUSTED` 各自成码
   （`errors.ts:6-7`）。
4. **文档**：在 `docs/guide/packages.md`（及 `.zh-CN`）和扩展作者指南里写明白名单，
   并说明"许可不一致时闸门只读根部 `license`"。

## 复现（最小）

```json
{ "name": "license-gate-repro", "version": "0.0.1", "private": true,
  "license": "GPL-3.0-or-later",
  "agnes": { "plugins": [{ "export": "runtime", "id": "ext:license-gate-repro/runtime",
                           "runtime": "in-process" }] } }
```

`install` → `trust` → 得 `E_PACKAGE_TRUST` + `blockers: []`；把 `license` 改成 `Apache-2.0`
再走一遍 → 通过。（本机实测：0.1.0 → 0.1.1 就是这么解开的，见 `docs/DESIGN.md` §3.10、
`P0-EVIDENCE.md` §P.5/P.5.5。）

## 工作区已接受的规避

`agh-blender` 采用"两套声明"：包根 `license: "Apache-2.0"`，`extensions/main/bridge/`
（`import bpy` 的那三个 `.py`）按 `GPL-3.0-or-later` 授权，两份许可文件都在包里。
**闸门通过，但这依赖"它只读根部一个字符串"这一未言明的行为** —— 这正是上面建议 4 想固化的东西。
