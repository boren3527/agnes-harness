# mesh-run-triposr.ps1 -- the generator command for agh_ortho_mesh_run ON THIS MACHINE.
# Contract: -Image <photo> -Out <dir>; leaves the finished .glb at <dir>\final\mesh.glb,
# which .agnes\agh-ortho\mesh-run.json declares as "output".
# ASCII only on purpose: PowerShell 5.1 mangles UTF-8 without BOM.
#
# Three deterministic steps (all three are declared in mesh-run.json, none is hidden in the plugin):
#   1. prep     crop to the alpha bounding box, composite on a gray 512 canvas (rembg would hang silently)
#   2. generate TripoSR run.py -> .glb, --no-remove-bg (we prepped the image ourselves)
#   3. bake     180 deg about the file's own Y axis, so the content is +X up WITHOUT any rotation op
#               (why: the imported object is QUATERNION mode, Blender ignores rotation_euler)
# The raw generator output is kept at <dir>\gen\0\mesh.glb so the bake stays auditable.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Root = 'D:\agnes-harness'
)
# NOT 'Stop': native children (python) log to stderr, and under 'Stop' PowerShell turns a stderr write
# into a terminating error even when merged with 2>&1. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
$py     = 'D:\triposr-venv\Scripts\python.exe'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$repo   = 'D:\cod\TripoSR'
$ckpt   = Join-Path $repo 'ckpt-stabilityai-TripoSR'
$prepPy = Join-Path $Root '.agnes\work\prep-triposr-input.py'
$bakeJs = Join-Path $Root '.agnes\work\bake-flip.mjs'

$env:TSR_DINO_CONFIG = Join-Path $repo 'ckpt-dino-vitb16\config.json'
$env:HF_ENDPOINT = 'https://hf-mirror.com'

if (-not (Test-Path $Image)) { Write-Host "FATAL image not found: $Image"; exit 2 }
if (-not (Test-Path $ckpt)) { Write-Host "FATAL weights not found: $ckpt"; exit 2 }
foreach ($exe in @($py, $nodeExe)) { if (-not (Test-Path $exe)) { Write-Host "FATAL missing: $exe"; exit 2 } }

# {out} comes from the tool as a workspace-relative path, so resolve it against -Root instead of
# trusting the child process's working directory.
$outAbs = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $Root $Out }
$prepDir = Join-Path $outAbs 'prep'
$genDir = Join-Path $outAbs 'gen'
$finalDir = Join-Path $outAbs 'final'
New-Item -ItemType Directory -Force -Path $prepDir, (Join-Path $genDir '0'), $finalDir | Out-Null

Write-Host "== 1/3 prep  ($Image)"
& $py $prepPy $prepDir $Image 2>&1 | Select-Object -Last 3
$prepped = Get-ChildItem $prepDir -Filter *_prep.png -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $prepped) { Write-Host 'FATAL prep produced no png'; exit 3 }

Write-Host "== 2/3 generate  (TripoSR)"
& $py (Join-Path $repo 'run.py') $prepped.FullName --output-dir $genDir --model-save-format glb --no-remove-bg --mc-resolution 256 --pretrained-model-name-or-path $ckpt 2>&1 | Select-Object -Last 12
if ($LASTEXITCODE -ne 0) { Write-Host "FATAL run.py exited $LASTEXITCODE"; exit $LASTEXITCODE }
$raw = Get-ChildItem $genDir -Recurse -Filter *.glb -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $raw) { Write-Host 'FATAL run.py wrote no glb'; exit 4 }

Write-Host "== 3/3 bake  (180 deg about the file's Y axis)"
& $nodeExe $bakeJs $raw.FullName (Join-Path $finalDir 'mesh.glb') 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Write-Host "FATAL bake exited $LASTEXITCODE"; exit $LASTEXITCODE }

Write-Host "== done"
Get-ChildItem $finalDir -Filter *.glb | Select-Object FullName, Length | Format-Table -AutoSize | Out-String -Width 200
exit 0
