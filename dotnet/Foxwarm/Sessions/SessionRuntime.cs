using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal enum SessionEventKind { MessageCommitted, StateChanged, ModelStream, RequestProgress, DraftChanged, ProcessingError }
internal sealed record SessionRuntimeEvent(string SessionId, SessionEventKind Kind, JsonNode? Data);
internal sealed record SessionMetadata(string Id, string Agent, string? ParentSessionId, string? DisplayName,
    bool Busy, bool Stopping, long? BusyStartedAt, int QueueLength, int MessageCount, long NextMessageSeq,
    long HistoryVersion, long LastMessageTime, bool Archived, bool Pinned, double? SidebarOrder,
    string? Model, string? Effort, long CachedTokens, long InputTokens, long OutputTokens, JsonObject? Wait = null, string? ChildModel = null, string? ChildEffort = null, double? CompactThreshold = null);

/// <summary>Session-semantic in-process API. Channels receive cloned projections, never mutable owners.</summary>
internal sealed class SessionRuntime(SessionManager manager)
{
    public SessionOwner? Owner(string id) => manager.Find(id);
    public JsonObject? GetSession(string id) => Owner(id)?.BuildDto();
    public SessionMetadata[] ListMetadata() => manager.Owners().Select(owner => owner.Metadata()).ToArray();
    public JsonObject[] ListSessions() => manager.Owners().Select(owner => owner.BuildDto()).ToArray();
    public event Action<SessionRuntimeEvent> Changed { add => manager.Changed += value; remove => manager.Changed -= value; }
    public event Action TopologyChanged { add => manager.TopologyChanged += value; remove => manager.TopologyChanged -= value; }
    public Task ContinueAsync(string id) => Required(id).StartProcessing(retry: true);
    public Task SubmitAndRunAsync(string id, QueueItem item) => Required(id).Registry.Ingress.EnqueueAsync(id, item);
    public Task<JsonObject> UpdateSettingsAsync(string id, JsonObject settings) => Required(id).UpdateModelAsync(settings);
    public Task UpdateDisplayNameAsync(string id, string? name) => Required(id).Entry.SaveLane.CommitDisplayNameAsync(name);
    public Task<string> RefreshSnapshotAsync(string id) => manager.RefreshSnapshotAsync(Required(id));
    public async Task<StopResult> StopAsync(string id)
    {
        var owner = Required(id);
        if (owner.Compactor.Standalone) return new(false, false);
        var result = await owner.Registry.Control.StopAsync(id);
        await owner.DrainForegroundAsync();
        return result;
    }
    public Task<DequeueResult> DequeueAsync(string id) => Required(id).Registry.Control.DequeueAsync(id);
    private SessionOwner Required(string id) => Owner(id) ?? throw new InvalidDataException("Session not found.");
}

