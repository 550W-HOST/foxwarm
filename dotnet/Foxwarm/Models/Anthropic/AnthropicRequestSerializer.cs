using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal static class AnthropicRequestSerializer
{
    internal static JsonArray ConvertHistory(
        IEnumerable<JsonObject> history,
        Uri baseUri,
        string? concreteModelId = null,
        ModelHistoryCompatibility? compatibility = null
    )
    {
        var messages = new JsonArray();
        foreach (var raw in history)
        {
            var message = CanonicalMessage.FromNode(raw);
            if (!message.IsModelVisible)
                continue;
            var role =
                message.Role == "model" ? "assistant"
                : message.Role == "tool" ? "user"
                : message.Role;
            var blocks = new JsonArray();
            var parts = (raw["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
            JsonArray? Native(JsonObject part)
            {
                var metadata = (part["providerMeta"] as JsonObject)?["anthropic"] as JsonObject;
                return
                    message.Role == "model"
                    && concreteModelId is not null
                    && SessionWait.Text(metadata?["sourceModelId"]) is string source
                    && (compatibility ?? ModelHistoryCompatibility.Exact).Matches(
                        source,
                        concreteModelId
                    )
                    ? metadata?["contentBlocks"] as JsonArray
                    : null;
            }
            var nativeSearch = parts
                .SelectMany(part => (Native(part) ?? []).OfType<JsonObject>())
                .Any(block =>
                    SessionWait.Text(block["type"]) is "server_tool_use" or "web_search_tool_result"
                );
            foreach (var part in parts)
            {
                if (Native(part) is JsonArray native)
                {
                    foreach (var block in native)
                        blocks.Add(block?.DeepClone());
                    continue;
                }
                // Portable evidence is for other protocols/models. The native
                // continuation must replay the returned assistant blocks unchanged.
                if (
                    nativeSearch
                    && part["providerMeta"]?["anthropicSearchEvidence"]?.GetValue<bool>() == true
                )
                    continue;
                if (
                    message.Role == "tool"
                    && ProviderImageParts.IsImage(part)
                    && SessionWait.Text(part["toolUseId"]) is { Length: > 0 }
                )
                    continue;
                if (SessionWait.Text(part["imageMeta"]?["origin"]) == "generated")
                    blocks.Add(
                        new JsonObject
                        {
                            ["type"] = "text",
                            ["text"] = HostedResponsesTools.Placeholder(part),
                        }
                    );
                else
                    ProviderImageParts.AddOccurrence(blocks, part, "anthropic");
                if (
                    SessionWait.Text(part["thinking"]) is string
                    && CompletionsRequestSerializer.Truthy(part["providerMeta"]?["signature"])
                )
                    blocks.Add(
                        new JsonObject
                        {
                            ["type"] = "thinking",
                            ["thinking"] = part["thinking"]!.DeepClone(),
                            ["signature"] = part["providerMeta"]!["signature"]!.DeepClone(),
                        }
                    );
                if (SessionWait.Text(part["providerMeta"]?["redactedThinking"]) is string redacted)
                    blocks.Add(
                        new JsonObject { ["type"] = "redacted_thinking", ["data"] = redacted }
                    );
                if (SessionWait.Text(part["system"]) is { Length: > 0 } system)
                    blocks.Add(Text(OpenAIRequestText.System(system)));
                if (SessionWait.Text(part["text"]) is { Length: > 0 } text)
                    blocks.Add(Text(text));
                if (part["functionCall"] is JsonObject call)
                {
                    var id = SessionWait.Text(call["id"]);
                    if (string.IsNullOrEmpty(id))
                        throw new ModelPreparationException(
                            "Anthropic history has no stable call ID; the legacy/malformed fallback is not implemented."
                        );
                    blocks.Add(
                        new JsonObject
                        {
                            ["type"] = "tool_use",
                            ["id"] = id,
                            ["name"] = call["name"]?.DeepClone(),
                            ["input"] =
                                SessionWait.Text(call["argsParseError"]) is { Length: > 0 }
                                    ? JsonNode.Parse(
                                        FunctionCallArguments.Stringify(
                                            call["args"] as JsonObject,
                                            SessionWait.Text(call["rawArgsText"]),
                                            SessionWait.Text(call["argsParseError"])
                                        )
                                    )
                                : CompletionsRequestSerializer.Truthy(call["args"])
                                    ? call["args"]!.DeepClone()
                                : new JsonObject(),
                        }
                    );
                }
                if (part["functionResponse"] is JsonObject response)
                {
                    var id =
                        SessionWait.Text(response["tool_use_id"])
                        ?? SessionWait.Text(part["toolUseId"])
                        ?? "unknown";
                    var output = ToolResponseFormatting.Format(
                        CompletionsRequestSerializer.Truthy(response["response"])
                            ? response["response"]
                            : new JsonObject()
                    );
                    var prefix = OpenAIRequestText.PreviousRequest(response);
                    var associated = parts
                        .Where(image =>
                            ProviderImageParts.IsImage(image)
                            && SessionWait.Text(image["toolUseId"]) == id
                        )
                        .ToArray();
                    var resultContent = new JsonArray();
                    var textOutput = prefix is null
                        ? output
                        : prefix + (output.Length > 0 ? "\n" + output : "");
                    if (textOutput.Length > 0)
                        resultContent.Add(Text(textOutput));
                    foreach (var image in associated)
                    {
                        if (SessionWait.Text(image["text"]) is { Length: > 0 } label)
                            resultContent.Add(Text(label));
                        ProviderImageParts.AddOccurrence(resultContent, image, "anthropic");
                    }
                    var result = new JsonObject
                    {
                        ["type"] = "tool_result",
                        ["tool_use_id"] = id,
                        ["content"] =
                            associated.Length > 0 ? resultContent : JsonValue.Create(textOutput),
                    };
                    if (
                        baseUri.AbsoluteUri.StartsWith(
                            "https://api.kimi.com/",
                            StringComparison.Ordinal
                        )
                        && !blocks
                            .OfType<JsonObject>()
                            .Any(block => SessionWait.Text(block["type"]) == "thinking")
                    )
                        result["reasoning_content"] = "";
                    blocks.Add(result);
                }
            }
            JsonNode content =
                blocks.Count == 1
                && SessionWait.Text(blocks[0]?["type"]) == "text"
                && !parts.Any(part => Native(part) is not null)
                    ? blocks[0]!["text"]!.DeepClone()
                : blocks.Count == 0
                    ? CompletionsRequestSerializer.Truthy(raw["content"])
                            ? raw["content"]!.DeepClone()
                        : JsonValue.Create(" ")!
                : blocks;
            if (
                messages.LastOrDefault() is JsonObject previous
                && SessionWait.Text(previous["role"]) == role
            )
            {
                var merged = AsBlocks(previous["content"]);
                foreach (var block in AsBlocks(content))
                    merged.Add(block?.DeepClone());
                previous["content"] = merged;
            }
            else
                messages.Add(new JsonObject { ["role"] = role, ["content"] = content });
        }
        return messages;
    }

    internal static JsonObject BuildRequest(
        IEnumerable<JsonObject> history,
        ResponsesClientOptions options
    )
    {
        var body = new JsonObject
        {
            ["model"] = options.RequestModel,
            ["max_tokens"] = options.MaxOutputTokens,
            ["stream"] = true,
            ["cache_control"] = new JsonObject { ["type"] = "ephemeral" },
            ["system"] = options.Instructions,
            ["messages"] = ConvertHistory(
                history,
                options.BaseUri,
                options.ConcreteModelId,
                options.HistoryCompatibility
            ),
        };
        if (options.Tools is { Count: > 0 })
            body["tools"] = new JsonArray(
                options
                    .Tools.OfType<JsonObject>()
                    .Select(tool =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["name"] = tool["name"]?.DeepClone(),
                                ["description"] = tool["description"]?.DeepClone(),
                                ["input_schema"] = tool["parameters"]?.DeepClone(),
                            }
                    )
                    .ToArray()
            );
        if (BuildSearchTool(options.WebSearch) is JsonObject search)
        {
            var tools = body["tools"] as JsonArray ?? new JsonArray();
            tools.Add(search);
            if (tools.Parent is null)
                body["tools"] = tools;
        }
        if (options.ExtraFields is not null)
            foreach (var (key, value) in options.ExtraFields)
                body[key] = value?.DeepClone();
        if (body["stream"] is not JsonValue stream || !stream.TryGetValue<bool>(out _))
            throw new ModelPreparationException(
                "Anthropic extraFields.stream must be true or false."
            );
        if (options.Effort is "none")
        {
            body["thinking"] = new JsonObject { ["type"] = "disabled" };
            if (body["output_config"] is JsonObject output)
            {
                output.Remove("effort");
                if (output.Count == 0)
                    body.Remove("output_config");
            }
        }
        else if (options.Effort is not null)
        {
            var output = body["output_config"] as JsonObject ?? new JsonObject();
            output["effort"] = options.Effort;
            if (output.Parent is null)
                body["output_config"] = output;
        }
        return body;
    }

    internal static JsonObject? BuildSearchTool(JsonObject? config)
    {
        if (config?["enabled"]?.GetValue<bool>() != true)
            return null;
        // Basic direct search; newer versions implicitly enable code execution.
        var tool = new JsonObject { ["type"] = "web_search_20250305", ["name"] = "web_search" };
        if (config["allowedDomains"] is JsonArray { Count: > 0 } domains)
            tool["allowed_domains"] = domains.DeepClone();
        if (config["userLocation"] is JsonObject location)
        {
            var normalized = new JsonObject { ["type"] = "approximate" };
            foreach (var key in new[] { "country", "city", "region", "timezone" })
                if (SessionWait.Text(location[key]) is string value && value.Trim().Length > 0)
                    normalized[key] = value.Trim();
            tool["user_location"] = normalized;
        }
        return tool;
    }

    internal static bool HasSearchTool(JsonObject body) =>
        (body["tools"] as JsonArray)
            ?.OfType<JsonObject>()
            .Any(tool =>
                SessionWait.Text(tool["type"]) == "web_search_20250305"
                && SessionWait.Text(tool["name"]) == "web_search"
            ) == true;

    private static JsonObject Text(string value) => new() { ["type"] = "text", ["text"] = value };

    private static JsonArray AsBlocks(JsonNode? value) =>
        value is JsonArray array
            ? (JsonArray)array.DeepClone()
            : new JsonArray(
                Text(
                    SessionWait.Text(value)
                        ?? (value is JsonObject ? "[object Object]" : value?.ToJsonText() ?? "")
                )
            );
}
