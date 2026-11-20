# Control a Foxwarm release installation: start, stop, restart, status, run, update, version.
# The installer places this script in the installation directory beside runtime\current.
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Version,
  [string]$Package,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime'
# PowerShell variables are case-insensitive; functions must not assign $current, $root, etc.
$Current = Join-Path $RuntimeDir 'current'
$Releases = 'https://github.com/550W-HOST/foxwarm/releases'
$StopSeconds = 60

function Write-Step($Message) { Write-Host "[foxwarm] $Message" }

# A plain message and exit code 1, not a PowerShell error record with a stack position.
function Fail($Message) {
  [Console]::Error.WriteLine("[foxwarm] $Message")
  exit 1
}

function Show-Usage {
  @'
Usage: foxwarmctl COMMAND

  start                       Start Foxwarm in the background
  stop                        Stop Foxwarm (forced after 60 seconds)
  restart                     Stop, then start
  status                      Show whether Foxwarm is running
  run                         Run Foxwarm in this console
  update [VERSION]            Install the latest or the given release and restart if running
         [-Package FILE] [-Force]
  version                     Show the installed release
'@ | Write-Host
}

if (-not (Test-Path (Join-Path $Current 'release.json'))) {
  throw "No release is installed at $Current. Run the copy of foxwarmctl in the installation directory."
}

function Read-Release($Directory) {
  return Get-Content (Join-Path $Directory 'release.json') -Raw | ConvertFrom-Json
}

function Resolve-DataRoot {
  if ($env:FOXWARM_DATA_DIR -and $env:FOXWARM_DATA_DIR.Trim()) { $value = $env:FOXWARM_DATA_DIR.Trim() }
  else {
    $pointer = Join-Path $Root 'data_dir'
    # The installer writes the pointer as UTF-8, which Main reads; Windows PowerShell's default is ANSI.
    $value = if (Test-Path -LiteralPath $pointer) { ([string](Get-Content -LiteralPath $pointer -Raw -Encoding UTF8)).Trim() } else { '' }
    if (-not $value) { return [System.IO.Path]::GetFullPath($Root) }
  }
  if ($value -eq '~') { $value = $HOME } elseif ($value.StartsWith('~/')) { $value = Join-Path $HOME $value.Substring(2) }
  if (-not [System.IO.Path]::IsPathRooted($value)) { $value = Join-Path $Root $value }
  $full = [System.IO.Path]::GetFullPath($value)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
  return $full
}

$DataRoot = Resolve-DataRoot
$LogDir = Join-Path $DataRoot 'state\logs'
$StdoutLog = Join-Path $LogDir 'foxwarm.stdout.log'
$StderrLog = Join-Path $LogDir 'foxwarm.stderr.log'

# Same data-root-specific name as the source checkout's Windows controls.
function Get-PipeName {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($DataRoot.ToLowerInvariant()))
  } finally { $sha.Dispose() }
  return 'foxwarm-' + (-join ($bytes | ForEach-Object { $_.ToString('x2') })).Substring(0, 20)
}
$PipeName = Get-PipeName

