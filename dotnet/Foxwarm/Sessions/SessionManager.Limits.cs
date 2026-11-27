using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Foxwarm.Limits;

namespace Foxwarm.Sessions;

// The tenant's limits (RuntimeCapabilities.Limits) at this runtime's admission points. File mode
// has no limits: Admission is null and every point admits as before.
internal sealed partial class SessionManager
{
    private TenantAdmission? admission;

    // Resident owners' hot-owner charges, released when the owner leaves memory.
    private readonly ConcurrentDictionary<SessionOwner, HotOwnerBudget.Charge> hotCharges = new(
        ReferenceEqualityComparer.Instance
    );

    /// <summary>The tenant's admission state, or null without limits.</summary>
    internal TenantAdmission? Admission
    {
        get
        {
            if (admission is null && Capabilities.Limits is { } limits)
                lock (lifecycle)
                    admission ??= new TenantAdmission(limits, ReplicaLimits, new HotOwners(this));
            return admission;
        }
    }

    /// <summary>The tenant's blob limit on new images and artifacts, or null without limits.</summary>
    internal BlobQuota? BlobQuota { get; }

    /// <summary>The replica's budgets this runtime shares; tests give each runtime its own.</summary>
    internal ReplicaLimits ReplicaLimits { get; init; } = ReplicaLimits.Process;

    /// <summary>The history JSON an owner holds, the base of its hot-owner estimate.</summary>
    internal static long HistoryJsonBytes(IEnumerable<HistoryMessage> history)
    {
        long bytes = 0;
        foreach (var message in history)
            bytes += JsonMarshal.GetRawUtf8Value(message.Data).Length;
        return bytes;
    }

    // Owner admission: reserves a loading owner's estimate (releasing idle owners or waiting).
    private async Task<HotOwnerBudget.Charge?> ReserveHotOwnerAsync(
        SessionHistory history,
        CancellationToken token
    ) =>
        Admission is { } limits
            ? await limits
                .HotOwners.ReserveAsync(HotOwnerBudget.Estimate(HistoryJsonBytes(history)), token)
                .ConfigureAwait(false)
            : null;

    // A created owner exists already: it is charged without waiting.
    private HotOwnerBudget.Charge? ChargeCreatedOwner(SessionOwner owner) =>
        Admission?.HotOwners.Force(
            HotOwnerBudget.Estimate(HistoryJsonBytes(owner.Entry.WithState(state => state.History.Snapshot())))
        );

    private void RecordHotCharge(SessionOwner owner, HotOwnerBudget.Charge? charge)
    {
        if (charge is not null && !hotCharges.TryAdd(owner, charge))
            charge.Dispose();
    }

    // Every removal of a resident owner from `sessions` ends its charge.
    private void ReleaseHotCharge(SessionOwner owner)
    {
        if (hotCharges.TryRemove(owner, out var charge))
            charge.Dispose();
    }

    // Re-estimates resident owners whose history grew or shrank since admission.
    private void RemeasureHotOwners()
    {
        foreach (var (owner, charge) in hotCharges)
            charge.Resize(
                HotOwnerBudget.Estimate(
                    HistoryJsonBytes(owner.Entry.WithState(state => state.History.Snapshot()))
                )
            );
    }

    private void DisposeAdmission()
    {
        foreach (var owner in hotCharges.Keys.ToArray())
            ReleaseHotCharge(owner);
        admission?.Dispose();
    }

    /// <summary>A busy-turn slot for the turn about to run; more turns than the limit queue.</summary>
    internal ValueTask<IDisposable> EnterTurnAsync(CancellationToken token) =>
        Admission?.Turns.EnterAsync(token) ?? ValueTask.FromResult(AdmissionSlots.None);

    // Memory pressure releases the least recently used owner with nothing live, whatever its
    // quiet period; the ordinary idle release fences it the same way.
    private sealed class HotOwners(SessionManager manager) : IHotOwnerReleaser
    {
        public long? OldestIdle() => manager.OldestIdleOwner()?.LastUse;

        public bool ReleaseOldestIdle()
        {
            if (manager.OldestIdleOwner() is not { } oldest)
                return false;
            lock (manager.idleReleaseGate)
                return manager.TryReleaseIdleOwner(oldest.Owner, Environment.TickCount64, 0);
        }
    }

    private (SessionOwner Owner, long LastUse)? OldestIdleOwner()
    {
        if (!accepting)
            return null;
        var candidates = new List<(SessionOwner Owner, long LastUse)>();
        lock (lifecycle)
            foreach (var owner in sessions.Values)
                if (ReleasableSlot(owner, out var slot))
                    candidates.Add((owner, slot.LastUse));
        foreach (var candidate in candidates.OrderBy(item => item.LastUse))
            if (IdleReleaseBlocker(candidate.Owner) is null)
                return candidate;
        return null;
    }
}
