using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Web;

internal sealed class HostSessions : IAsyncDisposable
{
    private readonly string root;
    private readonly ResponsesClientOptions clientOptions;
    private readonly HostModels models;
    private readonly WorkspaceTools tools;
    private readonly LocalExecManager executor;
    private readonly HttpClient http = new();
    private readonly ConcurrentDictionary<string, HostedSession> sessions = new();
    private volatile bool accepting = true;
    private readonly object lifecycle = new();

    public HostSessions(string root, string workspace, ResponsesClientOptions options, HostModels models)
    {
        this.root = Path.GetFullPath(root);
        var workspaceRoot = Path.GetFullPath(workspace);
        if (workspaceRoot == this.root || workspaceRoot.StartsWith(this.root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || this.root.StartsWith(workspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("Tool workspace and authority root must not overlap.");
        Directory.CreateDirectory(this.root);
        tools = new WorkspaceTools(workspaceRoot);
        executor = new LocalExecManager(this.root, workspaceRoot, async (sessionId, execId, message) =>
        {
            if (!accepting || Find(sessionId) is not { } current)
                throw new InvalidOperationException("Exec completion owner is unavailable; retry after recovery.");
            var detail = message.StartsWith("Background Process Finished\n", StringComparison.Ordinal)
                ? message["Background Process Finished\n".Length..] : message;
            var eventPart = $"<foxwarm-system kind=\"event\" type=\"background-process-finished\">\n{detail}\n</foxwarm-system>";
            await current.Entry.SaveLane.CommitBackgroundExecCompletionAsync(execId, eventPart);
            if (!current.Entry.WithState(state => state.Busy || state.Stopping)) current.Registry.Trigger(sessionId);
        });
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in LocalExecManager.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(ArchiveRecallTool.Definition());
        definitions.Add(CompactPrompt.ToolDefinition());
        clientOptions = options with { Tools = definitions };
        this.models = models;
    }

    public async Task LoadAsync()
    {
        var directory = Path.Combine(root, "state", "sessions");
        var knownFiles = Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.json").ToArray() : [];
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in knownFiles)
        {
            var id = Path.GetFileNameWithoutExtension(path);
            if (!IsOwnedId(id)) throw new InvalidDataException("Unknown authority filename in experiment root.");
            ids.Add(id);
            var store = new PersistentSessionAuthorityStore(root, id);
            var snapshot = await store.LoadAsync(id) ?? throw new InvalidDataException("An indexed authority file is missing.");
            if (snapshot.Busy || snapshot.Stopping)
                throw new InvalidDataException("Non-idle Session cannot be resumed automatically by the experiment host.");
            var hosted = MakeSession(id, store);
            hosted.Registry.Add(id, snapshot);
            hosted.EnableCommittedNotifications();
            if (!sessions.TryAdd(id, hosted)) throw new InvalidDataException("Duplicate Session ID in experiment root.");
        }
        // Archive is never a history source. Its existing IDs only detect an authority
        // file that disappeared between clean runs, rather than silently dropping a Session.
        var archivePath = Path.Combine(root, "state", "archive-store.sqlite");
        if (File.Exists(archivePath))
        {
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = archivePath, Mode = SqliteOpenMode.ReadOnly
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT DISTINCT session_id FROM archive_messages";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                if (!ids.Contains(reader.GetString(0)))
                    throw new InvalidDataException("Active Session authority is missing while Archive rows exist; Archive cannot rebuild history.");
        }
        await executor.InitializeAsync(id => sessions.ContainsKey(id));
    }

    public IEnumerable<object> List() => sessions.OrderBy(pair => pair.Key).Select(pair => pair.Value.State());

    public bool Accepting => accepting;
    public HostModels Models => models;

    public HostedSession? Find(string id) => IsOwnedId(id) && sessions.TryGetValue(id, out var value) ? value : null;

    public async Task<HostedSession> CreateAsync()
    {
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        var id = $"s_{Guid.NewGuid():N}";
        var store = new PersistentSessionAuthorityStore(root, id);
        if (await store.LoadAsync(id) is not null) throw new InvalidOperationException("Session ID collision.");
        var hosted = MakeSession(id, store);
        var entry = hosted.Registry.Add(id);
        await entry.SaveLane.SaveStrictAsync(); // First authority JSON exists before publication/acknowledgement.
        lock (lifecycle)
        {
            if (!accepting) throw new InvalidOperationException("Host is shutting down.");
            if (!sessions.TryAdd(id, hosted)) throw new InvalidOperationException("Session ID collision.");
        }
        return hosted;
    }

    private HostedSession MakeSession(string id, PersistentSessionAuthorityStore store)
    {
        var hosted = new HostedSession(id, models);
        hosted.Archive = store.Archive;
        hosted.Executor = executor;
        var chat = new HostModelChatService(http, clientOptions, hosted, models, (sessionId, update) =>
        {
            hosted.PublishDraftProgress(update);
            hosted.Broadcast(new JsonObject
            {
                ["type"] = "model-progress", ["sessionId"] = sessionId,
                ["text"] = update.Text, ["reasoning"] = update.Reasoning
            });
        });
        var registry = new SessionRegistry(store, new WebUiChatService(chat, hosted), new WebUiToolExecutor(tools, hosted));
        hosted.Registry = registry;
        hosted.Compactor = new SessionCompactor(hosted, store, models, clientOptions, http);
        registry.OnTurnCompleted = (_, result) => hosted.Compactor.AutoAfterTurnAsync(result);
        registry.TriggerOverride = _ => hosted.StartProcessing();
        return hosted;
    }

    public async Task ShutdownAsync()
    {
        HostedSession[] current;
        lock (lifecycle) { accepting = false; current = sessions.Values.ToArray(); }
        // Each Stop takes and cancels its own active handle synchronously before
        // the host waits on any Session's best-effort persistence lane.
        var compactStops = current.Where(session => session.Compactor.Active)
            .Select(session => session.Compactor.StopAsync()).ToArray();
        await Task.WhenAll(compactStops);
        var stops = current.Where(session => session.Entry.Snapshot().Busy)
            .Select(session => session.Registry.Control.StopAsync(session.Id)).ToArray();
        await Task.WhenAll(stops);
        await Task.WhenAll(current.Select(session => session.DrainAsync()));
        foreach (var session in current)
            await session.Entry.SaveLane.SaveStrictAsync();
    }

    public void BeginShutdown()
    {
        executor.BeginShutdown();
        lock (lifecycle)
        {
            accepting = false;
            foreach (var session in sessions.Values) session.CloseSubscribers();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await executor.DisposeAsync();
        http.Dispose();
    }

    internal static bool IsOwnedId(string id) => id.Length == 34 && id.StartsWith("s_", StringComparison.Ordinal)
        && id.AsSpan(2).ToString().All(Uri.IsHexDigit);
}

internal sealed partial class HostedSession
{
    private readonly ConcurrentDictionary<long, Task> running = new();
    private readonly ConcurrentDictionary<long, Channel<JsonObject>> listeners = new();
    private long nextListener;
    private long nextRun;
    private long lastNotifiedSeq;
    private int lastReportedFailureCount;
    private readonly HostModels models;
    public string Id { get; }
    public SessionRegistry Registry { get; set; } = null!;
    public SessionCompactor Compactor { get; set; } = null!;
    public SqliteArchiveMessageStore Archive { get; set; } = null!;
    public LocalExecManager Executor { get; set; } = null!;
    public SessionEntry Entry => Registry.GetRequired(Id);

    public HostedSession(string id, HostModels models)
    {
        Id = id;
        this.models = models;
    }

    public JsonObject WebUiState() => WebUiContract.Session(Entry.Snapshot(), models, toolActive, compacting);
    public JsonObject WebUiHistory(SessionSnapshot snapshot, int? tail, int? prefix, long? afterSeq) =>
        WebUiContract.History(snapshot, models, toolActive, compacting, tail, prefix, afterSeq);

    public object State()
    {
        var state = Entry.Snapshot();
        return new
        {
            id = Id, busy = state.Busy, stopping = state.Stopping,
            queueCount = state.Queue.Count, messageCount = state.History.Count,
            nextMessageSeq = state.NextMessageSeq,
            failureCount = Entry.BackgroundProcessorFailureCount,
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
                Broadcast(new JsonObject { ["type"] = "message-committed", ["message"] = message.DeepClone() });
                Broadcast(new JsonObject { ["type"] = "message", ["sessionId"] = Id, ["message"] = message.DeepClone() });
                ClearCommittedDraft(message);
            }
            Broadcast(new JsonObject { ["type"] = "session-state", ["session"] = JsonSerializerNode(State()) });
            Broadcast(new JsonObject { ["type"] = "webui-session-state", ["sessionId"] = Id, ["session"] = WebUiState() });
        };
    }

    private static JsonNode JsonSerializerNode(object value) => System.Text.Json.JsonSerializer.SerializeToNode(value)!;

    public Task StartProcessing()
    {
        var index = Interlocked.Increment(ref nextRun);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task ExecuteAsync()
        {
            await ready.Task;
            try { await Registry.Runner.ProcessQueueAsync(Id); }
            catch (Exception error)
            {
                Entry.RecordBackgroundProcessorFailure(error);
            }
            finally
            {
                ClearDraft();
                var failures = Entry.BackgroundProcessorFailureCount;
                if (failures != lastReportedFailureCount)
                {
                    lastReportedFailureCount = failures;
                    Broadcast(new JsonObject { ["type"] = "processing-error", ["message"] = Entry.LastBackgroundProcessorFailure?.Message });
                }
                Broadcast(new JsonObject { ["type"] = "session-state", ["session"] = JsonSerializerNode(State()) });
                Broadcast(new JsonObject { ["type"] = "webui-session-state", ["sessionId"] = Id, ["session"] = WebUiState() });
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

    public (long Id, ChannelReader<JsonObject> Reader) Subscribe()
    {
        var channel = Channel.CreateUnbounded<JsonObject>(new UnboundedChannelOptions
        {
            SingleReader = true, SingleWriter = false, AllowSynchronousContinuations = false
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

    public void Broadcast(JsonObject value)
    {
        foreach (var channel in listeners.Values) channel.Writer.TryWrite((JsonObject)value.DeepClone());
    }

    public void BroadcastState()
    {
        Broadcast(new JsonObject { ["type"] = "session-state", ["session"] = JsonSerializerNode(State()) });
        Broadcast(new JsonObject { ["type"] = "webui-session-state", ["sessionId"] = Id, ["session"] = WebUiState() });
    }

    public void PublishCompactError(Exception error) =>
        Broadcast(new JsonObject { ["type"] = "processing-error", ["message"] = error.Message });
}
