using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Foxwarm.Models;

public enum StreamOwnership
{
    LeaveOpen,
    Dispose,
}

public enum ResponsesStreamErrorCategory
{
    EofBeforeCompleted,
    MalformedSseEventJson,
    ProviderTerminal,
    Read,
    Cancellation,
}

public sealed record ResponsesToolCallProgress(
    int Index,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Arguments
);

public sealed record ResponsesStreamProgress(
    string Reasoning,
    string Text,
    IReadOnlyList<ResponsesToolCallProgress> ToolCalls
);

public sealed class ResponsesStreamCallbacks
{
    public Action<ResponsesStreamProgress>? OnProgress { get; init; }
    public Action? OnMeaningfulProgress { get; init; }
    public Action<JsonObject>? OnSafetyBuffering { get; init; }
    public Action<string>? OnDecodedChunk { get; init; }
    public Action<string>? OnSseBlock { get; init; }
}

public class ResponsesStreamException : Exception
{
    public ResponsesStreamErrorCategory Category { get; }

    public ResponsesStreamException(
        ResponsesStreamErrorCategory category,
        string message,
        Exception? inner = null
    )
        : base(message, inner) => Category = category;
}

public sealed class OpenAiResponsesTerminalException : ResponsesStreamException
{
    public string TerminalKind { get; }
    public string? Status { get; }
    public string? Code { get; }
    public JsonObject? Details { get; }

    public OpenAiResponsesTerminalException(
        string terminalKind,
        string message,
        string? status,
        string? code,
        JsonObject? details
    )
        : base(ResponsesStreamErrorCategory.ProviderTerminal, message)
    {
        TerminalKind = terminalKind;
        Status = status;
        Code = code;
        Details = details;
    }
}

public sealed class MalformedSseEventJsonException : ResponsesStreamException
{
    public string Block { get; }

    public MalformedSseEventJsonException(string block, Exception inner)
        : base(
            ResponsesStreamErrorCategory.MalformedSseEventJson,
            "Malformed OpenAI Responses SSE event JSON.",
            inner
        ) => Block = block;
}

public sealed class ResponsesStreamReadException : ResponsesStreamException
{
    public ResponsesStreamReadException(Exception inner)
        : base(ResponsesStreamErrorCategory.Read, "OpenAI Responses stream read failed.", inner) { }
}

public sealed class ResponsesEventAccumulator
{
    private readonly ResponsesStreamCallbacks? callbacks;
    private readonly SortedDictionary<int, JsonObject> outputItems = new();
    private readonly Dictionary<(int Output, int Summary), string> summaryParts = new();
    private JsonObject? completedResponse;
    private string lastSummaryText = "";

    public ResponsesEventAccumulator(ResponsesStreamCallbacks? callbacks = null) =>
        this.callbacks = callbacks;

    public bool HasCompletedResponse => completedResponse is not null;

