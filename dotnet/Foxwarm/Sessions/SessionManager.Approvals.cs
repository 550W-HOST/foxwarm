using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Where a waiting call came from: a model turn, a ToolScript run, a timer slice or the Claude
// Code runtime. Unattended slices always get a finite deadline.
internal sealed record ToolApprovalOrigin(string Kind, string? ToolCallId, string? RunId);

internal sealed record PendingToolApproval(
    string Id,
    IReadOnlySet<string> Fingerprints,
    long? TimeoutSeconds,
    ToolApprovalWaiters.Waiter Waiter,
    ResolvedTool Resolved,
    ToolApprovalStage Stage = ToolApprovalStage.Call
);

internal sealed class ToolApprovalNotPendingException(string message)
    : InvalidOperationException(message);

// The deciding identity isn't admitted by the approval requirements in effect now.
internal sealed class ToolApprovalNotAllowedException()
    : InvalidOperationException("You are not an approver for this request.");

internal sealed partial class SessionManager
{
    // The arguments approvers see. add_secret's value is not stored yet, so masking cannot hide
    // it; approvers decide from the name and source.
    internal static JsonObject ApprovalArgs(ResolvedTool resolved)
    {
        var args = (JsonObject)resolved.Args.DeepClone();
        if (resolved is { Source: "builtin", Name: "add_secret" } && args.ContainsKey("value"))
            args["value"] = HiddenSecretValue;
        return args;
    }

    // The facts of a request as approvers read them.
    private static JsonObject RecordFacts(ToolAuthorizationRequest request)
    {
        var facts = ToolAuthorizationExplain.Facts(request);
        var recordFacts = new JsonObject();
        foreach (var key in new[] { "paths", "nodeTargets", "sessionTarget", "secrets", "operations" })
            if (facts[key] is { } fact)
                recordFacts[key] = fact.DeepClone();
        return recordFacts;
    }

    private static JsonObject RecordTool(ResolvedTool resolved, bool invocation = true)
    {
        var tool = new JsonObject
        {
            ["source"] = resolved.Source,
            ["name"] = resolved.Name,
            ["server"] = resolved.Server,
            ["executionNode"] = resolved.ExecutionNode,
        };
        if (invocation && resolved.InvocationName != resolved.Name)
            tool["invocationName"] = resolved.InvocationName;
        return tool;
    }

