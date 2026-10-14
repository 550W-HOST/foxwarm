using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal static class WebUiContract
{
    public static JsonObject Session(
        SessionSnapshot snapshot,
        HostModels models,
        bool toolActive,
        bool compacting,
        string? executionNode = null
    )
    {
        models = models.Capture();
        var rawModel = SessionWait.Text(snapshot.AuthorityEnvelope["model"]);
        var rawEffort = SessionWait.Text(snapshot.AuthorityEnvelope["effort"]);
        var model = models.All.Count == 0 ? null : models.Resolve(rawModel);
        var allowed = model?.AllowedEfforts ?? HostModels.Efforts;
        var defaultEffort = model is null ? "high" : model.DefaultEffort;
        var effectiveEffort =
            rawEffort is not null && allowed.Contains(rawEffort) ? rawEffort : defaultEffort;
        var queueLength = snapshot.Queue.Count(SessionCompactor.Ordinary);
        var runtime = new JsonObject
        {
            ["state"] = snapshot.Busy
                ? toolActive
                    ? "running-tool"
                    : "requesting-model"
                : "idle",
            ["busy"] = snapshot.Busy,
            ["queueLength"] = queueLength,
        };
        if (snapshot.BusyStartedAt is long since)
            runtime["since"] = since;
        if (compacting)
            runtime["active"] = new JsonObject { ["phase"] = "compaction" };
        var result = new JsonObject
        {
            ["id"] = snapshot.Id,
            ["agent"] =
                snapshot.AuthorityEnvelope["agent"]?.DeepClone() ?? JsonValue.Create("main"),
            ["parentSessionId"] = snapshot.AuthorityEnvelope["parentSessionId"]?.DeepClone(),
            ["displayName"] = snapshot.AuthorityEnvelope["displayName"]?.DeepClone(),
            ["currentNode"] =
                executionNode ?? SessionManager.ResolveExecutionNode(snapshot.AuthorityEnvelope),
            ["cwd"] = snapshot.AuthorityEnvelope["cwd"]?.DeepClone(),
            ["busy"] = snapshot.Busy,
            ["busyStartedAt"] = snapshot.BusyStartedAt,
            ["queueLength"] = queueLength,
            ["messageCount"] = snapshot.History.Count,
            ["historyVersion"] = snapshot.HistoryVersion,
            ["runtimeState"] = runtime,
            ["model"] = rawModel,
            ["modelKey"] =
                rawModel is not null && models.Contains(rawModel) ? rawModel : models.DefaultKey,
            ["defaultModelKey"] = models.DefaultKey,
            ["effort"] = rawEffort,
            ["effectiveEffort"] = effectiveEffort,
            ["effortAllowed"] = new JsonArray(
                allowed.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray()
            ),
            ["effortDefault"] = defaultEffort,
        };
        foreach (
            var (key, value) in SessionModelSettings.Presentation(
                snapshot.AuthorityEnvelope,
                models,
                snapshot.Id
            )
        )
            result[key] = value?.DeepClone();
        return result;
    }

    public static JsonObject History(
        SessionSnapshot snapshot,
        HostModels models,
        bool toolActive,
        bool compacting,
        int? tail,
        int? prefixLength,
        long? afterSeq,
        string? executionNode = null
    )
    {
        IReadOnlyList<JsonObject> selected = snapshot.History;
        var prefix = 0;
        var complete = true;
        if (tail is int count)
        {
            prefix = Math.Max(0, selected.Count - count);
            selected = selected.Skip(prefix).ToArray();
            complete = prefix == 0;
        }
        else if (prefixLength is int size)
            selected = selected.Take(size).ToArray();
        else if (afterSeq is long seq)
            selected = selected
                .Where(message =>
                    message["__meta"]?["seq"] is JsonValue value
                    && value.TryGetValue<long>(out var actual)
                    && actual > seq
                )
                .ToArray();
        var preview = new JsonArray();
        for (var i = 0; i < snapshot.Queue.Count && preview.Count < 20; i++)
        {
            var item = snapshot.Queue[i];
            if (item.Type != QueueItemType.User)
                continue;
            var parts = new JsonArray();
            if (item.Message?["parts"] is JsonArray existing)
                foreach (var part in existing.OfType<JsonObject>())
                    if (part["text"] is JsonValue text && text.TryGetValue<string>(out var raw))
                        parts.Add(
                            new JsonObject
                            {
                                ["text"] =
                                    raw.Length > 4000
                                        ? raw[..4000] + "\n… [preview truncated]"
                                        : raw,
                            }
                        );
                    else if (
                        part["inlineDataRef"] is not null
                        || part["inlineData"] is not null
                        || part["inlineDataUnavailable"] is not null
                    )
                        parts.Add(Foxwarm.Images.ImageTransport.Project(part));
            if (item.Parts is not null)
                foreach (var part in item.Parts)
                    if (part["text"] is JsonValue text && text.TryGetValue<string>(out var raw))
                        parts.Add(
                            new JsonObject
                            {
                                ["text"] =
                                    raw.Length > 4000
                                        ? raw[..4000] + "\n… [preview truncated]"
                                        : raw,
                            }
                        );
                    else if (
                        part["inlineDataRef"] is not null
                        || part["inlineData"] is not null
                        || part["inlineDataUnavailable"] is not null
                    )
                        parts.Add(Foxwarm.Images.ImageTransport.Project(part));
            if (parts.Count == 0)
                continue;
            preview.Add(
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = parts,
                    ["__meta"] = new JsonObject
                    {
                        ["synthetic"] = $"queued-{i}-user",
                        ["temporary"] = true,
                        ["queuedPreview"] = true,
                        ["queueIndex"] = i,
                        ["queueType"] = "user",
                    },
                }
            );
        }
        var result = new JsonObject
        {
            ["session"] = Session(snapshot, models, toolActive, compacting, executionNode),
            ["messages"] = new JsonArray(
                selected.Select(message => (JsonNode?)message.DeepClone()).ToArray()
            ),
            ["persistentMemorySnapshot"] = "",
            ["queuedMessages"] = preview,
            ["queueLength"] = snapshot.Queue.Count(SessionCompactor.Ordinary),
            ["latestSeq"] = snapshot.NextMessageSeq - 1,
            ["nextMessageSeq"] = snapshot.NextMessageSeq,
            ["historyVersion"] = snapshot.HistoryVersion,
            ["prefixLength"] = prefix,
            ["historyComplete"] = complete,
            ["queuedPreviewLimit"] = 20,
            ["queuedPreviewOmittedCount"] = Math.Max(
                0,
                snapshot.Queue.Count(SessionCompactor.Ordinary) - preview.Count
            ),
        };
        return result;
    }

    public static JsonObject Event(SessionRuntimeEvent entry, SessionRuntime runtime) =>
        entry.Kind switch
        {
            SessionEventKind.MessageCommitted or SessionEventKind.CommandReply => new JsonObject
            {
                ["type"] = "message",
                ["sessionId"] = entry.SessionId,
                ["message"] = entry.Data?.DeepClone(),
            },
            SessionEventKind.Deleted => new JsonObject
            {
                ["type"] = "session-deleted",
                ["sessionId"] = entry.SessionId,
            },
            SessionEventKind.StateChanged => new JsonObject
            {
                ["type"] = "session-state",
                ["sessionId"] = entry.SessionId,
                ["session"] = runtime.GetSession(entry.SessionId),
            },
            SessionEventKind.ModelStream => new JsonObject
            {
                ["type"] = "session-event",
                ["sessionId"] = entry.SessionId,
                ["event"] = entry.Data?.DeepClone(),
            },
            SessionEventKind.DraftChanged => Draft(runtime.Owner(entry.SessionId)!),
            _ => new JsonObject
            {
                ["type"] = "processing-error",
                ["sessionId"] = entry.SessionId,
                ["message"] = entry.Data?.DeepClone(),
            },
        };

    public static JsonObject Draft(SessionOwner owner)
    {
        var data = owner.DraftSnapshot();
        return new JsonObject
        {
            ["type"] = "model-stream-snapshot",
            ["sessionId"] = owner.Id,
            ["draft"] = data.Count == 0 ? null : data,
        };
    }

    public static JsonObject CliEvent(SessionRuntimeEvent entry, SessionRuntime runtime)
    {
        if (entry.Kind == SessionEventKind.MessageCommitted)
            return new JsonObject
            {
                ["type"] = "message-committed",
                ["message"] = entry.Data?.DeepClone(),
            };
        if (entry.Kind == SessionEventKind.StateChanged)
            return new JsonObject
            {
                ["type"] = "session-state",
                ["session"] = System.Text.Json.JsonSerializer.SerializeToNode(
                    runtime.Owner(entry.SessionId)!.State()
                ),
            };
        if (entry.Kind == SessionEventKind.RequestProgress)
        {
            var draft = entry.Data as JsonObject ?? new JsonObject();
            return new JsonObject
            {
                ["type"] = "model-progress",
                ["sessionId"] = entry.SessionId,
                ["text"] = draft["text"]?.DeepClone() ?? JsonValue.Create(""),
                ["reasoning"] = draft["reasoning"]?.DeepClone() ?? JsonValue.Create(""),
            };
        }
        return Event(entry, runtime);
    }

    public static JsonObject Models(HostModels config, string? current = null)
    {
        config = config.Capture();
        return new()
        {
            ["defaultKey"] = config.DefaultKey,
            ["currentKey"] =
                current is not null && config.Contains(current) ? current : config.DefaultKey,
            ["models"] = new JsonArray(
                config
                    .Options.Select(model =>
                    {
                        return (JsonNode?)
                            new JsonObject
                            {
                                ["key"] = model.Key,
                                ["label"] = model.Key,
                                ["isDefault"] = model.Key == config.DefaultKey,
                                ["contextLimit"] = model.ContextLimit,
                                ["providerKey"] = model.ProviderKey,
                                ["modelId"] = model.ModelId,
                                ["providerType"] = model.ProviderType,
                                ["isVirtual"] = model.IsVirtual,
                                ["targets"] = new JsonArray(
                                    model
                                        .Targets.Select(value => (JsonNode?)JsonValue.Create(value))
                                        .ToArray()
                                ),
                                ["allowedEfforts"] = new JsonArray(
                                    model
                                        .AllowedEfforts.Select(v => (JsonNode?)JsonValue.Create(v))
                                        .ToArray()
                                ),
                                ["defaultEffort"] = model.DefaultEffort,
                                ["asyncCompact"] = !ModelRoutingFingerprint.False(
                                    model.Configuration["asyncCompact"]
                                ),
                                ["failureThreshold"] =
                                    model.IsVirtual && model.ProviderType == "failover"
                                        ? model.Configuration["failureThreshold"]?.DeepClone()
                                        : null,
                                ["cooldownMs"] =
                                    model.IsVirtual && model.ProviderType == "failover"
                                        ? model.Configuration["cooldownMs"]?.DeepClone()
                                        : null,
                            };
                    })
                    .ToArray()
            ),
        };
    }
}
