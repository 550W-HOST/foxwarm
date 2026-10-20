using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Hidden_management_tools_remain_discoverable_explicitly_callable_and_policy_controlled()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        string[] hidden = ["set_session_child_model", "set_session_compact_threshold", "refresh_session_snapshot", "compact_session", "create_agent", "create_session", "set_agent_inherit"];
        foreach (var name in hidden)
        {
            Assert.False(execution.Registry.Entries.Single(entry => entry.Definition["name"]!.GetValue<string>() == name).DefaultInject);
            Assert.DoesNotContain(manager.ModelDefinitions(owner), definition => definition?["name"]?.GetValue<string>() == name);
            var search = await Call(execution.Tools, "search_tools", new JsonObject { ["query"] = name, ["sources"] = new JsonArray("builtin"), ["includeSchema"] = false });
            Assert.Contains("builtin:" + name, search["output"]!.GetValue<string>());
        }
        var result = await Call(execution.Tools, "call_tool", new JsonObject
        {
            ["source"] = "builtin",
            ["name"] = "set_session_compact_threshold",
            ["args"] = new JsonObject { ["thresholdTokens"] = 1234 },
        });
        Assert.Null(Error(result));
        Assert.Equal(1234, owner.Entry.Snapshot().AuthorityEnvelope["compactThresholdTokens"]!.GetValue<double>());
        await Policy(manager, "version: 1\nrules:\n- id: settings\n  action: deny\n  match: {tool: {source: builtin, name: set_session_compact_threshold}}\n");
        var denied = await Call(execution.Tools, "call_tool", new JsonObject
        {
            ["source"] = "builtin",
            ["name"] = "set_session_compact_threshold",
            ["args"] = new JsonObject { ["thresholdTokens"] = 2222 },
        });
        Assert.Equal("tool_authorization_denied", Error(denied));
        Assert.Equal(1234, owner.Entry.Snapshot().AuthorityEnvelope["compactThresholdTokens"]!.GetValue<double>());
        var filtered = await Call(execution.Tools, "search_tools", new JsonObject { ["query"] = "set_session_compact_threshold", ["sources"] = new JsonArray("builtin") });
        Assert.DoesNotContain("builtin:set_session_compact_threshold", filtered["output"]!.GetValue<string>());
        var explicitOverride = new JsonArray(new JsonObject { ["name"] = "set_session_compact_threshold" });
        Assert.True(JsonNode.DeepEquals(explicitOverride, manager.ModelDefinitions(owner, explicitOverride)));
        await manager.ShutdownAsync();
    }
}
