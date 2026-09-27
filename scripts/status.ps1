$ErrorActionPreference = 'Stop'
$RootDir = Split-Path $PSScriptRoot -Parent
Push-Location $RootDir
try {
  & node scripts/windowsService.js status
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
