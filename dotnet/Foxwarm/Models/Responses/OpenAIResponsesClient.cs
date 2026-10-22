using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

public sealed record ResponsesClientOptions(
    Uri BaseUri,
    string RequestModel,
    string ConcreteModelId,
    string Token,
    string Instructions,
    double MaxOutputTokens,
    JsonArray? Tools = null,
    string? Effort = null,
    JsonObject? ExtraHeaders = null,
    JsonObject? ExtraFields = null,
    string? RequestCompression = null,
    int? StreamInactivityTimeoutMs = null,
    bool DisallowEmptyResponse = false
)
{
    internal double? HardTimeoutMs { get; init; }
    internal TimeProvider? Clock { get; init; }
    internal bool KeepReasoningOnError { get; init; }
    internal ModelInteractionDiagnostics.Interaction.Attempt? Diagnostics { get; init; }
    internal Func<JsonObject, bool, Task<JsonObject>>? CommitAssistantSegment { get; init; }
    internal string? ProviderPromptCacheKey { get; init; }
    internal Func<JsonNode, Task>? AttemptPrepared { get; init; }
    internal JsonObject? WebSearch { get; init; }
    internal JsonObject? ImageGeneration { get; init; }
    internal Foxwarm.Images.ImageBlobStore? Images { get; init; }
    public Uri ResponsesUri =>
        new($"{BaseUri.ToString().TrimEnd('/')}/responses", UriKind.Absolute);
}

public sealed class UnsupportedResponsesFeatureException(string feature)
    : InvalidOperationException($"Experimental OpenAI Responses client does not support {feature}.")
{
    public string Feature { get; } = feature;
}

public sealed class ResponsesHttpException : HttpRequestException
{
    public ResponsesHttpException(HttpStatusCode statusCode, string responseBody, bool bodyTruncated)
        : base($"OpenAI Responses HTTP request failed with status {(int)statusCode}.", null, statusCode)
    {
        ClassificationBody = responseBody;
        var diagnostic = ModelAttemptFailure.DiagnosticBody(responseBody);
        ResponseBody = Foxwarm.Images.ImageTransport.DiagnosticBody(diagnostic.Body);
        BodyTruncated = bodyTruncated || diagnostic.Truncated;
    }

    internal string ClassificationBody { get; }
    public string ResponseBody { get; }
    public bool BodyTruncated { get; }
}

public static partial class ResponsesRequestSerializer
{
    public static JsonArray ConvertHistory(
        IReadOnlyList<JsonObject> history,
        string concreteModelId
    ) => ConvertHistoryWithImages(history, concreteModelId, null);

