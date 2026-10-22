using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed partial class QQBotChannel
{
    private sealed class Connection(long generation)
    {
        internal readonly long Generation = generation;
        internal readonly ClientWebSocket Socket = new();
        internal readonly SemaphoreSlim Send = new(1);
        internal readonly CancellationTokenSource Ended = new();
        internal CancellationTokenSource Heartbeat = new();
        internal readonly TaskCompletionSource<Reconnect> Retired = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal int Closing;
        internal volatile bool AwaitingAck;
    }

    private sealed record Reconnect(bool Retry = true, int? Delay = null);

    private Connection? socket;
    private string? sessionId;
    private double? lastSequence;
    private int reconnectAttempt;
    private static readonly int[] ReconnectDelays = [1000, 2000, 5000, 10000, 30000];

    public async Task StartAsync()
    {
        Required(config["appId"], "appId");
        Required(config["clientSecret"], "clientSecret");
        if (!stopped)
            return;
        stopped = false;
        lifetime = new();
        reconnectAttempt = 0;
        var current = Interlocked.Increment(ref generation);
        Interlocked.Increment(ref bufferGeneration);
        var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        gatewayTask = ObserveAsync(GatewayLoopAsync(current, opened, lifetime.Token));
        await opened.Task;
    }

    public Task StopAsync()
    {
        stopped = true;
        Interlocked.Increment(ref generation);
        Interlocked.Increment(ref bufferGeneration);
        lifetime.Cancel();
        Connection? old;
        lock (stateGate)
        {
            old = socket;
            socket = null;
            latest.Clear();
            recent.Clear();
            passive.Clear();
            chains.Clear();
            foreach (var batch in groups.Values)
                batch.Timer?.Cancel();
            groups.Clear();
        }
        if (old is not null)
        {
            old.Retired.TrySetResult(new(false));
            _ = ObserveAsync(CloseOutputAsync(old));
        }
        return Task.CompletedTask;
    }

    private bool Current(Connection connection) =>
        Current(connection.Generation) && ReferenceEquals(socket, connection);

    private async Task GatewayLoopAsync(
        long current,
        TaskCompletionSource opened,
        CancellationToken token
    )
    {
        var first = true;
        int? nextDelay = null;
        while (Current(current))
        {
            Connection? connection = null;
            var receiving = false;
            var stage = "gateway discovery";
            try
            {
                if (!first)
                {
                    if (reconnectAttempt >= 100)
                    {
                        log(new IOException("QQ Bot gateway reconnect limit reached."));
                        return;
                    }
                    Console.WriteLine($"Channel {id} (qqbot) gateway reconnect attempt {reconnectAttempt + 1}.");
                    await delay(
                        TimeSpan.FromMilliseconds(
                            nextDelay ?? ReconnectDelays[Math.Min(reconnectAttempt, 4)]
                        ),
                        token
                    );
                    reconnectAttempt++;
                }
                var gateway = await ApiAsync("/gateway", token: token, expected: current);
                RequireCurrent(current);
                connection = new(current);
                connection.Socket.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
                lock (stateGate)
                    socket = connection;
                stage = "gateway connect";
                await connection.Socket.ConnectAsync(
                    new Uri(Required(gateway["url"], "gateway URL")),
                    token
                );
                RequireCurrent(current);
                reconnectAttempt = 0;
                if (!first)
                    Console.WriteLine($"Channel {id} (qqbot) gateway reconnected (socket open).");
                opened.TrySetResult();
                first = false;
                // Independent receive lifetime mirrors ws.close(): a retired connection may finish its
                // handshake while its successor discovers/connects. It owns its own one-sender gate.
                receiving = true;
                _ = ObserveAsync(ReceiveAsync(connection));
                var reconnect = await connection.Retired.Task;
                if (!reconnect.Retry || stopped)
                    return;
                current = Interlocked.Read(ref generation);
                nextDelay = reconnect.Delay;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                opened.TrySetCanceled();
                return;
            }
            catch (Exception error)
            {
                if (first)
                {
                    opened.TrySetException(new ChannelFailure(stage, error));
                    return;
                }
                log(new ChannelFailure(stage, error));
                nextDelay = null;
            }
            finally
            {
                if (connection is not null)
                {
                    connection.Heartbeat.Cancel();
                    lock (stateGate)
                        if (ReferenceEquals(socket, connection))
                            socket = null;
                    if (receiving)
                        _ = ObserveAsync(CloseOutputAsync(connection));
                    else
                    {
                        connection.Ended.Cancel();
                        connection.Socket.Dispose();
                    }
                }
            }
        }
        opened.TrySetCanceled();
    }

    private async Task ReceiveAsync(Connection connection)
    {
        var ws = connection.Socket;
        try
        {
            var buffer = new byte[16384];
            while (ws.State is WebSocketState.Open or WebSocketState.CloseSent)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult frame;
                do
                {
                    frame = await ws.ReceiveAsync(buffer, connection.Ended.Token);
                    if (frame.MessageType == WebSocketMessageType.Close)
                    {
                        var code = (int?)frame.CloseStatus ?? 1005;
                        lock (stateGate)
                            if (Current(connection))
                            {
                                if (code is 4006 or 4007 or 4009 || code is >= 4900 and <= 4913)
                                {
                                    sessionId = null;
                                    lastSequence = null;
                                    lock (tokenGate)
                                        accessToken = null;
                                }
                                else if (code == 4004)
                                    lock (tokenGate)
                                        accessToken = null;
                                log(new QQBotGatewayException(code is 1000 or 4914 or 4915 ? "terminal close" : "reconnecting after close", code));
                                connection.Retired.TrySetResult(
                                    new(
                                        code is not (1000 or 4914 or 4915),
                                        code == 4008 ? 60000 : null
                                    )
                                );
                            }
                        await CloseOutputAsync(connection);
                        return;
                    }
                    if (message.Length + frame.Count > 100L * 1024 * 1024)
                    {
                        _ = ObserveAsync(
                            CloseOutputAsync(connection, WebSocketCloseStatus.MessageTooBig)
                        );
                        throw new IOException(
                            "QQ Bot gateway message exceeds the transport limit."
                        );
                    }
                    message.Write(buffer, 0, frame.Count);
                } while (!frame.EndOfMessage);
                // ws emits complete binary/text messages. Decode after reassembly, including split UTF-8.
                _ = ObserveAsync(
                    HandleFrameAsync(connection, Encoding.UTF8.GetString(message.ToArray()))
                );
            }
        }
        catch (OperationCanceledException) when (connection.Ended.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (Current(connection))
                log(error);
        }
        finally
        {
            connection.Heartbeat.Cancel();
            connection.Ended.Cancel();
            connection.Retired.TrySetResult(new());
            ws.Dispose();
        }
    }

    private void ReconnectSocket(Connection connection, int? wait = null, bool clear = false)
    {
        lock (stateGate)
        {
            if (!Current(connection))
                return;
            if (clear)
            {
                sessionId = null;
                lastSequence = null;
                lock (tokenGate)
                    accessToken = null;
            }
            Interlocked.Increment(ref generation);
            socket = null;
            connection.Heartbeat.Cancel();
            connection.Retired.TrySetResult(new(true, wait));
        }
        _ = ObserveAsync(CloseOutputAsync(connection));
    }

    private async Task HandleFrameAsync(Connection connection, string text)
    {
        if (!Current(connection))
            return;
        JsonObject frame;
        try
        {
            frame = JsonNode.Parse(text)!.AsObject();
        }
        catch
        {
            return;
        }
        lock (stateGate)
        {
            if (!Current(connection))
                return;
            if (Numeric(frame["s"]) is { } sequence)
                lastSequence = sequence;
        }
        var op = Numeric(frame["op"]);
        if (op == 10)
        {
            var credential = await GetTokenAsync();
            if (!Current(connection))
                return;
            string? resumeSession;
            double? resumeSequence;
            lock (stateGate)
            {
                resumeSession = sessionId;
                resumeSequence = lastSequence;
            }
            var resume = resumeSession is not null && resumeSequence is not null;
            var data = new JsonObject { ["token"] = "QQBot " + credential };
            if (resume)
            {
                data["session_id"] = resumeSession;
                data["seq"] = resumeSequence;
            }
            else
            {
                data["intents"] = 1174409216;
                data["shard"] = new JsonArray(0, 1);
            }
            // ws.send queues synchronously; its caller does not wait for a non-reading peer to drain.
            _ = ObserveAsync(
                SendFrameAsync(connection, new JsonObject { ["op"] = resume ? 6 : 2, ["d"] = data })
            );
            lock (stateGate)
            {
                if (!Current(connection))
                    return;
                connection.Heartbeat.Cancel();
                connection.Heartbeat = new();
                connection.AwaitingAck = false;
                if (
                    Number((frame["d"] as JsonObject)?["heartbeat_interval"])
                    is > 0
                        and < int.MaxValue
                )
                    _ = ObserveAsync(
                        HeartbeatAsync(
                            connection,
                            (int)Number((frame["d"] as JsonObject)?["heartbeat_interval"])!.Value,
                            connection.Heartbeat.Token
                        )
                    );
            }
            return;
        }
        if (op == 11)
        {
            connection.AwaitingAck = false;
            return;
        }
        if (op == 7)
        {
            if (Current(connection))
                log(new QQBotGatewayException("reconnect requested"));
            ReconnectSocket(connection);
            return;
        }
        if (op == 9)
        {
            if (Current(connection))
                log(new QQBotGatewayException("invalid session; reconnecting"));
            ReconnectSocket(connection, 3000, frame["d"]?.ToJsonString() != "true");
            return;
        }
        if (op != 0 || Text(frame["t"]) is not { } type)
            return;
        if (type == "READY")
        {
            lock (stateGate)
                if (
                    Current(connection)
                    && Text((frame["d"] as JsonObject)?["session_id"])?.Trim()
                        is { Length: > 0 } value
                )
                    sessionId = value;
            return;
        }
        if (
            type
                is "C2C_MESSAGE_CREATE"
                    or "GROUP_AT_MESSAGE_CREATE"
                    or "GROUP_MESSAGE_CREATE"
                    or "AT_MESSAGE_CREATE"
                    or "DIRECT_MESSAGE_CREATE"
            && frame["d"] is JsonObject body
        )
            await RouteInboundAsync(type, body);
    }

    private async Task HeartbeatAsync(Connection connection, int interval, CancellationToken token)
    {
        try
        {
            using var clock = new PeriodicTimer(TimeSpan.FromMilliseconds(interval));
            while (await clock.WaitForNextTickAsync(token) && Current(connection))
            {
                if (connection.AwaitingAck)
                {
                    log(new QQBotGatewayException("heartbeat acknowledgement missed; reconnecting"));
                    ReconnectSocket(connection);
                    return;
                }
                connection.AwaitingAck = true;
                double? sequence;
                lock (stateGate)
                    sequence = lastSequence;
                _ = ObserveAsync(
                    SendFrameAsync(connection, new JsonObject { ["op"] = 1, ["d"] = sequence })
                );
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private async Task SendFrameAsync(Connection connection, JsonObject frame)
    {
        await connection.Send.WaitAsync(connection.Ended.Token);
        try
        {
            if (
                !Current(connection)
                || connection.Socket.State != WebSocketState.Open
                || connection.Closing != 0
            )
                return;
            await connection.Socket.SendAsync(
                Encoding.UTF8.GetBytes(frame.ToJsonString()),
                WebSocketMessageType.Text,
                true,
                connection.Ended.Token
            );
        }
        finally
        {
            connection.Send.Release();
        }
    }

    private async Task CloseOutputAsync(
        Connection connection,
        WebSocketCloseStatus status = WebSocketCloseStatus.NormalClosure
    )
    {
        if (
            connection.Ended.IsCancellationRequested
            || Interlocked.Exchange(ref connection.Closing, 1) != 0
        )
            return;
        _ = ForceCloseAsync(connection);
        try
        {
            await connection.Send.WaitAsync(connection.Ended.Token);
            try
            {
                if (connection.Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await connection.Socket.CloseOutputAsync(status, "", connection.Ended.Token);
                else if (connection.Socket.State == WebSocketState.Connecting)
                    connection.Socket.Abort();
            }
            finally
            {
                connection.Send.Release();
            }
        }
        catch (OperationCanceledException) when (connection.Ended.IsCancellationRequested) { }
    }

    private static async Task ForceCloseAsync(Connection connection)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), connection.Ended.Token);
            connection.Socket.Abort();
        }
        catch (OperationCanceledException) when (connection.Ended.IsCancellationRequested) { }
    }
}
