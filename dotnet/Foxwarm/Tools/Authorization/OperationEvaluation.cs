using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// How one ordinary operation of a request was decided in a layer with operation rules: the
// first enabled version-1 rule matching the whole call or operation rule matching the
// operation, else the default. Unresolved marks an operation a reached rule (or the default)
// could not decide because a resource it tests was not established. Unreached lists the later
// rules that also match it.
internal sealed record OperationDecision(
    AuthorizationOperation Operation,
    ToolAuthorizationEffect Effect,
    JsonObject? Rule,
    bool Unresolved,
    IReadOnlyList<JsonObject> Unreached
);

// How one secret name was decided: by a version-1 `secrets` rule (over the original complete
// secret set) or a `secret.use` operation rule, else owned, else the unrestricted master exec
// fallback.
internal sealed record SecretNameDecision(
    string Name,
    ToolAuthorizationEffect Effect,
    JsonObject? Rule,
    bool Owned,
    UnrestrictedExecDecision? Fallback
);

// The two-domain evaluator of a layer that contains operation rules (phase 3). A layer of only
// version-1 rules is decided by ToolAuthorizationEvaluation exactly as before.
internal static class OperationEvaluation
{
    // The operations of a request: those its assessment derived, else derived from the request
    // itself (inbound requests, visibility and creation probes).
    internal static IReadOnlyList<AuthorizationOperation> Operations(ToolAuthorizationRequest request)
    {
        if (request.Operations is { } given)
            return given;
        var resolved = new ResolvedTool(
            request.Name,
            request.Source,
            request.Name,
            request.Args,
            request.Server,
            request.Source == "node" ? request.TargetNode ?? "master" : request.TargetNode ?? "master"
        );
        return OperationPlan.AuthorizationOperations(
            resolved,
            request,
            new PlanContext(request.CurrentNode ?? "master")
        );
    }

    private static IReadOnlyList<JsonObject> Rules(ToolAuthorizationPolicy policy) =>
        policy.Value["rules"]!.AsArray().OfType<JsonObject>().ToArray();

    private static bool Enabled(JsonObject rule) => rule["enabled"]!.GetValue<bool>();

    private static bool Restrictive(JsonObject rule) =>
        SessionWait.Text(rule["action"]) is "deny" or "ask";

    internal static AuthorizationDecision Evaluate(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        var rules = Rules(policy);
        // Version-1 ordinary rules match the whole call: one result for every operation.
        var wholeCall = new bool[rules.Count];
        for (var index = 0; index < rules.Count; index++)
            wholeCall[index] =
                Enabled(rules[index])
                && !OperationRules.IsOperationRule(rules[index])
                && ToolAuthorizationEvaluation.MatchesCall(rules[index], request);
        var operations = Operations(request);
        if (operations.Count == 0)
            // Only a Self branch has no operations, and Self calls are not assessed; anything
            // else that has none is underivable.
            operations = [new AuthorizationOperation("", [], []) { Underivable = "no operations" }];
        var decisions = operations.Select(operation => Decide(policy, rules, wholeCall, operation, request)).ToArray();
        var call = Strictest(decisions.Select(item => (item.Effect, item.Rule, (object)item)));
        var callDecision = new AuthorizationDecision(call.Effect, call.Rule);
        var asking = new List<JsonObject?>();
        foreach (var item in decisions.Where(item => item.Effect == ToolAuthorizationEffect.Ask))
            Add(asking, item.Rule);
        if (request.Principal != "internal" || request.Secrets is not { Count: > 0 } names)
            return callDecision with
            {
                Operations = decisions,
                Asking = asking,
            };
        var secretRules = new bool[rules.Count];
        for (var index = 0; index < rules.Count; index++)
            secretRules[index] =
                Enabled(rules[index])
                && !OperationRules.IsOperationRule(rules[index])
                && ToolAuthorizationEvaluation.MatchesSecrets(rules[index], request);
        var owned = (request.OwnedSecrets ?? []).ToHashSet(StringComparer.Ordinal);
        UnrestrictedExecDecision? fallback = null;
        var perName = new List<SecretNameDecision>();
        foreach (var name in names)
        {
            JsonObject? winner = null;
            for (var index = 0; index < rules.Count && winner is null; index++)
            {
                var rule = rules[index];
                if (!Enabled(rule))
                    continue;
                if (OperationRules.IsOperationRule(rule))
                {
                    if (
                        OperationRules.NamesSecretUse(rule)
                        && ToolAuthorizationEvaluation.Identity(rule["match"]!.AsObject(), request)
                        && OperationRules.CoversSecret(rule, name, request)
                    )
                        winner = rule;
                }
                else if (secretRules[index])
                    winner = rule;
            }
            if (winner is not null)
                perName.Add(new(name, ToolAuthorizationEvaluation.RuleEffect(winner, request), winner, false, null));
            else if (owned.Contains(name))
                perName.Add(new(name, ToolAuthorizationEffect.Allow, null, true, null));
            else
            {
                fallback ??= UnrestrictedMasterExec(policy, rules, request);
                perName.Add(new(name, fallback.Effect, null, false, fallback));
            }
        }
        foreach (var item in perName.Where(item => item.Effect == ToolAuthorizationEffect.Ask))
            Add(asking, item.Rule ?? item.Fallback?.Rule);
        var strictest = perName.First(item => item.Effect == perName.Max(other => other.Effect));
        var secrets = new SecretsDecision(
            strictest.Effect,
            strictest.Rule,
            strictest.Rule is null ? strictest.Fallback : null,
            perName.All(item => item.Owned)
        );
        var deciding = secrets.Rule ?? secrets.Fallback?.Rule;
        var result = secrets.Effect > callDecision.Effect
            ? new AuthorizationDecision(secrets.Effect, deciding)
            : callDecision;
        return result with
        {
            Call = callDecision,
            Secrets = secrets,
            Operations = decisions,
            SecretNames = perName,
            Asking = asking,
        };
    }

