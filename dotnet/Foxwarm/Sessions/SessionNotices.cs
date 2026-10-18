using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal static class SessionNotices
{
    internal static JsonObject Create(
        string source,
        string title,
        string summary,
        string details,
        string? id = null
    )
    {
        var notice = new JsonObject
        {
            ["version"] = 1,
            ["id"] = id ?? Guid.NewGuid().ToString(),
            ["source"] = source,
            ["severity"] = "error",
            ["title"] = SessionOwner.Bound(title, 100),
            ["summary"] = SessionOwner.Bound(summary, 300),
            ["details"] =
                details.Length > 32768 ? details[..32740] + "\n[Details truncated]" : details,
        };
        return new JsonObject
        {
            ["role"] = "model",
            ["modelVisible"] = false,
            ["parts"] = new JsonArray(
                new JsonObject { ["text"] = details.Length > 0 ? details : summary }
            ),
            ["__meta"] = new JsonObject
            {
                ["noticeType"] = "system-event",
                ["sessionNotice"] = notice,
            },
        };
    }
}

internal sealed partial class SessionOwner
{
    // Error identity is local to this exact owner. Do not mutate provider/IO exceptions or dedupe equal text.
    private readonly ConditionalWeakTable<Exception, object> presentedFailures = new();

    internal async Task PresentFailureAsync(
        Exception error,
        bool durable,
        string source = "session",
        string? operationId = null,
        bool applying = false
    )
    {
        if (
            error
            is OperationCanceledException
                or SessionTurnShutdownException
                or CompactionSnapshotIncompatibleException
        )
            return;
        for (Exception? cause = error; cause is not null; cause = cause.InnerException)
            if (presentedFailures.TryGetValue(cause, out _))
                return;
        if (
            error is ModelRequestException { TerminalNoticeDelivered: true }
            || Entry.WithState(state =>
            {
                var last = state.History.LastOrDefault()?.ToJson();
                return last?["modelVisible"]?.GetValue<bool>() == false
                    && SessionWait.Text(last["__meta"]?["noticeType"]) == "llm-retry"
                    && last["__meta"]?["retry"]?["final"]?.GetValue<bool>() == true;
            })
        )
        {
            presentedFailures.GetValue(error, _ => new object());
            return;
        }
        var message = SessionNotices.Create(
            source,
            source == "compaction" ? "Compaction failed" : "Run failed",
            source == "compaction"
                ? applying
                    ? "Could not apply the compaction result."
                    : "Could not prepare a compaction plan."
                : "The current run did not complete.",
            error.Message,
            operationId is null ? null : "compact:" + operationId
        );
        var appended = false;
        // Never send a second semantic append down the authority path whose failure is being presented.
        if (
            durable
            && Entry.IdentityAvailable
            && !Entry.HistoryMutation
            && !Entry.SaveLane.FailedOperation(error)
        )
        {
            try
            {
                await Entry.SaveLane.CommitCanonicalAppendAsync(state =>
                    LocalSessionTurnHost.PrepareCanonicalAppend(
                        state,
                        [message],
                        [],
                        false,
                        false,
                        () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    )
                );
                appended = true;
                Entry.InvokeCommitted(Entry.Snapshot());
            }
            catch (AuthorityCommittedException noticeError)
            {
                appended = true;
                Entry.RecordBestEffortFailure(noticeError);
                Entry.InvokeCommitted(Entry.Snapshot());
            }
            catch (Exception noticeError)
            {
                Entry.RecordBestEffortFailure(noticeError);
            }
        }
        if (!appended)
        {
            message["__meta"]!["temporary"] = true;
            Emit(SessionEventKind.MessageCommitted, message);
        }
        presentedFailures.GetValue(error, _ => new object());
    }
}
