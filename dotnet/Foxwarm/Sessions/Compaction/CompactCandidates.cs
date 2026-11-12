using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed record CompactCandidate(
    string Kind,
    int SourceLevel,
    long Start,
    long End,
    long RawStart,
    long RawEnd,
    int HistoryStart,
    int HistoryEnd,
    double? StartTimestamp,
    double? EndTimestamp,
    string Preview,
    int Tokens,
    int Segment,
    int? FrictionScore = null
)
{
    public string Key =>
        Kind == "message"
            ? Start == End
                ? $"M#{Start}"
                : $"M#{Start}-#{End}"
            : $"B#{Start}";
    public int TargetLevel => Kind == "message" ? 1 : SourceLevel + 1;
}

internal sealed record PreservedCompactMessage(long Seq, long BlockId, string Preview)
{
    internal IReadOnlyList<long> Exchange { get; set; } = [];
}

internal sealed record CompactCandidates(
    IReadOnlyList<JsonObject> History,
    int Split,
    IReadOnlyList<CompactCandidate> Items,
    IReadOnlyList<PreservedCompactMessage> Preserved,
    int EligibleRawTokens,
    int RequiredRawTokens,
    IReadOnlyList<RetentionOperation> Retention,
    bool InContext = false
)
{
    /// <summary>
    /// Whether summaries can be written: any candidate in in-context mode, otherwise at least
    /// one operation required by the retention policy.
    /// </summary>
    public bool HasWork => InContext ? Items.Count > 0 : Retention.Count > 0;
}

internal static class CompactCandidateBuilder
{
    public static int Tokens(string text)
    {
        var count = 0d;
        foreach (var character in text)
            count += character < 128 ? 0.33 : 1;
        return (int)Math.Ceiling(count);
    }

    /// <summary>
    /// Start of the force-kept recent raw tail: the newest rows whose estimated tokens fit within
    /// <paramref name="keepTokens"/>, moved back to the start of a complete tool exchange. The
    /// newest row is always kept, and the tail never extends over a summary block. Zero keeps
    /// nothing.
    /// </summary>
    public static int Split(IReadOnlyList<JsonObject> history, double keepTokens) =>
        Split(history, keepTokens, RawSequenceCounts(history));

    /// <summary>
    /// Raw-tail token budget: the keep fraction of the effective compact threshold or of the raw
    /// region after the newest summary block, whichever is smaller. Automatic compaction runs at or
    /// above the threshold; a manual compaction of a shorter history keeps the same share of what
    /// is present.
    /// </summary>
    public static double KeepTokens(
        double keepFraction,
        double threshold,
        IReadOnlyList<JsonObject> history
    )
    {
        if (keepFraction <= 0 || threshold <= 0)
            return 0;
        var raw = 0d;
        for (var index = history.Count - 1; index >= 0; index--)
        {
            if (Meta(history[index])?["contextBlock"] is not null)
                break;
            raw += RowTokens(history[index]);
        }
        return Math.Max(1, Math.Floor(keepFraction * Math.Min(threshold, raw)));
    }

    public static int RowTokens(JsonObject row) =>
        Visible(row) && !Completion(row) ? Tokens(Preview(row, true)) : 0;

    private static int Split(
        IReadOnlyList<JsonObject> history,
        double keepTokens,
        IReadOnlyDictionary<long, int> seqCounts
    )
    {
        var split = history.Count;
        if (keepTokens > 0)
        {
            var total = 0d;
            while (split > 0 && Meta(history[split - 1])?["contextBlock"] is null)
            {
                total += RowTokens(history[split - 1]);
                if (total > keepTokens && split < history.Count)
                    break;
                split--;
            }
        }
        if (keepTokens > 0 && split < history.Count)
        {
            var cursor = split;
            while (cursor > 0 && (Role(history[cursor]) == "tool" || Transparent(history[cursor])))
                cursor--;
            if (
                Role(history[cursor]) == "model"
                && Calls(history[cursor])
                && RawExchangeEnd(history, cursor, seqCounts) >= split
            )
                split = cursor;
        }
        return split;
    }

