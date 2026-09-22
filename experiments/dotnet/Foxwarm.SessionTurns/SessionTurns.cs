using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.MessageJson;
using Foxwarm.SessionPersistence;

namespace Foxwarm.SessionTurns;

public enum QueueItemType
{
    User,
    Intersession,
    Background,
    Trigger,
    OnBoot,
    CompactCommit,
    Tools,
    Retry,
    Wait,
    Managed,
    Channel,
}

public sealed record QueueSource(
    string Platform,
    string ChannelUserId,
    string? ChannelId = null,
    string? ChannelType = null,
    string? ConversationId = null,
    string? Username = null,
    string? SenderId = null,
    JsonObject? OpenFields = null);

public sealed record QueueItem(
    QueueItemType Type,
    IReadOnlyList<JsonObject>? Parts = null,
    JsonObject? Message = null,
    QueueSource? Source = null,
    string? ClientMessageId = null,
    string? SourceSessionId = null,
    string? SourceSessionRelation = null,
    JsonObject? OpenFields = null)
{
    public static QueueItem UserText(string text, QueueSource? source = null, string? clientMessageId = null) =>
        new(QueueItemType.User, new[] { new JsonObject { ["text"] = text } }, null, source, clientMessageId);

    public static QueueItem Prebuilt(JsonObject message, QueueSource? source = null) =>
        new(QueueItemType.User, null, (JsonObject)message.DeepClone(), source);

    public QueueItem CloneItem() => this with
    {
        Parts = Parts?.Select(p => (JsonObject)p.DeepClone()).ToArray(),
        Message = Message is null ? null : (JsonObject)Message.DeepClone(),
        Source = Source is null ? null : Source with { OpenFields = Source.OpenFields is null ? null : (JsonObject)Source.OpenFields.DeepClone() },
        OpenFields = OpenFields is null ? null : (JsonObject)OpenFields.DeepClone()
    };
}

public sealed class SessionState
{
    public string Id { get; }
    public List<JsonObject> History { get; } = new();
    public List<QueueItem> Queue { get; } = new();
    public bool Busy { get; internal set; }
    public long? BusyStartedAt { get; internal set; }
    public bool Stopping { get; internal set; }
    public JsonObject Meta { get; } = new();
    public long NextMessageSeq { get; internal set; } = 1;
    public long HistoryVersion { get; internal set; }
    public JsonObject AuthorityEnvelope { get; } = new();

    public SessionState(string id) => Id = id;

    internal SessionState Clone()
    {
        var clone = new SessionState(Id)
        {
            Busy = Busy,
            BusyStartedAt = BusyStartedAt,
            Stopping = Stopping,
            NextMessageSeq = NextMessageSeq,
            HistoryVersion = HistoryVersion,
        };
        clone.History.AddRange(History.Select(message => (JsonObject)message.DeepClone()));
        clone.Queue.AddRange(Queue.Select(item => item.CloneItem()));
        foreach (var property in Meta) clone.Meta[property.Key] = property.Value?.DeepClone();
        foreach (var property in AuthorityEnvelope) clone.AuthorityEnvelope[property.Key] = property.Value?.DeepClone();
        return clone;
    }

    public SessionSnapshot Snapshot()
    {
        var clone = Clone();
        return new SessionSnapshot(
            clone.Id,
            clone.History.Select(m => (JsonObject)m.DeepClone()).ToArray(),
            clone.Queue.Select(i => i.CloneItem()).ToArray(),
            clone.Busy,
            clone.BusyStartedAt,
            clone.Stopping,
            (JsonObject)clone.Meta.DeepClone(),
            clone.NextMessageSeq,
            clone.HistoryVersion,
            (JsonObject)clone.AuthorityEnvelope.DeepClone());
    }
}

public sealed record SessionSnapshot(
    string Id,
    IReadOnlyList<JsonObject> History,
    IReadOnlyList<QueueItem> Queue,
    bool Busy,
    long? BusyStartedAt,
    bool Stopping,
    JsonObject Meta,
    long NextMessageSeq,
    long HistoryVersion,
    JsonObject AuthorityEnvelope);

public enum SaveKind
{
    Strict,
    BestEffort,
}

