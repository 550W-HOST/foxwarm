using System.Text.Json.Nodes;
using Foxwarm.Persistence;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

/// <summary>
/// The LLM request journal: request manifests, attempts and results, the usage ledger and
/// text-redaction records, and the usage and redaction queries over them. Admission and
/// attempt writes return receipts that complete once durable. The file implementation is
/// <see cref="LlmRequestJournalStore"/>; legacy migration, SQLite authority markers and JSONL
/// export stay on it.
/// </summary>
internal interface ILlmJournalStore : IAsyncDisposable
{
    /// <summary>Raised after usage rows are recorded.</summary>
    event Action? UsageRecorded;

    /// <summary>Raised when the usage ledger fails to record a result.</summary>
    event Action? UsageLedgerFailed;

    /// <summary>
    /// Whether request and response content is recorded; the tenant's journal switch turns it
    /// off, and the wire diagnostics follow it.
    /// </summary>
    bool RecordsContent => true;

    Task<string> BeginRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    );

    ValueTask<JournalRequestAdmission> EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    );

    ValueTask<JournalRequestAdmission> EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        RequestHistory messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    );

    Task AppendAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token = default
    );

    ValueTask<WriteReceipt<bool>> EnqueueAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token = default
    );

    Task AppendAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token = default
    );

    ValueTask<WriteReceipt<bool>> EnqueueAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token = default,
        LlmRequestJournalStore.UsageRow? ledger = null,
        LlmRedactionRecord? redaction = null
    );

    Task AppendChatResultAsync(
        string requestId,
        int attempt,
        ChatResult result,
        CancellationToken token = default,
        LlmUsageAttribution? attribution = null,
        LlmRedactionRecord? redaction = null
    );

    Task<JsonObject> ReconstructAsync(
        string requestId,
        CancellationToken token = default
    );

    Task<JsonArray> ListAsync(
        string? sessionId,
        string? purpose,
        long? createdAt,
        string? requestId,
        int limit,
        CancellationToken token = default
    );

    Task BackfillUsageAsync(
        CancellationToken token,
        int batchSize = LlmRequestJournalStore.UsageBackfillBatch
    );

    IReadOnlyList<string> UsageSessions(long from, long to);

    IReadOnlyList<LlmUsageCell> QueryUsage(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession = false,
        IReadOnlyDictionary<string, long>? sessionStarts = null
    );

    LlmUsageCoverage UsageCoverage();

    Task<bool> AppendRedactionAsync(
        string requestId,
        int attempt,
        LlmRedactionRecord record,
        CancellationToken token = default
    );

    IReadOnlyList<string> RedactionSessions(long from, long to);

    IReadOnlyList<LlmRedactionCell> QueryRedaction(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession = false,
        IReadOnlyDictionary<string, long>? sessionStarts = null
    );
}
