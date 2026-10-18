#!/usr/bin/env bash
# Run after installing the repository's npm dependencies and the .NET 10 SDK.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:?Usage: dotnet/scripts/publish-desktop.sh OUTPUT_DIRECTORY}"
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
if [[ -n "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Use an empty output directory." >&2
  exit 1
fi
cd "$root"
npm run build:assets
dotnet publish dotnet/Foxwarm.Desktop -c Release -r win-x64 --self-contained false \
  -p:EnableWindowsTargeting=true -p:DebugType=None -p:DebugSymbols=false -o "$output"
# Symbols and XML API reference files are build/debug artifacts, not runtime assets.
find "$output" -type f \( -name '*.pdb' -o -name '*.xml' \) -delete
# The desktop references the host assembly; it does not launch the console apphost.
rm -f "$output/Foxwarm.exe" "$output/Foxwarm.runtimeconfig.json"
printf 'Desktop package prepared in %s\n' "$output"
