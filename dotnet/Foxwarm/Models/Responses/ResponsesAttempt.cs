using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Completed output is not a second history authority. Only an ordinary turn's
// exact owner supplies CommitAssistantSegment; detached requests have no lane.
internal sealed class ResponsesAttempt : IDisposable
{
    private readonly ResponsesClientOptions options;
    private readonly CancellationToken caller;
    private readonly CancellationTokenSource attempt;
    private readonly object gate = new();
    private readonly SortedDictionary<int, JsonObject> completed = new();
    private readonly List<JsonObject> committed = [];
    private readonly GeneratedImageBudget imageBudget = new();
    private Task tail = Task.CompletedTask;
    private Exception? failure;
    private int scheduledEnd;
    private int committedEnd;
    private bool responseCompleted;
    private bool callbackFailed;
    private readonly Dictionary<string, byte[]> replayBytes = new(StringComparer.Ordinal);

    internal ResponsesAttempt(ResponsesClientOptions options, CancellationToken caller,
        Action<ResponsesStreamProgress>? progress)
    {
        this.options = options;
        this.caller = caller;
        attempt = CancellationTokenSource.CreateLinkedTokenSource(caller);
        Callbacks = new ResponsesStreamCallbacks
        {
            OnProgress = value =>
            {
                try { progress?.Invoke(value); }
                catch { callbackFailed = true; throw; }
            },
            OnDecodedChunk = text => options.Diagnostics?.Chunk(text),
            OnSseBlock = block => options.Diagnostics?.Block(block),
            OnOutputItemDone = options.CommitAssistantSegment is null ? null : (index, item) =>
            {
                try { OutputDone(index, item); }
                catch { callbackFailed = true; throw; }
            },
            OnResponseCompleted = () => responseCompleted = true,
        };
    }

    internal CancellationToken Token => attempt.Token;
    internal ResponsesStreamCallbacks Callbacks { get; }
    internal IReadOnlyDictionary<string, byte[]> ReplayBytes => replayBytes;
    internal IReadOnlyList<JsonObject> Committed => committed;

    private void OutputDone(int index, JsonObject item)
    {
        lock (gate)
        {
            if (attempt.IsCancellationRequested || failure is not null || index < 0)
                return;
            completed[index] = (JsonObject)item.DeepClone();
            var cursor = scheduledEnd;
            var end = cursor;
            while (completed.TryGetValue(cursor, out var next))
            {
                var type = SessionWait.Text(next["type"]);
                if (next["status"] is not null && SessionWait.Text(next["status"]) != "completed"
                    || type is not ("reasoning" or "message" or "image_generation_call" or "web_search_call"))
                    break;
                if (type == "message" && (SessionWait.Text(next["phase"]) != "commentary"
                    || SessionWait.Text(next["role"]) != "assistant"
                    || (next["content"] as JsonArray ?? []).Any(part => SessionWait.Text(part?["type"]) != "output_text")))
                    break;
                cursor++;
                if (type == "message" && (next["content"] as JsonArray ?? []).Any(part => SessionWait.Text(part?["text"]) is { Length: > 0 }))
                    end = cursor;
            }
            if (end == scheduledEnd)
                return;
            var start = scheduledEnd;
            var output = Slice(start, end);
            scheduledEnd = end;
            tail = CommitAfterAsync(tail, start, end, output);
        }
    }

    private JsonArray Slice(int start, int end) => new(Enumerable.Range(start, end - start)
        .Select(index => (JsonNode?)completed[index].DeepClone()).ToArray());

    private async Task CommitAfterAsync(Task previous, int start, int end, JsonArray output)
    {
        await previous.ConfigureAwait(false);
        if (attempt.IsCancellationRequested || failure is not null)
            return;
        try
        {
            await CommitAsync(start, end, output, true).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            failure = error;
            attempt.Cancel();
        }
    }

    private async Task CommitAsync(int start, int end, JsonArray output, bool deliver)
    {
        var message = await ConvertAsync(new JsonObject { ["output"] = output }, start, 0).ConfigureAwait(false)
            ?? throw new InvalidDataException("Completed Responses prefix had no replayable assistant content.");
        var meta = message["__meta"]!.AsObject();
        meta.Remove("llmRequestTiming");
        meta["llmSegment"] = Segment(start, end, false);
        var row = await options.CommitAssistantSegment!(message, deliver).ConfigureAwait(false);
        committed.Add(row);
        committedEnd = end;
    }

