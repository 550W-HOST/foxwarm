using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub : IDisposable
{
    // Source's ws server uses its default 100 MiB message budget, including file envelopes.
    private const int NodeMessageLimit = 100 * 1024 * 1024;

    private readonly object gate = new();
    private readonly Dictionary<string, Connection> nodes = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Connection> pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Invocation> calls = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource shutdown = new();
    private readonly Timer expiry;
    internal ApprovedNodeRegistry Registry { get; }
    internal event Action? Changed;

    private sealed class Connection(WebSocket? socket = null)
    {
        internal readonly WebSocket Socket = socket!;
        internal ShellRuntime? Http;
        internal bool Open =>
            Http is not null
                ? !Http.Closed && DateTimeOffset.UtcNow - Http.LastSeen <= TimeSpan.FromSeconds(90)
                : Socket.State == WebSocketState.Open;
        internal readonly Guid Generation = Guid.NewGuid();
        internal readonly SemaphoreSlim SendGate = new(1, 1);
        internal string? Id;
        internal string? PendingId;
        internal string Type = "unknown";
        internal JsonObject Capabilities = new();
        internal JsonObject? Protocol;
        internal bool Executable => Protocol?["status"]?.GetValue<string>() == "compatible";
        internal bool Retired;
    }

    private sealed record Invocation(
        Connection Connection,
        TaskCompletionSource<JsonNode?> Result,
        RemoteExecAuthority.Claim? Claim,
        bool SupportsRegistration,
        SessionOwner? Owner,
        Action<JsonNode?>? PathMetadata
    );

    internal NodeConnectionHub(string root)
    {
        Registry = new(root);
        ExecClaims = new(root);
        ExternalExec = new(ExecClaims);
        Registry.Expired += id => RejectSocket(id, "Pairing request expired after 1 hour");
        expiry = new Timer(
            _ =>
            {
                try
                {
                    Registry.Cleanup();
                }
                catch (IOException)
                {
                    Console.Error.WriteLine("Node pairing expiry could not persist its update.");
                }
            },
            null,
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(1)
        );
    }

    internal const int CurrentProtocolVersion = 3;

    internal static JsonObject Protocol(JsonObject message)
    {
        var legacy = !message.ContainsKey("nodeProtocol");
        var range = legacy
            ? new JsonObject { ["min"] = 1, ["max"] = 1 }
            : message["nodeProtocol"] as JsonObject;
        if (
            range is null
            || range.Count != 2
            || SessionWait.Number(range["min"]) is not double min
            || SessionWait.Number(range["max"]) is not double max
            || min != Math.Truncate(min)
            || max != Math.Truncate(max)
            || min < 1
            || max < min
            || max > 1_000_000
        )
            throw new InvalidDataException(
                "nodeProtocol must satisfy 1 <= min <= max <= 1000000 with only integer min and max fields."
            );
        var compatible = min <= CurrentProtocolVersion && max >= 1;
        var result = new JsonObject
        {
            ["status"] = compatible ? "compatible" : "upgrade-required",
            ["client"] = range.DeepClone(),
            ["master"] = new JsonObject { ["min"] = 1, ["max"] = CurrentProtocolVersion },
            ["legacyClient"] = legacy,
        };
        if (compatible)
            result["negotiated"] = (int)Math.Min(max, CurrentProtocolVersion);
        return result;
    }

    private static void ValidateRegistration(JsonObject message)
    {
        if (
            SessionWait.Text(message["nodeType"]) is not { Length: > 0 }
            || message["capabilities"] is not JsonObject capabilities
            || capabilities["tools"] is not JsonArray tools
            || tools.Any(tool =>
                tool is not JsonObject || SessionWait.Text(tool["name"]) is not { Length: > 0 }
            )
            || tools
                .Select(tool => SessionWait.Text(tool!["name"]))
                .Distinct(StringComparer.Ordinal)
                .Count() != tools.Count
        )
            throw new InvalidDataException(
                "Registration requires nodeType and unique capabilities.tools definitions."
            );
    }

    internal bool Connected(string id)
    {
        if (id == "master")
            return true;
        lock (gate)
            return nodes.TryGetValue(id, out var connection)
                && !connection.Retired
                && connection.Open;
    }

    internal bool Online(string id)
    {
        if (id == "master")
            return true;
        lock (gate)
            return nodes.TryGetValue(id, out var connection)
                && !connection.Retired
                && connection.Executable
                && connection.Open;
    }

    internal JsonArray DiscoveredDefinitions(string id)
    {
        lock (gate)
        {
            if (
                !nodes.TryGetValue(id, out var connection)
                || connection.Retired
                || !connection.Executable
                || !connection.Open
            )
                return new JsonArray();
            return Definitions(id);
        }
    }

    internal JsonArray Definitions(string id)
    {
        lock (gate)
        {
            var definitions = new JsonArray(
                Require(id).Capabilities["tools"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Select(tool =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["type"] = "function",
                                ["name"] = tool["name"]!.DeepClone(),
                                ["description"] =
                                    tool["description"]?.DeepClone() ?? JsonValue.Create(""),
                                ["strict"] = false,
                                ["parameters"] =
                                    tool["parameters"]?.DeepClone()
                                    ?? new JsonObject
                                    {
                                        ["type"] = "object",
                                        ["properties"] = new JsonObject(),
                                    },
                            }
                    )
                    .ToArray()
            );
            foreach (var definition in definitions.OfType<JsonObject>())
            {
                if (definition["parameters"] is null)
                    definition["parameters"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["properties"] = new JsonObject(),
                    };
                if (
                    definition["parameters"] is JsonObject parameters
                    && parameters["properties"] is null
                )
                    parameters["properties"] = new JsonObject();
            }
            return definitions;
        }
    }

    private Connection Require(string id)
    {
        if (!nodes.TryGetValue(id, out var connection) || connection.Retired || !connection.Open)
            throw new InvalidOperationException("Node is offline: " + id);
        if (!connection.Executable)
            throw new InvalidOperationException("Node protocol is incompatible: " + id);
        return connection;
    }

    internal JsonArray List()
    {
        var records = Registry.ListApproved();
        lock (gate)
            foreach (var record in records.OfType<JsonObject>())
            {
                var id = record["nodeId"]!.GetValue<string>();
                nodes.TryGetValue(id, out var connection);
                record["id"] = id;
                record["type"] = connection?.Type ?? record["nodeType"]?.GetValue<string>();
                record["connected"] = connection is { Retired: false } && connection.Open;
                record["executable"] =
                    connection is { Retired: false, Executable: true } && connection.Open;
                record["services"] =
                    connection is { Retired: false, Executable: true } && connection.Open
                        ? connection.Capabilities["services"]?.DeepClone() ?? new JsonObject()
                        : new JsonObject();
                record["tools"] =
                    connection is { Retired: false, Executable: true } && connection.Open
                        ? ExecutableDefinitions(connection)
                        : new JsonArray();
                if (connection?.Protocol is not null)
                    record["protocolCompatibility"] = connection.Protocol.DeepClone();
                record.Remove("capabilities"); // Offline snapshots are not live capabilities.
            }
        return records;
    }

    private static JsonArray ExecutableDefinitions(Connection connection) =>
        new(
            connection.Capabilities["tools"]!
                .AsArray()
                .OfType<JsonObject>()
                .Select(tool => (JsonNode?)tool.DeepClone())
                .ToArray()
        );

    internal JsonArray ListPending()
    {
        var result = Registry.ListPending();
        foreach (var value in result.OfType<JsonObject>())
            value["connected"] = pending.ContainsKey(value["id"]!.GetValue<string>());
        return result;
    }

    internal async Task<JsonObject> ApproveAsync(
        string pendingId,
        string? nodeId,
        Action? beforeMutation = null
    )
    {
        var result = Registry.Approve(pendingId, nodeId, beforeMutation);
        var delivered = false;
        if (pending.TryRemove(pendingId, out var connection) && connection.Open)
        {
            try
            {
                await SendAsync(connection, PairApproved(result), shutdown.Token);
                delivered = true;
                Registry.ClaimId(pendingId);
                Close(connection, "Pairing approved; reconnect with node credentials", false);
            }
            catch (WebSocketException) { }
        }
        result["deliveredLive"] = delivered;
        Changed?.Invoke();
        return result;
    }

    private static JsonObject PairApproved(JsonObject result)
    {
        var response = (JsonObject)result.DeepClone();
        response["type"] = "pair_approved";
        return response;
    }

    internal void Reject(string id, string? reason)
    {
        Registry.Reject(id);
        RejectSocket(id, reason ?? "Pairing request rejected");
        Changed?.Invoke();
    }

    private void RejectSocket(string id, string reason)
    {
        if (!pending.TryRemove(id, out var connection))
            return;
        _ = RejectAsync(connection, id, reason);
    }

    private async Task RejectAsync(Connection connection, string id, string reason)
    {
        try
        {
            await SendAsync(
                connection,
                new JsonObject
                {
                    ["type"] = "pair_rejected",
                    ["pendingId"] = id,
                    ["reason"] = reason,
                },
                shutdown.Token
            );
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
        Close(connection, reason, true);
    }

    internal bool Remove(string id)
    {
        bool disconnected;
        lock (gate)
        {
            disconnected = nodes.ContainsKey(id);
            try
            {
                Registry.Remove(id);
            }
            catch (AuthorityCommittedException)
            {
                Disconnect(id, "Node credentials removed");
                throw;
            }
            Disconnect(id, "Node credentials removed");
        }
        Changed?.Invoke();
        return disconnected;
    }

    internal void Rename(string oldId, string newId)
    {
        lock (gate)
        {
            try
            {
                Registry.Rename(oldId, newId);
            }
            catch (AuthorityCommittedException)
            {
                Disconnect(oldId, "Node renamed; update client credentials");
                throw;
            }
            Disconnect(oldId, "Node renamed; update client credentials");
        }
        Changed?.Invoke();
    }

    internal void Disconnect(string id, string reason)
    {
        Connection? connection;
        lock (gate)
        {
            nodes.Remove(id, out connection);
            if (connection is not null)
                connection.Retired = true;
        }
        if (connection is null)
            return;
        FailCalls(connection, reason);
        Close(connection, reason, false);
    }

    private void FailCalls(Connection connection, string reason)
    {
        FailTransfers(connection, reason);
        FailServices(connection, reason);
        foreach (var pair in calls)
            if (
                ReferenceEquals(pair.Value.Connection, connection)
                && calls.TryRemove(pair.Key, out var call)
            )
            {
                if (call.Claim is not null)
                    ExecClaims.Settle(call.Claim, false);
                call.Result.TrySetException(
                    new IOException(
                        reason + ". Started effects may have occurred; they were not retried."
                    )
                );
            }
    }

    private static void Close(Connection connection, string reason, bool policy)
    {
        if (connection.Http is not null)
        {
            connection.Http.Disconnect();
            return;
        }
        _ = CloseAsync(connection, reason, policy);
    }

    private static async Task CloseAsync(Connection connection, string reason, bool policy)
    {
        try
        {
            await connection.SendGate.WaitAsync();
            try
            {
                if (connection.Open)
                    await connection.Socket.CloseOutputAsync(
                        policy
                            ? WebSocketCloseStatus.PolicyViolation
                            : WebSocketCloseStatus.NormalClosure,
                        reason,
                        CancellationToken.None
                    );
            }
            finally
            {
                connection.SendGate.Release();
            }
        }
        catch (WebSocketException)
        {
            connection.Socket.Abort();
        }
    }

    private static async Task SendAsync(
        Connection connection,
        JsonObject value,
        CancellationToken token,
        Action? beforeSend = null
    )
    {
        await connection.SendGate.WaitAsync(token);
        try
        {
            beforeSend?.Invoke();
            await connection.Socket.SendAsync(
                Encoding.UTF8.GetBytes(value.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                token
            );
        }
        finally
        {
            connection.SendGate.Release();
        }
    }

    internal async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = 400;
            return;
        }
        var query = context.Request.Query;
        var id = query["id"].ToString();
        var auth = query["auth"].ToString();
        var token = query["token"].ToString();
        var pairing = token.Length > 0 && id.Length == 0 && auth.Length == 0;
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var connection = new Connection(socket);
        if (
            !(
                pairing
                    ? ApprovedNodeRegistry.Equal(token, Registry.PairingToken)
                    : id.Length > 0 && auth.Length > 0 && Registry.Authenticate(id, auth)
            )
        )
        {
            await socket.CloseAsync(
                WebSocketCloseStatus.PolicyViolation,
                "Invalid node credentials or pairing token",
                context.RequestAborted
            );
            return;
        }
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
            shutdown.Token,
            context.RequestAborted
        );
        var buffer = new byte[32 * 1024];
        try
        {
            while (!lifetime.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                using var stream = new MemoryStream();
                WebSocketReceiveResult read;
                do
                {
                    read = await socket.ReceiveAsync(buffer, lifetime.Token);
                    if (read.MessageType == WebSocketMessageType.Close)
                        return;
                    if (
                        read.MessageType != WebSocketMessageType.Text
                        || stream.Length + read.Count > NodeMessageLimit
                    )
                        throw new InvalidDataException("Invalid Node message.");
                    stream.Write(buffer, 0, read.Count);
                } while (!read.EndOfMessage);
                try
                {
                    var message =
                        JsonNode.Parse(stream.ToArray()) as JsonObject
                        ?? throw new InvalidDataException("Node message must be an object.");
                    if (connection.Retired)
                        continue;
                    var type = SessionWait.Text(message["type"]);
                    if (type == "ping")
                    {
                        await SendAsync(
                            connection,
                            new JsonObject { ["type"] = "pong" },
                            lifetime.Token
                        );
                        continue;
                    }
                    if (pairing)
                    {
                        if (type != "pair_request" || connection.PendingId is not null)
                            throw new InvalidDataException("Pairing accepts one pair_request.");
                        ValidateRegistration(message);
                        var claimed = Registry.Claim(
                            message["nodeType"]!.GetValue<string>(),
                            SessionWait.Text(message["requestedName"])
                        );
                        if (claimed is not null)
                        {
                            await SendAsync(connection, PairApproved(claimed), lifetime.Token);
                            Close(
                                connection,
                                "Pairing approved; reconnect with node credentials",
                                false
                            );
                            continue;
                        }
                        var request = Registry.Request(message, Protocol(message));
                        connection.PendingId = request["id"]!.GetValue<string>();
                        pending[connection.PendingId] = connection;
                        await SendAsync(
                            connection,
                            new JsonObject
                            {
                                ["type"] = "pair_pending",
                                ["pendingId"] = connection.PendingId,
                                ["requestedName"] = request["requestedName"]?.DeepClone(),
                                ["nodeType"] = request["nodeType"]!.DeepClone(),
                            },
                            lifetime.Token
                        );
                        Changed?.Invoke();
                        continue;
                    }
                    if (connection.Id is null)
                    {
                        if (type != "node_register")
                            throw new InvalidDataException(
                                "Authenticated Node must register before application work."
                            );
                        ValidateRegistration(message);
                        var protocol = Protocol(message);
                        Connection? old;
                        lock (gate)
                        {
                            // Trust validation and publication share revocation's lifecycle lock.
                            Registry.Touch(id, auth, message, protocol);
                            connection.Id = id;
                            connection.Type = message["nodeType"]!.GetValue<string>();
                            connection.Capabilities = (JsonObject)
                                message["capabilities"]!.DeepClone();
                            connection.Protocol = protocol;
                            nodes.TryGetValue(id, out old);
                            if (old is not null)
                                old.Retired = true;
                            nodes[id] = connection;
                        }
                        if (old is not null)
                        {
                            FailCalls(old, "Node connection replaced");
                            Close(old, "Node connection replaced", false);
                        }
                        await SendAsync(
                            connection,
                            connection.Executable
                                ? new JsonObject
                                {
                                    ["type"] = "registered",
                                    ["nodeId"] = id,
                                    ["status"] = "success",
                                    ["nodeProtocol"] = new JsonObject
                                    {
                                        ["negotiated"] = protocol["negotiated"]!.DeepClone(),
                                        ["master"] = protocol["master"]!.DeepClone(),
                                    },
                                }
                                : new JsonObject
                                {
                                    ["type"] = "node_incompatible",
                                    ["code"] = "NODE_PROTOCOL_INCOMPATIBLE",
                                    ["nodeId"] = id,
                                    ["clientProtocol"] = protocol["client"]!.DeepClone(),
                                    ["masterProtocol"] = protocol["master"]!.DeepClone(),
                                    ["legacyClient"] = protocol["legacyClient"]!.DeepClone(),
                                    ["message"] =
                                        "Node protocol incompatible; update and restart the Node client.",
                                },
                            lifetime.Token
                        );
                        Changed?.Invoke();
                        continue;
                    }
                    lock (gate)
                        if (
                            !nodes.TryGetValue(id, out var active)
                            || !ReferenceEquals(active, connection)
                        )
                            continue;
                    if (!connection.Executable)
                        throw new InvalidDataException("NODE_PROTOCOL_INCOMPATIBLE");
                    if (type == "node_register")
                        continue;
                    if (
                        type
                        is "session_list_request"
                            or "session_history_request"
                            or "session_send_message"
                    )
                    {
                        await HandleSessionRequestAsync(connection, message, lifetime.Token);
                        continue;
                    }
                    if (
                        type
                        is "file_read_response"
                            or "file_write_response"
                            or "file_transfer_error"
                    )
                    {
                        HandleFileReply(connection, message, type);
                        continue;
                    }
                    if (type is "node_service_response" or "node_service_error")
                    {
                        HandleServiceReply(connection, message, type == "node_service_response");
                        continue;
                    }
                    if (type == "node_service_event")
                    {
                        HandleServiceEvent(connection, message);
                        continue;
                    }
                    if (type is "tool_call_response" or "tool_call_error")
                    {
                        HandleToolReply(connection, message, type == "tool_call_response");
                        continue;
                    }
                    if (
                        type
                        is "external_exec_background"
                            or "external_exec_completed"
                            or "external_exec_result_response"
                    )
                    {
                        await HandleExternalMessageAsync(connection, message, type, lifetime.Token);
                        continue;
                    }
                    if (type is "session_event" or "remote_exec_background")
                    {
                        try
                        {
                            var consumer =
                                type == "session_event" ? SessionEvent : BackgroundRegistration;
                            if (consumer is null)
                                throw new InvalidOperationException(
                                    "Node Session events are unavailable."
                                );
                            await consumer(id, message);
                            if (
                                type == "session_event"
                                && SessionWait.Text(message["requestId"]) is string requestId
                            )
                                await SendAsync(
                                    connection,
                                    new JsonObject
                                    {
                                        ["type"] = "session_event_accepted",
                                        ["requestId"] = requestId,
                                    },
                                    lifetime.Token
                                );
                        }
                        catch (Exception error)
                            when (error
                                    is InvalidOperationException
                                        or IOException
                                        or InvalidDataException
                            )
                        {
                            await SendAsync(
                                connection,
                                new JsonObject
                                {
                                    ["type"] = "error",
                                    ["requestId"] = message["requestId"]?.DeepClone(),
                                    ["error"] = error.Message,
                                },
                                lifetime.Token
                            );
                        }
                        continue;
                    }
                    throw new InvalidDataException(
                        "Node application message is unavailable in this host phase."
                    );
                }
                catch (Exception error)
                    when (error is InvalidDataException or System.Text.Json.JsonException)
                {
                    await SendAsync(
                        connection,
                        new JsonObject { ["type"] = "error", ["error"] = error.Message },
                        lifetime.Token
                    );
                }
            }
        }
        catch (Exception error)
            when (error is WebSocketException or OperationCanceledException or IOException) { }
        finally
        {
            if (connection.PendingId is string pendingId)
                pending.TryRemove(new KeyValuePair<string, Connection>(pendingId, connection));
            lock (gate)
            {
                connection.Retired = true;
                if (
                    connection.Id is string node
                    && nodes.TryGetValue(node, out var active)
                    && ReferenceEquals(active, connection)
                )
                    nodes.Remove(node);
            }
            FailCalls(connection, "Node disconnected");
            Changed?.Invoke();
        }
    }

    internal void BeginShutdown()
    {
        shellExpiry?.Change(Timeout.Infinite, Timeout.Infinite);
        expiry.Change(Timeout.Infinite, Timeout.Infinite);
        shutdown.Cancel();
        ExecClaims.Clear();
        string[] ids;
        lock (gate)
            ids = nodes.Keys.ToArray();
        foreach (var id in ids)
            Disconnect(id, "Host shutting down");
        foreach (var connection in pending.Values)
            connection.Socket.Abort();
    }

    public void Dispose()
    {
        BeginShutdown();
        shellExpiry?.Dispose();
        expiry.Dispose();
        shutdown.Dispose();
    }
}
