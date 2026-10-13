# pack-modeling.ps1 -- collect everything about this modelling pipeline into one staging tree.
#
# Why a script and not a hand-made zip: a good part of what makes the pipeline work is NOT in
# git (the whole .agnes/ tree is gitignored): the generator config, the local scripts, the
# skill. A hand-made archive would silently miss exactly those.
#
# What it deliberately does NOT copy, and why:
#   runs/         dozens of package directories, hundreds of MB, and they are EVIDENCE of
#                 particular rounds - they belong in a separate data archive, not in a code drop
#   meshes/       generated meshes + their sidecars (binary, and some came from private photos)
#   outputs/      .blend files, 3-10 MB each
#   __pycache__   build noise
#   .git          history belongs to the repo
#
# Usage:  powershell -ExecutionPolicy Bypass -File .agnes\work\pack-modeling.ps1
param([string]$Stage = '')

$ErrorActionPreference = 'Continue'
$root = 'D:\agnes-harness'
if (-not $Stage) {
  $Stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $Stage = Join-Path $root ".agnes\artifacts\stage\agh-modeling-$Stamp"
}
New-Item -ItemType Directory -Force $Stage | Out-Null

$found = 0; $missing = @()

function Copy-Into([string]$rel, [string]$sub) {
  $src = Join-Path $root $rel
  if (-not (Test-Path $src)) { $script:missing += $rel; return }
  $dst = Join-Path $Stage $sub
  New-Item -ItemType Directory -Force $dst | Out-Null
  # -Recurse for directories, plain copy for files; exclude noise everywhere.
  Get-ChildItem -Path $src -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '__pycache__|node_modules|\.git\\|\.agnes\\artifacts\\stage\\|\.agnes\\work\\pack\\' } |
    ForEach-Object {
      $relPath = $_.FullName.Substring($src.Length).TrimStart('\')
      if ([string]::IsNullOrEmpty($relPath)) { $relPath = $_.Name }
      $target = Join-Path $dst $relPath
      New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
      Copy-Item $_.FullName $target -Force
      $script:found++
    }
}

# 1. the two plugins (the actual product)
Copy-Into 'agh-ortho\package'   'plugins\agh-ortho'
Copy-Into 'agh-blender\package' 'plugins\agh-blender'

# 2. the plugin-side tooling (self-check, installers, cloud setup)
Copy-Into 'agh-ortho\tools'     'plugins\agh-ortho-tools'
Copy-Into 'agh-blender\tools'   'plugins\agh-blender-tools'

# 3. the local half: generator config + the scripts the config points at, and the scripts'
#    own measuring tools. NOTE: an explicit list, because `.agnes\work` is otherwise a 35 MB
#    junk drawer (draft meshes, probe .blend files, a 1.6 MB recover/t.json). A pack is judged
#    by what it leaves out as much as by what it carries.
Copy-Into '.agnes\agh-ortho\mesh-run.json'  'local\config'
Copy-Into '.agnes\agh-ortho\retention.json' 'local\config'
function Copy-FileList([string[]]$names, [string]$sub) {
  $dst = Join-Path $Stage $sub
  New-Item -ItemType Directory -Force $dst | Out-Null
  foreach ($n in $names) {
    $src = Join-Path $root (Join-Path '.agnes\work' $n)
    if (-not (Test-Path $src)) { $script:missing += ".agnes\work\$n"; continue }
    Copy-Item $src (Join-Path $dst (Split-Path $n -Leaf)) -Force
    $script:found++
  }
}
Copy-FileList @(
  'mesh-run-triposr.ps1',   # prep -> TripoSR -> bake: the generator command
  'cut-subject.ps1',        # preprocess wrapper: sets U2NET_PATH, calls the python below
  'cut-onnx.py',            # subject cut, u2netp via onnxruntime, local weights
  'prep-triposr-input.py',  # crop to the alpha bounding box + grey 512 canvas
  'bake-flip.mjs',          # bake the axis correction into the vertices
  'alpha-bbox.mjs',         # measure a photo: alpha bbox, aspect, touching the frame?
  'glb-bounds6.mjs',        # measure a GLB: world box, node transforms
  'measure-mesh.mjs',       # the coarser mesh ruler
  'png-measure.mjs',        # coverage / edge-touching for any PNG
  'audit-run.mjs',          # audit a run package against its own descriptors
  'run-refs.mjs',           # which runs the written record actually cites
  'retention-check.mjs',    # apply the pinning list to the real runs directory
  'cut-subject.py',         # the flood-fill heuristic that FAILED (kept as evidence)
  'cut-rembg.py',           # the rembg variant, unused (pypi unreachable from here)
  'pack-modeling.ps1'       # this script
) 'local\scripts'
Copy-Into '.agnes\work\frame-bounds' 'local\acceptance'
if (Test-Path (Join-Path $root '.agnes\work\PACK-README.md')) {
  Copy-Item (Join-Path $root '.agnes\work\PACK-README.md') (Join-Path $Stage 'README.md') -Force; $found++
} else { $missing += '.agnes\work\PACK-README.md' }

# 4. the record (the reason the code is the way it is)
Copy-Into 'agh-ortho\notes'     'notes'
Copy-Into 'agh-ortho\docs'      'notes\docs'

# 5. the skill + the project hint (how a session is told to use all of the above)
Copy-Into '.agnes\skills'       'skill'
if (Test-Path (Join-Path $root 'AGENTS.md')) { Copy-Item (Join-Path $root 'AGENTS.md') (Join-Path $Stage 'AGENTS.md') -Force; $found++ } else { $missing += 'AGENTS.md' }

# A manifest so the archive can be checked without opening it - including WHERE IT CAME FROM:
# the pack carries no .git, so without this line nobody can say which revision it is.
$list = Get-ChildItem -Path $Stage -Recurse -File | ForEach-Object { $_.FullName.Substring($Stage.Length).TrimStart('\') }
$head = (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1)
$dirty = (& git -C $root status --porcelain 2>$null | Select-Object -First 50)
$manifest = @{
  stagedAt = (Get-Date).ToString('o')
  head = "$head"
  uncommitted = @($dirty)
  files = $list.Count
  root = $Stage
  entries = $list
}
# PowerShell 5.1 的 UTF8 会写 BOM，而带 BOM 的 JSON 会让普通解析器直接报错（我当场被它绊了一次）。
# 包里的文件不该有这种小地雷：用 .NET 原样写，不带头部。
$json = $manifest | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText((Join-Path $Stage 'MANIFEST.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "staged $found files into $Stage"
if ($missing.Count -gt 0) { Write-Host ("MISSING (not found, not copied): " + ($missing -join ', ')) }
Write-Host ("total files in stage: " + $list.Count)
