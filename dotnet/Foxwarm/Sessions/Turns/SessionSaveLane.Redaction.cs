using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    // R2 for Session history: the one point where history content is masked. Every lane
    // commit that stages new or replaced history rows (canonical appends, the retry notice,
    // compaction and pruning) passes its staged snapshot through here before persistence.
    // Rows that were not in the pre-operation history are masked once; the masked rows are
    // persisted, published to hot state and announced. Prepared JSON rows are updated in
    // place so Archive records and callers holding them see the same masked content.
    private (SessionSnapshot Staged, Action<SessionState> Publish) RedactStagedHistory(
        SessionHistory before,
        SessionSnapshot staged,
        IReadOnlyList<JsonObject> prepared,
        Action<SessionState> publish
    )
    {
        var state = entry.State;
        if (state.HistoryRedaction is null)
            return (staged, publish);
        var unchanged = 0;
        while (
            unchanged < before.Count
            && unchanged < staged.History.Count
            && ReferenceEquals(before[unchanged], staged.History[unchanged])
        )
            unchanged++;
        var earlier = new HashSet<HistoryMessage>(
            before.Skip(unchanged),
            ReferenceEqualityComparer.Instance
        );
        Dictionary<HistoryMessage, HistoryMessage>? replaced = null;
        var history = staged.History;
        for (var index = unchanged; index < staged.History.Count; index++)
        {
            var row = staged.History[index];
            if (earlier.Contains(row))
                continue;
            var json = row.ToJson();
            var masked = state.RedactForHistory(json, "history");
            if (ReferenceEquals(masked, json))
                continue;
            var frozen = HistoryMessage.FromJson(masked);
            (replaced ??= new(ReferenceEqualityComparer.Instance))[row] = frozen;
            history = history.Replace(index, frozen);
            if (row.Sequence is { } sequence)
                foreach (var message in prepared)
                    if (SessionWait.Number(message["__meta"]?["seq"]) == sequence)
                        Replace(message, masked);
        }
        if (replaced is null)
            return (staged, publish);
        return (
            staged with
            {
                History = history,
            },
            live =>
            {
                publish(live);
                for (var index = 0; index < live.History.Count; index++)
                    if (replaced.TryGetValue(live.History[index], out var masked))
                        live.History.Replace(index, masked);
            }
        );
    }

    private static void Replace(JsonObject target, JsonObject source)
    {
        target.Clear();
        foreach (var (key, value) in source)
            target[key] = value?.DeepClone();
    }
}