public interface ISessionAuthorityStore
{
    Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken cancellationToken = default);
    Task<SessionSnapshot?> LoadAsync(string sessionId, CancellationToken cancellationToken = default);
}

public interface ICanonicalAppendAuthorityStore
{
    Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default);
}

internal sealed record CanonicalAppendPreparation(
    SessionSnapshot StagedSnapshot,
    IReadOnlyList<JsonObject> AppendedMessages,
    Action<SessionState> Publish);

/// <summary>Test-only authority snapshot store. It proves ordering and round-trip cloning only.</summary>
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

public sealed class SessionSaveLane
{
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

    public async Task SaveBestEffortAsync(CancellationToken cancellationToken = default)
    {
        try { await EnqueueAsync(SaveKind.BestEffort, cancellationToken); }
        catch (Exception error) { entry.RecordBestEffortFailure(error); }
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

public sealed class SessionEntry
{
    private int processorClaim;
    private int processorClaimCount;
    private readonly object stateGate = new();
    private CancellationHandle? activeCancellation;
    private long busyClaimVersion;
    private int bestEffortFailures;
    private int postCommitNotificationFailures;
    private int backgroundProcessorFailures;
    private Exception? lastPostCommitNotificationFailure;
    private Exception? lastBackgroundProcessorFailure;
    private readonly TaskCompletionSource<Exception> backgroundProcessorFailureSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public SessionState State { get; }
    public SessionSaveLane SaveLane { get; }
    public object StateGate => stateGate;
    public int BestEffortFailureCount => Volatile.Read(ref bestEffortFailures);
    public int ProcessorClaimCount => Volatile.Read(ref processorClaimCount);
    public int PostCommitNotificationFailureCount => Volatile.Read(ref postCommitNotificationFailures);
    public Exception? LastPostCommitNotificationFailure => Volatile.Read(ref lastPostCommitNotificationFailure);
    public int BackgroundProcessorFailureCount => Volatile.Read(ref backgroundProcessorFailures);
    public Exception? LastBackgroundProcessorFailure => Volatile.Read(ref lastBackgroundProcessorFailure);
    public Action<SessionSnapshot>? Committed { get; set; }

    public SessionEntry(SessionState state, ISessionAuthorityStore store)
    {
        State = state;
        SaveLane = new SessionSaveLane(this, store);
    }

    public SessionSnapshot Snapshot() { lock (stateGate) return State.Snapshot(); }
    internal SessionSnapshot SnapshotForPersistence() => Snapshot();
    internal void RecordBestEffortFailure(Exception error) => Interlocked.Increment(ref bestEffortFailures);
    internal void RecordPostCommitNotificationFailure(Exception error)
    {
        Volatile.Write(ref lastPostCommitNotificationFailure, error);
        Interlocked.Increment(ref postCommitNotificationFailures);
    }
    internal void RecordBackgroundProcessorFailure(Exception error)
    {
        Volatile.Write(ref lastBackgroundProcessorFailure, error);
        Interlocked.Increment(ref backgroundProcessorFailures);
        backgroundProcessorFailureSignal.TrySetResult(error);
    }
    public Task<Exception> WaitForBackgroundProcessorFailureAsync() => backgroundProcessorFailureSignal.Task;

    public bool TryClaimProcessor()
    {
        if (Interlocked.CompareExchange(ref processorClaim, 1, 0) != 0) return false;
        Interlocked.Increment(ref processorClaimCount);
        return true;
    }
    public void ReleaseProcessor() => Volatile.Write(ref processorClaim, 0);

    internal T WithState<T>(Func<SessionState, T> action)
    {
        lock (stateGate) return action(State);
    }

    internal void WithState(Action<SessionState> action)
    {
        lock (stateGate) action(State);
    }

    internal long MarkBusy()
    {
        lock (stateGate)
        {
            if (State.Busy || State.Stopping) return 0;
            State.Busy = true;
            State.BusyStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return ++busyClaimVersion;
        }
    }

    internal bool RollbackBusy(long version)
    {
        lock (stateGate)
        {
            if (version == 0 || version != busyClaimVersion || !State.Busy) return false;
            State.Busy = false;
            State.BusyStartedAt = null;
            return true;
        }
    }

    internal bool ReleaseBusy()
    {
        lock (stateGate)
        {
            if (!State.Busy && State.BusyStartedAt is null) return false;
            State.Busy = false;
            State.BusyStartedAt = null;
            return true;
        }
    }

    public CancellationHandle RegisterCancellationForTest(CancellationTokenSource source) => RegisterCancellation(source) ?? throw new InvalidOperationException("Cancellation registration was not created.");
    public void ClearCancellationForTest(CancellationHandle handle) => ClearCancellation(handle);
    public void SetStoppingForTest(bool value) => WithState(state => state.Stopping = value);

    internal CancellationHandle? RegisterCancellation(CancellationTokenSource source)
    {
        lock (stateGate)
        {
            if (State.Stopping) throw new OperationCanceledException("Session is stopping.");
            if (activeCancellation is not null) throw new InvalidOperationException("An active cancellation handle is already registered.");
            var handle = new CancellationHandle(source);
            activeCancellation = handle;
            return handle;
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
        if (dispose) handle.Dispose();
    }

    internal CancellationHandle? BeginStop()
    {
        lock (stateGate)
        {
            State.Stopping = true;
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
        try { Committed?.Invoke(snapshot); }
        catch (Exception error) { RecordPostCommitNotificationFailure(error); }
    }
}

public sealed class CancellationHandle : IDisposable
{
    private int disposed;
    internal CancellationHandle(CancellationTokenSource source) => Source = source;
    internal CancellationTokenSource Source { get; }
    internal bool TakenByStop { get; set; }
    public CancellationToken Token => Source.Token;
    public void Cancel() => Source.Cancel();
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) Source.Dispose();
    }
}

public interface IChatService
{
    Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken);
}

public interface ITurnToolExecutor
{
    Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken);
}

