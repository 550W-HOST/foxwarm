using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal static class SessionPresentation
{
    internal static JsonObject Build(
        SessionMetadata meta,
        HostModels models,
        Func<string, SessionMetadata?>? resolveAncestry,
        bool toolActive = false,
        bool compacting = false
    )
    {
        var catalog = models.Capture();
        var model = catalog.All.Count == 0 ? null : catalog.Resolve(meta.Model);
        var allowed = model?.AllowedEfforts ?? HostModels.Efforts;
        var defaultEffort = model is null ? "high" : model.DefaultEffort;
        var effort =
            meta.Effort is not null && allowed.Contains(meta.Effort, StringComparer.Ordinal)
                ? meta.Effort
                : defaultEffort;
        var runtime = SessionRuntimeState.Build(meta, toolActive, compacting);
        var result = new JsonObject
        {
            ["id"] = meta.Id,
            ["agent"] = meta.Agent,
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
            ["modelKey"] =
                meta.Model is not null && catalog.Contains(meta.Model)
                    ? meta.Model
                    : catalog.DefaultKey,
            ["defaultModelKey"] = catalog.DefaultKey,
            ["effort"] = meta.Effort,
            ["effectiveEffort"] = effort,
            ["effortAllowed"] = new JsonArray(
                allowed.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["effortDefault"] = defaultEffort,
            ["tokenUsage"] = new JsonObject
            {
                ["cachedTokens"] = meta.CachedTokens,
                ["inputTokens"] = meta.InputTokens,
                ["outputTokens"] = meta.OutputTokens,
            },
        };
        if (meta.Cost is double cost)
            result["tokenUsage"]!["cost"] = cost;
        var settings = new JsonObject
        {
            ["model"] = meta.Model,
            ["effort"] = meta.Effort,
            ["childModelDefault"] = meta.ChildModel,
            ["childEffortDefault"] = meta.ChildEffort,
            ["compactThresholdTokens"] = meta.CompactThreshold,
        };
        foreach (var (key, value) in SessionModelSettings.Presentation(settings, catalog, meta.Id))
            result[key] = value?.DeepClone();
        var hops = new List<SessionMetadata> { meta };
        var seen = new HashSet<string>(StringComparer.Ordinal) { meta.Id };
        var parentId = meta.ParentSessionId;
        while (
            parentId is not null
            && seen.Add(parentId)
            && resolveAncestry?.Invoke(parentId) is SessionMetadata parent
        )
        {
            hops.Add(parent);
            parentId = parent.ParentSessionId;
        }
        var effectiveRaw = meta.ChildModel ?? meta.Model;
        var supplier = 0;
        if (effectiveRaw is not null)
            for (var index = 0; index < hops.Count; index++)
                if (hops[index].ChildModel == effectiveRaw)
                    supplier = index;
        result["childPolicyChain"] = new JsonArray(
            hops.Select(
                    (hop, index) =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["level"] = index == 0 ? "session" : "inherited",
                                ["sessionId"] = hop.Id,
                                ["modelKey"] = hop.Model,
                                ["effort"] = hop.Effort,
                                ["childModelDefault"] = hop.ChildModel,
                                ["childEffortDefault"] = hop.ChildEffort,
                                ["source"] =
                                    hop.ChildModel is null ? "follow-parent"
                                    : index + 1 < hops.Count
                                    && hops[index + 1].ChildModel == hop.ChildModel
                                        ? "inherited"
                                    : "explicit",
                                ["supplies"] = index == supplier,
                            }
                )
                .ToArray()
        );
        return result;
    }
}
