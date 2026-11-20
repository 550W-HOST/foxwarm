using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Who started the turn of a tool call, and the input row that did. <c>From</c> names a second
/// party where one exists, such as the Session that assigned a Task.
/// </summary>
internal sealed record ToolEffectInitiator(long Seq, string Kind, string? Id, string? From = null)
{
    internal JsonObject ToJson()
    {
        var value = new JsonObject { ["kind"] = Kind };
        if (Id is not null)
            value["id"] = Id;
        if (From is not null)
            value["from"] = From;
        value["seq"] = Seq;
        return value;
    }

    internal static ToolEffectInitiator? FromJson(JsonNode? node) =>
        node is JsonObject value && SessionWait.Text(value["kind"]) is { } kind
            ? new(
                (long)(SessionWait.Number(value["seq"]) ?? 0),
                kind,
                SessionWait.Text(value["id"]),
                SessionWait.Text(value["from"])
            )
            : null;
}

/// <summary>
/// Classifies committed user input as the start of a turn. The Session owner records the
/// result on each tool row as <c>__meta.initiator</c> while the turn runs; the activity backfill
/// uses the same reading for rows written before that field existed. Only trusted first-party
/// shapes are read: the WebUI sender recorded by the server and the leading wrapper every
/// Foxwarm input path puts first. Background notices are not initiators, so the turn keeps the
/// input they followed.
/// </summary>
internal static class TurnInitiator
{
    internal const string Field = "initiator";

    internal static ToolEffectInitiator? FromInput(long seq, JsonObject message)
    {
        if (message["__meta"]?[InputSender.Field] is JsonObject sender)
            return SessionWait.Text(sender["kind"]) == "identity"
                ? new(seq, "identity", SessionWait.Text(sender["id"]))
                : new(seq, "administrator", null);
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var text = SessionWait.Text(part["system"]) ?? SessionWait.Text(part["text"]);
            if (text is null)
                return new(seq, "user", null);
            if (Classify(seq, text, out var initiator))
                return initiator;
        }
        return null;
    }

    // Returns false for framing that precedes the input itself (the Session's opening tags and
    // channel mode notices), so the next part decides.
    private static bool Classify(long seq, string text, out ToolEffectInitiator? initiator)
    {
        initiator = null;
        var wrapper = SessionSequenceProjection.ParseWrapper(text);
        if (wrapper is null)
        {
            initiator = new(seq, "user", null);
            return true;
        }
        string? Attribute(string name) => wrapper.Attributes.GetValueOrDefault(name);
        if (wrapper.Tag == "foxwarm-system")
        {
            switch (Attribute("kind"))
            {
                case "session" or "session-boundary" or "channel-mode":
                    // A self-closing opening tag can share its part with the input after it.
                    return wrapper.Body.Length > 0 && Classify(seq, wrapper.Body, out initiator);
                case "external-input" when Attribute("webhook") is { } webhook:
                    initiator = new(seq, "webhook", webhook);
                    return true;
                case "external-input" when Attribute("externalId") is { } client:
                    initiator = new(seq, "mcp-client", client);
                    return true;
                case "external-input" when Attribute("server") is { } server:
                    initiator = new(seq, "mcp-server", server);
                    return true;
                default:
                    return true;
            }
        }
        initiator = Attribute("type") switch
        {
            "channel" when Attribute("channelInstanceId") is null => new(
                seq,
                "user",
                Attribute("channelType")
            ),
            "channel" => new(
                seq,
                "channel",
                Attribute("channelTargetId") ?? Attribute("channelInstanceId"),
                Attribute("sender")
            ),
            "inter-agent" or "toolscript" => new(seq, "session", Attribute("sourceSessionId")),
            "task" => new(seq, "task", Attribute("taskId"), Attribute("sourceSessionId")),
            "timer" => new(seq, "timer", Attribute("timerId")),
            "trigger" => new(seq, "trigger", null),
            _ => null,
        };
        return true;
    }
}
