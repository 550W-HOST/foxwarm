using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel
{
    private sealed class Connection
    {
        internal readonly ClientWebSocket Socket = new();
        // A successor never shares an old connection's blocked writer.
        internal readonly SemaphoreSlim WireSend = new(1);
        internal readonly CancellationTokenSource Ended = new();
        internal int Closing;
    }

    private sealed record Pending(Connection Connection, string Command, TaskCompletionSource<JsonObject> Completion);

    private readonly object socketGate = new();
    private Connection? socket;
    private readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task> requestChains = new(StringComparer.Ordinal);

    private void CloseSocket()
    {
        Connection? current;
        lock (socketGate)
            current = socket;
        if (current is not null)
            _ = ObserveAsync(CloseOutputAsync(current));
    }

    private async Task CloseOutputAsync(Connection current, WebSocketCloseStatus status = WebSocketCloseStatus.NormalClosure)
    {
        if (Interlocked.Exchange(ref current.Closing, 1) != 0)
            return;
        // Like ws.close(), allow the handshake, but retire this exact socket after 30 seconds.
        _ = ObserveAsync(ForceCloseAfterAsync(current));
        await current.WireSend.WaitAsync(current.Ended.Token);
        try
        {
            if (current.Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await current.Socket.CloseOutputAsync(status, "", current.Ended.Token);
        }
        finally
        {
            current.WireSend.Release();
        }
    }

    private static async Task ForceCloseAfterAsync(Connection current)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), current.Ended.Token);
            current.Socket.Abort();
        }
        catch (OperationCanceledException) when (current.Ended.IsCancellationRequested) { }
    }

    private async Task ConnectionLoopAsync()
    {
        if (!Nonempty(Text(websocketConfig["botId"])) || !Nonempty(Text(websocketConfig["secret"])))
            return;
        while (!stopped)
        {
            var connection = new Connection();
            using var current = connection.Socket;
            current.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
            lock (socketGate)
                socket = connection;
            using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(
                lifetime.Token
            );
            try
            {
                await current.ConnectAsync(
                    new Uri(
                        Nonempty(Text(websocketConfig["url"]))
                            ? Text(websocketConfig["url"])
                            : "wss://openws.work.weixin.qq.com"
                    ),
                    lifetime.Token
                );
                // Do not await subscription or callbacks on the receive loop: their ACKs use that same loop.
                _ = ObserveAsync(SubscribeAsync(connection));
                _ = ObserveAsync(HeartbeatAsync(heartbeatStop.Token));
                var buffer = new byte[16384];
                while (!stopped && current.State is WebSocketState.Open or WebSocketState.CloseSent)
                {
                    using var message = new MemoryStream();
                    WebSocketReceiveResult frame;
                    do
                    {
                        frame = await current.ReceiveAsync(
                            new ArraySegment<byte>(buffer),
                            lifetime.Token
                        );
                        if (frame.MessageType == WebSocketMessageType.Close)
                        {
                            await CloseOutputAsync(connection);
                            throw new IOException(
                                $"WeWork AIBot WebSocket closed ({(int?)frame.CloseStatus ?? 1005})"
                            );
                        }
                        // The reference ws client uses its default 100 MiB decoded-message limit.
                        if (message.Length + frame.Count > 100L * 1024 * 1024)
                        {
                            await CloseOutputAsync(connection, WebSocketCloseStatus.MessageTooBig);
                            throw new IOException(
                                "WeWork AIBot WebSocket message exceeds the transport limit"
                            );
                        }
                        message.Write(buffer, 0, frame.Count);
                    } while (!frame.EndOfMessage);
                    // Decode only complete messages, including split UTF-8 scalars and binary ws payloads.
                    _ = ObserveAsync(
                        HandleSocketMessageAsync(connection, Encoding.UTF8.GetString(message.ToArray()))
                    );
                }
            }
            catch (OperationCanceledException) when (stopped) { }
            catch (Exception error)
            {
                log(error);
            }
            finally
            {
                heartbeatStop.Cancel();
                connection.Ended.Cancel();
                lock (socketGate)
                    if (ReferenceEquals(socket, connection))
                        socket = null;
                RejectPending(new IOException("WeWork AIBot WebSocket closed"), connection);
            }
            if (!stopped)
                await delay(
                    TimeSpan.FromMilliseconds(
                        SessionWait.Number(websocketConfig["reconnectMs"]) is { } reconnect
                        && reconnect != 0
                            ? reconnect
                            : 5000
                    ),
                    lifetime.Token
                );
        }
    }

    private async Task SubscribeAsync(Connection current)
    {
        try
        {
            await SendCommandAsync(
                "aibot_subscribe",
                new JsonObject
                {
                    ["bot_id"] = Text(websocketConfig["botId"]),
                    ["secret"] = Text(websocketConfig["secret"]),
                },
                null,
                CancellationToken.None
            );
        }
        catch
        {
            await CloseOutputAsync(current);
            throw;
        }
    }

    private async Task HeartbeatAsync(CancellationToken token)
    {
        var interval = TimeSpan.FromMilliseconds(
            SessionWait.Number(websocketConfig["heartbeatMs"]) is { } ms && ms != 0 ? ms : 30000
        );
        using var timer = new PeriodicTimer(interval);
        try
        {
            while (await timer.WaitForNextTickAsync(token))
                _ = ObserveAsync(SendCommandAsync("ping", null, null, CancellationToken.None));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private void RejectPending(Exception error, Connection? connection = null)
    {
        lock (socketGate)
        {
            foreach (var (key, value) in pending.ToArray())
                if (connection is null || ReferenceEquals(value.Connection, connection))
                {
                    value.Completion.TrySetException(error);
                    pending.Remove(key);
                }
        }
    }

    private Task<JsonObject> SendCommandAsync(
        string command,
        JsonObject? body,
        string? requestId,
        CancellationToken token
    )
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
        try
        {
            await run;
        }
        catch { }
        lock (socketGate)
            if (requestChains.GetValueOrDefault(reqId) == run)
                requestChains.Remove(reqId);
    }

    private async Task<JsonObject> RunAfterAsync(
        Task previous,
        string command,
        JsonObject? body,
        string reqId,
        CancellationToken token
    )
    {
        try
        {
            await previous;
        }
        catch { }
        // Source queues even the first command in a promise continuation. Yield outside the map mutation.
        await Task.Yield();
        Connection current;
        var completion = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Pending request;
        lock (socketGate)
        {
            current =
                !stopped && socket is { Socket.State: WebSocketState.Open, Closing: 0 } connected
                    ? connected
                    : throw new IOException("WeWork AIBot WebSocket is not connected");
            request = new Pending(current, command, completion);
            pending[reqId] = request;
        }
        var payload = new JsonObject
        {
            ["cmd"] = command,
            ["headers"] = new JsonObject { ["req_id"] = reqId },
        };
        if (body is not null)
            payload["body"] = body.DeepClone();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime.Token, current.Ended.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var registration = timeout.Token.Register(() =>
            completion.TrySetException(
                stopped ? new IOException("WeWork AIBot WebSocket stopped")
                : token.IsCancellationRequested ? new OperationCanceledException(token)
                : current.Ended.IsCancellationRequested ? new IOException("WeWork AIBot WebSocket closed")
                : new IOException($"WeWork AIBot command {command} timed out waiting for ack")
            )
        );
        try
        {
            try
            {
                await current.WireSend.WaitAsync(timeout.Token);
                try
                {
                    try
                    {
                        await current.Socket.SendAsync(
                            Encoding.UTF8.GetBytes(payload.ToJsonString()),
                            WebSocketMessageType.Text,
                            true,
                            timeout.Token
                        );
                    }
                    catch (Exception) when (timeout.IsCancellationRequested)
                    {
                        // Cancellation of a live .NET send has uncertain effects. Retire its socket,
                        // and await the send's exit before releasing this connection's writer.
                        current.Socket.Abort();
                        throw;
                    }
                }
                finally
                {
                    current.WireSend.Release();
                }
            }
            catch (Exception) when (timeout.IsCancellationRequested)
            {
                // The deadline/stop registration owns the observable command outcome.
            }
            return await completion.Task;
        }
        finally
        {
            lock (socketGate)
                if (pending.GetValueOrDefault(reqId) == request)
                    pending.Remove(reqId);
        }
    }

    private async Task HandleSocketMessageAsync(Connection current, string raw)
    {
        JsonObject? payload;
        try
        {
            payload = JsonNode.Parse(raw) as JsonObject;
        }
        catch (System.Text.Json.JsonException)
        {
            return;
        }
        if (payload is null)
            return;
        var reqId = Text(payload["headers"]?["req_id"]);
        Pending? ack;
        lock (socketGate)
        {
            ack = pending.GetValueOrDefault(reqId);
            if (ack is not null && ReferenceEquals(ack.Connection, current))
                pending.Remove(reqId);
            else
                ack = null;
        }
        if (ack is not null)
        {
            Console.WriteLine(
                "WeWork ACK: "
                    + new JsonObject
                    {
                        ["channelId"] = id,
                        ["reqId"] = reqId,
                        ["command"] = ack.Command,
                        ["errcode"] = payload["errcode"]?.DeepClone(),
                    }.ToJsonString()
            );
            if (payload.ContainsKey("errcode") && !Zero(payload["errcode"]))
                ack.Completion.TrySetException(
                    new IOException(
                        $"WeWork AIBot command {ack.Command} failed: {Text(payload["errmsg"])} (code: {payload["errcode"]})"
                    )
                );
            else
                ack.Completion.TrySetResult(payload);
            return;
        }
        if (Text(payload["cmd"]) == "aibot_msg_callback")
            await ProcessInboundAsync(
                payload["body"] as JsonObject,
                new("websocket", ReqId: Nonempty(reqId) ? reqId : Guid.NewGuid().ToString()),
                true
            );
        else if (
            Text(payload["cmd"]) == "aibot_event_callback"
            && Text(payload["body"]?["event"]?["eventtype"]) == "disconnected_event"
        )
            await CloseOutputAsync(current);
    }
}
