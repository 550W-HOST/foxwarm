using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class ResponsesWsChatService(
    ResponsesClientOptions options,
    ResponsesWsTransport transport,
    ModelRequestScope scope,
    bool ownsTransport,
    string cacheKey,
    Action<string, ResponsesStreamProgress>? progress = null
) : IChatService
{
    // Source Responses WebSocket defaults; HTTP adapter defaults remain independent.
    internal const string SourceUserAgent =
        "codex-tui/0.118.0 (Debian 13.0.0; x86_64) xterm.js_6.1.0-beta.191_ (codex-tui; 0.118.0)";

    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken token
    )
    {
        var body = ResponsesRequestPlan.Build(
            history,
            options.ProviderPromptCacheKey is null
                ? options with
                {
                    ProviderPromptCacheKey = ProviderPromptCache.Resolve(
                        "openai-ws",
                        sessionId,
                        cacheKey
                    ),
                }
                : options
        );
        body.Remove("stream");
        if (options.JournalAttemptStart is not null)
            await options.JournalAttemptStart(body).ConfigureAwait(false);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = "application/json",
            ["user-agent"] = SourceUserAgent,
            ["originator"] = "codex-tui",
        };
        if (options.Token.Length > 0)
            headers["Authorization"] = "Bearer " + options.Token;
        foreach (var (key, value) in options.ExtraHeaders ?? new JsonObject())
            headers[key] = SessionWait.Text(value) ?? (value?.ToJsonString() ?? "");
        var started = Stopwatch.GetTimestamp();
        WsPendingCompletion? pending = null;
        try
        {
            pending = await transport
                .RequestAsync(
                    options.ResponsesUri,
                    headers,
                    options.ConcreteModelId,
                    body,
                    new ResponsesStreamCallbacks
                    {
                        OnProgress = update => progress?.Invoke(sessionId, update),
                    },
                    options.StreamInactivityTimeoutMs,
                    token,
                    sessionId,
                    scope
                            is ModelRequestScope.CompactPlan
                                or ModelRequestScope.BackgroundCompactPlan
                            ? "compact-plan"
                        : scope == ModelRequestScope.Canonical ? "chat"
                        : "low-level"
                )
                .ConfigureAwait(false);
            GeneratedImageNormalization? generated = null;
            if (options.Images is not null && pending.Response["output"] is JsonArray output)
            {
                generated = await HostedResponsesTools.ExternalizeAsync(
                    output,
                    options.Images,
                    options.ConcreteModelId,
                    token
                );
                if (
                    generated.SuccessfulCount == 0
                    && generated.Failures.Count > 0
                    && !HasOtherUsableOutput(output)
                )
                    throw ModelAttemptFailure.GeneratedImageFailure(
                        HostedResponsesTools.FailureNote(generated.Failures)
                    );
            }
            var assistant = ResponsesCanonicalConverter.ConvertAssistant(
                pending.Response,
                options.ConcreteModelId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                generated?.Parts,
                generated?.Failures
            );
            if (options.DisallowEmptyResponse && !OpenAIHttp.HasMeaningfulAssistant(assistant))
                throw ModelAttemptFailure.Empty();
            var captured = pending;
            var unsafeReplay =
                (pending.Response["output"] as JsonArray)
                    ?.OfType<JsonObject>()
                    .Any(item =>
                        (
                            SessionWait.Text(item["type"]) == "message"
                            && (item["content"] as JsonArray)
                                ?.OfType<JsonObject>()
                                .Any(part => SessionWait.Text(part["type"]) == "refusal") == true
                        )
                        || (
                            SessionWait.Text(item["type"]) == "function_call"
                            && string.IsNullOrWhiteSpace(SessionWait.Text(item["call_id"]))
                        )
                    ) == true
                || (assistant?["parts"] as JsonArray)
                    ?.OfType<JsonObject>()
                    .Any(part =>
                        SessionWait.Text(part["functionCall"]?["argsParseError"]) is { Length: > 0 }
                    ) == true;
            var finalizer = new HistoryAppendFinalizer(rows =>
            {
                try
                {
                    if (rows is null || unsafeReplay)
                    {
                        captured.Finalize(null);
                        return;
                    }
                    var prepared = ConcreteRequestHistory.Prepare(rows, options.ConcreteModelId);
                    var replay = ResponsesRequestSerializer.ConvertHistory(
                        prepared,
                        options.ConcreteModelId
                    );
                    captured.Finalize(replay.Select(item => item?.DeepClone()).ToArray());
                }
                catch
                {
                    captured.Finalize(null);
                    throw;
                }
            });
            var result = new ChatResult(assistant) { HistoryAppend = finalizer };
            if (scope == ModelRequestScope.LowLevel || ownsTransport)
                result.FinalizeHistory(null);
            return result;
        }
        catch
        {
            pending?.Finalize(null);
            throw;
        }
        finally
        {
            if (ownsTransport)
                await transport.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static bool HasOtherUsableOutput(JsonArray output) =>
        output
            .OfType<JsonObject>()
            .Any(item =>
                !HostedResponsesTools.IsGeneratedImage(item)
                && (
                    SessionWait.Text(item["type"]) == "function_call"
                    || SessionWait.Text(item["type"]) == "message"
                        && (item["content"] as JsonArray)
                            ?.OfType<JsonObject>()
                            .Any(content =>
                                SessionWait.Text(content["text"]) is { Length: > 0 }
                                || SessionWait.Text(content["refusal"]) is { Length: > 0 }
                            ) == true
                )
            );
}