internal sealed partial class SessionOwner
{
    public SessionMetadata Metadata() => Entry.WithState(state =>
    {
        var envelope = state.AuthorityEnvelope;
        static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        static long Number(JsonNode? node) => node is JsonValue value && value.TryGetValue<long>(out var number) ? number : 0;
        static bool Flag(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
        return new SessionMetadata(Id, Agent, Text(envelope["parentSessionId"]), Text(envelope["displayName"]),
            state.Busy, state.Stopping, state.BusyStartedAt, state.Queue.Count(SessionCompactor.Ordinary), state.History.Count,
            state.NextMessageSeq, state.HistoryVersion, Number(state.Meta["lastMessageTime"]),
            Flag(envelope["archived"]), Flag(envelope["pinned"]),
            envelope["sidebarOrder"] is JsonValue order && order.TryGetValue<double>(out var rawOrder) ? rawOrder : null,
            Text(envelope["model"]), Text(envelope["effort"]), Number(envelope["stats"]?["totalCachedTokens"]),
            Number(envelope["stats"]?["totalInputTokens"]), Number(envelope["stats"]?["totalOutputTokens"]), SessionRuntimeState.WaitProjection(state.Meta), Text(envelope["childModelDefault"]), Text(envelope["childEffortDefault"]), SessionWait.Number(envelope["compactThresholdTokens"]));
    });

    public JsonObject BuildDto() => BuildDto(Metadata());
    public JsonObject BuildDto(SessionMetadata meta)
    {
        var catalog = models.Capture();
        var model = catalog.Resolve(meta.Model);
        var effort = meta.Effort is not null && model.AllowedEfforts.Contains(meta.Effort, StringComparer.Ordinal)
            ? meta.Effort : model.DefaultEffort;
        var runtime = SessionRuntimeState.Build(meta, toolActive, Compacting);
        var result = new JsonObject
        {
            ["id"] = Id,
            ["agent"] = Agent,
            ["parentSessionId"] = meta.ParentSessionId,
            ["displayName"] = meta.DisplayName,
            ["busy"] = meta.Busy,
            ["busyStartedAt"] = meta.BusyStartedAt,
            ["queueLength"] = meta.QueueLength,
            ["messageCount"] = meta.MessageCount,
            ["sequenceMessageCount"] = Math.Max(0, meta.NextMessageSeq - 1),
            ["historyVersion"] = meta.HistoryVersion,
            ["lastMessageTime"] = meta.LastMessageTime,
            ["archived"] = meta.Archived,
            ["pinned"] = meta.Pinned,
            ["sidebarOrder"] = meta.SidebarOrder,
            ["runtimeState"] = runtime,
            ["model"] = meta.Model,
            ["modelKey"] = meta.Model is not null && catalog.Contains(meta.Model) ? meta.Model : catalog.DefaultKey,
            ["defaultModelKey"] = catalog.DefaultKey,
            ["effort"] = meta.Effort,
            ["effectiveEffort"] = effort,
            ["effortAllowed"] = new JsonArray(model.AllowedEfforts.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
            ["effortDefault"] = model.DefaultEffort,
            ["tokenUsage"] = new JsonObject
            {
                ["cachedTokens"] = meta.CachedTokens,
                ["inputTokens"] = meta.InputTokens,
                ["outputTokens"] = meta.OutputTokens
            }
        };
        var settings = new JsonObject { ["model"] = meta.Model, ["effort"] = meta.Effort, ["childModelDefault"] = meta.ChildModel, ["childEffortDefault"] = meta.ChildEffort, ["compactThresholdTokens"] = meta.CompactThreshold };
        foreach (var (key, value) in SessionModelSettings.Presentation(settings, catalog, Id)) result[key] = value?.DeepClone();
        var hops = new List<SessionMetadata> { meta }; var seen = new HashSet<string>(StringComparer.Ordinal) { meta.Id };
        var parentId = meta.ParentSessionId;
        while (parentId is not null && seen.Add(parentId) && ResolveAncestry?.Invoke(parentId) is SessionMetadata parent)
        { hops.Add(parent); parentId = parent.ParentSessionId; }
        var effectiveRaw = meta.ChildModel ?? meta.Model; var supplier = 0;
        if (effectiveRaw is not null) for (var index = 0; index < hops.Count; index++) if (hops[index].ChildModel == effectiveRaw) supplier = index;
        result["childPolicyChain"] = new JsonArray(hops.Select((hop, index) => (JsonNode?)new JsonObject
        {
            ["level"] = index == 0 ? "session" : "inherited",
            ["sessionId"] = hop.Id,
            ["modelKey"] = hop.Model,
            ["effort"] = hop.Effort,
            ["childModelDefault"] = hop.ChildModel,
            ["childEffortDefault"] = hop.ChildEffort,
            ["source"] = hop.ChildModel is null ? "follow-parent" : index + 1 < hops.Count && hops[index + 1].ChildModel == hop.ChildModel ? "inherited" : "explicit",
            ["supplies"] = index == supplier
        }).ToArray());
        return result;
    }
}
