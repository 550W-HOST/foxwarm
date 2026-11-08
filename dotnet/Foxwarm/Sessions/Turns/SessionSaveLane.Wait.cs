using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal Task<bool> AdmitTimerAsync(QueueItem item) =>
        AdmitWithReceiptAsync(item, null, SaveKind.BestEffort);

    // Each durable receipt kind keeps its own bounded window, so a burst of one kind
    // cannot evict receipts another protocol's retries depend on.
    private sealed record ReceiptSlot(string Key, int Limit);

    private static readonly ReceiptSlot ExternalEventReceipts = new("acceptedExternalEventIds", 32);
    internal const string WebhookReceiptKey = "acceptedWebhookDeliveryIds";
    private static readonly ReceiptSlot WebhookReceipts = new(WebhookReceiptKey, 64);

    // Created eagerly and never resized, so concurrent admissions only read this map.
    private readonly Dictionary<string, HashSet<string>> uncertainReceipts = new(
        StringComparer.Ordinal
    )
    {
        [ExternalEventReceipts.Key] = new(StringComparer.Ordinal),
        [WebhookReceipts.Key] = new(StringComparer.Ordinal),
    };

    /// <summary>Strict external admission; a repeated delivery receipt returns false without queueing.</summary>
    /// <summary>
    /// <paramref name="shape"/> sees the current queue under the admission gate and returns the
    /// item to admit, a replacement, or null to admit nothing; it runs after the duplicate check.
    /// A replacement keeps the admitted item's wake marker, which ingress owns.
    /// </summary>
    internal Task<bool> AdmitWebhookAsync(
        QueueItem item,
        string? receipt,
        Action beforeAdmission,
        Func<IReadOnlyList<QueueItem>, QueueItem, QueueItem?>? shape = null
    ) =>
        AdmitWithReceiptAsync(
            item,
            receipt,
            SaveKind.Strict,
            beforeAdmission,
            WebhookReceipts,
            shape
        );

    private async Task CommitWaitSnapshotAsync(SessionSnapshot staged, Action? beforeCommit = null)
    {
        staged = await PrepareGoalOnlyAsync(staged).ConfigureAwait(false);
        beforeCommit?.Invoke();
        try
        {
            await store.CommitAsync(staged, SaveKind.Strict);
        }
        catch (AuthorityCommittedException)
        {
            PublishGoalOnly(staged);
            throw;
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
        Action? beforeAdmission = null,
        ReceiptSlot? receiptSlot = null,
        Func<IReadOnlyList<QueueItem>, QueueItem, QueueItem?>? shape = null
    )
    {
        var slot = receiptSlot ?? ExternalEventReceipts;
        var uncertainExternalReceipts = uncertainReceipts[slot.Key];
        using var accepted = entry.AdmitMutation();
        var admitted = false;
        var declined = false;
        await EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            item = RedactQueueItem(item);
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
                    var prior = SessionWait.Strings(meta[slot.Key]);
                    if (prior.Contains(receipt, StringComparer.Ordinal))
                        return (
                            Snapshot: (SessionSnapshot?)null,
                            Items: (IReadOnlyList<QueueItem>)[]
                        );
                    meta[slot.Key] = new JsonArray(
                        prior
                            .Append(receipt)
                            .TakeLast(slot.Limit)
                            .Select(value => (JsonNode?)JsonValue.Create(value))
                            .ToArray()
                    );
                }
                if (shape is not null)
                {
                    if (shape(snapshot.Queue, item) is not { } shaped)
                    {
                        declined = true;
                        return (
                            Snapshot: (SessionSnapshot?)null,
                            Items: (IReadOnlyList<QueueItem>)[]
                        );
                    }
                    item = shaped with { Trigger = item.Trigger };
                }
                // Question answers resolve in the same staged meta as the wait they release.
                item = SessionQuestions.ApplyAdmission(meta, item);
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
                if (!declined && receipt is not null && uncertainExternalReceipts.Contains(receipt))
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
                        var durableReceipts = SessionWait.Strings(prepared.Snapshot.Meta[slot.Key]);
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
            var retained = SessionWait.Strings(entry.Snapshot().Meta[slot.Key]);
            uncertainExternalReceipts.RemoveWhere(value =>
                !retained.Contains(value, StringComparer.Ordinal)
            );
            entry.InvokeQueuedCommitted(entry.Snapshot());
        });
        return admitted;
    }

    // Known secrets are masked before queued input reaches hot state or the Session file.
    private QueueItem RedactQueueItem(QueueItem item)
    {
        if (entry.State.HistoryRedaction is null)
            return item;
        var message = item.Message is null
            ? null
            : entry.State.RedactForHistory(item.Message, "input");
        IReadOnlyList<JsonObject>? parts = item.Parts;
        if (parts is not null)
        {
            var wrapper = new JsonObject
            {
                ["parts"] = new JsonArray(parts.Select(part => part.DeepClone()).ToArray()),
            };
            var redacted = entry.State.RedactForHistory(wrapper, "input");
            if (!ReferenceEquals(redacted, wrapper))
                parts = redacted["parts"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Select(part => (JsonObject)part.DeepClone())
                    .ToArray();
        }
        // Open fields carry structured question answers into the question record.
        var fields = item.OpenFields is null
            ? null
            : entry.State.RedactForHistory(item.OpenFields, "input");
        if (
            ReferenceEquals(message, item.Message)
            && ReferenceEquals(parts, item.Parts)
            && ReferenceEquals(fields, item.OpenFields)
        )
            return item;
        return item with { Message = message, Parts = parts, OpenFields = fields };
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
                    queue.AddRange(
                        SessionWait.Apply(
                            meta,
                            SessionQuestions.ApplyAdmission(meta, item, structured: false)
                        )
                    );
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

    internal Task<string?> ClearLostCopyWaitsAsync() =>
        MutateWaitAsync(
            (meta, queue, _) =>
            {
                var wait = SessionWait.Current(meta);
                var ids = SessionWait.Strings(wait?["waitExecIds"]);
                var queued = queue
                    .Select(item => SessionWait.Text(item.OpenFields?["execId"]))
                    .OfType<string>()
                    .ToHashSet(StringComparer.Ordinal);
                var retained = ids.Where(id =>
                        !id.StartsWith("transfer_", StringComparison.Ordinal) || queued.Contains(id)
                    )
                    .ToArray();
                if (wait is null || retained.Length == ids.Length)
                    return null;
                if (retained.Length > 0)
                    wait["waitExecIds"] = new JsonArray(
                        retained.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                    );
                else
                {
                    wait.Remove("waitExecIds");
                    if (
                        wait["waitAll"] is null
                        && wait["waitAnySessions"] is null
                        && wait["waitQuestionIds"] is null
                        && wait["waitForInput"] is null
                    )
                        meta.Remove("wait");
                }
                return SessionWait.Text(wait["id"]);
            }
        );

    // Question records share the strict wait/queue lane so ask, answer and close stay ordered.
    // Records hold model-written questions and notes, so they are masked like history.
    internal Task<string?> MutateQuestionsAsync(Func<JsonObject, string?> mutate) =>
        MutateWaitAsync((meta, _, _) => mutate(meta), maskQuestions: true);

    private async Task<string?> MutateWaitAsync(
        Func<JsonObject, List<QueueItem>, bool, string?> mutate,
        bool maskQuestions = false
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
            if (maskQuestions && staged.Meta["questions"] is JsonObject questions)
            {
                var masked = entry.State.RedactForHistory(questions, "history");
                if (!ReferenceEquals(masked, questions))
                {
                    var meta = (JsonObject)staged.Meta.DeepClone();
                    meta["questions"] = masked.DeepClone();
                    staged = staged with { Meta = meta };
                }
            }
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
            var key in new[] { "wait", ExternalEventReceipts.Key, WebhookReceipts.Key, "questions" }
        )
        {
            if (source.TryGetPropertyValue(key, out var value))
                target[key] = value?.DeepClone();
            else
                target.Remove(key);
        }
    }
}
