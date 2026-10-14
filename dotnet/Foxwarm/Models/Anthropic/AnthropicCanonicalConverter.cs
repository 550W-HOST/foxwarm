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
        var stopReason = StopReason(response);
        var parts = new JsonArray();
        var content = response is JsonObject obj ? obj["content"] as JsonArray : null;
        foreach (var raw in content ?? [])
        {
            if (raw is not JsonObject block)
                continue;
            var type = SessionWait.Text(block["type"]) ?? "";
            if (
                type is "server_tool_use" or "mcp_tool_use"
                || type.EndsWith("_tool_result", StringComparison.Ordinal)
            )
                throw new ModelAttemptFailure(
                    $"Anthropic server tool block \"{type}\" is not supported by Foxwarm.",
                    "response-error",
                    false,
                    false
                );
            switch (type)
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
                case "redacted_thinking":
                    if (SessionWait.Text(block["data"]) is string redacted)
                        parts.Add(
                            new JsonObject
                            {
                                ["providerMeta"] = new JsonObject
                                {
                                    ["redactedThinking"] = redacted,
                                },
                            }
                        );
                    break;
                case "tool_use":
                    var id = SessionWait.Text(block["id"]);
                    if (string.IsNullOrEmpty(id))
                        throw new ModelPreparationException(
                            "Anthropic output has no stable call ID; the legacy/malformed fallback is not implemented."
                        );
                    // Native non-object inputs are argument errors too, never executor input.
                    var input = block["input"];
                    var parsed = FunctionCallArguments.Parse(
                        input is null or JsonObject || SessionWait.Text(input) is not null
                            ? input
                            : JsonValue.Create(input.ToJsonString())
                    );
                    var call = new JsonObject
                    {
                        ["id"] = id,
                        ["name"] = block["name"]?.DeepClone(),
                        ["args"] = parsed.Args.DeepClone(),
                    };
                    if (parsed.RawArgsText is not null)
                        call["rawArgsText"] = parsed.RawArgsText;
                    if (parsed.ArgsParseError is string parseError)
                        call["argsParseError"] = stopReason is null
                            ? parseError
                            : $"Tool call was not executed: the response stopped at {stopReason} before the tool input was known to be complete. {parseError}";
                    parts.Add(new JsonObject { ["functionCall"] = call });
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

    internal static string? StopReason(JsonNode? response)
    {
        var reason = response is JsonObject body ? SessionWait.Text(body["stop_reason"]) : null;
        if (reason == "refusal")
        {
            var details = response!["stop_details"] as JsonObject;
            var category = SessionWait.Text(details?["category"]);
            var explanation = SessionWait.Text(details?["explanation"])?.Trim();
            throw new ModelAttemptFailure(
                "The model declined this request"
                    + (string.IsNullOrEmpty(category) ? "" : $" ({category})")
                    + "."
                    + (string.IsNullOrEmpty(explanation) ? "" : " " + explanation),
                "response-error",
                false,
                false
            );
        }
        if (reason == "pause_turn")
            throw new ModelAttemptFailure(
                "Anthropic paused a server-tool turn, which Foxwarm does not continue automatically.",
                "response-error",
                false,
                false
            );
        return reason is "max_tokens" or "model_context_window_exceeded" ? reason : null;
    }

    internal static JsonObject? Usage(JsonNode? response)
    {
        if (response is not JsonObject body || body["usage"] is not JsonObject usage)
            return null;
        var result = new JsonObject
        {
            ["inputTokens"] = Reported(usage["input_tokens"]) is double input
                ? System.Text.Json.JsonSerializer.SerializeToNode(
                    input + (Reported(usage["cache_creation_input_tokens"]) ?? 0)
                )
                : null,
            ["outputTokens"] = Reported(usage["output_tokens"]) is not null
                ? usage["output_tokens"]?.DeepClone()
                : null,
            ["cachedTokens"] = Reported(usage["cache_read_input_tokens"]) is not null
                ? usage["cache_read_input_tokens"]!.DeepClone()
                : JsonValue.Create(0),
        };
        if (Reported(usage["output_tokens_details"]?["thinking_tokens"]) is double reasoning)
            result["reasoningTokens"] = reasoning;
        return result;
    }

    private static double? Reported(JsonNode? node) =>
        SessionWait.Number(node) is double value && double.IsFinite(value) ? value : null;

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
