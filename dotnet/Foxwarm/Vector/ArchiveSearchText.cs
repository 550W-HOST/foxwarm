using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record ArchiveSearchQuery(
    string NormalizedQuery,
    string[] Identifiers,
    string[] ProseTerms,
    string? IdentifierMatch,
    string? ProseMatch
);

internal static class ArchiveSearchText
{
    private static readonly HashSet<string> StopWords = new(
        "about after again before current details find from have into latest message please recall search session show that this tool using what when where which with would your".Split(
            ' '
        ),
        StringComparer.Ordinal
    );

    private static bool LetterNumber(Rune rune) => (Rune.IsLetter(rune) || Rune.IsNumber(rune));

    private static bool IdentifierCharacter(Rune rune) =>
        LetterNumber(rune) || "_/:.-".Contains(rune.ToString(), StringComparison.Ordinal);

    private static bool CommandCharacter(Rune rune) =>
        LetterNumber(rune) || "_-".Contains(rune.ToString(), StringComparison.Ordinal);

    private static bool Strong(string value)
    {
        if (value.Length is < 4 or > 160)
            return false;
        if (
            Regex.IsMatch(value, "^[0-9a-f]{7,64}$", RegexOptions.IgnoreCase)
            || Regex.IsMatch(value, "^\\d{4,}$", RegexOptions.ECMAScript)
        )
            return true;
        var runes = value.EnumerateRunes().ToArray();
        if (runes[0].Value == '/')
        {
            var words = Regex.Split(
                value[1..],
                @"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
            );
            return words.Length is 1 or 2
                && words.All(word =>
                    word.Length > 0 && word.EnumerateRunes().All(CommandCharacter)
                );
        }
        if (
            LetterNumber(runes[0])
            && runes.All(IdentifierCharacter)
            && runes.Any(rune => "_/:.-".Contains(rune.ToString(), StringComparison.Ordinal))
        )
            return true;
        return Rune.GetUnicodeCategory(runes[0]) == UnicodeCategory.UppercaseLetter
            && runes.All(LetterNumber)
            && runes
                .Skip(1)
                .Any(rune => Rune.GetUnicodeCategory(rune) == UnicodeCategory.UppercaseLetter);
    }

    internal static IReadOnlyList<string> HanRuns(string text)
    {
        var result = new List<string>();
        var current = new StringBuilder();
        var count = 0;
        void Flush()
        {
            if (count >= 2)
                result.Add(current.ToString());
            current.Clear();
            count = 0;
        }
        foreach (var rune in text.EnumerateRunes())
            if (SourceHanRanges.Contains(rune.Value))
            {
                current.Append(rune);
                count++;
            }
            else
                Flush();
        Flush();
        return result;
    }

    internal static IReadOnlyList<string> HanBigrams(string text)
    {
        var grams = new HashSet<string>(StringComparer.Ordinal);
        foreach (var run in HanRuns(Normalize(text)))
        {
            var characters = run.EnumerateRunes().Select(rune => rune.ToString()).ToArray();
            for (var index = 0; index + 1 < characters.Length; index++)
                grams.Add("\u241f" + characters[index] + characters[index + 1] + "\u241f");
        }
        return grams.Order(StringComparer.Ordinal).ToArray();
    }

    internal static string IndexText(string text)
    {
        var normalized = Trim(Normalize(text));
        if (normalized.Length == 0)
            return "";
        var grams = HanBigrams(normalized);
        return normalized + (grams.Count == 0 ? "" : "\n" + string.Join(' ', grams));
    }

    private static string? MatchExpression(IEnumerable<string> terms, string op)
    {
        var accepted = new List<string>();
        foreach (var term in terms)
        {
            var quoted = "\"" + term.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
            if (string.Join(" " + op + " ", accepted.Append(quoted)).Length > 4096)
                break;
            accepted.Add(quoted);
        }
        return accepted.Count == 0 ? null : string.Join(" " + op + " ", accepted);
    }

    internal static IEnumerable<string> Runs(
        string text,
        Func<Rune, bool> first,
        Func<Rune, bool> rest,
        int min,
        int max = int.MaxValue
    )
    {
        var runes = WellFormed(text).EnumerateRunes().ToArray();
        for (var index = 0; index < runes.Length; index++)
        {
            if (!first(runes[index]))
                continue;
            var start = index;
            while (index + 1 < runes.Length && index - start + 1 < max && rest(runes[index + 1]))
                index++;
            if (index - start + 1 >= min)
                yield return string.Concat(
                    runes[start..(index + 1)].Select(rune => rune.ToString())
                );
        }
    }

    internal static ArchiveSearchQuery Compile(string query)
    {
        var bounded = query.Length > 2000 ? query[..2000] : query;
        var normalized = Trim(Normalize(bounded));
        var identifiers = new HashSet<string>(StringComparer.Ordinal);
        void Add(string value)
        {
            value = Trim(value.TrimEnd(')', ',', '.', ';', '!', '?'));
            if (Strong(value))
                identifiers.Add(Normalize(value));
        }
        foreach (var value in Runs(bounded, LetterNumber, IdentifierCharacter, 3, 160))
            Add(value);
        foreach (
            Match match in Regex.Matches(bounded, @"\b[0-9a-fA-F]{7,64}\b", RegexOptions.ECMAScript)
        )
            Add(match.Value);
        // Commands are a separate lane and can contain one whitespace-separated argument.
        var chars = WellFormed(bounded).EnumerateRunes().ToArray();
        for (var index = 0; index < chars.Length; index++)
        {
            if (
                chars[index].Value != '/'
                || index + 1 >= chars.Length
                || !CommandCharacter(chars[index + 1])
            )
                continue;
            var start = index++;
            while (index + 1 < chars.Length && CommandCharacter(chars[index + 1]))
                index++;
            var end = index;
            var cursor = index + 1;
            while (cursor < chars.Length && Trim(chars[cursor].ToString()).Length == 0)
                cursor++;
            if (cursor > index + 1 && cursor < chars.Length && CommandCharacter(chars[cursor]))
            {
                index = cursor;
                while (index + 1 < chars.Length && CommandCharacter(chars[index + 1]))
                    index++;
                end = index;
            }
            Add(string.Concat(chars[start..(end + 1)].Select(rune => rune.ToString())));
        }
        var prose = new HashSet<string>(StringComparer.Ordinal);
        foreach (var term in Runs(normalized, LetterNumber, LetterNumber, 3))
        {
            if (!StopWords.Contains(term) && !identifiers.Contains(term))
                prose.Add(term);
            if (prose.Count >= 12)
                break;
        }
        foreach (var run in HanRuns(normalized))
        {
            var characters = run.EnumerateRunes().Select(rune => rune.ToString()).ToArray();
            if (characters.Length >= 3)
                prose.Add(run);
            for (var index = 0; index + 1 < characters.Length && prose.Count < 12; index++)
                prose.Add("\u241f" + characters[index] + characters[index + 1] + "\u241f");
        }
        var ids = identifiers
            .OrderByDescending(term => term.Length)
            .ThenBy(term => term, StringComparer.InvariantCulture)
            .Take(4)
            .ToArray();
        var terms = prose.Take(12).ToArray();
        return new(
            normalized,
            ids,
            terms,
            MatchExpression(ids, "OR"),
            MatchExpression(terms, "AND")
        );
    }
}