    public static CompactCandidates Build(
        IReadOnlyList<JsonObject> history,
        double keepTokens = 0,
        bool inContext = false
    )
    {
        var seqCounts = RawSequenceCounts(history);
        var unsequencedExchanges = UnsequencedExchangeMembers(history);
        var split = inContext ? history.Count : Split(history, keepTokens, seqCounts);
        var older = history.Take(split).ToArray();
        var blockCounts = new Dictionary<long, int>();
        for (var index = 0; index < older.Length; index++)
        {
            var meta = Meta(older[index]);
            if (
                meta?["contextBlock"] is JsonObject block
                && Number(block["id"]) is long id
                && id > 0
            )
                blockCounts[id] = blockCounts.GetValueOrDefault(id) + 1;
        }
        var entries = new List<CompactCandidate>();
        var preserved = new List<PreservedCompactMessage>();
        var preservedExchanges =
            new List<(HashSet<string> Calls, List<PreservedCompactMessage> Items, int EndIndex)>();
        var segment = 1;
        string? priorKind = null;
        int priorLevel = 0;
        long? previousSeq = null,
            previousBlockEnd = null;
        for (var index = 0; index < older.Length; index++)
        {
            var message = older[index];
            var meta = Meta(message);
            var seq = Number(meta?["seq"]);
            if (unsequencedExchanges.Contains(index))
            {
                segment++;
                priorKind = null;
                previousSeq = previousBlockEnd = null;
                continue;
            }
            var preservedBlock = Number(meta?["preservedFromBlockId"]);
            if (preservedBlock is > 0)
            {
                if (seq is > 0 && seqCounts.GetValueOrDefault(seq.Value) == 1 && !Ignored(message))
                {
                    var item = new PreservedCompactMessage(
                        seq.Value,
                        preservedBlock.Value,
                        Preview(message, true)
                    );
                    preserved.Add(item);
                    var prior = preservedExchanges.LastOrDefault();
                    if (
                        Role(message) == "tool"
                        && prior.Items is { Count: > 0 }
                        && FollowsAcrossTransparentRows(older, prior.EndIndex, index, seqCounts)
                        && ToolIds(message, "functionResponse", "tool_use_id")
                            .Any(prior.Calls.Contains)
                    )
                    {
                        prior.Items.Add(item);
                        preservedExchanges[^1] = (prior.Calls, prior.Items, index);
                    }
                    else
                        preservedExchanges.Add(
                            (ToolIds(message, "functionCall", "id").ToHashSet(), [item], index)
                        );
                }
                segment++;
                priorKind = null;
                previousSeq = previousBlockEnd = null;
                continue;
            }
            if (meta?["contextBlock"] is JsonObject block)
            {
                previousSeq = null;
                var id = Number(block["id"]);
                var level = Number(block["level"]);
                var rawStart = Number(block["rawStartSeq"]);
                var rawEnd = Number(block["rawEndSeq"]);
                if (
                    id is not > 0
                    || level is not > 0
                    || rawStart is not > 0
                    || rawEnd is null
                    || rawEnd < rawStart
                    || !ValidBlock(block)
                    || blockCounts.GetValueOrDefault(id.Value) != 1
                    || Role(message) != "model"
                )
                {
                    segment++;
                    priorKind = null;
                    previousBlockEnd = null;
                    continue;
                }
                if (priorKind is not null && (priorKind != "block" || priorLevel != level.Value))
                    segment++;
                if (previousBlockEnd is not null && rawStart <= previousBlockEnd)
                    segment++;
                var summary = Preview(message, false);
                entries.Add(
                    new CompactCandidate(
                        "block",
                        (int)level.Value,
                        id.Value,
                        id.Value,
                        rawStart.Value,
                        rawEnd.Value,
                        index,
                        index,
                        Finite(block["rawStartTimestamp"]),
                        Finite(block["rawEndTimestamp"]),
                        summary,
                        Tokens(summary),
                        segment,
                        CompactPlanValidator.Friction(block["frictionScore"])
                    )
                );
                priorKind = "block";
                priorLevel = (int)level.Value;
                previousBlockEnd = rawEnd;
                continue;
            }
            previousBlockEnd = null;
            if (seq is not > 0 || seqCounts.GetValueOrDefault(seq.Value) != 1)
            {
                segment++;
                priorKind = null;
                previousSeq = Role(message) == "tool" ? null : seq;
                continue;
            }
            if (previousSeq is not null && seq <= previousSeq)
            {
                segment++;
                priorKind = null;
                previousSeq = Role(message) == "tool" ? null : seq;
                continue;
            }
            if (Transparent(message))
            {
                previousSeq = seq;
                continue;
            }
            if (Ignored(message))
            {
                segment++;
                priorKind = null;
                previousSeq = seq;
                continue;
            }
            if (priorKind is not null && priorKind != "message")
                segment++;
            var endIndex =
                Role(message) == "model" && Calls(message)
                    ? RawExchangeEnd(older, index, seqCounts)
                    : index;
            var grouped = older.Skip(index).Take(endIndex - index + 1).ToArray();
            var text = string.Join(
                " | ",
                grouped
                    .Where(Visible)
                    .Select(row =>
                    {
                        var preview = Preview(row, true);
                        return CompactPrompt.TruncateGraphemes(
                            preview,
                            50,
                            "...",
                            includeSuffixInLimit: false
                        );
                    })
                    .Where(part => part.Length > 0)
            );
            var estimated = grouped.Where(Visible).Sum(row => Tokens(Preview(row, true)));
            var endSeq = Number(Meta(grouped[^1])?["seq"])!.Value;
            entries.Add(
                new CompactCandidate(
                    "message",
                    0,
                    seq.Value,
                    endSeq,
                    seq.Value,
                    endSeq,
                    index,
                    endIndex,
                    Finite(meta?["timestamp"]),
                    Finite(Meta(grouped[^1])?["timestamp"]),
                    text.Length > 0 ? text : "[empty message]",
                    estimated,
                    segment
                )
            );
            priorKind = "message";
            previousSeq = endSeq;
            index = endIndex;
        }
        // A regular compaction writes its new level-1 block from the raw messages after the
        // newest block; older raw messages left between blocks are not part of that source.
        var newestBlock = entries.FindLastIndex(item => item.Kind == "block");
        var rawTokens = entries
            .Where((item, index) => item.Kind == "message" && (inContext || index > newestBlock))
            .Sum(item => item.Tokens);
        var eligible = inContext || rawTokens > 2000;
        if (!eligible)
            entries.RemoveAll(item => item.Kind == "message");
        foreach (var (_, items, _) in preservedExchanges)
        foreach (var item in items)
            item.Exchange = items.Select(member => member.Seq).ToArray();
        return new CompactCandidates(
            history,
            split,
            entries,
            preserved,
            eligible ? rawTokens : 0,
            eligible && !inContext ? (int)Math.Ceiling(rawTokens * .2) : 0,
            inContext ? [] : CompactRetention.Plan(entries),
            inContext
        );
    }

