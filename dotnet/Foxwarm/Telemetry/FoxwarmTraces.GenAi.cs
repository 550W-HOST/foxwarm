using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Telemetry;

internal sealed partial class FoxwarmTraces
{
    private const int FieldBytes = 16 * 1024;
    private static readonly JsonSerializerOptions ContentJson = new()
    {
        Encoder = JsonText.Encoder,
        TypeInfoResolver = MainJsonContext.Default,
    };

    internal Activity? StartModel(
        string sessionId,
        ConcreteHostModel leaf,
        string providerType,
        string route,
        string purpose,
        int attempt,
        JsonNode payload
    )
    {
        var body = payload as JsonObject;
        var model = Text(body, "model") ?? leaf.UpstreamModelId;
        var operation =
            providerType == ImageGenerationRequests.ImagesApiProviderType
                ? "generate_content"
                : "chat";
        var span = Start($"{operation} {model}", ActivityKind.Client, sessionId);
        if (span is null)
            return null;
        span.SetTag("gen_ai.operation.name", operation);
        span.SetTag("gen_ai.request.model", model);
        // For compatible APIs the configured provider identifier is the only known vendor identity.
        span.SetTag("gen_ai.provider.name", leaf.ProviderKey);
        span.SetTag("foxwarm.model.api", providerType);
        span.SetTag("foxwarm.model.route", route);
        span.SetTag("foxwarm.model.purpose", purpose);
        span.SetTag("foxwarm.model.attempt", attempt);
        if (operation == "generate_content")
            span.SetTag("gen_ai.output.type", "image");
        if (body is not null)
            CaptureRequest(span, body);
        return span;
    }

    internal void CompleteModel(Activity? span, ChatResult result)
    {
        if (span is null)
            return;
        var usage = result.Usage;
        var input = SessionWait.Number(usage?["inputTokens"]);
        var cached = SessionWait.Number(usage?["cachedTokens"]);
        Count(
            "gen_ai.usage.input_tokens",
            input is null && cached is null ? null : (input ?? 0) + (cached ?? 0)
        );
        Count("gen_ai.usage.cache_read.input_tokens", cached);
        Count("gen_ai.usage.output_tokens", SessionWait.Number(usage?["outputTokens"]));
        Count(
            "gen_ai.usage.reasoning.output_tokens",
            SessionWait.Number(usage?["reasoningTokens"])
        );
        if (result.TruncatedStopReason is { } reason)
            span.SetTag("gen_ai.response.finish_reasons", new[] { reason });
        if (content.OutputMessages)
            SetList(span, "gen_ai.output.messages", OutputMessages(result));

        void Count(string name, double? count)
        {
            if (count is >= 0 and < long.MaxValue)
                span.SetTag(name, (long)count.Value);
        }
    }

    internal Activity? StartTool(string sessionId, JsonObject call)
    {
        var name = Text(call, "name") ?? "unknown";
        var span = Start($"execute_tool {name}", ActivityKind.Internal, sessionId);
        if (span is null)
            return null;
        span.SetTag("gen_ai.operation.name", "execute_tool");
        span.SetTag("gen_ai.tool.name", name);
        span.SetTag("gen_ai.tool.type", "function");
        span.SetTag("gen_ai.tool.call.id", Text(call, "id"));
        span.SetTag("foxwarm.tool.started", false);
        if (content.ToolArguments)
            SetValue(
                span,
                "gen_ai.tool.call.arguments",
                call["args"] ?? ParseArguments(call["rawArgsText"])
            );
        return span;
    }

    internal static void SetToolTarget(Activity? span, string? source, string? name, string? node)
    {
        span?.SetTag("foxwarm.tool.source", source);
        span?.SetTag("foxwarm.tool.resolved_name", name);
        span?.SetTag("foxwarm.tool.node", node);
    }

