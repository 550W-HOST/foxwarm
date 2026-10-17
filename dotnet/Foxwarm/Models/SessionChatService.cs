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
    ) => ChatCoreAsync(sessionId, RequestHistory.FromMutable(history), null, cancellationToken);

    public Task<ChatResult> ChatAsync(
        string sessionId,
        SessionHistory history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        CancellationToken cancellationToken
    ) =>
        ChatCoreAsync(
            sessionId,
            RequestHistory.FromSnapshot(history),
            prepareRetry,
            cancellationToken
        );

    private async Task<ChatResult> ChatCoreAsync(
        string sessionId,
        RequestHistory history,
        Func<CancellationToken, Task<bool>>? prepareRetry,
        CancellationToken cancellationToken
    )
    {
        var catalog = models.Capture();
        var selected = hosted.Entry.WithState(state => catalog.Select(state.AuthorityEnvelope));
        var routeKey =
            selected.RawModel is not null && catalog.Contains(selected.RawModel)
                ? selected.RawModel
                : catalog.DefaultKey;
        var rawEffort = selected.RawEffort;
        var selectedRawModel = selected.RawModel;
        var selectionRecaptured = false;
        var turnId = hosted.LogicalTurnId;
        var captured = requests.Capture(catalog, routeKey, rawEffort);
        var cacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        var notice = new ModelRetryNotice(hosted);
        var attempts = 0;
        var retainedTaskIds = new List<string>();
        async Task<IReadOnlyList<JsonObject>> RequestContext()
        {
            if (tasks is null)
                return [];
            var visible = hosted.Entry.WithState(state => TaskProgress.Sequences(state.History));
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
                hosted.Entry.WithState(state =>
                    SessionWait.Text(state.AuthorityEnvelope["persistentMemorySnapshot"])
                ) ?? "";
            if (ConditionalMemory.ReadCurrentModelSnapshotId(value) != leaf.Key)
            {
                value = await memory.BuildAsync(
                    hosted.Agent,
                    hosted.Id,
                    leaf.Key,
                    token,
                    hosted.Entry.WithState(state => AgentMemory.Selection(state.AuthorityEnvelope))
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
                            RequestHistory.FromSnapshot(state.History.Snapshot())
                        );
                    },
                "normal-turn",
                0,
                id => hosted.BeginDraft(id),
                RequestContext,
                () =>
                {
                    var raw = hosted.Entry.WithState(state =>
                        SessionWait.Text(state.AuthorityEnvelope["model"])
                    );
                    if (raw == selectedRawModel)
                        return null;
                    var nextCatalog = models.Capture();
                    var next = hosted.Entry.WithState(state =>
                        nextCatalog.Select(state.AuthorityEnvelope)
                    );
                    selectedRawModel = next.RawModel;
                    selectionRecaptured = true;
                    captured = requests.Capture(
                        nextCatalog,
                        next.RawModel ?? nextCatalog.DefaultKey,
                        next.RawEffort
                    );
                    return captured;
                },
                async (leaf, effort, failover, token) =>
                {
                    token.ThrowIfCancellationRequested();
                    var current = new EffectiveRequestSelection(
                        leaf.Key,
                        hosted.Entry.WithState(state =>
                            hosted.ExecutionNode(state.AuthorityEnvelope)
                        ),
                        effort,
                        selectedRawModel is not null && !captured.Catalog.Contains(selectedRawModel)
                            ? selectedRawModel
                            : null
                    );
                    var changed = await hosted.Entry.SaveLane.AdoptEffectiveSelectionAsync(
                        current,
                        failover
                    );
                    var rebuild = changed || selectionRecaptured;
                    selectionRecaptured = false;
                    return rebuild
                        ? hosted.Entry.WithState(state =>
                            RequestHistory.FromSnapshot(state.History.Snapshot())
                        )
                        : null;
                }
            );
        }
        catch (SessionTurnShutdownException)
        {
            throw;
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
