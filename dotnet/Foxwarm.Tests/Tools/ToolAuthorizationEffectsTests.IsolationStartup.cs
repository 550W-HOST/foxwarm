using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// R2: legacy isolation is migrated at startup and no longer enforced.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static JsonObject Row(SessionManager manager, string agent = "alpha") =>
        manager.AgentMetadata[agent]!.AsObject();

    private static string? CurrentNode(SessionOwner owner) =>
        owner.Entry.WithState(state => SessionWait.Text(state.AuthorityEnvelope["currentNode"]));

    // The layer R1 (generator 1) wrote: identical except that `session` status had no target limit.
    private static JsonArray GeneratorOneLayer(string isolation)
    {
        var rules = GeneratorTwoLayer(isolation);
        foreach (var rule in rules.OfType<JsonObject>())
            if (
                rule["id"]!.GetValue<string>().StartsWith(IsolationMigrationRules.SessionStatusRule)
            )
                rule["match"]!["args"]!.AsObject().Remove("sessionId");
        return rules;
    }

    private static string Digest(JsonArray rules) => new IsolationMigrationPlan(rules, [], []).Digest;

    // The layer generator 2 wrote: without skill copy, skill runs and the advisor deny.
    private static JsonArray GeneratorTwoLayer(string isolation)
    {
        var rules = new JsonArray();
        foreach (var rule in LayerFor(isolation).OfType<JsonObject>())
        {
            var id = rule["id"]!.GetValue<string>();
            if (id == "isolation-advisor-runs" || id.StartsWith("isolation-skill-run", StringComparison.Ordinal))
                continue;
            if (id.StartsWith("isolation-skill", StringComparison.Ordinal))
                rule["match"]!["args"]!["action"] = new JsonArray("list", "load");
            rules.Add(rule.DeepClone());
        }
        return rules;
    }

    private static async Task<bool> PermitsBuiltin(
        SessionManager manager,
        SessionOwner owner,
        string root,
        string name,
        string args
    )
    {
        var execution = Executor(manager, owner, root);
        await using var mcp = execution.Mcp;
        try
        {
            return await Permits(manager, owner, execution.Files, "builtin", name, args);
        }
        catch (InvalidDataException)
        {
            // A corrupt creator chain cannot be evaluated; authorization fails closed.
            return false;
        }
    }

    [Fact]
    public async Task Startup_migrates_a_pre_R1_isolated_Agent_before_work_and_keeps_the_fence()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj(MigrationIsolation));
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            var row = Row(manager);
            Assert.True(JsonNode.DeepEquals(LayerFor(MigrationIsolation), row["rules"]));
            var marker = row["legacyIsolation"]!.AsObject();
            Assert.Equal(
                IsolationMigrationRules.GeneratorVersion,
                marker["generator"]!.GetValue<int>()
            );
            Assert.True(marker["automatic"]!.GetValue<bool>());
            Assert.True(marker["placementSettled"]!.GetValue<bool>());
            Assert.Equal(Digest(row["rules"]!.AsArray()), marker["rulesDigest"]!.GetValue<string>());
            Assert.Null(marker["failClosed"]);
            Assert.False(row["inheritable"]!.GetValue<bool>());
            Assert.Equal("bound-node", row["defaultNode"]!.GetValue<string>());
            // The legacy fields stay unchanged as the downgrade fence.
            Assert.True(row["isolated"]!.GetValue<bool>());
            Assert.Equal("bound-node", row["isolatedNode"]!.GetValue<string>());
            Assert.Equal(6, row["toolRules"]!.AsArray().Count);
            // Sessions that ran on the bound Node through the retired fallback record it.
            Assert.Equal("bound-node", CurrentNode(await manager.RequiredAsync("opaque")));
            Assert.Equal("bound-node", CurrentNode(await manager.RequiredAsync("direct")));
            Assert.Null(CurrentNode(await manager.RequiredAsync("foreign")));

            var report = manager.StartupIsolationMigration!;
            var entry = report["agents"]!.AsArray().Single()!;
            Assert.Equal("alpha", entry["agent"]!.GetValue<string>());
            Assert.Equal("migrated", entry["outcome"]!.GetValue<string>());
            Assert.NotEmpty(entry["notes"]!.AsArray());
            var placement = report["placement"]!.AsArray().Single()!;
            Assert.Equal(2, placement["materializedSessions"]!.AsArray().Count);
            Assert.NotNull(manager.IsolationMigrationInventory()["startup"]);

            await AssertParity(manager, temp.Path, "startup");
            var opaque = await manager.RequiredAsync("opaque");
            Assert.False(
                await PermitsBuiltin(
                    manager,
                    opaque,
                    temp.Path,
                    "session",
                    """{"action":"status","sessionId":"outside"}"""
                )
            );
            Assert.False(
                await PermitsBuiltin(
                    manager,
                    opaque,
                    temp.Path,
                    "session",
                    """{"sessionId":"kid"}"""
                )
            );
            Assert.True(
                await PermitsBuiltin(
                    manager,
                    opaque,
                    temp.Path,
                    "session",
                    """{"action":"status","sessionId":"self"}"""
                )
            );
        }

        // A restart finds nothing left to migrate and leaves the catalog unchanged.
        var before = await File.ReadAllTextAsync(
            Path.Combine(temp.Path, "data", "state", "agents.json")
        );
        await using var restarted = Manager(temp.Path);
        await restarted.LoadAsync();
        Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
        Assert.Empty(restarted.StartupIsolationMigration!["placement"]!.AsArray());
        Assert.Equal(
            before,
            await File.ReadAllTextAsync(Path.Combine(temp.Path, "data", "state", "agents.json"))
        );
    }

    [Fact]
    public async Task Startup_adds_the_current_Session_status_limit_to_R1_layers()
    {
        foreach (var edited in new[] { false, true })
        {
            using var temp = new TempDirectory();
            var rules = GeneratorOneLayer(MigrationIsolation);
            var digest = Digest(rules);
            if (edited)
                rules.Insert(
                    0,
                    Obj(
                        """{"id":"operator","action":"deny","match":{"tool":{"source":"builtin","name":"image_crop"}}}"""
                    )
                );
            var row = Obj(MigrationIsolation);
            row["rules"] = rules;
            row["inheritable"] = false;
            row["defaultNode"] = "bound-node";
            row["legacyIsolation"] = new JsonObject
            {
                ["node"] = "bound-node",
                ["migratedAt"] = 1,
                ["generator"] = 1,
                ["rulesDigest"] = digest,
            };
            await Seed(temp.Path, row);
            await using var manager = Manager(temp.Path);
            await manager.LoadAsync();
            var migrated = Row(manager);
            var marker = migrated["legacyIsolation"]!.AsObject();
            Assert.Equal(IsolationMigrationRules.GeneratorVersion, marker["generator"]!.GetValue<int>());
            Assert.Null(marker["automatic"]);
            var entry = manager.StartupIsolationMigration!["agents"]!.AsArray().Single()!;
            // An unedited layer is generated again by the current generator (3).
            Assert.Equal(edited ? "upgraded" : "regenerated", entry["outcome"]!.GetValue<string>());
            if (edited)
                Assert.Equal(2, entry["statusRulesLimited"]!.GetValue<int>());
            if (edited)
            {
                // An edited layer keeps its digest so it is still recognised as edited.
                Assert.Equal(digest, marker["rulesDigest"]!.GetValue<string>());
                Assert.NotNull(entry["reason"]);
                Assert.Equal("operator", migrated["rules"]![0]!["id"]!.GetValue<string>());
            }
            else
            {
                Assert.True(JsonNode.DeepEquals(LayerFor(MigrationIsolation), migrated["rules"]));
                Assert.Equal(
                    Digest(migrated["rules"]!.AsArray()),
                    marker["rulesDigest"]!.GetValue<string>()
                );
            }
            var opaque = await manager.RequiredAsync("opaque");
            Assert.False(
                await PermitsBuiltin(
                    manager,
                    opaque,
                    temp.Path,
                    "session",
                    """{"action":"status","sessionId":"outside"}"""
                )
            );
            Assert.True(
                await PermitsBuiltin(manager, opaque, temp.Path, "session", """{"action":"status"}""")
            );
        }
    }

    [Theory]
    [InlineData("local-rules")]
    [InlineData("master-binding")]
    [InlineData("creator-cycle")]
    public async Task Startup_installs_a_deny_everything_layer_when_migration_is_unsafe(string reason)
    {
        using var temp = new TempDirectory();
        var alpha = reason switch
        {
            "local-rules" => Obj(
                """
                {"isolated":true,"isolatedNode":"bound-node","rules":[
                  {"id":"keep","action":"allow"}]}
                """
            ),
            "master-binding" => Obj("""{"isolated":true,"isolatedNode":"master"}"""),
            _ => Obj("""{"isolated":true,"isolatedNode":"bound-node","createdBy":"beta"}"""),
        };
        await Seed(temp.Path, alpha);
        if (reason == "creator-cycle")
        {
            var path = Path.Combine(temp.Path, "data", "state", "agents.json");
            var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            document["metadata"]!["beta"] = new JsonObject { ["createdBy"] = "alpha" };
            await File.WriteAllTextAsync(path, document.ToJsonString());
        }
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var row = Row(manager);
        Assert.True(JsonNode.DeepEquals(IsolationMigrationRules.FailClosedRules(), row["rules"]));
        var marker = row["legacyIsolation"]!.AsObject();
        Assert.False(string.IsNullOrEmpty(marker["failClosed"]!.GetValue<string>()));
        if (reason == "local-rules")
            Assert.Equal("keep", marker["previousRules"]![0]!["id"]!.GetValue<string>());
        Assert.True(row["isolated"]!.GetValue<bool>());
        var entry = manager.StartupIsolationMigration!["agents"]!.AsArray().Single()!;
        Assert.Equal("failClosed", entry["outcome"]!.GetValue<string>());

        var opaque = await manager.RequiredAsync("opaque");
        foreach (
            var (name, args) in new[]
            {
                ("session", "{}"),
                ("read_memory", """{"filePath":"MEMORY.md"}"""),
            }
        )
            Assert.False(await PermitsBuiltin(manager, opaque, temp.Path, name, args), name);
        // Self-scoped calls pass a fail-closed layer, but not an invalid creator chain.
        Assert.Equal(
            reason != "creator-cycle",
            await PermitsBuiltin(manager, opaque, temp.Path, "wait", "{}")
        );
        var execution = Executor(manager, opaque, temp.Path);
        await using (execution.Mcp)
        {
            var read = Permits(
                manager,
                opaque,
                execution.Files,
                "node",
                "read",
                """{"filePath":"a.txt"}"""
            );
            if (reason == "creator-cycle")
                await Assert.ThrowsAsync<InvalidDataException>(() => read);
            else
                Assert.False(await read);
        }

        var listed = manager
            .AgentRegistry()
            .Select(item => (JsonObject)item)
            .Single(item => item["id"]!.GetValue<string>() == "alpha");
        Assert.True(listed["restricted"]!.GetValue<bool>());
        Assert.NotNull(listed["isolationMigration"]!["failClosed"]);
        Assert.Null(listed["isolated"]);

        // Replacing the rules ends the blocked state in the registry; the marker stays.
        await manager.SetAgentRulesAsync("alpha", new JsonArray());
        listed = manager
            .AgentRegistry()
            .Select(item => (JsonObject)item)
            .Single(item => item["id"]!.GetValue<string>() == "alpha");
        Assert.Null(listed["isolationMigration"]!["failClosed"]);
        Assert.False(listed["restricted"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Global_rules_naming_unisolated_Agents_keep_working_alongside_migration()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj(MigrationIsolation));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
              - id: guard-beta
                agent: beta
                tool: {source: node, name: exec}
                action: deny
              - id: guard-beta-agents
                agent: beta
                tool: {source: builtin, name: [list_agents, create_agent, send_to_channel]}
                action: deny
            """
        );
        var foreign = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, foreign, temp.Path);
        await using var mcp = execution.Mcp;
        Assert.False(
            await Permits(manager, foreign, execution.Files, "node", "exec", """{"command":"ls"}""")
        );
        Assert.False(await Permits(manager, foreign, execution.Files, "builtin", "list_agents", "{}"));
        Assert.True(
            await Permits(
                manager,
                foreign,
                execution.Files,
                "node",
                "read",
                """{"filePath":"a.txt"}"""
            )
        );
        Assert.Null(manager.AgentMetadata["beta"]);
        // The migrated Agent is bounded by both its own layer and the global policy.
        await AssertParity(manager, temp.Path, "with global policy");
    }

    [Fact]
    public async Task Startup_regenerates_unedited_generator_2_layers_with_skill_copy_and_runs()
    {
        foreach (var edited in new[] { false, true })
        {
            using var temp = new TempDirectory();
            var rules = GeneratorTwoLayer(MigrationIsolation);
            var digest = Digest(rules);
            if (edited)
                rules.Insert(
                    0,
                    Obj(
                        """{"id":"operator","action":"deny","match":{"tool":{"source":"builtin","name":"image_crop"}}}"""
                    )
                );
            var row = Obj(MigrationIsolation);
            row["rules"] = rules;
            row["inheritable"] = false;
            row["defaultNode"] = "bound-node";
            row["legacyIsolation"] = new JsonObject
            {
                ["node"] = "bound-node",
                ["migratedAt"] = 1,
                ["generator"] = 2,
                ["rulesDigest"] = digest,
                ["fenceDigest"] = IsolationMigrationRules.FenceDigest(Obj(MigrationIsolation)),
            };
            await Seed(temp.Path, row);
            await AssertGeneratorTwoUpgrade(temp.Path, edited, digest);
            // A restart has nothing left to change.
            Assert.Empty((await RestartedReport(temp.Path))["agents"]!.AsArray());
        }
    }

    private static async Task AssertGeneratorTwoUpgrade(string root, bool edited, string digest)
    {
        {
            await using var manager = Manager(root);
            await manager.LoadAsync();
            var migrated = Row(manager);
            var marker = migrated["legacyIsolation"]!.AsObject();
            Assert.Equal(3, marker["generator"]!.GetValue<int>());
            var entry = manager.StartupIsolationMigration!["agents"]!.AsArray().Single()!;
            var opaque = await manager.RequiredAsync("opaque");
            Task<bool> Allowed(string name, string args) =>
                PermitsBuiltin(manager, opaque, root, name, args);
            if (edited)
            {
                // An edited layer is the administrator's and is kept as stored.
                Assert.Equal("upgraded", entry["outcome"]!.GetValue<string>());
                Assert.NotNull(entry["reason"]);
                Assert.Equal(digest, marker["rulesDigest"]!.GetValue<string>());
                Assert.Equal("operator", migrated["rules"]![0]!["id"]!.GetValue<string>());
                Assert.False(await Allowed("run_skill", """{"skillName":"demo"}"""));
                Assert.False(await Allowed("skill", """{"action":"copy","skillName":"demo","targetPath":"x"}"""));
            }
            else
            {
                Assert.Equal("regenerated", entry["outcome"]!.GetValue<string>());
                Assert.True(JsonNode.DeepEquals(LayerFor(MigrationIsolation), migrated["rules"]));
                Assert.Equal(Digest(migrated["rules"]!.AsArray()), marker["rulesDigest"]!.GetValue<string>());
                Assert.True(await Allowed("run_skill", """{"skillName":"demo"}"""));
                Assert.True(await Allowed("run_skill", """{"skillName":"demo","agentName":"alpha","script":"x.py"}"""));
                Assert.False(await Allowed("run_skill", """{"skillName":"demo","agentName":"other"}"""));
                Assert.False(await Allowed("run_skill", """{"skillName":"advisor"}"""));
                Assert.True(await Allowed("skill", """{"action":"copy","skillName":"demo","targetPath":"x"}"""));
                Assert.False(await Allowed("create_child_session", """{"sessionName":"fork","fork":true}"""));
            }
            // Reading resources was already covered by the generator 2 `skill` rule.
            Assert.True(await Allowed("skill", """{"action":"load","skillName":"demo","path":"references/x.md"}"""));
        }
    }

    private static async Task<JsonObject> RestartedReport(string root)
    {
        await using var restarted = Manager(root);
        await restarted.LoadAsync();
        return restarted.StartupIsolationMigration!;
    }
}
