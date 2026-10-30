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
        string? executionNode = null,
        JsonObject? runtimeState = null
    )
    {
        models = models.Capture();
        var rawModel = SessionWait.Text(snapshot.AuthorityEnvelope["model"]);
        var rawEffort = SessionWait.Text(snapshot.AuthorityEnvelope["effort"]);
        var model =
            ClaudeRuntimeState.IsExternal(snapshot.AuthorityEnvelope) || models.All.Count == 0
                ? null
                : models.Resolve(rawModel);
        var allowed = model?.AllowedEfforts ?? HostModels.Efforts;
        var defaultEffort = model is null ? "high" : model.DefaultEffort;
        var effectiveEffort =
            rawEffort is not null && allowed.Contains(rawEffort) ? rawEffort : defaultEffort;
        var queueLength = snapshot.Queue.Count(SessionCompactor.Ordinary);
        var runtime = SessionRuntimeState.Build(
            snapshot.Busy,
            snapshot.Stopping,
            snapshot.BusyStartedAt,
            queueLength,
            SessionRuntimeState.WaitProjection(snapshot.Meta),
            toolActive,
            compacting,
            llmFailed: snapshot.Meta["llmFailed"]?.GetValue<bool>() == true
        );
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
            ["runtimeState"] = runtimeState?.DeepClone() ?? runtime,
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
        var external = snapshot.AuthorityEnvelope["externalRuntime"]?.DeepClone() as JsonObject;
        if (external is not null)
            external["canContinue"] = ClaudeRuntimeState.CanContinue(
                snapshot.AuthorityEnvelope,
                queueLength > 0
            );
        SessionPresentation.ApplyExternalRuntime(
            result,
            SessionWait.Text(snapshot.AuthorityEnvelope["runtime"]) ?? "foxwarm",
            external
        );
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
        string? executionNode = null,
        JsonObject? runtimeState = null
    )
    {
        IReadOnlyList<HistoryMessage> selected = snapshot.History;
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
                .Where(message => message.Sequence is long actual && actual > seq)
                .ToArray();
        var preview = QueuedPreview(snapshot);
        var result = new JsonObject
        {
            ["session"] = Session(
                snapshot,
                models,
                toolActive,
                compacting,
                executionNode,
                runtimeState
            ),
            ["messages"] = new JsonArray(
                selected
                    .Select(message =>
                    {
                        var projected = message.ToJson();
                        WebUiMessageTransport.ProjectMessage(projected);
                        return (JsonNode?)projected;
                    })
                    .ToArray()
            ),
            ["persistentMemorySnapshot"] =
                snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.DeepClone()
                ?? JsonValue.Create(""),
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

    internal static JsonArray QueuedPreview(SessionSnapshot snapshot)
    {
        var preview = new JsonArray();
        for (var i = 0; i < snapshot.Queue.Count && preview.Count < 20; i++)
        {
            var item = snapshot.Queue[i];
            var type = item.Type switch
            {
                QueueItemType.User => "user",
                QueueItemType.Intersession => "intersession",
                QueueItemType.Background => "background",
                QueueItemType.Trigger => "trigger",
                QueueItemType.OnBoot => "onboot",
                _ => null,
            };
            if (type is null)
                continue;
            var message = item.Message is not null
                ? WebUiMessageTransport.Message(item.Message)
                : new JsonObject { ["role"] = "user" };
            var parts = SanitizeQueuedPreviewParts(
                item.Message is not null
                    ? (item.Message["parts"] as JsonArray ?? []).OfType<JsonObject>()
                    : item.Parts ?? []
            );
            if (
                item.Message is null
                && item.Type != QueueItemType.User
                && !parts
                    .OfType<JsonObject>()
                    .Any(part => !string.IsNullOrWhiteSpace(SessionWait.Text(part["system"])))
            )
            {
                var text = string.Join(
                        "\n",
                        parts
                            .OfType<JsonObject>()
                            .Select(part =>
                                SessionWait.Text(part["text"]) is { Length: > 0 } body
                                    ? body
                                    : SessionWait.Text(part["thinking"]) ?? ""
                            )
                            .Where(body => body.Length > 0)
                    )
                    .Trim();
                parts = new JsonArray();
                if (text.Length > 0)
                {
                    var source = string.IsNullOrEmpty(item.SourceSessionId)
                        ? ""
                        : $" sourceSessionId=\"{LocalSessionTurnHost.EscapeFoxwarmAttribute(item.SourceSessionId)}\"";
                    parts.Add(
                        new JsonObject
                        {
                            ["system"] =
                                $"<foxwarm-message type=\"{type}\"{source} hint=\"queued session event preview\">\n{TruncateQueuedPreviewText(text)}\n</foxwarm-message>",
                        }
                    );
                }
            }
            if (parts.Count == 0)
                continue;
            WebUiMessageTransport.ProjectParts(parts);
            message["parts"] = parts;
            var meta = message["__meta"] as JsonObject ?? new JsonObject();
            meta["synthetic"] = $"queued-{i}-{type}";
            meta["temporary"] = true;
            meta["queuedPreview"] = true;
            meta["queueIndex"] = i;
            meta["queueType"] = type;
            message["__meta"] = meta;
            preview.Add(message);
        }
        return preview;
    }

    internal static JsonArray SanitizeQueuedPreviewParts(IEnumerable<JsonObject> source)
    {
        var parts = new JsonArray();
        foreach (var part in source)
        {
            var projected = (JsonObject)part.DeepClone();
            foreach (var field in new[] { "text", "system", "thinking" })
                if (SessionWait.Text(projected[field]) is { } text)
                    projected[field] = TruncateQueuedPreviewText(text);
            if (part["inlineData"] is not null || part["inlineDataRef"] is not null)
            {
                var inline = part["inlineData"] as JsonObject;
                var reference = part["inlineDataRef"] as JsonObject;
                var mime =
                    SessionWait.Text(inline?["mimeType"])
                    ?? SessionWait.Text(inline?["mime_type"])
                    ?? SessionWait.Text(reference?["mimeType"])
                    ?? "attachment";
                projected = new JsonObject { ["text"] = $"[{mime} attachment preview omitted]" };
            }
            parts.Add(projected);
        }
        return parts;
    }

    private static string TruncateQueuedPreviewText(string text) =>
        text.Length > 4000 ? text[..4000] + "\n… [preview truncated]" : text;

    private static JsonObject QueueHistoryAppend(SessionRuntimeEvent entry)
    {
        var snapshot =
            entry.Snapshot
            ?? throw new InvalidOperationException("Queue append snapshot is missing.");
        var preview = QueuedPreview(snapshot);
        var queueLength = snapshot.Queue.Count(SessionCompactor.Ordinary);
        var messages = entry.Data?.DeepClone();
        WebUiMessageTransport.ProjectMessages(messages);
        return new JsonObject
        {
            ["type"] = "history-append",
            ["sessionId"] = entry.SessionId,
            ["messages"] = messages,
            ["queuedMessages"] = preview,
            ["queueLength"] = queueLength,
            ["queuedPreviewOmittedCount"] = Math.Max(0, queueLength - preview.Count),
            ["messageCount"] = snapshot.History.Count,
            ["historyVersion"] = snapshot.HistoryVersion,
            ["latestSeq"] = snapshot.NextMessageSeq - 1,
        };
    }

    public static JsonObject Event(SessionRuntimeEvent entry, SessionRuntime runtime) =>
        entry.Kind switch
        {
            SessionEventKind.QueueHistoryAppended => QueueHistoryAppend(entry),
            SessionEventKind.MessageCommitted or SessionEventKind.CommandReply => new JsonObject
            {
                ["type"] = "message",
                ["sessionId"] = entry.SessionId,
                ["message"] = entry.Data is JsonObject message
                    ? WebUiMessageTransport.Message(message)
                    : entry.Data?.DeepClone(),
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