    internal static JsonArray ConvertHistoryWithImages(
        IReadOnlyList<JsonObject> history,
        string concreteModelId,
        Foxwarm.Images.ImageBlobStore? images = null,
        IReadOnlyDictionary<string, byte[]>? replayBytes = null
    )
    {
        var input = new JsonArray();
        foreach (var raw in history)
        {
            var message = CanonicalMessage.FromNode(raw);
            if (!message.IsModelVisible)
                continue;
            if (message.Role == "tool")
            {
                AppendToolOutputs(input, raw);
                continue;
            }
            var role = message.Role == "model" ? "assistant" : "user";
            var content = new JsonArray();
            string? messagePhase = null;
            var fallbackPhase =
                role == "assistant"
                    ? message.Parts.Any(part => part.Get("functionCall") is JsonObject)
                        ? "commentary"
                        : "final_answer"
                    : null;

            void Flush()
            {
                if (content.Count == 0)
                    return;
                var item = new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = role,
                    ["content"] = content.DeepClone(),
                };
                if (role == "assistant" && messagePhase is not null)
                    item["phase"] = messagePhase;
                input.Add(item);
                content.Clear();
                messagePhase = null;
            }

            void PrepareAssistant(JsonObject part)
            {
                if (role != "assistant")
                    return;
                var next = part.ContainsKey("phase")
                    ? RecognizedPhase(String(part, "phase"))
                    : fallbackPhase;
                if (content.Count > 0 && next != messagePhase)
                    Flush();
                messagePhase = next;
            }

            foreach (var part in (raw["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                RejectUnsupportedInput(part);
                if (String(part, "system") is { Length: > 0 } system)
                {
                    PrepareAssistant(part);
                    content.Add(
                        new JsonObject
                        {
                            ["type"] = role == "assistant" ? "output_text" : "input_text",
                            ["text"] = FormatSystemPartForModel(system),
                        }
                    );
                }

                var providerMeta = part["providerMeta"] as JsonObject;
                var outputItem = providerMeta?["openaiResponses"]?["outputItem"] as JsonObject;
                var sourceModelId = String(
                    providerMeta?["openaiResponses"] as JsonObject,
                    "sourceModelId"
                );
                if (
                    role == "assistant"
                    && outputItem is not null
                    && sourceModelId == concreteModelId
                )
                {
                    if (HostedResponsesTools.IsGeneratedImage(outputItem))
                    {
                        if (images is null || part["inlineDataRef"] is not JsonObject reference)
                            throw new ModelPreparationException(
                                "Generated image bytes are unavailable for native replay."
                            );
                        var blobId = String(reference, "blobId");
                        var bytes =
                            blobId is not null
                            && replayBytes?.TryGetValue(blobId, out var replay) == true
                                ? replay
                            : part["inlineData"] is JsonObject inline
                                ? ImageBlobStore.InlineBytes(inline)
                            : images.ReadAsync(reference).GetAwaiter().GetResult();
                        Flush();
                        input.Add(HostedResponsesTools.BuildReplayItem(outputItem, bytes));
                        PrepareAssistant(part);
                        content.Add(
                            new JsonObject
                            {
                                ["type"] = "output_text",
                                ["text"] = HostedResponsesTools.Guidance(part),
                            }
                        );
                        continue;
                    }
                    Flush();
                    input.Add(outputItem.DeepClone());
                }
                else if (
                    role == "assistant"
                    && outputItem is not null
                    && HostedResponsesTools.IsGeneratedImage(outputItem)
                )
                {
                    PrepareAssistant(part);
                    content.Add(
                        new JsonObject
                        {
                            ["type"] = "output_text",
                            ["text"] = HostedResponsesTools.Placeholder(part),
                        }
                    );
                    continue;
                }
                var summaries = providerMeta?["thinkingSummaries"] as JsonArray;
                var encryptedThinking = String(providerMeta, "encryptedThinking");
                if (summaries is not null || !string.IsNullOrEmpty(encryptedThinking))
                {
                    Flush();
                    var summary = new JsonArray();
                    if (summaries is not null)
                    {
                        foreach (var entry in summaries)
                            if (
                                entry is JsonValue scalar
                                && scalar.TryGetValue<string>(out var summaryText)
                            )
                                summary.Add(
                                    new JsonObject
                                    {
                                        ["text"] = summaryText,
                                        ["type"] = "summary_text",
                                    }
                                );
                    }
                    var reasoning = new JsonObject
                    {
                        ["type"] = "reasoning",
                        ["summary"] = summary,
                    };
                    if (!string.IsNullOrEmpty(encryptedThinking))
                        reasoning["encrypted_content"] = encryptedThinking;
                    input.Add(reasoning);
                }

                if (
                    part["text"] is JsonValue textValue
                    && textValue.TryGetValue<string>(out var text)
                    && (role == "assistant" || text.Length > 0)
                )
                {
                    PrepareAssistant(part);
                    var textPart = new JsonObject
                    {
                        ["type"] = role == "assistant" ? "output_text" : "input_text",
                        ["text"] = text,
                    };
                    var responseMeta = providerMeta?["openaiResponses"] as JsonObject;
                    if (
                        role == "assistant"
                        && String(responseMeta, "sourceModelId") == concreteModelId
                        && responseMeta?["annotations"] is JsonArray annotations
                    )
                        textPart["annotations"] = annotations.DeepClone();
                    content.Add(textPart);
                }

                if (role != "assistant")
                    ProviderImageParts.AddOccurrence(content, part, "responses");

                if (part["functionCall"] is JsonObject functionCall)
                {
                    Flush();
                    var callId = String(functionCall, "id");
                    if (string.IsNullOrEmpty(callId))
                        throw new UnsupportedResponsesFeatureException(
                            "function-call history without stable call ID"
                        );
                    if (functionCall["args"] is not null and not JsonObject)
                        throw new UnsupportedResponsesFeatureException(
                            "non-object canonical function-call args"
                        );
                    input.Add(
                        new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = callId,
                            ["name"] = String(functionCall, "name"),
                            ["arguments"] = FunctionCallArguments.Stringify(
                                functionCall["args"] as JsonObject,
                                String(functionCall, "rawArgsText"),
                                String(functionCall, "argsParseError")
                            ),
                        }
                    );
                }
            }
            Flush();
        }
        return input;
    }

