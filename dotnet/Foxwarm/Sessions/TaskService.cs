using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class TaskService : IDisposable
{
    internal sealed record AttachedChildResult(
        SessionOwner Child,
        bool AssignmentDelivered,
        string? Warning
    );

    private readonly TaskStore store;
    private readonly SessionManager manager;
    private readonly Func<string, string?> resolveSessionId;
    private readonly Func<string, string?> resolveSessionAgent;
    private readonly Func<string, long?> anchorSeq;
    private readonly SemaphoreSlim mutationLane = new(1, 1);

    internal TaskService(
        SessionManager manager,
        string root,
        Func<string, string?> resolveSessionId,
        Func<string, IReadOnlyList<string>> aliases,
        Func<string, long?> anchorSeq,
        Func<string, string?> resolveSessionAgent
    )
    {
        this.manager = manager;
        this.resolveSessionId = resolveSessionId;
        this.resolveSessionAgent = resolveSessionAgent;
        this.anchorSeq = anchorSeq;
        store = new TaskStore(root, resolveSessionId, aliases);
    }

    internal async Task<TaskStoreResult> ExecuteAsync(
        JsonObject args,
        string? actor,
        int? httpLimit = null,
        long? anchor = null
    )
    {
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            return await ExecuteCoreAsync(args, actor, httpLimit, anchor).ConfigureAwait(false);
        }
        finally
        {
            mutationLane.Release();
        }
    }

    internal async Task<JsonObject> ExecuteAsUserAsync(JsonObject args)
    {
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            var normalized = (JsonObject)args.DeepClone();
            if (
                normalized["ownerSessionId"] is JsonValue owner
                && owner.TryGetValue<string>(out var requested)
                && resolveSessionId(requested) is not { } canonical
            )
                throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
            if (
                normalized["ownerSessionId"] is JsonValue ownerValue
                && ownerValue.TryGetValue<string>(out var ownerId)
            )
                normalized["ownerSessionId"] = resolveSessionId(ownerId) ?? ownerId;
            var result = store.ExecuteAsUser(normalized);
            var warnings = new List<string>();
            var taskId = Text(result.Payload["task"]?["id"]) ?? Text(normalized["taskId"]);
            if (result.Assignment is { } assignment && taskId is not null)
                await DeliverAssignmentAsync(taskId, null, assignment, warnings);
            if (result.CommentOwner is { } commentOwner && taskId is not null)
            {
                try
                {
                    await manager.SendTaskNotificationAsync(
                        null,
                        commentOwner,
                        $"Comment on task {taskId}\n{Text(normalized["note"])}",
                        true,
                        taskId,
                        "commented",
                        "comment"
                    );
                }
                catch
                {
                    warnings.Add(
                        "Comment saved, but the owner notification could not be delivered."
                    );
                }
            }
            if (warnings.Count > 0)
                result.Payload["warning"] = string.Join(" ", warnings);
            if (result.Assignment is not null || result.CommentOwner is not null)
                result.Payload["task"] = store
                    .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId! }, null)
                    .Payload["task"]!.DeepClone();
            return result.Payload;
        }
        finally
        {
            mutationLane.Release();
        }
    }

    private async Task<TaskStoreResult> ExecuteCoreAsync(
        JsonObject args,
        string? actor,
        int? httpLimit,
        long? anchor
    )
    {
        TaskStore.Validate(args, httpLimit);
        var action = Text(args["action"]);
        if (actor is null && action is not ("list" or "get"))
            actor = store.DefaultActor(args);
        if (action is not ("list" or "get") && actor is null)
            throw new TaskError(
                "TASK_SESSION_REQUIRED",
                "Select an existing Session for this operation."
            );
        actor = actor is null ? null : resolveSessionId(actor) ?? actor;
        var normalizedArgs = (JsonObject)args.DeepClone();
        if (
            action is "assign" or "create"
            && args["ownerSessionId"] is JsonValue ownerValue
            && ownerValue.TryGetValue<string>(out var requestedOwner)
            && resolveSessionId(requestedOwner) is not { } canonicalOwner
        )
            throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
        if (
            action is "assign" or "create"
            && args["ownerSessionId"] is JsonValue ownerString
            && ownerString.TryGetValue<string>(out var ownerId)
        )
            normalizedArgs["ownerSessionId"] = resolveSessionId(ownerId) ?? ownerId;
        var selectedAnchor = actor is null ? null : anchor ?? anchorSeq(actor);
        var result = store.Execute(normalizedArgs, actor, httpLimit, selectedAnchor);
        var warnings = new List<string>();
        var resultTaskId = Text(result.Payload["task"]?["id"]) ?? Text(args["taskId"]);
        if (result.Assignment is { } assignment)
        {
            if (resultTaskId is null)
                throw new InvalidDataException("Task assignment did not return a task ID.");
            await DeliverAssignmentAsync(resultTaskId, actor!, assignment, warnings);
        }
        if (result.CommentOwner is { } commentOwner && commentOwner != actor)
        {
            try
            {
                await manager.SendTaskNotificationAsync(
                    actor,
                    commentOwner,
                    $"Comment on task {resultTaskId}\n{Text(args["note"])}",
                    true,
                    resultTaskId!,
                    "commented",
                    "comment"
                );
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
            await DeliverCompletionAsync(resultTaskId, actor!, warnings);
        }
        if (warnings.Count > 0)
            result.Payload["warning"] = string.Join(" ", warnings);
        if (result.Assignment is not null || result.Completed || result.CommentOwner is not null)
            result.Payload["task"] = store
                .Execute(new JsonObject { ["action"] = "get", ["taskId"] = resultTaskId! }, null)
                .Payload["task"]!.DeepClone();
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
        bool consume,
        IReadOnlyList<string> retained
    ) => store.TaskContext(sessionId, sequences, consume, retained);

    internal async Task<AttachedChildResult> CreateAttachedChildAsync(
        string taskId,
        string sourceSessionId,
        Func<Task<SessionOwner>> create,
        string? additionalMessage = null
    )
    {
        var source = resolveSessionId(sourceSessionId) ?? sourceSessionId;
        TaskStoreResult attached;
        SessionOwner child;
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            var task = store
                .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, source)
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
                attached = store.Execute(
                    new JsonObject
                    {
                        ["action"] = "assign",
                        ["taskId"] = taskId,
                        ["ownerSessionId"] = child.Id,
                        ["notifySession"] = true,
                    },
                    source
                );
                store.AttachChild(taskId, child.Id);
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
        var assignment = attached.Assignment;
        if (assignment is null)
            return new AttachedChildResult(child, true, null);
        var delivered = await DeliverAssignmentAsync(
            taskId,
            source,
            assignment,
            warnings,
            additionalMessage
        );
        return new AttachedChildResult(
            child,
            delivered,
            warnings.Count == 0 ? null : string.Join(" ", warnings)
        );
    }

    private async Task<bool> DeliverAssignmentAsync(
        string taskId,
        string? actor,
        TaskAssignmentPlan plan,
        List<string> warnings,
        string? additionalMessage = null
    )
    {
        var newOwnerDelivered = plan.NewOwner is null;
        if (plan.PreviousOwner is { } previous)
            await DeliverAsync(
                taskId,
                actor,
                previous,
                $"Task ownership {(plan.NewOwner is null ? "released" : $"transferred to {plan.NewOwner}")}: {Summary(taskId)}",
                false,
                "previousOwnerNotificationStatus",
                plan.Revision,
                warnings,
                "previous",
                plan.NewOwner is null ? "released" : "transferred"
            );
        if (plan.NewOwner is { } next)
            newOwnerDelivered = await DeliverAsync(
                taskId,
                actor,
                next,
                $"You have been assigned a task: {Summary(taskId, fullDescription: true)}{(additionalMessage is null ? "" : $"\n\nAdditional instruction:\n{additionalMessage}")}",
                true,
                "assignmentNotificationStatus",
                plan.Revision,
                warnings,
                "new",
                plan.PreviousOwner is null ? "assigned" : "transferred"
            );
        return newOwnerDelivered;
    }

    private async Task DeliverCompletionAsync(string taskId, string actor, List<string> warnings)
    {
        var row = store
            .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, null)
            .Payload["task"]
            ?.AsObject();
        var creator =
            row?["createdByKind"]?.GetValue<string>() == "session"
                ? row?["createdBySessionId"]?.GetValue<string>()
                : null;
        if (creator is null || resolveSessionId(creator) == resolveSessionId(actor))
        {
            store.MarkNotification(taskId, "completionNotificationStatus", "skipped");
            return;
        }
        await DeliverAsync(
            taskId,
            actor,
            creator,
            $"Task completed: {Summary(taskId, includeResult: true)}",
            true,
            "completionNotificationStatus",
            null,
            warnings,
            "completion",
            "completed"
        );
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
        string recipient,
        string eventName
    )
    {
        var canonicalTarget = resolveSessionId(target) ?? target;
        if (actor is not null && canonicalTarget == (resolveSessionId(actor) ?? actor))
        {
            store.MarkNotification(taskId, field, "skipped", revision);
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
            store.MarkNotification(taskId, field, "sent", revision);
            if (recipient == "new")
                return true;
            return true;
        }
        catch
        {
            try
            {
                store.MarkNotification(taskId, field, "failed", revision);
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

    private string Summary(string taskId, bool includeResult = false, bool fullDescription = false)
    {
        var task = store
            .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, null)
            .Payload["task"]!.AsObject();
        var title = task["title"]?.GetValue<string>() ?? taskId;
        var status = task["status"]?.GetValue<string>() ?? "unknown";
        var description = fullDescription
            ? store.ReadStoredDescription(taskId)
            : task["description"]?.GetValue<string>();
        var result = task["result"]?.GetValue<string>();
        var body = includeResult ? result : description;
        var limit =
            fullDescription ? int.MaxValue
            : includeResult ? 4000
            : 1000;
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
                    item["createdByAgent"] = resolveSessionAgent(
                        Text(item["createdBySessionId"]) ?? ""
                    );
                    item["ownerAgent"] = item["ownerSessionId"] is null
                        ? null
                        : resolveSessionAgent(Text(item["ownerSessionId"]) ?? "");
                }
            return payload;
        }
        var target = targetSessionId;
        if (target is null && action is not "create")
            target = store.DefaultActor(args);
        if (target is null)
            throw new TaskError(
                "TASK_SESSION_REQUIRED",
                "Select an existing Session for this operation."
            );
        var canonical =
            resolveSessionId(target)
            ?? throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
        var result = (await ExecuteAsync(args, canonical, limit, anchorSeq(canonical))).Payload;
        result["sessionId"] = canonical;
        return result;
    }

    internal async Task<(
        JsonObject Payload,
        string? CompletionTarget
    )> ExecuteForToolWithReceiptAsync(SessionOwner source, JsonObject args)
    {
        var payload = (
            await ExecuteAsync(args, source.Id, anchor: source.Entry.Snapshot().NextMessageSeq - 1)
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
