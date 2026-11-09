using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

/// <summary>The caller's knowledge that the journal rows themselves do not carry.</summary>
internal sealed record LlmUsageAttribution(string? ProviderKey);

/// <summary>
/// One aggregated ledger cell: a time bucket, an optional group value and, for Session-level
/// queries, the recorded Session ID and whether the rows completed before that Session's
/// current history began.
/// </summary>
internal sealed record LlmUsageCell(
    int Bucket,
    string? Key,
    long Requests,
    long CachedTokens,
    long InputTokens,
    long OutputTokens,
    long PricedRequests,
    double Cost,
    string? SessionId = null,
    bool BeforeSessionStart = false
);

internal sealed record LlmUsageCoverage(long? Earliest, bool Complete);

/// <summary>
/// Derived per-request usage ledger in the journal database. Every successful attempt result
/// owns at most one row; rows are written with the result or rebuilt from it by the backfill,
/// never repriced, and never authoritative for anything else. Attribution to Agents happens
/// when the ledger is read, not here.
/// </summary>
public sealed partial class LlmRequestJournalStore
{
    internal sealed record UsageRow(
        string? ProviderKey,
        long? CachedTokens,
        long? InputTokens,
        long? OutputTokens,
        double? Cost
    );

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
        UsageRow Usage
    );

    internal static readonly string[] UsageGroupColumns = ["model_key", "provider_key", "purpose"];

    private const string LowKey = "usage-ledger-low";
    private const string HighKey = "usage-ledger-high";
    internal const int UsageBackfillBatch = 500;

    // Additive and cheap on any database size: the table starts empty and only its own index is
    // built here. Older readers ignore both.
    private const string UsageSchemaSql = """
        CREATE TABLE IF NOT EXISTS llm_usage(
          request_id TEXT NOT NULL,attempt INTEGER NOT NULL,completed_at INTEGER NOT NULL,
          session_id TEXT,purpose TEXT NOT NULL,model_key TEXT NOT NULL,provider_key TEXT NOT NULL,
          provider_type TEXT NOT NULL,virtual_model_key TEXT,
          cached_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost REAL,
          PRIMARY KEY(request_id,attempt));
        CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage(completed_at);
        """;

    private const string InsertUsageSql = """
        INSERT OR IGNORE INTO llm_usage(request_id,attempt,completed_at,session_id,purpose,model_key,provider_key,
          provider_type,virtual_model_key,cached_tokens,input_tokens,output_tokens,cost)
        VALUES($request,$attempt,$completed,$session,$purpose,$model,$provider,$type,$virtual,$cached,$input,$output,$cost)
        """;

    /// <summary>Raised after ledger rows commit, from live results or a backfill batch.</summary>
    internal event Action? UsageRecorded;

    /// <summary>
    /// Raised after a result committed without its ledger row (for example because the table was
    /// removed). The result itself is unaffected; a backfill pass restores the row.
    /// </summary>
    internal event Action? UsageLedgerFailed;

    private void NotifyUsageRecorded() => Raise(UsageRecorded);

    private void NotifyUsageLedgerFailed() => Raise(UsageLedgerFailed);

    private static void Raise(Action? handler)
    {
        try
        {
            handler?.Invoke();
        }
        catch
        {
            // Presentation listeners cannot fail a committed result.
        }
    }

    private static long? UsageCount(JsonNode? value) =>
        SessionWait.Number(value) is double number && double.IsFinite(number) && number >= 0
            ? (long)number
            : null;

    private static UsageRow ToUsageRow(JsonNode? usage, string? providerKey)
    {
        var cost = SessionWait.Number(usage?["cost"]);
        return new(
            providerKey,
            UsageCount(usage?["cachedTokens"]),
            UsageCount(usage?["inputTokens"]),
            UsageCount(usage?["outputTokens"]),
            cost is double value && double.IsFinite(value) && value >= 0 ? value : null
        );
    }

    private static UsageRow PrepareUsageRow(ChatResult result, LlmUsageAttribution? attribution) =>
        ToUsageRow(result.Usage, attribution?.ProviderKey);

    private static string ProviderPrefix(string model) =>
        model.IndexOf('/') is var slash and > 0 ? model[..slash] : model;

    private static void InsertUsage(
        SqliteConnection connection,
        SqliteTransaction transaction,
        IEnumerable<PendingUsage> rows
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = InsertUsageSql;
        foreach (var row in rows)
        {
            command.Parameters.Clear();
            Add(command, "$request", row.RequestId);
            Add(command, "$attempt", row.Attempt);
            Add(command, "$completed", row.CompletedAt);
            Add(command, "$session", row.SessionId);
            Add(command, "$purpose", row.Purpose);
            Add(command, "$model", row.ModelKey);
            Add(command, "$provider", row.ProviderKey);
            Add(command, "$type", row.ProviderType);
            Add(command, "$virtual", row.VirtualModelKey);
            Add(command, "$cached", row.Usage.CachedTokens);
            Add(command, "$input", row.Usage.InputTokens);
            Add(command, "$output", row.Usage.OutputTokens);
            Add(command, "$cost", row.Usage.Cost);
            command.ExecuteNonQuery();
        }
    }

    /// <summary>
    /// Writes the live ledger row inside the result's command, isolated by its own savepoint: a
    /// ledger failure (such as a removed table) rolls back only the ledger row, never the result.
    /// </summary>
    private static bool TryRecordLiveUsage(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string requestId,
        int attempt,
        long completedAt,
        (string Model, string? Virtual, string Type) start,
        UsageRow usage
    )
    {
        void Execute(string sql)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }
        Execute("SAVEPOINT llm_usage_row");
        try
        {
            string? session = null;
            var purpose = "low-level";
            using (var request = connection.CreateCommand())
            {
                request.Transaction = transaction;
                request.CommandText =
                    "SELECT session_id,purpose FROM llm_journal_requests WHERE request_id=$id";
                Add(request, "$id", requestId);
                using var reader = request.ExecuteReader();
                if (reader.Read())
                {
                    session = reader.IsDBNull(0) ? null : reader.GetString(0);
                    purpose = reader.GetString(1);
                }
            }
            InsertUsage(
                connection,
                transaction,
                [
                    new(
                        requestId,
                        attempt,
                        completedAt,
                        session,
                        purpose,
                        start.Model,
                        usage.ProviderKey ?? ProviderPrefix(start.Model),
                        start.Type,
                        start.Virtual,
                        usage
                    ),
                ]
            );
            Execute("RELEASE llm_usage_row");
            return true;
        }
        catch (SqliteException)
        {
            Execute("ROLLBACK TO llm_usage_row");
            Execute("RELEASE llm_usage_row");
            return false;
        }
    }

    /// <summary>
    /// Extends the covered range to a newly written result when everything before it is already
    /// covered, so a restart does not rescan results that were recorded live.
    /// </summary>
    private static void AdvanceUsageHigh(
        SqliteConnection connection,
        SqliteTransaction transaction,
        long rowid
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE llm_journal_metadata SET value=$rowid WHERE key=$key
              AND CAST(value AS INTEGER)>=(SELECT coalesce(max(rowid),0) FROM llm_journal_attempt_results WHERE rowid<$row)
              AND CAST(value AS INTEGER)<$row
            """;
        Add(command, "$rowid", rowid.ToString(CultureInfo.InvariantCulture));
        Add(command, "$row", rowid);
        Add(command, "$key", HighKey);
        command.ExecuteNonQuery();
    }

    private static object? ReadMetadata(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string key
    ) =>
        ReadScalar(
            connection,
            transaction,
            "SELECT value FROM llm_journal_metadata WHERE key=$key",
            ("$key", key)
        );

    private static long? MetadataNumber(object? value) =>
        value is string text && long.TryParse(text, CultureInfo.InvariantCulture, out var number)
            ? number
            : null;

    private static void WriteMetadata(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string key,
        long value
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "INSERT INTO llm_journal_metadata(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        Add(command, "$key", key);
        Add(command, "$value", value.ToString(CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
    }

    private static bool UsageTableExists(
        SqliteConnection connection,
        SqliteTransaction? transaction
    ) =>
        ReadScalar(
            connection,
            transaction,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_usage'"
        )
            is not null;

    /// <summary>
    /// Rebuilds missing ledger rows from successful attempt results: first results written while
    /// the ledger was not maintained (newer than the covered range, oldest first), then older
    /// history newest first. Reading and attribution happen on a read connection; the writer
    /// only inserts prepared rows in small batches, so live journal commands wait at most for
    /// one batch. Progress is checkpointed per batch; reruns are idempotent.
    /// </summary>
    internal async Task BackfillUsageAsync(
        CancellationToken token,
        int batchSize = UsageBackfillBatch
    )
    {
        CheckOpen();
        var (low, high) = await PrepareUsageLedgerAsync(token).ConfigureAwait(false);
        using var source = new UsageSource(OpenReadOnly());
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var top = source.MaxResultRowid();
            if (top <= high)
                break;
            var end = Math.Min(top, high + batchSize);
            var rows = source.Read(
                $"a.rowid>{high} AND a.rowid<={end}",
                ascending: true,
                limit: null
            );
            token.ThrowIfCancellationRequested();
            high = await WriteUsageBatchAsync(rows.Rows, HighKey, end, token).ConfigureAwait(false);
        }
        while (low > 1)
        {
            token.ThrowIfCancellationRequested();
            var batch = source.Read($"a.rowid<{low}", ascending: false, limit: batchSize);
            var next = batch.Scanned < batchSize ? 1 : batch.Lowest;
            token.ThrowIfCancellationRequested();
            await WriteUsageBatchAsync(batch.Rows, LowKey, next, token).ConfigureAwait(false);
            low = next;
        }
    }

    /// <summary>
    /// Ensures the ledger table and its checkpoints. A ledger that was removed, or emptied while
    /// its checkpoints claim coverage, starts over: its checkpoints are reset so the backfill
    /// rebuilds every row from the attempt results.
    /// </summary>
    private async Task<(long Low, long High)> PrepareUsageLedgerAsync(CancellationToken token)
    {
        var receipt = await Writer
            .EnqueueAsync(
                (connection, transaction) =>
                {
                    var reset = false;
                    if (!UsageTableExists(connection, transaction))
                    {
                        using var create = connection.CreateCommand();
                        create.Transaction = transaction;
                        create.CommandText = UsageSchemaSql;
                        create.ExecuteNonQuery();
                        reset = true;
                    }
                    else if (
                        ReadScalar(connection, transaction, "SELECT 1 FROM llm_usage LIMIT 1")
                            is null
                        && MetadataNumber(ReadMetadata(connection, transaction, HighKey))
                            is long covered
                        && ReadScalar(
                            connection,
                            transaction,
                            "SELECT 1 FROM llm_journal_attempt_results WHERE rowid<=$high AND outcome='success' LIMIT 1",
                            ("$high", covered)
                        )
                            is not null
                    )
                        reset = true;
                    if (reset)
                    {
                        using var clear = connection.CreateCommand();
                        clear.Transaction = transaction;
                        clear.CommandText =
                            "DELETE FROM llm_journal_metadata WHERE key IN ($low,$high)";
                        Add(clear, "$low", LowKey);
                        Add(clear, "$high", HighKey);
                        clear.ExecuteNonQuery();
                    }
                    var top = Convert.ToInt64(
                        ReadScalar(
                            connection,
                            transaction,
                            "SELECT coalesce(max(rowid),0) FROM llm_journal_attempt_results"
                        ),
                        CultureInfo.InvariantCulture
                    );
                    long Read(string key, long initial)
                    {
                        if (
                            MetadataNumber(ReadMetadata(connection, transaction, key)) is long value
                        )
                            return value;
                        WriteMetadata(connection, transaction, key, initial);
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
    /// never moves backwards (live results may already have extended it); the call returns the
    /// stored value.
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
                (connection, transaction) =>
                {
                    InsertUsage(connection, transaction, rows);
                    var stored = MetadataNumber(ReadMetadata(connection, transaction, checkpoint));
                    if (checkpoint == LowKey || stored is null || stored < value)
                    {
                        WriteMetadata(connection, transaction, checkpoint, value);
                        return value;
                    }
                    return stored.Value;
                },
                token
            )
            .ConfigureAwait(false);
        var result = await receipt.Completion.ConfigureAwait(false);
        if (rows.Count > 0)
            NotifyUsageRecorded();
        return result;
    }

    /// <summary>
    /// Read side of the backfill on its own read-only connection. The latest attempt start of
    /// each request attempt is looked up through a connection-local temporary table, built once
    /// per pass, so the shared database needs no new index and the writer is never held for it.
    /// </summary>
    private sealed class UsageSource(SqliteConnection connection) : IDisposable
    {
        private bool startsReady;

        public void Dispose() => connection.Dispose();

        internal long MaxResultRowid() =>
            Convert.ToInt64(
                ReadScalar(
                    connection,
                    null,
                    "SELECT coalesce(max(rowid),0) FROM llm_journal_attempt_results"
                ),
                CultureInfo.InvariantCulture
            );

        private void EnsureStarts()
        {
            if (startsReady)
                return;
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TEMP TABLE IF NOT EXISTS usage_starts(request_id TEXT NOT NULL,attempt INTEGER NOT NULL,
                  model TEXT NOT NULL,virtual_key TEXT,provider_type TEXT NOT NULL,PRIMARY KEY(request_id,attempt));
                DELETE FROM temp.usage_starts;
                INSERT OR REPLACE INTO temp.usage_starts
                  SELECT request_id,attempt,concrete_model_id,virtual_model_key,provider_type
                  FROM llm_journal_attempt_starts ORDER BY rowid;
                """;
            command.ExecuteNonQuery();
            startsReady = true;
        }

        private (string Model, string? Virtual, string Type)? Start(string requestId, long attempt)
        {
            // Only for results newer than this pass's start table, which are rare.
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT concrete_model_id,virtual_model_key,provider_type FROM llm_journal_attempt_starts WHERE request_id=$id AND attempt=$attempt ORDER BY rowid DESC LIMIT 1";
            Add(command, "$id", requestId);
            Add(command, "$attempt", attempt);
            using var reader = command.ExecuteReader();
            return reader.Read()
                ? (
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetString(2)
                )
                : null;
        }

        /// <summary>
        /// Successful results in the range that have no ledger row yet, with what their row
        /// needs. Results whose request or start is missing are skipped but still scanned.
        /// </summary>
        internal (List<PendingUsage> Rows, int Scanned, long Lowest) Read(
            string range,
            bool ascending,
            int? limit
        )
        {
            EnsureStarts();
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                SELECT a.rowid,a.request_id,a.attempt,a.completed_at,r.request_id IS NOT NULL,r.session_id,r.purpose,
                  s.model,s.virtual_key,s.provider_type,
                  CASE WHEN json_valid(a.result_json) THEN json_extract(a.result_json,'$.usage') END
                FROM llm_journal_attempt_results a
                LEFT JOIN llm_journal_requests r ON r.request_id=a.request_id
                LEFT JOIN temp.usage_starts s ON s.request_id=a.request_id AND s.attempt=a.attempt
                WHERE {range} AND a.outcome='success'
                  AND NOT EXISTS(SELECT 1 FROM llm_usage u WHERE u.request_id=a.request_id AND u.attempt=a.attempt)
                ORDER BY a.rowid {(ascending ? "ASC" : "DESC")}{(
                    limit is null ? "" : " LIMIT " + limit
                )}
                """;
            using var reader = command.ExecuteReader();
            var rows = new List<PendingUsage>();
            var scanned = 0;
            var lowest = long.MaxValue;
            while (reader.Read())
            {
                scanned++;
                lowest = Math.Min(lowest, reader.GetInt64(0));
                if (reader.GetInt64(4) == 0)
                    continue;
                var requestId = reader.GetString(1);
                var attempt = reader.GetInt64(2);
                var start = reader.IsDBNull(7)
                    ? Start(requestId, attempt)
                    : (
                        reader.GetString(7),
                        reader.IsDBNull(8) ? null : reader.GetString(8),
                        reader.GetString(9)
                    );
                if (start is not { } found)
                    continue;
                JsonNode? usage = null;
                if (!reader.IsDBNull(10) && reader.GetValue(10) is string text)
                    try
                    {
                        usage = JsonNode.Parse(text);
                    }
                    catch (System.Text.Json.JsonException) { }
                rows.Add(
                    new(
                        requestId,
                        attempt,
                        reader.GetInt64(3),
                        reader.IsDBNull(5) ? null : reader.GetString(5),
                        reader.GetString(6),
                        found.Model,
                        ProviderPrefix(found.Model),
                        found.Type,
                        found.Virtual,
                        ToUsageRow(usage, null)
                    )
                );
            }
            return (rows, scanned, lowest);
        }
    }

    /// <summary>A read-only connection to an existing ledger, or null when there is none yet.</summary>
    private SqliteConnection? OpenUsageReader()
    {
        if (!File.Exists(path))
            return null;
        var connection = OpenReadOnly();
        if (UsageTableExists(connection, null))
            return connection;
        connection.Dispose();
        return null;
    }

    /// <summary>Distinct Sessions with recorded usage in [from, to).</summary>
    internal IReadOnlyList<string> UsageSessions(long from, long to)
    {
        CheckOpen();
        using var connection = OpenUsageReader();
        if (connection is null)
            return [];
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT DISTINCT session_id FROM llm_usage WHERE completed_at>=$from AND completed_at<$to AND session_id IS NOT NULL";
        Add(command, "$from", from);
        Add(command, "$to", to);
        using var reader = command.ExecuteReader();
        var result = new List<string>();
        while (reader.Read())
            result.Add(reader.GetString(0));
        return result;
    }

    /// <summary>
    /// Aggregates ledger rows into consecutive [boundary, next boundary) buckets, optionally by
    /// one ledger column and, for Session-level queries, by recorded Session. A Session-level
    /// query marks rows that completed before the supplied start of their Session's current
    /// history, so an earlier Session with a reused ID stays separate. Reads use their own
    /// read-only connection, never the journal writer.
    /// </summary>
    internal IReadOnlyList<LlmUsageCell> QueryUsage(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession = false,
        IReadOnlyDictionary<string, long>? sessionStarts = null
    )
    {
        CheckOpen();
        if (boundaries.Count < 2)
            throw new ArgumentException("Usage queries need at least one time bucket.");
        if (groupColumn is not null && !UsageGroupColumns.Contains(groupColumn))
            throw new ArgumentException("Unknown usage grouping.");
        using var connection = OpenUsageReader();
        if (connection is null)
            return [];
        var starts = bySession && sessionStarts is { Count: > 0 };
        if (starts)
        {
            using var create = connection.CreateCommand();
            create.CommandText =
                "CREATE TEMP TABLE usage_session_starts(session_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL)";
            create.ExecuteNonQuery();
            using var insert = connection.CreateCommand();
            insert.CommandText = "INSERT INTO temp.usage_session_starts VALUES($id,$at)";
            var id = insert.Parameters.Add("$id", SqliteType.Text);
            var at = insert.Parameters.Add("$at", SqliteType.Integer);
            foreach (var (session, started) in sessionStarts!)
            {
                id.Value = session;
                at.Value = started;
                insert.ExecuteNonQuery();
            }
        }
        using var command = connection.CreateCommand();
        var values = new StringBuilder();
        for (var index = 0; index + 1 < boundaries.Count; index++)
        {
            if (index > 0)
                values.Append(',');
            values.Append($"({index},$b{index},$b{index + 1})");
        }
        for (var index = 0; index < boundaries.Count; index++)
            Add(command, "$b" + index, boundaries[index]);
        var key = groupColumn is null ? "NULL" : "u." + groupColumn;
        var sessionColumn = bySession ? "u.session_id" : "NULL";
        var before = starts
            ? "CASE WHEN ss.started_at IS NOT NULL AND u.completed_at<ss.started_at THEN 1 ELSE 0 END"
            : "0";
        command.CommandText = $"""
            WITH buckets(i,b0,b1) AS (VALUES {values})
            SELECT buckets.i,{key},count(*),coalesce(sum(u.cached_tokens),0),coalesce(sum(u.input_tokens),0),
              coalesce(sum(u.output_tokens),0),count(u.cost),coalesce(sum(u.cost),0),{sessionColumn},{before}
            FROM buckets JOIN llm_usage u ON u.completed_at>=buckets.b0 AND u.completed_at<buckets.b1
            {(starts ? "LEFT JOIN temp.usage_session_starts ss ON ss.session_id=u.session_id" : "")}
            GROUP BY 1,2,9,10
            """;
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
        return cells;
    }

    /// <summary>
    /// The first recorded request, and whether the backfill has covered all history: its low
    /// checkpoint exists and no successful result lies below it.
    /// </summary>
    internal LlmUsageCoverage UsageCoverage()
    {
        CheckOpen();
        using var connection = OpenUsageReader();
        if (connection is null)
            return new(null, false);
        var earliest = ReadScalar(connection, null, "SELECT min(completed_at) FROM llm_usage");
        var complete =
            MetadataNumber(ReadMetadata(connection, null, LowKey)) is long low
            && (
                low <= 1
                || ReadScalar(
                    connection,
                    null,
                    "SELECT 1 FROM llm_journal_attempt_results WHERE rowid<$low AND outcome='success' LIMIT 1",
                    ("$low", low)
                )
                    is null
            );
        return new(earliest is long first ? first : null, complete);
    }
}
