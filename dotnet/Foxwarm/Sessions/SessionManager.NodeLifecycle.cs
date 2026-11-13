using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> ExecuteNodeToolAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token,
        bool programmatic = false
    )
    {
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Node tools require the current Session owner.");
        var action = ToolRegistry.Text(args, "action")?.Trim().ToLowerInvariant();
        if (action == "list")
        {
            ToolRegistry.Keys(args, ["action"]);
            // One caller snapshot decides every Node and Provider row of this list.
            var visibility = VisibilityFor(owner);
            var declared = await NodeProviders.ListProvidersAsync(token);
            var destroyProviders = declared
                .OfType<JsonObject>()
                .Where(value =>
                    value["lifecycle"]!.AsArray().Any(item => SessionWait.Text(item) == "destroy")
                )
                .Select(value => value["id"]!.GetValue<string>())
                .ToHashSet(StringComparer.Ordinal);
            var nodes = await ToolNodeTopologyAsync(visibility, destroyProviders, token);
            var providers = new JsonArray();
            foreach (var provider in declared.OfType<JsonObject>())
            {
                var id = provider["id"]!.GetValue<string>();
                var actions = VisibleProviderActions(
                    visibility,
                    id,
                    provider["lifecycle"]!.AsArray(),
                    nodes
                        .OfType<JsonObject>()
                        .Any(node =>
                            SessionWait
                                .Text(node["id"])!
                                .StartsWith(id + "/", StringComparison.Ordinal)
                            && node["manage"]!
                                .AsArray()
                                .Any(item => SessionWait.Text(item) == "destroy")
                        )
                );
                if (actions.Count == 0)
                    continue;
                var visible = (JsonObject)provider.DeepClone();
                visible["lifecycle"] = actions;
                providers.Add(visible);
            }
            var currentNode = visibility.CurrentNode;
            var result = new JsonObject
            {
                ["output"] =
                    $"Current node: `{currentNode}`.\n"
                    + string.Join(
                        '\n',
                        nodes
                            .OfType<JsonObject>()
                            .Select(value =>
                                $"- `{value["id"]!.GetValue<string>()}` ({value["kind"]!.GetValue<string>()}) — {value["availability"]!.GetValue<string>()}"
                                + (
                                    value["select"]!.GetValue<bool>()
                                    || value["id"]!.GetValue<string>() == currentNode
                                        ? ""
                                        : "; not selectable"
                                )
                            )
                    )
                    + (
                        providers.Count == 0
                            ? ""
                            : "\nProviders:\n"
                                + string.Join(
                                    '\n',
                                    providers
                                        .OfType<JsonObject>()
                                        .Select(value =>
                                            $"- `{value["id"]!.GetValue<string>()}` ({string.Join(", ", value["lifecycle"]!.AsArray().Select(SessionWait.Text))})"
                                        )
                                )
                    ),
            };
            if (programmatic)
            {
                result["nodes"] = nodes;
                result["providers"] = providers;
                result["currentNode"] = currentNode;
            }
            return result;
        }
        if (action == "select")
        {
            ToolRegistry.Keys(args, ["action", "nodeId"]);
            var id = RequiredNodeArgument(args, "nodeId", 193).Trim();
            return await SelectNodeAsync(owner, id, token);
        }
        if (action is not ("create" or "ensure" or "inspect" or "destroy"))
            throw new InvalidDataException(
                "node action must be list, select, create, ensure, inspect, or destroy."
            );
        ToolRegistry.Keys(
            args,
            action == "destroy"
                ? ["action", "nodeId", "parameters", "parametersJson", "confirmation"]
                : ["action", "providerId", "nodeId", "parameters", "parametersJson"]
        );
        var parameters =
            ToolRegistry.ObjectArg(args, "parameters", "parametersJson") ?? new JsonObject();
        ExecutableNodeProvider.BoundedJson(parameters, 64 * 1024, 12, int.MaxValue, true);
        string? providerId = null;
        string? nodeId = null;
        JsonObject resultValue;
        if (action == "inspect" && args.ContainsKey("providerId"))
        {
            if (args.ContainsKey("nodeId") || parameters.Count != 0)
                throw new InvalidDataException("Provider inspection accepts providerId only.");
            providerId = RequiredNodeArgument(args, "providerId", 64).Trim();
            var description = await NodeProviders.InspectProviderAsync(providerId, token);
            resultValue = new JsonObject { ["provider"] = description };
            // Normalize the full result as on Main's service boundary.
            ExecutableNodeProvider.BoundedJson(resultValue, 128 * 1024, 12, int.MaxValue, true);
        }
        else
        {
            if (action is "create" or "ensure")
            {
                providerId = RequiredNodeArgument(args, "providerId", 64).Trim();
                if (args.ContainsKey("nodeId"))
                {
                    nodeId = RequiredNodeArgument(args, "nodeId", 193, exact: true);
                    NodeProviderRegistry.ValidateId(nodeId);
                    if (nodeId.Equals("master", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Requested Node cannot be reserved master.");
                }
            }
            else
            {
                nodeId = RequiredNodeArgument(args, "nodeId", 193).Trim();
                if (
                    action == "destroy"
                    && ToolRegistry.Text(args, "confirmation") != "destroy node " + nodeId
                )
                    throw new InvalidDataException(
                        "destroy requires exact confirmation `destroy node " + nodeId + "`."
                    );
            }
            if (action == "ensure" && nodeId is null && agents.CreatedBy(owner.Agent) is not null)
                throw new ToolAuthorizationDeniedException(
                    "Callers in a delegated Agent must supply ensure.nodeId before provider effects."
                );
            if (action == "create")
                RequireNodeCreationParent(owner, NodeProviders.ProviderParent(providerId));
            resultValue = await NodeProviders.LifecycleAsync(
                action,
                providerId,
                nodeId,
                parameters,
                owner.Id,
                owner.Agent,
                token,
                async (target, existing) =>
                {
                    if (!existing)
                        RequireNodeCreationParent(owner, target);
                    await AuthorizeToolAsync(
                        owner,
                        new("node", "builtin", "node", args),
                        null,
                        token,
                        nodeEffects: target is null ? [] : [target]
                    );
                }
            );
            ExecutableNodeProvider.BoundedJson(resultValue, 128 * 1024, 12, int.MaxValue, true);
        }
        return resultValue;
    }

    private static string RequiredNodeArgument(
        JsonObject args,
        string key,
        int max,
        bool exact = false
    )
    {
        var text = ToolRegistry.Text(args, key);
        if (!exact)
            text = text?.Trim();
        if (string.IsNullOrWhiteSpace(text) || text.Length > max)
            throw new InvalidDataException(key + " must be a non-empty bounded string.");
        return text;
    }

    // Lists Nodes where the caller might do work (Node tools or file transfer), plus its current
    // Node. Selection and management are reported per listed Node but never admit one alone.
    private async Task<JsonArray> ToolNodeTopologyAsync(
        ToolVisibilityContext context,
        IReadOnlySet<string> destroyProviders,
        CancellationToken token
    )
    {
        var result = new JsonArray();
        var totalBytes = Encoding.UTF8.GetByteCount("{\"nodes\":[]}");
        var current = context.CurrentNode;
        foreach (var summary in (await NodeSummariesAsync(token: token)).OfType<JsonObject>())
        {
            var id = SessionWait.Text(summary["id"])!;
            var type = SessionWait.Text(summary["type"]);
            if (id.Length > 193 || type is not { Length: > 0 and <= 64 })
                continue;
            var tools =
                id == "master" ? this.tools.NodeDefinitions(id) : NodeProviders.Definitions(id);
            var definitions = tools
                .OfType<JsonObject>()
                .Take(200)
                .Where(definition =>
                    SessionWait.Text(definition["name"]) is { Length: > 0 and <= 128 }
                )
                .ToArray();
            var slash = id.IndexOf('/');
            var facets = ProbeNode(
                context,
                id,
                definitions.Select(definition => SessionWait.Text(definition["name"])!),
                slash > 0 && destroyProviders.Contains(id[..slash])
            );
            if (!facets.Usable && id != current)
                continue;
            // The cap applies to listed Nodes, so hidden ones cannot crowd them out.
            if (result.Count == 100)
                break;
            // Names only: descriptions and schemas come from Node inspection or `ctl tool search`.
            var visible = new JsonArray();
            foreach (var definition in definitions)
            {
                var name = SessionWait.Text(definition["name"])!;
                if (facets.Tools.Contains(name))
                    visible.Add((JsonNode?)name);
            }
            var node = new JsonObject
            {
                ["id"] = id,
                ["kind"] =
                    summary["kind"]?.DeepClone()
                    ?? JsonValue.Create(id == "master" ? "master" : "remote"),
                ["provider"] =
                    summary["provider"]?.DeepClone()
                    ?? JsonValue.Create(id == "master" ? "master" : "authenticated-remote"),
                ["type"] = summary["type"]!.DeepClone(),
                ["parentNode"] = summary["parentNode"]?.DeepClone(),
                ["availability"] =
                    summary["availability"]?.DeepClone()
                    ?? JsonValue.Create(
                        SessionCatalog.Flag(summary["executable"]) ? "ready"
                        : SessionCatalog.Flag(summary["online"]) ? "error"
                        : "offline"
                    ),
                ["tools"] = visible,
                ["select"] = facets.Select,
                ["transfer"] = facets.Transfer,
                ["manage"] = new JsonArray(
                    new[] { facets.Inspect ? "inspect" : null, facets.Destroy ? "destroy" : null }
                        .OfType<string>()
                        .Select(action => (JsonNode?)JsonValue.Create(action))
                        .ToArray()
                ),
            };
            if (
                SessionWait.Number(summary["lastActivity"]) is double activity
                && double.IsFinite(activity)
                && activity >= 0
            )
                node["lastActivity"] = activity;
            if (summary["protocolCompatibility"] is JsonObject compatibility)
            {
                try
                {
                    ExecutableNodeProvider.BoundedJson(compatibility, 4096, 12, int.MaxValue, true);
                    node["protocolCompatibility"] = compatibility.DeepClone();
                }
                catch (NodeProviderException) { }
            }
            if (SessionWait.Text(summary["displayName"]) is { Length: > 0 and <= 256 } label)
                node["label"] = label;
            var size = Encoding.UTF8.GetByteCount(node.ToJsonString());
            if (totalBytes + size > 256 * 1024)
                break;
            totalBytes += size;
            result.Add(node);
        }
        return result;
    }
}