public sealed class UnsupportedTurnToolExecutor : ITurnToolExecutor
{
    public Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>() ?? "";
        return Task.FromResult(ToolError("unknown_tool", $"Unknown tool: {name}"));
    }

    public static JsonObject ToolError(string type, string message) => new()
    {
        ["error"] = new JsonObject { ["type"] = type, ["message"] = message }
    };
}

public sealed class ToolLoopLimitException(int limit)
    : InvalidOperationException($"Experimental Session turn exceeded the {limit} iteration tool-loop limit.");

public sealed record ChatResult(JsonObject? AssistantMessage)
{
    public static ChatResult Text(string text) => new(new JsonObject
    {
        ["role"] = "model",
        ["parts"] = new JsonArray(new JsonObject { ["text"] = text })
    });
}

public sealed class UnsupportedSessionTurnException : InvalidOperationException
{
    public string Path { get; }
    public UnsupportedSessionTurnException(string path) : base($"Experimental Session turns do not support {path}.") => Path = path;
}

public sealed class LocalSessionTurnHost
{
    private readonly SessionEntry entry;
    private readonly IChatService chat;
    private readonly ITurnToolExecutor tools;
    private readonly int maxToolIterations;
    private readonly Func<long> clock;
    private int releaseCommits;

    public LocalSessionTurnHost(
        SessionEntry entry,
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor? tools = null,
        int maxToolIterations = 500,
        Func<long>? clock = null)
    {
        this.entry = entry;
        this.chat = chat;
        this.tools = tools ?? new UnsupportedTurnToolExecutor();
        this.maxToolIterations = maxToolIterations > 0 ? maxToolIterations : throw new ArgumentOutOfRangeException(nameof(maxToolIterations));
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public int ReleaseCommitCount => Volatile.Read(ref releaseCommits);

    public async Task<bool> TryClaimBusyAsync()
    {
        var version = entry.MarkBusy();
        if (version == 0) return false;
        try
        {
            await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false);
            return true;
        }
        catch (Exception error)
        {
            if (error is not AuthorityCommittedException) entry.RollbackBusy(version);
            throw;
        }
    }

