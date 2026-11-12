# Install -Old with the real installer and start it, then rerun the installer with -New (and
# -Native or -FrameworkDependent if given) to switch the installation the way users do. The
# installation's own control script performs the update. Checks that the new package runs from
# the same program directory and keeps its data and configuration.
# With -ViaUpdate ASSET, the installation's own `foxwarmctl update` performs the switch instead:
# its release downloads are answered with -New published under ASSET and a SHA256SUMS line
# for that name, and ASSET must be the asset the installed release records. Control scripts
# have a fixed release URL, so for this check the control script runs in this PowerShell
# session, where an Invoke-WebRequest function serves those downloads.
# Usage: scripts\release\smoke-upgrade.ps1 -Old FILE -New FILE [-Port 3001] [-ViaUpdate ASSET] [-Native | -FrameworkDependent]
param(
  [Parameter(Mandatory = $true)][string]$Old,
  [Parameter(Mandatory = $true)][string]$New,
  [int]$Port = 3001,
  [string]$ViaUpdate,
  [switch]$Native,
  [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$Old = (Resolve-Path -LiteralPath $Old).Path
$New = (Resolve-Path -LiteralPath $New).Path
$Installer = (Resolve-Path (Join-Path $PSScriptRoot '..\..\install-foxwarm.ps1')).Path
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('foxwarm-upgrade-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Dir = Join-Path $Work 'foxwarm'
$Data = Join-Path $Work 'data'
$Control = Join-Path $Dir 'foxwarmctl.cmd'
Remove-Item Env:\FOXWARM_DATA_DIR, Env:\FOXWARM_DIR -ErrorAction SilentlyContinue

function Invoke-Installer {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer @args | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "The installer failed with exit code $LASTEXITCODE" }
}

function Wait-Http {
  for ($i = 0; $i -lt 120; $i++) {
    try {
      $response = Invoke-WebRequest "http://127.0.0.1:$Port/login.html" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  throw "Foxwarm did not serve the sign-in page on port $Port"
}

function Get-RunningPid {
  $status = & $Control status
  if ($LASTEXITCODE -ne 0) { $status | Write-Host; throw 'Foxwarm is not running' }
  return [int](([string]($status | Select-String 'PID (\d+)').Matches[0].Groups[1].Value))
}

function Read-Installed { Get-Content -LiteralPath (Join-Path $Dir 'runtime\current\release.json') -Raw -Encoding UTF8 | ConvertFrom-Json }

function Read-PackageRelease($File) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($File)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -match '^[^/\\]+[/\\]release\.json$' } | Select-Object -First 1
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}

New-Item -ItemType Directory -Force -Path (Join-Path $Data 'state') | Out-Null
# Loopback only; releases before 0.9.6 ignore bot.httpHost and listen on all addresses.
$config = "bot:`n  httpPort: $Port`n  httpHost: 127.0.0.1`n# retained by the upgrade`n"
[System.IO.File]::WriteAllText((Join-Path $Data 'state\config.yaml'), $config)
try {
  Invoke-Installer -Package $Old -InstallDir $Dir -DataDir $Data
  Wait-Http
  $before = Read-Installed
  $beforeRelease = "$($before.asset)/$($before.version)/$($before.commit)"
  $first = Get-RunningPid
  $token = (Get-Content -LiteralPath (Join-Path $Data 'state\token') -Raw).Trim()
  if (-not $token) { throw 'No sign-in token was created' }
  New-Item -ItemType Directory -Force -Path (Join-Path $Data 'agents') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Data 'agents\upgrade-marker'), 'kept')
  $next = Read-PackageRelease $New

  if ($ViaUpdate) {
    if ($before.asset -ne $ViaUpdate) { throw "The installed release records $($before.asset), not $ViaUpdate" }
    $serve = Join-Path $Work 'release-download'
    New-Item -ItemType Directory -Force -Path $serve | Out-Null
    Copy-Item -LiteralPath $New -Destination (Join-Path $serve $ViaUpdate)
    $hash = (Get-FileHash (Join-Path $serve $ViaUpdate) -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText((Join-Path $serve 'SHA256SUMS'), "$hash  $ViaUpdate`n")
    # The function runs in the control script's scope, so it records requests in a file.
    $requestLog = Join-Path $Work 'requests'
    # Command lookup prefers functions to cmdlets, so the control script run below in this
    # session downloads the release files from $serve.
    function Invoke-WebRequest {
      param([Parameter(Position = 0)][string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
      if ($Uri -match '^https://github\.com/[^/]+/[^/]+/releases/latest/download/([^/]+)$') {
        Add-Content -LiteralPath $requestLog -Value $Uri
        $file = Join-Path $serve $Matches[1]
        if (-not (Test-Path -LiteralPath $file)) { throw "404 $Uri" }
        Copy-Item -LiteralPath $file -Destination $OutFile
        return
      }
      if ($Uri -match '^https://') { throw "Unexpected download: $Uri" }
      $forwarded = @{ Uri = $Uri; UseBasicParsing = $true }
      if ($OutFile) { $forwarded.OutFile = $OutFile }
      if ($TimeoutSec) { $forwarded.TimeoutSec = $TimeoutSec }
      Microsoft.PowerShell.Utility\Invoke-WebRequest @forwarded
    }
    # A release whose version equals the installed one needs -Force; the download is the same.
    $script = Join-Path $Dir 'foxwarmctl.ps1'
    if ($next.version -eq $before.version) { & $script update -Force | Out-Host } else { & $script update | Out-Host }
    if ($LASTEXITCODE -ne 0) { throw "update failed with exit code $LASTEXITCODE" }
    Remove-Item Function:\Invoke-WebRequest
    $requests = @(Get-Content -LiteralPath $requestLog -ErrorAction SilentlyContinue)
    $expected = @("releases/latest/download/$ViaUpdate", 'releases/latest/download/SHA256SUMS')
    if ($requests.Count -ne 2 -or -not $requests[0].EndsWith($expected[0]) -or -not $requests[1].EndsWith($expected[1])) {
      $requests | Write-Host
      throw "update did not download $ViaUpdate and its SHA256SUMS"
    }
  } else {
    if ($next.version -eq $before.version -and $next.asset -eq $before.asset) { throw 'Upgrading to the same version of the same package needs no installer switch; use -ViaUpdate or another package.' }
    $options = @('-Package', $New, '-InstallDir', $Dir)
    if ($Native) { $options += '-Native' }
    if ($FrameworkDependent) { $options += '-FrameworkDependent' }
    Invoke-Installer @options
  }
  Wait-Http
  $second = Get-RunningPid
  if ($first -eq $second) { throw 'The update did not restart Foxwarm on the new package' }
  $after = Read-Installed
  $afterRelease = "$($after.asset)/$($after.version)/$($after.commit)"
  Write-Host "Switched $beforeRelease -> $afterRelease"
  if ($afterRelease -eq $beforeRelease) { throw "The installation still runs $beforeRelease" }
  if ((Get-Content -LiteralPath (Join-Path $Data 'state\token') -Raw).Trim() -ne $token) { throw 'The sign-in token changed' }
  if ([System.IO.File]::ReadAllText((Join-Path $Data 'state\config.yaml')) -ne $config) { throw 'config.yaml changed' }
  if ([System.IO.File]::ReadAllText((Join-Path $Data 'agents\upgrade-marker')) -ne 'kept') { throw 'Agent data was lost' }
  if ([System.IO.File]::ReadAllText((Join-Path $Dir 'data_dir')).Trim() -ne (Resolve-Path $Data).Path) { throw 'data_dir changed' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $second"
  if ($after.native) {
    if ($process.Name -ne 'Foxwarm.exe' -or $process.CommandLine -match 'Foxwarm\.dll') { throw "The native installation runs a managed Main: $($process.CommandLine)" }
    if (Test-Path (Join-Path $Dir 'runtime\current\Foxwarm.dll')) { throw 'The native package contains Foxwarm.dll' }
  }
  # Later updates must request the new package's own asset, not the name it arrived under.
  if ($after.asset -ne $next.asset) { throw "release.json records $($after.asset), not $($next.asset)" }
  $entries = @(Get-ChildItem -LiteralPath (Join-Path $Dir 'runtime') -Force)
  if ($entries.Count -ne 2) { $entries | Format-Table | Out-String | Write-Host; throw 'The old release was not removed' }
  & $Control restart | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "restart failed with exit code $LASTEXITCODE" }
  Wait-Http
  & $Control stop | Out-Host
  & $Control status | Out-Host
  if ($LASTEXITCODE -eq 0) { throw 'Foxwarm is still running after stop' }
  Write-Host "Upgrade smoke passed: $(Split-Path $Old -Leaf) -> $(Split-Path $New -Leaf)"
} catch {
  Write-Host "Upgrade smoke failed: $_"
  Write-Host $_.ScriptStackTrace
  foreach ($log in 'foxwarm.stdout.log', 'foxwarm.stderr.log', 'foxwarm.log') {
    $file = Join-Path $Data "state\logs\$log"
    if (Test-Path -LiteralPath $file) { Write-Host "--- $log"; Get-Content -LiteralPath $file -Tail 80 | Write-Host }
  }
  throw
} finally {
  try { if (Test-Path -LiteralPath $Control) { & $Control stop | Out-Null } } catch { Write-Host "Cleanup stop failed: $_" }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
