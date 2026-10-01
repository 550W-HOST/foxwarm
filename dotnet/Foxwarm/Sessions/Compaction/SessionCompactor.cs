using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed record CompactAdmission(bool AlreadyPending, bool Started, bool Background, bool BackgroundUnavailable);

internal sealed partial class SessionCompactor
{
    private readonly SessionOwner hosted;
    private readonly PersistentSessionAuthorityStore store;
    private readonly HostModels models;
    private readonly ResponsesClientOptions baseOptions;
    private readonly ModelRequestOwner requests;
    private readonly AgentMemory memory;
    private readonly object gate = new();
    private readonly ConcurrentDictionary<CompactRun, Task> lifetimes = new();
    private CompactRun? active;
    private sealed class CompactRun(SessionSnapshot snapshot, HostModels catalog, double keep, bool background, bool standalone)
    {
        internal readonly SessionSnapshot Snapshot = snapshot;
        internal readonly HostModels Catalog = catalog;
        internal readonly double Keep = keep;
        internal readonly bool Background = background, Standalone = standalone;
        internal readonly CancellationTokenSource Cancellation = new();
        internal readonly TaskCompletionSource PipelineDone = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string Phase = "planning";
        internal bool Committed, Applying, Ready, OwnsProcessor;
        internal int Finished;
        internal CompactCandidates? Candidates;
        internal CompactPlan? Plan;
        internal string? CacheKey;
        internal Exception? Failure;
        internal object? PhaseLease;
    }

    public SessionCompactor(SessionOwner hosted, PersistentSessionAuthorityStore store,
        HostModels models, ResponsesClientOptions baseOptions, ModelRequestOwner requests, AgentMemory memory)
    {
        this.hosted = hosted; this.store = store; this.models = models; this.baseOptions = baseOptions;
        this.requests = requests; this.memory = memory;
    }
    public bool Active { get { lock (gate) return active is not null; } }
    public bool Standalone { get { lock (gate) return active is { Standalone: true, OwnsProcessor: true }; } }
    public bool HasCompletedJob { get { lock (gate) return active is { Background: true, Ready: true, Applying: false } run && !run.Cancellation.IsCancellationRequested; } }
    public string? Phase { get { lock (gate) return active?.Phase; } }
    public async Task DrainAsync()
    {
        while (!lifetimes.IsEmpty) await Task.WhenAll(lifetimes.Values.ToArray());
    }
    private CompactRun? Begin(SessionSnapshot snapshot, HostModels catalog, double keep, bool background, bool standalone)
    {
        lock (gate)
        {
            if (active is not null) return null;
            var run = new CompactRun(snapshot, catalog, keep, background, standalone);
            active = run; lifetimes[run] = run.Completion.Task;
            return run;
        }
    }
    private void Report(Exception error)
    {
        hosted.Entry.RecordBestEffortFailure(error);
        hosted.PublishCompactError(error);
    }
    private async Task FinishAsync(CompactRun run)
    {
        if (Interlocked.Exchange(ref run.Finished, 1) != 0) { await run.Completion.Task; return; }
        lock (gate) { if (ReferenceEquals(active, run)) active = null; }
        try
        {
            await run.PipelineDone.Task;
            await hosted.Entry.SaveLane.RemoveCompactWakeAsync(run);
        }
        catch (Exception error) { Report(error); }
        finally
        {
            if (run.PhaseLease is not null) hosted.EndCompactPhase(run.PhaseLease);
            run.Cancellation.Dispose();
            run.Completion.TrySetResult(); lifetimes.TryRemove(run, out _);
        }
    }
    public async Task<(bool Cancelled, bool TooLate)> StopAsync()
    {
        CompactRun? run;
        lock (gate) run = active;
        if (run is null) return (false, false);
        try { run.Cancellation.Cancel(); } catch (ObjectDisposedException) { }
        await run.PipelineDone.Task;
        bool finish;
        lock (gate) finish = ReferenceEquals(active, run) && !run.Applying;
        if (finish) await FinishAsync(run);
        await run.Completion.Task;
        return run.Committed ? (false, true) : (true, false);
    }

