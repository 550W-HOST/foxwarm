using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private async Task<JsonObject> CompactSessionAsync(SessionOwner source, JsonObject args)
    {
        Keys(args, ["sessionId", "summary", "keepPercent"], []);
        var targetId = SessionWait.Text(args["sessionId"]);
        if (string.IsNullOrEmpty(targetId)) targetId = source.Id;
        var target = Find(targetId) ?? throw new InvalidDataException($"Session `{targetId}` not found.");
        var snapshot = target.Entry.Snapshot();
        if (target != source && (snapshot.Busy || snapshot.Queue.Any(SessionCompactor.Ordinary)))
            throw new InvalidOperationException($"Session `{targetId}` must be idle with an empty ordinary queue before another session can request compaction.");
        var summary = SessionWait.Text(args["summary"]);
        var guidance = summary is null ? null : SessionGoal.Trim(summary);
        if (guidance is "") guidance = null;
        var value = SessionWait.Number(args["keepPercent"]);
        double? keep = value is > 1 and <= 100 ? value / 100 : value is > 0 and <= 1 ? value : null;
        var result = await target.Compactor.StartManualAsync(guidance, keep);
        if (result.AlreadyPending) return Output($"Compaction is already pending for session `{targetId}`.");
        var mode = guidance is null ? "automatic compaction plan" : "guided compaction plan";
        if (result.Started) return Output(result.Background
            ? $"Compaction requested for session `{targetId}`. It is entering the background compact planning flow now using {mode}."
            : $"Compaction started for session `{targetId}` using {mode}. The session remains busy until awaited compaction finishes.");
        return Output($"Compaction was not started for session `{targetId}`: its model disables background compaction, so the session must be idle before compaction can run.");
    }
}
