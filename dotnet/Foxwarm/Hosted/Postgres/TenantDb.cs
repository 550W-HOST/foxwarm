using System.Data;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The write was refused because this runtime no longer holds the tenant lease at its epoch:
/// another replica took over, the lease expired or was released, or the runtime closed its
/// database access while fencing itself. Nothing of the transaction is committed.
/// </summary>
internal sealed class TenantFencedException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The connection failed while <c>COMMIT</c> was in flight, so the transaction may or may not
/// have committed. Thrown only when the caller supplied no way to verify the outcome, or when
/// verification itself failed.
/// </summary>
internal sealed class CommitOutcomeUnknownException(string message, Exception inner)
    : Exception(message, inner);

/// <summary>Options of one <see cref="TenantDb"/> write transaction.</summary>
/// <param name="Verify">
/// Runs in a new read transaction after a lost <c>COMMIT</c> and reports whether this write
/// is visible. True turns the write into a success; false surfaces the original failure as a
/// precommit failure.
/// </param>
/// <param name="Retryable">
/// The body is idempotent: a serialization failure or deadlock rolls back and runs it again,
/// at most <see cref="TenantDb.MaxAttempts"/> times in total.
/// </param>
internal sealed record PgWriteOptions(Func<PgTx, bool>? Verify = null, bool Retryable = false);

/// <summary>
/// The only way tenant store code reaches PostgreSQL. Every transaction sets the tenant for
/// row-level security; every write transaction also sets the runtime's lease epoch and checks
/// it first. The schema's fence trigger repeats that check on every write statement, so a
/// write issued after a takeover fails even if it skipped this helper.
/// </summary>
internal sealed class TenantDb
{
    internal const string FenceSqlState = "FW001";
    internal const int MaxAttempts = 3;

    private const string LeaseCheck =
        "SELECT 1 FROM tenant_leases WHERE tenant_id = $1 AND epoch = $2 AND state = 'active'"
        + " AND expires_at > now() FOR KEY SHARE";

    private readonly PgDatabase database;
    private readonly string statementTimeout;
    private readonly string idleTimeout;
    private volatile bool closed;

    /// <param name="statementTimeout">Bound of one statement, default 15 s.</param>
    /// <param name="idleTimeout">
    /// Bound of a pause between statements inside a transaction, default 10 s. Together they
    /// bound how long a partitioned owner's open transaction can hold the lease lock and delay
    /// a takeover: the server ends it on its own.
    /// </param>
    internal TenantDb(
        PgDatabase database,
        int tenantId,
        long epoch,
        TimeSpan? statementTimeout = null,
        TimeSpan? idleTimeout = null
    )
    {
        this.database = database;
        TenantId = tenantId;
        Epoch = epoch;
        this.statementTimeout = Milliseconds(statementTimeout ?? TimeSpan.FromSeconds(15));
        this.idleTimeout = Milliseconds(idleTimeout ?? TimeSpan.FromSeconds(10));
    }

    private static string Milliseconds(TimeSpan value) =>
        ((long)value.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture)
        + "ms";

    internal int TenantId { get; }

    internal long Epoch { get; }

    /// <summary>
    /// Raised once per refused write that observed a lost lease, before the exception reaches
    /// the caller. The lease monitor fences the runtime on it.
    /// </summary>
    internal event Action<TenantFencedException>? Fenced;

    /// <summary>Refuses every later transaction. Used when the runtime fences itself.</summary>
    internal void Close() => closed = true;

    internal T Write<T>(Func<PgTx, T> body, PgWriteOptions? options = null)
    {
        options ??= new();
        for (var attempt = 1; ; attempt++)
        {
            CheckOpen();
            using var connection = Open();
            using var transaction = connection.BeginTransaction(IsolationLevel.ReadCommitted);
            var tx = new PgTx(connection, transaction, TenantId);
            T result;
            try
            {
                Begin(tx, write: true, readOnly: false);
                result = body(tx);
            }
            catch (Exception error) when (Translate(error) is { } translated)
            {
                Rollback(transaction);
                if (translated is RetryableFailure && options.Retryable && attempt < MaxAttempts)
                    continue;
                throw Unwrap(translated, error);
            }
            catch
            {
                Rollback(transaction);
                throw;
            }
            try
            {
                transaction.Commit();
                return result;
            }
            catch (Exception error) when (IsLostCommit(error))
            {
                ResolveLostCommit(options, error);
                return result;
            }
            catch (Exception error) when (Translate(error) is { } translated)
            {
                if (translated is RetryableFailure && options.Retryable && attempt < MaxAttempts)
                    continue;
                throw Unwrap(translated, error);
            }
        }
    }

