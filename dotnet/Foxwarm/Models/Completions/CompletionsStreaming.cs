using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class CompletionsEventAccumulator(ResponsesStreamCallbacks? callbacks = null)
{
    private sealed record Tool(int StreamIndex, int ProgressIndex, int Sequence, JsonObject Call);

    private readonly List<Tool> tools = [];
    private readonly Dictionary<int, Tool> byIndex = [];
    private readonly HashSet<int> progressIndices = [];
    private readonly JsonObject message = new() { ["role"] = "assistant", ["content"] = "" };
    private JsonNode? usage;
    private string? finishReason;
    private bool sawChoice;
    private int fallbackIndex;

    internal void Consume(JsonObject item)
    {
        if (CompletionsRequestSerializer.Truthy(item["error"]))
            throw new InvalidDataException(
                SessionWait.Text((item["error"] as JsonObject)?["message"]) is { Length: > 0 } error
                    ? error
                    : "OpenAI chat stream error."
            );
        if (CompletionsRequestSerializer.Truthy(item["usage"]))
            usage = item["usage"]?.DeepClone();
        foreach (var rawChoice in item["choices"] as JsonArray ?? [])
        {
            var choice =
                rawChoice as JsonObject
                ?? throw new InvalidDataException("OpenAI chat choice is malformed.");
            if ((SessionWait.Number(choice["index"]) ?? 0) != 0)
                continue;
            sawChoice = true;
            var delta = choice["delta"] as JsonObject ?? new JsonObject();
            var changed = false;
            if (CompletionsRequestSerializer.Truthy(delta["role"]))
                message["role"] = delta["role"]?.DeepClone();
            foreach (var key in new[] { "content", "reasoning_content", "reasoning" })
            {
                if (SessionWait.Text(delta[key]) is not { Length: > 0 } text)
                    continue;
                callbacks?.OnMeaningfulProgress?.Invoke();
                message[key] = (SessionWait.Text(message[key]) ?? "") + text;
                changed = true;
            }
            if (SessionWait.Text(delta["refusal"]) is { Length: > 0 })
                callbacks?.OnMeaningfulProgress?.Invoke();
            if (delta["provider_specific_fields"] is JsonObject opaque)
                message["provider_specific_fields"] = opaque.DeepClone();
            foreach (var rawCall in delta["tool_calls"] as JsonArray ?? [])
            {
                var part =
                    rawCall as JsonObject
                    ?? throw new InvalidDataException("OpenAI chat tool delta is malformed.");
                var number = SessionWait.Number(part["index"]) ?? 0;
                if (Math.Floor(number) != number || number < int.MinValue || number > int.MaxValue)
                    throw new InvalidDataException("OpenAI chat tool index cannot be represented.");
                var index = (int)number;
                var id = SessionWait.Text(part["id"]);
                var function = part["function"] as JsonObject;
                var initial =
                    CompletionsRequestSerializer.Truthy(part["type"])
                    || SessionWait.Text(function?["name"]) is { Length: > 0 };
                if (
                    !byIndex.TryGetValue(index, out var entry)
                    || !string.IsNullOrEmpty(id)
                        && SessionWait.Text(entry.Call["id"]) is { Length: > 0 } oldId
                        && oldId != id
                        && initial
                )
                {
                    var progressIndex = index;
                    if (progressIndices.Contains(progressIndex))
                    {
                        while (progressIndices.Contains(fallbackIndex))
                            fallbackIndex++;
                        progressIndex = fallbackIndex++;
                    }
                    progressIndices.Add(progressIndex);
                    entry = new Tool(
                        index,
                        progressIndex,
                        tools.Count,
                        new JsonObject
                        {
                            ["id"] = "",
                            ["type"] = "function",
                            ["function"] = new JsonObject { ["name"] = "", ["arguments"] = "" },
                        }
                    );
                    tools.Add(entry);
                    byIndex[index] = entry;
                }
                if (!string.IsNullOrEmpty(id))
                    entry.Call["id"] = (SessionWait.Text(entry.Call["id"]) ?? "") + id;
                if (CompletionsRequestSerializer.Truthy(part["type"]))
                    entry.Call["type"] = part["type"]?.DeepClone();
                if (function is not null)
                    foreach (var key in new[] { "name", "arguments" })
                    {
                        if (SessionWait.Text(function[key]) is not { Length: > 0 } fragment)
                            continue;
                        if (key == "arguments")
                            callbacks?.OnMeaningfulProgress?.Invoke();
                        entry.Call["function"]![key] =
                            (SessionWait.Text(entry.Call["function"]?[key]) ?? "") + fragment;
                    }
                changed = true;
            }
            if (changed)
                callbacks?.OnProgress?.Invoke(
                    new ResponsesStreamProgress(
                        string.Join(
                            "\n",
                            new[]
                            {
                                SessionWait.Text(message["reasoning_content"]),
                                SessionWait.Text(message["reasoning"]),
                            }.Where(value => !string.IsNullOrEmpty(value))
                        ),
                        SessionWait.Text(message["content"]) ?? "",
                        Ordered()
                            .Select(entry => new ResponsesToolCallProgress(
                                entry.ProgressIndex,
                                Clean(entry.Call["id"]),
                                Clean(entry.Call["function"]?["name"]),
                                SessionWait.Text(entry.Call["function"]?["arguments"])
                            ))
                            .ToArray()
                    )
                );
            if (SessionWait.Text(choice["finish_reason"]) is { Length: > 0 } reason)
                finishReason = reason;
        }
    }

    private IEnumerable<Tool> Ordered() =>
        tools.OrderBy(tool => tool.StreamIndex).ThenBy(tool => tool.Sequence);

    private static string? Clean(JsonNode? value) =>
        SessionWait.Text(value) is string text
        && OpenAIRequestText.Trim(text) is { Length: > 0 } trimmed
            ? trimmed
            : null;

    internal JsonObject CompleteAtEof()
    {
        if (!sawChoice && usage is null)
            throw new InvalidDataException(
                "OpenAI chat stream ended before any choices were received."
            );
        if (tools.Count > 0)
            message["tool_calls"] = new JsonArray(
                Ordered().Select(entry => entry.Call.DeepClone()).ToArray()
            );
        return new JsonObject
        {
            ["choices"] = new JsonArray(
                new JsonObject
                {
                    ["message"] = message.DeepClone(),
                    ["finish_reason"] = finishReason,
                }
            ),
            ["usage"] = usage?.DeepClone(),
        };
    }
}

internal static class CompletionsSseCollector
{
    internal static async Task<JsonObject> CollectAsync(
        Stream stream,
        CancellationToken cancellationToken,
        ResponsesStreamCallbacks? callbacks = null
    )
    {
        var accumulator = new CompletionsEventAccumulator(callbacks);
        await OpenAISseReader
            .ReadAsync(
                stream,
                cancellationToken,
                accumulator.Consume,
                callbacks,
                StreamOwnership.Dispose
            )
            .ConfigureAwait(false);
        return accumulator.CompleteAtEof();
    }
}
