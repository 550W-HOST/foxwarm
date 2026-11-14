using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// R2 reconciliation with the whole legacy fence (isolated, isolatedNode, toolRules) and the
// parsed check of whether an Agent's own layer still restricts it.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static JsonObject MarkedAlpha(JsonArray rules, string rulesDigest, string? fenceDigest = null)
    {
        var row = new JsonObject
        {
            ["isolated"] = true,
            ["isolatedNode"] = "bound-node",
            ["defaultNode"] = "bound-node",
            ["inheritable"] = false,
            ["rules"] = rules,
        };
        var marker = new JsonObject
        {
            ["node"] = "bound-node",
            ["migratedAt"] = 1,
            ["generator"] = IsolationMigrationRules.GeneratorVersion,
            ["rulesDigest"] = rulesDigest,
            ["automatic"] = true,
            ["placementSettled"] = true,
        };
        if (fenceDigest is not null)
            marker["fenceDigest"] = fenceDigest;
        row["legacyIsolation"] = marker;
        return row;
    }

    private static async Task EditAgents(string root, Action<JsonObject> edit)
    {
        var path = AgentsPath(root);
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        edit(document["metadata"]!.AsObject());
        await File.WriteAllTextAsync(path, document.ToJsonString());
    }

    private static bool RegistryRestricted(SessionManager manager, string agent) =>
        manager
            .AgentRegistry()
            .Select(item => (JsonObject)item)
            .Single(item => item["id"]!.GetValue<string>() == agent)["restricted"]!
            .GetValue<bool>();

    [Theory]
    [InlineData("disabled-deny")]
    [InlineData("shorthand-deny")]
    [InlineData("creator-deny")]
    public async Task Startup_fails_closed_unless_the_Agents_own_layer_ends_in_an_unconditional_deny(
        string shape
    )
    {
        using var temp = new TempDirectory();
        var rules = shape switch
        {
            "disabled-deny" => JsonNode.Parse(
                """[{"id":"isolation-deny-other","action":"deny","enabled":false}]"""
            )!.AsArray(),
            "shorthand-deny" => JsonNode.Parse(
                """[{"id":"only-this","action":"deny","tool":{"source":"builtin","name":"set_agent_rules"}}]"""
            )!.AsArray(),
            _ => new JsonArray(),
        };
        await Seed(temp.Path, MarkedAlpha(rules, "0000"));
        if (shape == "creator-deny")
            await EditAgents(
                temp.Path,
                metadata =>
                {
                    metadata["alpha"]!["createdBy"] = "beta";
                    metadata["beta"] = Obj(
                        """
                        {"rules":[
                          {"id":"coordinator-nodes","action":"allow","match":{"tool":{"source":"node"}}},
                          {"id":"coordinator-rest","action":"deny"}]}
                        """
                    );
                }
            );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var entry = SingleEntry(manager);
        Assert.Equal("failClosed", entry["outcome"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(IsolationMigrationRules.FailClosedRules(), Row(manager)["rules"]));
        var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
        Assert.False(masterExec || boundExec || otherExec);
    }

    [Fact]
    public async Task Startup_keeps_an_own_layer_ending_in_an_unconditional_deny_as_administrator_intent()
    {
        using var temp = new TempDirectory();
        var rules = JsonNode.Parse("""[{"id":"all","action":"allow"},{"id":"rest","action":"deny"}]""")!.AsArray();
        await Seed(temp.Path, MarkedAlpha(rules, "0000"));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        Assert.Equal("edited", SingleEntry(manager)["outcome"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(rules, Row(manager)["rules"]));
        Assert.NotNull(Row(manager)["legacyIsolation"]!["fenceDigest"]);
    }

    [Fact]
    public async Task Registry_restricted_label_uses_the_parsed_layer()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        foreach (
            var (rules, restricted) in new[]
            {
                ("""[{"id":"a","action":"deny","tool":{"source":"builtin","name":"wait"}}]""", false),
                ("""[{"id":"a","action":"deny","enabled":false}]""", false),
                ("""[{"id":"a","action":"deny","match":{}}]""", true),
                ("""[{"id":"a","action":"allow"},{"id":"b","action":"deny"}]""", true),
            }
        )
        {
            await manager.SetAgentRulesAsync("beta", JsonNode.Parse(rules)!.AsArray());
            Assert.Equal(restricted, RegistryRestricted(manager, "beta"));
        }
    }

    [Fact]
    public async Task Real_R1_data_follows_tool_rules_changed_after_migration()
    {
        foreach (var (name, boundExecAllowed, outcome) in new[]
        {
            ("isolation-r1-apply-unedited", true, "upgraded"),
            ("isolation-r1-toolrules-changed", false, "regenerated"),
        })
        {
            using var temp = new TempDirectory();
            await Seed(temp.Path);
            File.Copy(
                Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", name + ".agents.json"),
                AgentsPath(temp.Path),
                true
            );
            await File.WriteAllTextAsync(
                Path.Combine(temp.Path, "data", "state", "installation.json"),
                """{"minimumReaderVersion":1}"""
            );
            await using (var manager = Manager(temp.Path))
            {
                await manager.LoadAsync();
                Assert.Equal(outcome, SingleEntry(manager)["outcome"]!.GetValue<string>());
                var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
                Assert.False(masterExec);
                Assert.Equal(boundExecAllowed, boundExec);
                Assert.False(otherExec);
                var owner = await manager.RequiredAsync("opaque");
                var execution = Executor(manager, owner, temp.Path);
                await using var mcp = execution.Mcp;
                Assert.True(
                    await Permits(manager, owner, execution.Files, "mcp", "t\"1é", "{}", "master", "srv+ü<x>&'")
                );
            }
            await using var restarted = Manager(temp.Path);
            await restarted.LoadAsync();
            Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
            Assert.Null(Row(restarted)["legacyIsolation"]!["failClosed"]);
            Assert.Equal(boundExecAllowed, (await NodeExecAuthority(restarted, temp.Path)).BoundExec);
        }
    }

    [Fact]
    public async Task An_accepted_edited_layer_fails_closed_when_an_older_release_later_changes_the_fence()
    {
        using var temp = new TempDirectory();
        var layer = LegacyIsolationFixture.Layer("alpha", "bound-node");
        var edited = layer.DeepClone().AsArray();
        edited.Insert(0, Obj("""{"id":"operator","action":"deny","match":{"tool":{"source":"builtin","name":"image_crop"}}}"""));
        // An R1-era marker without a fence digest: the edited layer is accepted and the
        // current fence recorded.
        await Seed(temp.Path, MarkedAlpha(edited, Digest(layer)));
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            Assert.Equal("edited", SingleEntry(manager)["outcome"]!.GetValue<string>());
        }
        // An older release then adds an exact deny to the legacy tool rules.
        await EditAgents(
            temp.Path,
            metadata =>
                metadata["alpha"]!["toolRules"] = JsonNode.Parse(
                    """[{"effect":"deny","source":"node","node":"bound-node","tool":"exec"}]"""
                )
        );
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        var entry = SingleEntry(restarted);
        Assert.Equal("failClosed", entry["outcome"]!.GetValue<string>());
        Assert.Equal(
            "An older release changed the Agent's legacy isolation settings after migration, and its local rules had been edited; they are kept in the migration marker for a manual merge.",
            entry["reason"]!.GetValue<string>()
        );
        Assert.True(JsonNode.DeepEquals(edited, Row(restarted)["legacyIsolation"]!["previousRules"]));
        Assert.False((await NodeExecAuthority(restarted, temp.Path)).BoundExec);
    }

    [Fact]
    public async Task An_unreadable_layer_of_a_migrated_Agent_is_left_unchanged_and_reported()
    {
        using var temp = new TempDirectory();
        var rules = JsonNode.Parse(
            """[{"id":"x","action":"allow","match":{"futureSelector":true}},{"id":"rest","action":"deny"}]"""
        )!.AsArray();
        var row = MarkedAlpha(rules, "0000");
        await Seed(temp.Path, row);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var entry = SingleEntry(manager);
        Assert.Equal("unreadableRules", entry["outcome"]!.GetValue<string>());
        var written = JsonNode.Parse(await File.ReadAllTextAsync(AgentsPath(temp.Path)))!["metadata"]!["alpha"];
        Assert.True(JsonNode.DeepEquals(row, written));
        Assert.True(RegistryRestricted(manager, "alpha"));
        await Assert.ThrowsAnyAsync<Exception>(async () => await NodeExecAuthority(manager, temp.Path));
    }

    [Fact]
    public async Task An_unreadable_creator_layer_leaves_the_child_unchanged_until_it_is_repaired()
    {
        foreach (var migrated in new[] { true, false })
        {
            using var temp = new TempDirectory();
            var layer = LegacyIsolationFixture.Layer("alpha", "bound-node");
            var row = migrated
                ? MarkedAlpha(layer.DeepClone().AsArray(), Digest(layer))
                : Obj("""{"isolated":true,"isolatedNode":"bound-node"}""");
            row["createdBy"] = "beta";
            await Seed(temp.Path, row);
            await EditAgents(
                temp.Path,
                metadata =>
                    metadata["beta"] = Obj(
                        """{"rules":[{"id":"x","action":"allow","match":{"futureSelector":true}}]}"""
                    )
            );
            var stored = JsonNode.Parse(await File.ReadAllTextAsync(AgentsPath(temp.Path)))!["metadata"]!["alpha"]!.DeepClone();
            await using (var manager = Manager(temp.Path))
            {
                await manager.LoadAsync();
                var entries = manager.StartupIsolationMigration!["agents"]!.AsArray();
                var child = entries.Single(entry => entry!["agent"]!.GetValue<string>() == "alpha")!;
                Assert.Equal("unreadableRules", child["outcome"]!.GetValue<string>());
                Assert.Equal(
                    "The local rules of creator Agent beta do not parse; this Agent is left unchanged until they are repaired.",
                    child["reason"]!.GetValue<string>()
                );
                var written = JsonNode.Parse(await File.ReadAllTextAsync(AgentsPath(temp.Path)))!["metadata"]!["alpha"];
                Assert.True(JsonNode.DeepEquals(stored, written));
            }
            await EditAgents(
                temp.Path,
                metadata => metadata["beta"] = Obj("""{"rules":[{"id":"ok","action":"allow"}]}""")
            );
            await using var repaired = Manager(temp.Path);
            await repaired.LoadAsync();
            var marker = Row(repaired)["legacyIsolation"]!.AsObject();
            Assert.Null(marker["failClosed"]);
            Assert.True(JsonNode.DeepEquals(layer, Row(repaired)["rules"]));
            if (!migrated)
                Assert.Equal(
                    "migrated",
                    SingleEntry(repaired)["outcome"]!.GetValue<string>()
                );
            Assert.Equal(
                IsolationMigrationRules.FenceDigest(Row(repaired)),
                marker["fenceDigest"]!.GetValue<string>()
            );
        }
    }

    [Fact]
    public async Task An_accepted_unedited_layer_records_the_current_fence()
    {
        using var temp = new TempDirectory();
        var layer = LegacyIsolationFixture.Layer("alpha", "bound-node");
        // The fence digest is stale: an older change left the generated layer identical.
        await Seed(temp.Path, MarkedAlpha(layer.DeepClone().AsArray(), Digest(layer), "stale"));
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            Assert.Empty(manager.StartupIsolationMigration!["agents"]!.AsArray());
            Assert.Equal(
                IsolationMigrationRules.FenceDigest(Row(manager)),
                Row(manager)["legacyIsolation"]!["fenceDigest"]!.GetValue<string>()
            );
        }
        // A later edit that still ends in a deny is kept, not read as a fence change.
        var edited = layer.DeepClone().AsArray();
        edited.Insert(0, Obj("""{"id":"operator","action":"deny","match":{"tool":{"source":"builtin","name":"image_crop"}}}"""));
        await EditAgents(temp.Path, metadata => metadata["alpha"]!["rules"] = edited.DeepClone());
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        Assert.Equal("edited", SingleEntry(restarted)["outcome"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(edited, Row(restarted)["rules"]));
    }
}
