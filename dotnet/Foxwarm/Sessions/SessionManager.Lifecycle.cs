using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record ClearHistoryResult(
    bool Cleared,
    bool RequiresRetry,
    bool AbortedInFlight,
    int DroppedQueueItems = 0
);

internal sealed partial class SessionManager
{
    public async Task<ClearHistoryResult> ClearAsync(SessionOwner owner)
    {
        if (!Accepting)
            throw new InvalidOperationException("Host is shutting down.");
        using var mutation = BeginOwnerMutation(owner);
        if (!owner.Entry.TryBeginHistoryMutation(out var busy, out var captured))
            throw new InvalidOperationException("Session history change is already in progress.");
        try
        {
            if (busy)
            {
                await owner.Entry.SaveLane.DropCapturedQueueAsync(captured);
                var stop = await owner.Registry.Control.StopAsync(owner.Id);
                return new(false, true, stop.AbortedInFlight, captured.Length);
            }
            await owner.Compactor.StopAsync();
            await owner.Entry.SaveLane.ClearHistoryAsync(
                captured,
                owner.Archive.EffectiveBlockHighWater
            );
            return new(true, false, false);
        }
        finally
        {
            owner.Entry.EndHistoryMutation(!busy);
            if (
                Accepting
                && !owner.Entry.WithState(state => state.Busy || state.Stopping)
                && owner.Registry.HasRunnableWork(owner.Entry)
            )
                _ = owner.StartProcessing();
        }
    }

    public async Task<SessionOwner> ForkAsync(
        SessionOwner parent,
        string? suffix = null,
        bool childMode = false
    )
    {
        ClaudeRuntimeState.RequireFoxwarm(parent, "Fork");
        suffix ??= "fork";
        ValidateForkSuffix(suffix);
        using var operation = TrackCreation();
        using var mutation = BeginOwnerMutation(parent);
        var gate = CreationKey(
            childMode && parent.Id.Split('/').Last() == "main"
                ? SessionIdentity.Build(parent.Agent, suffix)
                : parent.Id + "_" + suffix
        );
        await gate.WaitAsync();
        try
        {
            return (
                await ForkLockedAsync(parent, suffix, childMode, null, null, userInitiated: true)
            ).Owner;
        }
        finally
        {
            gate.Release();
        }
    }

