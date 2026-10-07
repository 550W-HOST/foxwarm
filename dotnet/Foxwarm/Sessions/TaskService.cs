using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class TaskService : IDisposable
{
    private readonly TaskStore store;
    private readonly SessionManager manager;

    internal TaskService(SessionManager manager, string root, Func<string, string?> resolveAlias)
    {
        this.manager = manager;
        store = new TaskStore(root, resolveAlias, _ => []);
    }

    internal async Task<TaskStoreResult> ExecuteAsync(
        JsonObject args,
        string? actor,
        int? httpLimit = null
    )
    {
        var action = Text(args["action"]);
        if (actor is null && action is not ("list" or "get" or "create"))
            actor = store.DefaultActor(args);
        var result = store.Execute(args, actor, httpLimit);
        var warnings = new List<string>();
        if (result.Assignment is { } assignment)
            await DeliverAssignmentAsync(Text(args["taskId"])!, assignment, warnings);
        if (result.Completed)
            await DeliverCompletionAsync(Text(args["taskId"])!, actor!, warnings);
        if (warnings.Count > 0)
            result.Payload["warning"] = string.Join(" ", warnings);
        return result;
    }

    private async Task DeliverAssignmentAsync(
        string taskId,
        TaskAssignmentPlan plan,
        List<string> warnings
    )
    {
        if (plan.NewOwner is { } newOwner)
            await DeliverAsync(
                taskId,
                newOwner,
                $"Task {taskId} was assigned to this Session.",
                true,
                "assignmentNotificationStatus",
                plan.Revision,
                warnings
            );
        if (plan.PreviousOwner is { } previous)
            await DeliverAsync(
                taskId,
                previous,
                $"Task {taskId} is no longer assigned to this Session.",
                false,
                "previousOwnerNotificationStatus",
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
        if (creator is null || creator == actor)
        {
            store.MarkNotification(taskId, "completionNotificationStatus", "skipped");
            return;
        }
        await DeliverAsync(
            taskId,
            creator,
            $"Task {taskId} was completed.",
            true,
            "completionNotificationStatus",
            null,
            warnings
        );
    }

    private async Task DeliverAsync(
        string taskId,
        string target,
        string message,
        bool trigger,
        string field,
        int? revision,
        List<string> warnings
    )
    {
        try
        {
            await manager.EnqueueTaskNotificationAsync(target, message, trigger);
            store.MarkNotification(taskId, field, "sent", revision);
        }
        catch
        {
            store.MarkNotification(taskId, field, "failed", revision);
            warnings.Add($"Task notification to {target} could not be delivered.");
        }
    }

    internal async Task<JsonObject> ExecuteForWebUiAsync(
        JsonObject args,
        string? targetSessionId,
        int? limit = null
    ) => (await ExecuteAsync(args, targetSessionId, limit)).Payload;

    internal async Task<JsonObject> ExecuteForToolAsync(SessionOwner source, JsonObject args) =>
        (await ExecuteAsync(args, source.Id)).Payload;

    public void Dispose() => store.Dispose();

    private static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
