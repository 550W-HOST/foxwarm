using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal sealed record CompactOperation(
    CompactCandidate First,
    CompactCandidate Last,
    int CandidateStart,
    int CandidateEnd,
    string Summary,
    JsonArray? MemoryFacts,
    int? FrictionScore = null
)
{
    public string Kind => First.Kind;
    public int Level => First.TargetLevel;
    public int HistoryStart => First.HistoryStart;
    public int HistoryEnd => Last.HistoryEnd;
    public long RawStart => First.RawStart;
    public long RawEnd => Last.RawEnd;
}

internal sealed record CompactPlan(
    IReadOnlyList<CompactOperation> Operations,
    IReadOnlySet<long> Preserve,
    IReadOnlySet<long> Remove
)
{
    internal CompactionPlannerDebug? Planner { get; init; }
}

internal sealed class CompactPlanInvalidException(string message) : Exception(message);

internal static class CompactPlanValidator
{
    private static readonly HashSet<string> FactKinds =
    [
        "decision",
        "preference",
        "fact",
        "convention",
        "environment",
    ];
    private static readonly HashSet<string> Attributions = ["user", "assistant", "both"];

    public static CompactPlan Validate(JsonObject args, CompactCandidates candidates)
    {
        if (args.ContainsKey("createBlocksJson") || args.ContainsKey("createBlocks"))
            throw new CompactPlanInvalidException(
                "createBlocksJson/createBlocks is obsolete; use replaceAsBlocks with a direct array or JSON-encoded array string."
            );
        if (!args.ContainsKey("replaceAsBlocks"))
            throw new CompactPlanInvalidException(
                "replaceAsBlocks is required and must be an array or a non-empty JSON string encoding an array."
            );
        var raw = args["replaceAsBlocks"];
        if (raw is JsonValue text && text.TryGetValue<string>(out var serialized))
        {
            if (string.IsNullOrWhiteSpace(serialized))
                throw new CompactPlanInvalidException(
                    "replaceAsBlocks JSON string must be non-empty and encode an array."
                );
            try
            {
                raw = JsonNode.Parse(serialized);
            }
            catch (JsonException error)
            {
                throw new CompactPlanInvalidException(
                    "replaceAsBlocks must be valid JSON when passed as a string: " + error.Message
                );
            }
        }
        if (raw is not JsonArray blocks)
            throw new CompactPlanInvalidException(
                "replaceAsBlocks must be a direct array or a JSON string encoding an array."
            );
        var preserve = PositiveIds(args["preserveMessages"], "preserveMessages");
        var remove = PositiveIds(args["removePreservedMessages"], "removePreservedMessages");
        if (blocks.Count == 0 && remove.Count == 0)
            throw new CompactPlanInvalidException(
                "replaceAsBlocks must contain at least one block unless removePreservedMessages removes previously preserved raw messages."
            );
        if (preserve.Overlaps(remove))
            throw new CompactPlanInvalidException(
                "A message cannot appear in both preserveMessages and removePreservedMessages."
            );
        foreach (var seq in remove)
            if (candidates.Preserved.All(entry => entry.Seq != seq))
                throw new CompactPlanInvalidException(
                    $"removePreservedMessages contains msg#{seq}, but that message is not listed as a previously preserved raw message in the current compact candidates."
                );

        var used = new HashSet<int>();
        var operations = new List<CompactOperation>();
        var seenFacts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var factsRemaining = 20;
        foreach (var (node, blockIndex) in blocks.Select((value, index) => (value, index)))
        {
            var item =
                node as JsonObject
                ?? throw new CompactPlanInvalidException(
                    $"replaceAsBlocks[{blockIndex}] must be an object."
                );
            var level = Number(item["level"]);
            var kind =
                item["sourceKind"] is JsonValue source && source.TryGetValue<string>(out var type)
                    ? type
                    : "";
            var start = Number(item["sourceStart"]);
            var end = Number(item["sourceEnd"]);
            var summary =
                item["summary"] is JsonValue value && value.TryGetValue<string>(out var textValue)
                    ? textValue.Trim()
                    : "";
            if (
                level is not > 0
                || start is not > 0
                || end is not > 0
                || kind is not ("message" or "block")
                || summary.Length == 0
                || kind == "message" && (level != 1 || start > end)
                || kind == "block" && level <= 1
            )
                throw new CompactPlanInvalidException(
                    $"replaceAsBlocks[{blockIndex}] has invalid level/sourceKind/sourceStart/sourceEnd/summary."
                );
            var firstIndex = candidates
                .Items.ToList()
                .FindIndex(candidate =>
                    candidate.Kind == kind
                    && candidate.TargetLevel == level
                    && candidate.Start == start
                );
            if (firstIndex < 0)
                throw new CompactPlanInvalidException(
                    $"replaceAsBlocks[{blockIndex}] sourceStart is not a listed candidate."
                );
            var first = candidates.Items[firstIndex];
            var endIndex = -1;
            for (var i = firstIndex; i < candidates.Items.Count; i++)
            {
                var candidate = candidates.Items[i];
                if (
                    candidate.Kind != kind
                    || candidate.TargetLevel != level
                    || candidate.Segment != first.Segment
                )
                    break;
                if (candidate.End == end)
                {
                    endIndex = i;
                    break;
                }
            }
            if (endIndex < firstIndex)
                throw new CompactPlanInvalidException(
                    $"replaceAsBlocks[{blockIndex}] does not match a continuous candidate range in current older context."
                );
            if (
                !candidates.InContext
                && kind == "block"
                && endIndex == firstIndex
                && !first.Stranded
            )
                throw new CompactPlanInvalidException(
                    $"replaceAsBlocks[{blockIndex}] uses a single block source, which is allowed only for a stranded block immediately surrounded by higher-level blocks."
                );
            for (var i = firstIndex; i <= endIndex; i++)
                if (!used.Add(i))
                    throw new CompactPlanInvalidException(
                        $"replaceAsBlocks[{blockIndex}] overlaps another replaceAsBlocks range at candidate {candidates.Items[i].Key}."
                    );
            var facts = NormalizeFacts(item["memoryFacts"], seenFacts, ref factsRemaining);
            operations.Add(
                new CompactOperation(
                    first,
                    candidates.Items[endIndex],
                    firstIndex,
                    endIndex,
                    summary,
                    facts,
                    Friction(item["frictionScore"])
                )
            );
        }
        foreach (var seq in preserve.ToArray())
        {
            var index = candidates
                .Items.ToList()
                .FindIndex(candidate =>
                    candidate.Kind == "message"
                    && candidates
                        .History.Skip(candidate.HistoryStart)
                        .Take(candidate.HistoryEnd - candidate.HistoryStart + 1)
                        .Any(row => Number(CompactCandidateBuilder.Meta(row)?["seq"]) == seq)
                );
            if (index < 0)
                throw new CompactPlanInvalidException(
                    $"preserveMessages contains msg#{seq}, but that raw message is not present in the current compact message candidates."
                );
            if (
                operations.All(op =>
                    op.Kind != "message" || index < op.CandidateStart || index > op.CandidateEnd
                )
            )
                throw new CompactPlanInvalidException(
                    $"preserveMessages contains msg#{seq}, but that message is not covered by any created message-source block."
                );
            var candidate = candidates.Items[index];
            foreach (
                var row in candidates
                    .History.Skip(candidate.HistoryStart)
                    .Take(candidate.HistoryEnd - candidate.HistoryStart + 1)
            )
                if (Number(CompactCandidateBuilder.Meta(row)?["seq"]) is long member)
                    preserve.Add(member);
        }
        foreach (var seq in remove)
        {
            var item = candidates.Preserved.First(entry => entry.Seq == seq);
            var missing = item.Exchange.Where(member => !remove.Contains(member)).ToArray();
            if (missing.Length > 0)
                throw new CompactPlanInvalidException(
                    $"removePreservedMessages contains msg#{seq}, which belongs to a preserved tool exchange; list every member to remove it. Missing: {string.Join(", ", missing.Select(member => $"msg#{member}"))}."
                );
        }
        var coveredTokens = operations
            .Where(op => op.Kind == "message")
            .SelectMany(op =>
                candidates
                    .Items.Skip(op.CandidateStart)
                    .Take(op.CandidateEnd - op.CandidateStart + 1)
            )
            .Where(candidate => !preserve.Contains(candidate.Start))
            .Sum(candidate => candidate.Tokens);
        if (coveredTokens < candidates.RequiredRawTokens)
            throw new CompactPlanInvalidException(
                $"Raw-message hard quota requires message-source replaceAsBlocks entries to actually replace at least ~{candidates.RequiredRawTokens} eligible estimated tokens, but this plan replaces only ~{coveredTokens} after excluding preserveMessages (deficit ~{candidates.RequiredRawTokens - coveredTokens})."
            );
        foreach (var block in candidates.BlockPolicies.Where(policy => policy.EffectiveMin > 0))
        {
            var covered = operations
                .Where(op =>
                    op.Kind == "block"
                    && op.First.SourceLevel == block.SourceLevel
                    && op.CandidateEnd > op.CandidateStart
                )
                .Sum(op => op.CandidateEnd - op.CandidateStart + 1);
            if (covered < block.EffectiveMin)
                throw new CompactPlanInvalidException(
                    $"Source L{block.SourceLevel} block hard quota requires valid multi-block operations to compact at least {block.EffectiveMin} candidate block(s), but this plan compacts only {covered}; stranded single-block lifts do not count (deficit {block.EffectiveMin - covered})."
                );
        }
        return new CompactPlan(
            operations.OrderBy(op => op.HistoryStart).ToArray(),
            preserve,
            remove
        );
    }

