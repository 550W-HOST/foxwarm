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
    public string[] Agents() => agents.List();

    public string AgentDirectory(string name) => agents.AgentDirectory(name);

    public async Task<(string AgentName, string? MainSessionId)> CreateAgentAsync(
        string agentName,
        bool createMainSession = true,
        string? initialMemory = null,
        string? inherit = null,
        string? isolatedNode = null
    )
    {
        await EnsureIdentityStartupAsync();
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        RequireAgentCreation(agentName);
        isolatedNode = string.IsNullOrWhiteSpace(isolatedNode) ? null : isolatedNode.Trim();
        if (isolatedNode is not null)
            RequireApprovedAgentNode(isolatedNode);
        inherit = string.IsNullOrWhiteSpace(inherit) ? null : inherit.Trim();
        using var operation = TrackCreation();
        var gate = CreationKey(SessionIdentity.Build(agentName, "main"));
        await gate.WaitAsync();
        try
        {
            try
            {
                await agents.CreateAsync(agentName, initialMemory, inherit);
            }
            catch (AuthorityCommittedException error)
            {
                throw new CommittedSessionCreationException(
                    null,
                    $"Agent '{agentName}' catalog was committed, but its final durability step failed; no main Session was created.",
                    error
                );
            }
            try
            {
                if (isolatedNode is not null)
                    await agents.SetNodeAsync(agentName, isolatedNode);
                if (!createMainSession)
                    return (agentName, null);
                var session = await CreateNamedLockedAsync(
                    agentName,
                    "main",
                    null,
                    null,
                    null,
                    null
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

    public async Task<SessionOwner> CreateNamedAsync(
        string agentName,
        string sessionName,
        string? displayName,
        JsonObject? forceModel
    )
    {
        using var operation = TrackCreation();
        var gate = CreationKey(SessionIdentity.Build(agentName, sessionName));
        await gate.WaitAsync();
        try
        {
            return await CreateNamedLockedAsync(
                agentName,
                sessionName,
                null,
                displayName,
                null,
                forceModel
            );
        }
        finally
        {
            gate.Release();
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
        string? taskId = null
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
                    taskId
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
                    targetAgent == parent.Agent ? AgentMemory.Selection(parentEnvelope) : null
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
                        var snapshot = state.Snapshot();
                        var meta = (JsonObject)snapshot.Meta.DeepClone();
                        meta["messageCount"] = snapshot.History.Count + 1;
                        return new CanonicalAppendPreparation(
                            snapshot with
                            {
                                History = snapshot.History.Append(message).ToArray(),
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
        JsonObject? taskNotification = null
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
        if (source.Id == target.Id)
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
        var wrapper = taskNotification is null
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

    public async Task<string> RefreshSnapshotAsync(SessionOwner session)
    {
        using var admission = BeginOwnerMutation(session);
        var snapshot = session.Entry.Snapshot();
        var modelId =
            ConditionalMemory.ReadCurrentModelSnapshotId(
                snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? ""
            ) ?? models.Select(snapshot).Model.Key;
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
        string? timerNode = null
    )
    {
        if (!accepting)
            throw new InvalidOperationException("Host is shutting down.");
        if (!agents.Exists(agentName))
            throw new InvalidDataException($"Agent '{agentName}' does not exist.");
        var id = exactId ?? SessionIdentity.Build(agentName, sessionName);
        if (!SessionIdentity.IsValid(id) || SessionIdentity.Agent(id) != agentName)
            throw new InvalidDataException("Invalid Session identity.");
        if (await IdReservedAsync(id))
            throw new InvalidDataException($"Session ID '{id}' is already reserved.");
        if (parentId is not null && Find(parentId) is null)
            throw new InvalidDataException("Parent Session does not exist.");
        return await WithCreationIdentityAsync(
            id,
            async () =>
            {
                var (model, effort) = ValidateModelSettings(inherited, forceModel);
                if (timerCreation)
                    model = inherited?.Model;
                var snapshotModel = models.Resolve(model).Key;
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
                    state.AuthorityEnvelope["currentNode"] =
                        BoundNode(agentName)
                        ?? (
                            timerCreation ? timerNode
                            : parentId is not null ? CurrentNode(Find(parentId)!)
                            : null
                        )
                        ?? "master";
                    if (model is not null)
                        state.AuthorityEnvelope["model"] = model;
                    if (effort is not null)
                        state.AuthorityEnvelope["effort"] = effort;
                    state.AuthorityEnvelope["persistentMemorySnapshot"] = snapshotText;
                    if (selectedFiles is not null)
                        state.AuthorityEnvelope["systemPromptFiles"] = new JsonArray(
                            selectedFiles
                                .Select(text => (JsonNode?)JsonValue.Create(text))
                                .ToArray()
                        );
                    state.AuthorityEnvelope["promptCacheKey"] = Guid.NewGuid().ToString("N");
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
                        CompensateCreatedBranch(store, branch);
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
        await CreationPublicationBarrierAsync(session.Id);
        IdentitySlot slot;
        lock (lifecycle)
            slot =
                identities.GetValueOrDefault(session.Id)
                ?? throw new InvalidOperationException("Creation identity was not claimed.");
        PublishOwner(session, slot);
    }

    private (string? Model, string? Effort) ValidateModelSettings(
        (string? Model, string? Effort)? inherited,
        JsonObject? forceModel
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
        if (model is not null && !models.Contains(model))
            model = null;
        var leaf = models.Resolve(model);
        var effort = forceModel?["effort"] is JsonNode effortValue
            ? effortValue is JsonValue e
            && e.TryGetValue<string>(out var raw)
            && leaf.AllowedEfforts.Contains(raw, StringComparer.Ordinal)
                ? raw
                : throw new InvalidDataException("Requested model effort is not allowed.")
            : inherited?.Effort;
        if (effort is not null && !leaf.AllowedEfforts.Contains(effort, StringComparer.Ordinal))
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

        var legacyCreateMarker = Path.Combine(
            root,
            "state",
            "experiment-faults",
            "legacy-create-after-rename"
        );
        PersistentSessionAuthorityStore store = null!;
        store = new PersistentSessionAuthorityStore(
            root,
            id,
            agent,
            stage =>
            {
                if (SessionSaveLane.IsClearCommit && stage == AtomicJsonWriteStage.BeforeRename)
                {
                    var hold = Path.Combine(
                        root,
                        "state",
                        "experiment-faults",
                        SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id)
                            + ".clear-hold-before-rename"
                    );
                    if (File.Exists(hold))
                    {
                        File.WriteAllText(hold + ".reached", "reached");
                        var deadline = DateTime.UtcNow.AddSeconds(15);
                        while (File.Exists(hold) && DateTime.UtcNow < deadline)
                            Thread.Sleep(2);
                        if (File.Exists(hold))
                            throw new TimeoutException("Experimental clear barrier expired.");
                    }
                }
                var lifecycleSuffix =
                    stage == AtomicJsonWriteStage.BeforeRename ? "-before-rename"
                    : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync ? "-after-rename"
                    : null;
                if (lifecycleSuffix is not null)
                {
                    var action =
                        SessionSaveLane.IsClearCommit ? "clear"
                        : ManualForkNoticeCommitScope.Value ? "fork-notice"
                        : Find(store?.SessionId ?? id) is null ? "create"
                        : null;
                    if (action is not null)
                    {
                        var fault = Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id)
                                + "."
                                + action
                                + lifecycleSuffix
                        );
                        if (File.Exists(fault))
                        {
                            File.Delete(fault);
                            throw new IOException(
                                "Injected experimental " + action + " commit failure."
                            );
                        }
                    }
                }
                if (store is { IsIdentitySnapshotCommit: true })
                {
                    var identitySuffix =
                        stage == AtomicJsonWriteStage.BeforeRename
                            ? ".identity-authority-before-rename"
                        : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            ? ".identity-authority-after-rename"
                        : null;
                    if (identitySuffix is not null)
                    {
                        var identityMarker = Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store.SessionId) + identitySuffix
                        );
                        if (File.Exists(identityMarker))
                        {
                            File.Delete(identityMarker);
                            throw new IOException(
                                "Injected experimental identity authority write failure."
                            );
                        }
                    }
                }
                if (SessionSaveLane.IsSettingsCommit)
                {
                    if (stage == AtomicJsonWriteStage.BeforeRename)
                    {
                        var hold = Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id)
                                + ".settings-hold-before-rename"
                        );
                        if (File.Exists(hold))
                        {
                            File.WriteAllText(hold + ".reached", "reached");
                            var deadline = DateTime.UtcNow.AddSeconds(15);
                            while (File.Exists(hold) && DateTime.UtcNow < deadline)
                                Thread.Sleep(2);
                            if (File.Exists(hold))
                                throw new TimeoutException(
                                    "Experimental settings publication barrier expired."
                                );
                        }
                    }
                    var suffix =
                        stage == AtomicJsonWriteStage.BeforeRename ? ".settings-before-rename"
                        : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            ? ".settings-after-rename"
                        : null;
                    if (suffix is not null)
                    {
                        var settingsMarker = Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id) + suffix
                        );
                        if (File.Exists(settingsMarker))
                        {
                            File.Delete(settingsMarker);
                            throw new IOException("Injected experimental settings commit failure.");
                        }
                    }
                }
                if (SessionSaveLane.IsWaitCommit)
                {
                    var suffix =
                        stage == AtomicJsonWriteStage.BeforeRename ? ".wait-before-rename"
                        : stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            ? ".wait-after-rename"
                        : null;
                    if (suffix is not null)
                    {
                        var waitMarker = Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id) + suffix
                        );
                        if (File.Exists(waitMarker))
                        {
                            File.Delete(waitMarker);
                            throw new IOException("Injected experimental wait commit failure.");
                        }
                    }
                }
                if (
                    stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                    && SessionIdentity.IsLegacyGenerated(id)
                    && Find(store?.SessionId ?? id) is null
                    && File.Exists(legacyCreateMarker)
                )
                {
                    File.Delete(legacyCreateMarker);
                    throw new IOException(
                        "Injected experimental legacy Session post-rename failure."
                    );
                }
                if (stage == AtomicJsonWriteStage.BeforeRename && SessionSaveLane.IsTimerQueueWrite)
                {
                    var hold = Path.Combine(
                        root,
                        "state",
                        "experiment-faults",
                        SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id)
                            + ".timer-queue-hold-before-rename"
                    );
                    if (File.Exists(hold))
                    {
                        File.WriteAllText(hold + ".reached", "reached");
                        var deadline = DateTime.UtcNow.AddSeconds(15);
                        while (File.Exists(hold) && DateTime.UtcNow < deadline)
                            Thread.Sleep(2);
                        if (File.Exists(hold))
                            throw new TimeoutException(
                                "Experimental timer queue publication barrier expired."
                            );
                    }
                }
                if (
                    stage != AtomicJsonWriteStage.BeforeRename
                    || !SessionSaveLane.IsSnapshotCommit
                    || !File.Exists(
                        Path.Combine(
                            root,
                            "state",
                            "experiment-faults",
                            SessionIdentity.ExecDirectorySegment(store!.SessionId)
                                + ".snapshot-before-rename"
                        )
                    )
                )
                    return;
                File.Delete(
                    Path.Combine(
                        root,
                        "state",
                        "experiment-faults",
                        SessionIdentity.ExecDirectorySegment(store!.SessionId)
                            + ".snapshot-before-rename"
                    )
                );
                throw new IOException("Injected experimental memory snapshot pre-rename failure.");
            },
            canonicalCommitBarrier: async (_, cancellationToken) =>
            {
                var hold = Path.Combine(
                    root,
                    "state",
                    "experiment-faults",
                    SessionIdentity.ExecDirectorySegment(store?.SessionId ?? id)
                        + ".canonical-hold-before-rename"
                );
                if (!File.Exists(hold))
                    return;
                await File.WriteAllTextAsync(hold + ".reached", "reached", cancellationToken);
                var deadline = DateTime.UtcNow.AddSeconds(15);
                while (File.Exists(hold) && DateTime.UtcNow < deadline)
                    await Task.Delay(2, cancellationToken);
                if (File.Exists(hold))
                    throw new TimeoutException(
                        "Experimental canonical publication barrier expired."
                    );
            },
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
            }
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
