namespace Foxwarm.Limits;

/// <summary>
/// The resident Session owners of one runtime that memory pressure may release: the least
/// recently used owner with nothing live in process (<c>IdleReleaseBlocker</c> null), whatever
/// its quiet period.
/// </summary>
internal interface IHotOwnerReleaser
{
    /// <summary>The latest admission (monotonic milliseconds) of the owner that would go first.</summary>
    long? OldestIdle();

    /// <summary>Releases that owner; false when none could be released.</summary>
    bool ReleaseOldestIdle();
}

/// <summary>
/// The replica's budget for resident owners across the tenants it serves (plan P2 §7.2: 70% of
/// the container's memory). Tenant budgets charge it as well as their own.
/// </summary>
internal sealed class HotOwnerPool(long limit)
{
    internal readonly object Gate = new();
    private readonly List<IHotOwnerReleaser> releasers = [];
    private TaskCompletionSource changed = NewSignal();

    internal long Limit { get; } = limit;

    // Under Gate.
    internal long Used;

    internal long UsedBytes
    {
        get
        {
            lock (Gate)
                return Used;
        }
    }

    internal void Register(IHotOwnerReleaser releaser)
    {
        lock (Gate)
            releasers.Add(releaser);
    }

    internal void Unregister(IHotOwnerReleaser releaser)
    {
        lock (Gate)
            releasers.Remove(releaser);
        Signal();
    }

    internal IHotOwnerReleaser[] Releasers()
    {
        lock (Gate)
            return [.. releasers];
    }

    // A charge shrank or ended: waiting admissions look again.
    internal void Signal()
    {
        TaskCompletionSource previous;
        lock (Gate)
        {
            previous = changed;
            changed = NewSignal();
        }
        previous.TrySetResult();
    }

    internal Task Changed
    {
        get
        {
            lock (Gate)
                return changed.Task;
        }
    }

    private static TaskCompletionSource NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

/// <summary>
/// One tenant's budget for resident Session owners, in estimated bytes (plan P2 §7.2). Loading
/// an owner reserves its estimate; over the tenant's or the replica's budget, the least
/// recently used idle owner (of this tenant, or of any tenant for the replica's budget) is
/// released first, then the load waits for room, up to <see cref="Wait"/>. An owner alone in
/// its budget is always admitted, so one oversized Session still opens.
/// </summary>
internal sealed class HotOwnerBudget : IDisposable
{
    /// <summary>
    /// An owner holds about ten times its history JSON in managed memory (the P2 sizing probe:
    /// parsed elements, projections and caches), plus a fixed part for an empty owner.
    /// </summary>
    internal const int HistoryFactor = 10;

    internal const long OwnerFloorBytes = 256 * 1024;

    internal static readonly TimeSpan DefaultWait = TimeSpan.FromSeconds(30);

    // Bounds the releases one admission tries before it waits.
    private const int ReleaseAttempts = 16;

    private readonly HotOwnerPool tenant;
    private readonly HotOwnerPool? replica;
    private readonly IHotOwnerReleaser releaser;

    internal HotOwnerBudget(
        long limit,
        HotOwnerPool? replica,
        IHotOwnerReleaser releaser,
        TimeSpan? wait = null
    )
    {
        tenant = new HotOwnerPool(limit);
        tenant.Register(releaser);
        this.replica = replica;
        this.releaser = releaser;
        replica?.Register(releaser);
        Wait = wait ?? DefaultWait;
    }

    internal TimeSpan Wait { get; }

    internal long Limit => tenant.Limit;

    internal long UsedBytes
    {
        get
        {
            lock (Gate)
                return tenant.Used;
        }
    }

    /// <summary>The estimate for an owner with this much history JSON.</summary>
    internal static long Estimate(long historyJsonBytes) =>
        OwnerFloorBytes + HistoryFactor * Math.Max(0, historyJsonBytes);

    /// <summary>Reserves an owner's estimate, releasing idle owners or waiting for room.</summary>
    internal async Task<Charge> ReserveAsync(long bytes, CancellationToken token = default)
    {
        var deadline = Environment.TickCount64 + (long)Wait.TotalMilliseconds;
        while (true)
        {
            // Taken before the check, so a release after it wakes the wait below.
            var tenantChanged = tenant.Changed;
            var replicaChanged = replica?.Changed ?? tenantChanged;
            if (TryCharge(bytes, out var charge))
                return charge;
            if (ReleaseFor(bytes))
                continue;
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
                throw Exhausted();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            await Task.WhenAny(
                    tenantChanged,
                    replicaChanged,
                    Task.Delay(TimeSpan.FromMilliseconds(remaining), timeout.Token)
                )
                .ConfigureAwait(false);
            timeout.Cancel();
            token.ThrowIfCancellationRequested();
        }
    }

