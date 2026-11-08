using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

// Code/Terminal service routing for every non-master Node. Resident Nodes keep their WebSocket
// transport in NodeConnectionHub; executable-Provider Nodes use their optional persistent channel.
// Callers see one target/request/command/event surface and never choose a transport.
internal sealed partial class NodeProviderRegistry : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, ProviderServiceChannel> channels = new(
        StringComparer.Ordinal
    );
    private readonly ConcurrentDictionary<string, Task<JsonObject?>> resolving = new(
        StringComparer.Ordinal
    );
    private readonly Action<NodeServiceEvent> forwardEvent;
    private readonly Action<Guid, string> forwardDisconnect;
    private int disposed;

    internal event Action<NodeServiceEvent>? ServiceReceived;
    internal event Action<Guid, string>? ServicesDisconnected;

    private void ConnectServiceEvents()
    {
        native.ServiceReceived += forwardEvent;
        native.ServicesDisconnected += forwardDisconnect;
    }

    private ProviderServiceChannel Channel(string id)
    {
        if (Volatile.Read(ref disposed) != 0)
            throw Unavailable("Node service channel is closed.");
        var slash = id.IndexOf('/');
        if (slash < 0 || !providers.TryGetValue(id[..slash], out var provider))
            throw Unavailable($"Node '{id}' is not available.");
        return channels.GetOrAdd(
            id,
            _ =>
            {
                var channel = new ProviderServiceChannel(provider, id[(slash + 1)..], id);
                channel.ServiceReceived += forwardEvent;
                channel.Disconnected += forwardDisconnect;
                return channel;
            }
        );
    }

    private static CodeServiceException Unavailable(string message) =>
        new("NodeUnavailable", message, 503);

    private static int DeclaredVersion(JsonObject descriptor, string service) =>
        descriptor["services"] is JsonObject services
        && SessionWait.Number(services[service]) is double version
        && version >= 1
            ? (int)version
            : 0;

    private bool Admitted(string id) => HasAuthorizationAncestry(id);

    /// <summary>
    /// Resolves the service endpoint for a non-master Node. A Provider Node must be ready,
    /// admitted to the authorization tree and declare the service; its channel starts on first use.
    /// </summary>
    internal async Task<NodeServiceTarget> ServiceAsync(
        string id,
        string service,
        int minimumVersion,
        CancellationToken token
    )
    {
        if (!IsProviderNode(id))
            return native.Service(id, service, minimumVersion);
        var channel = Channel(id);
        // A live generation avoids rediscovery: every Code request would otherwise pay a new launch.
        if (
            channel.Live is { } live
            && discovered.TryGetValue(id, out var known)
            && SessionWait.Text(known["availability"]) == "ready"
            && Admitted(id)
            && DeclaredVersion(known, service) >= minimumVersion
        )
            return channel.Target(live, service, minimumVersion);
        JsonObject? descriptor;
        try
        {
            descriptor = await SharedResolveAsync(id).WaitAsync(token);
        }
        catch (NodeProviderException error)
        {
            throw Unavailable("Node could not be resolved: " + error.Code);
        }
        if (descriptor is null || SessionWait.Text(descriptor["availability"]) != "ready")
            throw Unavailable($"Node '{id}' is not available.");
        if (!Admitted(id))
            throw Unavailable($"Node '{id}' is not admitted to the authorization tree.");
        if (DeclaredVersion(descriptor, service) < minimumVersion)
            throw new CodeServiceException(
                "UnsupportedService",
                $"Node '{id}' does not advertise '{service}' version {minimumVersion} or newer.",
                501
            );
        return channel.Target(await channel.EnsureAsync(token), service, minimumVersion);
    }

    // Code opens with many concurrent requests; one discovery serves them instead of exhausting
    // the Provider's active-request admission. It is not tied to any single caller's cancellation.
    private Task<JsonObject?> SharedResolveAsync(string id)
    {
        var created = new TaskCompletionSource<JsonObject?>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var shared = resolving.GetOrAdd(id, created.Task);
        if (ReferenceEquals(shared, created.Task))
            _ = Task.Run(async () =>
            {
                try
                {
                    created.SetResult(await ResolveAsync(id, CancellationToken.None));
                }
                catch (Exception error)
                {
                    created.SetException(error);
                }
                finally
                {
                    resolving.TryRemove(
                        new KeyValuePair<string, Task<JsonObject?>>(id, created.Task)
                    );
                }
            });
        return shared;
    }

    /// <summary>
    /// Populates the discovery projection once after startup so that service enumeration (for
    /// example the terminal list) can include Provider Nodes before any Node picker request.
    /// </summary>
    internal async Task EnsureDiscoveredAsync(CancellationToken token)
    {
        if (providers.Count > 0 && discovered.IsEmpty)
            _ = await ListAsync(token);
    }

    /// <summary>Currently known Nodes advertising a service, from the discovery projection.</summary>
    internal string[] ServiceNodes(string service) =>
        native
            .Services(service)
            .Select(target => target.NodeId)
            .Concat(
                discovered
                    .Where(pair =>
                        SessionWait.Text(pair.Value["availability"]) == "ready"
                        && DeclaredVersion(pair.Value, service) >= 1
                        && Admitted(pair.Key)
                    )
                    .Select(pair => pair.Key)
            )
            .Order(StringComparer.Ordinal)
            .ToArray();

    internal async Task<JsonObject> RequestServiceAsync(
        string id,
        string service,
        string operation,
        JsonObject args,
        CancellationToken token,
        int minimumVersion = 1
    ) =>
        await RequestServiceAsync(
            await ServiceAsync(id, service, minimumVersion, token),
            operation,
            args,
            token
        );

    internal Task<JsonObject> RequestServiceAsync(
        NodeServiceTarget target,
        string operation,
        JsonObject args,
        CancellationToken token,
        Action<JsonObject>? receive = null
    )
    {
        if (!IsProviderNode(target.NodeId))
            return native.RequestServiceAsync(target, operation, args, token, receive);
        return ProviderRequestAsync(target, operation, args, token, receive);
    }

    private async Task<JsonObject> ProviderRequestAsync(
        NodeServiceTarget target,
        string operation,
        JsonObject args,
        CancellationToken token,
        Action<JsonObject>? receive
    )
    {
        if (!Admitted(target.NodeId))
            throw Unavailable($"Node '{target.NodeId}' is not admitted to the authorization tree.");
        return await Channel(target.NodeId)
            .RequestAsync(target, operation, args, token, receive, null);
    }

    internal Task CommandServiceAsync(
        NodeServiceTarget target,
        string operation,
        JsonObject args,
        CancellationToken token = default
    )
    {
        if (!IsProviderNode(target.NodeId))
            return native.CommandServiceAsync(target, operation, args, token);
        if (!Admitted(target.NodeId))
            throw Unavailable($"Node '{target.NodeId}' is not admitted to the authorization tree.");
        return Channel(target.NodeId).CommandAsync(target, operation, args, token);
    }

    // A channel never outlives discovery of its Node: a missing, unavailable or service-less
    // Node ends the generation exactly as a closed resident connection would.
    private void ReconcileChannels(string? only = null)
    {
        foreach (var (id, channel) in channels)
        {
            if ((only is not null && id != only) || channel.Live is null)
                continue;
            if (
                !discovered.TryGetValue(id, out var descriptor)
                || SessionWait.Text(descriptor["availability"]) != "ready"
                || descriptor["services"] is not JsonObject { Count: > 0 }
            )
                channel.Retire("Node is no longer available.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
            return;
        native.ServiceReceived -= forwardEvent;
        native.ServicesDisconnected -= forwardDisconnect;
        foreach (var channel in channels.Values)
            await channel.DisposeAsync();
        channels.Clear();
    }
}
