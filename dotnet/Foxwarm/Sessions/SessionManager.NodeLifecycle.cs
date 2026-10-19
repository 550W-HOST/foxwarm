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
        var isolated = AgentIsolated(owner.Agent);
        if (action == "list")
        {
            ToolRegistry.Keys(args, ["action"]);
            var nodes = await ToolNodeTopologyAsync(owner, token);
            var providers = await NodeProviders.ListProvidersAsync(isolated, token);
            var currentNode = CurrentNode(owner);
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
                            )
                    )
                    + "\nProviders:\n"
                    + string.Join(
                        '\n',
                        providers
                            .OfType<JsonObject>()
                            .Select(value =>
                                $"- `{value["id"]!.GetValue<string>()}` ({string.Join(", ", value["lifecycle"]!.AsArray().Select(SessionWait.Text))})"
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
            if (isolated)
                throw new ToolAuthorizationDeniedException(
                    "Isolated sessions cannot switch Node through model tools. Use the administrator Node command."
                );
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
        if (isolated && action != "inspect")
            throw new ToolAuthorizationDeniedException(
                "Effectively isolated sessions cannot mutate provider Nodes without an ownership policy."
            );
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
            // Normalize the full result before restricting disclosed actions, as on Main's service boundary.
            ExecutableNodeProvider.BoundedJson(resultValue, 128 * 1024, 12, int.MaxValue, true);
            description["lifecycle"] = NodeProviderRegistry.DisclosedActions(description, isolated);
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
                RequireNodeBoundary(owner, nodeId);
                if (
                    action == "destroy"
                    && ToolRegistry.Text(args, "confirmation") != "destroy node " + nodeId
                )
                    throw new InvalidDataException(
                        "destroy requires exact confirmation `destroy node " + nodeId + "`."
                    );
            }
            resultValue = await NodeProviders.LifecycleAsync(
                action,
                providerId,
                nodeId,
                parameters,
                owner.Id,
                owner.Agent,
                token
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

    private async Task<JsonArray> ToolNodeTopologyAsync(SessionOwner owner, CancellationToken token)
    {
        var result = new JsonArray();
        var totalBytes = Encoding.UTF8.GetByteCount("{\"nodes\":[]}");
        var current = CurrentNode(owner);
        foreach (var summary in (await NodeSummariesAsync(token: token)).OfType<JsonObject>())
        {
            var id = SessionWait.Text(summary["id"])!;
            var type = SessionWait.Text(summary["type"]);
            if (id.Length > 193 || type is not { Length: > 0 and <= 64 })
                continue;
            if (
                AgentIsolated(owner.Agent)
                && id != "master"
                && id != (RecordedIsolationNode(owner.Agent) ?? current)
                && id != current
            )
                continue;
            if (result.Count == 100)
                break;
            var tools =
                id == "master" ? this.tools.NodeDefinitions(id) : NodeProviders.Definitions(id);
            var visible = new JsonArray();
            foreach (var definition in tools.OfType<JsonObject>().Take(200))
            {
                var name = SessionWait.Text(definition["name"]);
                if (name is not { Length: > 0 and <= 128 })
                    continue;
                if (!ToolVisible(owner, "node", name, node: id))
                    continue;
                var tool = new JsonObject { ["name"] = name };
                if (SessionWait.Text(definition["description"]) is string description)
                    tool["description"] = description[..Math.Min(2000, description.Length)];
                if (definition["parameters"] is JsonNode schema)
                {
                    try
                    {
                        ExecutableNodeProvider.BoundedJson(
                            schema,
                            16 * 1024,
                            12,
                            int.MaxValue,
                            true
                        );
                        tool["parameters"] = schema.DeepClone();
                    }
                    catch (NodeProviderException) { }
                }
                visible.Add(tool);
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
                ["availability"] =
                    summary["availability"]?.DeepClone()
                    ?? JsonValue.Create(
                        SessionCatalog.Flag(summary["executable"]) ? "ready"
                        : SessionCatalog.Flag(summary["online"]) ? "error"
                        : "offline"
                    ),
                ["tools"] = visible,
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
