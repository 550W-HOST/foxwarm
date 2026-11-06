namespace Foxwarm.Code;

internal sealed partial class CodeWorkbench
{
    internal static string InstallCommand(string assets, bool powershell)
    {
        var version = ProductVersion.Value;
        var asset = $"foxwarm-code-{version}.tar.gz";
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
                  $temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
                  New-Item -ItemType Directory -Path $temp | Out-Null
                  try {
                    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $temp $asset)
                    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $temp 'SHA256SUMS')
                    $line = @(Get-Content (Join-Path $temp 'SHA256SUMS') | Where-Object { $_.EndsWith("  $asset") })
                    if ($line.Count -ne 1) { throw 'Missing package checksum.' }
                    $expected = $line[0].Split(' ')[0]
                    if ((Get-FileHash (Join-Path $temp $asset) -Algorithm SHA256).Hash -ne $expected) { throw 'Package checksum failed.' }
                    New-Item -ItemType Directory -Force -Path $target | Out-Null
                    tar -xzf (Join-Path $temp $asset) -C $target
                    if ($LASTEXITCODE -ne 0) { throw 'Package extraction failed.' }
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
              temp="$(mktemp -d)"
              trap 'rm -rf "$temp"' EXIT
              curl -fL "$base/$asset" -o "$temp/$asset"
              curl -fL "$base/SHA256SUMS" -o "$temp/SHA256SUMS"
              (
                cd "$temp"
                awk -v name="$asset" '$2 == name { print }' SHA256SUMS > code.sha256
                if command -v sha256sum >/dev/null 2>&1; then sha256sum -c code.sha256; else shasum -a 256 -c code.sha256; fi
              )
              mkdir -p "$target"
              tar -xzf "$temp/$asset" -C "$target"
            )
            """;
    }
}
