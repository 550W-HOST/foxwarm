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
        if (options.AttemptPrepared is not null)
            await options.AttemptPrepared(body).ConfigureAwait(false);
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
        using var attempt = new ResponsesAttempt(
            options,
            token,
            update => progress?.Invoke(sessionId, update)
        );
        try
        {
            try
            {
                pending = await transport
                    .RequestAsync(
                        options.ResponsesUri,
                        headers,
                        options.ConcreteModelId,
                        body,
                        attempt.Callbacks,
                        options.StreamInactivityTimeoutMs,
                        attempt.Token,
                        sessionId,
                        scope
                                is ModelRequestScope.CompactPlan
                                    or ModelRequestScope.BackgroundCompactPlan
                                ? "compact-plan"
                            : scope == ModelRequestScope.Canonical ? "chat"
                            : scope == ModelRequestScope.Btw ? "btw"
                            : "low-level",
                        token
                    )
                    .ConfigureAwait(false);
            }
            catch (Exception error)
            {
                await attempt.FailedAsync(error).ConfigureAwait(false);
                throw;
            }
            options.Diagnostics?.Response("101 WebSocket", new JsonObject(), pending.Response);
            var result = await attempt
                .CompleteAsync(
                    pending.Response,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Stopwatch.GetElapsedTime(started).TotalMilliseconds
                )
                .ConfigureAwait(false);
            var assistant = result.AssistantMessage;
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
            // The projected evidence was not emitted or cached by the provider.
            // Send it in a full next request before exact-prefix reuse can resume.
            var hostedSearch = (pending.Response["output"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Any(item => SessionWait.Text(item["type"]) == "web_search_call");
            var finalizer = new HistoryAppendFinalizer(rows =>
            {
                try
                {
                    if (rows is null || unsafeReplay || hostedSearch)
                    {
                        captured.Finalize(null);
                        return;
                    }
                    var prepared = ConcreteRequestHistory.Prepare(
                        attempt.Committed.Concat(rows).ToArray(),
                        options.ConcreteModelId,
                        options.HistoryCompatibility
                    );
                    var replay = ResponsesRequestSerializer.ConvertHistoryWithImages(
                        prepared,
                        options.ConcreteModelId,
                        options.Images,
                        attempt.ReplayBytes,
                        options.HistoryCompatibility
                    );
                    captured.Finalize(replay.Select(item => item?.DeepClone()).ToArray());
                }
                catch
                {
                    captured.Finalize(null);
                    throw;
                }
            });
            result = result with { HistoryAppend = finalizer };
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
}
