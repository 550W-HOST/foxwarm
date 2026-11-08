using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    /// <summary>
    /// Summarizes the owner's own successful requests between a Task's assignment and completion
    /// from the recorded concrete model attribution and saved per-message costs, or returns null
    /// when it made none. Archive rows are used, so compaction does not change the result.
    /// </summary>
    internal async Task<string?> TaskOwnerUsageLineAsync(
        string ownerSessionId,
        long assignedAt,
        long completedAt
    )
    {
        var owner = await RequiredAsync(ownerSessionId);
        var modelIds = new List<string>();
        var total = 0d;
        var complete = true;
        var requests = 0;
        foreach (var row in owner.Archive.ReadEffectiveMessagesBetween(assignedAt, completedAt + 1))
        {
            if (
                row.Role != "model"
                || row.Message["__meta"] is not JsonObject meta
                || SessionWait.Text(meta["modelId"]) is not { Length: > 0 } modelId
            )
                continue;
            requests++;
            if (!modelIds.Contains(modelId, StringComparer.Ordinal))
                modelIds.Add(modelId);
            if (
                meta["usage"] is JsonObject usage
                && SessionWait.Number(usage["cost"]) is double cost
                && double.IsFinite(cost)
            )
                total += cost;
            else
                complete = false;
        }
        if (requests == 0)
            return null;
        return "Task owner usage: "
            + string.Join(", ", modelIds)
            + "; estimated cost "
            + (complete ? Foxwarm.Models.ModelUsageCost.FormatUsd(total) : "unavailable")
            + ".";
    }

    internal async Task SendTaskNotificationAsync(
        string? sourceId,
        string targetId,
        string message,
        bool trigger,
        string taskId,
        string eventName,
        string recipient
    )
    {
        if (sourceId is null)
        {
            var target = await RequiredAsync(targetId);
            var now = DateTimeOffset.Now;
            var offset = now.ToString("zzz").Replace(":", "", StringComparison.Ordinal);
            var time = now.ToString("yyyy-MM-dd HH:mm:ss") + " " + offset;
            var wrapper =
                $"<foxwarm-message type=\"task\" taskId=\"{Escape(taskId)}\" event=\"{Escape(eventName)}\" time=\"{Escape(time)}\" hint=\"task notification from an authenticated user\" sourceKind=\"user\">\n{message}\n</foxwarm-message>";
            var item = new QueueItem(
                QueueItemType.Intersession,
                [new JsonObject { ["system"] = wrapper }],
                SourceSessionId: null,
                SourceSessionRelation: null,
                Trigger: trigger
            );
            await target.Entry.SaveLane.CommitInterSessionAsync(item);
            if (
                trigger
                && Accepting
                && !target.Entry.WithState(state => state.Busy || state.Stopping)
                && target.Registry.HasRunnableWork(target.Entry)
            )
                target.Registry.Trigger(target.Id);
            return;
        }
        var source = await RequiredAsync(sourceId);
        await SendAsync(
            source,
            targetId,
            message,
            new JsonObject { ["sessionId"] = targetId, ["message"] = message },
            trigger,
            new JsonObject
            {
                ["taskId"] = taskId,
                ["event"] = eventName,
                ["recipient"] = recipient,
            }
        );
    }
}
