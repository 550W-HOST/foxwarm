using System.Diagnostics;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Lease;

/// <summary>
/// One tenant lease grant this replica holds, as the renewer tracks it. Its deadline is a
/// <see cref="Stopwatch"/> timestamp: the start of the last positive proof (the acquisition, or
/// a renewal batch's stamp taken before its transaction) plus <see cref="LeaseTimings.FenceAfter"/>.
/// The grant is current until the deadline or until it is lost, whichever comes first; a lost
/// handle never becomes current again. Proof and loss are decided under one lock against the
/// clock read inside it, so a proof that arrives after the deadline can't extend it. The loss
/// instant is state recorded by that decision (the deadline itself when the grant expired),
/// not the time a handler happens to run; every hard stop counts from it.
/// </summary>
internal sealed class GrantHandle
{
    private readonly object state = new();
    private readonly TaskCompletionSource<string> lost = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<Action<GrantHandle>> onLoss = [];
    private readonly Func<long> clock;
    private long deadline;
    private long lostAt;
    private bool isLost;

    internal GrantHandle(LeaseGrant grant, long deadline, Func<long>? clock = null)
    {
        Grant = grant;
        this.deadline = deadline;
        this.clock = clock ?? Stopwatch.GetTimestamp;
    }

    internal LeaseGrant Grant { get; }

    internal long Deadline
    {
        get
        {
            lock (state)
                return deadline;
        }
    }

    /// <summary>Completes with the reason once the grant is lost or given up.</summary>
    internal Task<string> Lost => lost.Task;

    internal bool IsCurrent(long now)
    {
        lock (state)
            return !isLost && now < deadline;
    }

    /// <summary>Whether the grant is current now, by the handle's own clock.</summary>
    internal bool IsCurrent() => IsCurrent(clock());

    /// <summary>
    /// When the grant stopped being current: the recorded loss instant, or the deadline once it
    /// has passed; <see cref="long.MaxValue"/> while current.
    /// </summary>
    internal long EndedAt(long now)
    {
        lock (state)
            return isLost ? lostAt : now >= deadline ? deadline : long.MaxValue;
    }

    /// <summary>
    /// The latest instant anything running under the grant may still run: the loss instant (or,
    /// while current, the deadline) plus <paramref name="drain"/>, in <see cref="Stopwatch"/> ticks.
    /// Moves forward only with a positive proof, and back only to a recorded loss.
    /// </summary>
    internal long HardStop(long drain)
    {
        lock (state)
            return (isLost ? lostAt : deadline) + drain;
    }

    /// <summary>
    /// A positive proof: moves the deadline forward (never back). False, changing nothing, when
    /// the grant is lost or its deadline has already passed by the clock read under the lock.
    /// </summary>
    internal bool Prove(long deadlineFromProof)
    {
        lock (state)
        {
            if (isLost || clock() >= deadline)
                return false;
            if (deadlineFromProof > deadline)
                deadline = deadlineFromProof;
            return true;
        }
    }

    /// <summary>
    /// Runs <paramref name="hook"/> inline when the grant is lost, on the deciding thread; at
    /// once when it is already lost. Hooks must not block: they latch and close, nothing more.
    /// </summary>
    internal void OnLoss(Action<GrantHandle> hook)
    {
        lock (state)
            if (!isLost)
            {
                onLoss.Add(hook);
                return;
            }
        Run(hook);
    }

    /// <summary>
    /// Decides the loss once: records its instant (the deadline when that came first), runs the
    /// hooks inline, then completes <see cref="Lost"/>. False when already lost.
    /// </summary>
    internal bool TryLose(string reason) => End(reason, lost: true);

    /// <summary>
    /// Ends a grant that is being released: not current from now on, but not a loss, so the
    /// loss hooks don't run. False when already ended.
    /// </summary>
    internal bool TryRelease(string reason) => End(reason, lost: false);

