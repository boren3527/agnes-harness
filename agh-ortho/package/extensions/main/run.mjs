/**
 * run.mjs —— 描述符层：run 目录、marker.json、report.json、幂等与保留策略。
 * （纯函数 + 注入的 fs，方便用内存 fs 直接测。）
 *
 * 依据 upstream 契约（agh-blender/docs/UPSTREAM-ARTIFACT-CONTRACT.md）：
 *   §3 描述符字段   §4 落点与 naming   §5.2 先落盘报告再返回   §5.3 幂等   §7 清理与保留
 *
 * 为什么产物必须"落盘 + 描述符"而不是只回一段 JSON：
 *   §2.1 任何由第三方插件放进工具结果的内容块（尤其图片）会让**这一轮直接失败并永久毒化会话**；
 *   §2.2 写进产物库 ≠ 消费方读得到；
 *   §5.2 副作用型工具的结果可能被宿主替换为 TOOL_OUTCOME_UNKNOWN，结果与失败原因**一起永久丢失**
 *        ⇒ 唯一的补救是先把报告写到磁盘，返回值只是"方便读的副本"。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 契约版本。不兼容变更必须递增；消费方不认识这个值必须明确拒绝，不许猜。 */
export const CONTRACT_VERSION = 1
export const PRODUCER = 'agh-ortho@0.1.0'

/** 产物根目录（相对工作区）。工作区的 `.agnes` 被 .gitignore 忽略，不会污染 git status。 */
export const ARTIFACT_ROOT_SEGMENTS = ['.agnes', 'agh-ortho', 'runs']

/** §7 保留策略：默认保留最近 20 次运行或 30 天，取先到者。 */
export const RETENTION = { maxRuns: 20, maxAgeDays: 30 }

const ROOT = ARTIFACT_ROOT_SEGMENTS.join('/')

export const runPaths = (runId) => ({
  dir: `${ROOT}/${runId}`,
  marker: `${ROOT}/${runId}/marker.json`,
  report: `${ROOT}/${runId}/report.json`,
  file: (name) => `${ROOT}/${runId}/${name}`,
})

export const newRunId = () => randomUUID()

const shape = (name) => (name.split('.').pop() ?? '').toLowerCase()

/** §3 的 mime / kind 词表。只认我们真的会产出的那几种。 */
export function classifyFile(name) {
  switch (shape(name)) {
    case 'svg':
      return { mime: 'image/svg+xml', kind: 'image' }
    case 'json':
      return { mime: 'application/json', kind: 'json' }
    case 'csv':
      return { mime: 'text/csv', kind: 'csv' }
    case 'png':
      return { mime: 'image/png', kind: 'image' }
    default:
      return { mime: 'application/octet-stream', kind: 'other' }
  }
}

