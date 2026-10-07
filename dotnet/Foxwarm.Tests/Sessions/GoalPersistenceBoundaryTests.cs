using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class GoalPersistenceBoundaryTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    [Fact]
    public async Task Strict_owner_save_migrates_goal_once_and_identity_move_does_not_duplicate_task()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "goal-owner", null, null);
        owner.Entry.WithState(state => state.AuthorityEnvelope["goalState"] = Goal("ship it"));

        await owner.Entry.SaveLane.SaveStrictAsync();
        Assert.Null(owner.Entry.Snapshot().AuthorityEnvelope["goalState"]);
        Assert.Null(
            (await owner.AuthorityStore.LoadAsync(owner.Id))!.AuthorityEnvelope["goalState"]
        );
        Assert.Equal(1, CountTasks(data));

        await manager.MoveIdentityAsync(
            owner,
            new JsonObject { ["newSessionId"] = "goal-owner-moved" }
        );
        var moved = await manager.RequiredAsync("goal-owner-moved");
        await moved.Entry.SaveLane.SaveStrictAsync();
        Assert.Equal(1, CountTasks(data));
    }

    [Fact]
    public async Task Best_effort_postcommit_goal_save_keeps_hot_queue_and_clears_persisted_goal()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var inner = new PersistentSessionAuthorityStore(data, "goal-postcommit");
        var entry = new SessionEntry(
            new SessionState("goal-postcommit"),
            new FaultingAuthorityStore(inner, postcommit: true),
            Migration(manager)
        );
        entry.WithState(state => state.AuthorityEnvelope["goalState"] = Goal("postcommit"));
        await inner.CommitAsync(entry.Snapshot(), SaveKind.Strict);

        await entry.SaveLane.AdmitAsync(QueueItem.UserText("hot queue"), SaveKind.BestEffort);

        Assert.Null(entry.Snapshot().AuthorityEnvelope["goalState"]);
        Assert.Single(entry.Snapshot().Queue);
        Assert.Null((await inner.LoadAsync(entry.Snapshot().Id))!.AuthorityEnvelope["goalState"]);
        Assert.Equal(1, CountTasks(data));
        Assert.Equal(1, entry.BestEffortFailureCount);
    }

    [Fact]
    public async Task Best_effort_precommit_goal_failure_preserves_goal_and_retry_is_idempotent()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var inner = new PersistentSessionAuthorityStore(data, "goal-precommit");
        var fault = new FaultingAuthorityStore(inner, postcommit: false);
        var entry = new SessionEntry(new SessionState("goal-precommit"), fault, Migration(manager));
        entry.WithState(state => state.AuthorityEnvelope["goalState"] = Goal("precommit"));
        await inner.CommitAsync(entry.Snapshot(), SaveKind.Strict);

        await entry.SaveLane.AdmitAsync(QueueItem.UserText("queued"), SaveKind.BestEffort);

        Assert.NotNull(entry.Snapshot().AuthorityEnvelope["goalState"]);
        Assert.Single(entry.Snapshot().Queue);
        Assert.NotNull(
            (await inner.LoadAsync(entry.Snapshot().Id))!.AuthorityEnvelope["goalState"]
        );
        Assert.Equal(1, CountTasks(data));

        fault.Fail = false;
        await entry.SaveLane.SaveStrictAsync();
        Assert.Null(entry.Snapshot().AuthorityEnvelope["goalState"]);
        Assert.Null((await inner.LoadAsync(entry.Snapshot().Id))!.AuthorityEnvelope["goalState"]);
        Assert.Equal(1, CountTasks(data));
    }

    private static JsonObject Goal(string text) => new() { ["goal"] = text, ["anchorSeq"] = 0 };

    private static Func<SessionSnapshot, Task<SessionSnapshot>> Migration(SessionManager manager)
    {
        var method = typeof(SessionManager).GetMethod(
            "MigrateGoalSnapshotAsync",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!;
        return snapshot => (Task<SessionSnapshot>)method.Invoke(manager, [snapshot])!;
    }

    private static int CountTasks(string data)
    {
        using var db = new SqliteConnection(
            $"Data Source={Path.Combine(data, "state", "tasks.sqlite")}"
        );
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM tasks";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    private sealed class FaultingAuthorityStore(ISessionAuthorityStore inner, bool postcommit)
        : ISessionAuthorityStore
    {
        internal bool Fail { get; set; } = true;

        public async Task CommitAsync(
            SessionSnapshot snapshot,
            SaveKind kind,
            CancellationToken cancellationToken = default
        )
        {
            if (!Fail)
            {
                await inner.CommitAsync(snapshot, kind, cancellationToken);
                return;
            }
            Fail = false;
            if (postcommit)
            {
                await inner.CommitAsync(snapshot, kind, cancellationToken);
                throw new AuthorityCommittedException("postcommit fault", new IOException("fault"));
            }
            throw new IOException("precommit fault");
        }

        public Task<SessionSnapshot?> LoadAsync(
            string sessionId,
            CancellationToken cancellationToken = default
        ) => inner.LoadAsync(sessionId, cancellationToken);
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-goal-boundary-tests-" + Guid.NewGuid().ToString("N")
            );

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, true);
    }
}
