using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm;

public static class ConditionalMemory
{
    private const string SnapshotHeaderSeparator = "\n\n";
    public const string FoxwarmRuntime = "foxwarm";

    // Each attribute is one condition; all attributes must match (AND).
    private static readonly string[] ConditionAttributes = ["model-id", "runtime"];
    private static readonly Regex ConditionalOpen = new(
        "^[ \\t]*<foxwarm-if((?: [a-z-]+=\"[^\"]*\")+)>[ \\t]*$",
        RegexOptions.CultureInvariant
    );
    private static readonly Regex ConditionalAttribute = new(
        " ([a-z-]+)=\"([^\"]*)\"",
        RegexOptions.CultureInvariant
    );
    private static readonly Regex ConditionalClose = new(
        @"^[ \t]*</foxwarm-if>[ \t]*$",
        RegexOptions.CultureInvariant
    );

    // JavaScript's non-Unicode \\b is ASCII-word based; .NET's is Unicode-word based.
    private static readonly Regex ConditionalOpenLike = new(
        "^[ \\t]*<foxwarm-if(?=[^A-Za-z0-9_]|$)[^>]*>[ \\t]*$",
        RegexOptions.CultureInvariant
    );
    private static readonly Regex ConditionalCloseLike = new(
        "^[ \\t]*</foxwarm-if(?=[^A-Za-z0-9_]|$)[^>]*>[ \\t]*$",
        RegexOptions.CultureInvariant
    );
    private static readonly Regex CurrentModelHeader = new(
        "^<foxwarm-current-model model-id=\"([^\"]*)\" />$",
        RegexOptions.CultureInvariant
    );

    public static string FilterConditionalMemorySource(
        string source,
        string modelId,
        string runtime = FoxwarmRuntime
    )
    {
        if (
            string.IsNullOrEmpty(source)
            || !source.Contains("<foxwarm-if", StringComparison.Ordinal)
        )
            return source;
        var lines = SplitSourceLines(source);
        var ranges = FindConditionalRanges(lines, FindFencedLines(lines));
        if (ranges.Count == 0)
            return source;

        var output = new StringBuilder();
        var sourceOffset = 0;
        foreach (var range in ranges)
        {
            var open = lines[range.Start];
            var close = lines[range.End];
            output.Append(source, sourceOffset, open.Start - sourceOffset);
            if (
                range.Conditions.All(condition =>
                    ListMatches(condition.Value, condition.Key == "runtime" ? runtime : modelId)
                )
            )
                output.Append(source, open.End, close.Start - open.End);
            sourceOffset = close.End;
        }
        output.Append(source, sourceOffset, source.Length - sourceOffset);
        return output.ToString();
    }

    public static string BuildCurrentModelSnapshot(string modelId, string snapshotBody) =>
        $"<foxwarm-current-model model-id=\"{EscapeAttributeValue(modelId)}\" />{SnapshotHeaderSeparator}{snapshotBody}";

    public static string? ReadCurrentModelSnapshotId(string snapshot)
    {
        var separatorIndex = snapshot.IndexOf(SnapshotHeaderSeparator, StringComparison.Ordinal);
        if (separatorIndex < 0)
            return null;
        var firstLine = snapshot[..separatorIndex];
        var match = CurrentModelHeader.Match(firstLine);
        if (!match.Success)
            return null;
        var modelId = UnescapeAttributeValue(match.Groups[1].Value);
        return string.IsNullOrEmpty(modelId) || FormatCurrentModelHeader(modelId) != firstLine
            ? null
            : modelId;
    }

    private static string FormatCurrentModelHeader(string modelId) =>
        $"<foxwarm-current-model model-id=\"{EscapeAttributeValue(modelId)}\" />";

    private static string EscapeAttributeValue(string value)
    {
        var normalized = value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        var chars = new StringBuilder(normalized.Length);
        foreach (var c in normalized)
        {
            if (
                c
                is >= '\0'
                    and <= '\u0008'
                    or '\u000B'
                    or '\u000C'
                    or >= '\u000E'
                    and <= '\u001F'
                    or '\u007F'
            )
                chars.Append(' ');
            else if (IsJavaScriptWhitespace(c))
                chars.Append(' ');
            else
                chars.Append(c);
        }
        var collapsedBuilder = new StringBuilder(chars.Length);
        var previousSpace = false;
        foreach (var c in chars.ToString())
        {
            if (c == ' ')
            {
                if (previousSpace)
                    continue;
                previousSpace = true;
            }
            else
                previousSpace = false;
            collapsedBuilder.Append(c);
        }
        var collapsed = collapsedBuilder.ToString().Trim(' ');
        return collapsed
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }

    private static bool IsJavaScriptWhitespace(char c) =>
        c
            is '\u0009'
                or '\u000A'
                or '\u000B'
                or '\u000C'
                or '\u000D'
                or '\u0020'
                or '\u00A0'
                or '\u1680'
                or '\u2028'
                or '\u2029'
                or '\u202F'
                or '\u205F'
                or '\u3000'
                or '\uFEFF'
        || c is >= '\u2000' and <= '\u200A';

    private static string UnescapeAttributeValue(string value) =>
        value
            .Replace("&quot;", "\"", StringComparison.Ordinal)
            .Replace("&apos;", "'", StringComparison.Ordinal)
            .Replace("&lt;", "<", StringComparison.Ordinal)
            .Replace("&gt;", ">", StringComparison.Ordinal)
            .Replace("&amp;", "&", StringComparison.Ordinal);