    public async Task AppendQueuedInputsAsync(IReadOnlyList<QueueItem> items)
    {
        if (items.Count == 0) return;
        foreach (var item in items) SessionIngress.EnsureSupportedForRunner(item);
        await entry.SaveLane.CommitCanonicalAppendAsync(state => PrepareQueuedAppend(state, items, finalizing: false, clock)).ConfigureAwait(false);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    public async Task<ChatResult> ChatAsync(string turnId)
    {
        var requestCts = new CancellationTokenSource();
        CancellationHandle? handle = null;
        try
        {
            handle = entry.RegisterCancellation(requestCts);
            var registered = handle ?? throw new InvalidOperationException("Cancellation registration was not created.");
            for (var iteration = 0; iteration < maxToolIterations; iteration++)
            {
                var history = entry.WithState(state => state.History.Select(m => (JsonObject)m.DeepClone()).ToArray());
                var result = await chat.ChatAsync(entry.State.Id, history, registered.Token).ConfigureAwait(false);
                if (result.AssistantMessage is null) return result;
                var assistant = (JsonObject)result.AssistantMessage.DeepClone();
                if (assistant["role"]?.GetValue<string>() != "model" || assistant["parts"] is not JsonArray)
                    throw new InvalidOperationException("Chat result assistant message must be a canonical model message.");
                await AppendHistoryMessageStrictAsync(assistant).ConfigureAwait(false);

                var calls = ExtractFunctionCalls(assistant);
                if (calls.Count == 0) return result;

                var toolParts = new JsonArray();
                foreach (var call in calls)
                {
                    registered.Token.ThrowIfCancellationRequested();
                    var callId = call["id"]?.GetValue<string>()
                        ?? throw new InvalidOperationException("Canonical function call is missing its stable ID.");
                    var name = call["name"]?.GetValue<string>() ?? "";
                    JsonObject response;
                    if (call["argsParseError"] is JsonValue parseErrorValue
                        && parseErrorValue.TryGetValue<string>(out var parseError)
                        && parseError.Length > 0)
                    {
                        response = UnsupportedTurnToolExecutor.ToolError("invalid_tool_arguments", parseError);
                    }
                    else
                    {
                        response = await tools.ExecuteAsync((JsonObject)call.DeepClone(), registered.Token).ConfigureAwait(false);
                    }
                    toolParts.Add(new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = callId,
                            ["name"] = name,
                            ["response"] = response.DeepClone()
                        }
                    });
                }

                var toolMessage = new JsonObject { ["role"] = "tool", ["parts"] = toolParts };
                await AppendHistoryMessageStrictAsync(toolMessage).ConfigureAwait(false);
                if (entry.WithState(state => state.Stopping)) throw new OperationCanceledException(registered.Token);
                await AppendQueuedFollowUpsAfterToolAsync().ConfigureAwait(false);
                if (iteration + 1 >= maxToolIterations) throw new ToolLoopLimitException(maxToolIterations);
            }
            throw new ToolLoopLimitException(maxToolIterations);
        }
        finally
        {
            if (handle is not null) entry.ClearCancellation(handle);
            else requestCts.Dispose();
        }
    }

    private async Task AppendHistoryMessageStrictAsync(JsonObject message)
    {
        await entry.SaveLane.CommitCanonicalAppendAsync(state =>
            PrepareCanonicalAppend(state, [message], [], updateLastMessageTime: false, finalizing: false, clock)).ConfigureAwait(false);
        entry.InvokeCommitted(entry.Snapshot());
    }

    private static IReadOnlyList<JsonObject> ExtractFunctionCalls(JsonObject assistant)
    {
        var calls = new List<JsonObject>();
        foreach (var node in assistant["parts"] as JsonArray ?? [])
            if (node is JsonObject part && part["functionCall"] is JsonObject call)
                calls.Add((JsonObject)call.DeepClone());
        return calls;
    }

    private async Task AppendQueuedFollowUpsAfterToolAsync()
    {
        if (entry.WithState(state => state.Stopping || state.Queue.Count == 0)) return;
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        var batch = SessionTurnRunner.DrainLeading(entry);
        if (batch.Count > 0)
        {
            await AppendQueuedInputsAsync(batch).ConfigureAwait(false);
            return;
        }
        var remainingHead = entry.WithState(state => state.Queue.FirstOrDefault()?.CloneItem());
        if (remainingHead is not null) SessionIngress.EnsureSupportedForRunner(remainingHead);
    }

    public async Task ReleaseBusyAsync()
    {
        var beforeBusy = false;
        long? beforeBusyStartedAt = null;
        var changed = entry.WithState(state =>
        {
            if (!state.Busy && state.BusyStartedAt is null) return false;
            beforeBusy = state.Busy;
            beforeBusyStartedAt = state.BusyStartedAt;
            state.Busy = false;
            state.BusyStartedAt = null;
            return true;
        });
        if (!changed) return;
        Interlocked.Increment(ref releaseCommits);
        try { await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false); }
        catch (Exception error)
        {
            if (error is not AuthorityCommittedException)
                entry.WithState(state =>
                {
                    if (!state.Busy && state.BusyStartedAt is null)
                    {
                        state.Busy = beforeBusy;
                        state.BusyStartedAt = beforeBusyStartedAt;
                    }
                });
            throw;
        }
        entry.InvokeCommitted(entry.Snapshot());
    }

    public async Task FinalizeStoppedAsync()
    {
        var items = entry.WithState(state => state.Queue.ToArray());
        foreach (var item in items.Where(item => item.Type != QueueItemType.CompactCommit)) SessionIngress.EnsureSupportedForRunner(item);
        await entry.SaveLane.CommitCanonicalAppendAsync(state => PrepareQueuedAppend(state, items, finalizing: true, clock)).ConfigureAwait(false);
        Interlocked.Increment(ref releaseCommits);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    private static CanonicalAppendPreparation PrepareQueuedAppend(
        SessionState state,
        IReadOnlyList<QueueItem> selectedItems,
        bool finalizing,
        Func<long> clock)
    {
        if (state.Queue.Count < selectedItems.Count) throw new InvalidOperationException("Selected queue items are no longer available.");
        for (var index = 0; index < selectedItems.Count; index++)
            if (!ReferenceEquals(state.Queue[index], selectedItems[index]))
                throw new InvalidOperationException("Selected queue identity changed before canonical append.");

        var rawMessages = new List<JsonObject>();
        var historyEmpty = state.History.Count == 0;
        var committedAnyInput = false;
        var updateLastMessageTime = false;
        foreach (var item in selectedItems)
        {
            if (item.Type == QueueItemType.CompactCommit)
            {
                if (!finalizing) throw new UnsupportedSessionTurnException("compact");
                continue;
            }
            if (item.Message is not null)
            {
                rawMessages.Add((JsonObject)item.Message.DeepClone());
                committedAnyInput = true;
                continue;
            }
            if (item.Parts is null || item.Parts.Count == 0) continue;
            var parts = item.Parts.Select(part => (JsonObject)part.DeepClone()).ToArray();
            if (!committedAnyInput)
            {
                updateLastMessageTime = true;
                if (historyEmpty) parts = new[] { SessionTag(state.Id) }.Concat(parts).ToArray();
            }
            var message = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray())
            };
            if (item.ClientMessageId is not null) message["__meta"] = new JsonObject { ["clientMessageId"] = item.ClientMessageId };
            rawMessages.Add(message);
            committedAnyInput = true;
        }
        return PrepareCanonicalAppend(state, rawMessages, selectedItems, updateLastMessageTime, finalizing, clock);
    }

    private static CanonicalAppendPreparation PrepareCanonicalAppend(
        SessionState state,
        IReadOnlyList<JsonObject> rawMessages,
        IReadOnlyList<QueueItem> selectedItems,
        bool updateLastMessageTime,
        bool finalizing,
        Func<long> clock)
    {
        var capturedNextSeq = state.NextMessageSeq;
        var capturedHistoryVersion = state.HistoryVersion;
        var canonicalMessages = new List<JsonObject>(rawMessages.Count);
        var nextSeq = capturedNextSeq;
        foreach (var rawMessage in rawMessages)
        {
            var message = (JsonObject)rawMessage.DeepClone();
            var meta = message["__meta"] switch
            {
                null => new JsonObject(),
                JsonObject value => (JsonObject)value.DeepClone(),
                _ => throw new InvalidDataException("Canonical message __meta must be an object.")
            };
            if (meta.ContainsKey("seq")) throw new UnsupportedSessionTurnException("caller-supplied message seq");
            if (!meta.ContainsKey("timestamp") || meta["timestamp"] is null || IsZeroNumber(meta["timestamp"]))
                meta["timestamp"] = clock();
            message["__meta"] = meta;
            meta["seq"] = nextSeq++;
            canonicalMessages.Add(message);
        }

        var stagedHistory = state.History.Select(message => (JsonObject)message.DeepClone()).ToList();
        stagedHistory.AddRange(canonicalMessages.Select(message => (JsonObject)message.DeepClone()));
        var stagedQueue = state.Queue.Skip(selectedItems.Count).Select(item => item.CloneItem()).ToArray();
        var stagedMeta = (JsonObject)state.Meta.DeepClone();
        JsonNode? previousLastMessageTime = state.Meta["lastMessageTime"]?.DeepClone();
        var hadLastMessageTime = state.Meta.ContainsKey("lastMessageTime");
        if (updateLastMessageTime) stagedMeta["lastMessageTime"] = clock();
        stagedMeta["messageCount"] = stagedHistory.Count;
        var stagedHistoryVersion = capturedHistoryVersion;
        var staged = new SessionSnapshot(
            state.Id,
            stagedHistory,
            stagedQueue,
            finalizing ? false : state.Busy,
            finalizing ? null : state.BusyStartedAt,
            finalizing ? false : state.Stopping,
            stagedMeta,
            nextSeq,
            stagedHistoryVersion,
            (JsonObject)state.AuthorityEnvelope.DeepClone());

        return new CanonicalAppendPreparation(staged, canonicalMessages, live =>
        {
            if (live.NextMessageSeq != capturedNextSeq || live.HistoryVersion != capturedHistoryVersion)
                throw new InvalidOperationException("Canonical append base changed before publish.");
            if (live.Queue.Count < selectedItems.Count) throw new InvalidOperationException("Selected queue items disappeared before publish.");
            for (var index = 0; index < selectedItems.Count; index++)
                if (!ReferenceEquals(live.Queue[index], selectedItems[index]))
                    throw new InvalidOperationException("Selected queue identity changed before publish.");
            live.Queue.RemoveRange(0, selectedItems.Count);
            live.History.AddRange(canonicalMessages);
            live.NextMessageSeq = nextSeq;
            live.HistoryVersion = stagedHistoryVersion;
            live.Meta["messageCount"] = live.History.Count;
            if (updateLastMessageTime
                && live.Meta.ContainsKey("lastMessageTime") == hadLastMessageTime
                && JsonNode.DeepEquals(live.Meta["lastMessageTime"], previousLastMessageTime))
                live.Meta["lastMessageTime"] = stagedMeta["lastMessageTime"]?.DeepClone();
            if (finalizing)
            {
                live.Busy = false;
                live.BusyStartedAt = null;
                live.Stopping = false;
            }
        });
    }

    private static bool IsZeroNumber(JsonNode? node)
    {
        if (node is not JsonValue value) return false;
        if (value.TryGetValue<double>(out var floating)) return floating == 0;
        if (value.TryGetValue<long>(out var signed)) return signed == 0;
        if (value.TryGetValue<int>(out var integer)) return integer == 0;
        if (value.TryGetValue<decimal>(out var decimalValue)) return decimalValue == 0;
        return false;
    }

    private static JsonObject SessionTag(string sessionId) => new()
    {
        ["system"] = $"<foxwarm-system kind=\"session\" currentSessionId=\"{EscapeFoxwarmAttribute(sessionId)}\" />"
    };

    private static string EscapeFoxwarmAttribute(string value)
    {
        var normalized = new string(value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Select(character => character switch
            {
                >= '\u0000' and <= '\u0008' or '\u000B' or '\u000C' or >= '\u000E' and <= '\u001F' or '\u007F' => ' ',
                '\n' => ' ',
                _ => character,
            }).ToArray());
        var collapsed = new StringBuilder(normalized.Length);
        var pendingWhitespace = false;
        foreach (var character in normalized)
        {
            if (IsEcmaWhitespace(character))
            {
                pendingWhitespace = collapsed.Length > 0;
                continue;
            }
            if (pendingWhitespace) collapsed.Append(' ');
            collapsed.Append(character);
            pendingWhitespace = false;
        }
        normalized = collapsed.ToString();
        return normalized
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }

    private static bool IsEcmaWhitespace(char character) => character is
        '\u0009' or '\u000A' or '\u000B' or '\u000C' or '\u000D' or '\u0020' or '\u00A0' or
        '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' ||
        character is >= '\u2000' and <= '\u200A';

}

