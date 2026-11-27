# Install a prebuilt Foxwarm release on Windows x64 and start it.
#   irm https://foxwarm.net/install-foxwarm.ps1 | iex
# To choose options, download the script first:
#   .\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data [-Version 0.9.0]
#     [-Native | -FrameworkDependent] [-Package FILE] [-NoStart]
# A new installation uses the native package, which needs no .NET, unless -FrameworkDependent
# chooses the package that uses the installed ASP.NET Core 10 runtime. Choosing a package for an
# existing installation, or passing a package file of another type, switches it to that package
# and keeps its data.
# If local script execution is blocked, run:
#   powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
param(
  [string]$InstallDir,
  [string]$DataDir,
  [string]$Version,
  [string]$Package,
  [switch]$Native,
  [switch]$FrameworkDependent,
  # Retired: the native package replaced the self-contained one in 0.9.6.
  [switch]$SelfContained,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Releases = 'https://github.com/550W-HOST/foxwarm/releases'
$CallDir = (Get-Location).Path

function Write-Step($Message) { Write-Host "[foxwarm-install] $Message" -ForegroundColor Cyan }

$Utf8 = New-Object System.Text.UTF8Encoding($false)
$NativeAsset = 'foxwarm-win-x64-native.zip'
$FrameworkAsset = 'foxwarm-win-x64.zip'
# The native package replaced the self-contained one, which also needed no .NET.
$RetiredAsset = 'foxwarm-win-x64-self-contained.zip'

# Download a release file; a release that does not publish it fails with that message.
function Get-ReleaseFile($Url, $OutFile) {
  try { Invoke-WebRequest $Url -OutFile $OutFile -UseBasicParsing }
  catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 404) {
      $release = if ($Version) { "Release $($Version.TrimStart('v'))" } else { 'The latest release' }
      throw "$release has no $(Split-Path $Url -Leaf)."
    }
    throw
  }
}

# Download a package and its SHA256SUMS line into $Directory and verify it.
function Get-VerifiedPackage($Asset, $Directory) {
  $base = if ($Version) { "$Releases/download/v$($Version.TrimStart('v'))" } else { "$Releases/latest/download" }
  Write-Step "Downloading $Asset"
  $file = Join-Path $Directory $Asset
  Get-ReleaseFile "$base/$Asset" $file
  Get-ReleaseFile "$base/SHA256SUMS" (Join-Path $Directory 'SHA256SUMS')
  $expected = Get-Content (Join-Path $Directory 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($Asset))$" } | ForEach-Object { $Matches[1] }
  if (-not $expected -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw "Checksum verification failed for $Asset."
  }
  return $file
}

# The asset name recorded in a package archive's release.json.
function Get-PackageAsset($File) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($File)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -match '^[^/\\]+[/\\]release\.json$' } | Select-Object -First 1
    if (-not $entry) { throw "$File is not a Foxwarm Windows server package." }
    $reader = New-Object System.IO.StreamReader($entry.Open(), $Utf8)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json).asset } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}

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

# The scalar value of bot.$Key in config.yaml, the setting Main reads: a key directly under the
# top-level bot mapping, without quotes or a trailing comment. Keys elsewhere, at the top level
# or nested deeper, are not Main's setting. foxwarmctl.ps1 reads it the same way.
function Get-BotSetting($DataRoot, $Key) {
  $config = Join-Path $DataRoot 'state\config.yaml'
  if (-not (Test-Path -LiteralPath $config)) { return $null }
  $inBot = $false
  $indent = $null
  foreach ($line in [System.IO.File]::ReadAllLines($config)) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\S') { $inBot = $line -match '^bot:\s*(#.*)?$'; $indent = $null; continue }
    if (-not $inBot -or $line -notmatch '^( +)(.*)$') { continue }
    $lead = $Matches[1]
    $rest = $Matches[2]
    if ($null -eq $indent) { $indent = $lead }
    if ($lead -ne $indent) { continue }
    if ($rest -match ('^' + [regex]::Escape($Key) + ':(?:\s+(.*))?$')) {
      $value = ($Matches[1] -replace '\s+#.*$', '').Trim()
      if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
      return $value
    }
  }
  return $null
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
  $Port = Get-BotSetting $DataRoot 'httpPort'
  if ($Port -notmatch '^\d+$') { $Port = 3001 }
  # A specific bot.httpHost is the only address Main answers on.
  $listen = Get-BotSetting $DataRoot 'httpHost'
  $HostName = if (-not $listen -or $listen -in '0.0.0.0', '::') { 'localhost' } elseif ($listen.Contains(':')) { "[$listen]" } else { $listen }
  Write-Host ''
  Write-Step "Program dir: $Dir"
  Write-Step "Data dir: $DataRoot"
  if ($Token) {
    $Url = "http://${HostName}:$Port/#token=$Token"
    Write-Step "WebUI: $Url"
    try { Start-Process $Url } catch { }
  } else {
    Write-Warning "The sign-in token is not ready yet. When startup finishes, read $TokenFile"
    Write-Step "WebUI: http://${HostName}:$Port/"
  }
  if ($Loopback) { Write-LoopbackHint $DataRoot }
  # Older releases have no link command.
  $verbs = 'status | stop | restart | update'
  if (Select-String -LiteralPath (Join-Path $Dir 'foxwarmctl.ps1') -Pattern '^\s*''link''' -Quiet) { $verbs += ' | link' }
  Write-Step "Control: & '$Dir\foxwarmctl.cmd' $verbs"
}

