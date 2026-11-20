using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Regressions for the independent review of the R1 isolation migration.
public sealed partial class ToolAuthorizationEffectsTests
{
    // Session-target resolvers registered by R1, the oldest release a migrated installation
    // may be downgraded to. A generated layer that names any other tool in a Session-target
    // matcher would fail to parse after that downgrade.
    private static readonly HashSet<string> PreviousReleaseSessionTargets = new(
        StringComparer.Ordinal
    )
    {
        "session",
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

}
