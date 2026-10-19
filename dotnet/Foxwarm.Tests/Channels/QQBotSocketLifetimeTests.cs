using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class QQBotSocketLifetimeTests
{
    private sealed class Peer(TcpClient client, WebSocket socket) : IDisposable
    {
        internal readonly TcpClient Client = client;
        internal readonly WebSocket Socket = socket;
        internal static async Task<Peer> Accept(TcpListener listener, bool small = false)
        {
            var client = await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (small) client.ReceiveBufferSize = 4096;
            var stream = client.GetStream(); var header = new StringBuilder(); var one = new byte[1];
            while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                await stream.ReadExactlyAsync(one); header.Append((char)one[0]);
            }
            var key = header.ToString().Split("\r\n").Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)).Split(':', 2)[1].Trim();
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"));
            return new(client, WebSocket.CreateFromStream(stream, true, null, Timeout.InfiniteTimeSpan));
        }
        internal Task Send(JsonObject value) => Socket.SendAsync(Encoding.UTF8.GetBytes(value.ToJsonString()), WebSocketMessageType.Text, true, default);
        internal Task Hello(int interval = 0) => Send(new() { ["op"] = 10, ["d"] = new JsonObject { ["heartbeat_interval"] = interval } });
        internal async Task<JsonObject> Read()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var data = new MemoryStream(); var buffer = new byte[65536]; WebSocketReceiveResult frame;
            do
            {
                frame = await Socket.ReceiveAsync(buffer, timeout.Token);
                Assert.NotEqual(WebSocketMessageType.Close, frame.MessageType);
                data.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            return JsonNode.Parse(data.ToArray())!.AsObject();
        }
        public void Dispose() { Socket.Dispose(); Client.Dispose(); }
    }
    [Fact]
    public async Task Stop_is_nonjoining_and_silent_Close_is_retired_by_the_same_30_second_SDK_lifetime()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        await using var api = await QQBotPeer.StartAsync();
        api.Respond = call => Task.FromResult<IResult?>(call.Path == "/gateway"
            ? Results.Json(new { url = $"ws://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/" }) : null);
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = api.Config() }, dependencies: api.Dependencies);
        var start = f.Manager.ManagedChannels!.ReloadAsync();
        using var peer = await Peer.Accept(listener); await start;
        await peer.Hello(); Assert.Equal("2", (await peer.Read())["op"]!.ToString());
        var clock = Stopwatch.StartNew();
        await f.Manager.ManagedChannels.ChangeAsync("stop", "qq").WaitAsync(TimeSpan.FromSeconds(2));
        var close = await peer.Socket.ReceiveAsync(new byte[128], default).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        // Deliberately never answer Close. Reading raw TCP here does not complete the websocket handshake.
        var eof = await peer.Client.GetStream().ReadAsync(new byte[1]).AsTask().WaitAsync(TimeSpan.FromSeconds(35));
        Assert.Equal(0, eof); Assert.InRange(clock.Elapsed.TotalSeconds, 29, 35);
    }
    [Fact]
    public async Task Nonreading_resume_writer_cannot_hold_heartbeat_reconnect_or_the_successors_sender()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        await using var api = await QQBotPeer.StartAsync();
        api.Respond = call => Task.FromResult<IResult?>(call.Path == "/gateway"
            ? Results.Json(new { url = $"ws://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/" }) : null);
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = api.Config() }, dependencies: api.Dependencies);
        var start = f.Manager.ManagedChannels!.ReloadAsync();
        using var first = await Peer.Accept(listener); await start;
        await first.Hello(); await first.Read();
        var session = new string('s', 16 * 1024 * 1024);
        await first.Send(new() { ["op"] = 0, ["t"] = "READY", ["s"] = 41, ["d"] = new JsonObject { ["session_id"] = session } });
        await first.Send(new() { ["op"] = 7 });
        using var blocked = await Peer.Accept(listener, true);
        await blocked.Hello(40); // Its 16 MiB resume write is never read or ACKed.
        using var successor = await Peer.Accept(listener);
        await successor.Hello();
        var resume = await successor.Read();
        Assert.Equal("6", resume["op"]!.ToString()); Assert.Equal(41, resume["d"]!["seq"]!.GetValue<double>());
        Assert.Equal(session.Length, resume["d"]!["session_id"]!.GetValue<string>().Length);
        await successor.Send(new() { ["op"] = 0, ["t"] = "C2C_MESSAGE_CREATE", ["s"] = 42, ["d"] = QQBotPeer.Message("healthy", "/whoami") });
        await TelegramChannelTests.Until(() => api.Sent.Any(call => call.Body["msg_id"]?.ToString() == "healthy"));
    }
}
