<#
.SYNOPSIS
  Foxwarm Node Client bootstrap for Windows (PowerShell).

.DESCRIPTION
  Downloads, builds, and starts the Foxwarm node client.
  Runs synchronously in the foreground.

.EXAMPLE
  # First-time setup:
  irm https://master:3001/node/run.ps1 | iex
  # (then set params manually, or use the parameterized form below)

  .\run.ps1 -Host "http://master:3001" -Pairing "TOKEN" -NodeId "my-pc"

  # With stored credentials (subsequent runs):
  .\run.ps1 -Host "http://master:3001" -NodeId "my-pc"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$HostUrl,

    [string]$Pairing = "",

    [string]$NodeId = "node-$($env:COMPUTERNAME ?? 'foxwarm-node')",

    [string]$StateDir = ".\data",

    [string]$SourceDir = ".\foxwarm-node",

    [switch]$Interactive,

    [string]$AutoApprove = "",

    [int]$Timeout = 0,

    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host @"
Foxwarm Node Client Bootstrap (Windows)
========================================

Usage:
  .\run.ps1 -HostUrl http://master:3001 -Pairing TOKEN -NodeId my-pc
  .\run.ps1 -HostUrl http://master:3001 -NodeId my-pc -Interactive

Parameters:
  -HostUrl        Foxwarm master base URL (required)
  -Pairing        Pairing token for first-time setup
  -NodeId         Node name (default: node-<hostname>)
  -StateDir       Persistent data dir (default: .\data)
  -SourceDir      Source dir for node client (default: .\foxwarm-node)
  -Interactive    Run in interactive mode (confirm each tool call)
  -AutoApprove    Auto-approve tools matching regex (interactive mode)
  -Timeout        Auto-reject after N seconds (interactive mode)
  -Help           Show this help
"@
    exit 0
}

# ─── Validate prerequisites ───
foreach ($cmd in @("node", "npm")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "$cmd is required but not found in PATH"
        exit 1
    }
}

# ─── Normalize paths ───
$HostUrl = $HostUrl.TrimEnd("/")
$StateDir = [System.IO.Path]::GetFullPath($StateDir)
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)
$CredentialsFile = Join-Path $StateDir "state\node_credentials.json"

# ─── Create directories ───
foreach ($dir in @(
    (Join-Path $StateDir "state"),
    (Join-Path $StateDir "agents"),
    (Join-Path $StateDir "logs"),
    $SourceDir
)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# ─── Check credentials / pairing ───
if (-not $Pairing -and -not (Test-Path $CredentialsFile)) {
    Write-Error "Pairing token is required for first-time setup (no stored credentials at $CredentialsFile). Use -Pairing TOKEN"
    exit 1
}

# ─── Download source ───
$tarUrl = "$HostUrl/node/source.tar.gz"
$tarFile = Join-Path $SourceDir "source.tar.gz"

Write-Host "Downloading node source from $tarUrl ..."
Invoke-WebRequest -Uri $tarUrl -OutFile $tarFile -UseBasicParsing

Write-Host "Extracting source ..."
tar -xzf $tarFile -C $SourceDir
Remove-Item $tarFile -Force -ErrorAction SilentlyContinue

# ─── Install & build ───
Write-Host "Installing dependencies ..."
Push-Location $SourceDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Host "Building ..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

# ─── Determine entry point ───
if ($Interactive) {
    $entryPoint = Join-Path $SourceDir "lib\nodes\interactive-client.js"
} else {
    $entryPoint = Join-Path $SourceDir "lib\nodes\client.js"
}

if (-not (Test-Path $entryPoint)) {
    Write-Error "Entry point not found: $entryPoint"
    exit 1
}

# ─── Build arguments ───
$nodeArgs = @($entryPoint, "--host", $HostUrl, "--id", $NodeId, "--credentials-file", $CredentialsFile)

if ($Pairing) {
    $nodeArgs += @("--token", $Pairing)
}

if ($Interactive -and $AutoApprove) {
    $nodeArgs += @("--auto-approve", $AutoApprove)
}

if ($Interactive -and $Timeout -gt 0) {
    $nodeArgs += @("--timeout", $Timeout)
}

# ─── Print info ───
Write-Host ""
Write-Host "Starting node client ..."
Write-Host "  Mode:        $(if ($Interactive) { 'Interactive' } else { 'Background' })"
Write-Host "  Source:       $SourceDir"
Write-Host "  State:        $StateDir"
Write-Host "  Credentials:  $CredentialsFile"
Write-Host ""

if (-not $Pairing -or (Test-Path $CredentialsFile)) {
    Write-Host "Using stored credentials."
} else {
    Write-Host "First run - after startup, approve on master:"
    Write-Host "  /node pair list"
    Write-Host "  /node pair approve <pending-id> $NodeId"
}

Write-Host ""

# ─── Run synchronously ───
& node @nodeArgs
exit $LASTEXITCODE
