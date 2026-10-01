using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class CompletionsChatService(HttpClient http, ResponsesClientOptions options,
    string reasoningField, string promptCacheKey, Action<string, ResponsesStreamProgress>? progress = null) : IChatService
{
    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var body = CompletionsRequestSerializer.BuildRequest(history, options, reasoningField, promptCacheKey);
        var endpoint = new Uri(options.BaseUri.ToString().TrimEnd('/') + "/chat/completions", UriKind.Absolute);
        var completed = await OpenAIHttp.RequestAsync(http, endpoint, body, options, sessionId, progress, "foxwarm/1.0",
            (stream, token, callbacks) => CompletionsSseCollector.CollectAsync(stream, token, callbacks), cancellationToken).ConfigureAwait(false);
        var assistant = CompletionsCanonicalConverter.ConvertAssistant(completed.Payload, options.ConcreteModelId, completed.CompletedAt, completed.DurationMs);
        if (options.DisallowEmptyResponse && !OpenAIHttp.HasMeaningfulAssistant(assistant))
            throw ModelAttemptFailure.Empty();
        return new ChatResult(assistant);
    }
}
