using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// R2 startup reconciliation of already migrated Agents with the legacy fence that older
// releases still write, and startup with an unreadable layer elsewhere.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static string AgentsPath(string root) =>
        Path.Combine(root, "data", "state", "agents.json");

    private static JsonObject MigratedRow(string fenceNode, JsonArray rules, string markerNode, int generator, string digest)
    {
        var row = Obj(
            $$"""
            {"isolated":true,"isolatedNode":"{{fenceNode}}","defaultNode":"{{markerNode}}","inheritable":false}
            """
        );
        row["rules"] = rules;
        row["legacyIsolation"] = new JsonObject
        {
            ["node"] = markerNode,
            ["migratedAt"] = 1,
            ["generator"] = generator,
            ["rulesDigest"] = digest,
            ["placementSettled"] = true,
        };
        return row;
    }

    private static async Task<(bool MasterExec, bool BoundExec, bool OtherExec)> NodeExecAuthority(
        SessionManager manager,
        string root
    )
    {
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, root);
        await using var mcp = execution.Mcp;
        async Task<bool> Exec(string node) =>
            await Permits(manager, owner, execution.Files, "node", "exec", """{"command":"id"}""", node);
        return (await Exec("master"), await Exec("bound-node"), await Exec("node-two"));
    }

    private static JsonObject SingleEntry(SessionManager manager) =>
        manager.StartupIsolationMigration!["agents"]!.AsArray().Single()!.AsObject();

    [Fact]
    public async Task Startup_fails_closed_when_an_isolated_Agents_edited_layer_no_longer_restricts_it()
    {
        // R1 marker with cleared rules, and a generator 2 layer whose final deny was removed.
        foreach (var generator in new[] { 1, 2 })
        {
            using var temp = new TempDirectory();
            var layer = generator == 1 ? GeneratorOneLayer(MigrationIsolation) : LayerFor(MigrationIsolation);
            var digest = Digest(layer);
            var edited = generator == 1 ? new JsonArray() : layer.DeepClone().AsArray();
            if (generator == 2)
                edited.RemoveAt(edited.Count - 1);
            await Seed(temp.Path, MigratedRow("bound-node", edited, "bound-node", generator, digest));
            await using (var manager = Manager(temp.Path))
            {
                await manager.LoadAsync();
                var entry = SingleEntry(manager);
                Assert.Equal("failClosed", entry["outcome"]!.GetValue<string>());
                Assert.Equal(
                    "The local rules no longer restrict this Agent; they are kept in the migration marker for a manual merge.",
                    entry["reason"]!.GetValue<string>()
                );
                var row = Row(manager);
                Assert.True(JsonNode.DeepEquals(IsolationMigrationRules.FailClosedRules(), row["rules"]));
                var marker = row["legacyIsolation"]!.AsObject();
                if (generator == 2)
                    Assert.True(JsonNode.DeepEquals(edited, marker["previousRules"]));
                else
                    Assert.Null(marker["previousRules"]);
                Assert.True(row["isolated"]!.GetValue<bool>());
                var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
                Assert.False(masterExec);
                Assert.False(boundExec);
                Assert.False(otherExec);

                // Rules an administrator writes in this release are kept at the next start,
                // even when they no longer restrict the Agent.
                await manager.SetAgentRulesAsync("alpha", new JsonArray());
            }
            await using var restarted = Manager(temp.Path);
            await restarted.LoadAsync();
            Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
            Assert.Empty(Row(restarted)["rules"]!.AsArray());
            Assert.True((await NodeExecAuthority(restarted, temp.Path)).MasterExec);
        }
    }

    [Fact]
    public async Task Startup_keeps_an_edited_layer_that_still_ends_in_a_deny_and_reports_it_once()
    {
        using var temp = new TempDirectory();
        var layer = LayerFor(MigrationIsolation);
        var edited = layer.DeepClone().AsArray();
        edited.Insert(
            0,
            Obj("""{"id":"operator","action":"allow","match":{"tool":{"source":"node","name":"exec"},"targetNode":"node-two"}}""")
        );
        await Seed(temp.Path, MigratedRow("bound-node", edited, "bound-node", 2, Digest(layer)));
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            var entry = SingleEntry(manager);
            Assert.Equal("edited", entry["outcome"]!.GetValue<string>());
            Assert.True(JsonNode.DeepEquals(edited, Row(manager)["rules"]));
            var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
            Assert.False(masterExec);
            Assert.True(boundExec);
            Assert.True(otherExec);
        }
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
    }

    [Fact]
    public async Task Startup_follows_a_binding_changed_by_an_older_release()
    {
        using var temp = new TempDirectory();
        var layer = LegacyIsolationFixture.Layer("alpha", "bound-node");
        await Seed(temp.Path, MigratedRow("node-two", layer, "bound-node", 2, Digest(layer)));
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            var entry = SingleEntry(manager);
            Assert.Equal("rebound", entry["outcome"]!.GetValue<string>());
            Assert.Equal("bound-node", entry["previousNode"]!.GetValue<string>());
            var row = Row(manager);
            Assert.True(JsonNode.DeepEquals(LegacyIsolationFixture.Layer("alpha", "node-two"), row["rules"]));
            Assert.Equal("node-two", row["defaultNode"]!.GetValue<string>());
            var marker = row["legacyIsolation"]!.AsObject();
            Assert.Equal("node-two", marker["node"]!.GetValue<string>());
            Assert.Equal(Digest(row["rules"]!.AsArray()), marker["rulesDigest"]!.GetValue<string>());
            Assert.Equal("node-two", row["isolatedNode"]!.GetValue<string>());
            var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
            Assert.False(masterExec);
            Assert.False(boundExec);
            Assert.True(otherExec);
        }
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
    }

    [Fact]
    public async Task Startup_fails_closed_when_the_binding_changed_and_the_layer_was_edited()
    {
        using var temp = new TempDirectory();
        var layer = LegacyIsolationFixture.Layer("alpha", "bound-node");
        var edited = layer.DeepClone().AsArray();
        edited.Insert(0, Obj("""{"id":"operator","action":"deny","match":{"tool":{"source":"builtin","name":"image_crop"}}}"""));
        await Seed(temp.Path, MigratedRow("node-two", edited, "bound-node", 2, Digest(layer)));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var entry = SingleEntry(manager);
        Assert.Equal("failClosed", entry["outcome"]!.GetValue<string>());
        var row = Row(manager);
        Assert.True(JsonNode.DeepEquals(IsolationMigrationRules.FailClosedRules(), row["rules"]));
        var marker = row["legacyIsolation"]!.AsObject();
        Assert.True(JsonNode.DeepEquals(edited, marker["previousRules"]));
        Assert.Equal("node-two", marker["node"]!.GetValue<string>());
        Assert.Equal("node-two", row["defaultNode"]!.GetValue<string>());
        var (masterExec, boundExec, otherExec) = await NodeExecAuthority(manager, temp.Path);
        Assert.False(masterExec || boundExec || otherExec);
    }

    [Fact]
    public async Task Startup_keeps_the_layer_when_an_older_release_cleared_the_fence()
    {
        using var temp = new TempDirectory();
        var layer = LayerFor(MigrationIsolation);
        var row = MigratedRow("bound-node", layer, "bound-node", 2, Digest(layer));
        row["isolated"] = false;
        row.Remove("isolatedNode");
        await Seed(temp.Path, row);
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            var entry = SingleEntry(manager);
            Assert.Equal("fenceCleared", entry["outcome"]!.GetValue<string>());
            Assert.True(JsonNode.DeepEquals(layer, Row(manager)["rules"]));
            Assert.False((await NodeExecAuthority(manager, temp.Path)).MasterExec);
        }
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
    }

    [Fact]
    public async Task Unreadable_rules_of_another_Agent_do_not_stop_startup_migration()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj(MigrationIsolation));
        var path = AgentsPath(temp.Path);
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        var beta = Obj("""{"rules":[{"id":"x","action":"allow","match":{"futureSelector":true}}]}""");
        document["metadata"]!["beta"] = beta.DeepClone();
        await File.WriteAllTextAsync(path, document.ToJsonString());

        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var entries = manager.StartupIsolationMigration!["agents"]!.AsArray();
        Assert.Equal(
            "migrated",
            entries.Single(entry => entry!["agent"]!.GetValue<string>() == "alpha")!["outcome"]!.GetValue<string>()
        );
        var unreadable = entries.Single(entry => entry!["agent"]!.GetValue<string>() == "beta")!;
        Assert.Equal("unreadableRules", unreadable["outcome"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(LayerFor(MigrationIsolation), Row(manager)["rules"]));
        var written = JsonNode.Parse(await File.ReadAllTextAsync(path))!["metadata"]!["beta"];
        Assert.True(JsonNode.DeepEquals(beta, written));

        // Only beta's calls fail.
        var foreign = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, foreign, temp.Path);
        await using var mcp = execution.Mcp;
        await Assert.ThrowsAnyAsync<Exception>(() =>
            Permits(manager, foreign, execution.Files, "node", "read", """{"filePath":"a.txt"}""")
        );
    }

    [Fact]
    public async Task Archive_reads_without_a_live_row_take_the_Agent_from_the_Session_identity()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj(MigrationIsolation));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        async Task<bool> Read(string id) =>
            await Permits(
                manager,
                owner,
                execution.Files,
                "builtin",
                "get_archived_messages",
                new JsonObject { ["sessionId"] = id }.ToJsonString()
            );
        Assert.True(await Read("alpha/gone"));
        Assert.False(await Read("beta/gone"));
        // An unprefixed ID names a main-Agent Session, even when it equals an Agent name.
        Assert.False(await Read("alpha"));
        Assert.False(await Read("gone"));
    }
}
