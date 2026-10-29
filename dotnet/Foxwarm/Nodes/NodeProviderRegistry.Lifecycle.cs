using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeProviderRegistry
{
    internal async Task<JsonObject> InspectProviderAsync(string providerId, CancellationToken token)
    {
        JsonObject description = providerId switch
        {
            "master" => new()
            {
                ["label"] = "Main host",
                ["description"] = "The colocated Main execution environment.",
                ["lifecycle"] = new JsonArray("inspect"),
            },
            "authenticated-remote" => new()
            {
                ["label"] = "Authenticated Nodes",
                ["description"] =
                    "Resident Nodes connected through authenticated CLI, HTTP or WebSocket transports. Pairing and revocation are managed separately.",
                ["lifecycle"] = new JsonArray("inspect"),
            },
            _ => await RequiredProvider(providerId).DescribeAsync(token),
        };
        description["id"] = providerId;
        return description;
    }

    internal async Task<JsonArray> ListProvidersAsync(bool isolated, CancellationToken token)
    {
        var result = new JsonArray();
        foreach (var id in new[] { "master", "authenticated-remote" }.Concat(providers.Keys))
        {
            var description = await InspectProviderAsync(id, token);
            if (result.Count == 100)
                continue;
            var summary = new JsonObject
            {
                ["id"] = id,
                ["label"] = description["label"]!.DeepClone(),
                ["lifecycle"] = DisclosedActions(description, isolated),
            };
            ExecutableNodeProvider.BoundedJson(summary, 64 * 1024, 12, int.MaxValue, true);
            result.Add(summary);
        }
        return result;
    }

    internal static JsonArray DisclosedActions(JsonObject description, bool isolated) =>
        new(
            description["lifecycle"]!
                .AsArray()
                .Where(action => !isolated || SessionWait.Text(action) == "inspect")
                .Select(action => action!.DeepClone())
                .ToArray()
        );

    private ExecutableNodeProvider RequiredProvider(string id) =>
        providers.TryGetValue(id, out var provider)
            ? provider
            : throw new NodeProviderException(
                "NODE_LIFECYCLE_PROVIDER_NOT_FOUND",
                "Node provider is not configured: " + id
            );

    internal async Task<JsonObject> LifecycleAsync(
        string action,
        string? providerId,
        string? nodeId,
        JsonObject parameters,
        string sessionId,
        string agent,
        CancellationToken token,
        Func<string?, bool, Task>? authorize = null
    )
    {
        ApprovedNodeRegistry.Mutation? mutation = null;
        if (action == "inspect")
            return await InvokeLifecycleAsync();
        using var scope = await native.Registry.BeginMutationAsync(token);
        mutation = scope;
        token.ThrowIfCancellationRequested();
        return await InvokeLifecycleAsync();

        async Task<JsonObject> InvokeLifecycleAsync()
        {
            var creating = action is "create" or "ensure";
            ExecutableNodeProvider provider;
            if (creating)
            {
                // Fixed providers expose inspection only; provisioning stays with their existing owners.
                if (providerId is "master" or "authenticated-remote")
                    throw Unsupported(providerId, action);
                provider = RequiredProvider(providerId!);
                if (nodeId is not null)
                {
                    ValidateId(nodeId);
                    if (!nodeId.StartsWith(provider.Id + "/", StringComparison.Ordinal))
                        throw new NodeProviderException(
                            "NODE_LIFECYCLE_INVALID_NODE_ID",
                            "Requested Node must belong to the selected provider namespace."
                        );
                }
            }
            else
            {
                ValidateId(nodeId!);
                // Resolve the exact namespace owner without requiring readiness.
                var existing =
                    await ResolveAsync(nodeId!, token, mutation)
                    ?? throw new NodeProviderException(
                        "NODE_EXECUTION_NODE_UNAVAILABLE",
                        "Node is not available: " + nodeId,
                        true
                    );
                var id =
                    nodeId!.Contains('/') ? nodeId[..nodeId.IndexOf('/')]
                    : nodeId == "master" ? "master"
                    : "authenticated-remote";
                if (id is "master" or "authenticated-remote")
                {
                    if (action == "inspect")
                        return new JsonObject { ["node"] = existing.DeepClone() };
                    throw Unsupported(id, action);
                }
                provider = RequiredProvider(id);
            }
            var description = await provider.DescribeAsync(token);
            if (!description["lifecycle"]!.AsArray().Any(item => SessionWait.Text(item) == action))
                throw Unsupported(provider.Id, action);
            if (creating && nodeId is null)
                native.Registry.ObserveProvider(provider.Id, await provider.ListAsync(token), mutation);
            if (creating && nodeId is not null)
            {
                var existing = await ResolveAsync(nodeId, token, mutation);
                if (action == "create" && (existing is not null || native.Registry.Forest().Contains(nodeId)))
                    throw new NodeProviderException(
                        "NODE_LIFECYCLE_NODE_EXISTS",
                        "Node already exists; create was not invoked."
                    );
                // The namespace preflight makes foreign-provider ensure ownership impossible.
            }
            if (creating)
            {
                var existingIdentity = action == "ensure" && nodeId is not null && native.Registry.Forest().Contains(nodeId);
                var target = action == "ensure" && nodeId is null ? null : existingIdentity ? nodeId : provider.ParentNode;
                if (authorize is not null)
                    await authorize(target, existingIdentity);
                if (!existingIdentity && (action != "ensure" || nodeId is not null))
                    native.Registry.RequireNewNode(nodeId, provider.ParentNode, mutation!);
            }
            else if (action == "destroy")
            {
                if (authorize is not null)
                    await authorize(nodeId, true);
                if (native.Registry.Forest().Subtree(nodeId!).Count != 1)
                    throw new InvalidDataException("Node has descendants.");
            }
            var request = new JsonObject
            {
                ["sourceSessionId"] = sessionId,
                ["parameters"] = parameters.DeepClone(),
                ["context"] = new JsonObject { ["agent"] = agent },
            };
            if (nodeId is not null)
                request["nodeId"] = nodeId[(provider.Id.Length + 1)..];
            var before = native.Registry.Forest();
            var result = await provider.LifecycleAsync(action, request, token);
            var returned =
                action == "destroy"
                    ? SessionWait.Text(result["nodeId"])
                    : SessionWait.Text(result["node"]?["id"]);
            if (nodeId is not null && returned != nodeId)
                throw new NodeProviderException(
                    "NODE_LIFECYCLE_NODE_MISMATCH",
                    "Provider returned the wrong Node identity."
                );
            if (result["node"] is JsonObject descriptor)
            {
                if (action == "create" && before.Contains(returned!))
                    throw new NodeProviderException("NODE_LIFECYCLE_NODE_EXISTS", "Provider create returned an existing identity after its effect; inspect before retrying.");
                if (action != "inspect")
                    native.Registry.RecordProviderNode(provider.Id, descriptor, mutation!);
                discovered[returned!] = (JsonObject)descriptor.DeepClone();
                result["node"] = LifecycleDescriptor(descriptor);
            }
            if (action == "destroy")
            {
                native.Registry.RemoveProviderNode(nodeId!, mutation!);
                discovered.TryRemove(nodeId!, out _);
            }
            return result;
        }
    }

    private static NodeProviderException Unsupported(string id, string action) =>
        new(
            "NODE_LIFECYCLE_OPERATION_UNSUPPORTED",
            $"Node provider `{id}` does not support `{action}`."
        );

    private JsonObject LifecycleDescriptor(JsonObject descriptor)
    {
        var value = (JsonObject)descriptor.DeepClone();
        value["parentNode"] = native.Registry.Forest().Parent(SessionWait.Text(value["id"])!);
        value["primitiveBackends"] = new JsonObject
        {
            ["filesystem"] = value["filesystem"]?.DeepClone(),
        };
        if (value["exec"] is not null)
            value["primitiveBackends"]!["exec"] = value["exec"]!.DeepClone();
        value.Remove("filesystem");
        value.Remove("exec");
        value["tools"] = DefinitionsFor(descriptor);
        return value;
    }
}
