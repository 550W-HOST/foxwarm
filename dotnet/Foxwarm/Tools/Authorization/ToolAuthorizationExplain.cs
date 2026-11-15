using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// One policy's outcome for one probe: the shared assessment, or the denial raised before
// policy evaluation.
internal sealed record ExplainedVariant(AuthorizationAssessment? Assessment, string? Precheck)
{
    internal bool PolicyDenied => Assessment?.Denied is not null;

    // Deny is decided before anyone would be asked.
    internal bool Asked =>
        Assessment is { Denied: null } assessment
        && assessment.Effect == ToolAuthorizationEffect.Ask;

    internal string Decision =>
        Assessment is null || PolicyDenied ? "deny"
        : Asked ? "ask"
        : "allow";
}

// Read-only projections for explain_tool_authorization. Decisions come from the shared
// assessment; nothing here evaluates policy itself.
internal static class ToolAuthorizationExplain
{
    internal static string ToolId(ResolvedTool resolved) =>
        resolved.Source switch
        {
            "builtin" => "builtin:" + resolved.Name,
            "mcp" => $"mcp:{resolved.Server}/{resolved.Name}",
            _ => $"{resolved.Source}:{resolved.ExecutionNode}/{resolved.Name}",
        };

    internal static JsonObject FullVariant(ExplainedVariant variant)
    {
        if (variant.Assessment is not { } assessment)
            return new JsonObject
            {
                ["decision"] = "deny",
                ["allowed"] = false,
                ["deniedBy"] = "precheck",
                ["precheck"] = variant.Precheck,
            };
        var result = new JsonObject
        {
            ["decision"] = variant.Decision,
            ["allowed"] = !variant.PolicyDenied && !variant.Asked,
            ["deniedBy"] = variant.PolicyDenied ? "policy" : null,
        };
        if (variant.Asked)
        {
            result["askedBy"] = "policy";
            result["approval"] = assessment.Approval.ToJson();
        }
        if (assessment.Self is { } self)
            result["self"] = self;
        result["layers"] = new JsonArray(
            assessment.Layers.Select(layer => (JsonNode?)Layer(layer)).ToArray()
        );
        result["facts"] = Facts(assessment.Request);
        return result;
    }

    // The decision and, for each layer that matched a rule or did not allow, the layer, its
    // deciding rule ID (null for the default) and its decision. A layer with secret facts also
    // names how they were decided. A precheck denial has no layers and carries its message.
    internal static JsonObject CompactVariant(ExplainedVariant variant, JsonObject result)
    {
        result["decision"] = variant.Decision;
        if (variant.Assessment is not { } assessment)
        {
            result["precheck"] = variant.Precheck;
            return result;
        }
        if (assessment.Self is not null)
            result["self"] = true;
        var rules = new JsonArray();
        foreach (var layer in assessment.Layers)
        {
            var decision = layer.Decision;
            var rule = (decision.Call ?? decision).Rule;
            JsonObject? secrets = null;
            if (decision.Secrets is { } detail)
            {
                var deciding = detail.Rule ?? detail.Fallback?.Rule;
                secrets = new JsonObject
                {
                    ["decision"] = AuthorizationDecision.Name(detail.Effect),
                    ["rule"] = deciding is null ? null : RuleId(deciding),
                };
            }
            if (
                rule is null
                && secrets?["rule"] is null
                && decision.Effect == ToolAuthorizationEffect.Allow
            )
                continue;
            var entry = new JsonObject
            {
                ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
                ["rule"] = rule is null ? null : RuleId(rule),
                ["decision"] = AuthorizationDecision.Name(decision.Effect),
            };
            if (secrets is not null)
                entry["secrets"] = secrets;
            rules.Add(entry);
        }
        result["rules"] = rules;
        return result;
    }

    // The first check other than the call's own request that does not allow: one that denies
    // (or is indeterminate) before one that asks. It names the check, its decision and the
    // deciding rule ID (null for a default). Nothing is added when every such check allows or
    // was not evaluated.
    internal static void CompactObligation(JsonArray obligations, JsonObject result)
    {
        var others = obligations
            .OfType<JsonObject>()
            .Where(item =>
                SessionWait.Text(item["id"]) != "primary"
                && item["sameAs"] is null
                && item["decision"] is not null
            )
            .ToArray();
        var deciding =
            others.FirstOrDefault(item =>
                SessionWait.Text(item["decision"]) is "deny" or "indeterminate"
            ) ?? others.FirstOrDefault(item => SessionWait.Text(item["decision"]) == "ask");
        if (deciding is null)
            return;
        var decision = SessionWait.Text(deciding["decision"]);
        var layer = (deciding["layers"] as JsonArray)
            ?.OfType<JsonObject>()
            .FirstOrDefault(item => SessionWait.Text(item["decision"]) == decision);
        var entry = new JsonObject
        {
            ["id"] = deciding["id"]?.DeepClone(),
            ["decision"] = decision,
        };
        if (layer?["conservative"] is not null)
        {
            // A conservative creation target lists the IDs of the rules that contributed.
            entry["conservative"] = true;
            entry["rules"] = new JsonArray(
                (layer["rules"] as JsonArray ?? [])
                    .Select(item => item?["id"]?.DeepClone())
                    .ToArray()
            );
            if (layer["default"] is { } fallback)
                entry["default"] = fallback.DeepClone();
        }
        else
            entry["rule"] = layer?["rule"]?["id"]?.DeepClone();
        result["obligation"] = entry;
    }

