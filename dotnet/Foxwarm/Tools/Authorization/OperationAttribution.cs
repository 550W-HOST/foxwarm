using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// What decided an assessment, read from the existing evaluator's result: the effect, the
// deciding layer and rule (null with Default for a default action), the secret part and the
// approval options of an ask. Attribution never evaluates policy itself.
internal sealed record DecisionAttribution(
    ToolAuthorizationEffect Effect,
    AuthorizationLayerDecision? Layer,
    JsonObject? Rule,
    SecretsDecision? Secrets,
    ToolApprovalOptions? Approval
)
{
    internal bool Default => Layer is not null && Rule is null;
}

internal static class OperationAttribution
{
    // The deciding layer is the first denying layer, else the first asking one. An allowed call
    // has no deciding layer: every layer passed.
    internal static DecisionAttribution Of(AuthorizationAssessment assessment)
    {
        var layer =
            assessment.Denied
            ?? assessment.Layers.FirstOrDefault(item =>
                item.Decision.Effect == ToolAuthorizationEffect.Ask
            );
        var secrets =
            layer?.Decision.Secrets
            ?? assessment
                .Layers.Select(item => item.Decision.Secrets)
                .FirstOrDefault(item => item is not null);
        return new(
            assessment.Effect,
            layer,
            layer?.Decision.Rule,
            secrets,
            assessment.Effect == ToolAuthorizationEffect.Ask ? assessment.Approval : null
        );
    }

    // How the model names the call: `ctl <command>` for a ctl command, otherwise the invoked
    // tool name.
    internal static string Invocation(ResolvedTool tool) =>
        tool.Command is { } command ? "ctl " + command : tool.InvocationName;

    // The primary call of the current invocation, when the check runs inside one.
    internal static ResolvedTool? Primary(SessionOwner owner) =>
        ToolApprovalScope.Current is { } scope && ReferenceEquals(scope.Owner, owner)
            ? scope.Primary
            : null;

    private static bool SameIdentity(ResolvedTool left, ResolvedTool right) =>
        left.Source == right.Source
        && left.Name == right.Name
        && left.Server == right.Server
        && left.ExecutionNode == right.ExecutionNode;

    private static bool Matches(string capability, ResolvedTool check)
    {
        var colon = capability.IndexOf(':');
        return colon > 0
            && check.Source == capability[..colon]
            && check.Name == capability[(colon + 1)..];
    }

    // The declared obligation a check of the invocation corresponds to; null for the primary
    // request itself (including its effect-owner rechecks).
    internal static ObligationTemplate? Obligation(ResolvedTool? primary, ResolvedTool check)
    {
        if (primary is null || ReferenceEquals(primary, check))
            return null;
        var declaration = OperationDeclarations.Find(primary.Source, primary.Name);
        if (SameIdentity(primary, check))
            return JsonNode.DeepEquals(primary.Args, check.Args)
                ? null
                : declaration?.Obligations.FirstOrDefault(item =>
                    item.Kind == ObligationKind.Retained && item.Capability == "same"
                );
        var candidates = declaration
            ?.Obligations.Where(item => Matches(item.Capability, check))
            .ToArray() ?? [];
        var path = SessionWait.Text(check.Args["filePath"])?.Trim();
        return candidates.FirstOrDefault(item =>
                item.PathArg is { } arg
                && path is not null
                && SessionWait.Text(primary.Args[arg])?.Trim() == path
            )
            ?? candidates.FirstOrDefault(item => item.PathArg is null)
            ?? candidates.FirstOrDefault()
            ?? OperationDeclarations.Common.FirstOrDefault(item =>
                item.Id == "output-spill" && check is { Source: "node", Name: "read" or "write" }
            );
    }

    internal static string LayerName(string? layer) =>
        layer is null ? "the global policy"
        : layer == OperatorCeiling.Layer ? "the operator ceiling"
        : $"the rules of Agent `{layer}`";

    // Sentence-initial by default; `lower` for use in the middle of a sentence.
    private static string RuleName(ToolAuthorizationPolicy policy, JsonObject rule, bool lower = false)
    {
        var index = policy.Value["rules"]!.AsArray().IndexOf(rule) + 1;
        return $"{(lower ? "rule" : "Rule")} `{SessionWait.Text(rule["id"])}` (#{index})";
    }

