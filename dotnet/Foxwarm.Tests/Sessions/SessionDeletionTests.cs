using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionDeletionTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static string Authority(string root, string id) =>
        Path.Combine(root, "data", "state", "sessions", id + ".json");

    private static async Task Seed(string root, params JsonObject[] rows)
    {
        root = Path.Combine(root, "data");
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        foreach (var row in rows)
            await SessionCatalogMigrationTests.Authority(root, row["id"]!.GetValue<string>());
        catalog.Upsert(rows);
    }

    private static SessionManager Manager(string root) =>
        new(
            Path.Combine(root, "data"),
            Path.Combine(root, "workspace"),
            Options,
            HostModels.ForTest(Options)
        );

    [Fact]
    public async Task Single_delete_detaches_cold_children_only_in_Main_and_preserves_retained_records_and_old_owner_fences()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("target", 0, aliases: ["alias"]),
            SessionCatalogTests.Row("child", 0, "alias")
        );
        var childBytes = await File.ReadAllTextAsync(Authority(temp.Path, "child"));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("target");
        owner.Archive.EnsureBranch();
        var branches = owner.Archive.ReadBranch();
        var historical = Path.Combine(temp.Path, "data", "state", "toolscript-runs", "old.json");
        Directory.CreateDirectory(Path.GetDirectoryName(historical)!);
        await File.WriteAllTextAsync(historical, "{\"status\":\"active\"}");
        var events = new List<SessionRuntimeEvent>();
        manager.Changed += events.Add;
        var result = await manager.DeleteAsync("alias");
        Assert.Equal("deleted", result["status"]!.GetValue<string>());
        Assert.Equal(
            new[] { "target" },
            result["deletedSessionIds"]!.AsArray().Select(node => node!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "child" },
            result["detachedChildSessionIds"]!.AsArray().Select(node => node!.GetValue<string>())
        );
        Assert.Null(manager.Catalog.Get("child")!["parentSessionId"]);
        Assert.Null(manager.Catalog.Get("target"));
        Assert.Null(manager.Find("target"));
        Assert.Equal(childBytes, await File.ReadAllTextAsync(Authority(temp.Path, "child")));
        Assert.Equal("{\"status\":\"active\"}", await File.ReadAllTextAsync(historical));
        Assert.False(File.Exists(Authority(temp.Path, "target")));
        Assert.Equal(branches, owner.Archive.ReadBranch());
        Assert.Contains(events, item => item.Kind == SessionEventKind.Deleted);
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.Entry.SaveLane.SaveStrictAsync()
        );
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.AuthorityStore.CommitAsync(owner.Entry.Snapshot(), SaveKind.Strict)
        );
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.Entry.SaveLane.AdmitAsync(
                SessionWait.Event("late", "late", new(), new()),
                SaveKind.Strict
            )
        );
        await Assert.ThrowsAnyAsync<InvalidDataException>(() =>
            manager.CreateNamedAsync("main", "target", null, null)
        );
    }

    [Fact]
    public async Task Retired_archive_free_legacy_ID_may_have_a_new_lifetime_but_the_captured_old_owner_cannot_write_it()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, SessionCatalogTests.Row("target", 0));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var old = await manager.RequiredAsync("target");
        await manager.DeleteAsync("target");
        var created = await manager.CreateNamedAsync("main", "target", null, null);
        var current = await File.ReadAllTextAsync(Authority(temp.Path, "target"));
        Assert.NotSame(old, created);
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            old.AuthorityStore.CommitAsync(old.Entry.Snapshot(), SaveKind.Strict)
        );
        old.PublishStateChanged();
        Assert.Equal(current, await File.ReadAllTextAsync(Authority(temp.Path, "target")));
        Assert.Same(created, manager.Find("target"));
    }

    [Fact]
    public async Task Recursive_selection_includes_archived_hidden_raw_descendants_and_validates_all_authorities_before_detach_or_unlink()
    {
        using var temp = new TempDirectory();
        var child = SessionCatalogTests.Row("child", 0, "root");
        child["archived"] = true;
        child["pinned"] = true;
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("root", 0),
            child,
            SessionCatalogTests.Row("grand", 0, "child")
        );
        var original = await File.ReadAllTextAsync(Authority(temp.Path, "grand"));
        await File.WriteAllTextAsync(Authority(temp.Path, "grand"), "broken");
        var channels = Path.Combine(temp.Path, "data", "state", "channels.json");
        const string bindings = """
            {"channels":{"webui:root":{"sessionId":"root"},"webui:child":{"sessionId":"child"},"webui:grand":{"sessionId":"grand"}}}
            """;
        await File.WriteAllTextAsync(channels, bindings);
        var authorityBytes = new Dictionary<string, string>();
        foreach (var id in new[] { "root", "child", "grand" })
            authorityBytes[id] = await File.ReadAllTextAsync(Authority(temp.Path, id));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var failure = await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() => manager.DeleteAsync("root", true));
        Assert.Equal("grand", failure.SessionId);
        Assert.Equal(new[] { "child", "grand", "root" }, manager.Catalog.List().Select(row => row["id"]!.GetValue<string>()).Order());
        Assert.Equal("root", manager.Catalog.Get("child")!["parentSessionId"]!.GetValue<string>());
        Assert.Equal("child", manager.Catalog.Get("grand")!["parentSessionId"]!.GetValue<string>());
        foreach (var (id, bytes) in authorityBytes)
            Assert.Equal(bytes, await File.ReadAllTextAsync(Authority(temp.Path, id)));
        Assert.Equal(bindings, await File.ReadAllTextAsync(channels));
        await File.WriteAllTextAsync(Authority(temp.Path, "grand"), original);
        var result = await manager.DeleteAsync("root", true);
        Assert.Equal(
            new[] { "grand", "child", "root" },
            result["deletedSessionIds"]!.AsArray().Select(node => node!.GetValue<string>())
        );
        Assert.Empty(manager.Catalog.List());
        Assert.Empty(JsonNode.Parse(await File.ReadAllTextAsync(channels))!["channels"]!.AsObject());
    }

    [Fact]
    public async Task Source_alias_self_rejection_precedes_effects_and_source_surviving_child_keeps_its_canonical_save_lane()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("root", 0),
            SessionCatalogTests.Row("source", 0, "root", aliases: ["self"])
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var source = await manager.RequiredAsync("source");
        var bytes = await File.ReadAllTextAsync(Authority(temp.Path, "source"));
        var self = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("self", source: source)
        );
        Assert.Equal("SESSION_DELETE_CURRENT", self.Code);
        Assert.Equal(bytes, await File.ReadAllTextAsync(Authority(temp.Path, "source")));
        var result = await manager.ExecuteAgentToolAsync(
            source,
            "delete_session",
            new() { ["sessionId"] = "root" }
        );
        Assert.Null(result.Response["error"]);
        await source.Entry.SaveLane.SaveStrictAsync();
        Assert.Null(manager.Catalog.Get("source")!["parentSessionId"]);
        Assert.Null(
            JsonNode.Parse(await File.ReadAllTextAsync(Authority(temp.Path, "source")))![
                "parentSessionId"
            ]
        );
    }

    [Fact]
    public async Task Real_primary_bindings_and_selected_migration_evidence_do_not_invent_attachments_from_lastChannel()
    {
        using var temp = new TempDirectory();
        var row = SessionCatalogTests.Row("target", 0, aliases: ["alias"]);
        row["meta"]!["lastChannel"] = new JsonObject
        {
            ["channelId"] = "discord",
            ["channelUserId"] = "old",
        };
        await Seed(temp.Path, row);
        var channels = Path.Combine(temp.Path, "data", "state", "channels.json");
        await File.WriteAllTextAsync(
            channels,
            "{\"channels\":{\"discord:room\":{\"sessionId\":\"target\"},\"webui:chat\":{\"sessionId\":\"target\"},\"other:room\":{\"sessionId\":\"alias\"}}}"
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var blocked = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("target")
        );
        Assert.Equal("SESSION_DELETE_CHANNEL_BLOCKED", blocked.Code);
        Assert.True(File.Exists(Authority(temp.Path, "target")));
        await File.WriteAllTextAsync(channels, "broken");
        await Assert.ThrowsAnyAsync<Exception>(() => manager.DeleteAsync("target"));
        Assert.True(File.Exists(Authority(temp.Path, "target")));
        File.Delete(channels);
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "data", "state", "sessions.json.pre-catalog-sqlite-v1.bak"),
            "{\"channelAttachments\":{\"webui:chat\":\"target\",\"other:room\":{\"sessionId\":\"alias\",\"mode\":\"push-only\",\"dangerouslyAllowAllGroupMembers\":true}}}"
        );
        await manager.DeleteAsync("target");
        var actual = JsonNode.Parse(await File.ReadAllTextAsync(channels))!["channels"]!;
        Assert.Null(actual["webui:chat"]);
        Assert.Equal("alias", actual["other:room"]!["sessionId"]!.GetValue<string>());
        Assert.Equal("send-only", actual["other:room"]!["mode"]!.GetValue<string>());
        Assert.True(actual["other:room"]!["dangerouslyAllowAllUsers"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Exact_read_admission_settles_before_retirement_and_claimed_targets_reject_late_mutation_without_blocking_other_IDs()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("target", 0),
            SessionCatalogTests.Row("other", 0)
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var readReached = Signal();
        var readRelease = Signal();
        var retireReached = Signal();
        var retireRelease = Signal();
        manager.BeforeAdmissionRead = async (id, token) =>
        {
            if (id == "target")
            {
                readReached.TrySetResult();
                await readRelease.Task.WaitAsync(token);
            }
        };
        var read = manager.GetExistingAsync("target");
        await readReached.Task;
        manager.BeforeDeleteStage = async (stage, _) =>
        {
            if (stage == "retire")
            {
                retireReached.TrySetResult();
                await retireRelease.Task;
            }
        };
        var deletion = manager.DeleteAsync("target");
        Assert.False(deletion.IsCompleted);
        var other = await manager.RequiredAsync("other").WaitAsync(TimeSpan.FromSeconds(2));
        readRelease.TrySetResult();
        var captured = (await read)!;
        await retireReached.Task;
        await Assert.ThrowsAsync<SessionDeletionException>(() => manager.ClearAsync(captured));
        await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.ForkAsync(captured, "late")
        );
        await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.CreateChildAsync(captured, "late", null, null, null, null)
        );
        await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.RefreshSnapshotAsync(captured)
        );
        await Assert.ThrowsAsync<SessionDeletionException>(() => captured.StartProcessing(true));
        await Assert.ThrowsAsync<SessionDeletionException>(() =>
            captured.Entry.SaveLane.AdmitAsync(
                SessionWait.Event("late", "late", new(), new()),
                SaveKind.Strict
            )
        );
        await other.Entry.SaveLane.SaveStrictAsync();
        retireRelease.TrySetResult();
        await deletion.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(manager.Catalog.Get("target"));
    }

    [Fact]
    public async Task A_real_JSON_unlink_failure_keeps_actual_retirement_and_same_host_retry_only_the_frozen_lifetime()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("target", 0),
            SessionCatalogTests.Row("child", 0, "target")
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("target");
        var file = Authority(temp.Path, "target");
        var saved = file + ".held";
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (stage == "json-unlink" && id == "target")
            {
                File.Move(file, saved);
                Directory.CreateDirectory(file);
            }
            return Task.CompletedTask;
        };
        var failure = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("target")
        );
        Assert.Equal("json-unlink", failure.Details["failedStage"]!.GetValue<string>());
        Assert.Equal(
            new[] { "child" },
            failure.Details["detachedChildSessionIds"]!
                .AsArray()
                .Select(node => node!.GetValue<string>())
        );
        Assert.True(owner.Entry.Retired);
        Assert.NotNull(manager.Catalog.Get("target"));
        await Assert.ThrowsAsync<SessionDeletionException>(() => manager.RequiredAsync("target"));
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.Entry.SaveLane.SaveStrictAsync()
        );
        manager.BeforeDeleteStage = null;
        Directory.Delete(file);
        File.Move(saved, file);
        var retry = await manager.DeleteAsync("target");
        Assert.True(retry["continuedSameHost"]!.GetValue<bool>());
        Assert.Null(manager.Catalog.Get("target"));
        Assert.False(File.Exists(file));
    }

    [Theory]
    [InlineData("inactive", true)]
    [InlineData("orphan", false)]
    [InlineData("active", false)]
    public async Task Actual_source_Worker_v2_inactive_cleanup_absent_owner_preservation_and_active_fence(
        string mode,
        bool cleaned
    )
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, SessionCatalogTests.Row("target", 0));
        var file = Path.Combine(temp.Path, "data", "state", "session-runtime.sqlite");
        await Worker(file, mode);
        var helper = new SessionDeletionWorkerStore(Path.Combine(temp.Path, "data"));
        helper.Preflight([]);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        if (mode == "active")
        {
            var failure = await Assert.ThrowsAsync<SessionDeletionException>(() =>
                manager.DeleteAsync("target")
            );
            Assert.Equal("SESSION_DELETE_WORKER_UNSUPPORTED", failure.Code);
            Assert.True(File.Exists(Authority(temp.Path, "target")));
        }
        else
        {
            var result = await manager.DeleteAsync("target");
            Assert.Equal(
                cleaned ? new[] { "target" } : [],
                result["workerRowsRemovedSessionIds"]!
                    .AsArray()
                    .Select(node => node!.GetValue<string>())
            );
        }
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM session_worker_mailbox";
        Assert.Equal(cleaned ? 0L : 1L, command.ExecuteScalar());
        command.CommandText = "PRAGMA user_version";
        Assert.Equal(2L, command.ExecuteScalar());
    }

    [Fact]
    public async Task Registry_delete_is_nondefault_discoverable_and_neutral_dispatch_keeps_real_self_checks()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("source", 0, aliases: ["self"]),
            SessionCatalogTests.Row("target", 0)
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var source = await manager.RequiredAsync("source");
        await using var mcp = new Foxwarm.McpClient(Path.Combine(temp.Path, "data"));
        var registry = SessionToolExecutor.CreateRegistry(
            new JsonArray(
                AgentToolDefinitions
                    .Definitions()
                    .Select(def => (JsonNode?)def.DeepClone())
                    .ToArray()
            ),
            mcp,
            _ => Path.Combine(temp.Path, "workspace")
        );
        Assert.DoesNotContain(
            registry.ModelDefinitions().OfType<JsonObject>(),
            definition => definition["name"]!.GetValue<string>() == "delete_session"
        );
        var registration = registry.Entries.Single(entry =>
            entry.Definition["name"]!.GetValue<string>() == "delete_session"
        );
        Assert.Equal("builtin", registration.Source);
        Assert.False(registration.DefaultInject);
        Assert.Equal(
            new[] { "sessionId" },
            registration.Definition["parameters"]!["required"]!
                .AsArray()
                .Select(node => node!.GetValue<string>())
        );
        var executor = new SessionToolExecutor(
            new UnsupportedTurnToolExecutor(),
            source,
            manager,
            registry
        );
        var self = await executor.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "call_tool",
                ["args"] = new JsonObject
                {
                    ["toolId"] = "builtin:delete_session",
                    ["args"] = new JsonObject { ["sessionId"] = "self" },
                },
            },
            default
        );
        Assert.Equal("SESSION_DELETE_CURRENT", self!["error"]!["type"]!.GetValue<string>());
        var deleted = await executor.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "call_tool",
                ["args"] = new JsonObject
                {
                    ["source"] = "builtin",
                    ["name"] = "delete_session",
                    ["args"] = new JsonObject { ["sessionId"] = "target" },
                },
            },
            default
        );
        Assert.Null(deleted!["error"]);
        Assert.Null(manager.Catalog.Get("target"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Same_host_retry_ignores_a_completed_member_real_delete_recreate_and_pending_new_publication(
        bool recursive
    )
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("root", 0),
            SessionCatalogTests.Row("a", 0, "root"),
            SessionCatalogTests.Row("b", 0, "root")
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var blocked = Authority(temp.Path, "b");
        var saved = blocked + ".held";
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (id == "b" && stage == (recursive ? "json-unlink" : "detach"))
            {
                if (recursive)
                {
                    File.Move(blocked, saved);
                    Directory.CreateDirectory(blocked);
                }
                else
                    throw new IOException("Owned second-survivor boundary failure.");
            }
            return Task.CompletedTask;
        };
        var failure = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("root", recursive)
        );
        Assert.Equal(
            new[] { "b", "root" },
            failure.Details["stillClaimedSessionIds"]!
                .AsArray()
                .Select(node => node!.GetValue<string>())
                .Order(StringComparer.Ordinal)
        );
        if (!recursive)
            await manager.DeleteAsync("a"); // The already-detached member is free for an independent lifetime.
        manager.BeforeDeleteStage = null;
        if (recursive)
        {
            Directory.Delete(blocked);
            File.Move(saved, blocked);
        }
        var reached = Signal();
        var release = Signal();
        manager.BeforeCreationPublication = async id =>
        {
            if (id == "a")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var creating = manager.CreateNamedAsync("main", "a", null, null);
        await reached.Task;
        try
        {
            var newAuthority = await File.ReadAllTextAsync(Authority(temp.Path, "a"));
            var retried = await manager
                .DeleteAsync("root", recursive)
                .WaitAsync(TimeSpan.FromSeconds(3));
            Assert.True(retried["continuedSameHost"]!.GetValue<bool>());
            Assert.NotNull(manager.Catalog.Get("a"));
            Assert.Equal(newAuthority, await File.ReadAllTextAsync(Authority(temp.Path, "a")));
            Assert.False(creating.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        var created = await creating;
        await created.Entry.SaveLane.SaveStrictAsync();
        Assert.Same(created, manager.Find("a"));
    }

    [Fact]
    public async Task Read_old_archive_free_command_source_can_be_recreated_but_does_not_authorize_its_predecessor_partial_retry()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("source", 0),
            SessionCatalogTests.Row("target", 0)
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var router = new MessageRouter(new SessionRuntime(manager));
        var target = Authority(temp.Path, "target");
        var original = target + ".held";
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (stage == "json-unlink" && id == "target")
            {
                File.Move(target, original);
                Directory.CreateDirectory(target);
            }
            return Task.CompletedTask;
        };
        var failed = await router.HandleMessageAsync(
            new ChannelContext("source", "webui"),
            new ChannelMessage("/session delete target", null)
        );
        Assert.Equal(500, failed.Status);
        await manager.DeleteAsync("source");
        var recreated = await manager.CreateNamedAsync("main", "source", null, null);
        manager.BeforeDeleteStage = null;
        Directory.Delete(target);
        File.Move(original, target);
        var targetBytes = await File.ReadAllTextAsync(target);
        var refused = await router.HandleMessageAsync(
            new ChannelContext("source", "webui"),
            new ChannelMessage("/session delete target", null)
        );
        var response = System.Text.Json.JsonSerializer.SerializeToNode(refused.Value)!;
        Assert.Equal(
            "SESSION_DELETE_RETRY_MISMATCH",
            response["result"]!["code"]!.GetValue<string>()
        );
        Assert.Equal(targetBytes, await File.ReadAllTextAsync(target));
        Assert.NotNull(manager.Catalog.Get("target"));
        Assert.Same(recreated, manager.Find("source"));
    }

    [Fact]
    public async Task A_completed_notification_failure_does_not_capture_a_legal_recreated_lifetime_as_pending_cleanup()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, SessionCatalogTests.Row("target", 0));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var atCommit = false;
        var fault = true;
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (stage == "catalog")
                atCommit = true;
            return Task.CompletedTask;
        };
        manager.TopologyChanged += () =>
        {
            if (atCommit && fault)
            {
                fault = false;
                throw new IOException("Owned committed notification failure.");
            }
        };
        var failure = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("target")
        );
        Assert.Empty(failure.Details["remainingSessionIds"]!.AsArray());
        Assert.Equal("target", failure.Details["deletedSessionIds"]![0]!.GetValue<string>());
        Assert.Null(manager.Catalog.Get("target"));
        var replacement = await manager.CreateNamedAsync("main", "target", null, null);
        manager.BeforeDeleteStage = null;
        var deleted = await manager.DeleteAsync("target");
        Assert.Null(deleted["continuedSameHost"]);
        Assert.True(replacement.Entry.Retired);
        Assert.Null(manager.Catalog.Get("target"));
    }

    [Fact]
    public async Task Shutdown_drains_an_already_accepted_target_retirement_before_final_owner_snapshot()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            SessionCatalogTests.Row("root", 0),
            SessionCatalogTests.Row("child", 0, "root")
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var reached = Signal();
        var release = Signal();
        manager.BeforeDeleteStage = async (stage, id) =>
        {
            if (stage == "retire" && id == "root")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var deleting = manager.DeleteAsync("root");
        await reached.Task;
        var draining = manager.ShutdownAsync();
        await Task.Delay(30);
        Assert.False(draining.IsCompleted);
        release.TrySetResult();
        await deleting.WaitAsync(TimeSpan.FromSeconds(3));
        await draining.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Null(manager.Catalog.Get("root"));
        Assert.Null(manager.Catalog.Get("child")!["parentSessionId"]);
        Assert.False(File.Exists(Authority(temp.Path, "root")));
    }

    private static async Task Worker(string file, string mode)
    {
        var root = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var start = new ProcessStartInfo("node")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(
                    root,
                    "dotnet",
                    "Foxwarm.Tests",
                    "Fixtures",
                    "session-delete-worker-fixture-ts.mjs"
                ),
                file,
                mode,
            }
        )
            start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000))
        {
            process.Kill(true);
            throw new TimeoutException("Owned source Worker fixture timed out.");
        }
        Assert.True(process.ExitCode == 0, await output + await error);
    }
}
