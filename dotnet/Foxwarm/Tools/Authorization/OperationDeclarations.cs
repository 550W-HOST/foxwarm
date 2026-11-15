namespace Foxwarm.Tools;

// Operation declarations of every registered capability: the operations a call performs (its
// physical effects), the authorization obligations it must pass today, its action branches and
// the internal work its effects subsume. Phase 1 of operation authorization uses them as
// diagnostic metadata only. Nothing here authorizes, denies or reads; the existing evaluator
// stays authoritative.
internal enum ObligationKind
{
    Primary,
    SubRequest,
    Probe,
    Retained,
    Nested,
}

// An op of the operation catalog with the resource selectors and attributes it declares.
internal sealed record OperationSpec(
    string Op,
    IReadOnlyList<string> Resources,
    IReadOnlyList<string> Attributes
);

// One operation of a branch. Resources and With map a selector or attribute to a value
// expression that OperationPlan evaluates against the call (see OperationPlan.Value). Each, when
// set, expands the template once per item (path facts of an argument, secret names, Node
// targets). When names the condition of a conditional template.
internal sealed record OperationTemplate(
    string Op,
    IReadOnlyDictionary<string, string> Resources,
    IReadOnlyDictionary<string, string> With,
    string? Each = null,
    string? When = null
)
{
    internal bool Conditional => When is not null;
}

// A policy assessment the invocation must pass. Capability names the identity it is evaluated
// as: "same" for the call's own capability, otherwise a capability such as "node:read" (a Node
// capability on the Node the obligation names) or "builtin:create_session". Optional marks a
// check whose denial only omits part of a result.
internal sealed record ObligationTemplate(
    string Id,
    ObligationKind Kind,
    string Capability,
    string Description,
    string? When = null,
    bool Optional = false
);

// The branch of a capability selected by its normalized action (null: any action) and an
// optional condition. Self names the owner check of a branch that acts only on the caller's own
// turn, context, runs, transfers or history images; it is not authorizable from phase 3 and is
// assessed as today until then.
internal sealed record ActionBranch(
    string Name,
    string? Action,
    IReadOnlyList<OperationTemplate> Operations,
    string? When = null,
    string? Self = null
);

internal enum ActionNormalization
{
    // The handler reads its action exactly.
    Exact,

    // string.Trim() then lowercase (node, skill).
    TrimLower,

    // SessionGoal.Trim() then lowercase (session).
    SessionTrimLower,
}

internal sealed record OperationDeclaration(
    string Source,
    string Name,
    IReadOnlyList<ActionBranch> Branches,
    IReadOnlyList<ObligationTemplate> Obligations,
    IReadOnlyList<string> Subsumed
)
{
    // Matches every name with this prefix (browser tools come from the host bundle).
    internal bool Prefix { get; init; }

    // Matches every identity of the source that has no exact declaration (MCP tools and custom
    // Node tools).
    internal bool Opaque { get; init; }

    // A front end such as ctl: it resolves to its target capability and is never authorized.
    internal string? FrontEnd { get; init; }

    internal ActionNormalization Normalize { get; init; } = ActionNormalization.Exact;

    // The action a handler applies when the call gives none.
    internal string? DefaultAction { get; init; }

    internal bool HasActions => Branches.Any(branch => branch.Action is not null);

    internal string Capability =>
        Opaque ? Source + ":*"
        : Prefix ? Source + ":" + Name + "*"
        : Source + ":" + Name;
}

// An authorization call site outside the dispatch gate and the obligations it checks. Member is
// the enclosing method; Ordinal counts the authorization calls of that member in source order.
internal sealed record ObligationSite(
    string File,
    string Member,
    int Ordinal,
    string Call,
    IReadOnlyList<(string Capability, string Obligation)> Obligations
);

