using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> TimerQueueScope = new();
    internal static bool IsTimerQueueWrite => TimerQueueScope.Value;

    internal Task<bool> AdmitTimerAsync(QueueItem item) =>
        AdmitWithReceiptAsync(item, null, SaveKind.BestEffort, timer: true);

    private static readonly AsyncLocal<bool> WaitCommitScope = new();
    internal static bool IsWaitCommit => WaitCommitScope.Value;

    private async Task CommitWaitSnapshotAsync(SessionSnapshot staged)
    {
        var previous = WaitCommitScope.Value;
        WaitCommitScope.Value = true;
        try
        {
            await store.CommitAsync(staged, SaveKind.Strict);
        }
        finally
        {
            WaitCommitScope.Value = previous;
        }
    }

    // All wait/queue mutations share the existing ordered save lane. Stop retains its immediate state/CTS path.
    internal Task<bool> AdmitAsync(QueueItem item, SaveKind kind) =>
        AdmitWithReceiptAsync(item, null, kind);

    private async Task<bool> AdmitWithReceiptAsync(
        QueueItem item,
        string? receipt,
        SaveKind kind = SaveKind.Strict,
        bool timer = false
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
                return;
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
                try
                {
                    await store.CommitAsync(entry.SnapshotForPersistence(), kind);
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
                    await CommitWaitSnapshotAsync(prepared.Snapshot);
                }
                catch (AuthorityCommittedException)
                {
                    entry.WithState(Publish);
                    entry.InvokeQueuedCommitted(entry.Snapshot());
                    throw;
                }
                entry.WithState(Publish);
            }
            entry.InvokeQueuedCommitted(entry.Snapshot());
        });
        return admitted;
    }

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
