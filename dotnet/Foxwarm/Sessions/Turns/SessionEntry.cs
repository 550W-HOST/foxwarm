using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class SessionEntry
{
    private int processorClaim;
    private int historyMutation;
    private int processorClaimCount;
    private readonly object stateGate = new();
    private CancellationHandle? activeCancellation;
    private long busyClaimVersion;
    private int bestEffortFailures;
    private int postCommitNotificationFailures;
    private int backgroundProcessorFailures;
    private Exception? lastPostCommitNotificationFailure;
    private Exception? lastBackgroundProcessorFailure;
    private readonly TaskCompletionSource<Exception> backgroundProcessorFailureSignal = new(
        TaskCreationOptions.RunContinuationsAsynchronously
    );

    private Exception? identityUnavailable;

    internal void RequireIdentityAuthority()
    {
        if (Volatile.Read(ref identityUnavailable) is { } error)
            throw error;
    }

    internal bool IdentityAvailable => Volatile.Read(ref identityUnavailable) is null;

    internal void MarkIdentityUnavailable(Exception error) =>
        Volatile.Write(ref identityUnavailable, error);

    internal bool Retired { get; set; }
    internal Func<IDisposable>? MutationAdmission { get; set; }

    internal IDisposable? AdmitMutation()
    {
        RequireIdentityAuthority();
        if (Retired)
            throw new InvalidOperationException("Session owner has retired.");
        return MutationAdmission?.Invoke();
    }

    private static readonly AsyncLocal<TurnScope?> currentTurn = new();

    private sealed class TurnScope(SessionEntry entry, TurnScope? previous) : IDisposable
    {
        internal readonly SessionEntry Entry = entry;
        internal volatile bool Active = true;

        public void Dispose()
        {
            Active = false;
            currentTurn.Value = previous;
        }
    }

    internal IDisposable EnterTurnScope()
    {
        var scope = new TurnScope(this, currentTurn.Value);
        currentTurn.Value = scope;
        return scope;
    }

    internal bool CanSettleDuringShutdown =>
        currentTurn.Value is { Active: true } scope && ReferenceEquals(scope.Entry, this);

    public SessionState State { get; }
    public SessionSaveLane SaveLane { get; }
    public object StateGate => stateGate;
    public int BestEffortFailureCount => Volatile.Read(ref bestEffortFailures);
    public int ProcessorClaimCount => Volatile.Read(ref processorClaimCount);
    public int PostCommitNotificationFailureCount =>
        Volatile.Read(ref postCommitNotificationFailures);
    public Exception? LastPostCommitNotificationFailure =>
        Volatile.Read(ref lastPostCommitNotificationFailure);
    public int BackgroundProcessorFailureCount => Volatile.Read(ref backgroundProcessorFailures);
    public Exception? LastBackgroundProcessorFailure =>
        Volatile.Read(ref lastBackgroundProcessorFailure);
    public Action<SessionSnapshot>? Committed { get; set; }
    internal Func<Action>? CaptureForegroundRelease { get; set; }

    public SessionEntry(
        SessionState state,
        ISessionAuthorityStore store,
        Func<SessionSnapshot, Task<SessionSnapshot>>? migrateGoal = null
    )
    {
        State = state;
        SaveLane = new SessionSaveLane(this, store, migrateGoal);
    }

    public SessionSnapshot Snapshot()
    {
        lock (stateGate)
            return State.Snapshot();
    }

    internal SessionSnapshot SnapshotForPersistence() => Snapshot();

    internal void RecordBestEffortFailure(Exception error) =>
        Interlocked.Increment(ref bestEffortFailures);

    internal void RecordPostCommitNotificationFailure(Exception error)
    {
        Volatile.Write(ref lastPostCommitNotificationFailure, error);
        Interlocked.Increment(ref postCommitNotificationFailures);
    }

    public void RecordBackgroundProcessorFailure(Exception error)
    {
        Volatile.Write(ref lastBackgroundProcessorFailure, error);
        Interlocked.Increment(ref backgroundProcessorFailures);
        backgroundProcessorFailureSignal.TrySetResult(error);
    }

    public Task<Exception> WaitForBackgroundProcessorFailureAsync() =>
        backgroundProcessorFailureSignal.Task;

    internal bool HistoryMutation => Volatile.Read(ref historyMutation) != 0;

    internal bool TryBeginHistoryMutation(out bool busy, out QueueItem[] captured)
    {
        lock (stateGate)
        {
            captured = State.Queue.ToArray();
            busy = State.Busy || processorClaim != 0;
            if (historyMutation != 0)
                return false;
            historyMutation = 1;
            if (!busy)
                processorClaim = 1;
            return true;
        }
    }

    internal void EndHistoryMutation(bool ownedProcessor)
    {
        lock (stateGate)
        {
            historyMutation = 0;
            if (ownedProcessor)
                processorClaim = 0;
        }
    }

    public bool TryClaimProcessor()
    {
        using var admission = AdmitMutation();
        return TryClaimAdmittedProcessor();
    }

    internal bool TryClaimAdmittedProcessor()
    {
        lock (stateGate)
        {
            if (historyMutation != 0 || Interlocked.CompareExchange(ref processorClaim, 1, 0) != 0)
                return false;
            Interlocked.Increment(ref processorClaimCount);
            return true;
        }
    }

    public void ReleaseProcessor() => Volatile.Write(ref processorClaim, 0);

    internal T WithState<T>(Func<SessionState, T> action)
    {
        lock (stateGate)
            return action(State);
    }

    internal void WithState(Action<SessionState> action)
    {
        lock (stateGate)
            action(State);
    }

    internal long MarkBusy()
    {
        lock (stateGate)
        {
            if (State.Busy || State.Stopping)
                return 0;
            State.Busy = true;
            State.BusyStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return ++busyClaimVersion;
        }
    }

    internal bool RollbackBusy(long version)
    {
        lock (stateGate)
        {
            if (version == 0 || version != busyClaimVersion || !State.Busy)
                return false;
            State.Busy = false;
            State.BusyStartedAt = null;
            return true;
        }
    }

    internal bool ReleaseBusy()
    {
        lock (stateGate)
        {
            if (!State.Busy && State.BusyStartedAt is null)
                return false;
            State.Busy = false;
            State.BusyStartedAt = null;
            return true;
        }
    }

    public CancellationHandle RegisterCancellationForTest(CancellationTokenSource source) =>
        RegisterCancellation(source)
        ?? throw new InvalidOperationException("Cancellation registration was not created.");

    public void ClearCancellationForTest(CancellationHandle handle) => ClearCancellation(handle);

    public void SetStoppingForTest(bool value) => WithState(state => state.Stopping = value);

    internal CancellationHandle? RegisterCancellation(CancellationTokenSource source)
    {
        lock (stateGate)
        {
            if (State.Stopping)
                throw new OperationCanceledException("Session is stopping.");
            if (activeCancellation is not null)
                throw new InvalidOperationException(
                    "An active cancellation handle is already registered."
                );
            var handle = new CancellationHandle(source);
            activeCancellation = handle;
            return handle;
        }
    }

    internal bool ShutdownCancellationRequested { get; private set; }

    internal string ToolCancellationSource =>
        WithState(state =>
            ShutdownCancellationRequested && !state.Stopping
                ? "process shutdown"
                : "Stop or Run queued"
        );

    internal void CancelForShutdown()
    {
        CancellationHandle? handle;
        lock (stateGate)
        {
            if (State.Stopping || activeCancellation is null)
                return;
            ShutdownCancellationRequested = true;
            handle = activeCancellation;
            activeCancellation = null;
            handle.TakenByStop = true;
        }
        try
        {
            handle.Cancel();
        }
        finally
        {
            handle.Dispose();
        }
    }

    internal void ClearCancellation(CancellationHandle handle)
    {
        bool dispose;
        lock (stateGate)
        {
            if (ReferenceEquals(activeCancellation, handle))
            {
                activeCancellation = null;
                dispose = !handle.TakenByStop;
            }
            else
            {
                dispose = false;
            }
        }
        if (dispose)
            handle.Dispose();
    }

    internal void MarkStoppingAfterCurrentTool()
    {
        lock (stateGate)
        {
            State.Stopping = true;
            State.Meta.Remove("runQueuedAfterStop");
        }
    }

    internal CancellationHandle? BeginStop(bool runQueued = false)
    {
        lock (stateGate)
        {
            State.Stopping = true;
            if (runQueued)
                State.Meta["runQueuedAfterStop"] = true;
            else
                State.Meta.Remove("runQueuedAfterStop");
            var handle = activeCancellation;
            if (handle is not null)
            {
                activeCancellation = null;
                handle.TakenByStop = true;
            }
            return handle;
        }
    }

    public CancellationHandle? TakeCancellationForTest() => BeginStop();

    internal IReadOnlyList<QueueItem> TakeAllQueueForStop()
    {
        lock (stateGate)
        {
            var items = State.Queue.Select(item => item.CloneItem()).ToArray();
            State.Queue.Clear();
            return items;
        }
    }

    internal void InvokeCommitted(SessionSnapshot snapshot) => Committed?.Invoke(snapshot);

    internal void InvokeQueuedCommitted(SessionSnapshot snapshot)
    {
        try
        {
            Committed?.Invoke(snapshot);
        }
        catch (Exception error)
        {
            RecordPostCommitNotificationFailure(error);
        }
    }
}