    public async Task<CompactAdmission> StartManualAsync(string? guidance = null, double? keepPercent = null)
    {
        var snapshot = hosted.Entry.Snapshot(); var catalog = models.Capture();
        var background = SupportsBackground(snapshot, catalog);
        lock (gate) { if (active is not null) return new(true, false, background, false); }
        if (!background && (snapshot.Busy || snapshot.Stopping || snapshot.Queue.Any(Ordinary)))
            return new(false, false, false, true);
        var run = Begin(snapshot, catalog, keepPercent ?? catalog.CompactKeepFraction, background, !background);
        if (run is null) return new(true, false, background, false);
        if (background)
        {
            _ = ProduceBackgroundAsync(run, guidance);
            return new(false, true, true, false);
        }
        var entry = hosted.Entry;
        if (!entry.TryClaimProcessor())
        {
            run.PipelineDone.TrySetResult(); await FinishAsync(run);
            return new(false, false, false, true);
        }
        run.OwnsProcessor = true;
        var claimed = false;
        try
        {
            claimed = await hosted.Registry.HostFor(hosted.Id).TryClaimBusyAsync();
            if (!claimed) return new(false, false, false, true);
            run.PhaseLease = hosted.BeginCompactPhase();
            _ = RunStandaloneAsync(run, guidance);
            return new(false, true, false, false);
        }
        finally
        {
            if (!claimed)
            {
                entry.ReleaseProcessor(); run.PipelineDone.TrySetResult(); await FinishAsync(run);
            }
        }
    }

