using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record VectorRawSelection(
    IReadOnlyList<ArchiveMessageRecord> Records,
    long FirstSeq,
    long LastSeq,
    int OmittedCount,
    IReadOnlyList<string> Notices
);

internal readonly record struct VectorRawScore(
    int Index,
    int Score,
    bool Substantive,
    int TextLength
);

internal static class VectorRawWindow
{
    internal static string SearchText(ArchiveMessageRecord record) =>
        Trim(
            Message(record.Message, rolePrefix: false, toolLimit: int.MaxValue, visibleOnly: false)
        );

    internal static bool Substantive(ArchiveMessageRecord record) =>
        record.Role is "user" or "model"
        && (
            (record.Message["parts"] as JsonArray)
                ?.OfType<JsonObject>()
                .Any(part =>
                    Trim(Text(part["text"])).Length > 0
                    || Trim(Text(part["system"])).Length > 0
                        && part["functionCall"] is null
                        && part["functionResponse"] is null
                )
            ?? false
        );

    internal static string[] QueryTokens(string query)
    {
        var normalized = Normalize(query);
        var tokens = new HashSet<string>(
            ArchiveSearchText.Runs(
                normalized,
                rune => Rune.IsLetter(rune) || Rune.IsNumber(rune) || rune.Value == '_',
                rune =>
                    Rune.IsLetter(rune)
                    || Rune.IsNumber(rune)
                    || "_.:/#-".Contains(rune.ToString(), StringComparison.Ordinal),
                2
            ),
            StringComparer.Ordinal
        );
        foreach (var run in ArchiveSearchText.HanRuns(normalized))
        {
            tokens.Add(run);
            for (var index = 0; index + 1 < run.Length; index++)
                tokens.Add(run.Substring(index, 2));
        }
        return tokens
            .OrderByDescending(token => token.Length)
            .ThenBy(token => token, StringComparer.InvariantCulture)
            .ToArray();
    }

    internal sealed class Scorer
    {
        private readonly string query;
        private readonly string chunk;
        private readonly string[] tokens;
        internal readonly string? Literal;
        internal readonly Regex? Include;

        internal Scorer(string query, string? chunk, JsonObject? filters = null)
        {
            this.query = Normalize(query);
            this.chunk = Normalize(chunk ?? "");
            tokens = QueryTokens(query);
            var literal = Trim(Text(filters?["contentFilter"]));
            Literal = literal.Length > 0 ? Normalize(literal) : null;
            var pattern = Trim(Text(filters?["includeRegex"]));
            if (pattern.Length > 0)
                try
                {
                    Include = new(
                        pattern,
                        RegexOptions.IgnoreCase
                            | RegexOptions.ECMAScript
                            | RegexOptions.CultureInvariant
                    );
                }
                catch (ArgumentException) { }
        }

        internal VectorRawScore Score(ArchiveMessageRecord record, int index)
        {
            var text = SearchText(record);
            var normalized = Normalize(text);
            var score = 0;
            if (normalized.Length >= 8 && chunk.Length > 0)
            {
                if (chunk.Contains(normalized, StringComparison.Ordinal))
                    score += 1000;
                else if (normalized.Contains(chunk, StringComparison.Ordinal) && chunk.Length >= 8)
                    score += 700;
            }
            if (query.Length >= 3 && normalized.Contains(query, StringComparison.Ordinal))
                score += 200;
            if (Literal is not null && normalized.Contains(Literal, StringComparison.Ordinal))
                score += 3000;
            if (Include?.IsMatch(text) == true)
                score += 2500;
            foreach (var token in tokens)
                if (normalized.Contains(token, StringComparison.Ordinal))
                    score += token.Length >= 8 ? 40 : 12;
            var substantive = Substantive(record);
            if (substantive)
                score += 3;
            return new(index, score, substantive, normalized.Length);
        }
    }

    internal static bool Meaningful(VectorRawScore entry) =>
        entry.Score > (entry.Substantive ? 3 : 0);

