using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

/// <summary>
/// What one attempt on a redacting model did before it was sent, or why detection failed.
/// Counts and timings only: never originals or placeholders.
/// </summary>
internal sealed record LlmRedactionRecord(
    string? SessionId,
    string Purpose,
    string ModelKey,
    string ProviderKey,
    string ProviderType,
    string? VirtualModelKey,
    string? FailureKind,
    int Detected,
    int Literal,
    JsonObject DetectedLabels,
    JsonObject LiteralLabels,
    int Slots,
    int DetectedSlots,
    int CachedSlots,
    int DetectorCalls,
    double DetectionMs,
    bool Omitted
)
{
    internal static LlmRedactionRecord From(
        TextRedactionStats stats,
        string? sessionId,
        string purpose,
        string modelKey,
        string providerKey,
        string providerType,
        string? virtualModelKey,
        string? failureKind
    )
    {
        var labels = stats.Labels;
        return new(
            sessionId,
            purpose,
            modelKey,
            providerKey,
            providerType,
            virtualModelKey,
            failureKind,
            labels.Sum(label => label.Detected),
            labels.Sum(label => label.Literal),
            TextRedactionStats.LabelCounts(labels, literal: false),
            TextRedactionStats.LabelCounts(labels, literal: true),
            stats.Slots,
            stats.DetectedSlots,
            stats.CachedSlots,
            stats.DetectorCalls,
            stats.DetectionMs,
            stats.Omitted
        );
    }
}

/// <summary>
/// Aggregated redaction statistics for one bucket, optional group value and, for Session-level
/// queries, recorded Session. Counts and timings cover sent attempts only. `Failures` counts
/// detection failures by kind; they are not provider attempts and are not in `Attempts`.
/// </summary>
internal sealed record LlmRedactionCell(
    int Bucket,
    string? Key,
    string? SessionId,
    bool BeforeSessionStart,
    long Attempts,
    long Detected,
    long Literal,
    long Slots,
    long CachedSlots,
    long DetectorCalls,
    double DetectionMs,
    long Omitted,
    IReadOnlyDictionary<string, long> Labels,
    IReadOnlyDictionary<string, long> Failures
);

/// <summary>
/// Per-attempt text redaction statistics in the journal database, keyed like attempts by
/// request and attempt number. A row is either a sent attempt (`failure_kind` NULL), written
/// with its successful result or after its provider failure/abort, or a detection failure,
/// which consumed an attempt number of the request's retry budget but has no attempt start or
/// result: nothing was sent. Reconstruction and the usage ledger never read this table; it is
/// additive, so older readers ignore it, and it is not rebuilt from other rows.
/// </summary>
public sealed partial class LlmRequestJournalStore
{
    private const string RedactionSchemaSql = """
        CREATE TABLE IF NOT EXISTS llm_redaction(
          request_id TEXT NOT NULL,attempt INTEGER NOT NULL,completed_at INTEGER NOT NULL,
          session_id TEXT,purpose TEXT NOT NULL,model_key TEXT NOT NULL,provider_key TEXT NOT NULL,
          provider_type TEXT NOT NULL,virtual_model_key TEXT,failure_kind TEXT,
          detected INTEGER NOT NULL,literal INTEGER NOT NULL,detected_labels TEXT NOT NULL,literal_labels TEXT NOT NULL,
          slots INTEGER NOT NULL,detected_slots INTEGER NOT NULL,cached_slots INTEGER NOT NULL,
          detector_calls INTEGER NOT NULL,detection_ms REAL NOT NULL,omitted INTEGER NOT NULL,
          PRIMARY KEY(request_id,attempt));
        CREATE INDEX IF NOT EXISTS idx_llm_redaction_time ON llm_redaction(completed_at);
        """;

    private const string InsertRedactionSql = """
        INSERT OR IGNORE INTO llm_redaction(request_id,attempt,completed_at,session_id,purpose,model_key,provider_key,
          provider_type,virtual_model_key,failure_kind,detected,literal,detected_labels,literal_labels,slots,
          detected_slots,cached_slots,detector_calls,detection_ms,omitted)
        VALUES($request,$attempt,$completed,$session,$purpose,$model,$provider,$type,$virtual,$failure,$detected,
          $literal,$detectedLabels,$literalLabels,$slots,$detectedSlots,$cachedSlots,$calls,$ms,$omitted)
        """;

