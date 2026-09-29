using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class InMemorySessionAuthorityStore : ISessionAuthorityStore, ICanonicalAppendAuthorityStore
{
    private readonly ConcurrentDictionary<string, SessionSnapshot> snapshots = new();
    private readonly ConcurrentQueue<(string SessionId, SaveKind Kind)> calls = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> holds = new();
    private readonly ConcurrentDictionary<(string SessionId, SaveKind Kind), Exception> failures = new();
    private readonly ConcurrentDictionary<string, Exception> allFailures = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> commitSignals = new();

    public IReadOnlyCollection<(string SessionId, SaveKind Kind)> Calls => calls.ToArray();
    public int CommitCount => calls.Count;

    public void Hold(string sessionId) => holds[sessionId] = NewSignal();
    public Task WaitForCommitAsync(string sessionId) => commitSignals.GetOrAdd(sessionId, _ => NewSignal()).Task;
    public void ResetCommitSignal(string sessionId) => commitSignals[sessionId] = NewSignal();
    public void Release(string sessionId)
    {
        if (holds.TryRemove(sessionId, out var signal)) signal.TrySetResult(true);
    }
    public void Fail(string sessionId, Exception error, SaveKind? kind = null)
    {
        if (kind is null) allFailures[sessionId] = error;
        else failures[(sessionId, kind.Value)] = error;
    }
    public void ClearFailure(string sessionId, SaveKind? kind = null)
    {
        if (kind is null) allFailures.TryRemove(sessionId, out _);
        else failures.TryRemove((sessionId, kind.Value), out _);
    }

    public async Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken cancellationToken = default)
    {
        calls.Enqueue((snapshot.Id, kind));
        commitSignals.GetOrAdd(snapshot.Id, _ => NewSignal()).TrySetResult(true);
        if (holds.TryGetValue(snapshot.Id, out var hold)) await hold.Task.WaitAsync(cancellationToken);
        if (allFailures.TryGetValue(snapshot.Id, out var allError)) throw allError;
        if (failures.TryGetValue((snapshot.Id, kind), out var error)) throw error;
        snapshots[snapshot.Id] = Clone(snapshot);
    }

    public Task<SessionSnapshot?> LoadAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        snapshots.TryGetValue(sessionId, out var snapshot);
        return Task.FromResult(snapshot is null ? null : Clone(snapshot));
    }

    public Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default) =>
        CommitAsync(stagedSnapshot, SaveKind.Strict, cancellationToken);

    private static TaskCompletionSource<bool> NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static SessionSnapshot Clone(SessionSnapshot snapshot) => new(
        snapshot.Id,
        snapshot.History.Select(m => (JsonObject)m.DeepClone()).ToArray(),
        snapshot.Queue.Select(i => i.CloneItem()).ToArray(),
        snapshot.Busy,
        snapshot.BusyStartedAt,
        snapshot.Stopping,
        (JsonObject)snapshot.Meta.DeepClone(),
        snapshot.NextMessageSeq,
        snapshot.HistoryVersion,
        (JsonObject)snapshot.AuthorityEnvelope.DeepClone());
}


public sealed class FakeChatService : IChatService
{
    private readonly ConcurrentQueue<Call> calls = new();
    private readonly ConcurrentQueue<Func<CancellationToken, Task<string>>> plans = new();
    public IReadOnlyList<Call> Calls => calls.ToArray();
    public TaskCompletionSource<bool> FirstCallStarted { get; } = NewSignal();
    public TaskCompletionSource<bool> FirstCallCompleted { get; } = NewSignal();

    public void EnqueueResult(string text) => plans.Enqueue(_ => Task.FromResult(text));
    public void EnqueuePlan(Func<CancellationToken, Task<string>> plan) => plans.Enqueue(plan);

    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var call = new Call(sessionId, history.Select(m => (JsonObject)m.DeepClone()).ToArray());
        calls.Enqueue(call);
        FirstCallStarted.TrySetResult(true);
        var plan = plans.TryDequeue(out var queued) ? queued : (_ => Task.FromResult("ok"));
        var result = await plan(cancellationToken).ConfigureAwait(false);
        FirstCallCompleted.TrySetResult(true);
        return ChatResult.Text(result);
    }

    public sealed record Call(string SessionId, IReadOnlyList<JsonObject> History);
    private static TaskCompletionSource<bool> NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