    private static HashSet<int> UnsequencedExchangeMembers(IReadOnlyList<JsonObject> history)
    {
        var members = new HashSet<int>();
        for (var start = 0; start < history.Count; start++)
        {
            if (Role(history[start]) != "model" || !Calls(history[start]))
                continue;
            var end = start;
            for (var next = start + 1; next < history.Count; next++)
            {
                var row = history[next];
                if (
                    Meta(row)?["contextBlock"] is not null
                    || Role(row) != "tool" && !Transparent(row)
                )
                    break;
                if (Role(row) == "tool")
                    end = next;
            }
            if (
                end > start
                && Enumerable
                    .Range(start, end - start + 1)
                    .Any(index => Number(Meta(history[index])?["seq"]) is not > 0)
            )
                for (var index = start; index <= end; index++)
                    members.Add(index);
            start = end;
        }
        return members;
    }

    private static Dictionary<long, int> RawSequenceCounts(IReadOnlyList<JsonObject> history)
    {
        var counts = new Dictionary<long, int>();
        foreach (var row in history)
        {
            var meta = Meta(row);
            if (meta?["contextBlock"] is null && Number(meta?["seq"]) is > 0 and var seq)
                counts[seq] = counts.GetValueOrDefault(seq) + 1;
        }
        return counts;
    }

