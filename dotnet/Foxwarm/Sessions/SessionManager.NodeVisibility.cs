using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Node list visibility is a presentation projection of tool authorization. A listed Node may
// still reject a call, and a hidden Node is hidden only because no work probe could pass; every
// actual use still runs the strict per-call authorization.
internal sealed partial class SessionManager
{
    private static readonly string[] CanonicalNodeTools = ["read", "write", "edit", "exec"];

    private static readonly string[] TransferTools =
    [
        "copy_between_nodes",
        "send_file",
        "image_write_to_file",
    ];

    private static readonly IReadOnlySet<string> NodeTargetArgs = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "action",
        "nodeId",
        "providerId",
    };

    private static readonly IReadOnlySet<string> NodeDestroyArgs = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "action",
        "nodeId",
        "providerId",
        "confirmation",
    };

    // One caller's facts and one policy snapshot shared by every visibility probe of a request.
    internal sealed class ToolVisibilityContext
    {
        private readonly SessionManager manager;
        private ToolAuthorizationPolicy[]? policies;
        private NodeAuthorizationForest? forest;

        internal ToolVisibilityContext(
            SessionManager manager,
            string agent,
            string session,
            string currentNode,
            bool externalRuntime
        )
        {
            this.manager = manager;
            Agent = agent;
            Session = session;
            CurrentNode = currentNode;
            ExternalRuntime = externalRuntime;
            try
            {
                Layers = manager.agents.RuleLayers(agent);
            }
            catch (InvalidDataException)
            {
                // Unreadable rule metadata makes nothing visible.
                Layers = null;
            }
        }

        internal string Agent { get; }
        internal string Session { get; }
        internal string CurrentNode { get; }
        internal bool ExternalRuntime { get; }

        // Null when the Agent's rule chain is invalid: nothing is visible then.
        internal ToolAuthorizationPolicy[]? Layers { get; }

        // The global policy is read on first use; an unavailable policy propagates.
        internal ToolAuthorizationPolicy[] Policies =>
            policies ??= [manager.authorization.Load(), .. Layers ?? []];

        internal NodeAuthorizationForest Forest => forest ??= manager.Nodes.Registry.Forest();
    }

    internal sealed record NodeVisibility(
        IReadOnlyList<string> Tools,
        bool Transfer,
        bool Select,
        bool Inspect,
        bool Destroy
    )
    {
        // Work capabilities admit a Node to a list; select and management are annotations only.
        internal bool Usable => Tools.Count > 0 || Transfer;
    }

    internal ToolVisibilityContext VisibilityFor(SessionOwner owner) =>
        new(
            this,
            owner.Agent,
            owner.Id,
            CurrentNode(owner),
            owner.Entry.WithState(state => ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope))
        );

    // Main-owned presentation routes use catalog facts and never hydrate the Session.
    internal ToolVisibilityContext? CatalogVisibility(string id, JsonObject row)
    {
        var agent = SessionCatalog.Text(row["agent"]);
        if (string.IsNullOrEmpty(agent) || !agents.Exists(agent))
            return null;
        var current = SessionCatalog.Text(row["currentNode"]) is { Length: > 0 } node
            ? node
            : "master";
        return new(this, agent, id, current, externalRuntime: false);
    }

    internal bool ToolVisible(
        ToolVisibilityContext context,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false,
        string? node = null
    )
    {
        if (context.ExternalRuntime && !ClaudeRuntimeToolSupport.Visible(source, name))
            return false;
        if (context.Layers is null)
            return false;
        if (name == "call_tool" && source == "builtin")
            return true;
        if (
            source == "builtin"
            && name
                is "artifact"
                    or "run_script"
                    or "start_toolscript_run"
                    or "send_file"
                    or "image_write_to_file"
        )
            unknownNode = true;
        var targetNode =
            node
            ?? (
                source == "node"
                || source == "builtin" && name is "send_file" or "image_write_to_file"
                    ? context.CurrentNode
                    : "master"
            );
        var unknownNodeTargets =
            source == "builtin"
            && name
                is "send_file"
                    or "image_write_to_file"
                    or "copy_between_nodes"
                    or "node"
                    or "node_create_auth_token"
                    or "node_remove";
        var args = new JsonObject();
        var targets =
            source == "builtin" && name == "node"
                ? NodeProviders.AuthorizationTargets(args)
                : ToolAuthorizationNodeEffects.Resolve(source, name, targetNode, args);
        return VisibleRequest(
            context,
            source,
            name,
            server,
            args,
            targetNode,
            targets,
            unknownNode,
            unknownNodeTargets,
            null
        );
    }

    /// <summary>
    /// Whether broad MCP discovery should list this server for the caller: false only when
    /// some effective policy layer denies every tool of the server regardless of name and
    /// arguments. Listing a server starts its connection, so a definitely denied server is
    /// skipped; an explicitly named server is still listed as requested.
    /// </summary>
    internal bool McpServerVisible(ToolVisibilityContext context, string server)
    {
        if (context.Layers is null)
            return false;
        try
        {
            var request = new ToolAuthorizationRequest(
                "mcp",
                "",
                server,
                new JsonObject(),
                [],
                context.Agent,
                context.Session,
                "master",
                toolWorkspace,
                agents.AgentDirectory(context.Agent),
                agents.MemoryDirectory(context.Agent),
                CurrentNode: context.CurrentNode
            );
            return context.Policies.All(policy =>
                ToolAuthorizationEvaluation.Visible(policy, request, unknownName: true)
            );
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private bool VisibleRequest(
        ToolVisibilityContext context,
        string source,
        string name,
        string? server,
        JsonObject args,
        string targetNode,
        IReadOnlyList<string>? targets,
        bool unknownNode,
        bool unknownNodeTargets,
        IReadOnlySet<string>? knownArgs
    )
    {
        if (context.Layers is null)
            return false;
        try
        {
            var request = new ToolAuthorizationRequest(
                source,
                name,
                server,
                args,
                [],
                context.Agent,
                context.Session,
                targetNode,
                toolWorkspace,
                agents.AgentDirectory(context.Agent),
                agents.MemoryDirectory(context.Agent),
                NodeTargets: targets,
                CurrentNode: context.CurrentNode,
                NodeForest: targets is { Count: > 0 } ? context.Forest : null
            );
            return context.Policies.All(policy =>
                ToolAuthorizationEvaluation.Visible(
                    policy,
                    request,
                    unknownNode,
                    unknownNodeTargets,
                    knownArgs
                )
            );
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    // A builtin `node` action whose stated arguments are known; omitted ones remain unresolved.
    private bool NodeActionVisible(
        ToolVisibilityContext context,
        JsonObject args,
        IReadOnlyList<string>? targets,
        IReadOnlySet<string> knownArgs
    )
    {
        if (context.ExternalRuntime && !ClaudeRuntimeToolSupport.Visible("builtin", "node"))
            return false;
        return VisibleRequest(
            context,
            "builtin",
            "node",
            null,
            args,
            SessionWait.Text(args["nodeId"]) ?? "master",
            targets,
            unknownNode: false,
            unknownNodeTargets: false,
            knownArgs
        );
    }

    internal NodeVisibility ProbeNode(
        ToolVisibilityContext context,
        string id,
        IEnumerable<string> advertised,
        bool providerDestroy
    )
    {
        // Offline Nodes advertise nothing; probe the canonical capabilities they would serve.
        var names = advertised.Distinct(StringComparer.Ordinal).ToArray();
        if (names.Length == 0)
            names = CanonicalNodeTools;
        var tools = names.Where(name => ToolVisible(context, "node", name, node: id)).ToArray();
        // The other copy endpoint is the caller's choice, so only this Node's facts can hide it.
        var transfer = TransferTools.Any(name =>
                (!context.ExternalRuntime || ClaudeRuntimeToolSupport.Visible("builtin", name))
                && VisibleRequest(
                    context,
                    "builtin",
                    name,
                    null,
                    new JsonObject(),
                    name == "copy_between_nodes" ? "master" : id,
                    [id],
                    unknownNode: name == "copy_between_nodes",
                    unknownNodeTargets: false,
                    null
                )
            );
        var select = NodeActionVisible(
                context,
                new JsonObject { ["action"] = "select", ["nodeId"] = id },
                [id],
                NodeTargetArgs
            );
        var inspect = NodeActionVisible(
                context,
                new JsonObject { ["action"] = "inspect", ["nodeId"] = id },
                [id],
                NodeTargetArgs
            );
        var destroy =
            providerDestroy
            && NodeActionVisible(
                context,
                new JsonObject
                {
                    ["action"] = "destroy",
                    ["nodeId"] = id,
                    ["confirmation"] = "destroy node " + id,
                },
                [id],
                NodeDestroyArgs
            );
        return new(tools, transfer, select, inspect, destroy);
    }

    // Whether the caller might do any work on this Node, for administrator hints.
    internal bool NodeUsable(ToolVisibilityContext context, string id) =>
        ProbeNode(
            context,
            id,
            (id == "master" ? tools.NodeDefinitions(id) : NodeProviders.Definitions(id))
                .OfType<JsonObject>()
                .Take(200)
                .Select(definition => SessionWait.Text(definition["name"]))
                .OfType<string>(),
            providerDestroy: false
        ).Usable;

    // Lifecycle actions of one Provider the caller might be allowed to use, in declared order.
    internal JsonArray VisibleProviderActions(
        ToolVisibilityContext context,
        string providerId,
        JsonArray declared,
        bool anyNodeDestroy
    )
    {
        var parent = NodeProviders.ProviderParent(providerId);
        IReadOnlyList<string>? parentTargets = parent is null ? null : [parent];
        var delegated = agents.CreatedBy(context.Agent) is not null;
        var result = new JsonArray();
        foreach (var action in declared.Select(SessionWait.Text).OfType<string>())
        {
            var visible = action switch
            {
                "inspect" => NodeActionVisible(
                    context,
                    new JsonObject { ["action"] = "inspect", ["providerId"] = providerId },
                    null,
                    NodeTargetArgs
                ),
                "create" => !(delegated && parent is null)
                    && NodeActionVisible(
                        context,
                        new JsonObject { ["action"] = "create", ["providerId"] = providerId },
                        parentTargets,
                        new HashSet<string>(StringComparer.Ordinal) { "action", "providerId" }
                    ),
                "ensure" => NodeActionVisible(
                        context,
                        new JsonObject { ["action"] = "ensure", ["providerId"] = providerId },
                        parentTargets,
                        new HashSet<string>(StringComparer.Ordinal) { "action", "providerId" }
                    ),
                "destroy" => anyNodeDestroy,
                _ => false,
            };
            if (visible)
                result.Add((JsonNode?)action);
        }
        return result;
    }
}
