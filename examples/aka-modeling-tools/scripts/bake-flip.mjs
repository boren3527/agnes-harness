/**
 * 把 180° 翻转**烘进网格数据**（绕文件自身的 Y 轴：(x,y,z) → (−x,y,−z)）。
 *
 * 为什么烘进数据而不是发 object.transform：实测（p0-rot-probe，2026-10-10）下游 `mesh.import`
 * 走 glTF 导入器 ⇒ 对象是 QUATERNION 模式 ⇒ Blender **忽略** rotation_euler ⇒ 旋转静默失效。
 * 面朝/朝上这类**数据本身的朝向**问题，最稳的解法是把它写进数据：之后声明 `up_axis: "X"`（不带符号）
 * 单独就得到正立的模型，不依赖任何 op。
 *
 * 为什么绕 Y 而不是绕 Z：两者都能把 −X 翻成 +X，但绕 Z 会同时把 y→−y ⇒ **左右镜像**（角色被镜像
 * 是静默的错）；绕 Y 只把 z→−z ⇒ 只是"面朝方向"换了一边（对我们的用途是自由的）。
 *
 * 用法：node bake-flip.mjs <源.glb> <目标.glb>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.log('用法: node bake-flip.mjs <源.glb> <目标.glb>')
  process.exit(1)
}

const buf = readFileSync(src)
const magic = buf.readUInt32LE(0)
const version = buf.readUInt32LE(4)
const total = buf.readUInt32LE(8)
if (magic !== 0x46546c67 || version !== 2)
  throw new Error(`${src} 不是 glTF 2.0 二进制（magic=${magic} version=${version}）`)

let offset = 12
let json = null
let bin = null
while (offset < total) {
  const len = buf.readUInt32LE(offset)
  const type = buf.readUInt32LE(offset + 4)
  const data = buf.subarray(offset + 8, offset + 8 + len)
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
  else if (type === 0x004e4942) bin = Buffer.from(data)
  offset += 8 + len
}
if (!json || !bin) throw new Error('GLB 缺少 JSON 或 BIN 块')

/** 对 VEC3 的 float 数据施加 (x,y,z) → (−x,y,−z)。 */
const flipView = (accessorIndex, label) => {
  const acc = json.accessors[accessorIndex]
  if (!acc || acc.type !== 'VEC3' || acc.componentType !== 5126) return 0
  const view = json.bufferViews[acc.bufferView]
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = view.byteStride ?? 12
  for (let i = 0; i < acc.count; i += 1) {
    const at = base + i * stride
    const x = bin.readFloatLE(at)
    const z = bin.readFloatLE(at + 8)
    bin.writeFloatLE(-x, at)
    bin.writeFloatLE(-z, at + 8)
  }
  if (Array.isArray(acc.min) && Array.isArray(acc.max)) {
    const min = [-acc.max[0], acc.min[1], -acc.max[2]]
    const max = [-acc.min[0], acc.max[1], -acc.min[2]]
    acc.min = min
    acc.max = max
  }
  console.log(`  ${label}: ${acc.count} 个顶点已翻转，min/max 已更新`)
  return acc.count
}

let flipped = 0
for (const [mi, mesh] of (json.meshes ?? []).entries()) {
  for (const [pi, prim] of (mesh.primitives ?? []).entries()) {
    const attrs = prim.attributes ?? {}
    if (Number.isInteger(attrs.POSITION)) flipped += flipView(attrs.POSITION, `mesh${mi}.prim${pi}.POSITION`)
    if (Number.isInteger(attrs.NORMAL)) flipView(attrs.NORMAL, `mesh${mi}.prim${pi}.NORMAL`)
  }
}
if (!flipped) throw new Error('没有找到可翻转的 VEC3 float 数据 —— 拒绝写出一个没变过的文件')

// 重写 GLB：JSON 用空格补齐、BIN 用 0 补齐（规范要求 4 字节对齐）。
const pad = (b, byte) => {
  const rem = b.length % 4
  return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - rem, byte)])
}
const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
const binChunk = pad(bin, 0)
const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length)
out.writeUInt32LE(0x46546c67, 0)
out.writeUInt32LE(2, 4)
out.writeUInt32LE(out.length, 8)
let at = 12
out.writeUInt32LE(jsonChunk.length, at)
out.writeUInt32LE(0x4e4f534a, at + 4)
jsonChunk.copy(out, at + 8)
at += 8 + jsonChunk.length
out.writeUInt32LE(binChunk.length, at)
out.writeUInt32LE(0x004e4942, at + 4)
binChunk.copy(out, at + 8)
writeFileSync(dst, out)
console.log(`写出 ${dst}：${out.length} 字节（源 ${buf.length} 字节），共翻转 ${flipped} 个顶点`)
