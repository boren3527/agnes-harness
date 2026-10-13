# cut-subject.ps1 -- the preprocess step for agh_ortho_mesh_run on THIS machine.
# Contract: -Image <photo> -Out <dir>; must leave exactly ONE image under <dir>\prep\.
#
# It only sets the model path and calls the python script: U2NET_PATH cannot be relied on
# from the host environment (the AGH process started long before we set it, and a variable
# that "happens to be set" is exactly the kind of hidden dependency this file exists to make
# explicit). The model is LOCAL - nothing is fetched at run time, which is what made the
# first rembg attempt hang silently.
#
# ASCII only on purpose: PowerShell 5.1 mangles UTF-8 without BOM.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Continue'
$py    = 'D:\triposr-venv\Scripts\python.exe'
$model = Join-Path $env:USERPROFILE '.u2net\u2netp.onnx'
$script = 'D:\agnes-harness\.agnes\work\cut-onnx.py'

if (-not (Test-Path $Image)) { Write-Host "FATAL image not found: $Image"; exit 2 }
if (-not (Test-Path $model)) { Write-Host "FATAL model not found: $model (download it once; nothing is fetched at run time)"; exit 2 }

$env:U2NET_PATH = $model
& $py $script $Image $Out
if ($LASTEXITCODE -ne 0) { Write-Host "FATAL cut-onnx.py exited $LASTEXITCODE"; exit $LASTEXITCODE }
exit 0
