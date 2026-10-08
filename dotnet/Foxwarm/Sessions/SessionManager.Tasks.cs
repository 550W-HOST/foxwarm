using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
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
