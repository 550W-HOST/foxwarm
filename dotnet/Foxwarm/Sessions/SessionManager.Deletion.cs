using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> DeleteAsync(
        string requested,
        bool recursive = false,
        SessionOwner? source = null
    )
    {
        if (string.IsNullOrWhiteSpace(requested))
            throw new SessionDeletionException(
                "Session ID is required.",
                "SESSION_DELETE_INVALID",
                400
            );
        if (source is not null)
        {
            if (!IsCurrentOwner(source))
                throw new SessionDeletionException(
                    "Deletion needs a current source Session.",
                    "SESSION_DELETE_SOURCE_NOT_FOUND",
                    404
                );
        }
        DeleteOperation? operation;
        bool continuing;
        lock (lifecycle)
        {
            partialDeletes.TryGetValue(requested, out operation);
            continuing = operation is not null;
        }
        if (operation is not null)
        {
            bool exactPending;
            lock (lifecycle)
                exactPending =
                    requested != operation.Selection.Root && identities.ContainsKey(requested);
            var canonical = SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"]);
            if (exactPending || canonical is not null && canonical != operation.Selection.Root)
                throw new SessionDeletionException(
                    "The requested identifier now belongs to another Session. Retry the original deletion using its canonical ID.",
                    "SESSION_DELETE_RETRY_MISMATCH",
                    409,
                    new JsonObject
                    {
                        ["requestedSessionId"] = requested,
                        ["currentSessionId"] = exactPending ? requested : canonical,
                        ["retrySessionId"] = operation.Selection.Root,
                    }
                );
        }
        if (operation is null)
        {
            if (SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"]) is null)
                return new JsonObject
                {
                    ["status"] = "not-found",
                    ["requestedSessionId"] = requested,
                };
            var selection = Catalog.SelectDeletion(requested, recursive);
            if (source is not null && selection.Targets.Contains(source.Id, StringComparer.Ordinal))
                throw new SessionDeletionException(
                    "Cannot delete current session. Use /clear to clear history or switch to another session first.",
                    "SESSION_DELETE_CURRENT",
                    400
                );
            operation = new(selection, recursive, requested, source);
        }
        else if (
            !ReferenceEquals(operation.SourceOwner, source)
            || operation.Recursive != recursive
        )
            throw new SessionDeletionException(
                "Retry must use the original deletion source and recursive selection.",
                "SESSION_DELETE_RETRY_MISMATCH"
            );
        lock (lifecycle)
        {
            RequireIdentityAction(
                RemainingDeleteClaims(operation)
                    .Concat(operation.SourceOwner is null ? [] : new[] { operation.SourceOwner.Id })
            );
            if (operation.Running)
                throw new SessionDeletionException(
                    "This deletion is already running.",
                    "SESSION_DELETE_CONFLICT"
                );
            var involved = operation.SourceOwner is null
                ? []
                : operation
                    .Selection.Targets.Except(operation.Deleted, StringComparer.Ordinal)
                    .Append(operation.SourceOwner.Id)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
            if (involved.Any(crossDeletes.ContainsKey))
                throw new SessionDeletionException(
                    "Another deletion involving the source or target is in progress. Retry after it finishes.",
                    "SESSION_DELETE_CONFLICT"
                );
            foreach (var id in involved)
                crossDeletes[id] = operation;
            operation.Finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
            operation.Running = true;
            deletionOperations.Add(operation);
        }
        var attachments = deletionChannels;
        var workers = new SessionDeletionWorkerStore(root);
        try
        {
            await ClaimDeleteAsync(operation);
            AssertDeleteSource(operation);
            if (!continuing)
            {
                RequireSameSelection(operation);
                var blockers = attachments.Blockers(
                    attachments.Read(operation.Selection.Root),
                    operation.Selection.Targets
                );
                if (blockers.Count > 0)
                    throw new SessionDeletionException(
                        "Cannot delete sessions with non-WebUI channels attached. Detach them and retry.",
                        "SESSION_DELETE_CHANNEL_BLOCKED",
                        409,
                        new JsonObject
                        {
                            ["includeDescendants"] = recursive,
                            ["blockingChannels"] = blockers,
                            ["blockingSessionIds"] = DeleteIds(
                                blockers
                                    .Select(row => SessionCatalog.Text(row!["sessionId"])!)
                                    .Distinct()
                            ),
                        }
                    );
                workers.Preflight(operation.Selection.Targets);
                foreach (var id in operation.Selection.Targets)
                {
                    operation.Owners[id] =
                        await GetExistingAsync(id, forDeletion: true)
                        ?? throw new InvalidDataException(
                            "Deletion target membership disappeared."
                        );
                    var snapshot = operation.Owners[id].Entry.Snapshot();
                    ValidateExecutionEnvironment(
                        snapshot.AuthorityEnvelope,
                        agents.AgentDirectory(operation.Owners[id].Agent),
                        Directory.GetCurrentDirectory()
                    );
                }
                await DeleteStageAsync(operation, "prepare", operation.Selection.Root);
                var busy = new List<string>();
                var dropped = 0;
                var aborted = 0;
                foreach (var id in operation.Selection.Targets)
                {
                    AssertDeleteSource(operation);
                    var owner = operation.Owners[id];
                    var captured = owner.Entry.WithState(state => state.Queue.ToArray());
                    var wasBusy = owner.Metadata().Busy || owner.Processing;
                    if (captured.Length > 0)
                    {
                        await owner.Entry.SaveLane.DropCapturedQueueAsync(captured);
                        dropped += captured.Length;
                    }
                    if (wasBusy)
                    {
                        busy.Add(id);
                        var stopped = await owner.Registry.Control.StopAsync(id);
                        if (stopped.AbortedInFlight)
                            aborted++;
                    }
                }
                if (busy.Count > 0)
                    return new JsonObject
                    {
                        ["status"] = "busy",
                        ["includeDescendants"] = recursive,
                        ["busySessionIds"] = DeleteIds(busy),
                        ["droppedQueueItems"] = dropped,
                        ["abortedInFlightCount"] = aborted,
                        ["message"] =
                            "Stop signals sent to busy targets. Retry deletion after they become idle.",
                    };
                await DeleteStageAsync(operation, "revalidate", operation.Selection.Root);
                RequireSameSelection(operation);
                if (
                    attachments
                        .Blockers(
                            attachments.Read(operation.Selection.Root),
                            operation.Selection.Targets
                        )
                        .Count > 0
                    || operation.Owners.Values.Any(owner =>
                        owner.Metadata().Busy
                        || owner.Processing
                        || owner.Entry.WithState(state => state.Queue.Count > 0)
                    )
                )
                    throw new SessionDeletionException(
                        "Deletion selection became active or channel-blocked. Retry.",
                        "SESSION_DELETE_STATE_CHANGED"
                    );
                workers.Preflight(operation.Selection.Targets);
            }
            // Same-host continuation never resolves the old alias or chooses a new graph/owner.
            foreach (var (id, owner) in operation.Owners)
            {
                lock (lifecycle)
                    if (
                        !operation.Deleted.Contains(id)
                        && (
                            !sessions.TryGetValue(id, out var actual)
                            || !ReferenceEquals(actual, owner)
                        )
                    )
                        throw new InvalidOperationException(
                            "The original deletion lifetime is no longer current."
                        );
            }
            if (!operation.Recursive)
            {
                foreach (
                    var id in operation.Selection.Direct.Where(id =>
                        !operation.Detached.Contains(id)
                    )
                )
                {
                    AssertDeleteSource(operation);
                    await DeleteStageAsync(operation, "detach", id);
                    if (Catalog.Get(id) is null)
                        throw new InvalidDataException("A selected surviving child disappeared.");
                    var previous = catalogDeleteOwner.Value;
                    catalogDeleteOwner.Value = operation;
                    try
                    {
                        try
                        {
                            ChangePresentation(catalog => catalog.SetParent(id, null));
                        }
                        catch (PresentationCommittedException)
                        {
                            operation.Detached.Add(id);
                            throw;
                        }
                        operation.Detached.Add(id);
                    }
                    finally
                    {
                        catalogDeleteOwner.Value = previous;
                    }
                }
            }
            foreach (
                var id in operation.Selection.Post.Where(id => !operation.Deleted.Contains(id))
            )
            {
                AssertDeleteSource(operation);
                var owner = operation.Owners[id];
                if (!operation.Retired.Contains(id))
                {
                    await DeleteStageAsync(operation, "retire", id);
                    lock (lifecycle)
                        identities[id].Retiring = true;
                    operation.RetirementStarted.Add(id);
                    mcp.InvalidateOwner(owner);
                    await owner.Compactor.StopAsync();
                    await owner.DrainForegroundAsync();
                    await waitTimeouts.RetireAsync(id);
                    await waitLiveness.RetireAsync(id);
                    await owner.Entry.SaveLane.RetireAsync(owner.AuthorityStore.Retire);
                    lock (lifecycle)
                        identities[id].Retired = true;
                    operation.Retired.Add(id);
                }
                if (!operation.TrackingCleaned.Contains(id))
                {
                    await DeleteStageAsync(operation, "tracking", id);
                    await executor.RetireSessionAsync(id);
                    operation.TrackingCleaned.Add(id);
                }
                if (!operation.JsonDurable.Contains(id))
                {
                    await DeleteStageAsync(operation, "json-unlink", id);
                    UnlinkActive(
                        owner.AuthorityStore.AuthorityPath,
                        () => operation.JsonRemoved.Add(id)
                    );
                    operation.JsonDurable.Add(id);
                }
                if (!operation.FrontierDurable.Contains(id))
                {
                    await DeleteStageAsync(operation, "frontier-unlink", id);
                    UnlinkActive(
                        Path.Combine(root, "state", "sessions", id + ".frontier.json"),
                        () => operation.FrontierRemoved.Add(id)
                    );
                    operation.FrontierDurable.Add(id);
                }
                if (!operation.ChannelsCleaned.Contains(id))
                {
                    await DeleteStageAsync(operation, "channels", id);
                    attachments.Detach(id);
                    operation.ChannelsCleaned.Add(id);
                }
                if (!operation.WorkersCleaned.Contains(id))
                {
                    await DeleteStageAsync(operation, "worker", id);
                    if (workers.CleanupInactive(id))
                        operation.WorkerRowsRemoved.Add(id);
                    operation.WorkersCleaned.Add(id);
                }
                await DeleteStageAsync(operation, "catalog", id);
                try
                {
                    Catalog.RemoveForDeletion(id);
                }
                catch
                {
                    if (Catalog.Get(id) is null)
                        CompleteDeletedOwner(operation, id, owner);
                    throw;
                }
                CompleteDeletedOwner(operation, id, owner);
            }
            lock (lifecycle)
                foreach (
                    var key in partialDeletes
                        .Where(pair => pair.Value == operation)
                        .Select(pair => pair.Key)
                        .ToArray()
                )
                    partialDeletes.Remove(key);
            var result = DeleteProgress(operation);
            result["status"] = "deleted";
            result["success"] = true;
            result["deletedCount"] = operation.Deleted.Count;
            if (continuing)
                result["continuedSameHost"] = true;
            return result;
        }
        catch (Exception error)
        {
            if (
                operation.RetirementStarted.Count == 0
                && operation.Detached.Count == 0
                && operation.Deleted.Count == 0
            )
                throw;
            var remaining = RemainingDeleteClaims(operation).Length > 0;
            lock (lifecycle)
            {
                if (remaining)
                {
                    partialDeletes[operation.Requested] = operation;
                    partialDeletes[operation.Selection.Root] = operation;
                }
                else
                    foreach (
                        var key in partialDeletes
                            .Where(pair => pair.Value == operation)
                            .Select(pair => pair.Key)
                            .ToArray()
                    )
                        partialDeletes.Remove(key);
            }
            var details = DeleteProgress(operation);
            details["failedStage"] = operation.Stage;
            details["failedSessionId"] = operation.FailedId;
            details["retryScope"] = remaining
                ? "Same host, original source, exact selected lifetimes and remaining cleanup only. Remaining targets and not-yet-detached survivors stay claimed until retry finishes. Restart does not resume this operation."
                : "No cleanup remains. All selected records were deleted. A later request starts a new deletion.";
            throw new SessionDeletionException(
                error.Message,
                operation.Stage == "detach"
                    ? "SESSION_DELETE_DETACH_PARTIAL"
                    : "SESSION_TREE_DELETE_PARTIAL",
                500,
                details
            );
        }
        finally
        {
            ReleaseDelete(operation);
        }
    }

    private static string DeleteToolText(string requested, JsonObject result)
    {
        if (SessionCatalog.Text(result["status"]) == "not-found")
            return $"Session `{requested}` not found.";
        if (SessionCatalog.Text(result["status"]) == "busy")
            return $"Stop signal sent to busy session `{requested}`. "
                + (
                    SessionWait.Number(result["abortedInFlightCount"]) > 0
                        ? "The in-flight LLM request was aborted."
                        : "It will stop after the current tool call completes."
                )
                + (
                    SessionWait.Number(result["droppedQueueItems"]) > 0
                        ? $" Cleared {result["droppedQueueItems"]} queued item(s)."
                        : ""
                )
                + " Retry delete after the session becomes idle.";
        return $"Session `{result["deletedSessionIds"]![0]}` deleted successfully.";
    }

    private static JsonArray DeleteIds(IEnumerable<string> ids) =>
        new(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());

    private static JsonObject DeleteProgress(DeleteOperation operation) =>
        new()
        {
            ["includeDescendants"] = operation.Recursive,
            ["deletedSessionIds"] = DeleteIds(operation.Deleted),
            ["detachedChildSessionIds"] = DeleteIds(operation.Detached),
            ["remainingSessionIds"] = DeleteIds(
                operation.Selection.Post.Where(id => !operation.Deleted.Contains(id))
            ),
            ["retiredSessionIds"] = DeleteIds(operation.Retired),
            ["stillClaimedSessionIds"] = DeleteIds(RemainingDeleteClaims(operation)),
            ["retirementStartedSessionIds"] = DeleteIds(operation.RetirementStarted),
            ["authorityRemovedSessionIds"] = DeleteIds(operation.JsonRemoved),
            ["workerRowsRemovedSessionIds"] = DeleteIds(operation.WorkerRowsRemoved),
        };

    private void RequireSameSelection(DeleteOperation operation)
    {
        var current = Catalog.SelectDeletion(operation.Selection.Root, operation.Recursive);
        if (
            !current.Targets.SequenceEqual(operation.Selection.Targets)
            || !current.Direct.SequenceEqual(operation.Selection.Direct)
            || !current.Post.SequenceEqual(operation.Selection.Post)
        )
            throw new SessionDeletionException(
                "The canonical session tree changed while preparing deletion. Retry.",
                "SESSION_DELETE_TREE_CHANGED"
            );
    }

    private static void UnlinkActive(string path, Action removed)
    {
        File.Delete(path);
        removed();
        if (Directory.Exists(Path.GetDirectoryName(path)))
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(path)!);
    }

    private void CompleteDeletedOwner(DeleteOperation operation, string id, SessionOwner owner)
    {
        operation.Deleted.Add(id);
        lock (lifecycle)
        {
            if (sessions.TryGetValue(id, out var current) && ReferenceEquals(current, owner))
                sessions.TryRemove(id, out _);
            identities.Remove(id);
        }
        lock (presentationGate)
            if (localVisible.Remove(id))
                volatileSequence++;
        owner.NotifyDeleted();
        Changed?.Invoke(new(id, SessionEventKind.Deleted, null));
        waitLiveness.Transition(id);
        TopologyChanged?.Invoke();
    }
}
