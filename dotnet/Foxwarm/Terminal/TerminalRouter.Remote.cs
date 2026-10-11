using System.Text;
using System.Text.Json.Nodes;
using System.Net.WebSockets;
using Foxwarm.Code;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using TerminalClient = Foxwarm.Terminal.TerminalRegistry.TerminalRecord.TerminalClient;

namespace Foxwarm.Terminal;

internal sealed partial class TerminalRouter
{
    private sealed class RemoteTerminal : ITerminalStreamTarget
    {
        private readonly TerminalRouter router;
        private readonly object gate = new();
        private readonly SemaphoreSlim attachment = new(1, 1);
        private readonly List<TerminalClient> clients = [];
        private readonly Dictionary<string, PendingControl> controls = new(StringComparer.Ordinal);
        private sealed record PendingControl(TerminalClient Owner, NodeConnectionHub.ServiceTarget Target, Timer Timeout);
        private NodeConnectionHub.ServiceTarget target;
        private JsonObject descriptor;
        private string backlog = "";
        private bool attached;
        private bool connectionLost;
        private TerminalClient? controlOwner;
        internal string Id { get; }
        internal string NodeId { get; }

        internal RemoteTerminal(TerminalRouter router, NodeConnectionHub.ServiceTarget target, JsonObject descriptor)
        {
            this.router = router;
            this.target = target;
            this.descriptor = descriptor;
            Id = descriptor["id"]!.GetValue<string>();
            NodeId = target.NodeId;
        }

        internal JsonObject Describe() { lock (gate) return (JsonObject)descriptor.DeepClone(); }

        internal void Refresh(NodeConnectionHub.ServiceTarget newTarget, JsonObject value)
        {
            if (newTarget.NodeId != NodeId || SessionWait.Text(value["id"]) != Id)
                throw new CodeServiceException("NodeServiceError", "Conflicting remote terminal identity.", 502);
            lock (gate)
            {
                // Discovery never transfers an old stream or helper callback to a replacement connection.
                if (newTarget.ConnectionId != target.ConnectionId && (attached || clients.Count > 0))
                    throw new CodeServiceException("NodeUnavailable", "The previous terminal connection is still detaching.", 503);
                target = newTarget;
                descriptor = value;
            }
        }

        internal async Task AttachAsync(WebSocket socket, CancellationToken token, bool codeControl)
        {
            await using var client = new TerminalClient(socket, this, token, codeControl);
            try
            {
                await attachment.WaitAsync(token);
                try
                {
                    bool needsAttach;
                    lock (gate) needsAttach = !attached;
                    if (needsAttach)
                    {
                        var endpoint = router.nodes.Service(NodeId, "vscode-pty");
                        lock (gate) { target = endpoint; connectionLost = false; }
                        await router.nodes.RequestServiceAsync(endpoint, "attach", new() { ["terminalId"] = Id }, token, response =>
                        {
                            var value = DescribeRemote(NodeId, response["terminal"]);
                            if (SessionWait.Text(value["id"]) != Id) throw new CodeServiceException("NodeServiceError", "Remote attach returned a different terminal.", 502);
                            var buffer = SessionWait.Text(response["backlog"]) ?? "";
                            lock (gate)
                            {
                                if (connectionLost || target != endpoint) throw new CodeServiceException("NodeUnavailable", "Node disconnected during attachment.", 503);
                                descriptor = value;
                                backlog = buffer.Length <= TerminalRegistry.BacklogLimit ? buffer : buffer[^TerminalRegistry.BacklogLimit..];
                                attached = true;
                                AddClientLocked(client, codeControl);
                            }
                        });
                    }
                    else
                    {
                        lock (gate)
                        {
                            if (!attached || connectionLost) throw new CodeServiceException("NodeUnavailable", "Node disconnected during attachment.", 503);
                            AddClientLocked(client, codeControl);
                        }
                    }
                }
                finally { attachment.Release(); }
                await client.StartAsync();
            }
            finally { await DetachAsync(client); }
        }

