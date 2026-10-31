# Foxwarm one-line installer for Windows PowerShell.
# Usage:
#   irm https://foxwarm.net/install-foxwarm.ps1 | iex
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
function Resolve-InstallerPath($Value, $BaseDir) {
  if ($Value -eq '~') {
    $Value = $HOME
  } elseif ($Value.StartsWith('~/')) {
    $Value = Join-Path $HOME $Value.Substring(2)
  }
  if (-not [System.IO.Path]::IsPathRooted($Value)) {
    $Value = Join-Path $BaseDir $Value
  }
  return [System.IO.Path]::GetFullPath($Value)
}

$Dir = Resolve-InstallerPath $Dir $CallDir
if ($DataDir) {
  $DataDir = Resolve-InstallerPath $DataDir $CallDir
} elseif ($env:FOXWARM_DATA_DIR) {
  $DataDir = Resolve-InstallerPath $env:FOXWARM_DATA_DIR $CallDir
} else {
  $Pointer = Join-Path $Dir 'data_dir'
  $SavedDataDir = if (Test-Path $Pointer) { ([string](Get-Content $Pointer -Raw)).Trim() } else { '' }
  if ($SavedDataDir) {
    $DataDir = Resolve-InstallerPath $SavedDataDir $Dir
  } elseif (Test-Path (Join-Path $Dir '.git')) {
    $DataDir = $Dir
  } else {
    $DataDir = Join-Path (Split-Path $Dir) 'foxwarm-data'
  }
}
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

function Require-BuildNode() {
  Require-Command node 'Install Node.js 20.19+ (20.x) or 22.12+ from https://nodejs.org/, then rerun this script.'
  Require-Command npm 'Install Node.js 20.19+ (20.x) or 22.12+ with npm from https://nodejs.org/, then rerun this script.'
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)"
  if ($LASTEXITCODE -ne 0) {
    $version = node -v
    throw "Node.js 20.19+ (20.x) or 22.12+ is required; found $version. Please upgrade Node.js and rerun this script."
  }
}

function Require-ManagedBuild() {
  Require-Command dotnet 'Install a net10.0-capable .NET SDK and the ASP.NET Core 10 runtime, then rerun this script.'
  $sdk = & dotnet --version
  if ($LASTEXITCODE -ne 0 -or $sdk -notmatch '^(\d+)\.' -or [int]$Matches[1] -lt 10) {
    throw "A net10.0-capable .NET SDK is required; selected: $sdk"
  }
  $runtimes = & dotnet --list-runtimes
  if ($LASTEXITCODE -ne 0 -or -not ($runtimes -match '^Microsoft.AspNetCore.App 10\.')) {
    throw 'The ASP.NET Core 10 runtime is required to run managed Main.'
  }
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'This managed Main source candidate requires Windows x64.'
  }
}

Require-Command git 'Install Git for Windows, then rerun this script: https://git-scm.com/download/win'
Require-BuildNode
Require-ManagedBuild

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
$env:FOXWARM_DATA_DIR = $DataDir

node scripts/windowsService.js check-stopped
if ($LASTEXITCODE -ne 0) {
  throw 'Foxwarm must be stopped before dependency installation. Run npm run stop:windows, then rerun this installer.'
}

if (-not (Test-Path 'dotnet/Foxwarm/obj/monty-0.0.19/win-x64/bin/monty.exe')) {
  Require-Command python 'Python 3 is required to acquire the pinned Monty worker on a fresh source build.'
  & python -c "import sys; sys.exit(0 if sys.version_info.major == 3 else 1)"
  if ($LASTEXITCODE -ne 0) { throw 'Python 3 is required for the pinned native worker acquisition.' }
}

Write-Step 'Installing dependencies and building Foxwarm. This can take a few minutes.'
npm run build-all
if ($LASTEXITCODE -ne 0) {
  throw 'Foxwarm dependency installation or build failed.'
}

Write-Step 'Starting Foxwarm in the background.'
node scripts/windowsService.js start
if ($LASTEXITCODE -ne 0) {
  throw 'Foxwarm failed to start. Check the log paths printed above.'
}

$TokenFile = Join-Path $DataDir 'state\token'
$Token = $null
for ($i = 0; $i -lt 240; $i++) {
  if (Test-Path $TokenFile) {
    $Token = (Get-Content $TokenFile -Raw).Trim()
    if ($Token) { break }
  }
  if (($i -gt 0) -and ($i % 20 -eq 0)) {
    Write-Warning 'Still waiting for token. Check the Foxwarm logs for startup progress.'
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
