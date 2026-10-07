using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task SendTaskNotificationAsync(
        string sourceId,
        string targetId,
        string message,
        bool trigger
    )
    {
        var source = await RequiredAsync(sourceId);
        await SendAsync(
            source,
            targetId,
            message,
            new JsonObject { ["sessionId"] = targetId, ["message"] = message },
            trigger
        );
    }
}
