using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager : IAsyncDisposable
{
    private readonly PendingWriteRefs pendingWrites = new();
    private readonly string root;
    private readonly HostPaths? hostPaths;
    internal Foxwarm.Images.ImageBlobStore Images { get; }
    internal Foxwarm.Artifacts.ArtifactStore Artifacts { get; }
    internal Foxwarm.Artifacts.ArtifactPreparer ArtifactPreparation { get; } = new();
    private readonly ResponsesClientOptions clientOptions;
    private readonly HostModels models;
    internal readonly SessionCatalog Catalog;
    private readonly AgentCatalog agents;
    private readonly AgentMemory memory;
    private readonly Skills skills;
    private readonly LocalExecManager executor;

    internal IEnumerable<string> ExecLogRoots() => agents.ExecLogRoots();

    private readonly SessionDeletionChannels deletionChannels;
    private readonly CommittedArchiveIdentity archiveIdentities;
    private readonly HttpClient http = ProviderHttpRequest.CreateClient();
    private readonly Foxwarm.McpClient mcp;
    internal Foxwarm.McpClient OutboundMcp => mcp;
    internal Foxwarm.Channels.ChannelRegistry ChannelRegistry { get; } = new();
    internal Foxwarm.Nodes.NodeConnectionHub Nodes { get; }
    internal Foxwarm.Nodes.NodeProviderRegistry NodeProviders { get; }
    internal Foxwarm.Nodes.NodeBootstrap? Bootstrap { get; set; }
    private readonly ModelRouting modelRouting = new();
    private readonly ModelInteractionDiagnostics diagnostics;
    internal LlmRequestJournalStore Journal { get; }
    internal Foxwarm.Vector.VectorService Vector { get; }
    private readonly Foxwarm.Persistence.SqliteWriterOwners.Lease archiveWriter;
    internal TaskService Tasks { get; }
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

    public SessionManager(
        string root,
        string workspace,
        ResponsesClientOptions options,
        HostModels models,
        string? skillsRoot = null,
        HostPaths? hostPaths = null
    )
    {
        this.hostPaths = hostPaths;
        Images = new(root);
        Artifacts = new(Path.Combine(root, "state", "artifacts"), ArtifactPreparation);
        ToolScript = new(root);
        HandoffConfirmationEnabled = models.HandoffConfirmationEnabled;
        this.root = Path.GetFullPath(root);
        diagnostics = new(this.root);
        Nodes = new(this.root);
        NodeProviders = new(
            Nodes,
            models.ConfigurationOwner?.AppConfiguration["nodeProviders"] as JsonObject,
            pendingWrites
        );
        Nodes.Changed += () => TopologyChanged?.Invoke();
        var workspaceRoot = Path.GetFullPath(workspace);
        toolWorkspace = workspaceRoot;
        authorization = new ToolAuthorizationAuthority(this.root);
        CommittedArchiveIdentity.ValidateStartupEvidence(
            this.root,
            allowPendingIdentityRecovery: true
        );
        Directory.CreateDirectory(this.root);
        deletionChannels = new(this.root);
        archiveIdentities = new(this.root);
        Catalog = new SessionCatalog(this.root);
        Tasks = new TaskService(
            this,
            this.root,
            id => ResolveTaskSessionId(id),
            id => TaskSessionAliases(id),
            id => TaskAnchorSeq(id),
            id => Find(id)?.Agent
        );
        Catalog.Changed += () => TopologyChanged?.Invoke();
        Catalog.BeforePresentationMutation = BeginCatalogMutation;
        Catalog.BeforeAuthorityProjection = id =>
        {
            var marker = Path.Combine(
                this.root,
                "state",
                "experiment-faults",
                SessionIdentity.ExecDirectorySegment(id) + ".catalog-projection"
            );
            if (File.Exists(marker))
            {
                File.Delete(marker);
                throw new IOException("Injected experimental catalog projection failure.");
            }
        };
        var recoveringMove = IdentityJournal.Read();
        agents = new AgentCatalog(
            this.root,
            workspaceRoot,
            recoveringMove is { OwnsAgent: true, Phase: "rolling-back" }
                ? recoveringMove.OwnedAgent
                : null,
            canonicalLayout: hostPaths is { LegacyWorkspace: null }
        );
        skills = new Skills(
            agents,
            Path.GetFullPath(
                skillsRoot
                    ?? hostPaths?.SkillsRoot
                    ?? Path.Combine(AppContext.BaseDirectory, "skills")
            )
        );
        memory = new AgentMemory(agents, skills);
        executor = new LocalExecManager(
            this.root,
            sessionId =>
                agents.AgentDirectory(
                    SessionCatalog.Text(Catalog.Get(sessionId)?["agent"])
                        ?? throw new InvalidDataException("Exec Session membership is missing.")
                ),
            async (sessionId, execId, message) =>
            {
                if (!accepting)
                    throw new InvalidOperationException(
                        "Exec completion owner is unavailable; retry after recovery."
                    );
                var current = await RequiredAsync(sessionId);
                var detail = message.StartsWith(
                    "Background Process Finished\n",
                    StringComparison.Ordinal
                )
                    ? message["Background Process Finished\n".Length..]
                    : message;
                var eventPart =
                    $"<foxwarm-system kind=\"event\" type=\"background-process-finished\">\n{detail}\n</foxwarm-system>";
                try
                {
                    if (
                        !await current.Entry.SaveLane.CommitBackgroundExecCompletionAsync(
                            execId,
                            eventPart
                        )
                    )
                        return;
                }
                catch (AuthorityCommittedException)
                {
                    if (
                        Accepting
                        && !current.Entry.WithState(state => state.Busy || state.Stopping)
                        && current.Registry.HasRunnableWork(current.Entry)
                    )
                        current.Registry.Trigger(sessionId);
                    throw;
                }
                if (
                    Accepting
                    && !current.Entry.WithState(state => state.Busy || state.Stopping)
                    && current.Registry.HasRunnableWork(current.Entry)
                )
                    current.Registry.Trigger(sessionId);
            },
            ResolveExecLifetime,
            sessionId =>
                SessionCatalog.Text(Catalog.Get(sessionId)?["agent"])
                ?? throw new InvalidDataException("Exec Session membership is missing.")
        );
        executor.ResolveProviderBackend = NodeProviders.ResolveExecBackend;
        executor.RemoteIdentityReserved = (session, id) =>
            Find(session) is { } owner && Nodes.ExecClaims.Has(owner, id, activeOnly: false);
        Nodes.LocalExecActive = (owner, id) => executor.IsOwnedActive(owner.Id, id);
        Nodes.SessionEvent = AdmitNodeSessionEventAsync;
        Nodes.SessionRequest = HandleNodeSessionRequestAsync;
        Nodes.BackgroundRegistration = RegisterRemoteExecBackgroundAsync;
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in Foxwarm.Nodes.NodeToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        if (LocalExecManager.IsSupported)
            foreach (var definition in LocalExecManager.Definitions())
                definitions.Add(definition?.DeepClone());
        definitions.Add(ArtifactToolDefinition.Definition());
        definitions.Add(ArchiveRecallTool.Definition());
        foreach (var definition in ArchiveControlTools.Definitions())
            definitions.Add(definition?.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        foreach (var definition in FileDeliveryDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in MainLocalToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(
                HandoffConfirmation.Definition(definition.AsObject(), HandoffConfirmationEnabled)
            );
        foreach (var definition in TimerToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        if (Foxwarm.ToolScript.MontyWorker.IsSupported)
            foreach (var definition in ToolScriptToolDefinitions.Definitions())
                definitions.Add(definition?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        foreach (var definition in KnowledgeToolDefinitions.Definitions())
            definitions.Add(definition);
        foreach (var definition in ObservationToolDefinitions.Definitions())
            definitions.Add(definition);
        foreach (var definition in SessionSettingsDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        definitions.Add(CompactToolDefinition.Definition());
        definitions.Add(CompactPrompt.ToolDefinition());
        foreach (var definition in UnifiedToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        mcp = new Foxwarm.McpClient(
            this.root,
            SessionWait.Text(models.ConfigurationOwner?.AppConfiguration["url"]),
            hostPaths?.McpConfigPath
        );
        tools = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            owner => agents.AgentDirectory(owner.Agent),
            Nodes,
            NodeProviders
        );
        clientOptions = options with { Tools = tools.ModelDefinitions() };
        this.models = models;
        timers = new(this.root, DeliverTimerAsync);
        waitTimeouts = new SessionWaitTimeouts(this);
        waitLiveness = new WaitLiveness(this);
        Journal = new LlmRequestJournalStore(this.root);
        archiveWriter = SqliteArchiveMessageStore.AcquireWriter(ArchiveDatabase);
        Vector = new(
            this.root,
            Foxwarm.Vector.VectorConfiguration.Capture(models.ConfigurationOwner?.AppConfiguration)
        );
        Vector.Diagnostic = (code, id) =>
            Console.Error.WriteLine("Vector " + code + (id.Length == 0 ? "" : " session=" + id));
    }

    internal string? ResolveTaskSessionId(string requested)
    {
        var resolution = Catalog.Resolve(requested);
        return SessionCatalog.Text(resolution["sessionId"]);
    }

    internal IReadOnlyList<string> TaskSessionAliases(string id) =>
        Catalog.Get(id)?["aliases"] is JsonArray aliases
            ? aliases
                .Select(SessionCatalog.Text)
                .Where(value => value is not null)
                .Cast<string>()
                .ToArray()
            : [];

    internal long? TaskAnchorSeq(string id)
    {
        var canonical = ResolveTaskSessionId(id);
        if (canonical is null)
            return null;
        var row = Catalog.Get(canonical);
        var agent = SessionCatalog.Text(row?["agent"]) ?? "main";
        var path = Path.Combine(root, "state", "sessions", canonical + ".json");
        if (File.Exists(path))
        {
            var document = SessionAuthorityDocument.Load(path, canonical, agent);
            var rootValue = document.CloneRoot();
            if (rootValue["nextMessageSeq"] is JsonValue value)
            {
                if (value.TryGetValue<long>(out var detachedNext))
                {
                    return detachedNext - 1;
                }
                if (value.TryGetValue<double>(out var detachedDouble))
                {
                    return checked((long)detachedDouble) - 1;
                }
            }
        }
        var live = Find(canonical)?.Entry.Snapshot().NextMessageSeq;
        return live is { } next ? next - 1 : null;
    }

    private static bool IsFalsyGoal(JsonNode value) =>
        value is JsonValue scalar
        && (
            scalar.TryGetValue<bool>(out var boolean) && !boolean
            || scalar.TryGetValue<double>(out var number) && number == 0
            || scalar.TryGetValue<string>(out var text) && text.Length == 0
        );

    private async Task<SessionSnapshot> MigrateGoalSnapshotAsync(SessionSnapshot snapshot)
    {
        if (!snapshot.AuthorityEnvelope.TryGetPropertyValue("goalState", out var rawGoal))
            return snapshot;
        if (rawGoal is null || IsFalsyGoal(rawGoal))
            return snapshot;
        if (rawGoal is not JsonObject goalState)
            throw new InvalidDataException("Session authority goalState must be an object.");
        if (
            goalState["goal"] is not JsonValue goalValue
            || !goalValue.TryGetValue<string>(out var goal)
        )
            throw new InvalidDataException(
                "Session authority goalState must contain a goal string."
            );
        var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
        envelope.Remove("goalState");
        if (SessionGoal.Trim(goal).Length == 0)
            return snapshot with { AuthorityEnvelope = envelope };
        var anchor =
            goalState["anchorSeq"] is JsonValue anchorValue
            && anchorValue.TryGetValue<long>(out var storedAnchor)
            && storedAnchor >= 0
                ? storedAnchor
                : Math.Max(0, snapshot.NextMessageSeq - 1);
        await Tasks.MigrateLegacyGoalAsync(snapshot.Id, goal, anchor).ConfigureAwait(false);
        return snapshot with { AuthorityEnvelope = envelope };
    }

    internal async Task PrepareLegacyGoalBeforeIdentityAsync(SessionOwner owner)
    {
        var snapshot = owner.Entry.Snapshot();
        if (snapshot.AuthorityEnvelope["goalState"] is null)
            return;
        var migrated = await MigrateGoalSnapshotAsync(snapshot).ConfigureAwait(false);
        try
        {
            await owner.AuthorityStore.CommitAsync(migrated, SaveKind.Strict).ConfigureAwait(false);
        }
        catch (AuthorityCommittedException)
        {
            owner.Entry.WithState(state => state.AuthorityEnvelope.Remove("goalState"));
            throw;
        }
        owner.Entry.WithState(state => state.AuthorityEnvelope.Remove("goalState"));
    }

    public Task LoadAsync() => LoadOwnersAsync(startMainServices: false);

    private async Task LoadOwnersAsync(bool startMainServices)
    {
        await EnsureIdentityStartupAsync();
        try
        {
            await Vector.StartAsync();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                "Vector initialization failed; Main will continue without semantic search: " + error
            );
        }
        await timers.LoadAsync();
        foreach (var row in Catalog.List())
        {
            var id = SessionCatalog.Text(row["id"])!;
            var agent = SessionCatalog.Text(row["agent"])!;
            if (!SessionIdentity.IsValid(id) || !agents.Exists(agent))
                throw new InvalidDataException(
                    "Catalog Session binding is unsupported or its Agent is missing."
                );
        }
        await executor.RegisterRecordsAsync(id => Catalog.Get(id) is not null);
        var ids = Catalog
            .RestartIds()
            .Concat(executor.OwnerIds)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var mandatory = ids.Select(id => RequiredAsync(id)).ToList();
        await Task.WhenAll(mandatory);
        servicesReady = true;
        foreach (var owner in sessions.Values)
            WaitTransition(owner.Id);
        if (startMainServices)
            await StartMainServicesAsync();
        await executor.ReconcileNowAsync();
        executor.StartReconciliation();
        foreach (var owner in sessions.Values)
            if (owner.Registry.HasRunnableWork(owner.Entry))
                _ = owner.StartProcessing();
    }

    private async Task StartMainServicesAsync()
    {
        foreach (var owner in sessions.Values)
            await ReconcileTimerWaitsAsync(owner);
        timers.Start();
    }

    public IEnumerable<SessionOwner> Owners() => sessions.Values;

    public IEnumerable<object> List() =>
        sessions.OrderBy(pair => pair.Key).Select(pair => pair.Value.State());

    internal event Action<SessionRuntimeEvent>? Changed;
    internal event Action? TopologyChanged;

    internal void NotifyCreated(SessionOwner owner)
    {
        owner.Changed += value =>
        {
            if (!IsCurrentOwner(owner))
                return;
            if (value.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted)
                CaptureLocalProjection(owner);
            if (
                servicesReady
                && !IsDeletionClaimed(owner.Id)
                && value.Kind == SessionEventKind.StateChanged
            )
                WaitTransition(owner.Id);
            ObserveChannelTurn(owner, value);
            Changed?.Invoke(value);
        };
        CaptureLocalProjection(owner);
        if (servicesReady)
            _ = ReconcileTimerWaitsAsync(owner);
        TopologyChanged?.Invoke();
    }

    private void WaitTransition(string id)
    {
        if (!IsDeletionClaimed(id))
        {
            waitTimeouts.Transition(id);
            waitLiveness.Transition(id);
        }
    }

    private void BindMutations(SessionOwner owner)
    {
        owner.Entry.MutationAdmission = () => BeginOwnerMutation(owner);
        owner.Entry.ToolProgress = (call, start) => ChannelToolProgress(owner, call, start);
        owner.Entry.StructuredProgress = progress => ChannelStructuredProgress(owner, progress);
        owner.Entry.TurnStopped = () => ChannelStoppedAsync(owner);
        owner.Entry.AssistantCommitted = message => ChannelAssistantCommittedAsync(owner, message);
        owner.Entry.RetryPresented = (retry, initial, same) =>
            ChannelRetryAsync(owner, retry, initial, same);
    }

    public string DataRoot => root;
    public bool Accepting => accepting;
    public HostModels Models => models;

    internal SqliteArchiveMessageStore ArchiveReader(string sessionId) =>
        new(ArchiveDatabase, sessionId);

    public SessionOwner? Find(string id)
    {
        if (sessions.TryGetValue(id, out var exact))
            return exact.Entry.Retired || IsRetiring(id) ? null : exact;
        var canonical = SessionCatalog.Text(Catalog.Resolve(id)["sessionId"]);
        return
            canonical is not null
            && sessions.TryGetValue(canonical, out var value)
            && !value.Entry.Retired
            && !IsRetiring(canonical)
            ? value
            : null;
    }

    public async Task<SessionOwner> CreateAsync()
    {
        using var operation = TrackCreation();
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        var id = $"s_{Guid.NewGuid():N}";
        if (await IdReservedAsync(id))
            throw new InvalidOperationException("Session ID collision.");
        return await WithCreationIdentityAsync(
            id,
            async () =>
            {
                var store = MakeStore(id, "main");
                if (await store.LoadAsync(id) is not null)
                    throw new InvalidOperationException("Session ID collision.");
                var hosted = MakeSession(id, "main", store);
                var entry = hosted.Registry.Add(id);
                BindMutations(hosted);
                entry.WithState(state =>
                {
                    state.AuthorityEnvelope["agent"] = "main";
                    state.Meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                });
                var branch = store.Archive.EnsureBranch();
                try
                {
                    await entry.SaveLane.SaveStrictAsync();
                } // First authority JSON exists before publication/acknowledgement.
                catch (AuthorityCommittedException error)
                {
                    await PublishCreatedAsync(hosted);
                    throw new CommittedSessionCreationException(
                        id,
                        $"Session '{id}' was committed but a later durability step failed.",
                        error
                    );
                }
                catch (Exception error)
                {
                    try
                    {
                        await CompensateCreatedBranchAsync(store, branch);
                    }
                    catch (Exception cleanup)
                    {
                        throw new AggregateException(
                            "Creation failed and owned branch compensation also failed.",
                            error,
                            cleanup
                        );
                    }
                    throw;
                }
                await PublishCreatedAsync(hosted);
                return hosted;
            }
        );
    }

    private SessionOwner MakeSession(string id, string agent, PersistentSessionAuthorityStore store)
    {
        var hosted = new SessionOwner(id, agent, models)
        {
            ResolveAncestry = CatalogMetadata,
            MainMetadata = OverlayMainMetadata,
            ResolveBoundNode = BoundNode,
        };
        hosted.Archive = store.Archive;
        hosted.AuthorityStore = store;
        hosted.Executor = executor;
        var requests = new ModelRequestOwner(
            http,
            clientOptions,
            modelRouting,
            websockets: websockets,
            images: Images,
            journal: Journal,
            diagnostics: diagnostics
        );
        var chat = new SessionChatService(
            requests,
            clientOptions,
            hosted,
            models,
            memory,
            (sessionId, update) =>
            {
                hosted.PublishDraftProgress(update);
                hosted.Emit(
                    SessionEventKind.RequestProgress,
                    new JsonObject { ["text"] = update.Text, ["reasoning"] = update.Reasoning }
                );
            },
            () => ModelDefinitions(hosted),
            Tasks,
            () => ExecutionEnvironment(hosted)
        );
        var registry = new SessionRegistry(
            store,
            new RequestChatService(chat, hosted),
            new SessionToolExecutor(
                new WorkspaceTools(agents.AgentDirectory(agent), pendingWrites, hosted.Id, agent),
                hosted,
                this,
                tools
            ),
            migrateGoal: MigrateGoalSnapshotAsync,
            parentSessionResolver: _ => hosted.Metadata().ParentSessionId
        );
        hosted.Registry = registry;
        hosted.Compactor = new SessionCompactor(
            hosted,
            this,
            store,
            models,
            clientOptions,
            requests,
            memory,
            () => ModelDefinitions(hosted)
        );
        registry.OnTurnFailure = async (error, durable) =>
        {
            await hosted.PresentFailureAsync(error, durable);
            await ChannelFailureAsync(hosted, error);
        };
        registry.OnTurnStarting = async _ =>
        {
            StartChannelTurn(hosted);
            try
            {
                await NodeProviders.RefreshAsync(CurrentNode(hosted), admissionStop.Token);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException) { }
            await MaybeRefreshStaleAsync(hosted);
        };
        registry.OnTurnCompleted = (_, result) => hosted.Compactor.AutoAfterTurnAsync(result);
        registry.OnProcessorFinalizing = (_, error, interrupted, suspended) =>
            FinishChannelTurnAsync(hosted, error, interrupted, suspended);
        registry.OnBeforeContinuation = (_, result, consume, token) =>
            hosted.Compactor.BeforeContinuationAsync(result, consume, token);
        registry.OnSafePoint = _ => hosted.Compactor.SafePointAsync();
        registry.OnRetrySafePoint = _ => hosted.Compactor.SafePointAsync(propagateFailure: true);
        registry.HasCompletedCompact = _ => hosted.Compactor.HasCompletedJob;
        registry.TriggerOverride = _ =>
            Accepting && !IsDeletionClaimed(hosted.Id) && !hosted.Entry.Retired
                ? hosted.StartProcessing()
                : Task.CompletedTask;
        return hosted;
    }

    internal MainBrowserTools Browser { get; } = new();

    private Task? shutdown;

    public Task ShutdownAsync()
    {
        BeginShutdown();
        lock (lifecycle)
            return shutdown ??= ShutdownCoreAsync();
    }

    private async Task ShutdownCoreAsync()
    {
        SessionOwner[] current;
        lock (lifecycle)
            current = sessions.Values.ToArray();
        // Start bounded foreground settlement immediately; accepted effects retain
        // their dependencies throughout grace and cancellation.
        await Task.WhenAll(current.Select(session => session.Registry.Runner.ShutdownAsync()));
        await timers.DisposeAsync();
        await DrainPublicationsAsync();
        lock (lifecycle)
            current = sessions.Values.ToArray();
        // An accepted creation can publish during closure, but its runner is fenced.
        await Task.WhenAll(current.Select(session => session.Registry.Runner.ShutdownAsync()));
        await Task.WhenAll(current.Select(session => session.DrainForegroundAsync()));
        await waitTimeouts.DrainAsync();
        await waitLiveness.DrainAsync();
        // Planners are independently owned. Release foreground waits first, then
        // cancel/drain planning without reclassifying interruption as user Stop.
        await Task.WhenAll(current.Select(session => session.Compactor.StopAsync()));
        await Task.WhenAll(current.Select(session => session.DrainAsync()));
        ToolScript.BeginShutdown();
        executor.BeginShutdown();
        mcp.BeginShutdown();
        Nodes.BeginShutdown();
        websockets.BeginShutdown();
        await ToolScript.DrainAsync();
        foreach (var session in current)
            if (!session.Entry.Retired)
                await session.Entry.SaveLane.SaveStrictAsync();
        await DrainVectorHooksAsync();
        await Vector.DisposeAsync();
        foreach (var session in current)
            session.CloseSubscribers();
    }

    public void BeginShutdown()
    {
        mcp.StopNotificationProducer();
        timers.StopFuture();
        lock (lifecycle)
        {
            accepting = false;
            foreach (var session in sessions.Values)
                session.Registry.Runner.CloseAdmission();
        }
        admissionStop.Cancel();
        waitTimeouts.Stop();
        waitLiveness.Stop();
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        // A failed drain is not permission to close dependencies beneath its owner.
        await ShutdownAsync();
        await timers.DisposeAsync();
        await DrainPublicationsAsync();
        await waitTimeouts.DisposeAsync();
        await waitLiveness.DisposeAsync();
        await ToolScript.DisposeAsync();
        await executor.DisposeAsync();
        await Browser.DisposeAsync();
        await mcp.DisposeAsync();
        Nodes.Dispose();
        await websockets.DisposeAsync();
        await Journal.DisposeAsync();
        await archiveWriter.DisposeAsync();
        Tasks.Dispose();
        admissionStop.Dispose();
        Catalog.Dispose();
        http.Dispose();
    }

    internal static bool IsOwnedId(string id) => SessionIdentity.IsValid(id);
}
