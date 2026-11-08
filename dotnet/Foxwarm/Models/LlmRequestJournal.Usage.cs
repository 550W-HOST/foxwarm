using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

/// <summary>The caller's knowledge that the journal rows themselves do not carry.</summary>
internal sealed record LlmUsageAttribution(string? SessionId, string? ProviderKey);

/// <summary>One aggregated ledger cell: a time bucket and an optional group value.</summary>
internal sealed record LlmUsageCell(
    int Bucket,
    string? Key,
    long Requests,
    long CachedTokens,
    long InputTokens,
    long OutputTokens,
    long PricedRequests,
    double Cost,
    string? Agent = null
);

internal sealed record LlmUsageCoverage(long? Earliest, bool Complete);

/// <summary>
/// Derived per-request usage ledger in the journal database. Every successful attempt result
/// owns at most one row; rows are written with the result or rebuilt from it by the backfill,
/// never repriced, and never authoritative for anything else.
/// </summary>
public sealed partial class LlmRequestJournalStore
{
    internal sealed record UsageRow(
        string? Agent,
        string? ProviderKey,
        long? CachedTokens,
        long? InputTokens,
        long? OutputTokens,
        double? Cost
    );

    internal static readonly string[] UsageGroupColumns =
    [
        "agent",
        "session_id",
        "model_key",
        "provider_key",
        "purpose",
    ];

    private const string LowKey = "usage-ledger-low";
    private const string HighKey = "usage-ledger-high";
    internal const int UsageBackfillBatch = 500;

    // Additive only: older readers ignore the table and indexes. The attempt-start index
    // serves the ledger joins and the existing result-before-start check.
    private const string UsageSchemaSql = """
        CREATE TABLE IF NOT EXISTS llm_usage(
          request_id TEXT NOT NULL,attempt INTEGER NOT NULL,completed_at INTEGER NOT NULL,
          session_id TEXT,agent TEXT,purpose TEXT NOT NULL,model_key TEXT NOT NULL,provider_key TEXT NOT NULL,
          provider_type TEXT NOT NULL,virtual_model_key TEXT,
          cached_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost REAL,
          PRIMARY KEY(request_id,attempt));
        CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage(completed_at);
        CREATE INDEX IF NOT EXISTS idx_llm_usage_agent ON llm_usage(agent,completed_at);
        CREATE INDEX IF NOT EXISTS idx_llm_journal_attempt_starts_request ON llm_journal_attempt_starts(request_id,attempt);
        """;

    private static string ProviderPrefix(string column) =>
        $"CASE WHEN instr({column},'/')>0 THEN substr({column},1,instr({column},'/')-1) ELSE {column} END";

    private static string UsageNumber(string source, string field) =>
        $"CASE WHEN json_type({source},'$.usage.{field}') IN ('integer','real') AND json_extract({source},'$.usage.{field}')>=0 THEN json_extract({source},'$.usage.{field}') END";

    /// <summary>Optional Session-to-Agent lookup used when a live result is recorded.</summary>
    internal Func<string, string?>? SessionAgent { get; set; }

    /// <summary>Raised after ledger rows commit, from live results or a backfill batch.</summary>
    internal event Action? UsageRecorded;

    private void NotifyUsageRecorded()
    {
        try
        {
            UsageRecorded?.Invoke();
        }
        catch
        {
            // Presentation listeners cannot fail a committed result.
        }
    }

    private UsageRow PrepareUsageRow(ChatResult result, LlmUsageAttribution? attribution)
    {
        string? agent = null;
        if (attribution?.SessionId is { Length: > 0 } sessionId && SessionAgent is { } resolve)
            try
            {
                agent = resolve(sessionId);
            }
            catch
            {
                // Attribution is best-effort; the row still counts under an unknown Agent.
            }
        var usage = result.Usage;
        static long? Count(JsonNode? value) =>
            SessionWait.Number(value) is double number && double.IsFinite(number) && number >= 0
                ? (long)number
                : null;
        var cost = SessionWait.Number(usage?["cost"]);
        return new(
            agent,
            attribution?.ProviderKey,
            Count(usage?["cachedTokens"]),
            Count(usage?["inputTokens"]),
            Count(usage?["outputTokens"]),
            cost is double value && double.IsFinite(value) && value >= 0 ? value : null
        );
    }

