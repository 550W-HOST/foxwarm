using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private readonly TimeProvider idleClock;
    private readonly object idleGate = new();
    private ITimer? idleTimer;
    private long idleGeneration;
    private bool idleClosed;
    private double idleConsumedThrough = double.NegativeInfinity;
    private Task idleFiring = Task.CompletedTask;
    private IdleRequest? idleRequest;

    private sealed record IdleRequest(
        double StartedAt,
        double Total,
        string ModelId,
        long HistoryVersion
    );

    private sealed record IdleDue(IdleRequest Request, double At);

    internal void AttachIdleScheduling()
    {
        hosted.Entry.ProcessorReleased = () => RefreshIdleSchedule(allowArm: true);
        hosted.Entry.IdentityLossToken.Register(StopIdleScheduling);
    }

    // Read only active authority. A completion marker ends the preceding measurement's lifetime.
    private static IdleRequest? LastIdleRequest(SessionSnapshot snapshot)
    {
        for (var index = snapshot.History.Count - 1; index >= 0; index--)
        {
            var row = snapshot.History[index].ToJson();
            if (CompactCandidateBuilder.Completion(row))
                return null;
            if (SessionWait.Text(row["role"]) != "model")
                continue;
            var meta = row["__meta"];
            if (
                CompactCandidateBuilder.Finite(meta?["llmRequestTiming"]?["startedAt"])
                    is not double started
                || SessionWait.Text(meta?["modelId"]) is not string model
            )
                continue;
            return new IdleRequest(
                started,
                UsageTotal(new ChatResult(row)),
                model,
                snapshot.HistoryVersion
            );
        }
        return null;
    }

    private IdleDue? IdleCandidate(
        SessionSnapshot snapshot,
        HostModels catalog,
        IdleRequest? request
    )
    {
        if (
            hosted.Entry.Retired
            || !hosted.Entry.IdentityAvailable
            || hosted.Registry.Runner.Closing
            || hosted.Entry.HistoryMutation
            || hosted.Entry.HasProcessor
            || snapshot.Busy
            || snapshot.Stopping
            || snapshot.Queue.Any(Ordinary)
            || ClaudeRuntimeState.IsExternal(snapshot.AuthorityEnvelope)
            || Active
        )
            return null;
        if (request is null || request.HistoryVersion != snapshot.HistoryVersion)
            return null;
        lock (idleGate)
            if (idleClosed || request.StartedAt <= idleConsumedThrough)
                return null;
        var model = requests.ResolveConcrete(catalog, snapshot);
        if (model.Key != request.ModelId)
            return null;
        var minutes = SessionWait.Number(model.Configuration["idleCompactMinutes"]) ?? 0;
        var fraction =
            SessionWait.Number(model.Configuration["idleCompactMinContextPercent"]) ?? .5;
        if (minutes <= 0 || request.Total / model.ContextLimit <= fraction)
            return null;
        return new IdleDue(request, Math.Ceiling(request.StartedAt + minutes * 60_000));
    }

    // Only a released processor can initially arm a timer. Lazy hydration and startup never do.
    internal void RefreshIdleSchedule(bool allowArm = false)
    {
        lock (idleGate)
            if (idleClosed || !allowArm && idleTimer is null)
                return;
        IdleDue? due;
        try
        {
            var snapshot = hosted.Entry.Snapshot();
            IdleRequest? request;
            lock (idleGate)
                request = idleRequest;
            if (allowArm)
            {
                request = LastIdleRequest(snapshot);
                lock (idleGate)
                    idleRequest = request;
            }
            due = IdleCandidate(snapshot, models.Capture(), request);
        }
        catch (Exception error)
        {
            Report(error);
            due = null;
        }
        lock (idleGate)
        {
            CancelIdleTimer();
            if (idleClosed || due is null)
                return;
            ArmIdleTimer(due);
        }
    }

    private void CancelIdleTimer()
    {
        idleGeneration++;
        idleTimer?.Dispose();
        idleTimer = null;
    }

    private void ArmIdleTimer(IdleDue due)
    {
        var generation = idleGeneration;
        // System timers have a finite maximum delay; very long delays recheck at that bound.
        var milliseconds = Math.Clamp(
            due.At - idleClock.GetUtcNow().ToUnixTimeMilliseconds(),
            0,
            int.MaxValue - 1d
        );
        void Fire(object? state)
        {
            TaskCompletionSource settled;
            lock (idleGate)
            {
                if (idleClosed || generation != idleGeneration)
                    return;
                CancelIdleTimer();
                settled = new(TaskCreationOptions.RunContinuationsAsynchronously);
                idleFiring = idleFiring.IsCompleted
                    ? settled.Task
                    : Task.WhenAll(idleFiring, settled.Task);
            }
            _ = FireIdleAsync(settled);
        }
        ITimer Create() =>
            idleClock.CreateTimer(
                Fire,
                null,
                TimeSpan.FromMilliseconds(milliseconds),
                Timeout.InfiniteTimeSpan
            );
        // A timer must not retain the finished turn's invocation or mutation scopes.
        if (ExecutionContext.IsFlowSuppressed())
            idleTimer = Create();
        else
            using (ExecutionContext.SuppressFlow())
                idleTimer = Create();
    }

    private async Task FireIdleAsync(TaskCompletionSource settled)
    {
        try
        {
            var snapshot = hosted.Entry.Snapshot();
            var due = IdleCandidate(snapshot, models.Capture(), LastIdleRequest(snapshot));
            if (due is null)
                return;
            if (due.At > idleClock.GetUtcNow().ToUnixTimeMilliseconds())
            {
                RefreshIdleSchedule(allowArm: true);
                return;
            }
            // Admission repeats eligibility and consumes this measurement under the Session gate.
            var admission = await StartAsync(null, null, idle: true);
            if (!admission.Started)
                RefreshIdleSchedule(allowArm: true);
        }
        catch (Exception error)
        {
            Report(error);
        }
        finally
        {
            settled.TrySetResult();
        }
    }

    private void IdleCompactionCommitted()
    {
        var request = LastIdleRequest(hosted.Entry.Snapshot());
        lock (idleGate)
        {
            var committedAt = (idleClock.GetUtcNow() - DateTimeOffset.UnixEpoch).TotalMilliseconds;
            idleConsumedThrough = Math.Max(idleConsumedThrough, committedAt);
            if (request is not null)
                idleConsumedThrough = Math.Max(idleConsumedThrough, request.StartedAt);
            idleRequest = null;
            CancelIdleTimer();
        }
    }

    private void CancelIdleSchedule()
    {
        lock (idleGate)
            CancelIdleTimer();
    }

    internal void StopIdleScheduling()
    {
        lock (idleGate)
        {
            idleClosed = true;
            CancelIdleTimer();
        }
    }

    internal Task DrainIdleAsync()
    {
        lock (idleGate)
            return idleFiring;
    }

    /// <summary>An armed or firing idle compaction; hydration never re-arms one.</summary>
    internal bool IdleScheduled
    {
        get
        {
            lock (idleGate)
                return idleTimer is not null || !idleFiring.IsCompleted;
        }
    }
}