    /// <summary>
    /// Charges an owner that already exists (a Session just created), then releases idle owners
    /// while the budgets are exceeded. Never waits or fails.
    /// </summary>
    internal Charge Force(long bytes)
    {
        Charge charge;
        lock (Gate)
            charge = Add(bytes);
        for (var attempt = 0; attempt < ReleaseAttempts && Over(0); attempt++)
            if (!ReleaseFor(0))
                break;
        return charge;
    }

    private object Gate => replica?.Gate ?? tenant.Gate;

    private bool TryCharge(long bytes, out Charge charge)
    {
        lock (Gate)
        {
            if (!Over(bytes))
            {
                charge = Add(bytes);
                return true;
            }
        }
        charge = null!;
        return false;
    }

    // Under Gate, or a racy read for the release loop.
    private bool Over(long bytes) => TenantOver(bytes) || ReplicaOver(bytes);

    private bool TenantOver(long bytes) =>
        bytes == 0 ? tenant.Used > tenant.Limit : tenant.Used > 0 && tenant.Used + bytes > tenant.Limit;

    private bool ReplicaOver(long bytes) =>
        replica is not null
        && (bytes == 0 ? replica.Used > replica.Limit : replica.Used > 0 && replica.Used + bytes > replica.Limit);

    // Under Gate.
    private Charge Add(long bytes)
    {
        tenant.Used += bytes;
        if (replica is not null)
            replica.Used += bytes;
        return new Charge(this, bytes);
    }

    // Releases the owner that should go first for this admission; false when there is none.
    // Releasing takes the releasers' own locks, so it runs outside Gate.
    private bool ReleaseFor(long bytes)
    {
        for (var attempt = 0; attempt < ReleaseAttempts; attempt++)
        {
            bool tenantOver, replicaOver;
            lock (Gate)
            {
                tenantOver = TenantOver(bytes);
                replicaOver = ReplicaOver(bytes);
            }
            IHotOwnerReleaser? candidate = null;
            if (tenantOver && releaser.OldestIdle() is not null)
                candidate = releaser;
            else if (replicaOver)
                candidate = replica!
                    .Releasers()
                    .Select(item => (Releaser: item, Use: item.OldestIdle()))
                    .Where(item => item.Use is not null)
                    .OrderBy(item => item.Use)
                    .Select(item => item.Releaser)
                    .FirstOrDefault();
            if (candidate is null)
                return false;
            if (candidate.ReleaseOldestIdle())
                return true;
        }
        return false;
    }

    private TenantLimitException Exhausted() =>
        new(
            "hotOwnerBytes",
            "Too many Sessions are open at once. Try again when another Session has finished."
        );

    public void Dispose()
    {
        tenant.Unregister(releaser);
        replica?.Unregister(releaser);
    }

    /// <summary>An owner's reservation; disposed when the owner leaves memory.</summary>
    internal sealed class Charge(HotOwnerBudget owner, long bytes) : IDisposable
    {
        private long current = bytes;
        private bool released;

        internal long Bytes
        {
            get
            {
                lock (owner.Gate)
                    return current;
            }
        }

        /// <summary>Re-estimates a resident owner; growth never waits, it is released later.</summary>
        internal void Resize(long bytes)
        {
            long delta;
            lock (owner.Gate)
            {
                if (released)
                    return;
                delta = bytes - current;
                current = bytes;
                owner.tenant.Used += delta;
                if (owner.replica is not null)
                    owner.replica.Used += delta;
            }
            if (delta < 0)
                owner.Signal();
        }

        public void Dispose()
        {
            lock (owner.Gate)
            {
                if (released)
                    return;
                released = true;
                owner.tenant.Used -= current;
                if (owner.replica is not null)
                    owner.replica.Used -= current;
            }
            owner.Signal();
        }
    }

    private void Signal()
    {
        tenant.Signal();
        replica?.Signal();
    }
}
