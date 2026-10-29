using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    [Fact]
    public async Task Layers_resolve_Session_and_Task_facts_even_without_global_target_rules()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var peer = await f.Manager.CreateNamedAsync("child", "peer", null, null);
        await f.Manager.SetAgentRulesAsync(
            "main",
            Rules(
                """[{"tool":{"source":"builtin","name":"view_session"},"args":{"sessionId":{"session":{"sameAgent":true}}},"action":"allow"},{"tool":"view_session","action":"deny"}]"""
            )
        );
        Successful(
            await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = peer.Id }, child)
        );
        Denied(
            await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = f.Owner.Id }, child)
        );
        await f.Manager.SetAgentRulesAsync(
            "main",
            Rules(
                """[{"tool":{"source":"builtin","name":"task"},"args":{"taskId":{"task":{"owned":true}}},"action":"allow"},{"tool":"task","action":"deny"}]"""
            )
        );
        var task = await f.Manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "owned",
                ["ownerSessionId"] = child.Id,
            },
            f.Owner.Id
        );
        var taskId = SessionWait.Text(task.Payload["task"]?["id"]);
        Assert.NotNull(taskId);
        // Execute the authorization owner directly so the test observes policy facts independently of Task get's shared read contract.
        await f.Manager.AuthorizeToolAsync(
            child,
            new(
                "task",
                "builtin",
                "task",
                new JsonObject { ["action"] = "get", ["taskId"] = taskId }
            ),
            null,
            default
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            f.Manager.AuthorizeToolAsync(
                peer,
                new(
                    "task",
                    "builtin",
                    "task",
                    new JsonObject { ["action"] = "get", ["taskId"] = taskId }
                ),
                null,
                default
            )
        );
    }

    [Theory]
    [InlineData("{\"broken\":{\"createdBy\":\"missing\"}}")]
    [InlineData("{\"broken\":{\"createdBy\":\"other\"},\"other\":{\"createdBy\":\"broken\"}}")]
    [InlineData("{\"broken\":{\"rules\":[{\"action\":\"deny\",\"agent\":\"broken\"}]}}")]
    public async Task Invalid_persisted_creator_authority_rejects_execution_and_discovery(
        string metadata
    )
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        Directory.CreateDirectory(Path.Combine(paths.AgentsRoot, "broken"));
        Directory.CreateDirectory(Path.Combine(paths.AgentsRoot, "other"));
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "state", "agents.json"), metadata);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("broken", "main", null, null);
        Assert.False(manager.ToolVisible(owner, "node", "exec", node: "master"));
        Assert.False(manager.ToolVisible(owner, "builtin", "call_tool"));
        Assert.Empty(manager.ModelDefinitions(owner));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                null,
                default
            )
        );
    }

    [Fact]
    public async Task Adding_layers_is_monotone_for_the_same_real_initiator_and_requests()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var random = new Random(4817);
        var requests = new[]
        {
            "skill",
            "session",
            "create_timer",
            "create_agent",
            "set_agent_rules",
        }
            .Select(name => new ResolvedTool(
                name,
                "builtin",
                name,
                new JsonObject { ["action"] = "status" }
            ))
            .ToArray();
        async Task<bool> Allowed(ResolvedTool request)
        {
            try
            {
                await f.Manager.AuthorizeToolAsync(grand, request, null, default);
                return true;
            }
            catch (ToolAuthorizationDeniedException)
            {
                return false;
            }
        }
        for (var round = 0; round < 12; round++)
        {
            foreach (var name in new[] { "main", "child", "grand" })
                await f.Manager.SetAgentRulesAsync(name, new JsonArray());
            var prior = await Task.WhenAll(requests.Select(Allowed));
            foreach (var name in new[] { "main", "child", "grand" })
            {
                var rules = new JsonArray();
                for (var rule = 0; rule < 6; rule++)
                    rules.Add(
                        new JsonObject
                        {
                            ["tool"] = requests[random.Next(requests.Length)].Name,
                            ["action"] = random.Next(2) == 0 ? "allow" : "deny",
                            ["enabled"] = random.Next(4) != 0,
                        }
                    );
                await f.Manager.SetAgentRulesAsync(name, rules);
                var current = await Task.WhenAll(requests.Select(Allowed));
                for (var index = 0; index < requests.Length; index++)
                    Assert.False(
                        current[index] && !prior[index],
                        $"Layer {name} widened fixed request {requests[index].Name}."
                    );
                prior = current;
            }
        }
    }

    [Fact]
    public async Task Tree_limits_are_serialized_admission_checks_and_retained_inheritance_is_revalidated()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "agents");
        var depth = 2;
        var children = 2;
        var agents = new AgentCatalog(
            temp.Path,
            work,
            canonicalLayout: true,
            treeLimits: () => (depth, children)
        );
        await agents.CreateAsync("root");
        var results = await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(async index =>
                {
                    try
                    {
                        await agents.CreateAsync("child" + index, createdBy: "root");
                        return true;
                    }
                    catch (InvalidDataException)
                    {
                        return false;
                    }
                })
        );
        Assert.Equal(2, results.Count(value => value));
        var selected = agents
            .List()
            .First(name => name.StartsWith("child", StringComparison.Ordinal));
        await agents.CreateAsync("grand", createdBy: selected);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            agents.CreateAsync("too-deep", createdBy: "grand")
        );
        depth = 0;
        children = 0;
        Assert.Equal(3, agents.RuleLayers("grand").Length);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            agents.CreateAsync("limited", createdBy: selected)
        );
        AppConfigurationRules.Validate(Obj("""{"agentTree":{"maxDepth":0,"maxChildren":0}}"""));
        foreach (
            var invalid in new[]
            {
                "null",
                "[]",
                "{\"maxDepth\":-1}",
                "{\"maxChildren\":1.5}",
                "{\"unknown\":1}",
            }
        )
            Assert.Throws<InvalidDataException>(() =>
                AppConfigurationRules.Validate(Obj("{\"agentTree\":" + invalid + "}"))
            );
    }

    [Fact]
    public async Task Reusing_legacy_metadata_does_not_adopt_an_unrelated_inheritance_source_or_reset_authority()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "agents");
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        foreach (var name in new[] { "root", "outside" })
            Directory.CreateDirectory(Path.Combine(work, name));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "agents.json"),
            """{"reuse":{"inherit":"outside"},"placed":{"defaultNode":"offline"}}"""
        );
        var catalog = new AgentCatalog(temp.Path, work, canonicalLayout: true);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            catalog.CreateAsync("reuse", createdBy: "root")
        );
        Assert.False(Directory.Exists(Path.Combine(work, "reuse")));
        await catalog.CreateAsync("placed", createdBy: "root");
        Assert.Equal("offline", catalog.DefaultNode("placed"));
        var reopened = new AgentCatalog(temp.Path, work, canonicalLayout: true);
        Assert.Equal("root", reopened.CreatedBy("placed"));
        Assert.Equal(2, reopened.RuleLayers("placed").Length);
    }

    [Fact]
    public async Task Native_ToolScript_and_neutral_dispatch_share_the_latest_Agent_layer()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var path = Path.Combine(f.Manager.AgentDirectory("child"), "native-write.txt");
        var args = new JsonObject { ["filePath"] = path, ["content"] = "native effect" };
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"write","action":"deny"}]"""));
        Denied(
            await f.ToolAsync(
                "call_tool",
                new JsonObject
                {
                    ["source"] = "node",
                    ["name"] = "write",
                    ["args"] = args.DeepClone(),
                },
                child
            )
        );
        var script = new JsonObject
        {
            ["code"] = "return call_tool('write', args)",
            ["args"] = args.DeepClone(),
        };
        var native = await f.ToolAsync("run_script", script, child);
        Assert.Equal("failed", SessionWait.Text(native!["status"]));
        Assert.False(File.Exists(path));
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        var allowed = await f.ToolAsync("run_script", script, child);
        Successful(allowed);
        Assert.True(SessionWait.Text(allowed!["status"]) == "completed", allowed.ToJsonString());
        Assert.Equal("native effect", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task Prepared_directories_are_not_membership_and_failed_authority_write_leaves_no_published_child()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "agents");
        var catalog = new AgentCatalog(temp.Path, work, canonicalLayout: true);
        await catalog.CreateAsync("root");
        var index = Path.Combine(temp.Path, "state", "agents.json");
        File.Delete(index);
        Directory.CreateDirectory(index);
        await Assert.ThrowsAnyAsync<IOException>(() =>
            catalog.CreateAsync(
                "child",
                createdBy: "root",
                rules: Rules("""[{"action":"deny"}]"""),
                initialMemory: "owned preparation"
            )
        );
        Assert.False(catalog.Exists("child"));
        Assert.Null(catalog.MetadataSnapshot()["child"]);
        Assert.Equal(new[] { "root" }, Directory.GetDirectories(work).Select(Path.GetFileName));
        Directory.Delete(index);
        // This is the durable layout after metadata commit but before final directory publication.
        Directory.CreateDirectory(Path.Combine(work, ".create-interrupted", "memory"));
        await File.WriteAllTextAsync(
            index,
            """{"child":{"createdBy":"root","rules":[{"action":"deny"}]}}"""
        );
        var reopened = new AgentCatalog(temp.Path, work, canonicalLayout: true);
        Assert.DoesNotContain("child", reopened.List());
        Assert.DoesNotContain(".create-interrupted", reopened.List());
        Assert.Throws<InvalidDataException>(() => reopened.RuleLayers("child"));
        Assert.Equal("root", reopened.CreatedBy("child"));
        await Assert.ThrowsAsync<InvalidDataException>(() => reopened.CreateAsync("child"));
    }
}
