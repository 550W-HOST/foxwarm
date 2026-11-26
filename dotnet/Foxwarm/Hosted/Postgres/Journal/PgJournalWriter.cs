using System.Threading.Channels;
using Foxwarm.Persistence;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The journal's single write lane over <see cref="TenantDb"/>, with the batching contract of
/// <see cref="SqliteBatchWriter"/>: commands run in admission order, up to
/// <see cref="BatchLimit"/> of them in one fenced transaction after a one-millisecond coalescing
/// window. Each command runs under its own savepoint, so a failing command fails alone while
/// later commands of the batch still see the earlier ones. A failed or fenced transaction
/// fails every command of its batch. A lost <c>COMMIT</c> is resolved by the transaction's ID.
/// </summary>
internal sealed class PgJournalWriter : IAsyncDisposable
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
    private readonly TenantDb database;
    private readonly Task loop;

    internal PgJournalWriter(TenantDb database)
    {
        this.database = database;
        loop = Task.Run(RunAsync);
    }

    /// <summary>Test hook: awaited before each batch is collected.</summary>
    internal Func<Task>? BeforeBatch { get; set; }

    /// <summary>Test hook: runs inside the batch transaction before <c>COMMIT</c>.</summary>
    internal Action<PgTx, int>? BeforeCommit { get; set; }

    internal long CommittedBatches { get; private set; }
    internal long CommittedCommands { get; private set; }
    internal int LargestBatch { get; private set; }

    internal ValueTask<WriteReceipt<T>> EnqueueAsync<T>(
        Func<PgTx, T> execute,
        CancellationToken token = default
    ) => AdmitAsync(new Work<T>(execute, token), token);

    /// <summary>Completes once every command admitted before it has finished.</summary>
    internal async Task BarrierAsync(CancellationToken token = default)
    {
        var barrier = new Barrier(token);
        await queue.Writer.WriteAsync(barrier, token).ConfigureAwait(false);
        await barrier.Completion.Task.ConfigureAwait(false);
    }

    private async ValueTask<WriteReceipt<T>> AdmitAsync<T>(Work<T> command, CancellationToken token)
    {
        await queue.Writer.WriteAsync(command, token).ConfigureAwait(false);
        return new(command.Completion.Task);
    }

    private async Task RunAsync()
    {
        Command? pending = null;
        while (pending is not null || await queue.Reader.WaitToReadAsync().ConfigureAwait(false))
        {
            var first = pending ?? await queue.Reader.ReadAsync().ConfigureAwait(false);
            pending = null;
            if (first is Barrier barrier)
            {
                barrier.Completion.TrySetResult(true);
                continue;
            }
            var batch = new List<Command>(BatchLimit) { first };
            try
            {
                if (BeforeBatch is { } beforeBatch)
                    await beforeBatch().ConfigureAwait(false);
            }
            catch (Exception error)
            {
                first.Fail(error);
                continue;
            }
            await Task.Delay(1).ConfigureAwait(false);
            while (batch.Count < BatchLimit && queue.Reader.TryRead(out var next))
            {
                if (next is Barrier)
                {
                    pending = next;
                    break;
                }
                batch.Add(next);
            }
            ExecuteBatch(batch);
        }
    }

    private void ExecuteBatch(List<Command> batch)
    {
        try
        {
            string? xid = null;
            database.Write(
                tx =>
                {
                    xid = tx.Scalar("SELECT pg_current_xact_id()::text") as string;
                    foreach (var command in batch)
                    {
                        command.Error = null;
                        if (command.CancelBeforeExecution())
                            continue;
                        tx.Execute("SAVEPOINT command");
                        try
                        {
                            command.Execute(tx);
                            tx.Execute("RELEASE SAVEPOINT command");
                        }
                        catch (Exception error) when (!AbortsBatch(error))
                        {
                            tx.Execute("ROLLBACK TO SAVEPOINT command");
                            tx.Execute("RELEASE SAVEPOINT command");
                            command.Error = error;
                        }
                    }
                    BeforeCommit?.Invoke(tx, batch.Count);
                    return true;
                },
                new PgWriteOptions(Verify: tx => CommittedTransaction(tx, xid))
            );
            CommittedBatches++;
            CommittedCommands += batch.Count;
            LargestBatch = Math.Max(LargestBatch, batch.Count);
            foreach (var command in batch)
                command.Complete();
        }
        catch (Exception error)
        {
            // No member succeeds when the transaction fails, is fenced or its outcome is unknown.
            foreach (var command in batch)
                command.Fail(error);
        }
    }

    internal static bool CommittedTransaction(PgTx tx, string? xid) =>
        xid is not null
        && tx.Scalar("SELECT pg_xact_status($1::xid8)", xid) switch
        {
            "committed" => true,
            "aborted" => false,
            _ => throw new InvalidOperationException("The journal transaction outcome is unavailable."),
        };

    // A fence, a broken connection or a lost transaction ends the batch; anything else is the
    // command's own failure, rolled back to its savepoint.
    internal static bool AbortsBatch(Exception error) =>
        error is TenantFencedException
            or PostgresException { SqlState: TenantDb.FenceSqlState }
            or PostgresException { SqlState: "25P02" or "57P01" or "57P02" or "57P03" }
            || error is NpgsqlException and not PostgresException
            || error is IOException;

    public async ValueTask DisposeAsync()
    {
        queue.Writer.TryComplete();
        await loop.ConfigureAwait(false);
    }

    private abstract class Command(CancellationToken token)
    {
        internal Exception? Error;

        internal bool CancelBeforeExecution()
        {
            if (!token.IsCancellationRequested)
                return false;
            Error = new OperationCanceledException(token);
            return true;
        }

        internal abstract void Execute(PgTx tx);
        internal abstract void Complete();
        internal abstract void Fail(Exception error);
    }

    private sealed class Barrier(CancellationToken token) : Command(token)
    {
        internal readonly TaskCompletionSource<bool> Completion = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        internal override void Execute(PgTx tx) => throw new InvalidOperationException();

        internal override void Complete() => Completion.TrySetResult(true);

        internal override void Fail(Exception error) => Completion.TrySetException(error);
    }

    private sealed class Work<T>(Func<PgTx, T> execute, CancellationToken token) : Command(token)
    {
        internal readonly TaskCompletionSource<T> Completion = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        private T result = default!;

        internal override void Execute(PgTx tx) => result = execute(tx);

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
}