        private void AddClientLocked(TerminalClient client, bool codeControl)
        {
            client.Enqueue(new { type = "ready", terminal = descriptor.DeepClone(), backlog });
            clients.Add(client);
            // A second opt-in attachment observes output but cannot take over an existing control owner.
            if (codeControl && controlOwner is null) controlOwner = client;
        }

        public void Detach(TerminalClient client) => _ = DetachAsync(client);

        private async Task DetachAsync(TerminalClient client)
        {
            await attachment.WaitAsync();
            try
            {
                List<(string Id, PendingControl Pending)> rejected;
                bool detach;
                NodeConnectionHub.ServiceTarget endpoint;
                lock (gate)
                {
                    if (!clients.Remove(client)) return;
                    rejected = controls.Where(p => p.Value.Owner == client).Select(p => (p.Key, p.Value)).ToList();
                    foreach (var item in rejected) { controls.Remove(item.Id); item.Pending.Timeout.Dispose(); }
                    if (controlOwner == client) controlOwner = clients.FirstOrDefault(c => c.IsControlOwner);
                    detach = attached && clients.Count == 0;
                    if (detach) attached = false;
                    endpoint = target;
                }
                foreach (var item in rejected)
                    await TryCommandAsync(item.Pending.Target, "code-result", new() { ["requestId"] = item.Id, ["ok"] = false, ["error"] = "The Code terminal detached before handling the request." });
                if (detach) await TryCommandAsync(endpoint, "detach", new() { ["terminalId"] = Id });
            }
            finally { attachment.Release(); }
        }

        private async Task TryCommandAsync(NodeConnectionHub.ServiceTarget endpoint, string operation, JsonObject args)
        {
            try { await router.nodes.CommandServiceAsync(endpoint, operation, args, router.lifetime); }
            catch (Exception error) when (error is CodeServiceException or IOException or OperationCanceledException or WebSocketException) { }
        }

        public Task InputAsync(string text)
        {
            if (Encoding.UTF8.GetByteCount(text) > 64 * 1024) throw new InvalidDataException("Terminal input is too large.");
            NodeConnectionHub.ServiceTarget endpoint;
            lock (gate) endpoint = target;
            return router.nodes.CommandServiceAsync(endpoint, "input", new() { ["terminalId"] = Id, ["data"] = text }, router.lifetime);
        }

        public async Task ResizeAsync(int cols, int rows)
        {
            cols = Math.Max(20, cols); rows = Math.Max(5, rows);
            NodeConnectionHub.ServiceTarget endpoint;
            lock (gate) endpoint = target;
            await router.nodes.CommandServiceAsync(endpoint, "resize", new() { ["terminalId"] = Id, ["cols"] = cols, ["rows"] = rows }, router.lifetime);
            lock (gate) { descriptor["cols"] = cols; descriptor["rows"] = rows; }
        }

        public Task CloseAsync(string reason) => router.CloseAsync(Id, reason, router.lifetime);

        public void ResolveControl(TerminalClient client, string requestId, bool ok, string? message, string? error)
        {
            PendingControl pending;
            lock (gate)
            {
                if (!controls.TryGetValue(requestId, out pending!) || pending.Owner != client || controlOwner != client)
                    throw new InvalidDataException("Unknown or unauthorized terminal control response.");
                controls.Remove(requestId);
                pending.Timeout.Dispose();
            }
            _ = TryCommandAsync(pending.Target, "code-result", new() { ["requestId"] = requestId, ["ok"] = ok, ["message"] = message, ["error"] = error });
        }

