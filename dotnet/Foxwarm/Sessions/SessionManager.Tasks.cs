using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task SendTaskNotificationAsync(
        string sourceId,
        string targetId,
        string message,
        bool trigger,
        string taskId,
        string eventName,
        string recipient
    )
    {
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
