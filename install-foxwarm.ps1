# Install a prebuilt Foxwarm release on Windows x64 and start it.
#   irm https://foxwarm.net/install-foxwarm.ps1 | iex
# To choose options, download the script first:
#   .\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data [-Version 0.9.0]
#     [-SelfContained | -FrameworkDependent] [-Package FILE] [-NoStart]
# If local script execution is blocked, run:
#   powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
param(
  [string]$InstallDir,
  [string]$DataDir,
  [string]$Version,
  [string]$Package,
  [switch]$SelfContained,
  [switch]$FrameworkDependent,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Releases = 'https://github.com/550W-HOST/foxwarm/releases'
$CallDir = (Get-Location).Path

function Write-Step($Message) { Write-Host "[foxwarm-install] $Message" -ForegroundColor Cyan }

# The installation's control script runs through foxwarmctl.cmd, which starts PowerShell with
# -ExecutionPolicy Bypass for that script only, so a Restricted or AllSigned policy does not stop it.
function Invoke-Control($Arguments) {
  # Show the script's output instead of returning it with the exit code.
  & (Join-Path $Dir 'foxwarmctl.cmd') @Arguments | Out-Host
  return $LASTEXITCODE
}

function Start-Control {
  if ((Invoke-Control @('start')) -ne 0) {
    throw "Foxwarm is installed in $Dir but did not start. Fix the problem described above, then run: & '$Dir\foxwarmctl.cmd' start"
  }
}

function Show-SignIn($DataRoot) {
  $TokenFile = Join-Path $DataRoot 'state\token'
  $Token = $null
  for ($i = 0; $i -lt 120; $i++) {
    if (Test-Path $TokenFile) {
      $Token = ([string](Get-Content $TokenFile -Raw)).Trim()
      if ($Token) { break }
    }
    Start-Sleep -Milliseconds 500
  }
  $Port = 3001
  $Config = Join-Path $DataRoot 'state\config.yaml'
  if (Test-Path $Config) {
    $match = Select-String -Path $Config -Pattern '^\s*httpPort:\s*(\d+)' | Select-Object -First 1
    if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value }
  }
  Write-Host ''
  Write-Step "Program dir: $Dir"
  Write-Step "Data dir: $DataRoot"
  if ($Token) {
    $Url = "http://localhost:$Port/#token=$Token"
    Write-Step "WebUI: $Url"
    try { Start-Process $Url } catch { }
  } else {
    Write-Warning "The sign-in token is not ready yet. When startup finishes, read $TokenFile"
    Write-Step "WebUI: http://localhost:$Port/"
  }
  Write-Step "Control: & '$Dir\foxwarmctl.cmd' status | stop | restart | update"
}

