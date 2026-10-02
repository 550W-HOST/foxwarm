using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> ClearCommitScope = new();
    internal static bool IsClearCommit => ClearCommitScope.Value;

    internal async Task<SessionSnapshot> CaptureForkAsync(Func<long> effectiveBlockHighWater)
    {
        SessionSnapshot? result = null;
        await EnqueueOperationAsync(async () =>
        {
            var maximum = effectiveBlockHighWater();
            var snapshot = entry.Snapshot();
            var next = SessionBlockCounter.Resolve(snapshot, maximum);
            var cache = SessionWait.Text(snapshot.AuthorityEnvelope["promptCacheKey"]);
            var newCache = string.IsNullOrWhiteSpace(cache) ? Guid.NewGuid().ToString() : cache;
            if (cache != newCache)
            {
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                envelope["promptCacheKey"] = newCache;
                void Publish(SessionState state) { state.AuthorityEnvelope["promptCacheKey"] = newCache; }
                try { await store.CommitAsync(snapshot with { AuthorityEnvelope = envelope }, SaveKind.Strict); }
                catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
                entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
            }
            var captured = entry.Snapshot();
            var targetEnvelope = (JsonObject)captured.AuthorityEnvelope.DeepClone(); targetEnvelope["nextBlockId"] = next;
            result = captured with { AuthorityEnvelope = targetEnvelope };
        });
        return result!;
    }

    internal Task DropCapturedQueueAsync(IReadOnlyList<QueueItem> captured) => EnqueueOperationAsync(async () =>
    {
        var staged = entry.WithState(state => state.Snapshot() with
        { Queue = state.Queue.Where(item => !captured.Any(prior => ReferenceEquals(item, prior))).Select(item => item.CloneItem()).ToArray() });
        void Publish(SessionState state) => state.Queue.RemoveAll(item => captured.Any(prior => ReferenceEquals(item, prior)));
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeQueuedCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish); entry.InvokeQueuedCommitted(entry.Snapshot());
    });

    internal Task ClearHistoryAsync(IReadOnlyList<QueueItem> captured, Func<long> effectiveBlockHighWater) => EnqueueOperationAsync(async () =>
    {
        var maximum = effectiveBlockHighWater();
        var snapshot = entry.WithState(state => state.Snapshot() with
        { Queue = state.Queue.Where(item => !captured.Any(prior => ReferenceEquals(item, prior))).Select(item => item.CloneItem()).ToArray() });
        var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
        var nextBlock = SessionBlockCounter.Resolve(snapshot, maximum);
        var cache = Guid.NewGuid().ToString(); envelope["nextBlockId"] = nextBlock; envelope["promptCacheKey"] = cache;
        var meta = (JsonObject)snapshot.Meta.DeepClone();
        meta["messageCount"] = 0; meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        meta.Remove("wait"); meta.Remove("runQueuedAfterStop");
        var staged = snapshot with { History = [], Meta = meta, AuthorityEnvelope = envelope,
            HistoryVersion = snapshot.HistoryVersion + 1, Busy = false, BusyStartedAt = null, Stopping = false };
        void Publish(SessionState state)
        {
            state.PublishCommittedHistoryRewrite([], snapshot.HistoryVersion, snapshot.NextMessageSeq, snapshot.NextMessageSeq, nextBlock);
            state.Queue.RemoveAll(item => captured.Any(prior => ReferenceEquals(item, prior)));
            state.Busy = false; state.BusyStartedAt = null; state.Stopping = false;
            state.AuthorityEnvelope["promptCacheKey"] = cache;
            state.Meta["lastMessageTime"] = meta["lastMessageTime"]!.DeepClone();
            state.Meta.Remove("wait"); state.Meta.Remove("runQueuedAfterStop");
        }
        var previous = ClearCommitScope.Value; ClearCommitScope.Value = true;
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
        finally { ClearCommitScope.Value = previous; }
        entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
    });
}