    internal void CompleteTool(Activity? span, TurnToolExecution result, bool started)
    {
        if (span is null)
            return;
        span.SetTag("foxwarm.tool.started", started);
        if (result.Target is { } target)
            SetToolTarget(span, Text(target, "source"), Text(target, "name"), Text(target, "node"));
        var value = result.Response;
        var code = ToolFailure.Code(value);
        if (
            code == "tool_call_cancelled"
            || (value as JsonObject)?["canceled"] is JsonValue cancelled
                && cancelled.TryGetValue<bool>(out var flag)
                && flag
        )
            End(span, "cancelled", code ?? "tool_call_cancelled");
        else if (code == "tool_call_skipped" || !started)
            End(span, "skipped", code ?? "tool_call_not_started");
        else if (
            Text(result.Target, "source") == "mcp"
            && (value as JsonObject)?["isError"] is JsonValue failure
            && failure.TryGetValue<bool>(out var isError)
            && isError
        )
            End(span, "failed", "mcp_tool_error");
        else if ((value as JsonObject)?["error"] is not null)
            End(span, "failed", code ?? "tool_error");
        else
            End(span, "completed");
        if (started && content.ToolResults)
            SetValue(span, "gen_ai.tool.call.result", value);
    }

    private void CaptureRequest(Activity span, JsonObject body)
    {
        if (content.SystemPrompt)
            SetList(span, "gen_ai.system_instructions", SystemInstructions(body));
        if (content.InputMessages)
        {
            // Keep the newest messages when a long history exceeds the field budget, and
            // restore chronological order for the retained records.
            SetList(
                span,
                "gen_ai.input.messages",
                InputMessagesNewestFirst(body),
                newestFirst: true
            );
        }
        if (content.ToolDefinitions)
            SetList(span, "gen_ai.tool.definitions", ToolDefinitions(body));
    }

    private static IEnumerable<JsonObject> SystemInstructions(JsonObject body)
    {
        foreach (var value in new[] { body["instructions"], body["system"] })
        foreach (var part in TextParts(value))
            yield return part;
        foreach (var message in Objects(body["messages"] ?? body["input"]))
            if (Text(message, "role") is "system" or "developer")
                foreach (var part in TextParts(message["content"]))
                    yield return part;
    }

    private IEnumerable<JsonObject> InputMessagesNewestFirst(JsonObject body)
    {
        if (Text(body, "prompt") is { } prompt)
            yield return Message("user", [TextPart(prompt)]);
        var input = body["messages"] ?? body["input"];
        if (SessionWait.Text(input) is { } text)
            yield return Message("user", [TextPart(text)]);
        if (input is not JsonArray history)
            yield break;
        for (var i = history.Count - 1; i >= 0; i--)
        {
            if (history[i] is not JsonObject item)
                continue;
            var role = Text(item, "role");
            if (role is "system" or "developer")
                continue;
            var parts = WireParts(item).ToArray();
            if (parts.Length == 0)
                continue;
            role ??= Text(item, "type") == "function_call_output" ? "tool" : "assistant";
            yield return Message(role, parts);
        }
    }

    private IEnumerable<JsonObject> WireParts(JsonObject item)
    {
        var type = Text(item, "type");
        var role = Text(item, "role");
        if (type is "function_call" or "function_call_output" or "reasoning")
        {
            foreach (var part in WireBlock(item))
                yield return part;
            yield break;
        }
        if (role == "tool")
        {
            if (content.ToolResults)
                yield return ToolResponse(Text(item, "tool_call_id"), item["content"]);
            yield break;
        }
        if (
            content.Reasoning
            && (Text(item, "reasoning_content") ?? Text(item, "reasoning")) is { } thought
        )
            yield return TextPart(thought, "reasoning");
        if (Text(item, "content") is { } text)
            yield return TextPart(text);
        foreach (var block in Objects(item["content"]))
        foreach (var part in WireBlock(block))
            yield return part;
        foreach (var call in Objects(item["tool_calls"]))
            if (call["function"] is JsonObject function && Text(function, "name") is { } name)
                yield return ToolCall(Text(call, "id"), name, function["arguments"]);
    }

