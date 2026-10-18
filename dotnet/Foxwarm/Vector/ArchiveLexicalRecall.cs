using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record StrongArchiveLocator(
    string Value,
    string Normalized,
    int Strength,
    int Offset
);

internal static class ArchiveLexicalRecall
{
    private static readonly HashSet<string> Common = new(
        "about after again before current details find from have into latest message please recall search session show that this tool using what when where which with would your".Split(
            ' '
        ),
        StringComparer.Ordinal
    );

    private static bool Meaningful(string value, string query, int offset)
    {
        if (value.Length is < 4 or > 160 || Common.Contains(Normalize(value)))
            return false;
        if (Regex.IsMatch(value, "^[a-z0-9]+(?:-[a-z0-9]+)+$", RegexOptions.ECMAScript))
        {
            var normalized = Normalize(value);
            var exactInfrastructure =
                Normalize(Trim(query)) == normalized
                && normalized
                    .Split('-')
                    .Any(segment =>
                        new[]
                        {
                            "gpu",
                            "vm",
                            "docker",
                            "sandbox",
                            "node",
                            "worker",
                            "host",
                        }.Contains(segment, StringComparer.Ordinal)
                    );
            var before = query[Math.Max(0, offset - 32)..offset];
            var previous = offset > 0 ? query[offset - 1] : '\0';
            var next = offset + value.Length < query.Length ? query[offset + value.Length] : '\0';
            if (
                !exactInfrastructure
                && !Regex.IsMatch(
                    before,
                    @"(?:node|session)(?:\s+id)?\s*[:=]?\s*$",
                    RegexOptions.IgnoreCase | RegexOptions.ECMAScript
                )
                && !(previous == '`' && next == '`')
                && !(previous is '\"' or '\'' && next == previous)
            )
                return false;
        }
        return !Regex.IsMatch(value, "^[a-z]+$", RegexOptions.IgnoreCase | RegexOptions.ECMAScript)
            || Regex.IsMatch(value, "[A-Z].*[A-Z]|[a-z][A-Z]", RegexOptions.ECMAScript);
    }

    internal static IReadOnlyList<StrongArchiveLocator> Locators(string query)
    {
        var bounded = query.Length > 2000 ? query[..2000] : query;
        var candidates = new List<StrongArchiveLocator>();
        void Add(string raw, int strength, int offset)
        {
            var value = Regex.Replace(Trim(raw), "^[`'\"([{<]+|[`'\"\\])}>.,;!?]+$", "");
            value = Trim(value);
            if (Meaningful(value, bounded, offset))
                candidates.Add(new(value, Normalize(value), strength, offset));
        }
        void Matches(string pattern, int strength)
        {
            foreach (
                Match match in Regex.Matches(
                    bounded,
                    pattern,
                    RegexOptions.ECMAScript | RegexOptions.CultureInvariant
                )
            )
                Add(match.Value, strength, match.Index);
        }
        Matches(@"\b[0-9a-fA-F]{7,64}\b", 120);
        Matches(@"(?<![\p{L}\p{N}_.-])/[A-Za-z][\w-]*\s+[A-Za-z][\w-]*", 115);
        Matches(@"(?<![\p{L}\p{N}_.-])/[A-Za-z][\w-]*", 110);
        var offset = 0;
        foreach (
            var value in ArchiveSearchText.Runs(
                bounded,
                rune => Rune.IsLetter(rune) || Rune.IsNumber(rune),
                rune =>
                    Rune.IsLetter(rune)
                    || Rune.IsNumber(rune)
                    || "_:./#-".Contains(rune.ToString(), StringComparison.Ordinal),
                4,
                160
            )
        )
        {
            offset = bounded.IndexOf(value, offset, StringComparison.Ordinal);
            if (offset < 0)
                break;
            Add(value, 105, offset);
            offset += value.Length;
        }
        Matches(@"\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b", 95);
        Matches(@"\b[\p{L}][\p{L}\p{N}]*_[\p{L}\p{N}_]+\b", 95);
        Matches(@"\b\d{4,}\b", 80);
        return candidates
            .GroupBy(candidate => candidate.Normalized, StringComparer.Ordinal)
            .Select(group =>
                group
                    .OrderByDescending(candidate => candidate.Strength)
                    .ThenBy(candidate => candidate.Offset)
                    .First()
            )
            .OrderByDescending(candidate => candidate.Strength)
            .ThenByDescending(candidate => candidate.Value.Length)
            .ThenBy(candidate => candidate.Offset)
            .ThenBy(candidate => candidate.Value, StringComparer.InvariantCulture)
            .Take(4)
            .ToArray();
    }

    private static string[] Terms(string query)
    {
        var bounded = Normalize(query);
        if (bounded.Length > 2000)
            bounded = bounded[..2000];
        var terms = new HashSet<string>(StringComparer.Ordinal);
        foreach (
            var term in ArchiveSearchText.Runs(
                bounded,
                rune => Rune.IsLetter(rune) || Rune.IsNumber(rune),
                rune => Rune.IsLetter(rune) || Rune.IsNumber(rune),
                3
            )
        )
            if (
                !Common.Contains(term)
                && !Regex.IsMatch(term, "^\\d{1,3}$", RegexOptions.ECMAScript)
            )
                terms.Add(term);
        foreach (var run in ArchiveSearchText.HanRuns(bounded))
        {
            terms.Add(run);
            // Source's transient locator loop deliberately slices UTF-16, unlike the FTS bigram normalizer.
            for (var index = 0; index + 1 < run.Length; index++)
                terms.Add(run.Substring(index, 2));
        }
        return terms
            .OrderByDescending(term => term.Length)
            .ThenBy(term => term, StringComparer.InvariantCulture)
            .Take(12)
            .ToArray();
    }

