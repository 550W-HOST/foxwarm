using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    private Connection? currentConnection;

    private Connection Connected => currentConnection is { Socket.State: System.Net.WebSockets.WebSocketState.Open } connection
        ? connection
        : throw new IOException("Remote node is not connected to master");

    internal async Task SendSessionEvent(string sessionId, string message, string eventType = "background")
    {
        if (string.IsNullOrEmpty(sessionId))
            return;
        await Connected.Request(new JsonObject
        {
            ["type"] = "session_event",
            ["sessionId"] = sessionId,
            ["message"] = message,
            ["eventType"] = eventType,
        });
    }

    internal async Task<JsonArray> ListBoundSessions()
    {
        var result = await Connected.Request(new JsonObject { ["type"] = "session_list_request" }, 10);
        return result is JsonObject value && value["sessions"] is JsonArray sessions
            ? (JsonArray)sessions.DeepClone()
            : new JsonArray();
    }

    internal Task<JsonNode?> GetSessionHistory(string sessionId, double count = 30) =>
        Connected.Request(new JsonObject
        {
            ["type"] = "session_history_request",
            ["sessionId"] = sessionId,
            ["count"] = double.IsFinite(count) ? JsonValue.Create(count) : null,
        }, 10);

    internal async Task SendSessionMessage(string sessionId, string message)
    {
        await Connected.Request(new JsonObject
        {
            ["type"] = "session_send_message",
            ["sessionId"] = sessionId,
            ["message"] = message,
            ["eventType"] = "trigger",
        }, 10);
    }
}
