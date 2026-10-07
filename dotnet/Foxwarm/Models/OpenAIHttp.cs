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
        CancellationToken cancellationToken
    )
    {
        var headers = new Dictionary<string, string>();
        if (userAgent is not null)
            headers["user-agent"] = userAgent;
        if (!string.IsNullOrEmpty(options.Token))
            headers["Authorization"] = "Bearer " + options.Token;
        using var request = ProviderHttpRequest.Create(endpoint, body, options, headers);
        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (options.StreamInactivityTimeoutMs is not null)
            activity.CancelAfter(180000);
        var token = activity.Token;
        var effectiveInactivity = options.StreamInactivityTimeoutMs;
        var callbacks = new ResponsesStreamCallbacks
        {
            OnProgress = update => progress?.Invoke(sessionId, update),
            OnMeaningfulProgress = () =>
            {
                if (effectiveInactivity is int timeout)
                    activity.CancelAfter(timeout);
            },
            OnImageGenerationActivity = () =>
            {
                if (effectiveInactivity is int timeout)
                    activity.CancelAfter(timeout);
            },
            OnSafetyBuffering = _ =>
            {
                effectiveInactivity = Math.Max(effectiveInactivity ?? 60000, 600000);
                activity.CancelAfter(effectiveInactivity.Value);
            },
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
            throw new ResponsesHttpException(response.StatusCode, error, truncated);
        }
        await using var stream = await response
            .Content.ReadAsStreamAsync(token)
            .ConfigureAwait(false);
        var payload = await collect(stream, token, callbacks).ConfigureAwait(false);
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
                || Foxwarm.Sessions.SessionWait.Text(part["text"]) is string text
                    && OpenAIRequestText.Trim(text).Length > 0
            ) == true;
}
