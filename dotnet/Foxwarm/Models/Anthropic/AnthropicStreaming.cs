using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class AnthropicEventAccumulator(
    ResponsesStreamCallbacks? callbacks = null,
    Action<bool>? reasoningPhase = null
)
{
    private sealed class Block(int index, JsonObject content)
    {
        internal int Index { get; } = index;
        internal JsonObject Content { get; } = content;
        internal string Kind => SessionWait.Text(Content["type"]) ?? "";
        internal string PartialJson { get; set; } = "";
        internal bool Closed { get; set; }
    }

    private readonly SortedDictionary<int, Block> blocks = [];
    private JsonObject? message;
    private JsonObject? usage;
    private JsonObject delta = new();
    internal bool Stopped { get; private set; }

    private static int Index(JsonObject item)
    {
        var number = SessionWait.Number(item["index"]);
        if (number is null || number < 0 || number > int.MaxValue || Math.Floor(number.Value) != number)
            throw new InvalidDataException("Anthropic stream has an invalid content block index.");
        return (int)number.Value;
    }

    private Block RequireBlock(JsonObject item)
    {
        var index = Index(item);
        if (!blocks.TryGetValue(index, out var block))
            throw new InvalidDataException($"Anthropic stream referenced unknown content block {index}.");
        if (block.Closed)
            throw new InvalidDataException($"Anthropic stream sent content for closed content block {index}.");
        return block;
    }

    internal void Consume(JsonObject item)
    {
        switch (SessionWait.Text(item["type"]))
        {
            case "message_start":
                message = (JsonObject?)item["message"]?.DeepClone() ?? new JsonObject();
                usage = message["usage"] is JsonObject initial ? (JsonObject)initial.DeepClone() : null;
                break;
            case "content_block_start":
                var index = Index(item);
                var content = item["content_block"] is JsonObject raw ? (JsonObject)raw.DeepClone() : new JsonObject();
                var block = new Block(index, content);
                if (!blocks.TryAdd(index, block))
                    throw new InvalidDataException($"Anthropic stream started duplicate content block {index}.");
                switch (block.Kind)
                {
                    case "text":
                        content["text"] = SessionWait.Text(content["text"]) ?? "";
                        if (SessionWait.Text(content["text"]) is { Length: > 0 })
                            callbacks?.OnMeaningfulProgress?.Invoke();
                        break;
                    case "thinking":
                        content["thinking"] = SessionWait.Text(content["thinking"]) ?? "";
                        reasoningPhase?.Invoke(true);
                        break;
                    case "redacted_thinking":
                        content["data"] = SessionWait.Text(content["data"]) ?? "";
                        reasoningPhase?.Invoke(true);
                        break;
                    case "tool_use":
                        // Stream input is defined by input_json_delta, not the start placeholder.
                        content.Remove("input");
                        break;
                }
                EmitProgress();
                break;
            case "content_block_delta":
                var active = RequireBlock(item);
                var update = item["delta"] as JsonObject ?? new JsonObject();
                var type = SessionWait.Text(update["type"]);
                if (type == "signature_delta" && active.Kind == "thinking")
                {
                    Append(active.Content, "signature", SessionWait.Text(update["signature"]) ?? "");
                    break;
                }
                string fragment;
                if (type == "text_delta" && active.Kind == "text")
                {
                    fragment = SessionWait.Text(update["text"]) ?? "";
                    Append(active.Content, "text", fragment);
                }
                else if (type == "thinking_delta" && active.Kind == "thinking")
                {
                    fragment = SessionWait.Text(update["thinking"]) ?? "";
                    Append(active.Content, "thinking", fragment);
                }
                else if (type == "input_json_delta" && active.Kind == "tool_use")
                {
                    fragment = SessionWait.Text(update["partial_json"]) ?? "";
                    active.PartialJson += fragment;
                }
                else if (type is null || active.Kind is not ("text" or "thinking" or "redacted_thinking" or "tool_use"))
                    break;
                else
                    throw new InvalidDataException($"Anthropic stream sent {type} for a {active.Kind} content block.");
                if (fragment.Length > 0)
                    callbacks?.OnMeaningfulProgress?.Invoke();
                EmitProgress();
                break;
            case "content_block_stop":
                var closed = RequireBlock(item);
                closed.Closed = true;
                if (closed.Kind == "tool_use")
                {
                    closed.Content["input"] = FinalizeInput(closed.PartialJson);
                    EmitProgress();
                }
                else if (closed.Kind is "thinking" or "redacted_thinking")
                    reasoningPhase?.Invoke(false);
                break;
            case "message_delta":
                if (item["delta"] is JsonObject changes)
                    foreach (var key in new[] { "stop_reason", "stop_sequence", "stop_details" })
                        if (changes.ContainsKey(key))
                            delta[key] = changes[key]?.DeepClone();
                if (item["usage"] is JsonObject totals)
                {
                    usage ??= new JsonObject();
                    foreach (var (key, value) in totals)
                        usage[key] = value?.DeepClone();
                }
                break;
            case "message_stop":
                Stopped = true;
                break;
            case "error":
                var error = item["error"] as JsonObject;
                throw new InvalidDataException(
                    $"Anthropic stream error ({SessionWait.Text(error?["type"]) ?? "error"}): {SessionWait.Text(error?["message"]) ?? "Anthropic stream error."}"
                );
            // Pings and future event types are not semantic progress.
        }
    }

    private static void Append(JsonObject content, string key, string fragment) =>
        content[key] = (SessionWait.Text(content[key]) ?? "") + fragment;

    private static JsonNode FinalizeInput(string partial)
    {
        if (partial.Trim().Length == 0)
            return new JsonObject();
        try
        {
            if (JsonNode.Parse(partial) is JsonObject input)
                return input;
        }
        catch (JsonException) { }
        return JsonValue.Create(partial)!;
    }

    private void EmitProgress() => callbacks?.OnProgress?.Invoke(
        new ResponsesStreamProgress(
            string.Join("\n", blocks.Values.Where(block => block.Kind == "thinking")
                .Select(block => SessionWait.Text(block.Content["thinking"]) ?? "").Where(value => value.Length > 0)),
            string.Concat(blocks.Values.Where(block => block.Kind == "text")
                .Select(block => SessionWait.Text(block.Content["text"]) ?? "")),
            blocks.Values.Where(block => block.Kind == "tool_use").Select(block =>
                new ResponsesToolCallProgress(block.Index, SessionWait.Text(block.Content["id"]),
                    SessionWait.Text(block.Content["name"]), block.PartialJson)).ToArray()
        )
    );

    internal JsonObject Complete()
    {
        if (!Stopped)
            throw new InvalidDataException("Anthropic message stream ended before message_stop.");
        if (message is null)
            throw new InvalidDataException("Anthropic message stream ended before message_start.");
        if (!delta.ContainsKey("stop_reason"))
            throw new InvalidDataException("Anthropic message stream ended without a message_delta stop_reason.");
        foreach (var block in blocks.Values)
            if (!block.Closed)
                throw new InvalidDataException($"Anthropic message stream ended with content block {block.Index} still open.");
        var result = (JsonObject)message.DeepClone();
        result["type"] = "message";
        result["role"] = "assistant";
        result["content"] = new JsonArray(blocks.Values.Select(block => block.Content.DeepClone()).ToArray());
        foreach (var (key, value) in delta)
            result[key] = value?.DeepClone();
        if (usage is not null)
            result["usage"] = usage.DeepClone();
        return result;
    }
}

internal static class AnthropicSseCollector
{
    internal static async Task<JsonObject> CollectAsync(
        Stream stream,
        CancellationToken token,
        ResponsesStreamCallbacks? callbacks = null,
        Action<bool>? reasoningPhase = null
    )
    {
        var accumulator = new AnthropicEventAccumulator(callbacks, reasoningPhase);
        await OpenAISseReader.ReadAsync(stream, token, accumulator.Consume, callbacks,
            StreamOwnership.Dispose, () => accumulator.Stopped, flushFinalEvent: true).ConfigureAwait(false);
        return accumulator.Complete();
    }
}
