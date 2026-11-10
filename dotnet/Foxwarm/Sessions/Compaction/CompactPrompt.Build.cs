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
            "COMPACTION STARTED: stop any previous task and focus only on CTX-BLOCK compaction.",
            "Goal: Replace older context with compact, source-bound summaries that preserve what the main model needs to continue and identify when to recall details.",
            $"Recent messages {(recent.Length > 0 ? $"({recent.Length} rendered item(s), {Range(recentSeqs.FirstOrDefault(), recentSeqs.LastOrDefault())})" : "(none)")} are already force-kept verbatim by the system. No need to summarize/replace them.",
        };
        if (policy.RequiredRawTokens > 0)
            lines.AddRange([
                "Hard compaction limits for this run:",
                $"- Raw messages: ~{policy.EligibleRawTokens} eligible estimated tokens; message-source replaceAsBlocks entries must actually replace at least ~{policy.RequiredRawTokens} estimated tokens. Raw messages listed in preserveMessages stay verbatim and do not count toward this minimum.",
            ]);
        lines.Add("");
        if (policy.Retention.Count == 0)
            lines.Add("No new summary blocks are required in this run.");
        else
            lines.Add(
                "Required operations. Submit exactly one replaceAsBlocks entry for each, with the sourceKind, sourceStart, sourceEnd and level shown; you write its summary, memoryFacts and frictionScore:"
            );
        for (var n = 0; n < policy.Retention.Count; n++)
        {
            var op = policy.Retention[n];
            var sources = policy
                .Items.Skip(op.CandidateStart)
                .Take(op.CandidateEnd - op.CandidateStart + 1)
                .Where(item => item.Kind == op.Kind)
                .ToArray();
            var head =
                $"{n + 1}. sourceKind={op.Kind}, sourceStart={op.SourceStart}, sourceEnd={op.SourceEnd}, level={op.Level}";
            if (op.Kind == "message")
            {
                lines.Add(
                    $"{head}: new level-1 block from raw messages M#{op.SourceStart}..M#{op.SourceEnd} (~{sources.Sum(item => item.Tokens)} estimated tokens). Budget: {op.Budget} tokens."
                );
                for (var i = 0; i < sources.Length; i++)
                {
                    var limit = i < 2 || i >= sources.Length - 2 ? 300 : 80;
                    var preview = TrimPreview(sources[i].Preview, limit);
                    lines.Add(
                        $"- {sources[i].Key} {(preview.Length > 0 ? preview : "[empty message]")}"
                    );
                }
            }
            else
                lines.Add(
                    $"{head}: merge {string.Join(", ", sources.Select(item => $"{item.Key} (L{item.SourceLevel}, raw{Range(item.RawStart, item.RawEnd)}{(item.FrictionScore is int score ? $", frictionScore={score}" : "")})"))} into one level-{op.Level} block. Budget: {op.Budget} tokens."
                );
        }
        lines.Add("");
        if (policy.Preserved.Count > 0)
        {
            lines.Add("Previously preserved raw messages already covered by summary blocks:");
            lines.Add(
                "These are still verbatim in working history for exact wording. If the summary block is now sufficient, remove them with removePreservedMessages: number[]. Do not summarize them again just to remove them."
            );
            foreach (var item in policy.Preserved)
            {
                // Preserved rows of a merged block leave active history with that merge.
                var merge = policy
                    .Retention.ToList()
                    .FindIndex(op =>
                        op.Kind == "block"
                        && policy
                            .Items.Skip(op.CandidateStart)
                            .Take(op.CandidateEnd - op.CandidateStart + 1)
                            .Any(source => source.Kind == "block" && source.Start == item.BlockId)
                    );
                lines.Add(
                    $"- M#{item.Seq} preserved from B#{item.BlockId}{(merge < 0 ? "" : $" (removed by operation {merge + 1})")}: {TrimPreview(item.Preview, 300)}"
                );
            }
        }
        lines.AddRange([
            "Write the summaries for the operations above and finish by calling submit_compact_plan. Do not answer with plain text only.",
            "Rules:",
            "- Pass summary-block creations via replaceAsBlocks. Prefer a direct array of objects; a JSON string encoding that same array is also accepted as a fallback. Use replaceAsBlocks: [] or replaceAsBlocks: \"[]\" if you only need to remove previously preserved raw messages.",
            "- Each replaceAsBlocks entry may include memoryFacts: an array of durable facts tied to exactly that source range. Invalid/omitted facts are ignored and never affect block creation; do not repeat them manually in summary prose.",
            "- Each required operation appears exactly once. Do not add, split, combine or omit operations; the system chose them so the timeline keeps more detail for recent work and less for older work.",
            "- The sources of each operation are replaced by its summary. Other items stay verbatim unless listed in removePreservedMessages or marked as removed by an operation.",
            "- Use preserveMessages for a small number of raw message seqs that must remain verbatim even though they are covered by the new level-1 block. The system will extract them after the covering block in working history. Selecting any member of a tool exchange in preserveMessages keeps the model call message and all its paired response messages together.",
            "- Use removePreservedMessages only for messages listed in the \"Previously preserved raw messages\" section. This removes the raw message from active history only; it does not delete archive records or existing summary blocks. When removing a preserved tool exchange, list every member; partial removal is rejected.",
            "",
            "Summary writing guidance:",
            "Write each summary as a continuation brief, not a narrative. Keep the goal and current state, decisions and their reasons, constraints and user preferences, open items and commitments, and the identifiers needed to find details later: Task IDs, files, commits, Session IDs and msg# ranges.",
            "When a fact is already recorded in Agent memory, a Task, the Code Index, a document or a commit, write one line saying where it is instead of restating it.",
            "A new level-1 block is the most detailed: keep the working state of this stretch, including procedures still in progress, error signatures and exact values the next turns may need.",
            "When merging blocks, consolidate rather than concatenate. Drop finished procedures and step-by-step debugging first, then superseded decisions; keep outcomes, usually one line per finished thread. Carry forward every item that was still open at the end of the sources, with its Task ID or other locator, unless a later source shows it finished. Keep user decisions together with their msg# reference.",
            "Blocks at level 5 and above keep the gist: themes, standing decisions with their msg# references, lasting constraints, a short list of items still open with their Task IDs, and where to recall details.",
            "Each operation has a token budget, shown with it. Stay well under it when the content allows; a summary over budget is returned for revision.",
            "Memory facts record only what the sources' facts don't already contain, and they count toward the operation's budget.",
            "Facts of merged blocks leave active context with the merge and are not copied into Agent memory, so keep the decisions that still matter in the summary with their msg# reference, and point only to places that actually hold them: Agent memory, Tasks, the Code Index, documents or commits.",
            "Preserved messages inside merged blocks are removed from history by this merge; cover what still matters from them in the summary.",
            "- Reduce information volume by selecting and consolidating content, not by removing spaces, shortening ordinary words or packing fragments together. Use normal spelling, spacing, punctuation and readable sentences.",
            "- Stay within the assigned source range. Do not import later outcomes or turn an earlier proposal into a confirmed decision.",
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
            lines.Add(
                "Additional guidance from the compaction requester. It applies to the summaries; the operations above are fixed:"
            );
            lines.Add(guidance);
            lines.Add("");
        }
        return string.Join('\n', lines);
    }
}
