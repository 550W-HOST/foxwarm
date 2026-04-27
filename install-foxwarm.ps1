# Foxwarm one-line installer for Windows PowerShell.
# Usage:
#   irm https://YOUR_DOMAIN/install-foxwarm.ps1 | iex
# Optional:
#   $env:FOXWARM_REPO='https://github.com/550W-HOST/foxwarm.git'
#   $env:FOXWARM_DIR="$HOME\foxwarm"
#   $env:FOXWARM_BRANCH='testing'

$ErrorActionPreference = 'Stop'

$Repo = if ($env:FOXWARM_REPO) { $env:FOXWARM_REPO } else { 'https://github.com/550W-HOST/foxwarm.git' }
if ($env:FOXWARM_DIR) {
  $Dir = $env:FOXWARM_DIR
} elseif ((Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name"\s*:\s*"foxwarm"')) {
  $Dir = (Get-Location).Path
} else {
  $Dir = Join-Path $HOME 'foxwarm'
}
if ($env:FOXWARM_BRANCH) {
  $Branch = $env:FOXWARM_BRANCH
} elseif (Test-Path (Join-Path $Dir '.git')) {
  $Branch = (git -C $Dir branch --show-current 2>$null)
  if (-not $Branch) { $Branch = 'main' }
} else {
  $Branch = 'main'
}
$HttpPort = if ($env:HTTP_PORT) { $env:HTTP_PORT } else { '3001' }

function Write-Step($Message) {
  Write-Host "[foxwarm-install] $Message" -ForegroundColor Cyan
}

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Hint"
  }
}

Require-Command git 'Install Git for Windows, then rerun this script: https://git-scm.com/download/win'
Require-Command npm 'Install Node.js 20+ (includes npm), then rerun this script: https://nodejs.org/'

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
New-Item -ItemType Directory -Force -Path 'state','agents','skills' | Out-Null

Write-Step 'Installing dependencies and building Foxwarm. This can take a few minutes.'
npm run build-all

Write-Step 'Starting Foxwarm in a new PowerShell window.'
$Command = "cd `"$Dir`"; node lib/index.js; Read-Host 'Foxwarm stopped. Press Enter to close this window'"
Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $Command)

$TokenFile = Join-Path $Dir 'state\token'
$Token = $null
for ($i = 0; $i -lt 40; $i++) {
  if (Test-Path $TokenFile) {
    $Token = (Get-Content $TokenFile -Raw).Trim()
    if ($Token) { break }
  }
  Start-Sleep -Milliseconds 500
}

Write-Host ''
if ($Token) {
  Write-Step "WebUI: http://localhost:$HttpPort/#token=$Token"
  Start-Process "http://localhost:$HttpPort/#token=$Token"
} else {
  Write-Warning "Token file is not ready yet. When startup finishes, read it at: $TokenFile"
  Write-Step "WebUI: http://localhost:$HttpPort/"
  Start-Process "http://localhost:$HttpPort/"
}

Write-Host 'Next: finish OOBE in the WebUI by configuring models and optional channels.'
