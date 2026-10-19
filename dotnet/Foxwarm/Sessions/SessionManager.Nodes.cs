using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal string? BoundNode(string agent) =>
        AgentIsolated(agent) ? RecordedIsolationNode(agent) : null;

    internal (string Node, string? Cwd) ExecutionPlacement(SessionOwner owner) =>
        owner.Entry.WithState(state =>
            (
                ResolveExecutionNode(state.AuthorityEnvelope, BoundNode(owner.Agent)),
                SessionWait.Text(state.AuthorityEnvelope["cwd"])
            )
        );

    internal static string ResolveExecutionNode(JsonObject authority, string? boundNode = null)
    {
        var node = SessionGoal.Trim(SessionWait.Text(authority["currentNode"]) ?? "");
        return node.Length > 0 ? node : boundNode ?? "master";
    }

    internal string CurrentNode(SessionOwner owner) => ExecutionPlacement(owner).Node;

    internal string ExecutionEnvironment(SessionOwner owner, SessionSnapshot? snapshot = null)
    {
        var placement = snapshot is null
            ? ExecutionPlacement(owner)
            : (
                Node: ResolveExecutionNode(snapshot.AuthorityEnvelope, BoundNode(owner.Agent)),
                Cwd: SessionWait.Text(snapshot.AuthorityEnvelope["cwd"])
            );
        return $"--- EXECUTION ENVIRONMENT ---\n- Current Node: {placement.Node}\n- Connected: {NodeProviders.Connected(placement.Node).ToString().ToLowerInvariant()}\n- Working directory: {placement.Cwd ?? "not set; use the Node's default directory"}\n- Agent memory and Session history remain on Main. The agent_folder above is this Agent's directory on Main, not its directory on another Node.";
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
        foreach (var node in NodeProviders.Snapshot())
            nodes.Add(node?.DeepClone());
        return nodes;
    }

    internal async Task<JsonArray> NodeSummariesAsync(
        bool hasPty = false,
        CancellationToken token = default
    )
    {
        await NodeProviders.ListAsync(token);
        return NodeSummaries(hasPty);
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
        CancellationToken token = default,
        bool clearCwd = true
    )
    {
        await WaitForIdentityMutationAsync(owner.Id, token);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Session owner changed before Node selection.");
        id = id.Trim();
        if (id != "master")
            Foxwarm.Nodes.NodeProviderRegistry.ValidateId(id);
        RequireNodeBoundary(owner, id);
        await NodeProviders.RefreshAsync(id, token);
        if (!NodeProviders.Online(id))
            throw new InvalidOperationException("Node is offline or incompatible: " + id);
        token.ThrowIfCancellationRequested();
        var defaultCwd =
            id == "master"
                ? agents.AgentDirectory(owner.Agent)
                : NodeProviders.DefaultCwd(id) ?? "unknown";
        if (
            id != "master"
            && !NodeProviders.IsProviderNode(id)
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
        if (!NodeProviders.Online(id))
            throw new InvalidOperationException("Node disconnected before selection: " + id);
        token.ThrowIfCancellationRequested();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Session owner changed before Node selection.");
        RequireNodeBoundary(owner, id);
        await owner.Entry.SaveLane.CommitNodeAsync(id, clearCwd);
        return new JsonObject
        {
            ["output"] =
                $"Current node changed to `{id}`. {(clearCwd ? "Session cwd cleared." : "Session cwd retained.")} Node default cwd: `{defaultCwd}`.",
            ["nodeId"] = id,
            ["defaultCwd"] = defaultCwd,
        };
    }

    internal JsonObject RemoveNode(JsonObject args)
    {
        ToolRegistry.Keys(args, ["nodeId"]);
        var id = ToolRegistry.Text(args, "nodeId")?.Trim();
        if (string.IsNullOrEmpty(id))
            throw new InvalidDataException("nodeId is required.");
        return new JsonObject { ["nodeId"] = id, ["disconnected"] = Nodes.Remove(id) };
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
            var values = await NodeSummariesAsync(token: token);
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
                (await NodeSummariesAsync(token: token))
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

    internal async Task RequireAgentNodeAsync(string node)
    {
        if (node == "master")
            throw new InvalidDataException("Use null to remove a Node binding.");
        Foxwarm.Nodes.NodeProviderRegistry.ValidateId(node);
        if (await NodeProviders.ResolveAsync(node, default) is null)
            throw new InvalidDataException("Node not found.");
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
            await RequireAgentNodeAsync(node);
        await agents.SetIsolationAsync(agent, node, updateNode, rules);
        if (updateNode && node is not null)
            foreach (
                var row in Catalog.List().Where(row => SessionWait.Text(row["agent"]) == agent)
            )
            {
                var owner = await RequiredAsync(row["id"]!.GetValue<string>());
                await owner.Entry.SaveLane.CommitNodeAsync(node, clearCwd: false);
            }
        if (updateNode && node is null)
            foreach (var owner in sessions.Values.Where(owner => owner.Agent == agent))
                CaptureLocalProjection(owner);
        TopologyChanged?.Invoke();
    }
}
