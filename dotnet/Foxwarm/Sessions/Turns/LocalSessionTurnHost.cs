using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

public sealed partial class LocalSessionTurnHost
{
    private readonly SessionEntry entry;
    private readonly ISessionAuthorityStore store;
    private readonly IChatService chat;
    private readonly ITurnToolExecutor tools;
    private readonly int maxToolIterations;
    private readonly Func<long> clock;
    private readonly Func<string?>? parentSessionResolver;
    private int releaseCommits;
    private readonly Action? assertCanContinue;
    private readonly Func<bool>? closing;
    private bool Closing => closing?.Invoke() == true;

    private void AssertCanContinue() => assertCanContinue?.Invoke();

    private readonly Func<Task>? safePoint;
    private readonly Func<Task>? retrySafePoint;
    private readonly Func<
        ChatResult,
        Func<Func<Task>, Task>,
        CancellationToken,
        Task
    >? beforeContinuation;

    public LocalSessionTurnHost(
        SessionEntry entry,
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor? tools = null,
        int maxToolIterations = 500,
        Func<long>? clock = null,
        Func<Task>? safePoint = null,
        Func<Task>? retrySafePoint = null,
        Func<string?>? parentSessionResolver = null,
        Func<ChatResult, Func<Func<Task>, Task>, CancellationToken, Task>? beforeContinuation =
            null,
        Action? assertCanContinue = null,
        Func<bool>? closing = null
    )
    {
        this.entry = entry;
        this.store = store;
        this.chat = chat;
        this.tools = tools ?? new UnsupportedTurnToolExecutor();
        this.maxToolIterations =
            maxToolIterations > 0
                ? maxToolIterations
                : throw new ArgumentOutOfRangeException(nameof(maxToolIterations));
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.parentSessionResolver = parentSessionResolver;
        this.safePoint = safePoint;
        this.retrySafePoint = retrySafePoint;
        this.beforeContinuation = beforeContinuation;
        this.assertCanContinue = assertCanContinue;
        this.closing = closing;
    }

    internal Task SafePointAsync() => safePoint?.Invoke() ?? Task.CompletedTask;

    public int ReleaseCommitCount => Volatile.Read(ref releaseCommits);

