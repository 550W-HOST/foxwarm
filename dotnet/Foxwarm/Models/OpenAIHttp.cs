using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal static class OpenAIHttp
{
    internal sealed record Completed(JsonObject Payload, long CompletedAt, double DurationMs);

    internal static async Task<Completed> RequestAsync(
        HttpClient http,
        Uri endpoint,
        JsonObject body,
        ResponsesClientOptions options,
        string sessionId,
        Action<string, ResponsesStreamProgress>? progress,
        string? userAgent,
        Func<Stream, CancellationToken, ResponsesStreamCallbacks, Task<JsonObject>> collect,
        CancellationToken cancellationToken,
        ResponsesStreamCallbacks? output = null
    )
    {
        var headers = new Dictionary<string, string>();
        if (userAgent is not null)
            headers["user-agent"] = userAgent;
        if (!string.IsNullOrEmpty(options.Token))
            headers["Authorization"] = "Bearer " + options.Token;
        using var request = ProviderHttpRequest.Create(endpoint, body, options, headers);
        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var watchdog = new StreamActivityWatchdog(
            activity,
            options.StreamInactivityTimeoutMs,
            options.Clock
        );
        var token = activity.Token;
        var callbacks = new ResponsesStreamCallbacks
        {
            OnProgress = update =>
            {
                if (output?.OnProgress is { } publish)
                    publish(update);
                else
                    progress?.Invoke(sessionId, update);
            },
            OnDecodedChunk = text => options.Diagnostics?.Chunk(text),
            OnSseBlock = block => options.Diagnostics?.Block(block),
            OnOutputItemDone = output?.OnOutputItemDone,
            OnResponseCompleted = output?.OnResponseCompleted,
            OnMeaningfulProgress = watchdog.Progress,
            OnImageGenerationActivity = watchdog.ExtendedActivity,
            OnSafetyBuffering = _ => watchdog.ExtendedActivity(),
        };
        var started = Stopwatch.GetTimestamp();
        using var response = await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                token
            )
            .ConfigureAwait(false);
        if (response.StatusCode != System.Net.HttpStatusCode.OK)
        {
            var (error, truncated) = await ReadBoundedAsync(response.Content, token)
                .ConfigureAwait(false);
            options.Diagnostics?.Response(
                $"{(int)response.StatusCode} {response.ReasonPhrase}",
                ProviderHttpRequest.ResponseHeaders(response),
                JsonValue.Create(error),
                truncated
            );
            throw new ResponsesHttpException(response.StatusCode, error, truncated);
        }
        await using var stream = await response
            .Content.ReadAsStreamAsync(token)
            .ConfigureAwait(false);
        options.Diagnostics?.Response(
            $"{(int)response.StatusCode} {response.ReasonPhrase}",
            ProviderHttpRequest.ResponseHeaders(response),
            null
        );
        var payload = await collect(stream, token, callbacks).ConfigureAwait(false);
        watchdog.Finish();
        options.Diagnostics?.Response(
            $"{(int)response.StatusCode} {response.ReasonPhrase}",
            ProviderHttpRequest.ResponseHeaders(response),
            payload
        );
        return new Completed(
            payload,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Stopwatch.GetElapsedTime(started).TotalMilliseconds
        );
    }

    private static async Task<(string Body, bool Truncated)> ReadBoundedAsync(
        HttpContent content,
        CancellationToken cancellationToken
    )
    {
        const int limit = 64 * 1024;
        await using var stream = await content
            .ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        var bytes = new byte[limit + 1];
        var used = 0;
        while (used < bytes.Length)
        {
            var read = await stream
                .ReadAsync(bytes.AsMemory(used), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
                break;
            used += read;
        }
        return (Encoding.UTF8.GetString(bytes, 0, Math.Min(used, limit)), used > limit);
    }

    internal static bool HasMeaningfulAssistant(JsonObject? assistant) =>
        (assistant?["parts"] as JsonArray)
            ?.OfType<JsonObject>()
            .Any(part =>
                part["functionCall"] is not null
                || part["inlineDataRef"] is JsonObject imageReference
                    && Foxwarm.Sessions.SessionWait.Text(imageReference["mimeType"]) is string mime
                    && mime.StartsWith("image/", StringComparison.Ordinal)
                || Foxwarm.Sessions.SessionWait.Text(part["text"]) is string text
                    && OpenAIRequestText.Trim(text).Length > 0
            ) == true;
}
