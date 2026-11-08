using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

internal sealed record KnownSecret(string Label, string Value);

// An immutable matcher for one generation of known values. Matching covers a fixed list
// of encodings (raw, JSON string escapes, percent-encoding, the stable core of base64 and
// base64url at each byte alignment, and hex); it is accident protection, not a guarantee
// against a process that deliberately transforms a value.
internal sealed class SecretRedactor
{
    internal const string MarkerPrefix = "[[FW_SECRET:";
    private const ulong HashBase = 1099511628211UL;
    private const int FilterBits = 16;

    private sealed record Pattern(string Text, string Label);

    internal static SecretRedactor Empty { get; } = new([]);

    private readonly Dictionary<ulong, Pattern[]> candidates = new();
    private readonly bool[] filter = new bool[1 << FilterBits];
    private readonly HashSet<string> exactValues = new(StringComparer.Ordinal);
    private readonly HashSet<string> labels = new(StringComparer.Ordinal);
    private readonly int window;
    private readonly ulong power = 1;

    internal SecretRedactor(IEnumerable<KnownSecret> secrets)
    {
        var patterns = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var secret in secrets)
        {
            // Values below the minimum length are neither masked nor treated as known.
            if (secret.Value.Length < SecretStore.MinimumRedactableLength)
                continue;
            exactValues.Add(secret.Value);
            var label = Label(secret.Label);
            labels.Add(label);
            foreach (var form in Forms(secret.Value))
                if (form.Length >= SecretStore.MinimumRedactableLength)
                    patterns.TryAdd(form, label);
        }
        if (patterns.Count == 0)
            return;
        window = patterns.Keys.Min(text => text.Length);
        for (var index = 1; index < window; index++)
            power = unchecked(power * HashBase);
        foreach (
            var group in patterns
                .Select(pair => new Pattern(pair.Key, pair.Value))
                .GroupBy(pattern => Hash(pattern.Text.AsSpan(0, window)))
        )
        {
            candidates[group.Key] = group
                .OrderByDescending(pattern => pattern.Text.Length)
                .ToArray();
            filter[Slot(group.Key)] = true;
        }
    }

    internal bool IsEmpty => candidates.Count == 0;

    internal int KnownValueCount => exactValues.Count;

    // Whether a marker label stands for a value this matcher masks.
    internal bool HasLabel(string label) => labels.Contains(label);

    internal static string Marker(string label) => MarkerPrefix + label + "]]";

    // Labels appear inside markers; keep them to a marker-safe character set.
    internal static string Label(string label)
    {
        var builder = new StringBuilder(label.Length);
        foreach (var character in label)
            builder.Append(
                char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-' or ':' or '/'
                    ? character
                    : '_'
            );
        return builder.Length == 0 ? "secret" : builder.ToString();
    }

    // Whether this exact text is a known value (used to drop inherited environment values).
    internal bool IsKnownValue(string value) => exactValues.Contains(value);

    internal bool Contains(string? text) => text is not null && Scan(text, false, null) is not null;

    internal string Redact(string text, ICollection<string>? hits = null) =>
        Scan(text, true, hits) ?? text;

    // Copy-on-write: returns the same node when nothing matched.
    internal JsonNode? Redact(JsonNode? node, ICollection<string>? hits = null)
    {
        if (IsEmpty || node is null || !Contains(node))
            return node;
        var copy = node.DeepClone();
        Replace(copy, hits);
        return copy;
    }

    internal JsonObject Redact(JsonObject node, ICollection<string>? hits = null) =>
        (JsonObject)Redact((JsonNode)node, hits)!;

    internal bool Contains(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (_, child) in obj)
                    if (Contains(child))
                        return true;
                return false;
            case JsonArray array:
                foreach (var child in array)
                    if (Contains(child))
                        return true;
                return false;
            case JsonValue value:
                return SessionWait.Text(value) is string text && Contains(text);
            default:
                return false;
        }
    }

    private void Replace(JsonNode node, ICollection<string>? hits)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(pair => pair.Key).ToArray())
                {
                    if (obj[key] is JsonValue value && SessionWait.Text(value) is string text)
                    {
                        var redacted = Redact(text, hits);
                        if (!ReferenceEquals(redacted, text))
                            obj[key] = redacted;
                    }
                    else if (obj[key] is { } child)
                        Replace(child, hits);
                }
                break;
            case JsonArray array:
                for (var index = 0; index < array.Count; index++)
                {
                    if (array[index] is JsonValue value && SessionWait.Text(value) is string text)
                    {
                        var redacted = Redact(text, hits);
                        if (!ReferenceEquals(redacted, text))
                            array[index] = redacted;
                    }
                    else if (array[index] is { } child)
                        Replace(child, hits);
                }
                break;
        }
    }

    // Leftmost-longest, non-overlapping replacement with a rolling hash over the shortest
    // pattern length. Without build it only reports whether anything matched.
    private string? Scan(string text, bool build, ICollection<string>? hits)
    {
        if (IsEmpty || text.Length < window)
            return null;
        StringBuilder? output = null;
        var last = 0;
        var position = 0;
        var hash = Hash(text.AsSpan(0, window));
        while (position + window <= text.Length)
        {
            if (
                filter[Slot(hash)]
                && candidates.TryGetValue(hash, out var group)
                && Match(text, position, group) is { } pattern
            )
            {
                if (!build)
                    return text;
                output ??= new StringBuilder(text.Length);
                output.Append(text, last, position - last).Append(Marker(pattern.Label));
                if (hits is not null && !hits.Contains(pattern.Label))
                    hits.Add(pattern.Label);
                position += pattern.Text.Length;
                last = position;
                if (position + window <= text.Length)
                    hash = Hash(text.AsSpan(position, window));
                continue;
            }
            if (position + window < text.Length)
                hash = unchecked(
                    (hash - text[position] * power) * HashBase + text[position + window]
                );
            position++;
        }
        if (output is null)
            return null;
        output.Append(text, last, text.Length - last);
        return output.ToString();
    }

    private static Pattern? Match(string text, int position, Pattern[] group)
    {
        foreach (var pattern in group)
            if (text.AsSpan(position).StartsWith(pattern.Text, StringComparison.Ordinal))
                return pattern;
        return null;
    }

    private static ulong Hash(ReadOnlySpan<char> text)
    {
        ulong hash = 0;
        foreach (var character in text)
            hash = unchecked(hash * HashBase + character);
        return hash;
    }

    private static int Slot(ulong hash) => (int)(hash >> (64 - FilterBits));

    internal static IEnumerable<string> Forms(string value)
    {
        yield return value;
        yield return JsonEncodedText
            .Encode(value, JavaScriptEncoder.UnsafeRelaxedJsonEscaping)
            .Value;
        yield return JsonEncodedText.Encode(value).Value;
        var percent = Uri.EscapeDataString(value);
        yield return percent;
        yield return LowerPercent(percent);
        var bytes = Encoding.UTF8.GetBytes(value);
        yield return Convert.ToHexStringLower(bytes);
        yield return Convert.ToHexString(bytes);
        // The characters of base64 that depend only on the value's own bytes, for each
        // position of its first byte within a 3-byte group.
        for (var skip = 0; skip < 3 && skip < bytes.Length; skip++)
        {
            var whole = (bytes.Length - skip) / 3 * 3;
            if (whole == 0)
                continue;
            var core = Convert.ToBase64String(bytes, skip, whole);
            yield return core;
            yield return core.Replace('+', '-').Replace('/', '_');
        }
    }

    private static string LowerPercent(string text)
    {
        var builder = new StringBuilder(text);
        for (var index = 0; index + 2 < builder.Length; index++)
            if (builder[index] == '%')
            {
                builder[index + 1] = char.ToLowerInvariant(builder[index + 1]);
                builder[index + 2] = char.ToLowerInvariant(builder[index + 2]);
                index += 2;
            }
        return builder.ToString();
    }
}