public sealed class SessionIngress
{
    private readonly SessionRegistry registry;
    public SessionIngress(SessionRegistry registry) => this.registry = registry;

    public async Task EnqueueAsync(string sessionId, QueueItem item)
    {
        EnsureSupported(item);
        var entry = registry.GetRequired(sessionId);
        entry.WithState(state => state.Queue.Add(item.CloneItem()));
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        if (!entry.WithState(state => state.Busy || state.Stopping)) registry.Trigger(sessionId);
    }

    internal static void EnsureSupportedForRunner(QueueItem item) => EnsureSupported(item);

    private static void EnsureSupported(QueueItem item)
    {
        if (item.Type is QueueItemType.CompactCommit) throw new UnsupportedSessionTurnException("compact");
        if (item.Type is QueueItemType.Tools) throw new UnsupportedSessionTurnException("tools");
        if (item.Type is QueueItemType.Retry) throw new UnsupportedSessionTurnException("retry");
        if (item.Type is QueueItemType.Wait) throw new UnsupportedSessionTurnException("waits");
        if (item.Type is QueueItemType.Managed) throw new UnsupportedSessionTurnException("managed state");
        if (item.Type is QueueItemType.Channel) throw new UnsupportedSessionTurnException("channel delivery");
    }
}

public sealed class SessionControl
{
    private readonly SessionRegistry registry;
    public SessionControl(SessionRegistry registry) => this.registry = registry;

