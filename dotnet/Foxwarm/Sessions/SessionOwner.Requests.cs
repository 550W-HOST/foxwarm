using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionOwner
{
    internal string LogicalTurnId { get; private set; } = Guid.NewGuid().ToString();

    internal void BeginLogicalTurn() => LogicalTurnId = Guid.NewGuid().ToString();

    private readonly object draftGate = new();
    private JsonObject? draft;
    private JsonObject? emittedDraft;
    private ResponsesStreamProgress? latestDraftProgress;
    private ITimer? draftTimer;
    private ITimer? toolArgsTimer;
    private long lastDraftSent;
    private long lastToolArgsSent;
    private readonly TimeProvider draftClock;
    private static readonly TimeSpan DraftInterval = TimeSpan.FromMilliseconds(80);
    private static readonly TimeSpan ToolArgsInterval = TimeSpan.FromSeconds(1);
    private int activeTools;
    public bool ToolActive => Volatile.Read(ref activeTools) > 0;
    private object? compactPhase;
    public bool Compacting => Volatile.Read(ref compactPhase) is not null;

    public object BeginCompactPhase()
    {
        var lease = new JsonObject
        {
            ["state"] = "requesting-model",
            ["since"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["active"] = new JsonObject { ["phase"] = "compaction" },
        };
        lock (runtimeGate)
            foregroundRuntime = lease;
        Interlocked.Exchange(ref compactPhase, lease);
        PublishStateChanged();
        return lease;
    }

    public void EndCompactPhase(object lease)
    {
        if (!ReferenceEquals(Interlocked.CompareExchange(ref compactPhase, null, lease), lease))
            return;
        lock (runtimeGate)
            if (ReferenceEquals(foregroundRuntime, lease))
                foregroundRuntime = null;
        PublishStateChanged();
    }

    internal async Task<JsonObject> UpdateCwdAsync(
        string? value,
        bool preserveWhitespace = false,
        Func<bool>? condition = null
    )
    {
        var change = await Entry.SaveLane.CommitCwdAsync(value, preserveWhitespace, condition);
        return new JsonObject
        {
            ["success"] = true,
            ["changed"] = change.Changed,
            ["previous"] = change.Previous,
            ["cwd"] = change.Current,
        };
    }

    public Task<JsonObject> UpdateModelAsync(JsonObject patch) =>
        UpdateSettingsAsync(patch, child: false);

    public async Task<JsonObject> UpdateSettingsAsync(JsonObject patch, bool child)
    {
        var allowed = child
            ? new[] { "model", "clear", "childEffortDefault" }
            : ["model", "clear", "effort"];
        if (patch.Count == 0 || patch.Any(pair => !allowed.Contains(pair.Key)))
            throw new InvalidDataException("Unsupported model settings.");
        var clear = patch["clear"]?.GetValue<bool>() == true;
        if (clear && patch.ContainsKey("model"))
            throw new InvalidDataException("clear=true cannot be combined with model.");
        var normalized = new JsonObject();
        if (clear || patch.ContainsKey("model"))
            normalized[child ? "childModelDefault" : "model"] = clear
                ? null
                : patch["model"]?.DeepClone();
        var effortKey = child ? "childEffortDefault" : "effort";
        if (patch.ContainsKey(effortKey))
            normalized[effortKey] = patch[effortKey]?.DeepClone();
        if (normalized.Count == 0)
            throw new InvalidDataException("model and/or effort is required.");
        await Entry.SaveLane.CommitSettingsAsync(normalized, models);
        var status = BuildDto();
        status["success"] = true;
        status["sessionId"] = Id;
        return status;
    }

    internal void RestartDraft()
    {
        string? requestId;
        lock (draftGate)
            requestId = SessionWait.Text(draft?["llmRequestId"]);
        BeginDraft(requestId);
    }

    public JsonObject DraftSnapshot()
    {
        lock (draftGate)
            return draft is null ? new JsonObject() : (JsonObject)draft.DeepClone();
    }

    public string BeginDraft(string? outerRequestId = null)
    {
        var requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        JsonObject payload;
        lock (draftGate)
        {
            FlushDraftLocked();
            draft = new JsonObject
            {
                ["streamId"] = requestId,
                ["iteration"] = 1,
                ["sequence"] = 0,
                ["startedAt"] = startedAt,
                ["llmRequestId"] = outerRequestId ?? requestId,
                ["text"] = "",
                ["reasoning"] = "",
                ["toolCalls"] = new JsonArray(),
            };
            latestDraftProgress = new ResponsesStreamProgress("", "", []);
            emittedDraft = (JsonObject)draft.DeepClone();
            lastDraftSent = lastToolArgsSent = draftClock.GetTimestamp();
            payload = new JsonObject
            {
                ["type"] = "model-stream-reset",
                ["streamVersion"] = 2,
                ["streamId"] = requestId,
                ["iteration"] = 1,
                ["sequenceStart"] = 0,
                ["sequence"] = 0,
                ["startedAt"] = startedAt,
                ["llmRequestId"] = outerRequestId ?? requestId,
            };
            Emit(SessionEventKind.ModelStream, payload);
        }
        return requestId;
    }

    public void PublishDraftProgress(ResponsesStreamProgress progress)
    {
        lock (draftGate)
        {
            if (draft is null)
                return;
            if (draft["committedThrough"]?.GetValue<int>() is int through && progress.Parts is not null)
                progress = ProjectDraft(progress, through);
            latestDraftProgress = progress;
            draft["text"] = progress.Text;
            draft["reasoning"] = progress.Reasoning;
            draft["toolCalls"] = new JsonArray(progress.ToolCalls.Select(call => (JsonNode?)new JsonObject
            {
                ["index"] = call.Index,
                ["id"] = call.Id,
                ["name"] = call.Name,
                ["arguments"] = call.Arguments ?? "",
            }).ToArray());
            if (progress.Parts is not null)
                draft["parts"] = new JsonArray(progress.Parts.Select(part => (JsonNode?)PartObject(part)).ToArray());
            var delay = DraftInterval - draftClock.GetElapsedTime(lastDraftSent);
            if (delay <= TimeSpan.Zero)
                NotifyDraftLocked(forceToolArgs: false);
            else
                ScheduleDraftLocked(arguments: false, delay);
            ScheduleToolArgsLocked();
        }
    }

    private void NotifyDraftLocked(bool forceToolArgs)
    {
        if (draft is null || emittedDraft is null || latestDraftProgress is not { } progress)
            return;
        var toolArgsDue = forceToolArgs || draftClock.GetElapsedTime(lastToolArgsSent) >= ToolArgsInterval;
            var previousText = emittedDraft!["text"]?.GetValue<string>() ?? "";
            var previousReasoning = emittedDraft!["reasoning"]?.GetValue<string>() ?? "";
            var hasParts = progress.Parts is not null || emittedDraft!["parts"] is JsonArray;
            var previousParts = (emittedDraft!["parts"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>()
                .ToDictionary(PartKey);
            var newCalls = new JsonArray();
            var deltas = new JsonArray();
            var newParts = new JsonArray();
            var partDeltas = new JsonArray();
            var oldCalls = (emittedDraft!["toolCalls"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>()
                .ToDictionary(item => item["index"]!.GetValue<int>());
            foreach (var call in progress.ToolCalls)
            {
                oldCalls.TryGetValue(call.Index, out var old);
                var oldArgs = old?["arguments"]?.GetValue<string>() ?? "";
                var nextArgs = toolArgsDue ? call.Arguments ?? "" : oldArgs;
                var oldId = old?["id"]?.GetValue<string>();
                var oldName = old?["name"]?.GetValue<string>();
                var entry = new JsonObject { ["index"] = call.Index, ["arguments"] = nextArgs };
                if (call.Id is not null)
                    entry["id"] = call.Id;
                if (call.Name is not null)
                    entry["name"] = call.Name;
                newCalls.Add(entry);
                if (old is null || oldArgs != nextArgs || oldId != call.Id || oldName != call.Name)
                {
                    var delta = new JsonObject { ["index"] = call.Index };
                    if (call.Id is not null)
                        delta["id"] = call.Id;
                    if (call.Name is not null)
                        delta["name"] = call.Name;
                    if (oldArgs != nextArgs)
                        delta["argumentsDelta"] = new JsonObject
                        {
                            ["offset"] = nextArgs.StartsWith(oldArgs, StringComparison.Ordinal)
                                ? oldArgs.Length
                                : 0,
                            ["text"] = nextArgs.StartsWith(oldArgs, StringComparison.Ordinal)
                                ? nextArgs[oldArgs.Length..]
                                : nextArgs,
                        };
                    deltas.Add(delta);
                }
            }
            foreach (var part in progress.Parts ?? [])
            {
                var next = PartObject(part);
                newParts.Add(next);
                var key = PartKey(next);
                previousParts.TryGetValue(key, out var old);
                var oldText = old?["text"]?.GetValue<string>() ?? "";
                var nextText = next["text"]?.GetValue<string>() ?? "";
                var delta = new JsonObject
                {
                    ["outputIndex"] = part.OutputIndex,
                    ["kind"] = part.Kind,
                };
                if (part.ContentIndex is not null)
                    delta["contentIndex"] = part.ContentIndex;
                if (part.SummaryIndex is not null)
                    delta["summaryIndex"] = part.SummaryIndex;
                if (part.Phase is not null && part.Phase != old?["phase"]?.GetValue<string>())
                    delta["phase"] = part.Phase;
                if (old is null)
                    delta["added"] = true;
                if (part.Status is not null && part.Status != old?["status"]?.GetValue<string>())
                    delta["status"] = part.Status;
                if (part.Text is not null && oldText != nextText)
                    delta["textDelta"] = Delta(oldText, nextText);
                if (
                    old is null
                    || delta.Count
                        > 2
                            + (part.ContentIndex is null ? 0 : 1)
                            + (part.SummaryIndex is null ? 0 : 1)
                )
                    partDeltas.Add(delta);
            }
            var changed =
                previousText != progress.Text
                || previousReasoning != progress.Reasoning
                || deltas.Count > 0
                || partDeltas.Count > 0;
            if (!changed)
                return;
            var textDelta =
                previousText != progress.Text ? Delta(previousText, progress.Text) : null;
            var reasoningDelta =
                previousReasoning != progress.Reasoning
                    ? Delta(previousReasoning, progress.Reasoning)
                    : null;
            var nextSequence = emittedDraft!["sequence"]!.GetValue<int>() + 1;
            draft!["sequence"] = nextSequence;
            emittedDraft!["sequence"] = nextSequence;
            emittedDraft["text"] = progress.Text;
            emittedDraft["reasoning"] = progress.Reasoning;
            emittedDraft["toolCalls"] = newCalls;
            if (hasParts)
                emittedDraft["parts"] = newParts;
            var update = new JsonObject
            {
                ["type"] = "model-stream-update",
                ["streamVersion"] = 2,
                ["streamId"] = emittedDraft!["streamId"]!.GetValue<string>(),
                ["iteration"] = 1,
                ["sequenceStart"] = nextSequence,
                ["sequence"] = nextSequence,
                ["startedAt"] = emittedDraft!["startedAt"]!.GetValue<long>(),
                ["llmRequestId"] = emittedDraft!["llmRequestId"]!.GetValue<string>(),
            };
            if (textDelta is not null)
                update["textDelta"] = textDelta;
            if (reasoningDelta is not null)
                update["reasoningDelta"] = reasoningDelta;
            if (deltas.Count > 0)
                update["toolCallDeltas"] = deltas;
            if (partDeltas.Count > 0)
                update["partDeltas"] = partDeltas;
            lastDraftSent = draftClock.GetTimestamp();
            if (deltas.OfType<JsonObject>().Any(delta => delta.ContainsKey("argumentsDelta")))
                lastToolArgsSent = lastDraftSent;
            Emit(SessionEventKind.ModelStream, update);
    }

    private void ScheduleToolArgsLocked()
    {
        if (draft is null || emittedDraft is null)
            return;
        var sent = (emittedDraft["toolCalls"] as JsonArray ?? []).OfType<JsonObject>()
            .ToDictionary(call => call["index"]!.GetValue<int>());
        if ((draft["toolCalls"] as JsonArray ?? []).OfType<JsonObject>().Any(call =>
            (SessionWait.Text(call["arguments"]) ?? "") != (SessionWait.Text(sent.GetValueOrDefault(call["index"]!.GetValue<int>())?["arguments"]) ?? "")))
            ScheduleDraftLocked(arguments: true, ToolArgsInterval - draftClock.GetElapsedTime(lastToolArgsSent));
    }

    private void ScheduleDraftLocked(bool arguments, TimeSpan delay)
    {
        if ((arguments ? toolArgsTimer : draftTimer) is not null)
            return;
        var expected = draft;
        ITimer timer = null!;
        timer = draftClock.CreateTimer(_ =>
        {
            lock (draftGate)
            {
                if (!ReferenceEquals(draft, expected) || !ReferenceEquals(arguments ? toolArgsTimer : draftTimer, timer))
                    return;
                timer.Dispose();
                if (arguments) toolArgsTimer = null;
                else draftTimer = null;
                NotifyDraftLocked(forceToolArgs: false);
                ScheduleToolArgsLocked();
            }
        }, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        if (arguments) toolArgsTimer = timer;
        else draftTimer = timer;
        timer.Change(delay > TimeSpan.Zero ? delay : TimeSpan.Zero, Timeout.InfiniteTimeSpan);
    }

    private void FlushDraftLocked()
    {
        draftTimer?.Dispose();
        toolArgsTimer?.Dispose();
        draftTimer = toolArgsTimer = null;
        NotifyDraftLocked(forceToolArgs: true);
    }

    internal void FlushDraft()
    {
        lock (draftGate)
            FlushDraftLocked();
    }

    private static JsonObject Delta(string oldText, string newText) =>
        new()
        {
            ["offset"] = newText.StartsWith(oldText, StringComparison.Ordinal) ? oldText.Length : 0,
            ["text"] = newText.StartsWith(oldText, StringComparison.Ordinal)
                ? newText[oldText.Length..]
                : newText,
        };

    private static string PartKey(JsonObject part) =>
        string.Join(
            ":",
            part["outputIndex"]?.GetValue<int>(),
            part["kind"]?.GetValue<string>(),
            part["contentIndex"]
                ?.GetValue<int>()
                .ToString(System.Globalization.CultureInfo.InvariantCulture)
                ?? "",
            part["summaryIndex"]
                ?.GetValue<int>()
                .ToString(System.Globalization.CultureInfo.InvariantCulture)
                ?? ""
        );

    private static JsonObject PartObject(ResponsesStreamPart part)
    {
        var result = new JsonObject { ["outputIndex"] = part.OutputIndex, ["kind"] = part.Kind };
        if (part.ContentIndex is not null)
            result["contentIndex"] = part.ContentIndex;
        if (part.SummaryIndex is not null)
            result["summaryIndex"] = part.SummaryIndex;
        if (part.Phase is not null)
            result["phase"] = part.Phase;
        if (part.Text is not null)
            result["text"] = part.Text;
        if (part.Status is not null)
            result["status"] = part.Status;
        return result;
    }

    private static ResponsesStreamProgress ProjectDraft(
        ResponsesStreamProgress progress,
        int through
    )
    {
        var parts = (progress.Parts ?? []).Where(part => part.OutputIndex >= through).ToArray();
        return new ResponsesStreamProgress(
            string.Join(
                "\n",
                parts
                    .Where(part => part.Kind == "reasoning")
                    .Select(part => part.Text)
                    .Where(text => !string.IsNullOrEmpty(text))
            ),
            string.Concat(
                parts.Where(part => part.Kind is "text" or "refusal").Select(part => part.Text)
            ),
            progress.ToolCalls.Where(call => call.Index >= through).ToArray(),
            parts
        );
    }

    private void TrimCommittedDraft(JsonObject message, int through)
    {
        JsonObject? envelope = null;
        lock (draftGate)
        {
            if (
                draft is null
                || SessionWait.Text(draft["llmRequestId"])
                    != SessionWait.Text(message["__meta"]?["llmRequestId"])
            )
                return;
            FlushDraftLocked();
            var parts = (draft["parts"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Where(part => part["outputIndex"]!.GetValue<int>() >= through)
                .ToArray();
            var text = string.Concat(
                parts
                    .Where(part => SessionWait.Text(part["kind"]) is "text" or "refusal")
                    .Select(part => SessionWait.Text(part["text"]))
            );
            var reasoning = string.Join(
                "\n",
                parts
                    .Where(part => SessionWait.Text(part["kind"]) == "reasoning")
                    .Select(part => SessionWait.Text(part["text"]))
                    .Where(value => !string.IsNullOrEmpty(value))
            );
            var sequence = draft["sequence"]!.GetValue<int>() + 1;
            envelope = new JsonObject
            {
                ["type"] = "model-stream-update",
                ["streamVersion"] = 2,
                ["streamId"] = draft["streamId"]!.DeepClone(),
                ["iteration"] = 1,
                ["sequenceStart"] = sequence,
                ["sequence"] = sequence,
                ["startedAt"] = draft["startedAt"]!.DeepClone(),
                ["llmRequestId"] = draft["llmRequestId"]!.DeepClone(),
                ["trimBeforeOutputIndex"] = through,
                ["textDelta"] = Delta(SessionWait.Text(draft["text"]) ?? "", text),
                ["reasoningDelta"] = Delta(SessionWait.Text(draft["reasoning"]) ?? "", reasoning),
            };
            draft["sequence"] = sequence;
            draft["committedThrough"] = through;
            draft["text"] = text;
            draft["reasoning"] = reasoning;
            draft["parts"] = new JsonArray(parts.Select(part => part.DeepClone()).ToArray());
            draft["toolCalls"] = new JsonArray(
                (draft["toolCalls"] as JsonArray ?? [])
                    .OfType<JsonObject>()
                    .Where(call => call["index"]!.GetValue<int>() >= through)
                    .Select(call => call.DeepClone())
                    .ToArray()
            );
            latestDraftProgress = ProjectDraft(latestDraftProgress!, through);
            emittedDraft = (JsonObject)draft.DeepClone();
            Emit(SessionEventKind.ModelStream, envelope);
            Emit(SessionEventKind.DraftChanged);
        }
    }

    public void ClearCommittedDraft(JsonObject message)
    {
        if (
            message["__meta"]?["llmSegment"] is JsonObject segment
            && segment["complete"]?.GetValue<bool>() == false
        )
        {
            TrimCommittedDraft(message, segment["outputEndExclusive"]!.GetValue<int>());
            return;
        }
        var requestId = message["__meta"]?["llmRequestId"]?.GetValue<string>();
        if (requestId is null)
            return;
        lock (draftGate)
        {
            if (draft?["llmRequestId"]?.GetValue<string>() != requestId)
                return;
            FlushDraftLocked();
            draft = emittedDraft = null;
            latestDraftProgress = null;
            Emit(SessionEventKind.DraftChanged);
        }
    }

    public void ClearDraft()
    {
        lock (draftGate)
        {
            if (draft is null)
                return;
            FlushDraftLocked();
            draft = emittedDraft = null;
            latestDraftProgress = null;
            Emit(SessionEventKind.DraftChanged);
        }
    }

    internal object BeginTool(JsonObject? details = null)
    {
        var projection = new JsonObject
        {
            ["state"] = "running-tool",
            ["since"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["tool"] = details?.DeepClone(),
        };
        Interlocked.Increment(ref activeTools);
        lock (runtimeGate)
            foregroundRuntime = projection;
        try
        {
            PublishStateChanged();
        }
        catch
        {
            EndTool(projection);
            throw;
        }
        return projection;
    }

    internal void EndTool(object? lease = null)
    {
        Interlocked.Decrement(ref activeTools);
        lock (runtimeGate)
            if (lease is null || ReferenceEquals(foregroundRuntime, lease))
                foregroundRuntime = null;
        PublishStateChanged();
    }
}

internal sealed class RequestChatService(IChatService inner, SessionOwner hosted)
    : ISessionChatService
{
    public Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    ) => ChatCoreAsync(sessionId, history, null, cancellationToken);

    public Task<ChatResult> ChatAsync(
        string sessionId,
        SessionHistory history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        CancellationToken cancellationToken
    ) => ChatCoreAsync(sessionId, null, prepareRetry, cancellationToken, history);

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
            null,
            prepareRetry,
            cancellationToken,
            history,
            commitAssistantSegment,
            iteration
        );

    private async Task<ChatResult> ChatCoreAsync(
        string sessionId,
        IReadOnlyList<JsonObject>? history,
        Func<CancellationToken, Task<bool>>? prepareRetry,
        CancellationToken cancellationToken,
        SessionHistory? snapshot = null,
        Func<JsonObject, bool, Task<JsonObject>>? commitAssistantSegment = null,
        int iteration = 0
    )
    {
        string? requestId = null;
        async Task<bool> Prepare(CancellationToken token)
        {
            hosted.ClearDraft();
            var changed = await prepareRetry!(token);
            token.ThrowIfCancellationRequested();
            return changed;
        }
        try
        {
            var result =
                inner is ISessionChatService ordinary
                && prepareRetry is not null
                && snapshot is not null
                    ? commitAssistantSegment is null
                        ? await ordinary.ChatAsync(sessionId, snapshot, Prepare, cancellationToken)
                        : await ordinary.ChatAsync(
                            sessionId,
                            snapshot,
                            Prepare,
                            commitAssistantSegment,
                            cancellationToken,
                            iteration
                        )
                    : await inner.ChatAsync(
                        sessionId,
                        history ?? snapshot!.Materialize(),
                        cancellationToken
                    );
            hosted.FlushDraft();
            requestId = result.JournalRequestId ?? requestId;
            if (result.AssistantMessage is null)
                hosted.ClearDraft();
            else
            {
                var metadata = result.AssistantMessage["__meta"] as JsonObject;
                if (metadata is null)
                    result.AssistantMessage["__meta"] = metadata = new JsonObject();
                if (requestId is not null)
                    metadata["llmRequestId"] = requestId;
                if (result.JournalAttempt is not null)
                    metadata["llmAttempt"] = result.JournalAttempt.Value;
            }
            return result;
        }
        catch
        {
            hosted.ClearDraft();
            throw;
        }
    }
}
