using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed record CompactAdmission(
    bool AlreadyPending,
    bool Started,
    bool Background,
    bool BackgroundUnavailable
);

internal sealed partial class SessionCompactor
{
    private readonly SessionOwner hosted;
    private readonly SessionManager? sessions;
    private readonly PersistentSessionAuthorityStore store;
    private readonly HostModels models;
    private readonly ResponsesClientOptions baseOptions;
    private readonly ModelRequestOwner requests;
    private readonly AgentMemory memory;
    private readonly Func<JsonArray>? definitions;
    private readonly object gate = new();
    private readonly ConcurrentDictionary<CompactRun, Task> lifetimes = new();
    private CompactRun? active;

    private sealed class CompactRun(
        SessionSnapshot snapshot,
        HostModels catalog,
        double keep,
        bool background,
        bool standalone
    )
    {
        internal readonly SessionSnapshot Snapshot = snapshot;
        internal readonly HostModels Catalog = catalog;
        internal readonly double Keep = keep;
        internal readonly bool Background = background,
            Standalone = standalone;
        internal readonly CancellationTokenSource Cancellation = new();
        internal readonly TaskCompletionSource PlanningSettled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource PipelineDone = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource Completion = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal string Phase = "planning";
        internal bool Committed,
            Applying,
            Ready,
            OwnsProcessor;
        internal int Finished;
        internal CompactCandidates? Candidates;
        internal CompactPlan? Plan;
        internal string? CacheKey;
        internal Exception? Failure;
        internal object? PhaseLease;
    }

    public SessionCompactor(
        SessionOwner hosted,
        SessionManager sessions,
        PersistentSessionAuthorityStore store,
        HostModels models,
        ResponsesClientOptions baseOptions,
        ModelRequestOwner requests,
        AgentMemory memory,
        Func<JsonArray>? definitions = null
    )
    {
        this.hosted = hosted;
        this.sessions = sessions;
        this.store = store;
        this.models = models;
        this.baseOptions = baseOptions;
        this.requests = requests;
        this.memory = memory;
        this.definitions = definitions;
    }

    public bool Active
    {
        get
        {
            lock (gate)
                return active is not null;
        }
    }
    public bool Standalone
    {
        get
        {
            lock (gate)
                return active is { Standalone: true, OwnsProcessor: true };
        }
    }
    public bool HasCompletedJob
    {
        get
        {
            lock (gate)
                return active is { Background: true, Ready: true, Applying: false } run
                    && !run.Cancellation.IsCancellationRequested;
        }
    }
    public string? Phase
    {
        get
        {
            lock (gate)
                return active?.Phase;
        }
    }

    public async Task DrainAsync()
    {
        while (!lifetimes.IsEmpty)
            await Task.WhenAll(lifetimes.Values.ToArray());
    }