    // The attribution appended to a denial: the deciding rule and layer, the denied obligation
    // and its capability, and the command that was called.
    internal static string Denial(
        ResolvedTool check,
        ResolvedTool? primary,
        AuthorizationLayerDecision denied,
        IReadOnlyList<string>? secrets
    )
    {
        var decision = denied.Decision;
        var secretPart = decision
            is {
                Secrets.Effect: ToolAuthorizationEffect.Deny,
                Call.Effect: not ToolAuthorizationEffect.Deny
            };
        var rule = decision.Rule;
        var who = rule is null
            ? $"The default action of {LayerName(denied.Layer)}"
            : $"{RuleName(denied.Policy, rule)} in {LayerName(denied.Layer)}";
        var capability = $"`{OperationPlan.CapabilityId(check)}`";
        var obligation = Obligation(primary, check);
        var call = primary ?? check;
        var called = $"`{OperationPlan.CapabilityId(call)}`";
        var what =
            obligation is null ? capability
            : capability == called ? $"the {obligation.Description} of {capability}"
            : $"the {obligation.Description} ({capability}) for {called}";
        if (secretPart)
        {
            // With operation rules each name has its own decision; name the denied ones.
            var refused = decision.SecretNames is { } perName
                ? perName
                    .Where(item => item.Effect == ToolAuthorizationEffect.Deny)
                    .Select(item => item.Name)
                    .ToArray()
                : secrets ?? [];
            var names = string.Join(", ", refused.Select(name => $"`{name}`"));
            what = $"the use of {names} by {what}";
            if (decision.Secrets?.Fallback is not null)
                what += " through the unrestricted master exec fallback";
        }
        else if (
            decision.Operations?.FirstOrDefault(item => item.Effect == ToolAuthorizationEffect.Deny)
            is { } operation
        )
            what = $"the operation {OperationText(operation.Operation)} of {what}";
        return $"{who} denied {what}, called as `{Invocation(call)}`.";
    }

    // An operation as denials name it: the op and its established resources.
    internal static string OperationText(AuthorizationOperation operation)
    {
        var parts = new List<string>();
        foreach (var (key, value) in operation.Resources)
        {
            var text = value switch
            {
                null => null,
                JsonObject marker when marker["prospective"] is not null => "a new Session",
                JsonObject identity => string.Join(
                    "/",
                    identity.Select(pair => SessionWait.Text(pair.Value)).OfType<string>()
                ),
                _ => SessionWait.Text(value) ?? value.ToJsonText(),
            };
            if (text is not null)
                parts.Add($"{key} `{text}`");
        }
        return parts.Count == 0 ? $"`{operation.Op}`" : $"`{operation.Op}` ({string.Join(", ", parts)})";
    }

    // The rejection of a call operation rules could not decide: which operation, which facts
    // were missing, and the rule (or default) that needed them.
    internal static string Unresolved(
        ResolvedTool check,
        ResolvedTool? primary,
        AuthorizationLayerDecision denied,
        OperationDecision unresolved
    )
    {
        var call = primary ?? check;
        var capability = $"`{OperationPlan.CapabilityId(check)}`";
        var who = unresolved.Rule is { } rule
            ? $"{RuleName(denied.Policy, rule, lower: true)} in {LayerName(denied.Layer)}"
            : $"the operation rules of {LayerName(denied.Layer)}";
        var operation = unresolved.Operation;
        if (operation.Underivable is { } reason)
            return $"Tool authorization can't determine what {capability} would do ({reason}), called as `{Invocation(call)}`, so {who} can't decide it. The call was not executed.";
        var missing = operation
            .Resources.Where(pair => pair.Value is null)
            .Select(pair => pair.Key)
            .Concat(operation.With.Where(pair => pair.Value is null).Select(pair => "with." + pair.Key))
            .ToArray();
        var facts = missing.Length == 0
            ? "the tested facts"
            : "the " + string.Join(", ", missing.Select(name => $"`{name}`"));
        return $"Tool authorization can't establish {facts} of the operation `{operation.Op}` ({capability}, called as `{Invocation(call)}`), so {who} can't decide it. The call was not executed.";
    }

    // What a creation-target outcome is attributed to. A deny or ask the stopping rule (or
    // default) gives itself is definite. Otherwise the outcome is conservative: the rules that
    // contributed the deny or ask are named, never an allowing rule or default.
    internal static (IReadOnlyList<CreationContribution> Causes, bool Conservative) CreationCauses(
        CreationTargetOutcome outcome
    )
    {
        var settling = outcome.Contributions[^1];
        var effect = outcome.Decision switch
        {
            CreationTargetDecision.Deny => ToolAuthorizationEffect.Deny,
            CreationTargetDecision.Ask => ToolAuthorizationEffect.Ask,
            CreationTargetDecision.Allow => ToolAuthorizationEffect.Allow,
            _ => (ToolAuthorizationEffect?)null,
        };
        if (effect is { } definite && settling.Effect == definite)
            return ([settling], false);
        return (
            outcome
                .Contributions.Where(item =>
                    effect is { } wanted
                        ? item.Effect == wanted
                        : item.Effect != ToolAuthorizationEffect.Allow
                )
                .ToArray(),
            true
        );
    }

