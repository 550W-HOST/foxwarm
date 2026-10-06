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
    internal Foxwarm.Images.ImageBlobStore Images { get; }
    private readonly ResponsesClientOptions clientOptions;
    private readonly HostModels models;
    internal readonly SessionCatalog Catalog;
    private readonly AgentCatalog agents;
    private readonly AgentMemory memory;
    private readonly Skills skills;
    private readonly LocalExecManager executor;
    private readonly SessionDeletionChannels deletionChannels;
    private readonly CommittedArchiveIdentity archiveIdentities;
    private readonly HttpClient http = new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    private readonly Foxwarm.McpClient mcp;
    private readonly ModelRouting modelRouting = new();
    private readonly ResponsesWsTransport websockets = new();
    private readonly ToolRegistry tools;
    internal Foxwarm.ToolScript.MainToolScript ToolScript { get; }
    private readonly SessionWaitTimeouts waitTimeouts;
    private readonly WaitLiveness waitLiveness;
    private readonly ConcurrentDictionary<string, SessionOwner> sessions = new();
    private volatile bool accepting = true;
    private readonly object lifecycle = new();
    internal string MemoryDirectory(string agent) => agents.MemoryDirectory(agent);

    internal bool HandoffConfirmationEnabled { get; }
    public SessionManager(string root, string workspace, ResponsesClientOptions options, HostModels models, string? skillsRoot = null)
    {
        Images = new(root);
        ToolScript = new(root);
        HandoffConfirmationEnabled = models.HandoffConfirmationEnabled;
        this.root = Path.GetFullPath(root);
        var workspaceRoot = Path.GetFullPath(workspace);
        toolWorkspace = workspaceRoot;
        authorization = new ToolAuthorizationAuthority(this.root);
        if (workspaceRoot == this.root || workspaceRoot.StartsWith(this.root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || this.root.StartsWith(workspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("Tool workspace and authority root must not overlap.");
        CommittedArchiveIdentity.ValidateStartupEvidence(this.root, allowPendingIdentityRecovery: true);
        Directory.CreateDirectory(this.root);
        deletionChannels = new(this.root);
        archiveIdentities = new(this.root);
        Catalog = new SessionCatalog(this.root);
        Catalog.Changed += () => TopologyChanged?.Invoke();
        Catalog.BeforePresentationMutation = BeginCatalogMutation;
        Catalog.BeforeAuthorityProjection = id =>
        {
            var marker = Path.Combine(this.root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(id) + ".catalog-projection");
            if (File.Exists(marker)) { File.Delete(marker); throw new IOException("Injected experimental catalog projection failure."); }
        };
        var recoveringMove = IdentityJournal.Read();
        agents = new AgentCatalog(this.root, workspaceRoot, recoveringMove is { OwnsAgent: true, Phase: "rolling-back" } ? recoveringMove.OwnedAgent : null);
        skills = new Skills(agents, Path.GetFullPath(skillsRoot ?? Path.Combine(AppContext.BaseDirectory, "skills")));
        memory = new AgentMemory(agents, skills);
        executor = new LocalExecManager(this.root,
            sessionId => agents.AgentDirectory(SessionCatalog.Text(Catalog.Get(sessionId)?["agent"]) ?? throw new InvalidDataException("Exec Session membership is missing.")),
            async (sessionId, execId, message) =>
        {
            if (!accepting) throw new InvalidOperationException("Exec completion owner is unavailable; retry after recovery.");
            var current = await RequiredAsync(sessionId);
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
        }, ResolveExecLifetime, HistoricalExecOwners);
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in LocalExecManager.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(ArchiveRecallTool.Definition());
        foreach (var definition in ArchiveControlTools.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        foreach (var definition in FileDeliveryDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        foreach (var definition in MainLocalToolDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        foreach (var definition in AgentToolDefinitions.Definitions()) definitions.Add(HandoffConfirmation.Definition(definition.AsObject(), HandoffConfirmationEnabled));
        foreach (var definition in TimerToolDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        foreach (var definition in ToolScriptToolDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        foreach (var definition in KnowledgeToolDefinitions.Definitions()) definitions.Add(definition);
        foreach (var definition in ObservationToolDefinitions.Definitions()) definitions.Add(definition);
        foreach (var definition in SessionSettingsDefinitions.Definitions()) definitions.Add(definition?.DeepClone());
        definitions.Add(CompactToolDefinition.Definition());
        definitions.Add(CompactPrompt.ToolDefinition());
        foreach (var definition in UnifiedToolDefinitions.All()) definitions.Add(definition?.DeepClone());
        mcp = new Foxwarm.McpClient(this.root);
        tools = SessionToolExecutor.CreateRegistry(definitions, mcp, owner => agents.AgentDirectory(owner.Agent));
        clientOptions = options with { Tools = tools.ModelDefinitions() };
        this.models = models;
        timers = new(this.root, DeliverTimerAsync, TimerPlacement);
        waitTimeouts = new SessionWaitTimeouts(this);
        waitLiveness = new WaitLiveness(this);
    }

    public Task LoadAsync() => LoadOwnersAsync(startMainServices: false);
    private async Task LoadOwnersAsync(bool startMainServices)
    {
        await EnsureIdentityStartupAsync();
        await timers.LoadAsync();
        foreach (var row in Catalog.List())
        {
            var id = SessionCatalog.Text(row["id"])!; var agent = SessionCatalog.Text(row["agent"])!;
            if (!SessionIdentity.IsValid(id) || !agents.Exists(agent)) throw new InvalidDataException("Catalog Session binding is unsupported or its Agent is missing.");
        }
        await executor.RegisterRecordsAsync(id => Catalog.Get(id) is not null);
        var ids = Catalog.RestartIds().Concat(executor.OwnerIds).Distinct(StringComparer.Ordinal).ToArray();
        var mandatory = ids.Select(id => RequiredAsync(id)).ToList();
        await Task.WhenAll(mandatory);
        servicesReady = true;
        foreach (var owner in sessions.Values) WaitTransition(owner.Id);
        if (startMainServices) await StartMainServicesAsync();
        executor.StartReconciliation();
        foreach (var owner in sessions.Values)
            if (owner.Entry.WithState(state => state.Queue.Any(SessionCompactor.Ordinary))) _ = owner.StartProcessing();
    }

    private async Task StartMainServicesAsync()
    {
        foreach (var owner in sessions.Values) await ReconcileTimerWaitsAsync(owner);
        timers.Start();
    }

    public IEnumerable<SessionOwner> Owners() => sessions.Values;
    public IEnumerable<object> List() => sessions.OrderBy(pair => pair.Key).Select(pair => pair.Value.State());
    internal event Action<SessionRuntimeEvent>? Changed;
    internal event Action? TopologyChanged;
    internal void NotifyCreated(SessionOwner owner)
    {
        owner.Changed += value =>
        {
            if (!IsCurrentOwner(owner)) return;
            if (value.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted) CaptureLocalProjection(owner);
            if (servicesReady && !IsDeletionClaimed(owner.Id) && value.Kind == SessionEventKind.StateChanged) WaitTransition(owner.Id);
            Changed?.Invoke(value);
        };
        CaptureLocalProjection(owner);
        if (servicesReady) _ = ReconcileTimerWaitsAsync(owner);
        TopologyChanged?.Invoke();
    }
    private void WaitTransition(string id) { if (!IsDeletionClaimed(id)) { waitTimeouts.Transition(id); waitLiveness.Transition(id); } }
    private void BindMutations(SessionOwner owner) => owner.Entry.MutationAdmission = () => BeginOwnerMutation(owner);

    public string DataRoot => root;
    public bool Accepting => accepting;
    public HostModels Models => models;
    internal SqliteArchiveMessageStore ArchiveReader(string sessionId) => new(ArchiveDatabase, sessionId);

    public SessionOwner? Find(string id)
    {
        if (sessions.TryGetValue(id, out var exact)) return exact.Entry.Retired || IsRetiring(id) ? null : exact;
        var canonical = SessionCatalog.Text(Catalog.Resolve(id)["sessionId"]);
        return canonical is not null && sessions.TryGetValue(canonical, out var value) && !value.Entry.Retired && !IsRetiring(canonical) ? value : null;
    }

    public async Task<SessionOwner> CreateAsync()
    {
        using var operation = TrackCreation();
        if (!accepting) throw new InvalidOperationException("Host is shutting down.");
        var id = $"s_{Guid.NewGuid():N}";
        if (await IdReservedAsync(id)) throw new InvalidOperationException("Session ID collision.");
        return await WithCreationIdentityAsync(id, async () =>
        {
        var store = MakeStore(id, "main");
        if (await store.LoadAsync(id) is not null) throw new InvalidOperationException("Session ID collision.");
        var hosted = MakeSession(id, "main", store);
        var entry = hosted.Registry.Add(id); BindMutations(hosted);
        entry.WithState(state => { state.AuthorityEnvelope["agent"] = "main"; state.Meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); });
        var branch = store.Archive.EnsureBranch();
        try { await entry.SaveLane.SaveStrictAsync(); } // First authority JSON exists before publication/acknowledgement.
        catch (AuthorityCommittedException error)
        {
            await PublishCreatedAsync(hosted);
            throw new CommittedSessionCreationException(id,
                $"Session '{id}' was committed but a later durability step failed.", error);
        }
        catch (Exception error)
        {
            try { CompensateCreatedBranch(store, branch); }
            catch (Exception cleanup) { throw new AggregateException("Creation failed and owned branch compensation also failed.", error, cleanup); }
            throw;
        }
        await PublishCreatedAsync(hosted);
        return hosted;
        });
    }

    private SessionOwner MakeSession(string id, string agent, PersistentSessionAuthorityStore store)
    {
        var hosted = new SessionOwner(id, agent, models) { ResolveAncestry = CatalogMetadata, MainMetadata = OverlayMainMetadata };
        hosted.Archive = store.Archive; hosted.AuthorityStore = store;
        hosted.Executor = executor;
        var requests = new ModelRequestOwner(http, clientOptions, modelRouting, websockets: websockets, images: Images, imageOutputFormat: models.ConfigurationOwner?.ProviderImageOutputFormat ?? "webp");
        var chat = new SessionChatService(requests, clientOptions, hosted, models, memory, (sessionId, update) =>
        {
            hosted.PublishDraftProgress(update);
            hosted.Emit(SessionEventKind.RequestProgress, new JsonObject { ["text"] = update.Text, ["reasoning"] = update.Reasoning });
        }, () => ModelDefinitions(hosted));
        var registry = new SessionRegistry(store, new RequestChatService(chat, hosted),
            new SessionToolExecutor(new WorkspaceTools(agents.AgentDirectory(agent), pendingWrites, hosted.Id, agent), hosted, this, tools));
        hosted.Registry = registry;
        hosted.Compactor = new SessionCompactor(hosted, this, store, models, clientOptions, requests, memory, () => ModelDefinitions(hosted));
        registry.OnTurnStarting = _ => MaybeRefreshStaleAsync(hosted);
        registry.OnTurnCompleted = (_, result) => hosted.Compactor.AutoAfterTurnAsync(result);
        registry.OnSafePoint = _ => hosted.Compactor.SafePointAsync();
        registry.OnRetrySafePoint = _ => hosted.Compactor.SafePointAsync(propagateFailure: true);
        registry.HasCompletedCompact = _ => hosted.Compactor.HasCompletedJob;
        registry.TriggerOverride = _ => Accepting && !IsDeletionClaimed(hosted.Id) && !hosted.Entry.Retired ? hosted.StartProcessing() : Task.CompletedTask;
        return hosted;
    }

    public async Task ShutdownAsync()
    {
        SessionOwner[] current;
        timers.StopFuture(); await timers.DisposeAsync();
        ToolScript.BeginShutdown();
        await DrainPublicationsAsync();
        lock (lifecycle) current = sessions.Values.ToArray();
        waitTimeouts.Stop(); waitLiveness.Stop();
        await waitTimeouts.DrainAsync(); await waitLiveness.DrainAsync();
        // Each Stop takes and cancels its own active handle synchronously before
        // the host waits on any Session's best-effort persistence lane.
        var compactStops = current.Where(session => session.Compactor.Active)
            .Select(session => session.Compactor.StopAsync()).ToArray();
        var stops = current.Where(session => session.Entry.Snapshot().Busy)
            .Select(session => session.Registry.Control.StopAsync(session.Id)).ToArray();
        await Task.WhenAll(compactStops.Select(task => (Task)task).Concat(stops));
        await Task.WhenAll(current.Select(session => session.DrainAsync()));
        await ToolScript.DrainAsync();
        foreach (var session in current)
            if (!session.Entry.Retired) await session.Entry.SaveLane.SaveStrictAsync();
    }

    public void BeginShutdown()
    {
        timers.StopFuture();
        lock (lifecycle) accepting = false;
        admissionStop.Cancel();
        ToolScript.BeginShutdown();
        executor.BeginShutdown();
        mcp.BeginShutdown();
        websockets.BeginShutdown();
        waitTimeouts.Stop(); waitLiveness.Stop();
        foreach (var session in sessions.Values) session.CloseSubscribers();
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        await timers.DisposeAsync();
        await DrainPublicationsAsync();
        await waitTimeouts.DisposeAsync();
        await waitLiveness.DisposeAsync();
        await ToolScript.DisposeAsync();
        await executor.DisposeAsync();
        await mcp.DisposeAsync();
        await websockets.DisposeAsync();
        admissionStop.Dispose();
        Catalog.Dispose();
        http.Dispose();
    }

    internal static bool IsOwnedId(string id) => SessionIdentity.IsValid(id);
}
