using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    private static JsonObject Obj(string text) => JsonNode.Parse(text)!.AsObject();
    private static JsonArray Rules(string text) => JsonNode.Parse(text)!.AsArray();

    private static async Task<ExternalChannelFixture> Fixture()
    {
        var f = await ExternalChannelFixture.CreateAsync();
        var definitions = WorkspaceTools.Definitions();
        foreach (var item in AgentToolDefinitions.Definitions()
            .Concat(KnowledgeToolDefinitions.Definitions())
            .Concat(ObservationToolDefinitions.Definitions())
            .Concat(TimerToolDefinitions.Definitions().OfType<JsonObject>())
            .Concat(UnifiedToolDefinitions.All().OfType<JsonObject>())
            .Concat(ToolScriptToolDefinitions.Definitions().OfType<JsonObject>()))
            definitions.Add(HandoffConfirmation.Definition(item, f.Manager.HandoffConfirmationEnabled));
        f.Registry = SessionToolExecutor.CreateRegistry(definitions, f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory, f.Manager.Nodes, f.Manager.NodeProviders);
        return f;
    }

    private static void Successful(JsonNode? result) =>
        Assert.True(result is JsonObject && result["error"] is null, result?.ToJsonString());
    private static void Denied(JsonNode? result) => Assert.NotNull(result?["error"]);

    private static async Task<SessionOwner> ChildAgent(ExternalChannelFixture f, string name, SessionOwner? caller = null, JsonArray? rules = null)
    {
        var args = new JsonObject { ["agentName"] = name };
        if (rules is not null)
            args["rules"] = rules.DeepClone();
        Successful(await f.ToolAsync("create_agent", args, caller));
        return await f.Manager.RequiredAsync(name + "/main");
    }

    [Fact]
    public void Local_rules_reuse_ordered_v1_catch_all_without_caller_selectors()
    {
        foreach (var key in new[] { "agent", "session", "sessionPattern", "externalId" })
        foreach (var legacy in new[] { false, true })
        {
            var rule = new JsonObject { ["action"] = "deny" };
            if (legacy)
                rule["match"] = new JsonObject { [key] = "caller" };
            else
                rule[key] = "caller";
            Assert.Throws<InvalidDataException>(() => AgentRulePolicy.Parse(new JsonArray(rule)));
        }
        var policy = AgentRulePolicy.Parse(Rules("""[{"action":"allow","tool":"read"},{"action":"deny"}]"""));
        var request = new ToolAuthorizationRequest("node", "read", null, new(), [], "child", "child/main", "master", ".", ".", ".");
        Assert.True(ToolAuthorizationEvaluation.Evaluate(policy, request).Allowed);
        Assert.False(ToolAuthorizationEvaluation.Evaluate(policy, request with { Name = "exec" }).Allowed);
        var yaml = ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\nrules:\n  - action: deny\n"));
        Assert.False(ToolAuthorizationEvaluation.Evaluate(yaml, request).Allowed);
        Assert.True(ToolAuthorizationEvaluation.Evaluate(AgentRulePolicy.Parse(new JsonArray()), request).Allowed);
    }

    [Fact]
    public async Task Actual_caller_and_initial_rules_are_published_together_for_creation_and_conversion()
    {
        await using var f = await Fixture();
        await f.Manager.CreateAgentAsync("selected-source");
        var source = await f.Manager.RequiredAsync("selected-source/main");
        var initial = Rules("""[{"action":"deny","tool":"skill"}]""");
        foreach (var convert in new[] { false, true })
        {
            var name = convert ? "converted" : "fresh";
            var observedInitialAuthority = false;
            void ObserveInitial()
            {
                var published = f.Manager.AgentMetadata[name]!;
                Assert.Equal("main", SessionWait.Text(published["createdBy"]));
                Assert.True(JsonNode.DeepEquals(initial, published["rules"]));
                observedInitialAuthority = true;
            }
            f.Manager.BeforeCreationPublication = id => { if (id == name + "/main") ObserveInitial(); return Task.CompletedTask; };
            f.Manager.BeforeIdentityStage = (_, stage) => { if (convert && stage == "after-agent-copy") ObserveInitial(); return Task.CompletedTask; };
            Successful(await f.ToolAsync("create_agent", new JsonObject
            {
                ["agentName"] = name,
                ["sourceSessionId"] = source.Id,
                ["convertSession"] = convert,
                ["rules"] = initial.DeepClone(),
                ["defaultNode"] = "offline-default",
            }));
            Assert.True(observedInitialAuthority);
            var metadata = f.Manager.AgentMetadata[name]!;
            Assert.Equal("main", SessionWait.Text(metadata["createdBy"]));
            Assert.True(JsonNode.DeepEquals(initial, metadata["rules"]));
            Assert.Equal("offline-default", SessionWait.Text(metadata["defaultNode"]));
            var target = await f.Manager.RequiredAsync(name + "/main");
            Denied(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, target));
        }
        Assert.Null(f.Manager.AgentMetadata["selected-source"]?["createdBy"]);
        var disk = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "agents.json")))!;
        Assert.Equal("main", SessionWait.Text(disk["metadata"]!["converted"]!["createdBy"]));
    }

    [Fact]
    public async Task Fixed_initiator_layers_only_narrow_and_use_initiator_paths_with_live_visibility()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var local = Rules("""[{"action":"allow","tool":"write"},{"action":"deny","tool":"exec"}]""");
        await f.Manager.SetAgentRulesAsync("grand", local);
        var path = Path.Combine(f.Manager.AgentDirectory(grand.Agent), "own.txt");
        Successful(await f.ToolAsync("write", new JsonObject { ["filePath"] = path, ["content"] = "own" }, grand));
        var parentLayer = Rules("""[{"action":"allow","tool":"write","path":{"allWithin":"${agent.dir}"}},{"action":"deny","tool":"write"}]""");
        await f.Manager.SetAgentRulesAsync("child", parentLayer);
        Successful(await f.ToolAsync("write", new JsonObject { ["filePath"] = path, ["content"] = "still own", ["overwrite"] = true }, grand));
        var outside = Path.Combine(f.Manager.AgentDirectory("child"), "outside.txt");
        Denied(await f.ToolAsync("write", new JsonObject { ["filePath"] = outside, ["content"] = "blocked" }, grand));
        Assert.False(File.Exists(outside));
        // The same concrete initiator/request remains denied even if its own layer explicitly allows it.
        Denied(await f.ToolAsync("exec", new JsonObject { ["command"] = "echo blocked" }, grand));
        Assert.False(f.Manager.ToolVisible(grand, "node", "exec", node: "master"));
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"deny","tool":"skill"}]"""));
        Assert.False(f.Manager.ToolVisible(grand, "builtin", "skill"));
        Assert.DoesNotContain(f.Manager.ModelDefinitions(grand), item => SessionWait.Text(item?["name"]) == "skill");
        var discovered = await f.ToolAsync("search_tools", new JsonObject { ["query"] = "skill", ["sources"] = new JsonArray("builtin") }, grand);
        Successful(discovered);
        Assert.DoesNotContain("builtin:skill", discovered!["output"]!.GetValue<string>());
        Denied(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, grand));
        await f.Manager.SetAgentRulesAsync("child", new JsonArray());
        Assert.True(f.Manager.ToolVisible(grand, "builtin", "skill"));
        Successful(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, grand));
        await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes("version: 1\nrules: [{agent: grand, tool: skill, action: deny}]\n"), default);
        Denied(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, grand));
    }

    [Fact]
    public async Task Rule_setter_requires_a_strict_ancestor_and_its_own_current_policy()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var sibling = await ChildAgent(f, "sibling");
        foreach (var target in new[] { "main", "child", "sibling" })
            Denied(await f.ToolAsync("set_agent_rules", new JsonObject { ["agentName"] = target, ["rules"] = new JsonArray() }, child));
        Successful(await f.ToolAsync("call_tool", new JsonObject
        {
            ["source"] = "builtin", ["name"] = "set_agent_rules", ["args"] = new JsonObject { ["agentName"] = "grand", ["rules"] = Rules("""[{"action":"deny","tool":"skill"}]""") },
        }, child));
        Denied(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, grand));
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"deny","tool":"set_agent_rules"}]"""));
        Denied(await f.ToolAsync("set_agent_rules", new JsonObject { ["agentName"] = "grand", ["rules"] = new JsonArray() }, child));
        // Trusted administration can clear any layer; being named main is not administrator authority.
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"action":"deny","tool":"set_agent_rules"}]"""));
        Denied(await f.ToolAsync("set_agent_rules", new JsonObject { ["agentName"] = "sibling", ["rules"] = new JsonArray() }));
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        await f.Manager.SetAgentRulesAsync("grand", new JsonArray());
        Successful(await f.ToolAsync("skill", new JsonObject { ["action"] = "list" }, grand));
    }
}
