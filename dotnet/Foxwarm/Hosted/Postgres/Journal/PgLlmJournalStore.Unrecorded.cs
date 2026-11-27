using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Persistence;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The tenant's journal off switch (<c>tenants.settings.journal.enabled: false</c>): requests
/// get an ID and are admitted as usual, but no request content is written: no manifest,
/// objects, attempt starts or results. The usage-ledger and redaction rows are still written,
/// from the start data this owner keeps while the request is live. The ID itself records the
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
    private sealed class Unrecorded(string? sessionId, string purpose, long touched)
    {
        internal readonly string? SessionId = sessionId;
        internal readonly string Purpose = purpose;
        internal long Touched = touched;
        internal readonly ConcurrentDictionary<int, (string Model, string? Virtual, string Type)> Starts = new();
    }

    private readonly ConcurrentDictionary<string, Unrecorded> unrecorded = new(StringComparer.Ordinal);

    // Admission order, for expiry of requests that ended without a success.
    private readonly ConcurrentQueue<(string Id, long Admitted)> unrecordedOrder = new();

    // A request that ends without a success (a final failure, a cancellation) has no closing
    // call; its start data is dropped an hour after its last attempt.
    private static readonly long UnrecordedIdleMs = (long)TimeSpan.FromHours(1).TotalMilliseconds;

    /// <summary>Whether request content is written (the tenant's journal setting).</summary>
    internal bool Recording { get; set; } = true;

    bool ILlmJournalStore.RecordsContent => Recording;

    /// <summary>Live unrecorded requests whose start data this owner keeps.</summary>
    internal int UnrecordedLiveCount => unrecorded.Count;

    internal static bool IsUnrecorded(string requestId) =>
        requestId.StartsWith(UnrecordedPrefix, StringComparison.Ordinal);

    private JournalRequestAdmission AdmitUnrecorded(string? sessionId, string purpose)
    {
        var now = Now();
        ExpireUnrecorded(now);
        var requestId = UnrecordedPrefix + Guid.NewGuid().ToString("N");
        unrecorded[requestId] = new Unrecorded(
            string.IsNullOrEmpty(sessionId) ? null : sessionId,
            purpose,
            now
        );
        unrecordedOrder.Enqueue((requestId, now));
        return new(requestId, Task.CompletedTask);
    }

    // Drops idle requests from the front of the admission order: each request is looked at
    // about once, so admission stays constant time.
    private void ExpireUnrecorded(long now)
    {
        while (unrecordedOrder.TryPeek(out var oldest) && now - oldest.Admitted >= UnrecordedIdleMs)
        {
            if (!unrecordedOrder.TryDequeue(out oldest))
                break;
            if (!unrecorded.TryGetValue(oldest.Id, out var entry))
                continue;
            if (now - Volatile.Read(ref entry.Touched) >= UnrecordedIdleMs)
                unrecorded.TryRemove(oldest.Id, out _);
            else
                unrecordedOrder.Enqueue((oldest.Id, Volatile.Read(ref entry.Touched)));
        }
    }

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
        Volatile.Write(ref entry.Touched, Now());
        entry.Starts[attempt] = (concreteModelId, virtualModelKey, providerType);
        return true;
    }

    // The result of an unrecorded request: only its ledger and redaction rows. A success ends
    // the request, any result ends its attempt.
    private async ValueTask<WriteReceipt<bool>?> CompleteUnrecordedAsync(
        string requestId,
        int attempt,
        string outcome,
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
        Volatile.Write(ref entry.Touched, Now());
        if (outcome == "success")
            unrecorded.TryRemove(requestId, out _);
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

    private static bool UnrecordedUsageLost(PgTx tx) => ReadMetadataNumber(tx, LostKey) is > 0;

    private static JsonObject NotRecordedAnswer(string requestId) =>
        new()
        {
            ["requestId"] = requestId,
            ["completeness"] = NotRecorded,
            ["reason"] = "The request journal was off for this request, so its content wasn't recorded.",
        };
}
