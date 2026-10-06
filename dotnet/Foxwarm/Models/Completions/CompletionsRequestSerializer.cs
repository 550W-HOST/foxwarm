using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal static class CompletionsRequestSerializer
{
    internal static JsonArray ConvertHistory(
        IReadOnlyList<JsonObject> history,
        string concreteModelId,
        string reasoningField
    )
    {
        var result = new JsonArray();
        var pendingToolImages = new JsonArray();
        void FlushToolImages()
        {
            if (pendingToolImages.Count == 0)
                return;
            result.Add(
                new JsonObject { ["role"] = "user", ["content"] = pendingToolImages.DeepClone() }
            );
            pendingToolImages.Clear();
        }
        foreach (var raw in history)
        {
            var message = CanonicalMessage.FromNode(raw);
            if (!message.IsModelVisible)
                continue;
            var parts = (raw["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
            if (message.Role == "tool")
            {
                foreach (var group in ProviderImageParts.ToolGroups(parts))
                {
                    var all = ProviderImageParts.GroupBlocks(
                        group.Parts.Where(part => !ProviderImageParts.IsImage(part)),
                        "completions"
                    );
                    var texts = new JsonArray(
                        all.OfType<JsonObject>()
                            .Where(block => SessionWait.Text(block["type"]) == "text")
                            .Select(block => (JsonNode)block.DeepClone())
                            .ToArray()
                    );
                    JsonNode toolContent =
                        texts.Count == 0 ? JsonValue.Create("")!
                        : texts.Count == 1 ? texts[0]!["text"]!.DeepClone()
                        : texts;
                    result.Add(
                        new JsonObject
                        {
                            ["role"] = "tool",
                            ["tool_call_id"] = group.Id,
                            ["content"] = toolContent,
                        }
                    );
                    var images = ProviderImageParts.GroupBlocks(
                        group.Parts.Where(ProviderImageParts.IsImage),
                        "completions"
                    );
                    if (images.Count > 0)
                    {
                        pendingToolImages.Add(
                            new JsonObject
                            {
                                ["type"] = "text",
                                ["text"] = "Images returned by tool_call_id=" + group.Id + ":",
                            }
                        );
                        foreach (var image in images)
                            pendingToolImages.Add(image?.DeepClone());
                    }
                }
                continue;
            }
            FlushToolImages();
            var role = message.Role == "model" ? "assistant" : message.Role;
            if (
                role == "user"
                && parts.Length > 1
                && parts.All(part =>
                    (part.ContainsKey("text") || part.ContainsKey("system"))
                    && !Truthy(part["thinking"])
                    && !Truthy(part["functionCall"])
                    && !Truthy(part["functionResponse"])
                    && !Truthy(part["inlineData"])
                )
            )
                parts =
                [
                    new JsonObject
                    {
                        ["text"] = string.Join(
                            "\n",
                            parts
                                .Select(part =>
                                    part.ContainsKey("system")
                                        ? OpenAIRequestText.System(
                                            SessionWait.Text(part["system"])
                                                ?? throw new ModelPreparationException(
                                                    "System content must be a string."
                                                )
                                        )
                                        : SessionWait.Text(part["text"])
                                )
                                .Where(text => !string.IsNullOrEmpty(text))
                        ),
                    },
                ];
            var content = new JsonArray();
            var calls = new JsonArray();
            string? thinking = null;
            foreach (var part in parts)
            {
                if (SessionWait.Text(part["thinking"]) is { Length: > 0 } thought)
                    thinking = thought;
                if (SessionWait.Text(part["system"]) is { Length: > 0 } system)
                    content.Add(
                        new JsonObject
                        {
                            ["type"] = "text",
                            ["text"] = OpenAIRequestText.System(system),
                        }
                    );
                if (SessionWait.Text(part["text"]) is { Length: > 0 } text)
                    content.Add(new JsonObject { ["type"] = "text", ["text"] = text });
                if (SessionWait.Text(part["imageMeta"]?["origin"]) != "generated")
                    ProviderImageParts.AddOccurrence(content, part, "completions");
                if (part["functionCall"] is JsonObject call)
                {
                    var id = SessionWait.Text(call["id"]);
                    if (string.IsNullOrEmpty(id))
                        throw new ModelPreparationException(
                            "Chat Completions function call needs a stable ID; the legacy fallback is not implemented."
                        );
                    calls.Add(
                        new JsonObject
                        {
                            ["id"] = id,
                            ["type"] = "function",
                            ["function"] = new JsonObject
                            {
                                ["name"] = SessionWait.Text(call["name"]) ?? "",
                                ["arguments"] = FunctionCallArguments.Stringify(
                                    call["args"] as JsonObject,
                                    SessionWait.Text(call["rawArgsText"]),
                                    SessionWait.Text(call["argsParseError"])
                                ),
                            },
                        }
                    );
                }
            }
            var wire = new JsonObject { ["role"] = role };
            if (!string.IsNullOrEmpty(thinking))
                wire[reasoningField] = thinking;
            wire["content"] =
                content.Count == 1 && SessionWait.Text(content[0]?["type"]) == "text"
                    ? content[0]?["text"]?.DeepClone()
                : content.Count > 0 ? content
                : raw["content"]?.DeepClone() ?? JsonValue.Create("");
            if (calls.Count > 0)
                wire["tool_calls"] = calls;
            if (
                role == "assistant"
                && SessionWait.Text(raw["providerMeta"]?["sourceModelId"]) == concreteModelId
                && raw["providerMeta"]?["providerSpecificFields"] is JsonObject fields
            )
                wire["provider_specific_fields"] = fields.DeepClone();
            result.Add(wire);
        }
        FlushToolImages();
        return result;
    }

    internal static JsonObject BuildRequest(
        IReadOnlyList<JsonObject> history,
        ResponsesClientOptions options,
        string reasoningField,
        string promptCacheKey
    )
    {
        var messages = ConvertHistory(history, options.ConcreteModelId, reasoningField);
        if (OpenAIRequestText.Trim(options.Instructions).Length > 0)
            messages.Insert(
                0,
                new JsonObject { ["role"] = "system", ["content"] = options.Instructions }
            );
        var body = new JsonObject
        {
            ["model"] = options.RequestModel,
            ["max_tokens"] = options.MaxOutputTokens,
            ["prompt_cache_key"] = promptCacheKey,
            ["stream"] = true,
            ["stream_options"] = new JsonObject { ["include_usage"] = true },
            ["messages"] = messages,
        };
        if (options.Tools is { Count: > 0 } tools)
            body["tools"] = new JsonArray(
                tools
                    .OfType<JsonObject>()
                    .Select(tool =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["type"] = "function",
                                ["function"] = new JsonObject
                                {
                                    ["name"] = tool["name"]?.DeepClone(),
                                    ["description"] = tool["description"]?.DeepClone(),
                                    ["parameters"] = tool["parameters"]?.DeepClone(),
                                    ["strict"] = false,
                                },
                            }
                    )
                    .ToArray()
            );
        if (options.ExtraFields is not null)
            foreach (var (key, value) in options.ExtraFields)
                body[key] = value?.DeepClone();
        if (options.Effort is not null)
            body["reasoning_effort"] = options.Effort;
        return body;
    }

    internal static bool Truthy(JsonNode? value) =>
        value is JsonObject or JsonArray
        || value is JsonValue scalar
            && (
                scalar.TryGetValue<string>(out var text) ? text.Length > 0
                : scalar.TryGetValue<bool>(out var flag) ? flag
                : SessionWait.Number(value) is double number && number != 0 && !double.IsNaN(number)
            );
}
