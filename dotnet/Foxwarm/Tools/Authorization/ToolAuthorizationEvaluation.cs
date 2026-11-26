using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal readonly record struct AuthorizationFact(bool Present, JsonNode? Value)
{
    internal static AuthorizationFact Of(string? value) =>
        new(value is not null, JsonValue.Create(value));
}

internal sealed record AuthorizationTarget(string Id, string Agent, string? Parent);

internal sealed record AuthorizationPath(
    string Arg,
    string Raw,
    string? Resolved,
    string Node = "master",
    // A copy leg: the directory and everything in it, so a rule about any path inside applies.
    bool Tree = false
);

internal sealed record ToolAuthorizationRequest(
    string Source,
    string Name,
    string? Server,
    JsonObject Args,
    IReadOnlyList<AuthorizationPath> Paths,
    string? Agent,
    string? Session,
    string? TargetNode,
    string Workspace,
    string? AgentDirectory,
    string? MemoryDirectory,
    string? SourceParent = null,
    AuthorizationTarget? SessionTarget = null,
    string Principal = "internal",
    string? ExternalId = null,
    string? TaskOwnerSession = null,
    IReadOnlyList<string>? NodeTargets = null,
    string? CurrentNode = null,
    Foxwarm.Nodes.NodeAuthorizationForest? NodeForest = null,
    // Stored secrets the call would send to a destination they were not sent to before.
    IReadOnlyList<string>? Secrets = null,
    // Those of Secrets that the caller's Agent owns.
    IReadOnlyList<string>? OwnedSecrets = null,
    // The operations operation rules decide, with their facts, when the assessment derived
    // them (or a host call stated them, such as a ToolScript model request). Null derives them
    // from the request itself when a layer has operation rules.
    IReadOnlyList<AuthorizationOperation>? Operations = null
);

internal enum ToolAuthorizationEffect
{
    Allow,
    Ask,
    Deny,
}

// Allowed means the call proceeds without a person. Consumers that cannot ask anyone read only
// Allowed and therefore treat Ask as a denial.
internal sealed record AuthorizationDecision(ToolAuthorizationEffect Effect, JsonObject? Rule)
{
    internal bool Allowed => Effect == ToolAuthorizationEffect.Allow;

    // Set when the request carries secret facts: the call's own first match and the decision of
    // its secrets. Effect is the stricter of the two, and Rule belongs to the one that decided it.
    internal AuthorizationDecision? Call { get; init; }
    internal SecretsDecision? Secrets { get; init; }

    // Set by a layer with operation rules: how each ordinary operation and each secret name was
    // decided, and every asking rule of both (null for an asking default), once each.
    internal IReadOnlyList<OperationDecision>? Operations { get; init; }
    internal IReadOnlyList<SecretNameDecision>? SecretNames { get; init; }
    internal IReadOnlyList<JsonObject?>? Asking { get; init; }

    // The operation that decided a deny because it could not be resolved, if any.
    internal OperationDecision? Unresolved =>
        Effect == ToolAuthorizationEffect.Deny
        && Operations?.FirstOrDefault(item => item.Effect == ToolAuthorizationEffect.Deny) is
            { Unresolved: true } unresolved
        && (Secrets is null || Call?.Effect == ToolAuthorizationEffect.Deny)
            ? unresolved
            : null;

    // The rules whose ask this decision carries; null stands for an asking default.
    internal IEnumerable<JsonObject?> AskingRules =>
        Asking ?? (Secrets is null
            ? (Effect == ToolAuthorizationEffect.Ask ? [Rule] : [])
            : (Call?.Effect == ToolAuthorizationEffect.Ask ? new[] { Call.Rule } : []).Concat(
                Secrets.Effect == ToolAuthorizationEffect.Ask
                    ? [Secrets.Rule ?? Secrets.Fallback?.Rule]
                    : []
            ));

    internal static ToolAuthorizationEffect Parse(string? action) =>
        action switch
        {
            "allow" => ToolAuthorizationEffect.Allow,
            "ask" => ToolAuthorizationEffect.Ask,
            _ => ToolAuthorizationEffect.Deny,
        };

    internal static string Name(ToolAuthorizationEffect effect) =>
        effect switch
        {
            ToolAuthorizationEffect.Allow => "allow",
            ToolAuthorizationEffect.Ask => "ask",
            _ => "deny",
        };
}

// Layer is null for the global policy, otherwise the Agent that owns the local rules.
internal sealed record AuthorizationLayerDecision(
    string? Layer,
    ToolAuthorizationPolicy Policy,
    AuthorizationDecision Decision
);

