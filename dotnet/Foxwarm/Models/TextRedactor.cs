using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal sealed class TextRedactionException(
    string message,
    bool retryable,
    bool tooLarge = false,
    string kind = TextRedactionFailureKind.Other
) : Exception(message)
{
    internal bool Retryable { get; } = retryable;

    // The detection service rejected one text slot as larger than it accepts.
    internal bool TooLarge { get; } = tooLarge;

    // The failure kind recorded in usage statistics (`TextRedactionFailureKind`).
    internal string Kind { get; } = tooLarge ? TextRedactionFailureKind.TooLarge : kind;
}

// One redactor per installation (`InstanceSecrets.TextRedactor`); neither keys nor detection
// results depend on Session identity. The instance key makes placeholders stable across
// Sessions and restarts without letting a model provider confirm guesses of short values by
// hashing them itself.
//
// The redactor owns two bounded memory stores. The reverse map records which original each
// placeholder replaced; it detects collisions and lets later requests mask known originals
// literally. The detection cache records, per distinct slot text, the detected spans and,
// once the slot has been through literal masking, that pass's spans, so an unchanged slot is
// sent the same way while it stays cached. With a `TextRedactionStore`, both survive a
// restart (see TextRedactor.Persistence.cs). Neither store restores output: restoration uses
// only the pairs one request registered (`TextRedactionScope`).
internal sealed partial class TextRedactor : IDisposable
{
    internal const string Prefix = "[[PRIVATE_";
    internal const int DigestCharacters = 16;
    internal const long DefaultCacheBytes = 32L * 1024 * 1024;
    internal const long DefaultKnownBytes = 16L * 1024 * 1024;
    private const int EntryOverhead = 96;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly byte[] key;
    private readonly int digestCharacters;
    private readonly Regex placeholder;
    private readonly object gate = new();
    private readonly long cacheLimit;
    private readonly long knownLimit;
    private long cacheBytes;
    private long knownBytes;
    private readonly Dictionary<DetectionKey, LinkedListNode<Detection>> detections = new();
    private readonly LinkedList<Detection> detectionOrder = new();
    private readonly Dictionary<string, LinkedListNode<Known>> known = new(StringComparer.Ordinal);
    private readonly LinkedList<Known> knownOrder = new();

    // One replaced range of a slot text, in UTF-16 code units.
    internal readonly record struct Found(
        int Start,
        int Length,
        string Placeholder,
        string Original,
        string[] Labels
    );

    private sealed record DetectionKey(TextRedactionOptions Options, string Digest);

    // Masked holds the literal pass's spans over the detected text, once that pass has run.
    private sealed record Detection(DetectionKey Key, Found[] Spans, Found[]? Masked = null)
    {
        // The day this entry's disk record was last written or touched; 0 when it has none.
        internal long Touched { get; set; }

        internal long Size =>
            EntryOverhead
            + 2L * Key.Digest.Length
            + SpansSize(Spans)
            + (Masked is null ? 0 : SpansSize(Masked));

        private static long SpansSize(Found[] spans) =>
            spans.Sum(span =>
                EntryOverhead
                + 2L * (span.Placeholder.Length + span.Original.Length)
                + span.Labels.Sum(label => 2L * label.Length)
            );
    }

    internal sealed class Known(string placeholder, string original, string[] labels)
    {
        internal string Placeholder { get; } = placeholder;
        internal string Original { get; } = original;
        internal string[] Labels { get; set; } = labels;

        // The day this original's disk record was last written or touched.
        internal long Touched { get; set; }
        internal long Size => EntryOverhead + 2L * (Placeholder.Length + Original.Length);
    }

    internal TextRedactor(
        byte[] key,
        long cacheBytes = DefaultCacheBytes,
        long knownBytes = DefaultKnownBytes,
        int digestCharacters = DigestCharacters,
        TextRedactionStore? store = null
    )
    {
        if (key.Length < 32)
            throw new ArgumentException("Text redaction key must have at least 32 bytes.");
        this.key = (byte[])key.Clone();
        cacheLimit = cacheBytes;
        knownLimit = knownBytes;
        this.digestCharacters = digestCharacters;
        placeholder = new Regex(
            Regex.Escape(Prefix) + "[0-9a-f]{" + digestCharacters + @"}\]\]",
            RegexOptions.CultureInvariant
        );
        this.store = store;
        LoadKnown();
    }

