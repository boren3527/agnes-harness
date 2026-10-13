// Use the runtime reader so the diagnostic and production measurements cannot drift.
import { readFileSync } from 'node:fs'
import { glbWorldBounds } from '../../packages/agh-ortho/extensions/main/glb-geometry.mjs'

const file = process.argv[2]
if (!file) throw new Error('Usage: node glb-bounds6.mjs model.glb')
const result = glbWorldBounds(readFileSync(file))
if (!result.ok) throw new Error(result.why)
console.log(JSON.stringify({ file, ...result }, null, 2))