    public async Task<bool> TryClaimBusyAsync()
    {
        var version = entry.MarkBusy();
        if (version == 0)
            return false;
        try
        {
            await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false);
            return true;
        }
        catch (Exception error)
        {
            if (error is not AuthorityCommittedException)
                entry.RollbackBusy(version);
            throw;
        }
    }

    public async Task AppendQueuedInputsAsync(IReadOnlyList<QueueItem> items)
    {
        if (items.Count == 0)
            return;
        foreach (var item in items)
            SessionIngress.EnsureSupportedForRunner(item);
        await entry
            .SaveLane.CommitCanonicalAppendAsync(state =>
                PrepareQueuedAppend(state, items, finalizing: false, clock)
            )
            .ConfigureAwait(false);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    public async Task<ChatResult> ChatAsync(string turnId)
    {
        var requestCts = new CancellationTokenSource();
        CancellationHandle? handle = null;
        try
        {
            handle = entry.RegisterCancellation(requestCts);
            var registered =
                handle
                ?? throw new InvalidOperationException(
                    "Cancellation registration was not created."
                );
            if (tools is ITurnToolControl control)
                control.BeginTurn();
            for (var iteration = 0; iteration < maxToolIterations; iteration++)
            {
                AssertCanContinue();
                registered.Token.ThrowIfCancellationRequested();
                await SafePointAsync().ConfigureAwait(false);
                AssertCanContinue();
                registered.Token.ThrowIfCancellationRequested();
                entry.StructuredProgress?.Invoke(new("llm-start"));
                var history = entry.WithState(state => state.History.Snapshot());
                var result = chat is ISessionChatService ordinary
                    ? await ordinary
                        .ChatAsync(entry.State.Id, history, PrepareRetryAsync, registered.Token)
                        .ConfigureAwait(false)
                    : await chat.ChatAsync(entry.State.Id, history.Materialize(), registered.Token)
                        .ConfigureAwait(false);
                try
                {
                    entry.WithState(state => DeferredQueueInput.Mark(state.Queue));
                    if (result.AssistantMessage is null)
                    {
                        if (result.Usage is not null)
                            await AppendHistoryMessageStrictAsync(null, result.Usage)
                                .ConfigureAwait(false);
                        return result;
                    }
                    var assistant = (JsonObject)result.AssistantMessage.DeepClone();
                    if (
                        assistant["role"]?.GetValue<string>() != "model"
                        || assistant["parts"] is not JsonArray
                    )
                        throw new InvalidOperationException(
                            "Chat result assistant message must be a canonical model message."
                        );
                    var appended = await AppendHistoryMessageStrictAsync(
                            assistant,
                            result.Usage ?? assistant["__meta"]?["usage"] as JsonObject
                        )
                        .ConfigureAwait(false);
                    result.FinalizeHistory(appended, entry.RecordBestEffortFailure);
                    if (entry.AssistantCommitted is { } present)
                        await present(appended[^1]);
                    if (result.TruncatedStopReason is string stopReason)
                    {
                        try
                        {
                            await AppendHistoryMessageStrictAsync(
                                    new JsonObject
                                    {
                                        ["role"] = "model",
                                        ["modelVisible"] = false,
                                        ["parts"] = new JsonArray(
                                            new JsonObject
                                            {
                                                ["text"] =
                                                    stopReason == "model_context_window_exceeded"
                                                        ? "The response stopped because the context window was reached. The text above may be incomplete."
                                                        : "The response stopped at the output limit. The text above may be incomplete.",
                                            }
                                        ),
                                        ["__meta"] = new JsonObject
                                        {
                                            ["noticeType"] = "llm-stop",
                                            ["stopReason"] = stopReason,
                                        },
                                    }
                                )
                                .ConfigureAwait(false);
                        }
                        catch (Exception error)
                        {
                            entry.RecordBestEffortFailure(error);
                        }
                    }

                    var calls = ExtractFunctionCalls(assistant);
                    if (calls.Count == 0)
                    {
                        var parts = assistant["parts"]?.AsArray() ?? [];
                        var noAction = parts.Any(part =>
                            SessionBoundary.IsNoAction(SessionWait.Text(part?["text"]))
                        );
                        var finalText = string.Join(
                            "",
                            parts
                                .Select(part => SessionWait.Text(part?["text"]))
                                .Where(text => text is not null)
                        );
                        var hasLeadingQueue = entry.WithState(state =>
                            state.Queue.Any(SessionCompactor.Ordinary)
                        );
                        if (!hasLeadingQueue && noAction)
                            await entry.SaveLane.ResolveChildHandoffAsync().ConfigureAwait(false);
                        var parent = ParentSessionId();
                        if (
                            !hasLeadingQueue
                            && parent is not null
                            && SessionBoundary.NeedsChildHandoff(entry.Snapshot().AuthorityEnvelope)
                            && !noAction
                            && !finalText.TrimStart().StartsWith("Error:", StringComparison.Ordinal)
                        )
                            await entry
                                .SaveLane.QueueChildReminderAsync(
                                    parent,
                                    tools is SessionToolExecutor toolMode
                                        && toolMode.HandoffConfirmationEnabled
                                )
                                .ConfigureAwait(false);
                        if (
                            Closing
                            || !entry.WithState(state =>
                                !state.Stopping
                                && !state.Meta.ContainsKey("runQueuedAfterStop")
                                && state.Queue.Any(SessionCompactor.Ordinary)
                            )
                        )
                            return result;
                        await ContinueAfterResultAsync(result, registered.Token)
                            .ConfigureAwait(false);
                        continue;
                    }

                    entry.StructuredProgress?.Invoke(
                        new(
                            "tool-calls-start",
                            calls
                                .Select(call => new Foxwarm.Channels.ChannelTurnTool(
                                    SessionWait.Text(call["id"]) ?? "",
                                    SessionWait.Text(call["name"]) ?? "tool"
                                ))
                                .ToArray(),
                            string.Join(
                                "",
                                (assistant["parts"] as JsonArray ?? [])
                                    .OfType<JsonObject>()
                                    .Where(part => part["thinking"] is null)
                                    .Select(part => SessionWait.Text(part["text"]) ?? "")
                            )
                        )
                    );
                    var toolParts = await ExecuteToolBatchAsync(
                            ToolCallControls.Plan(
                                calls,
                                tools is SessionToolExecutor mode && mode.HandoffConfirmationEnabled
                            ),
                            registered.Token
                        )
                        .ConfigureAwait(false);

                    if (tools is SessionToolExecutor receiptTools)
                    {
                        var parent = ParentSessionId();
                        var validReceipt = receiptTools
                            .ConsumeReceipts()
                            .Any(receipt =>
                                receipt.AttachedSessionId == entry.Snapshot().Id
                                    && receipt.CompletedTaskId is not null
                                || parent is not null && receipt.SuccessfulSendTarget == parent
                            );
                        if (validReceipt)
                            await entry.SaveLane.ResolveChildHandoffAsync().ConfigureAwait(false);
                    }

                    if (
                        toolParts.FirstOrDefault()?["functionResponse"] is JsonObject firstResponse
                        && assistant["__meta"]?["llmRequestTiming"] is JsonObject timing
                        && SessionWait.Number(timing["completedAt"]) is double completedAt
                        && double.IsFinite(completedAt)
                        && completedAt >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                        && completedAt <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
                        && SessionWait.Number(timing["durationMs"]) is double duration
                        && double.IsFinite(duration)
                    )
                        firstResponse["previousLlmRequest"] = new JsonObject
                        {
                            ["time"] = ArchiveBlockRecord.LocalTimestamp(completedAt),
                            ["durationMs"] = duration,
                        };
                    var toolMessage = new JsonObject { ["role"] = "tool", ["parts"] = toolParts };
                    await AppendHistoryMessageStrictAsync(toolMessage).ConfigureAwait(false);
                    entry.StructuredProgress?.Invoke(
                        new(
                            "tool-calls-finish",
                            toolParts
                                .OfType<JsonObject>()
                                .Select(part => part["functionResponse"])
                                .OfType<JsonObject>()
                                .Select(result => new Foxwarm.Channels.ChannelTurnTool(
                                    SessionWait.Text(result["tool_use_id"]) ?? "",
                                    SessionWait.Text(result["name"]) ?? "tool",
                                    result["response"] is JsonObject response
                                    && response["error"] is not null
                                        ? "error"
                                        : "success"
                                ))
                                .ToArray()
                        )
                    );
                    var stopping = entry.WithState(state => state.Stopping);
                    var ending =
                        tools is ITurnToolControl turnControl
                        ? await turnControl
                            .CompleteBatchAsync(toolMessage, stopping)
                            .ConfigureAwait(false) : TurnBatchEnding.Continue;
                    if (stopping)
                        throw new OperationCanceledException(registered.Token);
                    if (ending != TurnBatchEnding.Continue)
                        return result with { Terminal = true, Suspended = ending == TurnBatchEnding.Suspended };
                    AssertCanContinue();
                    await ContinueAfterResultAsync(result, registered.Token).ConfigureAwait(false);
                    if (iteration + 1 >= maxToolIterations)
                        throw new ToolLoopLimitException(maxToolIterations);
                }
                finally
                {
                    result.FinalizeHistory(null, entry.RecordBestEffortFailure);
                }
            }
            throw new ToolLoopLimitException(maxToolIterations);
        }
        finally
        {
            if (handle is not null)
                entry.ClearCancellation(handle);
            else
                requestCts.Dispose();
        }
    }

    private string? ParentSessionId() =>
        parentSessionResolver is { } resolver
            ? resolver()
            : entry.WithState(state =>
                SessionWait.Text(state.AuthorityEnvelope["parentSessionId"])
            );

    private async Task<bool> PrepareRetryAsync(CancellationToken token)
    {
        void AssertCanRetry()
        {
            AssertCanContinue();
            token.ThrowIfCancellationRequested();
            if (
                entry.WithState(state =>
                    state.Stopping || state.Meta["runQueuedAfterStop"]?.GetValue<bool>() == true
                )
            )
                throw new OperationCanceledException(token);
        }
        AssertCanRetry();
        var context = entry.WithState(state => (state.HistoryVersion, state.NextMessageSeq));
        // Existing Main ingress already publishes to this owner; join its pending save lane.
        await entry.SaveLane.SaveBestEffortAsync(token).ConfigureAwait(false);
        AssertCanRetry();
        await (retrySafePoint?.Invoke() ?? SafePointAsync()).ConfigureAwait(false);
        AssertCanRetry();
        entry.WithState(state => DeferredQueueInput.Mark(state.Queue));
        var batch = SessionTurnRunner.DrainLeading(entry);
        if (batch.Count > 0)
            await AppendQueuedInputsAsync(batch).ConfigureAwait(false);
        AssertCanRetry();
        return entry.WithState(state => (state.HistoryVersion, state.NextMessageSeq) != context);
    }

    private async Task<IReadOnlyList<JsonObject>> AppendHistoryMessageStrictAsync(
        JsonObject? message,
        JsonObject? usage = null
    )
    {
        if (message is not null && store is PersistentSessionAuthorityStore persistent)
            await persistent.Images.ExternalizeMessageAsync(message);
        var rows = await entry
            .SaveLane.CommitCanonicalAppendWithResultAsync(state =>
                PrepareCanonicalAppend(
                    state,
                    message is null ? [] : [message],
                    [],
                    updateLastMessageTime: false,
                    finalizing: false,
                    clock,
                    usage
                )
            )
            .ConfigureAwait(false);
        entry.InvokeCommitted(entry.Snapshot());
        return rows;
    }

    private static IReadOnlyList<JsonObject> ExtractFunctionCalls(JsonObject assistant)
    {
        var calls = new List<JsonObject>();
        foreach (var node in assistant["parts"] as JsonArray ?? [])
            if (node is JsonObject part && part["functionCall"] is JsonObject call)
                calls.Add((JsonObject)call.DeepClone());
        return calls;
    }

    private async Task ContinueAfterResultAsync(ChatResult result, CancellationToken token)
    {
        AssertCanContinue();
        if (beforeContinuation is not null)
        {
            await beforeContinuation(
                    result,
                    safe => AppendQueuedFollowUpsAfterToolAsync(safe),
                    token
                )
                .ConfigureAwait(false);
            return;
        }
        await AppendQueuedFollowUpsAfterToolAsync().ConfigureAwait(false);
    }

    private async Task AppendQueuedFollowUpsAfterToolAsync(Func<Task>? continuationSafePoint = null)
    {
        AssertCanContinue();
        await (continuationSafePoint?.Invoke() ?? SafePointAsync()).ConfigureAwait(false);
        AssertCanContinue();
        if (entry.WithState(state => state.Stopping || !state.Queue.Any(SessionCompactor.Ordinary)))
            return;
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        await (continuationSafePoint?.Invoke() ?? SafePointAsync()).ConfigureAwait(false);
        AssertCanContinue();
        entry.WithState(state => DeferredQueueInput.Mark(state.Queue));
        var batch = SessionTurnRunner.DrainLeading(entry);
        if (batch.Count > 0)
        {
            await AppendQueuedInputsAsync(batch).ConfigureAwait(false);
            return;
        }
    }

    public async Task ReleaseBusyAsync()
    {
        var releaseForeground = entry.CaptureForegroundRelease?.Invoke();
        var beforeBusy = false;
        long? beforeBusyStartedAt = null;
        var changed = entry.WithState(state =>
        {
            if (!state.Busy && state.BusyStartedAt is null)
                return false;
            beforeBusy = state.Busy;
            beforeBusyStartedAt = state.BusyStartedAt;
            state.Busy = false;
            state.BusyStartedAt = null;
            return true;
        });
        if (!changed)
        {
            releaseForeground?.Invoke();
            return;
        }
        Interlocked.Increment(ref releaseCommits);
        try
        {
            await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false);
        }
        catch (Exception error)
        {
            if (error is not AuthorityCommittedException)
                entry.WithState(state =>
                {
                    if (!state.Busy && state.BusyStartedAt is null)
                    {
                        state.Busy = beforeBusy;
                        state.BusyStartedAt = beforeBusyStartedAt;
                    }
                });
            throw;
        }
        releaseForeground?.Invoke();
        entry.InvokeCommitted(entry.Snapshot());
    }

    public async Task FinalizeStoppedAsync()
    {
        await SafePointAsync().ConfigureAwait(false);
        var releaseForeground = entry.CaptureForegroundRelease?.Invoke();
        var items = entry.WithState(state =>
        {
            DeferredQueueInput.Mark(state.Queue);
            return state.Queue.ToArray();
        });
        foreach (var item in items.Where(item => item.Type != QueueItemType.CompactCommit))
            SessionIngress.EnsureSupportedForRunner(item);
        await entry
            .SaveLane.CommitCanonicalAppendAsync(state =>
                PrepareQueuedAppend(state, items, finalizing: true, clock)
            )
            .ConfigureAwait(false);
        Interlocked.Increment(ref releaseCommits);
        releaseForeground?.Invoke();
        if (entry.TurnStopped is { } stopped)
            await stopped();
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    private static CanonicalAppendPreparation PrepareQueuedAppend(
        SessionState state,
        IReadOnlyList<QueueItem> selectedItems,
        bool finalizing,
        Func<long> clock
    )
    {
        var available = finalizing
            ? state.Queue.ToArray()
            : state.Queue.Where(SessionCompactor.Ordinary).ToArray();
        if (available.Length < selectedItems.Count)
            throw new InvalidOperationException("Selected queue items are no longer available.");
        for (var index = 0; index < selectedItems.Count; index++)
            if (!ReferenceEquals(available[index], selectedItems[index]))
                throw new InvalidOperationException(
                    "Selected queue identity changed before canonical append."
                );

        var rawMessages = new List<JsonObject>();
        var historyEmpty = state.History.Count == 0;
        var committedAnyInput = false;
        var updateLastMessageTime = false;
        foreach (var item in selectedItems)
        {
            if (item.Type == QueueItemType.CompactCommit)
            {
                if (!finalizing)
                    throw new UnsupportedSessionTurnException("compact");
                continue;
            }
            if (item.Message is not null)
            {
                rawMessages.Add(
                    DeferredQueueInput.Message(item, (JsonObject)item.Message.DeepClone())
                );
                committedAnyInput = true;
                continue;
            }
            if (item.Parts is null || item.Parts.Count == 0)
                continue;
            var parts = item.Parts.Select(part => (JsonObject)part.DeepClone()).ToArray();
            if (!committedAnyInput)
            {
                updateLastMessageTime = true;
                if (historyEmpty)
                    parts = new[] { SessionTag(state.Id) }.Concat(parts).ToArray();
            }
            var message = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray()),
            };
            if (item.ClientMessageId is not null)
                message["__meta"] = new JsonObject { ["clientMessageId"] = item.ClientMessageId };
            rawMessages.Add(DeferredQueueInput.Message(item, message));
            committedAnyInput = true;
        }
        return PrepareCanonicalAppend(
            state,
            rawMessages,
            selectedItems,
            updateLastMessageTime,
            finalizing,
            clock
        );
    }

    internal static CanonicalAppendPreparation PrepareCanonicalAppend(
        SessionState state,
        IReadOnlyList<JsonObject> rawMessages,
        IReadOnlyList<QueueItem> selectedItems,
        bool updateLastMessageTime,
        bool finalizing,
        Func<long> clock,
        JsonObject? usage = null
    )
    {
        var capturedNextSeq = state.NextMessageSeq;
        var capturedHistoryVersion = state.HistoryVersion;
        var canonicalMessages = new List<JsonObject>(rawMessages.Count);
        var nextSeq = capturedNextSeq;
        foreach (var rawMessage in rawMessages)
        {
            var message = (JsonObject)rawMessage.DeepClone();
            var meta = message["__meta"] switch
            {
                null => new JsonObject(),
                JsonObject value => (JsonObject)value.DeepClone(),
                _ => throw new InvalidDataException("Canonical message __meta must be an object."),
            };
            if (meta.ContainsKey("seq"))
                throw new UnsupportedSessionTurnException("caller-supplied message seq");
            if (
                !meta.ContainsKey("timestamp")
                || meta["timestamp"] is null
                || IsZeroNumber(meta["timestamp"])
            )
                meta["timestamp"] = clock();
            message["__meta"] = meta;
            meta["seq"] = nextSeq++;
            canonicalMessages.Add(message);
        }

        var appended = canonicalMessages.Select(HistoryMessage.FromJson).ToArray();
        var stagedHistory = state.History.Snapshot().Append(appended);
        var selected = new HashSet<QueueItem>(selectedItems, ReferenceEqualityComparer.Instance);
        var stagedQueue = state
            .Queue.Where(item => !selected.Contains(item))
            .Select(item => item.CloneItem())
            .ToArray();
        var stagedMeta = (JsonObject)state.Meta.DeepClone();
        var stagedEnvelope = (JsonObject)state.AuthorityEnvelope.DeepClone();
        if (usage is not null)
        {
            var stats = stagedEnvelope["stats"] as JsonObject;
            if (stats is null)
                stagedEnvelope["stats"] = stats = new JsonObject();
            foreach (
                var (total, key) in new[]
                {
                    ("totalCachedTokens", "cachedTokens"),
                    ("totalInputTokens", "inputTokens"),
                    ("totalOutputTokens", "outputTokens"),
                }
            )
                stats[total] =
                    (SessionWait.Number(stats[total]) ?? 0) + (SessionWait.Number(usage[key]) ?? 0);
            stats["lastUsage"] = usage.DeepClone();
        }
        foreach (var item in selectedItems)
            SessionBoundary.ApplyChildHandoff(stagedEnvelope, item);
        JsonNode? previousLastMessageTime = state.Meta["lastMessageTime"]?.DeepClone();
        var hadLastMessageTime = state.Meta.ContainsKey("lastMessageTime");
        if (updateLastMessageTime)
            stagedMeta["lastMessageTime"] = clock();
        stagedMeta["messageCount"] = stagedHistory.Count;
        var stagedHistoryVersion = capturedHistoryVersion;
        var staged = new SessionSnapshot(
            state.Id,
            stagedHistory,
            stagedQueue,
            finalizing ? false : state.Busy,
            finalizing ? null : state.BusyStartedAt,
            finalizing ? false : state.Stopping,
            stagedMeta,
            nextSeq,
            stagedHistoryVersion,
            stagedEnvelope
        );

        return new CanonicalAppendPreparation(
            staged,
            canonicalMessages,
            live =>
            {
                if (
                    live.NextMessageSeq != capturedNextSeq
                    || live.HistoryVersion != capturedHistoryVersion
                )
                    throw new InvalidOperationException(
                        "Canonical append base changed before publish."
                    );
                if (
                    selectedItems.Any(item =>
                        !live.Queue.Any(current => ReferenceEquals(current, item))
                    )
                )
                    throw new InvalidOperationException(
                        "Selected queue items disappeared before publish."
                    );
                live.Queue.RemoveAll(item => selected.Contains(item));
                live.History.AddRange(appended);
                live.NextMessageSeq = nextSeq;
                live.HistoryVersion = stagedHistoryVersion;
                live.Meta["messageCount"] = live.History.Count;
                if (usage is not null)
                    live.AuthorityEnvelope["stats"] = stagedEnvelope["stats"]!.DeepClone();
                if (stagedEnvelope["childHandoffState"] is null)
                    live.AuthorityEnvelope.Remove("childHandoffState");
                else
                    live.AuthorityEnvelope["childHandoffState"] = stagedEnvelope[
                        "childHandoffState"
                    ]!.DeepClone();
                if (
                    updateLastMessageTime
                    && live.Meta.ContainsKey("lastMessageTime") == hadLastMessageTime
                    && JsonNode.DeepEquals(live.Meta["lastMessageTime"], previousLastMessageTime)
                )
                    live.Meta["lastMessageTime"] = stagedMeta["lastMessageTime"]?.DeepClone();
                if (finalizing)
                {
                    live.Busy = false;
                    live.BusyStartedAt = null;
                    live.Stopping = false;
                }
            }
        );
    }

    private static bool IsZeroNumber(JsonNode? node)
    {
        if (node is not JsonValue value)
            return false;
        if (value.TryGetValue<double>(out var floating))
            return floating == 0;
        if (value.TryGetValue<long>(out var signed))
            return signed == 0;
        if (value.TryGetValue<int>(out var integer))
            return integer == 0;
        if (value.TryGetValue<decimal>(out var decimalValue))
            return decimalValue == 0;
        return false;
    }

    private static JsonObject SessionTag(string sessionId) =>
        new()
        {
            ["system"] =
                $"<foxwarm-system kind=\"session\" currentSessionId=\"{EscapeFoxwarmAttribute(sessionId)}\" />",
        };

    internal static string EscapeFoxwarmAttribute(string value)
    {
        var normalized = new string(
            value
                .Replace("\r\n", "\n", StringComparison.Ordinal)
                .Replace('\r', '\n')
                .Select(character =>
                    character switch
                    {
                        >= '\u0000'
                        and <= '\u0008'
                        or '\u000B'
                        or '\u000C'
                        or >= '\u000E'
                        and <= '\u001F'
                        or '\u007F' => ' ',
                        '\n' => ' ',
                        _ => character,
                    }
                )
                .ToArray()
        );
        var collapsed = new StringBuilder(normalized.Length);
        var pendingWhitespace = false;
        foreach (var character in normalized)
        {
            if (IsEcmaWhitespace(character))
            {
                pendingWhitespace = collapsed.Length > 0;
                continue;
            }
            if (pendingWhitespace)
                collapsed.Append(' ');
            collapsed.Append(character);
            pendingWhitespace = false;
        }
        normalized = collapsed.ToString();
        return normalized
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
    }

    private static bool IsEcmaWhitespace(char character) =>
        character
            is '\u0009'
                or '\u000A'
                or '\u000B'
                or '\u000C'
                or '\u000D'
                or '\u0020'
                or '\u00A0'
                or '\u1680'
                or '\u2028'
                or '\u2029'
                or '\u202F'
                or '\u205F'
                or '\u3000'
                or '\uFEFF'
        || character is >= '\u2000' and <= '\u200A';
}
