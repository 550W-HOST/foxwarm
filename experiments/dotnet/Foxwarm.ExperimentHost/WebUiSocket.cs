using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Foxwarm.ExperimentHost;

internal static class WebUiSocket
{
    private const int MaxMessageBytes = 64 * 1024;

    public static async Task RunAsync(WebSocket socket, HostSessions sessions, CancellationToken stopped)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stopped);
        using var sendGate = new SemaphoreSlim(1);
        var subscriptions = new Dictionary<string, (HostedSession Session, long ListenerId, ChannelReader<JsonObject> Reader)>();
        var pumps = new List<Task>();
        long revision = 0;
        try
        {
            await Send(new JsonObject { ["type"] = "connected" });
            while (socket.State == WebSocketState.Open && !stopped.IsCancellationRequested)
            {
                JsonObject? input;
                try { input = await Receive(socket, lifetime.Token); }
                catch (Exception error) when (error is FormatException or System.Text.Json.JsonException)
                {
                    await ProtocolError("Invalid subscription frame.");
                    break;
                }
                if (input is null) break;
                if (input["type"] is not JsonValue type || !type.TryGetValue<string>(out var messageType)
                    || messageType != "set-subscriptions"
                    || !ReadRevision(input["revision"], out var requested) || requested <= revision
                    || input["sessionListActive"] is not JsonValue listFlag
                    || !listFlag.TryGetValue<bool>(out var listActive) || listActive
                    || input["sessionListIds"] is not JsonArray list || list.Count != 0
                    || input["sessionIds"] is not JsonArray ids || ids.Count > 16
                    || ids.Any(value => value is not JsonValue scalar || !scalar.TryGetValue<string>(out var id) || !HostSessions.IsOwnedId(id)))
                {
                    await ProtocolError("Only valid existing experimental Session subscriptions are supported.");
                    break;
                }
                var requestedIds = ids.Select(value => value!.GetValue<string>()).Distinct(StringComparer.Ordinal).ToArray();
                if (requestedIds.Any(id => sessions.Find(id) is null))
                {
                    await ProtocolError("Unknown Session subscription.");
                    break;
                }
                foreach (var (_, subscriber) in subscriptions)
                    subscriber.Session.Unsubscribe(subscriber.ListenerId);
                subscriptions.Clear();
                revision = requested;
                foreach (var id in requestedIds)
                {
                    var hosted = sessions.Find(id)!;
                    var (listenerId, reader) = hosted.Subscribe();
                    subscriptions[id] = (hosted, listenerId, reader);
                }
                var map = new JsonObject();
                foreach (var id in requestedIds) map[id] = id;
                await Send(new JsonObject
                {
                    ["type"] = "subscriptions-accepted", ["revision"] = revision,
                    ["sessionListResolutions"] = new JsonObject(), ["sessionResolutions"] = map
                });
                // All listeners are installed before these exact-owner snapshots are taken.
                // Concurrent events remain in their channels until the snapshots are sent.
                foreach (var id in requestedIds)
                {
                    var session = subscriptions[id].Session;
                    await Send(new JsonObject { ["type"] = "session-state", ["sessionId"] = id,
                        ["session"] = session.WebUiState() });
                    await Send(session.DraftSnapshot());
                }
                foreach (var id in requestedIds)
                    while (subscriptions[id].Reader.TryRead(out var buffered))
                        if (Filter(buffered)) await Send(ToWire(buffered));
                await Send(new JsonObject { ["type"] = "subscriptions-applied", ["revision"] = revision });
                var activeRevision = revision;
                foreach (var id in requestedIds)
                {
                    var captured = subscriptions[id];
                    pumps.Add(Task.Run(async () =>
                    {
                        await foreach (var entry in captured.Reader.ReadAllAsync(lifetime.Token))
                        {
                            if (activeRevision != Interlocked.Read(ref revision)) return;
                            if (Filter(entry)) await Send(ToWire(entry));
                        }
                    }, lifetime.Token));
                }
            }
        }
        catch (OperationCanceledException) when (stopped.IsCancellationRequested) { }
        catch (WebSocketException) { }
        finally
        {
            lifetime.Cancel();
            foreach (var (_, subscriber) in subscriptions) subscriber.Session.Unsubscribe(subscriber.ListenerId);
            try { await Task.WhenAll(pumps); } catch (OperationCanceledException) { }
            if (socket.State == WebSocketState.Open)
                try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Subscription closed", CancellationToken.None); }
                catch (WebSocketException) { }
        }

        async Task Send(JsonObject data)
        {
            var bytes = Encoding.UTF8.GetBytes(data.ToJsonString());
            await sendGate.WaitAsync(lifetime.Token);
            try
            {
                if (socket.State == WebSocketState.Open)
                    await socket.SendAsync(bytes, WebSocketMessageType.Text, true, lifetime.Token);
            }
            finally { sendGate.Release(); }
        }

        async Task ProtocolError(string message)
        {
            await Send(new JsonObject { ["type"] = "protocol-error", ["message"] = message });
            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, message, lifetime.Token);
        }
    }

    private static bool Filter(JsonObject eventNode) =>
        eventNode["type"]?.GetValue<string>() is "message" or "session-event" or "model-stream-snapshot" or "webui-session-state";

    private static JsonObject ToWire(JsonObject input)
    {
        var clone = (JsonObject)input.DeepClone();
        if (clone["type"]?.GetValue<string>() == "webui-session-state") clone["type"] = "session-state";
        return clone;
    }

    private static bool ReadRevision(JsonNode? node, out long value)
    {
        value = 0;
        return node is JsonValue scalar && scalar.TryGetValue<long>(out value) && value > 0 && value <= int.MaxValue;
    }

    private static async Task<JsonObject?> Receive(WebSocket socket, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            var next = await socket.ReceiveAsync(buffer, cancellationToken);
            if (next.MessageType == WebSocketMessageType.Close) return null;
            if (next.MessageType != WebSocketMessageType.Text || output.Length + next.Count > MaxMessageBytes)
                throw new FormatException("Invalid WebUI subscription size or type.");
            output.Write(buffer, 0, next.Count);
            if (next.EndOfMessage) break;
        }
        return JsonNode.Parse(output.ToArray()) as JsonObject
            ?? throw new FormatException("Expected a subscription object.");
    }
}