    internal async Task<T> WriteAsync<T>(
        Func<PgTx, CancellationToken, Task<T>> body,
        PgWriteOptions? options = null,
        CancellationToken token = default
    )
    {
        options ??= new();
        for (var attempt = 1; ; attempt++)
        {
            CheckOpen();
            await using var connection = await OpenAsync(token).ConfigureAwait(false);
            await using var transaction = await connection
                .BeginTransactionAsync(IsolationLevel.ReadCommitted, token)
                .ConfigureAwait(false);
            var tx = new PgTx(connection, transaction, TenantId);
            T result;
            try
            {
                await BeginAsync(tx, write: true, readOnly: false, token).ConfigureAwait(false);
                result = await body(tx, token).ConfigureAwait(false);
            }
            catch (Exception error) when (Translate(error) is { } translated)
            {
                await RollbackAsync(transaction).ConfigureAwait(false);
                if (translated is RetryableFailure && options.Retryable && attempt < MaxAttempts)
                    continue;
                throw Unwrap(translated, error);
            }
            catch
            {
                await RollbackAsync(transaction).ConfigureAwait(false);
                throw;
            }
            try
            {
                // Not cancellable: a cancelled COMMIT is a lost commit, never a quiet rollback.
                await transaction.CommitAsync(CancellationToken.None).ConfigureAwait(false);
                return result;
            }
            catch (Exception error) when (IsLostCommit(error))
            {
                ResolveLostCommit(options, error);
                return result;
            }
            catch (Exception error) when (Translate(error) is { } translated)
            {
                if (translated is RetryableFailure && options.Retryable && attempt < MaxAttempts)
                    continue;
                throw Unwrap(translated, error);
            }
        }
    }

    /// <summary>
    /// Runs <paramref name="body"/> in a read-only transaction with the tenant set and no lease
    /// check. <paramref name="snapshot"/> gives every statement the same snapshot.
    /// </summary>
    internal T Read<T>(Func<PgTx, T> body, bool snapshot = false)
    {
        CheckOpen();
        using var connection = Open();
        using var transaction = connection.BeginTransaction(
            snapshot ? IsolationLevel.RepeatableRead : IsolationLevel.ReadCommitted
        );
        var tx = new PgTx(connection, transaction, TenantId);
        try
        {
            Begin(tx, write: false, readOnly: true);
            var result = body(tx);
            transaction.Commit();
            return result;
        }
        catch (Exception error) when (Translate(error) is { } translated)
        {
            Rollback(transaction);
            throw Unwrap(translated, error);
        }
        catch
        {
            Rollback(transaction);
            throw;
        }
    }

    internal async Task<T> ReadAsync<T>(
        Func<PgTx, CancellationToken, Task<T>> body,
        bool snapshot = false,
        CancellationToken token = default
    )
    {
        CheckOpen();
        await using var connection = await OpenAsync(token).ConfigureAwait(false);
        await using var transaction = await connection
            .BeginTransactionAsync(
                snapshot ? IsolationLevel.RepeatableRead : IsolationLevel.ReadCommitted,
                token
            )
            .ConfigureAwait(false);
        var tx = new PgTx(connection, transaction, TenantId);
        try
        {
            await BeginAsync(tx, write: false, readOnly: true, token).ConfigureAwait(false);
            var result = await body(tx, token).ConfigureAwait(false);
            await transaction.CommitAsync(token).ConfigureAwait(false);
            return result;
        }
        catch (Exception error) when (Translate(error) is { } translated)
        {
            await RollbackAsync(transaction).ConfigureAwait(false);
            throw Unwrap(translated, error);
        }
        catch
        {
            await RollbackAsync(transaction).ConfigureAwait(false);
            throw;
        }
    }

    private void CheckOpen()
    {
        if (closed)
            throw new TenantFencedException("This runtime no longer owns the tenant.");
    }

