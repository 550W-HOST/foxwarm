using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> SnapshotCommitScope = new();
    internal static bool IsSnapshotCommit => SnapshotCommitScope.Value;
    private readonly SessionEntry entry;
    private readonly ISessionAuthorityStore store;
    private readonly object laneGate = new();
    private Task tail = Task.CompletedTask;

    internal SessionSaveLane(SessionEntry entry, ISessionAuthorityStore store)
    {
        this.entry = entry;
        this.store = store;
    }

    public Task SaveStrictAsync(CancellationToken cancellationToken = default) => EnqueueAsync(SaveKind.Strict, cancellationToken);
    public async Task<DisplayNameChange> CommitDisplayNameAsync(string? name)
    {
        DisplayNameChange result = new(false, null, null);
        await EnqueueOperationAsync(async () =>
    {
        var staged = entry.WithState(state =>
        {
            var prior = SessionWait.Text(state.AuthorityEnvelope["displayName"]);
            if (prior is "") prior = null;
            result = new(prior != name, prior, name);
            if (!result.Changed) return (SessionSnapshot?)null;
            var snapshot = state.Snapshot();
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            if (name is null) envelope.Remove("displayName"); else envelope["displayName"] = name;
            return snapshot with { AuthorityEnvelope = envelope };
        });
        if (staged is null) return;
        void Publish(SessionState state)
        {
            if (name is null) state.AuthorityEnvelope.Remove("displayName"); else state.AuthorityEnvelope["displayName"] = name;
        }
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
    });
        return result;
    }

    public async Task SaveBestEffortAsync(CancellationToken cancellationToken = default)
    {
        try { await EnqueueAsync(SaveKind.BestEffort, cancellationToken); }
        catch (Exception error) { entry.RecordBestEffortFailure(error); }
    }

    /// <summary>Persist one owner snapshot before a model request; no request is sent on failure.</summary>
    public Task CommitMemorySnapshotAsync(string snapshot) => EnqueueOperationAsync(async () =>
    {
        var staged = entry.WithState(state =>
        {
            var next = state.Snapshot();
            var envelope = (JsonObject)next.AuthorityEnvelope.DeepClone();
            envelope["persistentMemorySnapshot"] = snapshot;
            return next with { AuthorityEnvelope = envelope };
        });
        void Publish(SessionState state) => state.AuthorityEnvelope["persistentMemorySnapshot"] = snapshot;
        var previousScope = SnapshotCommitScope.Value;
        SnapshotCommitScope.Value = true;
        try { await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false); }
        catch (AuthorityCommittedException)
        {
            entry.WithState(Publish);
            entry.InvokeCommitted(entry.Snapshot());
            throw;
        }
        finally { SnapshotCommitScope.Value = previousScope; }
        entry.WithState(Publish);
        entry.InvokeCommitted(entry.Snapshot());
    });

    /// <summary>Strictly admit one source-bearing inter-Session item.</summary>
    public Task CommitInterSessionAsync(QueueItem item) => AdmitAsync(item, SaveKind.Strict);

    public Task<bool> CommitBackgroundExecCompletionAsync(string execId, string message) => AdmitWithReceiptAsync(
        new QueueItem(QueueItemType.Background, [new JsonObject { ["system"] = message }],
            OpenFields: new JsonObject { ["execId"] = execId, ["externalEventId"] = "exec-completion:" + execId }),
        "exec-completion:" + execId);

    private static void Set(JsonObject root, string key, bool supplied, string? value)
    {
        if (!supplied) return;
        if (value is null) root.Remove(key);
        else root[key] = value;
    }

    internal Task CommitCanonicalAppendAsync(
        Func<SessionState, CanonicalAppendPreparation> prepare,
        CancellationToken cancellationToken = default) =>
        EnqueueOperationAsync(async () =>
        {
            var operation = entry.WithState(prepare);
            try
            {
                if (store is ICanonicalAppendAuthorityStore canonical)
                    await canonical.CommitCanonicalAppendAsync(operation.StagedSnapshot, operation.AppendedMessages, cancellationToken).ConfigureAwait(false);
                else
                    await store.CommitAsync(operation.StagedSnapshot, SaveKind.Strict, cancellationToken).ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(operation.Publish);
                throw;
            }
            entry.WithState(operation.Publish);
        });

    public Task CommitCompactionAsync(Func<SessionState, CompactionPreparation> prepare, CancellationToken cancellationToken = default) =>
        EnqueueOperationAsync(async () =>
        {
            var operation = entry.WithState(prepare);
            var previousScope = GoalCommitScope.Value;
            GoalCommitScope.Value = operation.StagedSnapshot.AuthorityEnvelope["goalState"] is JsonObject;
            try
            {
                if (store is not ICompactionAuthorityStore compact)
                    throw new UnsupportedSessionTurnException("persistent compact authority");
                await compact.CommitCompactionAsync(operation.StagedSnapshot, operation.Blocks,
                    operation.ArchivedMessages, cancellationToken).ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(operation.Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            finally { GoalCommitScope.Value = previousScope; }
            entry.WithState(operation.Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });

    private Task EnqueueAsync(SaveKind kind, CancellationToken cancellationToken)
        => EnqueueOperationAsync(async () =>
        {
            var snapshot = entry.SnapshotForPersistence();
            await store.CommitAsync(snapshot, kind, cancellationToken).ConfigureAwait(false);
        });

    private Task EnqueueOperationAsync(Func<Task> operation)
    {
        var launch = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task current;
        lock (laneGate)
        {
            var previous = tail;
            current = RunAfterAsync(launch.Task, previous, operation);
            tail = current;
        }
        launch.TrySetResult(true);
        return current;
    }

    private static async Task RunAfterAsync(Task launch, Task previous, Func<Task> operation)
    {
        await launch.ConfigureAwait(false);
        try { await previous.ConfigureAwait(false); }
        catch { /* A failed best-effort attempt must not poison later strict work. */ }
        await operation().ConfigureAwait(false);
    }
}
