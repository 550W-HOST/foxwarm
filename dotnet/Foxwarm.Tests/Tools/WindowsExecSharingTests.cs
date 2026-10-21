using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WindowsExecSharingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Live_capture_allows_read_write_and_rename_while_command_remains_independent(bool cli)
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent space 雪");
        Directory.CreateDirectory(agent);
        var release = Path.Combine(agent, "release");
        var previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", agent);
        JsonObject? record = null;
        try
        {
            await using (var main = new LocalExecManager(
                Path.Combine(temp.Path, "data"),
                _ => agent,
                (_, _, _) => Task.CompletedTask
            ))
            await using (var node = new NodeExecManager(
                new NodePaths(agent),
                Path.Combine(agent, ".temp", "exec", "running-exec.json"),
                (_, _, _) => Task.CompletedTask
            ))
            {
                var command = "Write-Output 'ready'; while (-not (Test-Path -LiteralPath '"
                    + release.Replace("'", "''", StringComparison.Ordinal)
                    + "')) { Start-Sleep -Milliseconds 25 }; Write-Output 'finished'";
                if (cli)
                    record = await node.Start(
                        new JsonObject
                        {
                            ["sessionId"] = "main/sharing",
                            ["args"] = new JsonObject { ["command"] = command },
                        },
                        "main",
                        "owned",
                        default,
                        () => { }
                    );
                else
                {
                    var result = await main.ExecuteAsync(
                        "sharing",
                        new JsonObject { ["command"] = command, ["timeout"] = 1 },
                        default,
                        MainNativePaths.Default(agent)
                    );
                    Assert.Contains("Switched to background", result["output"]!.ToString());
                    record = Assert.Single(main.Tracked);
                }
            }
            // Observer disposal must not stop the real command or retain its capture.
            using var child = Process.GetProcessById(int.Parse(record["pid"]!.ToString(), CultureInfo.InvariantCulture));
            Assert.False(child.HasExited);
            Assert.Equal("powershell", child.ProcessName, ignoreCase: true);
            var log = record["logPath"]!.ToString();
            using (File.Open(log, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) { }
            var moved = log + ".moved";
            File.Move(log, moved);
            Assert.False(child.HasExited);
            await File.WriteAllTextAsync(release, "finish");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await child.WaitForExitAsync(deadline.Token);
            Assert.Contains("finished", await File.ReadAllTextAsync(moved));
            Assert.Equal(0, JsonNode.Parse(await File.ReadAllTextAsync(record["statusPath"]!.ToString()))!["exitCode"]!.GetValue<int>());
        }
        finally
        {
            try
            {
                await File.WriteAllTextAsync(release, "finish");
                if (record is not null)
                {
                    try
                    {
                        using var child = Process.GetProcessById(int.Parse(record["pid"]!.ToString(), CultureInfo.InvariantCulture));
                        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                        await child.WaitForExitAsync(deadline.Token);
                    }
                    catch (ArgumentException) { }
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous);
            }
        }
    }
}