internal static partial class OperationDeclarations
{
    internal static readonly IReadOnlyList<OperationSpec> Operations =
    [
        new("env.read", ["node", "path"], []),
        new("env.write", ["node", "path"], []),
        new("env.exec", ["node", "path"], []),
        new("env.browser", ["node"], []),
        new("env.tool", ["node", "nodeTool"], []),
        new("node.list", [], []),
        new("node.view", ["node"], []),
        new("node.select", ["node"], []),
        new("node.lifecycle", ["node"], ["action"]),
        new("node.trust", ["node"], ["action"]),
        new("session.list", [], ["scope"]),
        new("session.view", ["targetSession"], []),
        new("session.send", ["targetSession"], []),
        new("session.deliver", ["targetSession"], []),
        new(
            "session.create",
            ["targetAgent", "node", "parent", "targetSession"],
            ["kind", "placement", "runtime", "fork"]
        ),
        new("session.control", ["targetSession"], ["change"]),
        new("session.manage", ["targetSession", "parent", "targetAgent"], ["change"]),
        new("history.read", ["targetSession"], ["mode"]),
        new("history.search", ["targetAgent"], []),
        new("agent.list", [], []),
        new("agent.view", ["targetAgent"], []),
        new("agent.create", ["targetAgent"], []),
        new("agent.manage", ["targetAgent"], ["change"]),
        new("task.create", [], ["assigned"]),
        new("task.list", [], ["scope"]),
        new("task.read", ["task"], []),
        new("task.update", ["task"], []),
        new("task.complete", ["task"], []),
        new("task.cancel", ["task"], []),
        new("task.assign", ["task", "targetSession"], []),
        new("timer.manage", ["targetSession"], ["change", "kind"]),
        new("channel.send", ["channel"], []),
        new("user.ask", [], ["secret"]),
        new("config.read", [], ["target"]),
        new("config.write", [], ["target"]),
        new("secret.use", ["secret"], []),
        new("secret.manage", ["secret"], []),
        new("secret.list", [], []),
        new("mcp.call", ["mcp"], []),
        new("mcp.list", [], []),
        new("mcp.manage", ["mcp"], []),
        new("mcp.subscribe", ["mcp"], ["action"]),
        new("image.generate", ["model"], []),
        new("model.request", ["model"], []),
    ];

    internal static OperationSpec? Spec(string op) =>
        Operations.FirstOrDefault(spec => spec.Op == op);

    // The declaration of a capability identity: exact, then prefix, then the opaque declaration
    // of its source (MCP tools and custom Node tools).
    internal static OperationDeclaration? Find(string source, string name) =>
        Capabilities.FirstOrDefault(declaration =>
            !declaration.Opaque
            && !declaration.Prefix
            && declaration.Source == source
            && declaration.Name == name
        )
        ?? Capabilities.FirstOrDefault(declaration =>
            declaration.Prefix
            && declaration.Source == source
            && name.StartsWith(declaration.Name, StringComparison.Ordinal)
        )
        ?? Capabilities.FirstOrDefault(declaration =>
            declaration.Opaque && declaration.Source == source
        );

    // Template builders. Resource and attribute parts are "selector=expression"; an attribute is
    // written "with.name=expression".
    private static OperationTemplate Op(string op, params string[] parts) =>
        Template(op, null, null, parts);

    private static OperationTemplate OpIf(string when, string op, params string[] parts) =>
        Template(op, null, when, parts);

    private static OperationTemplate OpEach(string each, string op, params string[] parts) =>
        Template(op, each, null, parts);

    private static OperationTemplate OpEachIf(
        string when,
        string each,
        string op,
        params string[] parts
    ) => Template(op, each, when, parts);

    private static OperationTemplate Template(
        string op,
        string? each,
        string? when,
        string[] parts
    )
    {
        var resources = new Dictionary<string, string>(StringComparer.Ordinal);
        var with = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in parts)
        {
            var split = part.IndexOf('=');
            var key = part[..split];
            if (key.StartsWith("with.", StringComparison.Ordinal))
                with[key[5..]] = part[(split + 1)..];
            else
                resources[key] = part[(split + 1)..];
        }
        return new(op, resources, with, each, when);
    }

    private static ActionBranch Branch(
        string name,
        string? action,
        params OperationTemplate[] operations
    ) => new(name, action, operations);

    private static ActionBranch Call(params OperationTemplate[] operations) =>
        new("call", null, operations);

    private static ActionBranch SelfBranch(string name, string? action, string reason) =>
        new(name, action, [], Self: reason);

    private static ObligationTemplate Primary(string description = "the call's own request") =>
        new("primary", ObligationKind.Primary, "same", description);

    private static ObligationTemplate Sub(
        string id,
        string capability,
        string description,
        string? when = null,
        bool optional = false
    ) => new(id, ObligationKind.SubRequest, capability, description, when, optional);

    private static ObligationTemplate Probe(
        string id,
        string capability,
        string description,
        string? when = null
    ) => new(id, ObligationKind.Probe, capability, description, when);

    private static ObligationTemplate Retained(
        string id,
        string capability,
        string description,
        string? when = null
    ) => new(id, ObligationKind.Retained, capability, description, when);

    private static ObligationTemplate Nested(string description) =>
        new("nested", ObligationKind.Nested, "*", description);

    private static OperationDeclaration Declare(
        string id,
        ActionBranch[] branches,
        ObligationTemplate[] obligations,
        params string[] subsumed
    )
    {
        var colon = id.IndexOf(':');
        return new(id[..colon], id[(colon + 1)..], branches, obligations, subsumed);
    }
}
