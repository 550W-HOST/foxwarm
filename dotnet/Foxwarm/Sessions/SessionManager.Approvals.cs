using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Where a waiting call came from: a model turn, a ToolScript run, a timer slice or the Claude
// Code runtime. Unattended slices always get a finite deadline.
internal sealed record ToolApprovalOrigin(string Kind, string? ToolCallId, string? RunId);

internal sealed record PendingToolApproval(
    string Id,
    string Fingerprint,
    long? TimeoutSeconds,
    ToolApprovalWaiters.Waiter Waiter,
    ResolvedTool Resolved
);

internal sealed class ToolApprovalNotPendingException(string message)
    : InvalidOperationException(message);

internal sealed partial class SessionManager
{
    /// <summary>
    /// Records a pending approval for a call that matched an ask rule and registers its live
    /// waiter. The record is committed before anyone can see or decide it.
    /// </summary>
    internal async Task<PendingToolApproval> BeginToolApprovalAsync(
        SessionOwner owner,
        ToolApprovalRequiredException required,
        ToolApprovalOrigin origin,
        bool unattended
    )
    {
        var assessment = required.Assessment;
        var resolved = required.Resolved;
        var options = assessment.Approval;
        var timeout =
            options.TimeoutSeconds
            ?? (unattended ? SessionApprovals.UnattendedTimeoutSeconds : null);
        var id = SessionApprovals.NewId();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var tool = new JsonObject
        {
            ["source"] = resolved.Source,
            ["name"] = resolved.Name,
            ["server"] = resolved.Server,
            ["executionNode"] = resolved.ExecutionNode,
        };
        if (resolved.InvocationName != resolved.Name)
            tool["invocationName"] = resolved.InvocationName;
        var record = new JsonObject
        {
            ["id"] = id,
            ["status"] = "pending",
            ["createdAt"] = now,
            ["origin"] = origin.Kind,
            ["tool"] = tool,
            ["summary"] = SessionToolExecutor.ToolArgsPreview(resolved.Name, resolved.Args),
        };
        if (timeout is long seconds)
        {
            record["timeoutSeconds"] = seconds;
            record["expiresAt"] = now + seconds * 1000;
        }
        if (!string.IsNullOrEmpty(origin.ToolCallId))
            record["toolCallId"] = origin.ToolCallId;
        if (!string.IsNullOrEmpty(origin.RunId))
            record["runId"] = origin.RunId;
        var args = resolved.Args.ToJsonString();
        if (Encoding.UTF8.GetByteCount(args) <= SessionApprovals.MaxArgsBytes)
            record["args"] = resolved.Args.DeepClone();
        else
        {
            // The live waiter keeps the full arguments for approvers while the record is pending.
            record["argsPreview"] =
                args.Length > SessionApprovals.MaxArgsPreviewLength
                    ? args[..SessionApprovals.MaxArgsPreviewLength]
                    : args;
            record["argsTruncated"] = true;
        }
        var facts = ToolAuthorizationExplain.Facts(assessment.Request);
        var recordFacts = new JsonObject();
        foreach (var key in new[] { "paths", "nodeTargets", "sessionTarget" })
            if (facts[key] is { } fact)
                recordFacts[key] = fact.DeepClone();
        record["facts"] = recordFacts;
        record["rules"] = new JsonArray(
            assessment
                .Asking.Select(layer =>
                {
                    var rule = new JsonObject
                    {
                        ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
                        ["id"] = SessionWait.Text(layer.Decision.Rule?["id"]) ?? "defaultAction",
                    };
                    if (SessionWait.Text(layer.Decision.Rule?["reason"]) is { } reason)
                        rule["reason"] = reason;
                    return (JsonNode?)rule;
                })
                .ToArray()
        );
        record["approvers"] = new JsonArray(
            options.Approvers.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
        );
        var waiter = owner.ApprovalWaiters.Register(id, (JsonObject)resolved.Args.DeepClone());
        int? full = null;
        string? committed;
        try
        {
            committed = await owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
            {
                var pending = SessionApprovals.Pending(meta).Length;
                if (pending >= SessionApprovals.MaxPending)
                {
                    full = pending;
                    return null;
                }
                SessionApprovals.Add(meta, record);
                return id;
            });
        }
        catch
        {
            owner.ApprovalWaiters.Remove(id);
            throw;
        }
        if (committed is null)
        {
            owner.ApprovalWaiters.Remove(id);
            if (full is int count)
                throw new ToolApprovalOutcomeException(
                    "tool_approval_unavailable",
                    $"This Session already has {count} tool calls waiting for approval. This call was not executed."
                );
            throw new InvalidOperationException(
                "The Session is stopping; the call was not started."
            );
        }
        // External channels cannot decide; they only learn that the WebUI has a request.
        BroadcastTransientText(
            owner,
            $"A tool call is waiting for approval in the WebUI: `{resolved.Name}` — {SessionWait.Text(record["summary"])}"
        );
        return new(
            id,
            ToolApprovalScope.Fingerprint(resolved, assessment.Request),
            timeout,
            waiter,
            resolved
        );
    }

    /// <summary>
    /// Waits for the decision of a pending approval, its deadline or cancellation, and returns
    /// the final record. Deadline and cancellation take the same first-wins transition as a
    /// decision, so a racing decision has exactly one outcome.
    /// </summary>
    internal async Task<JsonObject> AwaitToolApprovalAsync(
        SessionOwner owner,
        PendingToolApproval pending,
        CancellationToken token
    )
    {
        try
        {
            try
            {
                return pending.TimeoutSeconds is long seconds
                    ? await pending
                        .Waiter.Decision.Task.WaitAsync(TimeSpan.FromSeconds(seconds), token)
                        .ConfigureAwait(false)
                    : await pending.Waiter.Decision.Task.WaitAsync(token).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                return await SettleToolApprovalAsync(owner, pending.Id, "expired", "timeout")
                    ?? throw new InvalidOperationException(
                        "The Session is stopping; the call was not started."
                    );
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                try
                {
                    await SettleToolApprovalAsync(
                        owner,
                        pending.Id,
                        "cancelled",
                        owner.Registry.Runner.Closing ? "shutdown" : "stop"
                    );
                }
                catch (Exception error)
                    when (error
                            is InvalidOperationException
                                or IOException
                                or ObjectDisposedException
                    )
                {
                    // A record left pending here is expired when the Session is next loaded.
                }
                throw;
            }
        }
        finally
        {
            owner.ApprovalWaiters.Remove(pending.Id);
        }
    }

    private async Task<JsonObject?> SettleToolApprovalAsync(
        SessionOwner owner,
        string id,
        string status,
        string reason
    )
    {
        JsonObject? final = null;
        await owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
        {
            SessionApprovals.Resolve(
                meta,
                id,
                status,
                new JsonObject { ["kind"] = "system", ["reason"] = reason }
            );
            final = SessionApprovals.Find(meta, id)?.DeepClone() as JsonObject;
            return final is null ? null : id;
        });
        return final;
    }

    /// <summary>
    /// Records an approver's decision and releases the waiting call. The first committed
    /// transition wins; a later decision fails as no longer pending.
    /// </summary>
    internal async Task<JsonObject> DecideToolApprovalAsync(
        SessionOwner owner,
        string approvalId,
        bool approve,
        string? note,
        JsonObject decidedBy
    )
    {
        note = string.IsNullOrWhiteSpace(note) ? null : note.Trim();
        if (note is { Length: > SessionApprovals.MaxNoteLength })
            throw new InvalidDataException(
                $"note is longer than {SessionApprovals.MaxNoteLength} characters."
            );
        string? failure = null;
        var missing = false;
        JsonObject? final = null;
        await owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
        {
            if (
                SessionApprovals.Resolve(
                    meta,
                    approvalId,
                    approve ? "approved" : "rejected",
                    decidedBy,
                    note
                )
            )
            {
                final = (JsonObject)SessionApprovals.Find(meta, approvalId)!.DeepClone();
                return approvalId;
            }
            missing = SessionApprovals.Find(meta, approvalId) is null;
            failure = SessionApprovals.NotPendingMessage(meta, approvalId);
            return null;
        });
        if (missing)
            throw new KeyNotFoundException(failure);
        if (failure is not null)
            throw new ToolApprovalNotPendingException(failure);
        if (final is null)
            throw new InvalidOperationException("The Session is stopping.");
        owner.ApprovalWaiters.Complete(approvalId, final);
        return final;
    }

    /// <summary>Model-facing outcome of a final record that did not approve the call.</summary>
    internal static ToolApprovalGrant ApprovalOutcome(
        PendingToolApproval pending,
        JsonObject record
    )
    {
        var note = SessionWait.Text(record["note"]);
        return SessionApprovals.Status(record) switch
        {
            "approved" => new(pending.Id, pending.Fingerprint, note),
            // Cancellation settles only after the call's own token was cancelled.
            "cancelled" => throw new InvalidOperationException(
                "Tool call was not started because its approval request was cancelled; it was not executed."
            ),
            "rejected" => throw new ToolApprovalOutcomeException(
                "tool_approval_rejected",
                "An approver rejected this tool call. It was not executed. Don't repeat it unchanged; follow the approver's note if there is one.",
                pending.Id,
                note
            ),
            "expired" => throw new ToolApprovalOutcomeException(
                "tool_approval_expired",
                $"No one approved this tool call within {pending.TimeoutSeconds ?? 0} seconds. It was not executed.",
                pending.Id
            ),
            _ => throw new InvalidDataException("Approval record has no final state."),
        };
    }

    /// <summary>Presentation-only record of the approval on the paired tool result.</summary>
    internal static JsonObject ApprovalMeta(JsonObject record)
    {
        var meta = new JsonObject
        {
            ["id"] = record["id"]?.DeepClone(),
            ["status"] = record["status"]?.DeepClone(),
        };
        foreach (var key in new[] { "decidedBy", "decidedAt", "note" })
            if (record[key] is { } value)
                meta[key] = value.DeepClone();
        return meta;
    }

    // Restart text for calls whose approval wait ended with the previous process.
    private static string? ExpiredApprovalText(IReadOnlyList<JsonObject> expired) =>
        expired.Count == 0
            ? null
            : string.Join(
                " ",
                expired.Select(record =>
                    $"Tool call {SessionWait.Text(record["tool"]?["name"])} ({SessionWait.Text(record["toolCallId"]) ?? SessionWait.Text(record["id"])}) was awaiting approval when the process restarted. It was not executed."
                )
            );
}
