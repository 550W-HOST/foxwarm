namespace Foxwarm.Sessions;

// Idle owner release: an admitted owner whose state is entirely in its authority, catalog and
// other persisted stores leaves memory after a quiet period. The next semantic admission
// hydrates a new owner through the ordinary cold path, as for a Session not yet loaded since
// startup. Owners with live in-process state stay resident; IdleReleaseBlocker names it.
internal sealed partial class SessionManager
{
    /// <summary>Quiet period after the latest semantic admission or observed activity.</summary>
    internal static readonly TimeSpan OwnerIdleReleaseDelay = TimeSpan.FromMinutes(15);

    private static readonly TimeSpan OwnerIdleSweepInterval = TimeSpan.FromMinutes(1);

    // Construction seams for tests: the quiet period, and a callback between the activity
    // checks and the release fence.
    internal TimeSpan IdleReleaseDelay { get; set; } = OwnerIdleReleaseDelay;
    internal Action<SessionOwner>? IdleReleaseChecked { get; set; }

    private ITimer? idleSweep;
    private readonly object idleReleaseGate = new();
    private long releasedOwners;

    internal long ReleasedOwnerCount => Interlocked.Read(ref releasedOwners);

    private void StartIdleRelease()
    {
        lock (lifecycle)
        {
            if (!accepting || idleSweep is not null)
                return;
            idleSweep = TimeProvider.System.CreateTimer(
                _ => SweepIdleOwners(),
                null,
                OwnerIdleSweepInterval,
                OwnerIdleSweepInterval
            );
        }
    }

    private void StopIdleRelease()
    {
        ITimer? sweep;
        lock (lifecycle)
        {
            sweep = idleSweep;
            idleSweep = null;
        }
        sweep?.Dispose();
    }

    private void SweepIdleOwners()
    {
        // A sweep that is still running skips this tick.
        if (!Monitor.TryEnter(idleReleaseGate))
            return;
        try
        {
            ReleaseIdleOwners();
        }
        catch (Exception error)
        {
            MainLog.Diagnostic(
                "Session idle release failed: " + MainLog.SafeFailure(error),
                failure: true
            );
        }
        finally
        {
            Monitor.Exit(idleReleaseGate);
        }
    }

    /// <summary>Releases every resident owner that is idle and quiet; returns how many.</summary>
    internal int ReleaseIdleOwners()
    {
        if (!accepting)
            return 0;
        var now = Environment.TickCount64;
        var delay = (long)IdleReleaseDelay.TotalMilliseconds;
        var released = 0;
        lock (idleReleaseGate)
            foreach (var owner in sessions.Values.ToArray())
                if (TryReleaseIdleOwner(owner, now, delay))
                    released++;
        return released;
    }

    /// <summary>
    /// The live in-process state that keeps this owner resident, or null when everything it
    /// holds is persisted. Called without the lifecycle gate: several owners take their own
    /// locks and then admit through it.
    /// </summary>
    internal string? IdleReleaseBlocker(SessionOwner owner)
    {
        var entry = owner.Entry;
        if (owner.Processing || entry.HasProcessor)
            return "processing";
        if (entry.HistoryMutation)
            return "history-mutation";
        var (busy, stopping, approvals) = entry.WithState(state =>
            (state.Busy, state.Stopping, SessionApprovals.Pending(state.Meta).Length > 0)
        );
        if (busy || stopping)
            return "busy";
        if (owner.Registry.HasRunnableWork(entry))
            return "runnable-queue";
        if (owner.Compactor.Active)
            return "compaction";
        // Only a released processor arms idle compaction; a new owner would never re-arm it.
        if (owner.Compactor.IdleScheduled)
            return "idle-compaction";
        // Loading expires persisted pending approvals; their waiter lives in this process.
        if (approvals || !owner.ApprovalWaiters.IsEmpty)
            return "approval";
        if (owner.HasSubscribers)
            return "subscriber";
        if (ToolScript.Holds(owner))
            return "toolscript";
        // The local projection carries the running count only for resident owners.
        if (executor.Running(owner.Id).Length > 0)
            return "exec";
        if (Nodes.HoldsSession(owner))
            return "node";
        if (mcp.HoldsOwner(owner))
            return "mcp";
        lock (copyGate)
            if (copies.Values.Any(transfer => ReferenceEquals(transfer.Owner, owner)))
                return "copy-transfer";
        lock (channelTurnGate)
            if (channelTurns.ContainsKey(owner))
                return "channel-turn";
        if (RuntimeCredentials.Holds(owner))
            return "external-runtime";
        if (owner.RecallWindows.HasLive())
            return "recall-window";
        return null;
    }

    private bool TryReleaseIdleOwner(SessionOwner owner, long now, long delay)
    {
        IdentitySlot? slot;
        long uses;
        lock (lifecycle)
        {
            if (!ReleasableSlot(owner, out slot) || now - slot.LastUse < delay)
                return false;
            uses = slot.Uses;
        }
        var observed = owner.Entry.SaveLane.EnqueuedOperations;
        if (IdleReleaseBlocker(owner) is not null)
        {
            // Activity restarts the quiet period.
            lock (lifecycle)
                slot.LastUse = Math.Max(slot.LastUse, now);
            return false;
        }
        IdleReleaseChecked?.Invoke(owner);
        lock (lifecycle)
        {
            // An admission since the checks stamped the slot; an accepted mutation is still
            // registered; a persisted change advanced or occupies the lane.
            if (
                !accepting
                || !ReleasableSlot(owner, out var current)
                || current != slot
                || slot.Uses != uses
            )
                return false;
            var keys = identities
                .Where(pair => pair.Value == slot)
                .Select(pair => pair.Key)
                .ToArray();
            if (
                keys.Any(key =>
                    mutationAdmissions.ContainsKey(key)
                    || deletionClaims.ContainsKey(key)
                    || identityMoveClaims.ContainsKey(key)
                    || pendingIdentityReservations.Contains(key)
                )
            )
                return false;
            if (owner.Processing || owner.Entry.HasProcessor || owner.Entry.HistoryMutation)
                return false;
            // Last: once the lane is retired, a stale reference can no longer persist anything.
            if (!owner.Entry.SaveLane.TryRetireIdle(observed))
                return false;
            sessions.TryRemove(owner.Id, out _);
            foreach (var key in keys)
                identities.Remove(key);
        }
        // Stale references now fail admission as a retired owner; scheduling tied to the
        // owner's identity-loss token (idle compaction, launchers) stops.
        owner.Entry.Retired = true;
        owner.AuthorityStore.Retire();
        lock (presentationGate)
            if (localVisible.Remove(owner.Id))
                volatileSequence++;
        Interlocked.Increment(ref releasedOwners);
        return true;
    }

    // Called under lifecycle.
    private bool ReleasableSlot(
        SessionOwner owner,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out IdentitySlot? slot
    )
    {
        slot = null;
        if (
            !sessions.TryGetValue(owner.Id, out var current)
            || !ReferenceEquals(current, owner)
            || owner.Entry.Retired
            || !owner.Entry.IdentityAvailable
            || !identities.TryGetValue(owner.Id, out var found)
            || found.Retiring
            || found.Retired
            || !found.Finished.Task.IsCompleted
            || !found.Owner.Task.IsCompletedSuccessfully
            || !ReferenceEquals(found.Owner.Task.Result, owner)
        )
            return false;
        slot = found;
        return true;
    }
}
