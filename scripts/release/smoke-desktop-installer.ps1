# Qualify the Windows Desktop installer on a disposable runner with an interactive desktop:
# a silent per-user installation into a non-ASCII directory, the installed files against the
# Desktop ZIP, the Start menu shortcut, the Apps entry and the sign-in start; the registered
# sign-in command, which must open in the notification area; an installation over the running
# app, which must exit through its own shutdown first; and a silent uninstallation of the
# running app, which must keep its data and remove the files and every registration.
# The installed files are the ZIP's, which the Desktop acceptance qualifies in full.
# This changes the current user's Start menu, Run key and Apps list: use a disposable account.
# Usage: scripts\release\smoke-desktop-installer.ps1 -Setup FILE -Package foxwarm-desktop-win-x64.zip
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Package
)

$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$Package = (Resolve-Path -LiteralPath $Package).Path
$WindowScript = (Resolve-Path (Join-Path $PSScriptRoot '..\..\dotnet\scripts\desktop-window.ps1')).Path
# U+00E9 U+4E2D U+6587, written with escapes so the script's own encoding does not matter.
$Unicode = [string][char]0x00e9 + [char]0x4e2d + [char]0x6587
# The hosted runner's TEMP is an 8.3 path; the checks below compare paths as text.
$Temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Work = Join-Path $Temp ('foxwarm-installer-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Dir = Join-Path $Work "Programs $Unicode\Foxwarm"
$Data = Join-Path $Work "data-$Unicode"
$Exe = Join-Path $Dir 'Foxwarm.Desktop.exe'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6BE01B0C-EDFF-4777-A5DE-FB2F3BB5167D}_is1'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Foxwarm.lnk'

function Invoke-Program($File, [string[]]$Arguments, $Label) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru
  Write-Host "[installer] $Label exited with $($process.ExitCode) after $($clock.ElapsedMilliseconds) ms"
  if ($process.ExitCode -ne 0) { throw "$Label failed with exit code $($process.ExitCode)" }
}

