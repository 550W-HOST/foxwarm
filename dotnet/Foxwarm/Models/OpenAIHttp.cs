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
            var error = await ReadErrorAsync(response.Content, token).ConfigureAwait(false);
            var diagnostic = ModelAttemptFailure.DiagnosticBody(error);
            options.Diagnostics?.Response(
                $"{(int)response.StatusCode} {response.ReasonPhrase}",
                ProviderHttpRequest.ResponseHeaders(response),
                JsonValue.Create(diagnostic.Body),
                diagnostic.Truncated
            );
            throw new ResponsesHttpException(response.StatusCode, error, false);
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

    private static async Task<string> ReadErrorAsync(
        HttpContent content,
        CancellationToken cancellationToken
    )
    {
        await using var stream = await content
            .ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
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