    private IEnumerable<JsonObject> WireBlock(JsonObject block)
    {
        switch (Text(block, "type"))
        {
            case "text" or "input_text" or "output_text" when Text(block, "text") is { } text:
                yield return TextPart(text);
                break;
            case "image" when block["source"] is JsonObject source:
                if (Text(source, "data") is { } data)
                    yield return ImagePart(Text(source, "media_type"), data);
                else if (Text(source, "url") is { } url)
                    yield return ImageUri(url);
                break;
            case "image_url"
            or "input_image"
                when (Text(block, "image_url") ?? Text(block["image_url"] as JsonObject, "url"))
                    is { } url:
                yield return ImageUri(url);
                break;
            case "thinking" when content.Reasoning && Text(block, "thinking") is { } thought:
                yield return TextPart(thought, "reasoning");
                break;
            case "reasoning" when content.Reasoning:
                foreach (var part in Objects(block["summary"]))
                    if (Text(part, "text") is { } summary)
                        yield return TextPart(summary, "reasoning");
                break;
            case "tool_use" or "function_call" when Text(block, "name") is { } name:
                yield return ToolCall(
                    Text(block, "call_id") ?? Text(block, "id"),
                    name,
                    block["input"] ?? block["arguments"]
                );
                break;
            case "tool_result" or "function_call_output" when content.ToolResults:
                yield return ToolResponse(
                    Text(block, "tool_use_id") ?? Text(block, "call_id"),
                    block["content"] ?? block["output"]
                );
                break;
        }
    }

    private static IEnumerable<JsonObject> ToolDefinitions(JsonObject body)
    {
        foreach (var tool in Objects(body["tools"]))
        {
            var definition = tool["function"] as JsonObject ?? tool;
            var type = Text(tool, "type") ?? "function";
            yield return new JsonObject
            {
                ["type"] = type,
                ["name"] = Text(definition, "name") ?? type,
                ["description"] = Text(definition, "description"),
                ["parameters"] = (
                    definition["parameters"] ?? definition["input_schema"]
                )?.DeepClone(),
            };
        }
    }

    private IEnumerable<JsonObject> OutputMessages(ChatResult result)
    {
        var parts = new List<JsonObject>();
        var hasToolCall = false;
        foreach (var message in result.CommittedSegments.Append(result.AssistantMessage))
        foreach (var part in Objects(message?["parts"]))
        {
            if (Text(part, "text") is { } text)
                parts.Add(TextPart(text));
            if (part["inlineData"] is JsonObject image)
                parts.Add(ImagePart(Text(image, "mimeType"), Text(image, "data")));
            else if (part["inlineDataRef"] is JsonObject imageRef)
                parts.Add(ImagePart(Text(imageRef, "mimeType"), null));
            if (content.Reasoning && Text(part, "thinking") is { } thought)
                parts.Add(TextPart(thought, "reasoning"));
            if (part["functionCall"] is JsonObject call && Text(call, "name") is { } name)
            {
                hasToolCall = true;
                parts.Add(ToolCall(Text(call, "id"), name, call["args"] ?? call["rawArgsText"]));
            }
        }
        if (parts.Count > 0)
        {
            var message = Message("assistant", parts);
            message["finish_reason"] = result.TruncatedStopReason switch
            {
                "max_tokens" or "model_context_window_exceeded" => "length",
                _ => hasToolCall ? "tool_call" : "stop",
            };
            yield return message;
        }
    }

    private JsonObject ToolCall(string? id, string name, JsonNode? args)
    {
        var part = new JsonObject
        {
            ["type"] = "tool_call",
            ["id"] = id,
            ["name"] = name,
        };
        if (content.ToolArguments)
            part["arguments"] = ParseArguments(args)?.DeepClone();
        return part;
    }

