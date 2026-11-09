using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Who sent WebUI input, kept on the committed user message as <c>__meta.sender</c>:
/// <c>{kind:"administrator"}</c> or <c>{kind:"identity", id}</c>, the shape approval decisions
/// use. It is administrator-only evidence: scoped WebUI projections remove it, and model
/// requests never see <c>__meta</c>.
/// </summary>
internal static class InputSender
{
    internal const string Field = "sender";

    internal static JsonObject Administrator() => new() { ["kind"] = "administrator" };

    internal static JsonObject Identity(string id) => new() { ["kind"] = "identity", ["id"] = id };

    internal static JsonObject With(JsonObject fields, JsonObject? sender)
    {
        if (sender is not null)
            fields[Field] = sender.DeepClone();
        return fields;
    }

    /// <summary>
    /// Returns the payload without any message <c>__meta.sender</c>. The input is never
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

    private static bool Contains(JsonNode node) =>
        node switch
        {
            JsonObject value => value.Any(pair =>
                pair.Key == "__meta" && pair.Value is JsonObject meta && meta.ContainsKey(Field)
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
                    meta.Remove(Field);
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
