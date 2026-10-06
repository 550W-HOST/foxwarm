using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static partial class RequestHistoryRepair
{
    internal static IReadOnlyList<JsonObject> SelectAndRepair(IReadOnlyList<JsonObject> history)
    {
        var source = history
            .Where(row => CanonicalMessage.FromNode(row).IsModelVisible)
            .Select(row => (JsonObject)row.DeepClone())
            .ToArray();
        var result = new List<JsonObject>();
        bool Nearby(int index, int direction, bool request)
        {
            for (
                var cursor = index + direction;
                cursor >= 0 && cursor < source.Length;
                cursor += direction
            )
            {
                var row = source[cursor];
                if (Interruption(row))
                    continue;
                return request
                    ? SessionWait.Text(row["role"]) == "model"
                        && Parts(row).Any(part => Truthy(part["functionCall"]))
                    : SessionWait.Text(row["role"]) == "tool";
            }
            return false;
        }
        for (var index = 0; index < source.Length; index++)
        {
            var row = source[index];
            var parts = Parts(row);
            if (
                SessionWait.Text(row["role"]) == "tool"
                && parts.Any(part => Truthy(part["functionResponse"]))
                && !Nearby(index, -1, true)
            )
                continue;
            result.Add(row);
            var calls = parts.Select(part => part["functionCall"]).OfType<JsonObject>().ToArray();
            if (
                SessionWait.Text(row["role"]) != "model"
                || calls.Length == 0
                || Nearby(index, 1, false)
            )
                continue;
            result.Add(
                new JsonObject
                {
                    ["role"] = "tool",
                    ["parts"] = new JsonArray(
                        calls
                            .Select(call =>
                                (JsonNode)
                                    new JsonObject
                                    {
                                        ["functionResponse"] = new JsonObject
                                        {
                                            ["tool_use_id"] = SessionWait.Text(call["id"])
                                                is { Length: > 0 } id
                                                ? id
                                                : "unknown",
                                            ["name"] = call["name"]?.DeepClone(),
                                            ["response"] = new JsonObject
                                            {
                                                ["error"] =
                                                    "Tool output is lost due to agent restart or error",
                                            },
                                        },
                                    }
                            )
                            .ToArray()
                    ),
                }
            );
        }
        return result;
    }

    private static JsonObject[] Parts(JsonObject row) =>
        (row["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();

    private static bool Truthy(JsonNode? node) =>
        node is not null
        && (
            node is not JsonValue value
            || !(
                value.TryGetValue<bool>(out var boolean) && !boolean
                || value.TryGetValue<string>(out var text) && text.Length == 0
            )
        );

    private static bool Interruption(JsonObject row)
    {
        var parts = Parts(row);
        return SessionWait.Text(row["role"]) == "user"
            && parts.Length > 0
            && parts.All(part =>
            {
                if (
                    new[]
                    {
                        "functionCall",
                        "functionResponse",
                        "inlineData",
                        "inlineDataRef",
                        "thinking",
                    }.Any(key => Truthy(part[key]))
                )
                    return false;
                if (Truthy(part["system"]))
                    return true;
                var text = SessionWait.Text(part["text"]);
                return text is not null
                    && (
                        part["systemPayload"] is JsonValue flag
                            && flag.TryGetValue<bool>(out var payload)
                            && payload
                        || text.StartsWith("[SYSTEM:", StringComparison.Ordinal)
                        || MetadataLine().IsMatch(text)
                    );
            });
    }

    [GeneratedRegex(@"^\s*</?foxwarm-(?:system|metadata|message)\b", RegexOptions.IgnoreCase)]
    private static partial Regex MetadataLine();
}
