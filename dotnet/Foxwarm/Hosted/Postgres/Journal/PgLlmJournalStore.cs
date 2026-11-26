using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Persistence;
using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's LLM request journal in PostgreSQL. Values, validation and the delta manifest
/// rules are shared with the file journal (<see cref="LlmRequestJournalStore"/>,
/// <see cref="LlmJournalReconstruction"/>), so both store and reconstruct the same requests.
/// Writes go through one <see cref="PgJournalWriter"/> lane with the file writer's batching and
/// per-command failure semantics; reads run on their own connections and never wait for it.
/// Objects are deduplicated per tenant. Legacy JSONL migration and export are file-only.
/// </summary>
internal sealed partial class PgLlmJournalStore : ILlmJournalStore
{
    private readonly TenantDb database;
    private readonly TimeProvider clock;
    private bool disposed;

    internal PgLlmJournalStore(TenantDb database, TimeProvider? clock = null)
    {
        this.database = database;
        this.clock = clock ?? TimeProvider.System;
        Writer = new PgJournalWriter(database);
    }

    internal PgJournalWriter Writer { get; }

    public event Action? UsageRecorded;

    public event Action? UsageLedgerFailed;

    private void CheckOpen() => ObjectDisposedException.ThrowIf(disposed, this);

    private long Now() => clock.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<string> BeginRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    )
    {
        var admission = await EnqueueRequestAsync(
                sessionId,
                purpose,
                iteration,
                systemPrompt,
                toolDefinitions,
                messages,
                requestedModelKey,
                promptCacheKey,
                token
            )
            .ConfigureAwait(false);
        await admission.Completion.ConfigureAwait(false);
        return admission.RequestId;
    }

    public ValueTask<JournalRequestAdmission> EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    )
    {
        CheckOpen();
        token.ThrowIfCancellationRequested();
        return EnqueueRequestAsync(
            sessionId,
            purpose,
            iteration,
            systemPrompt,
            toolDefinitions,
            RequestHistory.FromMutable(messages),
            requestedModelKey,
            promptCacheKey,
            token
        );
    }

    public async ValueTask<JournalRequestAdmission> EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        RequestHistory messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    )
    {
        CheckOpen();
        token.ThrowIfCancellationRequested();
        var requestId = Guid.NewGuid().ToString();
        // Consume request-owned JSON before admission; only immutable encoded values cross the queue.
        var prompt = LlmRequestJournalStore.PrepareObject("prompt", JsonValue.Create(systemPrompt)!);
        var tools = LlmRequestJournalStore.PrepareObject("tool-schema", toolDefinitions);
        var preparedMessages = LlmRequestJournalStore.PrepareMessages(messages);
        var messageIds = preparedMessages.Select(message => message.Id).ToArray();
        var cacheHash = LlmRequestJournalStore.Sha256(promptCacheKey);
        var receipt = await Writer
            .EnqueueAsync(
                tx =>
                {
                    var created = Now();
                    PutObjects(tx, [prompt, tools, .. preparedMessages], created);
                    var rows = new PgRows(tx);
                    var plan = LlmJournalReconstruction.PlanDelta(
                        rows,
                        string.IsNullOrEmpty(sessionId) ? null : ReadLatestRequest(tx, sessionId!),
                        messageIds
                    );
                    tx.Execute(
                        """
                        INSERT INTO llm_journal_requests(
                            request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,
                            requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,
                            base_request_id,common_prefix_length,appended_message_ids_json,delta_depth
                        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                        """,
                        requestId,
                        sessionId,
                        purpose,
                        (long)iteration,
                        created,
                        prompt.Id,
                        tools.Id,
                        requestedModelKey,
                        cacheHash,
                        (long)messageIds.Length,
                        plan.CheckpointJson,
                        plan.BaseRequestId,
                        plan.CommonPrefixLength is int prefix ? (long)prefix : null,
                        plan.AppendedJson,
                        (long)plan.DeltaDepth
                    );
                    // What this manifest names itself; a delta's prefix stays named by its base.
                    var listed = plan.BaseRequestId is null
                        ? messageIds
                        : messageIds[(plan.CommonPrefixLength ?? 0)..];
                    tx.Execute(
                        "INSERT INTO llm_journal_request_objects(request_id,object_id)"
                            + " SELECT $1, o FROM unnest($2::text[]) AS o ON CONFLICT DO NOTHING",
                        requestId,
                        new[] { prompt.Id, tools.Id }.Concat(listed).Distinct(StringComparer.Ordinal).ToArray()
                    );
                    return true;
                },
                token
            )
            .ConfigureAwait(false);
        return new(requestId, receipt.Completion);
    }

    /// <summary>
    /// Inserts the objects that don't exist yet. Only new payloads cross the network; objects
    /// are deduplicated per tenant.
    /// </summary>
    private static void PutObjects(
        PgTx tx,
        IReadOnlyList<LlmRequestJournalStore.PreparedObject> objects,
        long created
    )
    {
        var ids = objects.Select(item => item.Id).Distinct(StringComparer.Ordinal).ToArray();
        var existing = new HashSet<string>(StringComparer.Ordinal);
        using (var command = tx.Command(
            "SELECT object_id FROM llm_journal_objects WHERE object_id = ANY($1::text[])",
            [ids]
        ))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                existing.Add(reader.GetString(0));
        var missing = new Dictionary<string, LlmRequestJournalStore.PreparedObject>(StringComparer.Ordinal);
        foreach (var item in objects)
            if (!existing.Contains(item.Id))
                missing.TryAdd(item.Id, item);
        if (missing.Count == 0)
            return;
        tx.Execute(
            "INSERT INTO llm_journal_objects(object_id,object_kind,payload,created_at)"
                + " SELECT i, k, p, $4 FROM unnest($1::text[], $2::text[], $3::text[]) AS t(i, k, p)"
                + " ON CONFLICT DO NOTHING",
            missing.Values.Select(item => item.Id).ToArray(),
            missing.Values.Select(item => item.Kind).ToArray(),
            missing.Values.Select(item => item.Payload).ToArray(),
            created
        );
    }

    private static (string RequestId, int Depth)? ReadLatestRequest(PgTx tx, string sessionId)
    {
        using var command = tx.Command(
            "SELECT request_id,delta_depth FROM llm_journal_requests WHERE session_id=$1"
                + " ORDER BY created_at DESC,seq DESC LIMIT 1",
            sessionId
        );
        using var reader = command.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), checked((int)reader.GetInt64(1))) : null;
    }

    public async Task AppendAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token = default
    )
    {
        var receipt = await EnqueueAttemptStartAsync(
                requestId,
                attempt,
                concreteModelId,
                virtualModelKey,
                providerType,
                semanticPayload,
                effectivePrompt,
                token
            )
            .ConfigureAwait(false);
        await receipt.Completion.ConfigureAwait(false);
    }

    public async ValueTask<WriteReceipt<bool>> EnqueueAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token = default
    )
    {
        CheckOpen();
        token.ThrowIfCancellationRequested();
        var prompt = LlmRequestJournalStore.PrepareObject("prompt", JsonValue.Create(effectivePrompt)!);
        var payloadHash = LlmRequestJournalStore.HashValue(semanticPayload);
        return await Writer
            .EnqueueAsync(
                tx =>
                {
                    var promptId =
                        tx.Scalar(
                            "SELECT prompt_object_id FROM llm_journal_requests WHERE request_id=$1",
                            requestId
                        ) as string
                        ?? throw new InvalidDataException(
                            "LLM journal request is missing before attempt start."
                        );
                    string? overrideId = null;
                    if (attempt == 1 && prompt.Id != promptId)
                        throw new InvalidDataException(
                            "First LLM journal attempt must use the request prompt."
                        );
                    var started = Now();
                    if (prompt.Id != promptId)
                    {
                        PutObjects(tx, [prompt], started);
                        overrideId = prompt.Id;
                    }
                    tx.Execute(
                        "INSERT INTO llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                        Guid.NewGuid().ToString(),
                        requestId,
                        (long)attempt,
                        started,
                        concreteModelId,
                        virtualModelKey,
                        providerType,
                        payloadHash,
                        overrideId
                    );
                    return true;
                },
                token
            )
            .ConfigureAwait(false);
    }

    public async Task AppendAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token = default
    )
    {
        var receipt = await EnqueueAttemptResultAsync(
                requestId,
                attempt,
                outcome,
                result,
                error,
                token
            )
            .ConfigureAwait(false);
        await receipt.Completion.ConfigureAwait(false);
    }

    public async ValueTask<WriteReceipt<bool>> EnqueueAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token = default,
        LlmRequestJournalStore.UsageRow? ledger = null,
        LlmRedactionRecord? redaction = null
    )
    {
        CheckOpen();
        token.ThrowIfCancellationRequested();
        var resultJson = result is null ? null : LlmRequestJournalStore.Codec.Write(result);
        var errorJson = error is null ? null : LlmRequestJournalStore.Codec.Write(error);
        return await Writer
            .EnqueueAsync(
                tx =>
                {
                    (string Model, string? Virtual, string Type) start;
                    using (var lookup = tx.Command(
                        "SELECT concrete_model_id,virtual_model_key,provider_type FROM llm_journal_attempt_starts"
                            + " WHERE request_id=$1 AND attempt=$2 ORDER BY seq DESC LIMIT 1",
                        requestId,
                        (long)attempt
                    ))
                    using (var found = lookup.ExecuteReader())
                    {
                        if (!found.Read())
                            throw new InvalidDataException(
                                "LLM journal attempt is missing before its result."
                            );
                        start = (
                            found.GetString(0),
                            found.IsDBNull(1) ? null : found.GetString(1),
                            found.GetString(2)
                        );
                    }
                    var completedAt = Now();
                    var seq = (long)tx.Scalar(
                        "INSERT INTO llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json)"
                            + " VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING seq",
                        Guid.NewGuid().ToString(),
                        requestId,
                        (long)attempt,
                        completedAt,
                        outcome,
                        resultJson,
                        errorJson
                    )!;
                    // A success written without its ledger row stays outside the covered range
                    // so the backfill adds it; anything else is covered as soon as it commits.
                    var recorded = ledger is null
                        ? outcome != "success"
                        : TryRecordLiveUsage(tx, requestId, attempt, completedAt, start, ledger);
                    if (recorded)
                        AdvanceUsageHigh(tx, seq);
                    if (redaction is not null)
                        TryRecordRedaction(tx, requestId, attempt, completedAt, redaction);
                    return ledger is null || recorded;
                },
                token
            )
            .ConfigureAwait(false);
    }

    public async Task AppendChatResultAsync(
        string requestId,
        int attempt,
        ChatResult result,
        CancellationToken token = default,
        LlmUsageAttribution? attribution = null,
        LlmRedactionRecord? redaction = null
    )
    {
        var ledger = LlmRequestJournalStore.PrepareUsageRow(result, attribution);
        var receipt = await EnqueueAttemptResultAsync(
                requestId,
                attempt,
                "success",
                LlmRequestJournalStore.ToSourceResult(result),
                null,
                token,
                ledger,
                redaction
            )
            .ConfigureAwait(false);
        if (await receipt.Completion.ConfigureAwait(false))
            Raise(UsageRecorded);
        else
            Raise(UsageLedgerFailed);
    }

    public async Task<JsonObject> ReconstructAsync(
        string requestId,
        CancellationToken token = default
    )
    {
        CheckOpen();
        await Writer.BarrierAsync(token).ConfigureAwait(false);
        try
        {
            return database.Read(
                tx => LlmJournalReconstruction.Reconstruct(new PgRows(tx), requestId),
                snapshot: true
            );
        }
        // As in the file journal, an inconsistent request is reported rather than thrown; an
        // unavailable database still fails the call.
        catch (Exception error)
            when (error is not (NpgsqlException or IOException or TenantFencedException or OperationCanceledException))
        {
            return new JsonObject
            {
                ["requestId"] = requestId,
                ["completeness"] = "corrupt",
                ["errors"] = new JsonArray(error.Message),
            };
        }
    }

    public async Task<JsonArray> ListAsync(
        string? sessionId,
        string? purpose,
        long? createdAt,
        string? requestId,
        int limit,
        CancellationToken token = default
    )
    {
        CheckOpen();
        await Writer.BarrierAsync(token).ConfigureAwait(false);
        return database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT request_id,session_id,purpose,iteration,created_at,requested_model_key,message_count FROM llm_journal_requests"
                    + " WHERE ($1::text IS NULL OR session_id=$1) AND ($2::text IS NULL OR purpose=$2)"
                    + " AND ($3::bigint IS NULL OR created_at<$3 OR (created_at=$3 AND request_id<$4))"
                    + " ORDER BY created_at DESC,request_id DESC LIMIT $5",
                sessionId,
                purpose,
                createdAt,
                requestId ?? "~",
                (long)Math.Clamp(limit, 1, 1000)
            );
            using var reader = command.ExecuteReader();
            var result = new JsonArray();
            while (reader.Read())
                result.Add(
                    new JsonObject
                    {
                        ["requestId"] = reader.GetString(0),
                        ["sessionId"] = reader.IsDBNull(1) ? null : reader.GetString(1),
                        ["purpose"] = reader.GetString(2),
                        ["iteration"] = checked((int)reader.GetInt64(3)),
                        ["createdAt"] = reader.GetInt64(4),
                        ["requestedModelKey"] = reader.GetString(5),
                        ["messageCount"] = checked((int)reader.GetInt64(6)),
                    }
                );
            return result;
        });
    }

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

    // A failure of an optional row (ledger, redaction statistics) rolls back only that row;
    // fences and broken connections still end the batch.
    private static bool OptionalRowFailure(Exception error) =>
        error is PostgresException && !PgJournalWriter.AbortsBatch(error);

    public async ValueTask DisposeAsync()
    {
        if (disposed)
            return;
        disposed = true;
        await StopRetentionAsync().ConfigureAwait(false);
        await Writer.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// The reconstruction queries in one PostgreSQL transaction. Manifests are immutable, so a
    /// manifest chain is read once with its ancestors and kept for the transaction.
    /// </summary>
    private sealed class PgRows(PgTx tx) : ILlmJournalRows
    {
        private readonly Dictionary<string, LlmJournalManifest> manifests = new(StringComparer.Ordinal);

        public LlmJournalManifest? Manifest(string requestId)
        {
            if (manifests.TryGetValue(requestId, out var cached))
                return cached;
            using var command = tx.Command(
                """
                WITH RECURSIVE chain(request_id, base_request_id, hops) AS (
                    SELECT request_id, base_request_id, 0 FROM llm_journal_requests WHERE request_id=$1
                    UNION ALL
                    SELECT r.request_id, r.base_request_id, c.hops + 1
                    FROM chain c JOIN llm_journal_requests r ON r.request_id = c.base_request_id
                    WHERE c.hops < $2
                )
                SELECT r.request_id,r.checkpoint_message_ids_json,r.base_request_id,r.common_prefix_length,
                  r.appended_message_ids_json,r.delta_depth
                FROM chain c JOIN llm_journal_requests r ON r.request_id = c.request_id
                """,
                requestId,
                LlmJournalReconstruction.MaxDeltaDepth + 1
            );
            using var reader = command.ExecuteReader();
            while (reader.Read())
                manifests.TryAdd(
                    reader.GetString(0),
                    new(
                        reader.IsDBNull(1) ? null : reader.GetString(1),
                        reader.IsDBNull(2) ? null : reader.GetString(2),
                        reader.IsDBNull(3) ? null : checked((int)reader.GetInt64(3)),
                        reader.IsDBNull(4) ? null : reader.GetString(4),
                        checked((int)reader.GetInt64(5))
                    )
                );
            return manifests.GetValueOrDefault(requestId);
        }

        public LlmJournalHeader? Header(string requestId)
        {
            using var command = tx.Command(
                "SELECT session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count FROM llm_journal_requests WHERE request_id=$1",
                requestId
            );
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                return null;
            return new(
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.GetString(1),
                checked((int)reader.GetInt64(2)),
                reader.GetInt64(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.GetString(7),
                checked((int)reader.GetInt64(8))
            );
        }

        public IReadOnlyList<LlmJournalStartRow> Starts(string requestId)
        {
            using var command = tx.Command(
                "SELECT event_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id FROM llm_journal_attempt_starts WHERE request_id=$1 ORDER BY attempt,started_at,seq",
                requestId
            );
            using var reader = command.ExecuteReader();
            var rows = new List<LlmJournalStartRow>();
            while (reader.Read())
                rows.Add(
                    new(
                        reader.GetString(0),
                        checked((int)reader.GetInt64(1)),
                        reader.GetInt64(2),
                        reader.GetString(3),
                        reader.IsDBNull(4) ? null : reader.GetString(4),
                        reader.GetString(5),
                        reader.GetString(6),
                        reader.IsDBNull(7) ? null : reader.GetString(7)
                    )
                );
            return rows;
        }

        public LlmJournalResultRow? LatestResult(string requestId, int attempt)
        {
            using var command = tx.Command(
                "SELECT event_id,outcome,result_json,error_json,completed_at FROM llm_journal_attempt_results WHERE request_id=$1 AND attempt=$2 ORDER BY completed_at DESC,seq DESC LIMIT 1",
                requestId,
                (long)attempt
            );
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                return null;
            return new(
                reader.GetString(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.GetInt64(4)
            );
        }

        public IReadOnlyList<(int Attempt, string Outcome)> Outcomes(string requestId)
        {
            using var command = tx.Command(
                "SELECT attempt,outcome FROM llm_journal_attempt_results WHERE request_id=$1",
                requestId
            );
            using var reader = command.ExecuteReader();
            var rows = new List<(int, string)>();
            while (reader.Read())
                rows.Add((checked((int)reader.GetInt64(0)), reader.GetString(1)));
            return rows;
        }

        public (string Kind, string Payload)? Object(string objectId)
        {
            using var command = tx.Command(
                "SELECT object_kind,payload FROM llm_journal_objects WHERE object_id=$1",
                objectId
            );
            using var reader = command.ExecuteReader();
            return reader.Read() ? (reader.GetString(0), reader.GetString(1)) : null;
        }
    }
}
