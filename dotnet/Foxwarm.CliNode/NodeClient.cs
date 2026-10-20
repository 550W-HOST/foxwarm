using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed record NodeClientOptions(
    string Host,
    string? NodeId,
    string? PairingToken,
    string? AuthToken,
    string? CredentialsFile,
    bool LocalTrigger = true,
    double LocalTriggerPort = 0,
    Func<NodeToolCall, CancellationToken, Task<ToolApproval>>? ToolCallInterceptor = null,
    Action<string, string>? OnStatus = null
);

internal sealed partial class NodeClient
{
    private readonly NodePaths paths;
    private readonly NodeClientOptions options;
    private readonly NodeFileTools tools;
    private readonly NodeBrowserTools browserTools = new();
    private readonly NodeFileTransfer transfers;
    private readonly string requestedName;
    private readonly NodePtyService? pty;
    private string? nodeId;
    private string? authToken;
    private bool initialCredentialsPending;
    private bool pairingRejected;
    private bool incompatible;
    private bool immediateReconnect;

    internal NodeClient(NodeClientOptions options, NodePaths paths)
    {
        this.options = options;
        this.paths = paths;
        tools = new NodeFileTools(paths);
        transfers = new NodeFileTransfer(paths);
        if (NodePtyService.IsSupported)
            pty = new NodePtyService(
                options.CredentialsFile is not null
                    ? Path.GetDirectoryName(Path.GetFullPath(options.CredentialsFile))!
                    : Path.Combine(paths.StartupDirectory, "state")
            );
        requestedName = string.IsNullOrEmpty(options.NodeId)
            ? "node_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            : options.NodeId;
        initialCredentialsPending =
            !string.IsNullOrEmpty(options.NodeId) && !string.IsNullOrEmpty(options.AuthToken);
        nodeId = initialCredentialsPending ? options.NodeId : null;
        authToken = options.AuthToken;
    }

    private bool Authenticated => !string.IsNullOrEmpty(nodeId) && !string.IsNullOrEmpty(authToken);

    internal async Task Run(CancellationToken stop)
    {
        try
        {
            await StartLocalTriggerServer();
            await RunConnections(stop);
        }
        finally
        {
            await StopLocalTriggerServer();
            await DrainExec();
            await browserTools.DisposeAsync();
            if (pty is not null)
                await pty.DisposeAsync();
        }
    }

