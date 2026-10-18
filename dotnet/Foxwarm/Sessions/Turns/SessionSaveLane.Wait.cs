using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> TimerQueueScope = new();
    internal static bool IsTimerQueueWrite => TimerQueueScope.Value;

    internal Task<bool> AdmitTimerAsync(QueueItem item) =>
        AdmitWithReceiptAsync(item, null, SaveKind.BestEffort, timer: true);

    private readonly HashSet<string> uncertainExternalReceipts = new(StringComparer.Ordinal);
    private static readonly AsyncLocal<bool> WaitCommitScope = new();
    internal static bool IsWaitCommit => WaitCommitScope.Value;

    private async Task CommitWaitSnapshotAsync(SessionSnapshot staged, Action? beforeCommit = null)
    {
        staged = await PrepareGoalOnlyAsync(staged).ConfigureAwait(false);
        beforeCommit?.Invoke();
        var previous = WaitCommitScope.Value;
        WaitCommitScope.Value = true;
        try
        {
            await store.CommitAsync(staged, SaveKind.Strict);
        }
        catch (AuthorityCommittedException)
        {
            PublishGoalOnly(staged);
            throw;
        }
        finally
        {
            WaitCommitScope.Value = previous;
        }
        PublishGoalOnly(staged);
    }

    // All wait/queue mutations share the existing ordered save lane. Stop retains its immediate state/CTS path.
    internal Task<bool> AdmitAsync(QueueItem item, SaveKind kind, Action? beforeAdmission = null) =>
        AdmitWithReceiptAsync(item, null, kind, beforeAdmission: beforeAdmission);

    private async Task<bool> AdmitWithReceiptAsync(
        QueueItem item,
        string? receipt,
        SaveKind kind = SaveKind.Strict,
        bool timer = false,
        Action? beforeAdmission = null
    )
    {
        using var accepted = entry.AdmitMutation();
        var admitted = false;
        await EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            if (store is PersistentSessionAuthorityStore persistent)
            {
                item = item.CloneItem();
                if (item.Message is not null)
                    await persistent.Images.ExternalizeMessageAsync(item.Message);
                if (item.Parts is not null)
                {
                    var wrapper = new JsonObject
                    {
                        ["parts"] = new JsonArray(
                            item.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
                        ),
                    };
                    await persistent.Images.ExternalizeMessageAsync(wrapper);
                    item = item with
                    {
                        Parts = wrapper["parts"]!
                            .AsArray()
                            .OfType<JsonObject>()
                            .Select(part => (JsonObject)part.DeepClone())
                            .ToArray(),
                    };
                }
            }
            if (kind == SaveKind.BestEffort)
                beforeAdmission?.Invoke();
            var prepared = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var meta = (JsonObject)snapshot.Meta.DeepClone();
                if (receipt is not null)
                {
                    var prior = SessionWait.Strings(meta["acceptedExternalEventIds"]);
                    if (prior.Contains(receipt, StringComparer.Ordinal))
                        return (
                            Snapshot: (SessionSnapshot?)null,
                            Items: (IReadOnlyList<QueueItem>)[]
                        );
                    meta["acceptedExternalEventIds"] = new JsonArray(
                        prior
                            .Append(receipt)
                            .TakeLast(32)
                            .Select(value => (JsonNode?)JsonValue.Create(value))
                            .ToArray()
                    );
                }
                var items = SessionWait.Apply(meta, item);
                if (items.Count == 0 && JsonNode.DeepEquals(meta, snapshot.Meta))
                    return (Snapshot: (SessionSnapshot?)null, Items: items);
                return (
                    Snapshot: (SessionSnapshot?)(
                        snapshot with
                        {
                            Meta = meta,
                            Queue = snapshot.Queue.Concat(items).ToArray(),
                        }
                    ),
                    Items: items
                );
            });
            if (prepared.Snapshot is null)
            {
                // A prior committed-but-unsynced receipt needs strict durability, not a second queue insertion.
                if (receipt is not null && uncertainExternalReceipts.Contains(receipt))
                {
                    await CommitWaitSnapshotAsync(entry.SnapshotForPersistence());
                    uncertainExternalReceipts.Remove(receipt);
                }
                return;
            }
            void Publish(SessionState state)
            {
                PublishMeta(state.Meta, prepared.Snapshot.Meta);
                state.Queue.AddRange(prepared.Items.Select(item => item.CloneItem()));
                admitted = true;
            }
            if (kind == SaveKind.BestEffort)
            {
                entry.WithState(Publish); // Ordinary input stays hot even when its save attempt fails.
                var priorTimerScope = TimerQueueScope.Value;
                TimerQueueScope.Value = timer;
                SessionSnapshot? persisted = null;
                try
                {
                    persisted = await PrepareGoalOnlyAsync(entry.SnapshotForPersistence())
                        .ConfigureAwait(false);
                    await store.CommitAsync(persisted, kind);
                    PublishGoalOnly(persisted);
                }
                catch (AuthorityCommittedException error)
                {
                    if (persisted is not null)
                        PublishGoalOnly(persisted);
                    entry.RecordBestEffortFailure(error);
                }
                catch (Exception error)
                {
                    entry.RecordBestEffortFailure(error);
                }
                finally
                {
                    TimerQueueScope.Value = priorTimerScope;
                }
            }
            else
            {
                try
                {
                    await CommitWaitSnapshotAsync(prepared.Snapshot, beforeAdmission);
                }
                catch (AuthorityCommittedException)
                {
                    if (receipt is not null)
                    {
                        uncertainExternalReceipts.Add(receipt);
                        var durableReceipts = SessionWait.Strings(
                            prepared.Snapshot.Meta["acceptedExternalEventIds"]
                        );
                        uncertainExternalReceipts.RemoveWhere(value =>
                            !durableReceipts.Contains(value, StringComparer.Ordinal)
                        );
                    }
                    entry.WithState(Publish);
                    entry.InvokeQueuedCommitted(entry.Snapshot());
                    throw;
                }
                entry.WithState(Publish);
                if (receipt is not null)
                    uncertainExternalReceipts.Remove(receipt);
            }
            var retained = SessionWait.Strings(entry.Snapshot().Meta["acceptedExternalEventIds"]);
            uncertainExternalReceipts.RemoveWhere(value =>
                !retained.Contains(value, StringComparer.Ordinal)
            );
            entry.InvokeQueuedCommitted(entry.Snapshot());
        });
        return admitted;
    }

    internal Task<bool> CommitRemoteExecCompletionAsync(
        string execId,
        string message,
        string eventId
    ) =>
        AdmitWithReceiptAsync(
            new QueueItem(
                QueueItemType.Background,
                [new JsonObject { ["system"] = message }],
                OpenFields: new JsonObject { ["execId"] = execId, ["externalEventId"] = eventId }
            ),
            eventId
        );

    internal async Task<string?> StartWaitAsync(JsonObject declaration)
    {
        using var admission = entry.AdmitMutation();
        return await MutateWaitAsync(
            (meta, queue, stopping) =>
            {
                if (stopping)
                    return null;
                if (
                    SessionWait.Current(meta)?["waitAll"]?["deferredQueue"] is JsonArray
                    {
                        Count: > 0
                    }
                )
                    throw new InvalidOperationException(
                        "Cannot replace a wait with deferred messages."
                    );
                var wait = (JsonObject)declaration.DeepClone();
                meta["wait"] = wait;
                // Fast replies/events were admitted while tools ran; apply exactly the same transition now.
                var existing = queue.ToArray();
                queue.Clear();
                foreach (var item in existing)
                    queue.AddRange(SessionWait.Apply(meta, item));
                return SessionWait.Text(wait["id"]);
            }
        );
    }

    internal Task<string?> ClearWaitAsync(string? expectedId = null, bool flushDeferred = true) =>
        MutateWaitAsync(
            (meta, queue, _) =>
            {
                var wait = SessionWait.Current(meta);
                if (
                    wait is null
                    || expectedId is not null && SessionWait.Text(wait["id"]) != expectedId
                )
                    return null;
                if (flushDeferred && wait["waitAll"]?["deferredQueue"] is JsonArray deferred)
                    queue.InsertRange(
                        0,
                        deferred.Select(row =>
                            PersistentSessionAuthorityStore.FromQueueJson(row!.AsObject())
                        )
                    );
                meta.Remove("wait");
                return SessionWait.Text(wait["id"]);
            }
        );

    private async Task<string?> MutateWaitAsync(
        Func<JsonObject, List<QueueItem>, bool, string?> mutate
    )
    {
        string? result = null;
        await EnqueueOperationAsync(async () =>
        {
            var prepared = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var meta = (JsonObject)snapshot.Meta.DeepClone();
                var queue = state.Queue.ToList();
                result = mutate(meta, queue, state.Stopping);
                return (
                    Snapshot: snapshot with
                    {
                        Meta = meta,
                        Queue = queue.Select(item => item.CloneItem()).ToArray(),
                    },
                    Queue: queue
                );
            });
            if (result is null)
                return;
            var staged = prepared.Snapshot;
            void Publish(SessionState state)
            {
                PublishMeta(state.Meta, staged.Meta);
                state.Queue.Clear();
                state.Queue.AddRange(prepared.Queue);
            }
            try
            {
                await CommitWaitSnapshotAsync(staged);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                entry.InvokeQueuedCommitted(entry.Snapshot());
                throw;
            }
            entry.WithState(Publish);
            entry.InvokeQueuedCommitted(entry.Snapshot());
        });
        return result;
    }

    private static void PublishMeta(JsonObject target, JsonObject source)
    {
        foreach (
            var key in new[] { "wait", "waitLivenessFingerprints", "acceptedExternalEventIds" }
        )
        {
            if (source.TryGetPropertyValue(key, out var value))
                target[key] = value?.DeepClone();
            else
                target.Remove(key);
        }
    }
}
