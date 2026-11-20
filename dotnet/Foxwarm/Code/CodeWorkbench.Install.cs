namespace Foxwarm.Code;

internal sealed partial class CodeWorkbench
{
    internal static string InstallCommand(string assets, bool powershell)
    {
        var version = ProductVersion.Value;
        var asset = $"foxwarm-code-{version}.fwassets";
        var url = $"https://github.com/550W-HOST/foxwarm/releases/download/v{version}";
        if (powershell)
        {
            var target = assets.Replace("'", "''");
            return $$"""
                & {
                  $ErrorActionPreference = 'Stop'
                  $asset = '{{asset}}'
                  $base = '{{url}}'
                  $target = '{{target}}'
                  New-Item -ItemType Directory -Force -Path $target | Out-Null
                  $temp = Join-Path $target ('.foxwarm-code-' + [guid]::NewGuid().ToString())
                  New-Item -ItemType Directory -Path $temp | Out-Null
                  try {
                    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $temp $asset)
                    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $temp 'SHA256SUMS')
                    $line = @(Get-Content (Join-Path $temp 'SHA256SUMS') | Where-Object { $_.EndsWith("  $asset") })
                    if ($line.Count -ne 1) { throw 'Missing package checksum.' }
                    $expected = $line[0].Split(' ')[0]
                    if ((Get-FileHash (Join-Path $temp $asset) -Algorithm SHA256).Hash -ne $expected) { throw 'Package checksum failed.' }
                    Move-Item -LiteralPath (Join-Path $temp $asset) -Destination (Join-Path $target 'foxwarm.assets') -Force
                  } finally { Remove-Item -LiteralPath $temp -Recurse -Force }
                }
                """;
        }
        var directory = assets.Replace("'", "'\"'\"'");
        return $$"""
            (
              set -eu
              asset='{{asset}}'
              base='{{url}}'
              target='{{directory}}'
              mkdir -p "$target"
              temp="$(mktemp -d "$target/.foxwarm-code.XXXXXX")"
              trap 'rm -rf "$temp"' EXIT
              curl -fL "$base/$asset" -o "$temp/$asset"
              curl -fL "$base/SHA256SUMS" -o "$temp/SHA256SUMS"
              (
                cd "$temp"
                awk -v name="$asset" '$2 == name { print }' SHA256SUMS > code.sha256
                if command -v sha256sum >/dev/null 2>&1; then sha256sum -c code.sha256; else shasum -a 256 -c code.sha256; fi
              )
              mv "$temp/$asset" "$target/foxwarm.assets"
            )
            """;
    }
}