    private async Task RunConnections(CancellationToken stop)
    {
        await LoadCredentials();
        if (!Authenticated && string.IsNullOrEmpty(options.PairingToken))
            throw new InvalidDataException(
                "Node client needs either stored/auth credentials or a pairing token"
            );
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await LoadCredentials();
                var host = options.Host.TrimEnd('/');
                if (host.StartsWith("http", StringComparison.Ordinal))
                    host = "ws" + host[4..];
                var address = new Uri(
                    host
                        + "/node_ws"
                        + (
                            Authenticated
                                ? "?id="
                                    + Uri.EscapeDataString(nodeId!)
                                    + "&auth="
                                    + Uri.EscapeDataString(authToken!)
                                : "?token=" + Uri.EscapeDataString(options.PairingToken ?? "")
                        )
                );
                using var connection = new Connection();
                using var closeApprovals = stop.Register(connection.CloseApprovals);
                connection.Socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
                connection.Socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(10);
                connection.Socket.Options.Proxy = MasterProxy.Create(address);
                var proxy = MasterProxy.Resolve(address);
                Log(
                    "connecting",
                    "mode="
                        + (Authenticated ? "authenticated" : "pairing")
                        + (proxy is null ? "" : " proxy=" + MasterProxy.Safe(proxy))
                );
                await connection.Socket.ConnectAsync(address, stop);
                currentConnection = connection;
                try
                {
                    await connection.Send(
                        new JsonObject
                        {
                            ["type"] = Authenticated ? "node_register" : "pair_request",
                            ["nodeType"] = "cli-node",
                            ["capabilities"] = Capabilities(
                                options.ToolCallInterceptor is not null
                            ),
                            ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                            ["requestedName"] = Authenticated ? null : requestedName,
                        }
                    );
                    await Receive(connection, stop);
                }
                finally
                {
                    connection.CloseApprovals();
                    if (ReferenceEquals(currentConnection, connection))
                        currentConnection = null;
                    if (ReferenceEquals(registeredConnection, connection))
                        registeredConnection = null;
                    pty?.Disconnect(connection);
                    connection.RejectPending();
                }
                if (
                    connection.Socket.CloseStatus == WebSocketCloseStatus.PolicyViolation
                    && connection.Socket.CloseStatusDescription?.Contains(
                        "Invalid node credentials",
                        StringComparison.Ordinal
                    ) == true
                    && !string.IsNullOrEmpty(options.PairingToken)
                )
                {
                    nodeId = null;
                    authToken = null;
                    if (options.CredentialsFile is not null)
                        File.Delete(options.CredentialsFile);
                    Log("authentication_failed", "Falling back to pairing token");
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
                when (error
                        is WebSocketException
                            or HttpRequestException
                            or IOException
                            or ArgumentException
                            or OperationCanceledException
                )
            {
                // Transport exception chains can contain a credential-bearing URL.
                Log("connection_error", error.GetType().Name);
            }
            if (stop.IsCancellationRequested || pairingRejected || incompatible)
                break;
            var delay = immediateReconnect ? 250 : 5000;
            immediateReconnect = false;
            Log("reconnecting", "delay=" + delay);
            try
            {
                await Task.Delay(delay, stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async Task Receive(Connection connection, CancellationToken stop)
    {
        var buffer = new byte[65536];
        while (!stop.IsCancellationRequested && connection.Socket.State == WebSocketState.Open)
        {
            using var message = new MemoryStream();
            ValueWebSocketReceiveResult received;
            do
            {
                received = await connection.Socket.ReceiveAsync(buffer.AsMemory(), stop);
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    Log("disconnected", "code=" + (int?)connection.Socket.CloseStatus);
                    await connection.Socket.CloseOutputAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "",
                        stop
                    );
                    return;
                }
                message.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            try
            {
                if (
                    JsonNode.Parse(message.GetBuffer().AsSpan(0, (int)message.Length))
                    is not JsonObject frame
                )
                    continue;
                switch (Text(frame, "type"))
                {
                    case "registered":
                        try
                        {
                            connection.Protocol = ValidateProtocol(frame);
                        }
                        catch (InvalidDataException error)
                        {
                            incompatible = true;
                            Log("protocol_incompatible", error.Message);
                            await connection.Socket.CloseOutputAsync(
                                WebSocketCloseStatus.PolicyViolation,
                                "Invalid Node protocol negotiation result",
                                stop
                            );
                            return;
                        }
                        var registeredId = Text(frame, "nodeId");
                        if (
                            initialCredentialsPending
                            && authToken is not null
                            && nodeId == registeredId
                        )
                        {
                            await SaveCredentials(registeredId!, authToken);
                            initialCredentialsPending = false;
                        }
                        nodeId = registeredId;
                        await WriteLocalTriggerArtifacts();
                        Log("registered", "nodeId=" + nodeId);
                        if (Authenticated)
                        {
                            registeredConnection = connection;
                            pty?.Connect(
                                connection,
                                detail =>
                                    connection.Send(
                                        new JsonObject
                                        {
                                            ["type"] = "node_service_event",
                                            ["service"] = "vscode-pty",
                                            ["event"] = detail,
                                        }
                                    )
                            );
                            recovery ??= Recover();
                        }
                        break;
                    case "node_incompatible":
                        incompatible = true;
                        Log(
                            "protocol_incompatible",
                            Text(frame, "message") ?? "Update and restart this Node client"
                        );
                        break;
                    case "pair_pending":
                        Log(
                            "pair_pending",
                            "Node pairing pending approval. Run /node approve "
                                + Text(frame, "pendingId")
                        );
                        break;
                    case "pair_approved":
                        nodeId = Text(frame, "nodeId");
                        authToken = Text(frame, "authToken");
                        if (nodeId is null || authToken is null)
                            throw new InvalidDataException("Invalid pairing approval");
                        await SaveCredentials(nodeId, authToken);
                        await WriteLocalTriggerArtifacts();
                        Log("pair_approved", "nodeId=" + nodeId);
                        immediateReconnect = true;
                        await connection.Socket.CloseOutputAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "Reconnect with node credentials",
                            stop
                        );
                        break;
                    case "pair_rejected":
                        pairingRejected = true;
                        Log(
                            "pair_rejected",
                            "Pairing was rejected; automatic reconnect is disabled"
                        );
                        break;
                    case "external_exec_release":
                        ReleaseExternal(connection, frame["owner"] as JsonObject);
                        break;
                    case "external_exec_result_request":
                        ScheduleExternalQuery(connection, frame);
                        break;
                    case "node_service_request":
                    case "node_service_command":
                    case "tool_call":
                    case "file_read_request":
                    case "file_write_request":
                        // Effects outlive a lost reply, but can only reply on their originating connection.
                        ScheduleDispatch(connection, frame);
                        break;
                    case "tool_call_cancel":
                        if (
                            Text(frame, "callId") is { } cancelled
                            && foreground.TryGetValue(cancelled, out var call)
                            && ReferenceEquals(call.Connection, connection)
                        )
                            CancelWait(call.Stop);
                        break;
                    case "session_event_accepted":
                    case "cli_response":
                        connection.Accept(frame);
                        break;
                    case "error":
                        if (Text(frame, "requestId") is not null)
                            connection.Accept(frame);
                        else
                            Log("master_error", Text(frame, "error") ?? "Unknown error");
                        break;
                }
            }
            catch (System.Text.Json.JsonException)
            {
                Log("invalid_message", "Invalid JSON from Master");
            }
            catch (Exception error)
            {
                Log("message_error", error.GetType().Name);
            }
        }
    }

    private async Task Dispatch(
        Connection connection,
        JsonObject frame,
        CancellationTokenSource? cancellation
    )
    {
        var type = Text(frame, "type");
        if (type is "node_service_request" or "node_service_command")
        {
            await DispatchService(connection, frame);
            return;
        }
        var execStarted = false;
        try
        {
            var agent =
                Text(frame, "agentName") is { } value && !string.IsNullOrWhiteSpace(value)
                    ? value
                    : "main";
            JsonObject response;
            if (type == "tool_call")
            {
                if (!frame.ContainsKey("owner"))
                    await Approve(connection, frame, cancellation?.Token ?? CancellationToken.None);
                var result =
                    frame.ContainsKey("owner")
                        ? await ExecuteExternal(connection, frame, () => execStarted = true)
                    : Text(frame, "tool") == "exec"
                        ? await ExecuteCommand(
                            connection,
                            frame,
                            agent,
                            cancellation?.Token ?? CancellationToken.None,
                            () => execStarted = true
                        )
                    : Text(frame, "tool")?.StartsWith("browse_", StringComparison.Ordinal) == true
                        ? await browserTools.Execute(
                            Text(frame, "tool")!,
                            frame["args"] as JsonObject
                        )
                    : await tools.Execute(
                        Text(frame, "tool") ?? "",
                        frame["args"] as JsonObject,
                        agent,
                        Text(frame, "sessionCwd"),
                        NodeFileTools.Flag(frame, "programmatic")
                    );
                response = new JsonObject
                {
                    ["type"] = "tool_call_response",
                    ["callId"] = frame["callId"]?.DeepClone(),
                    ["result"] = result,
                };
            }
            else if (type == "file_read_request")
                response = new JsonObject
                {
                    ["type"] = "file_read_response",
                    ["transferId"] = frame["transferId"]?.DeepClone(),
                    ["file"] = await transfers.Read(
                        Text(frame, "filePath") ?? "",
                        agent,
                        NodeFileTools.Flag(frame, "restrictToAgentDir")
                    ),
                };
            else
                response = new JsonObject
                {
                    ["type"] = "file_write_response",
                    ["transferId"] = frame["transferId"]?.DeepClone(),
                    ["result"] = await transfers.Write(
                        Text(frame, "filePath") ?? "",
                        agent,
                        Text(frame, "dataBase64") ?? "",
                        NodeFileTools.Flag(frame, "overwrite"),
                        NodeFileTools.Flag(frame, "restrictToAgentDir")
                    ),
                };
            await connection.Send(response);
        }
        catch (Exception error)
        {
            var detail = FileError(error);
            var response =
                type == "tool_call"
                    ? new JsonObject
                    {
                        ["type"] = "tool_call_error",
                        ["callId"] = frame["callId"]?.DeepClone(),
                        ["error"] = detail,
                    }
                    : new JsonObject
                    {
                        ["type"] = "file_transfer_error",
                        ["transferId"] = frame["transferId"]?.DeepClone(),
                        ["error"] = detail["message"]?.DeepClone(),
                    };
            if (type == "tool_call" && Text(frame, "tool") == "exec")
                response["execStarted"] = execStarted;
            await connection.Send(response);
        }
    }

    internal static JsonObject FileError(Exception error)
    {
        string? code = error switch
        {
            NodeFileException native => native.Code,
            ExecCollisionException => "PERSISTENT_EXEC_ID_COLLISION",
            FileNotFoundException or DirectoryNotFoundException => "ENOENT",
            UnauthorizedAccessException => "EACCES",
            IOException when error is not InvalidDataException => (error.HResult & 0xffff) switch
            {
                2 or 3 => "ENOENT",
                5 or 13 => "EACCES",
                17 or 80 or 183 => "EEXIST",
                20 => "ENOTDIR",
                21 => "EISDIR",
                39 or 145 => "ENOTEMPTY",
                _ => null,
            },
            _ => null,
        };
        var result = new JsonObject
        {
            ["message"] =
                (
                    code is null
                    || error is ExecCollisionException
                    || error.Message.StartsWith(code + ":", StringComparison.Ordinal)
                        ? ""
                        : code + ": "
                ) + error.Message,
        };
        if (code is not null)
            result["code"] = code;
        return result;
    }

    private async Task LoadCredentials()
    {
        if (
            initialCredentialsPending
            || options.CredentialsFile is null
            || !File.Exists(options.CredentialsFile)
        )
            return;
        var stored =
            JsonNode.Parse(await File.ReadAllTextAsync(options.CredentialsFile)) as JsonObject;
        if (
            stored is not null
            && Text(stored, "nodeId") is { Length: > 0 } id
            && Text(stored, "authToken") is { Length: > 0 } token
        )
        {
            nodeId = id;
            authToken = token;
        }
    }

    private async Task SaveCredentials(string id, string token)
    {
        if (options.CredentialsFile is null)
            return;
        var path = Path.GetFullPath(options.CredentialsFile);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var content = new JsonObject
        {
            ["nodeId"] = id,
            ["authToken"] = token,
            ["pairedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        var fileOptions = new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
        };
        if (!OperatingSystem.IsWindows())
            fileOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        await using (var stream = new FileStream(path, fileOptions))
            await stream.WriteAsync(
                System.Text.Encoding.UTF8.GetBytes(
                    content.ToJsonString(new() { WriteIndented = true })
                )
            );
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    private static string? Text(JsonObject value, string key) => NodeFileTools.Text(value[key]);

    internal static JsonObject Capabilities(bool intercepted = false)
    {
        using var stream = typeof(NodeClient).Assembly.GetManifestResourceStream(
            "Foxwarm.CliNode.Capabilities.json"
        )!;
        var capabilities = (JsonObject)JsonNode.Parse(stream)!;
        if (intercepted)
            capabilities["features"]!.AsObject().Remove("externalToolOwner");
        if (!ExecNative.Supported)
        {
            var definitions = capabilities["tools"]!.AsArray();
            var exec = definitions.FirstOrDefault(tool =>
                NodeFileTools.Text(tool?["name"]) == "exec"
            );
            if (exec is not null)
                definitions.Remove(exec);
            capabilities["features"]!.AsObject().Remove("execWaitCancellation");
            capabilities["features"]!.AsObject().Remove("remoteExecBackgroundRegistration");
        }
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsWindows())
            capabilities.Remove("services");
        if (NodePtyService.IsSupported && capabilities["services"] is JsonObject services)
            services["vscode-pty"] = 1;
        return capabilities;
    }

    internal static int ValidateProtocol(JsonObject frame)
    {
        if (!frame.ContainsKey("nodeProtocol"))
            return 1;
        var negotiation =
            frame["nodeProtocol"] as JsonObject
            ?? throw new InvalidDataException("Invalid Node protocol negotiation result");
        var min = 1;
        var max = 1;
        if (negotiation.ContainsKey("master"))
        {
            var range =
                negotiation["master"] as JsonObject
                ?? throw new InvalidDataException("Invalid Master Node protocol range");
            if (
                range.Any(pair => pair.Key is not ("min" or "max"))
                || !Integer(range["min"], out min)
                || !Integer(range["max"], out max)
                || min < 1
                || max < min
                || max > 1000000
            )
                throw new InvalidDataException("Invalid Master Node protocol range");
        }
        var selected = Math.Min(3, max);
        if (
            Math.Max(1, min) > selected
            || !Integer(negotiation["negotiated"], out var actual)
            || actual != selected
        )
            throw new InvalidDataException(
                "Master returned an incompatible Node protocol selection; update and restart the Node client"
            );
        return selected;
    }

    private static bool Integer(JsonNode? node, out int result)
    {
        result = 0;
        return node is JsonValue value
            && value.TryGetValue<double>(out var number)
            && double.IsFinite(number)
            && number == Math.Truncate(number)
            && number >= int.MinValue
            && number <= int.MaxValue
            && (result = (int)number) == number;
    }

    private void Log(string state, string detail)
    {
        options.OnStatus?.Invoke(state, detail);
        if (options.OnStatus is not null)
            return;
        if (Environment.GetEnvironmentVariable("FOXWARM_NO_CONSOLE_LOG") != "1")
            Console.Error.WriteLine("[" + state + "] " + detail);
    }

    private sealed class Connection : IDisposable
    {
        internal ClientWebSocket Socket { get; } = new();
        internal CancellationTokenSource ApprovalStop { get; } = new();

        internal void CloseApprovals() => CancelWait(ApprovalStop);

        internal int Protocol { get; set; } = 1;
        private readonly object sendGate = new();
        private Task sending = Task.CompletedTask;
        internal Task PtyDispatch { get; set; } = Task.CompletedTask;
        private readonly System.Collections.Concurrent.ConcurrentDictionary<
            string,
            TaskCompletionSource<JsonObject>
        > requests = new();

        internal async Task<JsonNode?> Request(JsonObject frame, int timeoutSeconds = 15)
        {
            var id =
                "cli_"
                + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                + "_"
                + Guid.NewGuid().ToString("N")[..8];
            var completion = new TaskCompletionSource<JsonObject>(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            requests[id] = completion;
            frame["requestId"] = id;
            try
            {
                async Task<JsonObject> TransmitAndWait()
                {
                    await Send(frame, requireOpen: true);
                    return await completion.Task;
                }
                try
                {
                    var response = await TransmitAndWait()
                        .WaitAsync(TimeSpan.FromSeconds(timeoutSeconds));
                    return response["result"]?.DeepClone();
                }
                catch (TimeoutException)
                {
                    throw new IOException("cli-node request " + Text(frame, "type") + " timed out");
                }
            }
            finally
            {
                requests.TryRemove(id, out _);
            }
        }

        internal void Accept(JsonObject frame)
        {
            if (Text(frame, "requestId") is not { } id || !requests.TryRemove(id, out var pending))
                return;
            if (
                Text(frame, "type") == "error"
                || frame["ok"] is JsonValue value && value.TryGetValue<bool>(out var ok) && !ok
            )
                pending.TrySetException(
                    new IOException(
                        Text(frame, "error") is { Length: > 0 } error
                            ? error
                            : "cli-node request failed"
                    )
                );
            else
                pending.TrySetResult(frame);
        }

        internal void RejectPending()
        {
            foreach (var request in requests.ToArray())
                if (requests.TryRemove(request.Key, out var pending))
                    pending.TrySetException(
                        new IOException(
                            "Remote node connection closed before master acknowledged the request ("
                                + (Socket.CloseStatus is { } code ? (int)code : 1006)
                                + (
                                    string.IsNullOrEmpty(Socket.CloseStatusDescription)
                                        ? ""
                                        : ": " + Socket.CloseStatusDescription
                                )
                                + ")"
                        )
                    );
        }

        internal Task Send(JsonObject frame, bool requireOpen = false)
        {
            lock (sendGate)
                return sending = SendAfter(sending, frame, requireOpen);
        }

        private async Task SendAfter(Task previous, JsonObject frame, bool requireOpen)
        {
            try
            {
                await previous;
            }
            catch { }
            try
            {
                if (requireOpen && Socket.State != WebSocketState.Open)
                    throw new IOException("Remote node is not connected to master");
                if (Socket.State == WebSocketState.Open)
                    await Socket.SendAsync(
                        System.Text.Encoding.UTF8.GetBytes(frame.ToJsonString()).AsMemory(),
                        WebSocketMessageType.Text,
                        true,
                        CancellationToken.None
                    );
            }
            catch (Exception error)
                when (error
                        is WebSocketException
                            or ObjectDisposedException
                            or OperationCanceledException
                )
            {
                if (requireOpen)
                    throw new IOException("Remote node is not connected to master");
            }
        }

        public void Dispose()
        {
            CloseApprovals();
            RejectPending();
            Socket.Dispose();
        }
    }
}
