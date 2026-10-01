using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Models;

namespace Foxwarm.Models;

public sealed record ResponsesClientOptions(
    Uri BaseUri,
    string RequestModel,
    string ConcreteModelId,
    string Token,
    string Instructions,
    int MaxOutputTokens,
    JsonArray? Tools = null,
    string? Effort = null,
    JsonObject? ExtraHeaders = null,
    JsonObject? ExtraFields = null,
    string? RequestCompression = null,
    int? StreamInactivityTimeoutMs = null,
    bool DisallowEmptyResponse = false)
{
    public Uri ResponsesUri => new($"{BaseUri.ToString().TrimEnd('/')}/responses", UriKind.Absolute);
}

public sealed class UnsupportedResponsesFeatureException(string feature)
    : InvalidOperationException($"Experimental OpenAI Responses client does not support {feature}.")
{
    public string Feature { get; } = feature;
}

public sealed class ResponsesHttpException(
    HttpStatusCode statusCode,
    string responseBody,
    bool bodyTruncated)
    : HttpRequestException($"OpenAI Responses HTTP request failed with status {(int)statusCode}.", null, statusCode)
{
    public string ResponseBody { get; } = responseBody;
    public bool BodyTruncated { get; } = bodyTruncated;
}

public static partial class ResponsesRequestSerializer
{
    public static JsonArray ConvertHistory(IReadOnlyList<JsonObject> history, string concreteModelId)
    {
        var input = new JsonArray();
        foreach (var raw in history)
        {
            var message = CanonicalMessage.FromNode(raw);
            if (!message.IsModelVisible) continue;
            if (message.Role == "tool")
            {
                AppendToolOutputs(input, message);
                continue;
            }
            var role = message.Role == "model" ? "assistant" : "user";
            var content = new JsonArray();
            string? messagePhase = null;
            var fallbackPhase = role == "assistant"
                ? message.Parts.Any(part => part.Get("functionCall") is JsonObject) ? "commentary" : "final_answer"
                : null;

            void Flush()
            {
                if (content.Count == 0) return;
                var item = new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = role,
                    ["content"] = content.DeepClone()
                };
                if (role == "assistant" && messagePhase is not null) item["phase"] = messagePhase;
                input.Add(item);
                content.Clear();
                messagePhase = null;
            }

            void PrepareAssistant(JsonObject part)
            {
                if (role != "assistant") return;
                var next = part.ContainsKey("phase") ? RecognizedPhase(String(part, "phase")) : fallbackPhase;
                if (content.Count > 0 && next != messagePhase) Flush();
                messagePhase = next;
            }

            foreach (var view in message.Parts)
            {
                var part = view.ToJson();
                RejectUnsupportedInput(part);
                if (String(part, "system") is { Length: > 0 } system)
                {
                    PrepareAssistant(part);
                    content.Add(new JsonObject
                    {
                        ["type"] = role == "assistant" ? "output_text" : "input_text",
                        ["text"] = FormatSystemPartForModel(system)
                    });
                }

                var providerMeta = part["providerMeta"] as JsonObject;
                var summaries = providerMeta?["thinkingSummaries"] as JsonArray;
                var encryptedThinking = String(providerMeta, "encryptedThinking");
                if (summaries is not null || !string.IsNullOrEmpty(encryptedThinking))
                {
                    Flush();
                    var summary = new JsonArray();
                    if (summaries is not null)
                    {
                        foreach (var entry in summaries)
                            if (entry is JsonValue scalar && scalar.TryGetValue<string>(out var summaryText))
                                summary.Add(new JsonObject { ["text"] = summaryText, ["type"] = "summary_text" });
                    }
                    var reasoning = new JsonObject { ["type"] = "reasoning", ["summary"] = summary };
                    if (!string.IsNullOrEmpty(encryptedThinking)) reasoning["encrypted_content"] = encryptedThinking;
                    input.Add(reasoning);
                }

                if (part["text"] is JsonValue textValue && textValue.TryGetValue<string>(out var text)
                    && (role == "assistant" || text.Length > 0))
                {
                    PrepareAssistant(part);
                    var textPart = new JsonObject
                    {
                        ["type"] = role == "assistant" ? "output_text" : "input_text",
                        ["text"] = text
                    };
                    var responseMeta = providerMeta?["openaiResponses"] as JsonObject;
                    if (role == "assistant"
                        && String(responseMeta, "sourceModelId") == concreteModelId
                        && responseMeta?["annotations"] is JsonArray annotations)
                        textPart["annotations"] = annotations.DeepClone();
                    content.Add(textPart);
                }

                if (part["functionCall"] is JsonObject functionCall)
                {
                    Flush();
                    var callId = String(functionCall, "id");
                    if (string.IsNullOrEmpty(callId))
                        throw new UnsupportedResponsesFeatureException("function-call history without stable call ID");
                    if (functionCall["args"] is not null and not JsonObject)
                        throw new UnsupportedResponsesFeatureException("non-object canonical function-call args");
                    input.Add(new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = callId,
                        ["name"] = String(functionCall, "name"),
                        ["arguments"] = FunctionCallArguments.Stringify(
                            functionCall["args"] as JsonObject,
                            String(functionCall, "rawArgsText"),
                            String(functionCall, "argsParseError"))
                    });
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
        int maxOutputTokens,
        JsonArray? tools = null,
        string? effort = null)
    {
        if (maxOutputTokens <= 0) throw new ArgumentOutOfRangeException(nameof(maxOutputTokens));
        var data = new JsonObject
        {
            ["model"] = requestModel,
            ["instructions"] = instructions,
            ["input"] = ConvertHistory(history, concreteModelId),
            ["tools"] = tools is null ? BuildToolDefinitions() : tools.DeepClone(),
            ["tool_choice"] = "auto",
            ["parallel_tool_calls"] = true,
            ["max_output_tokens"] = maxOutputTokens,
            ["store"] = false,
            ["stream"] = true
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

    private static JsonArray BuildToolDefinitions() => new(new JsonObject
    {
        ["type"] = "function",
        ["name"] = "write_fixture",
        ["description"] = "Create a UTF-8 text file in the experiment's temporary directory. The file must not already exist.",
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
                    ["description"] = "Name of the file to create, without directory components."
                },
                ["content"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = "Text to write to the file."
                }
            }
        },
        ["strict"] = false
    });

