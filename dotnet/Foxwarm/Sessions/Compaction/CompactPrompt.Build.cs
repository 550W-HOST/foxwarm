using System.Globalization;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static partial class CompactPrompt
{
    private static string Range(long? first, long? last) =>
        first is not null && last is not null
            ? first == last
                ? $"#{first}"
                : $"#{first}-#{last}"
            : first is not null
                ? $"#{first}-?"
                : last is not null
                    ? $"?-#{last}"
                    : "(seq unavailable)";

    internal static string TruncateGraphemes(
        string text,
        int limit,
        string suffix,
        bool includeSuffixInLimit
    )
    {
        var boundaries = StringInfo.ParseCombiningCharacters(text);
        if (limit <= 0 || boundaries.Length <= limit)
            return text;
        var keep = Math.Max(
            0,
            limit - (includeSuffixInLimit ? StringInfo.ParseCombiningCharacters(suffix).Length : 0)
        );
        return text[..(keep < boundaries.Length ? boundaries[keep] : text.Length)] + suffix;
    }

    private static string TrimPreview(string text, int limit)
    {
        // ECMAScript \s, not .NET \s (which additionally consumes U+0085).
        var normalized = Regex
            .Replace(
                text,
                "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
                " "
            )
            .Trim(' ');
        return TruncateGraphemes(normalized, limit, "…", includeSuffixInLimit: true);
    }

    private static string SegmentHeader(IReadOnlyList<CompactCandidate> segment, int index)
    {
        var first = segment[0];
        var last = segment[^1];
        if (first.Kind == "message")
            return $"Segment {index}: raw message candidates -> L1 block(s). Legal ranges must stay within {first.Key}..{last.Key} (sourceKind=message, level=1, sourceStart/sourceEnd at listed M# boundaries).";
        var span = first.Start == last.End ? $"B#{first.Start}" : $"B#{first.Start}..B#{last.End}";
        var baseText =
            $"Segment {index}: history-contiguous L{first.SourceLevel} block candidates -> L{first.TargetLevel} block(s). Legal ranges must stay within this segment ({span}; sourceKind=block, level={first.TargetLevel}, sourceStart/sourceEnd at listed B# boundaries). Block ids inside a segment may skip numbers or be out of numeric order; a range covers the listed candidates between its endpoints, not every numeric id in between.";
        if (segment.Count != 1)
            return baseText;
        return first.Stranded
            ? $"{baseText} This is a stranded single-block segment, so sourceStart=sourceEnd={first.Start} is allowed only if lifting this block preserves useful detail; leaving it uncompressed is also fine."
            : $"{baseText} This segment has only one block, so normally leave it uncompressed rather than creating an invalid single-block plan.";
    }

    public static string Build(CompactCandidates policy, string? guidance = null)
    {
        var recent = policy.History.Skip(policy.Split).ToArray();
        var recentSeqs = recent
            .Select(message =>
                CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(message)?["seq"])
            )
            .Where(seq => seq is not null)
            .ToArray();
        var lines = new List<string>
        {
            "COMPACTION STARTED: stop any previous task and focus only on layered-context compaction.",
            "Goal: Replace older context with compact, source-bound summaries that preserve what the main model needs to continue and identify when to recall details.",
            $"Recent messages {(recent.Length > 0 ? $"({recent.Length} rendered item(s), {Range(recentSeqs.FirstOrDefault(), recentSeqs.LastOrDefault())})" : "(none)")} are already force-kept verbatim by the system. No need to summarize/replace them.",
            "Hard compaction limits for this run:",
        };
        if (policy.RequiredRawTokens > 0)
            lines.Add(
                $"- Raw messages: ~{policy.EligibleRawTokens} eligible estimated tokens; message-source replaceAsBlocks entries must actually replace at least ~{policy.RequiredRawTokens} estimated tokens. Raw messages listed in preserveMessages stay verbatim and do not count toward this minimum."
            );
        else
            lines.Add(
                $"- Raw messages: no mandatory message compaction this run ({policy.RawSkipped ?? "no eligible raw message candidates"})."
            );
        foreach (var block in policy.BlockPolicies)
        {
            var baseText =
                $"- Source L{block.SourceLevel} blocks: {block.TotalCount} block(s), ~{block.TotalTokens} tokens; newest {block.ForcedKeep} are force-kept and are not candidates; oldest {block.CandidateCount} may be listed.";
            if (block.EffectiveMin > 0)
                lines.Add(
                    $"{baseText} Valid multi-block operations must compact at least {block.EffectiveMin} source L{block.SourceLevel} block(s) in total."
                );
            else if (block.RequestedMin > 0)
                lines.Add(
                    $"{baseText} Requested minimum {block.RequestedMin} was reduced to 0 because no legal multi-block range is feasible{(block.Skipped is null ? "" : $" ({block.Skipped})")}; stranded single-block lifts do not count as effective compression."
                );
            else
                lines.Add($"{baseText}{(block.Skipped is null ? "" : $" {block.Skipped}.")}");
        }
        lines.Add(
            "Hard minima may be satisfied across multiple legal Segments, but every individual replaceAsBlocks range must remain inside one Segment."
        );
        lines.Add("");
        var segments = policy.Segments();
        if (segments.Count == 0)
            lines.Add(
                "No normal summary-block candidate segments are available in this compaction slice."
            );
        for (var s = 0; s < segments.Count; s++)
        {
            var segment = segments[s];
            lines.Add(SegmentHeader(segment, s + 1));
            for (var i = 0; i < segment.Count; i++)
            {
                var item = segment[i];
                var limit = i < 2 || i >= segment.Count - 2 ? 300 : 80;
                var preview = TrimPreview(item.Preview, limit);
                if (item.Kind == "message")
                    lines.Add($"- {item.Key} {(preview.Length > 0 ? preview : "[empty message]")}");
                else
                    lines.Add(
                        $"- {item.Key} L{item.SourceLevel} raw{Range(item.RawStart, item.RawEnd)}{(item.FrictionScore is int score ? $" frictionScore={score}" : "")} {(preview.Length > 0 ? preview : "[empty block]")}"
                    );
            }
        }
        if (policy.Preserved.Count > 0)
        {
            lines.Add("Previously preserved raw messages already covered by summary blocks:");
            lines.Add(
                "These are still verbatim in working history for exact wording. If the summary block is now sufficient, remove them with removePreservedMessages: number[]. Do not summarize them again just to remove them."
            );
            foreach (var item in policy.Preserved)
                lines.Add(
                    $"- M#{item.Seq} preserved from B#{item.BlockId}: {TrimPreview(item.Preview, 300)}"
                );
        }
        lines.AddRange([
            "Review the older candidate items above and finish by calling submit_compact_plan. Do not answer with plain text only.",
            "Rules:",
            "- Pass summary-block creations via replaceAsBlocks. Prefer a direct array of objects; a JSON string encoding that same array is also accepted as a fallback. Use replaceAsBlocks: [] or replaceAsBlocks: \"[]\" if you only need to remove previously preserved raw messages.",
            "- Each replaceAsBlocks entry may include memoryFacts: an array of durable facts tied to exactly that source range. Invalid/omitted facts are ignored and never affect block creation; do not repeat them manually in summary prose.",
            "- Raw messages are summarized by L1 blocks, L1 blocks are summarized by L2 blocks, and so on.",
            "- Items covered by replaceAsBlocks will be replaced by the summary. Other items stay verbatim unless listed in removePreservedMessages.",
            "- Use preserveMessages for a small number of raw message seqs that must remain verbatim even though they are covered by a newly created message-source block. The system will extract them after the covering block in working history. Selecting any member of a tool exchange in preserveMessages keeps the model call message and all its paired response messages together.",
            "- Use removePreservedMessages only for messages listed in the \"Previously preserved raw messages\" section. This removes the raw message from active history only; it does not delete archive records or existing summary blocks. When removing a preserved tool exchange, list every member; partial removal is rejected.",
            "- Block compression is optional after satisfying the hard minima above. Prefer compressing only older/resolved/repetitive block segments; keep recent, detail-rich, decision-heavy, or still-active blocks verbatim by omitting them from replaceAsBlocks.",
            "- Subject to the hard minima above, if a block/message still seems useful, you can leave it uncompressed by simply omitting it from replaceAsBlocks.",
            "",
            "Block range rules (must be followed to produce a valid plan):",
            "- Treat each Segment header as a hard boundary: replaceAsBlocks ranges must stay inside one listed segment and must not cross different block levels or different source kinds. Block ids may be non-consecutive or decreasing; use only listed B# endpoints in history order.",
            "- A single block may be summarized only when it is a stranded island immediately surrounded on both sides by higher-level blocks; otherwise block sources must span at least two blocks.",
            "- Blocks must have same kind and same level of source; do not combine low-level and high-level blocks in one replaceAsBlocks entry.",
            "- Blocks must not overlap source ranges across replaceAsBlocks entries.",
            "- Blocks must not separate seq/id range inside a candidate (can not separate a tool call and its response).",
            "",
            "Summary writing guidance:",
            "- Summarize only the entry's source range. Preserve its state at that point; do not import later outcomes or facts from other ranges, including force-kept context.",
            "- Keep the requester's intent, constraints and authorization scope, consequential decisions and reasons, active or blocked work, unresolved questions, and concrete next steps. Distinguish confirmed results from hypotheses or proposals.",
            "- Preserve important corrections, superseded decisions and rejected approaches with their relevant reasons. For unclear terms or requirements, retain the original wording or note the uncertainty rather than guessing.",
            "- Keep identifiers and pointers needed to locate supporting evidence. Summarize recoverable detail rather than reproducing it; do not replace essential decisions or constraints with a pointer.",
            "- Use compact, natural wording suited to the material. The summary should support continuation alongside other retained context and let the reader recognize when recall is needed.",
            "",
            "Execution friction:",
            "Provide a frictionScore from 0 to 100 for each new block. Judge only the source range being summarized. Use 0 when no meaningful friction is evident; 1–29 for minor isolated obstacles; 30–59 for repeated misunderstandings, retries, corrections, or avoidable work; 60–79 for substantial recurring friction or blocked progress; and 80–100 for severe or systemic friction with strong evidence that the workflow or supporting tools need review.",
            "Look for observable difficulties that may suggest improvements to skills, memory, workflows, or the framework. Task complexity, conversation length, expected negative tests, and reasonable exploration alone are not friction. Do not infer a root cause or current unresolved failure from the score. Later recovery does not erase friction observed within the summarized range.",
            "When summarizing existing blocks, use their summaries and available frictionScore values as evidence and assess the new range yourself. Do not mechanically average or accumulate scores, and do not dilute an important incident merely because it is surrounded by routine work. Missing scores mean unscored, not zero.",
            "",
            "Memory facts:",
            "- Put durable facts only in the memoryFacts array of their matching replaceAsBlocks entry: explicit user decisions, preferences, project conventions, technical discoveries, environment/deploy constraints, or stable identifiers. Do not include trivial chat, tool mechanics, transient progress, or stale TODOs.",
            "- Each memory fact must be self-contained and understandable outside this conversation. Keep the original conversation language when practical. Use kind decision/preference/fact/convention/environment and attributedTo user/assistant/both when clear.",
            "",
            "You have at most 15 total rounds in this dedicated compaction phase (including invalid-tool and plan-fix retries), so inspect efficiently and finish with submit_compact_plan.",
            "Do not read or write agent memory during compaction. If durable project/user/workflow/rule facts should outlive this session, attach them to the matching replaceAsBlocks entry's memoryFacts and then call submit_compact_plan.",
            "",
        ]);
        if (!string.IsNullOrWhiteSpace(guidance))
        {
            lines.Add("Additional guidance from compaction requester:");
            lines.Add(guidance);
            lines.Add("");
        }
        return string.Join('\n', lines);
    }
}
