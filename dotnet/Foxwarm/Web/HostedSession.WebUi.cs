using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Web;

internal sealed partial class HostedSession
{
    private readonly object draftGate = new();
    private JsonObject? draft;
    private volatile bool toolActive;
    private volatile bool compacting;

    public void SetCompacting(bool value)
    {
        compacting = value;
        BroadcastState();
    }

    public async Task<JsonObject> UpdateModelAsync(JsonObject patch)
    {
        if (patch.Count == 0 || patch.Any(pair => pair.Key is not ("model" or "effort" or "clear")))
            throw new InvalidDataException("model and/or effort is required.");
        var setModel = patch.ContainsKey("model") || patch["clear"]?.GetValue<bool>() == true;
        string? model = null;
        if (patch.ContainsKey("model") && patch["model"] is not null)
        {
            if (patch["model"] is not JsonValue raw || !raw.TryGetValue<string>(out model) || !models.Contains(model))
                throw new InvalidDataException("Unknown or unsupported model key.");
        }
        var setEffort = patch.ContainsKey("effort");
        string? effort = null;
        if (setEffort && patch["effort"] is not null)
        {
            if (patch["effort"] is not JsonValue raw || !raw.TryGetValue<string>(out effort)
                || effort is not ("none" or "low" or "medium" or "high" or "xhigh" or "max"))
                throw new InvalidDataException("Invalid model effort.");
        }
        if (!setModel && !setEffort) throw new InvalidDataException("model and/or effort is required.");
        var selected = models.Resolve(setModel ? model : models.Select(Entry.Snapshot()).RawModel);
        if (effort is not null && !selected.AllowedEfforts.Contains(effort, StringComparer.Ordinal))
            throw new InvalidDataException("Effort is not allowed by the selected model.");
        await Entry.SaveLane.CommitAuthoritySettingsAsync(model, setModel, effort, setEffort);
        var status = WebUiState();
        status["success"] = true;
        status["sessionId"] = Id;
        return status;
    }

    public JsonObject DraftSnapshot()
    {
        lock (draftGate)
            return new JsonObject { ["type"] = "model-stream-snapshot", ["sessionId"] = Id,
                ["draft"] = draft?.DeepClone() };
    }

    public string BeginDraft()
    {
        var requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        JsonObject payload;
        lock (draftGate)
        {
            draft = new JsonObject
            {
                ["streamId"] = requestId, ["iteration"] = 1, ["sequence"] = 0,
                ["startedAt"] = startedAt, ["llmRequestId"] = requestId,
                ["text"] = "", ["reasoning"] = "", ["toolCalls"] = new JsonArray()
            };
            payload = new JsonObject
            {
                ["type"] = "session-event", ["sessionId"] = Id,
                ["event"] = new JsonObject
                {
                    ["type"] = "model-stream-reset", ["streamVersion"] = 2,
                    ["streamId"] = requestId, ["iteration"] = 1, ["sequenceStart"] = 0, ["sequence"] = 0,
                    ["startedAt"] = startedAt, ["llmRequestId"] = requestId
                }
            };
        }
        Broadcast(payload);
        return requestId;
    }