internal sealed record AuthorizationAssessment(
    ToolAuthorizationRequest Request,
    IReadOnlyList<AuthorizationLayerDecision> Layers
)
{
    // The call can have secret facts, but they could not be established (an unreadable
    // configuration candidate, rejected MCP arguments). Diagnostic only; never a decision input.
    internal bool SecretsUnknown { get; init; }

    // Set for a Self call (its branch acts only on the caller's own turn, context, runs,
    // transfers or history images): it is not authorizable, so every valid layer passes it.
    internal string? Self { get; init; }

    internal AuthorizationLayerDecision? Denied =>
        Layers.FirstOrDefault(layer => layer.Decision.Effect == ToolAuthorizationEffect.Deny);

    internal IReadOnlyList<AuthorizationLayerDecision> Asking =>
        Layers.Where(layer => layer.Decision.Effect == ToolAuthorizationEffect.Ask).ToArray();

    // Deny in any layer wins; otherwise any asking layer requires approval.
    internal ToolAuthorizationEffect Effect =>
        Denied is not null ? ToolAuthorizationEffect.Deny
        : Asking.Count > 0 ? ToolAuthorizationEffect.Ask
        : ToolAuthorizationEffect.Allow;

    internal ToolApprovalOptions Approval => ToolApprovalOptions.Combine(Asking);
}

// Combined options of every asking layer: the shortest deadline, and only identities that every
// asking layer admits. The administrator may always decide.
internal sealed record ToolApprovalOptions(long? TimeoutSeconds, IReadOnlyList<string> Approvers)
{
    internal static ToolApprovalOptions Combine(IEnumerable<AuthorizationLayerDecision> asking)
    {
        long? timeout = null;
        HashSet<string>? approvers = null;
        foreach (var rule in asking.SelectMany(layer => layer.Decision.AskingRules))
        {
            var approval = rule?["approval"] as JsonObject;
            if (SessionWait.Number(approval?["timeoutSeconds"]) is double seconds)
                timeout = timeout is long current
                    ? Math.Min(current, (long)seconds)
                    : (long)seconds;
            var admitted = SessionWait
                .Strings(approval?["approvers"])
                .ToHashSet(StringComparer.Ordinal);
            if (approvers is null)
                approvers = admitted;
            else
                approvers.IntersectWith(admitted);
        }
        return new(timeout, (approvers ?? []).Order(StringComparer.Ordinal).ToArray());
    }

    internal JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["approvers"] = new JsonArray(
                Approvers.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
        };
        if (TimeoutSeconds is long seconds)
            result["timeoutSeconds"] = seconds;
        return result;
    }
}

internal enum CreationTargetDecision
{
    Allow,
    Ask,
    Deny,
    Indeterminate,
}

// One effect a creation-target evaluation took into account: a matching rule (null for the
// default action) and whether it depends on arguments known only when the Session is created.
internal sealed record CreationContribution(
    JsonObject? Rule,
    ToolAuthorizationEffect Effect,
    bool Conditional
);

// The creation-target decision, the rule traversal stopped at (null for the default action) and
// every effect that made up the decision, in policy order; the last is never conditional.
internal sealed record CreationTargetOutcome(
    CreationTargetDecision Decision,
    JsonObject? Rule,
    IReadOnlyList<CreationContribution> Contributions
);

// How a layer decided the secret facts of a call: by the first matching rule with a `secrets`
// selector; otherwise allowed when the caller's Agent owns every one of them; otherwise by the
// caller's authorization for an unrestricted `exec` on master, since such a caller can already
// read the store and its key.
internal sealed record SecretsDecision(
    ToolAuthorizationEffect Effect,
    JsonObject? Rule,
    UnrestrictedExecDecision? Fallback,
    bool Owned = false
);

// The caller's authorization for `exec` on master with any command and cwd. Rule is the rule
// that decided it; null stands for the default.
internal sealed record UnrestrictedExecDecision(ToolAuthorizationEffect Effect, JsonObject? Rule);

internal static class ToolAuthorizationEvaluation
{
    private static bool Equal(JsonNode? expected, AuthorizationFact actual)
    {
        if (!actual.Present)
            return false;
        if (expected is null || actual.Value is null)
            return expected is null && actual.Value is null;
        if (expected.GetValueKind() != actual.Value.GetValueKind())
            return false;
        if (ToolAuthorizationPolicy.Number(expected) is double number)
            return number == ToolAuthorizationPolicy.Number(actual.Value);
        return JsonNode.DeepEquals(expected, actual.Value);
    }

    internal static bool Scalar(JsonNode? matcher, AuthorizationFact actual)
    {
        if (matcher is JsonArray list)
            return list.Any(item => Equal(item, actual));
        if (matcher is JsonObject map)
        {
            if (map.ContainsKey("exists") && map["exists"]!.GetValue<bool>() != actual.Present)
                return false;
            if (map.ContainsKey("equals") && !Equal(map["equals"], actual))
                return false;
            if (map["oneOf"] is JsonArray values && !values.Any(item => Equal(item, actual)))
                return false;
            return true;
        }
        return Equal(matcher, actual);
    }

    private static bool Optional(JsonObject match, string key, AuthorizationFact actual) =>
        !match.ContainsKey(key) || Scalar(match[key], actual);

    internal static bool ToolMatches(
        JsonNode? matcher,
        string source,
        string name,
        string? server,
        bool unknownName = false
    )
    {
        // Read old persisted selectors as the renamed builtin only. This is not a
        // dispatch alias, and MCP/Node tools with the same name retain their identities.
        bool Name(JsonNode? selector) =>
            Scalar(selector, AuthorizationFact.Of(name))
            || source == "builtin"
                && name == "view_session"
                && Scalar(selector, AuthorizationFact.Of("get_session_messages"));
        if (matcher is JsonObject map)
            return Optional(map, "source", AuthorizationFact.Of(source))
                && Optional(map, "server", AuthorizationFact.Of(server))
                && (unknownName || !map.ContainsKey("name") || Name(map["name"]));
        return unknownName || Name(matcher);
    }

