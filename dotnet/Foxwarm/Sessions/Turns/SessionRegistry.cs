using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class LocalSessionTurnHostFactory
{
    private readonly ISessionAuthorityStore store;
    private readonly IChatService chat;
    private readonly ITurnToolExecutor tools;
    private readonly int maxToolIterations;
    private readonly Func<long> clock;
    private readonly Func<SessionEntry, Task>? safePoint;
    private readonly Func<SessionEntry, ChatResult, Task>? automaticCompact;
    private readonly Func<SessionEntry, Task>? retrySafePoint;

    public LocalSessionTurnHostFactory(
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor tools,
        int maxToolIterations,
        Func<long>? clock = null,
        Func<SessionEntry, Task>? safePoint = null,
        Func<SessionEntry, ChatResult, Task>? automaticCompact = null,
        Func<SessionEntry, Task>? retrySafePoint = null
    )
    {
        this.store = store;
        this.chat = chat;
        this.tools = tools;
        this.maxToolIterations = maxToolIterations;
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.safePoint = safePoint;
        this.automaticCompact = automaticCompact;
        this.retrySafePoint = retrySafePoint;
    }

    public LocalSessionTurnHost For(SessionEntry entry) =>
        new(
            entry,
            store,
            chat,
            tools,
            maxToolIterations,
            clock,
            () => safePoint?.Invoke(entry) ?? Task.CompletedTask,
            result => automaticCompact?.Invoke(entry, result) ?? Task.CompletedTask,
            () => retrySafePoint?.Invoke(entry) ?? safePoint?.Invoke(entry) ?? Task.CompletedTask
        );
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
        Func<long>? clock = null
    )
    {
        Store = store;
        hosts = new LocalSessionTurnHostFactory(
            store,
            chat,
            tools ?? new UnsupportedTurnToolExecutor(),
            maxToolIterations,
            clock,
            entry =>
                OnSafePoint?.Invoke(entry)
                ?? entry.SaveLane.RemoveCompactWakeAsync(staleOnly: true),
            (entry, result) => OnTurnCompleted?.Invoke(entry, result) ?? Task.CompletedTask,
            entry =>
                OnRetrySafePoint?.Invoke(entry)
                ?? OnSafePoint?.Invoke(entry)
                ?? entry.SaveLane.RemoveCompactWakeAsync(staleOnly: true)
        );
        runner = new SessionTurnRunner(this, hosts);
        ingress = new SessionIngress(this);
        control = new SessionControl(this);
    }

    public SessionIngress Ingress => ingress;
    public SessionControl Control => control;
    public SessionTurnRunner Runner => runner;

    public LocalSessionTurnHost HostFor(string sessionId) => hosts.For(GetRequired(sessionId));

    public Func<string, Task>? TriggerOverride { get; set; }
    public Func<SessionEntry, Task>? OnTurnStarting { get; set; }
    public Func<SessionEntry, ChatResult, Task>? OnTurnCompleted { get; set; }
    public Func<SessionEntry, Task>? OnSafePoint { get; set; }
    public Func<SessionEntry, Task>? OnRetrySafePoint { get; set; }
    public Func<SessionEntry, bool>? HasCompletedCompact { get; set; }

    internal bool HasRunnableWork(SessionEntry entry) =>
        HasCompletedCompact?.Invoke(entry) == true
        || entry.WithState(state =>
            state.Queue.Any(item =>
                item.Type != QueueItemType.CompactCommit || item.CompactOwner is null
            )
        );

    internal ISessionAuthorityStore Store { get; }

    public SessionEntry Add(string sessionId, SessionSnapshot? snapshot = null)
    {
        var state = new SessionState(sessionId);
        if (snapshot is not null)
            Restore(state, snapshot);
        var entry = new SessionEntry(state, Store);
        if (!entries.TryAdd(sessionId, entry))
            throw new InvalidOperationException($"Session '{sessionId}' already exists.");
        return entry;
    }

    internal void BindIdentity(string id, SessionEntry entry)
    {
        if (!entries.TryAdd(id, entry) && !ReferenceEquals(entries[id], entry))
            throw new InvalidOperationException(
                "Session registry identity belongs to another lifetime."
            );
    }

    public async Task<SessionEntry> LoadOrAddAsync(
        string sessionId,
        CancellationToken cancellationToken = default
    )
    {
        if (entries.TryGetValue(sessionId, out var existing))
            return existing;
        var snapshot = await Store.LoadAsync(sessionId, cancellationToken).ConfigureAwait(false);
        return Add(sessionId, snapshot);
    }

    public SessionEntry GetRequired(string sessionId) =>
        entries.TryGetValue(sessionId, out var entry)
            ? entry
            : throw new KeyNotFoundException($"Session '{sessionId}' not found.");

    internal void Trigger(string sessionId)
    {
        if (TriggerOverride is not null)
            _ = TriggerOverride(sessionId);
        else
            _ = ObserveTriggeredProcessorAsync(sessionId, Runner.ProcessQueueAsync(sessionId));
    }

    public Task TriggerProcessingAsync(string sessionId) => Runner.ProcessQueueAsync(sessionId);

    private async Task ObserveTriggeredProcessorAsync(string sessionId, Task processing)
    {
        try
        {
            await processing.ConfigureAwait(false);
        }
        catch (Exception error)
        {
            GetRequired(sessionId).RecordBackgroundProcessorFailure(error);
        }
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
        foreach (var property in snapshot.Meta)
            state.Meta[property.Key] = property.Value?.DeepClone();
        foreach (var property in snapshot.AuthorityEnvelope)
            state.AuthorityEnvelope[property.Key] = property.Value?.DeepClone();
    }
}
