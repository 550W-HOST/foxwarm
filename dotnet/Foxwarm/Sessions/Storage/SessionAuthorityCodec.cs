using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// The representation-independent mapping between a <see cref="SessionSnapshot"/> and the
/// authority value: the validated state written for a commit, the snapshot read back from a
/// normalized value, and the Archive record of an appended message. Every authority
/// representation uses it, so they store and load the same value.
/// </summary>
internal static class SessionAuthorityCodec
{
    internal static JsonObject PrepareState(
        SessionSnapshot snapshot,
        string sessionId,
        string agent,
        JsonObject? main
    )
    {
        var root = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
        if (main is not null)
            SessionCatalog.OverlayAuthorityContext(root, main);
        foreach (var field in new[] { "archived", "pinned", "sidebarOrder" })
            root.Remove(field);
        root["sessionStateVersion"] = ClaudeRuntimeState.IsExternal(root) ? 2 : 1;
        if (root["goalState"] is JsonObject goal)
            goal.Remove("remindOnTurnEnd");
        root["agent"] = agent;
        // Keep the existing property position; the writer supplies the immutable array values.
        root["history"] = null;
        root["persistentMemorySnapshot"] ??= "";
        root["queue"] = new JsonArray(
            snapshot.Queue.Select(SessionQueueJson.ToJson).Cast<JsonNode>().ToArray()
        );
        root["stats"] ??= new JsonObject
        {
            ["totalCachedTokens"] = 0,
            ["totalInputTokens"] = 0,
            ["totalOutputTokens"] = 0,
            ["lastUsage"] = null,
        };
        var meta = (JsonObject)snapshot.Meta.DeepClone();
        meta.Remove("lastChannel");
        meta["lastMessageTime"] ??= 0;
        meta["messageCount"] = snapshot.History.Count;
        root["meta"] = meta;
        root["busy"] = snapshot.Busy;
        root["busyStartedAt"] = snapshot.BusyStartedAt;
        root["stopping"] = snapshot.Stopping;
        root["historyVersion"] = snapshot.HistoryVersion;
        root["lastAppliedMailboxId"] ??= 0;
        root["nextMessageSeq"] = snapshot.NextMessageSeq;
        root["nextBlockId"] ??= 1;
        SessionAuthorityDocument.ValidateState(root, snapshot.History.Count, sessionId, agent);
        return root;
    }

    internal static ArchiveMessageRecord ToArchiveRecord(
        JsonObject message,
        string sessionId,
        string agent
    )
    {
        var meta =
            message["__meta"] as JsonObject
            ?? throw new InvalidDataException("Canonical appended message requires __meta.");
        var seq = ReadInteger(meta["seq"], "message seq");
        var timestamp = ReadNumber(meta["timestamp"], "message timestamp");
        return ArchiveMessageRecord.Create(sessionId, agent, seq, timestamp, message);
    }

    internal static SessionSnapshot FromAuthority(JsonObject root, string sessionId)
    {
        var history = SessionHistory.FromJson(((JsonArray)root["history"]!).OfType<JsonObject>());
        var envelope = new JsonObject();
        foreach (var property in root)
            if (property.Key is not ("history" or "queue" or "meta"))
                envelope[property.Key] = property.Value?.DeepClone();
        envelope = DetachDocument(envelope);
        var queue = ((JsonArray)root["queue"]!)
            .Select(node => SessionQueueJson.FromJson(DetachDocument((JsonObject)node!)))
            .ToArray();
        var busy = root["busy"]!.GetValue<bool>();
        long? busyStartedAt = root["busyStartedAt"] is JsonValue busyNode
            ? ReadInteger(busyNode, "busyStartedAt")
            : null;
        var stopping = root["stopping"]?.GetValue<bool>() ?? false;
        return new SessionSnapshot(
            sessionId,
            history,
            queue,
            busy,
            busyStartedAt,
            stopping,
            DetachDocument((JsonObject)root["meta"]!),
            ReadInteger(root["nextMessageSeq"], "nextMessageSeq"),
            ReadInteger(root["historyVersion"], "historyVersion"),
            envelope
        );
    }

    // DeepClone isolates mutations but parsed JsonValue elements may still share the original
    // JsonDocument. Reparse each retained non-history branch once at cold ingress so small
    // envelope/meta/queue values cannot keep the authority's unrelated history buffer alive.
    private static JsonObject DetachDocument(JsonObject value) =>
        (JsonObject)JsonNode.Parse(value.ToJsonText())!;

    private static long ReadInteger(JsonNode? node, string label)
    {
        var number = ReadNumber(node, label);
        if (number != Math.Truncate(number) || number < long.MinValue || number > long.MaxValue)
            throw new InvalidDataException($"{label} must be an integer.");
        return checked((long)number);
    }

    private static double ReadNumber(JsonNode? node, string label)
    {
        if (node is not JsonValue value)
            throw new InvalidDataException($"{label} must be numeric.");
        double number;
        if (value.TryGetValue<double>(out var direct))
            number = direct;
        else if (value.TryGetValue<long>(out var signed))
            number = signed;
        else if (value.TryGetValue<int>(out var integer))
            number = integer;
        else
            throw new InvalidDataException($"{label} must be numeric.");
        if (!double.IsFinite(number))
            throw new InvalidDataException($"{label} must be finite.");
        return number;
    }
}