    public void Consume(JsonObject input)
    {
        var eventNode = (JsonObject)input.DeepClone();
        var type = String(eventNode, "type");
        var outputIndex = Int(eventNode, "output_index");
        var contentIndex = Int(eventNode, "content_index");
        var summaryIndex = Int(eventNode, "summary_index") ?? 0;
        switch (type)
        {
            case "response.output_item.added":
            case "response.output_item.done":
                if (outputIndex is not null && eventNode["item"] is JsonObject lifecycleItem)
                {
                    callbacks?.OnMeaningfulProgress?.Invoke();
                    EnsureOutputItem(outputIndex.Value, lifecycleItem);
                    EmitProgress();
                }
                return;
            case "response.content_part.added":
            case "response.content_part.done":
                if (outputIndex is not null && contentIndex is not null)
                {
                    EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        eventNode["part"] as JsonObject
                    );
                    EmitProgress();
                }
                return;
            case "response.output_text.delta":
                if (String(eventNode, "delta") is { Length: > 0 })
                    callbacks?.OnMeaningfulProgress?.Invoke();
                if (outputIndex is not null && contentIndex is not null)
                {
                    var deltaPart = EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        new JsonObject { ["type"] = "output_text" }
                    );
                    if (deltaPart is not null)
                        Append(deltaPart, "text", eventNode["delta"]);
                    EmitProgress();
                }
                return;
            case "response.output_text.done":
                if (outputIndex is not null && contentIndex is not null)
                {
                    var donePart = EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        new JsonObject
                        {
                            ["type"] = "output_text",
                            ["text"] = String(eventNode, "text") ?? "",
                        }
                    );
                    if (
                        donePart is not null
                        && eventNode["text"] is JsonValue textValue
                        && textValue.TryGetValue<string>(out var doneText)
                    )
                    {
                        donePart["text"] = doneText;
                        EmitProgress();
                    }
                }
                return;
            case "response.output_text.annotation.added":
                if (
                    outputIndex is not null
                    && contentIndex is not null
                    && eventNode["annotation"] is JsonObject annotation
                )
                {
                    var annotationPart = EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        new JsonObject { ["type"] = "output_text" }
                    );
                    if (annotationPart is not null)
                    {
                        if (annotationPart["annotations"] is not JsonArray annotations)
                        {
                            annotations = new JsonArray();
                            annotationPart["annotations"] = annotations;
                        }
                        var index = Int(eventNode, "annotation_index") ?? annotations.Count;
                        while (annotations.Count <= index)
                            annotations.Add(null);
                        annotations[index] = annotation.DeepClone();
                        EmitProgress();
                    }
                }
                return;
            case "response.refusal.delta":
                if (String(eventNode, "delta") is { Length: > 0 })
                    callbacks?.OnMeaningfulProgress?.Invoke();
                if (outputIndex is not null && contentIndex is not null)
                {
                    var refusalPart = EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        new JsonObject { ["type"] = "refusal" }
                    );
                    if (refusalPart is not null)
                        Append(refusalPart, "refusal", eventNode["delta"]);
                    EmitProgress();
                }
                return;
            case "response.refusal.done":
                if (outputIndex is not null && contentIndex is not null)
                {
                    var refusalDonePart = EnsureContentPart(
                        outputIndex.Value,
                        contentIndex.Value,
                        new JsonObject
                        {
                            ["type"] = "refusal",
                            ["refusal"] = String(eventNode, "refusal") ?? "",
                        }
                    );
                    if (
                        refusalDonePart is not null
                        && eventNode["refusal"] is JsonValue refusalValue
                        && refusalValue.TryGetValue<string>(out var doneRefusal)
                    )
                    {
                        refusalDonePart["refusal"] = doneRefusal;
                        EmitProgress();
                    }
                }
                return;
            case "response.function_call_arguments.delta":
                if (String(eventNode, "delta") is { Length: > 0 })
                    callbacks?.OnMeaningfulProgress?.Invoke();
                if (outputIndex is not null)
                {
                    var functionDeltaItem = EnsureOutputItem(
                        outputIndex.Value,
                        new JsonObject { ["type"] = "function_call" }
                    );
                    if (functionDeltaItem is not null)
                        Append(functionDeltaItem, "arguments", eventNode["delta"]);
                    EmitProgress();
                }
                return;
            case "response.function_call_arguments.done":
                if (outputIndex is not null)
                {
                    var functionDoneItem = EnsureOutputItem(
                        outputIndex.Value,
                        new JsonObject
                        {
                            ["type"] = "function_call",
                            ["arguments"] = String(eventNode, "arguments") ?? "",
                        }
                    );
                    if (
                        functionDoneItem is not null
                        && eventNode["arguments"] is JsonValue argumentValue
                        && argumentValue.TryGetValue<string>(out var doneArguments)
                    )
                    {
                        functionDoneItem["arguments"] = doneArguments;
                        EmitProgress();
                    }
                }
                return;
            case "response.reasoning_summary_part.done":
                if (
                    eventNode["part"] is JsonObject summaryPart
                    && String(summaryPart, "text") is { Length: > 0 } summaryText
                )
                {
                    summaryParts[(outputIndex ?? 0, summaryIndex)] = summaryText;
                    EmitSummaryUpdate();
                }
                return;
            case "response.reasoning_summary_text.delta":
                if (String(eventNode, "delta") is { Length: > 0 } delta)
                    callbacks?.OnMeaningfulProgress?.Invoke();
                summaryParts[(outputIndex ?? 0, summaryIndex)] =
                    (
                        summaryParts.TryGetValue((outputIndex ?? 0, summaryIndex), out var old)
                            ? old
                            : ""
                    ) + (String(eventNode, "delta") ?? "");
                EmitSummaryUpdate();
                return;
            case "response.reasoning_summary_text.done":
                var key = (outputIndex ?? 0, summaryIndex);
                var doneSummary = String(eventNode, "text");
                summaryParts[key] = !string.IsNullOrEmpty(doneSummary)
                    ? doneSummary
                    : (summaryParts.TryGetValue(key, out var current) ? current : "");
                EmitSummaryUpdate();
                return;
            case "response.metadata":
                if (
                    eventNode["metadata"] is JsonObject metadata
                    && String(metadata, "type") == "safety_buffering"
                )
                    callbacks?.OnSafetyBuffering?.Invoke((JsonObject)metadata.DeepClone());
                return;
            case "response.completed":
                if (eventNode["response"] is JsonObject response)
                {
                    completedResponse = (JsonObject)response.DeepClone();
                    completedResponse["output"] = MergeCompletedOutputItems(
                        completedResponse["output"]
                    );
                    EmitProgress();
                }
                return;
            case "response.failed":
                throw BuildTerminal(
                    "response.failed",
                    "OpenAI Responses request failed.",
                    eventNode["response"]
                );
            case "response.incomplete":
                throw BuildTerminal(
                    "response.incomplete",
                    "OpenAI Responses request was incomplete.",
                    eventNode["response"]
                );
            case "response.error":
                throw BuildTerminal(
                    "response.error",
                    "OpenAI Responses stream error.",
                    eventNode["error"]
                );
            case "error":
                throw BuildTerminal("error", "OpenAI Responses stream error.", eventNode);
        }
    }

    public JsonObject CompleteAtEof()
    {
        if (completedResponse is not null)
            return (JsonObject)completedResponse.DeepClone();
        throw new ResponsesStreamException(
            ResponsesStreamErrorCategory.EofBeforeCompleted,
            "OpenAI Responses stream ended before response.completed."
        );
    }

    private JsonObject? EnsureOutputItem(int index, JsonObject? incoming)
    {
        if (incoming is null)
            return outputItems.TryGetValue(index, out var existing) ? existing : null;
        var next = MergeOutput(
            outputItems.TryGetValue(index, out var current) ? current : null,
            incoming
        );
        outputItems[index] = next!;
        return next;
    }

    private JsonObject? EnsureContentPart(int outputIndex, int contentIndex, JsonObject? incoming)
    {
        var item = EnsureOutputItem(
            outputIndex,
            new JsonObject
            {
                ["type"] = "message",
                ["role"] = "assistant",
                ["content"] = new JsonArray(),
            }
        );
        if (item is null)
            return null;
        if (item["content"] is not JsonArray content)
        {
            content = new JsonArray();
            item["content"] = content;
        }
        while (content.Count <= contentIndex)
            content.Add(null);
        content[contentIndex] = MergeContent(content[contentIndex] as JsonObject, incoming);
        return content[contentIndex] as JsonObject;
    }

    private ResponsesStreamProgress BuildProgress()
    {
        var reasoning = string.Join(
            "\n",
            summaryParts
                .OrderBy(x => x.Key.Output)
                .ThenBy(x => x.Key.Summary)
                .Select(x => x.Value)
                .Where(x => x.Length > 0)
        );
        var text = string.Join(
            "",
            outputItems
                .OrderBy(x => x.Key)
                .Select(x => x.Value)
                .Where(item =>
                    String(item, "type") == "message" && String(item, "role") == "assistant"
                )
                .SelectMany(item =>
                    (item["content"] as JsonArray ?? []).Select(part => part as JsonObject)
                )
                .Select(part =>
                    String(part, "type") == "output_text" ? String(part, "text")
                    : String(part, "type") == "refusal" ? String(part, "refusal")
                    : ""
                )
                .Where(x => x is not null)
        );
        var calls = outputItems
            .OrderBy(x => x.Key)
            .Where(x => String(x.Value, "type") == "function_call")
            .Select(x => new ResponsesToolCallProgress(
                x.Key,
                Clean(String(x.Value, "call_id") ?? String(x.Value, "id")),
                Clean(String(x.Value, "name")),
                String(x.Value, "arguments")
            ))
            .ToList();
        return new ResponsesStreamProgress(reasoning, text, calls.AsReadOnly());
    }

    private void EmitProgress() => callbacks?.OnProgress?.Invoke(BuildProgress());

    private void EmitSummaryUpdate()
    {
        var current = BuildProgress().Reasoning;
        if (current == lastSummaryText)
            return;
        lastSummaryText = current;
        EmitProgress();
    }

    private JsonArray MergeCompletedOutputItems(JsonNode? completedOutput)
    {
        var streamed = BuildOutputEntries();
        if (streamed.Count == 0)
            return completedOutput as JsonArray is { } array
                ? (JsonArray)array.DeepClone()
                : new JsonArray();
        var completed = completedOutput as JsonArray;
        var aligned =
            completed is not null
            && streamed.Count == completed.Count
            && streamed
                .Select(
                    (entry, i) =>
                        entry.Index == i
                        && entry.Item is not null
                        && completed[i] is JsonObject completedItem
                        && String(entry.Item, "type") is { } type
                        && type == String(completedItem, "type")
                        && CompatibleIds(entry.Item, completedItem)
                )
                .All(x => x);
        if (!aligned)
            return new JsonArray(streamed.Select(x => x.Item!.DeepClone()).ToArray());
        var result = new JsonArray();
        for (var i = 0; i < streamed.Count; i++)
        {
            var completedItem = (JsonObject)completed![i]!;
            var merged = MergeOutput(streamed[i].Item, completedItem)!;
            if (
                String(streamed[i].Item, "type") == "reasoning"
                && HasUsableSummary(streamed[i].Item["summary"])
            )
                merged["summary"] = streamed[i].Item["summary"]!.DeepClone();
            result.Add(merged);
        }
        return result;
    }

    private List<(int Index, JsonObject Item)> BuildOutputEntries() =>
        outputItems
            .OrderBy(x => x.Key)
            .Select(x =>
            {
                var item = (JsonObject)x.Value.DeepClone();
                if (item["content"] is JsonArray content)
                    item["content"] = new JsonArray(
                        content.Where(x => x is not null).Select(x => x!.DeepClone()).ToArray()
                    );
                var summaries = summaryParts
                    .Where(p => p.Key.Output == x.Key && p.Value.Length > 0)
                    .OrderBy(p => p.Key.Summary)
                    .Select(p => new JsonObject { ["type"] = "summary_text", ["text"] = p.Value })
                    .ToArray();
                if (String(item, "type") == "reasoning" && summaries.Length > 0)
                    item["summary"] = new JsonArray(summaries);
                return (x.Key, item);
            })
            .ToList();

    private static bool CompatibleIds(JsonObject a, JsonObject b)
    {
        var left = String(a, "id") ?? String(a, "call_id");
        var right = String(b, "id") ?? String(b, "call_id");
        return left is null || right is null || left == right;
    }

    private static bool HasUsableSummary(JsonNode? value) =>
        value is JsonArray array
        && array.Any(x =>
            x is JsonObject o && (String(o, "text") ?? String(o, "summary")) is { Length: > 0 }
        );

    private static JsonObject MergeContent(JsonObject? existing, JsonObject? incoming)
    {
        if (existing is null)
            return incoming is null ? new JsonObject() : (JsonObject)incoming.DeepClone();
        if (incoming is null)
            return (JsonObject)existing.DeepClone();
        var merged = (JsonObject)existing.DeepClone();
        foreach (var pair in incoming)
            merged[pair.Key] = pair.Value?.DeepClone();
        if (incoming.ContainsKey("text") || existing.ContainsKey("text"))
            merged["text"] = incoming["text"] is not null
                ? incoming["text"]!.DeepClone()
                : existing["text"]?.DeepClone();
        if (incoming.ContainsKey("refusal") || existing.ContainsKey("refusal"))
            merged["refusal"] = incoming["refusal"] is not null
                ? incoming["refusal"]!.DeepClone()
                : existing["refusal"]?.DeepClone();
        if (incoming["annotations"] is JsonArray ia && ia.Count > 0)
            merged["annotations"] = ia.DeepClone();
        else if (existing.ContainsKey("annotations"))
            merged["annotations"] = existing["annotations"]?.DeepClone();
        return merged;
    }

    private static JsonObject MergeOutput(JsonObject? existing, JsonObject incoming)
    {
        if (existing is null)
            return (JsonObject)incoming.DeepClone();
        var merged = (JsonObject)existing.DeepClone();
        foreach (var pair in incoming)
            merged[pair.Key] = pair.Value?.DeepClone();
        var ec = existing["content"] as JsonArray;
        var ic = incoming["content"] as JsonArray;
        if (ec is not null || ic is not null)
        {
            var max = Math.Max(ec?.Count ?? 0, ic?.Count ?? 0);
            var content = new JsonArray();
            for (var i = 0; i < max; i++)
            {
                var mergedPart = MergeContent(
                    ec is not null && i < ec.Count ? ec[i] as JsonObject : null,
                    ic is not null && i < ic.Count ? ic[i] as JsonObject : null
                );
                content.Add(mergedPart);
            }
            merged["content"] = content;
        }
        if (
            (!incoming.ContainsKey("arguments") || String(incoming, "arguments") == "")
            && String(existing, "arguments") is { } args
        )
            merged["arguments"] = args;
        if (incoming["summary"] is JsonArray isummary && isummary.Count > 0)
            merged["summary"] = isummary.DeepClone();
        else if (existing["summary"] is not null)
            merged["summary"] = existing["summary"]!.DeepClone();
        return merged;
    }

    private static void Append(JsonObject target, string property, JsonNode? value)
    {
        if (
            value is not JsonValue scalar
            || !scalar.TryGetValue<string>(out var delta)
            || delta.Length == 0
        )
            return;
        target[property] = (String(target, property) ?? "") + delta;
    }

    private OpenAiResponsesTerminalException BuildTerminal(
        string kind,
        string label,
        JsonNode? sourceNode
    )
    {
        var source = sourceNode as JsonObject ?? new JsonObject();
        var detail = source["error"] as JsonObject ?? source;
        var message = String(detail, "message") ?? String(source, "message") ?? label;
        return new OpenAiResponsesTerminalException(
            kind,
            message,
            Scalar(detail["status"] ?? source["status"]),
            String(detail, "code") ?? String(source, "code"),
            (JsonObject)detail.DeepClone()
        );
    }

    private static string? Scalar(JsonNode? node) =>
        node is null ? null
        : node is JsonValue v && v.TryGetValue<string>(out var s) ? s
        : node.ToJsonString();

    private static string? String(JsonObject? obj, string name) =>
        obj?[name] is JsonValue v && v.TryGetValue<string>(out var value) ? value : null;

    private static int? Int(JsonObject obj, string name)
    {
        if (obj[name] is not JsonValue value)
            return null;
        if (value.TryGetValue<int>(out var integer))
            return integer;
        if (
            value.TryGetValue<long>(out var longValue)
            && longValue is >= int.MinValue and <= int.MaxValue
        )
            return (int)longValue;
        return null;
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public static class ResponsesSseCollector
{
    public static async Task<JsonObject> CollectAsync(
        Stream stream,
        CancellationToken cancellationToken,
        ResponsesStreamCallbacks? callbacks = null,
        StreamOwnership ownership = StreamOwnership.Dispose
    )
    {
        var accumulator = new ResponsesEventAccumulator(callbacks);
        await OpenAISseReader
            .ReadAsync(stream, cancellationToken, accumulator.Consume, callbacks, ownership)
            .ConfigureAwait(false);
        return accumulator.CompleteAtEof();
    }
}