    public async Task<StopResult> StopAsync(string sessionId)
    {
        var entry = registry.GetRequired(sessionId);
        var handle = entry.BeginStop();
        var aborted = handle is not null;
        if (handle is not null)
        {
            handle.Cancel();
            handle.Dispose();
        }
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        return new StopResult(aborted, true);
    }
}

public sealed record StopResult(bool AbortedInFlight, bool StoppedCurrent);

public sealed class SessionTurnRunner
{
    private readonly SessionRegistry registry;
    private readonly LocalSessionTurnHostFactory hosts;
    private long turnSequence;

    internal SessionTurnRunner(SessionRegistry registry, LocalSessionTurnHostFactory hosts)
    {
        this.registry = registry;
        this.hosts = hosts;
    }

    public async Task ProcessQueueAsync(string sessionId)
    {
        var entry = registry.GetRequired(sessionId);
        if (!entry.TryClaimProcessor()) return;
        var claimed = false;
        var failed = false;
        try
        {
            var host = hosts.For(entry);
            claimed = await host.TryClaimBusyAsync().ConfigureAwait(false);
            if (!claimed) return;
            while (true)
            {
                if (entry.WithState(state => state.Stopping))
                {
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                if (!entry.WithState(state => state.Queue.Count > 0)) break;
                await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
                var batch = DrainLeading(entry);
                if (batch.Count == 0)
                {
                    var remainingHead = entry.WithState(state => state.Queue.FirstOrDefault()?.CloneItem());
                    if (remainingHead is not null) SessionIngress.EnsureSupportedForRunner(remainingHead);
                    break;
                }
                await host.AppendQueuedInputsAsync(batch).ConfigureAwait(false);
                try
                {
                    await host.ChatAsync($"turn-{Interlocked.Increment(ref turnSequence)}").ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (entry.WithState(state => state.Stopping))
                {
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                catch (AuthorityCommittedException)
                {
                    throw;
                }
                catch
                {
                    break;
                }
            }
        }
        catch
        {
            failed = true;
            throw;
        }
        finally
        {
            try
            {
                if (claimed) await hosts.For(entry).ReleaseBusyAsync().ConfigureAwait(false);
            }
            finally
            {
                entry.ReleaseProcessor();
                if (!failed && entry.WithState(state => !state.Busy && state.Queue.Count > 0)) registry.Trigger(sessionId);
            }
        }
    }

    internal static IReadOnlyList<QueueItem> DrainLeading(SessionEntry entry)
    {
        return entry.WithState(state =>
        {
            var result = new List<QueueItem>();
            var index = 0;
            while (index < state.Queue.Count)
            {
                var item = state.Queue[index];
                if (item.Type == QueueItemType.CompactCommit) break;
                result.Add(item);
                index++;
            }
            return (IReadOnlyList<QueueItem>)result;
        });
    }
}

public sealed class LocalSessionTurnHostFactory
{
    private readonly ISessionAuthorityStore store;
    private readonly IChatService chat;
    private readonly ITurnToolExecutor tools;
    private readonly int maxToolIterations;
    private readonly Func<long> clock;
    public LocalSessionTurnHostFactory(
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor tools,
        int maxToolIterations,
        Func<long>? clock = null)
    {
        this.store = store;
        this.chat = chat;
        this.tools = tools;
        this.maxToolIterations = maxToolIterations;
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }
    public LocalSessionTurnHost For(SessionEntry entry) => new(entry, store, chat, tools, maxToolIterations, clock);
}

public sealed class SessionRegistry
{
    private readonly ConcurrentDictionary<string, SessionEntry> entries = new();
    private readonly LocalSessionTurnHostFactory hosts;
    private readonly SessionTurnRunner runner;
    private readonly SessionIngress ingress;
    private readonly SessionControl control;

    public SessionRegistry(
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor? tools = null,
        int maxToolIterations = 500,
        Func<long>? clock = null)
    {
        Store = store;
        hosts = new LocalSessionTurnHostFactory(store, chat, tools ?? new UnsupportedTurnToolExecutor(), maxToolIterations, clock);
        runner = new SessionTurnRunner(this, hosts);
        ingress = new SessionIngress(this);
        control = new SessionControl(this);
    }

    public SessionIngress Ingress => ingress;
    public SessionControl Control => control;
    public SessionTurnRunner Runner => runner;
    public Func<string, Task>? TriggerOverride { get; set; }
    internal ISessionAuthorityStore Store { get; }

    public SessionEntry Add(string sessionId, SessionSnapshot? snapshot = null)
    {
        var state = new SessionState(sessionId);
        if (snapshot is not null) Restore(state, snapshot);
        var entry = new SessionEntry(state, Store);
        if (!entries.TryAdd(sessionId, entry)) throw new InvalidOperationException($"Session '{sessionId}' already exists.");
        return entry;
    }

    public async Task<SessionEntry> LoadOrAddAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        if (entries.TryGetValue(sessionId, out var existing)) return existing;
        var snapshot = await Store.LoadAsync(sessionId, cancellationToken).ConfigureAwait(false);
        return Add(sessionId, snapshot);
    }

    public SessionEntry GetRequired(string sessionId) => entries.TryGetValue(sessionId, out var entry)
        ? entry
        : throw new KeyNotFoundException($"Session '{sessionId}' not found.");

    internal void Trigger(string sessionId)
    {
        if (TriggerOverride is not null) _ = TriggerOverride(sessionId);
        else _ = ObserveTriggeredProcessorAsync(sessionId, Runner.ProcessQueueAsync(sessionId));
    }

    public Task TriggerProcessingAsync(string sessionId) => Runner.ProcessQueueAsync(sessionId);

    private async Task ObserveTriggeredProcessorAsync(string sessionId, Task processing)
    {
        try { await processing.ConfigureAwait(false); }
        catch (Exception error) { GetRequired(sessionId).RecordBackgroundProcessorFailure(error); }
    }

    private static void Restore(SessionState state, SessionSnapshot snapshot)
    {
        state.History.AddRange(snapshot.History.Select(m => (JsonObject)m.DeepClone()));
        state.Queue.AddRange(snapshot.Queue.Select(i => i.CloneItem()));
        state.Busy = snapshot.Busy;
        state.BusyStartedAt = snapshot.BusyStartedAt;
        state.Stopping = snapshot.Stopping;
        state.NextMessageSeq = snapshot.NextMessageSeq;
        state.HistoryVersion = snapshot.HistoryVersion;
        foreach (var property in snapshot.Meta) state.Meta[property.Key] = property.Value?.DeepClone();
        foreach (var property in snapshot.AuthorityEnvelope) state.AuthorityEnvelope[property.Key] = property.Value?.DeepClone();
    }
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
