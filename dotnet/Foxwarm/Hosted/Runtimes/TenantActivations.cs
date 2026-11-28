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

    private Task<HashSet<(int TenantId, long Epoch)>>? shutdownMoves;
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
    private readonly CancellationToken processStop;
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
        Func<long>? clock = null,
        CancellationToken processStop = default
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
        this.processStop = processStop;
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

    /// <summary>This replica's placement role; acquisition refuses tenants it may not serve.</summary>
    internal string Role { get; init; } = ReplicaRoles.General;

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
                ObjectDisposedException.ThrowIf(disposed || processStop.IsCancellationRequested, this);
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
                    activation = slot.Activation ??= Task.Run(() => RunActivationAsync(slot, cause));
                }
            }
            if (stale is not null)
            {
                // Past its deadline without the watchdog having run yet: decided now.
                renewer.Lose(stale, Expired);
                continue;
            }
            try { return await activation.WaitAsync(token).ConfigureAwait(false); }
            catch (AutonomousDemandSettledException) when (cause == ActivationCause.Request)
            {
                // A request joined a stale scan. Its own demand may still start the tenant.
            }
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
            if (TryAdmitExact(tenant, generation.Id.Epoch, replica) is { } admitted)
                return admitted;
            if (!generation.Handle.IsCurrent(clock()))
                renewer.Lose(generation.Handle, Expired);
            lock (gate)
                if (slots.TryGetValue(tenant, out var slot) && slot.Releasing is not null)
                    slot.Demand = true;
            await Task.Yield();
        }
    }

    /// <summary>Pin an exact dispatch without activating a tenant or following a stale route.</summary>
    internal (TenantGeneration Generation, AdmissionGate.Admission Admission)? TryAdmitExact(
        string tenant, long epoch, string receiverBoot)
    {
        lock (gate)
        {
            if (disposed || processStop.IsCancellationRequested || receiverBoot != replica || !slots.TryGetValue(tenant, out var slot)
                || slot.Current is not { } current || current.Id.Epoch != epoch)
                return null;
            return current.Gate.TryEnter() is { } admission ? (current, admission) : null;
        }
    }

    /// <summary>Every tenant's published generation, at this moment.</summary>
    internal IReadOnlyList<TenantGeneration> Published()
    {
        lock (gate)
            return [.. slots.Values.Select(slot => slot.Current).OfType<TenantGeneration>()];
    }

    internal IReadOnlyList<LeaseGrant> Grants()
    {
        lock (gate)
            return [.. slots.Values.Select(slot => slot.Grant?.Grant).OfType<LeaseGrant>()];
    }

    // Record the observation before releasing the publication lock. A build can finish
    // normally but cannot admit work from this epoch. A retiring runtime still owns
    // authenticated connections until its disposal completes.
    internal void SettingsChanged(LeaseGrant grant, bool rotated)
    {
        TenantGeneration? current;
        IGenerationRuntime? revoke = null;
        lock (gate)
        {
            if (!slots.TryGetValue(grant.Tenant, out var slot) || slot.Grant?.Grant != grant) return;
            if (slot.StaleEpoch != grant.Epoch)
            {
                slot.StaleEpoch = grant.Epoch;
                if (slot.Building is { } building)
                {
                    building.Gate.Latch(AdmissionLatch.Stop);
                    _ = BoundStaleBuildAsync(building);
                }
            }
            current = slot.Current;
            current?.Gate.Latch(AdmissionLatch.Stop);
            if (rotated) revoke = (current ?? slot.Retiring)?.Runtime;
        }
        revoke?.CredentialRotated();
        if (current is not null)
            _ = RetireForPlacementAsync(current.Id, $"Tenant {grant.Tenant}'s settings or placement changed");
    }

    // The first observation starts one fixed countdown, regardless of later renewals
    // or whether the factory, start, or disposal is in progress. Loss hands the same
    // unsettled generation to its existing fence supervisor; the lease is not released.
    private async Task BoundStaleBuildAsync(TenantGeneration building)
    {
        try
        {
            await building.Stopped.WaitAsync(supervisor.DrainBound).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            renewer.Lose(building.Handle, $"Tenant {building.Id.Tenant}'s obsolete startup didn't stop within the drain bound.");
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
    /// Retires <paramref name="id"/>, published, because its tenant's placement changed (its
    /// profile or pin no longer matches the grant): latches its gate, retires it while still
    /// owner, and releases the grant once the stop is confirmed, so the next activation acquires
    /// under the new eligibility. Demand meanwhile waits for the release. A stop that overruns
    /// the drain bound loses the grant instead. False when <paramref name="id"/> isn't published.
    /// </summary>
    internal async Task<bool> RetireForPlacementAsync(GenerationId id, string reason, TimeSpan? moveGrace = null, bool idleOnly = false)
    {
        Slot slot;
        TenantGeneration generation;
        TaskCompletionSource<IdleReleaseOutcome> done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (disposed || !slots.TryGetValue(id.Tenant, out slot!) || slot.Current?.Id != id || slot.Releasing is not null)
                return false;
            generation = slot.Current;
            if (idleOnly)
            {
                if (!generation.Gate.TryLatchIdle(TimeSpan.Zero, () => generation.Runtime!.Idle)) return false;
            }
            else generation.Gate.Latch(moveGrace.HasValue ? AdmissionLatch.Drain : AdmissionLatch.Stop);
            slot.Current = null;
            slot.Retiring = generation;
            slot.Releasing = done.Task;
        }
        var outcome = IdleReleaseOutcome.Aborted;
        try
        {
            using var bound = new CancellationTokenSource(moveGrace is { } gracePeriod ? gracePeriod + ShutdownBound : Timeout.InfiniteTimeSpan);
            var stopped = generation.RetireWithWakeupAsync(bound.Token, moveGrace is { } grace ? GraceEnd(grace) : null);
            if (await Task.WhenAny(stopped, Task.Delay((moveGrace ?? TimeSpan.Zero) + supervisor.DrainBound, CancellationToken.None)).ConfigureAwait(false) != stopped)
            {
                renewer.Lose(generation.Handle, $"{reason}; its runtime didn't stop within the drain bound.");
                await generation.Supervision.ConfigureAwait(false);
                return true;
            }
            if (!(await stopped.ConfigureAwait(false)).Confirmed)
                return true;
            var pending = TakeStoppedGrant(slot, generation);
            if (pending is not null)
                await HandBackAsync(slot.Lease, pending, generation, bound.Token).ConfigureAwait(false);
            outcome = IdleReleaseOutcome.Released;
            return true;
        }
        finally
        {
            lock (gate)
                slot.Releasing = null;
            done.TrySetResult(outcome);
        }
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
            var stopped = generation.RetireWithWakeupAsync(token);
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
            PendingRelease? pending = null;
            lock (gate)
            {
                if (held is null || slot.Grant != held || !held.IsCurrent(clock()))
                    outcome = IdleReleaseOutcome.Fenced;
                else if (slot.Demand || disposed)
                    outcome = IdleReleaseOutcome.Aborted;
                else
                {
                    pending = BeginRelease(slot, held);
                }
            }
            if (pending is not null)
            {
                var released = await HandBackAsync(slot.Lease, pending, generation, CancellationToken.None).ConfigureAwait(false);
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

    /// <summary>
    /// Test hook: runs first in the follow-up of every settled generation (scheduled after its
    /// settlement), so a test can order a decision before it.
    /// </summary>
    internal Action<TenantGeneration>? StopFollowUp { get; set; }

    /// <summary>
    /// Test hook: runs after an activation holds its grant and before it registers its
    /// generation, the window in which the grant has no generation yet.
    /// </summary>
    internal Func<Task>? BeforeRegister { get; set; }

    // Test barrier at the moment a renewal can first observe a new handle.
    internal Action<LeaseGrant>? AfterTrack { get; set; }

    private Slot SlotOf(string tenant)
    {
        if (!slots.TryGetValue(tenant, out var slot))
            slots[tenant] = slot = new(new TenantLease(control, tenant, readerVersion, Role) { LockTimeout = timings.RenewInterval });
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
            if (!held.IsCurrent(clock()) || disposed || processStop.IsCancellationRequested)
                throw new TenantFencedException(
                    $"Tenant {slot.Lease.Tenant} lost its lease at epoch {held.Grant.Epoch} before its runtime was built."
                );
            var id = new GenerationId(held.Grant.TenantId, slot.Lease.Tenant, held.Grant.Epoch, ++slot.Generations);
            var fence = new GenerationFence();
            generation = new TenantGeneration(id, held, new AdmissionGate(clock, () => !processStop.IsCancellationRequested && held.IsCurrent(clock())), fence);
            fence.Refused += error => renewer.Lose(held, "A write was refused by the tenant lease fence: " + error.Message);
            generation.Obligation = supervisor.Watch(id.ToString(), () => held.HardStop(supervisor.DrainTicks), generation.Stopped);
            slot.Building = generation;
            if (slot.StaleEpoch == held.Grant.Epoch)
            {
                generation.Gate.Latch(AdmissionLatch.Stop);
                _ = BoundStaleBuildAsync(generation);
            }
        }
        generation.Stopped.ContinueWith(
            task =>
            {
                StopFollowUp?.Invoke(generation);
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

    private async Task<TenantGeneration> RunActivationAsync(Slot slot, ActivationCause cause)
    {
        // Set when publication cleared the slot's activation under the lock; until then the
        // slot's activation is this one, and no other can start.
        var cleared = false;
        TenantGeneration? generation = null;
        GrantHandle? held = null;
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
                // Shutdown doesn't cancel it: a cancelled commit leaves its outcome unknown. Its
                // own lock and statement timeouts bound it.
                LeaseGrant? acquired;
                try
                {
                    acquired = await slot.Lease
                        .TryAcquireAsync(replica, timings.Ttl, timings.RenewInterval, CancellationToken.None,
                            cause == ActivationCause.Request ? null : Autonomous.Wakeups.Interval, processStop)
                        .ConfigureAwait(false);
                }
                catch (Exception error) when (error is not (TenantNotEligibleException or LeaseRefusedException or AutonomousDemandSettledException))
                {
                    // The commit may have taken effect: this replica may hold the lease until it expires.
                    MarkUncertain(slot);
                    throw;
                }
                if (acquired is null)
                    throw new TenantHeldElsewhereException(slot.Lease.Tenant);
                PendingRelease? late = null;
                lock (gate)
                {
                    held = renewer.Track(acquired);
                    AfterTrack?.Invoke(acquired);
                    held.OnLoss(OnGrantLost);
                    if (disposed || processStop.IsCancellationRequested)
                        late = BeginRelease(slot, held);
                    else if (held.IsCurrent(clock()))
                    {
                        slot.Grant = held;
                        slot.StaleEpoch = null;
                        // A new grant supersedes every earlier hand-back and unknown outcome.
                        slot.Releases.Clear();
                        slot.UncertainUntil = 0;
                    }
                }
                if (late is not null)
                {
                    // Acknowledged after shutdown began: handed back at once, within a bound.
                    using var bound = new CancellationTokenSource(timings.RenewInterval);
                    await ReleaseAsync(slot.Lease, late, bound.Token).ConfigureAwait(false);
                    throw new TenantFencedException($"Tenant {slot.Lease.Tenant} was acquired during shutdown and handed back.");
                }
            }
            if (BeforeRegister is { } hook)
                await hook().ConfigureAwait(false);
            generation = Register(slot, held);
            var id = generation.Id;
            using var starting = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token, generation.Fence.Lost);
            using var abortProducers = starting.Token.Register(() => _ = generation.Gate.AbortStartupAsync());
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
                await generation.Gate.AbortStartupAsync().ConfigureAwait(false);
                var confirmed = error is not StartupCleanupFailedException;
                if (confirmed)
                    await generation.Gate.DrainedAsync().ConfigureAwait(false);
                generation.Settle(StopResult.Now(confirmed));
                if (confirmed)
                    await FailedStartAsync(slot, held, wakeup).ConfigureAwait(false);
                throw Fenced(generation, error, "during its runtime's build");
            }
            bool start;
            lock (gate)
            {
                generation.Runtime = runtime;
                start = !disposed && !processStop.IsCancellationRequested && !generation.IsFenced && held.IsCurrent(clock());
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
            AdmissionGate.Admission? acknowledging = null;
            lock (gate)
            {
                published = !disposed && !processStop.IsCancellationRequested && slot.Grant == held && slot.StaleEpoch != held.Grant.Epoch && held.IsCurrent(clock()) && !generation.IsFenced;
                if (published)
                {
                    slot.Current = generation;
                    slot.Activation = null;
                    slot.Building = null;
                    cleared = true;
                    slot.Autonomous = false;
                    generation.Published = true;
                    generation.Gate.Open();
                    if (wakeup is not null) acknowledging = generation.Gate.TryEnter();
                }
            }
            if (!published)
            {
                // If a settings observation stopped publication, the lease is still valid:
                // dispose with the database available and release only after confirmation.
                bool stale;
                lock (gate) stale = slot.StaleEpoch == held.Grant.Epoch && !generation.IsFenced && !disposed;
                if (stale)
                {
                    generation.Gate.Latch(AdmissionLatch.Stop);
                    generation.Settle(await DisposeBuiltAsync(generation).ConfigureAwait(false));
                    await ReleaseWhenStoppedAsync(slot, generation, CancellationToken.None, recoverUnpublished: true).ConfigureAwait(false);
                    throw new LeaseRefusedException($"Tenant {id.Tenant}'s settings changed during startup.");
                }
                if (processStop.IsCancellationRequested)
                    generation.Gate.Latch(AdmissionLatch.Stop);
                else
                {
                    generation.Gate.Latch(AdmissionLatch.Fence);
                    generation.Fence.Close();
                }
                generation.Settle(await DisposeBuiltAsync(generation).ConfigureAwait(false));
                throw Fenced(generation, null, "before its runtime was published");
            }
            using (acknowledging)
                if (acknowledging is not null)
                    await generation.Runtime!.PublishedAsync(starting.Token).ConfigureAwait(false);
            return generation;
        }
        finally
        {
            if (!cleared && processStop.IsCancellationRequested && held is not null
                && (generation is null || generation.Stopped.IsCompletedSuccessfully && generation.Stopped.Result.Confirmed))
            {
                // The signal can cross the post-commit check, the build, or publication. No
                // request used this generation. Release only once its cleanup is confirmed,
                // even if the signal's shutdown continuation hasn't started yet.
                PendingRelease? pending;
                lock (gate) pending = slot.Grant == held && held.IsCurrent(clock()) ? BeginRelease(slot, held) : null;
                if (pending is not null)
                {
                    using var bound = new CancellationTokenSource(timings.RenewInterval);
                    await ReleaseAsync(slot.Lease, pending, bound.Token).ConfigureAwait(false);
                }
            }
            if (!cleared)
                lock (gate)
                {
                    slot.Activation = null;
                    slot.Autonomous = false;
                    if (generation is not null && slot.Building == generation)
                    {
                        slot.Building = null;
                        // Until its settlement is known, a new activation waits for it; a failed
                        // stop stays, so no later decision can miss it.
                        if (!generation.Stopped.IsCompleted || !generation.Stopped.Result.Confirmed)
                            slot.Retiring = generation;
                    }
                }
        }
    }

    // Disposes a runtime that was built but never served; confirmed only by a clean disposal.
    private static async Task<StopResult> DisposeBuiltAsync(TenantGeneration generation)
    {
        await generation.Gate.AbortStartupAsync().ConfigureAwait(false);
        var result = await StopResult.Of(generation.DisposeOnceAsync()).ConfigureAwait(false);
        if (result.Confirmed)
            await generation.Gate.DrainedAsync().ConfigureAwait(false);
        return result;
    }

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
        PendingRelease pending;
        lock (gate)
        {
            // At shutdown the grant is released plainly by the shutdown, without a backoff.
            if (slot.Grant != held || disposed || processStop.IsCancellationRequested || !held.IsCurrent(clock()))
                return;
            pending = BeginRelease(slot, held);
            autonomous = slot.Autonomous;
            slot.Autonomous = false;
        }
        await WriteReleaseAsync(pending, () => slot.Lease.ReleaseAfterFailedStartAsync(
            pending.Grant, Backoff((wakeup?.Attempts ?? 0) + 1), autonomous, CancellationToken.None))
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Graceful shutdown under one absolute bound (<see cref="ShutdownBound"/>): latches every
    /// generation, starts every retirement at once and off the caller's thread, and releases
    /// each tenant's grant as soon as its own stop is confirmed, without waiting for the others.
    /// At the bound, every tenant whose stop isn't confirmed loses its grant unreleased (its
    /// supervised fence then decides the process's end). True when every stop was confirmed.
    /// </summary>
    private static long GraceEnd(TimeSpan duration) => System.Diagnostics.Stopwatch.GetTimestamp() + (long)(duration.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);

    internal Task<bool> ShutdownAsync(Func<CancellationToken, Task<HashSet<(int TenantId, long Epoch)>>>? markDraining = null, TimeSpan? moveGrace = null)
    {
        lock (gate)
            return shutdown ??= Task.Run(() => ShutdownCoreAsync(markDraining, moveGrace));
    }

    private async Task<bool> ShutdownCoreAsync(Func<CancellationToken, Task<HashSet<(int TenantId, long Epoch)>>>? markDraining, TimeSpan? moveGrace)
    {
        // The one deadline: every stop and every release runs under it, and nothing starts after it.
        using var bound = new CancellationTokenSource(ShutdownBound + (moveGrace ?? TimeSpan.Zero));
        var graceEnds = moveGrace is { } grace ? GraceEnd(grace) : (long?)null;
        List<(Slot Slot, TenantGeneration Generation)> generations = [];
        List<(TenantLease Lease, PendingRelease Pending)> idle = [];
        List<Task> activations = [];
        List<Task> handBacks = [];
        lock (gate)
        {
            disposed = true;
            shutdownMoves = markDraining is null ? null : Task.Run(() => markDraining(bound.Token));
            foreach (var slot in slots.Values)
            {
                if (slot.Current is { } current)
                {
                    current.Gate.Latch(markDraining is null ? AdmissionLatch.Stop : AdmissionLatch.Drain);
                    slot.Retiring = current;
                    slot.Current = null;
                    _ = current.RetireWithWakeupAsync(bound.Token, graceEnds, shutdownMoves);
                }
                foreach (var generation in new[] { slot.Retiring, slot.Building }.OfType<TenantGeneration>().Distinct())
                    generations.Add((slot, generation));
                // Grants without a live generation (between generations, after a refused start,
                // or acquired just before this): released at once, under the same deadline.
                if (slot.Grant is { } held && held.IsCurrent(clock())
                    && !new[] { slot.Retiring, slot.Building }.Any(generation => generation?.Handle == held))
                {
                    idle.Add((slot.Lease, BeginRelease(slot, held)));
                }
                if (slot.Activation is { } activation)
                    activations.Add(activation);
                // Hand-backs already under way (placement, idle or failed-start releases).
                if (slot.Releasing is { } releasing) handBacks.Add(releasing);
                handBacks.AddRange(slot.Releases.Select(item => (Task)item.Acknowledged.Task));
            }
        }
        // Cancellation callbacks may block: never on this thread.
        _ = Task.Run(stopping.Cancel);
        var releases = generations.Select(item => ReleaseWhenStoppedAsync(item.Slot, item.Generation, bound.Token))
            .Concat(idle.Select(item => (Task)ReleaseAsync(item.Lease, item.Pending, bound.Token)))
            .ToList();
        var all = Task.WhenAll(releases.Concat(activations).Concat(handBacks).Select(task => task.ContinueWith(_ => { }, TaskScheduler.Default)));
        await Task.WhenAny(all, Task.Delay(Timeout.Infinite, bound.Token)).ConfigureAwait(false);
        // Clean only when every snapshotted activation ended (no acquisition left unresolved),
        // every generation known then or now recorded a confirmed stop, no acquisition's outcome
        // is unknown, every release's outcome is known, and no grant is still held.
        var confirmed = activations.All(task => task.IsCompleted);
        List<GrantHandle> unreleased = [];
        lock (gate)
        {
            var now = clock();
            var known = generations.Select(item => item.Generation)
                .Concat(slots.Values.SelectMany(slot => new[] { slot.Retiring, slot.Building }).OfType<TenantGeneration>());
            foreach (var generation in known)
                if (!generation.Stopped.IsCompletedSuccessfully || !generation.Stopped.Result.Confirmed)
                    confirmed = false;
            foreach (var slot in slots.Values)
            {
                if (slot.UncertainUntil > now || Unresolved(slot, now))
                    confirmed = false;
                if (slot.Grant is { } held && held.IsCurrent(now))
                {
                    confirmed = false;
                    unreleased.Add(held);
                }
            }
        }
        if (!confirmed)
        {
            foreach (var (_, generation) in generations)
                if (!generation.Stopped.IsCompleted)
                    renewer.Lose(generation.Handle, "The runtime didn't stop within the shutdown bound; its grant isn't released.");
            foreach (var held in unreleased)
                renewer.Lose(held, "The shutdown bound passed before the grant was released.");
        }
        return confirmed && !generations.Any(item => item.Generation.IsFenced && !item.Generation.Stopped.IsCompletedSuccessfully);
    }

    // Releases the tenant's grant once this generation's stop is confirmed and the grant is
    // still current and unclaimed; nothing after an unconfirmed stop.
    private async Task ReleaseWhenStoppedAsync(Slot slot, TenantGeneration generation, CancellationToken token, bool recoverUnpublished = false)
    {
        var result = await generation.Stopped.ConfigureAwait(false);
        if (!recoverUnpublished && BeforeShutdownGrantClaim is { } before) await before().ConfigureAwait(false);
        if (!result.Confirmed)
            return;
        var pending = TakeStoppedGrant(slot, generation);
        if (pending is not null)
        {
            if (generation.Published || recoverUnpublished)
                await HandBackAsync(slot.Lease, pending, generation, token).ConfigureAwait(false);
            else
                await ReleaseAsync(slot.Lease, pending, token).ConfigureAwait(false); // Preserve any unarmed occurrence.
        }
    }

    private Task<bool> HandBackAsync(TenantLease lease, PendingRelease pending, TenantGeneration generation, CancellationToken token) =>
        WriteReleaseAsync(pending, async () =>
        {
            Task<HashSet<(int TenantId, long Epoch)>>? stopping;
            lock (gate) stopping = shutdownMoves;
            var move = stopping is not null && (await stopping.WaitAsync(token).ConfigureAwait(false)).Contains((pending.Grant.TenantId, pending.Grant.Epoch));
            return generation.ScheduleSettled
                ? await lease.ReleaseWithWakeupAsync(pending.Grant, generation.HandBack, token, move).ConfigureAwait(false)
                : await lease.ReleaseForRecoveryAsync(pending.Grant, generation.Published ? generation.Runtime?.RecoveryOccurrence : null, Backoff(1), token, move).ConfigureAwait(false);
        });

    private PendingRelease? TakeStoppedGrant(Slot slot, TenantGeneration generation)
    {
        lock (gate)
            return slot.Grant == generation.Handle && generation.Handle.IsCurrent(clock())
                ? BeginRelease(slot, generation.Handle)
                : null;
    }

    // Caller holds gate. End renewal and replace the held grant with a pending result before
    // shutdown can inspect the slot. A late acquisition was never published in slot.Grant.
    private PendingRelease BeginRelease(Slot slot, GrantHandle held)
    {
        renewer.Untrack(held);
        if (slot.Grant == held)
            slot.Grant = null;
        var expiresBy = clock() + (long)(timings.Ttl.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);
        var pending = new PendingRelease(held.Grant, expiresBy);
        slot.Releases.Add(pending);
        return pending;
    }

    private Task<bool> ReleaseAsync(TenantLease lease, PendingRelease pending, CancellationToken token) =>
        WriteReleaseAsync(pending, async () =>
        {
            await lease.ReleaseAsync(pending.Grant, token).ConfigureAwait(false);
            return true;
        });

    private async Task<bool> WriteReleaseAsync(PendingRelease pending, Func<Task<bool>> write)
    {
        var acknowledged = false;
        try
        {
            if (BeforeReleaseWrite is { } wait)
                await wait().ConfigureAwait(false);
            var released = await write().ConfigureAwait(false);
            // A definite stale epoch is also an acknowledgement: ownership has ended.
            acknowledged = true;
            return released;
        }
        catch (Exception error) when (error is Npgsql.NpgsqlException or TimeoutException or OperationCanceledException)
        {
            return false;
        }
        finally
        {
            pending.Acknowledged.SetResult(acknowledged);
        }
    }

    // Test barrier before a hand-back starts its database call, outside the gate.
    internal Func<Task>? BeforeReleaseWrite { get; set; }
    // Test barrier after shutdown observes the stopped generation, before competing for its grant.
    internal Func<Task>? BeforeShutdownGrantClaim { get; set; }

    // Caller holds the gate. Drops resolved hand-backs; true while any remains.
    private static bool Unresolved(Slot slot, long now)
    {
        slot.Releases.RemoveAll(item => item.ExpiresBy <= now || item.Acknowledged.Task is { IsCompletedSuccessfully: true, Result: true });
        return slot.Releases.Count > 0;
    }

    // An acquisition whose outcome is unknown: this replica may hold the lease for up to a TTL.
    private void MarkUncertain(Slot slot)
    {
        var until = clock() + (long)(timings.Ttl.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);
        lock (gate)
            slot.UncertainUntil = Math.Max(slot.UncertainUntil, until);
    }

    public async ValueTask DisposeAsync() => await ShutdownAsync().ConfigureAwait(false);

    private sealed record PendingRelease(LeaseGrant Grant, long ExpiresBy)
    {
        internal TaskCompletionSource<bool> Acknowledged { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

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
        // Until this clock value, an acquisition's outcome is unknown (its commit may have
        // taken effect); a shutdown before then isn't clean.
        internal long UncertainUntil { get; set; }
        // Hand-backs tracked from the moment the grant leaves this slot.
        internal List<PendingRelease> Releases { get; } = [];
        internal long Generations { get; set; }
        internal long? StaleEpoch { get; set; }
        internal Task<IdleReleaseOutcome>? Releasing { get; set; }
        // Work that arrived while an idle release ran; it aborts the release.
        internal bool Demand { get; set; }
        // A coalesced waiter came from a wake-up or recovery scan, not only from requests.
        internal bool Autonomous { get; set; }
    }
}