    // Asking rules once each; null stands for an asking default and is kept once.
    private static void Add(List<JsonObject?> asking, JsonObject? rule)
    {
        if (!asking.Any(item => ReferenceEquals(item, rule)))
            asking.Add(rule);
    }

    private static (ToolAuthorizationEffect Effect, JsonObject? Rule) Strictest(
        IEnumerable<(ToolAuthorizationEffect Effect, JsonObject? Rule, object Item)> items
    )
    {
        var list = items.ToArray();
        var max = list.Max(item => item.Effect);
        var first = list.First(item => item.Effect == max);
        return (max, first.Rule);
    }

    private static OperationDecision Decide(
        ToolAuthorizationPolicy policy,
        IReadOnlyList<JsonObject> rules,
        bool[] wholeCall,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request
    )
    {
        for (var index = 0; index < rules.Count; index++)
        {
            var rule = rules[index];
            if (!Enabled(rule))
                continue;
            if (OperationRules.IsOperationRule(rule))
            {
                var match = OperationRules.Match(rule, operation, request, Restrictive(rule));
                if (match == OperationMatch.No)
                    continue;
                if (match == OperationMatch.Unknown)
                    return new(operation, ToolAuthorizationEffect.Deny, rule, true, []);
            }
            else if (!wholeCall[index])
                continue;
            return new(
                operation,
                ToolAuthorizationEvaluation.RuleEffect(rule, request),
                rule,
                false,
                Unreached(rules, wholeCall, index, operation, request)
            );
        }
        // An operation whose resources are not all established never reaches a default allow.
        if (operation.HasUnresolved)
            return new(operation, ToolAuthorizationEffect.Deny, null, true, []);
        return new(operation, ToolAuthorizationEvaluation.DefaultEffect(policy, request), null, false, []);
    }

    // Later enabled rules that match the operation too, shadowed by the deciding one.
    private static IReadOnlyList<JsonObject> Unreached(
        IReadOnlyList<JsonObject> rules,
        bool[] wholeCall,
        int winner,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request
    )
    {
        var result = new List<JsonObject>();
        for (var index = winner + 1; index < rules.Count; index++)
        {
            var rule = rules[index];
            if (!Enabled(rule))
                continue;
            if (
                OperationRules.IsOperationRule(rule)
                    ? OperationRules.Match(rule, operation, request, Restrictive(rule)) == OperationMatch.Yes
                    : wholeCall[index]
            )
                result.Add(rule);
        }
        return result;
    }

