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
        JsonNode payload,
        string? requestId = null,
        int? journalAttempt = null
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
        SetJournal(span, requestId, journalAttempt);
        if (
            body is not null
            && (content.SystemPrompt || content.InputMessages || content.ToolDefinitions)
        )
            CaptureContent(span, () => CaptureRequest(span, body));
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
        if (result.FinishReason is { } reason)
            span.SetTag("gen_ai.response.finish_reasons", new[] { reason });
        if (
            content.OutputMessages
            && (result.UsedTextRedaction ? result.TraceWireResult : result) is { } wire
        )
            RecordOutput(span, wire);

        void Count(string name, double? count)
        {
            if (count is >= 0 and < long.MaxValue)
                span.SetTag(name, (long)count.Value);
        }
    }

    internal bool NeedsWireResult => content.OutputMessages || content.ToolArguments;
    internal bool CaptureArguments => content.ToolArguments;

    private void RecordOutput(Activity span, ChatResult wire)
    {
        CaptureContent(
            span,
            () =>
                Record(
                    span,
                    "gen_ai.output.messages",
                    field =>
                    {
                        var parts = OutputParts(field, wire).ToArray();
                        if (parts.Length == 0)
                            return null;
                        var message = Message("assistant", parts);
                        if (wire.FinishReason is not null)
                            message["finish_reason"] = wire.FinishReason;
                        return new JsonArray(message);
                    }
                )
        );
    }

    internal static void SetJournal(Activity? span, string? requestId, int? attempt)
    {
        if (span is null || requestId is null)
            return;
        span.SetTag("foxwarm.journal.request.id", requestId);
        if (attempt is not null)
            span.SetTag("foxwarm.journal.attempt", attempt.Value);
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
        return span;
    }

    internal static void SetToolTarget(Activity? span, string? source, string? name, string? node)
    {
        span?.SetTag("foxwarm.tool.source", source);
        span?.SetTag("foxwarm.tool.resolved_name", name);
        span?.SetTag("foxwarm.tool.node", node);
    }

    // Observe the MCP envelope before large results become abbreviated tool output.
    internal static void ObserveMcpResult(Activity? span, JsonNode? result)
    {
        if (
            span is not null
            && (result as JsonObject)?["isError"] is JsonValue failure
            && failure.TryGetValue<bool>(out var isError)
            && isError
        )
            span.SetTag("error.type", "mcp_tool_error");
    }

    internal void CompleteTool(
        Activity? span,
        TurnToolExecution result,
        bool started,
        bool captureResult = true
    )
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
        else if (span.GetTagItem("error.type") is string mcpError)
            End(span, "failed", mcpError);
        else if ((value as JsonObject)?["error"] is not null)
            End(span, "failed", code ?? "tool_error");
        else
            End(span, "completed");
        if (started && captureResult && content.ToolResults)
            CaptureContent(
                span,
                () => Record(span, "gen_ai.tool.call.result", field => field.Copy(value))
            );
    }

    // Content is optional telemetry. A projection or serialization failure must not
    // change the provider attempt or tool result that supplied the value.
    private static void CaptureContent(Activity span, Action project)
    {
        try
        {
            project();
        }
        catch (Exception)
        {
            span.SetTag("foxwarm.content.capture_failed", true);
        }
    }

    private void CaptureRequest(Activity span, JsonObject body)
    {
        if (content.SystemPrompt)
            Record(
                span,
                "gen_ai.system_instructions",
                field => field.Records(SystemInstructions(field, body))
            );
        if (content.InputMessages)
            Record(
                span,
                "gen_ai.input.messages",
                field => field.Records(InputMessages(field, body), newestFirst: true)
            );
        if (content.ToolDefinitions)
            Record(
                span,
                "gen_ai.tool.definitions",
                field => field.Records(ToolDefinitions(field, body))
            );
    }

    private static IEnumerable<JsonObject> SystemInstructions(TraceField field, JsonObject body)
    {
        foreach (var key in new[] { "instructions", "system" })
        {
            if (field.Text(body[key]) is { } text)
                yield return field.Part(text);
            foreach (var part in field.Objects(body[key]))
                if (field.Text(part["text"]) is { } block)
                    yield return field.Part(block);
        }
        foreach (var item in field.Objects(body["messages"] ?? body["input"]))
            if (TraceField.Token(item["role"]) is "system" or "developer")
            {
                if (field.Text(item["content"]) is { } text)
                    yield return field.Part(text);
                foreach (var part in field.Objects(item["content"]))
                    if (field.Text(part["text"]) is { } block)
                        yield return field.Part(block);
            }
    }

    private IEnumerable<JsonObject> InputMessages(TraceField field, JsonObject body)
    {
        var history = body["input"] ?? body["messages"];
        if (field.Text(history) is { } direct)
            yield return Message("user", [field.Part(direct)]);
        if (field.Text(body["prompt"]) is { } prompt)
            yield return Message("user", [field.Part(prompt)]);
        foreach (var item in field.Objects(history, reverse: true))
        {
            var role = TraceField.Token(item["role"]);
            if (role is "system" or "developer")
                continue;
            var parts = WireParts(field, item).ToArray();
            if (parts.Length != 0)
                yield return Message(
                    role
                        ?? (
                            TraceField.Token(item["type"]) == "function_call_output"
                                ? "tool"
                                : "assistant"
                        ),
                    parts
                );
        }
    }

    private IEnumerable<JsonObject> WireParts(TraceField field, JsonObject item)
    {
        if (
            TraceField.Token(item["type"])
            is "function_call"
                or "function_call_output"
                or "reasoning"
        )
        {
            foreach (var part in WireBlock(field, item))
                yield return part;
            yield break;
        }
        if (TraceField.Token(item["role"]) == "tool")
        {
            if (content.ToolResults)
                yield return ToolResponse(field, item["tool_call_id"], item["content"]);
            yield break;
        }
        if (
            content.Reasoning
            && field.Text(item["reasoning_content"] ?? item["reasoning"]) is { } thought
        )
            yield return field.Part(thought, "reasoning");
        if (field.Text(item["content"]) is { } text)
            yield return field.Part(text);
        foreach (var block in field.Objects(item["content"]))
        foreach (var part in WireBlock(field, block))
            yield return part;
        foreach (var call in field.Objects(item["tool_calls"]))
            if (call["function"] is JsonObject function)
                yield return ToolCall(field, call["id"], function["name"]);
    }

    private IEnumerable<JsonObject> WireBlock(TraceField field, JsonObject block)
    {
        switch (TraceField.Token(block["type"]))
        {
            case "text" or "input_text" or "output_text" when field.Text(block["text"]) is { } text:
                yield return field.Part(text);
                break;
            case "image" when block["source"] is JsonObject source:
                yield return field.Image(source["media_type"], source["data"], source["url"]);
                break;
            case "image_url" or "input_image":
                yield return field.Image(
                    null,
                    null,
                    block["image_url"] is JsonObject image ? image["url"] : block["image_url"]
                );
                break;
            case "thinking" when content.Reasoning && field.Text(block["thinking"]) is { } thought:
                yield return field.Part(thought, "reasoning");
                break;
            case "reasoning" when content.Reasoning:
                foreach (var part in field.Objects(block["summary"]))
                    if (field.Text(part["text"]) is { } summary)
                        yield return field.Part(summary, "reasoning");
                break;
            case "tool_use" or "function_call":
                yield return ToolCall(field, block["call_id"] ?? block["id"], block["name"]);
                break;
            case "tool_result" or "function_call_output" when content.ToolResults:
                yield return ToolResponse(
                    field,
                    block["tool_use_id"] ?? block["call_id"],
                    block["content"] ?? block["output"]
                );
                break;
        }
    }

    private static IEnumerable<JsonObject> ToolDefinitions(TraceField field, JsonObject body)
    {
        foreach (var tool in field.Objects(body["tools"]))
        {
            var definition = tool["function"] as JsonObject ?? tool;
            var type = field.Text(tool["type"]) ?? "function";
            yield return new JsonObject
            {
                ["type"] = type,
                ["name"] = field.Text(definition["name"]) ?? type,
                ["description"] = field.Text(definition["description"]),
                ["parameters"] = field.Copy(definition["parameters"] ?? definition["input_schema"]),
            };
        }
    }

    private IEnumerable<JsonObject> OutputParts(TraceField field, ChatResult result)
    {
        foreach (var message in result.CommittedSegments.Append(result.AssistantMessage))
        {
            if (!field.Visit())
                yield break;
            foreach (var part in field.Objects(message?["parts"]))
            {
                if (field.Text(part["text"]) is { } text)
                    yield return field.Part(text);
                if (part["inlineData"] is JsonObject image)
                    yield return field.Image(image["mimeType"], image["data"], null);
                else if (part["inlineDataRef"] is JsonObject imageRef)
                    yield return field.Image(imageRef["mimeType"], null, null);
                if (content.Reasoning && field.Text(part["thinking"]) is { } thought)
                    yield return field.Part(thought, "reasoning");
                if (part["functionCall"] is JsonObject call)
                    yield return ToolCall(field, call["id"], call["name"]);
            }
        }
    }

    private static JsonObject ToolCall(TraceField field, JsonNode? id, JsonNode? name) =>
        new()
        {
            ["type"] = "tool_call",
            ["id"] = field.Text(id),
            ["name"] = field.Text(name),
        };

    private static JsonObject ToolResponse(TraceField field, JsonNode? id, JsonNode? value) =>
        new()
        {
            ["type"] = "tool_call_response",
            ["id"] = field.Text(id),
            ["response"] = field.Copy(value),
        };

    private static JsonObject Message(string role, JsonObject[] parts) =>
        new() { ["role"] = role, ["parts"] = new JsonArray(parts) };

    private static string? Text(JsonObject? node, string key) => SessionWait.Text(node?[key]);

    private static void Record(Activity span, string key, Func<TraceField, JsonNode?> project)
    {
        var field = new TraceField();
        if (project(field) is not { } projected)
            return;
        var json = projected.ToJsonString(ContentJson);
        span.SetTag(
            key,
            Encoding.UTF8.GetByteCount(json) <= FieldBytes ? json : "{\"truncated\":true}"
        );
    }

    internal void RecordArguments(
        Activity span,
        JsonObject args,
        bool omitValue,
        Foxwarm.Secrets.InstanceSecrets? secrets
    ) =>
        CaptureContent(
            span,
            () =>
                Record(
                    span,
                    "gen_ai.tool.call.arguments",
                    field => field.CopyObject(args, omitValue, secrets?.Redactor)
                )
        );
}
