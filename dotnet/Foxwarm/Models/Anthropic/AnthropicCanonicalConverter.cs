using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class AnthropicCanonicalConverter
{
    private const string Space =
        "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";

    internal static JsonObject? ConvertAssistant(
        JsonNode? response,
        string concreteModelId,
        long completedAt,
        double durationMs
    )
    {
        var parts = new JsonArray();
        var content = response is JsonObject obj ? obj["content"] as JsonArray : null;
        foreach (var raw in content ?? [])
        {
            if (raw is not JsonObject block)
                continue;
            switch (SessionWait.Text(block["type"]))
            {
                case "text":
                    var text = SessionWait.Text(block["text"]) ?? "";
                    var tagged = TaggedThinking(text);
                    if (tagged is null)
                        parts.Add(new JsonObject { ["text"] = text });
                    else
                        foreach (var part in tagged)
                            parts.Add(part?.DeepClone());
                    break;
                case "thinking":
                    var thinking = new JsonObject { ["thinking"] = block["thinking"]?.DeepClone() };
                    if (CompletionsRequestSerializer.Truthy(block["signature"]))
                        thinking["providerMeta"] = new JsonObject
                        {
                            ["signature"] = block["signature"]!.DeepClone(),
                        };
                    parts.Add(thinking);
                    break;
                case "tool_use":
                    var id = SessionWait.Text(block["id"]);
                    if (string.IsNullOrEmpty(id))
                        throw new ModelPreparationException(
                            "Anthropic output has no stable call ID; the legacy/malformed fallback is not implemented."
                        );
                    parts.Add(
                        new JsonObject
                        {
                            ["functionCall"] = new JsonObject
                            {
                                ["id"] = id,
                                ["name"] = block["name"]?.DeepClone(),
                                ["args"] = block["input"]?.DeepClone(),
                            },
                        }
                    );
                    break;
            }
        }
        if (parts.Count == 0)
            return null;
        var meta = new JsonObject
        {
            ["modelId"] = concreteModelId,
            ["llmRequestTiming"] = new JsonObject
            {
                ["startedAt"] = completedAt - durationMs,
                ["completedAt"] = completedAt,
                ["durationMs"] = durationMs,
            },
        };
        if (Usage(response) is JsonObject usage)
            meta["usage"] = usage;
        return new JsonObject
        {
            ["role"] = "model",
            ["parts"] = parts,
            ["__meta"] = meta,
        };
    }

    internal static JsonObject? Usage(JsonNode? response) =>
        response is JsonObject body && body["usage"] is JsonObject usage
            ? new JsonObject
            {
                ["inputTokens"] = usage["input_tokens"]?.DeepClone(),
                ["outputTokens"] = usage["output_tokens"]?.DeepClone(),
                ["cachedTokens"] = CompletionsRequestSerializer.Truthy(
                    usage["cache_read_input_tokens"]
                )
                    ? usage["cache_read_input_tokens"]!.DeepClone()
                    : JsonValue.Create(0),
            }
            : null;

    private static JsonArray? TaggedThinking(string text)
    {
        if (
            !text.Contains("<thinking>", StringComparison.Ordinal)
            || !text.Contains("</thinking>", StringComparison.Ordinal)
        )
            return null;
        var parts = new JsonArray();
        var offset = 0;
        static string Strip(string value) =>
            Regex.Replace(
                Regex.Replace(value, "^" + Space + "*\\n", "", RegexOptions.CultureInvariant),
                "\\n" + Space + "*$",
                "",
                RegexOptions.CultureInvariant
            );
        foreach (
            Match match in Regex.Matches(
                text,
                "<thinking>([\\s\\S]*?)</thinking>",
                RegexOptions.CultureInvariant
            )
        )
        {
            var before = text[offset..match.Index];
            if (OpenAIRequestText.Trim(before).Length > 0)
                parts.Add(new JsonObject { ["text"] = Strip(before) });
            var thought = Strip(match.Groups[1].Value);
            if (thought.Length > 0)
                parts.Add(new JsonObject { ["thinking"] = thought });
            offset = match.Index + match.Length;
        }
        var after = text[offset..];
        if (OpenAIRequestText.Trim(after).Length > 0)
            parts.Add(new JsonObject { ["text"] = Strip(after) });
        return parts.Count == 0 ? null : parts;
    }
}
