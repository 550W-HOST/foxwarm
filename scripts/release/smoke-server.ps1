# Install a Windows server package into a disposable directory, then exercise
# background start, HTTP sign-in page, status, forced reinstall through update, and stop.
# The installer and the control script run in Windows PowerShell, as for users. Program and
# data directories contain non-ASCII characters, which the data_dir pointer must keep.
# Usage: scripts\release\smoke-server.ps1 -Package FILE [-Port 3001]
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath $Package).Path
$Installer = (Resolve-Path (Join-Path $PSScriptRoot '..\..\install-foxwarm.ps1')).Path
# U+00E9 U+4E2D U+6587, written with escapes so the script's own encoding does not matter.
$Unicode = [string][char]0x00e9 + [char]0x4e2d + [char]0x6587
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('foxwarm-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Dir = Join-Path $Work "foxwarm-$Unicode"
$Data = Join-Path $Work "data-$Unicode"
$Control = Join-Path $Dir 'foxwarmctl.cmd'

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

function Show-Runtime($Label) {
  foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $Dir 'runtime') -Force -ErrorAction SilentlyContinue) {
    Write-Host "[$Label] runtime\$($entry.Name) $($entry.LinkType) $($entry.Target) release.json=$(Test-Path (Join-Path $entry.FullName 'release.json'))"
  }
}

function Get-RunningPid {
  $status = & $Control status
  if ($LASTEXITCODE -ne 0) { throw 'Foxwarm is not running' }
  $status | Write-Host
  return [int](([string]($status | Select-String 'PID (\d+)').Matches[0].Groups[1].Value))
}

function Invoke-Timed($Verb) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  & $Control @args | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Verb failed with exit code $LASTEXITCODE" }
  Write-Host "[smoke] $Verb took $($clock.ElapsedMilliseconds) ms"
}

New-Item -ItemType Directory -Force -Path (Join-Path $Data 'state') | Out-Null
# Listen on loopback only; releases before 0.9.6 ignore the setting and listen on all addresses.
Set-Content -LiteralPath (Join-Path $Data 'state\config.yaml') -Value "bot:`n  httpPort: $Port`n  httpHost: 127.0.0.1`n"
try {
  Invoke-Installer -Package $Package -InstallDir $Dir -DataDir $Data -NoStart
  $pointer = [System.IO.File]::ReadAllText((Join-Path $Dir 'data_dir'), [System.Text.Encoding]::UTF8)
  if ($pointer -ne (Resolve-Path -LiteralPath $Data).Path) { throw "data_dir records '$pointer', not '$Data'" }
  Invoke-Timed start start
  Wait-Http
  if (-not (Get-Content -LiteralPath (Join-Path $Data 'state\token') -Raw).Trim()) { throw 'No sign-in token was created' }
  $log = Get-Content -LiteralPath (Join-Path $Data 'state\logs\foxwarm.log') -Raw -Encoding UTF8
  if ($log -notmatch "Main HTTP listening: http://127\.0\.0\.1:$Port\r?\n") { throw 'Main did not listen on its configured address in the data directory' }
  $first = Get-RunningPid

  & $Control update -Package $Package -Force | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "update failed with exit code $LASTEXITCODE" }
  Wait-Http
  $second = Get-RunningPid
  if ($first -eq $second) { throw 'Update did not restart Foxwarm' }
  $entries = @(Get-ChildItem -LiteralPath (Join-Path $Dir 'runtime') -Force)
  if ($entries.Count -ne 2) { $entries | Format-Table | Out-String | Write-Host; throw 'Old releases were not removed' }

  Invoke-Timed restart restart
  Wait-Http
  $third = Get-RunningPid

  & $Control stop | Out-Host
  & $Control status | Out-Host
  if ($LASTEXITCODE -eq 0) { throw 'Foxwarm is still running after stop' }
  if (Get-Process -Id $third -ErrorAction SilentlyContinue) { throw "PID $third survived stop" }
  Write-Host "Smoke test passed: $(Split-Path $Package -Leaf)"
} catch {
  Write-Host "Smoke test failed: $_"
  Write-Host $_.ScriptStackTrace
  Show-Runtime 'failure'
  $logs = Join-Path $Data 'state\logs'
  foreach ($log in 'foxwarm.stdout.log', 'foxwarm.stderr.log') {
    $file = Join-Path $logs $log
    if (Test-Path -LiteralPath $file) { Write-Host "--- $log"; Get-Content -LiteralPath $file -Tail 80 | Write-Host }
  }
  throw
} finally {
  try { if (Test-Path -LiteralPath $Control) { & $Control stop | Out-Null } } catch { Write-Host "Cleanup stop failed: $_" }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
# The expected nonzero status exit above must not become the script result.
exit 0
