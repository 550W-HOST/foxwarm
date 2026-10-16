using Foxwarm.Persistence;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SqliteBatchWriterTests
{
    [Fact]
    public async Task One_outer_commit_publishes_ordered_commands_and_isolates_a_failed_savepoint()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "batch.sqlite");
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var writer = Create(path);
        writer.BeforeBatch = () => { held.TrySetResult(); return release.Task; };
        var first = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1));
        await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var rejected = await writer.EnqueueAsync<int>((db, tx) =>
        {
            Insert(db, tx, 2);
            throw new InvalidDataException("Reject this command, including its partial insert.");
        });
        var dependent = await writer.EnqueueAsync<int>((db, tx) =>
        {
            Assert.Equal(1, Count(db, tx));
            Insert(db, tx, 3);
            return 3;
        });
        var reachedCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var commit = new ManualResetEventSlim();
        writer.BeforeCommit = (_, _, size) =>
        {
            Assert.Equal(3, size);
            reachedCommit.TrySetResult();
            Assert.True(commit.Wait(TimeSpan.FromSeconds(5)));
        };
        release.SetResult();
        try
        {
            await reachedCommit.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(first.Completion.IsCompleted);
            Assert.False(dependent.Completion.IsCompleted);
            Assert.Equal(0, ReadCount(path));
        }
        finally { commit.Set(); }
        Assert.Equal(1, await first.Completion);
        await Assert.ThrowsAsync<InvalidDataException>(() => rejected.Completion);
        Assert.Equal(3, await dependent.Completion);
        Assert.Equal(2, ReadCount(path));
        Assert.Equal(1, writer.CommittedBatches);
        Assert.Equal(3, writer.LargestBatch);
    }

    [Fact]
    public async Task Failed_outer_commit_fails_every_receipt_and_leaves_no_partial_rows()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "commit.sqlite");
        await using var writer = Create(path);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        writer.BeforeBatch = () => release.Task;
        // A deferred foreign key produces a real SQLite failure at COMMIT, not a thrown test hook.
        writer.BeforeCommit = (db, tx, _) =>
        {
            using var command = db.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "INSERT INTO child(parent_id) VALUES(99)";
            command.ExecuteNonQuery();
        };
        var one = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1));
        var two = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 2));
        release.SetResult();
        await Assert.ThrowsAsync<SqliteException>(() => one.Completion);
        await Assert.ThrowsAsync<SqliteException>(() => two.Completion);
        Assert.Equal(0, writer.CommittedBatches);
        Assert.Equal(0, ReadCount(path));
        writer.BeforeCommit = null;
        var next = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 3));
        Assert.Equal(3, await next.Completion);
        Assert.Equal(1, ReadCount(path));
    }

    [Fact]
    public async Task Cancellation_before_execution_skips_only_that_command_but_after_execution_waits_for_commit()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "cancel.sqlite");
        await using var writer = Create(path);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        writer.BeforeBatch = () => release.Task;
        using var before = new CancellationTokenSource();
        using var after = new CancellationTokenSource();
        var skipped = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1), before.Token);
        var executed = await writer.EnqueueAsync((db, tx) =>
        {
            var value = Insert(db, tx, 2);
            after.Cancel();
            return value;
        }, after.Token);
        var unrelated = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 3));
        before.Cancel();
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => skipped.Completion);
        Assert.Equal(2, await executed.Completion);
        Assert.Equal(3, await unrelated.Completion);
        Assert.Equal(2, ReadCount(path));
    }

    [Fact]
    public async Task Full_queue_backpressures_admission_and_shutdown_drains_every_accepted_operation()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "drain.sqlite");
        var writer = Create(path);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        writer.BeforeBatch = () => { held.TrySetResult(); return release.Task; };
        var receipts = new List<WriteReceipt<int>> { await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1)) };
        await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var id = 2; id <= SqliteBatchWriter.QueueCapacity + 1; id++)
        {
            var owned = id;
            receipts.Add(await writer.EnqueueAsync((db, tx) => Insert(db, tx, owned)));
        }
        using var cancel = new CancellationTokenSource();
        var blocked = writer.EnqueueAsync((db, tx) => Insert(db, tx, 999), cancel.Token).AsTask();
        Assert.False(blocked.IsCompleted);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => blocked);
        var shutdown = writer.DisposeAsync().AsTask();
        Assert.False(shutdown.IsCompleted);
        await Assert.ThrowsAsync<System.Threading.Channels.ChannelClosedException>(async () =>
            await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1000)));
        release.SetResult();
        await shutdown.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.WhenAll(receipts.Select(receipt => receipt.Completion));
        Assert.Equal(receipts.Count, ReadCount(path));
        Assert.InRange(writer.LargestBatch, 2, SqliteBatchWriter.BatchLimit);
    }

    [Fact]
    public async Task Connection_startup_failure_resolves_first_and_all_other_accepted_receipts()
    {
        await using var writer = new SqliteBatchWriter(() => throw new IOException("Cannot open writer."));
        var receipt = await writer.EnqueueAsync((_, _) => 1);
        await Assert.ThrowsAsync<IOException>(() => receipt.Completion.WaitAsync(TimeSpan.FromSeconds(5)));
        await Assert.ThrowsAsync<System.Threading.Channels.ChannelClosedException>(async () =>
            await writer.EnqueueAsync((_, _) => 2));
    }

    [Fact]
    public async Task Exclusive_maintenance_runs_after_prior_commit_and_blocks_later_commands_until_it_finishes()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "exclusive.sqlite");
        await using var writer = Create(path);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 1));
        var maintenance = await writer.ExclusiveAsync(async db =>
        {
            Assert.Equal(1, ReadCount(path));
            Assert.Equal(1, Count(db));
            held.SetResult();
            await release.Task;
            return true;
        });
        var later = await writer.EnqueueAsync((db, tx) => Insert(db, tx, 2));
        try
        {
            await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(first.Completion.IsCompletedSuccessfully);
            Assert.False(later.Completion.IsCompleted);
            Assert.Equal(1, ReadCount(path));
        }
        finally { release.TrySetResult(); }
        await Task.WhenAll(maintenance.Completion, later.Completion);
        Assert.Equal(2, ReadCount(path));
        Assert.Equal(2, writer.CommittedBatches);
    }

    private static SqliteBatchWriter Create(string path) => new(() =>
    {
        var db = new SqliteConnection($"Data Source={path};Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE rows(id INTEGER PRIMARY KEY);
            CREATE TABLE parent(id INTEGER PRIMARY KEY);
            CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
            """;
        command.ExecuteNonQuery();
        return db;
    });

    private static int Insert(SqliteConnection db, SqliteTransaction tx, int id)
    {
        using var command = db.CreateCommand();
        command.Transaction = tx;
        command.CommandText = "INSERT INTO rows(id) VALUES($id)";
        command.Parameters.AddWithValue("$id", id);
        command.ExecuteNonQuery();
        return id;
    }

    private static int Count(SqliteConnection db, SqliteTransaction? tx = null)
    {
        using var command = db.CreateCommand();
        command.Transaction = tx;
        command.CommandText = "SELECT COUNT(*) FROM rows";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    private static int ReadCount(string path)
    {
        using var db = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        db.Open();
        return Count(db);
    }
}
