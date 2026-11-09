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

// One reverse map per placeholder key; neither keys nor detection results depend on Session
// identity. The instance key makes placeholders stable across Sessions and restarts without
// letting a model provider confirm guesses of short values by hashing them itself.
internal sealed class TextRedactor
{
    internal const string Prefix = "[[PRIVATE_";
    internal const int DigestCharacters = 16;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly ConcurrentDictionary<string, TextRedactor> ByKey = new(
        StringComparer.Ordinal
    );
    private readonly byte[] key;
    private readonly int digestCharacters;
    private readonly Regex placeholder;
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

    internal TextRedactor(
        byte[] key,
        int cacheCharacters = 4 * 1024 * 1024,
        int digestCharacters = DigestCharacters
    )
    {
        if (key.Length < 32)
            throw new ArgumentException("Text redaction key must have at least 32 bytes.");
        this.key = (byte[])key.Clone();
        this.cacheCharacters = cacheCharacters;
        this.digestCharacters = digestCharacters;
        placeholder = new Regex(
            Regex.Escape(Prefix) + "[0-9a-f]{" + digestCharacters + @"}\]\]",
            RegexOptions.CultureInvariant
        );
    }

    // The process-wide redactor for one derived instance key, shared by every request.
    internal static TextRedactor For(byte[] key) =>
        ByKey.GetOrAdd(
            Convert.ToHexStringLower(SHA256.HashData(key)),
            static (_, value) => new TextRedactor(value),
            key
        );

    internal string Placeholder(ReadOnlySpan<byte> original) =>
        Prefix
        + Convert.ToHexStringLower(HMACSHA256.HashData(key, original))[..digestCharacters]
        + "]]";

    internal string Restore(string text) =>
        placeholder.Replace(
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
                hex <= digestCharacters
                && (
                    hex == suffix.Length
                    || hex == digestCharacters && suffix[hex..].SequenceEqual("]")
                )
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
                if (options.ExcludeLabels.Contains(SessionWait.Text(entity?["label"])!))
                    continue;
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
            foreach (var (start, end) in WithoutSecretMarkers(input, merged))
            {
                output.Append(Utf8.GetString(input, cursor, start - cursor));
                var original = Utf8.GetString(input, start, end - start);
                var placeholder = Placeholder(input.AsSpan(start, end - start));
                // Restoration must never return a different value than the one replaced.
                if (
                    !string.Equals(
                        originals.GetOrAdd(placeholder, original),
                        original,
                        StringComparison.Ordinal
                    )
                )
                    throw new TextRedactionException(
                        "Text redaction placeholder collision; no model request was sent.",
                        false
                    );
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

    // Secret markers from the irreversible secret stage pass through unchanged: a detected
    // range keeps only its parts outside markers, and parts that are only whitespace stay.
    private static IEnumerable<(int Start, int End)> WithoutSecretMarkers(
        byte[] input,
        List<(int Start, int End)> spans
    )
    {
        var prefix = Encoding.ASCII.GetBytes(Foxwarm.Secrets.SecretRedactor.MarkerPrefix);
        var markers = new List<(int Start, int End)>();
        for (
            var start = input.AsSpan().IndexOf(prefix);
            start >= 0;
            start = NextIndex(input, prefix, start + 1)
        )
        {
            var label = input.AsSpan(start + prefix.Length);
            var close = label.IndexOf("]]"u8);
            if (close < 0)
                break;
            // Labels are names or configuration paths; whitespace means this is not a marker.
            if (close == 0 || label[..close].IndexOfAny(" \t\r\n"u8) >= 0)
                continue;
            // A path label may itself end in an index (`args[2]`), giving `]]]`.
            var end = start + prefix.Length + close + 2;
            while (end < input.Length && input[end] == (byte)']')
                end++;
            markers.Add((start, end));
        }
        foreach (var (spanStart, spanEnd) in spans)
        {
            var cursor = spanStart;
            foreach (var (markerStart, markerEnd) in markers)
            {
                if (markerEnd <= cursor || markerStart >= spanEnd)
                    continue;
                if (markerStart > cursor && Meaningful(input, cursor, markerStart))
                    yield return (cursor, markerStart);
                cursor = Math.Max(cursor, markerEnd);
            }
            if (cursor < spanEnd && Meaningful(input, cursor, spanEnd))
                yield return (cursor, spanEnd);
        }
    }

    private static int NextIndex(byte[] input, byte[] value, int from)
    {
        if (from >= input.Length)
            return -1;
        var index = input.AsSpan(from).IndexOf(value);
        return index < 0 ? -1 : from + index;
    }

    private static bool Meaningful(byte[] input, int start, int end) =>
        !string.IsNullOrWhiteSpace(Utf8.GetString(input, start, end - start));

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
