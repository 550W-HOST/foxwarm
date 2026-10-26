using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    [Theory]
    [InlineData(@"C:\node's [root]\雪", @"..\other's [dir]\雪")]
    [InlineData(@"\\server\share\node's root", @"D:\other's [dir]\雪")]
    public async Task Windows_dialect_keeps_remote_path_semantics_on_any_Main_host(
        string startup,
        string cwd
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start(register: false);
        using var registered = await fixture.Request(
            "register",
            Encoding.UTF8.GetBytes(startup),
            new() { ["X-Foxwarm-Shell-Dialect"] = "powershell" }
        );
        Assert.Equal(HttpStatusCode.NoContent, registered.StatusCode);
        fixture.Connection = registered.Headers.GetValues("X-Foxwarm-Connection").Single();
        Assert.Equal(startup, fixture.Manager.Nodes.ShellDefaultCwd("shell"));
        var node = Assert.Single(fixture.Manager.Nodes.List().OfType<JsonObject>());
        Assert.Equal("exec", Assert.Single(node["tools"]!.AsArray())!["name"]!.GetValue<string>());
        Assert.Empty(node["services"]!.AsObject());
        const string command = "[Console]::Write('雪 ''$literal`'); exit -1073741819";
        var execution = fixture.Exec(new JsonObject { ["command"] = command, ["cwd"] = cwd });
        var task = await fixture.Poll();
        Assert.Equal(
            "try { Set-Location -LiteralPath '"
                + startup.Replace("'", "''")
                + "' -ErrorAction Stop; Set-Location -LiteralPath '"
                + cwd.Replace("'", "''")
                + "' -ErrorAction Stop } catch { Write-Error $_; exit 125 }\n"
                + command
                + "\n",
            task.Script
        );
        using var completed = await fixture.Report(
            task.Task,
            true,
            Encoding.UTF8.GetBytes("雪"),
            exit: "-1073741819"
        );
        Assert.Equal(HttpStatusCode.NoContent, completed.StatusCode);
        Assert.Equal(-1073741819, (await execution)!["exitCode"]!.GetValue<int>());
        using var invalidDialect = await fixture.Request(
            "register",
            Encoding.UTF8.GetBytes(startup),
            new() { ["X-Foxwarm-Shell-Dialect"] = "unknown" }
        );
        Assert.Equal(HttpStatusCode.BadRequest, invalidDialect.StatusCode);
        using var relativeStartup = await fixture.Request(
            "register",
            Encoding.UTF8.GetBytes("relative"),
            new() { ["X-Foxwarm-Shell-Dialect"] = "powershell" }
        );
        Assert.Equal(HttpStatusCode.BadRequest, relativeStartup.StatusCode);
    }

    [Fact]
    public async Task Generated_Windows_bootstrap_binds_literals_and_preserves_saved_and_memory_directory_ownership()
    {
        // Portable PowerShell checks script semantics only; native Windows qualification is separate.
        var engine = OperatingSystem.IsWindows() ? "powershell.exe" : "pwsh";
        var enginePath = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator)
            .Select(directory => Path.Combine(directory, engine))
            .FirstOrDefault(File.Exists);
        if (enginePath is null)
            return;
        await using var fixture = new Fixture();
        await fixture.Start(register: false, bootstrap: true);
        var launcher = await fixture.Client.GetStringAsync("/node/run.ps1");
        using var shell = await fixture.Client.GetAsync("/node/run-shell.ps1");
        shell.EnsureSuccessStatusCode();
        Assert.DoesNotContain(
            "__FOXWARM_DEFAULT_BASE_URL__",
            await shell.Content.ReadAsStringAsync()
        );
        var bootstrap = new NodeBootstrap(
            fixture.Manager.Nodes,
            new PublicWebAddress("http://example.invalid", "", "/", false)
        );
        const string url = "https://example.invalid/mount'path/$literal";
        const string credential = "literal'$credential`";
        foreach (var memory in new[] { false, true })
        {
            var scriptDir = Path.Combine(fixture.Temp.Path, "saved launcher ' [雪]");
            var caller = Path.Combine(
                fixture.Temp.Path,
                memory ? "memory caller ' [雪]" : "saved caller ' [雪]"
            );
            Directory.CreateDirectory(scriptDir);
            Directory.CreateDirectory(caller);
            var capture = Path.Combine(caller, "capture.json");
            var saved = Path.Combine(scriptDir, "run.ps1");
            await File.WriteAllTextAsync(saved, launcher);
            string Quote(string value) => "'" + value.Replace("'", "''") + "'";
            var generated = bootstrap.Commands(url, "literal-node", authToken: credential)[
                "commands"
            ]!["windows"]!.GetValue<string>();
            var harness = Path.Combine(caller, "harness.ps1");
            await File.WriteAllTextAsync(
                harness,
                """
                $ErrorActionPreference = 'Stop'
                function Invoke-WebRequest {
                    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
                    if ($OutFile) { [IO.File]::WriteAllText($OutFile, 'fixture'); return }
                    [PSCustomObject]@{Content=[IO.File]::ReadAllText($env:FIXTURE_LAUNCHER)}
                }
                function tar {
                    $target = $args[[Array]::IndexOf($args, '-C') + 1]
                    $entry = Join-Path $target 'packages/cli-node/dist/client.bundle.js'
                    New-Item -ItemType Directory -Force -Path (Split-Path $entry) | Out-Null
                    [IO.File]::WriteAllText($entry, 'fixture')
                    $global:LASTEXITCODE = 0
                }
                function node {
                    [PSCustomObject]@{
                        cwd=(Get-Location).Path
                        agents=$env:FOXWARM_AGENTS_DIR
                        agent=$env:FOXWARM_AGENT_DIR
                        args=@($args)
                    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:FIXTURE_CAPTURE -Encoding UTF8
                    $global:LASTEXITCODE = 0
                }
                """
                    + "\n"
                    + (
                        memory
                            ? generated
                            : "& "
                                + Quote(saved)
                                + " -HostUrl "
                                + Quote(url)
                                + " -AuthToken "
                                + Quote(credential)
                                + " -NodeId 'literal-node'"
                    )
            );
            var start = new ProcessStartInfo(enginePath)
            {
                WorkingDirectory = caller,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            if (OperatingSystem.IsWindows())
            {
                start.ArgumentList.Add("-ExecutionPolicy");
                start.ArgumentList.Add("RemoteSigned"); // Process-only test scope permits the intentionally saved launcher.
            }
            foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File", harness })
                start.ArgumentList.Add(argument);
            start.Environment["FIXTURE_CAPTURE"] = capture;
            start.Environment["FIXTURE_LAUNCHER"] = saved;
            start.Environment["FOXWARM_AGENT_DIR"] = "hostile-single-agent";
            start.Environment["FOXWARM_AGENTS_DIR"] = "hostile-agent-root";
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.True(process.ExitCode == 0, (await output) + (await errors));
            var result = JsonNode.Parse(await File.ReadAllTextAsync(capture))!;
            var expected = memory ? caller : scriptDir;
            Assert.Equal(expected, result["cwd"]!.GetValue<string>());
            Assert.Equal(
                Path.Combine(expected, "data", "agents"),
                result["agents"]!.GetValue<string>()
            );
            Assert.True(string.IsNullOrEmpty(result["agent"]?.GetValue<string>()));
            var args = result["args"]!
                .AsArray()
                .Select(value => value!.GetValue<string>())
                .ToArray();
            Assert.Contains(url, args);
            Assert.Contains(credential, args);
            Assert.Contains(Path.Combine(expected, "data", "state", "node_credentials.json"), args);
            Assert.Contains(
                Path.Combine(
                    expected,
                    "foxwarm-node",
                    "packages",
                    "cli-node",
                    "dist",
                    "client.bundle.js"
                ),
                args
            );
            Assert.False(File.Exists(Path.Combine(caller, "run.ps1")));
        }
    }
}
