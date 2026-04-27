# Foxwarm one-line installer for Windows PowerShell.
# Usage:
#   irm https://YOUR_DOMAIN/install-foxwarm.ps1 | iex
param(
  [string]$InstallDir,
  [string]$DataDir,
  [string]$BranchName
)

# Optional:
#   $env:FOXWARM_REPO='https://github.com/550W-HOST/foxwarm.git'
#   $env:FOXWARM_DIR="$PWD\foxwarm"
#   $env:FOXWARM_DATA_DIR="$PWD\foxwarm-data"
#   $env:FOXWARM_BRANCH='main'
# If local script execution is blocked, run:
#   powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1

$ErrorActionPreference = 'Stop'

$Repo = if ($env:FOXWARM_REPO) { $env:FOXWARM_REPO } else { 'https://github.com/550W-HOST/foxwarm.git' }
$CallDir = (Get-Location).Path
if ($InstallDir) {
  $Dir = $InstallDir
} elseif ($env:FOXWARM_DIR) {
  $Dir = $env:FOXWARM_DIR
} elseif ((Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name"\s*:\s*"foxwarm"')) {
  $Dir = (Get-Location).Path
} else {
  $Dir = Join-Path (Get-Location).Path 'foxwarm'
}
$DataDir = if ($DataDir) { $DataDir } elseif ($env:FOXWARM_DATA_DIR) { $env:FOXWARM_DATA_DIR } else { Join-Path (Split-Path $Dir) 'foxwarm-data' }
$Dir = [System.IO.Path]::GetFullPath((Join-Path $CallDir $Dir))
$DataDir = [System.IO.Path]::GetFullPath((Join-Path $CallDir $DataDir))
if ($BranchName) {
  $Branch = $BranchName
} elseif ($env:FOXWARM_BRANCH) {
  $Branch = $env:FOXWARM_BRANCH
} elseif (Test-Path (Join-Path $Dir '.git')) {
  $Branch = (git -C $Dir branch --show-current 2>$null)
  if (-not $Branch) { $Branch = 'main' }
} else {
  $Branch = 'main'
}

function Write-Step($Message) {
  Write-Host "[foxwarm-install] $Message" -ForegroundColor Cyan
}

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Hint"
  }
}

function Require-Node20() {
  Require-Command node 'Install Node.js 20+ from https://nodejs.org/, then rerun this script.'
  Require-Command npm 'Install Node.js 20+ with npm from https://nodejs.org/, then rerun this script.'
  $majorText = node -p "process.versions.node.split('.')[0]"
  $major = [int]$majorText
  if ($major -lt 20) {
    $version = node -v
    throw "Node.js 20+ is required; found $version. Please upgrade Node.js and rerun this script."
  }
}

Require-Command git 'Install Git for Windows, then rerun this script: https://git-scm.com/download/win'
Require-Node20

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Step "Using existing checkout: $Dir"
  git -C $Dir fetch origin $Branch
  try {
    git -C $Dir checkout $Branch
    git -C $Dir pull --ff-only origin $Branch
  } catch {
    Write-Warning "Could not fast-forward existing checkout; continuing with local files unchanged. $_"
  }
} else {
  Write-Step "Cloning Foxwarm into $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  git clone --branch $Branch $Repo $Dir
}

Set-Location $Dir
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'state'),(Join-Path $DataDir 'agents') | Out-Null
Set-Content -Path (Join-Path $Dir 'data_dir') -Value $DataDir -NoNewline

Write-Step 'Installing dependencies and building Foxwarm. This can take a few minutes.'
npm run build-all

Write-Step 'Starting Foxwarm in a new PowerShell window.'
$Command = "cd `"$Dir`"; `$env:FOXWARM_DATA_DIR=`"$DataDir`"; node lib/index.js; Read-Host 'Foxwarm stopped. Press Enter to close this window'"
Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $Command)

$TokenFile = Join-Path $DataDir 'state\token'
$Token = $null
for ($i = 0; $i -lt 240; $i++) {
  if (Test-Path $TokenFile) {
    $Token = (Get-Content $TokenFile -Raw).Trim()
    if ($Token) { break }
  }
  if (($i -gt 0) -and ($i % 20 -eq 0)) {
    Write-Warning 'Still waiting for token. Check the Foxwarm PowerShell window for startup progress.'
  }
  Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Step "Program dir: $Dir"
Write-Step "Data dir: $DataDir"
$ConfigFile = Join-Path $DataDir 'state\config.yaml'
$HttpPort = '3001'
if (Test-Path $ConfigFile) {
  try {
    $portText = node -e "const fs=require('fs'); const yaml=require('js-yaml'); const cfg=yaml.load(fs.readFileSync(process.argv[1],'utf8'))||{}; console.log(cfg?.bot?.httpPort || 3001)" $ConfigFile
    if ($portText) { $HttpPort = $portText.Trim() }
  } catch {}
}
if ($Token) {
  Write-Step "WebUI: http://localhost:$HttpPort/#token=$Token"
  Start-Process "http://localhost:$HttpPort/#token=$Token"
} else {
  Write-Warning "Token file is not ready yet. When startup finishes, read it at: $TokenFile"
  Write-Step "WebUI: http://localhost:$HttpPort/"
  Start-Process "http://localhost:$HttpPort/"
}

Write-Host 'Next: finish OOBE in the WebUI by configuring models and optional channels.'