    private async Task RunStandaloneAsync(CompactRun run, string? guidance)
    {
        await Task.Yield();
        try { await PlanAndApplyAwaitedAsync(run, guidance); }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (Exception error) { Report(error); }
        finally
        {
            try { await hosted.Entry.SaveLane.ReleaseStandaloneCompactAsync(); }
            catch (Exception error) { Report(error); }
            hosted.Entry.ReleaseProcessor();
            run.PipelineDone.TrySetResult(); await FinishAsync(run);
            hosted.PublishStateChanged();
            if (hosted.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Any(Ordinary)))
                _ = hosted.StartProcessing();
        }
    }

    public async Task AutoAfterTurnAsync(ChatResult result)
    {
        var usage = result.Usage ?? result.AssistantMessage?["__meta"]?["usage"] as JsonObject;
        if (usage is null) return;
        var total = (CompactCandidateBuilder.Finite(usage["cachedTokens"]) ?? 0)
            + (CompactCandidateBuilder.Finite(usage["inputTokens"]) ?? 0)
            + (CompactCandidateBuilder.Finite(usage["outputTokens"]) ?? 0);
        var snapshot = hosted.Entry.Snapshot(); var catalog = models.Capture();
        if (total <= 0 || total <= SessionModelSettings.EffectiveThreshold(snapshot.AuthorityEnvelope, catalog)) return;
        var background = SupportsBackground(snapshot, catalog);
        var run = Begin(snapshot, catalog, catalog.CompactKeepFraction, background, false);
        if (run is null) return;
        var handedOff = false;
        try
        {
            if (await TryPruneToolsAsync(snapshot, run.Cancellation.Token, run.Keep, catalog))
            {
                run.Committed = true; run.PipelineDone.TrySetResult(); await FinishAsync(run); return;
            }
            if (background) { handedOff = true; _ = ProduceBackgroundAsync(run, null); return; }
            run.PhaseLease = hosted.BeginCompactPhase();
            await PlanAndApplyAwaitedAsync(run, null);
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (AuthorityCommittedException error) { run.Committed = true; Report(error); }
        catch (Exception error) { Report(error); }
        finally
        {
            if (!handedOff)
            { run.PipelineDone.TrySetResult(); await FinishAsync(run); }
        }
    }

    private static bool SupportsBackground(SessionSnapshot snapshot, HostModels catalog) =>
        !ModelRoutingFingerprint.False(catalog.Resolve(SessionWait.Text(snapshot.AuthorityEnvelope["model"])).Configuration["asyncCompact"]);
    internal static bool Ordinary(QueueItem item) => item.Type != QueueItemType.CompactCommit;

    private async Task PreparePlanAsync(CompactRun run, string? guidance)
    {
        var token = run.Cancellation.Token;
        token.ThrowIfCancellationRequested();
        run.CacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        token.ThrowIfCancellationRequested();
        var candidates = CompactCandidateBuilder.Build(run.Snapshot.History, run.Keep);
        run.Candidates = candidates;
        if (candidates.Split <= 0 || candidates.Items.Count == 0 && candidates.Preserved.Count == 0
            && !run.Snapshot.History.Take(candidates.Split).Any(row => !CompactCandidateBuilder.Visible(row))) return;
        run.Plan = candidates.Items.Count == 0 && candidates.Preserved.Count == 0
            ? new CompactPlan([], new HashSet<long>(), new HashSet<long>())
            : await PlanAsync(run.Snapshot, candidates, guidance, token, run.CacheKey,
                run.Background ? ModelRequestScope.BackgroundCompactPlan : ModelRequestScope.CompactPlan, run.Catalog.DefaultKey);
    }

    private async Task ProduceBackgroundAsync(CompactRun run, string? guidance)
    {
        await Task.Yield();
        try
        {
            try { await PreparePlanAsync(run, guidance); }
            catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { throw; }
            catch (Exception error) { run.Failure = error; }
            run.Cancellation.Token.ThrowIfCancellationRequested();
            lock (gate)
            {
                if (!ReferenceEquals(active, run)) return;
                run.Ready = true; run.Phase = "enqueueing";
            }
            await hosted.Entry.SaveLane.PublishCompactWakeAsync(run, run.Cancellation.Token);
            lock (gate)
                if (ReferenceEquals(active, run) && !run.Applying) run.Phase = "ready";
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (Exception error) { Report(error); run.Ready = false; }
        finally
        {
            run.PipelineDone.TrySetResult();
            bool finish, wake;
            lock (gate)
            {
                var cancelled = run.Cancellation.IsCancellationRequested;
                finish = !run.Applying && (cancelled || !run.Ready);
                wake = !cancelled && run.Ready;
            }
            if (finish) await FinishAsync(run);
            else if (wake && hosted.Entry.WithState(state => !state.Busy && !state.Stopping)) _ = hosted.StartProcessing();
        }
    }

    public async Task ApplyCompletedAsync()
    {
        CompactRun? run;
        lock (gate)
        {
            run = active;
            if (run is not { Background: true, Ready: true, Applying: false } || run.Cancellation.IsCancellationRequested) return;
            run.Applying = true; run.Phase = "committing";
        }
        run.PhaseLease = hosted.BeginCompactPhase();
        try
        {
            if (run.Failure is not null) throw run.Failure;
            if (run.Plan is not null) await ApplyAsync(run);
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (Exception error) { Report(error); }
        finally { await FinishAsync(run); }
    }
    public async Task SafePointAsync()
    {
        await ApplyCompletedAsync();
        try { await hosted.Entry.SaveLane.RemoveCompactWakeAsync(staleOnly: true); }
        catch (Exception error) { Report(error); }
    }
    private async Task PlanAndApplyAwaitedAsync(CompactRun run, string? guidance)
    {
        await PreparePlanAsync(run, guidance);
        if (run.Plan is not null) await ApplyAsync(run);
    }
    private async Task ApplyAsync(CompactRun run)
    {
        run.Cancellation.Token.ThrowIfCancellationRequested();
        lock (gate) run.Phase = "committing";
        try
        {
            await hosted.Entry.SaveLane.CommitCompactionAsync(state => PrepareCompact(state, run.Snapshot, run.Candidates!, run.Plan!),
                run.Cancellation.Token, RefreshCommitMemoryAsync);
            run.Committed = true; hosted.PublishStateChanged();
        }
        catch (AuthorityCommittedException) { run.Committed = true; hosted.PublishStateChanged(); throw; }
    }
    private async Task<string?> RefreshCommitMemoryAsync(SessionSnapshot live, CancellationToken token)
    {
        var modelId = ConditionalMemory.ReadCurrentModelSnapshotId(SessionWait.Text(live.AuthorityEnvelope["persistentMemorySnapshot"]) ?? "");
        if (modelId is null)
        {
            var model = models.Capture().Resolve(SessionWait.Text(live.AuthorityEnvelope["model"]));
            if (model.IsVirtual) return null;
            modelId = model.Key;
        }
        return await memory.BuildAsync(hosted.Agent, hosted.Id, modelId, token);
    }
}
