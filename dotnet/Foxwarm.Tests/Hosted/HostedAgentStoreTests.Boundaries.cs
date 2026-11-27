using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedAgentStoreTests
{
    [Fact]
    public async Task A_created_Agent_has_its_authority_published_before_it_becomes_a_member()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        var catalog = fixture.Manager.AgentCatalog;
        (bool Creator, bool Rules, bool Member)? seen = null;
        catalog.BeforeStoreCreation = name =>
        {
            var metadata = catalog.MetadataSnapshot()[name] as JsonObject;
            seen = (metadata?["createdBy"] is not null, metadata?["rules"] is JsonArray, catalog.Exists(name));
        };
        await fixture.Manager.CreateAgentAsync(
            "child",
            createMainSession: false,
            creator: fixture.Inner.Owner,
            rules: JsonNode.Parse("""[{"id":"rest","action":"deny"}]""")!.AsArray()
        );
        Assert.Equal((true, true, false), seen);
        Assert.True(catalog.Exists("child"));
    }

    [Fact]
    public async Task A_creation_over_the_limits_leaves_no_record_and_can_be_retried()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        var (_, entries) = ((PgAgentFileStore)fixture.Store).Usage();
        fixture.Postgres!.AgentStoreLimits = () => AgentStoreLimits.Default with { Files = entries };
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            fixture.Manager.CreateAgentAsync("child", createMainSession: false, creator: fixture.Inner.Owner)
        );
        Assert.False(fixture.Manager.AgentMetadata.ContainsKey("child"));
        Assert.False(fixture.Store.AgentExists("child"));
        fixture.Postgres.AgentStoreLimits = () => AgentStoreLimits.Default;
        await fixture.Manager.CreateAgentAsync("child", createMainSession: false, creator: fixture.Inner.Owner);
        Assert.True(fixture.Store.AgentExists("child"));
    }

    [Fact]
    public async Task Deleting_main_keeps_it_usable_and_startup_seeds_its_memory_as_for_folders()
    {
        async Task<(string Write, bool SeededBefore, bool SeededAfter)> RunAsync(StoreFixture fixture)
        {
            var survivor = await fixture.Manager.CreateNamedAsync("main", "survivor", null, null);
            await fixture.Manager.DeleteAgentFromCommandAsync("main");
            Assert.Contains("main", fixture.Manager.Agents());
            var tools = fixture.Inner.Executor(survivor);
            var write = Seen(
                await fixture.Call("write_memory", new() { ["filePath"] = "NOTE.md", ["content"] = "after" }, tools),
                fixture.Manager
            );
            bool Seeded() =>
                fixture.Manager.AgentStore is { } store
                    ? store.FileExists("main", "memory/MEMORY.md")
                    : File.Exists(Path.Combine(fixture.Manager.MemoryDirectory("main"), "MEMORY.md"));
            var before = Seeded();
            // A restart's bootstrap: memory isn't empty, so nothing is added.
            await fixture.Manager.AgentCatalog.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
            var unchanged = Seeded() == before;
            // With the deletion's state only (no memory files), startup seeds the templates.
            await fixture.Call("delete_memory", new() { ["filePath"] = "NOTE.md" }, tools);
            await fixture.Manager.AgentCatalog.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
            return (write, before && unchanged, Seeded());
        }
        await using var folders = await StoreFixture.Create(store: false, installedLayout: true);
        await using var store = await StoreFixture.Create(store: true);
        var expected = await RunAsync(folders);
        Assert.Equal("Memory file created: NOTE.md", expected.Write);
        Assert.True(expected.SeededAfter);
        Assert.Equal(expected, await RunAsync(store));
        Assert.True(store.Store.AgentExists("main"));
    }

    [Fact]
    public async Task The_isolation_migration_of_a_store_main_needs_no_folder()
    {
        // Startup converts an isolated main; the inventory reports it in the installed layout.
        await using var fixture = await StoreFixture.Create(store: true, agents: """{"main":{"isolated":true}}""");
        Assert.Equal(
            "migrated",
            SessionWait.Text(fixture.Manager.StartupIsolationMigration?["agents"]?[0]?["outcome"])
        );
        var inventory = fixture.Manager.IsolationMigrationInventory("main").ToJsonString();
        Assert.Contains("\"retainedMainLayout\":false", inventory);
        var plan = fixture.Manager.IsolationMigrationPlanFor("main", new AgentIsolation(true, null, new JsonArray()));
        Assert.Empty(plan.Blockers);
    }

    [Fact]
    public async Task Rule_roots_the_store_cannot_decide_are_refused_where_they_are_set()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        foreach (var root in new[] { "${agent.dir}/../other", "${agent.dir}x", "/abs/${agent.dir}", "${agent.memoryDir}/a\\b" })
        {
            var rules = new JsonArray(
                new JsonObject
                {
                    ["id"] = "outside",
                    ["match"] = new JsonObject { ["path"] = new JsonObject { ["anyNotWithin"] = root } },
                    ["action"] = "deny",
                }
            );
            var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
                fixture.Manager.CreateAgentAsync("boxed", createMainSession: false, rules: rules)
            );
            Assert.Equal($"Rule `outside`: `{root}` isn't a path inside this Agent's folder.", error.Message);
            Assert.False(fixture.Manager.AgentMetadata.ContainsKey("boxed"));
        }
        // Equivalent spellings of a store root are accepted and canonical.
        Assert.Equal("a/memory/notes", AgentStorePaths.PolicyRoot("${agent.memoryDir}/./notes//", "a", out var refused));
        Assert.False(refused);
        Assert.Equal("a/notes", AgentStorePaths.PolicyRoot("${agent.memoryDir}/../notes", "a", out _));
        Assert.Null(AgentStorePaths.PolicyRoot("/abs/path", "a", out refused));
        Assert.False(refused);
    }

    [Fact]
    public async Task A_stored_rule_with_an_undecidable_root_fails_closed()
    {
        await using var fixture = await StoreFixture.Create(
            store: true,
            agents: """{"main":{"rules":[{"id":"odd","match":{"tool":{"source":"builtin"},"path":{"anyNotWithin":"${agent.dir}/../other"}},"action":"deny"}]}}"""
        );
        var result = await fixture.Call("write_memory", new() { ["filePath"] = "x.md", ["content"] = "x" });
        Assert.Contains("odd", result.FailureMessage() ?? "");
        Assert.False(fixture.Store.FileExists("main", "memory/x.md"));
    }

    [Fact]
    public async Task Deleting_a_Session_of_a_vanished_Agent_folder_stops_nothing()
    {
        await using var fixture = await StoreFixture.Create(store: false, installedLayout: true);
        await fixture.Manager.CreateAgentAsync("gone", createMainSession: false);
        var owner = await fixture.Manager.CreateNamedAsync("gone", "s", null, null);
        Directory.Delete(fixture.Manager.AgentDirectory("gone"), recursive: true);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Manager.DeleteAsync(owner.Id));
        Assert.Equal("Agent 'gone' does not exist.", error.Message);
        Assert.NotNull(await fixture.Manager.GetExistingAsync(owner.Id));
    }
}