    public void PublishDraftProgress(ResponsesStreamProgress progress)
    {
        JsonObject? envelope = null;
        lock (draftGate)
        {
            if (draft is null) return;
            var previousText = draft["text"]?.GetValue<string>() ?? "";
            var previousReasoning = draft["reasoning"]?.GetValue<string>() ?? "";
            var newCalls = new JsonArray();
            var deltas = new JsonArray();
            var oldCalls = (draft["toolCalls"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>().ToDictionary(item => item["index"]!.GetValue<int>());
            foreach (var call in progress.ToolCalls)
            {
                oldCalls.TryGetValue(call.Index, out var old);
                var oldArgs = old?["arguments"]?.GetValue<string>() ?? "";
                var nextArgs = call.Arguments ?? "";
                var oldId = old?["id"]?.GetValue<string>();
                var oldName = old?["name"]?.GetValue<string>();
                var entry = new JsonObject { ["index"] = call.Index, ["arguments"] = nextArgs };
                if (call.Id is not null) entry["id"] = call.Id;
                if (call.Name is not null) entry["name"] = call.Name;
                newCalls.Add(entry);
                if (old is null || oldArgs != nextArgs || oldId != call.Id || oldName != call.Name)
                {
                    var delta = new JsonObject { ["index"] = call.Index };
                    if (call.Id is not null) delta["id"] = call.Id;
                    if (call.Name is not null) delta["name"] = call.Name;
                    if (oldArgs != nextArgs)
                        delta["argumentsDelta"] = new JsonObject
                        {
                            ["offset"] = nextArgs.StartsWith(oldArgs, StringComparison.Ordinal) ? oldArgs.Length : 0,
                            ["text"] = nextArgs.StartsWith(oldArgs, StringComparison.Ordinal) ? nextArgs[oldArgs.Length..] : nextArgs
                        };
                    deltas.Add(delta);
                }
            }
            var changed = previousText != progress.Text || previousReasoning != progress.Reasoning || deltas.Count > 0;
            if (!changed) return;
            var textDelta = previousText != progress.Text ? Delta(previousText, progress.Text) : null;
            var reasoningDelta = previousReasoning != progress.Reasoning ? Delta(previousReasoning, progress.Reasoning) : null;
            var nextSequence = draft["sequence"]!.GetValue<int>() + 1;
            draft["sequence"] = nextSequence;
            draft["text"] = progress.Text;
            draft["reasoning"] = progress.Reasoning;
            draft["toolCalls"] = newCalls;
            var update = new JsonObject
            {
                ["type"] = "model-stream-update", ["streamVersion"] = 2,
                ["streamId"] = draft["streamId"]!.GetValue<string>(),
                ["iteration"] = 1,
                ["sequenceStart"] = nextSequence, ["sequence"] = nextSequence,
                ["startedAt"] = draft["startedAt"]!.GetValue<long>(),
                ["llmRequestId"] = draft["llmRequestId"]!.GetValue<string>()
            };
            if (textDelta is not null) update["textDelta"] = textDelta;
            if (reasoningDelta is not null) update["reasoningDelta"] = reasoningDelta;
            if (deltas.Count > 0) update["toolCallDeltas"] = deltas;
            envelope = new JsonObject { ["type"] = "session-event", ["sessionId"] = Id, ["event"] = update };
        }
        Broadcast(envelope);
    }

    private static JsonObject Delta(string oldText, string newText) => new()
    {
        ["offset"] = newText.StartsWith(oldText, StringComparison.Ordinal) ? oldText.Length : 0,
        ["text"] = newText.StartsWith(oldText, StringComparison.Ordinal) ? newText[oldText.Length..] : newText
    };

    public void ClearCommittedDraft(JsonObject message)
    {
        var requestId = message["__meta"]?["llmRequestId"]?.GetValue<string>();
        if (requestId is null) return;
        lock (draftGate)
        {
            if (draft?["llmRequestId"]?.GetValue<string>() != requestId) return;
            draft = null;
        }
        Broadcast(DraftSnapshot());
    }

    public void ClearDraft()
    {
        lock (draftGate)
        {
            if (draft is null) return;
            draft = null;
        }
        Broadcast(DraftSnapshot());
    }

    public void SetToolActive(bool active)
    {
        toolActive = active;
        Broadcast(new JsonObject { ["type"] = "webui-session-state", ["sessionId"] = Id,
            ["session"] = WebUiState() });
    }
}

internal sealed class WebUiChatService(IChatService inner, HostedSession hosted) : IChatService
{
    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken)
    {
        var requestId = hosted.BeginDraft();
        try
        {
            var result = await inner.ChatAsync(sessionId, history, cancellationToken);
            if (result.AssistantMessage is null) hosted.ClearDraft();
            else
            {
                var metadata = result.AssistantMessage["__meta"] as JsonObject;
                if (metadata is null) result.AssistantMessage["__meta"] = metadata = new JsonObject();
                metadata["llmRequestId"] = requestId;
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

internal sealed class HostModelChatService(
    HttpClient http, ResponsesClientOptions baseOptions, HostedSession hosted, HostModels models,
    Action<string, ResponsesStreamProgress> progress) : IChatService
{
    public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var selected = models.Select(hosted.Entry.Snapshot());
        var options = baseOptions with
        {
            BaseUri = selected.Model.BaseUri,
            RequestModel = selected.Model.ModelId,
            ConcreteModelId = selected.Model.Key,
            Token = selected.Model.Token,
            Effort = selected.EffectiveEffort
        };
        return new ResponsesChatService(http, options, progress).ChatAsync(sessionId, history, cancellationToken);
    }
}

internal sealed class WebUiToolExecutor(ITurnToolExecutor inner, HostedSession hosted) : ITurnToolExecutor
{
    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        hosted.SetToolActive(true);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (functionCall["name"]?.GetValue<string>() == "recall")
                return ArchiveRecallTool.Execute(hosted.Archive, functionCall["args"] as JsonObject);
            return await inner.ExecuteAsync(functionCall, cancellationToken);
        }
        finally { hosted.SetToolActive(false); }
    }
}