    public static JsonObject BuildRequest(
        IReadOnlyList<JsonObject> history,
        string requestModel,
        string concreteModelId,
        string instructions,
        double maxOutputTokens,
        JsonArray? tools = null,
        string? effort = null
    ) =>
        BuildRequestWithImages(
            history,
            requestModel,
            concreteModelId,
            instructions,
            maxOutputTokens,
            tools,
            effort,
            null
        );

    internal static JsonObject BuildRequestWithImages(
        IReadOnlyList<JsonObject> history,
        string requestModel,
        string concreteModelId,
        string instructions,
        double maxOutputTokens,
        JsonArray? tools = null,
        string? effort = null,
        Foxwarm.Images.ImageBlobStore? images = null
    )
    {
        if (
            maxOutputTokens <= 0
            || !double.IsFinite(maxOutputTokens)
            || Math.Floor(maxOutputTokens) != maxOutputTokens
        )
            throw new ArgumentOutOfRangeException(nameof(maxOutputTokens));
        var data = new JsonObject
        {
            ["model"] = requestModel,
            ["instructions"] = instructions,
            ["input"] = ConvertHistoryWithImages(history, concreteModelId, images),
            ["tools"] = tools is null ? BuildToolDefinitions() : tools.DeepClone(),
            ["tool_choice"] = "auto",
            ["parallel_tool_calls"] = true,
            ["max_output_tokens"] = maxOutputTokens,
            ["store"] = false,
            ["stream"] = true,
        };
        if (effort is not null)
        {
            var reasoning = new JsonObject { ["effort"] = effort };
            if (effort != "none")
            {
                reasoning["summary"] = "auto";
                data["include"] = new JsonArray("reasoning.encrypted_content");
            }
            data["reasoning"] = reasoning;
        }
        return data;
    }

