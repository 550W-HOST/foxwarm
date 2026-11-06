using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// Read-only projections for explain_tool_authorization. Decisions come from the shared
// assessment; nothing here evaluates policy itself.
internal static class ToolAuthorizationExplain
{
    private static JsonArray Rules(ToolAuthorizationPolicy policy) =>
        policy.Value["rules"]!.AsArray();

    internal static JsonObject Layer(AuthorizationLayerDecision layer)
    {
        var result = new JsonObject
        {
            ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
            ["allowed"] = layer.Decision.Allowed,
        };
        if (layer.Decision.Rule is { } rule)
        {
            var matched = new JsonObject
            {
                ["index"] = Rules(layer.Policy).IndexOf(rule) + 1,
                ["id"] = rule["id"]?.DeepClone(),
                ["action"] = rule["action"]?.DeepClone(),
            };
            if (rule["reason"] is { } reason)
                matched["reason"] = reason.DeepClone();
            matched["match"] = rule["match"]?.DeepClone();
            result["rule"] = matched;
        }
        else
        {
            result["rule"] = null;
            result["default"] = layer.Policy.Value["defaultAction"]?.DeepClone();
        }
        return result;
    }

    internal static JsonObject Facts(ToolAuthorizationRequest request)
    {
        var facts = new JsonObject
        {
            ["agent"] = request.Agent,
            ["session"] = request.Session,
            ["currentNode"] = request.CurrentNode,
            ["targetNode"] = request.TargetNode,
        };
        if (request.NodeTargets is { } nodes)
            facts["nodeTargets"] = new JsonArray(nodes.Select(node => (JsonNode?)node).ToArray());
        if (request.Paths.Count > 0)
            facts["paths"] = new JsonArray(
                request
                    .Paths.Select(path =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["arg"] = path.Arg,
                                ["raw"] = path.Raw,
                                ["resolved"] = path.Resolved,
                                ["node"] = path.Node,
                            }
                    )
                    .ToArray()
            );
        if (request.SourceParent is not null)
            facts["sourceParent"] = request.SourceParent;
        if (request.SessionTarget is { } target)
            facts["sessionTarget"] = new JsonObject
            {
                ["id"] = target.Id,
                ["agent"] = target.Agent,
                ["parent"] = target.Parent,
            };
        if (request.TaskOwnerSession is not null)
            facts["taskOwnerSession"] = request.TaskOwnerSession;
        return facts;
    }

    // Rules are compared in normalized form, so YAML layout changes are not modifications.
    // Moved rules are common ids outside a longest common subsequence of the two orders,
    // so an insertion does not mark every later rule as moved.
    internal static JsonObject RuleDiff(
        ToolAuthorizationPolicy active,
        ToolAuthorizationPolicy candidate
    )
    {
        static Dictionary<string, (int Index, JsonObject Rule)> Index(
            ToolAuthorizationPolicy policy
        ) =>
            Rules(policy)
                .OfType<JsonObject>()
                .Select((rule, index) => (Id: SessionWait.Text(rule["id"])!, index, rule))
                .ToDictionary(item => item.Id, item => (item.index + 1, item.rule));
        var before = Index(active);
        var after = Index(candidate);
        JsonObject Entry(string id, int? from, int? to)
        {
            var entry = new JsonObject { ["id"] = id };
            if (from is not null && to is not null)
            {
                entry["activeIndex"] = from;
                entry["candidateIndex"] = to;
            }
            else
                entry["index"] = from ?? to;
            return entry;
        }
        var common = before.Keys.Where(after.ContainsKey).ToHashSet(StringComparer.Ordinal);
        var first = before
            .OrderBy(item => item.Value.Index)
            .Select(item => item.Key)
            .Where(common.Contains)
            .ToArray();
        var second = after
            .OrderBy(item => item.Value.Index)
            .Select(item => item.Key)
            .Where(common.Contains)
            .ToArray();
        var kept = LongestCommonSubsequence(first, second);
        var result = new JsonObject();
        var defaults = (
            SessionWait.Text(active.Value["defaultAction"]),
            SessionWait.Text(candidate.Value["defaultAction"])
        );
        if (defaults.Item1 != defaults.Item2)
            result["defaultAction"] = new JsonObject
            {
                ["active"] = defaults.Item1,
                ["candidate"] = defaults.Item2,
            };
        result["added"] = new JsonArray(
            after
                .Where(item => !before.ContainsKey(item.Key))
                .OrderBy(item => item.Value.Index)
                .Select(item => (JsonNode?)Entry(item.Key, null, item.Value.Index))
                .ToArray()
        );
        result["removed"] = new JsonArray(
            before
                .Where(item => !after.ContainsKey(item.Key))
                .OrderBy(item => item.Value.Index)
                .Select(item => (JsonNode?)Entry(item.Key, item.Value.Index, null))
                .ToArray()
        );
        result["changed"] = new JsonArray(
            second
                .Where(id => !JsonNode.DeepEquals(before[id].Rule, after[id].Rule))
                .Select(id => (JsonNode?)Entry(id, before[id].Index, after[id].Index))
                .ToArray()
        );
        result["moved"] = new JsonArray(
            second
                .Where(id => !kept.Contains(id))
                .Select(id => (JsonNode?)Entry(id, before[id].Index, after[id].Index))
                .ToArray()
        );
        return result;
    }

    private static HashSet<string> LongestCommonSubsequence(string[] first, string[] second)
    {
        var lengths = new int[first.Length + 1, second.Length + 1];
        for (var i = first.Length - 1; i >= 0; i--)
        for (var j = second.Length - 1; j >= 0; j--)
            lengths[i, j] =
                first[i] == second[j]
                    ? lengths[i + 1, j + 1] + 1
                    : Math.Max(lengths[i + 1, j], lengths[i, j + 1]);
        var kept = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0, j = 0; i < first.Length && j < second.Length; )
            if (first[i] == second[j])
            {
                kept.Add(first[i]);
                i++;
                j++;
            }
            else if (lengths[i + 1, j] >= lengths[i, j + 1])
                i++;
            else
                j++;
        return kept;
    }
}
