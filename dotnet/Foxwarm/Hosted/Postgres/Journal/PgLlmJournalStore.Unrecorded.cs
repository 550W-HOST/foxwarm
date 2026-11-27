using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Persistence;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's journal off switch (<c>tenants.settings.journal.enabled: false</c>): requests
/// get an ID and are admitted as usual, but no request content is written: no manifest,
/// objects, attempt starts or results. The usage-ledger and redaction rows are still written,
/// from the start data this owner keeps in memory, so the usage overview and its coverage stay
/// complete. Reconstruction reports such a request as not recorded. Requests recorded before
/// the switch keep their content and retention.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    // Requests admitted while the journal was off: what their ledger rows need.
    private sealed class Unrecorded(string? sessionId, string purpose, long admittedAt)
    {
        internal readonly string? SessionId = sessionId;
        internal readonly string Purpose = purpose;
        internal readonly long AdmittedAt = admittedAt;
        internal readonly ConcurrentDictionary<int, (string Model, string? Virtual, string Type)> Starts = new();
    }

    private readonly ConcurrentDictionary<string, Unrecorded> unrecorded = new(StringComparer.Ordinal);

    // An unrecorded request's start data is kept for a day: longer than any request's attempts.
    private static readonly TimeSpan UnrecordedLifetime = TimeSpan.FromDays(1);

    /// <summary>Whether request content is written (the tenant's journal setting).</summary>
    internal bool Recording { get; set; } = true;

    /// <summary>The reconstruction answer for a request whose content wasn't recorded.</summary>
    internal const string NotRecorded = "not-recorded";

    private JournalRequestAdmission AdmitUnrecorded(string? sessionId, string purpose)
    {
        var now = Now();
        var cutoff = now - (long)UnrecordedLifetime.TotalMilliseconds;
        foreach (var (id, entry) in unrecorded)
            if (entry.AdmittedAt < cutoff)
                unrecorded.TryRemove(id, out _);
        var requestId = Guid.NewGuid().ToString();
        unrecorded[requestId] = new Unrecorded(
            string.IsNullOrEmpty(sessionId) ? null : sessionId,
            purpose,
            now
        );
        return new(requestId, Task.CompletedTask);
    }

    private bool StartUnrecorded(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType
    )
    {
        if (!unrecorded.TryGetValue(requestId, out var entry))
            return false;
        entry.Starts[attempt] = (concreteModelId, virtualModelKey, providerType);
        return true;
    }

    // The result of an unrecorded request: only its ledger and redaction rows.
    private async ValueTask<WriteReceipt<bool>?> CompleteUnrecordedAsync(
        string requestId,
        int attempt,
        string outcome,
        LlmRequestJournalStore.UsageRow? ledger,
        LlmRedactionRecord? redaction,
        CancellationToken token
    )
    {
        if (!unrecorded.TryGetValue(requestId, out var entry))
            return null;
        if (!entry.Starts.TryGetValue(attempt, out var start))
            throw new InvalidDataException("LLM journal attempt is missing before its result.");
        return await Writer
            .EnqueueAsync(
                tx =>
                {
                    var completedAt = Now();
                    var recorded = ledger is null
                        ? outcome != "success"
                        : TryRecordUnrecordedUsage(tx, requestId, attempt, completedAt, entry, start, ledger);
                    if (redaction is not null)
                        TryRecordRedaction(tx, requestId, attempt, completedAt, redaction);
                    return ledger is null || recorded;
                },
                token
            )
            .ConfigureAwait(false);
    }

    private static bool TryRecordUnrecordedUsage(
        PgTx tx,
        string requestId,
        int attempt,
        long completedAt,
        Unrecorded entry,
        (string Model, string? Virtual, string Type) start,
        LlmRequestJournalStore.UsageRow usage
    )
    {
        tx.Execute("SAVEPOINT llm_usage_row");
        try
        {
            InsertUsage(
                tx,
                [
                    new(
                        requestId,
                        attempt,
                        completedAt,
                        entry.SessionId,
                        entry.Purpose,
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

    // Reconstruction of a request this owner admitted unrecorded, or that no row knows while
    // the journal is off.
    private JsonObject? NotRecordedAnswer(string requestId, bool known) =>
        unrecorded.ContainsKey(requestId) || !Recording && !known
            ? new JsonObject
            {
                ["requestId"] = requestId,
                ["completeness"] = NotRecorded,
                ["reason"] = "The request journal was off for this request; its content wasn't recorded.",
            }
            : null;
}
