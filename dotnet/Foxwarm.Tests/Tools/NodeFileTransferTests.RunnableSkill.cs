using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task A_skill_entry_is_read_on_Main_while_the_Session_works_on_a_remote_Node()
    {
        if (!OperatingSystem.IsLinux() || !Foxwarm.ToolScript.MontyWorker.IsSupported)
            return;
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        Assert.Equal("resident", f.Manager.CurrentNode(f.Owner));
        // An Agent-local skill of main, on the Main server.
        RunnableSkillTests.WriteSkill(
            Path.Combine(f.Work, "skills"),
            "local",
            "run:\n  entry: scripts/run.py\n  effect: Returns its input.\n  args:\n    type: object\n    properties:\n      n: {type: integer}\n",
            code: "return {'n': args['n'], 'from': 'entry'}\n"
        );
        await using var mcp = new Foxwarm.McpClient(Foxwarm.Net.EgressPolicy.Unguarded, f.Data);
        var definitions = ToolScriptToolDefinitions.Definitions();
        foreach (var item in UnifiedToolDefinitions.All())
            definitions.Add(item?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => f.Work,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        var result = (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["name"] = "ctl",
                    ["args"] = new JsonObject
                    {
                        ["command"] = "skill run local --args @a",
                        ["values"] = new JsonObject { ["a"] = new JsonObject { ["n"] = 4 } },
                    },
                },
                default
            )
        )!.AsObject();
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal(4, result["result"]!["n"]!.GetValue<int>());
        var record = await f.Manager.ToolScript.Store.ReadAsync(SessionWait.Text(result["runId"])!, default);
        Assert.Equal("agent-local", SessionWait.Text(record!["sourceSkill"]!["sourceType"]));
        Assert.Null(record["sourceNode"]);
        // Nothing reached the remote Node: the next frame answers our ping.
        await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", SessionWait.Text((await Fixture.Read(socket))["type"]));
    }
}
