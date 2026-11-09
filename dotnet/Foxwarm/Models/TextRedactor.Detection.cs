using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class TextRedactor
{
    // A detection service may accept only a few requests at a time and answer 429 beyond that
    // instead of queueing. Requests from every Session share one limit per endpoint
    // (`maxConcurrency`), so they wait for each other here rather than failing each other's
    // attempts. Changing the limit starts a new queue; calls already admitted finish.
    private static readonly ConcurrentDictionary<
        (Uri Endpoint, int Limit),
        SemaphoreSlim
    > EndpointQueues = new();

    internal const string TooLargeMessage =
        "Part of this request is too long for the text detection service, so nothing was sent to the model. Shorten or delete the long message, or turn off text redaction for this model.";

    // One detection call for one slot text. Returns the replaced ranges; registration and
    // caching belong to the request scope.
    internal async Task<Found[]> DetectAsync(
        HttpClient http,
        TextRedactionOptions options,
        string text,
        CancellationToken token
    )
    {
        // Waiting for another request's detection is bounded by this request's own deadline
        // and Stop, not by the per-call detection timeout.
        var queue = EndpointQueues.GetOrAdd(
            (options.Endpoint, options.MaxConcurrency),
            static key => new SemaphoreSlim(key.Limit, key.Limit)
        );
        var input = Encode(text);
        await queue.WaitAsync(token).ConfigureAwait(false);
        try
        {
            return ToFound(
                options,
                input,
                await ClassifyAsync(http, options, text, input, token).ConfigureAwait(false)
            );
        }
        finally
        {
            queue.Release();
        }
    }

    // Separates slot texts combined into one detection call. Paragraph breaks keep each slot
    // a separate passage for the detector, and the bytes are ASCII so slot boundaries stay
    // UTF-8 character boundaries.
    internal const string BatchSeparator = "\n\n";

    // One detection call for several slot texts joined by `BatchSeparator`. Each detected
    // range is clipped to the slots it overlaps and moved to that slot's own offsets; a
    // clipped part that is only whitespace is dropped. A range that crosses a separator is
    // therefore replaced in both slots. The detector sees neighbouring slots as context, so a
    // result may differ from detecting the slot alone.
    internal async Task<Found[][]> DetectBatchAsync(
        HttpClient http,
        TextRedactionOptions options,
        IReadOnlyList<string> texts,
        CancellationToken token
    )
    {
        var joined = string.Join(BatchSeparator, texts);
        var input = Encode(joined);
        var queue = EndpointQueues.GetOrAdd(
            (options.Endpoint, options.MaxConcurrency),
            static key => new SemaphoreSlim(key.Limit, key.Limit)
        );
        List<(int Start, int End, string[] Labels)> spans;
        await queue.WaitAsync(token).ConfigureAwait(false);
        try
        {
            spans = await ClassifyAsync(http, options, joined, input, token).ConfigureAwait(false);
        }
        finally
        {
            queue.Release();
        }
        var results = new Found[texts.Count][];
        var separatorBytes = Utf8.GetByteCount(BatchSeparator);
        var slotStart = 0;
        for (var index = 0; index < texts.Count; index++)
        {
            var slot = Encode(texts[index]);
            var slotEnd = slotStart + slot.Length;
            var local = new List<(int Start, int End, string[] Labels)>();
            foreach (var (start, end, labels) in spans)
            {
                var clippedStart = Math.Max(start, slotStart) - slotStart;
                var clippedEnd = Math.Min(end, slotEnd) - slotStart;
                if (clippedStart >= clippedEnd)
                    continue;
                if (slot.AsSpan(clippedStart, clippedEnd - clippedStart).Trim(" \t\r\n"u8).IsEmpty)
                    continue;
                local.Add((clippedStart, clippedEnd, labels));
            }
            results[index] = ToFound(options, slot, local);
            slotStart = slotEnd + separatorBytes;
        }
        return results;
    }

    // Sends one text and returns the detected byte ranges whose labels are not excluded.
    private static async Task<List<(int Start, int End, string[] Labels)>> ClassifyAsync(
        HttpClient http,
        TextRedactionOptions options,
        string text,
        byte[] input,
        CancellationToken token
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(options.TimeoutMs);
        try
        {
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
                if (status == 413)
                    throw new TextRedactionException(TooLargeMessage, false, tooLarge: true);
                throw new TextRedactionException(
                    "Text detection failed (HTTP " + status + "); no model request was sent.",
                    status is 408 or 429 || status is >= 500 and <= 599,
                    kind: TextRedactionFailureKind.ForStatus(status)
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
            var spans = new List<(int Start, int End, string[] Labels)>();
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
                var label = TextRedactionOptions.NormalizeLabel(
                    SessionWait.Text(entity?["label"])!
                );
                if (options.ExcludeLabels.Contains(label, StringComparer.Ordinal))
                    continue;
                spans.Add((start.Value, end.Value, [label]));
            }
            return spans;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TextRedactionException(
                "Text detection timed out; no model request was sent.",
                true,
                kind: TextRedactionFailureKind.Timeout
            );
        }
        catch (HttpRequestException)
        {
            throw new TextRedactionException(
                "Text detection connection failed; no model request was sent.",
                true,
                kind: TextRedactionFailureKind.Connection
            );
        }
        catch (IOException)
        {
            throw new TextRedactionException(
                "Text detection connection failed; no model request was sent.",
                true,
                kind: TextRedactionFailureKind.Connection
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

    // Drops ranges whose text is a kept value, merges overlapping ranges, keeps secret
    // markers, and converts byte ranges of `input`
    // into replaced UTF-16 ranges with their placeholders.
    private Found[] ToFound(
        TextRedactionOptions options,
        byte[] input,
        List<(int Start, int End, string[] Labels)> spans
    )
    {
        spans.RemoveAll(span =>
            options.Keeps(Utf8.GetString(input, span.Start, span.End - span.Start))
        );
        spans.Sort((left, right) => left.Start.CompareTo(right.Start));
        var merged = new List<(int Start, int End, string[] Labels)>();
        foreach (var span in spans)
        {
            if (merged.Count > 0 && span.Start < merged[^1].End)
                merged[^1] = (
                    merged[^1].Start,
                    Math.Max(merged[^1].End, span.End),
                    merged[^1].Labels.Union(span.Labels, StringComparer.Ordinal).ToArray()
                );
            else
                merged.Add(span);
        }
        var found = new List<Found>();
        var byteCursor = 0;
        var charCursor = 0;
        foreach (var (start, end, labels) in WithoutSecretMarkers(input, merged))
        {
            charCursor += Utf8.GetCharCount(input, byteCursor, start - byteCursor);
            var original = Utf8.GetString(input, start, end - start);
            found.Add(
                new(
                    charCursor,
                    original.Length,
                    Placeholder(input.AsSpan(start, end - start)),
                    original,
                    labels
                )
            );
            charCursor += original.Length;
            byteCursor = end;
        }
        return found.ToArray();
    }

    // Secret markers from the irreversible secret stage pass through unchanged: a detected
    // range keeps only its parts outside markers, and parts that are only whitespace stay.
    private static IEnumerable<(int Start, int End, string[] Labels)> WithoutSecretMarkers(
        byte[] input,
        List<(int Start, int End, string[] Labels)> spans
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
        foreach (var (spanStart, spanEnd, labels) in spans)
        {
            var cursor = spanStart;
            foreach (var (markerStart, markerEnd) in markers)
            {
                if (markerEnd <= cursor || markerStart >= spanEnd)
                    continue;
                if (markerStart > cursor && Meaningful(input, cursor, markerStart))
                    yield return (cursor, markerStart, labels);
                cursor = Math.Max(cursor, markerEnd);
            }
            if (cursor < spanEnd && Meaningful(input, cursor, spanEnd))
                yield return (cursor, spanEnd, labels);
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

    // Text that cannot be encoded strictly (an unpaired surrogate) cannot be matched to the
    // service's byte offsets.
    private static byte[] Encode(string text)
    {
        try
        {
            return Utf8.GetBytes(text);
        }
        catch (EncoderFallbackException)
        {
            throw InvalidResponse();
        }
    }

    private static TextRedactionException InvalidResponse() =>
        new(
            "Text detection returned an invalid response; no model request was sent.",
            false,
            kind: TextRedactionFailureKind.InvalidResponse
        );
}