    private sealed record SourceLine(string Content, int Start, int End);

    private sealed record ConditionalRange(
        int Start,
        int End,
        IReadOnlyDictionary<string, string> Conditions
    );

    private sealed record FenceState(char Marker, int Length);

    private static List<SourceLine> SplitSourceLines(string source)
    {
        var lines = new List<SourceLine>();
        var start = 0;
        while (start < source.Length)
        {
            var cursor = start;
            while (cursor < source.Length && source[cursor] is not ('\r' or '\n'))
                cursor++;
            var contentEnd = cursor;
            if (cursor < source.Length)
                cursor +=
                    source[cursor] == '\r'
                    && cursor + 1 < source.Length
                    && source[cursor + 1] == '\n'
                        ? 2
                        : 1;
            lines.Add(new SourceLine(source[start..contentEnd], start, cursor));
            start = cursor;
        }
        return lines;
    }

    private static FenceState? OpeningFence(string line)
    {
        var spaces = 0;
        while (spaces < line.Length && spaces < 3 && line[spaces] == ' ')
            spaces++;
        if (spaces >= line.Length || (line[spaces] != '`' && line[spaces] != '~'))
            return null;
        var marker = line[spaces];
        var end = spaces;
        while (end < line.Length && line[end] == marker)
            end++;
        if (end - spaces < 3 || marker == '`' && line[end..].Contains('`'))
            return null;
        return new FenceState(marker, end - spaces);
    }

    private static bool ClosesFence(string line, FenceState fence)
    {
        var spaces = 0;
        while (spaces < line.Length && spaces < 3 && line[spaces] == ' ')
            spaces++;
        var end = spaces;
        while (end < line.Length && line[end] == fence.Marker)
            end++;
        if (end - spaces < fence.Length)
            return false;
        return line[end..].All(c => c is ' ' or '\t');
    }

    private static bool[] FindFencedLines(IReadOnlyList<SourceLine> lines)
    {
        var fenced = new bool[lines.Count];
        FenceState? active = null;
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i].Content;
            if (active is not null)
            {
                fenced[i] = true;
                if (ClosesFence(line, active))
                    active = null;
            }
            else if (OpeningFence(line) is { } opened)
            {
                fenced[i] = true;
                active = opened;
            }
        }
        return fenced;
    }

    private sealed record Token(
        string Kind,
        bool Supported,
        IReadOnlyDictionary<string, string>? Conditions = null
    );

    private static Token? ParseToken(string line)
    {
        var open = ConditionalOpen.Match(line);
        if (open.Success && ParseConditions(open.Groups[1].Value) is { } conditions)
            return new Token("open", true, conditions);
        if (ConditionalClose.IsMatch(line))
            return new Token("close", true);
        if (ConditionalOpenLike.IsMatch(line))
            return new Token("open", false);
        if (ConditionalCloseLike.IsMatch(line))
            return new Token("close", false);
        return null;
    }

    private static List<ConditionalRange> FindConditionalRanges(
        IReadOnlyList<SourceLine> lines,
        bool[] fenced
    )
    {
        var ranges = new List<ConditionalRange>();
        for (var index = 0; index < lines.Count; index++)
        {
            if (fenced[index])
                continue;
            var opening = ParseToken(lines[index].Content);
            if (opening?.Kind != "open")
                continue;
            var depth = 1;
            var supported = opening.Supported;
            var nested = false;
            var cursor = index + 1;
            for (; cursor < lines.Count; cursor++)
            {
                if (fenced[cursor])
                    continue;
                var token = ParseToken(lines[cursor].Content);
                if (token is null)
                    continue;
                if (token.Kind == "open")
                {
                    depth++;
                    nested = true;
                    if (!token.Supported)
                        supported = false;
                    continue;
                }
                if (!token.Supported)
                    supported = false;
                depth--;
                if (depth == 0)
                    break;
            }
            if (cursor >= lines.Count)
                break;
            if (supported && !nested && opening.Supported)
                ranges.Add(new ConditionalRange(index, cursor, opening.Conditions!));
            index = cursor;
        }
        return ranges;
    }

    // Unknown or repeated attributes leave the wrapper unsupported, so it stays literal.
    private static Dictionary<string, string>? ParseConditions(string attributes)
    {
        var conditions = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match attribute in ConditionalAttribute.Matches(attributes))
        {
            var name = attribute.Groups[1].Value;
            if (!ConditionAttributes.Contains(name) || conditions.ContainsKey(name))
                return null;
            conditions[name] = UnescapeAttributeValue(attribute.Groups[2].Value);
        }
        return conditions;
    }

    // Space-separated patterns: any positive pattern may match (none means all), and no
    // !-prefixed pattern may match. An empty value is the single empty pattern.
    private static bool ListMatches(string value, string subject)
    {
        var patterns = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (patterns.Length == 0)
            return WildcardMatches(value, subject);
        var positives = patterns.Where(p => !p.StartsWith('!')).ToArray();
        return (positives.Length == 0 || positives.Any(p => WildcardMatches(p, subject)))
            && !patterns.Where(p => p.StartsWith('!')).Any(p => WildcardMatches(p[1..], subject));
    }

    private static bool WildcardMatches(string pattern, string modelId)
    {
        var regex =
            "^"
            + string.Join("[^\\r\\n\\u2028\\u2029]*", pattern.Split('*').Select(Regex.Escape))
            + "$";
        return Regex.IsMatch(modelId, regex, RegexOptions.CultureInvariant);
    }
}
