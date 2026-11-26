using System.Diagnostics;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Lease;

/// <summary>
/// One tenant lease grant this replica holds, as the renewer tracks it. Its deadline is a
/// <see cref="Stopwatch"/> timestamp: the start of the last positive proof (the acquisition, or
/// a renewal batch's stamp taken before its transaction) plus <see cref="LeaseTimings.FenceAfter"/>.
/// The grant is current until the deadline or until it is lost, whichever comes first; a lost
/// handle never becomes current again.
/// </summary>
internal sealed class GrantHandle
{
    private readonly TaskCompletionSource<string> lost = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private long deadline;

    internal GrantHandle(LeaseGrant grant, long deadline)
    {
        Grant = grant;
        this.deadline = deadline;
    }

    internal LeaseGrant Grant { get; }

    internal long Deadline => Interlocked.Read(ref deadline);

    /// <summary>Completes with the reason once the grant is lost or given up.</summary>
    internal Task<string> Lost => lost.Task;

    internal bool IsCurrent(long now) => !lost.Task.IsCompleted && now < Deadline;

    // Moves the deadline forward only: an older proof never shortens a newer one.
    internal void Prove(long deadlineFromProof)
    {
        long current;
        do
        {
            current = Interlocked.Read(ref deadline);
            if (deadlineFromProof <= current)
                return;
        } while (Interlocked.CompareExchange(ref deadline, deadlineFromProof, current) != current);
    }

    internal bool TryLose(string reason) => lost.TrySetResult(reason);
}

