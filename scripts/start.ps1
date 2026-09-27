param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path $PSScriptRoot -Parent
Push-Location $RootDir
try {
  if ($SkipBuild) {
    & node scripts/windowsService.js start
  } else {
    & npm run start:windows
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
