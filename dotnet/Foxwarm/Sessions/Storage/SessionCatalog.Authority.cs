using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    private static readonly string[] LegacyTransfer =
    [
        "history",
        "persistentMemorySnapshot",
        "queue",
        "parentSessionId",
        "promptCacheKey",
        "systemPromptFiles",
        "indexingState",
        "busy",
        "busyStartedAt",
        "stopping",
        "currentNode",
        "cwd",
        "model",
        "effort",
        "childModelDefault",
        "childEffortDefault",
        "agent",
        "verbose",
        "aliases",
        "historyVersion",
        "nextMessageSeq",
        "nextBlockId",
        "goalState",
        "compactThresholdTokens",
        "lastAppliedMailboxId",
    ];

    // Shared side-effect-free normalization for catalog preflight and semantic admission.
    // The owner still rejects unported semantic shapes; a catalog projection cannot enable them.
    internal static JsonObject NormalizeAuthority(
        JsonObject raw,
        string id,
        string agent,
        JsonObject? legacyCatalog = null
    )
    {
        if (raw.ContainsKey("sessionStateVersion") && Number(raw["sessionStateVersion"]) != 1)
            throw SessionAuthorityErrors.Unsupported(
                "Unsupported per-session state format version.",
                "sessionStateVersion"
            );
        if (raw.ContainsKey("id") && Text(raw["id"]) != id)
            throw new SessionAuthorityIdentityException(id);
        var legacy = !raw.ContainsKey("sessionStateVersion");
        var value = (JsonObject)raw.DeepClone();
        if (legacy && legacyCatalog is not null)
        {
            foreach (var key in LegacyTransfer)
                if (!raw.ContainsKey(key))
                    Copy(legacyCatalog, value, key);
            foreach (var key in new[] { "stats", "meta" })
            {
                if (!raw.ContainsKey(key))
                    Copy(legacyCatalog, value, key);
                else if (raw[key] is JsonObject owned && legacyCatalog[key] is JsonObject seed)
                {
                    var merged = (JsonObject)seed.DeepClone();
                    foreach (var (field, node) in owned)
                        merged[field] = node?.DeepClone();
                    value[key] = merged;
                }
            }
            if (!raw.ContainsKey("vectorIndexPosition"))
                Copy(legacyCatalog, value, "vectorIndexPosition");
        }
        if (legacy && raw.ContainsKey("history") && raw["history"] is not JsonArray)
            value["history"] = new JsonArray();
        if (value.ContainsKey("history") && value["history"] is not JsonArray)
            throw SessionAuthorityErrors.Invalid("Authority history must be an array.");
        if (!value.ContainsKey("history"))
            value["history"] = new JsonArray();
        var history = value["history"]!.AsArray();
        value.Remove("contextFrontier");
        foreach (var message in history.OfType<JsonObject>())
            if (message["__meta"] is JsonObject meta)
                meta.Remove("contextFrontierItem");
        if (!value.ContainsKey("persistentMemorySnapshot"))
            value["persistentMemorySnapshot"] = "";
        if (!value.ContainsKey("queue"))
            value["queue"] = new JsonArray();
        if (value["queue"] is not JsonArray)
            throw SessionAuthorityErrors.Invalid("Authority queue must be an array.");
        if (!value.ContainsKey("stats"))
            value["stats"] = new JsonObject
            {
                ["totalCachedTokens"] = 0,
                ["totalInputTokens"] = 0,
                ["totalOutputTokens"] = 0,
                ["lastUsage"] = null,
            };
        if (!value.ContainsKey("meta"))
            value["meta"] = new JsonObject();
        if (value["meta"] is not JsonObject projectedMeta)
            throw SessionAuthorityErrors.Invalid("Authority meta must be an object.");
        projectedMeta.Remove("lastChannel");
        if (!projectedMeta.ContainsKey("lastMessageTime"))
            projectedMeta["lastMessageTime"] = 0;
        if (!projectedMeta.ContainsKey("messageCount"))
            projectedMeta["messageCount"] = history.Count;
        if (!value.ContainsKey("busy"))
            value["busy"] = false;
        if (!value.ContainsKey("historyVersion"))
            value["historyVersion"] = 0;
        if (!value.ContainsKey("lastAppliedMailboxId"))
            value["lastAppliedMailboxId"] = 0;
        if (!value.ContainsKey("nextMessageSeq"))
        {
            var max = history
                .OfType<JsonObject>()
                .Select(message =>
                    Math.Max(
                        Number(message["__meta"]?["seq"]) ?? 0,
                        Number(message["__meta"]?["contextBlock"]?["rawEndSeq"]) ?? 0
                    )
                )
                .DefaultIfEmpty()
                .Max();
            value["nextMessageSeq"] = max + 1;
        }
        value["sessionStateVersion"] = 1;
        // Main supplies the binding; old JSON copies never override catalog identity.
        value["agent"] = agent;
        SessionAuthorityDocument.Validate(value, id, agent);
        return value;
    }

    internal static JsonObject AuthorityProjection(JsonObject authority, string id, JsonObject main)
    {
        var source = (JsonObject)authority.DeepClone();
        source["id"] = id;
        OverlayMain(source, main);
        return Project(source);
    }
}
