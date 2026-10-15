using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private sealed class PruningEstimateExceededException : Exception;

    private static readonly HashSet<string> RetainedResponseMetadata =
    [
        "status",
        "node",
        "nodeId",
        "path",
        "filePath",
        "absolutePath",
        "outputFullPath",
        "logPath",
        "statusPath",
        "runId",
        "execId",
        "sha256",
        "hash",
        "location",
        "sizeBytes",
        "byteLength",
        "outputOriginalLengthChars",
        "outputOriginalLineCount",
        "exitCode",
        "code",
        "overwritten",
    ];

    private static string Edge(IEnumerable<Rune> input, int limit, bool head)
    {
        var runes = input.ToArray();
        if (runes.Length <= limit)
            return string.Concat(runes.Select(rune => rune.ToString()));
        if (head)
        {
            for (var index = limit - 1; index >= limit - 100; index--)
                if (runes[index].Value == '\n')
                    return string.Concat(runes.Take(index + 1).Select(rune => rune.ToString()));
            return string.Concat(runes.Take(limit).Select(rune => rune.ToString()));
        }
        var start = runes.Length - limit;
        for (var index = start; index <= Math.Min(runes.Length - 1, start + 100); index++)
            if (runes[index].Value == '\n')
                return string.Concat(runes.Skip(index + 1).Select(rune => rune.ToString()));
        return string.Concat(runes.Skip(start).Select(rune => rune.ToString()));
    }

    private static HashSet<string> SkillLoadIds(IReadOnlyList<JsonObject> history)
    {
        var calls = history
            .SelectMany(row => (row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
            .Select(part => part["functionCall"])
            .OfType<JsonObject>()
            .Where(call => !string.IsNullOrEmpty(SessionWait.Text(call["id"])));
        return calls
            .GroupBy(call => SessionWait.Text(call["id"])!)
            .Where(group => group.Count() == 1 && IsSkillLoad(group.Single()))
            .Select(group => group.Key)
            .ToHashSet(StringComparer.Ordinal);
    }

    private static bool IsSkillLoad(JsonObject call)
    {
        if (call["argsParseError"] is not null || call["args"] is not JsonObject args)
            return false;
        var name = SessionWait.Text(call["name"]);
        if (name == "load_skill")
            return !string.IsNullOrWhiteSpace(SessionWait.Text(args["skillName"]));
        if (name == "call_tool")
        {
            var id = SessionWait.Text(args["toolId"]);
            if (
                !string.IsNullOrEmpty(id)
                    ? !(
                        id.StartsWith("builtin:", StringComparison.Ordinal)
                        && id[8..].Trim() == "skill"
                    )
                    : SessionWait.Text(args["source"])?.Trim() != "builtin"
                        || SessionWait.Text(args["name"]) != "skill"
            )
                return false;
            try
            {
                args = Foxwarm.Tools.ToolRegistry.ObjectArg(
                    args,
                    "args",
                    "argsJson",
                    required: true
                )!;
            }
            catch (Exception error)
                when (error is InvalidDataException or System.Text.Json.JsonException)
            {
                return false;
            }
            name = "skill";
        }
        return name == "skill"
            && SessionWait.Text(args["action"]) == "load"
            && !string.IsNullOrWhiteSpace(SessionWait.Text(args["skillName"]));
    }

    private static JsonObject? PrunePart(JsonObject part, long seq)
    {
        var function = part["functionResponse"] as JsonObject;
        var response = function?["response"] as JsonObject;
        if (
            response?["output"] is not JsonValue output
            || !output.TryGetValue<string>(out var text)
        )
            return null;
        var characters = text.EnumerateRunes().ToArray();
        if (characters.Length <= 1000)
            return null;
        var head = Edge(characters, 500, true);
        var tail = Edge(characters, 500, false);
        var tool = function?["name"]?.GetValue<string>() ?? "unknown";
        var id = function?["tool_use_id"]?.GetValue<string>() ?? "unknown";
        var marker =
            $"--- [foxwarm: historical tool response pruned; original: recall({{ target: \"msg#{seq}\" }}); tool={System.Text.Json.JsonSerializer.Serialize(tool)}; tool_use_id={System.Text.Json.JsonSerializer.Serialize(id)}; kept first {head.EnumerateRunes().Count()} and last {tail.EnumerateRunes().Count()} Unicode characters] ---";
        var bounded = head + "\n\n" + marker + "\n\n" + tail;
        if (bounded.EnumerateRunes().Count() >= characters.Length)
            return null;
        var clone = (JsonObject)part.DeepClone();
        var fn = (JsonObject)clone["functionResponse"]!;
        var pruned = new JsonObject { ["output"] = bounded };
        foreach (var (key, value) in response)
        {
            if (key == "output")
                continue;
            if (
                key is "content" or "error" && value?.ToJsonString().EnumerateRunes().Count() <= 512
                || RetainedResponseMetadata.Contains(key)
                    && value?.ToJsonString().EnumerateRunes().Count() <= 512
            )
                pruned[key] = value?.DeepClone();
        }
        fn["response"] = pruned;
        return clone;
    }

    private static JsonObject NormalizeArchiveComparison(JsonObject row)
    {
        var clone = (JsonObject)row.DeepClone();
        if (clone["__meta"] is JsonObject meta)
        {
            meta.Remove("preservedFromBlockId");
            meta.Remove("goalAnchorSeq");
            meta.Remove("contextFrontierItem");
        }
        return clone;
    }

    private static int EstimateHistory(IReadOnlyList<JsonObject> rows, string snapshot)
    {
        var tokens = CompactCandidateBuilder.Tokens(snapshot);
        foreach (var row in rows.Where(CompactCandidateBuilder.Visible))
        foreach (var part in (row["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (part["text"]?.GetValue<string>() is string text)
                tokens += CompactCandidateBuilder.Tokens(text);
            if (part["thinking"]?.GetValue<string>() is string thinking)
                tokens += CompactCandidateBuilder.Tokens(thinking);
            if (part["functionCall"] is JsonObject call)
            {
                tokens += CompactCandidateBuilder.Tokens(call["name"]?.GetValue<string>() ?? "");
                tokens += CompactCandidateBuilder.Tokens(
                    call["rawArgsText"]?.GetValue<string>() ?? call["args"]?.ToJsonString() ?? "{}"
                );
            }
            if (part["functionResponse"] is JsonObject response)
            {
                tokens += CompactCandidateBuilder.Tokens(
                    response["name"]?.GetValue<string>() ?? ""
                );
                tokens += CompactCandidateBuilder.Tokens(
                    response["response"]?.ToJsonString() ?? "{}"
                );
            }
        }
        return tokens;
    }

    private async Task<bool> TryPruneToolsAsync(
        SessionSnapshot snapshot,
        CancellationToken token,
        double keep,
        HostModels catalog
    )
    {
        var originalRows = snapshot.History.Materialize();
        var cutoff = CompactCandidateBuilder.Split(originalRows, keep);
        if (cutoff <= 0)
            return false;
        var bySeq = store
            .Archive.ReadEffectiveMessagesRange(1, 9007199254740991)
            .GroupBy(row => row.Seq)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var counts = originalRows
            .Select(row =>
                CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"])
            )
            .Where(seq => seq is > 0)
            .GroupBy(seq => seq!.Value)
            .ToDictionary(group => group.Key, group => group.Count());
        var skillLoads = SkillLoadIds(originalRows);
        var rewritten = originalRows.Select(row => (JsonObject)row.DeepClone()).ToArray();
        var affected = new HashSet<long>();
        for (var index = 0; index < cutoff; index++)
        {
            var row = originalRows[index];
            var seq = CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]);
            if (
                seq is not > 0
                || counts.GetValueOrDefault(seq.Value) != 1
                || !bySeq.TryGetValue(seq.Value, out var archives)
                || archives.Length != 1
                || !JsonNode.DeepEquals(
                    NormalizeArchiveComparison(row),
                    NormalizeArchiveComparison(archives[0].Message)
                )
            )
                continue;
            if (row["parts"] is not JsonArray parts)
                continue;
            var nextParts = new JsonArray();
            var changed = false;
            foreach (var part in parts.OfType<JsonObject>())
            {
                var id = SessionWait.Text(part["functionResponse"]?["tool_use_id"]);
                var pruned =
                    id is not null && skillLoads.Contains(id) ? null : PrunePart(part, seq.Value);
                nextParts.Add(pruned ?? part.DeepClone());
                changed |= pruned is not null;
            }
            if (!changed)
                continue;
            rewritten[index]["parts"] = nextParts;
            affected.Add(seq.Value);
        }
        if (affected.Count == 0)
            return false;
        var persistentSnapshot =
            snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        var after = EstimateHistory(rewritten, persistentSnapshot);
        var maximum = Math.Max(
            0,
            (int)Math.Ceiling(EstimateHistory(originalRows, persistentSnapshot) * .6) - 1
        );
        if (after > maximum)
            return false;
        foreach (var seq in affected)
        {
            var latest = store
                .Archive.ReadEffectiveMessagesRange(1, 9007199254740991)
                .Where(row => row.Seq == seq)
                .ToArray();
            var originals = originalRows
                .Where(row =>
                    CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]) == seq
                )
                .ToArray();
            if (
                latest.Length != 1
                || originals.Length != 1
                || !JsonNode.DeepEquals(
                    NormalizeArchiveComparison(latest[0].Message),
                    NormalizeArchiveComparison(originals[0])
                )
            )
                return false;
        }
        token.ThrowIfCancellationRequested();
        sessions?.Tasks.TaskContext(snapshot.Id, TaskProgress.Sequences(snapshot), false, []);
        try
        {
            await hosted.Entry.SaveLane.CommitCompactionAsync(
                live =>
                {
                    if (
                        live.HistoryVersion != snapshot.HistoryVersion
                        || live.History.Count < snapshot.History.Count
                        || snapshot
                            .History.Where(
                                (message, index) =>
                                    !message.ContentEquals(live.History[index])
                            )
                            .Any()
                    )
                        throw new InvalidOperationException(
                            "Tool-response pruning snapshot changed incompatibly."
                        );
                    var nextHistory = snapshot.History;
                    for (var index = 0; index < rewritten.Length; index++)
                        if (snapshot.History[index].Sequence is long seq && affected.Contains(seq))
                            nextHistory = nextHistory.Replace(index, HistoryMessage.FromJson(rewritten[index]));
                    nextHistory = nextHistory.Append(live.History.Skip(snapshot.History.Count));
                    if (
                        EstimateHistory(
                            nextHistory.Materialize(),
                            SessionWait.Text(live.AuthorityEnvelope["persistentMemorySnapshot"])
                                ?? ""
                        ) > maximum
                    )
                        throw new PruningEstimateExceededException();
                    var staged = live.Snapshot() with
                    {
                        History = nextHistory,
                        HistoryVersion = live.HistoryVersion + 1,
                    };
                    var version = live.HistoryVersion;
                    var nextSeq = live.NextMessageSeq;
                    void Publish(SessionState state)
                    {
                        state.PublishCommittedHistoryRewrite(
                            nextHistory,
                            version,
                            nextSeq,
                            nextSeq
                        );
                    }
                    return new CompactionPreparation(staged, [], [], Publish);
                },
                token
            );
        }
        catch (PruningEstimateExceededException)
        {
            return false;
        }
        hosted.PublishStateChanged();
        return true;
    }
}
