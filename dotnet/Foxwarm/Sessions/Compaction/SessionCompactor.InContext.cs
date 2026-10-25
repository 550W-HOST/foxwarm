using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private sealed record InContextSubmission(long AssistantSeq, string CallId);

    internal JsonObject SubmitInContext(JsonObject args, long assistantSeq, string callId)
    {
        if (args.ContainsKey("argsFilePath"))
            throw new CompactPlanInvalidException(
                "In-context compaction accepts direct plan fields, not argsFilePath."
            );
        if (hosted.Entry.HistoryMutation)
            throw new InvalidOperationException("Session history change is in progress.");
        using var admission = hosted.Entry.AdmitMutation();
        lock (gate)
            if (active is not null)
                throw new InvalidOperationException("A compaction operation is already pending.");

        var snapshot = hosted.Entry.Snapshot();
        var split = -1;
        for (var index = 0; index < snapshot.History.Count; index++)
            if (snapshot.History[index].Sequence == assistantSeq)
            {
                split = index;
                break;
            }
        if (split < 0)
            throw new CompactPlanInvalidException("The current tool exchange is no longer active.");
        // The entire executing assistant/tool exchange stays outside the source region.
        var candidates = CompactCandidateBuilder.Build(
            snapshot.History.Take(split).Select(row => row.ToJson()).ToArray(),
            inContext: true
        );
        var plan = CompactPlanValidator.Validate(args, candidates);
        var run = Begin(snapshot, models.Capture(), 0, background: false, standalone: false)
            ?? throw new InvalidOperationException("A compaction operation is already pending.");
        run.Submission = new InContextSubmission(assistantSeq, callId);
        run.Candidates = candidates;
        run.Plan = plan;
        run.Phase = "awaiting-tool-response";
        // This operation has no planner/producer. Stop must never await its own tool row.
        run.PlanningSettled.TrySetResult();
        run.PipelineDone.TrySetResult();
        PublishRuntime(run);
        return new JsonObject
        {
            ["accepted"] = true,
            ["applied"] = false,
            ["operationId"] = run.OperationId,
            ["output"] = "Plan accepted for application after this complete tool batch is recorded. Acceptance does not mean it applied; cancellation or changed history can prevent application. Inspect the resulting active history and compaction boundary.",
        };
    }

    internal bool PairInContextSubmission(JsonObject canonicalToolMessage)
    {
        lock (gate)
        {
            if (
                active is not { Submission: { } submission, Ready: false } run
                || run.Cancellation.IsCancellationRequested
                || CompactCandidateBuilder.Number(canonicalToolMessage["__meta"]?["seq"])
                    is not long responseSeq
                || responseSeq <= submission.AssistantSeq
                || (canonicalToolMessage["parts"] as JsonArray)?.OfType<JsonObject>().Any(part =>
                    part["functionResponse"] is JsonObject response
                    && SessionWait.Text(response["tool_use_id"]) == submission.CallId
                    && response["response"]?["accepted"]?.ToJsonString() == "true"
                    && SessionWait.Text(response["response"]?["operationId"]) == run.OperationId
                ) != true
            )
                return false;
            run.Ready = true;
            run.Phase = "ready";
            PublishRuntime(run);
            return true;
        }
    }

    internal async Task DiscardUnpairedInContextAsync(long assistantSeq)
    {
        CompactRun? run;
        lock (gate)
        {
            run = active;
            if (run?.Submission?.AssistantSeq != assistantSeq || run.Ready)
                return;
        }
        try
        {
            run.Cancellation.Cancel();
        }
        catch (ObjectDisposedException) { }
        await FinishAsync(run);
    }
}