    private static JsonArray BuildToolDefinitions() =>
        new(
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "write_fixture",
                ["description"] =
                    "Create a UTF-8 text file in the experiment's temporary directory. The file must not already exist.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("fileName", "content"),
                    ["properties"] = new JsonObject
                    {
                        ["fileName"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Name of the file to create, without directory components.",
                        },
                        ["content"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Text to write to the file.",
                        },
                    },
                },
                ["strict"] = false,
            }
        );

    private static void AppendToolOutputs(JsonArray input, JsonObject message)
    {
        foreach (
            var group in ProviderImageParts.ToolGroups(
                (message["parts"] as JsonArray ?? []).OfType<JsonObject>()
            )
        )
        {
            var blocks = ProviderImageParts.GroupBlocks(group.Parts, "responses");
            JsonNode output =
                blocks.Count == 0 ? JsonValue.Create("")!
                : blocks.Count == 1 && String(blocks[0] as JsonObject, "type") == "input_text"
                    ? blocks[0]!["text"]!.DeepClone()
                : blocks;
            input.Add(
                new JsonObject
                {
                    ["type"] = "function_call_output",
                    ["call_id"] = group.Id,
                    ["output"] = output,
                }
            );
        }
    }

    private static string FormatToolResponsePayload(JsonObject response)
    {
        if (response.Count == 1 && response["output"] is JsonValue output)
        {
            if (output.TryGetValue<string>(out var text))
                return text;
            if (output.TryGetValue<bool>(out var boolean))
                return boolean ? "true" : "false";
            return output.ToJsonString();
        }
        if (
            response.Count == 1
            && response["error"] is JsonObject { Count: 2 } error
            && error.All(pair => pair.Key is "type" or "message")
            && error["type"] is JsonValue errorType
            && errorType.TryGetValue<string>(out _)
            && error["message"] is JsonValue errorMessage
            && errorMessage.TryGetValue<string>(out _)
        )
        {
            var type = String(error, "type") ?? "tool_error";
            var message = String(error, "message") ?? "Tool execution failed";
            return $"error: {{type: {YamlScalar(type)}, message: {YamlScalar(message)}}}";
        }
        if (
            response.Count is >= 4 and <= 5
            && response["target"] is JsonValue target
            && target.TryGetValue<string>(out var reference)
            && reference.StartsWith("msg#", StringComparison.Ordinal)
            && response["offset"] is JsonValue
            && response["text"] is JsonValue recallPage
            && recallPage.TryGetValue<string>(out var page)
            && page.EnumerateRunes().Count() <= 12000
            && response["totalCharacters"] is JsonValue
            && response.All(item =>
                item.Key is "target" or "offset" or "text" or "totalCharacters" or "nextOffset"
            )
        )
            return response.ToJsonString();
        if (
            response.Count == 6
            && response["status"] is JsonValue status
            && status.TryGetValue<string>(out var state)
            && state is "running" or "finished"
            && response["output"] is JsonValue execOutput
            && execOutput.TryGetValue<string>(out var excerpt)
            && excerpt.Length <= 16 * 1024
            && response["offset"] is JsonValue start
            && start.TryGetValue<long>(out var startByte)
            && startByte >= 0
            && response["totalBytes"] is JsonValue total
            && total.TryGetValue<long>(out var totalBytes)
            && totalBytes >= 0
            && (
                response["nextOffset"] is null
                || response["nextOffset"] is JsonValue next
                    && next.TryGetValue<long>(out var nextByte)
                    && nextByte >= startByte
                    && nextByte <= totalBytes
            )
            && (
                response["exitCode"] is null
                || response["exitCode"] is JsonValue code && code.TryGetValue<int>(out _)
            )
            && response.All(item =>
                item.Key
                    is "status"
                        or "exitCode"
                        or "output"
                        or "offset"
                        or "nextOffset"
                        or "totalBytes"
            )
        )
            return response.ToJsonString();
        return Foxwarm.Tools.ToolResponseFormatting.Format(response);
    }

    private static string YamlScalar(string value)
    {
        if (
            value.Any(character =>
                character <= '\u001F'
                || character is >= '\u007F' and <= '\u009F'
                || character is '\u2028' or '\u2029'
            )
        )
            return DoubleQuotedYamlScalar(value);
        if (
            value.Length == 0
            || value.Contains(": ", StringComparison.Ordinal)
            || value[0]
                is '-'
                    or '?'
                    or ':'
                    or '!'
                    or '&'
                    or '*'
                    or '#'
                    or '{'
                    or '}'
                    or '['
                    or ']'
                    or ','
                    or '|'
                    or '>'
                    or '@'
                    or '`'
        )
            return $"'{value.Replace("'", "''", StringComparison.Ordinal)}'";
        return value;
    }

    private static string DoubleQuotedYamlScalar(string value)
    {
        var result = new StringBuilder(value.Length + 2).Append('"');
        foreach (var character in value)
        {
            result.Append(
                character switch
                {
                    '\0' => "\\0",
                    '\u0007' => "\\a",
                    '\b' => "\\b",
                    '\t' => "\\t",
                    '\n' => "\\n",
                    '\u000B' => "\\v",
                    '\f' => "\\f",
                    '\r' => "\\r",
                    '\u001B' => "\\e",
                    '"' => "\\\"",
                    '\\' => "\\\\",
                    '\u0085' => "\\N",
                    '\u2028' => "\\L",
                    '\u2029' => "\\P",
                    <= '\u00FF'
                        when character <= '\u001F' || character is >= '\u007F' and <= '\u009F' =>
                        $"\\x{(int)character:X2}",
                    _ => character.ToString(),
                }
            );
        }
        return result.Append('"').ToString();
    }

    private static void RejectUnsupportedInput(JsonObject part)
    {
        foreach (var property in new[] { "functionResponse" })
            if (part[property] is not null)
                throw new UnsupportedResponsesFeatureException($"message part {property}");
        if (part["providerMeta"]?["openaiResponses"]?["outputItem"] is JsonObject)
            return;
    }

    private static string FormatSystemPartForModel(string system) =>
        OpenAIRequestText.System(system);

    private static string EcmaTrim(string value)
    {
        var start = 0;
        while (start < value.Length && IsEcmaWhitespace(value[start]))
            start++;
        var end = value.Length;
        while (end > start && IsEcmaWhitespace(value[end - 1]))
            end--;
        return value[start..end];
    }

    private static bool IsEcmaWhitespace(char character) =>
        character
            is '\u0009'
                or '\u000A'
                or '\u000B'
                or '\u000C'
                or '\u000D'
                or '\u0020'
                or '\u00A0'
                or '\u1680'
                or '\u2028'
                or '\u2029'
                or '\u202F'
                or '\u205F'
                or '\u3000'
                or '\uFEFF'
        || character is >= '\u2000' and <= '\u200A';

    private static string? RecognizedPhase(string? phase) =>
        phase is "commentary" or "final_answer" ? phase : null;

    private static string? String(JsonObject? value, string property) =>
        value?[property] is JsonValue scalar && scalar.TryGetValue<string>(out var result)
            ? result
            : null;
}

