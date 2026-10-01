using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class AnthropicMessagesService(HttpClient http, ResponsesClientOptions options, int timeoutMs = 300000) : IChatService
{
    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var body = AnthropicRequestSerializer.BuildRequest(history, options);
        var endpoint = new Uri(options.BaseUri.AbsoluteUri.TrimEnd('/') + "/v1/messages");
        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json", ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = "interleaved-thinking-2025-05-14", ["user-agent"] = "foxwarm/1.0"
        };
        if (!string.IsNullOrEmpty(options.Token)) headers["x-api-key"] = options.Token;
        using var request = ProviderHttpRequest.Create(endpoint, body, options, headers);
        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        activity.CancelAfter(timeoutMs);
        var watch = Stopwatch.StartNew();
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, activity.Token);
            activity.CancelAfter(timeoutMs);
            await using var stream = await response.Content.ReadAsStreamAsync(activity.Token);
            using var registration = activity.Token.Register(() => { try { stream.Dispose(); } catch { } });
            using var buffer = new MemoryStream(); var bytes = new byte[8192];
            var success = response.StatusCode == HttpStatusCode.OK;
            while (true)
            {
                var count = await stream.ReadAsync(bytes, activity.Token);
                if (count == 0) break;
                activity.CancelAfter(timeoutMs);
                var keep = success ? count : Math.Min(count, Math.Max(0, 64 * 1024 - (int)buffer.Length));
                if (keep > 0) buffer.Write(bytes, 0, keep);
                if (!success && buffer.Length >= 64 * 1024) break;
            }
            cancellationToken.ThrowIfCancellationRequested(); activity.Token.ThrowIfCancellationRequested();
            var raw = buffer.ToArray();
            if (success && response.Content.Headers.ContentEncoding.LastOrDefault() is { } encoding && encoding is "gzip" or "br" or "deflate")
            {
                using var compressed = new MemoryStream(raw);
                using Stream decoder = encoding == "gzip" ? new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionMode.Decompress)
                    : encoding == "br" ? new System.IO.Compression.BrotliStream(compressed, System.IO.Compression.CompressionMode.Decompress)
                    : new System.IO.Compression.ZLibStream(compressed, System.IO.Compression.CompressionMode.Decompress);
                using var decoded = new MemoryStream(); await decoder.CopyToAsync(decoded, activity.Token); raw = decoded.ToArray();
            }
            var text = Encoding.UTF8.GetString(raw);
            if (text.StartsWith('\uFEFF')) text = text[1..];
            if (!success) throw ModelAttemptFailure.Http((int)response.StatusCode, text);
            JsonNode? payload;
            try { payload = JsonNode.Parse(text); }
            catch (JsonException) { payload = JsonValue.Create(text); } // Fixed Axios silently retains non-JSON response text.
            var assistant = AnthropicCanonicalConverter.ConvertAssistant(payload, options.ConcreteModelId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), watch.Elapsed.TotalMilliseconds);
            if (options.DisallowEmptyResponse && (assistant is null || !OpenAIHttp.HasMeaningfulAssistant(assistant)))
                throw ModelAttemptFailure.Empty();
            return new ChatResult(assistant, AnthropicCanonicalConverter.Usage(payload));
        }
        catch (Exception error) when (activity.IsCancellationRequested && !cancellationToken.IsCancellationRequested && error is OperationCanceledException or IOException or ObjectDisposedException)
        {
            throw new TimeoutException("Anthropic request timed out while waiting for headers or body bytes.");
        }
        catch (Exception error) when (cancellationToken.IsCancellationRequested && error is IOException or ObjectDisposedException)
        {
            throw new OperationCanceledException("Anthropic request was cancelled.", error, cancellationToken);
        }
    }
}
