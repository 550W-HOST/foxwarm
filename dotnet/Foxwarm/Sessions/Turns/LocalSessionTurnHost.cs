using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

public sealed class LocalSessionTurnHost
{
    private readonly SessionEntry entry;
    private readonly IChatService chat;
    private readonly ITurnToolExecutor tools;
    private readonly int maxToolIterations;
    private readonly Func<long> clock;
    private int releaseCommits;

    public LocalSessionTurnHost(
        SessionEntry entry,
        ISessionAuthorityStore store,
        IChatService chat,
        ITurnToolExecutor? tools = null,
        int maxToolIterations = 500,
        Func<long>? clock = null)
    {
        this.entry = entry;
        this.chat = chat;
        this.tools = tools ?? new UnsupportedTurnToolExecutor();
        this.maxToolIterations = maxToolIterations > 0 ? maxToolIterations : throw new ArgumentOutOfRangeException(nameof(maxToolIterations));
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public int ReleaseCommitCount => Volatile.Read(ref releaseCommits);

    public async Task<bool> TryClaimBusyAsync()
    {
        var version = entry.MarkBusy();
        if (version == 0) return false;
        try
        {
            await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false);
            return true;
        }
        catch (Exception error)
        {
            if (error is not AuthorityCommittedException) entry.RollbackBusy(version);
            throw;
        }
    }