    private static int RawExchangeEnd(
        IReadOnlyList<JsonObject> history,
        int start,
        IReadOnlyDictionary<long, int> seqCounts
    )
    {
        var end = start;
        var walkedSeq = Number(Meta(history[start])?["seq"]);
        var preserved = Number(Meta(history[start])?["preservedFromBlockId"]) is > 0;
        for (var next = start + 1; next < history.Count; next++)
        {
            var row = history[next];
            var meta = Meta(row);
            var seq = Number(meta?["seq"]);
            if (
                meta?["contextBlock"] is not null
                || !preserved && Number(meta?["preservedFromBlockId"]) is > 0
                || seq is null
                || seqCounts.GetValueOrDefault(seq.Value) != 1
                || seq <= walkedSeq
                || Role(row) != "tool" && !Transparent(row)
            )
                break;
            walkedSeq = seq;
            // A trailing presentation notice alone does not extend a call-only source.
            if (Role(row) == "tool")
                end = next;
        }
        return end;
    }

    private static bool Transparent(JsonObject row) => !Visible(row) || Completion(row);

    private static bool FollowsAcrossTransparentRows(
        IReadOnlyList<JsonObject> history,
        int previousIndex,
        int currentIndex,
        IReadOnlyDictionary<long, int> seqCounts
    )
    {
        var previousSeq = Number(Meta(history[previousIndex])?["seq"]);
        for (var index = previousIndex + 1; index <= currentIndex; index++)
        {
            var row = history[index];
            var meta = Meta(row);
            var seq = Number(meta?["seq"]);
            if (
                seq is null
                || seqCounts.GetValueOrDefault(seq.Value) != 1
                || seq <= previousSeq
                || meta?["contextBlock"] is not null
                || index < currentIndex && !Transparent(row)
            )
                return false;
            previousSeq = seq;
        }
        return true;
    }

    public static long? Number(JsonNode? node)
    {
        if (node is not JsonValue scalar)
            return null;
        if (scalar.TryGetValue<long>(out var integer))
            return integer;
        if (scalar.TryGetValue<int>(out var value))
            return value;
        if (
            scalar.TryGetValue<double>(out var real)
            && double.IsFinite(real)
            && real >= long.MinValue
            && real <= long.MaxValue
            && Math.Truncate(real) == real
        )
            return (long)real;
        return null;
    }

    public static double? Finite(JsonNode? node)
    {
        if (node is not JsonValue scalar)
            return null;
        if (scalar.TryGetValue<double>(out var number) && double.IsFinite(number))
            return number;
        if (scalar.TryGetValue<long>(out var integer))
            return integer;
        return null;
    }

    public static JsonObject? Meta(JsonObject row) => row["__meta"] as JsonObject;

    public static string Role(JsonObject row) => row["role"]?.GetValue<string>() ?? "";

    public static bool Visible(JsonObject row) =>
        row["modelVisible"] is not JsonValue flag
        || !flag.TryGetValue<bool>(out var value)
        || value;

