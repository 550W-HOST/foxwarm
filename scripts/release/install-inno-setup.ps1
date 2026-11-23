# Installs the pinned Inno Setup compiler for the Windows Desktop installer into a directory and
# prints the path of its ISCC.exe. The installer's portable mode creates no uninstaller, Apps
# entry, shortcut or file association.
param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
# Windows PowerShell's download progress display slows Invoke-WebRequest down considerably.
$ProgressPreference = 'SilentlyContinue'

$version = '7.1.1'
$sha256 = '8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0'
$url = "https://github.com/jrsoftware/issrc/releases/download/is-$($version.Replace('.', '_'))/innosetup-$version-x64.exe"

New-Item -ItemType Directory -Force $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$installer = Join-Path ([IO.Path]::GetTempPath()) "innosetup-$version-x64.exe"
Invoke-WebRequest $url -OutFile $installer -UseBasicParsing
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
  throw "Checksum verification failed for $url"
}
$setup = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList @(
  '/PORTABLE=1', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER', '/NOICONS', "/DIR=`"$Destination`""
)
Remove-Item -LiteralPath $installer
if ($setup.ExitCode -ne 0) { throw "Inno Setup installation failed with exit code $($setup.ExitCode)" }
$iscc = Join-Path $Destination 'ISCC.exe'
if (-not (Test-Path -LiteralPath $iscc)) { throw "$iscc is missing" }
$iscc
