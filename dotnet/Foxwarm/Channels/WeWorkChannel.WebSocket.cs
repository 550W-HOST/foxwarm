using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel
{
    private sealed record Pending(string Command, TaskCompletionSource<JsonObject> Completion);
    private readonly object socketGate = new();
    private ClientWebSocket? socket;
    private readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task> requestChains = new(StringComparer.Ordinal);
    // ClientWebSocket permits one concurrent send and one receive; different req_ids may await ACKs concurrently.
    private readonly SemaphoreSlim wireSend = new(1);

    private void CloseSocket()
    {
        ClientWebSocket? current;
        lock (socketGate)
            current = socket;
        if (current is not null)
            _ = ObserveAsync(CloseOutputAsync(current));
    }

    private static async Task CloseOutputAsync(ClientWebSocket current)
    {
        if (current.State is WebSocketState.Open or WebSocketState.CloseReceived)
            await current.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
    }

    private async Task ConnectionLoopAsync()
    {
        if (!Nonempty(Text(websocketConfig["botId"])) || !Nonempty(Text(websocketConfig["secret"])))
            return;
        while (!stopped)
        {
            using var current = new ClientWebSocket();
            current.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
            lock (socketGate)
                socket = current;
            using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            try
            {
                await current.ConnectAsync(new Uri(Nonempty(Text(websocketConfig["url"])) ? Text(websocketConfig["url"]) : "wss://openws.work.weixin.qq.com"), lifetime.Token);
                // Do not await subscription or callbacks on the receive loop: their ACKs use that same loop.
                _ = ObserveAsync(SubscribeAsync(current));
                _ = ObserveAsync(HeartbeatAsync(heartbeatStop.Token));
                var buffer = new byte[16384];
                while (!stopped && current.State is WebSocketState.Open or WebSocketState.CloseSent)
                {
                    using var message = new MemoryStream();
                    WebSocketReceiveResult frame;
                    do
                    {
                        frame = await current.ReceiveAsync(new ArraySegment<byte>(buffer), lifetime.Token);
                        if (frame.MessageType == WebSocketMessageType.Close)
                        {
                            await CloseOutputAsync(current);
                            throw new IOException($"WeWork AIBot WebSocket closed ({(int?)frame.CloseStatus ?? 1005})");
                        }
                        // The reference ws client uses its default 100 MiB decoded-message limit.
                        if (message.Length + frame.Count > 100L * 1024 * 1024)
                        {
                            await current.CloseOutputAsync(WebSocketCloseStatus.MessageTooBig, "", CancellationToken.None);
                            throw new IOException("WeWork AIBot WebSocket message exceeds the transport limit");
                        }
                        message.Write(buffer, 0, frame.Count);
                    } while (!frame.EndOfMessage);
                    // Decode only complete messages, including split UTF-8 scalars and binary ws payloads.
                    _ = ObserveAsync(HandleSocketMessageAsync(Encoding.UTF8.GetString(message.ToArray())));
                }
            }
            catch (OperationCanceledException) when (stopped) { }
            catch (Exception error) { log(error); }
            finally
            {
                heartbeatStop.Cancel();
                lock (socketGate)
                    if (ReferenceEquals(socket, current))
                        socket = null;
                RejectPending(new IOException("WeWork AIBot WebSocket closed"));
            }
            if (!stopped)
                await delay(TimeSpan.FromMilliseconds(SessionWait.Number(websocketConfig["reconnectMs"]) is { } reconnect && reconnect != 0 ? reconnect : 5000), lifetime.Token);
        }
    }

    private async Task SubscribeAsync(ClientWebSocket current)
    {
        try
        {
            await SendCommandAsync("aibot_subscribe", new JsonObject
            {
                ["bot_id"] = Text(websocketConfig["botId"]), ["secret"] = Text(websocketConfig["secret"]),
            }, null, CancellationToken.None);
        }
        catch
        {
            await CloseOutputAsync(current);
            throw;
        }
    }

    private async Task HeartbeatAsync(CancellationToken token)
    {
        var interval = TimeSpan.FromMilliseconds(SessionWait.Number(websocketConfig["heartbeatMs"]) is { } ms && ms != 0 ? ms : 30000);
        using var timer = new PeriodicTimer(interval);
        try
        {
            while (await timer.WaitForNextTickAsync(token))
                _ = ObserveAsync(SendCommandAsync("ping", null, null, CancellationToken.None));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private void RejectPending(Exception error)
    {
        lock (socketGate)
        {
            requestChains.Clear();
            foreach (var value in pending.Values)
                value.Completion.TrySetException(error);
            pending.Clear();
        }
    }

    private Task<JsonObject> SendCommandAsync(string command, JsonObject? body, string? requestId, CancellationToken token)
    {
        var reqId = requestId ?? Guid.NewGuid().ToString();
        lock (socketGate)
        {
            var previous = requestChains.GetValueOrDefault(reqId) ?? Task.CompletedTask;
            var run = RunAfterAsync(previous, command, body, reqId, token);
            requestChains[reqId] = run;
            _ = RemoveChainAsync(run, reqId);
            return run;
        }
    }

    private async Task RemoveChainAsync(Task run, string reqId)
    {
        try { await run; } catch { }
        lock (socketGate)
            if (requestChains.GetValueOrDefault(reqId) == run)
                requestChains.Remove(reqId);
    }

    private async Task<JsonObject> RunAfterAsync(Task previous, string command, JsonObject? body, string reqId, CancellationToken token)
    {
        try { await previous; } catch { }
        // Source queues even the first command in a promise continuation. Yield outside the map mutation.
        await Task.Yield();
        ClientWebSocket current;
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var request = new Pending(command, completion);
        lock (socketGate)
        {
            current = !stopped && socket is { State: WebSocketState.Open } connected ? connected
                : throw new IOException("WeWork AIBot WebSocket is not connected");
            pending[reqId] = request;
        }
        var payload = new JsonObject { ["cmd"] = command, ["headers"] = new JsonObject { ["req_id"] = reqId } };
        if (body is not null)
            payload["body"] = body.DeepClone();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var registration = timeout.Token.Register(() => completion.TrySetException(token.IsCancellationRequested
            ? new OperationCanceledException(token)
            : new IOException($"WeWork AIBot command {command} timed out waiting for ack")));
        try
        {
            await wireSend.WaitAsync(token);
            try
            {
                await current.SendAsync(Encoding.UTF8.GetBytes(payload.ToJsonString()), WebSocketMessageType.Text, true, token);
            }
            finally { wireSend.Release(); }
            return await completion.Task;
        }
        finally
        {
            lock (socketGate)
                if (pending.GetValueOrDefault(reqId) == request)
                    pending.Remove(reqId);
        }
    }

    private async Task HandleSocketMessageAsync(string raw)
    {
        JsonObject? payload;
        try { payload = JsonNode.Parse(raw) as JsonObject; }
        catch (System.Text.Json.JsonException) { return; }
        if (payload is null)
            return;
        var reqId = Text(payload["headers"]?["req_id"]);
        Pending? ack;
        lock (socketGate)
        {
            ack = pending.GetValueOrDefault(reqId);
            if (ack is not null)
                pending.Remove(reqId);
        }
        if (ack is not null)
        {
            Console.WriteLine("WeWork ACK: " + new JsonObject
            {
                ["channelId"] = id, ["reqId"] = reqId, ["command"] = ack.Command,
                ["errcode"] = payload["errcode"]?.DeepClone(),
            }.ToJsonString());
            if (payload.ContainsKey("errcode") && !Zero(payload["errcode"]))
                ack.Completion.TrySetException(new IOException($"WeWork AIBot command {ack.Command} failed: {Text(payload["errmsg"])} (code: {payload["errcode"]})"));
            else
                ack.Completion.TrySetResult(payload);
            return;
        }
        if (Text(payload["cmd"]) == "aibot_msg_callback")
            await ProcessInboundAsync(payload["body"] as JsonObject, new("websocket", ReqId: Nonempty(reqId) ? reqId : Guid.NewGuid().ToString()), true);
        else if (Text(payload["cmd"]) == "aibot_event_callback" && Text(payload["body"]?["event"]?["eventtype"]) == "disconnected_event")
            CloseSocket();
    }
}
