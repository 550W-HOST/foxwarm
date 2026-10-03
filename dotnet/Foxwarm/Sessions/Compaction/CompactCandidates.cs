using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record CompactCandidate(
    string Kind, int SourceLevel, long Start, long End, long RawStart, long RawEnd,
    int HistoryStart, int HistoryEnd, double? StartTimestamp, double? EndTimestamp,
    string Preview, int Tokens, int Segment, bool Stranded = false)
{
    public string Key => Kind == "message"
        ? Start == End ? $"M#{Start}" : $"M#{Start}-#{End}"
        : $"B#{Start}";
    public int TargetLevel => Kind == "message" ? 1 : SourceLevel + 1;
}

internal sealed record BlockPolicy(int SourceLevel, int TotalCount, int TotalTokens, int ForcedKeep,
    int CandidateCount, int RequestedMin, int FeasibleMax, int EffectiveMin, string? Skipped);

internal sealed record CompactCandidates(
    IReadOnlyList<JsonObject> History, int Split, IReadOnlyList<CompactCandidate> Items,
    IReadOnlyList<(long Seq, long BlockId, string Preview)> Preserved,
    int EligibleRawTokens, int RequiredRawTokens, string? RawSkipped, IReadOnlyList<BlockPolicy> BlockPolicies)
{
    public IReadOnlyList<IReadOnlyList<CompactCandidate>> Segments()
    {
        var segments = new List<IReadOnlyList<CompactCandidate>>();
        List<CompactCandidate>? current = null;
        foreach (var item in Items)
        {
            if (current is null || current.Count == 0 || item.Segment != current[^1].Segment
                || item.Kind != current[^1].Kind || item.SourceLevel != current[^1].SourceLevel)
            {
                current = [];
                segments.Add(current);
            }
            current.Add(item);
        }
        return segments;
    }
}

internal static class CompactCandidateBuilder
{
    public static int Tokens(string text)
    {
        var count = 0d;
        foreach (var character in text) count += character < 128 ? 0.33 : 1;
        return (int)Math.Ceiling(count);
    }

    public static int Split(IReadOnlyList<JsonObject> history, double keepPercent = .3)
    {
        var split = keepPercent > 0 ? (int)Math.Floor(history.Count * (1 - keepPercent)) : history.Count;
        if (keepPercent > 0 && split < history.Count && Role(history[split]) == "tool")
        {
            var cursor = split;
            while (cursor > 0 && Role(history[cursor]) == "tool") cursor--;
            if (Role(history[cursor]) == "model" && Calls(history[cursor])) split = cursor;
        }
        return split;
    }

