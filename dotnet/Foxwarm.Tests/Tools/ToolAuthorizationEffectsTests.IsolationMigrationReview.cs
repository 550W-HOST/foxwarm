using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Regressions for the independent review of the R1 isolation migration.
public sealed partial class ToolAuthorizationEffectsTests
{
    // Session-target resolvers registered by the release before R1. A generated layer that
    // names any other tool in a Session-target matcher would fail to parse after a downgrade.
    private static readonly HashSet<string> PreviousReleaseSessionTargets = new(
        StringComparer.Ordinal
    )
    {
        "send_to_session",
        "send_file",
        "recall",
        "view_session",
        "get_session_messages",
        "create_timer",
        "list_timers",
        "update_timer",
        "delete_timer",
        "get_archived_messages",
        "get_archived_blocks",
        "stop_session",
        "task",
    };

    private static JsonArray LayerFor(string isolation) =>
        IsolationMigrationRules
            .Generate("alpha", IsolatedToolCompatibility.Metadata(Obj(isolation)), false)
            .Rules;

    private static async Task<(SessionManager Manager, SessionOwner Owner)> LayerOnly(
        string root,
        JsonArray rules
    )
    {
        await Seed(root, new JsonObject { ["rules"] = rules.DeepClone() });
        var manager = Manager(root);
        await manager.LoadAsync();
        return (manager, await manager.RequiredAsync("opaque"));
    }

    private static async Task SeedCreatedBy(string root, JsonObject alpha)
    {
        await Seed(root, alpha);
        var path = Path.Combine(root, "data", "state", "agents.json");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        document["metadata"]!["beta"] = new JsonObject { ["createdBy"] = "alpha" };
        await File.WriteAllTextAsync(path, document.ToJsonString());
    }

    [Fact]
    public void Generated_layer_uses_only_selectors_the_previous_release_accepts()
    {
        foreach (
            var isolation in new[]
            {
                MigrationIsolation,
                """{"isolated":true}""",
                """
                    {"isolated":true,"isolatedNode":"bound-node","toolRules":[
                      {"effect":"allow","source":"builtin","tool":"session"},
                      {"effect":"allow","source":"builtin","tool":"node"},
                      {"effect":"allow","source":"builtin","tool":"send_file"},
                      {"effect":"allow","source":"builtin","tool":"set_config"}]}
                    """,
            }
        )
        foreach (var rule in LayerFor(isolation).OfType<JsonObject>())
        {
            if (rule["match"] is not JsonObject match)
                continue;
            Assert.All(
                match,
                pair => Assert.Contains(pair.Key, new[] { "tool", "targetNode", "args", "path" })
            );
            var names = match["tool"]?["name"] switch
            {
                JsonArray list => list.Select(SessionWait.Text).ToArray(),
                JsonNode name => [SessionWait.Text(name)],
                null => [],
            };
            foreach (var (key, value) in match["args"] as JsonObject ?? new())
            {
                if (value is not JsonObject matcher)
                    continue;
                if (matcher.ContainsKey("session"))
                    Assert.All(
                        names,
                        name => Assert.Contains(name!, PreviousReleaseSessionTargets)
                    );
                else if (matcher.ContainsKey("agent"))
                    Assert.Equal(("agentName", "create_session"), (key, names.Single()));
                else
                    Assert.Equal(["exists"], matcher.Select(pair => pair.Key));
            }
        }
    }

    [Fact]
    public async Task Exact_node_allow_is_limited_to_list_and_inspect_in_any_spelling_of_lifecycle()
    {
        const string isolation = """
            {"isolated":true,"isolatedNode":"bound-node","toolRules":[
              {"effect":"allow","source":"builtin","tool":"node"}]}
            """;
        var plan = IsolationMigrationRules.Generate(
            "alpha",
            IsolatedToolCompatibility.Metadata(Obj(isolation)),
            false
        );
        Assert.Equal("narrowed", plan.Notes.Single(note => note.Subject == "builtin:node").Kind);
        using var temp = new TempDirectory();
        var (manager, owner) = await LayerOnly(temp.Path, plan.Rules);
        await using var _ = manager;
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        foreach (
            var args in new[]
            {
                """{"action":"select","nodeId":"other"}""",
                """{"action":"Select","nodeId":"other"}""",
                """{"action":" Destroy","nodeId":"other","confirmation":"destroy node other"}""",
                """{"action":"CREATE","providerId":"p"}""",
            }
        )
            Assert.False(
                await Permits(manager, owner, execution.Files, "builtin", "node", args),
                args
            );
        Assert.True(
            await Permits(
                manager,
                owner,
                execution.Files,
                "builtin",
                "node",
                """{"action":"list"}"""
            )
        );
        Assert.True(
            await Permits(
                manager,
                owner,
                execution.Files,
                "builtin",
                "node",
                """{"action":"inspect","nodeId":"bound-node"}"""
            )
        );
    }

