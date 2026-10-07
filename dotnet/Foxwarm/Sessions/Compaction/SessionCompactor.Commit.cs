using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed class CompactionSnapshotIncompatibleException(string message)
    : InvalidOperationException(message);

internal sealed partial class SessionCompactor
{
    private CompactionPreparation PrepareCompact(
        SessionState live,
        SessionSnapshot original,
        CompactCandidates candidates,
        CompactPlan plan,
        long archiveMaximum
    )
    {
        if (
            live.HistoryVersion != original.HistoryVersion
            || live.History.Count < original.History.Count
            || original
                .History.Where(
                    (message, index) => !JsonNode.DeepEquals(message, live.History[index])
                )
                .Any()
        )
            throw new CompactionSnapshotIncompatibleException(
                "Compaction snapshot changed incompatibly before authority commit."
            );
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var nextBlockId =
            plan.Operations.Count > 0
                ? SessionBlockCounter.Resolve(live.History, live.AuthorityEnvelope, archiveMaximum)
                : CompactCandidateBuilder.Number(live.AuthorityEnvelope["nextBlockId"]) ?? 1;
        var operations = new List<(CompactOperation Operation, ArchiveBlockRecord Record)>();
        foreach (var op in plan.Operations)
        {
            var sourceIds =
                op.Kind == "block"
                    ? new JsonArray(
                        candidates
                            .Items.Skip(op.CandidateStart)
                            .Take(op.CandidateEnd - op.CandidateStart + 1)
                            .Select(item => (JsonNode?)JsonValue.Create(item.Start))
                            .ToArray()
                    )
                    : null;
            var summary = FormatSummary(op.Summary, op.MemoryFacts);
            var record = new ArchiveBlockRecord(
                live.Id,
                hosted.Agent,
                nextBlockId++,
                op.Level,
                op.Kind,
                op.First.Start,
                op.Last.End,
                sourceIds,
                op.RawStart,
                op.RawEnd,
                op.First.StartTimestamp,
                op.Last.EndTimestamp,
                summary,
                op.MemoryFacts is null ? null : (JsonArray)op.MemoryFacts.DeepClone(),
                now
            );
            operations.Add((op, record));
        }
        var history = new List<JsonObject>();
        var cursor = 0;
        foreach (var (op, record) in operations)
        {
            AppendRetained(
                original.History.Skip(cursor).Take(op.HistoryStart - cursor),
                plan.Remove,
                history
            );
            history.Add(record.ToMessage());
            foreach (
                var row in original
                    .History.Skip(op.HistoryStart)
                    .Take(op.HistoryEnd - op.HistoryStart + 1)
            )
                if (
                    CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"])
                        is long seq
                    && plan.Preserve.Contains(seq)
                )
                {
                    var preserved = (JsonObject)row.DeepClone();
                    ((JsonObject)preserved["__meta"]!)["preservedFromBlockId"] = record.Id;
                    history.Add(preserved);
                }
            cursor = op.HistoryEnd + 1;
        }
        AppendRetained(
            original.History.Skip(cursor).Take(candidates.Split - cursor),
            plan.Remove,
            history
        );
        AppendRetained(live.History.Skip(candidates.Split), new HashSet<long>(), history);
        var completion = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject { ["system"] = CompletionMarker(live.Id, now) }
            ),
            ["__meta"] = new JsonObject { ["seq"] = live.NextMessageSeq, ["timestamp"] = now },
        };
        if (plan.Planner is not null)
            completion["compaction"] = new JsonObject { ["planner"] = plan.Planner.ToJson() };
        history.Add(completion);
        var envelope = (JsonObject)live.AuthorityEnvelope.DeepClone();
        envelope["nextBlockId"] = nextBlockId;
        var meta = (JsonObject)live.Meta.DeepClone();
        meta["messageCount"] = history.Count;
        var staged = live.Snapshot() with
        {
            History = history,
            Meta = meta,
            NextMessageSeq = live.NextMessageSeq + 1,
            HistoryVersion = live.HistoryVersion + 1,
            AuthorityEnvelope = envelope,
        };
        var previousNext = live.NextMessageSeq;
        var previousVersion = live.HistoryVersion;
        void Publish(SessionState state)
        {
            state.PublishCommittedHistoryRewrite(
                history,
                previousVersion,
                previousNext,
                previousNext + 1,
                nextBlockId
            );
        }
        return new CompactionPreparation(
            staged,
            operations.Select(item => item.Record).ToArray(),
            [completion],
            Publish
        );
    }

    private static void AppendRetained(
        IEnumerable<JsonObject> source,
        IReadOnlySet<long> removed,
        List<JsonObject> output
    )
    {
        foreach (var row in source)
        {
            if (!CompactCandidateBuilder.Visible(row) || CompactCandidateBuilder.Completion(row))
                continue;
            var seq = CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]);
            if (
                seq is not null
                && removed.Contains(seq.Value)
                && CompactCandidateBuilder.Number(
                    CompactCandidateBuilder.Meta(row)?["preservedFromBlockId"]
                )
                    is > 0
            )
                continue;
            output.Add((JsonObject)row.DeepClone());
        }
    }

    private static string FormatSummary(string summary, JsonArray? facts)
    {
        if (facts is not { Count: > 0 })
            return summary;
        var lines = facts
            .OfType<JsonObject>()
            .Select(fact =>
            {
                var extras = new List<string>();
                if (
                    fact["context"]?.GetValue<string>() is string context
                    && context.Trim().Length > 0
                )
                    extras.Add("context: " + context.Trim());
                if (fact["attributedTo"]?.GetValue<string>() is string attributed)
                    extras.Add("attributed to: " + attributed);
                return $"- **{fact["kind"]?.GetValue<string>()}:** {fact["text"]?.GetValue<string>()?.Trim()}{(extras.Count == 0 ? "" : $" _({string.Join("; ", extras)})_")}";
            });
        return summary.Trim() + "\n\n### Memory facts\n" + string.Join('\n', lines);
    }

    private static string CompletionMarker(string id, long now) =>
        $"<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" parentSessionId=\"(none)\" currentSessionId=\"{id}\" time=\"{ArchiveBlockRecord.LocalTimestamp(now)}\" />";
}
