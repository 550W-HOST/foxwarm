using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal string? BoundNode(string agent) =>
        AgentIsolated(agent) ? RecordedIsolationNode(agent) : null;

    internal (string Node, string? Cwd) ExecutionPlacement(SessionOwner owner) =>
        owner.Entry.WithState(state =>
        {
            var node = SessionGoal.Trim(
                SessionWait.Text(state.AuthorityEnvelope["currentNode"]) ?? ""
            );
            return (
                node.Length > 0 ? node : BoundNode(owner.Agent) ?? "master",
                SessionWait.Text(state.AuthorityEnvelope["cwd"])
            );
        });

    internal string CurrentNode(SessionOwner owner) => ExecutionPlacement(owner).Node;

    internal string ExecutionEnvironment(SessionOwner owner)
    {
        var placement = ExecutionPlacement(owner);
        return $"--- EXECUTION ENVIRONMENT ---\n- Current Node: {placement.Node}\n- Connected: {Nodes.Connected(placement.Node).ToString().ToLowerInvariant()}\n- Working directory: {placement.Cwd ?? "not set; use the Node's default directory"}\n- Agent memory and Session history remain on Main. The agent_folder above is this Agent's directory on Main, not its directory on another Node.";
    }

    internal JsonArray NodeSummaries(bool hasPty = false)
    {
        var nodes = Nodes.List();
        foreach (var value in nodes.OfType<JsonObject>())
            value["online"] = value["connected"]!.DeepClone();
        nodes.Insert(
            0,
            new JsonObject
            {
                ["id"] = "master",
                ["nodeId"] = "master",
                ["type"] = "master",
                ["displayName"] = "master",
                ["online"] = true,
                ["connected"] = true,
                ["executable"] = true,
                ["services"] = hasPty
                    ? new JsonObject
                    {
                        ["vscode-fs"] = 1,
                        ["vscode-git"] = 2,
                        ["vscode-pty"] = 1,
                    }
                    : new JsonObject { ["vscode-fs"] = 1, ["vscode-git"] = 2 },
            }
        );
        return nodes;
    }

    internal void RequireNodeBoundary(SessionOwner owner, string node)
    {
        var isolation = Isolation(owner.Agent);
        if (isolation.Isolated && node != (isolation.RecordedNode ?? "master"))
            throw new ToolAuthorizationDeniedException(
                "Isolated Agent can only execute tools on its bound Node."
            );
    }

    internal async Task<JsonObject> SelectNodeAsync(
        SessionOwner owner,
        string id,
        CancellationToken token = default
    )
    {
        id = id.Trim();
        if (id != "master")
            Foxwarm.Nodes.ApprovedNodeRegistry.ValidateId(id);
        RequireNodeBoundary(owner, id);
        if (!Nodes.Online(id))
            throw new InvalidOperationException("Node is offline or incompatible: " + id);
        token.ThrowIfCancellationRequested();
        var defaultCwd = id == "master" ? agents.AgentDirectory(owner.Agent) : Nodes.ShellDefaultCwd(id) ?? "unknown";
        if (
            id != "master"
            && Nodes
                .Definitions(id)
                .Any(value => SessionWait.Text(value?["name"]) == "get_default_cwd")
        )
        {
            try
            {
                var args = new JsonObject();
                await AuthorizeToolAsync(
                    owner,
                    new("node", "node", "get_default_cwd", args, ExecutionNode: id),
                    null,
                    token
                );
                var value = await Nodes.ExecuteAsync(
                    id,
                    "get_default_cwd",
                    args,
                    owner.Id,
                    owner.Agent,
                    CurrentNode(owner),
                    null,
                    false,
                    token
                );
                var cwd =
                    SessionWait.Text(value) ?? SessionWait.Text((value as JsonObject)?["output"]);
                defaultCwd = string.IsNullOrWhiteSpace(cwd) ? "unknown" : cwd.Trim();
            }
            catch (Exception error)
                when (error
                        is IOException
                            or InvalidOperationException
                            or NotSupportedException
                            or ToolAuthorizationDeniedException
                    || error is OperationCanceledException && !token.IsCancellationRequested
                ) { }
        }
        if (!Nodes.Online(id))
            throw new InvalidOperationException("Node disconnected before selection: " + id);
        token.ThrowIfCancellationRequested();
        await owner.Entry.SaveLane.CommitNodeAsync(id);
        return new JsonObject
        {
            ["output"] =
                $"Current node changed to `{id}`. Session cwd cleared. Node default cwd: `{defaultCwd}`.",
            ["nodeId"] = id,
            ["defaultCwd"] = defaultCwd,
        };
    }

    internal async Task<JsonObject> ExecuteNodeToolAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        var action = ToolRegistry.Text(args, "action")?.Trim().ToLowerInvariant();
        if (action == "list")
        {
            ToolRegistry.Keys(args, ["action"]);
            var values = NodeSummaries();
            if (AgentIsolated(owner.Agent))
                values = new JsonArray(
                    values
                        .Where(value =>
                            SessionWait.Text(value?["id"])
                            == (RecordedIsolationNode(owner.Agent) ?? "master")
                        )
                        .Select(value => value?.DeepClone())
                        .ToArray()
                );
            return new JsonObject
            {
                ["output"] =
                    $"Current node: `{CurrentNode(owner)}`.\n"
                    + string.Join(
                        '\n',
                        values
                            .OfType<JsonObject>()
                            .Select(value =>
                                $"- `{value["id"]!.GetValue<string>()}` ({value["type"]!.GetValue<string>()}) — {(value["executable"]!.GetValue<bool>() ? "ready" : value["online"]!.GetValue<bool>() ? "upgrade required" : "offline")}"
                            )
                    ),
            };
        }
        ToolRegistry.Keys(args, ["action", "nodeId"]);
        var id = (
            ToolRegistry.Text(args, "nodeId")
            ?? throw new InvalidDataException("nodeId is required.")
        ).Trim();
        if (action == "select")
        {
            if (AgentIsolated(owner.Agent))
                throw new ToolAuthorizationDeniedException(
                    "Isolated sessions cannot switch Node through model tools. Use the administrator Node command."
                );
            return await SelectNodeAsync(owner, id, token);
        }
        if (action == "inspect")
        {
            RequireNodeBoundary(owner, id);
            var value =
                NodeSummaries()
                    .OfType<JsonObject>()
                    .FirstOrDefault(value => SessionWait.Text(value["id"]) == id)
                ?? throw new InvalidDataException("Node not found.");
            return new JsonObject { ["output"] = value.ToJsonString() };
        }
        throw new InvalidDataException("node action must be list, select or inspect.");
    }

    internal JsonObject NodeBootstrapInfo(JsonObject args)
    {
        ToolRegistry.Keys(args, []);
        return new()
        {
            ["output"] = (
                Bootstrap
                ?? throw new InvalidOperationException(
                    "Node bootstrap is unavailable on this host."
                )
            )
                .Info()
                .ToJsonString(),
        };
    }

    internal JsonObject NodePairList(JsonObject args)
    {
        ToolRegistry.Keys(args, []);
        return new()
        {
            ["output"] = new JsonArray(
                Nodes
                    .ListPending()
                    .Where(value => value?["approvedNodeId"] is null)
                    .Select(value => value?.DeepClone())
                    .ToArray()
            ).ToJsonString(),
        };
    }

    internal async Task<JsonObject> NodePairApproveAsync(JsonObject args)
    {
        ToolRegistry.Keys(args, ["pendingId", "nodeId"]);
        var result = await Nodes.ApproveAsync(
            ToolRegistry.Text(args, "pendingId")
                ?? throw new InvalidDataException("pendingId is required."),
            ToolRegistry.Text(args, "nodeId")
        );
        return new() { ["output"] = result.ToJsonString() };
    }

    internal void RequireApprovedAgentNode(string node)
    {
        if (node == "master")
            throw new InvalidDataException("Use null to remove a Node binding.");
        Foxwarm.Nodes.ApprovedNodeRegistry.ValidateId(node);
        if (!Nodes.List().Any(value => SessionWait.Text(value?["id"]) == node))
            throw new InvalidDataException("Approved Node not found.");
    }

    internal Task SetAgentNodeAsync(string agent, string? node) =>
        SetAgentIsolationAsync(agent, node, true, null);

    internal async Task SetAgentIsolationAsync(
        string agent,
        string? node,
        bool updateNode,
        JsonArray? rules
    )
    {
        if (!agents.Exists(agent))
            throw new InvalidDataException("Agent not found.");
        node = string.IsNullOrWhiteSpace(node) ? null : node.Trim();
        if (updateNode && node is not null)
            RequireApprovedAgentNode(node);
        await agents.SetIsolationAsync(agent, node, updateNode, rules);
        if (updateNode && node is not null)
            foreach (
                var row in Catalog.List().Where(row => SessionWait.Text(row["agent"]) == agent)
            )
            {
                var owner = await RequiredAsync(row["id"]!.GetValue<string>());
                await owner.Entry.SaveLane.CommitNodeAsync(node, clearCwd: false);
            }
        TopologyChanged?.Invoke();
    }
}