    [Fact]
    public async Task Recorded_master_binding_is_a_blocker_and_apply_refuses_it()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true,"isolatedNode":"master"}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var report = manager.IsolationMigrationInventory("alpha")["agents"]![0]!;
        Assert.False(report["applicable"]!.GetValue<bool>());
        Assert.Contains(
            report["blockers"]!.AsArray(),
            blocker => blocker!.GetValue<string>().Contains("isolation Node is master")
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.ApplyIsolationMigrationAsync("alpha")
        );
        Assert.Null(manager.AgentMetadata["alpha"]?["rules"]);
        Assert.Null(manager.AgentMetadata["alpha"]?["legacyIsolation"]);
    }

    [Fact]
    public void Exact_session_allow_is_reported_as_narrowed()
    {
        var plan = IsolationMigrationRules.Generate(
            "alpha",
            IsolatedToolCompatibility.Metadata(
                Obj(
                    """
                    {"isolated":true,"isolatedNode":"bound-node","toolRules":[
                      {"effect":"allow","source":"builtin","tool":"session"}]}
                    """
                )
            ),
            false
        );
        Assert.Equal("narrowed", plan.Notes.Single(note => note.Subject == "builtin:session").Kind);
    }

    [Fact]
    public async Task Creator_descendants_are_reported_and_apply_requires_acknowledging_them()
    {
        using var temp = new TempDirectory();
        await SeedCreatedBy(temp.Path, Obj("""{"isolated":true,"isolatedNode":"bound-node"}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var report = manager.IsolationMigrationInventory("alpha")["agents"]![0]!;
        Assert.True(report["acknowledgeDescendantsRequired"]!.GetValue<bool>());
        Assert.Contains(
            report["candidate"]!["notes"]!.AsArray(),
            note =>
                note!["subject"]!.GetValue<string>() == "agent:beta"
                && note["kind"]!.GetValue<string>() == "narrowed"
        );

        var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.ApplyIsolationMigrationAsync("alpha")
        );
        Assert.Contains("beta", refused.Message);
        Assert.Null(manager.AgentMetadata["alpha"]?["legacyIsolation"]);

        var applied = await manager.ApplyIsolationMigrationAsync(
            "alpha",
            acknowledgeDescendants: true
        );
        Assert.True(applied["applied"]!.GetValue<bool>());
        // The descendant is now bounded by the layer, as acknowledged.
        var foreign = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, foreign, temp.Path);
        await using var mcp = execution.Mcp;
        Assert.False(
            await Permits(
                manager,
                foreign,
                execution.Files,
                "node",
                "exec",
                """{"command":"ls"}""",
                "other-node"
            )
        );
    }

    [Fact]
    public async Task Reader_marker_rises_only_for_data_that_needs_this_reader()
    {
        using var temp = new TempDirectory();
        await SeedCreatedBy(temp.Path, new JsonObject());
        var marker = Path.Combine(temp.Path, "data", "state", AgentCatalog.InstallationFileName);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        // Creator links and local rules are enforced by earlier releases too.
        await manager.SetAgentDefaultPlacementAsync("alpha", false, null, true, "/srv/alpha");
        await manager.SetAgentRulesAsync("alpha", new JsonArray());
        Assert.False(File.Exists(marker));
        await manager.SetAgentInheritableAsync("beta", false);
        Assert.Equal(
            1,
            JsonNode.Parse(await File.ReadAllTextAsync(marker))![
                "minimumReaderVersion"
            ]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task Applying_to_a_migrated_Agent_resumes_the_placement_backfill()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true,"isolatedNode":"bound-node"}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        // Simulate an interruption after the catalog write: publish the catalog step only.
        var catalog = (AgentCatalog)
            typeof(SessionManager)
                .GetField(
                    "agents",
                    System.Reflection.BindingFlags.NonPublic
                        | System.Reflection.BindingFlags.Instance
                )!
                .GetValue(manager)!;
        await catalog.ApplyIsolationMigrationAsync(
            "alpha",
            isolation => manager.IsolationMigrationPlanFor("alpha", isolation),
            1
        );
        var before = manager.IsolationMigrationInventory("alpha")["agents"]![0]!;
        Assert.False(before["applicable"]!.GetValue<bool>());
        Assert.True(before["needsBackfill"]!.GetValue<bool>());
        var rules = manager.AgentMetadata["alpha"]!["rules"]!.DeepClone();

        var resumed = await manager.ApplyIsolationMigrationAsync("alpha");
        Assert.False(resumed["applied"]!.GetValue<bool>());
        Assert.Equal(
            new[] { "direct", "opaque" },
            resumed["materializedSessions"]!.AsArray().Select(id => id!.GetValue<string>()).Order()
        );
        Assert.True(JsonNode.DeepEquals(rules, manager.AgentMetadata["alpha"]!["rules"]));
        var again = await manager.ApplyIsolationMigrationAsync("alpha");
        Assert.Empty(again["materializedSessions"]!.AsArray());
        Assert.False(
            manager.IsolationMigrationInventory("alpha")["agents"]![0]![
                "needsBackfill"
            ]!.GetValue<bool>()
        );
    }
}
