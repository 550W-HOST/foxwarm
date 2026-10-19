using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private sealed class IdentityMoveOperation(
        SessionOwner owner,
        SessionIdentityMoveRecord record,
        string[] claims
    )
    {
        internal readonly SessionOwner Owner = owner;
        internal SessionIdentityMoveRecord Record = record;
        internal readonly string[] Claims = claims;
        internal readonly TaskCompletionSource Finished = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
    }

    private readonly SemaphoreSlim identityMoveGate = new(1, 1);
    private readonly SemaphoreSlim identityStartupGate = new(1, 1);
    private readonly Dictionary<string, IdentityMoveOperation> identityMoveClaims = new(
        StringComparer.Ordinal
    );
    private readonly HashSet<string> pendingIdentityReservations = new(StringComparer.Ordinal);
    private readonly AsyncLocal<IdentityMoveOperation?> owningIdentityMove = new();
    private volatile bool identityStartupComplete;
    private SessionIdentityMoveRecord? unresolvedIdentityMove;
    internal Func<string, string, Task>? BeforeIdentityStage { get; set; }
    private string ArchiveDatabase => Path.Combine(root, "state", "archive-store.sqlite");
    private SessionIdentityMoveJournal IdentityJournal => new(root);

    internal WorkspaceTools IdentityWorkspace(
        SessionOwner owner,
        string? capturedCwd = null,
        string? capturedNode = null,
        bool useLiveCwd = true
    )
    {
        var live = ExecutionPlacement(owner);
        var node = capturedNode ?? live.Node;
        var cwd =
            node == "master"
                ? capturedCwd ?? (useLiveCwd && live.Node == "master" ? live.Cwd : null)
                : null;
        return new(
            agents.AgentDirectory(owner.Agent),
            pendingWrites,
            owner.Id,
            owner.Agent,
            owner,
            cwd
        );
    }

    internal bool SameAdmittedLifetime(string first, string second)
    {
        lock (lifecycle)
            return identities.TryGetValue(first, out var a)
                && identities.TryGetValue(second, out var b)
                && a == b
                && a.Owner.Task.IsCompletedSuccessfully;
    }

    internal async Task WaitForIdentityMutationAsync(string id, CancellationToken token = default)
    {
        IdentityMoveOperation? operation;
        lock (lifecycle)
            identityMoveClaims.TryGetValue(id, out operation);
        if (operation is not null && operation != owningIdentityMove.Value)
            await operation.Finished.Task.WaitAsync(token);
    }

    private void RequireIdentityAction(IEnumerable<string> ids)
    {
        foreach (var id in ids)
        {
            if (pendingIdentityReservations.Contains(id) && owningIdentityMove.Value is null)
                throw new SessionIdentityUnavailableException(
                    "This identity has a pending move. Complete identity recovery before changing it.",
                    new JsonObject { ["sessionId"] = id }
                );
            if (
                identityMoveClaims.TryGetValue(id, out var operation)
                && operation != owningIdentityMove.Value
            )
                throw new InvalidOperationException(
                    "Session identity is changing. Retry after the move finishes."
                );
            if (sessions.TryGetValue(id, out var owner))
                owner.Entry.RequireIdentityAuthority();
        }
    }

    private void RequireAgentCreation(string agent)
    {
        if (
            unresolvedIdentityMove is { OwnsAgent: true, Phase: "rolling-back" } pending
            && pending.OwnedAgent == agent
        )
            throw new InvalidOperationException(
                "This Agent directory belongs to a pending identity move. Complete identity recovery first."
            );
    }

    private async Task IdentityStageAsync(IdentityMoveOperation operation, string stage)
    {
        if (BeforeIdentityStage is { } before)
            await before(operation.Record.OldId, stage);
        var marker = Path.Combine(
            root,
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment(operation.Record.OldId) + ".identity-" + stage
        );
        if (File.Exists(marker))
        {
            File.Delete(marker);
            throw new IOException("Injected experimental identity move failure at " + stage + ".");
        }
        var hold = marker + "-hold";
        if (!File.Exists(hold))
            return;
        await File.WriteAllTextAsync(hold + ".reached", "reached");
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(hold) && DateTime.UtcNow < deadline)
            await Task.Delay(2);
        if (File.Exists(hold))
            throw new TimeoutException("Experimental identity barrier expired.");
    }

    private void RebindIdentityOwner(SessionOwner owner, string id, string agent)
    {
        var previous = owner.Id;
        owner.AuthorityStore.RebindIdentity(id, agent);
        owner.Archive = owner.AuthorityStore.Archive;
        owner.RebindIdentity(id, agent);
        lock (lifecycle)
        {
            var slot = identities[previous];
            if (identities.TryGetValue(id, out var other) && other != slot)
                throw new InvalidOperationException("Identity target has another lifetime.");
            identities[id] = slot;
            sessions.TryRemove(previous, out _);
            sessions[id] = owner;
        }
        executor.RebindIdentity(previous, id);
        Nodes.ExecClaims.Rebind(owner);
        lock (presentationGate)
        {
            if (localVisible.Remove(previous))
                volatileSequence++;
        }
    }

    internal async Task<JsonObject> MoveIdentityAsync(
        SessionOwner caller,
        JsonObject args,
        CancellationToken token = default
    )
    {
        ToolRegistry.Keys(
            args,
            [
                "sessionId",
                "newSessionId",
                "createAgent",
                "newAgentName",
                "createAgentInheritMemory",
                "parentSessionId",
            ]
        );
        await EnsureIdentityStartupAsync();
        token.ThrowIfCancellationRequested();
        caller.Entry.RequireIdentityAuthority();
        var input = SessionGoal.Trim(OptionalString(args, "sessionId") ?? caller.Id);
        if (input.Length == 0)
            input = caller.Id;
        var owner = await RequiredAsync(input, token);
        var old = owner.Id;
        var name = OptionalString(args, "newSessionId");
        var agentName = OptionalString(args, "newAgentName");
        var create = (OptionalBool(args, "createAgent") ?? false);
        var copy = (OptionalBool(args, "createAgentInheritMemory") ?? false);
        if (name is not null && (name.Length == 0 || name.Contains('/')))
            throw new InvalidDataException("New Session name must be nonempty without '/'.");
        if (agentName is not null)
            AgentCatalog.ValidateName(agentName);
        var targetAgent =
            create || !string.IsNullOrEmpty(agentName)
                ? agentName
                    ?? throw new InvalidDataException(
                        "newAgentName is required when creating an Agent."
                    )
                : owner.Agent;
        using var membership = BeginAgentAdmission(owner.Agent, targetAgent);
        if (create && string.IsNullOrEmpty(agentName))
            throw new InvalidDataException("newAgentName is required when creating an Agent.");
        if (!create && string.IsNullOrEmpty(name))
            throw new InvalidDataException(
                "newSessionId is required when renaming or moving to an existing Agent."
            );
        var target =
            create ? targetAgent + "/" + (name ?? "main")
            : agentName is not null || owner.Agent != "main" || input.Contains('/')
                ? targetAgent + "/" + name
            : name!;
        SessionIdentityMoveJournal.SafeId(old);
        SessionIdentityMoveJournal.SafeId(input);
        SessionIdentityMoveJournal.SafeId(target);
        if (!create && !agents.Exists(targetAgent))
            throw new InvalidDataException("Destination Agent does not exist.");
        if (
            create
            && (agents.Exists(targetAgent) || Directory.Exists(agents.SourceDirectory(targetAgent)))
        )
            throw new InvalidDataException(
                "Destination Agent already exists or its directory is reserved."
            );
        if (
            owner.Agent != targetAgent
            && (Isolation(owner.Agent).Isolated || !create && Isolation(targetAgent).Isolated)
        )
            throw new InvalidDataException(
                "Isolated Agents cannot move sessions across Agent boundaries."
            );
        ValidateExecutionEnvironment(
            owner.Entry.Snapshot().AuthorityEnvelope,
            agents.SourceDirectory(targetAgent),
            Directory.GetCurrentDirectory()
        );
        var app = models.ConfigurationOwner?.AppConfiguration;
        if (
            SessionCatalog.Flag(
                app?["sessionWorkers"] is JsonObject workers
                    ? workers["enabled"]
                    : app?["sessionWorkers"]
            )
        )
            throw new NotSupportedException(
                "Session identity move is unavailable while Session-worker placement is enabled."
            );
        new SessionDeletionWorkerStore(root).Preflight([old]);
        string? parent = null;
        var parentProvided = args.ContainsKey("parentSessionId");
        if (parentProvided)
        {
            var raw = SessionGoal.Trim(OptionalString(args, "parentSessionId") ?? "");
            if (raw.Length == 0)
                throw new InvalidDataException(
                    "parentSessionId must be a nonempty existing Session ID."
                );
            parent = Catalog.ValidateIdentityParent(old, raw);
        }
        var previousParent = owner.Metadata().ParentSessionId;
        using var accepted = TrackCreation();
        await identityMoveGate.WaitAsync(token);
        IdentityMoveOperation? operation = null;
        JsonObject result;
        var targetCreation = CreationKey(target);
        var ownedAgentCreation = create
            ? CreationKey(SessionIdentity.Build(targetAgent, "main"))
            : null;
        var targetHeld = false;
        var agentHeld = false;
        try
        {
            if (
                ownedAgentCreation is not null
                && !ReferenceEquals(ownedAgentCreation, targetCreation)
            )
            {
                await ownedAgentCreation.WaitAsync(token);
                agentHeld = true;
            }
            await targetCreation.WaitAsync(token);
            targetHeld = true;
            if (IdentityJournal.Read() is not null)
                throw new InvalidOperationException(
                    "A pending identity move requires recovery before another move can start."
                );
            token.ThrowIfCancellationRequested();
            owner.Entry.RequireIdentityAuthority();
            if (owner.Id != old || !IsCurrentOwner(owner))
                throw new InvalidOperationException(
                    "Source identity changed. Retry using its current identity."
                );
            if (await IdReservedAsync(target))
                throw new InvalidDataException("Target Session ID is already reserved.");
            archiveIdentities.ValidateRename(old, target);
            deletionChannels.ValidateIdentityAuthority();
            var sourceRow = Catalog.Get(old)!;
            var aliases =
                (sourceRow["aliases"] as JsonArray)
                    ?.Select(SessionCatalog.Text)
                    .OfType<string>()
                    .ToArray()
                ?? [];
            var record = new SessionIdentityMoveRecord(
                "rolling-back",
                old,
                target,
                owner.Agent,
                aliases,
                create,
                create ? targetAgent : null,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            var children = Catalog
                .IdentityChildren(old)
                .Select(row => SessionCatalog.Text(row["id"])!)
                .ToArray();
            var claims = children
                .Concat([old, target])
                .Concat(parent is null ? [] : new[] { parent })
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            operation = new(owner, record, claims);
            lock (lifecycle)
            {
                RequireIdentityAction(claims);
                if (
                    !IsCurrentOwner(owner)
                    || identities.ContainsKey(target)
                    || claims.Any(id =>
                        deletionClaims.ContainsKey(id) || crossDeletes.ContainsKey(id)
                    )
                )
                    throw new InvalidOperationException(
                        "Identity move conflicts with another lifetime operation. Retry after it finishes."
                    );
                foreach (var id in claims)
                    identityMoveClaims[id] = operation;
            }
            mcp.InvalidateOwner(owner);
            var prior = owningIdentityMove.Value;
            owningIdentityMove.Value = operation;
            try
            {
                result = await ExecuteIdentityMoveAsync(operation, input, copy);
            }
            finally
            {
                owningIdentityMove.Value = prior;
            }
        }
        finally
        {
            if (operation is not null)
                lock (lifecycle)
                {
                    foreach (var id in operation.Claims)
                        if (identityMoveClaims.GetValueOrDefault(id) == operation)
                            identityMoveClaims.Remove(id);
                    operation.Finished.TrySetResult();
                }
            if (targetHeld)
                targetCreation.Release();
            if (agentHeld)
                ownedAgentCreation!.Release();
            identityMoveGate.Release();
        }
        return FinishMoveParent(owner, result, previousParent, parentProvided, parent);
    }

    private JsonObject FinishMoveParent(
        SessionOwner owner,
        JsonObject result,
        string? previousParent,
        bool parentProvided,
        string? parent
    )
    {
        result["previousParentSessionId"] = previousParent;
        result["parentSessionId"] = owner.Metadata().ParentSessionId;
        if (parentProvided)
        {
            result["requestedParentSessionId"] = parent;
            try
            {
                ChangePresentation(catalog => catalog.SetParent(owner.Id, parent));
            }
            catch (Exception error)
            {
                result["parentUpdateError"] = error.Message;
            }
            result["parentSessionId"] = owner.Metadata().ParentSessionId;
        }
        return result;
    }

    private async Task<JsonObject> ExecuteIdentityMoveAsync(
        IdentityMoveOperation operation,
        string input,
        bool copyMemory
    )
    {
        var owner = operation.Owner;
        var record = operation.Record;
        var aliases = record
            .OldAliases.Concat([record.OldId, input])
            .Where(id => id != record.NewId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var details = new JsonObject
        {
            ["oldSessionId"] = record.OldId,
            ["targetSessionId"] = record.NewId,
            ["targetAgent"] = record.TargetAgent,
            ["createdAgent"] = record.OwnsAgent,
            ["aliases"] = new JsonArray(
                aliases.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
            ),
            ["stage"] = "intent",
            ["identityCommitted"] = false,
        };
        var mutated = false;
        var vectorMoved = false;
        var committed = false;
        string[] children = [];
        unresolvedIdentityMove = record;
        try
        {
            IdentityJournal.Write(record);
            if (record.OwnsAgent)
            {
                await IdentityStageAsync(operation, "before-agent-copy");
                await agents.CreateAsync(record.OwnedAgent!);
                if (copyMemory)
                    agents.CopyIdentityMemory(record.OldAgent, record.OwnedAgent!);
                await IdentityStageAsync(operation, "after-agent-copy");
            }
            await owner.Entry.SaveLane.MutateIdentityAsync(async () =>
            {
                owner.Entry.RequireIdentityAuthority();
                await PrepareLegacyGoalBeforeIdentityAsync(owner);
                await IdentityStageAsync(operation, "before-mutation");
                mutated = true;
                details["stage"] = "paths";
                IdentityJournal.MoveArtifacts(record.OldId, record.NewId, record.Version);
                details["pathsMoved"] = true;
                details["stage"] = "archive";
                SqliteArchiveIdentityMove.Rename(ArchiveDatabase, record.OldId, record.NewId);
                details["archiveMoved"] = true;
                vectorMoved = true;
                await Vector.RenameAsync(record.OldId, record.NewId);
                RebindIdentityOwner(owner, record.NewId, record.TargetAgent);
                owner.Entry.WithState(state =>
                {
                    state.AuthorityEnvelope["aliases"] = new JsonArray(
                        aliases.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                    );
                    if (
                        SessionCatalog.Text(state.AuthorityEnvelope["parentSessionId"])
                        == record.OldId
                    )
                        state.AuthorityEnvelope["parentSessionId"] = record.NewId;
                });
                await IdentityStageAsync(operation, "before-target-persistence");
                details["stage"] = "target-authority";
                await owner.AuthorityStore.PersistIdentitySnapshotAsync(owner.Entry.Snapshot());
                details["targetAuthorityWritten"] = true;
                await IdentityStageAsync(operation, "after-target-persistence");
                details["stage"] = "catalog";
                children = Catalog.RewriteIdentity(
                    record.OldId,
                    record.NewId,
                    record.TargetAgent,
                    aliases
                );
                details["catalogMoved"] = true;
                deletionChannels.RewriteIdentity(record.OldId, record.NewId);
                details["channelsMoved"] = true;
                record = record with { Phase = "finishing" };
                operation.Record = record;
                IdentityJournal.Write(record);
                unresolvedIdentityMove = record;
                await IdentityStageAsync(operation, "before-alias-commit");
                details["stage"] = "alias";
                try
                {
                    await archiveIdentities.CommitRenameAsync(record.OldId, record.NewId);
                }
                catch (ArchiveIdentityCommittedException)
                {
                    committed = true;
                    throw;
                }
                committed = true;
                details["identityCommitted"] = true;
                await IdentityStageAsync(operation, "after-alias-commit");
                IdentityJournal.Clear();
                unresolvedIdentityMove = null;
            });
        }
        catch (Exception failure)
        {
            details["identityCommitted"] = committed;
            details["error"] = failure.Message;
            if (committed)
                throw new SessionIdentityMoveException(
                    "Identity move committed, but a later step failed.",
                    details,
                    failure
                );
            var errors = new List<Exception>();
            try
            {
                record = record with { Phase = "rolling-back" };
                IdentityJournal.Write(record);
                unresolvedIdentityMove = record;
            }
            catch (Exception error)
            {
                errors.Add(error);
            }
            if (errors.Count == 0 && mutated)
            {
                await owner.Entry.SaveLane.MutateIdentityAsync(async () =>
                {
                    async Task Attempt(Func<Task> action)
                    {
                        try
                        {
                            await action();
                        }
                        catch (Exception error)
                        {
                            errors.Add(error);
                        }
                    }
                    if (vectorMoved)
                        await Attempt(() => Vector.RenameAsync(record.NewId, record.OldId));
                    await Attempt(async () =>
                    {
                        await IdentityStageAsync(operation, "reverse-archive");
                        SqliteArchiveIdentityMove.Rename(
                            ArchiveDatabase,
                            record.NewId,
                            record.OldId
                        );
                    });
                    await Attempt(() =>
                    {
                        IdentityJournal.MoveArtifacts(record.NewId, record.OldId, record.Version);
                        return Task.CompletedTask;
                    });
                    await Attempt(() =>
                    {
                        RebindIdentityOwner(owner, record.OldId, record.OldAgent);
                        owner.Entry.WithState(state =>
                            state.AuthorityEnvelope["aliases"] = new JsonArray(
                                record
                                    .OldAliases.Select(id => (JsonNode?)JsonValue.Create(id))
                                    .ToArray()
                            )
                        );
                        return Task.CompletedTask;
                    });
                    await Attempt(() =>
                    {
                        if (Catalog.Get(record.NewId) is not null)
                            Catalog.RewriteIdentity(
                                record.NewId,
                                record.OldId,
                                record.OldAgent,
                                record.OldAliases
                            );
                        return Task.CompletedTask;
                    });
                    await Attempt(() =>
                    {
                        deletionChannels.RewriteIdentity(record.NewId, record.OldId);
                        return Task.CompletedTask;
                    });
                    await Attempt(() =>
                        owner.AuthorityStore.PersistIdentitySnapshotAsync(owner.Entry.Snapshot())
                    );
                    if (errors.Count > 0)
                        MarkIdentityUnavailable(operation, details, new AggregateException(errors));
                });
            }
            else if (mutated)
                MarkIdentityUnavailable(operation, details, new AggregateException(errors));
            if (errors.Count == 0)
            {
                try
                {
                    if (record.OwnsAgent)
                        await RemoveMoveOwnedAgentAsync(record);
                    IdentityJournal.Clear();
                    unresolvedIdentityMove = null;
                }
                catch (Exception error)
                {
                    errors.Add(error);
                }
            }
            if (errors.Count > 0)
            {
                lock (lifecycle)
                {
                    pendingIdentityReservations.Add(record.OldId);
                    pendingIdentityReservations.Add(record.NewId);
                }
                details["recoveryRequired"] = true;
                details["rollbackErrors"] = new JsonArray(
                    errors.Select(error => (JsonNode?)JsonValue.Create(error.Message)).ToArray()
                );
                if (mutated && !owner.Entry.IdentityAvailable)
                    throw new SessionIdentityMoveException(
                        "Identity move failed; this lifetime requires identity recovery before further writes or effects.",
                        details,
                        failure
                    );
                throw new SessionIdentityMoveException(
                    "Identity move failed; its cleanup remains pending.",
                    details,
                    failure
                );
            }
            lock (lifecycle)
                if (
                    identities.TryGetValue(record.NewId, out var attempted)
                    && attempted.Owner.Task.IsCompletedSuccessfully
                    && ReferenceEquals(attempted.Owner.Task.Result, owner)
                )
                    identities.Remove(record.NewId);
            details["rolledBack"] = true;
            throw new SessionIdentityMoveException(
                "Identity move failed and was rolled back.",
                details,
                failure
            );
        }
        details.Remove("stage");
        details["identityCommitted"] = true;
        details["updatedChildren"] = new JsonArray(
            children.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
        );
        try
        {
            Catalog.NotifyIdentityChanged();
            owner.PublishStateChanged();
        }
        catch (Exception error)
        {
            throw new SessionIdentityMoveException(
                "Identity move committed, but its notification failed.",
                details,
                error
            );
        }
        return details;
    }

    private void MarkIdentityUnavailable(
        IdentityMoveOperation operation,
        JsonObject details,
        Exception error
    )
    {
        details["recoveryRequired"] = true;
        var unavailable = new SessionIdentityUnavailableException(
            "Session authority is unavailable until pending identity recovery completes.",
            details,
            error
        );
        operation.Owner.AuthorityStore.MarkIdentityUnavailable(unavailable);
        operation.Owner.Entry.MarkIdentityUnavailable(unavailable);
    }
}
