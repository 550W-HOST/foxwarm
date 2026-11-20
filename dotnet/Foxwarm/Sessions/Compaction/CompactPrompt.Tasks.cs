using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static partial class CompactPrompt
{
    internal const string TaskStatusHeader = "Current status of Tasks mentioned in the sources:";
    internal const int TaskStatusLimit = 100;

    private static readonly Regex TaskIdPattern = new(
        "(?<![A-Za-z0-9_])task_[0-9a-f]{12}(?![A-Za-z0-9_])",
        RegexOptions.CultureInvariant | RegexOptions.ECMAScript
    );

    /// <summary>
    /// Lines for the planner prompt that give the current status, and nothing else, of the Tasks
    /// named in the sources of the required operations: the summaries of source blocks (their
    /// memory facts included) and the raw messages of the new level-1 operation. IDs keep the
    /// order of first occurrence; IDs the store does not know are omitted. Empty when no mentioned
    /// Task is known.
    /// </summary>
    private static IReadOnlyList<string> TaskStatusLines(
        CompactCandidates policy,
        Func<IReadOnlyList<string>, IReadOnlyDictionary<string, string>>? lookup
    )
    {
        if (lookup is null)
            return [];
        var ids = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        void Collect(string text)
        {
            foreach (var match in TaskIdPattern.Matches(text).Select(match => match.Value))
                if (seen.Add(match))
                    ids.Add(match);
        }

        foreach (var op in policy.Retention)
        {
            var sources = policy
                .Items.Skip(op.CandidateStart)
                .Take(op.CandidateEnd - op.CandidateStart + 1)
                .Where(item => item.Kind == op.Kind);
            foreach (var source in sources)
            {
                if (source.Kind == "block")
                {
                    // The stored summary already holds the block's memory facts.
                    Collect(source.Preview);
                    continue;
                }
                // The candidate preview is shortened per row; the sources are the full messages.
                for (var index = source.HistoryStart; index <= source.HistoryEnd; index++)
                {
                    var row = policy.History[index];
                    if (CompactCandidateBuilder.Visible(row))
                        Collect(CompactCandidateBuilder.Preview(row, true));
                }
            }
        }
        if (ids.Count == 0)
            return [];
        var statuses = lookup(ids);
        var lines = ids.Where(statuses.ContainsKey)
            .Take(TaskStatusLimit)
            .Select(id => $"- {id}: {statuses[id]}")
            .ToArray();
        return lines.Length == 0 ? [] : [TaskStatusHeader, .. lines];
    }
}