        internal void Receive(NodeConnectionHub.ServiceEvent value)
        {
            // Hub admission already binds the authenticated connection. Never copy peer-supplied identity or arbitrary fields.
            string? rejectId = null;
            lock (gate)
            {
                if (target != value.Target) return;
                var payload = value.Event;
                var type = SessionWait.Text(payload["type"]);
                if (type == "code-request")
                {
                    var id = SessionWait.Text(payload["requestId"]);
                    if (id is not { Length: > 0 and <= 256 } || controls.ContainsKey(id)) return;
                    var request = payload["request"] as JsonObject;
                    var kind = SessionWait.Text(request?["kind"]);
                    var path = SessionWait.Text(request?["path"]);
                    if (controlOwner is null || !attached || kind is not ("openFile" or "addFolder") || path is null || !path.StartsWith('/') || path.Contains('\0') || Encoding.UTF8.GetByteCount(request!.ToJsonString()) > 64 * 1024)
                        rejectId = id;
                    else
                    {
                        var forwarded = new JsonObject { ["kind"] = kind, ["nodeId"] = NodeId, ["path"] = path };
                        foreach (var key in new[] { "startLine", "startColumn" })
                            if (request!.ContainsKey(key))
                            {
                                if (SessionWait.Number(request[key]) is not double number || number < 1 || number > 9007199254740991 || number != Math.Truncate(number)) { rejectId = id; break; }
                                forwarded[key] = request[key]!.DeepClone();
                            }
                        if (rejectId is null)
                        {
                            var timeout = new Timer(_ => { lock (gate) if (controls.Remove(id, out var entry)) entry.Timeout.Dispose(); }, null, TimeSpan.FromSeconds(21), Timeout.InfiniteTimeSpan);
                            controls[id] = new(controlOwner, target, timeout);
                            controlOwner.Enqueue(new { type = "control", requestId = id, command = "open", request = forwarded });
                        }
                    }
                }
                else if (type == "output" && SessionWait.Text(payload["data"]) is string text)
                {
                    // CLI may split arbitrary process output; keep the same capped recent-output buffer as Source.
                    backlog += text;
                    if (backlog.Length > TerminalRegistry.BacklogLimit) backlog = backlog[^TerminalRegistry.BacklogLimit..];
                    foreach (var client in clients) client.Enqueue(new { type = "output", data = text });
                }
                else if (type == "exit")
                {
                    var exit = SessionWait.Number(payload["exitCode"]);
                    if (exit is null || exit != Math.Truncate(exit.Value)) return;
                    foreach (var client in clients) client.Enqueue(new { type = "exit", exitCode = exit.Value, signal = payload["signal"]?.DeepClone(), cwd = SessionWait.Text(payload["cwd"]) });
                    _ = Task.Run(() => router.ForgetAsync(this, null));
                }
                else if (type == "error")
                    foreach (var client in clients) client.Enqueue(new { type = "error", message = SessionWait.Text(payload["error"]?["message"]) ?? "Remote terminal operation failed." });
            }
            if (rejectId is not null)
                _ = Task.Run(() => TryCommandAsync(value.Target, "code-result", new() { ["requestId"] = rejectId, ["ok"] = false, ["error"] = "No Code terminal is attached to handle this request." }));
        }

        internal void ConnectionLost(Guid connection, string reason)
        {
            TerminalClient[] snapshot;
            lock (gate)
            {
                if (target.ConnectionId != connection) return;
                connectionLost = true;
                snapshot = ResetLocked();
                foreach (var client in snapshot) client.Enqueue(new { type = "error", message = reason });
            }
            foreach (var client in snapshot) _ = client.FinishAsync();
        }

        private TerminalClient[] ResetLocked()
        {
            attached = false;
            controlOwner = null;
            foreach (var entry in controls.Values) entry.Timeout.Dispose();
            controls.Clear();
            var snapshot = clients.ToArray();
            clients.Clear();
            return snapshot;
        }

        internal async Task DisconnectAsync(string? error)
        {
            TerminalClient[] snapshot;
            lock (gate)
            {
                snapshot = ResetLocked();
                if (error is not null) foreach (var client in snapshot) client.Enqueue(new { type = "error", message = error });
            }
            await Task.WhenAll(snapshot.Select(c => c.FinishAsync()));
        }

        internal async Task ShutdownAsync()
        {
            NodeConnectionHub.ServiceTarget endpoint;
            bool detach;
            lock (gate) { endpoint = target; detach = attached; }
            if (detach) await TryCommandAsync(endpoint, "detach", new() { ["terminalId"] = Id });
            await DisconnectAsync("Terminal transport closed.");
        }
    }
}