    public async Task AppendQueuedInputsAsync(IReadOnlyList<QueueItem> items)
    {
        if (items.Count == 0) return;
        foreach (var item in items) SessionIngress.EnsureSupportedForRunner(item);
        await entry.SaveLane.CommitCanonicalAppendAsync(state => PrepareQueuedAppend(state, items, finalizing: false, clock)).ConfigureAwait(false);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    public async Task<ChatResult> ChatAsync(string turnId)
    {
        var requestCts = new CancellationTokenSource();
        CancellationHandle? handle = null;
        try
        {
            handle = entry.RegisterCancellation(requestCts);
            var registered = handle ?? throw new InvalidOperationException("Cancellation registration was not created.");
            if (tools is ITurnToolControl control) control.BeginTurn();
            for (var iteration = 0; iteration < maxToolIterations; iteration++)
            {
                registered.Token.ThrowIfCancellationRequested();
                await entry.SaveLane.AppendGoalReminderAsync(registered.Token).ConfigureAwait(false);
                registered.Token.ThrowIfCancellationRequested();
                var history = entry.WithState(state => state.History.Select(m => (JsonObject)m.DeepClone()).ToArray());
                var result = await chat.ChatAsync(entry.State.Id, history, registered.Token).ConfigureAwait(false);
                if (result.AssistantMessage is null) return result;
                var assistant = (JsonObject)result.AssistantMessage.DeepClone();
                if (assistant["role"]?.GetValue<string>() != "model" || assistant["parts"] is not JsonArray)
                    throw new InvalidOperationException("Chat result assistant message must be a canonical model message.");
                await AppendHistoryMessageStrictAsync(assistant).ConfigureAwait(false);

                var calls = ExtractFunctionCalls(assistant);
                if (calls.Count == 0) return result;

                var toolParts = new JsonArray();
                foreach (var planned in ToolCallControls.Plan(calls))
                {
                    var call = planned.Call;
                    var callId = call["id"]?.GetValue<string>()
                        ?? throw new InvalidOperationException("Canonical function call is missing its stable ID.");
                    var name = call["name"]?.GetValue<string>() ?? "";
                    JsonObject response;
                    if (registered.Token.IsCancellationRequested)
                        response = new JsonObject { ["canceled"] = true, ["message"] = "Tool call canceled before execution." };
                    else if (planned.Preset is JsonObject preset) response = preset;
                    else if (call["argsParseError"] is JsonValue parseErrorValue
                        && parseErrorValue.TryGetValue<string>(out var parseError)
                        && parseError.Length > 0)
                    {
                        response = UnsupportedTurnToolExecutor.ToolError("invalid_tool_arguments", parseError);
                    }
                    else
                    {
                        try { response = await tools.ExecuteAsync((JsonObject)call.DeepClone(), registered.Token).ConfigureAwait(false); }
                        catch (OperationCanceledException)
                        { response = UnsupportedTurnToolExecutor.ToolError("tool_call_cancelled", "Tool request canceled. Started effects may have occurred and were not reversed."); }
                    }
                    toolParts.Add(new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = callId,
                            ["name"] = name,
                            ["response"] = response.DeepClone()
                        }
                    });
                }

                if (toolParts.FirstOrDefault()?["functionResponse"] is JsonObject firstResponse
                    && assistant["__meta"]?["llmRequestTiming"] is JsonObject timing
                    && SessionWait.Number(timing["completedAt"]) is double completedAt && double.IsFinite(completedAt)
                    && completedAt >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds() && completedAt <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
                    && SessionWait.Number(timing["durationMs"]) is double duration && double.IsFinite(duration))
                    firstResponse["previousLlmRequest"] = new JsonObject { ["time"] = ArchiveBlockRecord.LocalTimestamp(completedAt), ["durationMs"] = duration };
                var toolMessage = new JsonObject { ["role"] = "tool", ["parts"] = toolParts };
                await AppendHistoryMessageStrictAsync(toolMessage).ConfigureAwait(false);
                var stopping = entry.WithState(state => state.Stopping);
                var terminal = tools is ITurnToolControl turnControl && await turnControl.CompleteBatchAsync(toolMessage, stopping).ConfigureAwait(false);
                if (stopping) throw new OperationCanceledException(registered.Token);
                if (terminal) return result;
                await AppendQueuedFollowUpsAfterToolAsync().ConfigureAwait(false);
                if (iteration + 1 >= maxToolIterations) throw new ToolLoopLimitException(maxToolIterations);
            }
            throw new ToolLoopLimitException(maxToolIterations);
        }
        finally
        {
            if (handle is not null) entry.ClearCancellation(handle);
            else requestCts.Dispose();
        }
    }

    private async Task AppendHistoryMessageStrictAsync(JsonObject message)
    {
        await entry.SaveLane.CommitCanonicalAppendAsync(state =>
            PrepareCanonicalAppend(state, [message], [], updateLastMessageTime: false, finalizing: false, clock)).ConfigureAwait(false);
        entry.InvokeCommitted(entry.Snapshot());
    }

    private static IReadOnlyList<JsonObject> ExtractFunctionCalls(JsonObject assistant)
    {
        var calls = new List<JsonObject>();
        foreach (var node in assistant["parts"] as JsonArray ?? [])
            if (node is JsonObject part && part["functionCall"] is JsonObject call)
                calls.Add((JsonObject)call.DeepClone());
        return calls;
    }

    private async Task AppendQueuedFollowUpsAfterToolAsync()
    {
        if (entry.WithState(state => state.Stopping || state.Queue.Count == 0)) return;
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        var batch = SessionTurnRunner.DrainLeading(entry);
        if (batch.Count > 0)
        {
            await AppendQueuedInputsAsync(batch).ConfigureAwait(false);
            return;
        }
        var remainingHead = entry.WithState(state => state.Queue.FirstOrDefault()?.CloneItem());
        if (remainingHead is not null) SessionIngress.EnsureSupportedForRunner(remainingHead);
    }

    public async Task ReleaseBusyAsync()
    {
        var beforeBusy = false;
        long? beforeBusyStartedAt = null;
        var changed = entry.WithState(state =>
        {
            if (!state.Busy && state.BusyStartedAt is null) return false;
            beforeBusy = state.Busy;
            beforeBusyStartedAt = state.BusyStartedAt;
            state.Busy = false;
            state.BusyStartedAt = null;
            return true;
        });
        if (!changed) return;
        Interlocked.Increment(ref releaseCommits);
        try { await entry.SaveLane.SaveStrictAsync().ConfigureAwait(false); }
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
        entry.InvokeCommitted(entry.Snapshot());
    }

    public async Task FinalizeStoppedAsync()
    {
        var items = entry.WithState(state => state.Queue.ToArray());
        foreach (var item in items.Where(item => item.Type != QueueItemType.CompactCommit)) SessionIngress.EnsureSupportedForRunner(item);
        await entry.SaveLane.CommitCanonicalAppendAsync(state => PrepareQueuedAppend(state, items, finalizing: true, clock)).ConfigureAwait(false);
        Interlocked.Increment(ref releaseCommits);
        entry.InvokeQueuedCommitted(entry.Snapshot());
    }

    private static CanonicalAppendPreparation PrepareQueuedAppend(
        SessionState state,
        IReadOnlyList<QueueItem> selectedItems,
        bool finalizing,
        Func<long> clock)
    {
        if (state.Queue.Count < selectedItems.Count) throw new InvalidOperationException("Selected queue items are no longer available.");
        for (var index = 0; index < selectedItems.Count; index++)
            if (!ReferenceEquals(state.Queue[index], selectedItems[index]))
                throw new InvalidOperationException("Selected queue identity changed before canonical append.");

        var rawMessages = new List<JsonObject>();
        var historyEmpty = state.History.Count == 0;
        var committedAnyInput = false;
        var updateLastMessageTime = false;
        foreach (var item in selectedItems)
        {
            if (item.Type == QueueItemType.CompactCommit)
            {
                if (!finalizing) throw new UnsupportedSessionTurnException("compact");
                continue;
            }
            if (item.Message is not null)
            {
                rawMessages.Add((JsonObject)item.Message.DeepClone());
                committedAnyInput = true;
                continue;
            }
            if (item.Parts is null || item.Parts.Count == 0) continue;
            var parts = item.Parts.Select(part => (JsonObject)part.DeepClone()).ToArray();
            if (!committedAnyInput)
            {
                updateLastMessageTime = true;
                if (historyEmpty) parts = new[] { SessionTag(state.Id) }.Concat(parts).ToArray();
            }
            var message = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray())
            };
            if (item.ClientMessageId is not null) message["__meta"] = new JsonObject { ["clientMessageId"] = item.ClientMessageId };
            rawMessages.Add(message);
            committedAnyInput = true;
        }
        return PrepareCanonicalAppend(state, rawMessages, selectedItems, updateLastMessageTime, finalizing, clock);
    }

    private static CanonicalAppendPreparation PrepareCanonicalAppend(
        SessionState state,
        IReadOnlyList<JsonObject> rawMessages,
        IReadOnlyList<QueueItem> selectedItems,
        bool updateLastMessageTime,
        bool finalizing,
        Func<long> clock)
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
                _ => throw new InvalidDataException("Canonical message __meta must be an object.")
            };
            if (meta.ContainsKey("seq")) throw new UnsupportedSessionTurnException("caller-supplied message seq");
            if (!meta.ContainsKey("timestamp") || meta["timestamp"] is null || IsZeroNumber(meta["timestamp"]))
                meta["timestamp"] = clock();
            message["__meta"] = meta;
            meta["seq"] = nextSeq++;
            canonicalMessages.Add(message);
        }

        var stagedHistory = state.History.Select(message => (JsonObject)message.DeepClone()).ToList();
        stagedHistory.AddRange(canonicalMessages.Select(message => (JsonObject)message.DeepClone()));
        var stagedQueue = state.Queue.Skip(selectedItems.Count).Select(item => item.CloneItem()).ToArray();
        var stagedMeta = (JsonObject)state.Meta.DeepClone();
        JsonNode? previousLastMessageTime = state.Meta["lastMessageTime"]?.DeepClone();
        var hadLastMessageTime = state.Meta.ContainsKey("lastMessageTime");
        if (updateLastMessageTime) stagedMeta["lastMessageTime"] = clock();
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
            (JsonObject)state.AuthorityEnvelope.DeepClone());

        return new CanonicalAppendPreparation(staged, canonicalMessages, live =>
        {
            if (live.NextMessageSeq != capturedNextSeq || live.HistoryVersion != capturedHistoryVersion)
                throw new InvalidOperationException("Canonical append base changed before publish.");
            if (live.Queue.Count < selectedItems.Count) throw new InvalidOperationException("Selected queue items disappeared before publish.");
            for (var index = 0; index < selectedItems.Count; index++)
                if (!ReferenceEquals(live.Queue[index], selectedItems[index]))
                    throw new InvalidOperationException("Selected queue identity changed before publish.");
            live.Queue.RemoveRange(0, selectedItems.Count);
            live.History.AddRange(canonicalMessages);
            live.NextMessageSeq = nextSeq;
            live.HistoryVersion = stagedHistoryVersion;
            live.Meta["messageCount"] = live.History.Count;
            if (updateLastMessageTime
                && live.Meta.ContainsKey("lastMessageTime") == hadLastMessageTime
                && JsonNode.DeepEquals(live.Meta["lastMessageTime"], previousLastMessageTime))
                live.Meta["lastMessageTime"] = stagedMeta["lastMessageTime"]?.DeepClone();
            if (finalizing)
            {
                live.Busy = false;
                live.BusyStartedAt = null;
                live.Stopping = false;
            }
        });
    }

    private static bool IsZeroNumber(JsonNode? node)
    {
        if (node is not JsonValue value) return false;
        if (value.TryGetValue<double>(out var floating)) return floating == 0;
        if (value.TryGetValue<long>(out var signed)) return signed == 0;
        if (value.TryGetValue<int>(out var integer)) return integer == 0;
        if (value.TryGetValue<decimal>(out var decimalValue)) return decimalValue == 0;
        return false;
    }

    private static JsonObject SessionTag(string sessionId) => new()
    {
        ["system"] = $"<foxwarm-system kind=\"session\" currentSessionId=\"{EscapeFoxwarmAttribute(sessionId)}\" />"
    };

    private static string EscapeFoxwarmAttribute(string value)
    {
        var normalized = new string(value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Select(character => character switch
            {
                >= '\u0000' and <= '\u0008' or '\u000B' or '\u000C' or >= '\u000E' and <= '\u001F' or '\u007F' => ' ',
                '\n' => ' ',
                _ => character,
            }).ToArray());
        var collapsed = new StringBuilder(normalized.Length);
        var pendingWhitespace = false;
        foreach (var character in normalized)
        {
            if (IsEcmaWhitespace(character))
            {
                pendingWhitespace = collapsed.Length > 0;
                continue;
            }
            if (pendingWhitespace) collapsed.Append(' ');
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

    private static bool IsEcmaWhitespace(char character) => character is
        '\u0009' or '\u000A' or '\u000B' or '\u000C' or '\u000D' or '\u0020' or '\u00A0' or
        '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' ||
        character is >= '\u2000' and <= '\u200A';

}
