using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record AgentIsolation(bool Isolated, string? RecordedNode, JsonArray Rules);

// Reader of the retained legacy isolation fields (`isolated`, `isolatedNode`, `toolRules`).
// Since R2 they are not enforced: they remain the downgrade fence for older binaries, which
// validate these rows at startup, and the input of the isolation migration.
internal static class IsolatedToolCompatibility
{
    internal static AgentIsolation Metadata(JsonNode? raw)
    {
        var map = raw as JsonObject;
        var isolated = Truthy(map?["isolated"]);
        var recorded =
            isolated
            && SessionWait.Text(map?["isolatedNode"]) is string node
            && SessionGoal.Trim(node).Length > 0
                ? SessionGoal.Trim(node)
                : null;
        var rules = new JsonArray();
        if (map?.ContainsKey("toolRules") == true)
        {
            if (map["toolRules"] is not JsonArray list || list.Count > 256)
                throw new InvalidDataException("Invalid Agent toolRules.");
            var identities = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in list)
            {
                if (item is not JsonObject rule)
                    throw new InvalidDataException("Agent tool rule must be an object.");
                var source = SessionWait.Text(rule["source"]);
                var effect = SessionWait.Text(rule["effect"]);
                if (
                    source is not ("builtin" or "node" or "mcp")
                    || effect is not ("allow" or "deny")
                )
                    throw new InvalidDataException("Invalid Agent tool rule identity/effect.");
                var keys =
                    source == "node" ? new[] { "effect", "source", "node", "tool" }
                    : source == "mcp" ? ["effect", "source", "server", "tool"]
                    : ["effect", "source", "tool"];
                ToolAuthorizationPolicy.Fields(rule, keys);
                var copy = new JsonObject();
                foreach (var key in keys)
                {
                    var text = ToolAuthorizationPolicy.String(rule[key], 128);
                    if (text.Contains('*'))
                        throw new InvalidDataException(
                            "Agent tool rules require exact identities."
                        );
                    copy[key] = text;
                }
                if (source == "builtin" && SessionWait.Text(copy["tool"]) == "get_session_messages")
                    copy["tool"] = "view_session";
                var tool = SessionWait.Text(copy["tool"]);
                if (source == "builtin" && tool is "call_tool" or "update_session_snapshot")
                    throw new InvalidDataException(
                        "Obsolete or neutral Agent tool rule identity; use the concrete capability and refresh_session_snapshot."
                    );
                if (source == "builtin" && tool == "set_tool_rules")
                    throw new InvalidDataException(
                        "Obsolete Agent rule set_tool_rules; review permissions before migrating to set_config, because Agent exact rules cannot constrain target."
                    );
                var identity =
                    source
                    + "\0"
                    + (SessionWait.Text(copy[source == "node" ? "node" : "server"]) ?? "")
                    + "\0"
                    + tool;
                if (!identities.Add(identity))
                    throw new InvalidDataException("Duplicate Agent tool rule identity.");
                rules.Add(copy);
            }
        }
        return new(isolated, recorded, rules);
    }

    private static bool Truthy(JsonNode? value) =>
        value is not null
        && (
            value is JsonObject or JsonArray
            || SessionWait.Text(value) is string text && text.Length > 0
            || value is JsonValue flag && flag.TryGetValue<bool>(out var boolean) && boolean
            || ToolAuthorizationPolicy.Number(value) is double number
                && number != 0
                && !double.IsNaN(number)
        );
}
