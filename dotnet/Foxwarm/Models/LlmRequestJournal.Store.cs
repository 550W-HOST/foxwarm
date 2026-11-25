using System.Text.Json.Nodes;
using Foxwarm.Persistence;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// The journal interface over this store's existing members.
public sealed partial class LlmRequestJournalStore : ILlmJournalStore
{
    event Action? ILlmJournalStore.UsageRecorded
    {
        add => UsageRecorded += value;
        remove => UsageRecorded -= value;
    }

    event Action? ILlmJournalStore.UsageLedgerFailed
    {
        add => UsageLedgerFailed += value;
        remove => UsageLedgerFailed -= value;
    }

    Task<string> ILlmJournalStore.BeginRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token
    ) =>
        BeginRequestAsync(
            sessionId,
            purpose,
            iteration,
            systemPrompt,
            toolDefinitions,
            messages,
            requestedModelKey,
            promptCacheKey,
            token
        );

    ValueTask<JournalRequestAdmission> ILlmJournalStore.EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token
    ) =>
        EnqueueRequestAsync(
            sessionId,
            purpose,
            iteration,
            systemPrompt,
            toolDefinitions,
            messages,
            requestedModelKey,
            promptCacheKey,
            token
        );

    ValueTask<JournalRequestAdmission> ILlmJournalStore.EnqueueRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        RequestHistory messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token
    ) =>
        EnqueueRequestAsync(
            sessionId,
            purpose,
            iteration,
            systemPrompt,
            toolDefinitions,
            messages,
            requestedModelKey,
            promptCacheKey,
            token
        );

    Task ILlmJournalStore.AppendAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token
    ) =>
        AppendAttemptStartAsync(
            requestId,
            attempt,
            concreteModelId,
            virtualModelKey,
            providerType,
            semanticPayload,
            effectivePrompt,
            token
        );

    ValueTask<WriteReceipt<bool>> ILlmJournalStore.EnqueueAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token
    ) =>
        EnqueueAttemptStartAsync(
            requestId,
            attempt,
            concreteModelId,
            virtualModelKey,
            providerType,
            semanticPayload,
            effectivePrompt,
            token
        );

    Task ILlmJournalStore.AppendAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token
    ) =>
        AppendAttemptResultAsync(
            requestId,
            attempt,
            outcome,
            result,
            error,
            token
        );

    ValueTask<WriteReceipt<bool>> ILlmJournalStore.EnqueueAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token,
        LlmRequestJournalStore.UsageRow? ledger,
        LlmRedactionRecord? redaction
    ) =>
        EnqueueAttemptResultAsync(
            requestId,
            attempt,
            outcome,
            result,
            error,
            token,
            ledger,
            redaction
        );

    Task ILlmJournalStore.AppendChatResultAsync(
        string requestId,
        int attempt,
        ChatResult result,
        CancellationToken token,
        LlmUsageAttribution? attribution,
        LlmRedactionRecord? redaction
    ) =>
        AppendChatResultAsync(
            requestId,
            attempt,
            result,
            token,
            attribution,
            redaction
        );

    Task<JsonObject> ILlmJournalStore.ReconstructAsync(
        string requestId,
        CancellationToken token
    ) =>
        ReconstructAsync(
            requestId,
            token
        );

    Task<JsonArray> ILlmJournalStore.ListAsync(
        string? sessionId,
        string? purpose,
        long? createdAt,
        string? requestId,
        int limit,
        CancellationToken token
    ) =>
        ListAsync(
            sessionId,
            purpose,
            createdAt,
            requestId,
            limit,
            token
        );

    Task ILlmJournalStore.BackfillUsageAsync(
        CancellationToken token,
        int batchSize
    ) =>
        BackfillUsageAsync(
            token,
            batchSize
        );

    IReadOnlyList<string> ILlmJournalStore.UsageSessions(
        long from,
        long to
    ) =>
        UsageSessions(
            from,
            to
        );

    IReadOnlyList<LlmUsageCell> ILlmJournalStore.QueryUsage(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession,
        IReadOnlyDictionary<string, long>? sessionStarts
    ) =>
        QueryUsage(
            boundaries,
            groupColumn,
            bySession,
            sessionStarts
        );

    LlmUsageCoverage ILlmJournalStore.UsageCoverage() =>
        UsageCoverage();

    Task<bool> ILlmJournalStore.AppendRedactionAsync(
        string requestId,
        int attempt,
        LlmRedactionRecord record,
        CancellationToken token
    ) =>
        AppendRedactionAsync(
            requestId,
            attempt,
            record,
            token
        );

    IReadOnlyList<string> ILlmJournalStore.RedactionSessions(
        long from,
        long to
    ) =>
        RedactionSessions(
            from,
            to
        );

    IReadOnlyList<LlmRedactionCell> ILlmJournalStore.QueryRedaction(
        IReadOnlyList<long> boundaries,
        string? groupColumn,
        bool bySession,
        IReadOnlyDictionary<string, long>? sessionStarts
    ) =>
        QueryRedaction(
            boundaries,
            groupColumn,
            bySession,
            sessionStarts
        );
}
