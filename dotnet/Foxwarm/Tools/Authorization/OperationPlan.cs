using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

// Facts a plan may use beyond the call and its request. Every lookup is optional, in-memory and
// unprotected; without it the plan reports the gap.
internal sealed record PlanContext(string CurrentNode)
{
    internal string? PolicyPath { get; init; }

    // The authorization subtree of a Node, the Node first (node_remove cascades).
    internal Func<string, IReadOnlyList<string>?>? Subtree { get; init; }

    // Whether a Session exists in the catalog; null when unknown.
    internal Func<string, bool?>? SessionExists { get; init; }

    // Whether node select probes this Node's default cwd (the handler's own condition).
    internal Func<string, bool>? DefaultCwdProbe { get; init; }

    // The call can have secret facts that its assessment could not establish.
    internal bool SecretsUnknown { get; init; }

    // The memory directory of an Agent, and the Agent of a Session; null when unknown.
    internal Func<string, string?>? MemoryDirectory { get; init; }
    internal Func<string, string?>? SessionAgent { get; init; }

    // The Node a new Session of an Agent starts on without an explicit or inherited Node (its
    // default, the installation default, then master); null when unknown.
    internal Func<string, string?>? AgentDefaultNode { get; init; }

    // The effective working directory of an exec without cwd on master; null when unknown.
    internal Func<AuthorizationPath?>? DefaultExecCwd { get; init; }
}

internal sealed record PlannedOperation(
    string Op,
    JsonObject Resources,
    JsonObject With,
    bool Conditional
);

// A planned obligation. Request is the concrete request it is evaluated as when the plan can
// construct it; SameAsPrimary marks one evaluated as the call's own request; CreationAgent marks
// a creation-target probe. Gap says why an obligation cannot be evaluated from the plan.
internal sealed record PlannedObligation(
    string Id,
    ObligationKind Kind,
    string Capability,
    string Description,
    bool Optional,
    bool Conditional,
    ResolvedTool? Request = null,
    bool SameAsPrimary = false,
    string? CreationAgent = null,
    string? Gap = null
);

