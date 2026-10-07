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
    private readonly Func<SessionSnapshot, Task<SessionSnapshot>>? migrateGoal;
    private readonly object laneGate = new();
    private Task tail = Task.CompletedTask;
    private bool retired;

    internal Task RetireAsync(Action closeStore)
    {
        var launch = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Task current;
        lock (laneGate)
        {
            if (retired)
                return tail;
            retired = true;
            current = RunAfterAsync(
                launch.Task,
                tail,
                () =>
                {
                    closeStore();
                    entry.Retired = true;
                    return Task.CompletedTask;
                }
            );
            tail = current;
        }
        launch.TrySetResult(true);
        return current;
    }

    internal SessionSaveLane(
        SessionEntry entry,
        ISessionAuthorityStore store,
        Func<SessionSnapshot, Task<SessionSnapshot>>? migrateGoal = null
    )
    {
        this.entry = entry;
        this.store = store;
        this.migrateGoal = migrateGoal;
    }

    private async Task<(SessionSnapshot Snapshot, Action<SessionState> Publish)> PrepareGoalAsync(
        SessionSnapshot snapshot,
        Action<SessionState> publish
    )
    {
        if (migrateGoal is null || snapshot.AuthorityEnvelope["goalState"] is null)
            return (snapshot, publish);
        var migrated = await migrateGoal(snapshot).ConfigureAwait(false);
        return (
            migrated,
            state =>
            {
                publish(state);
                if (migrated.AuthorityEnvelope["goalState"] is null)
                    state.AuthorityEnvelope.Remove("goalState");
                else
                    state.AuthorityEnvelope["goalState"] = migrated.AuthorityEnvelope[
                        "goalState"
                    ]!.DeepClone();
            }
        );
    }

    private async Task<SessionSnapshot> PrepareGoalOnlyAsync(SessionSnapshot snapshot) =>
        (await PrepareGoalAsync(snapshot, _ => { }).ConfigureAwait(false)).Snapshot;

    private void PublishGoalOnly(SessionSnapshot snapshot)
    {
        if (snapshot.AuthorityEnvelope["goalState"] is null)
            entry.WithState(state => state.AuthorityEnvelope.Remove("goalState"));
    }

    // Identity IO joins the existing ordered save lane, never the short state or registry gate.
    internal Task MutateIdentityAsync(Func<Task> operation) => EnqueueOperationAsync(operation);

    public Task SaveStrictAsync(CancellationToken cancellationToken = default) =>
        EnqueueAsync(SaveKind.Strict, cancellationToken);

    public async Task<DisplayNameChange> CommitDisplayNameAsync(string? name)
    {
        DisplayNameChange result = new(false, null, null);
        await EnqueueOperationAsync(async () =>
        {
            var staged = entry.WithState(state =>
            {
                var prior = SessionWait.Text(state.AuthorityEnvelope["displayName"]);
                if (prior is "")
                    prior = null;
                result = new(prior != name, prior, name);
                if (!result.Changed)
                    return (SessionSnapshot?)null;
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                if (name is null)
                    envelope.Remove("displayName");
                else
                    envelope["displayName"] = name;
                return snapshot with { AuthorityEnvelope = envelope };
            });
            if (staged is null)
                return;
            void Publish(SessionState state)
            {
                if (name is null)
                    state.AuthorityEnvelope.Remove("displayName");
                else
                    state.AuthorityEnvelope["displayName"] = name;
            }
            var prepared = await PrepareGoalAsync(staged, Publish).ConfigureAwait(false);
            try
            {
                await store.CommitAsync(prepared.Snapshot, SaveKind.Strict);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(prepared.Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            entry.WithState(prepared.Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });
        return result;
    }

    public async Task SaveBestEffortAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await EnqueueAsync(SaveKind.BestEffort, cancellationToken);
        }
        catch (Exception error)
        {
            entry.RecordBestEffortFailure(error);
        }
    }

    /// <summary>Persist one owner snapshot before a model request; no request is sent on failure.</summary>
    public Task CommitMemorySnapshotAsync(string snapshot) =>
        EnqueueOperationAsync(async () =>
        {
            var staged = entry.WithState(state =>
            {
                var next = state.Snapshot();
                var envelope = (JsonObject)next.AuthorityEnvelope.DeepClone();
                envelope["persistentMemorySnapshot"] = snapshot;
                return next with { AuthorityEnvelope = envelope };
            });
            void Publish(SessionState state) =>
                state.AuthorityEnvelope["persistentMemorySnapshot"] = snapshot;
            var previousScope = SnapshotCommitScope.Value;
            SnapshotCommitScope.Value = true;
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            finally
            {
                SnapshotCommitScope.Value = previousScope;
            }
            entry.WithState(Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });

    /// <summary>Strictly admit one source-bearing inter-Session item.</summary>
    public Task CommitInterSessionAsync(QueueItem item) => AdmitAsync(item, SaveKind.Strict);

    internal Task ResolveChildHandoffAsync() =>
        EnqueueOperationAsync(async () =>
        {
            var snapshot = entry.Snapshot();
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            if (!SessionBoundary.ResolveChildHandoff(envelope))
                return;
            var staged = snapshot with { AuthorityEnvelope = envelope };
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(state =>
                    state.AuthorityEnvelope["childHandoffState"] = envelope[
                        "childHandoffState"
                    ]!.DeepClone()
                );
                throw;
            }
            entry.WithState(state =>
                state.AuthorityEnvelope["childHandoffState"] = envelope[
                    "childHandoffState"
                ]!.DeepClone()
            );
        });

    internal Task QueueChildReminderAsync(string parentSessionId) =>
        AdmitAsync(
            new QueueItem(
                QueueItemType.Background,
                [new JsonObject { ["system"] = SessionBoundary.ChildReminder(parentSessionId) }],
                SourceSessionRelation: "other",
                Trigger: false
            ),
            SaveKind.BestEffort
        );

    public Task<bool> CommitBackgroundExecCompletionAsync(string execId, string message) =>
        AdmitWithReceiptAsync(
            new QueueItem(
                QueueItemType.Background,
                [new JsonObject { ["system"] = message }],
                OpenFields: new JsonObject
                {
                    ["execId"] = execId,
                    ["externalEventId"] = "exec-completion:" + execId,
                }
            ),
            "exec-completion:" + execId
        );

    private static void Set(JsonObject root, string key, bool supplied, string? value)
    {
        if (!supplied)
            return;
        if (value is null)
            root.Remove(key);
        else
            root[key] = value;
    }

    internal Task CommitCanonicalAppendAsync(
        Func<SessionState, CanonicalAppendPreparation> prepare,
        CancellationToken cancellationToken = default
    ) =>
        EnqueueOperationAsync(async () =>
        {
            var operation = entry.WithState(prepare);
            var prepared = await PrepareGoalAsync(operation.StagedSnapshot, operation.Publish)
                .ConfigureAwait(false);
            operation = operation with
            {
                StagedSnapshot = prepared.Snapshot,
                Publish = prepared.Publish,
            };
            try
            {
                if (store is ICanonicalAppendAuthorityStore canonical)
                    await canonical
                        .CommitCanonicalAppendAsync(
                            operation.StagedSnapshot,
                            operation.AppendedMessages,
                            cancellationToken
                        )
                        .ConfigureAwait(false);
                else
                    await store
                        .CommitAsync(operation.StagedSnapshot, SaveKind.Strict, cancellationToken)
                        .ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(operation.Publish);
                throw;
            }
            entry.WithState(operation.Publish);
        });

    internal async Task<IReadOnlyList<JsonObject>> CommitCanonicalAppendWithResultAsync(
        Func<SessionState, CanonicalAppendPreparation> prepare
    )
    {
        IReadOnlyList<JsonObject> rows = [];
        await CommitCanonicalAppendAsync(state =>
            {
                var operation = prepare(state);
                rows = operation
                    .AppendedMessages.Select(row => (JsonObject)row.DeepClone())
                    .ToArray();
                return operation;
            })
            .ConfigureAwait(false);
        return rows;
    }

    public Task CommitCompactionAsync(
        Func<SessionState, CompactionPreparation> prepare,
        CancellationToken cancellationToken = default,
        Func<SessionSnapshot, CancellationToken, Task<string?>>? refreshMemory = null
    ) =>
        EnqueueOperationAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            var memory = refreshMemory is null
                ? null
                : await refreshMemory(entry.Snapshot(), cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            var operation = entry.WithState(prepare);
            if (memory is not null)
            {
                var envelope = (JsonObject)operation.StagedSnapshot.AuthorityEnvelope.DeepClone();
                envelope["persistentMemorySnapshot"] = memory;
                var publish = operation.Publish;
                operation = operation with
                {
                    StagedSnapshot = operation.StagedSnapshot with { AuthorityEnvelope = envelope },
                    Publish = state =>
                    {
                        publish(state);
                        state.AuthorityEnvelope["persistentMemorySnapshot"] = memory;
                    },
                };
            }
            var preparedGoal = await PrepareGoalAsync(operation.StagedSnapshot, operation.Publish)
                .ConfigureAwait(false);
            operation = operation with
            {
                StagedSnapshot = preparedGoal.Snapshot,
                Publish = preparedGoal.Publish,
            };
            try
            {
                if (store is not ICompactionAuthorityStore compact)
                    throw new UnsupportedSessionTurnException("persistent compact authority");
                await compact
                    .CommitCompactionAsync(
                        operation.StagedSnapshot,
                        operation.Blocks,
                        operation.ArchivedMessages,
                        cancellationToken
                    )
                    .ConfigureAwait(false);
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

    private Task EnqueueAsync(SaveKind kind, CancellationToken cancellationToken) =>
        EnqueueOperationAsync(async () =>
        {
            var snapshot = entry.SnapshotForPersistence();
            var prepared = await PrepareGoalAsync(snapshot, _ => { }).ConfigureAwait(false);
            try
            {
                await store
                    .CommitAsync(prepared.Snapshot, kind, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                prepared.Publish(entry.State);
                throw;
            }
            prepared.Publish(entry.State);
        });

    private Task EnqueueOperationAsync(Func<Task> operation)
    {
        var launch = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Task current;
        lock (laneGate)
        {
            if (retired)
                return Task.FromException(
                    new InvalidOperationException("Session persistence lane has retired.")
                );
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
        try
        {
            await previous.ConfigureAwait(false);
        }
        catch
        { /* A failed best-effort attempt must not poison later strict work. */
        }
        await operation().ConfigureAwait(false);
    }
}
