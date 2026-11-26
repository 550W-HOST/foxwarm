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
/// after its grant was lost is disposed, never published. Grants are renewed by the replica's
/// <see cref="GrantRenewer"/>; a lost grant fences its generation through the
/// <see cref="FenceSupervisor"/>, whether that generation is building, published or stopping.
/// </summary>
internal sealed class TenantActivations : IAsyncDisposable
{
    private const string Expired = "No lease renewal succeeded within the fence deadline.";

    private readonly object gate = new();
    private readonly Dictionary<string, Slot> slots = new(StringComparer.Ordinal);
    private readonly PgDatabase control;
    private readonly string replica;
    private readonly int readerVersion;
    private readonly LeaseTimings timings;
    private readonly GenerationFactory factory;
    private readonly GrantRenewer renewer;
    private readonly FenceSupervisor supervisor;
    private readonly Func<long> clock;
    private readonly CancellationTokenSource stopping = new();
    private bool disposed;

    /// <param name="control">The replica's control data source: acquisition, wake-ups and releases.</param>
    internal TenantActivations(
        PgDatabase control,
        string replica,
        int readerVersion,
        LeaseTimings timings,
        GenerationFactory factory,
        GrantRenewer renewer,
        FenceSupervisor supervisor,
        Func<long>? clock = null
    )
    {
        timings.Validate();
        this.control = control;
        this.replica = replica;
        this.readerVersion = readerVersion;
        this.timings = timings;
        this.factory = factory;
        this.renewer = renewer;
        this.supervisor = supervisor;
        this.clock = clock ?? System.Diagnostics.Stopwatch.GetTimestamp;
        renewer.GrantLost += (handle, reason) => _ = FenceHandleAsync(handle);
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
    /// Fences exactly <paramref name="id"/>, published or stopping: supervised as
    /// <see cref="FenceSupervisor.FenceAsync"/> describes, and its grant is lost (never
    /// released). False, changing nothing, when <paramref name="id"/> isn't such a generation,
    /// so a late fence never lands on its replacement. Returns once the stop is confirmed, or
    /// once the supervisor gave up on it.
    /// </summary>
    internal async Task<bool> FenceAsync(GenerationId id, string reason = "fenced")
    {
        TenantGeneration fenced;
        Task<bool> supervision;
        lock (gate)
        {
            if (!slots.TryGetValue(id.Tenant, out var slot))
                return false;
            if (slot.Current?.Id == id)
            {
                fenced = slot.Current;
                slot.Current = null;
            }
            else if (slot.Stopping?.Id == id)
                fenced = slot.Stopping;
            else
                return false;
            if (slot.Grant == fenced.Handle)
                slot.Grant = null;
            fenced.Gate.Latch(AdmissionLatch.Fence);
            // The supervisor's synchronous steps don't block; starting it here makes a second
            // fence of the same generation join this one.
            supervision = fenced.Supervision ??= SuperviseAsync(fenced, reason);
        }
        return await supervision.ConfigureAwait(false);
    }

    /// <summary>
    /// The lease of <paramref name="tenant"/> at <paramref name="epoch"/> is definitely lost:
    /// drops that grant and fences its generation. An activation still building on it is
    /// fenced too. A loss reported for another epoch changes nothing.
    /// </summary>
    internal async Task FenceGrantAsync(string tenant, long epoch)
    {
        GrantHandle? handle = null;
        lock (gate)
            if (slots.TryGetValue(tenant, out var slot))
                handle = new[] { slot.Grant, slot.Current?.Handle, slot.Stopping?.Handle, slot.Building?.Handle }
                    .FirstOrDefault(candidate => candidate?.Grant.Epoch == epoch);
        if (handle is not null)
        {
            renewer.Lose(handle, "The tenant lease was lost.");
            await FenceHandleAsync(handle).ConfigureAwait(false);
        }
    }

    // Everything running under a lost grant is fenced: the published or stopping generation,
    // and a build in progress. Matching is by handle, so epoch e never touches e+1.
    private async Task FenceHandleAsync(GrantHandle handle)
    {
        TenantGeneration? fenced = null;
        Building? building = null;
        var reason = handle.Lost.IsCompleted ? await handle.Lost.ConfigureAwait(false) : "fenced";
        var fences = new List<Task>();
        lock (gate)
        {
            if (!slots.TryGetValue(handle.Grant.Tenant, out var slot))
                return;
            if (slot.Grant == handle)
                slot.Grant = null;
            if (slot.Current?.Handle == handle)
            {
                fenced = slot.Current;
                slot.Current = null;
            }
            else if (slot.Stopping?.Handle == handle)
                fenced = slot.Stopping;
            if (slot.Building?.Handle == handle)
                building = slot.Building;
            fenced?.Gate.Latch(AdmissionLatch.Fence);
            building?.Gate.Latch(AdmissionLatch.Fence);
            if (fenced is not null)
                fences.Add(fenced.Supervision ??= SuperviseAsync(fenced, reason));
            if (building is not null)
                fences.Add(building.Supervision ??= supervisor.FenceAsync(
                    $"the start of {building.Id}",
                    System.Diagnostics.Stopwatch.GetTimestamp(),
                    () => building.Gate.Latch(AdmissionLatch.Fence),
                    () => { },
                    building.Fence,
                    // The activation disposes what it built once its start returns.
                    () => building.Done,
                    () => true
                ));
        }
        await Task.WhenAll(fences).ConfigureAwait(false);
    }

    private Task<bool> SuperviseAsync(TenantGeneration generation, string reason) =>
        supervisor.FenceAsync(
            generation.Id.ToString(),
            System.Diagnostics.Stopwatch.GetTimestamp(),
            () => generation.Gate.Latch(AdmissionLatch.Fence),
            () => renewer.Lose(generation.Handle, reason),
            generation.Fence,
            generation.DisposeOnceAsync,
            () => generation.Gate.DrainedAsync().IsCompleted
        );

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
        GrantHandle? held;
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
            slot.Stopping = generation;
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
            if (!await DisposeConfirmedAsync(slot, generation).ConfigureAwait(false))
                return outcome = IdleReleaseOutcome.StopFailed;
            lock (gate)
            {
                if (held is null || slot.Grant != held || !held.IsCurrent(clock()))
                    outcome = IdleReleaseOutcome.Fenced;
                else if (slot.Demand || disposed)
                    outcome = IdleReleaseOutcome.Aborted;
                else
                {
                    outcome = IdleReleaseOutcome.Released;
                    slot.Grant = null;
                }
            }
            if (outcome == IdleReleaseOutcome.Released)
            {
                renewer.Untrack(held!);
                var released = await slot.Lease.ReleaseWithWakeupAsync(held!.Grant, due, token)
                    .ConfigureAwait(false);
                outcome = released ? IdleReleaseOutcome.Released : IdleReleaseOutcome.Fenced;
            }
            return outcome;
        }
        finally
        {
            // A failed step keeps the grant; the runtime is disposed either way, and the next
            // activation builds a new generation. A disposal that failed drops the grant.
            if (outcome != IdleReleaseOutcome.StopFailed)
                await DisposeConfirmedAsync(slot, generation).ConfigureAwait(false);
            lock (gate)
            {
                slot.Releasing = null;
                if (slot.Stopping == generation)
                    slot.Stopping = null;
            }
            done.TrySetResult(outcome);
        }
    }

    // Disposes a generation that is stopping gracefully. A disposal that fails leaves its stop
    // unconfirmed: the databases close, the grant is lost without a release, and when work is
    // still admitted the supervisor ends the process at the deadline.
    private async Task<bool> DisposeConfirmedAsync(Slot slot, TenantGeneration generation)
    {
        var disposal = generation.DisposeOnceAsync();
        try
        {
            await disposal.ConfigureAwait(false);
            return true;
        }
        catch (Exception)
        {
            generation.Fence.Close();
            lock (gate)
                if (slot.Grant == generation.Handle)
                    slot.Grant = null;
            renewer.Lose(generation.Handle, "The runtime's stop failed; its grant isn't released.");
            if (!generation.Gate.DrainedAsync().IsCompleted)
                await supervisor
                    .JoinAsync(generation.Id.ToString(), System.Diagnostics.Stopwatch.GetTimestamp(), disposal, () => generation.Gate.DrainedAsync().IsCompleted)
                    .ConfigureAwait(false);
            return false;
        }
    }

    private Slot SlotOf(string tenant)
    {
        if (!slots.TryGetValue(tenant, out var slot))
            slots[tenant] = slot = new(new TenantLease(control, tenant, readerVersion));
        return slot;
    }

    private async Task<TenantGeneration> RunActivationAsync(Slot slot)
    {
        // Set when publication cleared the slot's activation under the lock; until then the
        // slot's activation is this one, and no other can start.
        var cleared = false;
        Building? building = null;
        try
        {
            Task? releasing;
            lock (gate)
                releasing = slot.Releasing;
            if (releasing is not null)
                await releasing.ConfigureAwait(false);

            GrantHandle? held;
            lock (gate)
            {
                held = slot.Grant;
                if (held is not null && !held.IsCurrent(clock()))
                    slot.Grant = null;
            }
            if (held is not null && !held.IsCurrent(clock()))
            {
                renewer.Lose(held, Expired);
                held = null;
            }
            if (held is null)
            {
                // No live grant here: the only acquisition. A grant this replica holds is reused.
                var acquired =
                    await slot.Lease.TryAcquireAsync(replica, timings.Ttl, timings.RenewInterval, stopping.Token)
                        .ConfigureAwait(false)
                    ?? throw new TenantHeldElsewhereException(slot.Lease.Tenant);
                held = renewer.Track(acquired);
                lock (gate)
                    slot.Grant = held;
            }
            var grant = held.Grant;
            var wakeup = await slot.Lease.ReadWakeupAsync(grant.TenantId, stopping.Token).ConfigureAwait(false);
            GenerationId id;
            var admission = new AdmissionGate(clock);
            var fence = new GenerationFence();
            fence.Refused += error => renewer.Lose(held, "A write was refused by the tenant lease fence: " + error.Message);
            lock (gate)
            {
                id = new(grant.TenantId, slot.Lease.Tenant, grant.Epoch, ++slot.Generations);
                slot.Building = building = new Building(id, held, admission, fence);
            }
            // A grant lost from here on fences the build: its databases close and its start is
            // cancelled, under the supervisor's deadline.
            if (!held.IsCurrent(clock()))
                renewer.Lose(held, Expired);
            using var starting = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token, fence.Lost);
            IGenerationRuntime? runtime = null;
            try
            {
                runtime = await factory(new(id, grant, admission, wakeup, fence), starting.Token).ConfigureAwait(false);
                await runtime.StartAsync(starting.Token).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                if (runtime is not null)
                    await runtime.DisposeAsync().AsTask().ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
                await FailedStartAsync(slot, held, wakeup).ConfigureAwait(false);
                // A start the fence cancelled failed because the grant was lost.
                if (fence.IsClosed && error is not TenantFencedException)
                    throw new TenantFencedException(
                        $"Tenant {id.Tenant} lost its lease at epoch {id.Epoch} during its runtime's start.",
                        error
                    );
                throw;
            }
            var generation = new TenantGeneration(id, held, admission, fence, runtime);
            bool published;
            lock (gate)
            {
                published = !disposed && slot.Grant == held && held.IsCurrent(clock()) && !fence.IsClosed;
                if (published)
                {
                    slot.Current = generation;
                    slot.Activation = null;
                    slot.Building = null;
                    cleared = true;
                    slot.Autonomous = false;
                    admission.Open();
                }
            }
            if (!published)
            {
                admission.Latch(AdmissionLatch.Fence);
                fence.Close();
                await generation.DisposeOnceAsync().ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
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
                    if (slot.Building == building)
                        slot.Building = null;
                }
            building?.Finish();
        }
    }

    // A start that failed: record the backoff, release the grant and let a scan retry. A grant
    // that was lost meanwhile (a fence during the start) is never released.
    private async Task FailedStartAsync(Slot slot, GrantHandle held, WakeupRow? wakeup)
    {
        bool autonomous;
        lock (gate)
        {
            // At shutdown the grant is released plainly by DisposeAsync, without a backoff.
            if (slot.Grant != held || disposed || !held.IsCurrent(clock()))
                return;
            slot.Grant = null;
            autonomous = slot.Autonomous;
            slot.Autonomous = false;
        }
        renewer.Untrack(held);
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

    /// <summary>
    /// Graceful shutdown: latches every generation, waits for activations and releases in
    /// progress, disposes every runtime, then releases each grant whose runtime confirmed its
    /// stop and is still current. A fence that arrives meanwhile is supervised like any other.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        List<(Slot Slot, TenantGeneration Generation)> current = [];
        List<Task> pending = [];
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
                    current.Add((slot, generation));
                    slot.Current = null;
                    slot.Stopping = generation;
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
        // Every tenant drains at once; one slow drain doesn't hold the others.
        await Task.WhenAll(current.Select(item => DisposeConfirmedAsync(item.Slot, item.Generation))).ConfigureAwait(false);
        // A fence that overtook a drain is supervised; it decides the process's end.
        foreach (var (_, generation) in current)
            if (generation.Supervision is { } supervision)
                await supervision.ConfigureAwait(false);
        List<(TenantLease Lease, GrantHandle Handle)> grants = [];
        lock (gate)
            foreach (var slot in slots.Values)
            {
                slot.Stopping = null;
                if (slot.Grant is { } held && held.IsCurrent(clock()))
                    grants.Add((slot.Lease, held));
                slot.Grant = null;
            }
        foreach (var (lease, handle) in grants)
        {
            renewer.Untrack(handle);
            try
            {
                await lease.ReleaseAsync(handle.Grant, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException) { }
        }
        stopping.Dispose();
    }

    // An activation between its grant and its publication: what a fence of that grant closes.
    private sealed class Building(GenerationId id, GrantHandle handle, AdmissionGate gate, GenerationFence fence)
    {
        private readonly TaskCompletionSource done = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal GenerationId Id { get; } = id;
        internal GrantHandle Handle { get; } = handle;
        internal AdmissionGate Gate { get; } = gate;
        internal GenerationFence Fence { get; } = fence;

        /// <summary>Completes once the activation returned, having disposed what it didn't publish.</summary>
        internal Task Done => done.Task;

        internal Task<bool>? Supervision { get; set; }

        internal void Finish() => done.TrySetResult();
    }

    private sealed class Slot(TenantLease lease)
    {
        internal TenantLease Lease { get; } = lease;
        internal Task<TenantGeneration>? Activation { get; set; }
        internal Building? Building { get; set; }
        internal TenantGeneration? Current { get; set; }
        // A generation that is disposing gracefully (idle release or shutdown).
        internal TenantGeneration? Stopping { get; set; }
        internal GrantHandle? Grant { get; set; }
        internal long Generations { get; set; }
        internal Task<IdleReleaseOutcome>? Releasing { get; set; }
        // Work that arrived while an idle release ran; it aborts the release.
        internal bool Demand { get; set; }
        // A coalesced waiter came from a wake-up or recovery scan, not only from requests.
        internal bool Autonomous { get; set; }
    }
}
