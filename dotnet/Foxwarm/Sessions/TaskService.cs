using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class TaskService : IDisposable
{
    internal sealed record AttachedChildResult(
        SessionOwner Child,
        bool AssignmentDelivered,
        string? Warning,
        int SentNotifications
    );

    private sealed class NotificationReceipt
    {
        internal int Count;
    }

    private readonly TaskStore store;
    private readonly SessionManager manager;
    private readonly Func<string, Task<string?>> resolveSessionId;
    private readonly Func<string, Task<string?>> resolveSessionAgent;
    private readonly Func<string, Task<long?>> anchorSeq;
    private readonly SemaphoreSlim mutationLane = new(1, 1);

    internal TaskService(SessionManager manager, TaskStore store, Func<string, Task<string?>> resolveSessionId,
        Func<string, Task<long?>> anchorSeq, Func<string, Task<string?>> resolveSessionAgent)
    {
        this.manager = manager;
        this.store = store;
        this.resolveSessionId = resolveSessionId;
        this.resolveSessionAgent = resolveSessionAgent;
        this.anchorSeq = anchorSeq;
    }

    internal Task<(string? Owner, string? Creator)> ReferencesAsync(string taskId) => store.ReferencesAsync(taskId);

    internal string? OwnerSessionId(string taskId) => store.OwnerSessionId(taskId);

    internal string? CreatorSessionId(string taskId) => store.CreatorSessionId(taskId);

    internal long? OwnerAssignedAt(string taskId) => store.OwnerAssignedAt(taskId);

    internal async Task<JsonObject> ExecuteAsUserAsync(JsonObject args)
    {
        var normalized = (JsonObject)args.DeepClone();
        TaskStoreResult result;
        string? fullDescription;
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            await NormalizeOwnerAsync(normalized);
            result = await store.ExecuteAsUserAsync(normalized).ConfigureAwait(false);
            fullDescription = result.Assignment is null
                ? null
                : await store.ReadStoredDescriptionAsync(Text(result.Payload["task"]?["id"])!).ConfigureAwait(false);
        }
        finally
        {
            mutationLane.Release();
        }

        var warnings = new List<string>();
        var receipt = new NotificationReceipt();
        var taskId = Text(result.Payload["task"]?["id"]) ?? Text(normalized["taskId"]);
        if (result.Assignment is { } assignment && taskId is not null)
            await DeliverAssignmentAsync(
                result.Payload["task"]!.AsObject(),
                fullDescription,
                null,
                assignment,
                warnings,
                receipt
            );
        if (result.CommentOwner is { } commentOwner && taskId is not null)
        {
            try
            {
                var title = Text(result.Payload["task"]?["title"]) ?? taskId;
                await manager.SendTaskNotificationAsync(
                    null,
                    commentOwner,
                    $"Note on task {taskId} — {title}\n{Text(normalized["note"])}",
                    true,
                    taskId,
                    "note",
                    "note"
                );
                receipt.Count++;
            }
            catch
            {
                warnings.Add("Comment saved, but the owner notification could not be delivered.");
            }
        }
        if (warnings.Count > 0)
            result.Payload["warning"] = string.Join(" ", warnings);
        if (result.Assignment is not null || result.CommentOwner is not null)
            result.Payload["task"] = (await store.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = taskId! }, null))
                .Payload["task"]!.DeepClone();
        result.Payload["sentNotifications"] = receipt.Count;
        return result.Payload;
    }

    internal JsonObject Summaries(IReadOnlyList<string> ids) => store.Summaries(ids);

    internal IReadOnlyDictionary<string, string> Statuses(IReadOnlyList<string> ids) =>
        store.Statuses(ids);

    private static bool UsesAnchor(string? action) => action is "create" or "claim" or "assign" or "update";

    private async Task NormalizeOwnerAsync(JsonObject args)
    {
        if (args["ownerSessionId"] is JsonValue value && value.TryGetValue<string>(out var requested))
            args["ownerSessionId"] = await resolveSessionId(requested)
                ?? throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
    }

    internal async Task<TaskStoreResult> ExecuteAsync(
        JsonObject args,
        string? actor,
        int? httpLimit = null,
        long? anchor = null
    )
    {
        TaskStore.Validate(args, httpLimit);
        var action = Text(args["action"]);
        var read = action is "list" or "get";
        TaskStoreResult result;
        string? fullDescription;
        if (!read)
            await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            if (actor is null && action is not ("list" or "get"))
                actor = await store.DefaultActorAsync(args).ConfigureAwait(false);
            if (action is not ("list" or "get") && actor is null)
                throw new TaskError(
                    "TASK_SESSION_REQUIRED",
                    "Select an existing Session for this operation."
                );
            actor = actor is null ? null : await resolveSessionId(actor) ?? actor;
            var normalizedArgs = (JsonObject)args.DeepClone();
            if (action is "assign" or "create")
                await NormalizeOwnerAsync(normalizedArgs);
            var selectedAnchor = actor is not null && UsesAnchor(action) ? anchor ?? await anchorSeq(actor) : null;
            IReadOnlyList<string>? scopeIds = null;
            if (action == "list" && Text(args["scope"]) is string scope && scope != "all")
            {
                if (actor is null)
                    throw new TaskError(
                        "TASK_SESSION_REQUIRED",
                        "A current Session is required for this task list scope."
                    );
                var agent =
                    await resolveSessionAgent(actor)
                    ?? throw new TaskError(
                        "TASK_SESSION_NOT_FOUND",
                        "The current Session Agent could not be resolved for this task list scope.",
                        404
                    );
                scopeIds = scope is "current-session" or "owned"
                    ? new[] { actor }
                    : await manager.Catalog.QueryAsync(() => manager.Catalog.List()
                        .Where(row => Text(row["agent"]) == agent)
                        .Select(row => Text(row["id"])!)
                        .ToArray());
            }
            result = await store.ExecuteAsync(
                normalizedArgs,
                actor,
                httpLimit,
                selectedAnchor,
                scopeSessionIds: scopeIds
            ).ConfigureAwait(false);
            fullDescription = result.Assignment is null
                ? null
                : await store.ReadStoredDescriptionAsync(Text(result.Payload["task"]?["id"])!).ConfigureAwait(false);
        }
        finally
        {
            if (!read)
                mutationLane.Release();
        }
        var warnings = new List<string>();
        var receipt = new NotificationReceipt();
        var resultTaskId = Text(result.Payload["task"]?["id"]) ?? Text(args["taskId"]);
        if (result.Assignment is { } assignment)
        {
            if (resultTaskId is null)
                throw new InvalidDataException("Task assignment did not return a task ID.");
            await DeliverAssignmentAsync(
                result.Payload["task"]!.AsObject(),
                fullDescription,
                actor!,
                assignment,
                warnings,
                receipt
            );
        }
        if (result.CommentOwner is { } commentOwner && commentOwner != actor)
        {
            try
            {
                var title = Text(result.Payload["task"]?["title"]) ?? resultTaskId;
                await manager.SendTaskNotificationAsync(
                    actor,
                    commentOwner,
                    $"Note on task {resultTaskId} — {title}\n{Text(args["note"])}",
                    true,
                    resultTaskId!,
                    "note",
                    "note"
                );
                receipt.Count++;
            }
            catch
            {
                warnings.Add("Comment saved, but the owner notification could not be delivered.");
            }
        }
        if (result.Completed)
        {
            if (resultTaskId is null)
                throw new InvalidDataException("Task completion did not return a task ID.");
            await DeliverCompletionAsync(
                result.Payload["task"]!.AsObject(),
                actor!,
                warnings,
                receipt
            );
        }
        if (warnings.Count > 0)
            result.Payload["warning"] = string.Join(" ", warnings);
        if (result.Assignment is not null || result.Completed || result.CommentOwner is not null)
            result.Payload["task"] = (await store.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = resultTaskId! }, null))
                .Payload["task"]!.DeepClone();
        if (action is not ("list" or "get"))
            result.Payload["sentNotifications"] = receipt.Count;
        return result;
    }

    internal Task MigrateLegacyGoalAsync(string sessionId, string goal, long anchorSeq)
    {
        store.MigrateLegacyGoal(sessionId, goal, anchorSeq);
        return Task.CompletedTask;
    }

    internal JsonObject TaskContext(
        string sessionId,
        IReadOnlyList<long> sequences,
        bool consume
    ) => store.TaskContext(sessionId, sequences, consume);

    internal Task<AttachedChildResult> CreateAttachedChildAsync(
        string taskId,
        string sourceSessionId,
        Func<Task<SessionOwner>> create,
        string? additionalMessage = null
    ) => CreateAttachedChildAsync(taskId, sourceSessionId, create, () => additionalMessage);

    /// <param name="additionalMessage">Read after creation, so a creator can omit an instruction
    /// the new child already has in context.</param>
    internal async Task<AttachedChildResult> CreateAttachedChildAsync(
        string taskId,
        string sourceSessionId,
        Func<Task<SessionOwner>> create,
        Func<string?> additionalMessage
    )
    {
        var source = await resolveSessionId(sourceSessionId) ?? sourceSessionId;
        TaskStoreResult attached;
        string? fullDescription;
        SessionOwner child;
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            var task = (await store.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, source))
                .Payload["task"]!.AsObject();
            if (Text(task["status"]) is "completed" or "cancelled")
                throw new TaskError("TASK_TERMINAL", $"Task {taskId} is terminal.", 409);
            var owner = Text(task["ownerSessionId"]);
            var creator = Text(task["createdBySessionId"]);
            if (creator != source && owner != source)
                throw new TaskError(
                    "TASK_FORBIDDEN",
                    $"Session {source} cannot assign task {taskId} (creator or owner required).",
                    403
                );
            child = await create().ConfigureAwait(false);
            try
            {
                attached = await store.ExecuteAsync(
                    new JsonObject
                    {
                        ["action"] = "assign",
                        ["taskId"] = taskId,
                        ["ownerSessionId"] = child.Id,
                        ["notifySession"] = true,
                    },
                    source
                ).ConfigureAwait(false);
                await store.AttachChildAsync(taskId, child.Id);
                fullDescription = await store.ReadStoredDescriptionAsync(taskId).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException(
                    child.Id,
                    $"Child Session '{child.Id}' was committed but task attachment was not durable: {error.Message}",
                    error
                );
            }
        }
        finally
        {
            mutationLane.Release();
        }
        var warnings = new List<string>();
        var receipt = new NotificationReceipt();
        var assignment = attached.Assignment;
        if (assignment is null)
            return new AttachedChildResult(child, true, null, 0);
        var delivered = await DeliverAssignmentAsync(
            attached.Payload["task"]!.AsObject(),
            fullDescription,
            source,
            assignment,
            warnings,
            receipt,
            additionalMessage()
        );
        return new AttachedChildResult(
            child,
            delivered,
            warnings.Count == 0 ? null : string.Join(" ", warnings),
            receipt.Count
        );
    }

    private async Task<bool> DeliverAssignmentAsync(
        JsonObject task,
        string? fullDescription,
        string? actor,
        TaskAssignmentPlan plan,
        List<string> warnings,
        NotificationReceipt receipt,
        string? additionalMessage = null
    )
    {
        var taskId = Text(task["id"])!;
        var newOwnerDelivered = plan.NewOwner is null;
        if (plan.PreviousOwner is { } previous)
            await DeliverAsync(
                taskId,
                actor,
                previous,
                $"Task ownership {(plan.NewOwner is null ? "released" : $"transferred to {plan.NewOwner}")}: {Summary(task)}",
                false,
                "previousOwnerNotificationStatus",
                plan.Revision,
                warnings,
                receipt,
                "previous",
                plan.NewOwner is null ? "released" : "transferred"
            );
        if (plan.NewOwner is { } next)
            newOwnerDelivered = await DeliverAsync(
                taskId,
                actor,
                next,
                $"You have been assigned a task: {Summary(task, fullDescription: fullDescription)}{(additionalMessage is null ? "" : $"\n\nAdditional instruction:\n{additionalMessage}")}",
                true,
                "assignmentNotificationStatus",
                plan.Revision,
                warnings,
                receipt,
                "new",
                plan.PreviousOwner is null ? "assigned" : "transferred"
            );
        return newOwnerDelivered;
    }

    private async Task DeliverCompletionAsync(
        JsonObject task,
        string actor,
        List<string> warnings,
        NotificationReceipt receipt
    )
    {
        var taskId = Text(task["id"])!;
        var creator =
            Text(task["createdByKind"]) == "session" ? Text(task["createdBySessionId"]) : null;
        if (creator is null || await resolveSessionId(creator) == await resolveSessionId(actor))
        {
            await store.MarkNotificationAsync(taskId, "completionNotificationStatus", "skipped");
            return;
        }
        var usage = await OwnerUsageLineAsync(task);
        await DeliverAsync(
            taskId,
            actor,
            creator,
            $"Task completed: {Summary(task, includeResult: true)}{(usage is null ? "" : "\n" + usage)}",
            true,
            "completionNotificationStatus",
            null,
            warnings,
            receipt,
            "completion",
            "completed"
        );
    }

    // Best effort: a usage lookup failure must not block the completion notification.
    private async Task<string?> OwnerUsageLineAsync(JsonObject task)
    {
        try
        {
            var owner = Text(task["ownerSessionId"]);
            var taskId = Text(task["id"]);
            if (
                owner is null
                || taskId is null
                || await store.OwnerAssignedAtAsync(taskId) is not long assignedAt
                || task["completedAt"] is not JsonValue completed
                || !completed.TryGetValue<long>(out var completedAt)
            )
                return null;
            return await manager.TaskOwnerUsageLineAsync(owner, assignedAt, completedAt);
        }
        catch
        {
            return null;
        }
    }

    private async Task<bool> DeliverAsync(
        string taskId,
        string? actor,
        string target,
        string message,
        bool trigger,
        string field,
        long? revision,
        List<string> warnings,
        NotificationReceipt receipt,
        string recipient,
        string eventName
    )
    {
        var canonicalTarget = await resolveSessionId(target) ?? target;
        if (actor is not null && canonicalTarget == (await resolveSessionId(actor) ?? actor))
        {
            await store.MarkNotificationAsync(taskId, field, "skipped", revision);
            return true;
        }
        try
        {
            await manager.SendTaskNotificationAsync(
                actor,
                target,
                message,
                trigger,
                taskId,
                eventName,
                recipient
            );
            receipt.Count++;
            await store.MarkNotificationAsync(taskId, field, "sent", revision);
            if (recipient == "new")
                return true;
            return true;
        }
        catch
        {
            try
            {
                await store.MarkNotificationAsync(taskId, field, "failed", revision);
            }
            catch { }
            warnings.Add(
                recipient switch
                {
                    "new" =>
                        "Task assigned, but the new owner notification could not be delivered.",
                    "previous" =>
                        "Task assigned, but the previous owner notification could not be delivered.",
                    _ => "Task completed, but the completion notification could not be delivered.",
                }
            );
            return false;
        }
    }

    private static string Summary(
        JsonObject task,
        bool includeResult = false,
        string? fullDescription = null
    )
    {
        var taskId = Text(task["id"])!;
        var title = Text(task["title"]) ?? taskId;
        var status = Text(task["status"]) ?? "unknown";
        var body = includeResult
            ? Text(task["result"])
            : fullDescription ?? Text(task["description"]);
        var limit = fullDescription is not null || includeResult ? int.MaxValue : 1000;
        return $"{taskId} — {title}\nStatus: {status}{(string.IsNullOrEmpty(body) ? "" : $"\n{body[..Math.Min(limit, body.Length)]}")}";
    }

    internal async Task<JsonObject> ExecuteForWebUiAsync(
        JsonObject args,
        string? targetSessionId,
        int? limit = null
    )
    {
        var action = Text(args["action"]);
        if (action is "list" or "get")
        {
            var payload = (await ExecuteAsync(args, null, limit)).Payload;
            if (action == "list" && payload["tasks"] is JsonArray tasks)
                foreach (var item in tasks.OfType<JsonObject>())
                {
                    item["createdByAgent"] = await resolveSessionAgent(
                        Text(item["createdBySessionId"]) ?? ""
                    );
                    item["ownerAgent"] = item["ownerSessionId"] is null
                        ? null
                        : await resolveSessionAgent(Text(item["ownerSessionId"]) ?? "");
                }
            return payload;
        }
        var target = targetSessionId;
        if (target is null && action is not "create")
            target = await store.DefaultActorAsync(args).ConfigureAwait(false);
        if (target is null)
            throw new TaskError(
                "TASK_SESSION_REQUIRED",
                "Select an existing Session for this operation."
            );
        var canonical =
            await resolveSessionId(target)
            ?? throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
        var result = (await ExecuteAsync(args, canonical, limit)).Payload;
        result["sessionId"] = canonical;
        return result;
    }

    internal async Task<(
        JsonObject Payload,
        string? CompletionTarget
    )> ExecuteForToolWithReceiptAsync(SessionOwner source, JsonObject args)
    {
        var normalized = (JsonObject)args.DeepClone();
        if (Text(normalized["action"]) == "list" && !normalized.ContainsKey("scope"))
            normalized["scope"] = "current-session";
        var payload = (
            await ExecuteAsync(
                normalized,
                source.Id,
                anchor: UsesAnchor(Text(args["action"])) ? source.Entry.Snapshot().NextMessageSeq - 1 : null
            )
        ).Payload;
        var task = payload["task"] as JsonObject;
        var completionTarget =
            Text(args["action"]) == "complete"
            && task?["completionNotificationStatus"]?.GetValue<string>() == "sent"
                ? task["createdBySessionId"]?.GetValue<string>()
                : null;
        return (payload, completionTarget);
    }

    internal async Task<JsonObject> ExecuteForToolAsync(SessionOwner source, JsonObject args) =>
        (await ExecuteForToolWithReceiptAsync(source, args)).Payload;

    public void Dispose() => store.Dispose();

    private static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