    // Whether a rule's tool selector depends on the tool name, which server-level
    // discovery does not know yet.
    private static bool NameConstrained(JsonNode? matcher) =>
        matcher is not null && (matcher is not JsonObject map || map.ContainsKey("name"));

    internal static bool Identity(
        JsonObject match,
        ToolAuthorizationRequest request,
        bool unknownNode = false,
        bool unknownNodeTargets = false,
        bool deny = false,
        bool unknownName = false
    ) =>
        (
            !match.ContainsKey("agent")
            || request.Principal == "internal"
                && Scalar(match["agent"], AuthorizationFact.Of(request.Agent))
        )
        && Optional(match, "session", AuthorizationFact.Of(request.Session))
        && (
            !match.ContainsKey("sessionPattern")
            || Pattern(match["sessionPattern"]!, request.Session)
        )
        && (
            !match.ContainsKey("externalId")
            || request.Principal == "external"
                && Scalar(match["externalId"], AuthorizationFact.Of(request.ExternalId))
        )
        && (
            !match.ContainsKey("tool")
            || ToolMatches(match["tool"], request.Source, request.Name, request.Server, unknownName)
        )
        && (unknownNode || Optional(match, "targetNode", AuthorizationFact.Of(request.TargetNode)))
        && (
            unknownNodeTargets
            || !match.ContainsKey("node")
            || NodeTargets(match["node"]!, request, deny)
        );

    internal static bool Pattern(JsonNode pattern, string? actual)
    {
        if (actual is null)
            return false;
        var patterns = pattern is JsonArray list
            ? list.Select(SessionWait.Text)
            : new[] { SessionWait.Text(pattern) };
        return patterns.Any(item =>
        {
            var parts = item!.Split('*');
            if (parts.Length == 1)
                return actual == item;
            if (
                !actual.StartsWith(parts[0], StringComparison.Ordinal)
                || !actual.EndsWith(parts[^1], StringComparison.Ordinal)
            )
                return false;
            var offset = parts[0].Length;
            var end = actual.Length - parts[^1].Length;
            foreach (var part in parts[1..^1])
            {
                var index = actual.IndexOf(part, offset, StringComparison.Ordinal);
                if (index < 0 || index + part.Length > end)
                    return false;
                offset = index + part.Length;
            }
            return offset <= end;
        });
    }

    private static bool NodeTargets(JsonNode matcher, ToolAuthorizationRequest request, bool deny)
    {
        if (request.NodeTargets is not { Count: > 0 } targets)
            return false;
        return deny
            ? targets.Any(node => NodeMatches(matcher, node, request))
            : targets.All(node => NodeMatches(matcher, node, request));
    }

    // Whether a Node selector covers one Node: bare IDs and patterns cover the Node's
    // ancestors, `exact` the Node itself, `current` the caller's current Node, `provider` the
    // Node's Provider.
    internal static bool NodeMatches(JsonNode matcher, string node, ToolAuthorizationRequest request)
    {
        {
            if (matcher is not JsonObject map)
                return request.NodeForest is { } forest && forest.Contains(node)
                    ? forest.Chain(node).Any(ancestor => Pattern(matcher, ancestor))
                    : Pattern(matcher, node);
            if (map.ContainsKey("exact"))
                return Scalar(map["exact"], AuthorizationFact.Of(node));
            if (map.ContainsKey("current"))
                return request.Principal == "internal"
                    && request.CurrentNode is not null
                    && request.CurrentNode == node;
            var slash = node.IndexOf('/');
            // The Agent store's endpoint is its own provider, never a remote Node's.
            var provider =
                slash > 0 ? node[..slash]
                : node is "master" or AgentStorePaths.Endpoint ? node
                : "authenticated-remote";
            return Pattern(map["provider"]!, provider);
        }
    }

    internal static AuthorizationFact Argument(JsonObject args, string path)
    {
        JsonNode? current = args;
        foreach (var part in path.Split('.'))
        {
            if (current is JsonObject map && map.TryGetPropertyValue(part, out var value))
                current = value;
            else if (current is JsonArray array && part == "length")
                current = JsonValue.Create(array.Count);
            else if (
                current is JsonArray sequence
                && int.TryParse(part, out var index)
                && index >= 0
                && index < sequence.Count
                && index.ToString(System.Globalization.CultureInfo.InvariantCulture) == part
            )
                current = sequence[index];
            else
                return new(false, null);
        }
        return new(true, current);
    }

    private static bool SessionMatch(JsonObject match, ToolAuthorizationRequest request) =>
        request.SessionTarget is { } target && SessionCondition(match, target, request);