    private static void ValidateForkSuffix(string suffix)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(suffix, "^[a-zA-Z0-9_-]+$"))
            throw new InvalidDataException(
                "Fork suffix must use only letters, numbers, hyphens and underscores."
            );
    }

    /// <summary>
    /// Creates a fork. For a model-created fork, <paramref name="creatorCallId"/> names the
    /// creating tool call in the copied tail; when that call is present the child receives its
    /// own result for it and can read the call's instruction directly (CallVisible).
    /// </summary>
    private async Task<(SessionOwner Owner, bool CallVisible)> ForkLockedAsync(
        SessionOwner parent,
        string suffix,
        bool childMode,
        string? displayName,
        JsonObject? forceModel,
        string? taskId = null,
        bool userInitiated = false,
        string? initialNode = null,
        string? creatorCallId = null,
        bool instructed = false
    )
    {
        ClaudeRuntimeState.RequireFoxwarm(parent, "Fork");
        using var membership = BeginAgentAdmission(parent.Agent);
        if (!Accepting)
            throw new InvalidOperationException("Host is shutting down.");
        var original = await parent.Entry.SaveLane.CaptureForkAsync(
            parent.Archive.EffectiveBlockHighWater
        );
        var baseId =
            childMode && parent.Id.Split('/').Last() == "main"
                ? SessionIdentity.Build(parent.Agent, suffix)
                : parent.Id + "_" + suffix;
        ValidateNewSessionName(baseId.Split('/').Last());
        var id = baseId;
        for (var serial = 2; await IdReservedAsync(id); serial++)
            id = baseId + "_" + serial.ToString(CultureInfo.InvariantCulture);
        var tailCalls =
            original.History.LastOrDefault()?.ToJson() is JsonObject tail
            && SessionWait.Text(tail["role"]) == "model"
                ? (tail["parts"] as JsonArray ?? [])
                    .OfType<JsonObject>()
                    .Select(part => part["functionCall"])
                    .OfType<JsonObject>()
                    .ToArray()
                : [];
        var creator =
            childMode && !userInitiated && !string.IsNullOrEmpty(creatorCallId)
                ? Array.FindIndex(tailCalls, call => SessionWait.Text(call["id"]) == creatorCallId)
                : -1;
        var callVisible = creator >= 0;
        var created = await WithCreationIdentityAsync(
            id,
            async () =>
            {
                var inherited = (
                    SessionWait.Text(original.AuthorityEnvelope["childModelDefault"])
                        ?? SessionWait.Text(original.AuthorityEnvelope["model"]),
                    SessionWait.Text(original.AuthorityEnvelope["childEffortDefault"])
                        ?? SessionWait.Text(original.AuthorityEnvelope["effort"])
                );
                var settings = ValidateModelSettings(inherited, forceModel);
                var envelope = new JsonObject
                {
                    ["agent"] = parent.Agent,
                    ["parentSessionId"] = parent.Id,
                    ["promptCacheKey"] = original.AuthorityEnvelope["promptCacheKey"]?.DeepClone(),
                    ["persistentMemorySnapshot"] = original
                        .AuthorityEnvelope["persistentMemorySnapshot"]
                        ?.DeepClone(),
                    ["nextBlockId"] = original.AuthorityEnvelope["nextBlockId"]?.DeepClone(),
                };
                foreach (var field in new[] { "systemPromptFiles", "verbose", "currentNode" })
                    if (original.AuthorityEnvelope.ContainsKey(field))
                        envelope[field] = original.AuthorityEnvelope[field]?.DeepClone();
                var selectedNode =
                    BoundNode(parent.Agent) ?? initialNode ?? agents.DefaultNode(parent.Agent);
                if (selectedNode is not null)
                {
                    envelope["currentNode"] = selectedNode;
                }
                if (
                    agents.DefaultCwdFor(parent.Agent, SessionWait.Text(envelope["currentNode"])) is
                    { } defaultCwd
                )
                    envelope["cwd"] = defaultCwd;
                if (displayName is not null)
                    envelope["displayName"] = displayName;
                // The child reads its instruction from the copied call instead of a delivered
                // parent message, so record the report boundary that delivery would have set.
                if (callVisible && instructed && taskId is null)
                    envelope["childHandoffState"] = new JsonObject
                    {
                        ["boundary"] = "report-required",
                        ["resolved"] = false,
                    };
                if (settings.Model is not null)
                    envelope["model"] = settings.Model;
                if (settings.Effort is not null)
                    envelope["effort"] = settings.Effort;
                var meta = new JsonObject
                {
                    ["lastMessageTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["messageCount"] = original.History.Count,
                };
                var copied = new SessionSnapshot(
                    id,
                    original.History,
                    [],
                    false,
                    null,
                    false,
                    meta,
                    original.NextMessageSeq,
                    0,
                    envelope
                );
                var store = MakeStore(id, parent.Agent);
                var owner = MakeSession(id, parent.Agent, store);
                owner.Registry.Add(id, copied);
                BindMutations(owner);
                var branch = store.Archive.EnsureBranch(
                    parent.Id,
                    Math.Max(0, original.NextMessageSeq - 1),
                    Math.Max(0, (CompactCandidateBuilder.Number(envelope["nextBlockId"]) ?? 1) - 1)
                );
                var committed = false;
                try
                {
                    try
                    {
                        await Vector.ForkAsync(id);
                    }
                    catch
                    {
                        VectorDiagnostic("VECTOR_FORK_BASELINE_FAILED", id);
                    }
                    var suffixRows = new List<JsonObject>();
                    if (tailCalls.Length > 0)
                        suffixRows.Add(
                            new JsonObject
                            {
                                ["role"] = "tool",
                                ["parts"] = new JsonArray(
                                    tailCalls
                                        .Select(
                                            (call, index) =>
                                                (JsonNode)
                                                    new JsonObject
                                                    {
                                                        ["functionResponse"] = new JsonObject
                                                        {
                                                            ["tool_use_id"] = call["id"]
                                                                ?.DeepClone(),
                                                            ["name"] = call["name"]?.DeepClone(),
                                                            ["response"] = new JsonObject
                                                            {
                                                                ["output"] =
                                                                    index == creator
                                                                        ? SessionBoundary.ForkChildResult(
                                                                            parent.Id,
                                                                            id,
                                                                            taskId,
                                                                            instructed
                                                                        )
                                                                        : SessionBoundary.ForkSkippedCall(
                                                                            parent.Id
                                                                        ),
                                                            },
                                                        },
                                                    }
                                        )
                                        .ToArray()
                                ),
                            }
                        );
                    suffixRows.Add(
                        SystemRow(
                            SessionBoundary.Identity(
                                parent.Id,
                                id,
                                inherited: true,
                                (
                                    ResolveExecutionNode(envelope, BoundNode(parent.Agent)),
                                    SessionWait.Text(envelope["cwd"])
                                )
                            )
                        )
                    );
                    suffixRows.Add(
                        SystemRow(
                            userInitiated || !childMode
                                ? $"This session was manually forked by the user from session `{parent.Id}`. Your current session ID is `{id}`. The parent relationship records the source of the inherited context; it does not itself assign work or require a completion report. Follow the user's instructions in this session."
                                : $"You are a child session forked from parent session `{parent.Id}`. Your current session ID is `{id}`. "
                                    + SessionBoundary.Completion(
                                        parent.Id,
                                        HandoffConfirmationEnabled,
                                        taskId
                                    )
                        )
                    );
                    await AppendOwnedRowsAsync(owner, suffixRows);
                    committed = true;
                    await PublishCreatedAsync(owner);
                    return owner;
                }
                catch (AuthorityCommittedException error)
                {
                    committed = true;
                    await PublishCreatedAsync(owner);
                    throw new CommittedSessionCreationException(
                        id,
                        $"Forked Session '{id}' was committed but a later durability step failed.",
                        error
                    );
                }
                catch (Exception error)
                {
                    if (committed || ReferenceEquals(Find(id), owner))
                        throw new CommittedSessionCreationException(
                            id,
                            $"Forked Session '{id}' was committed but publication failed.",
                            error
                        );
                    try
                    {
                        await CompensateCreatedBranchAsync(store, branch);
                    }
                    catch (Exception cleanup)
                    {
                        throw new AggregateException(
                            "Fork creation failed and owned branch compensation also failed.",
                            error,
                            cleanup
                        );
                    }
                    throw;
                }
            }
        );
        return (created, callVisible);
    }

    private async Task CompensateCreatedBranchAsync(
        PersistentSessionAuthorityStore store,
        ArchiveBranch? branch
    )
    {
        try
        {
            await Vector.ResetAsync(store.SessionId);
        }
        catch
        {
            VectorDiagnostic("VECTOR_DERIVED_RESET_FAILED", store.SessionId);
        }
        store.Archive.RollbackInsertedBranch(branch);
    }

    /// <summary>
    /// Creates a fresh Session under an existing canonical parent for a direct user request.
    /// It copies no history, starts no turn and records only its opening boundary.
    /// </summary>
    public async Task<SessionOwner> CreateUserChildAsync(
        string agentName,
        string? sessionName,
        string parentSessionId,
        string runtime = "foxwarm"
    )
    {
        var child = await CreateNamedAsync(
            agentName,
            sessionName,
            null,
            null,
            parentSessionId: parentSessionId,
            runtime: runtime
        );
        try
        {
            await AppendOwnedRowsAsync(
                child,
                [
                    SystemRow(
                        SessionBoundary.UserChildCreated(
                            parentSessionId,
                            child.Id,
                            ExecutionPlacement(child)
                        )
                    ),
                    SystemRow(SessionBoundary.UserChildNotice(parentSessionId)),
                ]
            );
        }
        catch (Exception error)
        {
            throw new CommittedSessionCreationException(
                child.Id,
                $"Child Session '{child.Id}' was committed but its boundary message failed: {error.Message}",
                error
            );
        }
        return child;
    }

    private static JsonObject SystemRow(string text) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["system"] = text }),
        };

    private static async Task AppendOwnedRowsAsync(
        SessionOwner owner,
        IReadOnlyList<JsonObject> supplied
    )
    {
        await owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
        {
            var next = state.NextMessageSeq;
            var rows = supplied
                .Select(row =>
                {
                    var copy = (JsonObject)row.DeepClone();
                    copy["__meta"] = new JsonObject
                    {
                        ["seq"] = next++,
                        ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    };
                    InputWrapperMetadata.StampSequence(copy);
                    return copy;
                })
                .ToArray();
            var snapshot = state.Snapshot();
            var meta = (JsonObject)snapshot.Meta.DeepClone();
            meta["messageCount"] = snapshot.History.Count + rows.Length;
            return new CanonicalAppendPreparation(
                snapshot with
                {
                    History = snapshot.History.AppendJson(rows),
                    Meta = meta,
                    NextMessageSeq = next,
                },
                rows,
                live =>
                {
                    live.History.AddRange(rows.Select(row => (JsonObject)row.DeepClone()));
                    live.NextMessageSeq = next;
                    live.Meta["messageCount"] = live.History.Count;
                }
            );
        });
        owner.Entry.InvokeCommitted(owner.Entry.Snapshot());
    }

    public async Task NotifyManualForkAsync(
        SessionOwner parent,
        SessionOwner child,
        string? initialMessage
    )
    {
        var text = SessionBoundary.ManualForkNotice(parent.Id, child.Id, initialMessage);
        if (parent.Entry.Snapshot().Busy)
            await parent.Registry.Ingress.EnqueueAsync(
                parent.Id,
                new QueueItem(QueueItemType.User, [new JsonObject { ["system"] = text }])
            );
        else
            await AppendOwnedRowsAsync(parent, [SystemRow(text)]);
    }
}