    private NpgsqlConnection Open()
    {
        try
        {
            return database.Open();
        }
        catch (Exception error) when (!closed)
        {
            throw new IOException("The database is unavailable.", error);
        }
    }

    private async ValueTask<NpgsqlConnection> OpenAsync(CancellationToken token)
    {
        try
        {
            return await database.OpenAsync(token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new IOException("The database is unavailable.", error);
        }
    }

    // Synchronous callers run the setup one command at a time: Npgsql sends a batch of several
    // commands from a thread-pool task even when the call is synchronous, so a starved pool
    // (callers blocked on a lock around a write) would leave this thread waiting for its own
    // send until the command timeout.
    private void Begin(PgTx tx, bool write, bool readOnly)
    {
        using var batch = Setup(tx, write, readOnly);
        if (tx.ExecuteInline(batch).Value is null && write)
            throw FenceFailure(null);
    }

    private async Task BeginAsync(PgTx tx, bool write, bool readOnly, CancellationToken token)
    {
        await using var batch = Setup(tx, write, readOnly);
        await using var reader = await batch.ExecuteReaderAsync(token).ConfigureAwait(false);
        while (await reader.ReadAsync(token).ConfigureAwait(false)) { }
        if (!write)
            return;
        if (
            !await reader.NextResultAsync(token).ConfigureAwait(false)
            || !await reader.ReadAsync(token).ConfigureAwait(false)
        )
            throw FenceFailure(null);
    }

    private NpgsqlBatch Setup(PgTx tx, bool write, bool readOnly)
    {
        var batch = tx.Batch();
        var settings = new NpgsqlBatchCommand(
            "SELECT set_config('foxwarm.tenant', $1, true), set_config('foxwarm.epoch', $2, true),"
                + " set_config('statement_timeout', $3, true),"
                + " set_config('idle_in_transaction_session_timeout', $4, true)"
        );
        settings.Parameters.Add(new NpgsqlParameter<string>
        {
            TypedValue = TenantId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });
        settings.Parameters.Add(new NpgsqlParameter<string>
        {
            TypedValue = write
                ? Epoch.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : "",
        });
        settings.Parameters.Add(new NpgsqlParameter<string> { TypedValue = statementTimeout });
        settings.Parameters.Add(new NpgsqlParameter<string> { TypedValue = idleTimeout });
        if (readOnly)
            batch.BatchCommands.Add(new NpgsqlBatchCommand("SET TRANSACTION READ ONLY"));
        batch.BatchCommands.Add(settings);
        if (write)
        {
            var check = new NpgsqlBatchCommand(LeaseCheck);
            check.Parameters.Add(new NpgsqlParameter<int> { TypedValue = TenantId });
            check.Parameters.Add(new NpgsqlParameter<long> { TypedValue = Epoch });
            batch.BatchCommands.Add(check);
        }
        return batch;
    }

    private TenantFencedException FenceFailure(Exception? inner)
    {
        var error = new TenantFencedException(
            "This runtime's tenant lease is no longer current; the write was not committed.",
            inner
        );
        try
        {
            Fenced?.Invoke(error);
        }
        catch { }
        return error;
    }

    private sealed class RetryableFailure : Exception;

    // Maps database failures to their contract meaning; null leaves the exception as it is.
    private Exception? Translate(Exception error) =>
        error switch
        {
            TenantFencedException fenced => fenced,
            PostgresException { SqlState: FenceSqlState } => FenceFailure(error),
            PostgresException { SqlState: "40001" or "40P01" } => new RetryableFailure(),
            _ => null,
        };

    private static Exception Unwrap(Exception translated, Exception original) =>
        translated is RetryableFailure ? original : translated;

    private static bool IsLostCommit(Exception error) =>
        error is NpgsqlException { InnerException: IOException or TimeoutException }
            or NpgsqlException { IsTransient: true } and not PostgresException
            or IOException
            or ObjectDisposedException;

    private void ResolveLostCommit(PgWriteOptions options, Exception error)
    {
        if (options.Verify is not { } verify)
            throw new CommitOutcomeUnknownException(
                "The database connection failed during COMMIT; the write may or may not be committed.",
                error
            );
        bool visible;
        try
        {
            visible = Read(verify);
        }
        catch (Exception verification)
        {
            throw new CommitOutcomeUnknownException(
                "The database connection failed during COMMIT and the outcome could not be verified.",
                new AggregateException(error, verification)
            );
        }
        if (!visible)
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
    }

    private static void Rollback(NpgsqlTransaction transaction)
    {
        try
        {
            transaction.Rollback();
        }
        catch { }
    }

    private static async Task RollbackAsync(NpgsqlTransaction transaction)
    {
        try
        {
            await transaction.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch { }
    }
}

/// <summary>
/// One open transaction of a <see cref="TenantDb"/> body. Commands are bound to it; the
/// connection and the transaction itself stay with the helper.
/// </summary>
internal sealed class PgTx
{
    private readonly NpgsqlConnection connection;
    private readonly NpgsqlTransaction transaction;

    internal PgTx(NpgsqlConnection connection, NpgsqlTransaction transaction, int tenantId)
    {
        this.connection = connection;
        this.transaction = transaction;
        TenantId = tenantId;
    }

    internal int TenantId { get; }

    /// <summary>A command with positional parameters <c>$1…$n</c>; null values bind as SQL NULL.</summary>
    internal NpgsqlCommand Command(string sql, params object?[] parameters)
    {
        var command = new NpgsqlCommand(sql, connection, transaction);
        foreach (var value in parameters)
            command.Parameters.Add(Parameter(value));
        return command;
    }

    internal NpgsqlBatch Batch() => new(connection, transaction);

    /// <summary>
    /// Runs <paramref name="batch"/>'s commands in order on the calling thread and returns the
    /// last command's first value (null without a row) and its affected-row count. Synchronous
    /// code uses this instead of executing the batch: Npgsql sends a multi-command batch from a
    /// thread-pool task even in a synchronous call.
    /// </summary>
    internal (object? Value, int RecordsAffected) ExecuteInline(NpgsqlBatch batch)
    {
        (object? Value, int RecordsAffected) last = (null, 0);
        foreach (var step in batch.BatchCommands)
        {
            using var command = new NpgsqlCommand(step.CommandText, connection, transaction);
            foreach (NpgsqlParameter parameter in step.Parameters)
                command.Parameters.Add(parameter.Clone());
            using var reader = command.ExecuteReader();
            object? value = null;
            if (reader.Read() && !reader.IsDBNull(0))
                value = reader.GetValue(0);
            while (reader.Read()) { }
            reader.Close();
            last = (value, reader.RecordsAffected);
        }
        return last;
    }

    internal int Execute(string sql, params object?[] parameters)
    {
        using var command = Command(sql, parameters);
        return command.ExecuteNonQuery();
    }

    internal async Task<int> ExecuteAsync(
        string sql,
        CancellationToken token,
        params object?[] parameters
    )
    {
        await using var command = Command(sql, parameters);
        return await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    internal object? Scalar(string sql, params object?[] parameters)
    {
        using var command = Command(sql, parameters);
        var value = command.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    internal static NpgsqlParameter Parameter(object? value) =>
        value switch
        {
            null => new NpgsqlParameter { Value = DBNull.Value },
            NpgsqlParameter parameter => parameter,
            string text => new NpgsqlParameter<string> { TypedValue = text },
            int number => new NpgsqlParameter<int> { TypedValue = number },
            long number => new NpgsqlParameter<long> { TypedValue = number },
            double number => new NpgsqlParameter<double> { TypedValue = number },
            bool flag => new NpgsqlParameter<bool> { TypedValue = flag },
            byte[] bytes => new NpgsqlParameter<byte[]> { TypedValue = bytes },
            Guid id => new NpgsqlParameter<Guid> { TypedValue = id },
            DateTimeOffset time => new NpgsqlParameter<DateTime> { TypedValue = time.UtcDateTime },
            long[] numbers => new NpgsqlParameter<long[]> { TypedValue = numbers },
            int[] numbers => new NpgsqlParameter<int[]> { TypedValue = numbers },
            string[] texts => new NpgsqlParameter<string[]> { TypedValue = texts },
            _ => throw new ArgumentException(
                "Unsupported PostgreSQL parameter type: " + value.GetType().Name
            ),
        };
}
