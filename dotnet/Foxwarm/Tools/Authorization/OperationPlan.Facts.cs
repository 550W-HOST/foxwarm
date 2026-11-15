using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Where each operation resource of a declaration comes from: the arguments an expression reads
// (unknown in a visibility projection that does not know them), the handler defaults it applies,
// and the plan-context facts it needs. Every declared expression has an entry; the coverage test
// fails for one that has none.
internal sealed partial record OperationPlan
{
    // Capabilities without a registered Session-target resolver whose handler targets sessionId,
    // or the caller when it is omitted or blank.
    internal static readonly IReadOnlySet<string> CallerDefaultTargets = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "compact_session",
        "refresh_session_snapshot",
        "set_session_child_model",
        "set_session_compact_threshold",
        "move_session",
    };

    // Capabilities without a resolver whose handler requires sessionId.
    internal static readonly IReadOnlySet<string> ArgumentTargets = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "delete_session",
    };

    // Optional arguments whose absence is itself the handler's meaning, not a default.
    internal static readonly IReadOnlyDictionary<string, string> AbsentMeaning = new Dictionary<
        string,
        string
    >(StringComparer.Ordinal)
    {
        ["parentSessionId"] = "no parent (create_session) or a cleared parent (set-parent)",
        ["ownerSessionId"] = "a released owner (task assign)",
    };

    internal static string[] ConditionArgs(string when)
    {
        if (when.StartsWith("arg:", StringComparison.Ordinal))
            return [when[4..]];
        if (when.StartsWith("default-true:", StringComparison.Ordinal))
            return [when[13..]];
        if (when.StartsWith("action:", StringComparison.Ordinal))
            return ["action"];
        return when switch
        {
            "file-source" => ["code"],
            "file-action" => ["action"],
            "channel" => ["channelTargetId"],
            "agent-scope" => ["sessionId", "vector_query", "scope"],
            "default-cwd-probe" => ["action", "nodeId"],
            "legacy-node" => ["edits", "replaceAll"],
            "source-exists" or "source-missing" => ["sourceSessionId"],
            _ => [],
        };
    }

    internal static string[] ItemArgs(string each)
    {
        if (each.StartsWith("path:", StringComparison.Ordinal))
            return each[5..] == "*" ? [] : [each[5..]];
        return each switch
        {
            "secret-questions" => ["questions"],
            "members" => ["nodeId"],
            "from-config-files" or "from-config-servers" => ["fromConfig"],
            "probe-sessions" => ["probes"],
            _ => [],
        };
    }

    internal static string[] ValueArgs(string expression)
    {
        foreach (var prefix in new[] { "arg?:", "arg:", "has:", "path?:" })
            if (expression.StartsWith(prefix, StringComparison.Ordinal))
            {
                var name = expression[prefix.Length..];
                var index = name.IndexOf("??", StringComparison.Ordinal);
                return [index < 0 ? name : name[..index]];
            }
        return expression switch
        {
            "memory-source" => ["sourceSessionId"],
            "memory-target" => ["agentName"],
            "node-target" or "node-target?" => ["nodeId", "parentNode", "providerId"],
            "provider-node" => ["nodeId", "providerId"],
            "target-session" or "timer-owner" => ["sessionId"],
            "agent-or-caller" => ["agentName"],
            "timer-kind" => ["action"],
            "placement" or "child-node" or "session-node" => ["node", "agentName"],
            "recall-mode" => ["vector_query"],
            "session-scope" => ["scope"],
            "has-secret-questions" => ["questions"],
            "move-agent" => ["newAgentName", "createAgent", "sessionId"],
            _ => [],
        };
    }

    // Where a declared value expression of a capability branch gets its value at enforcement,
    // with the plan-context members it needs; null when nothing supplies it.
    internal static (string Source, string[] Context)? FactSource(
        OperationDeclaration declaration,
        ActionBranch branch,
        string expression
    )
    {
        var name = declaration.Name;
        if (expression.StartsWith('='))
            return ("literal", []);
        if (expression.StartsWith("arg?:", StringComparison.Ordinal))
        {
            var spec = expression[5..];
            if (spec.Contains("??", StringComparison.Ordinal))
                return ("argument with the handler default", []);
            return AbsentMeaning.ContainsKey(spec) ? ("optional argument; absence is meaningful", []) : null;
        }
        if (expression.StartsWith("arg:", StringComparison.Ordinal))
            return ("required argument", []);
        if (expression.StartsWith("has:", StringComparison.Ordinal))
            return ("argument presence", []);
        if (expression == "path?:cwd")
            return ("exec cwd path fact, else the Session working directory", ["DefaultExecCwd"]);
        if (expression.StartsWith("path?:", StringComparison.Ordinal))
            return ("path fact", []);
        switch (expression)
        {
            case "each":
            case "each.path":
            case "each.node":
                return ("expansion item", []);
            case "exec-node":
            case "caller":
            case "caller-agent":
            case "prospective":
            case "tool":
            case "server-tool":
            case "placement":
            case "recall-mode":
            case "timer-kind":
            case "timer-owner":
            case "agent-or-caller":
            case "has-secret-questions":
            case "session-scope":
                return ("request", []);
            case "memory-source":
                return ("Agent memory directory", ["SessionAgent", "MemoryDirectory"]);
            case "memory-target":
                return ("Agent memory directory", ["MemoryDirectory"]);
            case "child-node":
            case "session-node":
                return ("creation Node default", ["AgentDefaultNode"]);
            case "move-agent":
                return ("moved Session's Agent", ["SessionAgent"]);
            case "status-node":
                return ("the inbound caller's selected Node", []);
            case "target-session":
                if (
                    declaration.FrontEnd is not null
                    || ToolAuthorizationPolicy.TargetResolvers.ContainsKey(name)
                    || CallerDefaultTargets.Contains(name)
                    || ArgumentTargets.Contains(name)
                )
                    return ("Session target", []);
                return null;
            case "node-target":
            case "node-target?":
            case "provider-node":
            {
                var source = declaration.Source;
                var sample = new JsonObject
                {
                    ["nodeId"] = "sample",
                    ["parentNode"] = "sample",
                };
                if (branch.Action is not null)
                    sample["action"] = branch.Action;
                if (expression == "provider-node")
                    return ("provider Node argument", []);
                return ToolAuthorizationNodeEffects.Resolve(source, name, "sample", sample) is not null
                    ? ("Node effects", [])
                    : null;
            }
            default:
                return null;
        }
    }
}
