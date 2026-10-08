<#
    agh-blender: reinstall the plugin into a running AGH.

    AGH loads an installed package from a content-addressed snapshot, so editing the
    source does NOT take effect on its own. This script walks the whole cycle:

        disable -> remove -> install -> trust -> enable -> verify

    It reads the integrity and capabilityHash straight out of the daemon's operation
    log, so you never copy hashes by hand.

    The install step stays interactive on purpose: AGH refuses to install unless a
    human answers the prompt, and that invariant is worth keeping.

    Usage (from the repository root):
        powershell -ExecutionPolicy Bypass -File .\agh-blender\tools\reinstall.ps1

    Options:
        -Source   package source (default: file:./agh-blender/package)
        -Profile  AGH profile    (default: local-dev)
        -DataDir  AGH data dir   (default: %USERPROFILE%\.agh\data)
        -SkipVerify   do not print the host audit summary

    ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as
    ANSI, which turns any non-ASCII text into mojibake.
#>
[CmdletBinding()]
param(
    [string]$Source = 'file:./agh-blender/package',
    [string]$Profile = 'local-dev',
    [string]$DataDir = (Join-Path $env:USERPROFILE '.agh\data'),
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host "--- $text ---" -ForegroundColor Gray }
function Write-Ok([string]$text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Bad([string]$text) { Write-Host "  !!   $text" -ForegroundColor Red }
function Write-Note([string]$text) { Write-Host "  ..   $text" -ForegroundColor DarkGray }

# Repository root: this script lives at <repo>/agh-blender/tools/reinstall.ps1
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cli = Join-Path $repoRoot 'packages\cli\dist\local\agnes.mjs'
$pkgJson = Join-Path $repoRoot 'agh-blender\package\package.json'

if (-not (Test-Path $cli)) {
    Write-Bad "CLI launcher not found: $cli"
    Write-Host '       Build it first:  pnpm --filter @agnes/cli build:local'
    exit 1
}
if (-not (Test-Path $pkgJson)) {
    Write-Bad "package manifest not found: $pkgJson"
    exit 1
}

$nodeExe = @(Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty Source)
if (-not $nodeExe) { $nodeExe = 'node.exe' }

$opsFile = Join-Path $DataDir 'daemon\package-operations\operations.json'
if (-not (Test-Path $opsFile)) {
    Write-Bad "no operation log at $opsFile"
    Write-Host '       Is the AGH daemon running on this home? Start it first, then re-run.'
    exit 1
}

$wanted = (Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version

# A 'file:' source is resolved against the current directory, so make sure we are at the
# repository root no matter where the caller was standing.
Set-Location -LiteralPath $repoRoot

Write-Host "agh-blender $wanted" -ForegroundColor Cyan
Write-Note "source  $Source"
Write-Note "profile $Profile"
Write-Note "home    $DataDir"
Write-Host ''

function Invoke-Cli([string[]]$cliArgs) {
    & $nodeExe $cli @cliArgs --profile $Profile
}

Write-Step 'disable (harmless if it was not installed)'
try { Invoke-Cli @('package', 'disable', 'agh-blender') | Out-Host } catch { Write-Note $_.Exception.Message }

Write-Step 'remove (harmless if it was not installed)'
try { Invoke-Cli @('package', 'remove', 'agh-blender') | Out-Host } catch { Write-Note $_.Exception.Message }

Write-Step 'install  ->  answer y at the prompt'
Invoke-Cli @('install', $Source) | Out-Host

Write-Step "read integrity / capabilityHash for agh-blender $wanted"
$ops = Get-Content $opsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$installed = @()
foreach ($op in $ops.operations) {
    $rec = $null
    if ($op.installed) { $rec = $op.installed }
    elseif ($op.operation -and $op.operation.installed) { $rec = $op.operation.installed }
    if ($rec -and $rec.id -eq 'agh-blender' -and $rec.version -eq $wanted) { $installed += $rec }
}
if ($installed.Count -eq 0) {
    Write-Bad "no install record for agh-blender $wanted - did the install step succeed?"
    exit 1
}
$record = $installed[$installed.Count - 1]
Write-Ok "integrity      $($record.integrity)"
Write-Ok "capabilityHash $($record.capabilityHash)"
Write-Note 'this is the real pair: a mismatched hash is refused, and the refusal message says nothing about why'

Write-Step 'trust'
Invoke-Cli @('package', 'trust', 'agh-blender', $record.integrity, $record.capabilityHash) | Out-Host

Write-Step 'enable'
Invoke-Cli @('package', 'enable', 'agh-blender') | Out-Host

Write-Step 'status'
Invoke-Cli @('package', 'status') | Out-Host

if (-not $SkipVerify) {
    Write-Step 'what the host actually loaded'
    $audit = Join-Path $DataDir 'audit\host.jsonl'
    if (-not (Test-Path $audit)) {
        Write-Note "no host audit at $audit"
    }
    else {
        $lines = Get-Content $audit -Encoding UTF8
        $loaded = @($lines | Select-String '"kind":"extension.loaded"' | Select-Object -Last 1)
        $failed = @($lines | Select-String '"kind":"extension.failed"' | Select-Object -Last 1)
        $tools = @($lines | Select-String '"kind":"extension.registered"' | Select-String 'agh_blender_')
        if ($loaded.Count -gt 0) { Write-Ok "last loaded: $($loaded[0].Line.Substring(0, [Math]::Min(170, $loaded[0].Line.Length)))" }
        if ($failed.Count -gt 0) { Write-Bad "there is a later failure line: $($failed[0].Line.Substring(0, [Math]::Min(170, $failed[0].Line.Length)))" }
        Write-Note "agh_blender_* registration lines in the audit: $($tools.Count)  (9 tools exist; the count grows as you reinstall)"
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Note 'Reminders: a batch of ops is one undo step; /shutdown refuses a dirty scene;'
Write-Note 'tool results never carry an image block; the plugin is loaded from a snapshot,'
Write-Note 'which is why editing the source alone changes nothing until this script runs.'
