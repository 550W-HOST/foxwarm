using System.Text.Json.Nodes;
using Foxwarm.SessionTurns;

namespace Foxwarm.ExperimentHost;

internal static class WebUiContract
{
    public static JsonObject Session(SessionSnapshot snapshot, string requestModel, string concreteModel, bool toolActive)
    {
        var queueLength = snapshot.Queue.Count;
        var runtime = new JsonObject
        {
            ["state"] = snapshot.Busy ? toolActive ? "running-tool" : "requesting-model" : "idle",
            ["busy"] = snapshot.Busy, ["queueLength"] = queueLength
        };
        if (snapshot.BusyStartedAt is long since) runtime["since"] = since;
        return new JsonObject
        {
            ["id"] = snapshot.Id,
            ["busy"] = snapshot.Busy,
            ["busyStartedAt"] = snapshot.BusyStartedAt,
            ["queueLength"] = queueLength,
            ["messageCount"] = snapshot.History.Count,
            ["historyVersion"] = snapshot.HistoryVersion,
            ["runtimeState"] = runtime,
            ["model"] = concreteModel,
            ["modelKey"] = requestModel,
            ["defaultModelKey"] = requestModel
        };
    }

    public static JsonObject History(SessionSnapshot snapshot, string requestModel, string concreteModel, bool toolActive,
        int? tail, int? prefixLength, long? afterSeq)
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
        else if (prefixLength is int size) selected = selected.Take(size).ToArray();
        else if (afterSeq is long seq) selected = selected.Where(message =>
            message["__meta"]?["seq"] is JsonValue value && value.TryGetValue<long>(out var actual) && actual > seq).ToArray();
        var preview = new JsonArray();
        for (var i = 0; i < snapshot.Queue.Count && preview.Count < 20; i++)
        {
            var item = snapshot.Queue[i];
            if (item.Type != QueueItemType.User) continue;
            var parts = new JsonArray();
            if (item.Message?["parts"] is JsonArray existing)
                foreach (var part in existing.OfType<JsonObject>())
                    if (part["text"] is JsonValue text && text.TryGetValue<string>(out var raw))
                        parts.Add(new JsonObject { ["text"] = raw.Length > 4000 ? raw[..4000] + "\n… [preview truncated]" : raw });
            if (item.Parts is not null)
                foreach (var part in item.Parts)
                    if (part["text"] is JsonValue text && text.TryGetValue<string>(out var raw))
                        parts.Add(new JsonObject { ["text"] = raw.Length > 4000 ? raw[..4000] + "\n… [preview truncated]" : raw });
            if (parts.Count == 0) continue;
            preview.Add(new JsonObject
            {
                ["role"] = "user", ["parts"] = parts,
                ["__meta"] = new JsonObject { ["synthetic"] = $"queued-{i}-user", ["temporary"] = true,
                    ["queuedPreview"] = true, ["queueIndex"] = i, ["queueType"] = "user" }
            });
        }
        var result = new JsonObject
        {
            ["session"] = Session(snapshot, requestModel, concreteModel, toolActive),
            ["messages"] = new JsonArray(selected.Select(message => (JsonNode?)message.DeepClone()).ToArray()),
            ["persistentMemorySnapshot"] = "",
            ["queuedMessages"] = preview,
            ["queueLength"] = snapshot.Queue.Count,
            ["latestSeq"] = snapshot.NextMessageSeq - 1,
            ["nextMessageSeq"] = snapshot.NextMessageSeq,
            ["historyVersion"] = snapshot.HistoryVersion,
            ["prefixLength"] = prefix,
            ["historyComplete"] = complete,
            ["queuedPreviewLimit"] = 20,
            ["queuedPreviewOmittedCount"] = Math.Max(0, snapshot.Queue.Count - preview.Count)
        };
        return result;
    }
}
