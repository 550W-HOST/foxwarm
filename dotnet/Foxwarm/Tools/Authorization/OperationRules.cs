using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// One operation of a request as operation rules see it: the op, its resources and attributes
// (keys with a null value could not be established), and the facts the operation-rule selectors
// read beyond the values themselves. Built from the operation plan of the request.
internal sealed record AuthorizationOperation(string Op, JsonObject Resources, JsonObject With)
{
    // The path fact of the `path` resource, when the op has one.
    internal AuthorizationPath? Path { get; init; }

    // The resolved Session of `targetSession` and of `parent`, when it exists.
    internal AuthorizationTarget? Target { get; init; }
    internal AuthorizationTarget? ParentTarget { get; init; }

    // Whether `targetAgent` is a creator descendant of the caller's Agent.
    internal bool? AgentDescendant { get; init; }

    // Whether the caller owns or created the `task` resource.
    internal bool? TaskOwned { get; init; }
    internal bool? TaskCreated { get; init; }

    // Whether the caller's Agent owns the `secret` resource.
    internal bool? SecretOwned { get; init; }

    // Set on the stand-in operation of a call whose operations could not be derived; every
    // operation rule is undecidable for it.
    internal string? Underivable { get; init; }

    internal bool Unresolved(string resource) =>
        Underivable is not null
        || Resources.TryGetPropertyValue(resource, out var value) && value is null;

    internal bool HasUnresolved =>
        Underivable is not null || Resources.Any(pair => pair.Value is null);

    internal JsonObject ToJson()
    {
        var result = new JsonObject { ["op"] = Op };
        if (Resources.Count > 0)
            result["resources"] = Resources.DeepClone();
        if (With.Count > 0)
            result["with"] = With.DeepClone();
        if (Underivable is not null)
            result["underivable"] = Underivable;
        return result;
    }
}

// Whether a rule matches an operation: yes, no, or undecidable because a resource or fact the
// rule tests could not be established.
internal enum OperationMatch
{
    No,
    Yes,
    Unknown,
}

// Operation rules: rules with `op`, in the same ordered lists as version-1 rules. Grammar,
// load-time validation and matching. Contract: docs/code-index/units/tool-operation-authorization.md.
internal static class OperationRules
{
    // Rule fields of an operation rule besides id, enabled, action, reason and approval.
    internal static readonly string[] Selectors =
    [
        "op",
        "agent",
        "session",
        "externalId",
        "node",
        "path",
        "targetSession",
        "parent",
        "targetAgent",
        "task",
        "channel",
        "secret",
        "mcp",
        "nodeTool",
        "model",
        "with",
    ];

    // Resource selectors, named as the catalog's operations declare them.
    private static readonly string[] Resources =
    [
        "node",
        "path",
        "targetSession",
        "parent",
        "targetAgent",
        "task",
        "channel",
        "secret",
        "mcp",
        "nodeTool",
        "model",
    ];

    internal static bool IsOperationRule(JsonObject? rule) => rule?.ContainsKey("op") == true;

    internal static bool HasOperationRules(ToolAuthorizationPolicy policy) =>
        policy.Value["rules"] is JsonArray rules
        && rules.OfType<JsonObject>().Any(IsOperationRule);

    // Whether stored rules (an Agent-local layer as authored) contain an operation rule.
    internal static bool ContainsOperationRule(JsonNode? rules) =>
        rules is JsonArray list && list.OfType<JsonObject>().Any(rule => rule.ContainsKey("op"));

    private static Exception Invalid(string id, string message) =>
        new InvalidDataException($"Operation rule `{id}`: {message}");

