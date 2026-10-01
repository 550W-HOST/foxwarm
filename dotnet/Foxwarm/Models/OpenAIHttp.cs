using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal static class OpenAIHttp
{
    internal sealed record Completed(JsonObject Payload, long CompletedAt, double DurationMs);
    internal static async Task<Completed> RequestAsync(HttpClient http, Uri endpoint, JsonObject body,
        ResponsesClientOptions options, string sessionId, Action<string, ResponsesStreamProgress>? progress,
        string? userAgent, Func<Stream, CancellationToken, ResponsesStreamCallbacks, Task<JsonObject>> collect, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        if (options.RequestCompression is string compression)
        {
            using var buffer = new MemoryStream();
            using (Stream encoder = compression == "gzip" ? new System.IO.Compression.GZipStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true) : new System.IO.Compression.BrotliStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true)) encoder.Write(bytes);
            bytes = buffer.ToArray();
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        if (userAgent is not null) request.Headers.TryAddWithoutValidation("user-agent", userAgent);
        if (options.ExtraHeaders is not null) foreach (var (name, value) in options.ExtraHeaders)
        {
            var text = value?.ToString() ?? "";
            if (request.Headers.TryAddWithoutValidation(name, text))
            { request.Headers.Remove(name); request.Headers.TryAddWithoutValidation(name, text); }
            else { request.Content.Headers.Remove(name); request.Content.Headers.TryAddWithoutValidation(name, text); }
        }
        if (!string.IsNullOrEmpty(options.Token) && options.ExtraHeaders?.Any(pair => pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)) != true) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Token);
        if (options.RequestCompression is not null)
        {
            request.Content.Headers.ContentEncoding.Clear(); request.Content.Headers.ContentEncoding.Add(options.RequestCompression);
            request.Content.Headers.ContentLength = bytes.Length;
        }
        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (options.StreamInactivityTimeoutMs is not null) activity.CancelAfter(180000);
        var token = activity.Token; var effectiveInactivity = options.StreamInactivityTimeoutMs;
        var callbacks = new ResponsesStreamCallbacks
        {
            OnProgress = update => progress?.Invoke(sessionId, update),
            OnMeaningfulProgress = () => { if (effectiveInactivity is int timeout) activity.CancelAfter(timeout); },
            OnSafetyBuffering = _ => { effectiveInactivity = Math.Max(effectiveInactivity ?? 60000, 600000); activity.CancelAfter(effectiveInactivity.Value); }
        };
        var started = Stopwatch.GetTimestamp();
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var (error, truncated) = await ReadBoundedAsync(response.Content, token).ConfigureAwait(false);
            throw new ResponsesHttpException(response.StatusCode, error, truncated);
        }
        await using var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
        var payload = await collect(stream, token, callbacks).ConfigureAwait(false);
        return new Completed(payload, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Stopwatch.GetElapsedTime(started).TotalMilliseconds);
    }
    private static async Task<(string Body, bool Truncated)> ReadBoundedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        const int limit = 64 * 1024;
        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var bytes = new byte[limit + 1]; var used = 0;
        while (used < bytes.Length)
        {
            var read = await stream.ReadAsync(bytes.AsMemory(used), cancellationToken).ConfigureAwait(false);
            if (read == 0) break; used += read;
        }
        return (Encoding.UTF8.GetString(bytes, 0, Math.Min(used, limit)), used > limit);
    }
    internal static bool HasMeaningfulAssistant(JsonObject? assistant) =>
        (assistant?["parts"] as JsonArray)?.OfType<JsonObject>().Any(part => part["functionCall"] is not null || Foxwarm.Sessions.SessionWait.Text(part["text"]) is string text && OpenAIRequestText.Trim(text).Length > 0) == true;
}
