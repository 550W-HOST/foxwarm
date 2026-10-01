using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal static class AnthropicRequestSerializer
{
    internal static JsonArray ConvertHistory(IEnumerable<JsonObject> history, Uri baseUri)
    {
        var messages = new JsonArray();
        foreach (var message in history.Select(CanonicalMessage.FromNode).Where(message => message.IsModelVisible))
        {
            var raw = message.ToJson();
            var role = message.Role == "model" ? "assistant" : message.Role == "tool" ? "user" : message.Role;
            var blocks = new JsonArray();
            foreach (var view in message.Parts)
            {
                var part = view.ToJson();
                if (part["inlineData"] is not null || part["inlineDataRef"] is not null)
                    throw new InvalidDataException("Anthropic native input/blob hydration is not implemented.");
                if (CompletionsRequestSerializer.Truthy(part["thinking"]) && CompletionsRequestSerializer.Truthy(part["providerMeta"]?["signature"]))
                    blocks.Add(new JsonObject { ["type"] = "thinking", ["thinking"] = part["thinking"]!.DeepClone(), ["signature"] = part["providerMeta"]!["signature"]!.DeepClone() });
                if (SessionWait.Text(part["system"]) is { Length: > 0 } system)
                    blocks.Add(Text(OpenAIRequestText.System(system)));
                if (SessionWait.Text(part["text"]) is { Length: > 0 } text) blocks.Add(Text(text));
                if (part["functionCall"] is JsonObject call)
                {
                    var id = SessionWait.Text(call["id"]);
                    if (string.IsNullOrEmpty(id)) throw new InvalidDataException("Anthropic history has no stable call ID; the legacy/malformed fallback is not implemented.");
                    blocks.Add(new JsonObject { ["type"] = "tool_use", ["id"] = id, ["name"] = call["name"]?.DeepClone(),
                        ["input"] = CompletionsRequestSerializer.Truthy(call["args"]) ? call["args"]!.DeepClone() : new JsonObject() });
                }
                if (part["functionResponse"] is JsonObject response)
                {
                    var id = SessionWait.Text(response["tool_use_id"]) ?? SessionWait.Text(part["toolUseId"]) ?? "unknown";
                    var output = ToolResponseFormatting.Format(CompletionsRequestSerializer.Truthy(response["response"]) ? response["response"] : new JsonObject());
                    var prefix = OpenAIRequestText.PreviousRequest(response);
                    var result = new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = id,
                        ["content"] = prefix is null ? output : prefix + (output.Length > 0 ? "\n" + output : "") };
                    if (baseUri.AbsoluteUri.StartsWith("https://api.kimi.com/", StringComparison.Ordinal)
                        && !blocks.OfType<JsonObject>().Any(block => SessionWait.Text(block["type"]) == "thinking")) result["reasoning_content"] = "";
                    blocks.Add(result);
                }
            }
            JsonNode content = blocks.Count == 1 && SessionWait.Text(blocks[0]?["type"]) == "text"
                ? blocks[0]!["text"]!.DeepClone()
                : blocks.Count == 0 ? CompletionsRequestSerializer.Truthy(raw["content"]) ? raw["content"]!.DeepClone() : JsonValue.Create(" ")! : blocks;
            if (messages.LastOrDefault() is JsonObject previous && SessionWait.Text(previous["role"]) == role)
            {
                var merged = AsBlocks(previous["content"]);
                foreach (var block in AsBlocks(content)) merged.Add(block?.DeepClone());
                previous["content"] = merged;
            }
            else messages.Add(new JsonObject { ["role"] = role, ["content"] = content });
        }
        return messages;
    }

    internal static JsonObject BuildRequest(IEnumerable<JsonObject> history, ResponsesClientOptions options)
    {
        var body = new JsonObject { ["model"] = options.RequestModel, ["max_tokens"] = options.MaxOutputTokens,
            ["system"] = options.Instructions, ["messages"] = ConvertHistory(history, options.BaseUri) };
        if (options.Tools is { Count: > 0 }) body["tools"] = new JsonArray(options.Tools.OfType<JsonObject>().Select(tool => (JsonNode)new JsonObject
        {
            ["name"] = tool["name"]?.DeepClone(), ["description"] = tool["description"]?.DeepClone(), ["input_schema"] = tool["parameters"]?.DeepClone()
        }).ToArray());
        if (options.ExtraFields is not null) foreach (var (key, value) in options.ExtraFields) body[key] = value?.DeepClone();
        if (options.Effort is "none")
        {
            body["thinking"] = new JsonObject { ["type"] = "disabled" };
            if (body["output_config"] is JsonObject output)
            {
                output.Remove("effort");
                if (output.Count == 0) body.Remove("output_config");
            }
        }
        else if (options.Effort is not null)
        {
            var output = body["output_config"] as JsonObject ?? new JsonObject();
            output["effort"] = options.Effort;
            if (output.Parent is null) body["output_config"] = output;
        }
        return body;
    }

    private static JsonObject Text(string value) => new() { ["type"] = "text", ["text"] = value };
    private static JsonArray AsBlocks(JsonNode? value) => value is JsonArray array ? (JsonArray)array.DeepClone()
        : new JsonArray(Text(SessionWait.Text(value) ?? (value is JsonObject ? "[object Object]" : value?.ToJsonString() ?? "")));
}
