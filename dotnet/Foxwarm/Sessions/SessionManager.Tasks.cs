using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task EnqueueTaskNotificationAsync(string targetId, string message, bool trigger)
    {
        var canonical = SessionCatalog.Text(Catalog.Resolve(targetId)["sessionId"]) ?? targetId;
        var target = await RequiredAsync(canonical);
        var item = new QueueItem(
            QueueItemType.Intersession,
            [new JsonObject { ["system"] = message }],
            SourceSessionId: "main",
            SourceSessionRelation: "task"
        );
        await target.Entry.SaveLane.CommitInterSessionAsync(item);
        if (
            trigger
            && Accepting
            && target.Entry.WithState(state =>
                !state.Busy && !state.Stopping && state.Queue.Count > 0
            )
        )
            target.Registry.Trigger(target.Id);
    }
}