    // A `{self, sameAgent, relation}` Session condition over one resolved target Session.
    // External principals never match it.
    internal static bool SessionCondition(
        JsonObject match,
        AuthorizationTarget target,
        ToolAuthorizationRequest request
    )
    {
        if (request.Principal != "internal")
            return false;
        if (
            match.ContainsKey("self") && target.Id != request.Session
            || match.ContainsKey("sameAgent") && target.Agent != request.Agent
        )
            return false;
        if (match.ContainsKey("relation"))
        {
            var relations = match["relation"] is JsonArray list
                ? list.Select(SessionWait.Text)
                : new[] { SessionWait.Text(match["relation"]) };
            if (
                !relations.Any(relation =>
                    relation == "parent"
                        ? target.Id == request.SourceParent
                        : target.Parent == request.Session
                )
            )
                return false;
        }
        return true;
    }

    private static bool ArgumentMatches(
        string key,
        JsonNode? matcher,
        ToolAuthorizationRequest request
    ) =>
        matcher is JsonObject wrapper && wrapper["session"] is JsonObject session
            ? SessionMatch(session, request)
        : matcher is JsonObject task && task.ContainsKey("task")
            ? request.Principal == "internal"
                && request.TaskOwnerSession is not null
                && request.TaskOwnerSession == request.Session
        : matcher is JsonObject agent && agent["agent"] is JsonObject comparison
            ? request.Principal == "internal"
                && request.Agent is not null
                && SessionWait.Text(Argument(request.Args, key).Value) is { Length: > 0 } target
                && (target == request.Agent) == comparison["sameAgent"]!.GetValue<bool>()
        : Scalar(matcher, Argument(request.Args, key));

    private static bool Arguments(JsonObject? match, ToolAuthorizationRequest request) =>
        match is null || match.All(pair => ArgumentMatches(pair.Key, pair.Value, request));

