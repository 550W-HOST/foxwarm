using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    private static AgentCatalog AgentCatalogOf(SessionManager manager) =>
        (AgentCatalog)
            typeof(SessionManager)
                .GetField("agents", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(manager)!;

    private static void MetadataWriteHook(
        SessionManager manager,
        Action<AtomicJsonWriteStage>? callback
    ) =>
        typeof(AgentCatalog)
            .GetField("metadataWriteStage", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(AgentCatalogOf(manager), callback);

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public async Task Conversion_compensates_owned_publication_and_preparation_without_touching_foreign_paths(
        bool canonical,
        bool blockDirectory,
        bool directoryBlocker
    )
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        var work = canonical ? paths.AgentsRoot : Path.Combine(temp.Path, "work");
        await using var manager = new SessionManager(
            temp.Path,
            work,
            options,
            HostModels.ForTest(options),
            hostPaths: canonical ? paths : null
        );
        await manager.LoadAsync();
        var source = await manager.CreateNamedAsync("main", "source", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            source,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "source-history" }),
            }
        );
        var sourceId = source.Id;
        var history = source
            .Entry.Snapshot()
            .History.Select(row => row.ToJson().ToJsonString())
            .ToArray();
        var snapshot = source
            .Entry.Snapshot()
            .AuthorityEnvelope["persistentMemorySnapshot"]
            ?.ToJsonString();
        var root = canonical ? paths.AgentsRoot : Path.Combine(work, "agents");
        var unrelated = Path.Combine(root, ".create-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(unrelated);
        await File.WriteAllTextAsync(Path.Combine(unrelated, "foreign.txt"), "foreign-preparation");
        var armed = true;
        MetadataWriteHook(
            manager,
            stage =>
            {
                if (!armed || stage != AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                    return;
                armed = false;
                if (blockDirectory)
                {
                    var blocked = Path.Combine(root, "converted");
                    if (directoryBlocker)
                    {
                        Directory.CreateDirectory(blocked);
                        File.WriteAllText(Path.Combine(blocked, "keep"), "foreign-blocker");
                    }
                    else
                        File.WriteAllText(blocked, "foreign-blocker");
                }
                else
                    throw new IOException("synthetic committed Agent durability failure");
            }
        );
        var result = (
            await manager.ExecuteAgentToolAsync(
                source,
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "converted",
                    ["convertSession"] = true,
                    ["rules"] = Rules("""[{"action":"deny","tool":"skill"}]"""),
                }
            )
        ).Response;
        MetadataWriteHook(manager, null);
        Denied(result);
        Assert.True(result["rolledBack"]!.GetValue<bool>(), result.ToJsonString());
        Assert.False(result["identityCommitted"]!.GetValue<bool>());
        Assert.Equal(sourceId, source.Id);
        Assert.Equal(
            history,
            source.Entry.Snapshot().History.Select(row => row.ToJson().ToJsonString())
        );
        Assert.Equal(
            snapshot,
            source.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]?.ToJsonString()
        );
        Assert.Null(manager.AgentMetadata["converted"]);
        Assert.Equal(directoryBlocker, Directory.Exists(Path.Combine(root, "converted")));
        Assert.Equal(
            new[] { unrelated },
            Directory
                .GetDirectories(root)
                .Where(path =>
                    Path.GetFileName(path).StartsWith(".create-", StringComparison.Ordinal)
                )
        );
        Assert.Equal(
            "foreign-preparation",
            await File.ReadAllTextAsync(Path.Combine(unrelated, "foreign.txt"))
        );
        if (blockDirectory)
            Assert.Equal(
                "foreign-blocker",
                await File.ReadAllTextAsync(
                    directoryBlocker
                        ? Path.Combine(root, "converted", "keep")
                        : Path.Combine(root, "converted")
                )
            );
        Assert.Null(new SessionIdentityMoveJournal(temp.Path).Read());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_conversion_restores_only_the_preexisting_empty_or_populated_metadata_row(
        bool populated
    )
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var previous = populated
            ? Obj("""{"inherit":"main","defaultNode":"offline","custom":{"keep":"value"}}""")
            : new JsonObject();
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "agents.json"),
            new JsonObject { ["retained"] = previous.DeepClone() }.ToJsonString()
        );
        await using var manager = new SessionManager(
            temp.Path,
            paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await manager.LoadAsync();
        var source = await manager.CreateNamedAsync("main", "source", null, null);
        var sourceId = source.Id;
        manager.BeforeIdentityStage = async (_, stage) =>
        {
            if (stage != "after-agent-copy")
                return;
            await manager.CreateAgentAsync("unrelated", false, rules: new JsonArray());
            throw new IOException(
                "synthetic conversion failure after independent metadata publication"
            );
        };
        var result = (
            await manager.ExecuteAgentToolAsync(
                source,
                "create_agent",
                new JsonObject { ["agentName"] = "retained", ["convertSession"] = true }
            )
        ).Response;
        Denied(result);
        Assert.True(result["rolledBack"]!.GetValue<bool>());
        Assert.True(JsonNode.DeepEquals(previous, manager.AgentMetadata["retained"]));
        Assert.DoesNotContain("retained", manager.Agents());
        Assert.Contains("unrelated", manager.Agents());
        Assert.IsType<JsonArray>(manager.AgentMetadata["unrelated"]!["rules"]);
        Assert.Equal(sourceId, source.Id);
    }

    [Fact]
    public async Task Conversion_cleanup_failure_reports_preparation_and_existing_recovery_removes_only_owned_state()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var previous = Obj("""{"inherit":"main","custom":{"keep":"preexisting"}}""");
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "agents.json"),
            new JsonObject { ["converted"] = previous.DeepClone() }.ToJsonString()
        );
        string? prepared = null;
        string? sourceId = null;
        var foreign = Path.Combine(temp.Path, "foreign");
        Directory.CreateDirectory(foreign);
        await File.WriteAllTextAsync(Path.Combine(foreign, "keep"), "unowned");
        await using (
            var manager = new SessionManager(
                temp.Path,
                paths.AgentsRoot,
                options,
                HostModels.ForTest(options),
                hostPaths: paths
            )
        )
        {
            await manager.LoadAsync();
            var source = await manager.CreateNamedAsync("main", "source", null, null);
            sourceId = source.Id;
            await ForkClearLifecycleTests.AppendAsync(
                source,
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = "source survives cleanup interruption" }
                    ),
                }
            );
            var armed = true;
            MetadataWriteHook(
                manager,
                stage =>
                {
                    if (!armed || stage != AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                        return;
                    armed = false;
                    var intent = new SessionIdentityMoveJournal(temp.Path).Read()!;
                    prepared = AgentCatalogOf(manager)
                        .PreparationPath(intent.OwnedAgentPreparation!);
                    Directory.Delete(prepared, true);
                    Directory.CreateSymbolicLink(prepared, foreign);
                    Directory.CreateDirectory(Path.Combine(paths.AgentsRoot, "converted"));
                    File.WriteAllText(
                        Path.Combine(paths.AgentsRoot, "converted", "keep"),
                        "unowned blocker"
                    );
                }
            );
            var result = (
                await manager.ExecuteAgentToolAsync(
                    source,
                    "create_agent",
                    new JsonObject { ["agentName"] = "converted", ["convertSession"] = true }
                )
            ).Response;
            MetadataWriteHook(manager, null);
            Denied(result);
            Assert.True(result["recoveryRequired"]!.GetValue<bool>(), result.ToJsonString());
            Assert.Null(result["rolledBack"]);
            Assert.Equal(prepared, SessionWait.Text(result["agentPreparationDirectory"]));
            Assert.Contains(prepared!, result["rollbackErrors"]!.ToJsonString());
            Assert.NotNull(manager.AgentMetadata["converted"]);
            Assert.NotNull(new SessionIdentityMoveJournal(temp.Path).Read());
            Assert.Equal(sourceId, source.Id);
            Assert.Equal("unowned", await File.ReadAllTextAsync(Path.Combine(foreign, "keep")));
            Directory.Delete(prepared!); // Explicit repair of the substituted link, then ordinary startup recovery.
            Directory.CreateDirectory(prepared!);
            await File.WriteAllTextAsync(Path.Combine(prepared!, "owned"), "owned preparation");
        }
        await using var reopened = new SessionManager(
            temp.Path,
            paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await reopened.LoadAsync();
        Assert.False(Directory.Exists(prepared));
        Assert.True(JsonNode.DeepEquals(previous, reopened.AgentMetadata["converted"]));
        Assert.Null(new SessionIdentityMoveJournal(temp.Path).Read());
        var recovered = await reopened.RequiredAsync(sourceId!);
        Assert.Contains(
            "source survives cleanup interruption",
            string.Join(
                "\n",
                recovered.Entry.Snapshot().History.Select(row => row.ToJson().ToJsonString())
            )
        );
        Assert.Equal("unowned", await File.ReadAllTextAsync(Path.Combine(foreign, "keep")));
        Assert.Equal(
            "unowned blocker",
            await File.ReadAllTextAsync(Path.Combine(paths.AgentsRoot, "converted", "keep"))
        );
    }

    [Fact]
    public async Task Delegated_foreign_rename_cannot_satisfy_an_ID_scoped_read_grant()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var sibling = await ChildAgent(f, "sibling");
        await ForkClearLifecycleTests.AppendAsync(
            sibling,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "foreign-secret-through-rename" }
                ),
            }
        );
        await f.Manager.SetAgentRulesAsync(
            "child",
            Rules(
                """[{"tool":"view_session","args":{"sessionId":"sibling/readable"},"action":"allow"},{"tool":"view_session","action":"deny"}]"""
            )
        );
        Denied(
            await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = sibling.Id }, child)
        );
        var original = sibling.Id;
        var originalHistory = sibling
            .Entry.Snapshot()
            .History.Select(row => row.ToJson().ToJsonString())
            .ToArray();
        Denied(
            await f.ToolAsync(
                "move_session",
                new JsonObject { ["sessionId"] = original, ["newSessionId"] = "readable" },
                child
            )
        );
        Assert.Equal(original, sibling.Id);
        Assert.Null(f.Manager.Catalog.Get("sibling/readable"));
        Denied(
            await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = original }, child)
        );
        var finalRead = await f.ToolAsync(
            "view_session",
            new JsonObject { ["sessionId"] = "sibling/readable" },
            child
        );
        Assert.DoesNotContain("foreign-secret-through-rename", finalRead!.ToJsonString());
        Assert.Equal(
            originalHistory,
            sibling.Entry.Snapshot().History.Select(row => row.ToJson().ToJsonString())
        );
        var descendant = await ChildAgent(f, "descendant", child);
        var alias = descendant.Id;
        await f.Manager.MoveIdentityAsync(
            descendant,
            new JsonObject { ["newSessionId"] = "admin-renamed" }
        );
        Successful(
            await f.ToolAsync(
                "move_session",
                new JsonObject { ["sessionId"] = alias, ["newSessionId"] = "allowed" },
                child
            )
        );
        Assert.Equal("descendant/allowed", descendant.Id);
        Successful(
            await f.ToolAsync(
                "move_session",
                new JsonObject { ["sessionId"] = original, ["newSessionId"] = "top-level-renamed" }
            )
        );
        Assert.Equal("sibling/top-level-renamed", sibling.Id);
        await f.Manager.MoveIdentityAsync(
            child,
            new JsonObject
            {
                ["sessionId"] = sibling.Id,
                ["newSessionId"] = "administrator-renamed",
            }
        );
        Assert.Equal("sibling/administrator-renamed", sibling.Id);
    }

    [Fact]
    public async Task Invalid_preparation_path_evidence_rejects_startup_without_touching_foreign_data()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        var foreign = Path.Combine(temp.Path, "foreign");
        Directory.CreateDirectory(foreign);
        await File.WriteAllTextAsync(Path.Combine(foreign, "keep"), "unowned");
        var journal = new SessionIdentityMoveJournal(temp.Path);
        var raw = new SessionIdentityMoveRecord(
            "rolling-back",
            "old",
            "target/main",
            "main",
            [],
            true,
            "target",
            1
        ).Json();
        raw["ownedAgentPreparation"] = "../foreign";
        Directory.CreateDirectory(Path.GetDirectoryName(journal.FilePath)!);
        await File.WriteAllTextAsync(journal.FilePath, raw.ToJsonString());
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        Assert.Throws<InvalidDataException>(() =>
            new SessionManager(
                temp.Path,
                paths.AgentsRoot,
                options,
                HostModels.ForTest(options),
                hostPaths: paths
            )
        );
        Assert.Equal("unowned", await File.ReadAllTextAsync(Path.Combine(foreign, "keep")));
    }
}
