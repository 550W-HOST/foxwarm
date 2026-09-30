using Foxwarm.Tools;
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionOwner
{
    private readonly ConcurrentDictionary<long, Task> running = new();
    private readonly ConcurrentDictionary<long, Channel<SessionRuntimeEvent>> listeners = new();
    internal event Action<SessionRuntimeEvent>? Changed;
    private long nextListener;
    private long nextRun;
    private long lastNotifiedSeq;
    private int lastReportedFailureCount;
    private readonly HostModels models;
    internal Func<string, SessionMetadata?>? ResolveAncestry { get; set; }
    internal string? SnapshotRefreshWarning { get; set; }
    public string Id { get; }
    public string Agent { get; }
    public SessionRegistry Registry { get; set; } = null!;
    public SessionCompactor Compactor { get; set; } = null!;
    public SqliteArchiveMessageStore Archive { get; set; } = null!;
    public LocalExecManager Executor { get; set; } = null!;
    public SessionEntry Entry => Registry.GetRequired(Id);

    public SessionOwner(string id, string agent, HostModels models)
    {
        Id = id;
        Agent = agent;
        this.models = models;
    }

    public object State()
    {
        var state = Metadata();
        return new
        {
            id = Id,
            agent = Agent,
            parentSessionId = state.ParentSessionId,
            displayName = state.DisplayName,
            busy = state.Busy,
            stopping = state.Stopping,
            queueCount = state.QueueLength,
            messageCount = state.MessageCount,
            nextMessageSeq = state.NextMessageSeq,
            failureCount = Entry.BackgroundProcessorFailureCount,
            bestEffortFailureCount = Entry.BestEffortFailureCount,
            snapshotRefreshWarning = SnapshotRefreshWarning,
            lastError = Entry.LastBackgroundProcessorFailure?.Message
        };
    }

    public IReadOnlyList<JsonObject> History() => Entry.Snapshot().History;

    public void EnableCommittedNotifications()
    {
        lastNotifiedSeq = Entry.Snapshot().History.LastOrDefault()?["__meta"]?["seq"]?.GetValue<long>() ?? 0;
        Entry.Committed = snapshot =>
        {
            foreach (var message in snapshot.History)
            {
                var seq = message["__meta"]?["seq"]?.GetValue<long>() ?? 0;
                if (seq <= lastNotifiedSeq) continue;
                lastNotifiedSeq = seq;
                Emit(SessionEventKind.MessageCommitted, message);
                ClearCommittedDraft(message);
            }
            Emit(SessionEventKind.StateChanged);
        };
    }

    private static JsonNode JsonSerializerNode(object value) => System.Text.Json.JsonSerializer.SerializeToNode(value)!;

    public Task StartProcessing(bool retry = false)
    {
        var index = Interlocked.Increment(ref nextRun);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task ExecuteAsync()
        {
            await ready.Task;
            try { await Registry.Runner.ProcessQueueAsync(Id, retry); }
            catch (Exception error)
            {
                if (error is not SessionContinuationUnavailableException && !(retry && error is InvalidOperationException && error.Message == "Session is already running."))
                    Entry.RecordBackgroundProcessorFailure(error);
                if (retry) throw;
            }
            finally
            {
                ClearDraft();
                var failures = Entry.BackgroundProcessorFailureCount;
                if (failures != lastReportedFailureCount)
                {
                    lastReportedFailureCount = failures;
                    Emit(SessionEventKind.ProcessingError, JsonValue.Create(Entry.LastBackgroundProcessorFailure?.Message));
                }
                Emit(SessionEventKind.StateChanged);
                running.TryRemove(index, out _);
            }
        }
        var task = ExecuteAsync();
        running.TryAdd(index, task);
        ready.TrySetResult();
        return task;
    }

    public async Task DrainAsync()
    {
        while (running.Count > 0) await Task.WhenAll(running.Values.ToArray());
        await Compactor.DrainAsync();
    }

    public (long Id, ChannelReader<SessionRuntimeEvent> Reader) Subscribe()
    {
        var channel = Channel.CreateUnbounded<SessionRuntimeEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
        var id = Interlocked.Increment(ref nextListener);
        listeners[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(long id)
    {
        if (listeners.TryRemove(id, out var channel)) channel.Writer.TryComplete();
    }

    public void CloseSubscribers()
    {
        foreach (var id in listeners.Keys) Unsubscribe(id);
    }

    public void Emit(SessionEventKind kind, JsonNode? data = null)
    {
        var value = new SessionRuntimeEvent(Id, kind, data?.DeepClone());
        Changed?.Invoke(value);
        foreach (var channel in listeners.Values) channel.Writer.TryWrite(value);
    }

    public void PublishStateChanged() => Emit(SessionEventKind.StateChanged);
    public void PublishCompactError(Exception error) => Emit(SessionEventKind.ProcessingError, JsonValue.Create(error.Message));
}