    // Timer registration knows the creation Agent, not future names or settings. Preserve
    // every possible first-match outcome; a mixed result is not an authorization grant.
    internal static CreationTargetDecision EvaluateCreationTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) => EvaluateCreationTargetOutcome(policy, request).Decision;

    // The operation a new-Session timer's future creation performs: its Agent is known (the
    // stored timer's agentName, which the fire uses) and it is an ordinary unforked Session
    // without a parent; its Node is decided when it fires.
    internal static AuthorizationOperation CreationTargetOperation(string agent) =>
        new(
            "session.create",
            new JsonObject
            {
                ["targetAgent"] = agent,
                ["node"] = null,
                ["parent"] = null,
                ["targetSession"] = new JsonObject { ["prospective"] = true, ["agent"] = agent },
            },
            new JsonObject
            {
                ["kind"] = "timer",
                ["placement"] = null,
                ["runtime"] = "foxwarm",
                ["fork"] = false,
            }
        );

    // The creation-target decision with the rule traversal stopped at (the first matching rule
    // whose conditions are all known, or null for the default action) and every contribution.
    internal static CreationTargetOutcome EvaluateCreationTargetOutcome(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        if (
            request.Source != "builtin"
            || request.Name != "create_session"
            || SessionWait.Text(request.Args["agentName"]) is not { Length: > 0 }
        )
            throw new InvalidDataException("Creation target authorization requires an Agent.");
        var allow = false;
        var ask = false;
        var deny = false;
        var contributions = new List<CreationContribution>();
        CreationTargetDecision Outcome() =>
            allow && (ask || deny) ? CreationTargetDecision.Indeterminate
            : allow ? CreationTargetDecision.Allow
            : deny ? CreationTargetDecision.Deny
            : CreationTargetDecision.Ask;
        var creation = CreationTargetOperation(SessionWait.Text(request.Args["agentName"])!);
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (rule["enabled"]!.GetValue<bool>() && OperationRules.IsOperationRule(rule))
            {
                var result = OperationRules.Match(rule, creation, request, Restrictive(rule));
                if (result == OperationMatch.No)
                    continue;
                var opEffect = RuleEffect(rule, request);
                allow |= opEffect == ToolAuthorizationEffect.Allow;
                ask |= opEffect == ToolAuthorizationEffect.Ask;
                deny |= opEffect == ToolAuthorizationEffect.Deny;
                var conditional = result == OperationMatch.Unknown;
                contributions.Add(new(rule, opEffect, conditional));
                if (!conditional)
                    return new(Outcome(), rule, contributions);
                continue;
            }
            if (
                !rule["enabled"]!.GetValue<bool>()
                || !Ordinary(match)
                || !Identity(match, request, deny: Restrictive(rule))
                || !Paths(match["path"] as JsonObject, request, Restrictive(rule))
            )
                continue;
            var unknown = false;
            var matches = true;
            foreach (var pair in match["args"] as JsonObject ?? new())
            {
                if (
                    pair.Key == "agentName"
                    || pair.Key.StartsWith("agentName.", StringComparison.Ordinal)
                )
                    matches &= ArgumentMatches(pair.Key, pair.Value, request);
                else
                    unknown = true;
            }
            if (!matches)
                continue;
            var effect = AuthorizationDecision.Parse(SessionWait.Text(rule["action"]));
            if (effect == ToolAuthorizationEffect.Ask && UndecidableStoreRoot(rule, request))
                effect = ToolAuthorizationEffect.Deny;
            allow |= effect == ToolAuthorizationEffect.Allow;
            ask |= effect == ToolAuthorizationEffect.Ask;
            deny |= effect == ToolAuthorizationEffect.Deny;
            contributions.Add(new(rule, effect, unknown));
            if (!unknown)
                return new(Outcome(), rule, contributions);
        }
        var fallback = Default(policy, request);
        allow |= fallback == ToolAuthorizationEffect.Allow;
        ask |= fallback == ToolAuthorizationEffect.Ask;
        deny |= fallback == ToolAuthorizationEffect.Deny;
        contributions.Add(new(null, fallback, false));
        return new(Outcome(), null, contributions);
    }

    // Whether the caller may run any command in any directory on master. Rules that depend on
    // the command arguments or cwd neither grant nor remove that: a command or cwd restriction
    // leaves other commands available, and an argument-scoped allow is not unrestricted. The
    // first rule that matches whatever the arguments are decides, else the default. The request
    // keeps the caller's identity facts, including its current Node.
    internal static UnrestrictedExecDecision EvaluateUnrestrictedMasterExec(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        var exec = UnrestrictedExecRequest(request);
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            if (
                rule["enabled"]!.GetValue<bool>()
                && Version1(rule)
                && EstablishesUnrestrictedExec(rule, exec)
            )
                return new(RuleEffect(rule, exec), rule);
        }
        return new(Default(policy, exec), null);
    }

    // Rules with a `secrets` selector decide only the secret facts of a call; every other rule
    // decides the call itself.
    private static bool Ordinary(JsonObject match) => !match.ContainsKey("secrets");

    // Version-1 rules; operation rules are decided by OperationEvaluation.
    private static bool Version1(JsonObject rule) => !OperationRules.IsOperationRule(rule);

    // Whether a version-1 rule without `secrets` matches the whole call.
    internal static bool MatchesCall(JsonObject rule, ToolAuthorizationRequest request)
    {
        var match = rule["match"]!.AsObject();
        return Ordinary(match)
            && Identity(match, request, deny: Restrictive(rule))
            && Arguments(match["args"] as JsonObject, request)
            && Paths(match["path"] as JsonObject, request, Restrictive(rule));
    }

    // Whether a version-1 `secrets` rule matches the call and its complete secret set.
    internal static bool MatchesSecrets(JsonObject rule, ToolAuthorizationRequest request)
    {
        var match = rule["match"]!.AsObject();
        return !Ordinary(match)
            && Identity(match, request, deny: Restrictive(rule))
            && SecretNames(match["secrets"]!, request, Restrictive(rule))
            && Arguments(match["args"] as JsonObject, request)
            && Paths(match["path"] as JsonObject, request, Restrictive(rule));
    }

    // The request of an unrestricted exec on master with the caller's identity facts.
    internal static ToolAuthorizationRequest UnrestrictedExecRequest(ToolAuthorizationRequest request) =>
        request with
        {
            Source = "node",
            Name = "exec",
            Server = null,
            Args = new JsonObject(),
            Paths = [],
            TargetNode = "master",
            NodeTargets = ["master"],
            NodeForest = null,
            SourceParent = null,
            SessionTarget = null,
            TaskOwnerSession = null,
            Secrets = null,
            OwnedSecrets = null,
            Operations = null,
        };

    // Whether a version-1 rule decides unrestricted exec: it has no argument or path condition
    // and matches exec on master.
    internal static bool EstablishesUnrestrictedExec(JsonObject rule, ToolAuthorizationRequest exec)
    {
        var match = rule["match"]!.AsObject();
        return Ordinary(match)
            && match["args"] is not JsonObject { Count: > 0 }
            && match["path"] is not JsonObject { Count: > 0 }
            && Identity(match, exec, deny: Restrictive(rule));
    }

    internal static ToolAuthorizationEffect DefaultEffect(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) => Default(policy, request);

    internal static string? PolicyRoot(string text, ToolAuthorizationRequest request) =>
        Base(text, request);

    /// <summary>The Agent store root a policy root names, if any (see <see cref="StoreBase"/>).</summary>
    internal static string? PolicyStoreRoot(string text, ToolAuthorizationRequest request) =>
        StoreBase(text, request);

    private static HashSet<string> OwnedSecrets(ToolAuthorizationRequest request) =>
        new(
            (request.OwnedSecrets ?? []).Where(name => request.Secrets?.Contains(name) == true),
            StringComparer.Ordinal
        );

    // Deny and ask match any named secret. An allow must cover every secret the caller's Agent
    // does not own, and at least one secret, so an unrelated allow never matches a call whose
    // secrets are all owned. External principals never send stored secrets.
    private static bool SecretNames(
        JsonNode matcher,
        ToolAuthorizationRequest request,
        bool restrictive
    )
    {
        if (request.Principal != "internal" || request.Secrets is not { Count: > 0 } names)
            return false;
        var owned = OwnedSecrets(request);
        bool Covers(string name) =>
            (matcher["anyOf"] is not { } patterns || Pattern(patterns, name))
            && (matcher["owned"]?.GetValue<bool>() != true || owned.Contains(name));
        return restrictive
            ? names.Any(Covers)
            : names.Any(Covers) && names.All(name => owned.Contains(name) || Covers(name));
    }

    private static SecretsDecision EvaluateSecrets(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (
                rule["enabled"]!.GetValue<bool>()
                && Version1(rule)
                && !Ordinary(match)
                && Identity(match, request, deny: Restrictive(rule))
                && SecretNames(match["secrets"]!, request, Restrictive(rule))
                && Arguments(match["args"] as JsonObject, request)
                && Paths(match["path"] as JsonObject, request, Restrictive(rule))
            )
                return new(RuleEffect(rule, request), rule, null);
        }
        // A secret the caller's Agent owns needs no allow rule.
        if (request.Secrets!.All(OwnedSecrets(request).Contains))
            return new(ToolAuthorizationEffect.Allow, null, null, Owned: true);
        var fallback = EvaluateUnrestrictedMasterExec(policy, request);
        return new(fallback.Effect, null, fallback);
    }

    // Deny and ask rules restrict; unresolved multi-target facts match them conservatively.
    private static bool Restrictive(JsonObject rule) =>
        SessionWait.Text(rule["action"]) is "deny" or "ask";

    // External principals never fall through to a grant and cannot be asked.
    private static ToolAuthorizationEffect Default(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        policy.PassesByDefault ? ToolAuthorizationEffect.Allow
        : request.Principal == "internal"
            ? AuthorizationDecision.Parse(SessionWait.Text(policy.Value["defaultAction"]))
            : ToolAuthorizationEffect.Deny;

    internal static ToolAuthorizationEffect RuleEffect(
        JsonObject rule,
        ToolAuthorizationRequest request
    ) =>
        AuthorizationDecision.Parse(SessionWait.Text(rule["action"])) is var effect
        && (effect != ToolAuthorizationEffect.Ask || request.Principal == "internal" && !UndecidableStoreRoot(rule, request))
            ? effect
            : ToolAuthorizationEffect.Deny;

    // A legacy rule whose path root the Agent store can't decide: when it applies (it denies or
    // asks), it denies, as an unknown operation-rule path does.
    private static bool UndecidableStoreRoot(JsonObject rule, ToolAuthorizationRequest request) =>
        !OperationRules.IsOperationRule(rule)
        && rule["match"]?["path"] is JsonObject path
        && new[] { path["allWithin"], path["anyNotWithin"] }.Any(value =>
            SessionWait.Text(value) is string text && StoreRootRefused(text, request)
        );

    internal static bool Within(string? path, string root)
    {
        if (path is null)
            return false;
        var normalized = Path.GetFullPath(path);
        return normalized == root
            || normalized.StartsWith(
                Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            );
    }

    // A path fact inside a rule root: a master path inside the physical root, or an Agent store
    // path inside the store root. A root has at most one kind; no path of the other kind is
    // inside it.
    private static bool Inside(AuthorizationPath path, string? root, string? store) =>
        path.Node == AgentStorePaths.Endpoint
            ? store is not null && path.Resolved is { } resolved && AgentStorePaths.Within(resolved, store)
            : path.Node == "master" && root is not null && Within(path.Resolved, root);

    // The Agent store root a rule root names: over an Agent store (store paths as the request's
    // Agent roots), `${agent.dir}` or `${agent.memoryDir}`, optionally followed by a relative
    // store path. Any other root names no store path, and neither does a malformed suffix.
    private static string? StoreBase(string text, ToolAuthorizationRequest request) =>
        request.Principal == "internal" && StoreRoots(request)
            ? AgentStorePaths.PolicyRoot(text, request.AgentDirectory!, out _)
            : null;

    /// <summary>
    /// Whether a policy root names the Agent's files in a way the Agent store can't decide: a
    /// suffix that leaves the Agent's namespace or isn't a store path. Such a root is refused
    /// where rules are set and fails closed where an existing rule has one.
    /// </summary>
    internal static bool StoreRootRefused(string text, ToolAuthorizationRequest request)
    {
        if (request.Principal != "internal" || !StoreRoots(request))
            return false;
        _ = AgentStorePaths.PolicyRoot(text, request.AgentDirectory!, out var refused);
        return refused;
    }

    // Whether the request's Agent roots are Agent store paths: a physical root is absolute.
    private static bool StoreRoots(ToolAuthorizationRequest request) =>
        request.AgentDirectory is { } directory && !Path.IsPathFullyQualified(directory);

    private static string? Base(string text, ToolAuthorizationRequest request)
    {
        // Over an Agent store the Agent roots are store paths: no master path is inside them.
        if (
            StoreRoots(request)
            && (
                text.Contains("${agent.dir}", StringComparison.Ordinal)
                || text.Contains("${agent.memoryDir}", StringComparison.Ordinal)
            )
        )
            return null;
        if (
            request.Principal == "external"
            && (
                text.Contains("${agent.dir}", StringComparison.Ordinal)
                || text.Contains("${agent.memoryDir}", StringComparison.Ordinal)
            )
        )
            return null;
        if (request.Principal == "internal")
            text = text.Replace("${agent.dir}", request.AgentDirectory!, StringComparison.Ordinal)
                .Replace("${agent.memoryDir}", request.MemoryDirectory!, StringComparison.Ordinal);
        return AuthorizationPaths.CanonicalPotential(
            text.Replace("${workspace}", request.Workspace, StringComparison.Ordinal)
        );
    }

    // restrictive: the rule denies or asks, so a root the Agent store can't interpret makes
    // it apply rather than vanish.
    private static bool Paths(JsonObject? match, ToolAuthorizationRequest request, bool restrictive = false)
    {
        if (match is null)
            return true;
        var names =
            match["arg"] is JsonArray list ? list.Select(SessionWait.Text).ToArray()
            : SessionWait.Text(match["arg"]) is string name ? [name]
            : null;
        var paths = names is null
            ? request.Paths
            : request
                .Paths.Where(path => names.Contains(path.Arg, StringComparer.Ordinal))
                .ToArray();
        if (paths.Count == 0)
            return false;
        if (
            new[] { match["allWithin"], match["anyNotWithin"] }.Any(value =>
                SessionWait.Text(value) is string text && StoreRootRefused(text, request)
            )
        )
            return restrictive;
        if (SessionWait.Text(match["allWithin"]) is string all)
        {
            var root = Base(all, request);
            var store = StoreBase(all, request);
            if (
                root is null && store is null
                || !paths.All(path => Inside(path, root, store))
            )
                return false;
        }
        if (SessionWait.Text(match["anyNotWithin"]) is string any)
        {
            var root = Base(any, request);
            var store = StoreBase(any, request);
            if (
                root is null && store is null
                || !paths.Any(path => !Inside(path, root, store))
            )
                return false;
        }
        return true;
    }

    private static void ValidateNodeAncestry(ToolAuthorizationRequest request)
    {
        if (request.NodeForest is not { } forest || request.NodeTargets is not { } targets)
            return;
        foreach (var node in targets)
            if (forest.Contains(node))
                _ = forest.Chain(node);
    }

    internal static AuthorizationDecision Evaluate(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        ValidateNodeAncestry(request);
        if (policy.HasOperationRules)
            return OperationEvaluation.Evaluate(policy, request);
        var call = EvaluateCall(policy, request);
        if (request.Secrets is not { Count: > 0 })
            return call;
        var secrets = EvaluateSecrets(policy, request);
        return secrets.Effect > call.Effect
            ? new(secrets.Effect, secrets.Rule ?? secrets.Fallback?.Rule)
            {
                Call = call,
                Secrets = secrets,
            }
            : call with
            {
                Call = call,
                Secrets = secrets,
            };
    }

    private static AuthorizationDecision EvaluateCall(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (
                rule["enabled"]!.GetValue<bool>()
                && Version1(rule)
                && Ordinary(match)
                && Identity(match, request, deny: Restrictive(rule))
                && Arguments(match["args"] as JsonObject, request)
                && Paths(match["path"] as JsonObject, request, Restrictive(rule))
            )
                return new(RuleEffect(rule, request), rule);
        }
        return new(Default(policy, request), null);
    }

    internal static bool Visible(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request,
        bool unknownNode = false,
        bool unknownNodeTargets = false,
        IReadOnlySet<string>? knownArgs = null,
        bool unknownName = false
    )
    {
        if (!unknownNodeTargets)
            ValidateNodeAncestry(request);
        // Raw arguments the caller states as known decide version-1 rules; the rest stay
        // unresolved, whatever branch an operation template assumes.
        (bool Skip, bool Conditional) WholeCall(JsonObject rule)
        {
            var match = rule["match"]!.AsObject();
            if (
                !Ordinary(match)
                || !Identity(
                    match,
                    request,
                    unknownNode,
                    unknownNodeTargets,
                    Restrictive(rule),
                    unknownName
                )
            )
                return (true, false);
            // Arguments the caller states as known are matched exactly; the rest stay unresolved.
            var unknownArgs = false;
            foreach (var pair in match["args"] as JsonObject ?? new())
            {
                if (knownArgs?.Contains(pair.Key.Split('.')[0]) != true)
                    unknownArgs = true;
                else if (!ArgumentMatches(pair.Key, pair.Value, request))
                    return (true, false);
            }
            return (
                false,
                unknownName && NameConstrained(match["tool"])
                    || match.ContainsKey("path")
                    || unknownArgs
                    || unknownNode && match.ContainsKey("targetNode")
                    || unknownNodeTargets && match.ContainsKey("node")
            );
        }
        if (policy.HasOperationRules)
            return OperationEvaluation.Visible(
                policy,
                request,
                WholeCall,
                unknownNode || unknownNodeTargets,
                knownArgs,
                unknownName
            );
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            if (!rule["enabled"]!.GetValue<bool>())
                continue;
            var (skip, conditional) = WholeCall(rule);
            if (skip)
                continue;
            // A call that can proceed after approval remains discoverable.
            var possible = RuleEffect(rule, request) != ToolAuthorizationEffect.Deny;
            if (!conditional)
                return possible;
            if (possible)
                return true;
        }
        return Default(policy, request) != ToolAuthorizationEffect.Deny;
    }

    internal static bool NeedsTaskTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        request.Source == "builtin"
        && request.Name == "task"
        && policy.Value["rules"]!
            .AsArray()
            .OfType<JsonObject>()
            .Any(rule =>
                rule["enabled"]!.GetValue<bool>()
                && Identity(rule["match"]!.AsObject(), request, deny: Restrictive(rule))
                && (
                    rule["resources"]?["task"] is not null
                    || (rule["match"]?["args"] as JsonObject ?? new()).Any(pair =>
                        pair.Value is JsonObject map && map.ContainsKey("task")
                    )
                )
            );

    internal static bool NeedsTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        policy.Value["rules"]!
            .AsArray()
            .OfType<JsonObject>()
            .Any(rule =>
                rule["enabled"]!.GetValue<bool>()
                && Identity(rule["match"]!.AsObject(), request, deny: Restrictive(rule))
                && (
                    OperationRules.IsOperationRule(rule)
                    || (rule["match"]?["args"] as JsonObject ?? new()).Any(pair =>
                        pair.Value is JsonObject map && map.ContainsKey("session")
                    )
                )
            );
}

