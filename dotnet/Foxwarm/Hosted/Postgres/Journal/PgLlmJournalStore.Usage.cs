using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The usage ledger with the file journal's rules: one row per successful attempt, written in
/// the result's command or rebuilt by the backfill, covered-range checkpoints in
/// <c>llm_journal_metadata</c>, and queries over consecutive time buckets.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    private const string LowKey = "usage-ledger-low";
    private const string HighKey = "usage-ledger-high";

    private sealed record PendingUsage(
        string RequestId,
        long Attempt,
        long CompletedAt,
        string? SessionId,
        string Purpose,
        string ModelKey,
        string ProviderKey,
        string ProviderType,
        string? VirtualModelKey,
        LlmRequestJournalStore.UsageRow Usage
    );

    private const string InsertUsageSql = """
        INSERT INTO llm_usage(request_id,attempt,completed_at,session_id,purpose,model_key,provider_key,
          provider_type,virtual_model_key,cached_tokens,input_tokens,output_tokens,cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING
        """;

    private static void InsertUsage(PgTx tx, IEnumerable<PendingUsage> rows)
    {
        foreach (var row in rows)
            tx.Execute(
                InsertUsageSql,
                row.RequestId,
                row.Attempt,
                row.CompletedAt,
                row.SessionId,
                row.Purpose,
                row.ModelKey,
                row.ProviderKey,
                row.ProviderType,
                row.VirtualModelKey,
                row.Usage.CachedTokens,
                row.Usage.InputTokens,
                row.Usage.OutputTokens,
                row.Usage.Cost
            );
    }

    /// <summary>
    /// Writes the live ledger row inside the result's command under its own savepoint: a
    /// ledger failure rolls back only the ledger row, never the result.
    /// </summary>
    private static bool TryRecordLiveUsage(
        PgTx tx,
        string requestId,
        int attempt,
        long completedAt,
        (string Model, string? Virtual, string Type) start,
        LlmRequestJournalStore.UsageRow usage
    )
    {
        tx.Execute("SAVEPOINT llm_usage_row");
        try
        {
            string? session = null;
            var purpose = "low-level";
            using (var request = tx.Command(
                "SELECT session_id,purpose FROM llm_journal_requests WHERE request_id=$1",
                requestId
            ))
            using (var reader = request.ExecuteReader())
                if (reader.Read())
                {
                    session = reader.IsDBNull(0) ? null : reader.GetString(0);
                    purpose = reader.GetString(1);
                }
            InsertUsage(
                tx,
                [
                    new(
                        requestId,
                        attempt,
                        completedAt,
                        session,
                        purpose,
                        start.Model,
                        usage.ProviderKey ?? LlmRequestJournalStore.ProviderPrefix(start.Model),
                        start.Type,
                        start.Virtual,
                        usage
                    ),
                ]
            );
            tx.Execute("RELEASE SAVEPOINT llm_usage_row");
            return true;
        }
        catch (Exception error) when (OptionalRowFailure(error))
        {
            tx.Execute("ROLLBACK TO SAVEPOINT llm_usage_row");
            tx.Execute("RELEASE SAVEPOINT llm_usage_row");
            return false;
        }
    }

    /// <summary>
    /// Extends the covered range to a newly written result when everything before it is already
    /// covered, so a restart does not rescan results that were recorded live.
    /// </summary>
    private static void AdvanceUsageHigh(PgTx tx, long seq) =>
        tx.Execute(
            """
            UPDATE llm_journal_metadata SET value=$1 WHERE key=$2
              AND CAST(value AS bigint)>=(SELECT coalesce(max(seq),0) FROM llm_journal_attempt_results WHERE seq<$3)
              AND CAST(value AS bigint)<$3
            """,
            seq.ToString(CultureInfo.InvariantCulture),
            HighKey,
            seq
        );

    private static long? ReadMetadataNumber(PgTx tx, string key) =>
        tx.Scalar("SELECT value FROM llm_journal_metadata WHERE key=$1", key) is string text
        && long.TryParse(text, CultureInfo.InvariantCulture, out var number)
            ? number
            : null;

    private static void WriteMetadata(PgTx tx, string key, long value) =>
        tx.Execute(
            "INSERT INTO llm_journal_metadata(key,value) VALUES($1,$2) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",
            key,
            value.ToString(CultureInfo.InvariantCulture)
        );

    private static long MaxResultSeq(PgTx tx) =>
        (long)tx.Scalar("SELECT coalesce(max(seq),0)::bigint FROM llm_journal_attempt_results")!;

    /// <summary>
    /// Rebuilds missing ledger rows from successful attempt results: results newer than the
    /// covered range oldest first, then older history newest first, in small batches on the
    /// writer lane with their checkpoint. Reruns are idempotent.
    /// </summary>
    public async Task BackfillUsageAsync(
        CancellationToken token,
        int batchSize = LlmRequestJournalStore.UsageBackfillBatch
    )
    {
        CheckOpen();
        var (low, high) = await PrepareUsageLedgerAsync(token).ConfigureAwait(false);
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var top = database.Read(MaxResultSeq);
            if (top <= high)
                break;
            var end = Math.Min(top, high + batchSize);
            var rows = ReadPendingUsage("a.seq>$1 AND a.seq<=$2", [high, end], ascending: true, limit: null);
            token.ThrowIfCancellationRequested();
            high = await WriteUsageBatchAsync(rows.Rows, HighKey, end, token).ConfigureAwait(false);
        }
        while (low > 1)
        {
            token.ThrowIfCancellationRequested();
            var batch = ReadPendingUsage("a.seq<$1", [low], ascending: false, limit: batchSize);
            var next = batch.Scanned < batchSize ? 1 : batch.Lowest;
            token.ThrowIfCancellationRequested();
            await WriteUsageBatchAsync(batch.Rows, LowKey, next, token).ConfigureAwait(false);
            low = next;
        }
    }

    /// <summary>
    /// Ensures the ledger checkpoints. A ledger emptied while its checkpoints claim coverage
    /// starts over, so the backfill rebuilds every row from the attempt results.
    /// </summary>
    private async Task<(long Low, long High)> PrepareUsageLedgerAsync(CancellationToken token)
    {
        var receipt = await Writer
            .EnqueueAsync(
                tx =>
                {
                    if (
                        tx.Scalar("SELECT 1 FROM llm_usage LIMIT 1") is null
                        && ReadMetadataNumber(tx, HighKey) is long covered
                        && tx.Scalar(
                            "SELECT 1 FROM llm_journal_attempt_results WHERE seq<=$1 AND outcome='success' LIMIT 1",
                            covered
                        )
                            is not null
                    )
                        tx.Execute(
                            "DELETE FROM llm_journal_metadata WHERE key IN ($1,$2)",
                            LowKey,
                            HighKey
                        );
                    var top = MaxResultSeq(tx);
                    long Read(string key, long initial)
                    {
                        if (ReadMetadataNumber(tx, key) is long value)
                            return value;
                        WriteMetadata(tx, key, initial);
                        return initial;
                    }
                    // A fresh ledger covers nothing below the current newest result; results
                    // written from here on are recorded live.
                    var high = Read(HighKey, top);
                    var low = Read(LowKey, high + 1);
                    return (low, high);
                },
                token
            )
            .ConfigureAwait(false);
        return await receipt.Completion.ConfigureAwait(false);
    }

    /// <summary>
    /// Inserts one prepared batch and moves its checkpoint in the same command. The high mark
    /// never moves backwards; the call returns the stored value.
    /// </summary>
    private async Task<long> WriteUsageBatchAsync(
        IReadOnlyList<PendingUsage> rows,
        string checkpoint,
        long value,
        CancellationToken token
    )
    {
        var receipt = await Writer
            .EnqueueAsync(
                tx =>
                {
                    InsertUsage(tx, rows);
                    var stored = ReadMetadataNumber(tx, checkpoint);
                    if (checkpoint == LowKey || stored is null || stored < value)
                    {
                        WriteMetadata(tx, checkpoint, value);
                        return value;
                    }
                    return stored.Value;
                },
                token
            )
            .ConfigureAwait(false);
        var result = await receipt.Completion.ConfigureAwait(false);
        if (rows.Count > 0)
            Raise(UsageRecorded);
        return result;
    }

    /// <summary>
    /// Successful results in the range that have no ledger row yet, with what their row needs.
    /// Results whose request or start is missing are skipped but still scanned. The usage
    /// member is read only from a JSON object, as the file journal's extraction does.
    /// </summary>
    private (List<PendingUsage> Rows, int Scanned, long Lowest) ReadPendingUsage(
        string range,
        object[] bounds,
        bool ascending,
        int? limit
    ) =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                $"""
                SELECT a.seq,a.request_id,a.attempt,a.completed_at,r.request_id IS NOT NULL,r.session_id,r.purpose,
                  s.concrete_model_id,s.virtual_model_key,s.provider_type,
                  CASE WHEN a.result_json IS JSON OBJECT THEN
                    CASE WHEN json_typeof(a.result_json::json -> 'usage') = 'object'
                      THEN (a.result_json::json -> 'usage')::text END END
                FROM llm_journal_attempt_results a
                LEFT JOIN llm_journal_requests r ON r.request_id=a.request_id
                LEFT JOIN LATERAL (
                  SELECT concrete_model_id,virtual_model_key,provider_type FROM llm_journal_attempt_starts s
                  WHERE s.request_id=a.request_id AND s.attempt=a.attempt ORDER BY s.seq DESC LIMIT 1
                ) s ON true
                WHERE {range} AND a.outcome='success'
                  AND NOT EXISTS(SELECT 1 FROM llm_usage u WHERE u.request_id=a.request_id AND u.attempt=a.attempt)
                ORDER BY a.seq {(ascending ? "ASC" : "DESC")}{(limit is null ? "" : " LIMIT " + limit.Value.ToString(CultureInfo.InvariantCulture))}
                """,
                bounds
            );
            using var reader = command.ExecuteReader();
            var rows = new List<PendingUsage>();
            var scanned = 0;
            var lowest = long.MaxValue;
            while (reader.Read())
            {
                scanned++;
                lowest = Math.Min(lowest, reader.GetInt64(0));
                if (!reader.GetBoolean(4) || reader.IsDBNull(7))
                    continue;
                JsonNode? usage = null;
                if (!reader.IsDBNull(10))
                    try
                    {
                        usage = JsonNode.Parse(reader.GetString(10));
                    }
                    catch (System.Text.Json.JsonException) { }
                var model = reader.GetString(7);
                rows.Add(
                    new(
                        reader.GetString(1),
                        reader.GetInt64(2),
                        reader.GetInt64(3),
                        reader.IsDBNull(5) ? null : reader.GetString(5),
                        reader.GetString(6),
                        model,
                        LlmRequestJournalStore.ProviderPrefix(model),
                        reader.GetString(9),
                        reader.IsDBNull(8) ? null : reader.GetString(8),
                        LlmRequestJournalStore.ToUsageRow(usage, null)
                    )
                );
            }
            return (rows, scanned, lowest);
        });

    /// <summary>Distinct Sessions with recorded usage in [from, to).</summary>
    public IReadOnlyList<string> UsageSessions(long from, long to) =>
        DistinctSessions("llm_usage", from, to);

    private IReadOnlyList<string> DistinctSessions(string table, long from, long to)
    {
        CheckOpen();
        return database.Read(tx =>
        {
            using var command = tx.Command(
                $"SELECT DISTINCT session_id FROM {table} WHERE completed_at>=$1 AND completed_at<$2 AND session_id IS NOT NULL",
                from,
                to
            );
            using var reader = command.ExecuteReader();
            var result = new List<string>();
            while (reader.Read())
                result.Add(reader.GetString(0));
            return (IReadOnlyList<string>)result;
        });
    }

    // The `buckets(i, b0, b1)` CTE over the boundaries in parameter $1 and, for Session-level
    // queries, the Session starts in $2 and $3.
    private const string BucketsCte = """
        WITH bounds(b, n) AS (SELECT * FROM unnest($1::bigint[]) WITH ORDINALITY),
        buckets(i, b0, b1) AS (
          SELECT (a.n - 1)::int, a.b, z.b FROM bounds a JOIN bounds z ON z.n = a.n + 1)
        """;

    private const string SessionStartsJoin =
        "LEFT JOIN unnest($2::text[], $3::bigint[]) AS ss(session_id, started_at) ON ss.session_id=";

    private static void ValidateQuery(IReadOnlyList<long> boundaries, string? groupColumn)
    {
        if (boundaries.Count < 2)
            throw new ArgumentException("Usage queries need at least one time bucket.");
        if (groupColumn is not null && !LlmRequestJournalStore.UsageGroupColumns.Contains(groupColumn))
            throw new ArgumentException("Unknown usage grouping.");
    }

    private static object[] QueryParameters(
        IReadOnlyList<long> boundaries,
        bool starts,
        IReadOnlyDictionary<string, long>? sessionStarts
    ) =>
        starts
            ? [boundaries.ToArray(), sessionStarts!.Keys.ToArray(), sessionStarts.Values.ToArray()]
            : [boundaries.ToArray()];

    public IReadOnlyList<LlmUsageCell> QueryUsage(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession = false,
        IReadOnlyDictionary<string, long>? sessionStarts = null
    )
    {
        CheckOpen();
        ValidateQuery(boundaries, groupColumn);
        var starts = bySession && sessionStarts is { Count: > 0 };
        var key = groupColumn is null ? "NULL::text" : "u." + groupColumn;
        var sessionColumn = bySession ? "u.session_id" : "NULL::text";
        var before = starts
            ? "CASE WHEN ss.started_at IS NOT NULL AND u.completed_at<ss.started_at THEN 1 ELSE 0 END"
            : "0";
        return database.Read(tx =>
        {
            using var command = tx.Command(
                $"""
                {BucketsCte}
                SELECT buckets.i,{key},count(*),coalesce(sum(u.cached_tokens),0)::bigint,coalesce(sum(u.input_tokens),0)::bigint,
                  coalesce(sum(u.output_tokens),0)::bigint,count(u.cost),coalesce(sum(u.cost),0)::double precision,
                  {sessionColumn},({before})::bigint
                FROM buckets JOIN llm_usage u ON u.completed_at>=buckets.b0 AND u.completed_at<buckets.b1
                {(starts ? SessionStartsJoin + "u.session_id" : "")}
                GROUP BY 1,2,9,10
                """,
                QueryParameters(boundaries, starts, sessionStarts)
            );
            using var reader = command.ExecuteReader();
            var cells = new List<LlmUsageCell>();
            while (reader.Read())
                cells.Add(
                    new(
                        reader.GetInt32(0),
                        reader.IsDBNull(1) ? null : reader.GetString(1),
                        reader.GetInt64(2),
                        reader.GetInt64(3),
                        reader.GetInt64(4),
                        reader.GetInt64(5),
                        reader.GetInt64(6),
                        reader.GetDouble(7),
                        reader.IsDBNull(8) ? null : reader.GetString(8),
                        reader.GetInt64(9) == 1
                    )
                );
            return (IReadOnlyList<LlmUsageCell>)cells;
        });
    }

    /// <summary>
    /// The first recorded request, and whether the backfill has covered all history: its low
    /// checkpoint exists and no successful result lies below it.
    /// </summary>
    public LlmUsageCoverage UsageCoverage()
    {
        CheckOpen();
        // One statement: the earliest ledger row, the backfill's low mark with whether a success
        // below it lacks its row, and the unrecorded requests' lost rows.
        return database.Read(
            tx =>
            {
                using var command = tx.Command(
                    """
                    WITH metadata AS (
                        SELECT (SELECT value FROM llm_journal_metadata WHERE key=$1) AS low,
                               (SELECT value FROM llm_journal_metadata WHERE key=$2) AS lost
                    ), marks AS (
                        SELECT CASE WHEN pg_input_is_valid(low,'bigint') THEN low::bigint END AS low,
                               CASE WHEN pg_input_is_valid(lost,'bigint') THEN lost::bigint END AS lost
                        FROM metadata
                    )
                    SELECT (SELECT min(completed_at) FROM llm_usage),
                           low IS NOT NULL AND coalesce(lost,0) <= 0 AND
                           (low <= 1 OR NOT EXISTS (SELECT 1 FROM llm_journal_attempt_results
                                                    WHERE seq < low AND outcome='success'))
                    FROM marks
                    """,
                    LowKey,
                    LostKey
                );
                using var reader = command.ExecuteReader();
                reader.Read();
                return new LlmUsageCoverage(reader.IsDBNull(0) ? null : reader.GetInt64(0), reader.GetBoolean(1));
            },
            snapshot: true
        );
    }
}