    private static HashSet<long> PositiveIds(JsonNode? raw, string label)
    {
        if (raw is null)
            return [];
        if (raw is not JsonArray values)
            throw new CompactPlanInvalidException(
                $"{label} must be an array of positive integer message seq numbers."
            );
        var result = new HashSet<long>();
        for (var index = 0; index < values.Count; index++)
        {
            var value = Number(values[index]);
            if (value is not > 0)
                throw new CompactPlanInvalidException(
                    $"{label}[{index}] must be a positive integer message seq number."
                );
            result.Add(value.Value);
        }
        return result;
    }

    internal static int? Friction(JsonNode? node) =>
        Number(node) is long value && value is >= 0 and <= 100 ? (int)value : null;

    private static long? Number(JsonNode? node) => CompactCandidateBuilder.Number(node);

    private static JsonArray? NormalizeFacts(JsonNode? raw, HashSet<string> seen, ref int remaining)
    {
        if (raw is not JsonArray input || remaining == 0)
            return null;
        var result = new JsonArray();
        foreach (var node in input.OfType<JsonObject>())
        {
            if (remaining == 0)
                break;
            var kind = Text(node, "kind")?.Trim();
            var text = Normalize(Text(node, "text"), 900);
            if (kind is null || !FactKinds.Contains(kind) || text.Length == 0 || !seen.Add(text))
                continue;
            var context = Normalize(Text(node, "context"), 500);
            var attributed = Text(node, "attributedTo") ?? Text(node, "attributed_to");
            var fact = new JsonObject { ["kind"] = kind, ["text"] = text };
            if (context.Length > 0)
                fact["context"] = context;
            if (attributed is not null && Attributions.Contains(attributed.Trim()))
                fact["attributedTo"] = attributed.Trim();
            result.Add(fact);
            remaining--;
        }
        return result.Count > 0 ? result : null;
    }

    private static string? Text(JsonObject obj, string key) =>
        obj[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string Normalize(string? value, int max)
    {
        var text = Regex.Replace(value?.Trim() ?? "", @"\s+", " ");
        return text.Length <= max ? text : text[..Math.Max(0, max - 1)] + "…";
    }
}