    public static CompactCandidates Build(IReadOnlyList<JsonObject> history, double keepPercent = .3)
    {
        var split = Split(history, keepPercent);
        var older = history.Take(split).ToArray();
        var seqCounts = new Dictionary<long, int>();
        var blockCounts = new Dictionary<long, int>();
        for (var index = 0; index < older.Length; index++)
        {
            var meta = Meta(older[index]);
            if (meta?["contextBlock"] is JsonObject block && Number(block["id"]) is long id && id > 0)
                blockCounts[id] = blockCounts.GetValueOrDefault(id) + 1;
            else if (Number(meta?["seq"]) is long seq && seq > 0)
                seqCounts[seq] = seqCounts.GetValueOrDefault(seq) + 1;
        }
        var blocksByLevel = older.Select(message => Meta(message)?["contextBlock"] as JsonObject)
            .Where(block => block is not null && ValidBlock(block) && blockCounts[Number(block["id"])!.Value] == 1)
            .GroupBy(block => (int)Number(block!["level"])!.Value)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var prelim = new Dictionary<int, (int Count, int Tokens, int Keep, int Candidate, int Minimum, HashSet<long> Ids)>();
        foreach (var (level, blocks) in blocksByLevel)
        {
            var tokens = blocks.Sum(block => Tokens(Preview(older.First(message =>
                Number(Meta(message)?["contextBlock"]?["id"]) == Number(block!["id"])), false)));
            var candidateCount = tokens < 3000 ? 0 : (int)Math.Floor(blocks.Length * .4);
            var minimum = tokens >= 5000 ? (int)Math.Ceiling(blocks.Length * .2) : 0;
            prelim[level] = (blocks.Length, tokens, blocks.Length - candidateCount, candidateCount, minimum,
                blocks.Take(candidateCount).Select(block => Number(block!["id"])!.Value).ToHashSet());
        }
        var entries = new List<CompactCandidate>();
        var preserved = new List<(long, long, string)>();
        var segment = 1;
        string? priorKind = null;
        int priorLevel = 0;
        long? previousSeq = null, previousBlockEnd = null;
        for (var index = 0; index < older.Length; index++)
        {
            var message = older[index];
            var meta = Meta(message);
            var seq = Number(meta?["seq"]);
            var preservedBlock = Number(meta?["preservedFromBlockId"]);
            if (preservedBlock is > 0)
            {
                if (seq is > 0 && seqCounts.GetValueOrDefault(seq.Value) == 1 && !Ignored(message))
                    preserved.Add((seq.Value, preservedBlock.Value, Preview(message, true)));
                segment++; priorKind = null; previousSeq = previousBlockEnd = null; continue;
            }
            if (meta?["contextBlock"] is JsonObject block)
            {
                previousSeq = null;
                var id = Number(block["id"]); var level = Number(block["level"]);
                var rawStart = Number(block["rawStartSeq"]); var rawEnd = Number(block["rawEndSeq"]);
                if (id is not > 0 || level is not > 0 || rawStart is not > 0 || rawEnd is null || rawEnd < rawStart
                    || !ValidBlock(block)
                    || blockCounts.GetValueOrDefault(id.Value) != 1 || !prelim.TryGetValue((int)level.Value, out var policy)
                    || !policy.Ids.Contains(id.Value) || Role(message) != "model")
                { segment++; priorKind = null; previousBlockEnd = null; continue; }
                if (priorKind is not null && (priorKind != "block" || priorLevel != level.Value)) segment++;
                if (previousBlockEnd is not null && rawStart <= previousBlockEnd) segment++;
                var stranded = index > 0 && index + 1 < older.Length
                    && Number(Meta(older[index - 1])?["contextBlock"]?["level"]) > level
                    && Number(Meta(older[index + 1])?["contextBlock"]?["level"]) > level;
                var summary = Preview(message, false);
                entries.Add(new CompactCandidate("block", (int)level.Value, id.Value, id.Value, rawStart.Value,
                    rawEnd.Value, index, index, Finite(block["rawStartTimestamp"]), Finite(block["rawEndTimestamp"]),
                    summary, Tokens(summary), segment, stranded));
                priorKind = "block"; priorLevel = (int)level.Value; previousBlockEnd = rawEnd; continue;
            }
            previousBlockEnd = null;
            if (seq is not > 0 || seqCounts.GetValueOrDefault(seq.Value) != 1
                || previousSeq is not null && seq != previousSeq + 1)
            { segment++; priorKind = null; previousSeq = Role(message) == "tool" ? null : seq; continue; }
            if (!Visible(message) || Completion(message)) { previousSeq = seq; continue; }
            if (Ignored(message)) { segment++; priorKind = null; continue; }
            if (priorKind is not null && priorKind != "message") segment++;
            var grouped = new List<JsonObject> { message };
            var endIndex = index;
            if (Role(message) == "model" && Calls(message))
                for (var next = index + 1; next < older.Length; next++)
                {
                    var row = older[next]; var nextMeta = Meta(row); var nextSeq = Number(nextMeta?["seq"]);
                    if (Role(row) != "tool" || nextMeta?["contextBlock"] is not null || Number(nextMeta?["preservedFromBlockId"]) is > 0
                        || nextSeq is null || seqCounts.GetValueOrDefault(nextSeq.Value) != 1
                        || nextSeq != Number(Meta(grouped[^1])?["seq"]) + 1) break;
                    grouped.Add(row); endIndex = next;
                }
            var text = string.Join(" | ", grouped.Where(Visible).Select(row =>
                {
                    var preview = Preview(row, true);
                    return CompactPrompt.TruncateGraphemes(preview, 50, "...", includeSuffixInLimit: false);
                }).Where(part => part.Length > 0));
            var estimated = grouped.Where(Visible).Sum(row => Tokens(Preview(row, true)));
            var endSeq = Number(Meta(grouped[^1])?["seq"])!.Value;
            entries.Add(new CompactCandidate("message", 0, seq.Value, endSeq, seq.Value, endSeq,
                index, endIndex, Finite(meta?["timestamp"]), Finite(Meta(grouped[^1])?["timestamp"]),
                text.Length > 0 ? text : "[empty message]", estimated, segment));
            priorKind = "message"; previousSeq = endSeq; index = endIndex;
        }
        var rawTokens = entries.Where(item => item.Kind == "message").Sum(item => item.Tokens);
        var eligible = rawTokens > 2000;
        if (!eligible) entries.RemoveAll(item => item.Kind == "message");
        var policies = new List<BlockPolicy>();
        foreach (var (level, policy) in prelim)
        {
            var group = entries.Where(item => item.Kind == "block" && item.SourceLevel == level).ToArray();
            var feasible = group.GroupBy(item => item.Segment).Sum(segmentItems => segmentItems.Count() >= 2 ? segmentItems.Count() : 0);
            policies.Add(new BlockPolicy(level, policy.Count, policy.Tokens, policy.Keep, policy.Candidate,
                policy.Minimum, feasible, Math.Min(policy.Minimum, feasible),
                policy.Tokens < 3000 ? "below the 3000-token block eligibility threshold"
                : policy.Candidate == 0 ? "the strict oldest-candidate window is empty at this level size"
                : policy.Minimum > 0 && feasible == 0 ? "no legal contiguous multi-block candidate segment is available" : null));
        }
        return new CompactCandidates(history, split, entries, preserved,
            eligible ? rawTokens : 0, eligible ? (int)Math.Ceiling(rawTokens * .2) : 0,
            eligible ? null : rawTokens > 0 ? $"~{rawTokens} raw-message tokens do not exceed the 2000-token eligibility threshold"
                : "no eligible model-visible raw message candidates", policies);
    }