public static class ResponsesCanonicalConverter
{
    public static JsonObject? ConvertAssistant(
        JsonObject response,
        string concreteModelId,
        long completedAt,
        double durationMs,
        IReadOnlyDictionary<int, JsonObject>? generatedParts = null,
        IReadOnlyList<string>? generatedFailures = null,
        int? successfulImageCount = null
    )
    {
        var parts = new JsonArray();
        foreach (var node in response["output"] as JsonArray ?? [])
        {
            if (node is not JsonObject item)
                continue;
            var type = String(item, "type");
            var outputIndex = response["output"] is JsonArray all ? all.IndexOf(node) : -1;
            if (type == "image_generation_call")
            {
                if (generatedParts?.TryGetValue(outputIndex, out var generated) == true)
                    parts.Add(generated.DeepClone());
                continue;
            }
            if (type == "web_search_call")
            {
                parts.Add(
                    new JsonObject
                    {
                        ["providerMeta"] = new JsonObject
                        {
                            ["openaiResponses"] = new JsonObject
                            {
                                ["sourceModelId"] = concreteModelId,
                                ["outputItem"] = item.DeepClone(),
                            },
                        },
                    }
                );
                continue;
            }
            if (type == "reasoning")
            {
                var summaryTexts = new List<string>();
                JsonArray? summaries = null;
                if (item["summary"] is JsonArray sourceSummaries)
                {
                    summaries = new JsonArray();
                    foreach (var summaryNode in sourceSummaries)
                    {
                        var summary = summaryNode as JsonObject;
                        var text = String(summary, "text") ?? String(summary, "summary") ?? "";
                        if (text.Length > 0)
                            summaryTexts.Add(text);
                        summaries.Add(
                            String(summary, "text") is { } exact ? JsonValue.Create(exact) : null
                        );
                    }
                }
                var providerMeta = new JsonObject();
                if (summaries is not null)
                    providerMeta["thinkingSummaries"] = summaries;
                if (String(item, "encrypted_content") is { } encrypted)
                    providerMeta["encryptedThinking"] = encrypted;
                parts.Add(
                    new JsonObject
                    {
                        ["thinking"] = string.Join("\n", summaryTexts),
                        ["providerMeta"] = providerMeta,
                    }
                );
                continue;
            }
            if (type == "message" && String(item, "role") == "assistant")
            {
                var phase = RecognizedPhase(String(item, "phase"));
                foreach (var contentNode in item["content"] as JsonArray ?? [])
                {
                    if (contentNode is not JsonObject content)
                        continue;
                    var contentType = String(content, "type");
                    var text =
                        contentType == "output_text" ? String(content, "text")
                        : contentType == "refusal" ? String(content, "refusal")
                        : null;
                    if (text is null)
                        throw new UnsupportedResponsesFeatureException(
                            $"Responses message content {contentType ?? "unknown"}"
                        );
                    var part = new JsonObject { ["text"] = text };
                    if (phase is not null)
                        part["phase"] = phase;
                    if (
                        contentType == "output_text"
                        && content["annotations"] is JsonArray annotations
                        && annotations.Count > 0
                    )
                        part["providerMeta"] = new JsonObject
                        {
                            ["openaiResponses"] = new JsonObject
                            {
                                ["sourceModelId"] = concreteModelId,
                                ["annotations"] = annotations.DeepClone(),
                            },
                        };
                    parts.Add(part);
                }
                continue;
            }
            if (type == "function_call")
            {
                var callId = String(item, "call_id") ?? String(item, "id");
                if (string.IsNullOrEmpty(callId))
                    throw new UnsupportedResponsesFeatureException(
                        "function-call output without stable call ID"
                    );
                var parsed = FunctionCallArguments.Parse(item["arguments"]);
                var functionCall = new JsonObject
                {
                    ["id"] = callId,
                    ["name"] = String(item, "name") ?? "",
                    ["args"] = parsed.Args.DeepClone(),
                };
                if (parsed.RawArgsText is not null)
                    functionCall["rawArgsText"] = parsed.RawArgsText;
                if (parsed.ArgsParseError is not null)
                    functionCall["argsParseError"] = parsed.ArgsParseError;
                parts.Add(new JsonObject { ["functionCall"] = functionCall });
                continue;
            }
            throw new UnsupportedResponsesFeatureException(
                $"Responses output item {type ?? "unknown"}"
            );
        }
        if (
            generatedFailures is { Count: > 0 }
            && (successfulImageCount ?? generatedParts?.Count ?? 0) > 0
        )
            parts.Add(
                new JsonObject
                {
                    ["text"] =
                        "[image generation did not produce a usable image: "
                        + HostedResponsesTools.FailureNote(generatedFailures)
                        + "]",
                }
            );
        if (parts.Count == 0)
            return null;
        var meta = new JsonObject
        {
            ["modelId"] = concreteModelId,
            ["llmRequestTiming"] = BuildTiming(completedAt, durationMs),
        };
        if (BuildUsage(response["usage"] as JsonObject) is { } usage)
            meta["usage"] = usage;
        return new JsonObject
        {
            ["role"] = "model",
            ["parts"] = parts,
            ["__meta"] = meta,
        };
    }

