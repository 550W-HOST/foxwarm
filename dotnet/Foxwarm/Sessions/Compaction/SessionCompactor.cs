using Foxwarm.Sessions;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private readonly SessionOwner hosted;
    private readonly PersistentSessionAuthorityStore store;
    private readonly HostModels models;
    private readonly ResponsesClientOptions baseOptions;
    private readonly ModelRequestOwner requests;
    private readonly AgentMemory memory;
    private readonly object gate = new();
    private CompactRun? active;
    private Task? manualTask;
    private sealed class CompactRun
    {
        public CancellationTokenSource Cancellation { get; } = new();
        public bool Committed;
        public bool Committing;
        public TaskCompletionSource Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public SessionCompactor(SessionOwner hosted, PersistentSessionAuthorityStore store,
        HostModels models, ResponsesClientOptions baseOptions, ModelRequestOwner requests, AgentMemory memory)
    {
        this.hosted = hosted; this.store = store; this.models = models; this.baseOptions = baseOptions; this.requests = requests;
        this.memory = memory;
    }
    public bool Active { get { lock (gate) return active is not null; } }
    public Task DrainAsync() { lock (gate) return manualTask ?? Task.CompletedTask; }
    private CompactRun? Begin()
    {
        lock (gate)
        {
            if (active is not null) return null;
            active = new CompactRun();
            hosted.SetCompacting(true);
            return active;
        }
    }
    private void End(CompactRun run)
    {
        lock (gate)
        {
            if (ReferenceEquals(active, run)) active = null;
            hosted.SetCompacting(false);
            run.Completion.TrySetResult();
            run.Cancellation.Dispose();
        }
    }
    public async Task<(bool Cancelled, bool TooLate)> StopAsync()
    {
        CompactRun? run;
        lock (gate)
        {
            run = active;
            if (run is null) return (false, false);
            if (run.Committed) return (false, true);
        }
        try { run.Cancellation.Cancel(); }
        catch (ObjectDisposedException) { /* Completed between checking and cancellation. */ }
        await run.Completion.Task;
        return run.Committed ? (false, true) : (true, false);
    }

    public async Task<bool> StartManualAsync(string? guidance = null)
    {
        var entry = hosted.Entry;
        if (!entry.TryClaimProcessor()) return false;
        var turn = hosted.Registry.HostFor(hosted.Id);
        var claimed = false;
        var handedOff = false;
        try
        {
            claimed = await turn.TryClaimBusyAsync();
            if (!claimed) return false;
            var run = Begin();
            if (run is null) return false;
            lock (gate) manualTask = RunManualAsync(run, turn, guidance);
            handedOff = true;
            return true;
        }
        finally
        {
            if (!claimed) entry.ReleaseProcessor();
            else if (!handedOff)
            {
                await turn.ReleaseBusyAsync();
                entry.ReleaseProcessor();
            }
        }
    }

    private async Task RunManualAsync(CompactRun run, LocalSessionTurnHost turn, string? guidance)
    {
        await Task.Yield();
        try { await RunAsync(run, guidance); }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (Exception error) { hosted.Entry.RecordBackgroundProcessorFailure(error); hosted.PublishCompactError(error); }
        finally
        {
            End(run);
            try { await turn.ReleaseBusyAsync(); }
            catch (Exception error) { hosted.Entry.RecordBackgroundProcessorFailure(error); hosted.PublishCompactError(error); }
            hosted.Entry.ReleaseProcessor();
            hosted.PublishStateChanged();
            if (hosted.Entry.Snapshot().Queue.Count > 0) _ = hosted.StartProcessing();
        }
    }

    public async Task AutoAfterTurnAsync(ChatResult result)
    {
        var usage = result.Usage ?? result.AssistantMessage?["__meta"]?["usage"] as JsonObject;
        if (usage is null) return;
        var cached = CompactCandidateBuilder.Finite(usage["cachedTokens"]) ?? 0;
        var input = CompactCandidateBuilder.Finite(usage["inputTokens"]) ?? 0;
        var output = CompactCandidateBuilder.Finite(usage["outputTokens"]) ?? 0;
        var total = cached + input + output;
        if (total <= 0) return;
        var snapshot = hosted.Entry.Snapshot();
        var threshold = SessionModelSettings.EffectiveThreshold(snapshot.AuthorityEnvelope, models);
        if (total <= threshold) return;
        var run = Begin();
        if (run is null) return;
        try { await RunAsync(run, null, auto: true); }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (Exception error) { hosted.Entry.RecordBackgroundProcessorFailure(error); hosted.PublishCompactError(error); }
        finally { End(run); }
    }

    private async Task<bool> RunAsync(CompactRun run, string? guidance, bool auto = false)
    {
        var token = run.Cancellation.Token;
        var snapshot = hosted.Entry.Snapshot();
        token.ThrowIfCancellationRequested();
        if (auto && await TryPruneToolsAsync(snapshot, token))
        {
            lock (gate) run.Committed = true;
            return true;
        }
        var candidates = CompactCandidateBuilder.Build(snapshot.History, models.Capture().CompactKeepFraction);
        if (candidates.Split <= 0 || candidates.Items.Count == 0 && candidates.Preserved.Count == 0
            && !snapshot.History.Take(candidates.Split).Any(row => !CompactCandidateBuilder.Visible(row))) return false;
        var plan = candidates.Items.Count == 0 && candidates.Preserved.Count == 0
            ? new CompactPlan([], new HashSet<long>(), new HashSet<long>())
            : await PlanAsync(snapshot, candidates, guidance, token);
        token.ThrowIfCancellationRequested();
        lock (gate) run.Committing = true;
        try
        {
            await hosted.Entry.SaveLane.CommitCompactionAsync(state => PrepareCompact(state, snapshot, candidates, plan), token);
            lock (gate) run.Committed = true;
            hosted.PublishStateChanged();
            return true;
        }
        catch (AuthorityCommittedException)
        {
            lock (gate) run.Committed = true;
            hosted.PublishStateChanged();
            throw;
        }
    }

    private CompactionPreparation PrepareCompact(SessionState live, SessionSnapshot original,
        CompactCandidates candidates, CompactPlan plan)
    {
        if (live.HistoryVersion != original.HistoryVersion || live.History.Count < original.History.Count
            || original.History.Where((message, index) => !JsonNode.DeepEquals(message, live.History[index])).Any())
            throw new InvalidOperationException("Compaction snapshot changed incompatibly before authority commit.");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var nextBlockId = CompactCandidateBuilder.Number(live.AuthorityEnvelope["nextBlockId"]) ?? 1;
        var operations = new List<(CompactOperation Operation, ArchiveBlockRecord Record)>();
        foreach (var op in plan.Operations)
        {
            var sourceIds = op.Kind == "block" ? new JsonArray(candidates.Items.Skip(op.CandidateStart)
                .Take(op.CandidateEnd - op.CandidateStart + 1).Select(item => (JsonNode?)JsonValue.Create(item.Start)).ToArray()) : null;
            var summary = FormatSummary(op.Summary, op.MemoryFacts);
            var record = new ArchiveBlockRecord(live.Id, "main", nextBlockId++, op.Level, op.Kind,
                op.First.Start, op.Last.End, sourceIds, op.RawStart, op.RawEnd,
                op.First.StartTimestamp, op.Last.EndTimestamp, summary,
                op.MemoryFacts is null ? null : (JsonArray)op.MemoryFacts.DeepClone(), now);
            operations.Add((op, record));
        }
        var history = new List<JsonObject>();
        var cursor = 0;
        foreach (var (op, record) in operations)
        {
            AppendRetained(original.History.Skip(cursor).Take(op.HistoryStart - cursor), plan.Remove, history);
            history.Add(record.ToMessage());
            foreach (var row in original.History.Skip(op.HistoryStart).Take(op.HistoryEnd - op.HistoryStart + 1))
                if (CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]) is long seq && plan.Preserve.Contains(seq))
                {
                    var preserved = (JsonObject)row.DeepClone();
                    ((JsonObject)preserved["__meta"]!)["preservedFromBlockId"] = record.Id;
                    history.Add(preserved);
                }
            cursor = op.HistoryEnd + 1;
        }
        AppendRetained(original.History.Skip(cursor).Take(candidates.Split - cursor), plan.Remove, history);
        AppendRetained(live.History.Skip(candidates.Split), new HashSet<long>(), history);
        var completion = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["system"] = CompletionMarker(live.Id, now) }),
            ["__meta"] = new JsonObject { ["seq"] = live.NextMessageSeq, ["timestamp"] = now }
        };
        var liveGoal = live.AuthorityEnvelope["goalState"] as JsonObject;
        var hasGoal = SessionWait.Text(liveGoal?["goal"]) is string goalText && SessionGoal.Trim(goalText).Length > 0;
        if (hasGoal)
        {
            ((JsonArray)completion["parts"]!).Add(new JsonObject { ["system"] = SessionGoal.Format(SessionWait.Text(liveGoal!["goal"])!) });
            var completionMeta = (JsonObject)completion["__meta"]!;
            completionMeta["goalReminder"] = true; completionMeta["goalReminderKind"] = "compact-completion";
            completionMeta["goalAnchorSeq"] = live.NextMessageSeq;
        }
        history.Add(completion);
        var envelope = (JsonObject)live.AuthorityEnvelope.DeepClone();
        envelope["nextBlockId"] = nextBlockId;
        if (hasGoal) ((JsonObject)envelope["goalState"]!)["anchorSeq"] = live.NextMessageSeq;
        var meta = (JsonObject)live.Meta.DeepClone();
        meta["messageCount"] = history.Count;
        var staged = live.Snapshot() with
        {
            History = history,
            Meta = meta,
            NextMessageSeq = live.NextMessageSeq + 1,
            HistoryVersion = live.HistoryVersion + 1,
            AuthorityEnvelope = envelope
        };
        var previousNext = live.NextMessageSeq;
        var previousVersion = live.HistoryVersion;
        void Publish(SessionState state)
        {
            state.PublishCommittedHistoryRewrite(history, previousVersion, previousNext, previousNext + 1, nextBlockId);
            if (hasGoal && state.AuthorityEnvelope["goalState"] is JsonObject currentGoal) currentGoal["anchorSeq"] = previousNext;
        }
        return new CompactionPreparation(staged, operations.Select(item => item.Record).ToArray(), [completion], Publish);
    }

    private static void AppendRetained(IEnumerable<JsonObject> source, IReadOnlySet<long> removed, List<JsonObject> output)
    {
        foreach (var row in source)
        {
            if (!CompactCandidateBuilder.Visible(row) || CompactCandidateBuilder.Completion(row)) continue;
            var seq = CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["seq"]);
            if (seq is not null && removed.Contains(seq.Value)
                && CompactCandidateBuilder.Number(CompactCandidateBuilder.Meta(row)?["preservedFromBlockId"]) is > 0) continue;
            output.Add((JsonObject)row.DeepClone());
        }
    }
    private static string FormatSummary(string summary, JsonArray? facts)
    {
        if (facts is not { Count: > 0 }) return summary;
        var lines = facts.OfType<JsonObject>().Select(fact =>
        {
            var extras = new List<string>();
            if (fact["context"]?.GetValue<string>() is string context && context.Trim().Length > 0)
                extras.Add("context: " + context.Trim());
            if (fact["attributedTo"]?.GetValue<string>() is string attributed) extras.Add("attributed to: " + attributed);
            return $"- **{fact["kind"]?.GetValue<string>()}:** {fact["text"]?.GetValue<string>()?.Trim()}{(extras.Count == 0 ? "" : $" _({string.Join("; ", extras)})_")}";
        });
        return summary.Trim() + "\n\n### Memory facts\n" + string.Join('\n', lines);
    }
    private static string CompletionMarker(string id, long now) =>
        $"<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" parentSessionId=\"(none)\" currentSessionId=\"{id}\" time=\"{ArchiveBlockRecord.LocalTimestamp(now)}\" />";
}
