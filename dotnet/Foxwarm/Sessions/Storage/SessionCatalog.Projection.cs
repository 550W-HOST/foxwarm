using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    internal static readonly string[] MainFields =
    [
        "agent",
        "aliases",
        "parentSessionId",
        "displayName",
        "archived",
        "pinned",
        "sidebarOrder",
    ];
    private static readonly string[] Efforts = ["none", "low", "medium", "high", "xhigh", "max"];

    internal static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    internal static double? Number(JsonNode? node) =>
        SessionWait.Number(node) is { } number && double.IsFinite(number) ? number : null;

    internal static bool Flag(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    internal static string Trim(string value) =>
        Regex.Replace(
            value,
            "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+|[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+$",
            ""
        );

    private static string Bounded(string text, int length) => text[..Math.Min(length, text.Length)];

    private static JsonArray? Strings(JsonNode? value, int count, int length)
    {
        if (value is not JsonArray array)
            return null;
        var result = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in array)
        {
            if (Text(node) is not { } raw)
                continue;
            var entry = Bounded(Trim(raw), length);
            if (entry.Length == 0 || !seen.Add(entry))
                continue;
            result.Add(entry);
            if (result.Count == count)
                break;
        }
        return result.Count == 0 ? null : result;
    }

    internal static JsonObject? WaitProjection(JsonNode? value)
    {
        if (value is not JsonObject wait || Text(wait["id"]) is not { } id || Trim(id).Length == 0)
            return null;
        var result = new JsonObject { ["id"] = Bounded(Trim(id), 128) };
        if (Number(wait["startedAt"]) is { } start)
            result["startedAt"] = start;
        if (Text(wait["reason"]) is { } reason && Trim(reason).Length > 0)
            result["reason"] = Bounded(Trim(reason), 500);
        if (Number(wait["timeoutSeconds"]) is > 0 and var timeout)
            result["timeoutSeconds"] = timeout;
        foreach (var key in new[] { "waitExecIds", "waitAnySessions" })
            if (Strings(wait[key], 64, key == "waitExecIds" ? 256 : 512) is { } entries)
                result[key] = entries;
        if (Flag(wait["waitForInput"]))
            result["waitForInput"] = true;
        if (Number(wait["declarationVersion"]) == 1)
            result["declarationVersion"] = 1;
        if (wait["waitAll"] is JsonObject all && Strings(all["sessions"], 64, 512) is { } sessions)
        {
            var projected = new JsonObject { ["sessions"] = sessions };
            if (Strings(all["satisfiedSessions"], 64, 512) is { } satisfied)
                projected["satisfiedSessions"] = satisfied;
            result["waitAll"] = projected;
        }
        return result;
    }

    internal static JsonObject Project(JsonObject raw)
    {
        var id = Text(raw["id"]);
        if (string.IsNullOrEmpty(id))
            throw new InvalidDataException("Invalid Session catalog ID.");
        if (
            raw.ContainsKey("aliases")
            && (
                raw["aliases"] is not JsonArray aliases
                || aliases.Any(node => Text(node) is not { Length: > 0 })
            )
        )
            throw new InvalidDataException($"Session '{id}' has invalid aliases.");
        foreach (
            var key in new[]
            {
                "agent",
                "parentSessionId",
                "displayName",
                "currentNode",
                "cwd",
                "model",
                "effort",
                "childModelDefault",
                "childEffortDefault",
            }
        )
            if (raw[key] is not null && Text(raw[key]) is null)
                throw new InvalidDataException($"Session '{id}' has invalid {key}.");
        foreach (var key in new[] { "effort", "childEffortDefault" })
            if (raw.ContainsKey(key) && !Efforts.Contains(Text(raw[key]), StringComparer.Ordinal))
                throw new InvalidDataException($"Session '{id}' has invalid {key}.");
        foreach (var key in new[] { "archived", "pinned", "busy", "stopping", "verbose" })
            if (
                raw[key] is not null
                && (raw[key] is not JsonValue flag || !flag.TryGetValue<bool>(out _))
            )
                throw new InvalidDataException($"Session '{id}' has invalid {key}.");
        foreach (
            var key in new[]
            {
                "sidebarOrder",
                "vectorIndexPosition",
                "compactThresholdTokens",
                "busyStartedAt",
                "queueLength",
                "managedPendingCount",
            }
        )
            CheckNumber(raw[key], key);
        foreach (var key in new[] { "stats", "meta" })
            if (raw.ContainsKey(key) && raw[key] is not JsonObject)
                throw new InvalidDataException($"Session '{id}' has invalid {key}.");
        if (raw.ContainsKey("queue") && raw["queue"] is not JsonArray)
            throw new InvalidDataException("Invalid queue projection source.");
        var meta = new JsonObject();
        var inputMeta = raw["meta"] as JsonObject;
        foreach (var key in new[] { "lastMessageTime", "messageCount" })
        {
            CheckNumber(inputMeta?[key], key);
            Copy(inputMeta, meta, key);
        }
        if (inputMeta?.ContainsKey("lastChannel") == true)
        {
            if (inputMeta["lastChannel"] is not JsonObject channel)
                throw new InvalidDataException("Invalid catalog lastChannel.");
            var channelId =
                Text(channel["channelId"])
                ?? Text(channel["platform"])
                ?? Text(channel["channelType"]);
            var userId = Text(channel["channelUserId"]) ?? Text(channel["conversationId"]);
            if (string.IsNullOrEmpty(channelId) || string.IsNullOrEmpty(userId))
                throw new InvalidDataException("Invalid catalog lastChannel.");
            var last = new JsonObject { ["channelId"] = channelId, ["channelUserId"] = userId };
            if ((Text(channel["channelType"]) ?? Text(channel["platform"])) is { } type)
                last["channelType"] = type;
            if (Text(channel["conversationId"]) is { } conversation)
                last["conversationId"] = conversation;
            meta["lastChannel"] = last;
        }
        if (inputMeta?["llmFailed"] is JsonNode failed)
        {
            if (failed is not JsonValue flag || !flag.TryGetValue<bool>(out _))
                throw new InvalidDataException("Invalid catalog llmFailed.");
            meta["llmFailed"] = failed.DeepClone();
        }
        if (WaitProjection(inputMeta?["wait"]) is { } wait)
            meta["wait"] = wait;
        var result = new JsonObject
        {
            ["id"] = id,
            ["agent"] = Text(raw["agent"]) is { Length: > 0 } agent ? agent : "main",
            ["aliases"] = raw["aliases"]?.DeepClone() ?? new JsonArray(),
            ["busy"] = Flag(raw["busy"]),
            ["queueLength"] =
                Number(raw["queueLength"])
                ?? (raw["queue"] as JsonArray)?.Count(item =>
                    Text((item as JsonObject)?["type"]) != "compact-commit"
                )
                ?? 0,
            ["managedPendingCount"] =
                Number(raw["managedPendingCount"])
                ?? (
                    (inputMeta?["managedSession"] as JsonObject)?["pendingInbox"] as JsonArray
                )?.Count
                ?? 0,
            ["currentNode"] = Text(raw["currentNode"]) is { Length: > 0 } nodeName
                ? nodeName
                : "master",
        };
        if (meta.Count > 0)
            result["meta"] = meta;
        if (Text(raw["runtime"]) == ClaudeRuntimeState.Kind)
        {
            result["runtime"] = ClaudeRuntimeState.Kind;
            var external = new JsonObject();
            foreach (var key in new[] { "status", "model", "authMethod", "lastResult" })
                Copy(raw["externalRuntime"] as JsonObject, external, key);
            external["canContinue"] = ClaudeRuntimeState.CanContinue(raw);
            result["externalRuntime"] = external;
        }
        foreach (
            var key in new[]
            {
                "parentSessionId",
                "displayName",
                "cwd",
                "model",
                "effort",
                "childModelDefault",
                "childEffortDefault",
                "vectorIndexPosition",
                "archived",
                "pinned",
                "stopping",
                "verbose",
                "sidebarOrder",
                "busyStartedAt",
                "compactThresholdTokens",
            }
        )
            Copy(raw, result, key);
        if (raw["stats"] is JsonObject stats)
        {
            var output = new JsonObject();
            foreach (
                var key in new[] { "totalCachedTokens", "totalInputTokens", "totalOutputTokens" }
            )
            {
                CheckNumber(stats[key], key);
                Copy(stats, output, key);
            }
            CopyCost(stats, output, "totalCost");
            if (stats.ContainsKey("lastUsage"))
            {
                if (stats["lastUsage"] is null)
                    output["lastUsage"] = null;
                else if (stats["lastUsage"] is JsonObject usage)
                {
                    var last = new JsonObject();
                    foreach (
                        var key in new[]
                        {
                            "cachedTokens",
                            "inputTokens",
                            "reasoningTokens",
                            "outputTokens",
                        }
                    )
                    {
                        CheckNumber(usage[key], key);
                        Copy(usage, last, key);
                    }
                    CopyCost(usage, last, "cost");
                    output["lastUsage"] = last;
                }
                else
                    throw new InvalidDataException("Invalid catalog stats.lastUsage.");
            }
            result["stats"] = output;
        }
        return result;
    }

    private static void CopyCost(JsonObject source, JsonObject target, string key)
    {
        if (!source.ContainsKey(key))
            return;
        if (Number(source[key]) is not double number || !double.IsFinite(number) || number < 0)
            throw new InvalidDataException("Invalid catalog " + key + ".");
        target[key] = number;
    }

    private static void CheckNumber(JsonNode? value, string key)
    {
        if (value is not null && Number(value) is null)
            throw new InvalidDataException($"Invalid catalog numeric {key}.");
    }

    internal static void Copy(JsonObject? from, JsonObject to, string key)
    {
        if (from?.ContainsKey(key) == true)
            to[key] = from[key]?.DeepClone();
    }

    internal static void OverlayAuthorityContext(JsonObject authority, JsonObject main)
    {
        foreach (var key in MainFields)
        {
            authority.Remove(key);
            Copy(main, authority, key);
        }
        if (authority["parentSessionId"] is null)
            authority.Remove("parentSessionId");
        if (authority["meta"] is JsonObject meta)
            meta.Remove("lastChannel");
    }

    internal static void OverlayMain(JsonObject authority, JsonObject main)
    {
        foreach (var key in MainFields)
        {
            authority.Remove(key);
            Copy(main, authority, key);
        }
        if (authority["meta"] is not JsonObject meta)
            authority["meta"] = meta = new JsonObject();
        meta.Remove("lastChannel");
        Copy(main["meta"] as JsonObject, meta, "lastChannel");
    }
}