function Invoke-Control($Request) {
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(2000)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Request`n")
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    $reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8)
    # Whoever owns the pipe name may never answer; do not wait for it forever.
    $read = $reader.ReadToEndAsync()
    if (-not $read.Wait(5000)) { throw "No reply from the control pipe $PipeName within 5 seconds." }
    return $read.Result | ConvertFrom-Json
  } finally { $pipe.Dispose() }
}

# Whether a pipe of this name exists. Connecting to a missing pipe would wait out its whole
# timeout, which made every start spend two seconds checking for a running instance.
function Test-ControlPipe {
  try { return [System.IO.Directory]::GetFiles('\\.\pipe\') -contains "\\.\pipe\$PipeName" } catch { return $true }
}

function Get-Status {
  if (-not (Test-ControlPipe)) { return $null }
  try {
    $status = Invoke-Control 'status'
    if ($status.ok) { return $status }
  } catch { }
  return $null
}

function Test-Pid($ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ProcessDetail($ProcessId) {
  return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Format-ProcessDetail($ProcessId) {
  $detail = Get-ProcessDetail $ProcessId
  if (-not $detail) { return "no process with PID $ProcessId" }
  $program = if ($detail.ExecutablePath) { $detail.ExecutablePath } else { $detail.Name }
  return "PID $ProcessId ($program)"
}

# The control pipe name is predictable, so a process that answers on it is not necessarily
# this installation's Main. A process is Main when its command line names this installation
# root and its program is a release under runtime\ (Foxwarm.exe, or Foxwarm.dll run by dotnet).
function Test-OwnedMain($ProcessId) {
  try {
    $detail = Get-ProcessDetail $ProcessId
    if (-not $detail -or -not $detail.CommandLine) { return $false }
    $commandLine = [string]$detail.CommandLine
    $named = [regex]::Match($commandLine, '--installation-root\s+(?:"([^"]*)"|(\S+))')
    if (-not $named.Success) { return $false }
    $namedRoot = if ($named.Groups[1].Success) { $named.Groups[1].Value } else { $named.Groups[2].Value }
    if ([System.IO.Path]::GetFullPath($namedRoot).TrimEnd('\', '/') -ne [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')) { return $false }
    $program = $null
    if ($detail.Name -eq 'Foxwarm.exe') { $program = $detail.ExecutablePath }
    elseif ($detail.Name -eq 'dotnet.exe') {
      $dll = [regex]::Match($commandLine, '^\s*"[^"]+"\s+"([^"]+\\Foxwarm\.dll)"')
      if ($dll.Success) { $program = $dll.Groups[1].Value }
    }
    if (-not $program) { return $false }
    $releases = [System.IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\', '/') + '\'
    return [System.IO.Path]::GetFullPath($program).StartsWith($releases, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

# State is none (nothing answers), running (this installation's Main answers) or foreign
# (something else answers on the pipe name). $Owned is a PID already verified as this
# installation's Main, so a caller polling one start does not repeat the slow process query.
function Get-Instance($Owned = 0) {
  $status = Get-Status
  if (-not $status) { return [pscustomobject]@{ State = 'none'; Status = $null; Pid = 0 } }
  $processId = [int]$status.pid
  # A reply from a process that has just exited (a Main that failed while starting) is not an instance.
  if (-not (Test-Pid $processId)) { return [pscustomobject]@{ State = 'none'; Status = $null; Pid = 0 } }
  $state = if ($processId -eq $Owned -or (Test-OwnedMain $processId)) { 'running' } else { 'foreign' }
  return [pscustomobject]@{ State = $state; Status = $status; Pid = $processId }
}

function Fail-Foreign($Instance) {
  Fail "The control pipe '$PipeName' is answered by $(Format-ProcessDetail $Instance.Pid), which is not this installation's Foxwarm. Nothing was started or stopped. Close the program that holds the pipe; if it is a stale Foxwarm, end it in Task Manager."
}

function Get-HttpPort {
  $config = Join-Path $DataRoot 'state\config.yaml'
  if (Test-Path -LiteralPath $config) {
    $match = Select-String -LiteralPath $config -Pattern '^\s*httpPort:\s*(\d+)' | Select-Object -First 1
    if ($match) { return [int]$match.Matches[0].Groups[1].Value }
  }
  return 3001
}

function Get-PortHolder($Port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($process) { $process.ProcessName } else { 'another program' }
    return "$name (PID $($listener.OwningProcess))"
  } catch { return $null }
}

# What Main wrote to the error log since this start began.
function Read-NewErrors($Offset) {
  try {
    $stream = [System.IO.File]::Open($StderrLog, 'Open', 'Read', 'ReadWrite')
    try {
      if ($stream.Length -le $Offset) { return '' }
      $null = $stream.Seek($Offset, 'Begin')
      return (New-Object System.IO.StreamReader($stream)).ReadToEnd()
    } finally { $stream.Dispose() }
  } catch { return '' }
}

function Fail-Startup($Offset) {
  $errors = (Read-NewErrors $Offset).Trim()
  if ($errors -match 'AddressInUse') {
    $port = Get-HttpPort
    $holder = Get-PortHolder $port
    $by = if ($holder) { " by $holder" } else { '' }
    Fail "Foxwarm could not start: port $port is already in use$by. Stop that program, or set bot.httpPort in $(Join-Path $DataRoot 'state\config.yaml') to a free port."
  }
  if ($errors -match 'AddressNotAvailable') {
    Fail "Foxwarm could not start: bot.httpHost in $(Join-Path $DataRoot 'state\config.yaml') is not an address of this computer."
  }
  if ($errors -match 'ControlPipeUnavailable') {
    Fail "Foxwarm could not start: the control pipe '$PipeName' is already in use by another process. Close the program that holds the pipe."
  }
  $last = if ($errors) { ' The last error was: ' + (($errors -split "`r?`n" | Select-Object -Last 1).Trim()) } else { '' }
  Fail "Foxwarm exited during startup.$last See $StderrLog"
}

function Get-SelectedRelease {
  $link = (Get-Item $Current).Target | Select-Object -First 1
  if (-not $link) { throw "$Current is not a junction to an installed release." }
  if (-not [System.IO.Path]::IsPathRooted($link)) { $link = Join-Path $RuntimeDir $link }
  return $link
}

# Framework-dependent packages use the dotnet on PATH, which the apphost would not search.
# Callers wrap the result in @() because a one-element array is returned as a scalar.
function Get-Launcher($Directory) {
  if ((Read-Release $Directory).selfContained) { return @((Join-Path $Directory 'Foxwarm.exe')) }
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) { Fail 'This package needs the ASP.NET Core 10 runtime and dotnet on PATH.' }
  return @($dotnet.Source, (Join-Path $Directory 'Foxwarm.dll'))
}

function Start-Foxwarm {
  $existing = Get-Instance
  if ($existing.State -eq 'running') { Fail "Foxwarm is already running (PID $($existing.Pid))." }
  if ($existing.State -eq 'foreign') { Fail-Foreign $existing }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # Resolve the selected release now so a later update does not move a running Main.
  $release = Get-SelectedRelease
  $launcher = @(Get-Launcher $release)
  $commandLine = ($launcher | ForEach-Object { "`"$_`"" }) -join ' '
  $env:FOXWARM_WINDOWS_CONTROL_PIPE = $PipeName
  $env:FOXWARM_MAIN_LIFETIME_PIPE = $null
  # cmd appends both streams to the lifecycle logs and keeps no console attached to this window.
  $line = "/d /s /c `"$commandLine --installation-root `"$Root`" --windows-background >> `"$StdoutLog`" 2>> `"$StderrLog`"`""
  $errorOffset = if (Test-Path -LiteralPath $StderrLog) { (Get-Item -LiteralPath $StderrLog).Length } else { 0 }
  $launch = Start-Process -FilePath $env:ComSpec -ArgumentList $line -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  # Success means Main is serving: the control pipe answers from this installation's process and
  # reports it ready. The pipe comes up before the HTTP listener, so an answer alone is not enough.
  $deadline = (Get-Date).AddSeconds(60)
  $started = $null
  $instance = $null
  $owned = 0
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $instance = Get-Instance $owned
    if ($instance.State -eq 'foreign' -and (Test-Pid $instance.Pid)) { Fail-Foreign $instance }
    if ($instance.State -eq 'running') {
      $owned = $instance.Pid
      # Main versions without the field are treated as ready once they answer.
      $ready = $instance.Status.PSObject.Properties['ready']
      if (-not $ready -or $ready.Value) { $started = $instance; break }
    } elseif ($launch.HasExited) {
      Fail-Startup $errorOffset
    }
  }
  if (-not $started) {
    if ($instance -and $instance.State -eq 'running') {
      Fail "Foxwarm (PID $($instance.Pid)) did not finish starting within 60 seconds and is still starting. Check $StdoutLog and $StderrLog"
    }
    Fail "Foxwarm did not start within 60 seconds. Check $StderrLog"
  }
  Write-Step "Started $((Read-Release $release).version) from $release in the background (PID $($started.Pid))."
  Write-Step "Data:   $DataRoot"
  Write-Step "Logs:   $LogDir"
}

function Stop-Foxwarm {
  $instance = Get-Instance
  if ($instance.State -eq 'none') {
    Write-Step 'Foxwarm is not running.'
    return
  }
  if ($instance.State -eq 'foreign') { Fail-Foreign $instance }
  $processId = $instance.Pid
  try { Invoke-Control 'stop' | Out-Null } catch { Write-Warning "Stop request failed: $_" }
  $deadline = (Get-Date).AddSeconds($StopSeconds)
  while ((Test-Pid $processId) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (Test-Pid $processId) {
    # Only this installation's Main is ever terminated, never a PID that merely came over the pipe.
    if (-not (Test-OwnedMain $processId)) {
      Fail "PID $processId is not this installation's Foxwarm and was not terminated."
    }
    Write-Warning "Foxwarm did not stop within $StopSeconds seconds; terminating PID $processId."
    Stop-Process -Id $processId -Force
    Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
  }
  Write-Step 'Foxwarm stopped.'
}

function Show-Status {
  $instance = Get-Instance
  if ($instance.State -eq 'none') {
    '[foxwarm] Not running.'
    exit 3
  }
  if ($instance.State -eq 'foreign') {
    "[foxwarm] Not running: the control pipe '$PipeName' is answered by $(Format-ProcessDetail $instance.Pid), which is not this installation's Foxwarm."
    exit 3
  }
  $status = $instance.Status
  $starting = $status.PSObject.Properties['ready'] -and -not $status.ready
  $release = Read-Release $Current
  "[foxwarm] Running (PID $($status.pid)$(if ($status.stopping) { ', stopping' } elseif ($starting) { ', starting' })), release $($release.version) $($release.target)."
  "[foxwarm] Data:   $DataRoot"
  "[foxwarm] Logs:   $LogDir"
}

function Set-Current($Target) {
  # A non-recursive delete removes the junction itself, never the selected release's contents.
  if ((Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue)) { [System.IO.Directory]::Delete($Current, $false) }
  New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null
  $selected = Get-SelectedRelease
  if ($selected -ne $Target -or -not (Test-Path (Join-Path $Current 'release.json'))) { throw "Could not select $Target (runtime\current points to $selected)" }
}

# Download a release file. A release that does not publish it fails with $Missing.
function Get-ReleaseFile($Url, $OutFile, $Missing) {
  try { Invoke-WebRequest $Url -OutFile $OutFile -UseBasicParsing }
  catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 404) { Fail $Missing }
    throw
  }
}

# Another process can briefly hold a file of a release that was just extracted and run for
# inspection (an indexer or scanner, for example), which makes the move fail with access
# denied; retry for a few seconds before giving up.
function Move-ExtractedRelease($Source, $Destination) {
  for ($attempt = 1; ; $attempt++) {
    try { Move-Item -LiteralPath $Source -Destination $Destination; return }
    catch [System.IO.IOException] { if ($attempt -ge 20) { throw } }
    catch [System.UnauthorizedAccessException] { if ($attempt -ge 20) { throw } }
    Start-Sleep -Milliseconds 250
  }
}

function Update-Foxwarm {
  $installed = Read-Release $Current
  $scratch = Join-Path $RuntimeDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  try {
    $archive = if ($Package) { (Resolve-Path -LiteralPath $Package).Path } else { $null }
    if (-not $archive) {
      $base = if ($Version) { "$Releases/download/v$($Version.TrimStart('v'))" } else { "$Releases/latest/download" }
      $archive = Join-Path $scratch $installed.asset
      Write-Step "Downloading $($installed.asset)"
      $ProgressPreference = 'SilentlyContinue'
      # A release can retire a package type; rerunning the installer switches to a current one.
      $release = if ($Version) { "Release $($Version.TrimStart('v'))" } else { 'The latest release' }
      Get-ReleaseFile "$base/$($installed.asset)" $archive "$release has no $($installed.asset). To switch this installation to a package it publishes, rerun the installer with -InstallDir '$Root'."
      Get-ReleaseFile "$base/SHA256SUMS" (Join-Path $scratch 'SHA256SUMS') "$release has no SHA256SUMS."
      $expected = Get-Content (Join-Path $scratch 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($installed.asset))$" } | ForEach-Object { $Matches[1] }
      if (-not $expected -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
        throw "Checksum verification failed for $($installed.asset)."
      }
    }
    $extract = Join-Path $scratch 'extract'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extract)
    $staging = Get-ChildItem $extract -Directory | Select-Object -First 1
    if (-not $staging -or -not (Test-Path (Join-Path $staging.FullName 'Foxwarm.exe'))) { throw "$archive is not a Foxwarm server package." }
    $next = Read-Release $staging.FullName
    if ($next.rid -ne $installed.rid) { throw "$archive is for $($next.rid), not this installation." }
    if ($next.version -eq $installed.version -and -not $Force) {
      Write-Step "Release $($installed.version) is already installed. Use -Force to reinstall it."
      return
    }
    Write-Step "Checking existing data with $($next.version)"
    $launcher = @(Get-Launcher $staging.FullName)
    & $launcher[0] @($launcher | Select-Object -Skip 1) --installation-root $Root --inspect-upgrade
    if ($LASTEXITCODE -ne 0) { throw "Upgrade inspection blocked $($next.version); the installed release is unchanged." }
    $running = Get-Instance
    if ($running.State -eq 'foreign') { Fail-Foreign $running }
    $wasRunning = $running.State -eq 'running'
    if ($wasRunning) { Stop-Foxwarm }
    $name = $next.version
    if (Test-Path (Join-Path $RuntimeDir $name)) { $name = "$name-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" }
    $selected = Join-Path $RuntimeDir $name
    Move-ExtractedRelease $staging.FullName $selected
    Set-Current $selected
    foreach ($file in 'foxwarmctl.ps1', 'foxwarmctl.cmd') { Copy-Item (Join-Path $Current $file) (Join-Path $Root $file) -Force }
    Write-Step "Installed $($next.version) (was $($installed.version))."
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($entry in Get-ChildItem -LiteralPath $RuntimeDir -Force) {
      if ($entry.Name -eq 'current' -or $entry.Name -eq $name) { continue }
      try { Remove-Item -LiteralPath $entry.FullName -Recurse -Force }
      catch { Write-Warning "Could not remove $($entry.FullName); it will be retried at the next update." }
    }
    if ($wasRunning) { Start-Foxwarm }
  } finally {
    if (Test-Path $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

switch ($Command) {
  'start' { Start-Foxwarm }
  'stop' { Stop-Foxwarm }
  'restart' {
    # Check that Main can be launched before stopping the running one.
    $null = @(Get-Launcher (Get-SelectedRelease))
    Stop-Foxwarm
    Start-Foxwarm
  }
  'status' { Show-Status }
  'run' {
    $release = Get-SelectedRelease
  $launcher = @(Get-Launcher $release)
    & $launcher[0] @($launcher | Select-Object -Skip 1) --installation-root $Root
    exit $LASTEXITCODE
  }
  'update' { Update-Foxwarm }
  'version' { Get-Content (Join-Path $Current 'release.json') -Raw | Write-Host }
  default { Show-Usage; if ($Command -notin 'help', '-h', '--help') { exit 2 } }
}
