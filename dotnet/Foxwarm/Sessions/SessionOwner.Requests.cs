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
    private int activeTools;
    public bool ToolActive => Volatile.Read(ref activeTools) > 0;
    private object? compactPhase;
    public bool Compacting => Volatile.Read(ref compactPhase) is not null;

    public object BeginCompactPhase()
    {
        var lease = new object();
        Interlocked.Exchange(ref compactPhase, lease);
        PublishStateChanged();
        return lease;
    }

    public void EndCompactPhase(object lease)
    {
        if (!ReferenceEquals(Interlocked.CompareExchange(ref compactPhase, null, lease), lease))
            return;
        PublishStateChanged();
    }

    internal async Task<JsonObject> UpdateCwdAsync(string? value)
    {
        var change = await Entry.SaveLane.CommitCwdAsync(value);
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
        }
        Emit(SessionEventKind.ModelStream, payload);
        return requestId;
    }

    public void PublishDraftProgress(ResponsesStreamProgress progress)
    {
        JsonObject? envelope = null;
        lock (draftGate)
        {
            if (draft is null)
                return;
            var previousText = draft["text"]?.GetValue<string>() ?? "";
            var previousReasoning = draft["reasoning"]?.GetValue<string>() ?? "";
            var hasParts = progress.Parts is not null || draft["parts"] is JsonArray;
            var previousParts = (draft["parts"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>()
                .ToDictionary(PartKey);
            var newCalls = new JsonArray();
            var deltas = new JsonArray();
            var newParts = new JsonArray();
            var partDeltas = new JsonArray();
            var oldCalls = (draft["toolCalls"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>()
                .ToDictionary(item => item["index"]!.GetValue<int>());
            foreach (var call in progress.ToolCalls)
            {
                oldCalls.TryGetValue(call.Index, out var old);
                var oldArgs = old?["arguments"]?.GetValue<string>() ?? "";
                var nextArgs = call.Arguments ?? "";
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
                if (part.Phase is not null)
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
            var nextSequence = draft["sequence"]!.GetValue<int>() + 1;
            draft["sequence"] = nextSequence;
            draft["text"] = progress.Text;
            draft["reasoning"] = progress.Reasoning;
            draft["toolCalls"] = newCalls;
            if (hasParts)
                draft["parts"] = newParts;
            var update = new JsonObject
            {
                ["type"] = "model-stream-update",
                ["streamVersion"] = 2,
                ["streamId"] = draft["streamId"]!.GetValue<string>(),
                ["iteration"] = 1,
                ["sequenceStart"] = nextSequence,
                ["sequence"] = nextSequence,
                ["startedAt"] = draft["startedAt"]!.GetValue<long>(),
                ["llmRequestId"] = draft["llmRequestId"]!.GetValue<string>(),
            };
            if (textDelta is not null)
                update["textDelta"] = textDelta;
            if (reasoningDelta is not null)
                update["reasoningDelta"] = reasoningDelta;
            if (deltas.Count > 0)
                update["toolCallDeltas"] = deltas;
            if (partDeltas.Count > 0)
                update["partDeltas"] = partDeltas;
            envelope = update;
        }
        Emit(SessionEventKind.ModelStream, envelope);
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

    public void ClearCommittedDraft(JsonObject message)
    {
        var requestId = message["__meta"]?["llmRequestId"]?.GetValue<string>();
        if (requestId is null)
            return;
        lock (draftGate)
        {
            if (draft?["llmRequestId"]?.GetValue<string>() != requestId)
                return;
            draft = null;
        }
        Emit(SessionEventKind.DraftChanged);
    }

    public void ClearDraft()
    {
        lock (draftGate)
        {
            if (draft is null)
                return;
            draft = null;
        }
        Emit(SessionEventKind.DraftChanged);
    }

    internal void BeginTool()
    {
        if (Interlocked.Increment(ref activeTools) != 1)
            return;
        try
        {
            Emit(SessionEventKind.StateChanged);
        }
        catch
        {
            Interlocked.Decrement(ref activeTools);
            throw;
        }
    }

    internal void EndTool()
    {
        if (Interlocked.Decrement(ref activeTools) == 0)
            Emit(SessionEventKind.StateChanged);
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

    private async Task<ChatResult> ChatCoreAsync(
        string sessionId,
        IReadOnlyList<JsonObject>? history,
        Func<CancellationToken, Task<bool>>? prepareRetry,
        CancellationToken cancellationToken,
        SessionHistory? snapshot = null
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
                inner is ISessionChatService ordinary && prepareRetry is not null && snapshot is not null
                    ? await ordinary.ChatAsync(sessionId, snapshot, Prepare, cancellationToken)
                    : await inner.ChatAsync(sessionId, history ?? snapshot!.Materialize(), cancellationToken);
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
