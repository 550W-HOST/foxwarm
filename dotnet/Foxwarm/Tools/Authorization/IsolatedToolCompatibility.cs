using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record AgentIsolation(bool Isolated, string? RecordedNode, JsonArray Rules);

internal static class IsolatedToolCompatibility
{
    private static readonly HashSet<string> Structural = new(StringComparer.Ordinal)
    {
        "create_agent",
        "list_agents",
        "set_agent_inherit",
        "set_agent_isolated",
        "move_session",
        "create_session",
        "create_child_session",
        "delete_session",
        "get_session_messages",
    };
    private static readonly HashSet<string> DefaultBuiltins = new(StringComparer.Ordinal)
    {
        "apply_patch_memory",
        "skill",
        "image_crop",
        "get_archived_messages",
        "get_archived_blocks",
        "recall",
        "session",
        "send_to_session",
        "wait",
        "submit_compact_plan",
        "search_tools",
        "create_timer",
        "list_timers",
        "update_timer",
        "delete_timer",
        "run_script",
        "start_toolscript_run",
        "continue_script",
        "list_toolscript_runs",
        "get_toolscript_run",
        "cancel_toolscript_run",
    };

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
                var tool = SessionWait.Text(copy["tool"]);
                if (source == "builtin" && tool is "call_tool" or "update_session_snapshot")
                    throw new InvalidDataException(
                        "Obsolete or neutral Agent tool rule identity; use the concrete capability and refresh_session_snapshot."
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

    private static string? Exact(
        AgentIsolation isolation,
        string source,
        string name,
        string? server
    ) =>
        isolation
            .Rules.OfType<JsonObject>()
            .Where(rule =>
                SessionWait.Text(rule["source"]) == source
                && SessionWait.Text(rule["tool"]) == name
                && (source != "node" || SessionWait.Text(rule["node"]) == "master")
                && (source != "mcp" || SessionWait.Text(rule["server"]) == server)
            )
            .Select(rule => SessionWait.Text(rule["effect"]))
            .FirstOrDefault();

    private static bool Forbidden(string source, string name) =>
        source == "node" && name == "exec" || source == "builtin" && Structural.Contains(name);

    internal static bool Visible(
        AgentIsolation isolation,
        string source,
        string name,
        string? server,
        bool unknownNode = false
    )
    {
        if (!isolation.Isolated)
            return true;
        if (Forbidden(source, name))
            return false;
        var exact = Exact(isolation, source, name, server);
        if (exact is not null)
            return exact == "allow";
        if (unknownNode)
            return true;
        return source == "node"
            ? name is "read" or "write" or "edit" or "apply_patch"
            : source == "builtin" && DefaultBuiltins.Contains(name);
    }

    internal static void Check(
        AgentIsolation isolation,
        ToolAuthorizationRequest request,
        Func<string, AuthorizationTarget?> resolve
    )
    {
        if (!isolation.Isolated)
            return;
        if (Forbidden(request.Source, request.Name))
            throw new ToolAuthorizationDeniedException(
                "Isolated Agent cannot use this structurally restricted capability."
            );
        var ownDirectory = AuthorizationPaths.CanonicalPotential(request.AgentDirectory!);
        var exact = Exact(isolation, request.Source, request.Name, request.Server);
        if (exact == "deny")
            throw new ToolAuthorizationDeniedException("Agent tool rule denies this capability.");
        if (exact != "allow")
        {
            var allowed =
                request.Source == "node"
                    ? request.Name is "read" or "write" or "edit"
                        && request.Paths.Count > 0
                        && request.Paths.All(path =>
                            ToolAuthorizationEvaluation.Within(path.Resolved, ownDirectory)
                        )
                    : request.Source == "builtin"
                        && DefaultBuiltins.Contains(request.Name)
                        && (
                            request.Name != "session"
                            || !request.Args.ContainsKey("action")
                            || request.Args["action"] is null
                            || SessionWait.Text(request.Args["action"]) is "" or "status"
                        );
            if (!allowed)
                throw new ToolAuthorizationDeniedException(
                    "Isolated Agent cannot use this capability without an exact allow rule."
                );
        }
        // Exact capability allow never bypasses handler-local physical/target/action boundaries.
        if (
            request.Source == "node" && request.Name is "read" or "write" or "edit" or "apply_patch"
            || request.Source == "builtin"
                && request.Name is "set_tool_rules" or "send_file" or "image_write_to_file"
        )
            if (
                request.Paths.Any(path =>
                    !ToolAuthorizationEvaluation.Within(path.Resolved, ownDirectory)
                    || request.Agent == "main"
                        && ToolAuthorizationEvaluation.Within(
                            path.Resolved,
                            AuthorizationPaths.CanonicalPotential(
                                Path.Combine(request.AgentDirectory!, "agents")
                            )
                        )
                )
            )
                throw new ToolAuthorizationDeniedException(
                    "Isolated Agent can only access its own tool directory on Main."
                );
        if (
            request.Source == "builtin"
            && request.Name == "session"
            && SessionGoal
                .Trim(SessionWait.Text(request.Args["action"]) ?? "status")
                .ToLowerInvariant() == "list"
        )
            throw new ToolAuthorizationDeniedException("Isolated Agent cannot list sessions.");
        if (
            request.Source == "builtin"
            && request.Name == "skill"
            && SessionWait.Text(request.Args["agentName"]) is string skillAgent
            && SessionGoal.Trim(skillAgent).Length > 0
            && SessionGoal.Trim(skillAgent) != request.Agent
        )
            throw new ToolAuthorizationDeniedException(
                "Isolated Agent can only use skills for its own Agent."
            );
        if (request.Source == "builtin" && request.Name == "recall")
        {
            var id = SessionGoal.Trim(
                SessionWait.Text(request.Args["sessionId"]) ?? request.Session!
            );
            if (id.Length == 0)
                id = request.Session!;
            if (
                (request.SessionTarget ?? resolve(id)) is { } target
                && target.Agent != request.Agent
            )
                throw new ToolAuthorizationDeniedException(
                    "Isolated Agent can only recall sessions under its own Agent."
                );
        }
    }
}
