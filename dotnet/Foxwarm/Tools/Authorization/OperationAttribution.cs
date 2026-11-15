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
        layer is null ? "the global policy" : $"the rules of Agent `{layer}`";

    private static string RuleName(ToolAuthorizationPolicy policy, JsonObject rule)
    {
        var index = policy.Value["rules"]!.AsArray().IndexOf(rule) + 1;
        return $"Rule `{SessionWait.Text(rule["id"])}` (#{index})";
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
            var names = string.Join(", ", (secrets ?? []).Select(name => $"`{name}`"));
            what = $"the use of {names} by {what}";
            if (decision.Secrets?.Fallback is not null)
                what += " through the unrestricted master exec fallback";
        }
        return $"{who} denied {what}, called as `{Invocation(call)}`.";
    }

    // The attribution of a refused timer creation target.
    internal static string CreationTarget(ResolvedTool? primary, string? layer) =>
        $"{Capitalized(LayerName(layer))} denied the create_session creation target (`builtin:create_session`)"
        + (
            primary is null
                ? "."
                : $" for `{OperationPlan.CapabilityId(primary)}`, called as `{Invocation(primary)}`."
        );

    private static string Capitalized(string text) =>
        text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];

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
            ["layer"] = layer.Layer is null ? "global" : "agent:" + layer.Layer,
            ["decision"] = AuthorizationDecision.Name(layer.Decision.Effect),
        };
        if (layer.Decision.Rule is { } rule)
            result["rule"] = new JsonObject
            {
                ["index"] = layer.Policy.Value["rules"]!.AsArray().IndexOf(rule) + 1,
                ["id"] = rule["id"]?.DeepClone(),
            };
        else
        {
            result["rule"] = null;
            result["default"] = layer.Policy.Value["defaultAction"]?.DeepClone();
        }
        return result;
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