    private static JsonNode? ParseArguments(JsonNode? raw)
    {
        if (SessionWait.Text(raw) is not { } text)
            return raw;
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return JsonValue.Create(text);
        }
    }

    private static JsonObject ToolResponse(string? id, JsonNode? value) =>
        new()
        {
            ["type"] = "tool_call_response",
            ["id"] = id,
            ["response"] = value?.DeepClone(),
        };

    private static IEnumerable<JsonObject> TextParts(JsonNode? value)
    {
        if (SessionWait.Text(value) is { Length: > 0 } text)
            yield return TextPart(text);
        foreach (var part in Objects(value))
            if (Text(part, "text") is { Length: > 0 } block)
                yield return TextPart(block);
    }

    private static IEnumerable<JsonObject> Objects(JsonNode? node) =>
        node is JsonArray array ? array.OfType<JsonObject>() : [];

    private static string? Text(JsonObject? node, string key) => SessionWait.Text(node?[key]);

    private static JsonObject TextPart(string text, string type = "text") =>
        new() { ["type"] = type, ["content"] = Prefix(text, FieldBytes) };

    private static JsonObject ImagePart(string? mimeType, string? encoded)
    {
        var part = new JsonObject
        {
            ["type"] = "blob",
            ["modality"] = "image",
            ["mime_type"] = mimeType,
        };
        if (encoded?.Length is > 0 and < FieldBytes - 256)
            part["content"] = encoded;
        else
            part["type"] = "truncated_image";
        return part;
    }

    private static JsonObject ImageUri(string uri)
    {
        const string separator = ";base64,";
        var data = uri.StartsWith("data:", StringComparison.Ordinal)
            ? uri.IndexOf(separator, StringComparison.Ordinal)
            : -1;
        if (data >= 5)
            return ImagePart(
                uri[5..data],
                uri.Length < FieldBytes ? uri[(data + separator.Length)..] : null
            );
        return new JsonObject
        {
            ["type"] = "uri",
            ["modality"] = "image",
            ["uri"] = Prefix(uri, FieldBytes / 8),
        };
    }

    private static JsonObject Message(string role, IEnumerable<JsonObject> parts) =>
        new() { ["role"] = role, ["parts"] = new JsonArray(parts.Cast<JsonNode>().ToArray()) };

    private static string Prefix(string value, int maxChars)
    {
        if (value.Length <= maxChars)
            return value;
        var end = maxChars - 1;
        if (char.IsHighSurrogate(value[end - 1]))
            end--;
        return value[..end] + "…";
    }

    private static void SetList(
        Activity span,
        string key,
        IEnumerable<JsonObject> records,
        bool newestFirst = false
    )
    {
        var rows = new List<string>();
        var size = 2;
        foreach (var record in records)
        {
            var remaining = FieldBytes - size - (rows.Count == 0 ? 0 : 1);
            var json = FitRecord(record, remaining);
            if (json is null)
            {
                if (rows.Count != 0)
                    break;
                continue;
            }
            var bytes = Encoding.UTF8.GetByteCount(json);
            rows.Add(json);
            size = FieldBytes - remaining + bytes;
        }
        if (rows.Count == 0)
            return;
        if (newestFirst)
            rows.Reverse();
        span.SetTag(key, "[" + string.Join(',', rows) + "]");
    }

    private static string? FitRecord(JsonObject record, int budget)
    {
        if (budget < 32)
            return null;
        if (record["parts"] is not JsonArray parts)
            return FitPart(record, budget);

        // Keep the message envelope and fit a prefix of complete parts, shortening
        // a text part that crosses the remaining budget.
        var empty = new JsonArray();
        record["parts"] = empty;
        var envelope = record.ToJsonString(ContentJson);
        var used = Encoding.UTF8.GetByteCount(envelope);
        foreach (var node in parts)
        {
            if (node is not JsonObject part)
                continue;
            var separator = empty.Count == 0 ? 0 : 1;
            var json = FitPart(part, budget - used - separator);
            if (json is null)
                break;
            empty.Add((JsonNode)part.DeepClone());
            used += separator + Encoding.UTF8.GetByteCount(json);
        }
        return empty.Count == 0 ? null : record.ToJsonString(ContentJson);
    }

    private static string? FitPart(JsonObject part, int budget)
    {
        if (budget < 16)
            return null;
        var json = part.ToJsonString(ContentJson);
        if (Encoding.UTF8.GetByteCount(json) <= budget)
            return json;
        if (
            Text(part, "type") is not ("text" or "reasoning")
            || Text(part, "content") is not { } text
        )
            return null;
        for (var chars = Math.Min(text.Length / 2, budget); chars > 1; chars /= 2)
        {
            part["content"] = Prefix(text, chars);
            json = part.ToJsonString(ContentJson);
            if (Encoding.UTF8.GetByteCount(json) <= budget)
                return json;
        }
        return null;
    }

    private static void SetValue(Activity span, string key, JsonNode? value)
    {
        if (value is null)
            return;
        var json = value.ToJsonString(ContentJson);
        if (Encoding.UTF8.GetByteCount(json) > FieldBytes)
            json = new JsonObject
            {
                ["truncated"] = true,
                ["preview"] = Prefix(json, FieldBytes / 8),
            }.ToJsonString(ContentJson);
        span.SetTag(key, json);
    }
}