function Resolve-InstallerPath($Value, $BaseDir) {
  if ($Value -eq '~') { $Value = $HOME } elseif ($Value.StartsWith('~/')) { $Value = Join-Path $HOME $Value.Substring(2) }
  if (-not [System.IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $BaseDir $Value }
  return [System.IO.Path]::GetFullPath($Value)
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Foxwarm release packages require Windows x64.' }
if ($SelfContained -and $FrameworkDependent) { throw 'Choose either -SelfContained or -FrameworkDependent.' }

$Dir = if ($InstallDir) { $InstallDir } elseif ($env:FOXWARM_DIR) { $env:FOXWARM_DIR } else { 'foxwarm' }
$Dir = Resolve-InstallerPath $Dir $CallDir
if ($Package) { $Package = Resolve-InstallerPath $Package $CallDir }
if (Test-Path (Join-Path $Dir '.git')) {
  throw "$Dir is a source checkout. Update it from source, or choose another -InstallDir and pass -DataDir to reuse its data."
}
$RequestedData = if ($DataDir) { $DataDir } elseif ($env:FOXWARM_DATA_DIR) { $env:FOXWARM_DATA_DIR } else { $null }
$Pointer = Join-Path $Dir 'data_dir'
$Saved = if (Test-Path $Pointer) { ([string](Get-Content $Pointer -Raw)).Trim() } else { '' }

if (Test-Path (Join-Path $Dir 'runtime\current\release.json')) {
  if ($RequestedData -and (-not $Saved -or (Resolve-InstallerPath $RequestedData $CallDir) -ne (Resolve-InstallerPath $Saved $Dir))) {
    throw "$Dir already uses the data directory in its data_dir file. Stop Foxwarm and edit that file to change it."
  }
  Write-Step "Foxwarm is already installed in $Dir; updating it."
  $update = @('update')
  if ($Version) { $update += $Version }
  if ($Package) { $update += @('-Package', $Package) }
  if ((Invoke-Control $update) -ne 0) { throw "Updating Foxwarm in $Dir failed; see the message above." }
  if (-not $NoStart) {
    if ((Invoke-Control @('status')) -ne 0) { Start-Control }
    Show-SignIn $(if ($Saved) { Resolve-InstallerPath $Saved $Dir } else { $Dir })
  }
  return
}

$Data = if ($RequestedData) { Resolve-InstallerPath $RequestedData $CallDir }
  elseif ($Saved) { Resolve-InstallerPath $Saved $Dir }
  else { Join-Path (Split-Path $Dir) 'foxwarm-data' }

$Asset = 'foxwarm-win-x64.zip'
if (-not $Package) {
  $useSelfContained = $SelfContained
  if (-not $SelfContained -and -not $FrameworkDependent) {
    $runtimes = if (Get-Command dotnet -ErrorAction SilentlyContinue) { & dotnet --list-runtimes 2>$null } else { @() }
    $useSelfContained = -not ($runtimes -match '^Microsoft.AspNetCore.App 10\.')
    if ($useSelfContained) { Write-Step 'No ASP.NET Core 10 runtime found; using the self-contained package.' }
    else { Write-Step 'Found the ASP.NET Core 10 runtime; using the framework-dependent package.' }
  }
  if ($useSelfContained) { $Asset = 'foxwarm-win-x64-self-contained.zip' }
}

$RuntimeDir = Join-Path $Dir 'runtime'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$Scratch = Join-Path $RuntimeDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $Scratch | Out-Null
try {
  if (-not $Package) {
    $base = if ($Version) { "$Releases/download/v$($Version.TrimStart('v'))" } else { "$Releases/latest/download" }
    Write-Step "Downloading $Asset"
    $Package = Join-Path $Scratch $Asset
    Invoke-WebRequest "$base/$Asset" -OutFile $Package -UseBasicParsing
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $Scratch 'SHA256SUMS') -UseBasicParsing
    $expected = Get-Content (Join-Path $Scratch 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($Asset))$" } | ForEach-Object { $Matches[1] }
    if (-not $expected -or (Get-FileHash $Package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
      throw "Checksum verification failed for $Asset."
    }
  }
  $extract = Join-Path $Scratch 'extract'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Package, $extract)
  $staging = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $staging -or -not (Test-Path (Join-Path $staging.FullName 'Foxwarm.exe')) -or -not (Test-Path (Join-Path $staging.FullName 'foxwarmctl.ps1'))) {
    throw "$Package is not a Foxwarm Windows server package."
  }
  $release = (Get-Content (Join-Path $staging.FullName 'release.json') -Raw | ConvertFrom-Json).version

  New-Item -ItemType Directory -Force -Path (Join-Path $Data 'state'), (Join-Path $Data 'agents') | Out-Null
  $Data = (Resolve-Path $Data).Path
  Set-Content -Path $Pointer -Value $Data -NoNewline
  $env:FOXWARM_DATA_DIR = $Data
  Write-Step "Checking existing data in $Data"
  if ((Get-Content (Join-Path $staging.FullName 'release.json') -Raw | ConvertFrom-Json).selfContained) {
    & (Join-Path $staging.FullName 'Foxwarm.exe') --installation-root $Dir --inspect-upgrade
  } else {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'This package needs the ASP.NET Core 10 runtime and dotnet on PATH; use -SelfContained otherwise.' }
    & dotnet (Join-Path $staging.FullName 'Foxwarm.dll') --installation-root $Dir --inspect-upgrade
  }
  if ($LASTEXITCODE -ne 0) { throw 'Upgrade inspection found a blocking problem; nothing was installed.' }
  $target = Join-Path $RuntimeDir $release
  Move-Item $staging.FullName $target
  New-Item -ItemType Junction -Path (Join-Path $RuntimeDir 'current') -Target $target | Out-Null
  foreach ($file in 'foxwarmctl.ps1', 'foxwarmctl.cmd') { Copy-Item (Join-Path $target $file) (Join-Path $Dir $file) -Force }
  Write-Step "Installed Foxwarm $release in $Dir"
} finally {
  Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoStart) {
  Write-Step "Start it with: & '$Dir\foxwarmctl.cmd' start"
  return
}
Start-Control
Show-SignIn $Data