// Phase 1: a diagnostic derivation from normalized arguments and the facts the existing
// assessment already established. It never authorizes, denies or reads, and handlers do not
// consume its normalized arguments. Derive never throws; what it cannot establish is reported in
// Incomplete.
internal sealed partial record OperationPlan(
    string Capability,
    OperationDeclaration? Declaration,
    JsonObject Raw,
    JsonObject Normalized,
    string? Branch,
    string? Self,
    IReadOnlyList<PlannedOperation> Operations,
    IReadOnlyList<PlannedObligation> Obligations,
    IReadOnlyList<string> Subsumed,
    IReadOnlyList<string> Incomplete
)
{
    internal static string CapabilityId(ResolvedTool tool) =>
        tool.Source switch
        {
            "node" => $"node:{tool.ExecutionNode}/{tool.Name}",
            "mcp" => $"mcp:{tool.Server}/{tool.Name}",
            _ => $"{tool.Source}:{tool.Name}",
        };

    internal static string KindName(ObligationKind kind) =>
        kind switch
        {
            ObligationKind.Primary => "primary",
            ObligationKind.SubRequest => "subRequest",
            ObligationKind.Probe => "probe",
            ObligationKind.Retained => "retained",
            _ => "nested",
        };

    // The handler's syntax normalization of the action field, and its default. Returns the
    // normalized arguments; other fields keep their raw values.
    internal static JsonObject Normalize(
        OperationDeclaration? declaration,
        JsonObject raw,
        List<string>? gaps = null
    )
    {
        var normalized = (JsonObject)raw.DeepClone();
        if (declaration is null || !declaration.HasActions)
            return normalized;
        var value = raw["action"];
        string? action = null;
        if (value is not null)
        {
            if (SessionWait.Text(value) is not string text)
            {
                // The session handler reads a non-string action as absent; the others reject it.
                if (declaration.Normalize != ActionNormalization.SessionTrimLower)
                {
                    gaps?.Add("action is not a string");
                    return normalized;
                }
                text = "";
            }
            action = declaration.Normalize switch
            {
                ActionNormalization.TrimLower => text.Trim().ToLowerInvariant(),
                ActionNormalization.SessionTrimLower => SessionGoal.Trim(text).ToLowerInvariant(),
                _ => text,
            };
        }
        if (string.IsNullOrEmpty(action) && declaration.DefaultAction is { } fallback)
            action = fallback;
        if (action is not null)
            normalized["action"] = action;
        return normalized;
    }

    internal static OperationPlan Derive(
        ResolvedTool resolved,
        ToolAuthorizationRequest? facts,
        PlanContext context
    )
    {
        var gaps = new List<string>();
        var declaration = OperationDeclarations.Find(resolved.Source, resolved.Name);
        var raw = (JsonObject)resolved.Args.DeepClone();
        try
        {
            if (declaration is null)
            {
                gaps.Add("no operation declaration for this capability");
                return new(CapabilityId(resolved), null, raw, raw, null, null, [], [], [], gaps);
            }
            var normalized = Normalize(declaration, raw, gaps);
            var derivation = new Derivation(resolved, facts, context, normalized, gaps);
            var branch = declaration.Branches.FirstOrDefault(item =>
                (item.Action is null || item.Action == SessionWait.Text(normalized["action"]))
                && (item.When is null || derivation.Holds(item.When) == true)
            );
            if (branch is null && declaration.FrontEnd is null)
                gaps.Add(
                    SessionWait.Text(normalized["action"]) is string action
                        ? $"no declared branch for action `{action}`"
                        : "no declared branch for this call"
                );
            var operations = new List<PlannedOperation>();
            foreach (var template in branch?.Operations ?? [])
                operations.AddRange(derivation.Expand(template));
            var obligations = new List<PlannedObligation>();
            if (branch is not null)
                foreach (var template in declaration.Obligations)
                    obligations.AddRange(derivation.Obligation(template));
            return new(
                CapabilityId(resolved),
                declaration,
                raw,
                normalized,
                branch?.Name,
                branch?.Self,
                operations,
                obligations,
                declaration.Subsumed,
                gaps
            );
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            gaps.Add("derivation failed: " + error.Message);
            return new(CapabilityId(resolved), declaration, raw, raw, null, null, [], [], [], gaps);
        }
    }

    // The branch's Self reason when the call acts only on the caller's own turn, context, runs,
    // transfers or history images (phase 3: such a call is not authorizable).
    internal static string? SelfReason(ResolvedTool resolved) =>
        OperationDeclarations.Find(resolved.Source, resolved.Name) is { FrontEnd: null }
            ? Derive(resolved, null, new PlanContext(resolved.ExecutionNode)).Self
            : null;

    // The operations operation rules decide for a call: every ordinary op of its branch. What
    // cannot be derived is kept as unresolved resources, or as an underivable stand-in
    // operation, never dropped. A Self branch has none. Secret names are decided from the
    // request's secret facts, not from here.
    internal static IReadOnlyList<AuthorizationOperation> AuthorizationOperations(
        ResolvedTool resolved,
        ToolAuthorizationRequest? facts,
        PlanContext context
    )
    {
        var gaps = new List<string>();
        var declaration = OperationDeclarations.Find(resolved.Source, resolved.Name);
        if (declaration is null)
            return [Underivable("no operation declaration for this capability")];
        try
        {
            var normalized = Normalize(declaration, resolved.Args, gaps);
            if (gaps.Count > 0)
                return [Underivable(gaps[0])];
            var derivation = new Derivation(resolved, facts, context, normalized, gaps);
            var branch = declaration.Branches.FirstOrDefault(item =>
                (item.Action is null || item.Action == SessionWait.Text(normalized["action"]))
                && (item.When is null || derivation.Holds(item.When) == true)
            );
            if (branch is null)
                return [
                    Underivable(
                        SessionWait.Text(normalized["action"]) is string action
                            ? $"no declared branch for action `{action}`"
                            : "no declared branch for this call"
                    ),
                ];
            if (branch.Self is not null)
                return [];
            return branch
                .Operations.SelectMany(template => derivation.ForAuthorization(template))
                .ToArray();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return [Underivable("derivation failed: " + error.Message)];
        }
    }

    // The unconditional operations of each branch a call could take when only some of its
    // arguments are known (visibility). The action selects branches only when it is known.
    internal static IEnumerable<(ActionBranch Branch, IReadOnlyList<AuthorizationOperation> Operations)> BranchOperations(
        OperationDeclaration declaration,
        ResolvedTool resolved,
        ToolAuthorizationRequest facts,
        bool actionKnown,
        IReadOnlySet<string>? knownArgs = null,
        bool unknownName = false
    )
    {
        var known = actionKnown
            ? SessionWait.Text(Normalize(declaration, resolved.Args)["action"])
            : null;
        foreach (var branch in declaration.Branches)
        {
            if (actionKnown && branch.Action is not null && branch.Action != known)
                continue;
            if (branch.Self is not null)
            {
                yield return (branch, []);
                continue;
            }
            var args = (JsonObject)resolved.Args.DeepClone();
            if (branch.Action is not null)
                args["action"] = branch.Action;
            var derivation = new Derivation(
                resolved with
                {
                    Args = args,
                },
                facts,
                new PlanContext(facts.CurrentNode ?? "master"),
                args,
                [],
                // What the caller does not state stays unknown: the action a branch assumes is
                // the only argument this projection adds.
                branch.Action is null
                    ? knownArgs ?? new HashSet<string>()
                    : new HashSet<string>(knownArgs ?? new HashSet<string>(), StringComparer.Ordinal)
                    {
                        "action",
                    },
                unknownName
            );
            var operations = new List<AuthorizationOperation>();
            foreach (var template in branch.Operations.Where(item => !item.Conditional))
                operations.AddRange(derivation.ForAuthorization(template));
            yield return (branch, operations);
        }
    }

    private static AuthorizationOperation Underivable(string reason) =>
        new("", [], []) { Underivable = reason };

    internal JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["capability"] = Capability,
            ["arguments"] = new JsonObject
            {
                ["raw"] = Raw.DeepClone(),
                ["normalized"] = Normalized.DeepClone(),
            },
            ["branch"] = Branch,
        };
        if (Self is not null)
            result["self"] = Self;
        result["operations"] = new JsonArray(
            Operations
                .Select(operation =>
                {
                    var item = new JsonObject { ["op"] = operation.Op };
                    if (operation.Resources.Count > 0)
                        item["resources"] = operation.Resources.DeepClone();
                    if (operation.With.Count > 0)
                        item["with"] = operation.With.DeepClone();
                    if (operation.Conditional)
                        item["conditional"] = true;
                    return (JsonNode?)item;
                })
                .ToArray()
        );
        result["obligations"] = new JsonArray(
            Obligations
                .Select(obligation =>
                {
                    var item = new JsonObject
                    {
                        ["id"] = obligation.Id,
                        ["kind"] = KindName(obligation.Kind),
                        ["capability"] = obligation.Capability,
                        ["description"] = obligation.Description,
                    };
                    if (obligation.Conditional)
                        item["conditional"] = true;
                    if (obligation.Optional)
                        item["optional"] = true;
                    return (JsonNode?)item;
                })
                .ToArray()
        );
        if (Subsumed.Count > 0)
            result["subsumed"] = new JsonArray(
                Subsumed.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()
            );
        if (Incomplete.Count > 0)
            result["incomplete"] = new JsonArray(
                Incomplete.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()
            );
        return result;
    }

    private sealed class Derivation(
        ResolvedTool resolved,
        ToolAuthorizationRequest? facts,
        PlanContext context,
        JsonObject args,
        List<string> gaps,
        IReadOnlySet<string>? known = null,
        bool unknownName = false
    )
    {
        // Whether an argument is outside what a visibility projection knows. Authorization and
        // planning know every argument the call states (and that it omits the rest).
        private bool Unknown(params string[] names) =>
            known is not null && names.Any(name => !known.Contains(name));

        private string? Text(string name) =>
            SessionWait.Text(args[name]) is string text && SessionGoal.Trim(text).Length > 0
                ? text
                : null;

        private bool Present(string name) =>
            args[name] switch
            {
                null => false,
                JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
                JsonValue value when value.TryGetValue<string>(out var text) =>
                    SessionGoal.Trim(text).Length > 0,
                JsonArray list => list.Count > 0,
                _ => true,
            };

        private string? NodeTarget => facts?.NodeTargets is { Count: > 0 } nodes ? nodes[0] : null;

        private string? Action => SessionWait.Text(args["action"]);

        // A condition: true, false, or null when the plan cannot know it.
        internal bool? Holds(string when)
        {
            if (when.StartsWith('!'))
                return Holds(when[1..]) is bool value ? !value : null;
            if (Unknown(ConditionArgs(when)))
                return null;
            if (when.StartsWith("arg:", StringComparison.Ordinal))
                return Present(when[4..]);
            if (when.StartsWith("default-true:", StringComparison.Ordinal))
                // An omitted boolean the handler defaults to true; a non-boolean is rejected.
                return args[when[13..]] switch
                {
                    null => true,
                    JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
                    _ => null,
                };
            if (when.StartsWith("action:", StringComparison.Ordinal))
                return when[7..].Split('|').Contains(Action);
            switch (when)
            {
                case "secrets":
                    // Facts that could not be established are unknown, not an empty set.
                    return facts is null ? null
                        : facts.Secrets is { Count: > 0 } ? true
                        : context.SecretsUnknown ? null
                        : false;
                case "file-source":
                    return Text("code") is null;
                case "file-action":
                    return Action is "prepare" or "publish";
                case "channel":
                    return Text("channelTargetId") is not null;
                case "agent-scope":
                    return Text("sessionId") is null
                        && Text("vector_query") is not null
                        && SessionWait.Text(args["scope"]) != "current-session";
                case "default-cwd-probe":
                    if (Action != "select")
                        return false;
                    if (NodeTarget is not { } node || context.DefaultCwdProbe is not { } probe)
                        return null;
                    return probe(node);
                case "legacy-node":
                    return resolved.ExecutionNode != "master"
                        && (args.ContainsKey("edits") || args.ContainsKey("replaceAll"))
                        ? null
                        : false;
                case "invalid-plan":
                    // Known only after the plan is parsed and validated.
                    return null;
                case "model-request":
                    // Known only when the script calls the model.
                    return null;
                case "source-exists":
                case "source-missing":
                    if (Text("sourceSessionId") is not string source)
                        return false;
                    if (context.SessionExists?.Invoke(SessionGoal.Trim(source)) is not bool exists)
                        return null;
                    return when == "source-exists" ? exists : !exists;
                default:
                    gaps.Add("unknown condition " + when);
                    return null;
            }
        }

        // The items a template expands over.
        private IReadOnlyList<JsonNode?>? Items(string each)
        {
            if (Unknown(ItemArgs(each)))
                return null;
            if (each.StartsWith("path:", StringComparison.Ordinal))
            {
                if (facts is null)
                    return null;
                var arg = each[5..];
                return facts
                    .Paths.Where(path => arg == "*" || path.Arg == arg)
                    .Select(path =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["path"] = path.Resolved ?? path.Raw,
                                ["node"] = path.Node,
                            }
                    )
                    .ToArray();
            }
            switch (each)
            {
                case "secrets":
                    return facts?.Secrets?.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray();
                case "secret-questions":
                    return (args["questions"] as JsonArray ?? [])
                        .OfType<JsonObject>()
                        .Select(question => SessionWait.Text(question["secret"]?["name"])?.Trim())
                        .OfType<string>()
                        .Select(name => (JsonNode?)JsonValue.Create(name))
                        .ToArray();
                case "members":
                    return Members()?.Select(node => (JsonNode?)JsonValue.Create(node)).ToArray();
                case "from-config-files":
                case "from-config-servers":
                    return Foxwarm
                        .Secrets.SecretLiteralMove.Parse(args["fromConfig"])
                        .Where(location =>
                            (location.Target == "mcp") == (each == "from-config-servers")
                        )
                        .Select(location =>
                            each == "from-config-servers" ? location.Path[0] : location.Target
                        )
                        .Distinct(StringComparer.Ordinal)
                        .Select(value => (JsonNode?)JsonValue.Create(value))
                        .ToArray();
                case "probe-sessions":
                    return (args["probes"] as JsonArray ?? [])
                        .OfType<JsonObject>()
                        .Select(probe => SessionWait.Text(probe["sessionId"])?.Trim())
                        .OfType<string>()
                        .Select(id => (JsonNode?)JsonValue.Create(id))
                        .ToArray();
                default:
                    gaps.Add("unknown expansion " + each);
                    return null;
            }
        }

        private IReadOnlyList<string>? Members()
        {
            if (Text("nodeId") is not string id)
                return null;
            return context.Subtree?.Invoke(id.Trim());
        }

        // A value expression. Returns false when the value is unknown; optional values that are
        // absent return true with a null value and are omitted.
        private bool Value(string expression, JsonNode? item, out JsonNode? value, out bool omit)
        {
            omit = false;
            value = null;
            if (expression.StartsWith('='))
            {
                value = expression[1..];
                return true;
            }
            if (Unknown(ValueArgs(expression)))
                return false;
            if (expression == "server-tool" && unknownName)
            {
                // Discovery knows the server, not which of its tools will be called.
                value = new JsonObject { ["server"] = resolved.Server, ["tool"] = null };
                return true;
            }
            if (expression.StartsWith("arg?:", StringComparison.Ordinal))
            {
                // `arg?:name??default`: the handler's default for an omitted argument.
                var (name, fallback) = Defaulted(expression[5..]);
                value = args[name]?.DeepClone();
                if (value is null && fallback is not null)
                    value = fallback;
                omit = value is null;
                return true;
            }
            if (expression.StartsWith("arg:", StringComparison.Ordinal))
            {
                value = args[expression[4..]]?.DeepClone();
                return value is not null;
            }
            if (expression.StartsWith("has:", StringComparison.Ordinal))
            {
                value = Present(expression[4..]);
                return true;
            }
            if (expression.StartsWith("path?:", StringComparison.Ordinal))
            {
                var path = facts?.Paths.FirstOrDefault(fact => fact.Arg == expression[6..]);
                value = path is null ? null : path.Resolved ?? path.Raw;
                if (value is null && expression == "path?:cwd" && Text("cwd") is null)
                {
                    // An exec without cwd runs in the Session's working directory on master. On
                    // another Node it runs in that Node's directory, which no path selector
                    // matches (they hold only for resolved master paths); an inbound caller's
                    // paths are never resolved either.
                    if (resolved.ExecutionNode != "master" || facts is { Principal: not "internal" })
                    {
                        value = ".";
                        return true;
                    }
                    if (context.DefaultExecCwd?.Invoke() is not { } cwd)
                        return false;
                    value = cwd.Resolved ?? cwd.Raw;
                    return true;
                }
                omit = value is null;
                return true;
            }
            switch (expression)
            {
                case "each":
                    value = item?.DeepClone();
                    return value is not null;
                case "each.path":
                case "each.node":
                    value = item?[expression[5..]]?.DeepClone();
                    return value is not null;
                case "exec-node":
                    value = resolved.ExecutionNode;
                    return true;
                case "memory-source":
                {
                    // create_agent copies the memory of the source Session's Agent, else main's.
                    var agent = Text("sourceSessionId") is string source
                        ? context.SessionAgent?.Invoke(SessionGoal.Trim(source))
                        : "main";
                    value = agent is null ? null : context.MemoryDirectory?.Invoke(agent);
                    return value is not null;
                }
                case "memory-target":
                    value = Text("agentName") is string name
                        ? context.MemoryDirectory?.Invoke(name.Trim())
                        : null;
                    return value is not null;
                case "node-target":
                case "node-target?":
                    value = NodeTarget;
                    omit = value is null && expression.EndsWith('?');
                    return value is not null || omit;
                case "provider-node":
                    value = NodeTarget ?? Text("nodeId")?.Trim();
                    return value is not null;
                case "target-session":
                    // Inbound front ends pass the canonical Session ID they resolved. Internal
                    // calls use the request's Session target; a capability without a registered
                    // resolver names its target in sessionId, which some default to the caller.
                    value =
                        facts?.SessionTarget?.Id
                        ?? (
                            facts is { Principal: not "internal" } ? Text("sessionId")?.Trim()
                            : facts is null
                            || ToolAuthorizationPolicy.TargetResolvers.ContainsKey(resolved.Name)
                                ? null
                            : CallerDefaultTargets.Contains(resolved.Name)
                                ? Text("sessionId")?.Trim() ?? facts.Session
                            : ArgumentTargets.Contains(resolved.Name) ? Text("sessionId")?.Trim()
                            : null
                        );
                    return value is not null;
                case "child-node":
                {
                    // create_child_session: the explicit Node, else the caller's current Node in
                    // its own Agent, else the target Agent's default.
                    if (args["node"] is JsonNode explicitNode)
                    {
                        value = explicitNode.DeepClone();
                        return true;
                    }
                    var agent = SessionWait.Text(args["agentName"]) ?? facts?.Agent;
                    value =
                        agent is null ? null
                        : agent == facts?.Agent ? context.CurrentNode
                        : context.AgentDefaultNode?.Invoke(agent);
                    return value is not null;
                }
                case "session-node":
                {
                    // create_session: the explicit Node, else the Agent's default.
                    if (args["node"] is JsonNode explicitNode)
                    {
                        value = explicitNode.DeepClone();
                        return true;
                    }
                    value = SessionWait.Text(args["agentName"]) is string agent
                        ? context.AgentDefaultNode?.Invoke(agent)
                        : null;
                    return value is not null;
                }
                case "move-agent":
                {
                    // move_session: the new Agent when one is named, else the moved Session's.
                    if (SessionWait.Text(args["newAgentName"]) is { Length: > 0 } named)
                    {
                        value = named;
                        return true;
                    }
                    if (Present("createAgent"))
                        return false;
                    var moved = Text("sessionId")?.Trim() ?? facts?.Session;
                    value = moved is null ? null : context.SessionAgent?.Invoke(moved);
                    return value is not null;
                }
                case "session-scope":
                    // The model's list defaults to the caller's Agent; an inbound list has no
                    // scope argument and lists every Session.
                    value =
                        facts is { Principal: not "internal" } ? "all"
                        : args["scope"]?.DeepClone() ?? "current-agent";
                    return true;
                case "status-node":
                    // Inbound `node status` views the caller's selected Node.
                    value = NodeTarget ?? facts?.TargetNode;
                    return value is not null;
                case "caller":
                    value = facts?.Session;
                    return value is not null;
                case "caller-agent":
                    value = facts?.Agent;
                    return value is not null;
                case "agent-or-caller":
                    value = Text("agentName")?.Trim() ?? facts?.Agent;
                    return value is not null;
                case "timer-owner":
                    value = Text("sessionId")?.Trim() ?? facts?.Session;
                    return value is not null;
                case "timer-kind":
                    if (!args.ContainsKey("action"))
                    {
                        // An update keeps the stored kind.
                        value = resolved.Name == "create_timer" ? "message" : null;
                        return value is not null;
                    }
                    value = Foxwarm.Timers.TimerArguments.Script(args) ? "script" : "message";
                    return true;
                case "placement":
                    value = Text("node") is null ? "inherited" : "explicit";
                    return true;
                case "recall-mode":
                    value = Text("vector_query") is null ? "exact" : "vector";
                    return true;
                case "has-secret-questions":
                    value = (Items("secret-questions")?.Count ?? 0) > 0;
                    return true;
                case "prospective":
                    value = new JsonObject { ["prospective"] = true };
                    return true;
                case "tool":
                    value = resolved.Name;
                    return true;
                case "server-tool":
                    value = new JsonObject { ["server"] = resolved.Server, ["tool"] = resolved.Name };
                    return true;
                default:
                    return false;
            }
        }

        private static (string Name, JsonNode? Fallback) Defaulted(string spec)
        {
            var index = spec.IndexOf("??", StringComparison.Ordinal);
            if (index < 0)
                return (spec, null);
            var text = spec[(index + 2)..];
            return (spec[..index], text is "true" or "false" ? JsonValue.Create(text == "true") : JsonValue.Create(text));
        }

        // A template as operation rules decide it: an unknown condition or missing per-item
        // facts give an operation whose resources are unresolved instead of no operation.
        internal IEnumerable<AuthorizationOperation> ForAuthorization(OperationTemplate template)
        {
            // Secret names are decided in their own domain from the request's secret facts.
            if (template.Op == "secret.use")
                yield break;
            if (template.When is { } when)
            {
                var holds = Holds(when);
                if (holds == false)
                    yield break;
                if (holds is null)
                {
                    yield return Unresolved(template);
                    yield break;
                }
            }
            if (template.Each is { } each && each.StartsWith("path:", StringComparison.Ordinal))
            {
                var arg = each[5..];
                var paths = facts?.Paths.Where(path => arg == "*" || path.Arg == arg).ToArray();
                if (paths is not { Length: > 0 })
                {
                    yield return Unresolved(template);
                    yield break;
                }
                foreach (var path in paths)
                {
                    var item = new JsonObject
                    {
                        ["path"] = path.Resolved ?? path.Raw,
                        ["node"] = path.Node,
                    };
                    yield return Build(template, item) with { Path = path };
                }
                yield break;
            }
            IReadOnlyList<JsonNode?> items = [null];
            if (template.Each is { } other)
            {
                IReadOnlyList<JsonNode?>? expanded;
                try
                {
                    expanded = Items(other);
                }
                catch (InvalidDataException)
                {
                    expanded = null;
                }
                if (
                    expanded is null
                    || expanded.Count == 0
                        && other
                            is not (
                                "secret-questions"
                                or "from-config-files"
                                or "from-config-servers"
                            )
                )
                {
                    yield return Unresolved(template);
                    yield break;
                }
                items = expanded;
            }
            foreach (var item in items)
                yield return Build(template, item);
        }

        private static AuthorizationOperation Unresolved(OperationTemplate template)
        {
            var resources = new JsonObject();
            foreach (var key in template.Resources.Keys)
                resources[key] = null;
            var with = new JsonObject();
            foreach (var key in template.With.Keys)
                with[key] = null;
            return new(template.Op, resources, with);
        }

        private AuthorizationOperation Build(OperationTemplate template, JsonNode? item)
        {
            var resources = new JsonObject();
            var with = new JsonObject();
            foreach (var (key, expression) in template.Resources)
                if (!Value(expression, item, out var value, out var omit))
                    resources[key] = null;
                else if (!omit)
                    resources[key] = value;
            foreach (var (key, expression) in template.With)
                if (!Value(expression, item, out var value, out var omit))
                    with[key] = null;
                else if (!omit)
                    with[key] = value;
            var operation = new AuthorizationOperation(template.Op, resources, with);
            // A path that is not one of the request's path facts (an Agent memory directory, an
            // exec cwd) is matched as it is, on its Node; only an Agent memory directory is
            // already a resolved master path.
            if (SessionWait.Text(resources["path"]) is string text)
                operation = operation with
                {
                    Path =
                        facts?.Paths.FirstOrDefault(path => (path.Resolved ?? path.Raw) == text)
                        ?? (
                            template.Resources["path"] == "path?:cwd"
                                ? context.DefaultExecCwd?.Invoke()
                                : null
                        )
                        ?? new AuthorizationPath(
                            "path",
                            text,
                            template.Resources["path"].StartsWith("memory-", StringComparison.Ordinal)
                                ? text
                                : null,
                            SessionWait.Text(resources["node"]) ?? "master"
                        ),
                };
            if (
                SessionWait.Text(resources["targetSession"]) is string target
                && facts?.SessionTarget is { } session
                && session.Id == target
            )
                operation = operation with { Target = session };
            if (
                resources.ContainsKey("task")
                && facts?.TaskOwnerSession is { } owner
                && facts.Session is { } caller
            )
                operation = operation with { TaskOwned = owner == caller };
            if (
                SessionWait.Text(resources["secret"]) is string secret
                && facts?.OwnedSecrets?.Contains(secret, StringComparer.Ordinal) == true
            )
                operation = operation with { SecretOwned = true };
            return operation;
        }

        internal IEnumerable<PlannedOperation> Expand(OperationTemplate template)
        {
            if (template.When is { } when)
            {
                var holds = Holds(when);
                if (holds == false)
                    yield break;
                if (holds is null)
                {
                    gaps.Add(
                        when == "secrets" && facts is not null
                            ? $"{template.Op}: the secret facts are unknown"
                            : $"{template.Op}: condition `{when}` is decided at run time"
                    );
                    yield break;
                }
            }
            IReadOnlyList<JsonNode?> items = [null];
            if (template.Each is { } each)
            {
                var expanded = Items(each);
                if (expanded is null || expanded.Count == 0)
                {
                    // Conditional per-item templates (secrets, questions) have no items to add.
                    if (
                        each
                            is "secrets"
                                or "secret-questions"
                                or "from-config-files"
                                or "from-config-servers"
                        && expanded is not null
                    )
                        yield break;
                    gaps.Add($"{template.Op}: no {each} facts");
                    yield break;
                }
                items = expanded;
            }
            foreach (var item in items)
            {
                var resources = new JsonObject();
                var with = new JsonObject();
                Fill(template, item, resources, template.Resources);
                Fill(template, item, with, template.With);
                yield return new(template.Op, resources, with, template.Conditional);
            }
        }

        private void Fill(
            OperationTemplate template,
            JsonNode? item,
            JsonObject target,
            IReadOnlyDictionary<string, string> parts
        )
        {
            foreach (var (key, expression) in parts)
            {
                if (!Value(expression, item, out var value, out var omit))
                {
                    gaps.Add($"{template.Op}: {key} is not resolved ({expression})");
                    target[key] = null;
                }
                else if (!omit)
                    target[key] = value;
            }
        }

        internal IEnumerable<PlannedObligation> Obligation(ObligationTemplate template)
        {
            var conditional = template.When is not null;
            if (template.When is { } when && Holds(when) == false)
                yield break;
            var unknown = template.When is { } condition && Holds(condition) is null;
            var capability =
                template.Capability == "same" ? CapabilityId(resolved) : template.Capability;
            PlannedObligation Planned(
                string? id = null,
                ResolvedTool? request = null,
                bool same = false,
                string? agent = null,
                string? gap = null
            ) =>
                new(
                    id ?? template.Id,
                    template.Kind,
                    request is null ? capability : CapabilityId(request),
                    template.Description,
                    template.Optional,
                    conditional,
                    request,
                    same,
                    agent,
                    unknown ? $"condition `{template.When}` is decided at run time" : gap
                );
            if (unknown)
            {
                yield return Planned();
                yield break;
            }
            var invocation = resolved.InvocationName;
            switch ((template.Kind, template.Id))
            {
                case (ObligationKind.Primary, _):
                    yield return Planned(same: true);
                    break;
                case (ObligationKind.Nested, _):
                    yield return Planned(gap: "each nested call has its own gate");
                    break;
                case (_, "member"):
                    var members = Members();
                    if (members is null)
                        yield return Planned(gap: "the subtree is read inside the registry mutation");
                    else
                        foreach (var member in members)
                        {
                            var clone = (JsonObject)resolved.Args.DeepClone();
                            clone["nodeId"] = member;
                            yield return Planned(
                                "member:" + member,
                                resolved with { Args = clone }
                            );
                        }
                    break;
                case (_, "reception"):
                    yield return Planned(
                        request: new(
                            invocation,
                            "builtin",
                            "mcp_notifications",
                            new JsonObject
                            {
                                ["action"] = "start",
                                ["server"] = args["server"]?.DeepClone(),
                            }
                        )
                    );
                    break;
                case (ObligationKind.Retained, _):
                    yield return Planned(same: true);
                    break;
                case (_, "source-read") when Text("filePath") is string file:
                    // Artifacts read the raw path; scripts read the trimmed one.
                    yield return Planned(
                        request: resolved.Name == "artifact"
                            ? Read("artifact", file, resolved.ExecutionNode)
                            : Read("read", SessionGoal.Trim(file), resolved.ExecutionNode)
                    );
                    break;
                case (_, "plan-read") when Text("argsFilePath") is string plan:
                    yield return Planned(request: Read("read", plan, context.CurrentNode));
                    break;
                case (_, "probe-view"):
                    // A probe of the caller itself needs no view (aliases resolve at run time).
                    var probes = (Items("probe-sessions") ?? [])
                        .Select(item => item!.GetValue<string>())
                        .Distinct(StringComparer.Ordinal)
                        .Where(probe => probe != facts?.Session);
                    foreach (var probe in probes)
                        yield return Planned(
                            "probe-view:" + probe,
                            new(
                                "view_session",
                                "builtin",
                                "view_session",
                                new JsonObject { ["sessionId"] = probe }
                            )
                        );
                    break;
                case (_, "default-cwd") when NodeTarget is string target:
                    yield return Planned(
                        request: new(
                            "node",
                            "node",
                            "get_default_cwd",
                            new JsonObject(),
                            ExecutionNode: target
                        )
                    );
                    break;
                case (_, "candidate-read")
                    when resolved.Name == "set_config" && Text("filePath") is string candidate:
                    yield return Planned(request: Read("set_config", candidate, "master"));
                    break;
                case (_, "policy-read") when context.PolicyPath is string policy:
                    yield return Planned(request: Read(invocation, policy, "master"));
                    break;
                case (_, "candidate-read") when Text("policyFilePath") is string policyCandidate:
                    yield return Planned(request: Read(invocation, policyCandidate, "master"));
                    break;
                case (_, "file-read") when Text("filePath") is string secretFile:
                    yield return Planned(request: Read("read", secretFile, context.CurrentNode));
                    break;
                case (_, "delete-file") when Text("filePath") is string deleted:
                    yield return Planned(
                        request: new(
                            "edit",
                            "node",
                            "edit",
                            SessionManager.DeletePatch(deleted),
                            ExecutionNode: context.CurrentNode
                        )
                    );
                    break;
                case (_, "creation-target")
                    when resolved.Name == "create_timer" && Text("agentName") is string agent:
                    yield return Planned(agent: agent.Trim());
                    break;
                case (_, "creation-target"):
                    yield return Planned(gap: "the target Agent comes from the timer row the call builds");
                    break;
                default:
                    yield return Planned(gap: "decided by its owner at run time");
                    break;
            }
        }

        private static ResolvedTool Read(string invocation, string path, string node) =>
            new(invocation, "node", "read", new JsonObject { ["filePath"] = path }, ExecutionNode: node);
    }
}
