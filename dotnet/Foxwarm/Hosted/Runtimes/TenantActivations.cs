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
/// a new generation over a held grant reuses it.
/// <para>
/// A generation is registered, under its grant, before anything is built, and the supervisor
/// watches it from then on: its hard stop is the grant's deadline (or loss) plus the drain
/// bound. It is published, and its gate opens, only after its start completed while its grant
/// was still current; the gate checks the grant on every admission too. A build whose grant is
/// lost before its factory returns is disposed without being started.
/// </para>
/// <para>
/// A lost grant (decided by the renewer: its deadline, a refused write, a takeover) latches and
/// closes every generation under it inline, on the deciding thread, and retires them off it.
/// Each slot keeps its retiring generation; a new activation of the tenant waits for that
/// retirement, and a retirement that isn't confirmed (a fault, a cancellation, an overrun)
/// leaves the tenant unavailable here until the supervisor ends the process. Nothing is
/// released after an unconfirmed stop.
/// </para>
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
    private Task<bool>? shutdown;

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
        ShutdownBound = supervisor.DrainBound;
    }

    /// <summary>How long a failed start keeps every replica from trying again, by attempt.</summary>
    internal Func<int, TimeSpan> Backoff { get; init; } =
        attempt => TimeSpan.FromSeconds(Math.Min(3600, 5 * Math.Pow(2, Math.Max(0, attempt - 1))));

    /// <summary>
    /// The replica shutdown's one absolute bound for every retirement, build and release in
    /// progress. A tenant whose stop isn't confirmed by then loses its grant unreleased.
    /// </summary>
    internal TimeSpan ShutdownBound { get; init; }

    /// <summary>
    /// The published generation of <paramref name="tenant"/>, activating it when there is none.
    /// Throws <see cref="TenantHeldElsewhereException"/> when another replica holds the lease,
    /// <see cref="LeaseRefusedException"/> when this binary may not take the tenant, and
    /// <see cref="TenantFencedException"/> when the grant was lost before publication or a
    /// previous generation's stop isn't confirmed.
    /// </summary>
    internal async Task<TenantGeneration> ActivateAsync(
        string tenant,
        ActivationCause cause = ActivationCause.Request,
        CancellationToken token = default
    )
    {
        while (true)
        {
            Task<TenantGeneration> activation;
            GrantHandle? stale = null;
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                var slot = SlotOf(tenant);
                if (slot.Current is { } current)
                {
                    if (current.Handle.IsCurrent(clock()))
                        return current;
                    stale = current.Handle;
                    activation = null!;
                }
                else
                {
                    if (slot.Releasing is not null)
                        slot.Demand = true;
                    slot.Autonomous |= cause != ActivationCause.Request;
                    activation = slot.Activation ??= Task.Run(() => RunActivationAsync(slot));
                }
            }
            if (stale is not null)
            {
                // Past its deadline without the watchdog having run yet: decided now.
                renewer.Lose(stale, Expired);
                continue;
            }
            return await activation.WaitAsync(token).ConfigureAwait(false);
        }
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
            if (!generation.Handle.IsCurrent(clock()))
                renewer.Lose(generation.Handle, Expired);
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
    /// Fences exactly <paramref name="id"/>, building, published or retiring: its grant is lost
    /// (never released), which fences every generation under it. False, changing nothing, when
    /// <paramref name="id"/> isn't such a generation, so a late fence never lands on its
    /// replacement. Returns once the stop is confirmed (true), or once the supervisor gave up
    /// on it (false).
    /// </summary>
    internal async Task<bool> FenceAsync(GenerationId id, string reason = "fenced")
    {
        TenantGeneration? fenced;
        lock (gate)
        {
            if (!slots.TryGetValue(id.Tenant, out var slot))
                return false;
            fenced = new[] { slot.Current, slot.Retiring, slot.Building }.FirstOrDefault(item => item?.Id == id);
            if (fenced is null)
                return false;
        }
        renewer.Lose(fenced.Handle, reason);
        return await fenced.Supervision.ConfigureAwait(false);
    }

    /// <summary>
    /// The lease of <paramref name="tenant"/> at <paramref name="epoch"/> is definitely lost:
    /// loses that grant, which fences its generations, building or not. A loss reported for
    /// another epoch changes nothing.
    /// </summary>
    internal async Task FenceGrantAsync(string tenant, long epoch)
    {
        GrantHandle? handle = null;
        lock (gate)
            if (slots.TryGetValue(tenant, out var slot))
                handle = new[] { slot.Grant, slot.Current?.Handle, slot.Retiring?.Handle, slot.Building?.Handle }
                    .FirstOrDefault(candidate => candidate?.Grant.Epoch == epoch);
        if (handle is null)
            return;
        renewer.Lose(handle, "The tenant lease was lost.");
        TenantGeneration[] under;
        lock (gate)
            under = slots.TryGetValue(tenant, out var slot)
                ? [.. new[] { slot.Retiring, slot.Building }.OfType<TenantGeneration>().Where(item => item.Handle == handle).Distinct()]
                : [];
        await Task.WhenAll(under.Select(item => item.Supervision)).ConfigureAwait(false);
    }

    // The loss hook of every grant, run inline by whoever decided the loss: latches and closes
    // every generation under it, moves a published one to retirement, and hands cancellation
    // and disposal (which may block) to the thread pool. Takes nothing but short locks.
    private void OnGrantLost(GrantHandle handle)
    {
        List<TenantGeneration> fenced = [];
        lock (gate)
        {
            if (!slots.TryGetValue(handle.Grant.Tenant, out var slot))
                return;
            if (slot.Grant == handle)
                slot.Grant = null;
            foreach (var generation in new[] { slot.Current, slot.Retiring, slot.Building })
                if (generation?.Handle == handle && generation.MarkFenced())
                {
                    generation.Gate.Latch(AdmissionLatch.Fence);
                    generation.Fence.Close();
                    fenced.Add(generation);
                }
            if (slot.Current?.Handle == handle)
            {
                slot.Retiring = slot.Current;
                slot.Current = null;
            }
            else if (slot.Building?.Handle == handle)
                slot.Retiring = slot.Building;
        }
        // The hard stops of these generations moved back to the loss.
        supervisor.Wake();
        foreach (var generation in fenced)
            _ = Task.Run(() =>
            {
                generation.Fence.Cancel();
                // A build settles itself once its factory or start returns.
                if (generation.Published)
                    _ = generation.RetireAsync();
            });
    }

    /// <summary>
    /// Releases an idle tenant (plan §2.3): latches the gate when nothing is admitted and the
    /// runtime is idle, stops its producers, settles in-flight deliveries, computes the next
    /// due time, disposes the runtime (whose final saves still hold the lease), then writes the
    /// wake-up row and releases the lease in one transaction at the expected epoch. Work that
    /// arrives after the latch aborts the release: the lease stays, and the activation that work
    /// caused builds a new generation over it. The stop gets the drain bound: when it overruns,
    /// the grant is lost (not released) and the supervised fence takes over, so the tenant is
    /// never latched and unavailable while its grant renews.
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
            if (!generation.Gate.TryLatchIdle(idleAfter, () => generation.Runtime!.Idle))
                return IdleReleaseOutcome.Busy;
            slot.Current = null;
            slot.Retiring = generation;
            slot.Demand = false;
            slot.Releasing = done.Task;
            held = slot.Grant;
        }
        var outcome = IdleReleaseOutcome.Aborted;
        try
        {
            WakeupDue? due = null;
            var stepsDone = false;
            using var steps = CancellationTokenSource.CreateLinkedTokenSource(token, generation.Fence.Lost);
            var stopped = generation.RetireAsync(async () =>
            {
                var runtime = generation.Runtime!;
                await runtime.StopProducersAsync(steps.Token).ConfigureAwait(false);
                await runtime.SettleAsync(steps.Token).ConfigureAwait(false);
                due = await runtime.NextDueAsync(steps.Token).ConfigureAwait(false);
                stepsDone = true;
            });
            if (await Task.WhenAny(stopped, Task.Delay(supervisor.DrainBound, CancellationToken.None)).ConfigureAwait(false) != stopped)
            {
                renewer.Lose(
                    generation.Handle,
                    $"The idle release didn't stop within {supervisor.DrainBound.TotalSeconds:0.#} s; its grant isn't released."
                );
                await generation.Supervision.ConfigureAwait(false);
                return outcome = IdleReleaseOutcome.Overrun;
            }
            if (!(await stopped.ConfigureAwait(false)).Confirmed)
                return outcome = IdleReleaseOutcome.StopFailed;
            lock (gate)
            {
                if (held is null || slot.Grant != held || !held.IsCurrent(clock()))
                    outcome = IdleReleaseOutcome.Fenced;
                else if (slot.Demand || disposed || !stepsDone)
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
                bool released;
                try
                {
                    released = await slot.Lease.ReleaseWithWakeupAsync(held!.Grant, due, token).ConfigureAwait(false);
                }
                catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException)
                {
                    // Unreleased, the grant expires within one TTL and the recovery scan finds it.
                    released = false;
                }
                outcome = released ? IdleReleaseOutcome.Released : IdleReleaseOutcome.Fenced;
            }
            return outcome;
        }
        finally
        {
            lock (gate)
                slot.Releasing = null;
            done.TrySetResult(outcome);
        }
    }

    private Slot SlotOf(string tenant)
    {
        if (!slots.TryGetValue(tenant, out var slot))
            slots[tenant] = slot = new(new TenantLease(control, tenant, readerVersion) { LockTimeout = timings.RenewInterval });
        return slot;
    }

    // Registers a generation under a current grant, before anything is built: the loss hook
    // and the supervisor see it from here on. Its retirement, when confirmed, clears the slot;
    // when not, the grant is lost and the slot stays unavailable.
    private TenantGeneration Register(Slot slot, GrantHandle held)
    {
        TenantGeneration generation;
        lock (gate)
        {
            if (!held.IsCurrent(clock()) || disposed)
                throw new TenantFencedException(
                    $"Tenant {slot.Lease.Tenant} lost its lease at epoch {held.Grant.Epoch} before its runtime was built."
                );
            var id = new GenerationId(held.Grant.TenantId, slot.Lease.Tenant, held.Grant.Epoch, ++slot.Generations);
            var fence = new GenerationFence();
            generation = new TenantGeneration(id, held, new AdmissionGate(clock, () => held.IsCurrent(clock())), fence);
            fence.Refused += error => renewer.Lose(held, "A write was refused by the tenant lease fence: " + error.Message);
            generation.Obligation = supervisor.Watch(id.ToString(), () => held.HardStop(supervisor.DrainTicks), generation.Stopped);
            slot.Building = generation;
        }
        generation.Stopped.ContinueWith(
            task =>
            {
                if (task.Result.Confirmed)
                {
                    lock (gate)
                        if (slot.Retiring == generation)
                            slot.Retiring = null;
                    return;
                }
                lock (gate)
                    slot.Retiring = generation;
                renewer.Lose(held, "The runtime's stop wasn't confirmed; its grant isn't released.");
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default
        );
        return generation;
    }

    private async Task<TenantGeneration> RunActivationAsync(Slot slot)
    {
        // Set when publication cleared the slot's activation under the lock; until then the
        // slot's activation is this one, and no other can start.
        var cleared = false;
        TenantGeneration? generation = null;
        try
        {
            // The previous generation's retirement first: a release finishes, a stop confirms;
            // an unconfirmed one keeps the tenant unavailable until the process exits.
            while (true)
            {
                Task? releasing;
                TenantGeneration? retiring;
                lock (gate)
                    (releasing, retiring) = (slot.Releasing, slot.Retiring);
                if (releasing is not null)
                {
                    await releasing.ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
                    continue;
                }
                if (retiring is null)
                    break;
                if (!(await retiring.Stopped.ConfigureAwait(false)).Confirmed)
                    throw new TenantFencedException(
                        $"Tenant {slot.Lease.Tenant}'s previous runtime didn't confirm its stop; this replica is exiting."
                    );
                lock (gate)
                    if (slot.Retiring == retiring)
                        slot.Retiring = null;
            }

            GrantHandle? held;
            lock (gate)
                held = slot.Grant;
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
                held.OnLoss(OnGrantLost);
                lock (gate)
                    if (held.IsCurrent(clock()))
                        slot.Grant = held;
            }
            generation = Register(slot, held);
            var id = generation.Id;
            using var starting = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token, generation.Fence.Lost);
            WakeupRow? wakeup = null;
            IGenerationRuntime runtime;
            try
            {
                wakeup = await slot.Lease.ReadWakeupAsync(id.TenantId, starting.Token).ConfigureAwait(false);
                runtime = await factory(new(id, held.Grant, generation.Gate, wakeup, generation.Fence), starting.Token)
                    .ConfigureAwait(false);
            }
            catch (Exception error)
            {
                // A factory that fails cleans up what it built; one whose cleanup failed says so.
                var confirmed = error is not StartupCleanupFailedException;
                generation.Settle(StopResult.Now(confirmed));
                if (confirmed)
                    await FailedStartAsync(slot, held, wakeup).ConfigureAwait(false);
                throw Fenced(generation, error, "during its runtime's build");
            }
            bool start;
            lock (gate)
            {
                generation.Runtime = runtime;
                start = !disposed && !generation.IsFenced && held.IsCurrent(clock());
            }
            if (!start)
            {
                // Built after its grant was lost (or at shutdown): disposed, never started.
                generation.Settle(await DisposeBuiltAsync(generation).ConfigureAwait(false));
                throw Fenced(generation, null, "before its runtime started");
            }
            try
            {
                await runtime.StartAsync(starting.Token).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                var result = await DisposeBuiltAsync(generation).ConfigureAwait(false);
                generation.Settle(result);
                if (result.Confirmed)
                    await FailedStartAsync(slot, held, wakeup).ConfigureAwait(false);
                throw Fenced(generation, error, "during its runtime's start");
            }
            bool published;
            lock (gate)
            {
                published = !disposed && slot.Grant == held && held.IsCurrent(clock()) && !generation.IsFenced;
                if (published)
                {
                    slot.Current = generation;
                    slot.Activation = null;
                    slot.Building = null;
                    cleared = true;
                    slot.Autonomous = false;
                    generation.Published = true;
                    generation.Gate.Open();
                }
            }
            if (!published)
            {
                generation.Gate.Latch(AdmissionLatch.Fence);
                generation.Fence.Close();
                generation.Settle(await DisposeBuiltAsync(generation).ConfigureAwait(false));
                throw Fenced(generation, null, "before its runtime was published");
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
                    if (generation is not null && slot.Building == generation)
                    {
                        slot.Building = null;
                        // Until its settlement is known, a new activation waits for it.
                        if (!generation.Stopped.IsCompleted)
                            slot.Retiring = generation;
                    }
                }
        }
    }

    // Disposes a runtime that was built but never served; confirmed only by a clean disposal.
    private static async Task<StopResult> DisposeBuiltAsync(TenantGeneration generation) =>
        await StopResult.Of(generation.DisposeOnceAsync()).ConfigureAwait(false);

    // The failure of a build or start, as the caller sees it: a fenced generation failed
    // because its grant was lost.
    private static Exception Fenced(TenantGeneration generation, Exception? error, string when) =>
        generation.IsFenced && error is not TenantFencedException
            ? new TenantFencedException($"Tenant {generation.Id.Tenant} lost its lease at epoch {generation.Id.Epoch} {when}.", error)
            : error ?? new TenantFencedException($"Tenant {generation.Id.Tenant} lost its lease at epoch {generation.Id.Epoch} {when}.");

    // A start that failed and whose cleanup is confirmed: record the backoff, release the grant
    // and let a scan retry. A grant that was lost meanwhile is never released.
    private async Task FailedStartAsync(Slot slot, GrantHandle held, WakeupRow? wakeup)
    {
        bool autonomous;
        lock (gate)
        {
            // At shutdown the grant is released plainly by the shutdown, without a backoff.
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
    /// Graceful shutdown under one absolute bound (<see cref="ShutdownBound"/>): latches every
    /// generation, starts every retirement at once and off the caller's thread, and releases
    /// each tenant's grant as soon as its own stop is confirmed, without waiting for the others.
    /// At the bound, every tenant whose stop isn't confirmed loses its grant unreleased (its
    /// supervised fence then decides the process's end). True when every stop was confirmed.
    /// </summary>
    internal Task<bool> ShutdownAsync()
    {
        lock (gate)
            return shutdown ??= Task.Run(ShutdownCoreAsync);
    }

    private async Task<bool> ShutdownCoreAsync()
    {
        var deadline = System.Diagnostics.Stopwatch.GetTimestamp()
            + (long)(ShutdownBound.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);
        List<(Slot Slot, TenantGeneration Generation)> generations = [];
        List<Task> activations = [];
        lock (gate)
        {
            disposed = true;
            foreach (var slot in slots.Values)
            {
                if (slot.Current is { } current)
                {
                    current.Gate.Latch(AdmissionLatch.Stop);
                    slot.Retiring = current;
                    slot.Current = null;
                    _ = current.RetireAsync();
                }
                foreach (var generation in new[] { slot.Retiring, slot.Building }.OfType<TenantGeneration>().Distinct())
                    generations.Add((slot, generation));
                if (slot.Activation is { } activation)
                    activations.Add(activation);
            }
        }
        // Cancellation callbacks may block: never on this thread.
        _ = Task.Run(stopping.Cancel);
        var releases = generations.Select(item => ReleaseWhenStoppedAsync(item.Slot, item.Generation)).ToList();
        var all = Task.WhenAll(releases.Concat(activations.Select(task => task.ContinueWith(_ => { }, TaskScheduler.Default))));
        var remaining = TimeSpan.FromSeconds(
            (double)(deadline - System.Diagnostics.Stopwatch.GetTimestamp()) / System.Diagnostics.Stopwatch.Frequency
        );
        if (remaining > TimeSpan.Zero)
            await Task.WhenAny(all, Task.Delay(remaining)).ConfigureAwait(false);
        var confirmed = true;
        lock (gate)
            foreach (var slot in slots.Values)
                foreach (var generation in new[] { slot.Retiring, slot.Building }.OfType<TenantGeneration>())
                    if (!generation.Stopped.IsCompletedSuccessfully || !generation.Stopped.Result.Confirmed)
                        confirmed = false;
        if (!confirmed)
            foreach (var (_, generation) in generations)
                if (!generation.Stopped.IsCompleted)
                    renewer.Lose(generation.Handle, "The runtime didn't stop within the shutdown bound; its grant isn't released.");
        // Grants without a live generation (between generations, or after a refused start).
        List<(TenantLease Lease, GrantHandle Handle)> idle = [];
        lock (gate)
            foreach (var slot in slots.Values)
                if (slot.Grant is { } held && held.IsCurrent(clock())
                    && !new[] { slot.Retiring, slot.Building }.Any(generation => generation?.Handle == held))
                {
                    idle.Add((slot.Lease, held));
                    slot.Grant = null;
                }
        foreach (var (lease, handle) in idle)
            await ReleaseAsync(lease, handle).ConfigureAwait(false);
        return confirmed && !generations.Any(item => item.Generation.IsFenced && !item.Generation.Stopped.IsCompletedSuccessfully);
    }

    // Releases the tenant's grant once this generation's stop is confirmed and the grant is
    // still current and unclaimed; nothing after an unconfirmed stop.
    private async Task ReleaseWhenStoppedAsync(Slot slot, TenantGeneration generation)
    {
        var result = await generation.Stopped.ConfigureAwait(false);
        if (!result.Confirmed)
            return;
        GrantHandle? held = null;
        lock (gate)
            if (slot.Grant == generation.Handle && generation.Handle.IsCurrent(clock()))
            {
                held = slot.Grant;
                slot.Grant = null;
            }
        if (held is not null)
            await ReleaseAsync(slot.Lease, held).ConfigureAwait(false);
    }

    private async Task ReleaseAsync(TenantLease lease, GrantHandle handle)
    {
        renewer.Untrack(handle);
        try
        {
            await lease.ReleaseAsync(handle.Grant, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException) { }
    }

    public async ValueTask DisposeAsync() => await ShutdownAsync().ConfigureAwait(false);

    private sealed class Slot(TenantLease lease)
    {
        internal TenantLease Lease { get; } = lease;
        internal Task<TenantGeneration>? Activation { get; set; }
        // The generation being built, from its registration until its activation returns.
        internal TenantGeneration? Building { get; set; }
        internal TenantGeneration? Current { get; set; }
        // The generation retiring (idle release, fence, shutdown), until its stop is confirmed;
        // an unconfirmed one stays, and the tenant is unavailable here until the process exits.
        internal TenantGeneration? Retiring { get; set; }
        internal GrantHandle? Grant { get; set; }
        internal long Generations { get; set; }
        internal Task<IdleReleaseOutcome>? Releasing { get; set; }
        // Work that arrived while an idle release ran; it aborts the release.
        internal bool Demand { get; set; }
        // A coalesced waiter came from a wake-up or recovery scan, not only from requests.
        internal bool Autonomous { get; set; }
    }
}
