using System.Net.WebSockets;
using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed record NodeClientOptions(
    string Host,
    string? NodeId,
    string? PairingToken,
    string? AuthToken,
    string? CredentialsFile
);

internal sealed class NodeClient
{
    private readonly NodeClientOptions options;
    private readonly NodeFileTools tools;
    private readonly NodeFileTransfer transfers;
    private readonly string requestedName;
    private string? nodeId;
    private string? authToken;
    private bool initialCredentialsPending;
    private bool pairingRejected;
    private bool incompatible;
    private bool immediateReconnect;

    internal NodeClient(NodeClientOptions options, NodePaths paths)
    {
        this.options = options;
        tools = new NodeFileTools(paths);
        transfers = new NodeFileTransfer(paths);
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
                await connection.Send(
                    new JsonObject
                    {
                        ["type"] = Authenticated ? "node_register" : "pair_request",
                        ["nodeType"] = "cli-node",
                        ["capabilities"] = Capabilities(),
                        ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                        ["requestedName"] = Authenticated ? null : requestedName,
                    }
                );
                await Receive(connection, stop);
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
                            ValidateProtocol(frame);
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
                        Log("registered", "nodeId=" + nodeId);
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
                    case "tool_call":
                    case "file_read_request":
                    case "file_write_request":
                        // Effects outlive a lost reply, but can only reply on their originating connection.
                        _ = Task.Run(() => Dispatch(connection, frame));
                        break;
                    case "error":
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

    private async Task Dispatch(Connection connection, JsonObject frame)
    {
        var type = Text(frame, "type");
        try
        {
            var agent =
                Text(frame, "agentName") is { } value && !string.IsNullOrWhiteSpace(value)
                    ? value
                    : "main";
            JsonObject response;
            if (type == "tool_call")
            {
                if (frame.ContainsKey("owner"))
                    throw new InvalidDataException(
                        "External tool owners are unavailable on this Node."
                    );
                var result = await tools.Execute(
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
            await connection.Send(response);
        }
    }

    internal static JsonObject FileError(Exception error)
    {
        string? code = error switch
        {
            NodeFileException native => native.Code,
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
                    code is null || error.Message.StartsWith(code + ":", StringComparison.Ordinal)
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

    internal static JsonObject Capabilities()
    {
        using var stream = typeof(NodeClient).Assembly.GetManifestResourceStream(
            "Foxwarm.CliNode.Capabilities.json"
        )!;
        return (JsonObject)JsonNode.Parse(stream)!;
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

    private static void Log(string state, string detail)
    {
        if (Environment.GetEnvironmentVariable("FOXWARM_NO_CONSOLE_LOG") != "1")
            Console.Error.WriteLine("[" + state + "] " + detail);
    }

    private sealed class Connection : IDisposable
    {
        internal ClientWebSocket Socket { get; } = new();
        private readonly SemaphoreSlim send = new(1, 1);

        internal async Task Send(JsonObject frame)
        {
            await send.WaitAsync();
            try
            {
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
                ) { }
            finally
            {
                send.Release();
            }
        }

        public void Dispose() => Socket.Dispose();
    }
}
