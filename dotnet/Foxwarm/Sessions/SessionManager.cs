using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Foxwarm.Limits;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager : IAsyncDisposable
{
    private readonly PendingWriteRefs pendingWrites = new();
    private readonly string root;
    internal Foxwarm.Storage.IStorageContext Storage { get; }
    private readonly HostPaths? hostPaths;
    internal Foxwarm.Images.ImageBlobStore Images { get; }
    internal Foxwarm.Artifacts.ArtifactStore Artifacts { get; }
    internal Foxwarm.Artifacts.ArtifactPreparer ArtifactPreparation { get; } = new();
    private readonly ResponsesClientOptions clientOptions;
    private readonly HostModels models;
    internal readonly ISessionCatalogStore Catalog;
    private readonly AgentCatalog agents;
    private readonly AgentMemory memory;
    private readonly Skills skills;
    private readonly LocalExecManager executor;

    internal IEnumerable<string> ExecLogRoots() => agents.ExecLogRoots();

    private readonly SessionDeletionChannels deletionChannels;
    private readonly HttpClient http;
    private readonly Foxwarm.McpClient mcp;
    private readonly Foxwarm.Secrets.InstanceSecrets? secrets;
    internal Foxwarm.Secrets.InstanceSecrets? Secrets => secrets;
    internal Foxwarm.McpClient OutboundMcp => mcp;
    internal SessionRuntimeCredentialStore RuntimeCredentials { get; } = new();
    internal Uri? RuntimeMcpEndpoint { get; set; }
    internal Foxwarm.Channels.ChannelRegistry ChannelRegistry { get; } = new();
    internal Foxwarm.Nodes.NodeConnectionHub Nodes { get; }
    internal Foxwarm.Nodes.NodeProviderRegistry NodeProviders { get; }
    internal Foxwarm.Nodes.NodeBootstrap? Bootstrap { get; set; }
    private readonly ModelRouting modelRouting = new();
    private readonly ModelInteractionDiagnostics diagnostics;
    internal ILlmJournalStore Journal { get; }

    /// <summary>Installation-wide usage read from the journal's derived ledger.</summary>
    internal UsageOverview Usage { get; }

    /// <summary>Installation activity: the derived index of tool effects and its records.</summary>
    internal ActivityIndex Activity { get; }
    internal Foxwarm.Vector.VectorService Vector { get; }
    private readonly IAsyncDisposable archiveWriter;
    internal TaskService Tasks { get; }
    private readonly ResponsesWsTransport websockets;
    private readonly ToolRegistry tools;
    internal ToolRegistry ToolRegistry => tools;
    internal Foxwarm.ToolScript.MainToolScript ToolScript { get; }
    private readonly SessionWaitTimeouts waitTimeouts;
    private readonly WaitLiveness waitLiveness;
    private readonly ConcurrentDictionary<string, SessionOwner> sessions = new();
    private volatile bool accepting = true;
    private readonly object lifecycle = new();

    internal string MemoryDirectory(string agent) => agents.MemoryDirectory(agent);

    // The memory root of an existing Agent: its memory directory, or over an Agent store the
    // store path `<agent>/memory`. Throws when the Agent does not exist.
    internal string MemoryRoot(string agent) => agents.AuthorizationMemoryRoot(agent);

    /// <summary>
    /// Test-only seam: when set, builds the storage context of a manager constructed without
    /// one (and without file-store test hooks), so existing tests can run against another
    /// backend. Product code never sets it.
    /// </summary>
    internal static Func<string, Foxwarm.Storage.IStorageContext>? StorageForTests { get; set; }

    /// <summary>The runtime's capability profile, fixed at construction.</summary>
    internal RuntimeCapabilities Capabilities { get; }

    // The Agent store, when the Agents' files are in one: with a storage context that has one
    // and no master Node. A runtime with a master Node keeps Agent folders on it, whatever its
    // Session stores are.
    internal IAgentStore? AgentStore => Capabilities.MasterNode ? null : Storage.AgentFiles;

    internal Channels.WebUi.HostedUploadStaging? UploadStaging { get; }

    internal AgentCatalog AgentCatalog => agents;

    public SessionManager(
        string root,
        string workspace,
        ResponsesClientOptions options,
        HostModels models,
        string? skillsRoot = null,
        HostPaths? hostPaths = null,
        Action<string, AtomicJsonWriteStage>? authorityStageHook = null,
        Func<string, int, CancellationToken, Task>? canonicalCommitBarrier = null,
        Foxwarm.Storage.IStorageContext? storage = null,
        // The runtime's features; null is file mode's full profile.
        RuntimeCapabilities? capabilities = null,
        // The hosted tenant profile prompts are built for (AgentMemory); null in file mode.
        string? memoryProfile = null
    )
    {
        Capabilities = capabilities ?? RuntimeCapabilities.File;
        // The model client and Responses WebSockets are the tenant's: the egress guard is on
        // their handlers, and no connection is shared with another runtime.
        http = ProviderHttpRequest.CreateClient(Capabilities.Egress);
        websockets = new(egress: Capabilities.Egress);
        this.hostPaths = hostPaths;
        // The test hooks belong to the default file context; a supplied context brings its own.
        Storage =
            storage
            ?? (
                authorityStageHook is null && canonicalCommitBarrier is null
                    ? StorageForTests?.Invoke(root)
                    : null
            )
            ?? new Foxwarm.Storage.FileStorageContext(
                root,
                new(authorityStageHook, canonicalCommitBarrier)
            );
        // The tenant's blob limit applies to new images and artifacts.
        var blobQuota = Capabilities.Limits is { } blobLimits
            ? new Foxwarm.Limits.BlobQuota(
                blobLimits.BlobBytes,
                Storage is Foxwarm.Limits.IBlobUsage usage ? usage.StoredBlobBytesAsync : null
            )
            : null;
        BlobQuota = blobQuota;
        if (Capabilities.Limits is not null)
            hotCharges = new(ReferenceEqualityComparer.Instance);
        limitedImageBlobs = blobQuota?.Apply(Storage.ImageBlobs);
        Images = new(root, limitedImageBlobs ?? Storage.ImageBlobs);
        Artifacts = new(
            Path.Combine(root, "state", "artifacts"),
            ArtifactPreparation,
            blobQuota?.Apply(Storage.ArtifactBlobs) ?? Storage.ArtifactBlobs
        );
        ToolScript = new(Storage.ToolScriptRuns);
        if (Capabilities.Limits is not null)
            ToolScript.AdmitProcess = token => Admission!.ToolScripts.EnterAsync(token);
        this.root = Path.GetFullPath(root);
        if (Capabilities.Limits is not null)
            UploadStaging = new(this.root, ReceivedFileLimit);
        var runtimeFiles = Path.Combine(this.root, "state", "runtime-runs");
        if (Directory.Exists(runtimeFiles))
            Directory.Delete(runtimeFiles, recursive: true);
        // The wire diagnostics copy request and response bodies: off with the tenant's journal.
        // A journal that always records needs no callback.
        diagnostics = new(this.root)
        {
            Recording = Storage.Journal.RecordingPolicy,
        };
        RecallTargets = new(this.root);
        Nodes = new(this.root, Storage.Documents, Storage.Credentials)
        {
            MasterNode = Capabilities.MasterNode,
        };
        if (Capabilities.Limits is { } nodeLimits)
        {
            Nodes.Registry.MaxApprovedNodes = nodeLimits.ResidentNodes;
            Nodes.AdmitCall = token => Admission!.NodeExecs.EnterAsync(token);
        }
        Nodes.Registry.ConfigureLimits(() =>
            (
                (int)(
                    SessionWait.Number(
                        models.ConfigurationOwner?.AppConfiguration["nodeTree"]?["maxDepth"]
                    ) ?? 16
                ),
                (int)(
                    SessionWait.Number(
                        models.ConfigurationOwner?.AppConfiguration["nodeTree"]?["maxChildren"]
                    ) ?? 256
                )
            )
        );
        NodeProviders = new(
            Nodes,
            models.ConfigurationOwner?.AppConfiguration["nodeProviders"] as JsonObject,
            pendingWrites,
            Capabilities.Providers
        );
        Nodes.Changed += () => TopologyChanged?.Invoke();
        var workspaceRoot = Path.GetFullPath(workspace);
        toolWorkspace = workspaceRoot;
        // A configuration owner over a database brings its documents; otherwise they are this
        // manager's files, as they have always been.
        ConfigDocuments =
            models.ConfigurationOwner?.Documents is { } configured
            and not Foxwarm.Storage.FileConfigDocuments
                ? configured
                : new Foxwarm.Storage.FileConfigDocuments(this.root, hostPaths?.McpConfigPath);
        authorization = new ToolAuthorizationAuthority(ConfigDocuments)
        {
            CeilingSource = models.ConfigurationOwner?.OperatorCeiling,
        };
        Storage.Identities.ValidateStartupEvidence(allowPendingIdentityRecovery: true);
        Directory.CreateDirectory(this.root);
        deletionChannels = new(this.root, documents: Storage.Documents);
        Catalog = Storage.Catalog;
        Tasks = new TaskService(
            this,
            new TaskStore(Storage.Tasks, ResolveTaskSessionId, TaskSessionAliases),
            id => Catalog.QueryAsync(() => ResolveTaskSessionId(id)),
            TaskAnchorSeqAsync,
            id => Catalog.QueryAsync(() => Find(id)?.Agent ?? CatalogMetadata(id)?.Agent)
        );
        Catalog.Changed += () => TopologyChanged?.Invoke();
        Catalog.BeforePresentationMutation = BeginCatalogMutation;
        var recoveringMove = Storage.Identities.ReadPendingMove();
        agents = new AgentCatalog(
            this.root,
            workspaceRoot,
            recoveringMove is { OwnsAgent: true, Phase: "rolling-back" }
                ? recoveringMove.OwnedAgent
                : null,
            // An Agent store has one layout: membership is its roots.
            canonicalLayout: hostPaths is not null || AgentStore is not null,
            treeLimits: () =>
                (
                    (int)(
                        SessionWait.Number(
                            models.ConfigurationOwner?.AppConfiguration["agentTree"]?["maxDepth"]
                        ) ?? 16
                    ),
                    (int)(
                        SessionWait.Number(
                            models.ConfigurationOwner?.AppConfiguration["agentTree"]?["maxChildren"]
                        ) ?? 128
                    )
                ),
            installDefaultNode: () => models.ConfigurationOwner?.AgentDefaultNode,
            documents: Storage.Documents,
            store: AgentStore
        );
        skills = new Skills(
            agents,
            Path.GetFullPath(
                skillsRoot
                    ?? hostPaths?.SkillsRoot
                    ?? Path.Combine(AppContext.BaseDirectory, "skills")
            ),
            Capabilities.MasterNode
        );
        memory = new AgentMemory(
            agents,
            skills,
            FrameworkPrompt.TemplatePath(hostPaths?.ResourceRoot ?? AppContext.BaseDirectory),
            models,
            skillAccess: CatalogSkillAccess,
            files: AgentStore,
            masterNode: Capabilities.MasterNode,
            profile: memoryProfile
        );
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
                using var currentUse = await ResolveExecCompletionOwnerAsync(sessionId);
                var current = currentUse.Owner;
                var eventPart = CompletionEvent(message);
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
                ?? throw new InvalidDataException("Exec Session membership is missing."),
            Storage.Documents
        );
        executor.MainLocal = Capabilities.MasterNode;
        executor.ResolveProviderBackend = NodeProviders.ResolveExecBackend;
        executor.ResolveProviderStop = NodeProviders.ExecStopBackendAsync;
        executor.Untracked = session => Find(session)?.PublishStateChanged();
        executor.RemoteIdentityReserved = (session, id) =>
            Find(session) is { } owner && Nodes.ExecClaims.Has(owner, id, activeOnly: false);
        Nodes.LocalExecActive = (owner, id) => executor.IsOwnedActive(owner.Id, id);
        Nodes.ReadEditSource = async (owner, node, file, cwd, token) =>
        {
            var files = IdentityWorkspace(owner);
            await AuthorizeNodeFileAsync(owner, node, file, "read", files, token);
            var source = await ReadResidentSourceAsync(owner, node, file, cwd, files, token);
            return System.Text.Encoding.UTF8.GetString(source.Bytes);
        };
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
        definitions.Add((JsonNode?)ToolAuthorizationToolDefinition.ExplainDefinition());
        foreach (var definition in SecretToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in FileDeliveryDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in ExecControlDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in MainLocalToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in TimerToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        if (Foxwarm.ToolScript.MontyWorker.IsSupported)
            foreach (var definition in ToolScriptToolDefinitions.Definitions())
                definitions.Add(definition?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        definitions.Add(AskUserToolDefinitions.Definition());
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
            Capabilities.Egress,
            this.root,
            SessionWait.Text(models.ConfigurationOwner?.AppConfiguration["url"]),
            hostPaths?.McpConfigPath,
            Storage.Documents,
            ConfigDocuments
        );
        mcp.Configuration.StdioAvailable = Capabilities.StdioMcp;
        mcp.Configuration.MaxServers = Capabilities.Limits?.McpServers;
        if (models.ConfigurationOwner is { } configurationOwner)
            configurationOwner.Limits = Capabilities.Limits;
        tools = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            // Over an Agent store there is no folder; the spool then never reaches master.
            owner => agents.PhysicalFolders ? agents.AgentDirectory(owner.Agent) : "",
            Nodes,
            NodeProviders,
            Capabilities
        );
        secrets = models.ConfigurationOwner?.Secrets;
        if (secrets is { } owned)
        {
            mcp.Configuration.SecretLookup = owned.Lookup;
            owned.AddSource("mcp", () => McpSecretLiterals(mcp));
            tools.Redaction = (result, sessionId) => owned.Redact(result, "tool-output", sessionId);
            tools.KnownSecretLabel = label => owned.Redactor.HasLabel(label);
            executor.InheritedSecret = value => owned.Redactor.IsKnownValue(value);
            executor.SecretEnvironment = ResolveSecretEnvironment;
            Nodes.SecretEnvironment = ResolveSecretEnvironment;
            owned.AddSource(
                "nodes",
                () =>
                    Nodes.Registry.PairingToken is { Length: > 0 } pairing
                        ? [new Foxwarm.Secrets.KnownSecret("node-pairing-token", pairing)]
                        : []
            );
        }
        clientOptions = options with { Tools = tools.ModelDefinitions() };
        this.models = models;
        timers = Foxwarm.Timers.MainTimers.Reporting(Storage.Documents, DeliverTimerAsync);
        waitTimeouts = new SessionWaitTimeouts(this);
        waitLiveness = new WaitLiveness(this);
        Journal = Storage.Journal;
        Usage = new UsageOverview(this, Journal);
        archiveWriter = Storage.Archive.AcquireWriter();
        Activity = new ActivityIndex(this);
        // Vector is a derived index of the SQLite Archive under the data root; over another Archive
        // (hosted mode) it is off whatever the configuration says, as the Activity index is.
        Vector = new(
            this.root,
            Foxwarm.Vector.VectorConfiguration.Capture(
                Storage.Archive is SqliteArchiveStore
                    ? models.ConfigurationOwner?.AppConfiguration
                    : null
            ),
            admissionStop.Token
        );
        if (secrets is { } embeddingSecrets)
            Vector.EmbeddingRedaction = text => embeddingSecrets.Redact(text, "embedding");
        Vector.Diagnostic = (code, id) =>
            Console.Error.WriteLine("Vector " + code + (id.Length == 0 ? "" : " session=" + id));
    }

    private static IEnumerable<Foxwarm.Secrets.KnownSecret> McpSecretLiterals(
        Foxwarm.McpClient client
    )
    {
        var values = new List<Foxwarm.Secrets.KnownSecret>();
        foreach (var (name, server) in client.Configuration.Snapshot())
            values.AddRange(
                Foxwarm.Secrets.InstanceSecrets.Literals(
                    Foxwarm.Secrets.SecretSinks.McpServer,
                    server,
                    path => "mcp." + name + "." + path
                )
            );
        values.AddRange(
            client
                .OAuth.Credentials()
                .Select(value => new Foxwarm.Secrets.KnownSecret("mcp-oauth", value))
        );
        return values;
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

    private async Task<long?> TaskAnchorSeqAsync(string canonical)
    {
        var row = await Catalog.QueryAsync(() => Catalog.Get(canonical));
        if (row is null)
            return null;
        var agent = SessionCatalog.Text(row["agent"]) ?? "main";
        if (await Storage.Authority.ReadEnvelopeAsync(canonical, agent) is { } rootValue)
        {
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
        var live = FindCanonical(canonical)?.Entry.Snapshot().NextMessageSeq;
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

    private async Task StartVectorAsync(bool logStartup)
    {
        try
        {
            await Vector.StartAsync();
            if (logStartup)
                Console.WriteLine($"Vector startup: mode={Vector.Mode}, ready={Vector.Ready}.");
        }
        catch (Exception error)
            when (Vector.Stopping
                && error is OperationCanceledException or Foxwarm.Vector.VectorUnavailableException
            )
        {
            // Main stopped while the Vector owner was still starting; nothing failed.
            Console.WriteLine("Vector startup stopped because Main is shutting down.");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                "Vector initialization failed; Main will continue without semantic search: "
                    + MainLog.SafeFailure(error)
            );
        }
    }

    public Task LoadAsync() => LoadOwnersAsync(startMainServices: false);

    private async Task LoadOwnersAsync(bool startMainServices)
    {
        await EnsureIdentityStartupAsync();
        // Legacy isolation is no longer enforced: every isolated Agent gets its generated
        // layer before any Session can run a tool.
        await MigrateLegacyIsolationCatalogAsync();
        _ = StartVectorAsync(startMainServices);
        await timers.LoadAsync();
        var catalogRows = Catalog.List();
        foreach (var row in catalogRows)
        {
            var id = SessionCatalog.Text(row["id"])!;
            var agent = SessionCatalog.Text(row["agent"])!;
            if (!SessionIdentity.IsValid(id) || !agents.Exists(agent))
                throw new InvalidDataException(
                    "Catalog Session binding is unsupported or its Agent is missing."
                );
        }
        await executor.RegisterRecordsAsync(id => Catalog.Get(id) is not null);
        if (startMainServices)
        {
            Usage.StartBackfill(admissionStop.Token);
            Activity.StartBackfill(admissionStop.Token);
            if (!Capabilities.MasterNode && AgentStore is not null)
                toolOutputSweep ??= Task.Run(() => RunToolOutputSweepAsync(admissionStop.Token));
        }
        var ids = Catalog
            .RestartIds()
            .Concat(Catalog.PendingApprovalIds())
            .Concat(executor.OwnerIds)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (startMainServices)
        {
            Console.WriteLine(
                $"Exec startup: supported={LocalExecManager.IsSupported}, tracked={executor.TrackedCount}."
            );
            Console.WriteLine(
                $"Session catalog loaded: entries={catalogRows.Length}, requiredOwners={ids.Length}."
            );
        }
        // With the tenant's hot-owner limit, recovery loads now only what fits; the rest loads
        // after the processors start, in order, as earlier owners finish and leave room.
        var deferred = new List<string>();
        if (Admission is null)
            await Task.WhenAll(ids.Select(id => RecoverOwnerAsync(id, deferred)));
        else
            using (HotOwnerBudget.WithoutWaiting())
                foreach (var id in ids)
                    await RecoverOwnerAsync(id, deferred);
        // Before any Session starts processing or a timer fires.
        await MaterializeMigratedPlacementAsync();
        var lostWaits = new List<string>();
        foreach (var row in catalogRows)
        {
            var id = SessionCatalog.Text(row["id"])!;
            if (
                SessionWait
                    .Strings(CatalogMetadata(id)?.Wait?["waitExecIds"])
                    .Any(SessionSaveLane.LostAfterRestart)
            )
                lostWaits.Add(id);
        }
        foreach (var id in lostWaits)
        {
            OwnerUse? acquired;
            try
            {
                acquired = await UseRecoveryOwnerAsync(id);
            }
            catch (TenantLimitException error) when (error.Limit == "hotOwnerBytes")
            {
                if (!deferred.Contains(id))
                    deferred.Add(id);
                continue;
            }
            using var use = acquired;
            if (use is not null)
                await use.Owner.Entry.SaveLane.ClearLostBackgroundWaitsAsync();
        }
        if (startMainServices)
            Console.WriteLine($"Session startup: loadedOwners={sessions.Count}.");
        servicesReady = true;
        foreach (var row in catalogRows)
            waitTimeouts.Transition(SessionCatalog.Text(row["id"])!);
        foreach (
            var id in Catalog.RecentWaitIds(
                WaitLiveness.ActivityCutoff(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            )
        )
            waitLiveness.Transition(id);
        if (startMainServices)
            await StartMainServicesAsync();
        if (deferred.Count == 0)
            await executor.ReconcileNowAsync();
        StartIdleRelease();
        foreach (var owner in sessions.Values)
        {
            using var use = TryUseOwner(owner);
            if (use is not null)
                StartRecoveredProcessing(use.Owner);
        }
        // A completed exec owned by a deferred Session may itself need space. Deliver after
        // activation, independently of the runnable-owner pass and its progress.
        if (deferred.Count != 0)
        {
            deferredRecovery = RecoverDeferredAsync(deferred, lostWaits.ToHashSet(), startMainServices);
            deferredRecovery = Task.WhenAll(deferredRecovery, executor.ReconcileNowAsync());
        }
        executor.StartReconciliation();
    }

    private async Task<OwnerUse> ResolveExecCompletionOwnerAsync(string sessionId)
    {
        // A notification cannot hold a shared cold load waiting for space while the recovery
        // pass needs to get past this owner. Its durable exec record retries on reconciliation.
        using var immediate = Admission is not null && !deferredRecovery.IsCompleted
            ? HotOwnerBudget.WithoutWaiting() : null;
        return await UseRequiredAsync(sessionId);
    }

    private Task deferredRecovery = Task.CompletedTask;

    private void StartRecoveredProcessing(SessionOwner owner)
    {
        var envelope = owner.Entry.Snapshot().AuthorityEnvelope;
        if (
            (
                !ClaudeRuntimeState.IsExternal(envelope)
                || SessionWait.Text(envelope["externalRuntime"]?["status"]) == "complete"
            ) && owner.Registry.HasRunnableWork(owner.Entry)
        )
            _ = owner.StartProcessing();
    }

    private async Task<OwnerUse?> UseRecoveryOwnerAsync(string id, CancellationToken token = default)
    {
        using var immediate = Admission is null ? null : HotOwnerBudget.WithoutWaiting();
        return await UseExistingAsync(id, token);
    }

    // Try each outstanding owner once per pass. A smaller owner that fits behind a larger
    // blocked owner can start immediately, without spinning on the blocked owner.
    private async Task RecoverDeferredAsync(List<string> pending, HashSet<string> lostWaits, bool startMainServices)
    {
        var budget = Admission!.HotOwners;
        while (pending.Count > 0 && accepting)
        {
            long smallest = long.MaxValue;
            foreach (var id in pending.ToArray())
            {
                if (!accepting)
                    return;
                try
                {
                    OwnerUse? acquired;
                    try
                    {
                        acquired = await UseRecoveryOwnerAsync(id, admissionStop.Token);
                    }
                    catch (TenantLimitException error) when (error.Limit == "hotOwnerBytes")
                    {
                        smallest = Math.Min(smallest, error.RequestedBytes);
                        continue;
                    }
                    using var use = acquired;
                    if (use is not null)
                    {
                        var owner = use.Owner;
                        if (lostWaits.Contains(id))
                            await owner.Entry.SaveLane.ClearLostBackgroundWaitsAsync();
                        if (startMainServices)
                            await ReconcileTimerWaitsAsync(owner);
                        StartRecoveredProcessing(owner);
                    }
                }
                catch (Exception) when (!accepting || admissionStop.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    MainLog.Diagnostic("Session recovery failed: " + MainLog.SafeFailure(error), failure: true);
                }
                pending.Remove(id);
            }
            if (pending.Count > 0)
                try
                {
                    await budget.WaitForCapacityAsync(
                        smallest,
                        () => pending.Any(sessions.ContainsKey),
                        admissionStop.Token
                    );
                }
                catch (OperationCanceledException) when (admissionStop.IsCancellationRequested)
                {
                    return;
                }
        }
    }

    private async Task RecoverOwnerAsync(string id, List<string> deferred)
    {
        try
        {
            await RequiredAsync(id);
        }
        catch (TenantLimitException error) when (error.Limit == "hotOwnerBytes")
        {
            deferred.Add(id);
        }
        catch (SessionAuthorityUnavailableException error)
        {
            MainLog.Diagnostic(
                "Session recovery failed: " + MainLog.SafeFailure(error),
                failure: true
            );
        }
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

    // Binding checks from this runtime's topology subscribers share the notification order,
    // including when an earlier subscriber is still completing a selected revocation.
    private readonly object bindingGate = new();
    private Task bindingChecks = Task.CompletedTask;

    internal void QueueBindingCheck(Func<Task> check)
    {
        lock (bindingGate)
            bindingChecks = bindingChecks.ContinueWith(_ => check(), CancellationToken.None,
                TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
    }


    // Identity changes must finish stale-binding checks before releasing their claims: a
    // later move or recreation could otherwise hide that a previously bound lifetime ended.
    private Task PendingBindingChecks()
    {
        lock (bindingGate)
            return bindingChecks;
    }

    internal void NotifyCreated(SessionOwner owner)
    {
        owner.ChangedProjection = (value, row) =>
        {
            if (!IsCurrentOwner(owner))
                return;
            if (value.Kind is SessionEventKind.StateChanged or SessionEventKind.MessageCommitted)
            {
                row ??= Catalog.Get(owner.Id);
                var meta = OverlayMainMetadata(owner.AuthorityMetadata(), row);
                CaptureLocalProjection(owner, meta, row);
                if (value.Kind == SessionEventKind.StateChanged)
                {
                    if (servicesReady && !IsDeletionClaimed(owner.Id))
                    {
                        if (owner.Entry.IdentityAvailable)
                            waitTimeouts.Transition(owner.Id, meta.Wait ?? SessionCatalog.WaitProjection(row?["meta"]?["wait"]));
                        waitLiveness.Transition(owner.Id, meta);
                    }
                    ObserveChannelTurn(owner, meta);
                }
            }
            Changed?.Invoke(value);
        };
        var row = Catalog.Get(owner.Id);
        CaptureLocalProjection(owner, OverlayMainMetadata(owner.AuthorityMetadata(), row), row);
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
        owner.Entry.ExternalTurn = (host, token) =>
        {
            RequireRuntimeAvailable(ClaudeRuntimeState.Kind);
            return new ClaudeSessionDriver(this, owner, host).RunAsync(token);
        };
        owner.Entry.RevokeExternalRun = () => RuntimeCredentials.Revoke(owner);
        owner.Entry.ToolProgress = (call, start) => ChannelToolProgress(owner, call, start);
        owner.Entry.StructuredProgress = progress => ChannelStructuredProgress(owner, progress);
        owner.Entry.TurnStopped = () => ChannelStoppedAsync(owner);
        owner.Entry.AssistantCommitted = message => ChannelAssistantCommittedAsync(owner, message);
        owner.Entry.RetryPresented = (retry, initial, same) =>
            ChannelRetryAsync(owner, retry, initial, same);
    }

    public string DataRoot => root;

    // RuntimeCapabilities.ClaudeRuntime: without it no Session is created on, or runs a turn of,
    // the external Claude Code runtime.
    internal void RequireRuntimeAvailable(string runtime)
    {
        if (runtime == ClaudeRuntimeState.Kind && !Capabilities.ClaudeRuntime)
            throw new InvalidDataException("The Claude Code runtime is not available on this server.");
    }

    // The tool authorization policy, MCP servers and WebUI settings of this runtime.
    internal Foxwarm.Storage.IConfigDocumentStore ConfigDocuments { get; }

    internal RecallTargetLog RecallTargets { get; }
    public bool Accepting => accepting;
    public HostModels Models => models;

    internal IArchiveSession ArchiveReader(string sessionId) =>
        Storage.Archive.ForSession(sessionId);

    private SessionOwner? FindCanonical(string id) =>
        sessions.TryGetValue(id, out var owner) && !owner.Entry.Retired && !IsRetiring(id) ? owner : null;

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

    public Task<SessionOwner> CreateAsync() => CreateNamedAsync("main", null, null, null);

    private SessionOwner MakeSession(string id, string agent, ISessionAuthority store)
    {
        var hosted = new SessionOwner(id, agent, models)
        {
            ResolveAncestry = CatalogMetadata,
            MainMetadata = OverlayMainMetadata,
            MasterNode = Capabilities.MasterNode,
        };
        hosted.RunningExecCount = () => RunningExecs(hosted).Length;
        hosted.Archive = store.Archive;
        hosted.AuthorityStore = store;
        hosted.Executor = executor;
        var requests = new ModelRequestOwner(
            http,
            clientOptions,
            modelRouting,
            Capabilities.Egress,
            websockets: websockets,
            images: Images,
            journal: Journal,
            diagnostics: diagnostics,
            retryIntervals: models.GetRetryIntervals,
            secrets: secrets
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
            Tasks
        );
        var registry = new SessionRegistry(
            store,
            new RequestChatService(chat, hosted),
            new SessionToolExecutor(
                AgentWorkspace(agent, pendingWrites, hosted.Id),
                hosted,
                this,
                tools
            ),
            migrateGoal: MigrateGoalSnapshotAsync,
            parentSessionResolver: _ => hosted.Metadata().ParentSessionId
        );
        if (secrets is { } owner)
            // Canonical append runs under the Session state gate: use the last built
            // matcher there. Queue admission (outside the gate) refreshes it.
            registry.HistoryRedaction = (sessionId, message, source) =>
                owner.RedactMessage(owner.Redactor, message, source, sessionId);
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
            AutoTitleTurnStarting(hosted);
            StartChannelTurn(hosted);
            try
            {
                await NodeProviders.RefreshAsync(CurrentNode(hosted), admissionStop.Token);
            }
            catch (Exception error) when (error is IOException or InvalidOperationException) { }
            await MaybeRefreshStaleAsync(hosted);
        };
        registry.OnTurnCompleted = (_, result) =>
        {
            if (ClaudeRuntimeState.IsExternal(hosted.Entry.Snapshot().AuthorityEnvelope))
                return Task.CompletedTask;
            // Detached; never delays continuation maintenance or the next turn.
            StartAutoTitle(hosted);
            return hosted.Compactor.AutoAfterTurnAsync(result);
        };
        registry.OnProcessorFinalizing = async (_, error, interrupted, suspended) =>
        {
            // Retire this run's draft before a queued successor can claim the processor.
            hosted.ClearDraft();
            await FinishChannelTurnAsync(hosted, error, interrupted, suspended);
        };
        registry.OnBeforeContinuation = (_, result, consume, token) =>
            ClaudeRuntimeState.IsExternal(hosted.Entry.Snapshot().AuthorityEnvelope)
                ? Task.CompletedTask
                : hosted.Compactor.BeforeContinuationAsync(result, consume, token);
        if (Capabilities.Limits is not null)
        {
            registry.TurnAdmission = EnterTurnAsync;
            registry.AdmissionClosed = admissionStop.Token;
            registry.TurnAdmissionWaiting = hosted.PublishStateChanged;
        }
        registry.OnSafePoint = _ =>
            ClaudeRuntimeState.IsExternal(hosted.Entry.Snapshot().AuthorityEnvelope)
                ? Task.CompletedTask
                : hosted.Compactor.SafePointAsync();
        registry.OnRetrySafePoint = _ =>
            ClaudeRuntimeState.IsExternal(hosted.Entry.Snapshot().AuthorityEnvelope)
                ? Task.CompletedTask
                : hosted.Compactor.SafePointAsync(propagateFailure: true);
        registry.OnChildReportMissing = (_, parent, reply) =>
            DeliverChildReportMissingAsync(hosted.Id, parent, reply);
        registry.HasCompletedCompact = _ => hosted.Compactor.HasCompletedJob;
        registry.TriggerOverride = _ =>
            Accepting && !IsDeletionClaimed(hosted.Id) && !hosted.Entry.Retired
                ? hosted.StartProcessing()
                : Task.CompletedTask;
        return hosted;
    }

    // A persisted runtime event in the parent, like a background completion; it is
    // transparent to the parent's own report boundary and wakes an idle parent.
    private async Task DeliverChildReportMissingAsync(string childId, string parentId, string reply)
    {
        using var parentUse = await UseRequiredAsync(parentId);
        var parent = parentUse.Owner;
        var item = new QueueItem(
            QueueItemType.Background,
            [new JsonObject { ["system"] = SessionBoundary.ChildReportMissing(childId, reply) }]
        );
        try
        {
            await parent.Entry.SaveLane.AdmitAsync(item, SaveKind.Strict);
        }
        finally
        {
            if (
                Accepting
                && !parent.Entry.WithState(state => state.Busy || state.Stopping)
                && parent.Registry.HasRunnableWork(parent.Entry)
            )
                parent.Registry.Trigger(parent.Id);
        }
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
        try
        {
            await DrainForShutdownAsync();
        }
        finally
        {
            // The terminal boundary every host reaches, also on composition rollback: the
            // replica's budgets forget this runtime even when a final save failed. It accepts
            // nothing more and offers no owners to release; its storage stays open.
            DisposeAdmission();
        }
    }

    private async Task DrainForShutdownAsync()
    {
        // Deferred recovery stops at BeginShutdown; it loads no owner after this.
        await deferredRecovery;
        SessionOwner[] current;
        lock (lifecycle)
            current = sessions.Values.ToArray();
        // Start bounded foreground settlement immediately; accepted effects retain
        // their dependencies throughout grace and cancellation.
        await Task.WhenAll(
            current.Select(session =>
                session.Registry.Runner.ShutdownAsync(
                    cancelForeground: ToolScript.CancelForegroundForShutdown
                )
            )
        );
        if (toolOutputSweep is not null)
            await toolOutputSweep;
        await timers.DisposeAsync();
        // Webhook handlers are ToolScript runs too; settle them before ToolScript closes.
        await Webhooks.DrainAsync();
        await DrainPublicationsAsync();
        lock (lifecycle)
            current = sessions.Values.ToArray();
        // An accepted creation can publish during closure, but its runner is fenced.
        await Task.WhenAll(
            current.Select(session =>
                session.Registry.Runner.ShutdownAsync(
                    cancelForeground: ToolScript.CancelForegroundForShutdown
                )
            )
        );
        await Task.WhenAll(current.Select(session => session.DrainForegroundAsync()));
        await DrainCopyTransfersAsync();
        await waitTimeouts.DrainAsync();
        await waitLiveness.DrainAsync();
        // Planners are independently owned. Release foreground waits first, then
        // cancel/drain planning without reclassifying interruption as user Stop.
        await Task.WhenAll(current.Select(session => session.Compactor.DrainIdleAsync()));
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
        RuntimeCredentials.Close();
        mcp.StopNotificationProducer();
        timers.StopFuture();
        // Detached runs do not survive the process; end them before draining their owners.
        ToolScript.CancelDetached();
        StopIdleRelease();
        lock (lifecycle)
        {
            accepting = false;
            foreach (var session in sessions.Values)
            {
                session.Registry.Runner.CloseAdmission();
                session.Compactor.StopIdleScheduling();
            }
        }
        admissionStop.Cancel();
        waitTimeouts.Stop();
        waitLiveness.Stop();
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        try
        {
            await DisposeServicesAsync();
        }
        finally
        {
            // Also when disposal starts here, without a shutdown first.
            DisposeAdmission();
        }
    }

    private async Task DisposeServicesAsync()
    {
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
        await NodeProviders.DisposeAsync();
        UploadStaging?.Dispose();
        Nodes.Dispose();
        await websockets.DisposeAsync();
        await Usage.DisposeAsync();
        await Activity.DisposeAsync();
        await Journal.DisposeAsync();
        await archiveWriter.DisposeAsync();
        Tasks.Dispose();
        admissionStop.Dispose();
        Catalog.Dispose();
        http.Dispose();
    }

    internal static bool IsOwnedId(string id) => SessionIdentity.IsValid(id);

    // The wire diagnostics' recording callback; null when the journal always records.
    internal Func<bool>? DiagnosticsRecordingForTest => diagnostics.Recording;
}
