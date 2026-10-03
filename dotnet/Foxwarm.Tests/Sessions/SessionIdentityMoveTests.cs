using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionIdentityMoveTests
{
    private static ResponsesClientOptions Options => new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
    private static SessionManager Manager(string data, string work) => new(data, work, Options, HostModels.ForTest(Options));
    private static JsonObject Text(string text) => new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };
    private static void Sql(string data, string sql)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(data, "state", "archive-store.sqlite"), Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        db.Open(); using var command = db.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery();
    }
    [Fact]
    public async Task Same_canonical_target_is_reserved_not_a_noop_and_cannot_apply_a_parent_override()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        await using var manager = Manager(data, work); await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "same", null, null); var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var before = await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", "same.json"));
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "same", ["parentSessionId"] = parent.Id }));
        Assert.Null(owner.Metadata().ParentSessionId); Assert.Equal(before, await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", "same.json")));
        Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
    }
    [Fact]
    public async Task Same_owner_chain_preserves_owned_history_cache_snapshot_and_immutable_audit_then_reserves_every_historical_id()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        await using var manager = Manager(data, work); await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", "Display", null); var entry = owner.Entry;
        await ForkClearLifecycleTests.AppendAsync(owner, Text("Original bytes.")); var before = entry.Snapshot(); var audit = owner.Archive.ReadMessages().Single();
        await manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "middle" });
        Assert.Same(owner, await manager.GetExistingAsync("old")); Assert.Same(entry, owner.Entry); Assert.Equal("middle", owner.Id);
        var created = await manager.CreateAgentAsync("destination", false);
        await manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "current", ["newAgentName"] = created.AgentName });
        Assert.Same(owner, await manager.GetExistingAsync("old")); Assert.Same(owner, await manager.GetExistingAsync("middle")); Assert.Same(entry, owner.Entry);
        var current = entry.Snapshot(); Assert.Equal("destination/current", current.Id);
        Assert.Equal(before.History.Select(row => row.ToJsonString()), current.History.Select(row => row.ToJsonString()));
        Assert.Equal(before.AuthorityEnvelope["promptCacheKey"]!.ToJsonString(), current.AuthorityEnvelope["promptCacheKey"]!.ToJsonString());
        Assert.Equal(before.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString(), current.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString());
        Assert.Equal("Display", owner.Metadata().DisplayName);
        await ForkClearLifecycleTests.AppendAsync(owner, Text("New Agent attribution."));
        var rows = new SqliteArchiveMessageStore(Path.Combine(data, "state", "archive-store.sqlite"), "old").ReadMessages();
        Assert.Equal(audit.MessageJson, rows[0].MessageJson); Assert.Equal("main", rows[0].Agent); Assert.Equal("destination", rows[1].Agent);
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "old.json"))); Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "middle.json")));
        foreach (var id in new[] { "old", "middle" }) await Assert.ThrowsAsync<InvalidDataException>(() => manager.CreateNamedAsync("main", id, null, null));
    }
    [Fact]
    public async Task Complete_rollback_keeps_same_owner_and_releases_uncommitted_target_for_a_real_new_lifetime()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        await using var manager = Manager(data, work); await manager.LoadAsync(); var owner = await manager.CreateNamedAsync("main", "source", null, null);
        await ForkClearLifecycleTests.AppendAsync(owner, Text("Before rollback."));
        manager.BeforeIdentityStage = (_, stage) => stage == "after-target-persistence" ? Task.FromException(new IOException("Forward fault.")) : Task.CompletedTask;
        var error = await Assert.ThrowsAsync<SessionIdentityMoveException>(() => manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "target" }));
        Assert.True(error.Details["rolledBack"]!.GetValue<bool>()); Assert.Equal("source", owner.Id); Assert.Same(owner, await manager.GetExistingAsync("source"));
        Assert.Null(await manager.GetExistingAsync("target")); Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
        manager.BeforeIdentityStage = null; await ForkClearLifecycleTests.AppendAsync(owner, Text("Allowed after complete rollback."));
        var replacement = await manager.CreateNamedAsync("main", "target", null, null); Assert.NotSame(owner, replacement); Assert.Equal("target", replacement.Id);
    }
    [Fact]
    public async Task Failed_real_reverse_archive_write_blocks_target_append_and_ingress_without_touching_independent_owner_and_recovers_directionally()
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        var manager = Manager(data, work); await manager.LoadAsync();
        var target = await manager.CreateNamedAsync("main", "old", null, null); var independent = await manager.CreateNamedAsync("main", "caller", null, null);
        await ForkClearLifecycleTests.AppendAsync(target, Text("Target original."));
        manager.BeforeIdentityStage = (_, stage) =>
        {
            if (stage != "after-target-persistence") return Task.CompletedTask;
            Sql(data, "CREATE TRIGGER fail_reverse BEFORE UPDATE OF session_id ON archive_branches WHEN OLD.session_id='new' AND NEW.session_id='old' BEGIN SELECT RAISE(ABORT,'Reverse fault'); END");
            return Task.FromException(new IOException("Forward target-persistence fault."));
        };
        var error = await Assert.ThrowsAsync<SessionIdentityMoveException>(() => manager.MoveIdentityAsync(independent, new JsonObject { ["sessionId"] = "old", ["newSessionId"] = "new" }));
        Assert.True(error.Details["recoveryRequired"]!.GetValue<bool>());
        await Assert.ThrowsAsync<SessionIdentityUnavailableException>(() => ForkClearLifecycleTests.AppendAsync(target, Text("Must not create an old branch.")));
        await Assert.ThrowsAsync<SessionIdentityUnavailableException>(() => target.Registry.Ingress.EnqueueAsync(target.Id, new QueueItem(QueueItemType.User, [new JsonObject { ["text"] = "Blocked normal input." }])));
        await Assert.ThrowsAsync<SessionIdentityUnavailableException>(() => manager.GetExistingAsync("old"));
        await ForkClearLifecycleTests.AppendAsync(independent, Text("Independent caller can persist its partial result."));
        Assert.Null(new SqliteArchiveMessageStore(Path.Combine(data, "state", "archive-store.sqlite"), "old").ReadBranch());
        Assert.Single(new SqliteArchiveMessageStore(Path.Combine(data, "state", "archive-store.sqlite"), "new").ReadMessages());
        Sql(data, "DROP TRIGGER fail_reverse");
        try { await manager.DisposeAsync(); } catch (SessionIdentityUnavailableException) { }
        await using var restarted = Manager(data, work); await restarted.LoadAsync();
        Assert.False(File.Exists(Path.Combine(data, "state", "session-id-move-pending.json")));
        var restored = await restarted.GetExistingAsync("old"); Assert.NotNull(restored); Assert.Single(restored!.Archive.ReadMessages());
        Assert.Null(await restarted.GetExistingAsync("new"));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_fork_retains_original_zero_or_nonzero_inherited_caps_and_bytes_after_parent_move_append_delete_and_restart(bool seeded)
    {
        using var temp = new TempDirectory(); var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
        string childId; string[] original; long cap;
        await using (var manager = Manager(data, work))
        {
            await manager.LoadAsync(); var parent = await manager.CreateNamedAsync("main", "old", null, null);
            if (seeded) await ForkClearLifecycleTests.AppendAsync(parent, Text("Captured prefix."));
            var child = await manager.ForkAsync(parent, "fork"); childId = child.Id; cap = child.Archive.ReadBranch()!.MessageCap;
            Assert.Equal(seeded ? 1 : 0, cap); original = child.Archive.ReadEffectiveMessagesRange(1, long.MaxValue).Select(row => row.MessageJson).ToArray();
            await manager.MoveIdentityAsync(parent, new JsonObject { ["newSessionId"] = "moved" }); await ForkClearLifecycleTests.AppendAsync(parent, Text("Later parent row."));
            Assert.Equal("moved", child.Archive.ReadBranch()!.ParentSessionId); Assert.Equal(cap, child.Archive.ReadBranch()!.MessageCap);
            Assert.Equal(original, child.Archive.ReadEffectiveMessagesRange(1, long.MaxValue).Select(row => row.MessageJson));
            await manager.DeleteAsync("old", source: child);
        }
        await using var restarted = Manager(data, work); await restarted.LoadAsync(); var retained = await restarted.RequiredAsync(childId);
        Assert.Equal(cap, retained.Archive.ReadBranch()!.MessageCap); Assert.Equal(original, retained.Archive.ReadEffectiveMessagesRange(1, long.MaxValue).Select(row => row.MessageJson));
        await Assert.ThrowsAsync<InvalidDataException>(() => restarted.CreateNamedAsync("main", "old", null, null));
        await Assert.ThrowsAsync<InvalidDataException>(() => restarted.CreateNamedAsync("main", "moved", null, null));
    }

}
