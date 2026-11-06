using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionOwner
{
    private readonly object toolActivityGate = new();
    private readonly string toolActivityId = Guid.NewGuid().ToString("N");
    private readonly HashSet<string> runningToolCalls = new(StringComparer.Ordinal);
    private long toolActivitySequence;

    internal JsonObject ToolCallActivitySnapshot()
    {
        lock (toolActivityGate)
            return new JsonObject
            {
                ["type"] = "tool-call-snapshot",
                ["activityId"] = toolActivityId,
                ["sequence"] = toolActivitySequence,
                ["runningCallIds"] = new JsonArray(
                    runningToolCalls.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                ),
            };
    }

    private void SetToolCallActivity(JsonObject projection, bool running)
    {
        if (SessionWait.Text(projection["tool"]?["id"]) is not { Length: > 0 } id)
            return;
        lock (toolActivityGate)
        {
            if (!(running ? runningToolCalls.Add(id) : runningToolCalls.Remove(id)))
                return;
            // Keep concurrent completion publication ordered with the reconnect watermark.
            Emit(
                SessionEventKind.ModelStream,
                new JsonObject
                {
                    ["type"] = "tool-call-state",
                    ["activityId"] = toolActivityId,
                    ["sequence"] = ++toolActivitySequence,
                    ["callId"] = id,
                    ["status"] = running ? "running" : "finished",
                }
            );
        }
    }
}
