using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionIdentityBoundaryTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string data, string work) =>
        new(data, work, Options, HostModels.ForTest(Options));

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public async Task Supplied_Main_spelling_controls_target_shape_and_new_agent_copy_preserves_existing_context_and_memory_bytes()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "memory", "nested"));
        await File.WriteAllTextAsync(
            Path.Combine(work, "memory", "nested", "notes.md"),
            "Owned memory: 漢字\n"
        );
        using (var initial = new SessionCatalog(data))
            initial.Initialize();
        await SessionCatalogMigrationTests.Authority(data, "old");
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var row = SessionCatalogTests.Row("old", 0);
            row["aliases"] = new JsonArray("main/alias");
            catalog.Upsert([row]);
        }
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("old");
        var before = owner.Entry.Snapshot();
        var first = await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["sessionId"] = "main/alias", ["newSessionId"] = "named" }
        );
        Assert.Equal("main/named", owner.Id);
        await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["sessionId"] = "old", ["newSessionId"] = "flat" }
        );
        Assert.Equal("flat", owner.Id);
        var created = await manager.MoveIdentityAsync(
            owner,
            new JsonObject
            {
                ["createAgent"] = true,
                ["newAgentName"] = "copied",
                ["createAgentInheritMemory"] = true,
            }
        );
        Assert.Equal("copied/main", owner.Id);
        Assert.True(created["createdAgent"]!.GetValue<bool>());
        Assert.Equal(
            "Owned memory: 漢字\n",
            await File.ReadAllTextAsync(
                Path.Combine(work, "agents", "copied", "memory", "nested", "notes.md")
            )
        );
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["promptCacheKey"],
                owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]
            )
        );
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["persistentMemorySnapshot"],
                owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
            )
        );
        Assert.Same(owner, await manager.GetExistingAsync("main/alias"));
        Assert.Same(owner, await manager.GetExistingAsync("flat"));
    }

    [Fact]
    public async Task Meaningful_master_cwd_survives_cross_agent_move_without_replacing_cache_or_the_cwd_value()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var initial = new SessionCatalog(data))
            initial.Initialize();
        await SessionCatalogMigrationTests.Authority(data, "old");
        var path = Path.Combine(data, "state", "sessions", "old.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        raw["cwd"] = work;
        await File.WriteAllTextAsync(path, raw.ToJsonString());
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("old", 0)]);
        }
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("old");
        var bytes = await File.ReadAllTextAsync(path);
        var before = owner.Entry.Snapshot();
        await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["createAgent"] = true, ["newAgentName"] = "destination" }
        );
        Assert.Equal(work, owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>());
        Assert.Equal("destination/main", owner.Id);
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["promptCacheKey"],
                owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]
            )
        );
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
    }

    [Fact]
    public async Task All_cold_direct_children_and_exact_nonWebUi_channel_binding_move_without_hydration_or_unrelated_changes()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        manager.Catalog.Upsert(
            Enumerable.Range(0, 1000).Select(i => SessionCatalogTests.Row("cold-" + i, i, "old"))
        );
        var channels = Path.Combine(data, "state", "channels.json");
        await File.WriteAllTextAsync(
            channels,
            "{\"channels\":{\"telegram:room\":{\"sessionId\":\"old\",\"mode\":\"push-only\"},\"webui:other\":{\"sessionId\":\"unrelated\",\"other\":true}}}"
        );
        var result = await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["newSessionId"] = "new" }
        );
        Assert.Equal(1000, result["updatedChildren"]!.AsArray().Count);
        Assert.All(
            manager
                .Catalog.List()
                .Where(row =>
                    row["id"]!.GetValue<string>().StartsWith("cold-", StringComparison.Ordinal)
                ),
            row => Assert.Equal("new", row["parentSessionId"]!.GetValue<string>())
        );
        Assert.Single(manager.Owners());
        Assert.False(Directory.Exists(Path.Combine(data, "state", "sessions", "cold-0")));
        var state = JsonNode.Parse(await File.ReadAllTextAsync(channels))!;
        Assert.Equal("new", state["channels"]!["telegram:room"]!["sessionId"]!.GetValue<string>());
        Assert.Equal("push-only", state["channels"]!["telegram:room"]!["mode"]!.GetValue<string>());
        Assert.Equal(
            "unrelated",
            state["channels"]!["webui:other"]!["sessionId"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Old_and_target_calls_join_actual_move_and_caller_cancellation_never_cancels_mutation_or_publishes_another_owner()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        var reached = Signal();
        var release = Signal();
        manager.BeforeIdentityStage = async (_, stage) =>
        {
            if (stage == "before-target-persistence")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var move = manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "new" });
        await reached.Task;
        var old = manager.GetExistingAsync("old");
        var target = manager.GetExistingAsync("new");
        using var cancel = new CancellationTokenSource();
        var local = manager.GetExistingAsync("new", cancel.Token);
        Assert.False(old.IsCompleted);
        Assert.False(target.IsCompleted);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => local);
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => manager.DeleteAsync("old"));
        release.TrySetResult();
        await move;
        Assert.Same(owner, await old);
        Assert.Same(owner, await target);
        Assert.Single(manager.Owners());
    }

    [Fact]
    public async Task Accepted_dormant_admission_and_target_creation_settle_before_move_validation_without_substituting_their_lifetime()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var initial = new SessionCatalog(data))
            initial.Initialize();
        await SessionCatalogMigrationTests.Authority(data, "cold");
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("cold", 0)]);
        }
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var reached = Signal();
        var release = Signal();
        manager.BeforeAdmissionRead = async (id, _) =>
        {
            if (id == "cold")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var admission = manager.GetExistingAsync("cold");
        await reached.Task;
        var move = manager.MoveIdentityAsync(
            caller,
            new JsonObject { ["sessionId"] = "cold", ["newSessionId"] = "current" }
        );
        Assert.False(move.IsCompleted);
        release.TrySetResult();
        var owner = await admission;
        await move;
        Assert.Same(owner, await manager.GetExistingAsync("current"));
        reached = Signal();
        release = Signal();
        manager.BeforeCreationPublication = async id =>
        {
            if (id == "taken")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var creating = manager.CreateNamedAsync("main", "taken", null, null);
        await reached.Task;
        var conflict = manager.MoveIdentityAsync(
            caller,
            new JsonObject { ["sessionId"] = "current", ["newSessionId"] = "taken" }
        );
        Assert.False(conflict.IsCompleted);
        release.TrySetResult();
        var actual = await creating;
        await Assert.ThrowsAsync<InvalidDataException>(() => conflict);
        Assert.Same(actual, await manager.GetExistingAsync("taken"));
        Assert.Equal("current", owner!.Id);
    }

    [Fact]
    public async Task Separate_parent_sql_failure_reports_the_committed_identity_and_truthful_unchanged_parent()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        await manager.CreateNamedAsync("main", "parent", null, null);
        using (
            var db = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = manager.Catalog.FilePath,
                    Pooling = false,
                }.ToString()
            )
        )
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "CREATE TRIGGER fail_parent BEFORE UPDATE OF parent_reference ON session_catalog WHEN NEW.session_id='new' AND NEW.parent_reference='parent' BEGIN SELECT RAISE(ABORT,'Real separate parent failure'); END";
            command.ExecuteNonQuery();
        }
        var result = await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["newSessionId"] = "new", ["parentSessionId"] = "parent" }
        );
        Assert.Equal("new", owner.Id);
        Assert.NotNull(result["parentUpdateError"]);
        Assert.Null(result["parentSessionId"]);
        Assert.Equal("parent", result["requestedParentSessionId"]!.GetValue<string>());
        Assert.Same(owner, await manager.GetExistingAsync("old"));
        Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
    }

    [Theory]
    [InlineData("sessionWorkers", "Session-worker")]
    [InlineData("vector", "Vector")]
    public async Task Actual_captured_unsupported_placement_or_external_index_configuration_fails_before_move_effects(
        string field,
        string detail
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: a\nproviders: {a: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            field + ": {enabled: true}\n"
        );
        var configuration = new ModelConfiguration(data);
        await using var manager = new SessionManager(data, work, Options, configuration.Models);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        var file = Path.Combine(data, "state", "sessions", "old.json");
        var bytes = await File.ReadAllBytesAsync(file);
        var error = await Assert.ThrowsAsync<NotSupportedException>(() =>
            manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "new" })
        );
        Assert.Contains(detail, error.Message);
        Assert.Equal("old", owner.Id);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(file));
        Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
        Assert.Null(manager.Catalog.Get("new"));
    }
}