    // The attribution of a refused timer creation target: one sentence naming what denied it,
    // required approval, or may do either depending on arguments known only at creation.
    internal static string CreationTarget(
        ResolvedTool? primary,
        string? layer,
        ToolAuthorizationPolicy policy,
        CreationTargetOutcome outcome
    )
    {
        var (causes, conservative) = CreationCauses(outcome);
        var rules = causes
            .Where(item => item.Rule is not null)
            .Select(item => RuleName(policy, item.Rule!))
            .ToArray();
        var fallback = causes.Any(item => item.Rule is null);
        var listed = rules.Length switch
        {
            0 => "",
            1 => rules[0],
            _ => "Rules "
                + string.Join(", ", rules[..^1].Select(name => name["Rule ".Length..]))
                + " and "
                + rules[^1]["Rule ".Length..],
        };
        var who =
            rules.Length == 0 ? $"The default action of {LayerName(layer)}"
            : fallback ? $"{listed} in {LayerName(layer)} and its default action"
            : $"{listed} in {LayerName(layer)}";
        var deny = causes.Any(item => item.Effect == ToolAuthorizationEffect.Deny);
        var ask = causes.Any(item => item.Effect == ToolAuthorizationEffect.Ask);
        var verb =
            !conservative ? (deny ? "denied" : "requires approval for")
            : deny && ask ? "may deny or require approval for"
            : deny ? "may deny"
            : "may require approval for";
        return $"{who} {verb} the create_session creation target (`builtin:create_session`)"
            + (conservative ? ", depending on arguments known only when the Session is created" : "")
            + (
                primary is null ? "."
                : (conservative ? "," : "")
                    + $" for `{OperationPlan.CapabilityId(primary)}`, called as `{Invocation(primary)}`."
            );
    }

    internal static string Append(string message, string attribution) =>
        message.TrimEnd() is var trimmed && trimmed.Length > 0
            ? (trimmed[^1] is '.' or '!' or '?' ? trimmed : trimmed + ".") + " " + attribution
            : attribution;

    // One layer of an obligation's decision for explanations: decision and the deciding rule
    // (index and id) or the default.
    internal static JsonObject Layer(AuthorizationLayerDecision layer)
    {
        var result = new JsonObject
        {
            ["layer"] = OperatorCeiling.Label(layer.Layer),
            ["decision"] = AuthorizationDecision.Name(layer.Decision.Effect),
        };
        RuleReference(result, layer.Policy, layer.Decision.Rule);
        return result;
    }

    // One layer of a creation-target probe: its decision and the rule (or default) it is
    // attributed to. A conservative outcome lists, as rules and default, every contribution of
    // its deny or ask instead.
    internal static JsonObject CreationLayer(
        string? layer,
        ToolAuthorizationPolicy policy,
        CreationTargetOutcome outcome
    )
    {
        var result = new JsonObject
        {
            ["layer"] = OperatorCeiling.Label(layer),
            ["decision"] = outcome.Decision.ToString().ToLowerInvariant(),
        };
        var (causes, conservative) = CreationCauses(outcome);
        if (!conservative)
        {
            RuleReference(result, policy, causes[0].Rule);
            return result;
        }
        result["conservative"] = true;
        result["rules"] = new JsonArray(
            causes
                .Where(item => item.Rule is not null)
                .Select(item =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["index"] = policy.Value["rules"]!.AsArray().IndexOf(item.Rule!) + 1,
                            ["id"] = item.Rule!["id"]?.DeepClone(),
                            ["action"] = AuthorizationDecision.Name(item.Effect),
                        }
                )
                .ToArray()
        );
        if (causes.Any(item => item.Rule is null))
            result["default"] = policy.Value["defaultAction"]?.DeepClone();
        return result;
    }

    private static void RuleReference(JsonObject result, ToolAuthorizationPolicy policy, JsonObject? rule)
    {
        if (rule is not null)
            result["rule"] = new JsonObject
            {
                ["index"] = policy.Value["rules"]!.AsArray().IndexOf(rule) + 1,
                ["id"] = rule["id"]?.DeepClone(),
            };
        else
        {
            result["rule"] = null;
            result["default"] = policy.Value["defaultAction"]?.DeepClone();
        }
    }

    internal static JsonObject Obligation(PlannedObligation obligation, AuthorizationAssessment assessment)
    {
        var attribution = Of(assessment);
        var result = new JsonObject
        {
            ["id"] = obligation.Id,
            ["decision"] = AuthorizationDecision.Name(attribution.Effect),
            ["layers"] = new JsonArray(
                assessment.Layers.Select(layer => (JsonNode?)Layer(layer)).ToArray()
            ),
        };
        if (attribution.Approval is { } approval)
            result["approval"] = approval.ToJson();
        return result;
    }
}
