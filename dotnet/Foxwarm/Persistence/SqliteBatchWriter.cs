using System.Threading.Channels;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Persistence;

internal readonly record struct WriteReceipt<T>(Task<T> Completion);

// One connection and one execution loop. Admission is separate from the committed receipt.
internal sealed class SqliteBatchWriter : IAsyncDisposable
{
    internal const int QueueCapacity = 256;
    internal const int BatchLimit = 64;
    private readonly Channel<Command> queue = Channel.CreateBounded<Command>(
        new BoundedChannelOptions(QueueCapacity)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false,
        }
    );
    private readonly Func<SqliteConnection> open;
    private readonly Task loop;
    internal Action<SqliteConnection, SqliteTransaction, int>? BeforeCommit { get; set; }
    internal Func<Task>? BeforeBatch { get; set; }
    internal long CommittedBatches { get; private set; }
    internal long CommittedCommands { get; private set; }
    internal int LargestBatch { get; private set; }

    internal SqliteBatchWriter(Func<SqliteConnection> open)
    {
        this.open = open;
        loop = Task.Run(RunAsync);
    }

    internal ValueTask<WriteReceipt<T>> EnqueueAsync<T>(
        Func<SqliteConnection, SqliteTransaction, T> execute,
        CancellationToken token = default
    ) => AdmitAsync(new Work<T>(execute, token), token);

    // Maintenance runs between committed batches, never concurrently with the connection owner.
    internal ValueTask<WriteReceipt<T>> ExclusiveAsync<T>(
        Func<SqliteConnection, Task<T>> execute,
        CancellationToken token = default
    ) => AdmitAsync(new Exclusive<T>(execute, token), token);

    private async ValueTask<WriteReceipt<T>> AdmitAsync<T>(
        ResultCommand<T> command,
        CancellationToken token
    )
    {
        await queue.Writer.WriteAsync(command, token).ConfigureAwait(false);
        return new(command.Completion.Task);
    }

    private async Task RunAsync()
    {
        SqliteConnection? connection = null;
        Command? pending = null;
        Command? current = null;
        try
        {
            while (
                pending is not null || await queue.Reader.WaitToReadAsync().ConfigureAwait(false)
            )
            {
                var first = pending ?? await queue.Reader.ReadAsync().ConfigureAwait(false);
                pending = null;
                current = first;
                connection ??= open();
                if (first.IsExclusive)
                {
                    await first.RunExclusiveAsync(connection).ConfigureAwait(false);
                    current = null;
                    continue;
                }
                var batch = new List<Command>(BatchLimit) { first };
                // A bounded one-millisecond coalescing window, not a wait for a full batch.
                if (BeforeBatch is { } beforeBatch)
                    await beforeBatch().ConfigureAwait(false);
                await Task.Delay(1).ConfigureAwait(false);
                while (batch.Count < BatchLimit && queue.Reader.TryRead(out var next))
                {
                    if (next.IsExclusive)
                    {
                        pending = next;
                        break;
                    }
                    batch.Add(next);
                }
                ExecuteBatch(connection, batch);
                current = null;
            }
        }
        catch (Exception error)
        {
            queue.Writer.TryComplete(error);
            current?.Fail(error);
            pending?.Fail(error);
            while (queue.Reader.TryRead(out var command))
                command.Fail(error);
        }
        finally
        {
            connection?.Dispose();
        }
    }

    private void ExecuteBatch(SqliteConnection connection, List<Command> batch)
    {
        try
        {
            using var transaction = connection.BeginTransaction(deferred: false);
            foreach (var command in batch)
            {
                if (command.CancelBeforeExecution())
                    continue;
                transaction.Save("command");
                try
                {
                    command.Execute(connection, transaction);
                    transaction.Release("command");
                }
                catch (Exception error)
                {
                    transaction.Rollback("command");
                    transaction.Release("command");
                    command.Error = error;
                }
            }
            BeforeCommit?.Invoke(connection, transaction, batch.Count);
            transaction.Commit();
            CommittedBatches++;
            CommittedCommands += batch.Count;
            LargestBatch = Math.Max(LargestBatch, batch.Count);
            foreach (var command in batch)
                command.Complete();
        }
        catch (Exception error)
        {
            // No member succeeds when the outer commit (or savepoint recovery) fails.
            foreach (var command in batch)
                command.Fail(error);
        }
    }

    public async ValueTask DisposeAsync()
    {
        queue.Writer.TryComplete();
        await loop.ConfigureAwait(false);
    }

    private abstract class Command(CancellationToken token)
    {
        internal Exception? Error;
        internal virtual bool IsExclusive => false;

        internal bool CancelBeforeExecution()
        {
            if (!token.IsCancellationRequested)
                return false;
            Error = new OperationCanceledException(token);
            return true;
        }

        internal abstract void Execute(SqliteConnection connection, SqliteTransaction transaction);
        internal abstract Task RunExclusiveAsync(SqliteConnection connection);
        internal abstract void Complete();
        internal abstract void Fail(Exception error);
    }

    private abstract class ResultCommand<T>(CancellationToken token) : Command(token)
    {
        internal readonly TaskCompletionSource<T> Completion = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        protected T result = default!;

        internal override void Complete()
        {
            if (Error is { } error)
                Fail(error);
            else
                Completion.TrySetResult(result);
        }

        internal override void Fail(Exception error)
        {
            if (error is OperationCanceledException cancelled)
                Completion.TrySetCanceled(cancelled.CancellationToken);
            else
                Completion.TrySetException(error);
        }
    }

    private sealed class Work<T>(
        Func<SqliteConnection, SqliteTransaction, T> execute,
        CancellationToken token
    ) : ResultCommand<T>(token)
    {
        internal override void Execute(
            SqliteConnection connection,
            SqliteTransaction transaction
        ) => result = execute(connection, transaction);

        internal override Task RunExclusiveAsync(SqliteConnection connection) =>
            throw new InvalidOperationException();
    }

    private sealed class Exclusive<T>(
        Func<SqliteConnection, Task<T>> execute,
        CancellationToken token
    ) : ResultCommand<T>(token)
    {
        internal override bool IsExclusive => true;

        internal override void Execute(
            SqliteConnection connection,
            SqliteTransaction transaction
        ) => throw new InvalidOperationException();

        internal override async Task RunExclusiveAsync(SqliteConnection connection)
        {
            try
            {
                if (!CancelBeforeExecution())
                    result = await execute(connection).ConfigureAwait(false);
                Complete();
            }
            catch (Exception error)
            {
                Fail(error);
            }
        }
    }
}