    internal TextRedactionScope Begin(
        HttpClient http,
        TextRedactionOptions options,
        CancellationToken token
    ) => new(this, http, options, token);

    internal string Placeholder(ReadOnlySpan<byte> original) =>
        Prefix
        + Convert.ToHexStringLower(HMACSHA256.HashData(key, original))[..digestCharacters]
        + "]]";

    internal int KnownCount
    {
        get
        {
            lock (gate)
                return known.Count;
        }
    }

    internal int CachedDetectionCount
    {
        get
        {
            lock (gate)
                return detections.Count;
        }
    }

    internal string Restore(string text, IReadOnlyDictionary<string, string> registered) =>
        placeholder.Replace(
            text,
            match => registered.TryGetValue(match.Value, out var original) ? original : match.Value
        );

    // Progress is a cumulative snapshot. Hold only an unfinished placeholder at its end.
    internal string RestoreProgress(string text, IReadOnlyDictionary<string, string> registered)
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
        return Restore(text, registered);
    }

    // The cached result of one slot. A memory miss reads the slot's finished result from the
    // store, when there is one, and caches it again.
    internal (Found[] Spans, Found[]? Masked)? Cached(
        TextRedactionOptions options,
        string text,
        string digest
    )
    {
        lock (gate)
        {
            if (detections.TryGetValue(new(options, digest), out var node))
            {
                detectionOrder.Remove(node);
                detectionOrder.AddLast(node);
                var entry = node.Value;
                if (store is not null && entry.Masked is not null && entry.Touched < store.Today)
                {
                    entry.Touched = store.Today;
                    store.TouchSlot(options, digest);
                }
                return (entry.Spans, entry.Masked);
            }
        }
        if (Stored(options, text, digest) is not { } stored)
            return null;
        Admit(options, digest, stored.Spans, stored.Masked);
        store!.TouchSlot(options, digest);
        return stored;
    }

    // Reads a cached slot without refreshing its LRU position or caching a stored result, for
    // presentation only.
    internal (Found[] Spans, Found[]? Masked)? Peek(TextRedactionOptions options, string text)
    {
        var digest = Digest(text);
        lock (gate)
            if (detections.TryGetValue(new(options, digest), out var node))
                return (node.Value.Spans, node.Value.Masked);
        return Stored(options, text, digest);
    }

    // The detection cache key of one slot text.
    internal static string Digest(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(MemoryMarshal.AsBytes(text.AsSpan())));

    // Records the literal pass's spans for a cached slot. The first result is kept, so the
    // slot stays the same for as long as it is cached, whatever is registered later. The
    // finished result is also written to the store.
    internal void Memoize(
        TextRedactionOptions options,
        string digest,
        Found[] spans,
        Found[] masked
    )
    {
        if (MemoizeInMemory(options, digest, masked))
            // Encoding and queueing the record happen outside the lock.
            store?.PutSlot(options, digest, spans, masked);
    }

    // False when the slot already had a memoized result, which is then kept. An entry evicted
    // meanwhile is still written: the store may keep it longer.
    private bool MemoizeInMemory(TextRedactionOptions options, string digest, Found[] masked)
    {
        lock (gate)
        {
            if (!detections.TryGetValue(new(options, digest), out var node))
                return true;
            if (node.Value.Masked is not null)
                return false;
            var entry = node.Value with { Masked = masked, Touched = store?.Today ?? 0 };
            var size = entry.Size;
            cacheBytes -= node.Value.Size;
            if (size > cacheLimit)
            {
                detectionOrder.Remove(node);
                detections.Remove(entry.Key);
                return true;
            }
            node.Value = entry;
            cacheBytes += size;
            while (cacheBytes > cacheLimit && detectionOrder.First is { } oldest && oldest != node)
            {
                detectionOrder.RemoveFirst();
                detections.Remove(oldest.Value.Key);
                cacheBytes -= oldest.Value.Size;
            }
            return true;
        }
    }

    internal void Cache(TextRedactionOptions options, string digest, Found[] spans)
    {
        var entry = new Detection(new(options, digest), spans);
        var size = entry.Size;
        lock (gate)
        {
            if (size > cacheLimit || detections.ContainsKey(entry.Key))
                return;
            while (cacheBytes + size > cacheLimit && detectionOrder.First is { } oldest)
            {
                detectionOrder.RemoveFirst();
                detections.Remove(oldest.Value.Key);
                cacheBytes -= oldest.Value.Size;
            }
            detections[entry.Key] = detectionOrder.AddLast(entry);
            cacheBytes += size;
        }
    }

    // Records that a placeholder replaced an original. False when the placeholder is already
    // registered for a different original; the existing mapping is then kept.
    internal bool TryRegister(string placeholder, string original, string[] labels)
    {
        lock (gate)
        {
            if (known.TryGetValue(placeholder, out var node))
            {
                if (!string.Equals(node.Value.Original, original, StringComparison.Ordinal))
                    return false;
                var current = node.Value;
                if (labels.Except(current.Labels, StringComparer.Ordinal).Any())
                {
                    current.Labels = current.Labels.Union(labels, StringComparer.Ordinal).ToArray();
                    store?.PutKnown(placeholder, original, current.Labels);
                    current.Touched = store?.Today ?? 0;
                }
                else if (store is not null && current.Touched < store.Today)
                {
                    store.TouchKnown(placeholder);
                    current.Touched = store.Today;
                }
                knownOrder.Remove(node);
                knownOrder.AddLast(node);
                return true;
            }
            var entry = new Known(placeholder, original, labels) { Touched = store?.Today ?? 0 };
            store?.PutKnown(placeholder, original, labels);
            node = knownOrder.AddLast(entry);
            known[placeholder] = node;
            knownBytes += entry.Size;
            knownGeneration++;
            while (knownBytes > knownLimit && knownOrder.First is { } oldest && oldest != node)
                Forget(oldest);
            return true;
        }
    }

    private void Forget(LinkedListNode<Known> node)
    {
        var entry = node.Value;
        knownOrder.Remove(node);
        known.Remove(entry.Placeholder);
        knownBytes -= entry.Size;
        knownGeneration++;
        store?.DeleteKnown(entry.Placeholder);
    }

    internal static string Apply(string text, IReadOnlyList<Found> spans)
    {
        if (spans.Count == 0)
            return text;
        var output = new StringBuilder(text.Length);
        var cursor = 0;
        foreach (var span in spans)
        {
            output.Append(text, cursor, span.Start - cursor).Append(span.Placeholder);
            cursor = span.Start + span.Length;
        }
        return output.Append(text, cursor, text.Length - cursor).ToString();
    }

    private static bool Word(char character) => char.IsAsciiLetterOrDigit(character);

    private static bool Bounded(string text, int start, int length)
    {
        var end = start + length;
        return !(Word(text[start]) && start > 0 && Word(text[start - 1]))
            && !(Word(text[end - 1]) && end < text.Length && Word(text[end]));
    }

    private static bool Excluded(string[] labels, IReadOnlyList<string> excluded) =>
        labels.Length > 0 && labels.All(label => excluded.Contains(label, StringComparer.Ordinal));

    // Placeholder and secret-marker ranges, which literal masking leaves intact.
    private List<(int Start, int End)> Guarded(string text)
    {
        var ranges = new List<(int Start, int End)>();
        foreach (Match match in placeholder.Matches(text))
            ranges.Add((match.Index, match.Index + match.Length));
        ranges.AddRange(MarkerRanges(text));
        ranges.Sort((left, right) => left.Start.CompareTo(right.Start));
        return ranges;
    }

    private static IEnumerable<(int Start, int End)> MarkerRanges(string text)
    {
        var prefix = Foxwarm.Secrets.SecretRedactor.MarkerPrefix;
        // The next closing bracket pair is searched again only once it lies behind, so
        // many unclosed prefixes do not make this quadratic.
        var close = -1;
        for (
            var start = text.IndexOf(prefix, StringComparison.Ordinal);
            start >= 0;
            start =
                    start + 1 < text.Length
                        ? text.IndexOf(prefix, start + 1, StringComparison.Ordinal)
                        : -1
        )
        {
            var labelStart = start + prefix.Length;
            if (close < labelStart)
                close = text.IndexOf("]]", labelStart, StringComparison.Ordinal);
            if (close < 0)
                yield break;
            // Labels are names or configuration paths; whitespace means this is not a marker.
            if (
                close == labelStart
                || text.AsSpan(labelStart, close - labelStart).IndexOfAny(" \t\r\n") >= 0
            )
                continue;
            // A path label may itself end in an index (`args[2]`), giving `]]]`.
            var end = close + 2;
            while (end < text.Length && text[end] == ']')
                end++;
            yield return (start, end);
        }
    }
}
