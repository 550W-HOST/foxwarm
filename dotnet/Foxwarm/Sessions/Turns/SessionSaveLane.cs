using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class SessionSaveLane
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
    public Task CommitDisplayNameAsync(string? name) => EnqueueOperationAsync(async () =>
    {
        var staged = entry.WithState(state =>
        {
            var snapshot = state.Snapshot();
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            if (name is null) envelope.Remove("displayName"); else envelope["displayName"] = name;
            return snapshot with { AuthorityEnvelope = envelope };
        });
        void Publish(SessionState state)
        {
            if (name is null) state.AuthorityEnvelope.Remove("displayName"); else state.AuthorityEnvelope["displayName"] = name;
        }
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
    });

    public async Task SaveBestEffortAsync(CancellationToken cancellationToken = default)
    {
        try { await EnqueueAsync(SaveKind.BestEffort, cancellationToken); }
        catch (Exception error) { entry.RecordBestEffortFailure(error); }
    }

    public Task CommitAuthoritySettingsAsync(string? model, bool setModel, string? effort, bool setEffort) =>
        EnqueueOperationAsync(async () =>
        {
            var staged = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                Set(envelope, "model", setModel, model);
                Set(envelope, "effort", setEffort, effort);
                return snapshot with { AuthorityEnvelope = envelope };
            });
            void Publish(SessionState state)
            {
                Set(state.AuthorityEnvelope, "model", setModel, model);
                Set(state.AuthorityEnvelope, "effort", setEffort, effort);
            }
            try { await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false); }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            entry.WithState(Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });

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

    /// <summary>Strictly admit one source-bearing inter-Session item without replacing newer hot state.</summary>
    public Task CommitInterSessionAsync(QueueItem item) => EnqueueOperationAsync(async () =>
    {
        if (item.Type != QueueItemType.Intersession || item.Parts is not { Count: > 0 })
            throw new InvalidDataException("An inter-session delivery requires one ordinary message item.");
        var staged = entry.WithState(state =>
        {
            var snapshot = state.Snapshot();
            return snapshot with { Queue = snapshot.Queue.Append(item.CloneItem()).ToArray() };
        });
        void Publish(SessionState state) => state.Queue.Add(item.CloneItem());
        try { await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false); }
        catch (AuthorityCommittedException)
        {
            entry.WithState(Publish);
            entry.InvokeQueuedCommitted(entry.Snapshot());
            throw;
        }
        entry.WithState(Publish);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    });

    /// <summary>Strict same-owner admission of one exec completion, not ordinary best-effort ingress.</summary>
    public async Task<bool> CommitBackgroundExecCompletionAsync(string execId, string message)
    {
        var admitted = false;
        await EnqueueOperationAsync(async () =>
        {
            var eventId = "exec-completion:" + execId;
            var prepared = entry.WithState(state =>
            {
                var prior = state.Meta["acceptedExternalEventIds"] as JsonArray;
                var receipts = prior?.Select(value => value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : null)
                    .Where(value => !string.IsNullOrEmpty(value)).Distinct(StringComparer.Ordinal).ToList() ?? [];
                if (receipts.Contains(eventId, StringComparer.Ordinal)) return (Snapshot: (SessionSnapshot?)null, Item: (QueueItem?)null, Receipts: (JsonArray?)null);
                receipts.Add(eventId);
                var accepted = new JsonArray(receipts.TakeLast(32).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
                var item = new QueueItem(QueueItemType.Background,
                    [new JsonObject { ["system"] = message }],
                    OpenFields: new JsonObject { ["execId"] = execId, ["externalEventId"] = eventId });
                var snapshot = state.Snapshot();
                var meta = (JsonObject)snapshot.Meta.DeepClone();
                meta["acceptedExternalEventIds"] = accepted.DeepClone();
                return (Snapshot: (SessionSnapshot?)(snapshot with { Queue = snapshot.Queue.Append(item).ToArray(), Meta = meta }),
                    Item: (QueueItem?)item, Receipts: (JsonArray?)accepted);
            });
            if (prepared.Snapshot is null || prepared.Item is null || prepared.Receipts is null) return;
            void Publish(SessionState state)
            {
                state.Meta["acceptedExternalEventIds"] = prepared.Receipts.DeepClone();
                state.Queue.Add(prepared.Item.CloneItem());
                admitted = true;
            }
            try { await store.CommitAsync(prepared.Snapshot, SaveKind.Strict).ConfigureAwait(false); }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                entry.InvokeQueuedCommitted(entry.Snapshot());
                throw;
            }
            entry.WithState(Publish);
            entry.InvokeQueuedCommitted(entry.Snapshot());
        }).ConfigureAwait(false);
        return admitted;
    }

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