    internal static IReadOnlyList<JsonObject> Search(
        SqliteArchiveMessageStore archive,
        string query,
        int limit
    )
    {
        var locators = Locators(query);
        if (locators.Count == 0)
            return [];
        var terms = Terms(query);
        var candidates = new List<(ArchiveMessageRecord? Message, ArchiveBlockRecord? Block)>();
        foreach (var branch in archive.VectorLineage().Take(16))
        {
            if (candidates.Count >= 256)
                break;
            var local = new SqliteArchiveMessageStore(archive.DatabasePath, branch.SessionId);
            if (branch.MaxMessageSeq is null or > 0)
            {
                var messages = local
                    .ReadMessagesNumericRange(
                        null,
                        branch.MaxMessageSeq,
                        2000,
                        descending: true,
                        substantiveWindow: true
                    )
                    .Where(row =>
                        locators.Any(locator =>
                            Normalize(
                                    Message(
                                        row.Message,
                                        rolePrefix: false,
                                        substantive: true,
                                        toolLimit: 0
                                    )
                                )
                                .Contains(Normalize(locator.Value), StringComparison.Ordinal)
                        )
                    )
                    .Take(64);
                foreach (var message in messages)
                {
                    if (candidates.Count >= 256)
                        break;
                    candidates.Add((message, null));
                }
            }
            if (candidates.Count >= 256)
                break;
            if (branch.MaxBlockId is null or > 0)
            {
                static string AsciiLower(string value) =>
                    string.Concat(
                        value.Select(character =>
                            character is >= 'A' and <= 'Z' ? (char)(character + 32) : character
                        )
                    );
                var blocks = local
                    .ReadBlocksNumericRange(null, branch.MaxBlockId, 1000, descending: true)
                    .Where(block =>
                        locators.Any(locator =>
                            locator.Value.All(character => character <= 127)
                                ? AsciiLower(block.Summary)
                                    .Contains(AsciiLower(locator.Value), StringComparison.Ordinal)
                                : Normalize(block.Summary)
                                    .Contains(Normalize(locator.Value), StringComparison.Ordinal)
                        )
                    )
                    .Take(64);
                foreach (var block in blocks)
                {
                    if (candidates.Count >= 256)
                        break;
                    candidates.Add((null, block));
                }
            }
        }
        var hits = new List<JsonObject>();
        foreach (var (message, block) in candidates)
        {
            var text = block is not null
                ? Trim(block.Summary)
                : Message(message!.Message, rolePrefix: false, substantive: true, toolLimit: 0);
            if (text.Length == 0)
                continue;
            var normalized = Normalize(text);
            var matched = locators
                .Where(locator => normalized.Contains(locator.Normalized, StringComparison.Ordinal))
                .ToArray();
            if (matched.Length == 0)
                continue;
            var score =
                (block is not null ? 180 : 80)
                + matched.Sum(locator => locator.Strength + Math.Min(80, locator.Value.Length * 2));
            if (matched.Length == locators.Count && locators.Count > 1)
                score += 100;
            var normalizedQuery = Normalize(query);
            if (normalizedQuery.Length > 500)
                normalizedQuery = normalizedQuery[..500];
            if (
                normalizedQuery.Length >= 4
                && normalized.Contains(normalizedQuery, StringComparison.Ordinal)
            )
                score += 180;
            score += Math.Min(
                96,
                terms.Count(term => normalized.Contains(term, StringComparison.Ordinal)) * 12
            );
            var id = block?.SessionId ?? message!.SessionId;
            var kind = block is not null ? "block" : "raw";
            var source = block?.Id ?? message!.Seq;
            var row = new JsonObject
            {
                ["id"] = $"lex:{kind}:{id}:{source}",
                ["kind"] = kind,
                ["session_id"] = id,
                ["agent"] = block?.Agent ?? message!.Agent,
                ["source_family"] = block is not null
                    ? $"{id}:block:{source}"
                    : $"{id}:raw:{source}-{source}",
                ["lexical_score"] = score,
                ["lexical_locators"] = new JsonArray(
                    matched.Select(locator => (JsonNode?)JsonValue.Create(locator.Value)).ToArray()
                ),
                ["chunk_text"] = text.Length > 2000 ? text[..2000] : text,
                ["raw_start_seq"] = block?.RawStartSeq ?? source,
                ["raw_end_seq"] = block?.RawEndSeq ?? source,
            };
            if (block is not null)
            {
                row["block_id"] = block.Id;
                row["block_level"] = block.Level;
            }
            else
            {
                row["start_seq"] = source;
                row["end_seq"] = source;
            }
            hits.Add(row);
        }
        return hits.OrderByDescending(row => VectorRuntime.Number(row["lexical_score"]))
            .ThenByDescending(row => Text(row["kind"]) == "block")
            .ThenBy(row => Text(row["source_family"]), StringComparer.InvariantCulture)
            .DistinctBy(row => Text(row["source_family"]))
            .Take(Math.Clamp(limit, 1, 40))
            .ToArray();
    }
}