function Invoke-Setup($Log, [string[]]$Extra) {
  Invoke-Program $Setup (@('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/LOG=`"$(Join-Path $Work $Log)`"") + $Extra) $Log
}

function Invoke-Window($Action, $ProcessId) {
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $WindowScript -Action $Action -ProcessId $ProcessId
  if ($LASTEXITCODE -ne 0) { throw "desktop-window.ps1 $Action failed" }
  return (@($output)[-1] | ConvertFrom-Json)
}

function Get-MainStops {
  $log = Join-Path $Data 'state\logs\foxwarm.log'
  if (-not (Test-Path -LiteralPath $log)) { return 0 }
  return @(Select-String -LiteralPath $log -Pattern 'Main stopped\.').Count
}

# Starts a command of the installed app from an unrelated directory, with the disposable data
# directory, and waits until Main reports ready.
function Start-Desktop($File, [string[]]$Arguments) {
  $env:FOXWARM_DATA_DIR = $Data
  $start = @{ FilePath = $File; WorkingDirectory = [Environment]::SystemDirectory; PassThru = $true }
  if ($Arguments.Count) { $start.ArgumentList = $Arguments }
  $process = Start-Process @start
  $null = $process.Handle # keeps the exit code available after the process ends
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "Foxwarm exited during startup with $($process.ExitCode)" }
    $port = Get-Content -LiteralPath (Join-Path $Data 'state\desktop-port') -ErrorAction SilentlyContinue
    $token = Get-Content -LiteralPath (Join-Path $Data 'state\token') -ErrorAction SilentlyContinue
    if ($port -and $token) {
      try {
        $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -Headers @{ Authorization = "Bearer $($token.Trim())" } -TimeoutSec 5
        if ($health.status -eq 'ready') { return $process }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Foxwarm did not become ready'
}

# The app must have ended by itself with status 0, after logging one more Main shutdown.
function Assert-Exited($Process, $StopsBefore, $Label) {
  if (-not $Process.WaitForExit(60000)) { throw "Foxwarm is still running after $Label" }
  if ($Process.ExitCode -ne 0) { throw "Foxwarm exited with $($Process.ExitCode) after $Label" }
  if ((Get-MainStops) -ne $StopsBefore + 1) { throw "Main did not stop through its shutdown before $Label" }
  Write-Host "[installer] Foxwarm exited through its shutdown for $Label"
}

function Assert-Registered($Expected) {
  $entry = Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue
  $run = (Get-ItemProperty -LiteralPath $RunKey -Name Foxwarm -ErrorAction SilentlyContinue).Foxwarm
  $link = Test-Path -LiteralPath $Shortcut
  if (-not $Expected) {
    if ($entry -or $run -or $link) { throw "Registrations remain: Apps entry=$([bool]$entry) sign-in start=$([bool]$run) shortcut=$link" }
    return
  }
  if ($entry.DisplayName -ne 'Foxwarm' -or $entry.DisplayVersion -ne $Expected -or $entry.InstallLocation -ne "$Dir\") {
    throw "Unexpected Apps entry: $($entry.DisplayName) $($entry.DisplayVersion) $($entry.InstallLocation)"
  }
  if ($run -ne "`"$Exe`" --tray") { throw "Unexpected sign-in start: $run" }
  if (-not $link) { throw 'The Start menu shortcut is missing' }
  # The Shell's link object keeps non-ANSI paths, which WScript.Shell's shortcuts replace with '?'.
  $link = (New-Object -ComObject Shell.Application).NameSpace((Split-Path $Shortcut)).ParseName((Split-Path -Leaf $Shortcut)).GetLink
  if ($link.Path -ne $Exe -or $link.Arguments) { throw "Unexpected shortcut: $($link.Path) $($link.Arguments)" }
}

function Get-Files($Root) {
  $files = @{}
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
    $files[$file.FullName.Substring($Root.Length + 1)] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
  return $files
}

if (Test-Path -LiteralPath $UninstallKey) { throw 'Foxwarm Desktop is already installed for this user; use a disposable account' }
$running = $null
try {
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $zip = Join-Path $Work 'zip'
  Expand-Archive -LiteralPath $Package -DestinationPath $zip
  $payload = (Get-ChildItem -LiteralPath $zip -Directory | Select-Object -First 1).FullName
  $version = (Get-Content -LiteralPath (Join-Path $payload 'release.json') -Raw | ConvertFrom-Json).version

  Invoke-Setup 'install.log' @("/DIR=`"$Dir`"", '/TASKS=autostart')
  Assert-Registered $version
  $expected = Get-Files $payload
  $installed = Get-Files $Dir
  foreach ($name in $expected.Keys) {
    if ($installed[$name] -ne $expected[$name]) { throw "The installed $name differs from the ZIP" }
  }
  $extra = @($installed.Keys | Where-Object { -not $expected.ContainsKey($_) } | Sort-Object)
  if (($extra -join ',') -ne 'unins000.dat,unins000.exe') { throw "Unexpected installed files: $($extra -join ', ')" }
  Write-Host "[installer] $($expected.Count) installed files match the ZIP"

  # The registered sign-in command, run as Windows runs it at sign-in, opens in the notification
  # area without WebView2.
  $command = (Get-ItemProperty -LiteralPath $RunKey -Name Foxwarm).Foxwarm
  if ($command -notmatch '^"([^"]+)" (.+)$') { throw "Unexpected sign-in command: $command" }
  $running = Start-Desktop $Matches[1] ($Matches[2] -split ' ')
  if (-not (Invoke-Window 'tray' $running.Id).registered) { throw 'The sign-in start has no notification icon' }
  if ((Invoke-Window 'window' $running.Id).visible) { throw 'The sign-in start shows its window' }
  $webView = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($running.Id) AND Name = 'msedgewebview2.exe'")
  if ($webView.Count) { throw 'The sign-in start created WebView2 before the window was opened' }
  Set-Content -LiteralPath (Join-Path $Data 'kept.txt') -Value 'user data'

  $stops = Get-MainStops
  Invoke-Setup 'reinstall.log' @()
  Assert-Exited $running $stops 'the installation over it'
  Assert-Registered $version
  if ((Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash -ne $expected['Foxwarm.Desktop.exe']) { throw 'The reinstalled executable differs' }

  $running = Start-Desktop $Exe @()
  if (-not (Invoke-Window 'window' $running.Id).visible) { throw 'An ordinary start does not show its window' }
  $stops = Get-MainStops
  Invoke-Program (Join-Path $Dir 'unins000.exe') @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $Work 'uninstall.log')`"") 'uninstall'
  Assert-Exited $running $stops 'the uninstallation'
  $running = $null
  # The uninstaller removes itself and the empty program directory just after it exits.
  for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $Dir); $i++) { Start-Sleep -Milliseconds 250 }
  if (Test-Path -LiteralPath $Dir) { throw "The program directory remains: $((Get-ChildItem -LiteralPath $Dir -Recurse -Name) -join ', ')" }
  Assert-Registered $null
  if ((Get-Content -LiteralPath (Join-Path $Data 'kept.txt')) -ne 'user data') { throw 'The uninstallation changed the data directory' }
  if (-not (Test-Path -LiteralPath (Join-Path $Data 'state\token'))) { throw 'The uninstallation removed Foxwarm state' }
  Write-Host '[installer] Installation, sign-in start, installation over the running app and uninstallation passed.'
} finally {
  Remove-Item Env:FOXWARM_DATA_DIR -ErrorAction SilentlyContinue
  if ($running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath (Join-Path $Dir 'unins000.exe')) {
    Start-Process -FilePath (Join-Path $Dir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait | Out-Null
  }
  foreach ($log in 'install.log', 'reinstall.log', 'uninstall.log') {
    $file = Join-Path $Work $log
    if (Test-Path -LiteralPath $file) { Write-Host "== $log"; Get-Content -LiteralPath $file | Select-String 'Foxwarm|exit|Removing|previous' | ForEach-Object { Write-Host $_.Line } }
  }
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