    internal static bool BetterMeaningful(VectorRawScore a, VectorRawScore b) =>
        a.Score > b.Score
        || a.Score == b.Score
            && (
                a.Substantive && !b.Substantive
                || a.Substantive == b.Substantive
                    && (
                        a.TextLength > b.TextLength
                        || a.TextLength == b.TextLength && a.Index < b.Index
                    )
            );

    internal static bool BetterFallback(VectorRawScore a, VectorRawScore b) =>
        a.Substantive && !b.Substantive || a.Substantive == b.Substantive && a.Index > b.Index;

    private static Dictionary<int, (int Start, int End)> ToolGroups(
        IReadOnlyList<ArchiveMessageRecord> records
    )
    {
        var groups = new Dictionary<int, (int Start, int End)>();
        for (var index = 0; index < records.Count; index++)
        {
            if (records[index].Role != "model")
                continue;
            var ids =
                (records[index].Message["parts"] as JsonArray)
                    ?.OfType<JsonObject>()
                    .Select(part => Text((part["functionCall"] as JsonObject)?["id"]))
                    .Where(id => id.Length > 0)
                    .ToArray()
                ?? [];
            var calls = ids.ToHashSet(StringComparer.Ordinal);
            if (calls.Count == 0 || calls.Count != ids.Length)
                continue;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var end = index;
            var malformed = false;
            for (
                var cursor = index + 1;
                cursor < records.Count && records[cursor].Role == "tool";
                cursor++
            )
            {
                var responses =
                    (records[cursor].Message["parts"] as JsonArray)
                        ?.OfType<JsonObject>()
                        .Select(part =>
                            Text((part["functionResponse"] as JsonObject)?["tool_use_id"])
                        )
                        .Where(id => id.Length > 0)
                        .ToArray()
                    ?? [];
                if (
                    responses.Length == 0
                    || responses.Distinct(StringComparer.Ordinal).Count() != responses.Length
                    || responses.Any(id => !calls.Contains(id) || seen.Contains(id))
                )
                {
                    malformed = true;
                    break;
                }
                foreach (var id in responses)
                    seen.Add(id);
                end = cursor;
            }
            if (malformed || end == index || seen.Count != calls.Count || end - index + 1 > 16)
                continue;
            for (var cursor = index; cursor <= end; cursor++)
                groups[cursor] = (index, end);
            index = end;
        }
        return groups;
    }

