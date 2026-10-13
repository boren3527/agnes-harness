# triposr-run.ps1 -- one-shot: build deps, weights, run two images, collect meshes.
# Run:  powershell -ExecutionPolicy Bypass -File D:\agnes-harness\agh-ortho\tools\cloud\triposr-run.ps1
# ASCII-only on purpose (PowerShell 5.1 mangles UTF-8 without BOM).
$ErrorActionPreference = 'Continue'
$repo = 'D:\cod\TripoSR'
$py   = 'D:\triposr-venv\Scripts\python.exe'
$out  = Join-Path $repo 'out-triposr'
$dest = 'D:\agnes-harness\.agnes\agh-ortho\meshes\kuson'
$log  = 'D:\agnes-harness\.agnes\work\triposr-run.log'

function Step($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }

# --- toolchain for compiling CUDA extensions ---
Step 'toolchain (vcvars + CUDA + arch)'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (Test-Path $vcvars) {
  cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path ("env:" + $matches[1]) -Value $matches[2] -ErrorAction SilentlyContinue }
  }
  Write-Host "vcvars imported"
} else { Write-Host "!! vcvars64.bat not found: $vcvars" -ForegroundColor Yellow }
$cuda = Get-ChildItem 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'v12.8' } | Select-Object -First 1
if ($cuda) { $env:CUDA_HOME = $cuda.FullName; $env:PATH = "$($cuda.FullName)\bin;$env:PATH"; Write-Host "CUDA_HOME=$env:CUDA_HOME" }
else { Write-Host '!! CUDA v12.8 not found' -ForegroundColor Yellow }
$env:TORCH_CUDA_ARCH_LIST = '12.0'
$env:FORCE_CUDA = '1'
$env:DISTUTILS_USE_SDK = '1'
# NOTE: no HTTP(S)_PROXY here on purpose. pip reaches PyPI directly on this machine, and going
# through the proxy makes pip fail with a TLS/"check your proxy" error. The HF download below
# adds the proxy only if the direct mirror route fails.
$env:HF_ENDPOINT = 'https://hf-mirror.com'

# --- verify the CPU marching-cubes fallback (no CUDA build needed) ---
Step 'marching cubes (PyMCubes, patched in)'
& $py -c "import mcubes; print('mcubes ok')"
if ($LASTEXITCODE -ne 0) { Write-Host '!! PyMCubes missing -> pip install PyMCubes' -ForegroundColor Yellow; & $py -m pip install -q PyMCubes }

# --- weights (~1.5 GB): curl straight from the mirror; the hub client refuses the mirror
#     ("missing commit header"), and a local dir makes run.py skip the hub entirely ---
Step 'weights (stabilityai/TripoSR -> local dir)'
$ckpt = 'D:\cod\TripoSR\ckpt-stabilityai-TripoSR'
if (-not (Test-Path $ckpt)) { New-Item -ItemType Directory -Force -Path $ckpt | Out-Null }
$base = 'https://hf-mirror.com/stabilityai/TripoSR/resolve/main/'
$files = @(@{ n = 'config.yaml'; min = 100 }, @{ n = 'model.ckpt'; min = 500MB })
foreach ($f in $files) {
  $target = Join-Path $ckpt $f.n
  if ((Test-Path $target) -and ((Get-Item $target).Length -ge $f.min)) { Write-Host "have $($f.n)"; continue }
  if (Test-Path $target) { Remove-Item $target -Force }   # a 0-byte leftover must not count as 'have'
  Write-Host "downloading $($f.n) ..."
  curl.exe -s -L -C - --retry 3 --retry-delay 3 --retry-all-errors -o "$target" "$base$($f.n)"
  if (-not ((Test-Path $target) -and ((Get-Item $target).Length -ge $f.min))) {
    Write-Host "direct failed -> retry through the proxy" -ForegroundColor Yellow
    curl.exe -s -L -C - --retry 3 --retry-delay 3 --retry-all-errors --proxy http://127.0.0.1:7897 -o "$target" "$base$($f.n)"
  }
}
Get-ChildItem $ckpt | Select-Object Name, @{n = 'MB'; e = { [Math]::Round($_.Length / 1MB, 3) } }

# --- DINO tokenizer config (a single small file; weights live in model.ckpt) ---
Step 'dino config (facebook/dino-vitb16/config.json)'
$dinoDir = 'D:\cod\TripoSR\ckpt-dino-vitb16'
if (-not (Test-Path $dinoDir)) { New-Item -ItemType Directory -Force -Path $dinoDir | Out-Null }
$dinoCfg = Join-Path $dinoDir 'config.json'
if (-not ((Test-Path $dinoCfg) -and ((Get-Item $dinoCfg).Length -gt 100))) {
  if (Test-Path $dinoCfg) { Remove-Item $dinoCfg -Force }
  curl.exe -s -L -C - --retry 3 --retry-all-errors -o "$dinoCfg" 'https://hf-mirror.com/facebook/dino-vitb16/resolve/main/config.json'
  if (-not ((Test-Path $dinoCfg) -and ((Get-Item $dinoCfg).Length -gt 100))) {
    Write-Host 'direct failed -> retry through the proxy' -ForegroundColor Yellow
    curl.exe -s -L -C - --retry 3 --retry-all-errors --proxy http://127.0.0.1:7897 -o "$dinoCfg" 'https://hf-mirror.com/facebook/dino-vitb16/resolve/main/config.json'
  }
}
Get-ChildItem $dinoDir | Select-Object Name, Length
$env:TSR_DINO_CONFIG = $dinoCfg
& $py 'D:\agnes-harness\.agnes\work\patch-triposr-dino.py' $repo

# --- run: prepare inputs ourselves (gray bg) and skip rembg, which hangs downloading u2net ---
Step 'inference (no rembg: inputs are pre-composited on gray)'
$prep = 'D:\cod\TripoSR\inputs'
$out = Join-Path $repo 'out-triposr'
# run.py saves into out\<index>\ and its own renderer crashed when that dir was missing;
# pre-create the per-image dirs and skip --render entirely (we render ourselves via the plugin).
New-Item -ItemType Directory -Force -Path (Join-Path $out '0'), (Join-Path $out '1') | Out-Null
$imgs = @((Join-Path $repo 'examples\police_woman.png'), 'D:\cod\StdGEN\input_cases\ayaka.png')
$existing = $imgs | Where-Object { Test-Path $_ }
Write-Host ("images: " + ($existing -join ' , '))
& $py 'D:\agnes-harness\.agnes\work\prep-triposr-input.py' $prep @existing 2>&1 | Select-Object -Last 4
$prepped = Get-ChildItem $prep -Filter *.png -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
Write-Host ("prepared: " + ($prepped -join ' , '))
& $py (Join-Path $repo 'run.py') @prepped --output-dir $out --model-save-format glb --no-remove-bg --mc-resolution 256 --pretrained-model-name-or-path $ckpt *>&1 |
  Tee-Object -FilePath $log | Select-Object -Last 25

# --- collect ---
Step 'collect meshes'
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
Get-ChildItem $out -Recurse -Include *.glb,*.obj,*.mtl,*.png -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'renders' } | ForEach-Object {
    # prefix with the per-image subdir (0_, 1_, ...) so two images cannot overwrite each other
    $target = Join-Path $dest ($_.Directory.Name + '_' + $_.Name)
    Copy-Item $_.FullName $target -Force
  }
Get-ChildItem $dest | Select-Object Name, Length
Write-Host "`nDONE. Contents of $dest listed above." -ForegroundColor Green
Write-Host "Log: $log"