    internal static JsonObject? BuildUsage(JsonObject? usage)
    {
        if (usage is null)
            return null;
        var cached = Number(usage["input_tokens_details"]?["cached_tokens"]) ?? 0;
        var input = Number(usage["input_tokens"]) ?? 0;
        var result = new JsonObject
        {
            ["inputTokens"] = input - cached,
            ["outputTokens"] = Number(usage["output_tokens"]) ?? 0,
            ["cachedTokens"] = cached,
        };
        if (Number(usage["output_tokens_details"]?["reasoning_tokens"]) is { } reasoning)
            result["reasoningTokens"] = reasoning;
        return result;
    }

    private static JsonObject BuildTiming(long completedAt, double durationMs)
    {
        var startedAt = completedAt - durationMs;
        if (
            completedAt < 0
            || !double.IsFinite(durationMs)
            || durationMs < 0
            || !double.IsFinite(startedAt)
            || startedAt < 0
        )
            throw new InvalidOperationException("Responses request timing is invalid.");
        return new JsonObject
        {
            ["startedAt"] = startedAt,
            ["completedAt"] = completedAt,
            ["durationMs"] = durationMs,
        };
    }

    private static long? Number(JsonNode? node)
    {
        if (node is not JsonValue scalar)
            return null;
        if (scalar.TryGetValue<long>(out var integer))
            return integer;
        if (scalar.TryGetValue<int>(out var small))
            return small;
        return null;
    }

    private static string? String(JsonObject? value, string property) =>
        value?[property] is JsonValue scalar && scalar.TryGetValue<string>(out var result)
            ? result
            : null;

    private static string? RecognizedPhase(string? phase) =>
        phase is "commentary" or "final_answer" ? phase : null;
}