    private bool End(string reason, bool lost)
    {
        Action<GrantHandle>[] hooks;
        lock (state)
        {
            if (isLost)
                return false;
            isLost = true;
            lostAt = Math.Min(clock(), deadline);
            hooks = lost ? [.. onLoss] : [];
            onLoss.Clear();
        }
        foreach (var hook in hooks)
            Run(hook);
        this.lost.TrySetResult(reason);
        return true;
    }

    private void Run(Action<GrantHandle> hook)
    {
        try
        {
            hook(this);
        }
        catch { }
    }
}

/// <summary>
/// Renews every grant a replica holds (plan §3.2). Each round takes an immutable batch of the
/// live grants with a monotonic stamp taken with the batch, before its transaction, renews them
/// in one statement under the per-row predicate on a data source reserved for the periodic
/// batch, and publishes the outcomes only after the commit, only to the handles of that batch,
/// and only while each is still current. A grant acquired after the stamp isn't in the batch
/// and keeps its own acquisition stamp. A row another transaction holds locked, or a batch that
/// hits the lock timeout, is unproved: each such row is retried on its own on the control data
/// source (shared with acquisitions and releases), with a lock wait bounded by its deadline,
/// until that deadline; a row that no longer matches is lost at once.
/// One watchdog thread, independent of the thread pool, loses every grant at its deadline,
/// whether or not a renewal is still blocked; a result that arrives after the deadline never
/// revives the grant. Holding no grants starts no countdown.
/// </summary>
internal sealed class GrantRenewer : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly HashSet<GrantHandle> live = [];
    private readonly HashSet<GrantHandle> retrying = [];
    private readonly PgDatabase batches;
    private readonly PgDatabase control;
    private readonly string replica;
    private readonly LeaseTimings timings;
    private readonly Func<long> clock;
    private readonly Action<string>? log;
    private readonly CancellationTokenSource stopping = new();
    // Single-row retries take one control connection at a time, so acquisitions and releases
    // keep the other.
    private readonly SemaphoreSlim retryLane = new(1, 1);
    private readonly AutoResetEvent wake = new(false);
    private Task? loop;
    private Thread? watchdog;

    /// <param name="batches">
    /// The data source reserved for the periodic batch (<see cref="PgDatabase.Renewal"/>): nothing
    /// else uses it, so no control traffic can queue ahead of a renewal.
    /// </param>
    /// <param name="control">The control data source, for retries of unproved rows.</param>
    internal GrantRenewer(
        PgDatabase batches,
        PgDatabase control,
        string replica,
        LeaseTimings timings,
        Action<string>? log = null,
        Func<long>? clock = null
    )
    {
        timings.Validate();
        this.batches = batches;
        this.control = control;
        this.replica = replica;
        this.timings = timings;
        this.log = log;
        this.clock = clock ?? Stopwatch.GetTimestamp;
    }


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
        var handle = new GrantHandle(grant, start + Ticks(timings.FenceAfter), clock);
        lock (gate)
            live.Add(handle);
        Wake();
        return handle;
    }

    /// <summary>
    /// The grant is definitely lost (a refused write, a takeover, its deadline): decides the
    /// loss now, running the handle's hooks inline. The log line is queued, never awaited.
    /// </summary>
    internal void Lose(GrantHandle handle, string reason)
    {
        lock (gate)
            live.Remove(handle);
        if (handle.TryLose(reason) && log is { } write)
            ThreadPool.UnsafeQueueUserWorkItem(
                _ => write($"[lease] Tenant {handle.Grant.Tenant} epoch {handle.Grant.Epoch} lost: {reason}"),
                null
            );
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
        handle.TryRelease(reason);
    }

    internal void Start()
    {
        if (loop is not null)
            return;
        loop = Task.Run(RenewLoopAsync);
        watchdog = new Thread(Watch) { IsBackground = true, Name = "Foxwarm lease watchdog" };
        watchdog.Start();
    }

    /// <summary>One renewal round over every live grant; the loop calls it every renew interval.</summary>
    internal async Task RenewOnceAsync(CancellationToken token = default)
    {
        long stamp;
        GrantHandle[] batch;
        // The stamp and the membership are taken together: a grant tracked after the stamp is
        // in a later batch.
        lock (gate)
        {
            stamp = clock();
            batch = [.. live.Where(handle => handle.IsCurrent(stamp))];
        }
        if (batch.Length == 0)
            return;
        RenewalOutcome[] outcomes;
        try
        {
            outcomes = await TenantLease
                .RenewBatchAsync(
                    batches,
                    replica,
                    [.. batch.Select(handle => handle.Grant)],
                    timings.Ttl,
                    timings.RenewInterval / 2,
                    skipLocked: true,
                    token
                )
                .ConfigureAwait(false);
        }
        catch (Npgsql.PostgresException error) when (error.SqlState == "55P03")
        {
            // Proves nothing; each row is retried on its own within its own deadline.
            foreach (var handle in batch)
                Unproved(handle);
            return;
        }
        for (var index = 0; index < batch.Length; index++)
            Publish(batch[index], outcomes[index], stamp);
    }

    internal event Action<LeaseGrant, bool>? SettingsChanged;

    // Applies one committed outcome to the handle of the batch it was taken for.
    private void Publish(GrantHandle handle, RenewalOutcome outcome, long stamp)
    {
        switch (outcome)
        {
            case RenewalOutcome.CredentialRotated:
            case RenewalOutcome.SettingsChanged:
                SettingsChanged?.Invoke(handle.Grant, outcome == RenewalOutcome.CredentialRotated);
                goto case RenewalOutcome.Renewed;
            case RenewalOutcome.Renewed:
                // Decided against the deadline under the handle's lock: a success that arrives
                // after it doesn't revive the grant.
                if (!handle.Prove(stamp + Ticks(timings.FenceAfter)))
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
                while (!stopping.IsCancellationRequested && Tracked(handle))
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
            // Checked on the lane, just before the attempt starts: a grant lost or released
            // while this retry waited for the lane is never renewed again.
            if (!Tracked(handle))
                return null;
            var stamp = clock();
            var remaining = TimeSpan.FromSeconds((double)(handle.Deadline - stamp) / Stopwatch.Frequency);
            if (remaining <= TimeSpan.Zero)
                return null;
            var wait = remaining < timings.RenewInterval ? remaining : timings.RenewInterval;
            var outcomes = await TenantLease
                .RenewBatchAsync(
                    control,
                    replica,
                    [handle.Grant],
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

    // Still tracked and current: what every new renewal attempt requires.
    private bool Tracked(GrantHandle handle)
    {
        lock (gate)
            return live.Contains(handle) && handle.IsCurrent(clock());
    }

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

    // A dedicated thread: sleeps until the earliest deadline (or a new grant); on every wake,
    // including a late one after a stall, loses every grant whose deadline has passed. The loss
    // instant is each deadline, however late the thread runs.
    private void Watch()
    {
        while (!stopping.IsCancellationRequested)
        {
            var now = clock();
            long next = long.MaxValue;
            GrantHandle[] due;
            lock (gate)
            {
                due = [.. live.Where(handle => handle.Deadline <= now)];
                foreach (var handle in live)
                    if (handle.Deadline > now && handle.Deadline < next)
                        next = handle.Deadline;
            }
            foreach (var handle in due)
                Lose(handle, Expired);
            var wait = next == long.MaxValue
                ? Timeout.Infinite
                : (int)Math.Min(int.MaxValue, Math.Ceiling((double)(next - now) * 1000 / Stopwatch.Frequency) + 1);
            try
            {
                WaitHandle.WaitAny([wake, stopping.Token.WaitHandle], wait);
            }
            catch (ObjectDisposedException)
            {
                return;
            }
        }
    }

    private void Wake()
    {
        try
        {
            wake.Set();
        }
        catch (ObjectDisposedException) { }
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
        if (loop is not null)
            await loop.ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
        watchdog?.Join();
        stopping.Dispose();
        wake.Dispose();
    }
}
