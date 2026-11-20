using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Who sent WebUI input, kept on the committed user message as <c>__meta.sender</c>:
/// <c>{kind:"administrator"}</c> or <c>{kind:"identity", id}</c>, the shape approval decisions
/// use. It and the turn initiator on tool rows (<c>__meta.initiator</c>, which can repeat the
/// sender) are administrator-only evidence: scoped WebUI projections and every model-facing
/// copy of stored messages remove both, wherever the message is nested.
/// </summary>
internal static class InputSender
{
    internal const string Field = "sender";

    private static readonly string[] AuditFields = [Field, TurnInitiator.Field];

    internal static JsonObject Administrator() => new() { ["kind"] = "administrator" };

    internal static JsonObject Identity(string id) => new() { ["kind"] = "identity", ["id"] = id };

    internal static JsonObject With(JsonObject fields, JsonObject? sender)
    {
        if (sender is not null)
            fields[Field] = sender.DeepClone();
        return fields;
    }

    /// <summary>
    /// Returns the payload without any <c>__meta.sender</c> or <c>__meta.initiator</c>. The input is never
    /// modified: event payloads and history nodes can be shared with other subscribers, so a
    /// payload that carries a sender is cloned first.
    /// </summary>
    internal static T? Without<T>(T? payload)
        where T : JsonNode
    {
        if (payload is null || !Contains(payload))
            return payload;
        var copy = (T)payload.DeepClone();
        Remove(copy);
        return copy;
    }

    /// <summary>Removes the audit fields from a payload this caller owns.</summary>
    internal static void Strip(JsonNode? payload)
    {
        if (payload is not null && Contains(payload))
            Remove(payload);
    }

    private static bool Contains(JsonNode node) =>
        node switch
        {
            JsonObject value => value.Any(pair =>
                pair.Key == "__meta"
                    && pair.Value is JsonObject meta
                    && AuditFields.Any(meta.ContainsKey)
                || pair.Value is not null && Contains(pair.Value)
            ),
            JsonArray items => items.Any(item => item is not null && Contains(item)),
            _ => false,
        };

    private static void Remove(JsonNode node)
    {
        switch (node)
        {
            case JsonObject value:
                if (value["__meta"] is JsonObject meta)
                    foreach (var field in AuditFields)
                        meta.Remove(field);
                foreach (var pair in value.ToArray())
                    if (pair.Value is not null)
                        Remove(pair.Value);
                break;
            case JsonArray items:
                foreach (var item in items)
                    if (item is not null)
                        Remove(item);
                break;
        }
    }
}
