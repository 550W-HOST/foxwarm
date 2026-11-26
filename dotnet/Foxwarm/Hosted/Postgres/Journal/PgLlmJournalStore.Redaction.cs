using Foxwarm.Models;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// Per-attempt text-redaction statistics with the file journal's rules: written with the
/// attempt's result or on their own, never failing the command they travel with, and
/// aggregated like the usage ledger.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    private const string InsertRedactionSql = """
        INSERT INTO llm_redaction(request_id,attempt,completed_at,session_id,purpose,model_key,provider_key,
          provider_type,virtual_model_key,failure_kind,detected,literal,detected_labels,literal_labels,slots,
          detected_slots,cached_slots,detector_calls,detection_ms,omitted)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING
        """;

    /// <summary>Inserts one redaction row under its own savepoint; reports whether it was written.</summary>
    private static bool TryRecordRedaction(
        PgTx tx,
        string requestId,
        int attempt,
        long completedAt,
        LlmRedactionRecord record
    )
    {
        tx.Execute("SAVEPOINT llm_redaction_row");
        try
        {
            tx.Execute(
                InsertRedactionSql,
                requestId,
                (long)attempt,
                completedAt,
                record.SessionId,
                record.Purpose,
                record.ModelKey,
                record.ProviderKey,
                record.ProviderType,
                record.VirtualModelKey,
                record.FailureKind,
                (long)record.Detected,
                (long)record.Literal,
                record.DetectedLabels.ToJsonText(),
                record.LiteralLabels.ToJsonText(),
                (long)record.Slots,
                (long)record.DetectedSlots,
                (long)record.CachedSlots,
                (long)record.DetectorCalls,
                record.DetectionMs,
                record.Omitted ? 1L : 0L
            );
            tx.Execute("RELEASE SAVEPOINT llm_redaction_row");
            return true;
        }
        catch (Exception error) when (OptionalRowFailure(error))
        {
            tx.Execute("ROLLBACK TO SAVEPOINT llm_redaction_row");
            tx.Execute("RELEASE SAVEPOINT llm_redaction_row");
            return false;
        }
    }

    public async Task<bool> AppendRedactionAsync(
        string requestId,
        int attempt,
        LlmRedactionRecord record,
        CancellationToken token = default
    )
    {
        CheckOpen();
        var receipt = await Writer
            .EnqueueAsync(
                tx => TryRecordRedaction(tx, requestId, attempt, Now(), record),
                token
            )
            .ConfigureAwait(false);
        var written = await receipt.Completion.ConfigureAwait(false);
        if (written)
            Raise(UsageRecorded);
        return written;
    }

    /// <summary>Distinct Sessions with recorded redaction statistics in [from, to).</summary>
    public IReadOnlyList<string> RedactionSessions(long from, long to) =>
        DistinctSessions("llm_redaction", from, to);

    // Label counts are JSON objects of integers; anything else contributes nothing, like the
    // file journal's json_each over invalid JSON.
    private static string LabelEntries(string column) =>
        $"CROSS JOIN LATERAL json_each_text(CASE WHEN r.{column} IS JSON OBJECT THEN r.{column}::json ELSE '{{}}'::json END) j";

    /// <summary>
    /// Aggregates redaction rows into the same buckets, groups and Session attribution as
    /// <see cref="QueryUsage"/>.
    /// </summary>
    public IReadOnlyList<LlmRedactionCell> QueryRedaction(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession = false,
        IReadOnlyDictionary<string, long>? sessionStarts = null
    )
    {
        CheckOpen();
        ValidateQuery(boundaries, groupColumn);
        var starts = bySession && sessionStarts is { Count: > 0 };
        var key = groupColumn is null ? "NULL::text" : "r." + groupColumn;
        var session = bySession ? "r.session_id" : "NULL::text";
        var before = starts
            ? "(CASE WHEN ss.started_at IS NOT NULL AND r.completed_at<ss.started_at THEN 1 ELSE 0 END)::bigint"
            : "0::bigint";
        var from = $"""
            FROM buckets JOIN llm_redaction r ON r.completed_at>=buckets.b0 AND r.completed_at<buckets.b1
            {(starts ? SessionStartsJoin + "r.session_id" : "")}
            """;
        var parameters = QueryParameters(boundaries, starts, sessionStarts);
        return database.Read(
            tx =>
            {
                var cells = new Dictionary<(int, string?, string?, bool), RedactionTotals>();
                RedactionTotals Cell(NpgsqlDataReader reader)
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
                using (var command = tx.Command(
                    $"""
                    {BucketsCte}
                    SELECT buckets.i,{key},{session},{before},r.failure_kind,count(*),sum(r.detected)::bigint,
                      sum(r.literal)::bigint,sum(r.slots)::bigint,sum(r.cached_slots)::bigint,
                      sum(r.detector_calls)::bigint,sum(r.omitted)::bigint,sum(r.detection_ms)::double precision
                    {from}
                    GROUP BY 1,2,3,4,5
                    """,
                    parameters
                ))
                using (var reader = command.ExecuteReader())
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
                const string count =
                    "sum(CASE WHEN j.value ~ '^-?[0-9]{1,18}$' THEN j.value::bigint END)::bigint";
                using (var command = tx.Command(
                    $"""
                    {BucketsCte}
                    SELECT buckets.i,{key},{session},{before},j.key,{count}
                    {from}
                    {LabelEntries("detected_labels")}
                    WHERE r.failure_kind IS NULL
                    GROUP BY 1,2,3,4,5
                    UNION ALL
                    SELECT buckets.i,{key},{session},{before},j.key,{count}
                    {from}
                    {LabelEntries("literal_labels")}
                    WHERE r.failure_kind IS NULL
                    GROUP BY 1,2,3,4,5
                    """,
                    parameters
                ))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                    {
                        if (reader.IsDBNull(4) || reader.IsDBNull(5))
                            continue;
                        var labels = Cell(reader).Labels;
                        labels[reader.GetString(4)] =
                            labels.GetValueOrDefault(reader.GetString(4)) + reader.GetInt64(5);
                    }
                return (IReadOnlyList<LlmRedactionCell>)cells
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
            },
            snapshot: true
        );
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