/** §3 描述符。`preview` 是**模型唯一必然读到的内容**，所以它必须承载语义，不能写废话。 */
export function descriptor({ name, absolutePath, text, preview, createdAt, meta = null }) {
  const bytes = Buffer.byteLength(text, 'utf8')
  const { mime, kind } = classifyFile(name)
  return {
    contract: CONTRACT_VERSION,
    id: randomUUID(),
    path: absolutePath,
    sha256: sha256Hex(text),
    bytes,
    mime,
    kind,
    createdAt,
    producer: PRODUCER,
    preview,
    // 大文件只给路径，不塞内容（§3）：消费方需要正文时按 path 读。
    text: null,
    ...(meta === null ? {} : { meta }),
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function makeMarker({ runId, createdAt }) {
  return { contract: CONTRACT_VERSION, producer: PRODUCER, runId, createdAt }
}

export function makeReport({ runId, createdAt, descriptors, extra }) {
  return {
    contract: CONTRACT_VERSION,
    producer: PRODUCER,
    runId,
    createdAt,
    // §3：消费方必须能忽略未知字段 ⇒ 额外信息放同层而不是塞进描述符。
    ...(extra ?? {}),
    artifacts: descriptors,
  }
}

async function readJson(fs, path) {
  try {
    const bytes = await fs.read(path)
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * §4 marker.json 用于归属校验：吃一个产物之前先确认它属于预期的生产方与运行，
 * 避免"读到别的运行留下的东西"。§6 的 E_RUN_NOT_OWNED 就是这条。
 */
export async function loadRun(fs, runId) {
  const paths = runPaths(runId)
  const marker = await readJson(fs, paths.marker)
  if (!marker) return { owned: false, reason: 'no marker.json: this run directory is not ours', marker: null, report: null }
  if (marker.contract !== CONTRACT_VERSION) {
    return { owned: false, reason: `marker.json declares contract ${marker.contract}, this producer speaks ${CONTRACT_VERSION}`, marker, report: null }
  }
  if (marker.producer !== PRODUCER) {
    return { owned: false, reason: `marker.json names producer ${marker.producer}, not ${PRODUCER}`, marker, report: null }
  }
  const report = await readJson(fs, paths.report)
  if (!report) return { owned: true, reason: 'marker present but report.json is missing or unreadable', marker, report: null }
  return { owned: true, reason: null, marker, report }
}

/**
 * 写一个 run。顺序是刻意的：产物 → marker → report。
 * report.json **必须**在返回之前落盘（§5.2），因为它才是消费者据以判断的依据。
 * 返回 { ok, paths, descriptors } 或 { ok:false, code, message }。
 */
export async function writeRun(fs, { runId, createdAt, files, extra }) {
  const paths = runPaths(runId)
  const descriptors = []
  for (const file of files) {
    // 写失败就抛（seam 的契约是抛，不是返回错误码）—— 由调用方转成 blockers。
    await fs.write(paths.file(file.name), file.text)
    descriptors.push(
      descriptor({
        name: file.name,
        absolutePath: file.absolutePath,
        text: file.text,
        preview: file.preview,
        createdAt,
        meta: file.meta ?? null,
      }),
    )
  }
  await fs.write(paths.marker, `${JSON.stringify(makeMarker({ runId, createdAt }), null, 2)}\n`)
  const report = makeReport({ runId, createdAt, descriptors, extra })
  await fs.write(paths.report, `${JSON.stringify(report, null, 2)}\n`)
  return { ok: true, paths, descriptors, report }
}

/** 列出已有运行。只看目录，逐个读 marker.json（拿 createdAt，避免依赖 stat 的形状）。 */
export async function listRuns(fs) {
  let entries
  try {
    entries = await fs.list(ROOT)
  } catch {
    return []
  }
  const runs = []
  for (const entry of entries) {
    if (entry?.kind !== 'dir') continue
    const marker = await readJson(fs, `${ROOT}/${entry.name}/marker.json`)
    runs.push({
      runId: entry.name,
      createdAt: typeof marker?.createdAt === 'string' ? marker.createdAt : null,
      producer: typeof marker?.producer === 'string' ? marker.producer : null,
      owned: marker?.producer === PRODUCER && marker?.contract === CONTRACT_VERSION,
    })
  }
  return runs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * §7：谁删 = 生产方；消费方永不删。默认保留最近 N 次运行或 M 天。
 *
 * 我们**只算出该删谁，不主动删**：契约要求"不得静默删除被引用的运行（引用 = 该运行出现在某次
 * 会话的报告里）"，而本插件无法知道谁引用过谁。所以计划总是出现在返回值里，只有调用方明确
 * 传 prune:true 才真的删。这是对 §7 的一处**刻意保守偏离**，记在 notes 里。
 */
export function planRetention(runs, { now = new Date(), currentRunId = null } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION.maxAgeDays * 86_400_000).toISOString()
  const keep = []
  const prune = []
  for (const [index, run] of runs.entries()) {
    const reasons = []
    if (index >= RETENTION.maxRuns) reasons.push(`beyond the newest ${RETENTION.maxRuns} runs`)
    if (!run.createdAt) reasons.push('no createdAt in marker.json')
    else if (run.createdAt < cutoff) reasons.push(`older than ${RETENTION.maxAgeDays} days`)
    if (!run.owned) reasons.push('not produced by this producer')
    if (run.runId === currentRunId) reasons.push('the current run')
    if (reasons.some((r) => r === 'the current run' || r === 'not produced by this producer' || r === 'no createdAt in marker.json')) keep.push(run)
    else if (reasons.length) prune.push({ ...run, reasons })
    else keep.push(run)
  }
  return { policy: RETENTION, wouldPrune: prune, kept: keep.length }
}
