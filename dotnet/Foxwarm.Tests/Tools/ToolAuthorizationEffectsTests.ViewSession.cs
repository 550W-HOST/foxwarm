using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Literal_Archive_lookup_keeps_isolated_same_Agent_guard_and_new_view_keeps_structural_denial()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true,"toolRules":[{"effect":"allow","source":"builtin","tool":"get_session_messages"}]}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var source = await manager.RequiredAsync("self");
        var same = await manager.RequiredAsync("kid");
        var foreign = await manager.RequiredAsync("outside");
        foreach (var owner in new[] { source, same, foreign })
            await ForkClearLifecycleTests.AppendAsync(owner, VectorFixture.Message("scoped literal evidence " + owner.Id));
        var execution = Executor(manager, source, temp.Path);
        await using var mcp = execution.Mcp;
        var self = await Call(execution.Tools, "recall", new JsonObject { ["text_query"] = "literal evidence" });
        Assert.Null(Error(self));
        Assert.Contains("scoped literal evidence", SessionWait.Text(self["output"]));
        var peer = await Call(execution.Tools, "recall", new JsonObject { ["text_query"] = "literal evidence", ["sessionId"] = same.Id });
        Assert.Null(Error(peer));
        var denied = await Call(execution.Tools, "recall", new JsonObject { ["text_query"] = "literal evidence", ["sessionId"] = foreign.Id });
        Assert.NotNull(Error(denied));
        Assert.Null(denied["output"]);
        Assert.NotNull(Error(await Call(execution.Tools, "view_session", new JsonObject { ["sessionId"] = source.Id })));
    }
}
