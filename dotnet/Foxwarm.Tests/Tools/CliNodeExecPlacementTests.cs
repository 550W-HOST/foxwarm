using System.Text.Json.Nodes;
using Foxwarm.CliNode;

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
        Assert.Equal((temp.Path, temp.Path, "session"), paths.ExecCwd(null, temp.Path, "main", "n"));
        Assert.Equal((temp.Path, null, "default"), paths.ExecCwd(null, null, null, "n"));

        var tools = new NodeFileTools(paths);
        Assert.Equal(
            agent,
            (await tools.Execute("get_default_cwd", null, "main", null, false))["output"]!
                .GetValue<string>()
        );
        Assert.Equal(
            temp.Path,
            (await tools.Execute("get_default_cwd", null, null, null, false))["output"]!
                .GetValue<string>()
        );
    }
}
