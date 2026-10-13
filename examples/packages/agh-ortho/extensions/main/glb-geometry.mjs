// Bounds and six-view outlines use the same active-scene vertices and world transforms.
// Unsupported deformation/compression is refused rather than certified from accessor metadata.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite)
const integer = (v) => Number.isSafeInteger(v) && v >= 0
const fail = (message) => {
  throw new Error(message)
}
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const r = i % 4,
      c = Math.floor(i / 4)
    return a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3]
  })
}
function localMatrix(node) {
  if (node.matrix !== undefined) {
    const m = node.matrix
    if (
      !vector(m, 16) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1 ||
      ['translation', 'rotation', 'scale'].some((k) => node[k] !== undefined)
    )
      fail('invalid affine node matrix')
    return m
  }
  const t = node.translation ?? [0, 0, 0],
    s = node.scale ?? [1, 1, 1],
    q = node.rotation ?? [0, 0, 0, 1]
  if (!vector(t, 3) || !vector(s, 3) || !vector(q, 4) || Math.abs(Math.hypot(...q) - 1) > 1e-5)
    fail('invalid node TRS')
  const [x, y, z, w] = q
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + z * w) * s[0],
    2 * (x * z - y * w) * s[0],
    0,
    2 * (x * y - z * w) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + x * w) * s[1],
    0,
    2 * (x * z + y * w) * s[2],
    2 * (y * z - x * w) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    ...t,
    1,
  ]
}
function parse(bytes) {
  const buf = Buffer.from(bytes)
  if (
    buf.length < 20 ||
    buf.toString('latin1', 0, 4) !== 'glTF' ||
    buf.readUInt32LE(4) !== 2 ||
    buf.readUInt32LE(8) !== buf.length
  )
    fail('invalid GLB header or length')
  let json,
    bin,
    offset = 12
  while (offset < buf.length) {
    if (offset + 8 > buf.length) fail('truncated GLB chunk')
    const length = buf.readUInt32LE(offset),
      type = buf.readUInt32LE(offset + 4)
    if (length % 4 || offset + 8 + length > buf.length) fail('invalid GLB chunk length')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) {
      if (json || offset !== 12) fail('invalid JSON chunk ordering')
      json = JSON.parse(data.toString('utf8'))
    } else if (type === 0x004e4942) {
      if (bin) fail('duplicate BIN chunk')
      bin = data
    }
    offset += 8 + length
  }
  if (!json || !bin || json.asset?.version !== '2.0') fail('missing glTF 2.0 JSON or BIN chunk')
  if (json.extensionsRequired?.length || json.animations?.length)
    fail('required extensions and animated geometry are unsupported')
  if (
    json.buffers?.length !== 1 ||
    json.buffers[0].uri ||
    !integer(json.buffers[0].byteLength) ||
    json.buffers[0].byteLength > bin.length
  )
    fail('unsupported or truncated vertex buffer')
  return { json, bin: bin.subarray(0, json.buffers[0].byteLength) }
}
export function decodePositions(bytes) {
  try {
    const { json, bin } = parse(bytes)
    const nodes = json.nodes ?? [],
      meshes = json.meshes ?? [],
      accessors = json.accessors ?? [],
      views = json.bufferViews ?? []
    if (!Array.isArray(nodes) || nodes.length > 10000) fail('invalid node table')
    const childSet = new Set()
    for (const node of nodes) for (const child of node.children ?? []) childSet.add(child)
    const roots =
      json.scenes?.[json.scene ?? 0]?.nodes ??
      (json.scenes ? null : nodes.map((_, i) => i).filter((i) => !childSet.has(i)))
    if (!Array.isArray(roots) || !roots.length) fail('active scene is missing or empty')
    const visited = new Set(),
      vertices = []
    let count = 0
    const visit = (index, parent, depth) => {
      if (!integer(index) || !nodes[index] || visited.has(index) || depth > 128)
        fail('invalid, cyclic or shared scene node')
      visited.add(index)
      const node = nodes[index],
        world = multiply(parent, localMatrix(node))
      if (node.skin !== undefined || node.weights?.length || node.extensions)
        fail('deformed or extended nodes are unsupported')
      if (node.mesh !== undefined) {
        const mesh = integer(node.mesh) && meshes[node.mesh]
        if (!mesh?.primitives?.length || mesh.weights?.length) fail('missing or deformed mesh')
        count++
        for (const prim of mesh.primitives) {
          if (prim.targets?.length || prim.extensions) fail('morph or compressed primitives are unsupported')
          const acc = accessors[prim.attributes?.POSITION],
            bv = acc && views[acc.bufferView]
          if (
            !acc ||
            acc.type !== 'VEC3' ||
            acc.componentType !== 5126 ||
            acc.sparse ||
            acc.normalized ||
            !integer(acc.count) ||
            !acc.count ||
            !bv ||
            bv.buffer !== 0 ||
            bv.extensions
          )
            fail('unsupported POSITION accessor')
          const stride = bv.byteStride ?? 12,
            offset = acc.byteOffset ?? 0,
            start = bv.byteOffset ?? 0
          if (
            !integer(stride) ||
            stride < 12 ||
            stride > 252 ||
            stride % 4 ||
            !integer(offset) ||
            offset % 4 ||
            !integer(start) ||
            start % 4 ||
            !integer(bv.byteLength) ||
            start + bv.byteLength > bin.length ||
            offset + (acc.count - 1) * stride + 12 > bv.byteLength ||
            vertices.length + acc.count > 2000000
          )
            fail('invalid or oversized POSITION data')
          for (let i = 0; i < acc.count; i++) {
            const at = start + offset + i * stride
            const p = [bin.readFloatLE(at), bin.readFloatLE(at + 4), bin.readFloatLE(at + 8)]
            const v = [0, 1, 2].map(
              (r) => world[r] * p[0] + world[r + 4] * p[1] + world[r + 8] * p[2] + world[r + 12],
            )
            if (!v.every(Number.isFinite)) fail('non-finite world vertex')
            vertices.push(v)
          }
        }
      }
      for (const child of node.children ?? []) visit(child, world, depth + 1)
    }
    for (const root of roots) visit(root, identity(), 0)
    if (!vertices.length) fail('no readable mesh vertices in the active scene')
    return { ok: true, vertices, nodes: count }
  } catch (error) {
    return { ok: false, why: error.message }
  }
}
export function glbWorldBounds(bytes) {
  const decoded = decodePositions(bytes)
  if (!decoded.ok) return decoded
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (const p of decoded.vertices)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i])
      max[i] = Math.max(max[i], p[i])
    }
  return { ok: true, min, max, size: max.map((v, i) => v - min[i]), nodes: decoded.nodes, rotated: false }
}