    private CompactRun? Begin(
        SessionSnapshot snapshot,
        HostModels catalog,
        double keep,
        bool background,
        bool standalone
    )
    {
        lock (gate)
        {
            if (hosted.Entry.HistoryMutation)
                return null;
            if (active is not null)
                return null;
            var run = new CompactRun(snapshot, catalog, keep, background, standalone);
            active = run;
            lifetimes[run] = run.Completion.Task;
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
        if (Interlocked.Exchange(ref run.Finished, 1) != 0)
        {
            await run.Completion.Task;
            return;
        }
        lock (gate)
        {
            if (ReferenceEquals(active, run))
                active = null;
        }
        try
        {
            await run.PipelineDone.Task;
            await hosted.Entry.SaveLane.RemoveCompactWakeAsync(run);
        }
        catch (Exception error)
        {
            Report(error);
        }
        finally
        {
            if (run.PhaseLease is not null)
                hosted.EndCompactPhase(run.PhaseLease);
            run.Cancellation.Dispose();
            run.Completion.TrySetResult();
            lifetimes.TryRemove(run, out _);
        }
    }

    public async Task<(bool Cancelled, bool TooLate)> StopAsync()
    {
        CompactRun? run;
        lock (gate)
            run = active;
        if (run is null)
            return (false, false);
        try
        {
            run.Cancellation.Cancel();
        }
        catch (ObjectDisposedException) { }
        await run.PipelineDone.Task;
        bool finish;
        lock (gate)
            finish = ReferenceEquals(active, run) && !run.Applying;
        if (finish)
            await FinishAsync(run);
        await run.Completion.Task;
        return run.Committed ? (false, true) : (true, false);
    }

    public async Task<CompactAdmission> StartManualAsync(
        string? guidance = null,
        double? keepPercent = null
    )
    {
        if (hosted.Entry.HistoryMutation)
            throw new InvalidOperationException("Session history change is in progress.");
        using var admission = hosted.Entry.AdmitMutation();
        var snapshot = hosted.Entry.Snapshot();
        var catalog = models.Capture();
        var background = SupportsBackground(snapshot, catalog);
        lock (gate)
        {
            if (active is not null)
                return new(true, false, background, false);
        }
        if (!background && (snapshot.Busy || snapshot.Stopping || snapshot.Queue.Any(Ordinary)))
            return new(false, false, false, true);
        var run = Begin(
            snapshot,
            catalog,
            keepPercent ?? catalog.CompactKeepFraction,
            background,
            !background
        );
        if (run is null)
            return new(true, false, background, false);
        if (background)
        {
            _ = ProduceBackgroundAsync(run, guidance);
            return new(false, true, true, false);
        }
        var entry = hosted.Entry;
        if (!entry.TryClaimProcessor())
        {
            run.PipelineDone.TrySetResult();
            await FinishAsync(run);
            return new(false, false, false, true);
        }
        run.OwnsProcessor = true;
        var claimed = false;
        try
        {
            claimed = await hosted.Registry.HostFor(hosted.Id).TryClaimBusyAsync();
            if (!claimed)
                return new(false, false, false, true);
            run.PhaseLease = hosted.BeginCompactPhase();
            _ = RunStandaloneAsync(run, guidance);
            return new(false, true, false, false);
        }
        finally
        {
            if (!claimed)
            {
                entry.ReleaseProcessor();
                run.PipelineDone.TrySetResult();
                await FinishAsync(run);
            }
        }
    }

    private async Task RunStandaloneAsync(CompactRun run, string? guidance)
    {
        await Task.Yield();
        try
        {
            await PlanAndApplyAwaitedAsync(run, guidance);
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (Exception error)
        {
            Report(error);
        }
        finally
        {
            try
            {
                await hosted.Entry.SaveLane.ReleaseStandaloneCompactAsync();
            }
            catch (Exception error)
            {
                Report(error);
            }
            hosted.Entry.ReleaseProcessor();
            run.PipelineDone.TrySetResult();
            await FinishAsync(run);
            hosted.PublishStateChanged();
            if (
                !hosted.Entry.WithState(state => state.Busy || state.Stopping)
                && hosted.Registry.HasRunnableWork(hosted.Entry)
            )
                _ = hosted.StartProcessing();
        }
    }

    public async Task<bool> AutoAfterTurnAsync(ChatResult result)
    {
        var total = UsageTotal(result);
        if (total <= 0)
            return false;
        var snapshot = hosted.Entry.Snapshot();
        var catalog = models.Capture();
        if (
            total <= SessionModelSettings.EffectiveThreshold(snapshot.AuthorityEnvelope, catalog)
        )
            return false;
        var background = SupportsBackground(snapshot, catalog);
        var run = Begin(snapshot, catalog, catalog.CompactKeepFraction, background, false);
        if (run is null)
            return false;
        var handedOff = false;
        try
        {
            if (await TryPruneToolsAsync(snapshot, run.Cancellation.Token, run.Keep, catalog))
            {
                run.Committed = true;
                run.PipelineDone.TrySetResult();
                await FinishAsync(run);
                return true;
            }
            if (background)
            {
                handedOff = true;
                _ = ProduceBackgroundAsync(run, null);
                return false;
            }
            run.PhaseLease = hosted.BeginCompactPhase();
            await PlanAndApplyAwaitedAsync(run, null);
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (AuthorityCommittedException error)
        {
            run.Committed = true;
            Report(error);
        }
        catch (Exception error)
        {
            Report(error);
        }
        finally
        {
            if (!handedOff)
            {
                run.PipelineDone.TrySetResult();
                await FinishAsync(run);
            }
        }
        return run.Committed;
    }

    private static double UsageTotal(ChatResult result)
    {
        var usage = result.Usage ?? result.AssistantMessage?["__meta"]?["usage"] as JsonObject;
        return (CompactCandidateBuilder.Finite(usage?["cachedTokens"]) ?? 0)
            + (CompactCandidateBuilder.Finite(usage?["inputTokens"]) ?? 0)
            + (CompactCandidateBuilder.Finite(usage?["outputTokens"]) ?? 0);
    }

    internal async Task BeforeContinuationAsync(ChatResult result, Func<Func<Task>, Task> consumeQueuedInputs, CancellationToken token)
    {
        var snapshot = hosted.Entry.Snapshot();
        var catalog = models.Capture();
        var limit = catalog.Resolve(SessionWait.Text(snapshot.AuthorityEnvelope["model"])).ContextLimit;
        var overLimit = UsageTotal(result) > limit;
        try
        {
            var committed = false;
            await consumeQueuedInputs(async () =>
            {
                var outcome = await SafePointAsync(propagateFailure: overLimit);
                committed |= outcome == true;
                if (overLimit && outcome == false)
                {
                    AssertCanContinue();
                    throw new ModelPreparationException("A completed context compaction did not commit before turn continuation.");
                }
            });
            if (committed)
                return;
            var applied = await AutoAfterTurnAsync(result);
            if (!overLimit)
                return;
            AssertCanContinue();
            if (applied)
                return;
            CompactRun? pending;
            lock (gate)
                pending = active;
            if (pending is not null)
            {
                // Readiness/completion releases the wait; the exact owner applies it below.
                // The normal turn token interrupts only this wait, never the planner.
                AssertCanContinue();
                await pending.PlanningSettled.Task.WaitAsync(token);
                AssertCanContinue();
                if (await SafePointAsync(propagateFailure: true) == true)
                    return;
            }
            throw new ModelPreparationException($"Context compaction did not complete, so this turn stopped before another provider request (previous usage {UsageTotal(result)}, limit {limit}).");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested || hosted.Entry.WithState(state => state.Stopping))
        {
            throw;
        }
        catch (Exception error) when (overLimit && error is not ModelPreparationException)
        {
            throw new ModelPreparationException("Context compaction failed before turn continuation.", error);
        }

        void AssertCanContinue()
        {
            token.ThrowIfCancellationRequested();
            if (hosted.Entry.WithState(state => state.Stopping || state.Meta["runQueuedAfterStop"]?.GetValue<bool>() == true))
                throw new OperationCanceledException(token);
        }
    }

    private static bool SupportsBackground(SessionSnapshot snapshot, HostModels catalog) =>
        !ModelRoutingFingerprint.False(
            catalog.Resolve(SessionWait.Text(snapshot.AuthorityEnvelope["model"])).Configuration[
                "asyncCompact"
            ]
        );

    internal static bool Ordinary(QueueItem item) => item.Type != QueueItemType.CompactCommit;

    private async Task PreparePlanAsync(CompactRun run, string? guidance)
    {
        var token = run.Cancellation.Token;
        token.ThrowIfCancellationRequested();
        run.CacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        token.ThrowIfCancellationRequested();
        var candidates = CompactCandidateBuilder.Build(run.Snapshot.History, run.Keep);
        run.Candidates = candidates;
        if (
            candidates.Split <= 0
            || candidates.Items.Count == 0
                && candidates.Preserved.Count == 0
                && !run
                    .Snapshot.History.Take(candidates.Split)
                    .Any(row => !CompactCandidateBuilder.Visible(row))
        )
            return;
        run.Plan =
            candidates.Items.Count == 0 && candidates.Preserved.Count == 0
                ? new CompactPlan([], new HashSet<long>(), new HashSet<long>())
                : await PlanAsync(
                    run.Snapshot,
                    candidates,
                    guidance,
                    token,
                    run.CacheKey,
                    run.Background
                        ? ModelRequestScope.BackgroundCompactPlan
                        : ModelRequestScope.CompactPlan,
                    run.Catalog.DefaultKey
                );
    }

    private async Task ProduceBackgroundAsync(CompactRun run, string? guidance)
    {
        await Task.Yield();
        try
        {
            try
            {
                await PreparePlanAsync(run, guidance);
            }
            catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                run.Failure = error;
            }
            run.Cancellation.Token.ThrowIfCancellationRequested();
            lock (gate)
            {
                if (!ReferenceEquals(active, run))
                    return;
                run.Ready = true;
                run.Phase = "enqueueing";
            }
            run.PlanningSettled.TrySetResult();
            await hosted.Entry.SaveLane.PublishCompactWakeAsync(
                run,
                run.Cancellation.Token,
                run.Snapshot.Id
            );
            lock (gate)
                if (ReferenceEquals(active, run) && !run.Applying)
                    run.Phase = "ready";
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException)
        {
            run.Ready = false;
        }
        catch (Exception error)
        {
            Report(error);
            run.Ready = false;
        }
        finally
        {
            run.PlanningSettled.TrySetResult();
            run.PipelineDone.TrySetResult();
            bool finish,
                wake;
            lock (gate)
            {
                var cancelled = run.Cancellation.IsCancellationRequested;
                finish = !run.Applying && (cancelled || !run.Ready);
                wake = ReferenceEquals(active, run) && !run.Applying && !cancelled && run.Ready;
            }
            if (finish)
                await FinishAsync(run);
            else if (
                wake
                && !hosted.Entry.WithState(state => state.Busy || state.Stopping)
                && hosted.Registry.HasRunnableWork(hosted.Entry)
            )
                _ = hosted.StartProcessing();
        }
    }

    // null means no completed job; false means an unapplied job; true means a commit.
    public async Task<bool?> ApplyCompletedAsync(bool propagateFailure = false)
    {
        CompactRun? run;
        lock (gate)
        {
            run = active;
            if (
                run is not { Background: true, Ready: true, Applying: false }
                || run.Cancellation.IsCancellationRequested
            )
                return null;
            run.Applying = true;
            run.Phase = "committing";
        }
        run.PhaseLease = hosted.BeginCompactPhase();
        try
        {
            if (run.Failure is not null)
                throw run.Failure;
            if (run.Plan is not null)
                await ApplyAsync(run);
        }
        catch (OperationCanceledException) when (run.Cancellation.IsCancellationRequested) { }
        catch (CompactionSnapshotIncompatibleException) { }
        catch (Exception error)
        {
            Report(error);
            if (propagateFailure)
                throw;
        }
        finally
        {
            await FinishAsync(run);
        }
        return run.Committed;
    }

    public async Task<bool?> SafePointAsync(bool propagateFailure = false)
    {
        var committed = await ApplyCompletedAsync(propagateFailure);
        try
        {
            await hosted.Entry.SaveLane.RemoveCompactWakeAsync(staleOnly: true);
        }
        catch (Exception error)
        {
            Report(error);
            if (propagateFailure)
                throw;
        }
        return committed;
    }

    internal static long[] OrdinaryVisibleSequences(SessionSnapshot snapshot) =>
        TaskProgress.Sequences(snapshot);

    private void CheckpointTaskProgress(SessionSnapshot snapshot)
    {
        if (sessions is null)
            return;
        var sequences = OrdinaryVisibleSequences(snapshot);
        sessions.Tasks.TaskContext(snapshot.Id, sequences, false, []);
    }

    private async Task PlanAndApplyAwaitedAsync(CompactRun run, string? guidance)
    {
        await PreparePlanAsync(run, guidance);
        if (run.Plan is not null)
            await ApplyAsync(run);
    }

    private async Task ApplyAsync(CompactRun run)
    {
        run.Cancellation.Token.ThrowIfCancellationRequested();
        lock (gate)
            run.Phase = "committing";
        try
        {
            long archiveMaximum = 0;
            CheckpointTaskProgress(run.Snapshot);
            await hosted.Entry.SaveLane.CommitCompactionAsync(
                state =>
                {
                    if (state.Id != run.Snapshot.Id)
                        throw new CompactionSnapshotIncompatibleException(
                            "Compaction was planned for a previous Session identity."
                        );
                    return PrepareCompact(
                        state,
                        run.Snapshot,
                        run.Candidates!,
                        run.Plan!,
                        archiveMaximum
                    );
                },
                run.Cancellation.Token,
                async (snapshot, token) =>
                {
                    archiveMaximum = store.Archive.EffectiveBlockHighWater();
                    return await RefreshCommitMemoryAsync(snapshot, token);
                }
            );
            run.Committed = true;
            hosted.PublishStateChanged();
        }
        catch (AuthorityCommittedException)
        {
            run.Committed = true;
            hosted.PublishStateChanged();
            throw;
        }
    }

    private async Task<string?> RefreshCommitMemoryAsync(
        SessionSnapshot live,
        CancellationToken token
    )
    {
        var modelId = ConditionalMemory.ReadCurrentModelSnapshotId(
            SessionWait.Text(live.AuthorityEnvelope["persistentMemorySnapshot"]) ?? ""
        );
        if (modelId is null)
        {
            var model = models.Capture().Resolve(SessionWait.Text(live.AuthorityEnvelope["model"]));
            if (model.IsVirtual)
                return null;
            modelId = model.Key;
        }
        return await memory.BuildAsync(
            hosted.Agent,
            hosted.Id,
            modelId,
            token,
            AgentMemory.Selection(live.AuthorityEnvelope)
        );
    }
}
