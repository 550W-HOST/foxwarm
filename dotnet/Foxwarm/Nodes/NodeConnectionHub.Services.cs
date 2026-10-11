using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    internal sealed record ServiceTarget(string NodeId, string Service, Guid ConnectionId, int Version);
    internal sealed record ServiceEvent(ServiceTarget Target, JsonObject Event);
    private sealed record ServiceInvocation(Connection Connection, ServiceTarget Target, TaskCompletionSource<JsonObject> Result, Action<JsonObject>? Receive);
    private readonly ConcurrentDictionary<string, ServiceInvocation> serviceCalls = new(StringComparer.Ordinal);
    internal event Action<ServiceEvent>? ServiceReceived;
    internal event Action<Guid, string>? ServicesDisconnected;

    private static int ServiceVersion(Connection connection, string service) =>
        SessionWait.Number(connection.Capabilities["services"]?[service]) is double version
        && version >= 1 && version <= int.MaxValue && version == Math.Truncate(version)
            ? (int)version : 0;

    internal ServiceTarget Service(string id, string service, int minimumVersion = 1)
    {
        lock (gate)
        {
            Connection connection;
            try { connection = Require(id); }
            catch (InvalidOperationException error)
            {
                throw new CodeServiceException("NodeUnavailable", error.Message, 503, error);
            }
            var version = ServiceVersion(connection, service);
            if (version < minimumVersion)
                throw new CodeServiceException("UnsupportedService", $"Node '{id}' does not advertise '{service}' version {minimumVersion} or newer.", 501);
            return new(id, service, connection.Generation, version);
        }
    }

    internal ServiceTarget[] Services(string service)
    {
        lock (gate)
            return nodes.Values.Where(c => !c.Retired && c.Executable && c.Socket.State == System.Net.WebSockets.WebSocketState.Open && ServiceVersion(c, service) >= 1)
                .Select(c => new ServiceTarget(c.Id!, service, c.Generation, ServiceVersion(c, service))).ToArray();
    }

    private Connection RequireService(ServiceTarget target)
    {
        var current = Service(target.NodeId, target.Service, target.Version);
        if (current.ConnectionId != target.ConnectionId)
            throw new CodeServiceException("NodeUnavailable", "Node connection was replaced; the operation was not retried.", 503);
        return nodes[target.NodeId];
    }

    internal Task<JsonObject> RequestServiceAsync(string id, string service, string operation, JsonObject args, CancellationToken token, int minimumVersion = 1) =>
        RequestServiceAsync(Service(id, service, minimumVersion), operation, args, token);

    internal async Task<JsonObject> RequestServiceAsync(ServiceTarget target, string operation, JsonObject args, CancellationToken token, Action<JsonObject>? receive = null)
    {
        var requestId = "service_" + Guid.NewGuid().ToString("N");
        ServiceInvocation invocation;
        lock (gate)
        {
            var connection = RequireService(target);
            invocation = new(connection, target, new(TaskCreationOptions.RunContinuationsAsynchronously), receive);
            serviceCalls[requestId] = invocation;
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await SendServiceAsync(target, invocation.Connection, new JsonObject
            {
                ["type"] = "node_service_request", ["requestId"] = requestId,
                ["service"] = target.Service, ["operation"] = operation, ["args"] = args.DeepClone(),
            }, deadline.Token);
            return await invocation.Result.Task.WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && !shutdown.IsCancellationRequested)
        {
            throw new CodeServiceException("NodeTimeout", "Node service request timed out. Effects may have occurred; the request was not retried.", 504);
        }
        finally { serviceCalls.TryRemove(requestId, out _); }
    }

    internal async Task CommandServiceAsync(ServiceTarget target, string operation, JsonObject args, CancellationToken token = default)
    {
        Connection connection;
        lock (gate) connection = RequireService(target);
        await SendServiceAsync(target, connection, new JsonObject
        {
            ["type"] = "node_service_command", ["service"] = target.Service,
            ["operation"] = operation, ["args"] = args.DeepClone(),
        }, token);
    }

    private async Task SendServiceAsync(ServiceTarget target, Connection connection, JsonObject message, CancellationToken token)
    {
        await connection.SendGate.WaitAsync(token);
        try
        {
            // Revocation/replacement and effect submission share the existing trust lock.
            Task send;
            lock (gate)
            {
                if (!ReferenceEquals(RequireService(target), connection))
                    throw new CodeServiceException("NodeUnavailable", "Node connection changed.", 503);
                send = connection.Socket.SendAsync(System.Text.Encoding.UTF8.GetBytes(message.ToJsonString()), System.Net.WebSockets.WebSocketMessageType.Text, true, token);
            }
            await send;
        }
        finally { connection.SendGate.Release(); }
    }

    private void HandleServiceReply(Connection connection, JsonObject message, bool success)
    {
        var id = SessionWait.Text(message["requestId"]);
        if (id is null || !serviceCalls.TryGetValue(id, out var invocation)
            || !ReferenceEquals(connection, invocation.Connection)
            || (message.ContainsKey("service") && SessionWait.Text(message["service"]) != invocation.Target.Service))
            return;
        lock (gate)
        {
            if (connection.Retired || !nodes.TryGetValue(connection.Id!, out var current) || !ReferenceEquals(current, connection)) return;
            if (!serviceCalls.TryRemove(id, out _)) return;
        }
        if (success)
        {
            if (message["result"] is JsonObject result)
            {
                try
                {
                    var copy = (JsonObject)result.DeepClone();
                    // Attachment readiness is published before this socket admits subsequent stream events.
                    invocation.Receive?.Invoke(copy);
                    invocation.Result.TrySetResult(copy);
                }
                catch (Exception error) { invocation.Result.TrySetException(error); }
            }
            else invocation.Result.TrySetException(new CodeServiceException("NodeServiceError", "Invalid Node service response.", 502));
        }
        else
        {
            var error = message["error"] as JsonObject;
            var status = SessionWait.Number(error?["statusCode"]);
            invocation.Result.TrySetException(new CodeServiceException(
                SessionWait.Text(error?["code"]) ?? "NodeServiceError",
                SessionWait.Text(error?["message"]) ?? SessionWait.Text(message["error"]) ?? "Node service failed.",
                status is >= 400 and <= 599 ? (int)status : 500));
        }
    }

    private void HandleServiceEvent(Connection connection, JsonObject message)
    {
        var service = SessionWait.Text(message["service"]);
        if (service is not ("vscode-fs" or "vscode-git" or "vscode-pty") || message["event"] is not JsonObject payload) return;
        lock (gate)
        {
            if (connection.Retired || !nodes.TryGetValue(connection.Id!, out var current) || !ReferenceEquals(current, connection) || ServiceVersion(connection, service) < 1) return;
            ServiceReceived?.Invoke(new(new(connection.Id!, service, connection.Generation, ServiceVersion(connection, service)), (JsonObject)payload.DeepClone()));
        }
    }

    private void FailServices(Connection connection, string reason)
    {
        foreach (var pair in serviceCalls)
            if (ReferenceEquals(pair.Value.Connection, connection) && serviceCalls.TryRemove(pair.Key, out var invocation))
                invocation.Result.TrySetException(new CodeServiceException("NodeUnavailable", reason + ". Effects were not retried.", 503));
        ServicesDisconnected?.Invoke(connection.Generation, reason);
    }
}