    // The normalized selectors of an operation rule: `op` (a list), `match` with only the caller
    // selectors, `resources` and `with`.
    internal static void Normalize(JsonObject rule, string id, JsonObject normalized)
    {
        ToolAuthorizationPolicy.Fields(
            rule,
            ["id", "enabled", "action", "reason", "approval", .. Selectors]
        );
        var ops = Ops(rule["op"], id);
        var match = new JsonObject();
        if (rule.ContainsKey("agent"))
            match["agent"] = ToolAuthorizationPolicy.CallerMatcher(rule["agent"]);
        if (rule.ContainsKey("session"))
            match["sessionPattern"] = ToolAuthorizationPolicy.Identities(rule["session"]);
        if (rule.ContainsKey("externalId"))
            match["externalId"] = ToolAuthorizationPolicy.CallerMatcher(rule["externalId"]);
        var resources = new JsonObject();
        foreach (var key in Resources)
            if (rule.ContainsKey(key))
                resources[key] = Resource(key, rule[key], id);
        var with = new JsonObject();
        if (rule.ContainsKey("with"))
        {
            if (rule["with"] is not JsonObject attributes || attributes.Count is 0 or > 16)
                throw Invalid(id, "`with` must map 1-16 attribute names to values.");
            foreach (var (name, value) in attributes)
                with[name] = ToolAuthorizationPolicy.ValueMatcher(value);
        }
        Validate(ops, resources, with, id);
        normalized["op"] = new JsonArray(ops.Select(op => (JsonNode?)op).ToArray());
        normalized["match"] = match;
        if (resources.Count > 0)
            normalized["resources"] = resources;
        if (with.Count > 0)
            normalized["with"] = with;
    }

