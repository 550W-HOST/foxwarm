using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private bool NodeCanAccessSession(string node, JsonObject session) =>
        ResolveExecutionNode(session, BoundNode(SessionWait.Text(session["agent"]) ?? "main"))
            == node
        || BoundNode(SessionWait.Text(session["agent"]) ?? "main") == node;

    private InvalidDataException NodeSessionDenied(string node, string id, string action) =>
        new(
            $"Node \"{node}\" cannot {action} session \"{id}\" because the session is not assigned to that node or its isolated agent."
        );

    private JsonObject RequireNodeSessionProjection(string node, string requested, string action)
    {
        var normalized = SessionGoal.Trim(requested);
        if (normalized.Length == 0)
            throw new InvalidDataException("sessionId must be a non-empty string.");
        var canonical = SessionWait.Text(Catalog.Resolve(normalized)["sessionId"]);
        var projection = canonical is null
            ? null
            : CatalogPresentations([canonical], false).FirstOrDefault();
        if (projection is null)
            throw new InvalidDataException($"Target session \"{requested}\" not found.");
        if (!NodeCanAccessSession(node, projection))
            throw NodeSessionDenied(node, requested, action);
        return projection;
    }

    internal async Task<JsonObject> HandleNodeSessionRequestAsync(
        string node,
        JsonObject message,
        Action requireConnection,
        CancellationToken token
    )
    {
        requireConnection();
        var type = SessionWait.Text(message["type"]);
        if (type == "session_list_request")
            return new JsonObject
            {
                ["sessions"] = new JsonArray(
                    ListPresentations()
                        .Where(session => NodeCanAccessSession(node, session))
                        .Select(session => (JsonNode?)NodeSessionSummary(session))
                        .ToArray()
                ),
            };
        var requested = NodeConnectionHub.SessionRequestString(message["sessionId"]);
        if (
            type == "session_send_message"
            && (
                !NodeConnectionHub.SessionRequestTruthy(message["sessionId"])
                || SessionWait.Text(message["message"]) is null
            )
        )
            throw new InvalidDataException(
                "Invalid session_send_message: missing sessionId or message"
            );
        var action = type == "session_history_request" ? "read history for" : "send messages to";
        var catalog = RequireNodeSessionProjection(node, requested, action);
        var owner = await GetExistingAsync(catalog["id"]!.GetValue<string>(), token);
        requireConnection();
        if (owner is null)
            throw new InvalidDataException($"Target session \"{requested}\" not found.");
        if (type == "session_history_request")
        {
            if (!NodeCanAccessSession(node, owner.BuildDto()))
                throw new InvalidDataException(
                    $"Node \"{node}\" cannot read history for session \"{requested}\" because the session assignment changed."
                );
            var snapshot = owner.Entry.Snapshot();
            var count = SessionWait.Number(message["count"]) ?? 30;
            var safeCount = Math.Max(1, Math.Min(100, count == 0 ? 30 : count));
            var start = Math.Max(0, snapshot.History.Count - safeCount);
            return new JsonObject
            {
                ["session"] = NodeSessionSummary(owner.BuildDto()),
                ["totalMessages"] = snapshot.History.Count,
                ["messages"] = new JsonArray(
                    snapshot
                        .History.Skip((int)start)
                        .Select(
                            (row, offset) =>
                                (JsonNode?)NodeHistoryMessage(row.ToJson(), start + offset)
                        )
                        .ToArray()
                ),
            };
        }
        var eventType = SessionWait.Text(message["eventType"]) switch
        {
            "background" => "background",
            "onboot" => "onboot",
            _ => "trigger",
        };
        var queueType = eventType switch
        {
            "background" => QueueItemType.Background,
            "onboot" => QueueItemType.OnBoot,
            _ => QueueItemType.Trigger,
        };
        await new SessionRuntime(this).SubmitAndRunAsync(
            owner,
            new QueueItem(
                queueType,
                [
                    new JsonObject
                    {
                        ["system"] = SessionBoundary.SessionEvent(
                            eventType,
                            SessionWait.Text(message["message"])!
                        ),
                    },
                ]
            ),
            () =>
            {
                requireConnection();
                if (!NodeCanAccessSession(node, owner.BuildDto()))
                    throw NodeSessionDenied(node, requested, "send messages to");
            }
        );
        return new JsonObject { ["accepted"] = true };
    }

    private JsonObject NodeSessionSummary(JsonObject session) =>
        new()
        {
            ["id"] = session["id"]?.DeepClone(),
            ["displayName"] = session["displayName"]?.DeepClone(),
            ["messageCount"] =
                session["messageCount"]?.DeepClone()
                ?? session["meta"]?["messageCount"]?.DeepClone()
                ?? JsonValue.Create(0),
            ["lastMessageTime"] =
                session["lastMessageTime"]?.DeepClone()
                ?? session["meta"]?["lastMessageTime"]?.DeepClone(),
            ["currentNode"] = ResolveExecutionNode(
                session,
                BoundNode(SessionWait.Text(session["agent"]) ?? "main")
            ),
            ["cwd"] = session["cwd"]?.DeepClone(),
            ["busy"] = session["busy"]?.DeepClone() ?? JsonValue.Create(false),
            ["queueLength"] = session["queueLength"]?.DeepClone() ?? JsonValue.Create(0),
        };

    internal static JsonObject NodeHistoryMessage(JsonObject message, double index)
    {
        var result = new JsonObject
        {
            ["index"] = index,
            ["role"] = NodeConnectionHub.SessionRequestTruthy(message["role"])
                ? message["role"]!.DeepClone()
                : JsonValue.Create("unknown"),
            ["text"] = string.Join(
                "\n",
                (message["parts"] as JsonArray ?? new JsonArray())
                    .Select(NodeMessagePartText)
                    .Where(text => text.Length > 0)
            ),
        };
        if (message["__meta"] is JsonObject meta && meta.ContainsKey("timestamp"))
            result["timestamp"] = meta["timestamp"]?.DeepClone();
        return result;
    }

    private static string NodeMessagePartText(JsonNode? part)
    {
        if (part is not (JsonObject or JsonArray))
            return NodeConnectionHub.SessionRequestValueString(part);
        if (part is not JsonObject obj)
            return EcmaJson.Stringify(part);
        if (SessionWait.Text(obj["text"]) is { } text)
            return text;
        if (SessionWait.Text(obj["system"]) is { } system)
            return "[SYSTEM] " + system;
        if (NodeConnectionHub.SessionRequestTruthy(obj["inlineData"]))
            return "[inline data: "
                + (
                    NodeConnectionHub.SessionRequestString(
                        (obj["inlineData"] as JsonObject)?["mimeType"]
                    )
                        is { Length: > 0 } mime
                        ? mime
                        : "unknown"
                )
                + "]";
        foreach (
            var (key, label, payload) in new[]
            {
                ("functionCall", "tool call", "args"),
                ("functionResponse", "tool response", "response"),
            }
        )
            if (NodeConnectionHub.SessionRequestTruthy(obj[key]))
            {
                var tool = obj[key] as JsonObject;
                var name = NodeConnectionHub.SessionRequestString(tool?["name"]);
                var data = tool?[payload];
                return $"[{label}: {(name.Length > 0 ? name : "unknown")} {EcmaJson.Stringify(NodeConnectionHub.SessionRequestTruthy(data) ? data! : new JsonObject())}]";
            }
        return EcmaJson.Stringify(part);
    }
}
