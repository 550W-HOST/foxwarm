using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Terminal;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WindowsLocalToolsTests
{
    [Fact]
    public async Task PowerShell_preserves_unicode_exit_location_and_independent_lifetime()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var agent = Path.Combine(temp.Path, "agent space 雪");
        Directory.CreateDirectory(agent);
        var data = Path.Combine(temp.Path, "data");
        var paths = MainNativePaths.Default(agent);
        var manager = new LocalExecManager(data, _ => agent, (_, _, _) => Task.CompletedTask);
        var first = await manager.ExecuteAsync(
            "windows",
            new JsonObject
            {
                ["command"] = "Write-Output 'snow 雪'; Set-Location $env:fw_tmp; cmd /c exit 7",
            },
            default,
            paths
        );
        Assert.Contains("snow 雪", first["output"]!.GetValue<string>());
        Assert.Contains("Exit code: 7", first["output"]!.GetValue<string>());
        var completed = Assert.Single(
            Directory.GetFiles(
                Path.Combine(agent, ".temp", "exec"),
                "*.cwd.txt",
                SearchOption.AllDirectories
            )
        );
        Assert.Equal(Path.Combine(agent, "tmp"), (await File.ReadAllTextAsync(completed)).Trim());

        var marker = Path.Combine(agent, "once.txt");
        var second = await manager.ExecuteAsync(
            "windows",
            new JsonObject
            {
                ["command"] =
                    "Start-Sleep -Seconds 3; Add-Content -LiteralPath '"
                    + marker.Replace("'", "''")
                    + "' -Value once",
                ["timeout"] = 1,
            },
            default,
            paths
        );
        Assert.Contains("Switched to background", second["output"]!.GetValue<string>());
        await manager.DisposeAsync();
        // A fresh manager observes the same owned command. It never relaunches it.
        await using var reopened = new LocalExecManager(
            data,
            _ => agent,
            (_, _, _) => Task.CompletedTask
        );
        await reopened.InitializeAsync(id => id == "windows");
        var execId = System
            .Text.RegularExpressions.Regex.Match(
                second["output"]!.GetValue<string>(),
                "execId: ([a-z]+-[a-z]+)"
            )
            .Groups[1]
            .Value;
        Assert.NotEmpty(execId);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!File.Exists(marker))
            await Task.Delay(50, deadline.Token);
        await reopened.ReconcileNowAsync();
        Assert.Equal(new[] { "once" }, await File.ReadAllLinesAsync(marker));
    }

    [Fact]
    public async Task ConPty_supports_real_input_resize_and_explicit_close()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        await using var terminals = new TerminalRegistry(temp.Path, default);
        var terminal = await terminals.CreateAsync("/", 100, 30, default);
        var before = terminal.Describe();
        Assert.True(before["pid"]!.GetValue<int>() > 0);
        Assert.Equal(
            Foxwarm.Code.CodeNativePaths.Transport(Path.GetPathRoot(Environment.CurrentDirectory)!),
            before["cwd"]!.GetValue<string>()
        );
        await terminal.InputAsync("Write-Output 'native 雪'\r");
        terminal.Resize(120, 40);
        Assert.Equal(120, terminal.Describe()["cols"]!.GetValue<int>());
        Assert.Equal(40, terminal.Describe()["rows"]!.GetValue<int>());
        await terminal.CloseAsync("test").WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Empty(terminals.List());
    }
}