// Main pins a data-root owner until its producers stop. Standalone tools/adapters borrow the same
// owner for their accepted work; the final lease drains it and closes its connection.
internal static class SqliteWriterOwners
{
    private static readonly object sync = new();
    private static readonly Dictionary<string, Entry> owners = new(StringComparer.Ordinal);

    internal static Lease Acquire(string path, Func<SqliteConnection> open)
    {
        path = Path.GetFullPath(path);
        while (true)
        {
            Task? closing;
            lock (sync)
            {
                if (!owners.TryGetValue(path, out var entry))
                    owners.Add(path, entry = new(new SqliteBatchWriter(open)));
                closing = entry.Closing;
                if (closing is null)
                {
                    entry.References++;
                    return new(path, entry);
                }
                if (closing.IsCompleted)
                {
                    owners.Remove(path);
                    continue;
                }
            }
            closing.GetAwaiter().GetResult();
        }
    }

    internal sealed class Entry(SqliteBatchWriter writer)
    {
        internal readonly SqliteBatchWriter Writer = writer;
        internal int References;
        internal Task? Closing;
    }

    internal sealed class Lease(string path, Entry entry) : IAsyncDisposable, IDisposable
    {
        private bool released;
        internal SqliteBatchWriter Writer => entry.Writer;

        public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

        public ValueTask DisposeAsync()
        {
            lock (sync)
            {
                if (released)
                    return ValueTask.CompletedTask;
                released = true;
                if (--entry.References != 0)
                    return ValueTask.CompletedTask;
                entry.Closing = entry.Writer.DisposeAsync().AsTask();
            }
            return new ValueTask(RemoveAfterDrainAsync());
        }

        private async Task RemoveAfterDrainAsync()
        {
            await entry.Closing!.ConfigureAwait(false);
            lock (sync)
                if (owners.GetValueOrDefault(path) == entry)
                    owners.Remove(path);
        }
    }
}
