using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record ToolAuthorizationPolicy(JsonObject Value)
{
    internal const int MaxBytes = 256 * 1024;
    internal static ToolAuthorizationPolicy Compatibility() => Normalize(new JsonObject { ["version"] = 1 });
    internal static readonly Dictionary<string, string> TargetFamilies = new(StringComparer.Ordinal)
    {
        ["send_to_session"] = "send", ["send_file"] = "file", ["recall"] = "recall", ["get_session_messages"] = "required",
        ["create_timer"] = "timer", ["list_timers"] = "timer", ["update_timer"] = "timer", ["delete_timer"] = "timer",
        ["get_archived_messages"] = "archive", ["get_archived_blocks"] = "archive"
    };
    internal static void Fields(JsonObject obj, params string[] allowed)
    { if (obj.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal))) throw new InvalidDataException("Unsupported policy field."); }
    internal static string String(JsonNode? node, int bytes = 512)
    {
        var text = SessionWait.Text(node) ?? throw new InvalidDataException("Policy requires a string.");
        text = SessionGoal.Trim(text);
        if (text.Length == 0 || Encoding.UTF8.GetByteCount(text) > bytes) throw new InvalidDataException("Policy string is empty or exceeds its byte limit.");
        return text;
    }
    private static bool Scalar(JsonNode? node) => node is null || node is JsonValue value &&
        (value.TryGetValue<string>(out _) || value.TryGetValue<bool>(out _) || Number(node) is double number && double.IsFinite(number));
    internal static double? Number(JsonNode? node)
    { return node?.GetValueKind() == System.Text.Json.JsonValueKind.Number && double.TryParse(node.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) ? number : null; }
    private static JsonNode? Finite(JsonNode? node)
    {
        if (!Scalar(node) || SessionWait.Text(node) is string text && Encoding.UTF8.GetByteCount(text) > 512)
            throw new InvalidDataException("Policy matcher requires a bounded finite scalar.");
        return node?.DeepClone();
    }
    private static JsonArray Scalars(JsonNode? node)
    {
        if (node is not JsonArray values || values.Count is < 1 or > 64) throw new InvalidDataException("Policy matcher list requires 1-64 items.");
        return new JsonArray(values.Select(Finite).ToArray());
    }
    private static JsonNode? Matcher(JsonNode? node)
    {
        if (Scalar(node)) return Finite(node);
        if (node is JsonArray) return Scalars(node);
        if (node is not JsonObject map || map.Count == 0) throw new InvalidDataException("Invalid scalar matcher.");
        Fields(map, "equals", "oneOf", "exists"); var result = new JsonObject();
        if (map.ContainsKey("equals")) result["equals"] = Finite(map["equals"]);
        if (map.ContainsKey("oneOf")) result["oneOf"] = Scalars(map["oneOf"]);
        if (map.ContainsKey("exists")) result["exists"] = Boolean(map["exists"]);
        return result;
    }
    internal static bool Boolean(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : throw new InvalidDataException("Policy requires a boolean.");
    private static JsonArray Names(JsonNode? node)
    {
        var array = Scalars(node);
        return new JsonArray(array.Select(item => (JsonNode?)JsonValue.Create(String(item))).ToArray());
    }
    private static JsonNode Tool(JsonNode? node)
    {
        JsonNode result;
        if (node is JsonArray) result = Names(node);
        else if (SessionWait.Text(node) is not null) result = JsonValue.Create(String(node))!;
        else
        {
            if (node is not JsonObject map || map.Count == 0) throw new InvalidDataException("Invalid policy tool selector.");
            Fields(map, "source", "server", "name"); var copy = new JsonObject();
            foreach (var pair in map) copy[pair.Key] = Matcher(pair.Value);
            if (copy.ContainsKey("source"))
            {
                var source = copy["source"]; var values = source is JsonArray list ? list.ToArray() : source is JsonObject match
                    ? (match.ContainsKey("equals") ? new[] { match["equals"] } : []).Concat((match["oneOf"] as JsonArray ?? []).ToArray()).ToArray() : [source];
                if (values.Any(value => SessionWait.Text(value) is not ("builtin" or "mcp" or "node"))) throw new InvalidDataException("Policy tool source must be builtin, mcp or node.");
            }
            result = copy;
        }
        var requested = result is JsonObject selected ? selected["name"] : result;
        var explicitOld = SessionWait.Text(requested) == "update_session_snapshot" || requested is JsonArray oldList && oldList.Any(value => SessionWait.Text(value) == "update_session_snapshot")
            || requested is JsonObject oldMap && (SessionWait.Text(oldMap["equals"]) == "update_session_snapshot" || (oldMap["oneOf"] as JsonArray ?? []).Any(value => SessionWait.Text(value) == "update_session_snapshot"));
        if (explicitOld && ToolAuthorizationEvaluation.ToolMatches(result, "builtin", "update_session_snapshot", null))
            throw new InvalidDataException("Obsolete builtin update_session_snapshot; migrate to refresh_session_snapshot.");
        return result;
    }
    private static JsonObject PathMatcher(JsonNode? node)
    {
        if (node is not JsonObject map) throw new InvalidDataException("Invalid path matcher.");
        Fields(map, "arg", "allWithin", "anyNotWithin");
        if (!map.ContainsKey("allWithin") && !map.ContainsKey("anyNotWithin")) throw new InvalidDataException("Path matcher requires a containment condition.");
        var result = new JsonObject();
        if (map.ContainsKey("arg")) result["arg"] = map["arg"] is JsonArray ? Names(map["arg"]) : JsonValue.Create(String(map["arg"]));
        foreach (var key in new[] { "allWithin", "anyNotWithin" }) if (map.ContainsKey(key))
        {
            var text = String(map[key]);
            if (Regex.Matches(text, @"\$\{[^}]+\}").Any(match => match.Value is not ("${agent.dir}" or "${agent.memoryDir}" or "${workspace}")))
                throw new InvalidDataException("Unsupported policy path variable.");
            result[key] = text;
        }
        return result;
    }
    private static JsonNode? Argument(JsonNode? node)
    {
        if (node is not JsonObject wrapper || !wrapper.ContainsKey("session")) return Matcher(node);
        Fields(wrapper, "session");
        if (wrapper["session"] is not JsonObject match || match.Count == 0) throw new InvalidDataException("Invalid Session-target matcher.");
        Fields(match, "self", "sameAgent", "relation"); var result = new JsonObject();
        foreach (var key in new[] { "self", "sameAgent" }) if (match.ContainsKey(key))
        { if (!Boolean(match[key])) throw new InvalidDataException("Session-target condition must be true."); result[key] = true; }
        if (match.ContainsKey("relation"))
        {
            var relations = match["relation"] is JsonArray values ? values.ToArray() : [match["relation"]];
            if (relations.Length is < 1 or > 2 || relations.Any(item => SessionWait.Text(item) is not ("parent" or "child"))
                || relations.Select(SessionWait.Text).Distinct(StringComparer.Ordinal).Count() != relations.Length) throw new InvalidDataException("Invalid Session relation.");
            result["relation"] = match["relation"]!.DeepClone();
        }
        return new JsonObject { ["session"] = result };
    }
    internal static ToolAuthorizationPolicy Normalize(JsonObject root)
    {
        Fields(root, "version", "defaultAction", "rules");
        if (Number(root["version"]) != 1) throw new InvalidDataException("Tool policy version must be 1.");
        var action = root.ContainsKey("defaultAction") ? SessionWait.Text(root["defaultAction"]) : "allow";
        if (action is not ("allow" or "deny")) throw new InvalidDataException("Invalid policy defaultAction.");
        var raw = root.ContainsKey("rules") ? root["rules"] as JsonArray ?? throw new InvalidDataException("Policy rules must be an array.") : new JsonArray();
        if (raw.Count > 256) throw new InvalidDataException("Policy exceeds 256 rules.");
        var rules = new JsonArray(); var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in raw)
        {
            if (node is not JsonObject rule) throw new InvalidDataException("Policy rule must be an object.");
            Fields(rule, "id", "enabled", "match", "action", "reason"); var id = String(rule["id"], 128);
            if (!ids.Add(id)) throw new InvalidDataException("Duplicate policy rule ID.");
            var enabled = !rule.ContainsKey("enabled") || Boolean(rule["enabled"]);
            var effect = SessionWait.Text(rule["action"]); if (effect is not ("allow" or "deny")) throw new InvalidDataException("Invalid policy action.");
            var match = new JsonObject();
            if (rule.ContainsKey("match"))
            {
                if (rule["match"] is not JsonObject source) throw new InvalidDataException("Policy match must be an object.");
                Fields(source, "agent", "session", "externalId", "tool", "targetNode", "args", "path");
                foreach (var key in new[] { "agent", "session", "externalId", "targetNode" }) if (source.ContainsKey(key)) match[key] = Matcher(source[key]);
                if (source.ContainsKey("tool")) match["tool"] = Tool(source["tool"]);
                if (source.ContainsKey("path")) match["path"] = PathMatcher(source["path"]);
                if (source.ContainsKey("args"))
                {
                    if (source["args"] is not JsonObject args || args.Count > 64) throw new InvalidDataException("Invalid or oversized policy argument matchers.");
                    var arguments = new JsonObject();
                    foreach (var pair in args)
                    {
                        if (pair.Key.Split('.').Any(part => part.Length == 0 || part is "__proto__" or "prototype" or "constructor")) throw new InvalidDataException("Unsafe dotted policy argument.");
                        arguments[pair.Key] = Argument(pair.Value);
                    }
                    var targets = arguments.Where(pair => pair.Value is JsonObject target && target.ContainsKey("session")).ToArray();
                    if (targets.Length > 0)
                    {
                        if (targets.Length != 1 || targets[0].Key != "sessionId" || match["tool"] is not JsonObject selector || selector.ContainsKey("server") || SessionWait.Text(selector["source"]) != "builtin")
                            throw new InvalidDataException("Session-target matcher requires exact registered builtin selector and sessionId.");
                        var names = selector["name"] is JsonArray list ? list.Select(SessionWait.Text).ToArray() : [SessionWait.Text(selector["name"])];
                        if (names.Length == 0 || names.Any(name => name is null || !TargetFamilies.ContainsKey(name)) || names.Select(name => TargetFamilies[name!]).Distinct().Count() != 1)
                            throw new InvalidDataException("Session-target tool names must share one registered resolver family.");
                    }
                    match["args"] = arguments;
                }
            }
            var normalized = new JsonObject { ["id"] = id, ["enabled"] = enabled, ["match"] = match, ["action"] = effect };
            if (rule.ContainsKey("reason"))
            {
                var reason = SessionWait.Text(rule["reason"]) ?? throw new InvalidDataException("Policy reason must be a string.");
                if (Encoding.UTF8.GetByteCount(reason) > 1024) throw new InvalidDataException("Policy reason exceeds 1024 bytes.");
                if (reason.Length > 0) normalized["reason"] = reason;
            }
            rules.Add(normalized);
        }
        return new(new JsonObject { ["version"] = 1, ["defaultAction"] = action, ["rules"] = rules });
    }
}
