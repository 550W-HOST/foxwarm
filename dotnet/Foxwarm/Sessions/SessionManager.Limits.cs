using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Foxwarm.Limits;

namespace Foxwarm.Sessions;

// The tenant's limits (RuntimeCapabilities.Limits) at this runtime's admission points. File mode
// has no limits: Admission is null and every point admits as before.
internal sealed partial class SessionManager
{
    private TenantAdmission? admission;
    private bool admissionDisposed;

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
                    if (!admissionDisposed)
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

    private void RecordHotCharge(SessionOwner owner, HotOwnerBudget.Charge? charge)
    {
        if (charge is not null && (admissionDisposed || !hotCharges!.TryAdd(owner, charge)))
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

    internal void DisposeAdmission()
    {
        if (hotCharges is null)
            return;
        lock (lifecycle)
        {
            if (admissionDisposed)
                return;
            admissionDisposed = true;
            foreach (var owner in hotCharges.Keys)
                ReleaseHotCharge(owner);
            admission?.Dispose();
        }
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
    /// Memory pressure doesn't release an owner within this time of its publication, so a load
    /// isn't undone by the next one before its caller's first operation. Lookups don't renew it;
    /// they only order the victims.
    /// </summary>
    internal static readonly TimeSpan PressurePublicationGrace = TimeSpan.FromSeconds(5);

    internal TimeSpan PressureGraceForTest { get; set; } = PressurePublicationGrace;

    // Memory pressure releases the least recently used owner with nothing live, whatever its
    // quiet period, once its publication grace is over; the ordinary idle release fences it the
    // same way. It never waits for the idle sweep: a sweep in progress releases owners itself.
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
                foreach (var (owner, _) in manager.IdleCandidates())
                    if (manager.TryReleaseIdleOwner(owner, now, 0))
                        return true;
                return false;
            }
            finally
            {
                Monitor.Exit(manager.idleReleaseGate);
            }
        }
    }

    // Resident owners past their publication grace with nothing live, least recently used
    // first.
    private IEnumerable<(SessionOwner Owner, long LastUse)> IdleCandidates()
    {
        if (!accepting)
            yield break;
        var cutoff = Environment.TickCount64 - (long)PressureGraceForTest.TotalMilliseconds;
        var candidates = new List<(SessionOwner Owner, long LastUse)>();
        lock (lifecycle)
            foreach (var owner in sessions.Values)
                if (ReleasableSlot(owner, out var slot) && slot.Published <= cutoff)
                    candidates.Add((owner, slot.LastUse));
        foreach (var candidate in candidates.OrderBy(item => item.LastUse))
            if (IdleReleaseBlocker(candidate.Owner) is null)
                yield return candidate;
    }
}
