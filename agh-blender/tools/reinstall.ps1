<#
    agh-blender: reinstall the plugin into a running AGH.

    AGH loads an installed package from a content-addressed snapshot, so editing the
    source does NOT take effect on its own. This script walks the whole cycle:

        inspect -> (disable -> remove -> install) -> trust -> enable -> verify

    It reads the integrity and capabilityHash straight out of the daemon's operation
    log, so you never copy hashes by hand. The install part is skipped when the
    source already matches what is installed, so an unchanged re-run costs nothing
    and never asks for a confirmation.

    Three things this script deliberately tolerates:

      * disable and remove can fail with E_PACKAGE_SOURCE / E_PACKAGE_STATE when the
        previously recorded source was a relative file: path; install replaces it
        anyway. Their failures are reported, never fatal.
      * the install step stays interactive: AGH refuses to install unless a human
        answers the prompt (INV-33). Its output is NOT piped, because piping the
        child's stdout would make its isTTY check fail.
      * trust is re-run even when nothing changed; it is idempotent.

    Usage (from the repository root):
        powershell -ExecutionPolicy Bypass -File .\agh-blender\tools\reinstall.ps1

    Options:
        -Source       package source  (default: file:./agh-blender/package)
        -ProfileName  AGH profile     (default: local-dev)
        -DataDir      AGH data dir    (default: %USERPROFILE%\.agh\data)
        -ForceReinstall   install even when the source is unchanged
        -SkipVerify       skip the host audit summary

    ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as
    ANSI, which turns any non-ASCII text into mojibake. -ProfileName is spelled out
    rather than -Profile so it cannot shadow the $PROFILE automatic variable.
#>
[CmdletBinding()]
param(
    [string]$Source = 'file:./agh-blender/package',
    [string]$ProfileName = 'local-dev',
    [string]$DataDir = (Join-Path $env:USERPROFILE '.agh\data'),
    [switch]$ForceReinstall,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Continue'

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
Write-Note "profile $ProfileName"
Write-Note "home    $DataDir"
Write-Host ''

$results = @()

function Invoke-Cli([string]$label, [string[]]$cliArgs, [switch]$NoPipe) {
    if ($NoPipe) {
        & $nodeExe $cli @cliArgs --profile $ProfileName
    }
    else {
        & $nodeExe $cli @cliArgs --profile $ProfileName 2>&1 | ForEach-Object { Write-Host "     $_" }
    }
    $code = $LASTEXITCODE
    $script:results += [pscustomobject]@{ Step = $label; ExitCode = $code }
    return $code
}

function Get-InstalledRecord([string]$id) {
    # The last install record for this id, whatever its version: that is the copy currently
    # on disk, and its integrity is what a no-op check must compare against.
    try {
        $ops = Get-Content $opsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        Write-Bad "could not read $opsFile : $($_.Exception.Message)"
        return $null
    }
    $found = @()
    foreach ($op in $ops.operations) {
        $rec = $null
        if ($op.installed) { $rec = $op.installed }
        elseif ($op.operation -and $op.operation.installed) { $rec = $op.operation.installed }
        if ($rec -and $rec.id -eq $id) { $found += $rec }
    }
    if ($found.Count -eq 0) { return $null }
    return $found[$found.Count - 1]
}

Write-Step 'what the source would install (inspect)'
$sourceIntegrity = $null
$inspectOut = (& $nodeExe $cli package inspect $Source --profile $ProfileName 2>&1 | Out-String)
$inspectOut.Trim() -split "`n" | ForEach-Object { Write-Host "     $($_.Trim())" }
if ($inspectOut -match 'integrity\s+(sha256-[0-9a-f]{64})') { $sourceIntegrity = $Matches[1] }
if ($null -eq $sourceIntegrity) {
    Write-Bad 'could not read an integrity out of the inspect output'
    exit 1
}
$installedBefore = Get-InstalledRecord 'agh-blender'
$unchanged = $false
if ($installedBefore -and $installedBefore.integrity -eq $sourceIntegrity) { $unchanged = $true }

if ($unchanged -and -not $ForceReinstall) {
    Write-Ok 'the installed copy already matches this source - skipping disable/remove/install'
    Write-Note 'pass -ForceReinstall to install anyway'
    $record = $installedBefore
}
else {
    if ($installedBefore) {
        Write-Note "installed now: v$($installedBefore.version) $($installedBefore.integrity.Substring(0,20))..."
        Write-Note "source       : v$wanted $($sourceIntegrity.Substring(0,20))..."
    }
    else {
        Write-Note 'nothing installed for agh-blender yet'
    }

    Write-Step 'disable (expected to fail when the old source was a relative file: path)'
    Invoke-Cli 'disable' @('package', 'disable', 'agh-blender') | Out-Null

    Write-Step 'remove (depends on disable; not fatal)'
    Invoke-Cli 'remove' @('package', 'remove', 'agh-blender') | Out-Null

    Write-Step 'install  ->  answer y at the prompt'
    Invoke-Cli 'install' @('install', $Source) -NoPipe | Out-Null

    $record = Get-InstalledRecord 'agh-blender'
    if ($null -eq $record) {
        Write-Bad 'no install record for agh-blender - did the install step succeed?'
        Write-Host ''
        Write-Host 'Nothing else was run. Re-run after checking the install output above.' -ForegroundColor Red
        exit 1
    }
}

Write-Ok "installed: v$($record.version)"
Write-Ok "integrity      $($record.integrity)"
Write-Ok "capabilityHash $($record.capabilityHash)"
Write-Note 'a mismatched hash is refused, and that refusal never says which hash was wrong'

Write-Step 'trust'
Write-Note "agh package trust agh-blender $($record.integrity.Substring(0,14))... $($record.capabilityHash.Substring(0,14))... --profile $ProfileName"
Invoke-Cli 'trust' @('package', 'trust', 'agh-blender', $record.integrity, $record.capabilityHash) | Out-Null

Write-Step 'enable'
Invoke-Cli 'enable' @('package', 'enable', 'agh-blender') | Out-Null

Write-Step 'status'
Invoke-Cli 'status' @('package', 'status') | Out-Null

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
        $tools = @($lines | Select-String '"kind":"extension.registered"' | Select-String 'agh_blender_' | Select-Object -Last 9)
        if ($loaded.Count -gt 0) { Write-Ok "last loaded: $($loaded[0].Line.Substring(0, [Math]::Min(150, $loaded[0].Line.Length)))" }
        if ($failed.Count -gt 0) { Write-Bad "a later failure line exists: $($failed[0].Line.Substring(0, [Math]::Min(150, $failed[0].Line.Length)))" }
        Write-Note "agh_blender_* registration lines (last 9): $($tools.Count)"
    }
}

Write-Host ''
Write-Host 'exit codes' -ForegroundColor Cyan
foreach ($r in $results) {
    $color = if ($r.ExitCode -eq 0) { 'Green' } else { 'Yellow' }
    Write-Host ("  {0,-8} {1}" -f $r.Step, $r.ExitCode) -ForegroundColor $color
}
Write-Host ''
Write-Note 'A non-zero code on disable/remove is normal here; what matters is trust, enable,'
Write-Note 'and the loaded line above. Editing the source alone changes nothing until this runs.'