    private static void InsertUsageRow(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string requestId,
        int attempt,
        long completedAt,
        UsageRow row
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        // Session, purpose and the concrete model come from the journal's own records.
        command.CommandText = $"""
            INSERT OR IGNORE INTO llm_usage(request_id,attempt,completed_at,session_id,agent,purpose,model_key,provider_key,
              provider_type,virtual_model_key,cached_tokens,input_tokens,output_tokens,cost)
            SELECT r.request_id,s.attempt,$completed,r.session_id,CASE WHEN r.session_id IS NULL THEN NULL ELSE $agent END,
              r.purpose,s.concrete_model_id,COALESCE($provider,{ProviderPrefix("s.concrete_model_id")}),s.provider_type,
              s.virtual_model_key,$cached,$input,$output,$cost
            FROM llm_journal_requests r JOIN llm_journal_attempt_starts s ON s.request_id=r.request_id AND s.attempt=$attempt
            WHERE r.request_id=$request ORDER BY s.rowid DESC LIMIT 1
            """;
        Add(command, "$request", requestId);
        Add(command, "$attempt", attempt);
        Add(command, "$completed", completedAt);
        Add(command, "$agent", row.Agent);
        Add(command, "$provider", row.ProviderKey);
        Add(command, "$cached", row.CachedTokens);
        Add(command, "$input", row.InputTokens);
        Add(command, "$output", row.OutputTokens);
        Add(command, "$cost", row.Cost);
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// Rebuilds missing ledger rows from successful attempt results, newest first: results
    /// written since the covered range (for example by a version without the ledger), then the
    /// remaining older results. Progress is checkpointed per batch; reruns are idempotent.
    /// </summary>
    internal async Task BackfillUsageAsync(
        Func<IReadOnlyCollection<string>, IReadOnlyDictionary<string, string?>> resolveAgents,
        CancellationToken token,
        int batchSize = UsageBackfillBatch
    )
    {
        CheckOpen();
        await InitializeAsync(token).ConfigureAwait(false);
        var (low, high, top) = await UsageCheckpointAsync(token).ConfigureAwait(false);
        // Results above the covered range, newest first; the range moves up when finished.
        if (top > high)
        {
            await BackfillRangeAsync(high + 1, top + 1, resolveAgents, null, batchSize, token)
                .ConfigureAwait(false);
            await SetMetadataAsync(HighKey, top, token).ConfigureAwait(false);
        }
        if (low > 1)
            await BackfillRangeAsync(1, low, resolveAgents, LowKey, batchSize, token)
                .ConfigureAwait(false);
    }

    private async Task<(long Low, long High, long Top)> UsageCheckpointAsync(
        CancellationToken token
    )
    {
        var receipt = await Writer
            .EnqueueAsync(
                (connection, transaction) =>
                {
                    var top = Convert.ToInt64(
                        ReadScalar(
                            connection,
                            transaction,
                            "SELECT coalesce(max(rowid),0) FROM llm_journal_attempt_results"
                        )
                    );
                    long Read(string key, long initial)
                    {
                        if (
                            ReadScalar(
                                connection,
                                transaction,
                                "SELECT value FROM llm_journal_metadata WHERE key=$key",
                                ("$key", key)
                            )
                                is string text
                            && long.TryParse(text, out var value)
                        )
                            return value;
                        WriteMetadata(connection, transaction, key, initial);
                        return initial;
                    }
                    // A fresh ledger covers nothing below the current newest result.
                    var high = Read(HighKey, top);
                    var low = Read(LowKey, high + 1);
                    return (low, high, top);
                },
                token
            )
            .ConfigureAwait(false);
        return await receipt.Completion.ConfigureAwait(false);
    }

    private async Task BackfillRangeAsync(
        long floor,
        long upper,
        Func<IReadOnlyCollection<string>, IReadOnlyDictionary<string, string?>> resolveAgents,
        string? checkpoint,
        int batchSize,
        CancellationToken token
    )
    {
        while (upper > floor)
        {
            token.ThrowIfCancellationRequested();
            var (sessions, lowest, full) = ReadBackfillBatch(floor, upper, batchSize);
            var from = full ? lowest : floor;
            var agents = sessions.Count == 0 ? new Dictionary<string, string?>() : resolveAgents(sessions);
            token.ThrowIfCancellationRequested();
            var map = new JsonObject();
            foreach (var (session, agent) in agents)
                if (agent is not null)
                    map[session] = agent;
            var agentsJson = map.ToJsonString();
            var to = upper - 1;
            var receipt = await Writer
                .EnqueueAsync(
                    (connection, transaction) =>
                    {
                        using var command = connection.CreateCommand();
                        command.Transaction = transaction;
                        command.CommandText = $"""
                            WITH src AS (
                              SELECT a.request_id,a.attempt,a.completed_at,
                                CASE WHEN json_valid(a.result_json) THEN a.result_json END AS result
                              FROM llm_journal_attempt_results a
                              WHERE a.rowid BETWEEN $from AND $to AND a.outcome='success'
                                AND NOT EXISTS(SELECT 1 FROM llm_usage u WHERE u.request_id=a.request_id AND u.attempt=a.attempt))
                            INSERT OR IGNORE INTO llm_usage(request_id,attempt,completed_at,session_id,agent,purpose,model_key,provider_key,
                              provider_type,virtual_model_key,cached_tokens,input_tokens,output_tokens,cost)
                            SELECT src.request_id,src.attempt,src.completed_at,r.session_id,
                              (SELECT j.value FROM json_each($agents) j WHERE j.key=r.session_id),
                              r.purpose,s.concrete_model_id,{ProviderPrefix("s.concrete_model_id")},s.provider_type,s.virtual_model_key,
                              {UsageNumber("src.result", "cachedTokens")},{UsageNumber("src.result", "inputTokens")},
                              {UsageNumber("src.result", "outputTokens")},{UsageNumber("src.result", "cost")}
                            FROM src JOIN llm_journal_requests r ON r.request_id=src.request_id
                            JOIN llm_journal_attempt_starts s ON s.rowid=(
                              SELECT s2.rowid FROM llm_journal_attempt_starts s2
                              WHERE s2.request_id=src.request_id AND s2.attempt=src.attempt ORDER BY s2.rowid DESC LIMIT 1)
                            """;
                        Add(command, "$from", from);
                        Add(command, "$to", to);
                        Add(command, "$agents", agentsJson);
                        var inserted = command.ExecuteNonQuery();
                        if (checkpoint is not null)
                            WriteMetadata(connection, transaction, checkpoint, from);
                        return inserted;
                    },
                    token
                )
                .ConfigureAwait(false);
            if (await receipt.Completion.ConfigureAwait(false) > 0)
                NotifyUsageRecorded();
            upper = from;
        }
    }

    private (HashSet<string> Sessions, long Lowest, bool Full) ReadBackfillBatch(
        long floor,
        long upper,
        int batchSize
    )
    {
        using var connection = OpenReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT a.rowid,r.session_id FROM llm_journal_attempt_results a
            LEFT JOIN llm_journal_requests r ON r.request_id=a.request_id
            WHERE a.rowid>=$floor AND a.rowid<$upper AND a.outcome='success'
              AND NOT EXISTS(SELECT 1 FROM llm_usage u WHERE u.request_id=a.request_id AND u.attempt=a.attempt)
            ORDER BY a.rowid DESC LIMIT $limit
            """;
        Add(command, "$floor", floor);
        Add(command, "$upper", upper);
        Add(command, "$limit", batchSize);
        using var reader = command.ExecuteReader();
        var sessions = new HashSet<string>(StringComparer.Ordinal);
        var lowest = upper;
        var count = 0;
        while (reader.Read())
        {
            lowest = reader.GetInt64(0);
            if (!reader.IsDBNull(1))
                sessions.Add(reader.GetString(1));
            count++;
        }
        return (sessions, lowest, count == batchSize);
    }

    private async Task SetMetadataAsync(string key, long value, CancellationToken token)
    {
        var receipt = await Writer
            .EnqueueAsync(
                (connection, transaction) =>
                {
                    WriteMetadata(connection, transaction, key, value);
                    return true;
                },
                token
            )
            .ConfigureAwait(false);
        await receipt.Completion.ConfigureAwait(false);
    }

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
        Add(command, "$value", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// Aggregates ledger rows into consecutive [boundary, next boundary) buckets, optionally
    /// grouped by one ledger column and filtered to one Agent.
    /// </summary>
    internal async Task<IReadOnlyList<LlmUsageCell>> QueryUsageAsync(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        string? agent,
        CancellationToken token = default
    )
    {
        CheckOpen();
        if (boundaries.Count < 2)
            throw new ArgumentException("Usage queries need at least one time bucket.");
        if (groupColumn is not null && !UsageGroupColumns.Contains(groupColumn))
            throw new ArgumentException("Unknown usage grouping.");
        await InitializeAsync(token).ConfigureAwait(false);
        using var connection = OpenReadOnly();
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
        // Agent grouping separates requests outside any Session (NULL) from Session requests
        // whose Agent could not be attributed (empty string; Agent names are never empty).
        var key = groupColumn switch
        {
            null => "NULL",
            "agent" => "coalesce(u.agent,CASE WHEN u.session_id IS NULL THEN NULL ELSE '' END)",
            _ => "u." + groupColumn,
        };
        command.CommandText = $"""
            WITH buckets(i,b0,b1) AS (VALUES {values})
            SELECT buckets.i,{key},count(*),coalesce(sum(u.cached_tokens),0),coalesce(sum(u.input_tokens),0),
              coalesce(sum(u.output_tokens),0),count(u.cost),coalesce(sum(u.cost),0),
              {(groupColumn == "session_id" ? "max(u.agent)" : "NULL")}
            FROM buckets JOIN llm_usage u ON u.completed_at>=buckets.b0 AND u.completed_at<buckets.b1
            {(agent is null ? "" : "WHERE u.agent=$agent")}
            GROUP BY buckets.i,{key}
            """;
        if (agent is not null)
            Add(command, "$agent", agent);
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
                    reader.IsDBNull(8) ? null : reader.GetString(8)
                )
            );
        return cells;
    }

    internal async Task<LlmUsageCoverage> UsageCoverageAsync(CancellationToken token = default)
    {
        CheckOpen();
        await InitializeAsync(token).ConfigureAwait(false);
        using var connection = OpenReadOnly();
        var earliest = ReadScalar(connection, null, "SELECT min(completed_at) FROM llm_usage");
        var low = ReadScalar(
            connection,
            null,
            "SELECT value FROM llm_journal_metadata WHERE key=$key",
            ("$key", LowKey)
        );
        var complete =
            low is string text
            && long.TryParse(text, out var value)
            && (
                value <= 1
                || ReadScalar(
                    connection,
                    null,
                    "SELECT 1 FROM llm_journal_attempt_results WHERE rowid<$low AND outcome='success' LIMIT 1",
                    ("$low", value)
                )
                    is null
            );
        return new(earliest is long first ? first : null, complete);
    }
}
