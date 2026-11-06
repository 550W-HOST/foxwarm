# Install a Windows server package into a disposable directory, then exercise
# background start, HTTP sign-in page, status, forced reinstall through update, and stop.
# Usage: scripts\release\smoke-server.ps1 -Package FILE [-Port 3001]
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath $Package).Path
$Installer = Join-Path $PSScriptRoot '..\..\install-foxwarm.ps1'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('foxwarm-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Dir = Join-Path $Work 'foxwarm'
$Data = Join-Path $Work 'data'
$Control = Join-Path $Dir 'foxwarmctl.ps1'

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

New-Item -ItemType Directory -Force -Path (Join-Path $Data 'state') | Out-Null
Set-Content -Path (Join-Path $Data 'state\config.yaml') -Value "bot:`n  httpPort: $Port`n"
try {
  & $Installer -Package $Package -InstallDir $Dir -DataDir $Data -NoStart
  & $Control start
  Wait-Http
  if (-not (Get-Content (Join-Path $Data 'state\token') -Raw).Trim()) { throw 'No sign-in token was created' }
  $first = Get-RunningPid

  & $Control update -Package $Package -Force
  Wait-Http
  $second = Get-RunningPid
  if ($first -eq $second) { throw 'Update did not restart Foxwarm' }
  $entries = @(Get-ChildItem (Join-Path $Dir 'runtime') -Force)
  if ($entries.Count -ne 2) { $entries | Format-Table | Out-String | Write-Host; throw 'Old releases were not removed' }

  & $Control stop
  & $Control status
  if ($LASTEXITCODE -eq 0) { throw 'Foxwarm is still running after stop' }
  if (Get-Process -Id $second -ErrorAction SilentlyContinue) { throw "PID $second survived stop" }
  Write-Host "Smoke test passed: $(Split-Path $Package -Leaf)"
} catch {
  Write-Host "Smoke test failed: $_"
  Write-Host $_.ScriptStackTrace
  Show-Runtime 'failure'
  $logs = Join-Path $Data 'state\logs'
  foreach ($log in 'foxwarm.stdout.log', 'foxwarm.stderr.log') {
    $file = Join-Path $logs $log
    if (Test-Path $file) { Write-Host "--- $log"; Get-Content $file -Tail 80 | Write-Host }
  }
  throw
} finally {
  try { if (Test-Path $Control) { & $Control stop | Out-Null } } catch { Write-Host "Cleanup stop failed: $_" }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
# The expected nonzero status exit above must not become the script result.
exit 0
