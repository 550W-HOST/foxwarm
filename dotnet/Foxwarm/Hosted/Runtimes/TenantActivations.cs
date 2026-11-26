using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>What asked for an activation.</summary>
internal enum ActivationCause
{
    /// <summary>A front or mesh request.</summary>
    Request,

    /// <summary>A due wake-up row.</summary>
    Wakeup,

    /// <summary>A grant that expired without being released (a crashed owner).</summary>
    Recovery,
}

/// <summary>
/// A replica's tenant runtime generations (plan §2.3). Every activation of one tenant is
/// coalesced: a front request, a mesh activation, a wake-up and a recovery scan share one
/// acquire, build, start and publish. Waiters keep their own deadlines, and one that gives up
/// doesn't cancel the shared activation. A grant this replica holds is never acquired again:
/// a new generation over a held grant reuses it. A runtime is published, and its gate opens,
/// only after its start completed while its grant was still current; a build that finishes
/// after its grant was lost is disposed, never published.
/// </summary>
internal sealed class TenantActivations : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Slot> slots = new(StringComparer.Ordinal);
    private readonly PgDatabase database;
    private readonly string replica;
    private readonly int readerVersion;
    private readonly LeaseTimings timings;
    private readonly GenerationFactory factory;
    private readonly Func<long> clock;
    private readonly CancellationTokenSource stopping = new();
    private bool disposed;

    internal TenantActivations(
        PgDatabase database,
        string replica,
        int readerVersion,
        LeaseTimings timings,
        GenerationFactory factory,
        Func<long>? clock = null
    )
    {
        timings.Validate();
        this.database = database;
        this.replica = replica;
        this.readerVersion = readerVersion;
        this.timings = timings;
        this.factory = factory;
        this.clock = clock ?? System.Diagnostics.Stopwatch.GetTimestamp;
    }

    /// <summary>How long a failed start keeps every replica from trying again, by attempt.</summary>
    internal Func<int, TimeSpan> Backoff { get; init; } =
        attempt => TimeSpan.FromSeconds(Math.Min(3600, 5 * Math.Pow(2, Math.Max(0, attempt - 1))));

    /// <summary>
    /// The published generation of <paramref name="tenant"/>, activating it when there is none.
    /// Throws <see cref="TenantHeldElsewhereException"/> when another replica holds the lease,
    /// <see cref="LeaseRefusedException"/> when this binary may not take the tenant, and
    /// <see cref="TenantFencedException"/> when the grant was lost before publication.
    /// </summary>
    internal async Task<TenantGeneration> ActivateAsync(
        string tenant,
        ActivationCause cause = ActivationCause.Request,
        CancellationToken token = default
    )
    {
        Task<TenantGeneration> activation;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var slot = SlotOf(tenant);
            if (slot.Current is { } current)
                return current;
            if (slot.Releasing is not null)
                slot.Demand = true;
            slot.Autonomous |= cause != ActivationCause.Request;
            activation = slot.Activation ??= Task.Run(() => RunActivationAsync(slot));
        }
        return await activation.WaitAsync(token).ConfigureAwait(false);
    }

    /// <summary>
    /// Admits one unit of work into the tenant's published generation, activating it when
    /// needed. Work refused by a gate that latched meanwhile is counted as new demand, so an
    /// idle release in progress aborts and a new generation admits it.
    /// </summary>
    internal async Task<(TenantGeneration Generation, AdmissionGate.Admission Admission)> AdmitAsync(
        string tenant,
        ActivationCause cause = ActivationCause.Request,
        CancellationToken token = default
    )
    {
        while (true)
        {
            var generation = await ActivateAsync(tenant, cause, token).ConfigureAwait(false);
            if (generation.Gate.TryEnter() is { } admission)
                return (generation, admission);
            lock (gate)
                if (slots.TryGetValue(tenant, out var slot) && slot.Releasing is not null)
                    slot.Demand = true;
            await Task.Yield();
        }
    }

    /// <summary>The tenant's published generation, or null.</summary>
    internal TenantGeneration? Current(string tenant)
    {
        lock (gate)
            return slots.TryGetValue(tenant, out var slot) ? slot.Current : null;
    }

    /// <summary>
    /// Fences exactly <paramref name="id"/>: latches its gate, drops its grant and disposes it.
    /// False, changing nothing, when <paramref name="id"/> isn't the published generation, so a
    /// late fence never lands on its replacement. Returns once the runtime is disposed.
    /// </summary>
    internal async Task<bool> FenceAsync(GenerationId id)
    {
        TenantGeneration fenced;
        lock (gate)
        {
            if (!slots.TryGetValue(id.Tenant, out var slot) || slot.Current?.Id != id)
                return false;
            fenced = slot.Current;
            slot.Current = null;
            if (slot.Grant?.Grant.Epoch == id.Epoch)
                slot.Grant = null;
            fenced.Gate.Latch(AdmissionLatch.Fence);
        }
        await fenced.DisposeOnceAsync().ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// The lease of <paramref name="tenant"/> at <paramref name="epoch"/> is definitely lost:
    /// drops that grant and fences its published generation. An activation still building on
    /// it is disposed when it finishes. A loss reported for an older epoch changes nothing.
    /// </summary>
    internal async Task FenceGrantAsync(string tenant, long epoch)
    {
        GenerationId? published;
        lock (gate)
        {
            if (!slots.TryGetValue(tenant, out var slot))
                return;
            if (slot.Grant?.Grant.Epoch == epoch)
                slot.Grant = null;
            published = slot.Current?.Id.Epoch == epoch ? slot.Current.Id : null;
        }
        if (published is not null)
            await FenceAsync(published).ConfigureAwait(false);
    }

    /// <summary>
    /// Releases an idle tenant (plan §2.3): latches the gate when nothing is admitted and the
    /// runtime is idle, stops its producers, settles in-flight deliveries, computes the next
    /// due time, disposes the runtime (whose final saves still hold the lease), then writes the
    /// wake-up row and releases the lease in one transaction at the expected epoch. Work that
    /// arrives after the latch aborts the release: the lease stays, and the activation that work
    /// caused builds a new generation over it.
    /// </summary>
    internal async Task<IdleReleaseOutcome> TryReleaseIdleAsync(
        GenerationId id,
        TimeSpan idleAfter,
        CancellationToken token = default
    )
    {
        Slot slot;
        TenantGeneration generation;
        HeldGrant? held;
        TaskCompletionSource<IdleReleaseOutcome> done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (disposed || !slots.TryGetValue(id.Tenant, out slot!) || slot.Current?.Id != id)
                return IdleReleaseOutcome.NotCurrent;
            generation = slot.Current;
            if (slot.Activation is not null || slot.Releasing is not null)
                return IdleReleaseOutcome.Busy;
            if (!generation.Gate.TryLatchIdle(idleAfter, () => generation.Runtime.Idle))
                return IdleReleaseOutcome.Busy;
            slot.Current = null;
            slot.Demand = false;
            slot.Releasing = done.Task;
            held = slot.Grant;
        }
        var outcome = IdleReleaseOutcome.Aborted;
        try
        {
            await generation.Runtime.StopProducersAsync(token).ConfigureAwait(false);
            await generation.Runtime.SettleAsync(token).ConfigureAwait(false);
            var due = await generation.Runtime.NextDueAsync(token).ConfigureAwait(false);
            await generation.DisposeOnceAsync().ConfigureAwait(false);
            lock (gate)
            {
                if (held is null || slot.Grant != held)
                    outcome = IdleReleaseOutcome.Fenced;
                else if (slot.Demand || disposed)
                    outcome = IdleReleaseOutcome.Aborted;
                else
                    outcome = IdleReleaseOutcome.Released;
            }
            if (outcome == IdleReleaseOutcome.Released)
            {
                var released = await slot.Lease.ReleaseWithWakeupAsync(held!.Grant, due, token)
                    .ConfigureAwait(false);
                outcome = released ? IdleReleaseOutcome.Released : IdleReleaseOutcome.Fenced;
                lock (gate)
                    if (slot.Grant == held)
                        slot.Grant = null;
            }
            return outcome;
        }
        finally
        {
            // A failed step keeps the grant; the runtime is disposed either way, and the next
            // activation builds a new generation.
            await generation.DisposeOnceAsync().ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
            lock (gate)
                slot.Releasing = null;
            done.TrySetResult(outcome);
        }
    }

    private Slot SlotOf(string tenant)
    {
        if (!slots.TryGetValue(tenant, out var slot))
            slots[tenant] = slot = new(new TenantLease(database, tenant, readerVersion));
        return slot;
    }

    private async Task<TenantGeneration> RunActivationAsync(Slot slot)
    {
        // Set when publication cleared the slot's activation under the lock; until then the
        // slot's activation is this one, and no other can start.
        var cleared = false;
        try
        {
            Task? releasing;
            lock (gate)
                releasing = slot.Releasing;
            if (releasing is not null)
                await releasing.ConfigureAwait(false);

            HeldGrant? held;
            lock (gate)
            {
                held = slot.Grant;
                if (held is not null && clock() >= held.ValidUntil)
                    slot.Grant = held = null;
            }
            if (held is null)
            {
                // No live grant here: the only acquisition. A grant this replica holds is reused.
                var acquired =
                    await slot.Lease.TryAcquireAsync(replica, timings.Ttl, timings.RenewInterval, stopping.Token)
                        .ConfigureAwait(false)
                    ?? throw new TenantHeldElsewhereException(slot.Lease.Tenant);
                held = new HeldGrant(acquired, acquired.AcquisitionStart + Ticks(timings.FenceAfter));
                lock (gate)
                    slot.Grant = held;
            }
            var grant = held.Grant;
            var wakeup = await slot.Lease.ReadWakeupAsync(grant.TenantId, stopping.Token).ConfigureAwait(false);
            GenerationId id;
            lock (gate)
                id = new(grant.TenantId, slot.Lease.Tenant, grant.Epoch, ++slot.Generations);
            var admission = new AdmissionGate(clock);
            IGenerationRuntime? runtime = null;
            try
            {
                runtime = await factory(new(id, grant, admission, wakeup), stopping.Token).ConfigureAwait(false);
                await runtime.StartAsync(stopping.Token).ConfigureAwait(false);
            }
            catch
            {
                if (runtime is not null)
                    await runtime.DisposeAsync().AsTask().ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
                await FailedStartAsync(slot, held, wakeup).ConfigureAwait(false);
                throw;
            }
            var generation = new TenantGeneration(id, grant, admission, runtime);
            bool published;
            lock (gate)
            {
                published = !disposed && slot.Grant == held && clock() < held.ValidUntil;
                if (published)
                {
                    slot.Current = generation;
                    slot.Activation = null;
                    cleared = true;
                    slot.Autonomous = false;
                    admission.Open();
                }
            }
            if (!published)
            {
                admission.Latch(AdmissionLatch.Fence);
                await generation.DisposeOnceAsync().ConfigureAwait(false);
                throw new TenantFencedException(
                    $"Tenant {id.Tenant} lost its lease at epoch {id.Epoch} before its runtime was published."
                );
            }
            return generation;
        }
        finally
        {
            if (!cleared)
                lock (gate)
                {
                    slot.Activation = null;
                    slot.Autonomous = false;
                }
        }
    }

    // A start that failed: record the backoff, release the grant and let a scan retry.
    private async Task FailedStartAsync(Slot slot, HeldGrant held, WakeupRow? wakeup)
    {
        bool autonomous;
        lock (gate)
        {
            // At shutdown the grant is released plainly by DisposeAsync, without a backoff.
            if (slot.Grant != held || disposed)
                return;
            slot.Grant = null;
            autonomous = slot.Autonomous;
            slot.Autonomous = false;
        }
        try
        {
            await slot.Lease.ReleaseAfterFailedStartAsync(
                    held.Grant,
                    Backoff((wakeup?.Attempts ?? 0) + 1),
                    autonomous,
                    CancellationToken.None
                )
                .ConfigureAwait(false);
        }
        catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException)
        {
            // Unreleased, the grant expires within one TTL and the recovery scan finds it.
        }
    }

    private static long Ticks(TimeSpan span) =>
        (long)(span.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);

    public async ValueTask DisposeAsync()
    {
        List<TenantGeneration> current = [];
        List<Task> pending = [];
        List<(TenantLease Lease, LeaseGrant Grant)> grants = [];
        lock (gate)
        {
            if (disposed)
                return;
            disposed = true;
            foreach (var slot in slots.Values)
            {
                if (slot.Current is { } generation)
                {
                    generation.Gate.Latch(AdmissionLatch.Stop);
                    current.Add(generation);
                    slot.Current = null;
                }
                if (slot.Activation is { } activation)
                    pending.Add(activation);
                if (slot.Releasing is { } releasing)
                    pending.Add(releasing);
            }
        }
        stopping.Cancel();
        foreach (var task in pending)
            await task.ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
        foreach (var generation in current)
            await generation.DisposeOnceAsync().ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
        lock (gate)
            foreach (var slot in slots.Values)
                if (slot.Grant is { } held)
                {
                    grants.Add((slot.Lease, held.Grant));
                    slot.Grant = null;
                }
        foreach (var (lease, grant) in grants)
            try
            {
                await lease.ReleaseAsync(grant, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException) { }
        stopping.Dispose();
    }

    // The grant this replica holds for a tenant and its local validity deadline (a Stopwatch
    // timestamp). Renewal moves the deadline; reaching it means the grant is lost.
    private sealed class HeldGrant(LeaseGrant grant, long validUntil)
    {
        internal LeaseGrant Grant { get; } = grant;
        internal long ValidUntil { get; set; } = validUntil;
    }

    private sealed class Slot(TenantLease lease)
    {
        internal TenantLease Lease { get; } = lease;
        internal Task<TenantGeneration>? Activation { get; set; }
        internal TenantGeneration? Current { get; set; }
        internal HeldGrant? Grant { get; set; }
        internal long Generations { get; set; }
        internal Task<IdleReleaseOutcome>? Releasing { get; set; }
        // Work that arrived while an idle release ran; it aborts the release.
        internal bool Demand { get; set; }
        // A coalesced waiter came from a wake-up or recovery scan, not only from requests.
        internal bool Autonomous { get; set; }
    }
}