    // The caller's authorization for an unrestricted exec on master in a layer with operation
    // rules: the first version-1 rule without argument or path conditions that matches exec on
    // master, or the first env.exec operation rule whose only conditions are callers and a Node
    // covering master; else the default.
    internal static UnrestrictedExecDecision UnrestrictedMasterExec(
        ToolAuthorizationPolicy policy,
        IReadOnlyList<JsonObject> rules,
        ToolAuthorizationRequest request
    )
    {
        var exec = ToolAuthorizationEvaluation.UnrestrictedExecRequest(request);
        var operation = new AuthorizationOperation(
            "env.exec",
            new JsonObject { ["node"] = "master" },
            []
        );
        foreach (var rule in rules)
        {
            if (!Enabled(rule))
                continue;
            if (OperationRules.IsOperationRule(rule))
            {
                if (
                    rule["with"] is null
                    && (rule["resources"] as JsonObject ?? []).All(pair => pair.Key == "node")
                    && OperationRules.Match(rule, operation, exec, Restrictive(rule)) == OperationMatch.Yes
                )
                    return new(ToolAuthorizationEvaluation.RuleEffect(rule, exec), rule);
                continue;
            }
            if (ToolAuthorizationEvaluation.EstablishesUnrestrictedExec(rule, exec))
                return new(ToolAuthorizationEvaluation.RuleEffect(rule, exec), rule);
        }
        return new(ToolAuthorizationEvaluation.DefaultEffect(policy, exec), null);
    }

    // Visibility of a request in a layer with operation rules. A capability is visible when one
    // of its possible branches has every unconditional operation possible; a Self branch is
    // always possible. Version-1 rules keep today's walk over the raw arguments the caller
    // states; operation rules see the operation's known resources, and an unknown one leaves
    // the rule conditional.
    internal static bool Visible(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request,
        Func<JsonObject, (bool Skip, bool Conditional)> wholeCall,
        bool unknownNodes,
        bool actionKnown
    )
    {
        var declaration = OperationDeclarations.Find(request.Source, request.Name);
        var rules = Rules(policy);
        var branches = declaration is null
            ? []
            : OperationPlan
                .BranchOperations(
                    declaration,
                    new ResolvedTool(
                        request.Name,
                        request.Source,
                        request.Name,
                        request.Args,
                        request.Server,
                        request.TargetNode ?? "master"
                    ),
                    request,
                    actionKnown
                )
                .ToArray();
        if (branches.Length == 0)
            return VisibleOperation(
                policy,
                rules,
                new AuthorizationOperation("", [], []) { Underivable = "no declared branch" },
                request,
                wholeCall
            );
        foreach (var (branch, operations) in branches)
        {
            if (branch.Self is not null)
                return true;
            // Only a Node tool listed for an explicit Node knows its Node. Builtin declarations
            // never depend on the current Node, Node inventory or placement, so a `node`
            // resource stays unknown there (request-prefix stability).
            var stated = unknownNodes || request.Source != "node"
                ? operations
                    .Select(operation =>
                        operation.Resources.ContainsKey("node")
                            ? operation with
                            {
                                Resources = WithUnknown(operation.Resources, "node"),
                            }
                            : operation
                    )
                    .ToArray()
                : operations;
            if (
                stated.Count == 0
                    ? VisibleOperation(
                        policy,
                        rules,
                        new AuthorizationOperation("", [], []) { Underivable = "conditional only" },
                        request,
                        wholeCall
                    )
                    : stated.All(operation => VisibleOperation(policy, rules, operation, request, wholeCall))
            )
                return true;
        }
        return false;
    }

    private static JsonObject WithUnknown(JsonObject resources, string key)
    {
        var copy = (JsonObject)resources.DeepClone();
        copy[key] = null;
        return copy;
    }

    private static bool VisibleOperation(
        ToolAuthorizationPolicy policy,
        IReadOnlyList<JsonObject> rules,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request,
        Func<JsonObject, (bool Skip, bool Conditional)> wholeCall
    )
    {
        foreach (var rule in rules)
        {
            if (!Enabled(rule))
                continue;
            bool conditional;
            if (OperationRules.IsOperationRule(rule))
            {
                var match = OperationRules.Match(rule, operation, request, Restrictive(rule));
                if (match == OperationMatch.No)
                    continue;
                conditional = match == OperationMatch.Unknown;
            }
            else
            {
                var (skip, unknown) = wholeCall(rule);
                if (skip)
                    continue;
                conditional = unknown;
            }
            var possible =
                ToolAuthorizationEvaluation.RuleEffect(rule, request) != ToolAuthorizationEffect.Deny;
            if (!conditional)
                return possible;
            if (possible)
                return true;
        }
        return ToolAuthorizationEvaluation.DefaultEffect(policy, request) != ToolAuthorizationEffect.Deny;
    }
}
