using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class TextRedactionException(string message, bool retryable) : Exception(message)
{
    internal bool Retryable { get; } = retryable;
}

// One process-wide reverse map; neither keys nor detection results depend on Session identity.
internal sealed class TextRedactor
{
    internal static TextRedactor Shared { get; } = new();
    private const string Prefix = "[[FW_PRIVATE_";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly Regex Placeholder = new(
        @"\[\[FW_PRIVATE_[0-9a-f]{64}\]\]",
        RegexOptions.CultureInvariant | RegexOptions.Compiled
    );
    private readonly ConcurrentDictionary<string, string> originals = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly Dictionary<CacheKey, LinkedListNode<CacheEntry>> cache = new();
    private readonly LinkedList<CacheEntry> recent = new();
    private readonly int cacheCharacters;
    private int characters;

    private sealed record CacheKey(TextRedactionOptions Options, string Text);

    private sealed record CacheEntry(CacheKey Key, string Redacted)
    {
        internal int Size => Key.Text.Length + Redacted.Length;
    }

    internal TextRedactor(int cacheCharacters = 4 * 1024 * 1024) =>
        this.cacheCharacters = cacheCharacters;

    internal string Restore(string text) =>
        Placeholder.Replace(
            text,
            match => originals.TryGetValue(match.Value, out var original) ? original : match.Value
        );

    // Progress is a cumulative snapshot. Hold only an unfinished placeholder at its end.
    internal string RestoreProgress(string text)
    {
        var start = text.LastIndexOf(Prefix, StringComparison.Ordinal);
        if (start >= 0)
        {
            var suffix = text.AsSpan(start + Prefix.Length);
            var hex = 0;
            while (hex < suffix.Length && char.IsAsciiHexDigitLower(suffix[hex]))
                hex++;
            if (
                hex <= 64
                && (hex == suffix.Length || hex == 64 && suffix[hex..].SequenceEqual("]"))
            )
                text = text[..start];
        }
        for (var length = Math.Min(Prefix.Length - 1, text.Length); length > 0; length--)
            if (text.EndsWith(Prefix[..length], StringComparison.Ordinal))
            {
                text = text[..^length];
                break;
            }
        return Restore(text);
    }

    internal async Task<string> RedactAsync(
        HttpClient http,
        TextRedactionOptions options,
        string text,
        CancellationToken token
    )
    {
        token.ThrowIfCancellationRequested();
        if (text.Length == 0)
            return text;
        var key = new CacheKey(options, text);
        lock (gate)
        {
            if (cache.TryGetValue(key, out var found))
            {
                recent.Remove(found);
                recent.AddLast(found);
                return found.Value.Redacted;
            }
        }
        var redacted = await DetectAsync(http, options, text, token).ConfigureAwait(false);
        var entry = new CacheEntry(key, redacted);
        lock (gate)
        {
            if (entry.Size <= cacheCharacters && !cache.ContainsKey(key))
            {
                while (
                    recent.First is { } oldest
                    && (characters + entry.Size > cacheCharacters || cache.Count >= 2048)
                )
                {
                    recent.RemoveFirst();
                    cache.Remove(oldest.Value.Key);
                    characters -= oldest.Value.Size;
                }
                cache[key] = recent.AddLast(entry);
                characters += entry.Size;
            }
        }
        return redacted;
    }

    private async Task<string> DetectAsync(
        HttpClient http,
        TextRedactionOptions options,
        string text,
        CancellationToken token
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(options.TimeoutMs);
        try
        {
            var input = Utf8.GetBytes(text);
            var body = new JsonObject { ["text"] = text, ["threshold"] = options.Threshold };
            using var request = new HttpRequestMessage(HttpMethod.Post, options.Endpoint)
            {
                Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body.ToJsonString())),
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            if (!string.IsNullOrEmpty(options.ApiKey))
                request.Headers.Authorization = new AuthenticationHeaderValue(
                    "Bearer",
                    options.ApiKey
                );
            using var response = await http.SendAsync(request, deadline.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode;
                throw new TextRedactionException(
                    "Text detection failed (HTTP " + status + "); no model request was sent.",
                    status is 408 or 429 || status is >= 500 and <= 599
                );
            }
            var result = JsonNode.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
            if (
                result is not JsonObject data
                || SessionWait.Text(data["offset_unit"]) != "utf8_bytes"
                || Integer(data["input_bytes"]) != input.Length
                || Integer(data["input_tokens"]) is not >= 0
                || data["entities"] is not JsonArray entities
            )
                throw InvalidResponse();
            var spans = new List<(int Start, int End)>();
            foreach (var entity in entities)
            {
                var start = Integer(entity?["start"]);
                var end = Integer(entity?["end"]);
                if (
                    start is null
                    || end is null
                    || start < 0
                    || start >= end
                    || end > input.Length
                    || string.IsNullOrWhiteSpace(SessionWait.Text(entity?["label"]))
                    || SessionWait.Number(entity?["score"]) is not double score
                    || !double.IsFinite(score)
                    || score is < 0 or > 1
                )
                    throw InvalidResponse();
                // The source was strictly encoded above. Continuation bytes cannot
                // start a boundary; validate without decoding every preceding prefix.
                if (
                    (input[start.Value] & 0xC0) == 0x80
                    || end.Value < input.Length && (input[end.Value] & 0xC0) == 0x80
                )
                    throw InvalidResponse();
                spans.Add((start.Value, end.Value));
            }
            spans.Sort((left, right) => left.Start.CompareTo(right.Start));
            var merged = new List<(int Start, int End)>();
            foreach (var span in spans)
            {
                if (merged.Count > 0 && span.Start < merged[^1].End)
                    merged[^1] = (merged[^1].Start, Math.Max(merged[^1].End, span.End));
                else
                    merged.Add(span);
            }
            var output = new StringBuilder();
            var cursor = 0;
            foreach (var (start, end) in merged)
            {
                output.Append(Utf8.GetString(input, cursor, start - cursor));
                var original = Utf8.GetString(input, start, end - start);
                var placeholder =
                    Prefix
                    + Convert
                        .ToHexString(SHA256.HashData(input.AsSpan(start, end - start)))
                        .ToLowerInvariant()
                    + "]]";
                originals.TryAdd(placeholder, original);
                output.Append(placeholder);
                cursor = end;
            }
            return output.Append(Utf8.GetString(input, cursor, input.Length - cursor)).ToString();
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TextRedactionException(
                "Text detection timed out; no model request was sent.",
                true
            );
        }
        catch (HttpRequestException)
        {
            throw new TextRedactionException(
                "Text detection connection failed; no model request was sent.",
                true
            );
        }
        catch (IOException)
        {
            throw new TextRedactionException(
                "Text detection connection failed; no model request was sent.",
                true
            );
        }
        catch (Exception error)
            when (error
                    is JsonException
                        or InvalidOperationException
                        or DecoderFallbackException
                        or EncoderFallbackException
            )
        {
            throw InvalidResponse();
        }
    }

    private static int? Integer(JsonNode? node) =>
        SessionWait.Number(node) is double value
        && double.IsFinite(value)
        && value is >= 0 and <= int.MaxValue
        && Math.Floor(value) == value
            ? (int)value
            : null;

    private static TextRedactionException InvalidResponse() =>
        new("Text detection returned an invalid response; no model request was sent.", false);
}
