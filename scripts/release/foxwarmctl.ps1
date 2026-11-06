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
    $value = if (Test-Path $pointer) { ([string](Get-Content $pointer -Raw)).Trim() } else { '' }
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
    return $reader.ReadToEnd() | ConvertFrom-Json
  } finally { $pipe.Dispose() }
}

function Get-Status {
  try {
    $status = Invoke-Control 'status'
    if ($status.ok) { return $status }
  } catch { }
  return $null
}

function Test-Pid($ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
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
  if (-not $dotnet) { throw 'This package needs the ASP.NET Core 10 runtime and dotnet on PATH.' }
  return @($dotnet.Source, (Join-Path $Directory 'Foxwarm.dll'))
}

function Start-Foxwarm {
  $existing = Get-Status
  if ($existing) { throw "Foxwarm is already running (PID $($existing.pid))." }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # Resolve the selected release now so a later update does not move a running Main.
  $release = Get-SelectedRelease
  $launcher = @(Get-Launcher $release)
  $commandLine = ($launcher | ForEach-Object { "`"$_`"" }) -join ' '
  $env:FOXWARM_WINDOWS_CONTROL_PIPE = $PipeName
  $env:FOXWARM_MAIN_LIFETIME_PIPE = $null
  # cmd appends both streams to the lifecycle logs and keeps no console attached to this window.
  $line = "/d /s /c `"$commandLine --installation-root `"$Root`" --windows-background >> `"$StdoutLog`" 2>> `"$StderrLog`"`""
  Start-Process -FilePath $env:ComSpec -ArgumentList $line -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 300
    $status = Get-Status
  } while (-not $status -and (Get-Date) -lt $deadline)
  if (-not $status) { throw "Foxwarm did not start. Check $StderrLog" }
  Write-Step "Started $((Read-Release $release).version) from $release in the background (PID $($status.pid))."
  Write-Step "Data:   $DataRoot"
  Write-Step "Logs:   $LogDir"
}

function Stop-Foxwarm {
  $status = Get-Status
  if (-not $status) {
    Write-Step 'Foxwarm is not running.'
    return
  }
  $processId = [int]$status.pid
  try { Invoke-Control 'stop' | Out-Null } catch { Write-Warning "Stop request failed: $_" }
  $deadline = (Get-Date).AddSeconds($StopSeconds)
  while ((Test-Pid $processId) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (Test-Pid $processId) {
    Write-Warning "Foxwarm did not stop within $StopSeconds seconds; terminating PID $processId."
    Stop-Process -Id $processId -Force
    Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
  }
  Write-Step 'Foxwarm stopped.'
}

function Show-Status {
  $status = Get-Status
  if (-not $status) {
    '[foxwarm] Not running.'
    exit 3
  }
  $release = Read-Release $Current
  "[foxwarm] Running (PID $($status.pid)$(if ($status.stopping) { ', stopping' })), release $($release.version) $($release.target)."
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
      Invoke-WebRequest "$base/$($installed.asset)" -OutFile $archive -UseBasicParsing
      Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $scratch 'SHA256SUMS') -UseBasicParsing
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
    $wasRunning = [bool](Get-Status)
    if ($wasRunning) { Stop-Foxwarm }
    $name = $next.version
    if (Test-Path (Join-Path $RuntimeDir $name)) { $name = "$name-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" }
    $selected = Join-Path $RuntimeDir $name
    Move-Item -LiteralPath $staging.FullName -Destination $selected
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
  'restart' { Stop-Foxwarm; Start-Foxwarm }
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