# A new installation listens on this computer only. An existing installation, or data that Main
# has already used, keeps its binding: config.yaml is never replaced.
$Loopback = $false
function Write-LoopbackHint($DataRoot) {
  Write-Step "Only this computer can connect. To allow other devices, set bot.httpHost to 0.0.0.0 in '$(Join-Path $DataRoot 'state\config.yaml')' and run: & '$Dir\foxwarmctl.cmd' restart"
}

function Resolve-InstallerPath($Value, $BaseDir) {
  if ($Value -eq '~') { $Value = $HOME } elseif ($Value.StartsWith('~/')) { $Value = Join-Path $HOME $Value.Substring(2) }
  if (-not [System.IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $BaseDir $Value }
  return [System.IO.Path]::GetFullPath($Value)
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Foxwarm release packages require Windows x64.' }
if ($SelfContained) {
  Write-Step 'Self-contained packages were replaced by the native package; using it.'
  $Native = $true
}
if ($Native -and $FrameworkDependent) { throw 'Choose either -Native or -FrameworkDependent.' }

$Dir = if ($InstallDir) { $InstallDir } elseif ($env:FOXWARM_DIR) { $env:FOXWARM_DIR } else { 'foxwarm' }
$Dir = Resolve-InstallerPath $Dir $CallDir
if ($Package) { $Package = Resolve-InstallerPath $Package $CallDir }
if (Test-Path (Join-Path $Dir '.git')) {
  throw "$Dir is a source checkout. Update it from source, or choose another -InstallDir and pass -DataDir to reuse its data."
}
$RequestedData = if ($DataDir) { $DataDir } elseif ($env:FOXWARM_DATA_DIR) { $env:FOXWARM_DATA_DIR } else { $null }
$Pointer = Join-Path $Dir 'data_dir'
# Main reads this file as UTF-8; Windows PowerShell's default encoding would corrupt non-ASCII paths.
$Saved = if (Test-Path -LiteralPath $Pointer) { ([string](Get-Content -LiteralPath $Pointer -Raw -Encoding UTF8)).Trim() } else { '' }

if (Test-Path (Join-Path $Dir 'runtime\current\release.json')) {
  if ($RequestedData -and (-not $Saved -or (Resolve-InstallerPath $RequestedData $CallDir) -ne (Resolve-InstallerPath $Saved $Dir))) {
    throw "$Dir already uses the data directory in its data_dir file. Stop Foxwarm and edit that file to change it."
  }
  Write-Step "Foxwarm is already installed in $Dir; updating it."
  $installed = (Get-Content (Join-Path $Dir 'runtime\current\release.json') -Raw -Encoding UTF8 | ConvertFrom-Json).asset
  $wanted = $installed
  if ($Native) { $wanted = $NativeAsset }
  elseif ($FrameworkDependent) { $wanted = $FrameworkAsset }
  elseif ($Package) { $wanted = Get-PackageAsset $Package }  # a package file of another type is a choice of that package
  elseif ($installed -eq $RetiredAsset) { $wanted = $NativeAsset }
  $update = @('update')
  if ($Version) { $update += $Version }
  $Scratch = $null
  try {
    if ($wanted -ne $installed) {
      # The installed control script updates within its own package type, so this switch
      # downloads the chosen package here and hands it over as a file. -Force also switches
      # between packages of the same version.
      Write-Step "Switching $Dir from $installed to $wanted."
      $update += '-Force'
      if (-not $Package) {
        $Scratch = Join-Path $Dir ('runtime\.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
        New-Item -ItemType Directory -Path $Scratch | Out-Null
        $Package = Get-VerifiedPackage $wanted $Scratch
      }
    }
    if ($Package) { $update += @('-Package', $Package) }
    if ((Invoke-Control $update) -ne 0) { throw "Updating Foxwarm in $Dir failed; see the message above." }
  } finally {
    if ($Scratch) { Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if (-not $NoStart) {
    if ((Invoke-Control @('status')) -ne 0) { Start-Control }
    Show-SignIn $(if ($Saved) { Resolve-InstallerPath $Saved $Dir } else { $Dir })
  }
  return
}

$Data = if ($RequestedData) { Resolve-InstallerPath $RequestedData $CallDir }
  elseif ($Saved) { Resolve-InstallerPath $Saved $Dir }
  else { Join-Path (Split-Path $Dir) 'foxwarm-data' }

$Asset = if ($FrameworkDependent) { $FrameworkAsset } else { $NativeAsset }
if (-not $Package -and -not $Native -and -not $FrameworkDependent) { Write-Step 'Using the native package, which needs no .NET runtime.' }

$RuntimeDir = Join-Path $Dir 'runtime'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$Scratch = Join-Path $RuntimeDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $Scratch | Out-Null
try {
  if (-not $Package) { $Package = Get-VerifiedPackage $Asset $Scratch }
  $extract = Join-Path $Scratch 'extract'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Package, $extract)
  $staging = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $staging -or -not (Test-Path (Join-Path $staging.FullName 'Foxwarm.exe')) -or -not (Test-Path (Join-Path $staging.FullName 'foxwarmctl.ps1'))) {
    throw "$Package is not a Foxwarm Windows server package."
  }
  $manifest = Get-Content (Join-Path $staging.FullName 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.rid -ne 'win-x64') { throw "$Package is for $($manifest.rid), not win-x64." }
  $release = $manifest.version

  # Main creates the token when it first serves HTTP, so data without a token and without a
  # config.yaml belongs to no installation yet.
  $Loopback = -not (Test-Path -LiteralPath (Join-Path $Data 'state\config.yaml')) -and -not (Test-Path -LiteralPath (Join-Path $Data 'state\token'))
  New-Item -ItemType Directory -Force -Path (Join-Path $Data 'state'), (Join-Path $Data 'agents') | Out-Null
  $Data = (Resolve-Path $Data).Path
  [System.IO.File]::WriteAllText($Pointer, $Data, $Utf8)
  $env:FOXWARM_DATA_DIR = $Data
  Write-Step "Checking existing data in $Data"
  if ($manifest.selfContained) {
    & (Join-Path $staging.FullName 'Foxwarm.exe') --installation-root $Dir --inspect-upgrade
  } else {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'This package needs the ASP.NET Core 10 runtime and dotnet on PATH; use the native package (-Native) otherwise.' }
    & dotnet (Join-Path $staging.FullName 'Foxwarm.dll') --installation-root $Dir --inspect-upgrade
  }
  if ($LASTEXITCODE -ne 0) { throw 'Upgrade inspection found a blocking problem; nothing was installed.' }
  $target = Join-Path $RuntimeDir $release
  # As in the control script: another process can briefly hold a file of the release that was
  # just extracted and run for inspection.
  for ($attempt = 1; ; $attempt++) {
    try { Move-Item -LiteralPath $staging.FullName -Destination $target; break }
    catch { if ($attempt -ge 20) { throw } }
    Start-Sleep -Milliseconds 250
  }
  New-Item -ItemType Junction -Path (Join-Path $RuntimeDir 'current') -Target $target | Out-Null
  foreach ($file in 'foxwarmctl.ps1', 'foxwarmctl.cmd') { Copy-Item (Join-Path $target $file) (Join-Path $Dir $file) -Force }
  Write-Step "Installed Foxwarm $release in $Dir"
  if ($Loopback) {
    # The release's initial settings, which first-run Setup would otherwise write, plus the
    # loopback address. Main's own default, used without this installer, stays 0.0.0.0.
    $template = Join-Path $target 'templates\config.example.yaml'
    $text = if (Test-Path -LiteralPath $template) { ([System.IO.File]::ReadAllText($template) -replace "`r`n", "`n").TrimEnd("`n") + "`n`n" } else { '' }
    $text += "bot:`n  # 127.0.0.1 accepts only this computer; 0.0.0.0 also accepts other devices.`n  httpHost: 127.0.0.1`n"
    try {
      # CreateNew: a config.yaml that appeared meanwhile is never replaced.
      $stream = [System.IO.File]::Open((Join-Path $Data 'state\config.yaml'), 'CreateNew', 'Write')
      try { $bytes = $Utf8.GetBytes($text); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } catch [System.IO.IOException] { $Loopback = $false }
  }
} finally {
  Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoStart) {
  if ($Loopback) { Write-LoopbackHint $Data }
  Write-Step "Start it with: & '$Dir\foxwarmctl.cmd' start"
  return
}
Start-Control
Show-SignIn $Data
