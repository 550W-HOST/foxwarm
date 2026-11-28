using Foxwarm.Models;

namespace Foxwarm.Hosted.Postgres;

/// <summary>What one retention pass deleted.</summary>
internal sealed record JournalRetentionResult(long Requests, long Attempts, long Objects);

/// <summary>
/// Journal retention, hosted only (U14(c), C11). A pass deletes requests created before the
/// cutoff together with their attempt starts and results, in batches on the writer lane, and
/// then the objects that only the deleted requests and attempts referenced. A request that
/// is the base of a retained request's delta chain is kept, so every retained request stays
/// reconstructable. The usage ledger and the redaction statistics are never deleted.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    internal const int RetentionBatch = 500;
    private static readonly TimeSpan RetentionInterval = TimeSpan.FromDays(1);
    private readonly object retentionGate = new();
    private CancellationTokenSource? retentionStop;
    private Task retention = Task.CompletedTask;

    private DateTimeOffset? nextRetention;
    internal DateTimeOffset? NextRetention
    {
        get { lock (retentionGate) return nextRetention; }
    }

    /// <summary>
    /// Starts the owner's daily retention job: a first pass after <paramref name="firstDelay"/>
    /// (default one minute after start), then one every <paramref name="interval"/> (default
    /// one day). Unlimited retention starts nothing. The job stops when the store is disposed.
    /// </summary>
    internal void StartRetention(
        JournalRetentionOptions options,
        TimeSpan? firstDelay = null,
        TimeSpan? interval = null
    )
    {
        CheckOpen();
        if (options.RetentionDays is null)
            return;
        lock (retentionGate)
        {
            if (retentionStop is not null)
                throw new InvalidOperationException("Journal retention is already running.");
            nextRetention = clock.GetUtcNow() + (firstDelay ?? TimeSpan.FromMinutes(1));
            retentionStop = new CancellationTokenSource();
            var stop = retentionStop.Token;
            retention = Task.Run(
                () =>
                    RunRetentionAsync(
                        options,
                        firstDelay ?? TimeSpan.FromMinutes(1),
                        interval ?? RetentionInterval,
                        stop
                    ),
                CancellationToken.None
            );
        }
    }

    /// <summary>Completes after the retention job's current pass, if any, has stopped.</summary>
    internal Task RetentionTask
    {
        get
        {
            lock (retentionGate)
                return retention;
        }
    }

    internal async Task StopRetentionAsync()
    {
        Task running;
        lock (retentionGate)
        {
            retentionStop?.Cancel();
            running = retention;
        }
        try
        {
            await running.ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
    }

    private async Task RunRetentionAsync(
        JournalRetentionOptions options,
        TimeSpan firstDelay,
        TimeSpan interval,
        CancellationToken stop
    )
    {
        var delay = firstDelay;
        while (true)
        {
            try
            {
                await Task.Delay(delay, clock, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            try
            {
                var result = await PurgeAsync(options.Cutoff(clock.GetUtcNow())!.Value, stop)
                    .ConfigureAwait(false);
                if (result.Requests > 0)
                    MainLog.Diagnostic(
                        $"Journal retention deleted {result.Requests} requests, {result.Attempts} attempt records and {result.Objects} objects older than {options.RetentionDays} days."
                    );
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                return;
            }
            catch (TenantFencedException)
            {
                // The runtime is fencing itself; the next owner runs its own job.
                return;
            }
            catch (Exception error)
            {
                MainLog.Diagnostic(
                    "Journal retention stopped; it runs again at its next interval: "
                        + MainLog.SafeFailure(error),
                    failure: true
                );
            }
            delay = interval;
            lock (retentionGate)
                nextRetention = clock.GetUtcNow() + interval;
        }
    }

    /// <summary>
    /// Deletes requests created before <paramref name="cutoff"/> (Unix milliseconds) with their
    /// attempts, oldest first in batches of <paramref name="batchSize"/>, and the objects no
    /// remaining request or attempt references. Each batch is one writer command.
    /// </summary>
    internal async Task<JournalRetentionResult> PurgeAsync(
        long cutoff,
        CancellationToken token,
        int batchSize = RetentionBatch
    )
    {
        CheckOpen();
        var cursor = (CreatedAt: long.MinValue, RequestId: "");
        long requests = 0,
            attempts = 0,
            objects = 0;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var after = cursor;
            var receipt = await Writer
                .EnqueueAsync(tx => PurgeBatch(tx, cutoff, after, batchSize), token)
                .ConfigureAwait(false);
            var batch = await receipt.Completion.ConfigureAwait(false);
            requests += batch.Requests;
            attempts += batch.Attempts;
            objects += batch.Objects;
            if (batch.Next is not { } next)
                return new(requests, attempts, objects);
            cursor = next;
        }
    }

    private sealed record PurgedBatch(
        long Requests,
        long Attempts,
        long Objects,
        (long CreatedAt, string RequestId)? Next
    );

    private static PurgedBatch PurgeBatch(
        PgTx tx,
        long cutoff,
        (long CreatedAt, string RequestId) after,
        int batchSize
    )
    {
        var batch = new List<string>();
        (long, string)? last = null;
        using (var command = tx.Command(
            "SELECT request_id, created_at FROM llm_journal_requests WHERE created_at<$1"
                + " AND (created_at, request_id) > ($2, $3) ORDER BY created_at, request_id LIMIT $4",
            cutoff,
            after.CreatedAt,
            after.RequestId,
            (long)batchSize
        ))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                batch.Add(reader.GetString(0));
                last = (reader.GetInt64(1), reader.GetString(0));
            }
        if (batch.Count == 0)
            return new(0, 0, 0, null);
        // Requests whose delta descendants include a retained request stay.
        var kept = new HashSet<string>(StringComparer.Ordinal);
        using (var command = tx.Command(
            """
            WITH RECURSIVE down(root, id, hops) AS (
                SELECT r COLLATE "C", r COLLATE "C", 0 FROM unnest($1::text[]) AS r
                UNION ALL
                SELECT d.root, q.request_id, d.hops + 1
                FROM down d JOIN llm_journal_requests q ON q.base_request_id = d.id
                WHERE d.hops < $2
            )
            SELECT DISTINCT d.root FROM down d JOIN llm_journal_requests q ON q.request_id = d.id
            WHERE q.created_at >= $3
            """,
            batch.ToArray(),
            LlmJournalReconstruction.MaxDeltaDepth + 1,
            cutoff
        ))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                kept.Add(reader.GetString(0));
        var deleted = batch.Where(id => !kept.Contains(id)).ToArray();
        var next = batch.Count < batchSize ? ((long, string)?)null : last;
        if (deleted.Length == 0)
            return new(0, 0, 0, next);
        var candidates = new List<string>();
        using (var command = tx.Command(
            "SELECT object_id FROM llm_journal_request_objects WHERE request_id = ANY($1::text[])"
                + " UNION SELECT prompt_object_id FROM llm_journal_attempt_starts"
                + " WHERE request_id = ANY($1::text[]) AND prompt_object_id IS NOT NULL",
            [deleted]
        ))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                candidates.Add(reader.GetString(0));
        long attempts = tx.Execute(
            "DELETE FROM llm_journal_attempt_results WHERE request_id = ANY($1::text[])",
            [deleted]
        );
        attempts += tx.Execute(
            "DELETE FROM llm_journal_attempt_starts WHERE request_id = ANY($1::text[])",
            [deleted]
        );
        tx.Execute(
            "DELETE FROM llm_journal_request_objects WHERE request_id = ANY($1::text[])",
            [deleted]
        );
        long requests = tx.Execute(
            "DELETE FROM llm_journal_requests WHERE request_id = ANY($1::text[])",
            [deleted]
        );
        long objects = candidates.Count == 0
            ? 0
            : tx.Execute(
                """
                DELETE FROM llm_journal_objects o WHERE o.object_id = ANY($1::text[])
                  AND NOT EXISTS (SELECT 1 FROM llm_journal_request_objects x WHERE x.object_id = o.object_id)
                  AND NOT EXISTS (SELECT 1 FROM llm_journal_attempt_starts s WHERE s.prompt_object_id = o.object_id)
                """,
                [candidates.ToArray()]
            );
        return new(requests, attempts, objects, next);
    }
}