    internal static VectorRawSelection Select(
        IReadOnlyList<ArchiveMessageRecord> records,
        string query,
        string? chunk,
        JsonObject? filters = null
    )
    {
        if (records.Count == 0)
            return new([], 0, 0, 0, []);
        var scorer = new Scorer(query, chunk, filters);
        var scores = records.Select(scorer.Score).ToArray();
        var meaningful = scores.Any(Meaningful);
        var anchor = scores.Aggregate(
            (best, candidate) =>
                (meaningful ? BetterMeaningful(candidate, best) : BetterFallback(candidate, best))
                    ? candidate
                    : best
        );
        var groups = ToolGroups(records);
        var anchorGroup = groups.GetValueOrDefault(anchor.Index, (anchor.Index, anchor.Index));
        var start = anchorGroup.Item1;
        var end = anchorGroup.Item2;
        bool Barrier(int index) =>
            index < 0
            || index >= records.Count
            || (
                records[index].Role == "tool"
                || records[index].Role == "model"
                    && (
                        (records[index].Message["parts"] as JsonArray)
                            ?.OfType<JsonObject>()
                            .Any(part => part["functionCall"] is not null)
                        ?? false
                    )
            ) && !groups.ContainsKey(index);
        var leftBlocked = Barrier(start) && !groups.ContainsKey(anchor.Index);
        var rightBlocked = leftBlocked;
        while (end - start + 1 < 7 && end - start + 1 < 16)
        {
            var left = start - 1;
            var right = end + 1;
            if (left < 0)
                leftBlocked = true;
            if (right >= records.Count)
                rightBlocked = true;
            var leftStart =
                groups.TryGetValue(left, out var leftGroup) && leftGroup.End == left
                    ? leftGroup.Start
                    : left;
            var rightEnd =
                groups.TryGetValue(right, out var rightGroup) && rightGroup.Start == right
                    ? rightGroup.End
                    : right;
            if (!leftBlocked && (Barrier(left) || end - leftStart + 1 > 16))
                leftBlocked = true;
            if (!rightBlocked && (Barrier(right) || rightEnd - start + 1 > 16))
                rightBlocked = true;
            if (leftBlocked && rightBlocked)
                break;
            var leftScore = leftBlocked
                ? int.MinValue
                : scores[leftStart..(left + 1)].Max(score => score.Score);
            var rightScore = rightBlocked
                ? int.MinValue
                : scores[right..(rightEnd + 1)].Max(score => score.Score);
            if (
                rightScore > leftScore
                || rightScore == leftScore && end - anchorGroup.Item2 <= anchorGroup.Item1 - start
            )
                end = rightEnd;
            else
                start = leftStart;
        }
        var selected = records.Skip(start).Take(end - start + 1).ToArray();
        var selectedSeqs = selected.Select(record => record.Seq).ToHashSet();
        var notices = new List<string>();
        void Notice(string label, IEnumerable<ArchiveMessageRecord> matching)
        {
            var rows = matching.ToArray();
            var omitted = rows.Where(row => !selectedSeqs.Contains(row.Seq)).ToArray();
            if (rows.Length == 0 || omitted.Length != rows.Length)
                return;
            var shown = omitted.Select(row => row.Seq).Take(6).ToArray();
            notices.Add(
                "[source filter match omitted from selected window] "
                    + label
                    + " matched "
                    + string.Join(", ", shown.Select(seq => $"`msg#{seq}`"))
                    + (
                        omitted.Length > shown.Length
                            ? $"; {omitted.Length - shown.Length} additional matching message(s) omitted"
                            : ""
                    )
                    + ". Inspect exact source with "
                    + string.Join("; ", shown.Select(seq => $"recall({{ target: \"msg#{seq}\" }})"))
                    + "."
            );
        }
        if (scorer.Literal is not null)
            Notice(
                "contentFilter",
                records.Where(record =>
                    Normalize(SearchText(record)).Contains(scorer.Literal, StringComparison.Ordinal)
                )
            );
        if (scorer.Include is not null)
            Notice(
                "includeRegex",
                records.Where(record => scorer.Include.IsMatch(SearchText(record)))
            );
        return new(
            selected,
            selected[0].Seq,
            selected[^1].Seq,
            Math.Max(0, records.Count - selected.Length),
            notices
        );
    }

    internal static VectorRawSelection Bounded(
        SqliteArchiveMessageStore archive,
        long first,
        long last,
        string query,
        string chunk
    )
    {
        var scorer = new Scorer(query, chunk);
        (VectorRawScore Score, long Seq)? meaningful = null;
        (VectorRawScore Score, long Seq)? fallback = null;
        long? after = null;
        var count = 0;
        while (true)
        {
            var page = archive.ReadEffectiveMessagesPage(
                after is { } seq ? Math.Max(first, seq + 1) : first,
                last,
                100
            );
            if (page.Count == 0)
                break;
            foreach (var record in page)
            {
                var score = scorer.Score(record, count++);
                if (
                    Meaningful(score)
                    && (meaningful is null || BetterMeaningful(score, meaningful.Value.Score))
                )
                    meaningful = (score, record.Seq);
                if (fallback is null || BetterFallback(score, fallback.Value.Score))
                    fallback = (score, record.Seq);
            }
            if (page.Count < 100 || page[^1].Seq == after)
                break;
            after = page[^1].Seq;
        }
        var anchor = (meaningful ?? fallback)?.Seq;
        if (anchor is null)
            return new([], 0, 0, 0, []);
        var before = archive
            .ReadEffectiveMessagesPage(first, anchor - 1, 16, descending: true)
            .Reverse();
        var at = archive.ReadEffectiveMessagesPage(anchor, anchor, 1);
        var next = archive.ReadEffectiveMessagesPage(anchor + 1, last, 16);
        var selected = Select(before.Concat(at).Concat(next).ToArray(), query, chunk);
        return selected with { OmittedCount = Math.Max(0, count - selected.Records.Count) };
    }
}
