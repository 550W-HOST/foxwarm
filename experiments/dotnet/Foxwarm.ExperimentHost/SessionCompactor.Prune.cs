using System.Text.Json.Nodes;
using System.Text;
using Foxwarm.SessionPersistence;
using Foxwarm.SessionTurns;

namespace Foxwarm.ExperimentHost;

internal sealed partial class SessionCompactor
{
    private static readonly HashSet<string> RetainedResponseMetadata =
    ["status", "node", "nodeId", "path", "filePath", "absolutePath", "outputFullPath",
     "logPath", "statusPath", "runId", "execId", "sha256", "hash", "location",
     "sizeBytes", "byteLength", "outputOriginalLengthChars", "outputOriginalLineCount",
     "exitCode", "code", "overwritten"];

    private static string Edge(IEnumerable<Rune> input, int limit, bool head)
    {
        var runes = input.ToArray();
        if (runes.Length <= limit) return string.Concat(runes.Select(rune => rune.ToString()));
        if (head)
        {
            for (var index = limit - 1; index >= limit - 100; index--)
                if (runes[index].Value == '\n') return string.Concat(runes.Take(index + 1).Select(rune => rune.ToString()));
            return string.Concat(runes.Take(limit).Select(rune => rune.ToString()));
        }
        var start = runes.Length - limit;
        for (var index = start; index <= Math.Min(runes.Length - 1, start + 100); index++)
            if (runes[index].Value == '\n') return string.Concat(runes.Skip(index + 1).Select(rune => rune.ToString()));
        return string.Concat(runes.Skip(start).Select(rune => rune.ToString()));
    }

    private static JsonObject? PrunePart(JsonObject part, long seq)
    {
        var function = part["functionResponse"] as JsonObject;
        var response = function?["response"] as JsonObject;
        if (response?["output"] is not JsonValue output || !output.TryGetValue<string>(out var text)) return null;
        var characters = text.EnumerateRunes().ToArray();
        if (characters.Length <= 1000) return null;
        var head = Edge(characters, 500, true);
        var tail = Edge(characters, 500, false);
        var tool = function?["name"]?.GetValue<string>() ?? "unknown";
        var id = function?["tool_use_id"]?.GetValue<string>() ?? "unknown";
        var marker = $"--- [foxwarm: historical tool response pruned; original: recall({{ target: \"msg#{seq}\" }}); tool={System.Text.Json.JsonSerializer.Serialize(tool)}; tool_use_id={System.Text.Json.JsonSerializer.Serialize(id)}; kept first {head.EnumerateRunes().Count()} and last {tail.EnumerateRunes().Count()} Unicode characters] ---";
        var bounded = head + "\n\n" + marker + "\n\n" + tail;
        if (bounded.EnumerateRunes().Count() >= characters.Length) return null;
        var clone = (JsonObject)part.DeepClone();
        var fn = (JsonObject)clone["functionResponse"]!;
        var pruned = new JsonObject { ["output"] = bounded };
        foreach (var (key, value) in response)
        {
            if (key == "output") continue;
            if (key is "content" or "error" && value?.ToJsonString().EnumerateRunes().Count() <= 512
                || RetainedResponseMetadata.Contains(key) && value?.ToJsonString().EnumerateRunes().Count() <= 512)
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
                if (part["text"]?.GetValue<string>() is string text) tokens += CompactCandidateBuilder.Tokens(text);
                if (part["thinking"]?.GetValue<string>() is string thinking) tokens += CompactCandidateBuilder.Tokens(thinking);
                if (part["functionCall"] is JsonObject call)
                {
                    tokens += CompactCandidateBuilder.Tokens(call["name"]?.GetValue<string>() ?? "");
                    tokens += CompactCandidateBuilder.Tokens(call["rawArgsText"]?.GetValue<string>() ?? call["args"]?.ToJsonString() ?? "{}");
                }
                if (part["functionResponse"] is JsonObject response)
                {
                    tokens += CompactCandidateBuilder.Tokens(response["name"]?.GetValue<string>() ?? "");
                    tokens += CompactCandidateBuilder.Tokens(response["response"]?.ToJsonString() ?? "{}");
                }
            }
        return tokens;
    }

    private async Task<bool> TryPruneToolsAsync(SessionSnapshot snapshot, CancellationToken token)
    {
        var cutoff = CompactCandidateBuilder.Split(snapshot.History);
        if (cutoff <= 0) return false;
        var bySeq = store.Archive.ReadMessages().GroupBy(row => row.Seq).ToDictionary(group => group.Key, group => group.ToArray());
        var counts = snapshot.History.Select(row => CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]))
            .Where(seq => seq is > 0).GroupBy(seq => seq!.Value).ToDictionary(group => group.Key, group => group.Count());
        var rewritten = snapshot.History.Select(row => (JsonObject)row.DeepClone()).ToArray();
        var affected = new HashSet<long>();
        for (var index = 0; index < cutoff; index++)
        {
            var row = snapshot.History[index];
            var seq = CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]);
            if (seq is not > 0 || counts.GetValueOrDefault(seq.Value) != 1
                || !bySeq.TryGetValue(seq.Value, out var archives) || archives.Length != 1
                || !JsonNode.DeepEquals(NormalizeArchiveComparison(row), NormalizeArchiveComparison(archives[0].Message))) continue;
            if (row["parts"] is not JsonArray parts) continue;
            var nextParts = new JsonArray();
            var changed = false;
            foreach (var part in parts.OfType<JsonObject>())
            {
                var pruned = PrunePart(part, seq.Value);
                nextParts.Add(pruned ?? part.DeepClone());
                changed |= pruned is not null;
            }
            if (!changed) continue;
            rewritten[index]["parts"] = nextParts;
            affected.Add(seq.Value);
        }
        if (affected.Count == 0) return false;
        var persistentSnapshot = snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        var after = EstimateHistory(rewritten, persistentSnapshot);
        var limit = models.Select(snapshot).Model.ContextLimit;
        if (after > Math.Max(1, (int)Math.Floor(limit * .5))) return false;
        foreach (var seq in affected)
        {
            var latest = store.Archive.ReadMessages().Where(row => row.Seq == seq).ToArray();
            var originals = snapshot.History.Where(row => CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]) == seq).ToArray();
            if (latest.Length != 1 || originals.Length != 1
                || !JsonNode.DeepEquals(NormalizeArchiveComparison(latest[0].Message), NormalizeArchiveComparison(originals[0]))) return false;
        }
        token.ThrowIfCancellationRequested();
        await hosted.Entry.SaveLane.CommitCompactionAsync(live =>
        {
            if (live.HistoryVersion != snapshot.HistoryVersion || live.History.Count < snapshot.History.Count
                || snapshot.History.Where((message, index) => !JsonNode.DeepEquals(message, live.History[index])).Any())
                throw new InvalidOperationException("Tool-response pruning snapshot changed incompatibly.");
            var nextHistory = rewritten.Concat(live.History.Skip(snapshot.History.Count))
                .Select(row => (JsonObject)row.DeepClone()).ToArray();
            var staged = live.Snapshot() with { History = nextHistory, HistoryVersion = live.HistoryVersion + 1 };
            var version = live.HistoryVersion;
            var nextSeq = live.NextMessageSeq;
            void Publish(SessionState state)
            {
                state.PublishCommittedHistoryRewrite(nextHistory, version, nextSeq, nextSeq);
            }
            return new CompactionPreparation(staged, [], [], Publish);
        }, token);
        hosted.BroadcastState();
        return true;
    }
}
