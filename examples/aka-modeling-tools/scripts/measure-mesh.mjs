// 网格样本的"尺子"：量包围盒（暴露单位）、哪根轴最长（up 轴候选）、
// 顶点/面数、是否带顶点色、是否分层。
// 用法：node .agnes/work/measure-mesh.mjs <file.glb|file.obj> [更多文件...]
import { readFileSync } from 'node:fs'

function bboxOf(points) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of points)
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < lo[i]) lo[i] = p[i]
      if (p[i] > hi[i]) hi[i] = p[i]
    }
  return {
    min: lo.map((v) => v.toFixed(4)),
    max: hi.map((v) => v.toFixed(4)),
    size: hi.map((v, i) => (v - lo[i]).toFixed(4)),
  }
}

function measureGlb(path) {
  const buf = readFileSync(path)
  const magic = buf.toString('latin1', 0, 4)
  if (magic !== 'glTF') throw new Error('not a GLB')
  const version = buf.readUInt32LE(4)
  const length = buf.readUInt32LE(8)
  let offset = 12
  let json = null
  let binLength = 0
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset)
    const chunkType = buf.toString('latin1', offset + 4, offset + 8)
    if (chunkType === 'JSON')
      json = JSON.parse(buf.subarray(offset + 8, offset + 8 + chunkLength).toString('utf8'))
    if (chunkType.startsWith('BIN')) binLength = chunkLength
    offset += 8 + chunkLength
  }
  const positions = []
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION]
      if (acc?.min && acc?.max) positions.push({ min: acc.min, max: acc.max, count: acc.count })
    }
  }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let verts = 0
  for (const p of positions) {
    verts += p.count ?? 0
    for (let i = 0; i < 3; i += 1) {
      if (p.min[i] < lo[i]) lo[i] = p.min[i]
      if (p.max[i] > hi[i]) hi[i] = p.max[i]
    }
  }
  const localSize = hi.map((v, i) => v - lo[i])
  const nodes = (json.nodes ?? []).map((n) => ({
    name: n.name ?? null,
    translation: n.translation ?? null,
    rotation: n.rotation ?? null,
    scale: n.scale ?? null,
  }))
  // **世界**尺寸才是主数字：glTF 允许把变换放在**节点**上（accessor 只描述局部坐标）⇒ 只看 accessor
  // 会把"缩放到 0.4×0.4×2 的方块"读成"2×2×2"。这一条**实测骗过人**：结论被带偏成"2×2×2 的团块"，
  // 而文件的世界尺寸是 0.4×2×0.4。所以：主数字 = 世界尺寸，局部尺寸另列；
  // 带**旋转**的节点无法用轴对齐盒子表述 ⇒ 明确标注，不硬给一串看起来精确的数。
  const wLo = [Infinity, Infinity, Infinity]
  const wHi = [-Infinity, -Infinity, -Infinity]
  let rotated = false
  for (const node of json.nodes ?? []) {
    if (node?.mesh === undefined) continue
    const prim = json.meshes?.[node.mesh]?.primitives?.[0]
    const acc = prim && json.accessors ? json.accessors[prim.attributes?.POSITION] : null
    if (!acc?.min || !acc?.max) continue
    const q = Array.isArray(node.rotation) ? node.rotation : null
    if (q && q.some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-6)) rotated = true
    const s = Array.isArray(node.scale) ? node.scale.map((v) => Math.abs(v)) : [1, 1, 1]
    const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0]
    for (let i = 0; i < 3; i += 1) {
      const a = acc.min[i] * s[i] + t[i]
      const b = acc.max[i] * s[i] + t[i]
      if (a < wLo[i]) wLo[i] = a
      if (b > wHi[i]) wHi[i] = b
    }
  }
  const hasWorld = wLo.every((v) => Number.isFinite(v))
  const size = hasWorld ? wHi.map((v, i) => v - wLo[i]) : localSize
  const sizes = size.map((v) => Number(v.toFixed(4)))
  const maxSize = Math.max(...sizes)
  const winners = ['X', 'Y', 'Z'].filter((_, i) => Math.abs(sizes[i] - maxSize) < 1e-6)
  // 平局时**不给答案**：对称物体本来就无法判定 up 轴，硬挑一个就是编。
  const longest = winners.length > 1 ? `ambiguous (${winners.join('/')})` : winners[0]
  return {
    kind: 'glb',
    glbVersion: version,
    declaredLength: length,
    scenes: (json.scenes ?? []).length,
    meshes: (json.meshes ?? []).length,
    materials: (json.materials ?? []).length,
    images: (json.images ?? []).length,
    hasTexture: (json.images ?? []).length > 0,
    primitiveCount: positions.length,
    verticesFromAccessors: verts,
    bbox: {
      min: (hasWorld ? wLo : lo).map((v) => v.toFixed(4)),
      max: (hasWorld ? wHi : hi).map((v) => v.toFixed(4)),
      size: sizes.map((v) => v.toFixed(4)),
    },
    is_world: hasWorld && nodes.some((n) => n.scale || n.translation),
    local_size: localSize.map((v) => Number(v.toFixed(4))),
    rotation_present: rotated,
    longestAxis: rotated ? 'unknown (a rotated node cannot be described by an axis-aligned box)' : longest,
    sizeAlongLongestAxis: Math.max(...size).toFixed(4),
    node_transforms: nodes,
    has_node_transform: nodes.some((n) => n.scale || n.rotation || n.translation),
    binChunkBytes: binLength,
  }
}

function measureObj(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  const points = []
  let faces = 0
  let vt = 0
  let vn = 0
  let vertexColors = false
  let mtllib = null
  const groups = new Set()
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 7) vertexColors = true
      points.push([Number(parts[1]), Number(parts[2]), Number(parts[3])])
    } else if (line.startsWith('f ')) faces += 1
    else if (line.startsWith('vt ')) vt += 1
    else if (line.startsWith('vn ')) vn += 1
    else if (line.startsWith('mtllib ')) mtllib = line.slice(7).trim()
    else if (line.startsWith('g ') || line.startsWith('o ')) groups.add(line.slice(2).trim())
  }
  const size = points.length ? bboxOf(points).size.map(Number) : [0, 0, 0]
  return {
    kind: 'obj',
    vertices: points.length,
    faces,
    uvs: vt,
    normals: vn,
    vertexColors,
    mtllib,
    groups: [...groups].slice(0, 10),
    bbox: points.length ? bboxOf(points) : null,
    longestAxis: ['X', 'Y', 'Z'][size.indexOf(Math.max(...size))],
  }
}

for (const file of process.argv.slice(2)) {
  try {
    const r = file.toLowerCase().endsWith('.glb') ? measureGlb(file) : measureObj(file)
    if (r.bbox?.size) {
      const size = r.bbox.size.map(Number)
      r.longestAxis = ['X', 'Y', 'Z'][size.indexOf(Math.max(...size))]
    }
    console.log(JSON.stringify({ file, ...r }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ file, error: String(error?.message ?? error) }, null, 2))
  }
}
