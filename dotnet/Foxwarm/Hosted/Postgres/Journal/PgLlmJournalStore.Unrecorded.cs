using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Persistence;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's journal off switch (<c>tenants.settings.journal.enabled: false</c>): requests
/// get an ID and are admitted as usual, but no request content is written: no manifest,
/// objects, attempt starts or results. The usage-ledger and redaction rows are still written,
/// from the start data this owner keeps from admission until the request's owner ends it
/// (<see cref="ILlmJournalStore.EndRequest"/>); an attempt in progress never expires. The ID itself records the
/// disposition (<see cref="UnrecordedPrefix"/>), so reconstruction reports such a request as
/// not recorded on any later owner, whether recording is on or off by then. Requests recorded
/// before the switch keep their content and retention.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    /// <summary>The ID prefix of requests admitted unrecorded; recorded IDs are plain GUIDs.</summary>
    internal const string UnrecordedPrefix = "unrecorded-";

    /// <summary>The reconstruction answer for a request whose content wasn't recorded.</summary>
    internal const string NotRecorded = "not-recorded";

    // Usage rows of unrecorded requests that couldn't be written; the coverage reports them.
    private const string LostKey = "usage-unrecorded-lost";

    // A live unrecorded request: what its ledger rows need.
    private sealed class Unrecorded(string? sessionId, string purpose)
    {
        internal readonly string? SessionId = sessionId;
        internal readonly string Purpose = purpose;
        internal readonly ConcurrentDictionary<int, (string Model, string? Virtual, string Type)> Starts = new();
    }

    private readonly ConcurrentDictionary<string, Unrecorded> unrecorded = new(StringComparer.Ordinal);

    /// <summary>Whether request content is written (the tenant's journal setting).</summary>
    internal bool Recording { get; set; } = true;

    Func<bool> ILlmJournalStore.RecordingPolicy => () => Recording;

    /// <summary>Live unrecorded requests whose start data this owner keeps.</summary>
    internal int UnrecordedLiveCount => unrecorded.Count;

    // Exactly the issued form: the prefix and a GUID's 32 lowercase hex digits.
    internal static bool IsUnrecorded(string requestId) =>
        requestId.Length == UnrecordedPrefix.Length + 32
        && requestId.StartsWith(UnrecordedPrefix, StringComparison.Ordinal)
        && requestId.AsSpan(UnrecordedPrefix.Length).IndexOfAnyExcept("0123456789abcdef") < 0;

    private JournalRequestAdmission AdmitUnrecorded(string? sessionId, string purpose)
    {
        var requestId = UnrecordedPrefix + Guid.NewGuid().ToString("N");
        unrecorded[requestId] = new Unrecorded(string.IsNullOrEmpty(sessionId) ? null : sessionId, purpose);
        return new(requestId, Task.CompletedTask);
    }

    // The request's owner is done with it: its start data goes.
    void ILlmJournalStore.EndRequest(string requestId) => unrecorded.TryRemove(requestId, out _);

    private bool StartUnrecorded(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType
    )
    {
        if (!IsUnrecorded(requestId))
            return false;
        if (!unrecorded.TryGetValue(requestId, out var entry))
            throw new InvalidDataException("LLM journal request is missing before attempt start.");
        entry.Starts[attempt] = (concreteModelId, virtualModelKey, providerType);
        return true;
    }

    // The result of an unrecorded request: only its ledger and redaction rows. Any result ends
    // its attempt; the owner ends the request.
    private async ValueTask<WriteReceipt<bool>?> CompleteUnrecordedAsync(
        string requestId,
        int attempt,
        LlmRequestJournalStore.UsageRow? ledger,
        LlmRedactionRecord? redaction,
        CancellationToken token
    )
    {
        if (!IsUnrecorded(requestId))
            return null;
        if (
            !unrecorded.TryGetValue(requestId, out var entry)
            || !entry.Starts.TryRemove(attempt, out var start)
        )
            throw new InvalidDataException("LLM journal attempt is missing before its result.");
        return await Writer
            .EnqueueAsync(
                tx =>
                {
                    var completedAt = Now();
                    var recorded = ledger is null
                        || TryRecordUnrecordedUsage(tx, requestId, attempt, completedAt, entry, start, ledger);
                    if (redaction is not null)
                        TryRecordRedaction(tx, requestId, attempt, completedAt, redaction);
                    return recorded;
                },
                token
            )
            .ConfigureAwait(false);
    }

    // Without a result row the backfill can't repair a missing ledger row, so a failed one is
    // counted durably and the usage coverage reports it as incomplete.
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
            if (InsertUsageForTest is { } hook)
                hook();
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
            tx.Execute(
                "INSERT INTO llm_journal_metadata(key,value) VALUES($1,'1') ON CONFLICT(tenant_id,key)"
                    + " DO UPDATE SET value=(CAST(llm_journal_metadata.value AS bigint)+1)::text",
                LostKey
            );
            return false;
        }
    }

    // A test makes the next unrecorded usage insert fail as a database rejection would.
    internal static Action? InsertUsageForTest { get; set; }

    private static JsonObject NotRecordedAnswer(string requestId) =>
        new()
        {
            ["requestId"] = requestId,
            ["completeness"] = NotRecorded,
            ["reason"] = "The request journal was off for this request, so its content wasn't recorded.",
        };
}
