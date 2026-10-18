using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class AnthropicMessagesService(
    HttpClient http,
    ResponsesClientOptions options,
    int timeoutMs = 300000,
    Action<string, ResponsesStreamProgress>? progress = null,
    TimeProvider? clock = null
) : IChatService
{
    private TimeSpan RequestTimeout =>
        options.HardTimeoutMs == 0
            ? Timeout.InfiniteTimeSpan
            : TimeSpan.FromMilliseconds(options.HardTimeoutMs ?? timeoutMs);

    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    )
    {
        var body = AnthropicRequestSerializer.BuildRequest(history, options);
        if (options.JournalAttemptStart is not null)
            await options.JournalAttemptStart(body).ConfigureAwait(false);
        var endpoint = new Uri(options.BaseUri.AbsoluteUri.TrimEnd('/') + "/v1/messages");
        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = "interleaved-thinking-2025-05-14",
            ["user-agent"] = "foxwarm/" + ProductVersion.Value,
        };
        if (!string.IsNullOrEmpty(options.Token))
            headers["x-api-key"] = options.Token;
        using var request = ProviderHttpRequest.Create(endpoint, body, options, headers);
        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var streaming = body["stream"]!.GetValue<bool>();
        var reasoning = false;
        await using var timer = (clock ?? TimeProvider.System).CreateTimer(
            _ => activity.Cancel(),
            null,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan
        );
        void ScheduleInactivity() =>
            timer.Change(
                TimeSpan.FromMilliseconds(
                    reasoning
                        ? Math.Max(options.StreamInactivityTimeoutMs ?? 60000, 600000)
                        : options.StreamInactivityTimeoutMs ?? 60000
                ),
                Timeout.InfiniteTimeSpan
            );
        if (streaming)
            timer.Change(TimeSpan.FromMilliseconds(180000), Timeout.InfiniteTimeSpan);
        else
            activity.CancelAfter(RequestTimeout);
        var watch = Stopwatch.StartNew();
        try
        {
            using var response = await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                activity.Token
            );
            if (!streaming)
                activity.CancelAfter(RequestTimeout);
            await using var stream = await response.Content.ReadAsStreamAsync(activity.Token);
            using var registration = activity.Token.Register(() =>
            {
                try
                {
                    stream.Dispose();
                }
                catch { }
            });
            JsonNode? payload;
            var success = response.StatusCode == HttpStatusCode.OK;
            if (streaming && success)
            {
                await using var decoded = Decode(
                    stream,
                    response.Content.Headers.ContentEncoding.LastOrDefault()
                );
                payload = await AnthropicSseCollector
                    .CollectAsync(
                        decoded,
                        activity.Token,
                        new ResponsesStreamCallbacks
                        {
                            OnProgress = update => progress?.Invoke(sessionId, update),
                            OnMeaningfulProgress = ScheduleInactivity,
                        },
                        active =>
                        {
                            reasoning = active;
                            ScheduleInactivity();
                        }
                    )
                    .ConfigureAwait(false);
            }
            else
            {
                payload = await ReadJsonAsync(
                        stream,
                        success,
                        response.Content.Headers.ContentEncoding.LastOrDefault(),
                        (int)response.StatusCode,
                        activity,
                        cancellationToken
                    )
                    .ConfigureAwait(false);
            }
            cancellationToken.ThrowIfCancellationRequested();
            activity.Token.ThrowIfCancellationRequested();
            var assistant = AnthropicCanonicalConverter.ConvertAssistant(
                payload,
                options.ConcreteModelId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                watch.Elapsed.TotalMilliseconds
            );
            if (
                options.DisallowEmptyResponse
                && (assistant is null || !OpenAIHttp.HasMeaningfulAssistant(assistant))
            )
                throw ModelAttemptFailure.Empty();
            return new ChatResult(assistant, AnthropicCanonicalConverter.Usage(payload))
            {
                TruncatedStopReason = AnthropicCanonicalConverter.StopReason(payload),
            };
        }
        catch (Exception error)
            when (activity.IsCancellationRequested
                && !cancellationToken.IsCancellationRequested
                && error is OperationCanceledException or IOException or ObjectDisposedException
            )
        {
            throw new TimeoutException(
                streaming
                    ? "Anthropic streaming request timed out while waiting for model output activity."
                    : "Anthropic request timed out while waiting for headers or body bytes."
            );
        }
        catch (Exception error)
            when (cancellationToken.IsCancellationRequested
                && error is IOException or ObjectDisposedException
            )
        {
            throw new OperationCanceledException(
                "Anthropic request was cancelled.",
                error,
                cancellationToken
            );
        }
    }

    private static Stream Decode(Stream stream, string? encoding) =>
        encoding switch
        {
            "gzip" => new System.IO.Compression.GZipStream(
                stream,
                System.IO.Compression.CompressionMode.Decompress,
                leaveOpen: true
            ),
            "br" => new System.IO.Compression.BrotliStream(
                stream,
                System.IO.Compression.CompressionMode.Decompress,
                leaveOpen: true
            ),
            "deflate" => new System.IO.Compression.ZLibStream(
                stream,
                System.IO.Compression.CompressionMode.Decompress,
                leaveOpen: true
            ),
            _ => stream,
        };

    private async Task<JsonNode?> ReadJsonAsync(
        Stream stream,
        bool success,
        string? encoding,
        int statusCode,
        CancellationTokenSource activity,
        CancellationToken cancellationToken
    )
    {
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];

        while (true)
        {
            var count = await stream.ReadAsync(bytes, activity.Token);
            if (count == 0)
                break;
            activity.CancelAfter(RequestTimeout);
            var keep = success
                ? count
                : Math.Min(count, Math.Max(0, 64 * 1024 - (int)buffer.Length));
            if (keep > 0)
                buffer.Write(bytes, 0, keep);
            if (!success && buffer.Length >= 64 * 1024)
                break;
        }
        cancellationToken.ThrowIfCancellationRequested();
        activity.Token.ThrowIfCancellationRequested();
        var raw = buffer.ToArray();
        if (success && encoding is not null && encoding is "gzip" or "br" or "deflate")
        {
            using var compressed = new MemoryStream(raw);
            using var decoder = Decode(compressed, encoding);
            using var decoded = new MemoryStream();
            await decoder.CopyToAsync(decoded, activity.Token);
            raw = decoded.ToArray();
        }
        var text = Encoding.UTF8.GetString(raw);
        if (text.StartsWith('\uFEFF'))
            text = text[1..];
        if (!success)
            throw ModelAttemptFailure.Http(statusCode, text);
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return JsonValue.Create(text);
        } // Fixed Axios silently retains non-JSON response text.
    }
}
