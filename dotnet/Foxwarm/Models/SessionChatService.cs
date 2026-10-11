using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal sealed class SessionChatService(
    ModelRequestOwner requests,
    ResponsesClientOptions baseOptions,
    SessionOwner hosted,
    HostModels models,
    AgentMemory memory,
    Action<string, ResponsesStreamProgress> progress,
    Func<JsonArray>? definitions = null,
    TaskService? tasks = null,
    Func<string>? executionContext = null
) : ISessionChatService
{
    public Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    ) => ChatCoreAsync(sessionId, history, null, cancellationToken);

    public Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        CancellationToken cancellationToken
    ) => ChatCoreAsync(sessionId, history, prepareRetry, cancellationToken);

    private async Task<ChatResult> ChatCoreAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        Func<CancellationToken, Task<bool>>? prepareRetry,
        CancellationToken cancellationToken
    )
    {
        var selectedSnapshot = hosted.Entry.Snapshot();
        var catalog = models.Capture();
        var selected = catalog.Select(selectedSnapshot);
        var routeKey =
            selected.RawModel is not null && catalog.Contains(selected.RawModel)
                ? selected.RawModel
                : catalog.DefaultKey;
        var rawEffort = selected.RawEffort;
        var turnId = hosted.LogicalTurnId;
        var captured = requests.Capture(catalog, routeKey, rawEffort);
        var cacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        var notice = new ModelRetryNotice(hosted);
        var attempts = 0;
        var retainedTaskIds = new List<string>();
        async Task<IReadOnlyList<JsonObject>> RequestContext()
        {
            var visible = TaskProgress.Sequences(hosted.Entry.Snapshot());
            if (tasks is null)
                return [];
            var context = tasks.TaskContext(hosted.Id, visible, true, retainedTaskIds);
            var current = context["tasks"]!.AsArray();
            retainedTaskIds = current.Select(item => item!["id"]!.GetValue<string>()).ToList();
            if (current.Count == 0)
                return [];
            var lines = current.Select(item =>
                $"{item!["id"]!.GetValue<string>()} — {item["title"]!.GetValue<string>()} ({item["status"]!.GetValue<string>()})"
            );
            var omitted = context["omitted"]?.GetValue<int>() ?? 0;
            var omittedText = omitted > 0 ? $"\n{omitted} more tasks." : "";
            return
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["system"] =
                                "<foxwarm-system kind=\"task-reminder\">Continue the active tasks:\n"
                                + string.Join('\n', lines)
                                + omittedText
                                + "</foxwarm-system>",
                        }
                    ),
                },
            ];
        }
        async Task<string> Prompt(ConcreteHostModel leaf, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            var value =
                SessionWait.Text(
                    hosted.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
                ) ?? "";
            if (ConditionalMemory.ReadCurrentModelSnapshotId(value) != leaf.Key)
            {
                value = await memory.BuildAsync(
                    hosted.Agent,
                    hosted.Id,
                    leaf.Key,
                    token,
                    AgentMemory.Selection(hosted.Entry.Snapshot().AuthorityEnvelope)
                );
                await hosted.Entry.SaveLane.CommitMemorySnapshotAsync(value);
            }
            if (executionContext is not null)
                value += "\n\n" + executionContext();
            return baseOptions.Instructions.Length == 0
                ? value
                : baseOptions.Instructions + "\n\n" + value;
        }
        try
        {
            return await requests.RequestAsync(
                sessionId,
                captured,
                cacheKey,
                turnId,
                history,
                Prompt,
                notice.NotifyAsync,
                () =>
                {
                    if (++attempts > 1 && prepareRetry is null)
                        hosted.RestartDraft();
                },
                progress,
                hosted.Entry.RecordBestEffortFailure,
                cancellationToken,
                ModelRequestScope.Canonical,
                definitions,
                prepareRetry is null
                    ? null
                    : async token =>
                    {
                        if (!await prepareRetry(token))
                            return null;
                        return hosted.Entry.WithState(state =>
                            state
                                .History.Select(message => (JsonObject)message.DeepClone())
                                .ToArray()
                        );
                    },
                "normal-turn",
                0,
                id => hosted.BeginDraft(id),
                RequestContext
            );
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ToolAuthorizationUnavailableException)
        {
            throw;
        }
        catch (ModelRequestException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new ModelPreparationException(
                ConfiguredModelRequests.SafeError(error, selected.Model),
                error
            );
        }
    }
}