    /// <summary>
    /// Inserts one redaction row under its own savepoint, so a failure (for example a removed
    /// table) never affects the journal command it travels with.
    /// </summary>
    private static bool TryRecordRedaction(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string requestId,
        int attempt,
        long completedAt,
        LlmRedactionRecord record
    )
    {
        void Execute(string sql)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }
        Execute("SAVEPOINT llm_redaction_row");
        try
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = InsertRedactionSql;
            Add(command, "$request", requestId);
            Add(command, "$attempt", attempt);
            Add(command, "$completed", completedAt);
            Add(command, "$session", record.SessionId);
            Add(command, "$purpose", record.Purpose);
            Add(command, "$model", record.ModelKey);
            Add(command, "$provider", record.ProviderKey);
            Add(command, "$type", record.ProviderType);
            Add(command, "$virtual", record.VirtualModelKey);
            Add(command, "$failure", record.FailureKind);
            Add(command, "$detected", record.Detected);
            Add(command, "$literal", record.Literal);
            Add(command, "$detectedLabels", record.DetectedLabels.ToJsonString());
            Add(command, "$literalLabels", record.LiteralLabels.ToJsonString());
            Add(command, "$slots", record.Slots);
            Add(command, "$detectedSlots", record.DetectedSlots);
            Add(command, "$cachedSlots", record.CachedSlots);
            Add(command, "$calls", record.DetectorCalls);
            Add(command, "$ms", record.DetectionMs);
            Add(command, "$omitted", record.Omitted ? 1 : 0);
            command.ExecuteNonQuery();
            Execute("RELEASE llm_redaction_row");
            return true;
        }
        catch (SqliteException)
        {
            Execute("ROLLBACK TO llm_redaction_row");
            Execute("RELEASE llm_redaction_row");
            return false;
        }
    }

    /// <summary>
    /// Records an attempt's redaction statistics on its own, for attempts whose result is not
    /// written as a success: detection failures (which have no attempt start) and sent attempts
    /// that failed or were stopped. Returns whether the row was written.
    /// </summary>
    internal async Task<bool> AppendRedactionAsync(
        string requestId,
        int attempt,
        LlmRedactionRecord record,
        CancellationToken token = default
    )
    {
        CheckOpen();
        var receipt = await Writer
            .EnqueueAsync(
                (connection, transaction) =>
                    TryRecordRedaction(
                        connection,
                        transaction,
                        requestId,
                        attempt,
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        record
                    ),
                token
            )
            .ConfigureAwait(false);
        var written = await receipt.Completion.ConfigureAwait(false);
        if (written)
            NotifyUsageRecorded();
        return written;
    }

    private SqliteConnection? OpenRedactionReader()
    {
        if (!File.Exists(path))
            return null;
        var connection = OpenReadOnly();
        if (
            ReadScalar(
                connection,
                null,
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_redaction'"
            )
            is not null
        )
            return connection;
        connection.Dispose();
        return null;
    }

    /// <summary>Distinct Sessions with recorded redaction statistics in [from, to).</summary>
    internal IReadOnlyList<string> RedactionSessions(long from, long to)
    {
        CheckOpen();
        using var connection = OpenRedactionReader();
        if (connection is null)
            return [];
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT DISTINCT session_id FROM llm_redaction WHERE completed_at>=$from AND completed_at<$to AND session_id IS NOT NULL";
        Add(command, "$from", from);
        Add(command, "$to", to);
        using var reader = command.ExecuteReader();
        var result = new List<string>();
        while (reader.Read())
            result.Add(reader.GetString(0));
        return result;
    }

    /// <summary>
    /// Aggregates redaction rows into the same buckets, groups and Session attribution as
    /// <see cref="QueryUsage"/>. Old databases without the table return no cells.
    /// </summary>
    internal IReadOnlyList<LlmRedactionCell> QueryRedaction(
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
        using var connection = OpenRedactionReader();
        if (connection is null)
            return [];
        var starts = bySession && sessionStarts is { Count: > 0 };
        if (starts)
            CreateSessionStarts(connection, sessionStarts!);
        var key = groupColumn is null ? "NULL" : "r." + groupColumn;
        var session = bySession ? "r.session_id" : "NULL";
        var before = starts
            ? "CASE WHEN ss.started_at IS NOT NULL AND r.completed_at<ss.started_at THEN 1 ELSE 0 END"
            : "0";
        var from = $"""
            FROM buckets JOIN llm_redaction r ON r.completed_at>=buckets.b0 AND r.completed_at<buckets.b1
            {(starts ? "LEFT JOIN temp.usage_session_starts ss ON ss.session_id=r.session_id" : "")}
            """;
        var cells = new Dictionary<(int, string?, string?, bool), RedactionTotals>();
        RedactionTotals Cell(SqliteDataReader reader)
        {
            var id = (
                reader.GetInt32(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetInt64(3) == 1
            );
            if (!cells.TryGetValue(id, out var cell))
                cells[id] = cell = new();
            return cell;
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"""
                WITH buckets(i,b0,b1) AS (VALUES {BucketValues(command, boundaries)})
                SELECT buckets.i,{key},{session},{before},r.failure_kind,count(*),sum(r.detected),sum(r.literal),
                  sum(r.slots),sum(r.cached_slots),sum(r.detector_calls),sum(r.omitted),sum(r.detection_ms)
                {from}
                GROUP BY 1,2,3,4,5
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var cell = Cell(reader);
                var rows = reader.GetInt64(5);
                // A failed pass sent nothing; only its kind is counted.
                if (!reader.IsDBNull(4))
                {
                    cell.Failures[reader.GetString(4)] =
                        cell.Failures.GetValueOrDefault(reader.GetString(4)) + rows;
                    continue;
                }
                cell.Attempts += rows;
                cell.Detected += reader.GetInt64(6);
                cell.Literal += reader.GetInt64(7);
                cell.Slots += reader.GetInt64(8);
                cell.CachedSlots += reader.GetInt64(9);
                cell.DetectorCalls += reader.GetInt64(10);
                cell.Omitted += reader.GetInt64(11);
                cell.DetectionMs += reader.GetDouble(12);
            }
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"""
                WITH buckets(i,b0,b1) AS (VALUES {BucketValues(command, boundaries)})
                SELECT buckets.i,{key},{session},{before},j.key,sum(j.value)
                {from}
                JOIN json_each(CASE WHEN json_valid(r.detected_labels) THEN r.detected_labels ELSE '{"{}"}' END) j
                WHERE r.failure_kind IS NULL
                GROUP BY 1,2,3,4,5
                UNION ALL
                SELECT buckets.i,{key},{session},{before},j.key,sum(j.value)
                {from}
                JOIN json_each(CASE WHEN json_valid(r.literal_labels) THEN r.literal_labels ELSE '{"{}"}' END) j
                WHERE r.failure_kind IS NULL
                GROUP BY 1,2,3,4,5
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                if (reader.IsDBNull(4) || reader.IsDBNull(5))
                    continue;
                var labels = Cell(reader).Labels;
                labels[reader.GetString(4)] =
                    labels.GetValueOrDefault(reader.GetString(4)) + reader.GetInt64(5);
            }
        }
        return cells
            .Select(pair => new LlmRedactionCell(
                pair.Key.Item1,
                pair.Key.Item2,
                pair.Key.Item3,
                pair.Key.Item4,
                pair.Value.Attempts,
                pair.Value.Detected,
                pair.Value.Literal,
                pair.Value.Slots,
                pair.Value.CachedSlots,
                pair.Value.DetectorCalls,
                pair.Value.DetectionMs,
                pair.Value.Omitted,
                pair.Value.Labels,
                pair.Value.Failures
            ))
            .ToArray();
    }

    private sealed class RedactionTotals
    {
        internal long Attempts;
        internal long Detected;
        internal long Literal;
        internal long Slots;
        internal long CachedSlots;
        internal long DetectorCalls;
        internal long Omitted;
        internal double DetectionMs;
        internal readonly Dictionary<string, long> Labels = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, long> Failures = new(StringComparer.Ordinal);
    }
}
