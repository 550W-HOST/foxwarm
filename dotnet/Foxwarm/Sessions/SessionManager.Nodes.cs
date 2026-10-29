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

    internal Task<JsonObject> UpdateProviderExecCwdAsync(
        SessionOwner owner,
        string node,
        string cwd
    ) =>
        owner.UpdateCwdAsync(
            cwd,
            preserveWhitespace: true,
            condition: () => IsCurrentOwner(owner) && CurrentNode(owner) == node
        );

    internal string CurrentNode(SessionOwner owner) => ExecutionPlacement(owner).Node;

    internal JsonArray NodeSummaries(bool hasPty = false)
    {
        var nodes = Nodes.List();
        foreach (var value in nodes.OfType<JsonObject>())
            value["online"] = value["connected"]!.DeepClone();
        nodes.Insert(0, Foxwarm.Nodes.NodeProviderRegistry.MasterSummary(hasPty));
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

    private void RequireNodeCreationParent(SessionOwner caller, string? parent)
    {
        caller.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(caller))
            throw new InvalidOperationException("Node admission requires the current Session owner.");
        if (parent is null && agents.CreatedBy(caller.Agent) is not null)
            throw new ToolAuthorizationDeniedException("Callers in a delegated Agent must create Nodes with an authorization parent.");
    }

    internal async Task<JsonObject> RemoveNodeAsync(SessionOwner owner, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["nodeId", "cascade"]);
        var id = ToolRegistry.Text(args, "nodeId")?.Trim();
        if (string.IsNullOrEmpty(id))
            throw new InvalidDataException("nodeId is required.");
        if (args.ContainsKey("cascade") && (args["cascade"] is not JsonValue flag || !flag.TryGetValue<bool>(out _)))
            throw new InvalidDataException("cascade must be a boolean.");
        var cascade = args["cascade"]?.GetValue<bool>() ?? false;
        using var mutation = await Nodes.Registry.BeginMutationAsync(token);
        var subtree = Nodes.Registry.Forest().Subtree(id);
        if (!cascade && subtree.Count > 1)
            throw new InvalidDataException("Node has descendants; cascade is required.");
        if (subtree.Any(node => node == "master" || node.Contains('/')))
            throw new InvalidDataException("Native credential cascade cannot contain executable-provider Nodes.");
        foreach (var member in subtree)
        {
            var removal = (JsonObject)args.DeepClone();
            removal["nodeId"] = member;
            await AuthorizeToolAsync(owner, new("node_remove", "builtin", "node_remove", removal), null, token);
        }
        token.ThrowIfCancellationRequested();
        var disconnected = Nodes.RemoveNodes(subtree, mutation);
        var result = new JsonObject { ["nodeId"] = id, ["disconnected"] = disconnected.Contains(id, StringComparer.Ordinal) };
        if (cascade)
        {
            result["removedNodes"] = new JsonArray(subtree.Select(node => (JsonNode?)JsonValue.Create(node)).ToArray());
            result["disconnectedNodes"] = new JsonArray(disconnected.Select(node => (JsonNode?)JsonValue.Create(node)).ToArray());
        }
        return result;
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

    internal async Task<JsonObject> NodePairApproveAsync(JsonObject args, SessionOwner? caller = null)
    {
        ToolRegistry.Keys(args, ["pendingId", "nodeId"]);
        void RequireCaller()
        {
            if (caller is null)
                return;
            caller.Entry.RequireIdentityAuthority();
            if (!IsCurrentOwner(caller))
                throw new InvalidOperationException("Pairing approval requires the current Session owner.");
            if (agents.CreatedBy(caller.Agent) is not null)
                throw new ToolAuthorizationDeniedException("Callers in a delegated Agent must use node_create_auth_token with parentNode instead of root pairing approval.");
        }
        RequireCaller();
        var result = await Nodes.ApproveAsync(
            ToolRegistry.Text(args, "pendingId")
                ?? throw new InvalidDataException("pendingId is required."),
            ToolRegistry.Text(args, "nodeId"),
            RequireCaller
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