    private static JsonNode? RuleId(JsonObject rule) => rule["id"]?.DeepClone();

    private static JsonArray Rules(ToolAuthorizationPolicy policy) =>
        policy.Value["rules"]!.AsArray();

    // decision is the layer's outcome. rule (or default) is the call's own first match; with
    // secret facts, secrets shows how they were decided and decision is the stricter of the two.
    internal static JsonObject Layer(AuthorizationLayerDecision layer)
    {
        var result = new JsonObject
        {
            ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
            ["decision"] = AuthorizationDecision.Name(layer.Decision.Effect),
            ["allowed"] = layer.Decision.Allowed,
        };
        Matched(result, layer.Policy, (layer.Decision.Call ?? layer.Decision).Rule);
        if (layer.Decision.Secrets is { } secrets)
        {
            var detail = new JsonObject
            {
                ["decision"] = AuthorizationDecision.Name(secrets.Effect),
            };
            if (secrets.Fallback is { } fallback)
            {
                detail["rule"] = null;
                var exec = new JsonObject
                {
                    ["decision"] = AuthorizationDecision.Name(fallback.Effect),
                };
                Matched(exec, layer.Policy, fallback.Rule);
                detail["unrestrictedMasterExec"] = exec;
            }
            else if (secrets.Owned)
            {
                detail["rule"] = null;
                detail["owned"] = true;
            }
            else
                Matched(detail, layer.Policy, secrets.Rule);
            result["secrets"] = detail;
        }
        if (layer.Decision.Operations is { } operations)
            result["operations"] = new JsonArray(
                operations.Select(item => (JsonNode?)Operation(layer.Policy, item)).ToArray()
            );
        if (layer.Decision.SecretNames is { } names)
            result["secretNames"] = new JsonArray(
                names.Select(item => (JsonNode?)SecretName(layer.Policy, item)).ToArray()
            );
        return result;
    }

    // A rule as per-operation results name it: position, ID and kind.
    private static JsonObject RuleRef(ToolAuthorizationPolicy policy, JsonObject rule) =>
        new()
        {
            ["index"] = Rules(policy).IndexOf(rule) + 1,
            ["id"] = rule["id"]?.DeepClone(),
            ["ruleKind"] = OperationRules.IsOperationRule(rule) ? "operation" : "whole-call",
        };

    // How one operation was decided in a layer with operation rules: its first matching rule
    // (or the default), the later rules that also match it, and whether it could not be
    // resolved.
    private static JsonObject Operation(ToolAuthorizationPolicy policy, OperationDecision item)
    {
        var result = item.Operation.ToJson();
        result["decision"] = AuthorizationDecision.Name(item.Effect);
        if (item.Rule is { } rule)
            result["rule"] = RuleRef(policy, rule);
        else
        {
            result["rule"] = null;
            if (!item.Unresolved)
                result["default"] = policy.Value["defaultAction"]?.DeepClone();
        }
        if (item.Unresolved)
            result["unresolved"] = true;
        if (item.Unreached.Count > 0)
            result["unreached"] = new JsonArray(
                item.Unreached.Select(other => (JsonNode?)RuleRef(policy, other)).ToArray()
            );
        return result;
    }

    private static JsonObject SecretName(ToolAuthorizationPolicy policy, SecretNameDecision item)
    {
        var result = new JsonObject
        {
            ["name"] = item.Name,
            ["decision"] = AuthorizationDecision.Name(item.Effect),
            ["rule"] = item.Rule is { } rule ? RuleRef(policy, rule) : null,
        };
        if (item.Owned)
            result["owned"] = true;
        if (item.Fallback is { } fallback)
            result["fallback"] = new JsonObject
            {
                ["decision"] = AuthorizationDecision.Name(fallback.Effect),
                ["rule"] = fallback.Rule is { } exec ? RuleRef(policy, exec) : null,
            };
        return result;
    }

    private static void Matched(JsonObject result, ToolAuthorizationPolicy policy, JsonObject? rule)
    {
        if (rule is null)
        {
            result["rule"] = null;
            result["default"] = policy.Value["defaultAction"]?.DeepClone();
            return;
        }
        var matched = new JsonObject
        {
            ["index"] = Rules(policy).IndexOf(rule) + 1,
            ["id"] = rule["id"]?.DeepClone(),
            ["action"] = rule["action"]?.DeepClone(),
        };
        if (rule["reason"] is { } reason)
            matched["reason"] = reason.DeepClone();
        if (rule["approval"] is { } approval)
            matched["approval"] = approval.DeepClone();
        matched["match"] = rule["match"]?.DeepClone();
        if (OperationRules.IsOperationRule(rule))
        {
            matched["ruleKind"] = "operation";
            matched["op"] = rule["op"]?.DeepClone();
            if (rule["resources"] is { } resources)
                matched["resources"] = resources.DeepClone();
            if (rule["with"] is { } with)
                matched["with"] = with.DeepClone();
        }
        else if (policy.HasOperationRules)
            matched["ruleKind"] = "whole-call";
        result["rule"] = matched;
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
        if (request.Operations is { Count: > 0 } operations)
            facts["operations"] = new JsonArray(
                operations.Select(operation => (JsonNode?)operation.ToJson()).ToArray()
            );
        if (request.Secrets is { Count: > 0 } secrets)
            facts["secrets"] = new JsonArray(
                secrets.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            );
        if (request.OwnedSecrets is { Count: > 0 } owned)
            facts["ownedSecrets"] = new JsonArray(
                owned.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            );
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
