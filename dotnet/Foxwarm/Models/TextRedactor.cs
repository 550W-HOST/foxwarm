using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal sealed class TextRedactionException(string message, bool retryable, bool tooLarge = false)
    : Exception(message)
{
    internal bool Retryable { get; } = retryable;

    // The detection service rejected one text slot as larger than it accepts.
    internal bool TooLarge { get; } = tooLarge;
}

// One redactor per placeholder key; neither keys nor detection results depend on Session
// identity. The instance key makes placeholders stable across Sessions and restarts without
// letting a model provider confirm guesses of short values by hashing them itself.
//
// The redactor owns two bounded memory-only stores. The reverse map records which original
// each placeholder replaced; it detects collisions and lets later requests mask known
// originals literally. The detection cache records detected spans per distinct slot text.
// Neither store restores output: restoration uses only the pairs one request registered
// (`TextRedactionScope`).
internal sealed partial class TextRedactor
{
    internal const string Prefix = "[[PRIVATE_";
    internal const int DigestCharacters = 16;
    internal const long DefaultCacheBytes = 32L * 1024 * 1024;
    internal const long DefaultKnownBytes = 16L * 1024 * 1024;
    private const int EntryOverhead = 96;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly ConcurrentDictionary<string, TextRedactor> ByKey = new(
        StringComparer.Ordinal
    );
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

    // Known originals indexed by their first two UTF-16 code units, longest first.
    private readonly Dictionary<int, List<Known>> byPrefix = new();

    // One replaced range of a slot text, in UTF-16 code units.
    internal readonly record struct Found(
        int Start,
        int Length,
        string Placeholder,
        string Original,
        string[] Labels
    );

    private sealed record DetectionKey(TextRedactionOptions Options, string Digest);

    private sealed record Detection(DetectionKey Key, Found[] Spans)
    {
        internal long Size =>
            EntryOverhead
            + 2L * Key.Digest.Length
            + Spans.Sum(span =>
                EntryOverhead
                + 2L * (span.Placeholder.Length + span.Original.Length)
                + span.Labels.Sum(label => 2L * label.Length)
            );
    }

    private sealed class Known(string placeholder, string original, string[] labels)
    {
        internal string Placeholder { get; } = placeholder;
        internal string Original { get; } = original;
        internal string[] Labels { get; set; } = labels;
        internal long Size => EntryOverhead + 2L * (Placeholder.Length + Original.Length);
    }

    internal TextRedactor(
        byte[] key,
        long cacheBytes = DefaultCacheBytes,
        long knownBytes = DefaultKnownBytes,
        int digestCharacters = DigestCharacters
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
    }

    // The process-wide redactor for one derived instance key, shared by every request.
    internal static TextRedactor For(byte[] key) =>
        ByKey.GetOrAdd(
            Convert.ToHexStringLower(SHA256.HashData(key)),
            static (_, value) => new TextRedactor(value),
            key
        );

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

    internal Found[]? Cached(TextRedactionOptions options, string digest)
    {
        lock (gate)
        {
            if (!detections.TryGetValue(new(options, digest), out var node))
                return null;
            detectionOrder.Remove(node);
            detectionOrder.AddLast(node);
            return node.Value.Spans;
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
                if (labels.Except(node.Value.Labels, StringComparer.Ordinal).Any())
                    node.Value.Labels = node
                        .Value.Labels.Union(labels, StringComparer.Ordinal)
                        .ToArray();
                knownOrder.Remove(node);
                knownOrder.AddLast(node);
                return true;
            }
            var entry = new Known(placeholder, original, labels);
            node = knownOrder.AddLast(entry);
            known[placeholder] = node;
            knownBytes += entry.Size;
            if (original.Length >= 2)
            {
                var prefix = PrefixKey(original[0], original[1]);
                if (!byPrefix.TryGetValue(prefix, out var list))
                    byPrefix[prefix] = list = [];
                var index = list.FindIndex(item => item.Original.Length < original.Length);
                list.Insert(index < 0 ? list.Count : index, entry);
            }
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
        if (
            entry.Original.Length >= 2
            && byPrefix.TryGetValue(PrefixKey(entry.Original[0], entry.Original[1]), out var list)
        )
        {
            list.Remove(entry);
            if (list.Count == 0)
                byPrefix.Remove(PrefixKey(entry.Original[0], entry.Original[1]));
        }
    }

    // Exact occurrences of retained originals, leftmost and then longest first. Existing
    // placeholders and secret markers are never entered. An original whose edge is an ASCII
    // letter or digit only matches where the neighbouring character is not one, so a short
    // name does not replace part of a longer word. Originals detected only under labels this
    // request excludes stay unchanged.
    internal List<Found> FindKnown(string text, IReadOnlyList<string> excluded)
    {
        var found = new List<Found>();
        if (text.Length < 2)
            return found;
        var guarded = Guarded(text);
        var next = 0;
        lock (gate)
        {
            if (byPrefix.Count == 0)
                return found;
            var index = 0;
            while (index < text.Length - 1)
            {
                while (next < guarded.Count && guarded[next].End <= index)
                    next++;
                if (next < guarded.Count && guarded[next].Start <= index)
                {
                    index = guarded[next].End;
                    continue;
                }
                var limit = next < guarded.Count ? guarded[next].Start : text.Length;
                Known? match = null;
                if (byPrefix.TryGetValue(PrefixKey(text[index], text[index + 1]), out var list))
                    foreach (var candidate in list)
                    {
                        var length = candidate.Original.Length;
                        if (
                            index + length <= limit
                            && text.AsSpan(index, length).SequenceEqual(candidate.Original)
                            && Bounded(text, index, length)
                            && !Excluded(candidate.Labels, excluded)
                        )
                        {
                            match = candidate;
                            break;
                        }
                    }
                if (match is null)
                {
                    index++;
                    continue;
                }
                var node = known[match.Placeholder];
                knownOrder.Remove(node);
                knownOrder.AddLast(node);
                found.Add(
                    new(
                        index,
                        match.Original.Length,
                        match.Placeholder,
                        match.Original,
                        match.Labels
                    )
                );
                index += match.Original.Length;
            }
        }
        return found;
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

    private static int PrefixKey(char first, char second) => first << 16 | second;

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
            var close = text.IndexOf("]]", labelStart, StringComparison.Ordinal);
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
