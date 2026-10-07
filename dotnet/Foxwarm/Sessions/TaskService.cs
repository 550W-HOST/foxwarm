using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class TaskService : IDisposable
{
    private readonly TaskStore store;
    private readonly SessionManager manager;
    private readonly Func<string, string?> resolveSessionId;
    private readonly Func<string, long?> anchorSeq;
    private readonly SemaphoreSlim mutationLane = new(1, 1);

    internal TaskService(
        SessionManager manager,
        string root,
        Func<string, string?> resolveSessionId,
        Func<string, IReadOnlyList<string>> aliases,
        Func<string, long?> anchorSeq
    )
    {
        this.manager = manager;
        this.resolveSessionId = resolveSessionId;
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
            action == "assign"
            && args["ownerSessionId"] is JsonValue ownerValue
            && ownerValue.TryGetValue<string>(out var requestedOwner)
            && resolveSessionId(requestedOwner) is not { } canonicalOwner
        )
            throw new TaskError("TASK_SESSION_NOT_FOUND", "Target Session was not found.", 404);
        if (
            action == "assign"
            && args["ownerSessionId"] is JsonValue ownerString
            && ownerString.TryGetValue<string>(out var ownerId)
        )
            normalizedArgs["ownerSessionId"] = resolveSessionId(ownerId) ?? ownerId;
        var selectedAnchor = actor is null ? null : anchor ?? anchorSeq(actor);
        var result = store.Execute(normalizedArgs, actor, httpLimit, selectedAnchor);
        var warnings = new List<string>();
        if (result.Assignment is { } assignment)
            await DeliverAssignmentAsync(Text(args["taskId"])!, actor!, assignment, warnings);
        if (result.Completed)
            await DeliverCompletionAsync(Text(args["taskId"])!, actor!, warnings);
        if (warnings.Count > 0)
            result.Payload["warning"] = string.Join(" ", warnings);
        if (result.Assignment is not null || result.Completed)
            result.Payload["task"] = store
                .Execute(
                    new JsonObject { ["action"] = "get", ["taskId"] = Text(args["taskId"])! },
                    null
                )
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

    internal async Task<SessionOwner> CreateAttachedChildAsync(
        string taskId,
        Func<Task<SessionOwner>> create
    )
    {
        await mutationLane.WaitAsync().ConfigureAwait(false);
        try
        {
            var task = store
                .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, null)
                .Payload["task"]!.AsObject();
            if (Text(task["status"]) is "completed" or "cancelled")
                throw new TaskError("TASK_TERMINAL", $"Task {taskId} is terminal.", 409);
            if (Text(task["ownerSessionId"]) is { } owner)
                throw new TaskError(
                    "TASK_OWNED",
                    $"Task {taskId} is already claimed by another Session ({owner}).",
                    409
                );
            var child = await create().ConfigureAwait(false);
            try
            {
                store.BindChild(taskId, child.Id);
                await child.Entry.SaveLane.MarkChildHandoffRequiredAsync().ConfigureAwait(false);
            }
            catch (Exception error)
            {
                throw new CommittedSessionCreationException(
                    child.Id,
                    $"Child Session '{child.Id}' was committed but task attachment was not durable: {error.Message}",
                    error
                );
            }
            return child;
        }
        finally
        {
            mutationLane.Release();
        }
    }

    private async Task DeliverAssignmentAsync(
        string taskId,
        string actor,
        TaskAssignmentPlan plan,
        List<string> warnings
    )
    {
        if (plan.PreviousOwner is { } previous)
            await DeliverAsync(
                taskId,
                actor,
                previous,
                $"Task ownership {(plan.NewOwner is null ? "released" : $"transferred to {plan.NewOwner}")}: {Summary(taskId)}",
                false,
                "previousOwnerNotificationStatus",
                plan.Revision,
                warnings
            );
        if (plan.NewOwner is { } next)
            await DeliverAsync(
                taskId,
                actor,
                next,
                $"You have been assigned a task: {Summary(taskId)}",
                true,
                "assignmentNotificationStatus",
                plan.Revision,
                warnings
            );
    }

    private async Task DeliverCompletionAsync(string taskId, string actor, List<string> warnings)
    {
        var row = store
            .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, null)
            .Payload["task"]
            ?.AsObject();
        var creator = row?["createdBySessionId"]?.GetValue<string>();
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
            warnings
        );
    }

    private async Task DeliverAsync(
        string taskId,
        string actor,
        string target,
        string message,
        bool trigger,
        string field,
        long? revision,
        List<string> warnings
    )
    {
        var canonicalTarget = resolveSessionId(target) ?? target;
        if (canonicalTarget == (resolveSessionId(actor) ?? actor))
        {
            store.MarkNotification(taskId, field, "skipped", revision);
            return;
        }
        try
        {
            await manager.SendTaskNotificationAsync(actor, target, message, trigger);
            store.MarkNotification(taskId, field, "sent", revision);
        }
        catch
        {
            try
            {
                store.MarkNotification(taskId, field, "failed", revision);
            }
            catch { }
            warnings.Add($"Task notification to {target} could not be delivered.");
        }
    }

    private string Summary(string taskId, bool includeResult = false)
    {
        var task = store
            .Execute(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, null)
            .Payload["task"]!.AsObject();
        var title = task["title"]?.GetValue<string>() ?? taskId;
        var status = task["status"]?.GetValue<string>() ?? "unknown";
        var description = task["description"]?.GetValue<string>();
        var result = task["result"]?.GetValue<string>();
        var body = includeResult ? result : description;
        var limit = includeResult ? 4000 : 1000;
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
            return (await ExecuteAsync(args, null, limit)).Payload;
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
