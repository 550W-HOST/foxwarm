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
                .History.Where((message, index) => !message.ContentEquals(live.History[index]))
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
                now,
                op.FrictionScore
            );
            operations.Add((op, record));
        }
        var history = new List<HistoryMessage>();
        var cursor = 0;
        foreach (var (op, record) in operations)
        {
            AppendRetained(
                original.History.Skip(cursor).Take(op.HistoryStart - cursor),
                plan.Remove,
                history
            );
            history.Add(HistoryMessage.FromJson(record.ToMessage()));
            foreach (
                var row in original
                    .History.Skip(op.HistoryStart)
                    .Take(op.HistoryEnd - op.HistoryStart + 1)
            )
                if (row.Sequence is long seq && plan.Preserve.Contains(seq))
                {
                    var preserved = row.ToJson();
                    ((JsonObject)preserved["__meta"]!)["preservedFromBlockId"] = record.Id;
                    history.Add(HistoryMessage.FromJson(preserved));
                }
            cursor = op.HistoryEnd + 1;
        }
        AppendRetained(
            original.History.Skip(cursor).Take(candidates.Split - cursor),
            plan.Remove,
            history
        );
        history.AddRange(live.History.Skip(candidates.Split));
        history.RemoveAll(record => CompactCandidateBuilder.Completion(record.ToJson()));
        var completion = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["system"] = CompletionMarker(
                        live.Id,
                        SessionWait.Text(live.AuthorityEnvelope["parentSessionId"]),
                        CompactedSkillNames(original.History.Take(candidates.Split)),
                        now
                    ),
                }
            ),
            ["__meta"] = new JsonObject { ["seq"] = live.NextMessageSeq, ["timestamp"] = now },
        };
        if (plan.Planner is not null)
            completion["compaction"] = new JsonObject { ["planner"] = plan.Planner.ToJson() };
        history.Add(HistoryMessage.FromJson(completion));
        var frozenHistory = SessionHistory.FromMessages(history);
        var envelope = (JsonObject)live.AuthorityEnvelope.DeepClone();
        envelope["nextBlockId"] = nextBlockId;
        var meta = (JsonObject)live.Meta.DeepClone();
        meta["messageCount"] = history.Count;
        var staged = live.Snapshot() with
        {
            History = frozenHistory,
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
                frozenHistory,
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
        IEnumerable<HistoryMessage> source,
        IReadOnlySet<long> removed,
        List<HistoryMessage> output
    )
    {
        foreach (var record in source)
        {
            var row = record.ToJson();
            if (!CompactCandidateBuilder.Visible(row) || CompactCandidateBuilder.Completion(row))
                continue;
            var seq = record.Sequence;
            if (
                seq is not null
                && removed.Contains(seq.Value)
                && CompactCandidateBuilder.Number(
                    CompactCandidateBuilder.Meta(row)?["preservedFromBlockId"]
                )
                    is > 0
            )
                continue;
            output.Add(record);
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

    private static IReadOnlyList<string> CompactedSkillNames(IEnumerable<HistoryMessage> consumed)
    {
        var names = new List<string>();
        foreach (var record in consumed)
        foreach (var part in (record.ToJson()["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (part["functionCall"] is not JsonObject call)
                continue;
            var name = SessionWait.Text(call["name"]);
            if (
                name != "load_skill"
                && !(
                    name == "skill"
                    && SessionWait.Text((call["args"] as JsonObject)?["action"]) == "load"
                )
            )
                continue;
            var skill = SessionWait.Text((call["args"] as JsonObject)?["skillName"]);
            if (
                skill is not null
                && OpenAIRequestText.Trim(skill) is { Length: > 0 } trimmed
                && !names.Contains(trimmed)
            )
                names.Add(trimmed);
        }
        return names;
    }

    private static string CompletionMarker(
        string id,
        string? parent,
        IReadOnlyList<string> skills,
        long now
    )
    {
        static string Attribute(string value) => LocalSessionTurnHost.EscapeFoxwarmAttribute(value);
        var hint =
            skills.Count == 0
                ? ""
                : " hint=\""
                    + Attribute(
                        "Note: The following skill(s) were loaded with skill(action=\"load\") but their content was compacted away: "
                            + string.Join(", ", skills.Select(skill => "`" + skill + "`"))
                            + ". If you still need them, call skill with action=\"load\" again."
                    )
                    + "\"";
        return $"<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" parentSessionId=\"{Attribute(string.IsNullOrEmpty(parent) ? "(none)" : parent)}\" currentSessionId=\"{Attribute(id)}\" time=\"{ArchiveBlockRecord.LocalTimestamp(now)}\"{hint} />";
    }
}
