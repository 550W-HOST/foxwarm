namespace Foxwarm.Sessions;

/// <summary>
/// One operation the retention policy requires: a new level-1 block from raw messages, or one
/// block that replaces a contiguous run of existing blocks.
/// </summary>
/// <param name="CandidateStart">Index of the first source candidate in the candidate list.</param>
/// <param name="CandidateEnd">Index of the last source candidate in the candidate list.</param>
/// <param name="Budget">Summary budget in estimated tokens.</param>
internal sealed record RetentionOperation(
    string Kind,
    int Level,
    int CandidateStart,
    int CandidateEnd,
    long SourceStart,
    long SourceEnd,
    int Budget
);

/// <summary>
/// Log-compressed CTX-block retention: at most <see cref="SlotsPerLevel"/> blocks per level with
/// levels non-increasing from oldest to newest. Each compaction writes one new level-1 block from
/// raw messages; an overflowing level merges its two oldest blocks into the next level. Legacy
/// layouts are normalized first: a block older than a higher, younger block is absorbed into it.
/// The engine selects every operation; the planner only writes the summaries.
/// </summary>
internal static class CompactRetention
{
    internal const int SlotsPerLevel = 3;
    internal const int NewBlockBudget = 3000;
    internal const int MergedBlockBudget = 1500;
    internal const double BudgetTolerance = 1.25;
    internal const int MaxMergesPerRun = 3;
    internal const int RegionBudget = 24000;

    /// <summary>
    /// Share of its budget at which a summary written in this run is projected for the region
    /// backstop; real summaries average about this much.
    /// </summary>
    internal const double ProjectedShare = 0.6;

    internal static int Limit(int budget) => (int)Math.Floor(budget * BudgetTolerance);

    private sealed class Group(int level, List<int> members, int tokens, bool fresh = false)
    {
        public int Level = level;
        public readonly List<int> Members = members;
        public int Tokens = tokens;
        public readonly bool Fresh = fresh;

        /// <summary>A normalization group left for a later run; nothing may merge with it now.</summary>
        public bool Deferred;
    }

    /// <summary>
    /// Required operations for this compaction, ordered by history position. At most
    /// <see cref="MaxMergesPerRun"/> block operations run; the rest waits for later runs.
    /// </summary>
    public static IReadOnlyList<RetentionOperation> Plan(IReadOnlyList<CompactCandidate> items)
    {
        var blocks = items
            .Select((item, index) => (item, index))
            .Where(entry => entry.item.Kind == "block")
            .ToArray();
        var newest = blocks.Length == 0 ? -1 : blocks[^1].index;
        var raw = items
            .Select((item, index) => (item, index))
            .Where(entry => entry.item.Kind == "message" && entry.index > newest)
            .ToArray();
        var sources = blocks.Select(entry => entry.item).ToArray();
        var pending = Normalize(sources).Count(group => group.Members.Count > 1);
        // Normalization runs first, oldest groups first, as many as fit the operation cap once
        // cascade merges have combined some of them; the others wait for later runs.
        var groups = Simulate(sources, raw.Length > 0, Math.Min(pending, MaxMergesPerRun));
        for (var selected = MaxMergesPerRun + 1; selected <= pending; selected++)
        {
            var wider = Simulate(sources, raw.Length > 0, selected);
            if (wider.Count(group => group.Members.Count > 1 && !group.Deferred) > MaxMergesPerRun)
                break;
            groups = wider;
        }
        var operations = new List<RetentionOperation>();
        foreach (var group in groups.Where(group => group.Members.Count > 1 && !group.Deferred))
        {
            var first = blocks[group.Members[0]];
            var last = blocks[group.Members[^1]];
            operations.Add(
                new RetentionOperation(
                    "block",
                    group.Level,
                    first.index,
                    last.index,
                    first.item.Start,
                    last.item.End,
                    MergedBlockBudget
                )
            );
        }
        if (raw.Length > 0)
            operations.Add(
                new RetentionOperation(
                    "message",
                    1,
                    raw[0].index,
                    raw[^1].index,
                    raw[0].item.Start,
                    raw[^1].item.End,
                    NewBlockBudget
                )
            );
        return operations;
    }

