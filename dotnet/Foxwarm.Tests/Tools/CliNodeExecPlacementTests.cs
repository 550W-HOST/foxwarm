using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class CliNodeExecPlacementTests
{
    [Fact]
    public async Task Session_exec_and_default_cwd_use_the_agent_directory_while_external_keeps_startup()
    {
        using var temp = new TempDirectory();
        var paths = new NodePaths(temp.Path);
        var agent = paths.AgentDirectory("main");
        Directory.CreateDirectory(Path.Combine(agent, "sub"));
        Directory.CreateDirectory(Path.Combine(temp.Path, "sub"));

        Assert.Equal((agent, null, "default"), paths.ExecCwd(null, null, "main", "n"));
        Assert.Equal(
            (Path.Combine(agent, "sub"), "sub", "explicit"),
            paths.ExecCwd(JsonValue.Create("sub"), null, "main", "n")
        );
        Assert.Equal(
            (Path.Combine(temp.Path, "sub"), "sub", "explicit"),
            paths.ExecCwd(JsonValue.Create("sub"), temp.Path, "main", "n")
        );
        Assert.Equal(
            (temp.Path, temp.Path, "session"),
            paths.ExecCwd(null, temp.Path, "main", "n")
        );
        Assert.Equal((temp.Path, null, "default"), paths.ExecCwd(null, null, null, "n"));

        var tools = new NodeFileTools(paths);
        Assert.Equal(
            agent,
            (await tools.Execute("get_default_cwd", null, "main", null, false))[
                "output"
            ]!.GetValue<string>()
        );
        Assert.Equal(
            temp.Path,
            (await tools.Execute("get_default_cwd", null, null, null, false))[
                "output"
            ]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Exec_result_reports_placement_only_when_main_requests_it(bool requested)
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var paths = new NodePaths(temp.Path);
        var agent = paths.AgentDirectory("main");
        var final = Path.Combine(agent, "sub");
        Directory.CreateDirectory(final);
        string? launchedIn = null;
        await using var manager = new NodeExecManager(
            paths,
            Path.Combine(agent, ".temp", "exec", "running-exec.json"),
            (_, _, _) => Task.CompletedTask
        )
        {
            Launch = start =>
            {
                launchedIn = start.WorkingDirectory;
                var log = Path.Combine(temp.Path, "owned.log");
                File.WriteAllText(log + ".cwd.txt", final + "\n");
                File.WriteAllText(
                    start.Environment["FOXWARM_EXEC_PATHS_PATH"]!,
                    new JsonObject
                    {
                        ["logPath"] = log,
                        ["statusPath"] = log + ".exit.json",
                        ["cwdPath"] = log + ".cwd.txt",
                    }.ToJsonString()
                );
                return Environment.ProcessId;
            },
        };
        var frame = new JsonObject
        {
            ["sessionId"] = "main/owned",
            ["backgroundExecId"] = "quiet-otter",
            ["args"] = new JsonObject { ["command"] = "cd sub" },
        };
        if (requested)
            frame[ExecPlacement.Feature] = true;
        var entry = await manager.Start(frame, "main", "owned", default, () => { });
        Assert.Equal(agent, launchedIn);
        var result = await NodeClient.WithPlacement(
            new JsonObject { ["output"] = "ok" },
            entry,
            frame,
            completed: true
        );
        await manager.Remove(entry);
        if (!requested)
        {
            Assert.False(result.ContainsKey(ExecPlacement.Field));
            return;
        }
        var placement = ExecPlacement.Parse(result[ExecPlacement.Field])!;
        Assert.Equal(agent, placement["cwd"]!.GetValue<string>());
        Assert.Equal("default", placement["cwdSource"]!.GetValue<string>());
        Assert.Equal("quiet-otter", placement["execId"]!.GetValue<string>());
        Assert.Equal(final, placement["finalCwd"]!.GetValue<string>());
        Assert.Equal(
            Path.Combine(temp.Path, "owned.log"),
            placement["logPath"]!.GetValue<string>()
        );
    }
}
