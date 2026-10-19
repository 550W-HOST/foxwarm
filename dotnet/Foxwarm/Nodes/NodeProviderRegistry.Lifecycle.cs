using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeProviderRegistry
{
    private readonly object mutationGate = new();
    private Task mutationTail = Task.CompletedTask;

    internal async Task<JsonObject> InspectProviderAsync(string providerId, CancellationToken token)
    {
        JsonObject description = providerId switch
        {
            "master" => new()
            {
                ["label"] = "Main host",
                ["description"] = "The colocated Main execution environment.",
                ["lifecycle"] = new JsonArray(),
            },
            "authenticated-remote" => new()
            {
                ["label"] = "Authenticated Nodes",
                ["description"] =
                    "Resident Nodes connected through authenticated CLI, HTTP or WebSocket transports. Pairing and revocation are managed separately.",
                ["lifecycle"] = new JsonArray(),
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
        CancellationToken token
    )
    {
        if (action == "inspect")
            return await InvokeLifecycleAsync();
        Task previous;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (mutationGate)
        {
            previous = mutationTail;
            mutationTail = release.Task;
        }
        await previous;
        try
        {
            token.ThrowIfCancellationRequested();
            return await InvokeLifecycleAsync();
        }
        finally
        {
            release.SetResult();
        }

        async Task<JsonObject> InvokeLifecycleAsync()
        {
            var creating = action is "create" or "ensure";
            ExecutableNodeProvider provider;
            if (creating)
            {
                // Fixed providers are configured owners too, but declare no lifecycle methods.
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
                // Resolve all possible exact owners without requiring readiness.
                var existing =
                    await ResolveLifecycleNodeAsync(nodeId!, token)
                    ?? throw new NodeProviderException(
                        "NODE_EXECUTION_NODE_UNAVAILABLE",
                        "Node is not available: " + nodeId,
                        true
                    );
                var id =
                    nodeId!.Contains('/') ? nodeId[..nodeId.IndexOf('/')]
                    : nodeId == "master" ? "master"
                    : "authenticated-remote";
                if (!providers.TryGetValue(id, out provider!))
                    throw Unsupported(id, action);
            }
            var description = await provider.DescribeAsync(token);
            if (!description["lifecycle"]!.AsArray().Any(item => SessionWait.Text(item) == action))
                throw Unsupported(provider.Id, action);
            if (creating && nodeId is not null)
            {
                var existing = await ResolveLifecycleNodeAsync(nodeId, token);
                if (action == "create" && existing is not null)
                    throw new NodeProviderException(
                        "NODE_LIFECYCLE_NODE_EXISTS",
                        "Node already exists; create was not invoked."
                    );
                // The namespace preflight makes foreign-provider ensure ownership impossible.
            }
            var request = new JsonObject
            {
                ["sourceSessionId"] = sessionId,
                ["parameters"] = parameters.DeepClone(),
                ["context"] = new JsonObject { ["agent"] = agent },
            };
            if (nodeId is not null)
                request["nodeId"] = nodeId[(provider.Id.Length + 1)..];
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
            if (creating)
            {
                // All executable owners are disjoint namespaces. Check the fixed owner after
                // the effect too; do not rediscover the effectful provider or replay its call.
                if (
                    native
                        .List()
                        .OfType<JsonObject>()
                        .Any(item => SessionWait.Text(item["id"]) == returned)
                )
                    throw new NodeProviderException(
                        "NODE_PROVIDER_DUPLICATE_NODE",
                        "Multiple providers own the same Node identity."
                    );
            }
            if (result["node"] is JsonObject descriptor)
            {
                discovered[returned!] = (JsonObject)descriptor.DeepClone();
                result["node"] = LifecycleDescriptor(descriptor);
            }
            if (action == "destroy")
                discovered.TryRemove(nodeId!, out _);
            return result;
        }
    }

    private async Task<JsonObject?> ResolveLifecycleNodeAsync(
        string nodeId,
        CancellationToken token
    )
    {
        // Namespace wrappers exclude every unrelated executable before discovery. Native
        // credential IDs cannot contain a slash, so exact lookup covers all possible owners.
        var result = await ResolveAsync(nodeId, token);
        if (
            nodeId.Contains('/')
            && native
                .List()
                .OfType<JsonObject>()
                .Any(item => SessionWait.Text(item["id"]) == nodeId)
        )
            throw new NodeProviderException(
                "NODE_PROVIDER_DUPLICATE_NODE",
                "Multiple providers own the same Node identity."
            );
        return result;
    }

    private static NodeProviderException Unsupported(string id, string action) =>
        new(
            "NODE_LIFECYCLE_OPERATION_UNSUPPORTED",
            $"Node provider `{id}` does not support `{action}`."
        );

    private static JsonObject LifecycleDescriptor(JsonObject descriptor)
    {
        var value = (JsonObject)descriptor.DeepClone();
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
