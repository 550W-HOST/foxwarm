using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Tools;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager : IAsyncDisposable
{
    private readonly PendingWriteRefs pendingWrites = new();
    private readonly string root;
    private readonly ResponsesClientOptions clientOptions;
    private readonly HostModels models;
    private readonly AgentCatalog agents;
    private readonly AgentMemory memory;
    private readonly Skills skills;
    private readonly LocalExecManager executor;
    private readonly HttpClient http = new();
    private readonly SessionWaitTimeouts waitTimeouts;
    private readonly WaitLiveness waitLiveness;
    private readonly ConcurrentDictionary<string, SessionOwner> sessions = new();
    private volatile bool accepting = true;
    private readonly object lifecycle = new();

    public SessionManager(string root, string workspace, ResponsesClientOptions options, HostModels models, string? skillsRoot = null)
    {
        this.root = Path.GetFullPath(root);
        var workspaceRoot = Path.GetFullPath(workspace);
        if (workspaceRoot == this.root || workspaceRoot.StartsWith(this.root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || this.root.StartsWith(workspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("Tool workspace and authority root must not overlap.");
        Directory.CreateDirectory(this.root);
        agents = new AgentCatalog(this.root, workspaceRoot);
        skills = new Skills(agents, Path.GetFullPath(skillsRoot ?? Path.Combine(AppContext.BaseDirectory, "skills")));
        memory = new AgentMemory(agents, skills);
        executor = new LocalExecManager(this.root,
            sessionId => agents.AgentDirectory(Find(sessionId)?.Agent ?? throw new InvalidDataException("Exec Session owner is missing.")),
            async (sessionId, execId, message) =>
        {
            if (!accepting || Find(sessionId) is not { } current)
                throw new InvalidOperationException("Exec completion owner is unavailable; retry after recovery.");
            var detail = message.StartsWith("Background Process Finished\n", StringComparison.Ordinal)
                ? message["Background Process Finished\n".Length..] : message;
            var eventPart = $"<foxwarm-system kind=\"event\" type=\"background-process-finished\">\n{detail}\n</foxwarm-system>";
            try { if (!await current.Entry.SaveLane.CommitBackgroundExecCompletionAsync(execId, eventPart)) return; }
            catch (AuthorityCommittedException)
            {
                if (Accepting && current.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) current.Registry.Trigger(sessionId);
                throw;
            }
            if (Accepting && current.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) current.Registry.Trigger(sessionId);
        });
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in LocalExecManager.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(ArchiveRecallTool.Definition());
        foreach (var definition in AgentToolDefinitions.Definitions()) definitions.Add(definition.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        foreach (var definition in KnowledgeToolDefinitions.Definitions()) definitions.Add(definition);
        foreach (var definition in ObservationToolDefinitions.Definitions()) definitions.Add(definition);
        foreach (var definition in SessionSettingsDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(CompactPrompt.ToolDefinition());
        clientOptions = options with { Tools = definitions };
        this.models = models;
        waitTimeouts = new SessionWaitTimeouts(this);
        waitLiveness = new WaitLiveness(this);
    }

    public async Task LoadAsync()
    {
        var directory = Path.Combine(root, "state", "sessions");
        var knownFiles = Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories).ToArray() : [];
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in knownFiles)
        {
            var id = Path.GetRelativePath(directory, path[..^".json".Length]).Replace(Path.DirectorySeparatorChar, '/');
            if (!SessionIdentity.IsValid(id) || !ids.Add(id)) throw new InvalidDataException("Unknown or duplicate authority filename in experiment root.");
            var agent = SessionIdentity.Agent(id);
            if (!agents.Exists(agent)) throw new InvalidDataException("Session is bound to a missing Agent.");
            var store = MakeStore(id, agent);
            var snapshot = await store.LoadAsync(id) ?? throw new InvalidDataException("An indexed authority file is missing.");
            if (snapshot.AuthorityEnvelope.ContainsKey("systemPromptFiles"))
                throw new InvalidDataException("Custom Session prompt files are unsupported by this Agent host.");
            if (snapshot.Busy || snapshot.Stopping)
                throw new InvalidDataException("Non-idle Session cannot be resumed automatically by the experiment host.");
            var hosted = MakeSession(id, agent, store);
            hosted.Registry.Add(id, snapshot);
            hosted.EnableCommittedNotifications();
            if (!sessions.TryAdd(id, hosted)) throw new InvalidDataException("Duplicate Session ID in experiment root.");
            NotifyCreated(hosted);
        }
        ValidateParentGraph();
        // Archive is never a history source. Its existing IDs only detect an authority
        // file that disappeared between clean runs, rather than silently dropping a Session.
        var archivePath = Path.Combine(root, "state", "archive-store.sqlite");
        if (File.Exists(archivePath))
        {
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = archivePath,
                Mode = SqliteOpenMode.ReadOnly
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT session_id FROM archive_messages UNION SELECT session_id FROM archive_blocks";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                if (!ids.Contains(reader.GetString(0)))
                    throw new InvalidDataException("Active Session authority is missing while Archive rows exist; Archive cannot rebuild history.");
        }
        foreach (var owner in sessions.Values) WaitTransition(owner.Id);
        await executor.InitializeAsync(id => sessions.ContainsKey(id));
        foreach (var owner in sessions.Values)
            if (owner.Entry.WithState(state => state.Queue.Count > 0)) _ = owner.StartProcessing();
    }

    public IEnumerable<SessionOwner> Owners() => sessions.Values;
    public IEnumerable<object> List() => sessions.OrderBy(pair => pair.Key).Select(pair => pair.Value.State());
    internal event Action<SessionRuntimeEvent>? Changed;
    internal event Action? TopologyChanged;
    internal void NotifyCreated(SessionOwner owner)
    {
        owner.Changed += value =>
        {
            if (value.Kind == SessionEventKind.StateChanged) WaitTransition(owner.Id);
            Changed?.Invoke(value);
        };
        TopologyChanged?.Invoke();
    }
    private void WaitTransition(string id) { waitTimeouts.Transition(id); waitLiveness.Transition(id); }

    public string DataRoot => root;
    public bool Accepting => accepting;
    public HostModels Models => models;

    public SessionOwner? Find(string id) => SessionIdentity.IsValid(id) && sessions.TryGetValue(id, out var value) ? value : null;

    public async Task<SessionOwner> CreateAsync()
    {
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        var id = $"s_{Guid.NewGuid():N}";
        var store = MakeStore(id, "main");
        if (await store.LoadAsync(id) is not null) throw new InvalidOperationException("Session ID collision.");
        var hosted = MakeSession(id, "main", store);
        var entry = hosted.Registry.Add(id);
        entry.WithState(state => { state.AuthorityEnvelope["agent"] = "main"; state.Meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); });
        try { await entry.SaveLane.SaveStrictAsync(); } // First authority JSON exists before publication/acknowledgement.
        catch (AuthorityCommittedException error)
        {
            PublishLegacy(hosted);
            throw new CommittedSessionCreationException(id,
                $"Session '{id}' was committed but a later durability step failed.", error);
        }
        PublishLegacy(hosted);
        return hosted;
    }

    private void PublishLegacy(SessionOwner hosted)
    {
        lock (lifecycle)
        {
            if (!accepting) throw new InvalidOperationException("Host is shutting down.");
            if (!sessions.TryAdd(hosted.Id, hosted)) throw new InvalidOperationException("Session ID collision.");
        }
        hosted.EnableCommittedNotifications();
        NotifyCreated(hosted);
    }

    private SessionOwner MakeSession(string id, string agent, PersistentSessionAuthorityStore store)
    {
        var hosted = new SessionOwner(id, agent, models) { ResolveAncestry = target => Find(target)?.Metadata() };
        hosted.Archive = store.Archive;
        hosted.Executor = executor;
        var chat = new SessionChatService(http, clientOptions, hosted, models, memory, (sessionId, update) =>
        {
            hosted.PublishDraftProgress(update);
            hosted.Emit(SessionEventKind.RequestProgress, new JsonObject { ["text"] = update.Text, ["reasoning"] = update.Reasoning });
        });
        var registry = new SessionRegistry(store, new RequestChatService(chat, hosted),
            new SessionToolExecutor(new WorkspaceTools(agents.AgentDirectory(agent), pendingWrites, hosted.Id, agent), hosted, this));
        hosted.Registry = registry;
        hosted.Compactor = new SessionCompactor(hosted, store, models, clientOptions, http, memory);
        registry.OnTurnStarting = _ => MaybeRefreshStaleAsync(hosted);
        registry.OnTurnCompleted = (_, result) => hosted.Compactor.AutoAfterTurnAsync(result);
        registry.TriggerOverride = _ => Accepting ? hosted.StartProcessing() : Task.CompletedTask;
        return hosted;
    }

    public async Task ShutdownAsync()
    {
        SessionOwner[] current;
        lock (lifecycle) { accepting = false; current = sessions.Values.ToArray(); }
        waitTimeouts.Stop(); waitLiveness.Stop();
        await waitTimeouts.DrainAsync(); await waitLiveness.DrainAsync();
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
        lock (lifecycle) accepting = false;
        executor.BeginShutdown();
        waitTimeouts.Stop(); waitLiveness.Stop();
        foreach (var session in sessions.Values) session.CloseSubscribers();
    }

    public async ValueTask DisposeAsync()
    {
        await waitTimeouts.DisposeAsync();
        await waitLiveness.DisposeAsync();
        await executor.DisposeAsync();
        http.Dispose();
    }

    internal static bool IsOwnedId(string id) => SessionIdentity.IsValid(id);
}