    private static void AppendToolOutputs(JsonArray input, CanonicalMessage message)
    {
        var grouped = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var view in message.Parts)
        {
            var part = view.ToJson();
            if (part["functionResponse"] is not JsonObject functionResponse) continue;
            var callId = String(functionResponse, "tool_use_id") ?? String(part, "toolUseId");
            if (string.IsNullOrEmpty(callId))
                throw new UnsupportedResponsesFeatureException("tool response without stable call ID");
            if (!grouped.TryGetValue(callId, out var outputs))
            {
                outputs = new List<string>();
                grouped.Add(callId, outputs);
                order.Add(callId);
            }
            outputs.Add(FormatToolResponsePayload(functionResponse["response"] as JsonObject ?? new JsonObject()));
        }
        foreach (var callId in order)
        {
            var outputs = grouped[callId];
            input.Add(new JsonObject
            {
                ["type"] = "function_call_output",
                ["call_id"] = callId,
                ["output"] = outputs.Count switch
                {
                    0 => "",
                    1 => outputs[0],
                    _ => new JsonArray(outputs.Select(output => (JsonNode)new JsonObject { ["type"] = "input_text", ["text"] = output }).ToArray())
                }
            });
        }
    }

    private static string FormatToolResponsePayload(JsonObject response)
    {
        if (response.Count == 1 && response["output"] is JsonValue output)
        {
            if (output.TryGetValue<string>(out var text)) return text;
            if (output.TryGetValue<bool>(out var boolean)) return boolean ? "true" : "false";
            return output.ToJsonString();
        }
        if (response.Count == 1 && response["error"] is JsonObject { Count: 2 } error
            && error.All(pair => pair.Key is "type" or "message")
            && error["type"] is JsonValue errorType && errorType.TryGetValue<string>(out _)
            && error["message"] is JsonValue errorMessage && errorMessage.TryGetValue<string>(out _))
        {
            var type = String(error, "type") ?? "tool_error";
            var message = String(error, "message") ?? "Tool execution failed";
            return $"error: {{type: {YamlScalar(type)}, message: {YamlScalar(message)}}}";
        }
        if (response.Count is >= 4 and <= 5 && response["target"] is JsonValue target
            && target.TryGetValue<string>(out var reference) && reference.StartsWith("msg#", StringComparison.Ordinal)
            && response["offset"] is JsonValue && response["text"] is JsonValue recallPage
            && recallPage.TryGetValue<string>(out var page) && page.EnumerateRunes().Count() <= 12000
            && response["totalCharacters"] is JsonValue
            && response.All(item => item.Key is "target" or "offset" or "text" or "totalCharacters" or "nextOffset"))
            return response.ToJsonString();
        if (response.Count == 6 && response["status"] is JsonValue status
            && status.TryGetValue<string>(out var state) && state is "running" or "finished"
            && response["output"] is JsonValue execOutput && execOutput.TryGetValue<string>(out var excerpt)
            && excerpt.Length <= 16 * 1024
            && response["offset"] is JsonValue start && start.TryGetValue<long>(out var startByte) && startByte >= 0
            && response["totalBytes"] is JsonValue total && total.TryGetValue<long>(out var totalBytes) && totalBytes >= 0
            && (response["nextOffset"] is null || response["nextOffset"] is JsonValue next
                && next.TryGetValue<long>(out var nextByte) && nextByte >= startByte && nextByte <= totalBytes)
            && (response["exitCode"] is null || response["exitCode"] is JsonValue code && code.TryGetValue<int>(out _))
            && response.All(item => item.Key is "status" or "exitCode" or "output" or "offset" or "nextOffset" or "totalBytes"))
            return response.ToJsonString();
        return Foxwarm.Tools.ToolResponseFormatting.Format(response);
    }

    private static string YamlScalar(string value)
    {
        if (value.Any(character => character <= '\u001F'
            || character is >= '\u007F' and <= '\u009F'
            || character is '\u2028' or '\u2029'))
            return DoubleQuotedYamlScalar(value);
        if (value.Length == 0 || value.Contains(": ", StringComparison.Ordinal) || value[0] is '-' or '?' or ':' or '!' or '&' or '*' or '#' or '{' or '}' or '[' or ']' or ',' or '|' or '>' or '@' or '`')
            return $"'{value.Replace("'", "''", StringComparison.Ordinal)}'";
        return value;
    }

    private static string DoubleQuotedYamlScalar(string value)
    {
        var result = new StringBuilder(value.Length + 2).Append('"');
        foreach (var character in value)
        {
            result.Append(character switch
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
                <= '\u00FF' when character <= '\u001F' || character is >= '\u007F' and <= '\u009F'
                    => $"\\x{(int)character:X2}",
                _ => character.ToString()
            });
        }
        return result.Append('"').ToString();
    }

    private static void RejectUnsupportedInput(JsonObject part)
    {
        foreach (var property in new[] { "functionResponse", "inlineData", "inlineDataRef" })
            if (part[property] is not null) throw new UnsupportedResponsesFeatureException($"message part {property}");
        if (part["providerMeta"]?["openaiResponses"]?["outputItem"] is not null)
            throw new UnsupportedResponsesFeatureException("native Responses output-item replay");
    }

    private static string FormatSystemPartForModel(string system)
    {
        var trimmed = EcmaTrim(system);
        if (FoxwarmMetadataLine().IsMatch(trimmed))
        {
            if (FoxwarmSystemLine().IsMatch(trimmed) && !FoxwarmKindAttribute().IsMatch(trimmed))
                throw new UnsupportedResponsesFeatureException("legacy Foxwarm system metadata normalization");
            return trimmed;
        }
        if (LegacySystemText().IsMatch(trimmed))
            throw new UnsupportedResponsesFeatureException("legacy system text normalization");
        return trimmed.Length == 0
            ? "<foxwarm-system kind=\"system\" />"
            : $"<foxwarm-system kind=\"system\">\n{trimmed}\n</foxwarm-system>";
    }

    private static string EcmaTrim(string value)
    {
        var start = 0;
        while (start < value.Length && IsEcmaWhitespace(value[start])) start++;
        var end = value.Length;
        while (end > start && IsEcmaWhitespace(value[end - 1])) end--;
        return value[start..end];
    }

    private static bool IsEcmaWhitespace(char character) => character is
        '\u0009' or '\u000A' or '\u000B' or '\u000C' or '\u000D' or '\u0020' or '\u00A0' or
        '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' ||
        character is >= '\u2000' and <= '\u200A';

    private static string? RecognizedPhase(string? phase) => phase is "commentary" or "final_answer" ? phase : null;
    private static string? String(JsonObject? value, string property) =>
        value?[property] is JsonValue scalar && scalar.TryGetValue<string>(out var result) ? result : null;

    [GeneratedRegex("^</?foxwarm-(?:system|metadata|message)(?![A-Za-z0-9_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FoxwarmMetadataLine();
    [GeneratedRegex("^<foxwarm-system(?![A-Za-z0-9_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FoxwarmSystemLine();
    [GeneratedRegex("(?:^|[^A-Za-z0-9_])kind[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*=", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FoxwarmKindAttribute();
    [GeneratedRegex("^(?:current time[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*=|current session ID[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*=|Session goal reminder:|Reminder: message ended without send_to_session call\\.|Background Process Finished|session resumed after process restart|retrying last request|Managed session `|Compaction completed\\.?|\\*\\*(?:COMPACTION COMPLETED|PARENT SESSION|NEW CHILD SESSION|HISTORY ABOVE IS INHERITED))", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LegacySystemText();
}

public static class ResponsesCanonicalConverter
{
    public static JsonObject? ConvertAssistant(
        JsonObject response,
        string concreteModelId,
        long completedAt,
        double durationMs)
    {
        var parts = new JsonArray();
        foreach (var node in response["output"] as JsonArray ?? [])
        {
            if (node is not JsonObject item) continue;
            var type = String(item, "type");
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
                        if (text.Length > 0) summaryTexts.Add(text);
                        summaries.Add(String(summary, "text") is { } exact ? JsonValue.Create(exact) : null);
                    }
                }
                var providerMeta = new JsonObject();
                if (summaries is not null) providerMeta["thinkingSummaries"] = summaries;
                if (String(item, "encrypted_content") is { } encrypted) providerMeta["encryptedThinking"] = encrypted;
                parts.Add(new JsonObject
                {
                    ["thinking"] = string.Join("\n", summaryTexts),
                    ["providerMeta"] = providerMeta
                });
                continue;
            }
            if (type == "message" && String(item, "role") == "assistant")
            {
                var phase = RecognizedPhase(String(item, "phase"));
                foreach (var contentNode in item["content"] as JsonArray ?? [])
                {
                    if (contentNode is not JsonObject content) continue;
                    var contentType = String(content, "type");
                    var text = contentType == "output_text" ? String(content, "text")
                        : contentType == "refusal" ? String(content, "refusal") : null;
                    if (text is null)
                        throw new UnsupportedResponsesFeatureException($"Responses message content {contentType ?? "unknown"}");
                    var part = new JsonObject { ["text"] = text };
                    if (phase is not null) part["phase"] = phase;
                    if (contentType == "output_text" && content["annotations"] is JsonArray annotations && annotations.Count > 0)
                        part["providerMeta"] = new JsonObject
                        {
                            ["openaiResponses"] = new JsonObject
                            {
                                ["sourceModelId"] = concreteModelId,
                                ["annotations"] = annotations.DeepClone()
                            }
                        };
                    parts.Add(part);
                }
                continue;
            }
            if (type == "function_call")
            {
                var callId = String(item, "call_id") ?? String(item, "id");
                if (string.IsNullOrEmpty(callId))
                    throw new UnsupportedResponsesFeatureException("function-call output without stable call ID");
                var parsed = FunctionCallArguments.Parse(item["arguments"]);
                var functionCall = new JsonObject
                {
                    ["id"] = callId,
                    ["name"] = String(item, "name") ?? "",
                    ["args"] = parsed.Args.DeepClone()
                };
                if (parsed.RawArgsText is not null) functionCall["rawArgsText"] = parsed.RawArgsText;
                if (parsed.ArgsParseError is not null) functionCall["argsParseError"] = parsed.ArgsParseError;
                parts.Add(new JsonObject { ["functionCall"] = functionCall });
                continue;
            }
            throw new UnsupportedResponsesFeatureException($"Responses output item {type ?? "unknown"}");
        }
        if (parts.Count == 0) return null;
        var meta = new JsonObject
        {
            ["modelId"] = concreteModelId,
            ["llmRequestTiming"] = BuildTiming(completedAt, durationMs)
        };
        if (BuildUsage(response["usage"] as JsonObject) is { } usage) meta["usage"] = usage;
        return new JsonObject { ["role"] = "model", ["parts"] = parts, ["__meta"] = meta };
    }

    private static JsonObject? BuildUsage(JsonObject? usage)
    {
        if (usage is null) return null;
        var cached = Number(usage["input_tokens_details"]?["cached_tokens"]) ?? 0;
        var input = Number(usage["input_tokens"]) ?? 0;
        var result = new JsonObject
        {
            ["inputTokens"] = input - cached,
            ["outputTokens"] = Number(usage["output_tokens"]) ?? 0,
            ["cachedTokens"] = cached
        };
        if (Number(usage["output_tokens_details"]?["reasoning_tokens"]) is { } reasoning)
            result["reasoningTokens"] = reasoning;
        return result;
    }

    private static JsonObject BuildTiming(long completedAt, double durationMs)
    {
        var startedAt = completedAt - durationMs;
        if (completedAt < 0 || !double.IsFinite(durationMs) || durationMs < 0 || !double.IsFinite(startedAt) || startedAt < 0)
            throw new InvalidOperationException("Responses request timing is invalid.");
        return new JsonObject
        {
            ["startedAt"] = startedAt,
            ["completedAt"] = completedAt,
            ["durationMs"] = durationMs
        };
    }

    private static long? Number(JsonNode? node)
    {
        if (node is not JsonValue scalar) return null;
        if (scalar.TryGetValue<long>(out var integer)) return integer;
        if (scalar.TryGetValue<int>(out var small)) return small;
        return null;
    }
    private static string? String(JsonObject? value, string property) =>
        value?[property] is JsonValue scalar && scalar.TryGetValue<string>(out var result) ? result : null;
    private static string? RecognizedPhase(string? phase) => phase is "commentary" or "final_answer" ? phase : null;
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
        Func<string, Stream>? openNew = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sandboxRoot);
        this.sandboxRoot = Path.GetFullPath(sandboxRoot);
        this.writeBytes = writeBytes ?? WriteBytesAsync;
        this.openNew = openNew ?? OpenNew;
        Directory.CreateDirectory(this.sandboxRoot);
    }

    public int SuccessfulEffects => Volatile.Read(ref successfulEffects);

    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>() ?? "";
        if (name != "write_fixture")
            return UnsupportedTurnToolExecutor.ToolError("unknown_tool", $"Unknown tool: {name}");
        if (functionCall["args"] is not JsonObject args
            || args.Count != 2
            || args["fileName"] is not JsonValue fileNameValue
            || !fileNameValue.TryGetValue<string>(out var fileName)
            || args["content"] is not JsonValue contentValue
            || !contentValue.TryGetValue<string>(out var content))
            return UnsupportedTurnToolExecutor.ToolError(
                "invalid_tool_arguments",
                "write_fixture requires exactly string fileName and content.");
        if (!IsPlainFileName(fileName))
            return UnsupportedTurnToolExecutor.ToolError("invalid_path", "fileName must be a plain file name.");

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

    private static Stream OpenNew(string path) => new FileStream(
        path,
        FileMode.CreateNew,
        FileAccess.Write,
        FileShare.None,
        4096,
        FileOptions.Asynchronous);

    private static bool TargetExists(string path)
    {
        try { return File.Exists(path) || Directory.Exists(path) || new FileInfo(path).LinkTarget is not null; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static JsonObject ToolIoError() => UnsupportedTurnToolExecutor.ToolError(
        "tool_io_error",
        "write_fixture failed due to an I/O error.");

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
    private const int MaxErrorBodyBytes = 64 * 1024;
    private readonly HttpClient httpClient;
    private readonly ResponsesClientOptions options;
    private readonly Action<string, ResponsesStreamProgress>? progress;

    public ResponsesChatService(HttpClient httpClient, ResponsesClientOptions options,
        Action<string, ResponsesStreamProgress>? progress = null)
    {
        this.httpClient = httpClient;
        this.options = options;
        this.progress = progress;
    }

    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken)
    {
        var body = ResponsesRequestSerializer.BuildRequest(
            history,
            options.RequestModel,
            options.ConcreteModelId,
            options.Instructions,
            options.MaxOutputTokens,
            options.Tools,
            options.Effort);
        if (options.ExtraFields is not null) foreach (var (key, value) in options.ExtraFields) body[key] = value?.DeepClone();
        if (options.Effort is string effort)
        {
            var reasoning = body["reasoning"] as JsonObject ?? new JsonObject(); reasoning["effort"] = effort;
            var include = body["include"] as JsonArray ?? new JsonArray();
            if (effort == "none")
            {
                reasoning.Remove("summary"); var filtered = new JsonArray(include.Where(value => SessionWait.Text(value) != "reasoning.encrypted_content").Select(value => value?.DeepClone()).ToArray());
                if (filtered.Count > 0) body["include"] = filtered; else body.Remove("include");
            }
            else
            {
                if (!reasoning.ContainsKey("summary")) reasoning["summary"] = "auto";
                if (!include.Any(value => SessionWait.Text(value) == "reasoning.encrypted_content")) include.Add("reasoning.encrypted_content");
                body["include"] = include.DeepClone();
            }
            body["reasoning"] = reasoning.DeepClone();
        }
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        if (options.RequestCompression is string compression)
        {
            using var buffer = new MemoryStream();
            using (Stream encoder = compression == "gzip" ? new System.IO.Compression.GZipStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true) : new System.IO.Compression.BrotliStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true)) encoder.Write(bytes);
            bytes = buffer.ToArray();
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, options.ResponsesUri) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        if (options.RequestCompression is not null) request.Content.Headers.ContentEncoding.Add(options.RequestCompression);
        if (options.ExtraHeaders is not null) foreach (var (name, value) in options.ExtraHeaders)
        {
            var text = value?.ToString() ?? "";
            if (request.Headers.TryAddWithoutValidation(name, text))
            { request.Headers.Remove(name); request.Headers.TryAddWithoutValidation(name, text); }
            else { request.Content.Headers.Remove(name); request.Content.Headers.TryAddWithoutValidation(name, text); }
        }
        if (options.RequestCompression is not null)
        {
            request.Content.Headers.ContentEncoding.Clear(); request.Content.Headers.ContentEncoding.Add(options.RequestCompression);
            request.Content.Headers.ContentLength = bytes.Length;
        }
        if (!string.IsNullOrEmpty(options.Token) && options.ExtraHeaders?.Any(pair => pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)) != true)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Token);
        using var inactivity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (options.StreamInactivityTimeoutMs is not null) inactivity.CancelAfter(180000);
        var requestToken = inactivity.Token;

        var started = Stopwatch.GetTimestamp();
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            requestToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var (errorBody, truncated) = await ReadBoundedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            throw new ResponsesHttpException(response.StatusCode, errorBody, truncated);
        }

        await using var stream = await response.Content.ReadAsStreamAsync(requestToken).ConfigureAwait(false);
        var completed = await ResponsesSseCollector.CollectAsync(
            stream,
            requestToken,
            callbacks: new ResponsesStreamCallbacks
            {
                OnProgress = update =>
                {
                    if (options.StreamInactivityTimeoutMs is int timeout) inactivity.CancelAfter(timeout);
                    progress?.Invoke(sessionId, update);
                }
            },
            ownership: StreamOwnership.Dispose).ConfigureAwait(false);
        var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        var assistant = ResponsesCanonicalConverter.ConvertAssistant(completed, options.ConcreteModelId, completedAt, elapsed);
        if (options.DisallowEmptyResponse && (assistant?["parts"] as JsonArray)?.OfType<JsonObject>().Any(part => part["functionCall"] is not null || SessionWait.Text(part["text"]) is string text && !string.IsNullOrWhiteSpace(text)) != true)
            throw new InvalidDataException("Selected model disallows an empty completed response.");
        return new ChatResult(assistant);
    }

    private static async Task<(string Body, bool Truncated)> ReadBoundedAsync(
        HttpContent content,
        CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var buffer = new byte[4096];
        using var output = new MemoryStream();
        var truncated = false;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            var remaining = MaxErrorBodyBytes - (int)output.Length;
            if (remaining <= 0) { truncated = true; break; }
            var accepted = Math.Min(remaining, read);
            output.Write(buffer, 0, accepted);
            if (accepted < read) { truncated = true; break; }
        }
        return (Encoding.UTF8.GetString(output.ToArray()), truncated);
    }
}
