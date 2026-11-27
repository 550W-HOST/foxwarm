using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Foxwarm.Limits;

namespace Foxwarm.Sessions;

// The tenant's limits (RuntimeCapabilities.Limits) at this runtime's admission points. File mode
// has no limits: Admission is null and every point admits as before.
internal sealed partial class SessionManager
{
    private TenantAdmission? admission;

    // Resident owners' hot-owner charges, released when the owner leaves memory; hosted only.
    private readonly ConcurrentDictionary<SessionOwner, HotOwnerBudget.Charge>? hotCharges;

    internal bool HotChargesAllocatedForTest => hotCharges is not null;

    /// <summary>The tenant's admission state, or null without limits.</summary>
    internal TenantAdmission? Admission
    {
        get
        {
            if (admission is null && Capabilities.Limits is { } limits)
                lock (lifecycle)
                    admission ??= new TenantAdmission(
                        limits,
                        ReplicaLimits ?? Foxwarm.Limits.ReplicaLimits.Process,
                        new HotOwners(this)
                    );
            return admission;
        }
    }

    /// <summary>The tenant's blob limit on new images and artifacts, or null without limits.</summary>
    internal BlobQuota? BlobQuota { get; }

    // The image blob store with the tenant's limit, shared by every image writer; null without.
    private readonly Foxwarm.Storage.IBlobStore? limitedImageBlobs;

    /// <summary>
    /// The replica's budgets this runtime shares (the process's unless a test gives its own);
    /// resolved only with limits.
    /// </summary>
    internal ReplicaLimits? ReplicaLimits { get; init; }

    /// <summary>The history JSON an owner holds, the base of its hot-owner estimate.</summary>
    internal static long HistoryJsonBytes(IEnumerable<HistoryMessage> history)
    {
        long bytes = 0;
        foreach (var message in history)
            bytes += JsonMarshal.GetRawUtf8Value(message.Data).Length;
        return bytes;
    }

    // Owner admission: reserves a loading owner's estimate (releasing idle owners or waiting).
    private async Task<HotOwnerBudget.Charge> ReserveHotOwnerAsync(
        long historyJsonBytes,
        CancellationToken token
    ) =>
        await Admission!
            .HotOwners.ReserveAsync(HotOwnerBudget.Estimate(historyJsonBytes), token)
            .ConfigureAwait(false);

    // Whether a resident owner holds this charge (its publication took it over).
    private bool OwnsHotCharge(HotOwnerBudget.Charge charge) =>
        hotCharges is not null && hotCharges.Values.Any(held => ReferenceEquals(held, charge));

    // A created owner exists already: it is charged without waiting.
    private HotOwnerBudget.Charge? ChargeCreatedOwner(SessionOwner owner) =>
        Admission?.HotOwners.Force(
            HotOwnerBudget.Estimate(HistoryJsonBytes(owner.Entry.WithState(state => state.History.Snapshot())))
        );

    private void RecordHotCharge(SessionOwner owner, HotOwnerBudget.Charge? charge)
    {
        if (charge is not null && !hotCharges!.TryAdd(owner, charge))
            charge.Dispose();
    }

    // Every removal of a resident owner from `sessions` ends its charge.
    private void ReleaseHotCharge(SessionOwner owner)
    {
        if (hotCharges is not null && hotCharges.TryRemove(owner, out var charge))
            charge.Dispose();
    }

    // Re-estimates resident owners whose history grew or shrank since admission.
    private void RemeasureHotOwners()
    {
        if (hotCharges is null)
            return;
        foreach (var (owner, charge) in hotCharges)
            charge.Resize(
                HotOwnerBudget.Estimate(
                    HistoryJsonBytes(owner.Entry.WithState(state => state.History.Snapshot()))
                )
            );
    }

    private void DisposeAdmission()
    {
        if (hotCharges is not null)
            foreach (var owner in hotCharges.Keys.ToArray())
                ReleaseHotCharge(owner);
        admission?.Dispose();
    }

    /// <summary>
    /// A busy-turn slot for the processor about to claim busy; more than the limit queue. Its
    /// release tells waiting owner loads that an owner may have become releasable.
    /// </summary>
    internal async ValueTask<IDisposable> EnterTurnAsync(CancellationToken token)
    {
        var limits = Admission!;
        var slot = await limits.Turns.EnterAsync(token).ConfigureAwait(false);
        return new TurnSlot(slot, limits.HotOwners);
    }

    private sealed class TurnSlot(IDisposable slot, HotOwnerBudget owners) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) != 0)
                return;
            slot.Dispose();
            owners.OwnerMayBeIdle();
        }
    }

    /// <summary>
    /// A lookup's use lease: memory pressure doesn't release an owner within this time of its
    /// latest lookup, which covers the caller's way from the lookup to its first operation (a
    /// registered mutation then keeps the owner resident by itself).
    /// </summary>
    internal static readonly TimeSpan PressureUseLease = TimeSpan.FromSeconds(10);

    internal TimeSpan PressureUseLeaseForTest { get; set; } = PressureUseLease;

    // Memory pressure releases the least recently used owner with nothing live, whatever its
    // quiet period beyond the use lease; the ordinary idle release fences it the same way. It
    // never waits for the idle sweep: a sweep in progress releases owners itself.
    private sealed class HotOwners(SessionManager manager) : IHotOwnerReleaser
    {
        public long? OldestIdle()
        {
            foreach (var candidate in manager.IdleCandidates())
                return candidate.LastUse;
            return null;
        }

        public bool ReleaseOldestIdle()
        {
            if (!Monitor.TryEnter(manager.idleReleaseGate))
                return false;
            try
            {
                var now = Environment.TickCount64;
                var lease = (long)manager.PressureUseLeaseForTest.TotalMilliseconds;
                foreach (var (owner, _) in manager.IdleCandidates())
                    if (manager.TryReleaseIdleOwner(owner, now, lease))
                        return true;
                return false;
            }
            finally
            {
                Monitor.Exit(manager.idleReleaseGate);
            }
        }
    }

    // Resident owners past the use lease with nothing live, least recently used first.
    private IEnumerable<(SessionOwner Owner, long LastUse)> IdleCandidates()
    {
        if (!accepting)
            yield break;
        var cutoff = Environment.TickCount64 - (long)PressureUseLeaseForTest.TotalMilliseconds;
        var candidates = new List<(SessionOwner Owner, long LastUse)>();
        lock (lifecycle)
            foreach (var owner in sessions.Values)
                if (ReleasableSlot(owner, out var slot) && slot.LastUse <= cutoff)
                    candidates.Add((owner, slot.LastUse));
        foreach (var candidate in candidates.OrderBy(item => item.LastUse))
            if (IdleReleaseBlocker(candidate.Owner) is null)
                yield return candidate;
    }
}
