$ErrorActionPreference = 'Stop'
$RootDir = Split-Path $PSScriptRoot -Parent
Push-Location $RootDir
try {
  & node scripts/windowsService.js stop
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
