param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path $PSScriptRoot -Parent
Push-Location $RootDir
try {
  if ($SkipBuild) {
    & node scripts/windowsService.js restart
  } else {
    & npm run restart:windows
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