    /// <summary>The groups after this run, with the oldest <paramref name="selected"/> normalization groups applied.</summary>
    private static List<Group> Simulate(
        IReadOnlyList<CompactCandidate> sources,
        bool fresh,
        int selected
    )
    {
        var groups = Normalize(sources);
        var normalizing = groups.Where(group => group.Members.Count > 1).ToArray();
        foreach (var group in normalizing.Skip(selected))
            group.Deferred = true;
        if (fresh)
            groups.Add(new Group(1, [], (int)(NewBlockBudget * ProjectedShare), fresh: true));
        // Every merge keeps the layout's level order, so applying them in the order they occur
        // and stopping at the first one that cannot run now keeps the order too. The backstop
        // waits until the layout is normalized and the cascade is complete.
        if (Cascade(groups, sources) && normalizing.Length == 0)
            Backstop(groups, sources);
        return groups;
    }

    /// <summary>
    /// Restores non-increasing levels. Scanning from newest to oldest, a block whose level is
    /// below that of the next younger group joins that group, which keeps its level.
    /// </summary>
    private static List<Group> Normalize(IReadOnlyList<CompactCandidate> blocks)
    {
        var newestFirst = new List<Group>();
        for (var index = blocks.Count - 1; index >= 0; index--)
        {
            var block = blocks[index];
            var younger = newestFirst.Count > 0 ? newestFirst[^1] : null;
            if (younger is not null && block.SourceLevel < younger.Level)
            {
                younger.Members.Insert(0, index);
                younger.Tokens = Projected(younger.Members, blocks);
            }
            else
                newestFirst.Add(new Group(block.SourceLevel, [index], block.Tokens));
        }
        newestFirst.Reverse();
        return newestFirst;
    }

    /// <summary>
    /// While a level holds more than k groups, its two oldest merge one level up. Returns false
    /// when it stopped early at a merge that cannot run in this compaction.
    /// </summary>
    private static bool Cascade(List<Group> groups, IReadOnlyList<CompactCandidate> blocks)
    {
        for (var level = 1; groups.Any(group => group.Level >= level); level++)
            while (true)
            {
                var at = Enumerable
                    .Range(0, groups.Count)
                    .Where(index => groups[index].Level == level)
                    .ToArray();
                if (at.Length <= SlotsPerLevel)
                    break;
                if (!TryMerge(groups, at[0], at[1], level + 1, blocks))
                    return false;
            }
        return true;
    }

    /// <summary>
    /// Bounds the summary tokens of the region: the oldest group absorbs its younger neighbour at
    /// the oldest group's level. The new level-1 block is never absorbed.
    /// </summary>
    private static void Backstop(List<Group> groups, IReadOnlyList<CompactCandidate> blocks)
    {
        while (
            groups.Sum(group => group.Tokens) > RegionBudget
            && groups.Count > 1
            && !groups[1].Fresh
            && TryMerge(groups, 0, 1, groups[0].Level, blocks)
        ) { }
    }

    /// <summary>
    /// Merges two groups unless one of them waits for a later run or the merge would exceed the
    /// operation cap.
    /// </summary>
    private static bool TryMerge(
        List<Group> groups,
        int older,
        int younger,
        int level,
        IReadOnlyList<CompactCandidate> blocks
    )
    {
        var range = groups.GetRange(older, younger - older + 1);
        if (range.Any(group => group.Deferred || group.Fresh))
            return false;
        var operations =
            groups.Count(group => group.Members.Count > 1 && !group.Deferred)
            - range.Count(group => group.Members.Count > 1)
            + 1;
        if (operations > MaxMergesPerRun)
            return false;
        var target = groups[older];
        // Groups at one level are adjacent once levels are monotone; merging keeps them contiguous.
        foreach (var group in range.Skip(1))
            target.Members.AddRange(group.Members);
        target.Members.Sort();
        target.Tokens = Projected(target.Members, blocks);
        target.Level = level;
        groups.RemoveRange(older + 1, younger - older);
        return true;
    }

    /// <summary>A new merged summary: its projected size, never more than its sources.</summary>
    private static int Projected(List<int> members, IReadOnlyList<CompactCandidate> blocks) =>
        Math.Min(
            (int)(MergedBlockBudget * ProjectedShare),
            members.Sum(index => blocks[index].Tokens)
        );
}