    private static string[] Ops(JsonNode? node, string id)
    {
        var values = node is JsonArray list ? list.ToArray() : [node];
        if (values.Length is < 1 or > 64)
            throw Invalid(id, "`op` must name 1-64 operations.");
        var ops = new List<string>();
        foreach (var value in values)
        {
            var op =
                SessionWait.Text(value)?.Trim()
                ?? throw Invalid(id, "`op` entries must be strings.");
            if (op == "*")
            {
                ops.Add(op);
                continue;
            }
            if (op.EndsWith(".*", StringComparison.Ordinal))
            {
                var family = op[..^1];
                if (!OperationDeclarations.Operations.Any(spec => spec.Op.StartsWith(family, StringComparison.Ordinal)))
                    throw Invalid(id, $"unknown operation family `{op}`.");
                ops.Add(op);
                continue;
            }
            if (OperationDeclarations.Spec(op) is null)
                throw Invalid(id, $"unknown operation `{op}`.");
            ops.Add(op);
        }
        return ops.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static JsonNode Resource(string key, JsonNode? value, string id)
    {
        switch (key)
        {
            case "node":
                return ToolAuthorizationPolicy.NodeSelector(value);
            case "channel":
            case "nodeTool":
            case "model":
                return ToolAuthorizationPolicy.Identities(value);
            case "secret":
                return ToolAuthorizationPolicy.SecretSelector(value);
            case "path":
            {
                if (value is not JsonObject map || map.Count == 0)
                    throw Invalid(id, "`path` requires `within`, `notWithin` or both.");
                ToolAuthorizationPolicy.Fields(map, "within", "notWithin");
                var result = new JsonObject();
                foreach (var (name, root) in map)
                    result[name] = ToolAuthorizationPolicy.PathRoot(root);
                return result;
            }
            case "targetSession":
            case "parent":
            {
                if (value is not JsonObject map || map.Count != 1)
                    throw Invalid(id, $"`{key}` requires exactly one of `session` or `id`.");
                ToolAuthorizationPolicy.Fields(map, "session", "id");
                if (map.ContainsKey("id"))
                    return new JsonObject { ["id"] = ToolAuthorizationPolicy.Identities(map["id"]) };
                return ToolAuthorizationPolicy.SessionCondition(
                    new JsonObject { ["session"] = map["session"]?.DeepClone() }
                );
            }
            case "targetAgent":
            {
                if (value is not JsonObject map || map.Count != 1)
                    throw Invalid(
                        id,
                        "`targetAgent` requires exactly one of `self`, `descendant` or `id`."
                    );
                ToolAuthorizationPolicy.Fields(map, "self", "descendant", "id");
                if (map.ContainsKey("id"))
                    return new JsonObject { ["id"] = ToolAuthorizationPolicy.Identities(map["id"]) };
                var name = map.First().Key;
                if (!ToolAuthorizationPolicy.Boolean(map[name]))
                    throw Invalid(id, $"`targetAgent.{name}` must be true.");
                return new JsonObject { [name] = true };
            }
            case "task":
            {
                if (value is not JsonObject map || map.Count != 1)
                    throw Invalid(id, "`task` requires exactly one of `owned` or `created`.");
                ToolAuthorizationPolicy.Fields(map, "owned", "created");
                var name = map.First().Key;
                if (!ToolAuthorizationPolicy.Boolean(map[name]))
                    throw Invalid(id, $"`task.{name}` must be true.");
                return new JsonObject { [name] = true };
            }
            case "mcp":
            {
                if (value is not JsonObject map || map.Count == 0)
                    throw Invalid(id, "`mcp` requires `server`, `tool` or both.");
                ToolAuthorizationPolicy.Fields(map, "server", "tool");
                var result = new JsonObject();
                foreach (var (name, item) in map)
                    result[name] = ToolAuthorizationPolicy.Identities(item);
                return result;
            }
            default:
                throw Invalid(id, $"unsupported selector `{key}`.");
        }
    }

    // Each listed op must declare every selector the rule uses. A pattern applies to the ops of
    // its family that declare them, and must cover at least one.
    private static void Validate(string[] ops, JsonObject resources, JsonObject with, string id)
    {
        foreach (var op in ops)
        {
            if (op == "*" || op.EndsWith(".*", StringComparison.Ordinal))
            {
                if (!OperationDeclarations.Operations.Any(spec => Applies(op, spec, resources, with)))
                    throw Invalid(
                        id,
                        $"no operation of `{op}` declares every selector the rule uses."
                    );
                continue;
            }
            var spec = OperationDeclarations.Spec(op)!;
            foreach (var (name, _) in resources)
                if (!spec.Resources.Contains(name))
                    throw Invalid(id, $"operation `{op}` has no `{name}` resource.");
            foreach (var (name, _) in with)
                if (!spec.Attributes.Contains(name))
                    throw Invalid(id, $"operation `{op}` has no `with.{name}` attribute.");
        }
        if (ops.Contains("secret.use") && ops.Length > 1)
            throw Invalid(id, "`secret.use` must be the only operation of its rule.");
        if (resources.ContainsKey("secret") && !ops.All(op => op is "secret.use" or "secret.manage"))
            throw Invalid(id, "the `secret` selector applies only to `secret.use` and `secret.manage`.");
    }

    // Whether one entry of a rule's `op` list covers an operation. Patterns never include
    // secret.use, and cover only the ops that declare every selector the rule uses.
    private static bool Applies(string entry, OperationSpec spec, JsonObject? resources, JsonObject? with)
    {
        if (entry == spec.Op)
            return true;
        if (spec.Op == "secret.use")
            return false;
        var covered =
            entry == "*"
            || entry.EndsWith(".*", StringComparison.Ordinal)
                && spec.Op.StartsWith(entry[..^1], StringComparison.Ordinal);
        return covered
            && (resources ?? []).All(pair => spec.Resources.Contains(pair.Key))
            && (with ?? []).All(pair => spec.Attributes.Contains(pair.Key));
    }

    internal static bool Covers(JsonObject rule, string op)
    {
        var spec = OperationDeclarations.Spec(op);
        if (spec is null)
            return false;
        var resources = rule["resources"] as JsonObject;
        var with = rule["with"] as JsonObject;
        return (rule["op"] as JsonArray ?? [])
            .Select(SessionWait.Text)
            .OfType<string>()
            .Any(entry => Applies(entry, spec, resources, with));
    }

    // Whether the rule names secret.use itself, the only way it decides secret names.
    internal static bool NamesSecretUse(JsonObject rule) =>
        (rule["op"] as JsonArray ?? []).Any(entry => SessionWait.Text(entry) == "secret.use");

    // Whether an operation rule matches an operation of the request. Caller selectors decide
    // first; a resource selector over a value or fact that could not be established makes the
    // match undecidable.
    internal static OperationMatch Match(
        JsonObject rule,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request,
        bool restrictive
    )
    {
        if (!ToolAuthorizationEvaluation.Identity(rule["match"]!.AsObject(), request))
            return OperationMatch.No;
        if (operation.Underivable is not null)
            return OperationMatch.Unknown;
        if (!Covers(rule, operation.Op))
            return OperationMatch.No;
        var unknown = false;
        foreach (var (key, matcher) in rule["resources"] as JsonObject ?? [])
        {
            var result = Resource(key, matcher!, operation, request, restrictive);
            if (result == OperationMatch.No)
                return OperationMatch.No;
            unknown |= result == OperationMatch.Unknown;
        }
        foreach (var (name, matcher) in rule["with"] as JsonObject ?? [])
        {
            var present = operation.With.TryGetPropertyValue(name, out var value);
            // An attribute that could not be established leaves the rule undecidable.
            if (present && value is null)
            {
                unknown = true;
                continue;
            }
            if (!ToolAuthorizationEvaluation.Scalar(matcher, new(present, value)))
                return OperationMatch.No;
        }
        return unknown ? OperationMatch.Unknown : OperationMatch.Yes;
    }

    // Whether a secret.use rule covers one secret name of the request.
    internal static bool CoversSecret(JsonObject rule, string name, ToolAuthorizationRequest request) =>
        rule["resources"]?["secret"] is not JsonObject selector
        || (selector["anyOf"] is not { } patterns || ToolAuthorizationEvaluation.Pattern(patterns, name))
            && (
                selector["owned"] is null
                || request.OwnedSecrets?.Contains(name, StringComparer.Ordinal) == true
            );

    private static OperationMatch Of(bool value) => value ? OperationMatch.Yes : OperationMatch.No;

    private static OperationMatch Resource(
        string key,
        JsonNode matcher,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request,
        bool restrictive
    )
    {
        if (!operation.Resources.TryGetPropertyValue(key, out var value))
            return OperationMatch.No;
        if (value is null)
            return OperationMatch.Unknown;
        var external = request.Principal != "internal";
        switch (key)
        {
            case "node":
                return SessionWait.Text(value) is string node
                    ? Of(ToolAuthorizationEvaluation.NodeMatches(matcher, node, request))
                    : OperationMatch.Unknown;
            case "path":
                return Path(matcher.AsObject(), operation, request, restrictive);
            case "channel":
            case "nodeTool":
            case "model":
                return Of(
                    SessionWait.Text(value) is string text
                        && ToolAuthorizationEvaluation.Pattern(matcher, text)
                );
            case "mcp":
            {
                // An MCP tool is {server, tool}; a managed or subscribed server is its name.
                var server = SessionWait.Text(value) ?? SessionWait.Text(value["server"]);
                var tool = value is JsonObject identity ? SessionWait.Text(identity["tool"]) : null;
                // A discovered server's tool name is unknown: only its server can decide.
                var toolUnknown = value is JsonObject named && named.ContainsKey("tool") && named["tool"] is null;
                var unknownTool = false;
                foreach (var (part, pattern) in matcher.AsObject())
                {
                    if (part == "tool" && toolUnknown)
                    {
                        unknownTool = true;
                        continue;
                    }
                    if (
                        (part == "server" ? server : tool) is not string name
                        || !ToolAuthorizationEvaluation.Pattern(pattern!, name)
                    )
                        return OperationMatch.No;
                }
                return unknownTool ? OperationMatch.Unknown : OperationMatch.Yes;
            }
            case "secret":
            {
                if (SessionWait.Text(value) is not string name)
                    return OperationMatch.Unknown;
                if (matcher["anyOf"] is { } patterns && !ToolAuthorizationEvaluation.Pattern(patterns, name))
                    return OperationMatch.No;
                if (matcher["owned"] is null)
                    return OperationMatch.Yes;
                if (external)
                    return OperationMatch.No;
                return operation.SecretOwned is bool owned ? Of(owned) : OperationMatch.Unknown;
            }
            case "targetSession":
            case "parent":
                return Session(
                    matcher.AsObject(),
                    value,
                    key == "parent" ? operation.ParentTarget : operation.Target,
                    operation,
                    request,
                    restrictive
                );
            case "targetAgent":
            {
                var agent = SessionWait.Text(value);
                if (matcher["id"] is { } ids)
                    return agent is null
                        ? OperationMatch.Unknown
                        : Of(ToolAuthorizationEvaluation.Pattern(ids, agent));
                if (external)
                    return OperationMatch.No;
                if (matcher["self"] is not null)
                    return agent is null ? OperationMatch.Unknown : Of(agent == request.Agent);
                return operation.AgentDescendant is bool descendant
                    ? Of(descendant)
                    : OperationMatch.Unknown;
            }
            case "task":
            {
                if (external)
                    return OperationMatch.No;
                var fact = matcher["owned"] is not null ? operation.TaskOwned : operation.TaskCreated;
                return fact is bool known ? Of(known) : OperationMatch.Unknown;
            }
            default:
                return OperationMatch.No;
        }
    }

    // `within` holds when the path is on master inside the root; `notWithin` when it is not.
    // Agent path variables never match for external principals. A tree path (a copy leg) holds
    // a selector only when every path in it does. When only part of the tree does (the
    // selector's root lies inside it), a restrictive rule still applies and a grant does not.
    private static OperationMatch Path(
        JsonObject matcher,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request,
        bool restrictive
    )
    {
        if (operation.Path is not { } path)
            return OperationMatch.Unknown;
        foreach (var (name, rootValue) in matcher)
        {
            var root = ToolAuthorizationEvaluation.PolicyRoot(SessionWait.Text(rootValue)!, request);
            if (root is null)
                return OperationMatch.No;
            var master = path.Node == "master";
            var within = master && ToolAuthorizationEvaluation.Within(path.Resolved, root);
            var holds = name == "within" ? within : !within;
            var partial =
                !within
                && path.Tree
                && master
                && path.Resolved is { } resolved
                && ToolAuthorizationEvaluation.Within(root, System.IO.Path.GetFullPath(resolved));
            if (!holds && !(partial && restrictive))
                return OperationMatch.No;
            if (holds && partial && !restrictive)
                return OperationMatch.No;
        }
        return OperationMatch.Yes;
    }

    private static OperationMatch Session(
        JsonObject matcher,
        JsonNode value,
        AuthorizationTarget? target,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request,
        bool restrictive
    )
    {
        var prospective = value is JsonObject marker && marker["prospective"] is not null;
        if (matcher["id"] is { } ids)
        {
            if (prospective)
                // The ID is allocated when the Session is created; a restriction applies to any
                // ID it could get, a grant to none.
                return restrictive ? OperationMatch.Yes : OperationMatch.No;
            var id = target?.Id ?? SessionWait.Text(value);
            return id is null ? OperationMatch.Unknown : Of(ToolAuthorizationEvaluation.Pattern(ids, id));
        }
        if (request.Principal != "internal")
            return OperationMatch.No;
        var condition = matcher["session"]!.AsObject();
        if (prospective)
        {
            // A Session the call creates: never the caller or its parent; a child when the
            // operation creates the caller's child; in the caller's Agent when its target Agent is.
            if (condition.ContainsKey("self"))
                return OperationMatch.No;
            if (condition.ContainsKey("sameAgent"))
            {
                var agent = SessionWait.Text(operation.Resources["targetAgent"]) ?? request.Agent;
                if (agent != request.Agent)
                    return OperationMatch.No;
            }
            if (condition["relation"] is { } relation)
            {
                var child = SessionWait.Text(operation.With["kind"]) == "child";
                var relations = relation is JsonArray list
                    ? list.Select(SessionWait.Text)
                    : [SessionWait.Text(relation)];
                if (!child || !relations.Contains("child"))
                    return OperationMatch.No;
            }
            return OperationMatch.Yes;
        }
        if (target is null)
            return OperationMatch.Unknown;
        return Of(ToolAuthorizationEvaluation.SessionCondition(condition, target, request));
    }
}
