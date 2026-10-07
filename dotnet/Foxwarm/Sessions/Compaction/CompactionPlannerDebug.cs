using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record CompactionPlannerDebug(
    int Steps,
    IReadOnlyList<string> ToolCalls,
    JsonObject? Usage,
    JsonArray Messages
)
{
    internal JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["steps"] = Steps,
            ["toolCalls"] = new JsonArray(
                ToolCalls.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            ),
            ["messages"] = Messages.DeepClone(),
        };
        if (Usage is not null)
            result["usage"] = Usage.DeepClone();
        return result;
    }

    internal static JsonObject AddUsage(JsonObject? accumulated, JsonObject reported)
    {
        accumulated ??= new JsonObject();
        foreach (
            var field in new[] { "cachedTokens", "inputTokens", "outputTokens", "reasoningTokens" }
        )
            if (CompactCandidateBuilder.Finite(reported[field]) is double value)
                accumulated[field] =
                    (CompactCandidateBuilder.Finite(accumulated[field]) ?? 0) + value;
        return accumulated;
    }
}
