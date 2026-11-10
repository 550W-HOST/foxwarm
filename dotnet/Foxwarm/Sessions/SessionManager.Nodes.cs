using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal (string Node, string? Cwd) ExecutionPlacement(SessionOwner owner) =>
        owner.Entry.WithState(state =>
            (
                ResolveExecutionNode(state.AuthorityEnvelope),
                SessionWait.Text(state.AuthorityEnvelope["cwd"])
            )
        );

    internal static string ResolveExecutionNode(JsonObject authority)
    {
        var node = SessionGoal.Trim(SessionWait.Text(authority["currentNode"]) ?? "");
        return node.Length > 0 ? node : "master";
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
            throw new InvalidOperationException(
                "Node admission requires the current Session owner."
            );
        if (parent is null && agents.CreatedBy(caller.Agent) is not null)
            throw new ToolAuthorizationDeniedException(
                "Callers in a delegated Agent must create Nodes with an authorization parent."
            );
    }

    internal async Task<JsonObject> RemoveNodeAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["nodeId", "cascade"]);
        var id = ToolRegistry.Text(args, "nodeId")?.Trim();
        if (string.IsNullOrEmpty(id))
            throw new InvalidDataException("nodeId is required.");
        if (
            args.ContainsKey("cascade")
            && (args["cascade"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))
        )
            throw new InvalidDataException("cascade must be a boolean.");
        var cascade = args["cascade"]?.GetValue<bool>() ?? false;
        using var mutation = await Nodes.Registry.BeginMutationAsync(token);
        var subtree = Nodes.Registry.Forest().Subtree(id);
        if (!cascade && subtree.Count > 1)
            throw new InvalidDataException("Node has descendants; cascade is required.");
        if (subtree.Any(node => node == "master" || node.Contains('/')))
            throw new InvalidDataException(
                "Native credential cascade cannot contain executable-provider Nodes."
            );
        foreach (var member in subtree)
        {
            var removal = (JsonObject)args.DeepClone();
            removal["nodeId"] = member;
            await AuthorizeToolAsync(
                owner,
                new("node_remove", "builtin", "node_remove", removal),
                null,
                token
            );
        }
        token.ThrowIfCancellationRequested();
        var disconnected = Nodes.RemoveNodes(subtree, mutation);
        var result = new JsonObject
        {
            ["nodeId"] = id,
            ["disconnected"] = disconnected.Contains(id, StringComparer.Ordinal),
        };
        if (cascade)
        {
            result["removedNodes"] = new JsonArray(
                subtree.Select(node => (JsonNode?)JsonValue.Create(node)).ToArray()
            );
            result["disconnectedNodes"] = new JsonArray(
                disconnected.Select(node => (JsonNode?)JsonValue.Create(node)).ToArray()
            );
        }
        return result;
    }

    // The pairing token is written to a new owner-only file on master; the model sees
    // the instructions with PAIRING_TOKEN in its place.
    internal async Task<JsonObject> NodeBootstrapInfoAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["filePath"]);
        var bootstrap =
            Bootstrap
            ?? throw new InvalidOperationException("Node bootstrap is unavailable on this host.");
        var path = WorkspaceTools.PrivateNodeTokenPath(
            ToolRegistry.Text(args, "filePath") ?? "",
            "node_bootstrap_info"
        );
        var info = bootstrap.Info();
        var pairing = SessionWait.Text(info["pairingToken"]) ?? "";
        info.Remove("pairingToken");
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous,
        };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        await using (var file = new FileStream(path, options))
        {
            await file.WriteAsync(System.Text.Encoding.UTF8.GetBytes(pairing + "\n"), token);
            await file.FlushAsync(token);
        }
        var text = info.ToJsonString();
        if (pairing.Length > 0)
            text = text.Replace(pairing, "PAIRING_TOKEN", StringComparison.Ordinal);
        var result = JsonNode.Parse(text)!.AsObject();
        result["pairingTokenFile"] = path;
        return new() { ["output"] = result.ToJsonString() };
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

    internal async Task<JsonObject> NodePairApproveAsync(
        JsonObject args,
        SessionOwner? caller = null
    )
    {
        ToolRegistry.Keys(args, ["pendingId", "nodeId"]);
        void RequireCaller()
        {
            if (caller is null)
                return;
            caller.Entry.RequireIdentityAuthority();
            if (!IsCurrentOwner(caller))
                throw new InvalidOperationException(
                    "Pairing approval requires the current Session owner."
                );
            if (agents.CreatedBy(caller.Agent) is not null)
                throw new ToolAuthorizationDeniedException(
                    "Callers in a delegated Agent must use node_create_auth_token with parentNode instead of root pairing approval."
                );
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
}