    /// <summary>
    /// Records a pending approval for a call whose checks matched ask rules and registers its
    /// live waiter. One record covers every asking check of the stage. The record is committed
    /// before anyone can see or decide it.
    /// </summary>
    internal async Task<PendingToolApproval> BeginToolApprovalAsync(
        SessionOwner owner,
        ToolApprovalRequiredException required,
        ToolApprovalOrigin origin,
        bool unattended,
        string? workingDirectory = null
    )
    {
        var resolved = required.Resolved;
        var shown = ApprovalArgs(resolved);
        var options = required.Approval;
        var timeout =
            options.TimeoutSeconds
            ?? (unattended ? SessionApprovals.UnattendedTimeoutSeconds : null);
        var id = SessionApprovals.NewId();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var record = new JsonObject
        {
            ["id"] = id,
            ["status"] = "pending",
            ["createdAt"] = now,
            ["origin"] = origin.Kind,
            ["tool"] = RecordTool(resolved),
            ["summary"] = SessionToolExecutor.ToolArgsPreview(resolved.Name, shown),
        };
        if (required.Stage == ToolApprovalStage.Input)
            record["stage"] = "input";
        if (timeout is long seconds)
        {
            record["timeoutSeconds"] = seconds;
            record["expiresAt"] = now + seconds * 1000;
        }
        if (workingDirectory is not null)
            record["workingDirectory"] = workingDirectory;
        if (!string.IsNullOrEmpty(origin.ToolCallId))
            record["toolCallId"] = origin.ToolCallId;
        if (!string.IsNullOrEmpty(origin.RunId))
            record["runId"] = origin.RunId;
        var args = shown.ToJsonText();
        if (Encoding.UTF8.GetByteCount(args) <= SessionApprovals.MaxArgsBytes)
            record["args"] = shown.DeepClone();
        else
        {
            // The live waiter keeps the full arguments for approvers while the record is pending.
            record["argsPreview"] =
                args.Length > SessionApprovals.MaxArgsPreviewLength
                    ? args[..SessionApprovals.MaxArgsPreviewLength]
                    : args;
            record["argsTruncated"] = true;
        }
        // The call's own facts, then every other check the approval covers with its facts.
        if (required.CallFacts is { } callFacts)
            record["facts"] = RecordFacts(callFacts);
        var others = required.Checks.Where(check => !check.Primary).ToArray();
        if (others.Length > 0)
            record["checks"] = new JsonArray(
                others
                    .Select(check =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["id"] = check.Id,
                                // A check is named by its capability, not by the call it serves.
                                ["tool"] = RecordTool(check.Resolved, invocation: false),
                                ["facts"] = RecordFacts(check.Facts),
                            }
                    )
                    .ToArray()
            );
        // The asking rules of every check, each layer and rule once.
        var rules = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var layer in required.Checks.SelectMany(check => check.Assessment.Asking))
        {
            var rule = new JsonObject
            {
                ["layer"] = OperatorCeiling.Label(layer.Layer),
                ["id"] = SessionWait.Text(layer.Decision.Rule?["id"]) ?? "defaultAction",
            };
            if (!seen.Add($"{rule["layer"]}\n{rule["id"]}"))
                continue;
            if (SessionWait.Text(layer.Decision.Rule?["reason"]) is { } reason)
                rule["reason"] = reason;
            rules.Add((JsonNode?)rule);
        }
        record["rules"] = rules;
        record["approvers"] = new JsonArray(
            options.Approvers.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
        );
        var waiter = owner.ApprovalWaiters.Register(
            id,
            (JsonObject)shown.DeepClone(),
            token => CurrentApproversAsync(owner, required, token)
        );
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
                "This Session is stopping. The call was not started."
            );
        }
        // External channels cannot decide; they only learn that the WebUI has a request.
        BroadcastTransientText(owner, ChannelApprovalText(required, record));
        return new(
            id,
            required.Checks.Select(check => check.Fingerprint).ToHashSet(StringComparer.Ordinal),
            timeout,
            waiter,
            resolved,
            required.Stage
        );
    }

    // The one-line channel notice of a pending approval.
    internal static string ChannelApprovalText(
        ToolApprovalRequiredException required,
        JsonObject record
    )
    {
        var call = $"`{required.Resolved.Name}` — {SessionWait.Text(record["summary"])}";
        if (required.Stage == ToolApprovalStage.Input)
            return $"A tool call is waiting for approval in the WebUI to read its input: {call}";
        var others = required.Checks.Count(check => !check.Primary);
        return others == 0
            ? $"A tool call is waiting for approval in the WebUI: {call}"
            : $"A tool call is waiting for approval in the WebUI: {call} (also covers {others} related {(others == 1 ? "check" : "checks")})";
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
                        "This Session is stopping. The call was not started."
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
            // A cancellation that loses to an approval still means the call never started.
            if (
                !SessionApprovals.Resolve(
                    meta,
                    id,
                    status,
                    new JsonObject { ["kind"] = "system", ["reason"] = reason }
                )
                && status == "cancelled"
            )
                SessionApprovals.Abandon(meta, id, reason);
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
        // A scoped identity decides only when the requirements in effect now admit it: a policy
        // change while the question was pending may have narrowed who may approve.
        if (
            SessionWait.Text(decidedBy["kind"]) == "identity"
            && owner.ApprovalWaiters.Approvers(approvalId) is { } current
            && !(await current(CancellationToken.None)).Contains(SessionWait.Text(decidedBy["id"]) ?? "")
        )
            throw new ToolApprovalNotAllowedException();
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

    // The identities the current policy admits to decide an approval for these checks: each
    // check's assessed request evaluated again against the effective layers, combined as when
    // the question was asked. No asking layer left admits no identity; the administrator
    // still decides.
    private async Task<IReadOnlyList<string>> CurrentApproversAsync(
        SessionOwner owner,
        ToolApprovalRequiredException required,
        CancellationToken token
    )
    {
        var layers = EffectiveLayers(owner.Agent, await authorization.LoadAsync(token));
        var asking = required
            .Checks.SelectMany(check =>
                layers.Select(layer => new AuthorizationLayerDecision(
                    layer.Name,
                    layer.Policy,
                    ToolAuthorizationEvaluation.Evaluate(layer.Policy, check.Assessment.Request)
                ))
            )
            .Where(layer => layer.Decision.Effect == ToolAuthorizationEffect.Ask);
        return ToolApprovalOptions.Combine(asking).Approvers;
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
            "approved" => new(pending.Id, pending.Fingerprints, note, pending.Stage),
            // Cancellation settles only after the call's own token was cancelled.
            "cancelled" => throw new ToolApprovalOutcomeException(
                "tool_call_cancelled",
                "This tool call's approval request was cancelled. It was not executed.",
                pending.Id
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
        foreach (var key in new[] { "decidedBy", "decidedAt", "note", "approvedBy", "approvedAt" })
            if (record[key] is { } value)
                meta[key] = value.DeepClone();
        return meta;
    }

    /// <summary>
    /// Records that an approved call did not start. Returns the settled presentation, or null
    /// when the record is no longer approved or no longer retained.
    /// </summary>
    internal async Task<JsonObject?> AbandonApprovedToolAsync(
        SessionOwner owner,
        string id,
        string reason
    )
    {
        try
        {
            var final = await SettleToolApprovalAsync(owner, id, "cancelled", reason);
            return final is null ? null : ApprovalMeta(final);
        }
        catch (Exception error)
            when (error is InvalidOperationException or IOException or ObjectDisposedException)
        {
            return null;
        }
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