    public static long? Number(JsonNode? node)
    {
        if (node is not JsonValue scalar) return null;
        if (scalar.TryGetValue<long>(out var integer)) return integer;
        if (scalar.TryGetValue<int>(out var value)) return value;
        if (scalar.TryGetValue<double>(out var real) && double.IsFinite(real) && real >= long.MinValue
            && real <= long.MaxValue && Math.Truncate(real) == real) return (long)real;
        return null;
    }
    public static double? Finite(JsonNode? node)
    {
        if (node is not JsonValue scalar) return null;
        if (scalar.TryGetValue<double>(out var number) && double.IsFinite(number)) return number;
        if (scalar.TryGetValue<long>(out var integer)) return integer;
        return null;
    }
    public static JsonObject? Meta(JsonObject row) => row["__meta"] as JsonObject;
    public static string Role(JsonObject row) => row["role"]?.GetValue<string>() ?? "";
    public static bool Visible(JsonObject row) => row["modelVisible"] is not JsonValue flag || !flag.TryGetValue<bool>(out var value) || value;
    public static bool Calls(JsonObject row) => (row["parts"] as JsonArray)?.OfType<JsonObject>().Any(part => part["functionCall"] is JsonObject) == true;
    public static bool Completion(JsonObject row) => (row["parts"] as JsonArray)?.OfType<JsonObject>().Any(part =>
        part["system"]?.GetValue<string>()?.Contains("event=\"compact-completed\"", StringComparison.Ordinal) == true) == true;
    public static bool Ignored(JsonObject row)
    {
        if (!Visible(row)) return true;
        var parts = (row["parts"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
        var systems = parts.Select(part => part["system"]?.GetValue<string>()?.Trim()).Where(text => !string.IsNullOrEmpty(text)).ToArray();
        if (systems.Length == 0) return false;
        if (parts.Any(part => part["text"]?.GetValue<string>()?.Trim().Length > 0
            || part["thinking"]?.GetValue<string>()?.Trim().Length > 0
            || part["functionCall"] is not null || part["functionResponse"] is not null)) return false;
        return systems.All(text => text!.StartsWith("<foxwarm-system", StringComparison.Ordinal)
            && (text.Contains("event=\"compact", StringComparison.Ordinal)
                || text.Contains("kind=\"session-boundary\"", StringComparison.Ordinal))
            || text!.StartsWith("Compaction completed.", StringComparison.Ordinal)
            || text.StartsWith("Manual compaction completed.", StringComparison.Ordinal)
            || text.StartsWith("This session has been compacted.", StringComparison.Ordinal)
            || text.StartsWith("Compacted message placeholder:", StringComparison.Ordinal)
            || text.StartsWith("**COMPACTION COMPLETED.", StringComparison.Ordinal));
    }
    public static string Preview(JsonObject row, bool skipSystem)
    {
        row = (JsonObject)Foxwarm.Images.ImageTokenEstimate.Sanitize(Foxwarm.Images.ImageTransport.Project(row)).Value!;
        var pieces = new List<string>();
        foreach (var part in (row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (part["system"] is JsonValue system && system.TryGetValue<string>(out var text) && text.Trim().Length > 0
                && (!skipSystem || !(text.StartsWith("<foxwarm-system kind=\"time\"", StringComparison.Ordinal)
                    || text.StartsWith("<foxwarm-system kind=\"session\"", StringComparison.Ordinal)
                    || text.StartsWith("<foxwarm-system kind=\"channel-mode\"", StringComparison.Ordinal))))
                pieces.Add("[system] " + text);
            if (part["text"] is JsonValue body && body.TryGetValue<string>(out var content) && content.Trim().Length > 0
                && !content.Contains("--- RELEVANT MEMORY SNIPPETS (RAG) ---", StringComparison.Ordinal))
                pieces.Add(content);
            if (part["functionCall"] is JsonObject call)
                pieces.Add($"[call:{call["name"]?.GetValue<string>()}] {call["rawArgsText"]?.GetValue<string>() ?? call["args"]?.ToJsonString() ?? ""}");
            if (part["functionResponse"] is JsonObject response)
            {
                var value = response["response"] as JsonObject;
                var output = value?["error"] is JsonNode error
                    ? "ERROR: " + (error is JsonValue stringError && stringError.TryGetValue<string>(out var message)
                        ? message : error.ToJsonString())
                    : value?["output"] is JsonValue outputValue && outputValue.TryGetValue<string>(out var textOutput)
                        ? textOutput : value?["output"]?.ToJsonString() ?? value?["content"]?.ToJsonString()
                            ?? value?.ToJsonString() ?? "";
                pieces.Add($"[tool:{response["name"]?.GetValue<string>() ?? "unknown"}] {output}");
            }
        }
        var normalized = string.Join('\n', pieces).Trim();
        var lines = normalized.Split('\n');
        return lines.Length <= 1 ? normalized : lines[0] + "\n" + string.Join('\n', lines.Skip(1).Select(line => "> " + line));
    }

    private static bool ValidBlock(JsonObject block)
    {
        var id = Number(block["id"]); var level = Number(block["level"]);
        var first = Number(block["sourceStart"]); var last = Number(block["sourceEnd"]);
        var rawFirst = Number(block["rawStartSeq"]); var rawLast = Number(block["rawEndSeq"]);
        if (id is not > 0 || level is not > 0 || first is not > 0 || last is not > 0
            || rawFirst is not > 0 || rawLast is null || rawLast < rawFirst) return false;
        if (block.ContainsKey("rawStartTimestamp") && Finite(block["rawStartTimestamp"]) is null
            || block.ContainsKey("rawEndTimestamp") && Finite(block["rawEndTimestamp"]) is null
            || Finite(block["rawStartTimestamp"]) is double from
                && Finite(block["rawEndTimestamp"]) is double to && from > to) return false;
        var kind = block["sourceKind"]?.GetValue<string>();
        if (kind == "message") return level == 1 && first <= last && first == rawFirst && last == rawLast;
        var ids = block["sourceBlockIds"] as JsonArray;
        if (kind != "block" || level <= 1 || ids is not { Count: > 0 }) return false;
        var numbers = ids.Select(Number).ToArray();
        return numbers.All(number => number is > 0)
            && numbers[0] == first && numbers[^1] == last
            && numbers.Distinct().Count() == numbers.Length;
    }
}