    private static IEnumerable<string> ToolIds(JsonObject row, string partKind, string field) =>
        ((row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
            .Select(part => SessionWait.Text(part[partKind]?[field]))
            .OfType<string>()
            .Where(id => id.Length > 0);

    public static bool Calls(JsonObject row) =>
        (row["parts"] as JsonArray)
            ?.OfType<JsonObject>()
            .Any(part => part["functionCall"] is JsonObject) == true;

    public static bool Completion(JsonObject row)
    {
        if (!Visible(row))
            return false;
        var parts = (row["parts"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        return parts.Any(part =>
                SessionWait.Text(part["system"]) is string system
                && CompletionSystemText(OpenAIRequestText.Trim(system))
            )
            && !parts.Any(part =>
                (
                    SessionWait.Text(part["text"]) is string text
                    && OpenAIRequestText.Trim(text).Length > 0
                    && !(
                        part["systemPayload"] is JsonValue flag
                        && flag.TryGetValue<bool>(out var payload)
                        && payload
                    )
                )
                || (
                    SessionWait.Text(part["thinking"]) is string thinking
                    && OpenAIRequestText.Trim(thinking).Length > 0
                )
                || part["functionCall"] is not null
                || part["functionResponse"] is not null
                || part["inlineData"] is not null
                || part["inlineDataRef"] is not null
            );
    }

    private static bool CompletionSystemText(string text)
    {
        // Only the opening system wrapper identifies a completion; quoted body text does not.
        var opening = Regex.Match(
            text,
            "^<foxwarm-([a-zA-Z0-9_-]+)\\b([^>]*)>",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.ECMAScript
        );
        if (
            opening.Success
            && opening.Groups[1].Value.Equals("system", StringComparison.OrdinalIgnoreCase)
        )
        {
            var attributes = new Dictionary<string, string>();
            foreach (
                Match attribute in Regex.Matches(
                    opening.Groups[2].Value,
                    "([a-zA-Z_:][a-zA-Z0-9_.:-]*)\\s*=\\s*\"([^\"]*)\""
                )
            )
                attributes[attribute.Groups[1].Value] = attribute
                    .Groups[2]
                    .Value.Replace("&quot;", "\"", StringComparison.Ordinal)
                    .Replace("&apos;", "'", StringComparison.Ordinal)
                    .Replace("&lt;", "<", StringComparison.Ordinal)
                    .Replace("&gt;", ">", StringComparison.Ordinal)
                    .Replace("&amp;", "&", StringComparison.Ordinal);
            return attributes.GetValueOrDefault("kind") == "session-boundary"
                && attributes.GetValueOrDefault("event") == "compact-completed";
        }
        return text.StartsWith("Compaction completed.", StringComparison.Ordinal)
            || text.StartsWith("**COMPACTION COMPLETED.", StringComparison.Ordinal)
            || text.StartsWith("Manual compaction completed.", StringComparison.Ordinal);
    }

    public static bool Ignored(JsonObject row)
    {
        if (!Visible(row))
            return true;
        var parts = (row["parts"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        var systems = parts
            .Select(part => part["system"]?.GetValue<string>()?.Trim())
            .Where(text => !string.IsNullOrEmpty(text))
            .ToArray();
        if (systems.Length == 0)
            return false;
        if (
            parts.Any(part =>
                part["text"]?.GetValue<string>()?.Trim().Length > 0
                || part["thinking"]?.GetValue<string>()?.Trim().Length > 0
                || part["functionCall"] is not null
                || part["functionResponse"] is not null
            )
        )
            return false;
        return systems.All(text =>
            text!.StartsWith("<foxwarm-system", StringComparison.Ordinal)
                && (
                    text.Contains("event=\"compact", StringComparison.Ordinal)
                    || text.Contains("kind=\"session-boundary\"", StringComparison.Ordinal)
                )
            || text!.StartsWith("Compaction completed.", StringComparison.Ordinal)
            || text.StartsWith("Manual compaction completed.", StringComparison.Ordinal)
            || text.StartsWith("This session has been compacted.", StringComparison.Ordinal)
            || text.StartsWith("Compacted message placeholder:", StringComparison.Ordinal)
            || text.StartsWith("**COMPACTION COMPLETED.", StringComparison.Ordinal)
        );
    }

    public static string Preview(JsonObject row, bool skipSystem)
    {
        row = (JsonObject)
            Foxwarm
                .Images.ImageTokenEstimate.Sanitize(Foxwarm.Images.ImageTransport.Project(row))
                .Value!;
        var pieces = new List<string>();
        foreach (var part in (row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (
                part["system"] is JsonValue system
                && system.TryGetValue<string>(out var text)
                && text.Trim().Length > 0
                && (
                    !skipSystem
                    || !(
                        text.StartsWith("<foxwarm-system kind=\"time\"", StringComparison.Ordinal)
                        || text.StartsWith(
                            "<foxwarm-system kind=\"session\"",
                            StringComparison.Ordinal
                        )
                        || text.StartsWith(
                            "<foxwarm-system kind=\"channel-mode\"",
                            StringComparison.Ordinal
                        )
                    )
                )
            )
                pieces.Add("[system] " + text);
            if (
                part["text"] is JsonValue body
                && body.TryGetValue<string>(out var content)
                && content.Trim().Length > 0
                && !content.Contains(
                    "--- RELEVANT MEMORY SNIPPETS (RAG) ---",
                    StringComparison.Ordinal
                )
            )
                pieces.Add(content);
            if (part["functionCall"] is JsonObject call)
                pieces.Add(
                    $"[call:{call["name"]?.GetValue<string>()}] {call["rawArgsText"]?.GetValue<string>() ?? call["args"]?.ToJsonString() ?? ""}"
                );
            if (part["functionResponse"] is JsonObject response)
            {
                var source = InputSender.Without(response["response"]);
                var value = source as JsonObject;
                var output =
                    value?["error"] is JsonNode error
                        ? "ERROR: "
                            + (
                                error is JsonValue stringError
                                && stringError.TryGetValue<string>(out var message)
                                    ? message
                                    : error.ToJsonString()
                            )
                    : value?["output"] is JsonValue outputValue
                    && outputValue.TryGetValue<string>(out var textOutput)
                        ? textOutput
                    : value?["output"]?.ToJsonString()
                        ?? value?["content"]?.ToJsonString()
                        ?? source?.ToJsonString()
                        ?? "";
                pieces.Add($"[tool:{response["name"]?.GetValue<string>() ?? "unknown"}] {output}");
            }
        }
        var normalized = string.Join('\n', pieces).Trim();
        var lines = normalized.Split('\n');
        return lines.Length <= 1
            ? normalized
            : lines[0] + "\n" + string.Join('\n', lines.Skip(1).Select(line => "> " + line));
    }

    private static bool ValidBlock(JsonObject block)
    {
        var id = Number(block["id"]);
        var level = Number(block["level"]);
        var first = Number(block["sourceStart"]);
        var last = Number(block["sourceEnd"]);
        var rawFirst = Number(block["rawStartSeq"]);
        var rawLast = Number(block["rawEndSeq"]);
        if (
            id is not > 0
            || level is not > 0
            || first is not > 0
            || last is not > 0
            || rawFirst is not > 0
            || rawLast is null
            || rawLast < rawFirst
        )
            return false;
        if (
            block.ContainsKey("rawStartTimestamp") && Finite(block["rawStartTimestamp"]) is null
            || block.ContainsKey("rawEndTimestamp") && Finite(block["rawEndTimestamp"]) is null
            || Finite(block["rawStartTimestamp"]) is double from
                && Finite(block["rawEndTimestamp"]) is double to
                && from > to
        )
            return false;
        var kind = block["sourceKind"]?.GetValue<string>();
        if (kind == "message")
            return level == 1 && first <= last && first == rawFirst && last == rawLast;
        var ids = block["sourceBlockIds"] as JsonArray;
        if (kind != "block" || level <= 1 || ids is not { Count: > 0 })
            return false;
        var numbers = ids.Select(Number).ToArray();
        return numbers.All(number => number is > 0)
            && numbers[0] == first
            && numbers[^1] == last
            && numbers.Distinct().Count() == numbers.Length;
    }
}