public sealed class WriteFixtureToolExecutor : ITurnToolExecutor
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private readonly string sandboxRoot;
    private readonly Func<Stream, ReadOnlyMemory<byte>, Task> writeBytes;
    private readonly Func<string, Stream> openNew;
    private int successfulEffects;

    public WriteFixtureToolExecutor(
        string sandboxRoot,
        Func<Stream, ReadOnlyMemory<byte>, Task>? writeBytes = null,
        Func<string, Stream>? openNew = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sandboxRoot);
        this.sandboxRoot = Path.GetFullPath(sandboxRoot);
        this.writeBytes = writeBytes ?? WriteBytesAsync;
        this.openNew = openNew ?? OpenNew;
        Directory.CreateDirectory(this.sandboxRoot);
    }

    public int SuccessfulEffects => Volatile.Read(ref successfulEffects);

    async Task<JsonNode?> ITurnToolExecutor.ExecuteAsync(
        JsonObject call,
        CancellationToken token
    ) => await ExecuteAsync(call, token);

    public async Task<JsonObject> ExecuteAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>() ?? "";
        if (name != "write_fixture")
            return UnsupportedTurnToolExecutor.ToolError("unknown_tool", $"Unknown tool: {name}");
        if (
            functionCall["args"] is not JsonObject args
            || args.Count != 2
            || args["fileName"] is not JsonValue fileNameValue
            || !fileNameValue.TryGetValue<string>(out var fileName)
            || args["content"] is not JsonValue contentValue
            || !contentValue.TryGetValue<string>(out var content)
        )
            return UnsupportedTurnToolExecutor.ToolError(
                "invalid_tool_arguments",
                "write_fixture requires exactly string fileName and content."
            );
        if (!IsPlainFileName(fileName))
            return UnsupportedTurnToolExecutor.ToolError(
                "invalid_path",
                "fileName must be a plain file name."
            );

        var path = Path.Combine(sandboxRoot, fileName);
        if (TargetExists(path))
            return UnsupportedTurnToolExecutor.ToolError("file_exists", "File already exists.");
        var bytes = Utf8NoBom.GetBytes(content);
        cancellationToken.ThrowIfCancellationRequested();
        Stream stream;
        try
        {
            stream = openNew(path);
        }
        catch (IOException)
        {
            return TargetExists(path)
                ? UnsupportedTurnToolExecutor.ToolError("file_exists", "File already exists.")
                : ToolIoError();
        }
        catch (UnauthorizedAccessException)
        {
            return ToolIoError();
        }
        await using (stream)
        {
            try
            {
                await writeBytes(stream, bytes).ConfigureAwait(false);
            }
            catch (IOException)
            {
                return ToolIoError();
            }
            catch (UnauthorizedAccessException)
            {
                return ToolIoError();
            }
        }
        Interlocked.Increment(ref successfulEffects);
        return new JsonObject { ["output"] = "created" };
    }

    private static async Task WriteBytesAsync(Stream stream, ReadOnlyMemory<byte> bytes)
    {
        await stream.WriteAsync(bytes, CancellationToken.None).ConfigureAwait(false);
        await stream.FlushAsync(CancellationToken.None).ConfigureAwait(false);
    }

    private static Stream OpenNew(string path) =>
        new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.Asynchronous
        );

    private static bool TargetExists(string path)
    {
        try
        {
            return File.Exists(path)
                || Directory.Exists(path)
                || new FileInfo(path).LinkTarget is not null;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static JsonObject ToolIoError() =>
        UnsupportedTurnToolExecutor.ToolError(
            "tool_io_error",
            "write_fixture failed due to an I/O error."
        );

    private static bool IsPlainFileName(string fileName) =>
        fileName.Length > 0
        && fileName is not "." and not ".."
        && !Path.IsPathRooted(fileName)
        && !fileName.Contains('/')
        && !fileName.Contains('\\')
        && !fileName.Contains('\0');
}

public sealed class ResponsesChatService : IChatService
{
    private readonly HttpClient httpClient;
    private readonly ResponsesClientOptions options;
    private readonly Action<string, ResponsesStreamProgress>? progress;

    public ResponsesChatService(
        HttpClient httpClient,
        ResponsesClientOptions options,
        Action<string, ResponsesStreamProgress>? progress = null
    )
    {
        this.httpClient = httpClient;
        this.options = options;
        this.progress = progress;
    }

    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    )
    {
        var body = ResponsesRequestPlan.Build(history, options);
        if (options.AttemptPrepared is not null)
            await options.AttemptPrepared(body).ConfigureAwait(false);
        using var attempt = new ResponsesAttempt(
            options,
            cancellationToken,
            update => progress?.Invoke(sessionId, update)
        );
        OpenAIHttp.Completed completed;
        try
        {
            completed = await OpenAIHttp
                .RequestAsync(
                    httpClient,
                    options.ResponsesUri,
                    body,
                    options,
                    sessionId,
                    null,
                    null,
                    (stream, token, callbacks) =>
                        ResponsesSseCollector.CollectAsync(stream, token, callbacks),
                    attempt.Token,
                    attempt.Callbacks
                )
                .ConfigureAwait(false);
        }
        catch (Exception error)
        {
            await attempt.FailedAsync(error).ConfigureAwait(false);
            throw;
        }
        return await attempt
            .CompleteAsync(completed.Payload, completed.CompletedAt, completed.DurationMs)
            .ConfigureAwait(false);
    }
}