    private async Task SettleAsync()
    {
        Task pending;
        lock (gate)
            pending = tail;
        await pending.ConfigureAwait(false);
        if (failure is not null)
            throw new ModelPreparationException("Completed assistant segment could not be committed.", failure);
    }

    internal async Task FailedAsync(Exception error)
    {
        await SettleAsync().ConfigureAwait(false);
        // Retain only an interrupted upstream's completed, encrypted reasoning
        // prefix. Stop, completed responses and local callback failures cannot opt in.
        if (!options.KeepReasoningOnError || options.CommitAssistantSegment is null
            || caller.IsCancellationRequested || responseCompleted || callbackFailed
            || attempt.IsCancellationRequested || error is ModelPreparationException)
            return;
        var start = committedEnd;
        var end = start;
        JsonArray output;
        lock (gate)
        {
            while (completed.TryGetValue(end, out var item)
                && SessionWait.Text(item["type"]) == "reasoning"
                && (item["status"] is null || SessionWait.Text(item["status"]) == "completed")
                && SessionWait.Text(item["encrypted_content"]) is string encrypted
                && OpenAIRequestText.Trim(encrypted).Length > 0)
                end++;
            output = Slice(start, end);
        }
        if (end == start)
            return;
        try
        {
            await CommitAsync(start, end, output, false).ConfigureAwait(false);
        }
        catch (Exception commitError)
        {
            throw new ModelPreparationException("Completed reasoning segment could not be committed.", commitError);
        }
    }

    internal async Task<ChatResult> CompleteAsync(JsonObject response, long completedAt, double durationMs)
    {
        await SettleAsync().ConfigureAwait(false);
        caller.ThrowIfCancellationRequested();
        var output = response["output"] as JsonArray ?? [];
        var suffix = (JsonObject)response.DeepClone();
        suffix["output"] = new JsonArray(output.Skip(committedEnd).Select(item => item?.DeepClone()).ToArray());
        var assistant = await ConvertAsync(suffix, committedEnd, durationMs, completedAt).ConfigureAwait(false);
        if (committedEnd > 0)
        {
            assistant ??= new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(), ["__meta"] = new JsonObject() };
            assistant["__meta"]!["llmSegment"] = Segment(committedEnd, output.Count, true);
        }
        if (options.DisallowEmptyResponse && !OpenAIHttp.HasMeaningfulAssistant(assistant) && !committed.Any(OpenAIHttp.HasMeaningfulAssistant))
            throw ModelAttemptFailure.Empty();
        return new ChatResult(assistant, ResponsesCanonicalConverter.BuildUsage(response["usage"] as JsonObject))
        {
            CommittedSegments = committed.ToArray(),
        };
    }

    private async Task<JsonObject?> ConvertAsync(JsonObject response, int start, double durationMs, long? completedAt = null)
    {
        GeneratedImageNormalization? generated = null;
        if (options.Images is not null && response["output"] is JsonArray output)
        {
            generated = await HostedResponsesTools.ExternalizeAsync(output, options.Images, options.ConcreteModelId, caller, imageBudget, start).ConfigureAwait(false);
            foreach (var (id, bytes) in generated.ReplayBytes)
                replayBytes[id] = bytes;
            if (generated.SuccessfulCount == 0 && generated.Failures.Count > 0
                && !HasOtherUsableOutput(output) && committed.Count == 0)
                throw ModelAttemptFailure.GeneratedImageFailure(HostedResponsesTools.FailureNote(generated.Failures));
        }
        return ResponsesCanonicalConverter.ConvertAssistant(response, options.ConcreteModelId,
            completedAt ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), durationMs, generated?.Parts, generated?.Failures);
    }

    private static bool HasOtherUsableOutput(JsonArray output) => output.OfType<JsonObject>().Any(item =>
        SessionWait.Text(item["type"]) == "function_call"
        || SessionWait.Text(item["type"]) == "message" && (item["content"] as JsonArray ?? []).OfType<JsonObject>().Any(content =>
            SessionWait.Text(content["text"]) is string text && OpenAIRequestText.Trim(text).Length > 0
            || SessionWait.Text(content["refusal"]) is string refusal && OpenAIRequestText.Trim(refusal).Length > 0));

    private static JsonObject Segment(int start, int end, bool complete) => new()
    {
        ["outputStart"] = start, ["outputEndExclusive"] = end, ["complete"] = complete,
    };

    public void Dispose() => attempt.Dispose();
}
