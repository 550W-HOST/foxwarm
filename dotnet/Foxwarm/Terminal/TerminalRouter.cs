using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using TerminalClient = Foxwarm.Terminal.TerminalRegistry.TerminalRecord.TerminalClient;

namespace Foxwarm.Terminal;

// A browser stream sink, not a remote operating-system or process abstraction.
internal interface ITerminalStreamTarget
{
    Task InputAsync(string text);
    Task ResizeAsync(int cols, int rows);
    Task CloseAsync(string reason);
    void Detach(TerminalClient client);
    void ResolveControl(
        TerminalClient client,
        string requestId,
        bool ok,
        string? message,
        string? error
    );
}

internal sealed partial class TerminalRouter : IAsyncDisposable
{
    private readonly TerminalRegistry local;
    private readonly NodeConnectionHub nodes;
    private readonly ConcurrentDictionary<string, RemoteTerminal> remote = new(
        StringComparer.Ordinal
    );
    private readonly CancellationTokenSource stopping = new();
    private readonly CancellationToken lifetime;

    internal TerminalRouter(TerminalRegistry local, NodeConnectionHub nodes)
    {
        this.local = local;
        this.nodes = nodes;
        lifetime = stopping.Token;
        nodes.ServiceReceived += OnEvent;
        nodes.ServicesDisconnected += OnDisconnect;
    }

    internal bool Supported =>
        TerminalRegistry.IsSupported || nodes.Services("vscode-pty").Length > 0;

    internal async Task<JsonObject> CreateAsync(
        string nodeId,
        string cwd,
        int cols,
        int rows,
        CancellationToken token
    )
    {
        if (nodeId == "master")
            return (await local.CreateAsync(cwd, cols, rows, token)).Describe();
        var target = nodes.Service(nodeId, "vscode-pty");
        var result = await nodes.RequestServiceAsync(
            target,
            "create",
            new()
            {
                ["cwd"] = cwd,
                ["cols"] = cols,
                ["rows"] = rows,
            },
            token
        );
        return Register(target, result["terminal"]).Describe();
    }

    private RemoteTerminal Register(NodeConnectionHub.ServiceTarget target, JsonNode? value)
    {
        var descriptor = DescribeRemote(target.NodeId, value);
        var id = descriptor["id"]!.GetValue<string>();
        if (local.TryGet(id, out _))
            throw new CodeServiceException(
                "NodeServiceError",
                "Remote terminal identity conflicts with a local terminal.",
                502
            );
        var record = remote.GetOrAdd(id, _ => new RemoteTerminal(this, target, descriptor));
        record.Refresh(target, descriptor);
        return record;
    }

    private static JsonObject DescribeRemote(string nodeId, JsonNode? value)
    {
        if (
            value is not JsonObject data
            || SessionWait.Text(data["id"]) is not { Length: > 0 and <= 256 } id
        )
            throw new CodeServiceException(
                "NodeServiceError",
                "Invalid remote terminal descriptor.",
                502
            );
        var result = new JsonObject { ["id"] = id, ["nodeId"] = nodeId };
        foreach (var key in new[] { "shell", "cwd" })
            result[key] = SessionWait.Text(data[key]) ?? (key == "cwd" ? "/" : "");
        foreach (var key in new[] { "cols", "rows", "createdAt", "pid" })
        {
            var number = SessionWait.Number(data[key]);
            if (number is null || !double.IsFinite(number.Value))
                throw new CodeServiceException(
                    "NodeServiceError",
                    "Invalid remote terminal metadata.",
                    502
                );
            result[key] = data[key]!.DeepClone();
        }
        return result;
    }

    internal async Task<IReadOnlyList<JsonObject>> ListAsync(CancellationToken token)
    {
        var result = local.List().ToList();
        foreach (var target in nodes.Services("vscode-pty"))
        {
            try
            {
                var response = await nodes.RequestServiceAsync(target, "list", new(), token);
                if (response["terminals"] is not JsonArray values)
                    throw new CodeServiceException(
                        "NodeServiceError",
                        "Invalid terminal list.",
                        502
                    );
                foreach (var value in values)
                {
                    var record = Register(target, value);
                    result.Add(record.Describe());
                }
            }
            catch (CodeServiceException) when (!token.IsCancellationRequested)
            {
                // Other Nodes and local terminals remain listable; no offline proxy is returned as a live process.
            }
        }
        return result.OrderByDescending(item => SessionWait.Number(item["createdAt"])).ToArray();
    }

    private async Task<RemoteTerminal?> FindAsync(string id, CancellationToken token)
    {
        if (remote.TryGetValue(id, out var record))
            return record;
        await ListAsync(token);
        return remote.GetValueOrDefault(id);
    }

    internal async Task<JsonObject?> GetAsync(string id, CancellationToken token)
    {
        if (local.TryGet(id, out var localRecord))
            return localRecord!.Describe();
        var record = await FindAsync(id, token);
        if (record is null)
            return null;
        var target = nodes.Service(record.NodeId, "vscode-pty");
        var result = await nodes.RequestServiceAsync(
            target,
            "get",
            new() { ["terminalId"] = id },
            token
        );
        if (result["terminal"] is null)
        {
            await ForgetAsync(record, "Remote terminal is no longer available.");
            return null;
        }
        return Register(target, result["terminal"]).Describe();
    }

    internal async Task AttachAsync(
        string id,
        WebSocket socket,
        CancellationToken token,
        bool codeControl
    )
    {
        if (local.TryGet(id, out var record))
        {
            await using var client = await record!.AttachAsync(socket, token, codeControl);
            return;
        }
        var remoteRecord =
            await FindAsync(id, token)
            ?? throw new CodeServiceException("FileNotFound", "Terminal not found.");
        await remoteRecord.AttachAsync(socket, token, codeControl);
    }

    internal async Task CloseAsync(string id, string reason, CancellationToken token)
    {
        if (local.TryGet(id, out _))
        {
            await local.CloseAsync(id, reason);
            return;
        }
        var record = await FindAsync(id, token);
        if (record is null)
            return;
        var target = nodes.Service(record.NodeId, "vscode-pty");
        await nodes.RequestServiceAsync(
            target,
            "close",
            new() { ["terminalId"] = id, ["reason"] = reason },
            token
        );
        await ForgetAsync(record, null);
    }

    private async Task ForgetAsync(RemoteTerminal record, string? error)
    {
        remote.TryRemove(new KeyValuePair<string, RemoteTerminal>(record.Id, record));
        await record.DisconnectAsync(error);
    }

    private void OnEvent(NodeConnectionHub.ServiceEvent value)
    {
        if (
            value.Target.Service != "vscode-pty"
            || SessionWait.Text(value.Event["terminalId"]) is not string id
            || !remote.TryGetValue(id, out var record)
        )
            return;
        record.Receive(value);
    }

    private void OnDisconnect(Guid connection, string reason)
    {
        foreach (var record in remote.Values)
            record.ConnectionLost(connection, reason);
    }

    public async ValueTask DisposeAsync()
    {
        nodes.ServiceReceived -= OnEvent;
        nodes.ServicesDisconnected -= OnDisconnect;
        stopping.Cancel();
        foreach (var record in remote.Values)
            await record.ShutdownAsync();
        remote.Clear();
        stopping.Dispose();
    }
}