// A path explain would have to inspect on master that this explanation has not inspected yet.
internal sealed class PathNotEstablishedException(string path)
    : Exception($"its path facts are not established by the probe (`{path}`)");

// Explain's record of master path inspection. While recording, each canonical result is kept;
// while replaying, a recorded path returns its recorded result and any other path raises
// PathNotEstablishedException without being inspected. Outside explain there is no record.
internal sealed class PathInspectionRecord
{
    internal readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> Inspected =
        new(StringComparer.Ordinal);
}

internal static class AuthorizationPaths
{
    private static readonly AsyncLocal<(PathInspectionRecord Record, bool Replay)?> inspection =
        new();

    // Records (or replays) inspection in the current flow until disposed.
    internal static IDisposable Inspecting(PathInspectionRecord record, bool replay)
    {
        var previous = inspection.Value;
        inspection.Value = (record, replay);
        return new Restore(() => inspection.Value = previous);
    }

    private sealed class Restore(Action restore) : IDisposable
    {
        public void Dispose() => restore();
    }

    internal static string CanonicalPotential(string path)
    {
        if (inspection.Value is not { } current)
            return Inspect(path);
        if (current.Replay)
            return current.Record.Inspected.TryGetValue(path, out var known)
                ? known
                : throw new PathNotEstablishedException(path);
        var result = Inspect(path);
        current.Record.Inspected[path] = result;
        return result;
    }

