// Read a photograph's silhouette with the SAME decoder the silhouette tier uses
// (agh-ortho/package/extensions/main/silhouette.mjs), so the reading of the photo and the
// reading of the render come from one code path.
//
// Why this matters for photo_check: the declared interval must come from the PHOTOGRAPH.
// A script reading of the photo is still a reading of the photo (NOT a copy of the model's own
// projection), and it is far more repeatable than an eyeball. But if the silhouette TOUCHES the
// frame, the aspect ratio is a crop, not a shape - and then the honest move is to say so
// instead of declaring a number.
import { readFileSync } from 'node:fs'
import { decodePng, silhouetteOf } from '../../agh-ortho/package/extensions/main/silhouette.mjs'

const path = process.argv[2]
if (!path) {
  console.log('usage: node alpha-bbox.mjs <image.png>')
  process.exit(1)
}
const bytes = readFileSync(path)
const png = decodePng(bytes)
const sil = silhouetteOf(bytes)
console.log(
  JSON.stringify(
    {
      file: path,
      file_bytes: bytes.length,
      png: { size: [png.width, png.height], colorType: png.colorType, channels: png.channels },
      covered_fraction: sil.covered_fraction,
      bbox_px: sil.bbox_px,
      aspect_px: sil.aspect_px,
      touches_edges: sil.touches_edges,
      cropped: sil.touches_edges ? Object.values(sil.touches_edges).some(Boolean) : null,
    },
    null,
    1,
  ),
)
