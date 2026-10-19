using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;

namespace Foxwarm.Tests;

public sealed class WeWorkBoundedSocketTests
{
    private sealed class Peer : IDisposable
    {
        private readonly TcpClient client;
        internal readonly WebSocket Socket;

        private Peer(TcpClient client, WebSocket socket) => (this.client, Socket) = (client, socket);

        internal static async Task<Peer> Accept(TcpListener listener)
        {
            var client = await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(35));
            client.ReceiveBufferSize = 4096;
            var stream = client.GetStream();
            var header = new StringBuilder();
            var one = new byte[1];
            while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                await stream.ReadExactlyAsync(one);
                header.Append((char)one[0]);
            }
            var key = header.ToString().Split("\r\n").Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)).Split(':', 2)[1].Trim();
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"));
            return new(client, WebSocket.CreateFromStream(stream, true, null, Timeout.InfiniteTimeSpan));
        }

        internal async Task<JsonObject> Read()
        {
            using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var bytes = new MemoryStream();
            var buffer = new byte[16384];
            ValueWebSocketReceiveResult frame;
            do
            {
                frame = await Socket.ReceiveAsync(buffer.AsMemory(), stop.Token);
                Assert.NotEqual(WebSocketMessageType.Close, frame.MessageType);
                bytes.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            return JsonNode.Parse(bytes.ToArray())!.AsObject();
        }

        internal async Task Send(JsonObject payload) => await Socket.SendAsync(Encoding.UTF8.GetBytes(payload.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

        internal Task Ack(JsonObject command, JsonObject? body = null, int code = 0) => Send(new JsonObject
        {
            ["headers"] = command["headers"]!.DeepClone(), ["errcode"] = code, ["body"] = body
        });

        internal async Task Subscribe()
        {
            var command = await Read();
            Assert.Equal("aibot_subscribe", command["cmd"]!.GetValue<string>());
            await Ack(command);
        }

        public void Dispose() { Socket.Dispose(); client.Dispose(); }
    }

    private static JsonObject Config(TcpListener listener) => new()
    {
        ["aibot"] = new JsonObject { ["websocket"] = new JsonObject
        {
            ["enabled"] = true, ["botId"] = "fixture", ["secret"] = "fixture",
            ["url"] = $"ws://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/",
            ["heartbeatMs"] = 60000, ["reconnectMs"] = 100
        }}
    };

    private static JsonObject Disconnect() => new()
    {
        ["cmd"] = "aibot_event_callback", ["body"] = new JsonObject { ["event"] = new JsonObject { ["eventtype"] = "disconnected_event" }}
    };

    private static async Task Healthy(WeWorkChannel channel, Peer peer)
    {
        var send = channel.Transport.Send("healthy", "after replacement", new(), default);
        var command = await peer.Read();
        Assert.Equal("aibot_send_msg", command["cmd"]!.GetValue<string>());
        Assert.Equal("after replacement", command["body"]!["markdown"]!["content"]!.GetValue<string>());
        await peer.Ack(command);
        await send.WaitAsync(TimeSpan.FromSeconds(3));
    }

    [Theory]
    [InlineData("deadline")]
    [InlineData("cancel")]
    [InlineData("stop")]
    public async Task No_read_peer_bounds_active_and_queued_file_writes_without_replay_and_successor_is_healthy(string outcome)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        await using var channel = new WeWorkChannel("bounded", Config(listener), null!, null!, null, _ => { });
        await channel.StartAsync();
        using var peer = await Peer.Accept(listener);
        await peer.Subscribe();
        using var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "bounded.bin");
        await File.WriteAllBytesAsync(file, new byte[512 * 1024]);
        using var cancel = new CancellationTokenSource();
        var sends = Enumerable.Range(0, 10).Select(i => channel.Transport.SendFile!("chat-" + i, new(file, "bounded.bin", "application/octet-stream", false), null, cancel.Token)).ToArray();
        var inits = new List<JsonObject>();
        for (var i = 0; i < 10; i++)
        {
            var command = await peer.Read();
            Assert.Equal("aibot_upload_media_init", command["cmd"]!.GetValue<string>());
            inits.Add(command);
        }
        foreach (var command in inits)
            await peer.Ack(command, new() { ["upload_id"] = "bounded-upload" });
        // Do not read another byte: force real TCP backpressure rather than withholding ACKs only.
        if (outcome != "deadline")
        {
            await Task.Delay(500);
            if (outcome == "stop") await channel.StopAsync();
            else cancel.Cancel();
        }
        try { await Task.WhenAll(sends).WaitAsync(TimeSpan.FromSeconds(outcome == "deadline" ? 13 : 3)); }
        catch (IOException) { }
        catch (OperationCanceledException) { }
        Assert.All(sends, send => Assert.True(send.IsCompleted && !send.IsCompletedSuccessfully));
        if (outcome == "stop")
        {
            Assert.All(sends, send => Assert.Contains("stopped", send.Exception!.GetBaseException().Message));
            return;
        }
        Assert.All(sends.Where(send => send.IsFaulted), send => Assert.Matches("timed out|closed", send.Exception!.GetBaseException().Message));
        using var replacement = await Peer.Accept(listener);
        await replacement.Subscribe();
        await Healthy(channel, replacement);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Silent_close_is_bounded_for_disconnect_and_subscription_failure(bool subscriptionFailure)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        await using var channel = new WeWorkChannel("closing", Config(listener), null!, null!, null, _ => { });
        await channel.StartAsync();
        using var peer = await Peer.Accept(listener);
        var subscribe = await peer.Read();
        await peer.Ack(subscribe, code: subscriptionFailure ? 41002 : 0);
        if (!subscriptionFailure)
            await peer.Send(Disconnect());
        var started = System.Diagnostics.Stopwatch.StartNew();
        using var replacement = await Peer.Accept(listener);
        Assert.InRange(started.Elapsed.TotalSeconds, 29, 35);
        await replacement.Subscribe();
        await Healthy(channel, replacement);
    }

    [Fact]
    public async Task Completed_close_handshake_reconnects_early_and_old_deadline_cannot_abort_replacement()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        await using var channel = new WeWorkChannel("early-close", Config(listener), null!, null!, null, _ => { });
        await channel.StartAsync();
        using var peer = await Peer.Accept(listener);
        await peer.Subscribe();
        await peer.Send(Disconnect());
        var buffer = new byte[1024];
        var close = await peer.Socket.ReceiveAsync(buffer, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        await peer.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", default);
        using var replacement = await Peer.Accept(listener).WaitAsync(TimeSpan.FromSeconds(3));
        await replacement.Subscribe();
        await Healthy(channel, replacement);
        await Task.Delay(TimeSpan.FromSeconds(31));
        await Healthy(channel, replacement);
    }
}
