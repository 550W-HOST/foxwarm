using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class CompletionsCanonicalConverter
{
    internal static JsonObject ConvertAssistant(
        JsonObject response,
        string concreteModelId,
        long completedAt,
        double durationMs
    )
    {
        var message = response["choices"]?[0]?["message"] as JsonObject ?? new JsonObject();
        var parts = new JsonArray();
        var reasoning = SessionWait.Text(message["reasoning_content"]);
        if (string.IsNullOrEmpty(reasoning))
            reasoning = SessionWait.Text(message["reasoning"]);
        if (!string.IsNullOrEmpty(reasoning))
            parts.Add(new JsonObject { ["thinking"] = reasoning });
        if (SessionWait.Text(message["content"]) is string text)
            parts.Add(new JsonObject { ["text"] = text });
        foreach (var raw in message["tool_calls"] as JsonArray ?? [])
        {
            if (raw is not JsonObject call || SessionWait.Text(call["type"]) != "function")
                continue;
            var id = SessionWait.Text(call["id"]);
            if (string.IsNullOrEmpty(id))
                throw new ModelPreparationException(
                    "Chat Completions output has no stable call ID; the legacy/malformed fallback is not implemented."
                );
            var function = call["function"] as JsonObject ?? new JsonObject();
            var args = FunctionCallArguments.Parse(function["arguments"]);
            var canonical = new JsonObject
            {
                ["id"] = id,
                ["name"] = SessionWait.Text(function["name"]) ?? "",
                ["args"] = args.Args.DeepClone(),
            };
            if (args.RawArgsText is not null)
                canonical["rawArgsText"] = args.RawArgsText;
            if (args.ArgsParseError is not null)
                canonical["argsParseError"] = args.ArgsParseError;
            parts.Add(new JsonObject { ["functionCall"] = canonical });
        }
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
        if (response["usage"] is JsonObject usage)
        {
            var cached = SessionWait.Number(usage["prompt_tokens_details"]?["cached_tokens"]) ?? 0;
            var normalized = new JsonObject
            {
                ["inputTokens"] = (SessionWait.Number(usage["prompt_tokens"]) ?? 0) - cached,
                ["outputTokens"] = SessionWait.Number(usage["completion_tokens"]) ?? 0,
                ["cachedTokens"] = cached,
            };
            if (
                SessionWait.Number(usage["completion_tokens_details"]?["reasoning_tokens"])
                    is double tokens
                && double.IsFinite(tokens)
            )
                normalized["reasoningTokens"] = tokens;
            meta["usage"] = normalized;
        }
        var result = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = parts,
            ["__meta"] = meta,
        };
        var providerMeta = new JsonObject();
        if (message["provider_specific_fields"] is JsonObject fields)
            providerMeta["providerSpecificFields"] = fields.DeepClone();
        if (message["extra_fields"] is JsonObject extra)
            providerMeta["extraFields"] = extra.DeepClone();
        if (providerMeta.Count > 0)
        {
            providerMeta["sourceModelId"] = concreteModelId;
            result["providerMeta"] = providerMeta;
        }
        return result;
    }
}