    private static string Inspect(string path)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string Resolve(string candidate)
        {
            var full = Path.GetFullPath(candidate);
            var current = Path.GetPathRoot(full)!;
            var segments = full[current.Length..]
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            for (var index = 0; index < segments.Length; index++)
            {
                current = Path.Combine(current, segments[index]);
                var info = new FileInfo(current);
                var link = info.LinkTarget;
                if (link is not null)
                {
                    if (!seen.Add(current))
                        throw new IOException("Symlink cycle in authorization path.");
                    var target = Path.IsPathRooted(link)
                        ? link
                        : Path.Combine(Path.GetDirectoryName(current)!, link);
                    try
                    {
                        current = Resolve(target);
                    }
                    finally
                    {
                        seen.Remove(info.FullName);
                    }
                }
                else
                {
                    try
                    {
                        _ = File.GetAttributes(current);
                    }
                    catch (Exception error)
                        when (error is FileNotFoundException or DirectoryNotFoundException)
                    {
                        return Path.Combine(
                            new[] { current }.Concat(segments[(index + 1)..]).ToArray()
                        );
                    }
                }
            }
            return Path.TrimEndingDirectorySeparator(current);
        }
        return Resolve(path);
    }
}

internal static class ToolAuthorizationNodeEffects
{
    private static bool Valid(string? id) =>
        id is not null
        && System.Text.RegularExpressions.Regex.IsMatch(
            id,
            @"^(?:[A-Za-z0-9._:-]{1,128}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$",
            System.Text.RegularExpressions.RegexOptions.CultureInvariant
        );

