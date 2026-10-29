using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed class CommittedSessionCreationException(
    string? sessionId,
    string message,
    Exception inner,
    bool? initialDeliveryCommitted = null,
    bool? parentNoticeCommitted = null
) : IOException(message, inner)
{
    public string? SessionId { get; } = sessionId;
    public bool? InitialDeliveryCommitted { get; } = initialDeliveryCommitted;
    public bool? ParentNoticeCommitted { get; } = parentNoticeCommitted;
}

internal sealed partial class SessionManager
{
    internal JsonObject AgentMetadata => agents.MetadataSnapshot();

    public string[] Agents() => agents.List();

    public string AgentDirectory(string name) => agents.AgentDirectory(name);

    public async Task<(string AgentName, string? MainSessionId)> CreateAgentAsync(
        string agentName,
        bool createMainSession = true,
        string? initialMemory = null,
        string? inherit = null,
        string? isolatedNode = null,
        string? initialSoul = null,
        SessionOwner? sourceSession = null,
        string? initialModel = null,
        string? initialNode = null,
        bool inheritMemory = false,
        string? sourceSessionId = null,
        SessionOwner? creator = null,
        JsonArray? rules = null,
        string? defaultNode = null
    )
    {
        await EnsureIdentityStartupAsync();
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        using var membership = BeginAgentAdmission(
            creator is null ? [agentName] : [agentName, creator.Agent]
        );
        RequireAgentCreation(agentName);
        isolatedNode = string.IsNullOrWhiteSpace(isolatedNode) ? null : isolatedNode.Trim();
        if (isolatedNode is not null)
            await RequireAgentNodeAsync(isolatedNode);
        inherit = string.IsNullOrWhiteSpace(inherit) ? null : inherit.Trim();
        using var operation = TrackCreation();
        var mainId = SessionIdentity.Build(agentName, "main");
        if (sourceSession is null && sourceSessionId is not null)
        {
            // Source resolves (and may create) its source only after the target-main preflight.
            // Do not hold the target creation key while entering another lifetime's creation owner.
            if (createMainSession && await IdReservedAsync(mainId))
                throw new InvalidDataException("Agent main Session ID is already reserved.");
            sourceSession = await ResolveAgentCreationSourceAsync(sourceSessionId, creator);
        }
        if (creator is not null)
            agents.RequireCreationSource(
                creator.Agent,
                sourceSession?.Agent ?? "main",
                conversion: false,
                copyMemory: inheritMemory
            );
        var gate = CreationKey(mainId);
        await gate.WaitAsync();
        try
        {
            if (
                createMainSession && await IdReservedAsync(SessionIdentity.Build(agentName, "main"))
            )
                throw new InvalidDataException("Agent main Session ID is already reserved.");
            try
            {
                await agents.CreateAsync(
                    agentName,
                    initialMemory,
                    inherit,
                    initialSoul,
                    creator?.Agent,
                    rules,
                    defaultNode
                );
            }
            catch (AuthorityCommittedException error)
            {
                throw new CommittedSessionCreationException(
                    null,
                    $"Agent '{agentName}' metadata was committed, but creation did not complete; no main Session was created. {error.Message}",
                    error
                );
            }
            try
            {
                if (inheritMemory)
                    agents.CopyIdentityMemory(sourceSession?.Agent ?? "main", agentName);
                if (isolatedNode is not null)
                    await agents.SetNodeAsync(agentName, isolatedNode);
                if (!createMainSession)
                    return (agentName, null);
                var source = sourceSession?.Entry.Snapshot().AuthorityEnvelope;
                var session = await CreateNamedLockedAsync(
                    agentName,
                    "main",
                    null,
                    null,
                    (
                        initialModel ?? SessionWait.Text(source?["model"]),
                        SessionWait.Text(source?["effort"])
                    ),
                    null,
                    initialNode: initialNode
                        ?? defaultNode
                        ?? (sourceSession is null ? null : CurrentNode(sourceSession)),
                    childDefaults: (
                        SessionWait.Text(source?["childModelDefault"]),
                        SessionWait.Text(source?["childEffortDefault"])
                    ),
                    agentMainCreation: true
                );
                return (agentName, session.Id);
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException(
                    (error as CommittedSessionCreationException)?.SessionId,
                    $"Agent '{agentName}' was created, but its main Session creation did not complete: {error.Message}",
                    error
                );
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<SessionOwner> ResolveAgentCreationSourceAsync(
        string id,
        SessionOwner? creator = null
    )
    {
        var existing = await GetExistingAsync(id);
        if (existing is not null)
            return existing;
        if (creator is not null)
            agents.RequireSessionTarget(creator.Agent, SessionIdentity.Agent(id));
        using var operation = TrackCreation();
        var gate = CreationKey(id);
        await gate.WaitAsync();
        try
        {
            existing = await GetExistingAsync(id);
            return existing
                ?? await CreateNamedLockedAsync(
                    SessionIdentity.Agent(id),
                    id[(id.LastIndexOf('/') + 1)..],
                    null,
                    null,
                    null,
                    null,
                    exactId: id,
                    initialNode: agents.DefaultNode(SessionIdentity.Agent(id)) ?? "master"
                );
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<SessionOwner> CreateNamedAsync(
        string agentName,
        string? sessionName,
        string? displayName,
        JsonObject? forceModel,
        string? initialNode = null,
        (string? Model, string? Effort)? inherited = null,
        IReadOnlyList<string>? selectedFiles = null,
        string? parentSessionId = null
    )
    {
        using var operation = TrackCreation();
        using var parentMutation = parentSessionId is null
            ? null
            : BeginOwnerMutation(await RequiredAsync(parentSessionId));
        while (true)
        {
            var candidate = sessionName ?? GenerateSessionId();
            ValidateNewSessionName(candidate);
            var id = SessionIdentity.Build(agentName, candidate);
            var gate = CreationKey(id);
            await gate.WaitAsync();
            try
            {
                if (sessionName is null && await IdReservedAsync(id))
                    continue;
                return await CreateNamedLockedAsync(
                    agentName,
                    candidate,
                    parentSessionId,
                    displayName,
                    inherited,
                    forceModel,
                    selectedFiles: selectedFiles,
                    initialNode: initialNode
                );
            }
            finally
            {
                gate.Release();
            }
        }
    }

    public async Task<(SessionOwner Child, bool Delivered)> CreateChildAsync(
        SessionOwner parent,
        string suffix,
        string? targetAgent,
        string? displayName,
        string? initialMessage,
        JsonObject? forceModel,
        bool fork = false,
        string? taskId = null,
        string? initialNode = null,
        bool userInitiated = false
    )
    {
        if (
            string.IsNullOrEmpty(suffix)
            || !System.Text.RegularExpressions.Regex.IsMatch(suffix, "^[a-zA-Z0-9_-]+$")
        )
            throw new InvalidDataException(
                "Child suffix must use only letters, numbers, hyphens and underscores."
            );
        targetAgent ??= parent.Agent;
        if (!userInitiated)
            agents.RequireSessionTarget(parent.Agent, targetAgent);
        using var membership = BeginAgentAdmission(parent.Agent, targetAgent);
        AgentCatalog.ValidateName(targetAgent);
        if (!agents.Exists(targetAgent))
            throw new InvalidDataException("Target Agent does not exist.");
        if (fork && targetAgent != parent.Agent)
            throw new InvalidDataException("create_child_session cannot fork across Agents.");
        using var operation = TrackCreation();
        using var parentMutation = BeginOwnerMutation(parent);
        var allocationBase =
            targetAgent != parent.Agent ? SessionIdentity.Build(targetAgent, suffix)
            : parent.Id.Split('/').Last() == "main" ? SessionIdentity.Build(targetAgent, suffix)
            : parent.Id + "_" + suffix;
        var gate = CreationKey(allocationBase);
        await gate.WaitAsync();
        SessionOwner child;
        try
        {
            if (fork)
                child = await ForkLockedAsync(
                    parent,
                    suffix,
                    true,
                    displayName,
                    forceModel,
                    taskId,
                    initialNode: initialNode
                );
            else
            {
                var parentId = parent.Id;
                var baseId =
                    targetAgent != parent.Agent ? SessionIdentity.Build(targetAgent, suffix)
                    : parentId.Split('/').Last() == "main"
                        ? SessionIdentity.Build(targetAgent, suffix)
                    : parentId + "_" + suffix;
                var candidate = baseId;
                for (var serial = 2; await IdReservedAsync(candidate); serial++)
                    candidate = baseId + "_" + serial.ToString(CultureInfo.InvariantCulture);
                var parentEnvelope = parent.Entry.Snapshot().AuthorityEnvelope;
                var childRawModel =
                    forceModel?["modelId"]?.GetValue<string>()
                    ?? parentEnvelope["childModelDefault"]?.GetValue<string>()
                    ?? parentEnvelope["model"]?.GetValue<string>();
                var childRawEffort =
                    forceModel?["effort"]?.GetValue<string>()
                    ?? parentEnvelope["childEffortDefault"]?.GetValue<string>()
                    ?? parentEnvelope["effort"]?.GetValue<string>();
                child = await CreateNamedLockedAsync(
                    targetAgent,
                    candidate[(candidate.IndexOf('/') + 1)..],
                    parentId,
                    displayName,
                    (childRawModel, childRawEffort),
                    forceModel,
                    candidate,
                    targetAgent == parent.Agent ? AgentMemory.Selection(parentEnvelope) : null,
                    initialNode: initialNode
                        ?? agents.DefaultNode(targetAgent)
                        ?? CurrentNode(parent)
                );
                try
                {
                    var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var system =
                        SessionBoundary.Identity(parentId, child.Id, inherited: false)
                        + "\nYou are a child session (new, empty context). "
                        + SessionBoundary.Completion(parentId, HandoffConfirmationEnabled, taskId);
                    await child.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
                    {
                        var message = new JsonObject
                        {
                            ["role"] = "user",
                            ["parts"] = new JsonArray(new JsonObject { ["system"] = system }),
                            ["__meta"] = new JsonObject
                            {
                                ["timestamp"] = time,
                                ["seq"] = state.NextMessageSeq,
                            },
                        };
                        InputWrapperMetadata.StampSequence(message);
                        var snapshot = state.Snapshot();
                        var meta = (JsonObject)snapshot.Meta.DeepClone();
                        meta["messageCount"] = snapshot.History.Count + 1;
                        return new CanonicalAppendPreparation(
                            snapshot with
                            {
                                History = snapshot.History.AppendJson([message]),
                                NextMessageSeq = snapshot.NextMessageSeq + 1,
                                Meta = meta,
                            },
                            [message],
                            live =>
                            {
                                live.History.Add((JsonObject)message.DeepClone());
                                live.NextMessageSeq++;
                                live.Meta["messageCount"] = live.History.Count;
                            }
                        );
                    });
                    child.Entry.InvokeCommitted(child.Entry.Snapshot());
                }
                catch (Exception error)
                {
                    throw new CommittedSessionCreationException(
                        child.Id,
                        $"Child Session '{child.Id}' was committed but its boundary message failed: {error.Message}",
                        error
                    );
                }
            }
        }
        finally
        {
            gate.Release();
        }
        if (string.IsNullOrEmpty(initialMessage))
            return (child, false);
        try
        {
            await SendAsync(parent, child.Id, initialMessage);
        }
        catch (Exception error)
        {
            var committed = error is AuthorityCommittedException;
            throw new CommittedSessionCreationException(
                child.Id,
                committed
                    ? $"Child Session '{child.Id}' and its initial message were committed, but delivery durability failed: {error.Message}"
                    : $"Child Session '{child.Id}' was committed but its initial message was not delivered: {error.Message}",
                error,
                committed
            );
        }
        return (child, true);
    }

    public async Task<string> SendAsync(
        SessionOwner source,
        string requestedTarget,
        string message,
        JsonObject? toolArgs = null,
        bool trigger = true,
        JsonObject? taskNotification = null,
        string? toolScriptRunId = null
    )
    {
        var targetId = ResolveSessionReference(source, requestedTarget);
        var target = await RequiredAsync(targetId);
        if (toolArgs is not null)
            await AuthorizeToolAsync(
                source,
                new("send_to_session", "builtin", "send_to_session", toolArgs),
                null,
                semanticCaller.Value ?? CancellationToken.None,
                target
            );
        var selfSend = source.Id == target.Id;
        if (selfSend && string.IsNullOrEmpty(toolScriptRunId))
            throw new InvalidDataException("A Session cannot send to itself.");
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        var sourceParent = source.Metadata().ParentSessionId;
        var targetParent = target.Metadata().ParentSessionId;
        var relation =
            taskNotification is not null ? null
            : sourceParent == target.Id ? "direct-child"
            : targetParent == source.Id ? "parent"
            : "other";
        var now = DateTimeOffset.Now;
        var offset = now.ToString("zzz", CultureInfo.InvariantCulture)
            .Replace(":", "", StringComparison.Ordinal);
        var time = now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + offset;
        var taskId = taskNotification?["taskId"]?.GetValue<string>() ?? "";
        if (taskId.Length > 128)
            taskId = taskId[..128];
        var taskEvent = taskNotification?["event"]?.GetValue<string>() ?? "";
        var taskHint =
            taskNotification?["recipient"]?.GetValue<string>() == "new"
                ? "Task assignment from Foxwarm, not direct user input. Complete this task with the task tool when the assigned work is finished; completion automatically notifies the task creator. Do not send a separate routine completion message."
                : "task notification from Foxwarm; not direct user input";
        var wrapper =
            selfSend
                ? $"<foxwarm-message type=\"toolscript\" sourceSessionId=\"{Escape(source.Id)}\" runId=\"{Escape(toolScriptRunId!)}\" time=\"{Escape(time)}\" hint=\"Message queued by a ToolScript in this Session, not direct user input.\">\n"
                    + message
                    + "\n</foxwarm-message>"
            : taskNotification is null
                ? $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{Escape(source.Id)}\" "
                    + $"replyTargetSessionId=\"{Escape(source.Id)}\" replyVia=\"send_to_session\" time=\"{Escape(time)}\" "
                    + "hint=\"inter-agent message from another session, not direct end-user input\">\n"
                    + message
                    + "\n</foxwarm-message>"
            : $"<foxwarm-message type=\"task\" taskId=\"{Escape(taskId)}\" event=\"{Escape(taskEvent)}\" sourceSessionId=\"{Escape(source.Id)}\" time=\"{Escape(time)}\" hint=\"{Escape(taskHint)}\">\n"
                + message
                + "\n</foxwarm-message>";
        var item = new QueueItem(
            QueueItemType.Intersession,
            [new JsonObject { ["system"] = wrapper }],
            SourceSessionId: source.Id,
            SourceSessionRelation: relation,
            Trigger: trigger
        );
        try
        {
            await target.Entry.SaveLane.CommitInterSessionAsync(item);
        }
        catch (AuthorityCommittedException)
        {
            if (
                item.Trigger
                && Accepting
                && !target.Entry.WithState(state => state.Busy || state.Stopping)
                && target.Registry.HasRunnableWork(target.Entry)
            )
                target.Registry.Trigger(target.Id);
            throw;
        }
        if (
            trigger
            && Accepting
            && !target.Entry.WithState(state => state.Busy || state.Stopping)
            && target.Registry.HasRunnableWork(target.Entry)
        )
            target.Registry.Trigger(target.Id);
        if (relation == "direct-child" && successfulSendReceipt.Value is { } receipt)
            receipt.Target = target.Id;
        return target.Id;
    }

    public async Task<string?> RefreshSnapshotAsync(SessionOwner session)
    {
        using var admission = BeginOwnerMutation(session);
        var snapshot = session.Entry.Snapshot();
        var modelId = ConditionalMemory.ReadCurrentModelSnapshotId(
            snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? ""
        );
        if (modelId is null)
        {
            var model =
                models.All.Count == 0
                    ? null
                    : models.Resolve(SessionWait.Text(snapshot.AuthorityEnvelope["model"]));
            if (model is null || model.IsVirtual)
                return null;
            modelId = model.Key;
        }
        var value = await memory.BuildAsync(
            session.Agent,
            session.Id,
            modelId,
            selection: AgentMemory.Selection(snapshot.AuthorityEnvelope)
        );
        await session.Entry.SaveLane.CommitMemorySnapshotAsync(value);
        return modelId;
    }

    private async Task<SessionOwner> CreateNamedLockedAsync(
        string agentName,
        string sessionName,
        string? parentId,
        string? displayName,
        (string? Model, string? Effort)? inherited,
        JsonObject? forceModel,
        string? exactId = null,
        IReadOnlyList<string>? selectedFiles = null,
        bool timerCreation = false,
        string? timerNode = null,
        string? initialNode = null,
        (string? Model, string? Effort)? childDefaults = null,
        bool agentMainCreation = false
    )
    {
        using var membership = BeginAgentAdmission(agentName);
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        if (!agents.Exists(agentName))
            throw new InvalidDataException($"Agent '{agentName}' does not exist.");
        ValidateNewSessionName(sessionName);
        var id = exactId ?? SessionIdentity.Build(agentName, sessionName);
        if (!SessionIdentity.IsValid(id) || SessionIdentity.Agent(id) != agentName)
            throw new InvalidDataException("Invalid Session identity.");
        if (await IdReservedAsync(id))
            throw new InvalidDataException($"Session ID '{id}' is already reserved.");
        if (parentId is not null && Find(parentId) is null)
            throw new InvalidDataException("Parent Session does not exist.");
        var selectedNode =
            BoundNode(agentName)
            ?? (
                timerCreation
                    ? agents.DefaultNode(agentName) ?? timerNode
                    : initialNode ?? agents.DefaultNode(agentName)
            );
        if (selectedNode is null && agentName != "main")
        {
            var main = await GetExistingAsync(SessionIdentity.Build(agentName, "main"));
            if (main is not null && CurrentNode(main) is { } mainNode && mainNode != "master")
                selectedNode = mainNode;
        }
        return await WithCreationIdentityAsync(
            id,
            async () =>
            {
                var (model, effort) = ValidateModelSettings(
                    inherited,
                    forceModel,
                    preserveInheritedModel: agentMainCreation
                );
                if (timerCreation)
                    model = inherited?.Model;
                var selectedModel = models.All.Count == 0 ? null : models.Resolve(model);
                var snapshotModel =
                    selectedModel is null || selectedModel.IsVirtual ? null : selectedModel.Key;
                var snapshotText = snapshotModel is null
                    ? ""
                    : await memory.BuildAsync(
                        agentName,
                        id,
                        snapshotModel,
                        selection: selectedFiles
                    );
                var store = MakeStore(id, agentName);
                var hosted = MakeSession(id, agentName, store);
                var entry = hosted.Registry.Add(id);
                BindMutations(hosted);
                entry.WithState(state =>
                {
                    state.Meta["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    state.AuthorityEnvelope["agent"] = agentName;
                    if (parentId is not null)
                        state.AuthorityEnvelope["parentSessionId"] = parentId;
                    if (displayName is not null)
                        state.AuthorityEnvelope["displayName"] = displayName;
                    state.AuthorityEnvelope["currentNode"] = selectedNode ?? "master";
                    if (model is not null)
                        state.AuthorityEnvelope["model"] = model;
                    if (effort is not null)
                        state.AuthorityEnvelope["effort"] = effort;
                    if (childDefaults?.Model is string childModel)
                        state.AuthorityEnvelope["childModelDefault"] = childModel;
                    if (childDefaults?.Effort is string childEffort)
                        state.AuthorityEnvelope["childEffortDefault"] = childEffort;
                    state.AuthorityEnvelope["persistentMemorySnapshot"] = snapshotText;
                    if (selectedFiles is not null)
                        state.AuthorityEnvelope["systemPromptFiles"] = new JsonArray(
                            selectedFiles
                                .Select(text => (JsonNode?)JsonValue.Create(text))
                                .ToArray()
                        );
                    state.AuthorityEnvelope["promptCacheKey"] = Guid.NewGuid().ToString();
                });
                var branch = store.Archive.EnsureBranch();
                try
                {
                    await entry.SaveLane.SaveStrictAsync();
                }
                catch (AuthorityCommittedException error)
                {
                    await PublishCreatedAsync(hosted);
                    throw new CommittedSessionCreationException(
                        id,
                        $"Session '{id}' was committed but the final durability step failed.",
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

    internal Func<string, Task>? BeforeCreationPublication { get; set; }

    private async Task PublishCreatedAsync(SessionOwner session)
    {
        if (BeforeCreationPublication is { } before)
            await before(session.Id);
        IdentitySlot slot;
        lock (lifecycle)
            slot =
                identities.GetValueOrDefault(session.Id)
                ?? throw new InvalidOperationException("Creation identity was not claimed.");
        PublishOwner(session, slot);
    }

    private (string? Model, string? Effort) ValidateModelSettings(
        (string? Model, string? Effort)? inherited,
        JsonObject? forceModel,
        bool preserveInheritedModel = false
    )
    {
        if (
            forceModel is not null
            && (
                forceModel.Count > 2
                || forceModel.Any(pair => pair.Key is not ("modelId" or "effort"))
            )
        )
            throw new InvalidDataException("forceModel accepts only modelId and effort.");
        if (
            forceModel?.ContainsKey("modelId") == true && forceModel["modelId"] is not JsonValue
            || forceModel?.ContainsKey("effort") == true && forceModel["effort"] is not JsonValue
        )
            throw new InvalidDataException(
                "forceModel values must be configured model and effort strings."
            );
        var model = forceModel?["modelId"] is JsonNode modelValue
            ? modelValue is JsonValue m && m.TryGetValue<string>(out var id) && models.Contains(id)
                ? id
                : throw new InvalidDataException("Unknown configured model key.")
            : inherited?.Model;
        // Agent mains copy stored raw selection across configuration removal. Resolution below
        // still uses the current default for effort and snapshot selection when that key is absent.
        if (preserveInheritedModel && model is not null)
            model = SessionGoal.Trim(model) is { Length: > 0 } rawModel ? rawModel : null;
        if (!preserveInheritedModel && model is not null && !models.Contains(model))
            model = null;
        var allowedEfforts =
            models.All.Count == 0 ? HostModels.Efforts : models.Resolve(model).AllowedEfforts;
        var effort = forceModel?["effort"] is JsonNode effortValue
            ? effortValue is JsonValue e
            && e.TryGetValue<string>(out var raw)
            && allowedEfforts.Contains(raw, StringComparer.Ordinal)
                ? raw
                : throw new InvalidDataException("Requested model effort is not allowed.")
            : inherited?.Effort;
        if (effort is not null && !allowedEfforts.Contains(effort, StringComparer.Ordinal))
            effort = null;
        return (model, effort);
    }

    internal string ResolveSessionReference(SessionOwner source, string requested)
    {
        var metadata =
            Catalog.Get(source.Id)
            ?? throw new InvalidDataException($"Session `{source.Id}` not found.");
        return requested switch
        {
            "<parent>" => SessionCatalog.Text(metadata["parentSessionId"]) is { Length: > 0 } parent
                ? parent
                : throw new InvalidDataException(
                    $"Cannot resolve `<parent>`: current Session `{source.Id}` has no parent Session."
                ),
            "<main>" => SessionIdentity.Build(
                SessionCatalog.Text(metadata["agent"]) ?? "main",
                "main"
            ),
            _ => requested,
        };
    }

    private async Task<bool> IdReservedAsync(string id)
    {
        await EnsureIdentityStartupAsync();
        if (archiveIdentities.IsReserved(id))
            return true;
        lock (lifecycle)
            if (
                identityMoveClaims.ContainsKey(id)
                || pendingIdentityReservations.Contains(id)
                || unresolvedIdentityMove is { } pendingMove
                    && (id == pendingMove.OldId || id == pendingMove.NewId)
            )
                return true;
        bool pending;
        lock (lifecycle)
            pending = identities.ContainsKey(id);
        if (
            pending
            || Catalog.Get(id) is not null
            || sessions.ContainsKey(id)
            || File.Exists(Path.Combine(root, "state", "sessions", id + ".json"))
        )
            return true;
        var archive = Path.Combine(root, "state", "archive-store.sqlite");
        if (!File.Exists(archive))
            return false;
        await using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = archive,
                Mode = SqliteOpenMode.ReadOnly,
            }.ToString()
        );
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_branches'";
        var hasBranches = await command.ExecuteScalarAsync() is not null;
        var hasReservations = SqliteArchiveMessageStore.HasReservationTable(connection);
        command.CommandText =
            "SELECT 1 FROM archive_messages WHERE session_id=$id UNION SELECT 1 FROM archive_blocks WHERE session_id=$id"
            + (hasBranches ? " UNION SELECT 1 FROM archive_branches WHERE session_id=$id" : "")
            + (
                hasReservations
                    ? " UNION SELECT 1 FROM archive_session_id_reservations WHERE session_id=$id OR canonical_session_id=$id"
                    : ""
            )
            + " LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return await command.ExecuteScalarAsync() is not null;
    }

    private PersistentSessionAuthorityStore MakeStore(string id, string agent)
    {
        IdentitySlot slot;
        lock (lifecycle)
            slot =
                identities.GetValueOrDefault(id)
                ?? throw new InvalidOperationException("Session identity was not claimed.");

        PersistentSessionAuthorityStore store = null!;
        store = new PersistentSessionAuthorityStore(
            root,
            id,
            agent,
            authorityStageHook: authorityStageHook is null
                ? null
                : stage => authorityStageHook(store.SessionId, stage),
            canonicalCommitBarrier: canonicalCommitBarrier is null
                ? null
                : (commit, token) => canonicalCommitBarrier(store.SessionId, commit, token),
            publishProjection: snapshot => PublishCatalogSnapshot(snapshot, slot),
            mainFields: () => Catalog.Get(store.SessionId),
            checkLifetime: () =>
            {
                lock (lifecycle)
                    if (
                        !identities.TryGetValue(store.SessionId, out var current)
                        || current != slot
                        || slot.Retired
                    )
                        throw new InvalidOperationException(
                            "Session authority lifetime has retired."
                        );
            },
            archiveCommitted: OnArchiveCommitted
        );
        return store;
    }

    private static string Escape(string text) =>
        text.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
}
