using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal Task PublishCompactWakeAsync(object owner, CancellationToken token, string? plannedIdentity = null) => EnqueueOperationAsync(async () =>
    {
        token.ThrowIfCancellationRequested();
        var item = new QueueItem(QueueItemType.CompactCommit) { CompactOwner = owner };
        var staged = entry.Snapshot();
        if (plannedIdentity is not null && staged.Id != plannedIdentity) throw new CompactionSnapshotIncompatibleException("Compaction was planned for a previous Session identity.");
        staged = staged with { Queue = staged.Queue.Append(item).ToArray() };
        void Publish(SessionState state) => state.Queue.Add(item);
        try { await store.CommitAsync(staged, SaveKind.Strict, token); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeQueuedCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    });

    internal Task RemoveCompactWakeAsync(object? owner = null, bool staleOnly = false) => EnqueueOperationAsync(async () =>
    {
        bool Owned(QueueItem item) => item.Type == QueueItemType.CompactCommit
            && (staleOnly ? item.CompactOwner is null : ReferenceEquals(item.CompactOwner, owner));
        var captured = entry.WithState(state => state.Queue.Where(Owned).ToArray());
        if (captured.Length == 0) return;
        var staged = entry.Snapshot();
        staged = staged with { Queue = staged.Queue.Where(item => !Owned(item)).ToArray() };
        void Publish(SessionState state) => state.Queue.RemoveAll(item => captured.Any(prior => ReferenceEquals(item, prior)));
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeQueuedCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    });

    internal Task ReleaseStandaloneCompactAsync() => EnqueueOperationAsync(async () =>
    {
        var snapshot = entry.Snapshot();
        var staged = snapshot with { Busy = false, BusyStartedAt = null, Stopping = false };
        void Publish(SessionState state) { state.Busy = false; state.BusyStartedAt = null; state.Stopping = false; }
        try { await store.CommitAsync(staged, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
        entry.WithState(Publish);
        entry.InvokeCommitted(entry.Snapshot());
    });
}
