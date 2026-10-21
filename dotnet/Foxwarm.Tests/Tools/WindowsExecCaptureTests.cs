using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WindowsExecCaptureTests
{
    private const string Command = "Write-Output 'formatted 雪'; [Console]::Out.WriteLine('direct 雪'); [Console]::Error.WriteLine('stderr 雪'); 'piped 雪' | & $env:ComSpec /d /c more; Set-Location $env:fw_tmp; & $env:ComSpec /d /c 'echo native-out& echo native-err 1>&2& exit /b 7'";

    [Fact]
    public async Task Main_direct_handles_capture_native_and_PowerShell_output_without_transcript_and_preserve_UTF8_status_and_cwd()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent space 雪"); Directory.CreateDirectory(agent);
        await using var manager = new LocalExecManager(Path.Combine(temp.Path, "data"), _ => agent, (_, _, _) => Task.CompletedTask);
        var result = await manager.ExecuteAsync("capture", new JsonObject { ["command"] = Command, ["timeout"] = 30 }, default, MainNativePaths.Default(agent));
        Assert.Contains("Exit code: 7", result["output"]!.ToString());
        await AssertArtifacts(agent);
    }

    [Fact]
    public async Task CLI_direct_handles_use_the_same_UTF8_wrapper_and_record_exact_native_exit()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var temp = new TempDirectory();
        var previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        var agent = Path.Combine(temp.Path, "agent space 雪"); Directory.CreateDirectory(agent);
        Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", agent);
        try
        {
            var paths = new NodePaths(agent);
            var registry = Path.Combine(agent, ".temp", "exec", "running-exec.json");
            await using var manager = new NodeExecManager(paths, registry, (_, _, _) => Task.CompletedTask);
            var record = await manager.Start(new JsonObject { ["sessionId"] = "main/capture", ["backgroundExecId"] = "quiet-otter", ["args"] = new JsonObject { ["command"] = Command } }, "main", "owned", default, () => { });
            var status = record["statusPath"]!.ToString();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (!File.Exists(status)) await Task.Delay(25, deadline.Token);
            Assert.Equal(7, JsonNode.Parse(await File.ReadAllTextAsync(status))!["exitCode"]!.GetValue<int>());
            await AssertArtifacts(agent);
        }
        finally { Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous); }
    }

    private static async Task AssertArtifacts(string agent)
    {
        var root = Path.Combine(agent, ".temp", "exec");
        var log = Assert.Single(Directory.GetFiles(root, "*.log", SearchOption.AllDirectories));
        var bytes = await File.ReadAllBytesAsync(log);
        var text = new UTF8Encoding(false, true).GetString(bytes);
        foreach (var expected in new[] { "formatted 雪", "direct 雪", "stderr 雪", "piped 雪", "native-out", "native-err" }) Assert.Contains(expected, text);
        Assert.DoesNotContain("transcript", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PowerShell session", text, StringComparison.OrdinalIgnoreCase);
        foreach (var script in Directory.GetFiles(root, "*.ps1", SearchOption.AllDirectories))
            Assert.True((await File.ReadAllBytesAsync(script)).AsSpan().StartsWith(Encoding.UTF8.Preamble));
        var cwd = log + ".cwd.txt";
        Assert.Equal(Path.Combine(agent, "tmp"), await File.ReadAllTextAsync(cwd));
        Assert.False((await File.ReadAllBytesAsync(cwd)).AsSpan().StartsWith(Encoding.UTF8.Preamble));
        Assert.False((await File.ReadAllBytesAsync(log + ".exit.json")).AsSpan().StartsWith(Encoding.UTF8.Preamble));
        Assert.Empty(Directory.GetFiles(root, "*.paths.json", SearchOption.AllDirectories));
    }
}
