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
    TaskService? tasks = null
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

    public Task<ChatResult> ChatAsync(
        string sessionId,
        SessionHistory history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        Func<JsonObject, bool, Task<JsonObject>> commitAssistantSegment,
        CancellationToken cancellationToken,
        int iteration = 0
    ) =>
        ChatCoreAsync(
            sessionId,
            RequestHistory.FromSnapshot(history),
            prepareRetry,
            cancellationToken,
            commitAssistantSegment,
            iteration
        );

    private async Task<ChatResult> ChatCoreAsync(
        string sessionId,
        RequestHistory history,
        Func<CancellationToken, Task<bool>>? prepareRetry,
        CancellationToken cancellationToken,
        Func<JsonObject, bool, Task<JsonObject>>? commitAssistantSegment = null,
        int iteration = 0
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
        var committedPrefix = false;
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
            return baseOptions.Instructions.Length == 0
                ? value
                : baseOptions.Instructions + "\n\n" + value;
        }
        try
        {
            // Only the retry-capable owner path carries committed history that the reminder can extend.
            if (prepareRetry is not null && await AppendTaskReminderAsync(cancellationToken))
                history = hosted.Entry.WithState(state =>
                    RequestHistory.FromSnapshot(state.History.Snapshot())
                );
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
                    hosted.BeginModelAttempt();
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
                        var changed = await prepareRetry(token);
                        if (!changed && !committedPrefix)
                            return null;
                        committedPrefix = false;
                        return hosted.Entry.WithState(state =>
                            RequestHistory.FromSnapshot(state.History.Snapshot())
                        );
                    },
                "normal-turn",
                iteration,
                id => hosted.BeginDraft(id),
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
                },
                commitAssistantSegment is null
                    ? null
                    : async (message, deliver) =>
                    {
                        var committed = await commitAssistantSegment(message, deliver)
                            .ConfigureAwait(false);
                        committedPrefix = true;
                        return committed;
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

    /// <summary>
    /// Persists a due Task reminder as ordinary system history before this request. Provider
    /// retries reuse committed history, and consumption resets progress, so it appends once.
    /// </summary>
    private async Task<bool> AppendTaskReminderAsync(CancellationToken cancellationToken)
    {
        if (tasks is null)
            return false;
        cancellationToken.ThrowIfCancellationRequested();
        var visible = hosted.Entry.WithState(state => TaskProgress.Sequences(state.History));
        if (TaskReminder.Build(tasks.TaskContext(hosted.Id, visible, true)) is not { } reminder)
            return false;
        IReadOnlyList<JsonObject> rows = [];
        try
        {
            rows = await hosted
                .Entry.SaveLane.CommitCanonicalAppendWithResultAsync(
                    state =>
                    {
                        var operation = LocalSessionTurnHost.PrepareCanonicalAppend(
                            state,
                            [reminder],
                            [],
                            false,
                            false,
                            () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        );
                        rows = operation.AppendedMessages;
                        return operation;
                    },
                    cancellationToken: cancellationToken
                )
                .ConfigureAwait(false);
        }
        catch (AuthorityCommittedException)
        {
            hosted.Entry.InvokeHistoryAppended(rows);
            hosted.Entry.InvokeCommitted(hosted.Entry.Snapshot());
            throw;
        }
        hosted.Entry.InvokeCommitted(hosted.Entry.Snapshot());
        return rows.Count > 0;
    }
}