/// <summary>
/// Renews every grant a replica holds (plan §3.2). Each round takes an immutable batch of the
/// live grants with a monotonic stamp from before its transaction, renews them in one
/// statement under the per-row predicate on the reserved control data source, and publishes
/// the outcomes only after the commit, only to the handles of that batch, and only while each
/// is still current. A grant acquired after the stamp isn't in the batch and keeps its own
/// acquisition stamp. A row another transaction holds locked is unproved and retried on its
/// own, with a bounded lock wait, until its own deadline; a row that no longer matches is lost
/// at once; a batch that hits the lock timeout is split, to a bounded depth.
/// One watchdog fences every grant at its deadline, whether or not a renewal is still blocked;
/// a result that arrives after the deadline never revives the grant. Holding no grants starts
/// no countdown.
/// </summary>
internal sealed class GrantRenewer : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly HashSet<GrantHandle> live = [];
    private readonly HashSet<GrantHandle> retrying = [];
    private readonly PgDatabase control;
    private readonly string replica;
    private readonly LeaseTimings timings;
    private readonly Func<long> clock;
    private readonly Action<string>? log;
    private readonly CancellationTokenSource stopping = new();
    // Single-row retries take one connection at a time, so the other control connection
    // stays free for the batch, a fence or a release.
    private readonly SemaphoreSlim retryLane = new(1, 1);
    private TaskCompletionSource wake = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? loops;

    internal GrantRenewer(
        PgDatabase control,
        string replica,
        LeaseTimings timings,
        Action<string>? log = null,
        Func<long>? clock = null
    )
    {
        timings.Validate();
        this.control = control;
        this.replica = replica;
        this.timings = timings;
        this.log = log;
        this.clock = clock ?? Stopwatch.GetTimestamp;
    }

    /// <summary>How many times a batch that hit the lock timeout is halved before its rows are left unproved.</summary>
    internal int MaxSplitDepth { get; init; } = 3;

    /// <summary>
    /// Raised once per lost grant, on the thread pool, never on the renewal or watchdog lane:
    /// a slow handler can't delay another grant's renewal or fence.
    /// </summary>
    internal event Action<GrantHandle, string>? GrantLost;

    internal int Count
    {
        get
        {
            lock (gate)
                return live.Count;
        }
    }

    /// <summary>Starts tracking an acquired grant; its deadline counts from its acquisition stamp.</summary>
    internal GrantHandle Track(LeaseGrant grant)
    {
        var start = grant.AcquisitionStart != 0 ? grant.AcquisitionStart : clock();
        var handle = new GrantHandle(grant, start + Ticks(timings.FenceAfter));
        lock (gate)
            live.Add(handle);
        Wake();
        return handle;
    }

    /// <summary>The grant is definitely lost (a refused write, a takeover): fences it now.</summary>
    internal void Lose(GrantHandle handle, string reason)
    {
        lock (gate)
            live.Remove(handle);
        if (handle.TryLose(reason))
        {
            log?.Invoke($"[lease] Tenant {handle.Grant.Tenant} epoch {handle.Grant.Epoch} lost: {reason}");
            var handlers = GrantLost;
            if (handlers is not null)
                _ = Task.Run(() => handlers(handle, reason));
        }
    }

    /// <summary>
    /// A replica-wide decision that the database is unreachable: fences every grant now. It
    /// never extends one, and a renewal that commits later revives none.
    /// </summary>
    internal void LoseAll(string reason)
    {
        GrantHandle[] all;
        lock (gate)
            all = [.. live];
        foreach (var handle in all)
            Lose(handle, reason);
    }

    /// <summary>Stops renewing a grant that is being released; it isn't reported as lost.</summary>
    internal void Untrack(GrantHandle handle, string reason = "released")
    {
        lock (gate)
            live.Remove(handle);
        handle.TryLose(reason);
    }

    internal void Start()
    {
        if (loops is not null)
            return;
        loops = Task.WhenAll(Task.Run(RenewLoopAsync), Task.Run(WatchdogAsync));
    }

    /// <summary>One renewal round over every live grant; the loop calls it every renew interval.</summary>
    internal async Task RenewOnceAsync(CancellationToken token = default)
    {
        var stamp = clock();
        GrantHandle[] batch;
        lock (gate)
            batch = [.. live.Where(handle => handle.IsCurrent(stamp))];
        if (batch.Length == 0)
            return;
        await RenewAsync(batch, stamp, depth: 0, token).ConfigureAwait(false);
    }

    private async Task RenewAsync(GrantHandle[] batch, long stamp, int depth, CancellationToken token)
    {
        RenewalOutcome[] outcomes;
        try
        {
            outcomes = await TenantLease
                .RenewBatchAsync(
                    control,
                    replica,
                    [.. batch.Select(handle => (handle.Grant.TenantId, handle.Grant.Epoch))],
                    timings.Ttl,
                    timings.RenewInterval,
                    skipLocked: true,
                    token
                )
                .ConfigureAwait(false);
        }
        catch (Npgsql.PostgresException error) when (error.SqlState == "55P03")
        {
            if (batch.Length > 1 && depth < MaxSplitDepth)
            {
                var half = batch.Length / 2;
                await RenewAsync(batch[..half], stamp, depth + 1, token).ConfigureAwait(false);
                await RenewAsync(batch[half..], stamp, depth + 1, token).ConfigureAwait(false);
            }
            else
                foreach (var handle in batch)
                    Unproved(handle);
            return;
        }
        for (var index = 0; index < batch.Length; index++)
            Publish(batch[index], outcomes[index], stamp);
    }

    // Applies one committed outcome to the handle of the batch it was taken for.
    private void Publish(GrantHandle handle, RenewalOutcome outcome, long stamp)
    {
        switch (outcome)
        {
            case RenewalOutcome.Renewed:
                // A success that arrives after the deadline doesn't revive the grant.
                if (handle.IsCurrent(clock()))
                    handle.Prove(stamp + Ticks(timings.FenceAfter));
                else
                    Lose(handle, Expired);
                break;
            case RenewalOutcome.Lost:
                Lose(handle, "The tenant lease was taken over, released or expired, or the tenant isn't active.");
                break;
            default:
                Unproved(handle);
                break;
        }
    }

    // A locked row: retried alone, waiting for the lock at most until the grant's deadline.
    private void Unproved(GrantHandle handle)
    {
        lock (gate)
            if (!live.Contains(handle) || !retrying.Add(handle))
                return;
        _ = Task.Run(async () =>
        {
            try
            {
                while (!stopping.IsCancellationRequested && handle.IsCurrent(clock()))
                {
                    if (await RetryOnceAsync(handle).ConfigureAwait(false) is not { } result)
                        continue;
                    if (result.Outcome != RenewalOutcome.Unproved)
                    {
                        Publish(handle, result.Outcome, result.Stamp);
                        return;
                    }
                }
            }
            catch (OperationCanceledException) { }
            finally
            {
                lock (gate)
                    retrying.Remove(handle);
            }
        });
    }

    // One locked-row attempt on the retry lane, waiting for the row lock at most until the
    // grant's deadline or one renew interval. Null when it proved nothing (lock timeout or a
    // failure); the stamp is taken on the lane, before the transaction.
    private async Task<(RenewalOutcome Outcome, long Stamp)?> RetryOnceAsync(GrantHandle handle)
    {
        await retryLane.WaitAsync(stopping.Token).ConfigureAwait(false);
        var failed = false;
        try
        {
            var stamp = clock();
            var remaining = TimeSpan.FromSeconds((double)(handle.Deadline - stamp) / Stopwatch.Frequency);
            if (remaining <= TimeSpan.Zero)
                return null;
            var wait = remaining < timings.RenewInterval ? remaining : timings.RenewInterval;
            var outcomes = await TenantLease
                .RenewBatchAsync(
                    control,
                    replica,
                    [(handle.Grant.TenantId, handle.Grant.Epoch)],
                    timings.Ttl,
                    wait,
                    skipLocked: false,
                    stopping.Token
                )
                .ConfigureAwait(false);
            return (outcomes[0], stamp);
        }
        catch (Npgsql.PostgresException error) when (error.SqlState == "55P03")
        {
            return null;
        }
        catch (Exception error) when (!stopping.IsCancellationRequested)
        {
            log?.Invoke("[lease] Renewing a locked grant failed: " + error.Message);
            failed = true;
            return null;
        }
        finally
        {
            retryLane.Release();
            if (failed)
                await Task.Delay(timings.RenewInterval / 4, stopping.Token).ConfigureAwait(false);
        }
    }

    private const string Expired = "No lease renewal succeeded within the fence deadline.";

    private async Task RenewLoopAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            var started = clock();
            try
            {
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                attempt.CancelAfter(timings.RenewInterval);
                // The client may not honour cancellation promptly on a dead path; the round's
                // bound holds regardless, and the watchdog fences at the deadlines meanwhile.
                var round = RenewOnceAsync(attempt.Token);
                _ = round.ContinueWith(
                    task => _ = task.Exception,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously
                );
                await round.WaitAsync(attempt.Token).ConfigureAwait(false);
            }
            catch (Exception) when (stopping.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                // Nothing is extended; the deadlines stand.
                log?.Invoke("[lease] Renewal failed: " + error.Message);
            }
            var elapsed = TimeSpan.FromSeconds((double)(clock() - started) / Stopwatch.Frequency);
            var delay = timings.RenewInterval - elapsed;
            if (delay > TimeSpan.Zero)
                try
                {
                    await Task.Delay(delay, stopping.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
        }
    }

    // Sleeps until the earliest deadline (or a new grant); on every wake, including a late one
    // after a stall, fences every grant whose deadline has passed.
    private async Task WatchdogAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            Task woken;
            long next = long.MaxValue;
            var now = clock();
            GrantHandle[] due;
            lock (gate)
            {
                due = [.. live.Where(handle => handle.Deadline <= now)];
                foreach (var handle in live)
                    if (handle.Deadline > now && handle.Deadline < next)
                        next = handle.Deadline;
                woken = wake.Task;
            }
            foreach (var handle in due)
                Lose(handle, Expired);
            var wait = next == long.MaxValue
                ? Timeout.InfiniteTimeSpan
                : TimeSpan.FromSeconds((double)(next - now) / Stopwatch.Frequency) + TimeSpan.FromMilliseconds(1);
            try
            {
                await Task.WhenAny(woken, Task.Delay(wait, stopping.Token)).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            lock (gate)
                if (wake.Task.IsCompleted)
                    wake = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    private void Wake()
    {
        lock (gate)
            wake.TrySetResult();
    }

    private static long Ticks(TimeSpan span) => (long)(span.TotalSeconds * Stopwatch.Frequency);

    public async ValueTask DisposeAsync()
    {
        try
        {
            stopping.Cancel();
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        if (loops is not null)
            await loops.ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
        stopping.Dispose();
    }
}