    internal static IReadOnlyList<string>? Resolve(
        string source,
        string name,
        string? targetNode,
        JsonObject args
    )
    {
        if (source == "node" || source == "builtin" && name is "send_file" or "image_write_to_file")
            return Valid(targetNode) ? [targetNode!] : null;
        if (source != "builtin")
            return null;
        if (name == "artifact" && ToolRegistry.ArtifactFileSource(args))
            return Valid(targetNode) ? [targetNode!] : null;
        if (name == "copy_between_nodes")
        {
            var endpoints = new[]
            {
                SessionWait.Text(args["sourceNode"])?.Trim(),
                SessionWait.Text(args["targetNode"])?.Trim(),
            };
            return endpoints.All(Valid) ? endpoints.Select(value => value!).ToArray() : null;
        }
        if (
            name == "node_create_auth_token"
            && SessionWait.Text(args["parentNode"]) is string parent
            && Valid(parent)
        )
            return [parent];
        if (
            name == "node_remove"
            && SessionWait.Text(args["nodeId"])?.Trim() is string removed
            && Valid(removed)
        )
            return [removed];
        if (
            name == "node"
            && SessionWait.Text(args["action"])?.Trim().ToLowerInvariant()
                is "select"
                    or "inspect"
                    or "destroy"
            && !args.ContainsKey("providerId")
            && SessionWait.Text(args["nodeId"])?.Trim() is string node
            && Valid(node)
        )
            return [node];
        return null;
    }
}
