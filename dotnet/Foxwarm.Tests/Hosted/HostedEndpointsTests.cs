using System.Net;
using System.Net.Sockets;
using System.Text;
using Foxwarm.Hosted;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed class HostedEndpointsTests
{
    private static readonly IPEndPoint AnyLoopback = new(IPAddress.Loopback, 0);

    [Fact]
    public async Task HealthReportsLivenessReadinessAndStatusByRole()
    {
        var state = new HealthState(ReplicaRole.Starting, "r1", "default");
        await using var health = new HealthEndpoint(AnyLoopback, () => state);
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri($"http://127.0.0.1:{health.Port}") };

        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/livez")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await http.GetAsync("/readyz")).StatusCode);

        state = state with { Role = ReplicaRole.Standby };
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/readyz")).StatusCode);

        state = state with { Role = ReplicaRole.Owner, Epoch = 7, SinceRenewal = TimeSpan.FromSeconds(1.24) };
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await http.GetAsync("/readyz")).StatusCode);
        state = state with { RuntimeStarted = true };
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/readyz")).StatusCode);
        var status = await http.GetStringAsync("/status");
        Assert.Equal(
            "{\"role\":\"owner\",\"replica\":\"r1\",\"tenant\":\"default\",\"epoch\":7,\"leaseRenewedSecondsAgo\":1.2,\"ready\":true}",
            status
        );

        state = state with { Role = ReplicaRole.Fencing };
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await http.GetAsync("/livez")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await http.GetAsync("/readyz")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/other")).StatusCode);
        Assert.Equal(
            HttpStatusCode.MethodNotAllowed,
            (await http.PostAsync("/livez", new StringContent(""))).StatusCode
        );
    }

    private static readonly TimeSpan Hold = TimeSpan.FromSeconds(10);

    // An echo server on `listener` for one connection at a time, until the listener closes.
    private static Task EchoAsync(Socket listener) =>
        Task.Run(async () =>
        {
            while (true)
            {
                Socket accepted;
                try
                {
                    accepted = await listener.AcceptAsync();
                }
                catch
                {
                    return;
                }
                _ = Task.Run(async () =>
                {
                    using (accepted)
                    {
                        var buffer = new byte[64 * 1024];
                        int count;
                        while ((count = await accepted.ReceiveAsync(buffer)) > 0)
                            await accepted.SendAsync(buffer.AsMemory(0, count));
                        accepted.Shutdown(SocketShutdown.Send);
                    }
                });
            }
        });

    private static async Task<string> RoundTripAsync(TcpClient client, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        await client.GetStream().WriteAsync(bytes);
        var received = new byte[bytes.Length];
        var read = 0;
        while (read < received.Length)
        {
            var count = await client.GetStream().ReadAsync(received.AsMemory(read)).AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, count);
            read += count;
        }
        return Encoding.UTF8.GetString(received);
    }

    [Fact]
    public async Task TheForwarderPipesBytesToTheOwnerBothWays()
    {
        using var owner = new TcpListener(AnyLoopback);
        owner.Start();
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndpoint).Port}";
        await using var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(address), Hold);
        var echo = Task.Run(async () =>
        {
            using var accepted = await owner.AcceptTcpClientAsync();
            var stream = accepted.GetStream();
            var buffer = new byte[64 * 1024];
            int count;
            while ((count = await stream.ReadAsync(buffer)) > 0)
                await stream.WriteAsync(buffer.AsMemory(0, count));
        });
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        var payload = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n", 4000)));
        var send = client.GetStream().WriteAsync(payload).AsTask();
        var received = new byte[payload.Length];
        var read = 0;
        while (read < received.Length)
            read += await client.GetStream().ReadAsync(received.AsMemory(read)).AsTask().WaitAsync(TimeSpan.FromSeconds(10));
        await send;
        Assert.Equal(payload, received);
        client.Client.Shutdown(SocketShutdown.Send);
        await echo.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task AConnectionWaitsForAReachableOwnerAndClosesAfterTheHold()
    {
        // The owner is first unknown, then known but not listening yet (refused), then listening.
        string? address = null;
        var lookups = 0;
        await using var forwarder = new StandbyForwarder(
            AnyLoopback,
            _ =>
            {
                Interlocked.Increment(ref lookups);
                return Task.FromResult(address);
            },
            Hold
        );
        using var held = new TcpClient();
        await held.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        var request = Encoding.UTF8.GetBytes("held request");
        await held.GetStream().WriteAsync(request);
        var reply = new byte[request.Length];
        var reading = held.GetStream().ReadAsync(reply).AsTask();
        await Task.Delay(600);
        Assert.False(reading.IsCompleted, "the connection was closed without an owner");
        var port = FreePort();
        address = $"127.0.0.1:{port}";
        await Task.Delay(600);
        Assert.False(reading.IsCompleted, "the connection was closed while the owner refused");
        using var owner = new Socket(SocketType.Stream, ProtocolType.Tcp);
        owner.Bind(new IPEndPoint(IPAddress.Loopback, port));
        owner.Listen();
        var echo = EchoAsync(owner);
        var count = await reading.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("held request"[..count], Encoding.UTF8.GetString(reply, 0, count));
        // Waiting connections share lookups: a few per retry interval, not one per attempt each.
        Assert.InRange(lookups, 1, 20);

        // Without any owner, the connection closes once the hold bound passes.
        await using var brief = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(null), TimeSpan.FromMilliseconds(500));
        using var abandoned = new TcpClient();
        await abandoned.ConnectAsync(IPAddress.Loopback, brief.Port);
        var buffer = new byte[1];
        Assert.Equal(0, await abandoned.GetStream().ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        owner.Dispose();
        await echo;
    }

    [Fact]
    public async Task AHandedOverPortKeepsQueueingAndHeldConnectionsReachTheNewOwner()
    {
        string? address = null;
        var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult(address), Hold);
        var port = forwarder.Port;
        using var held = new TcpClient();
        await held.ConnectAsync(IPAddress.Loopback, port);
        await Task.Delay(300);
        // Takeover: the replica's own host adopts the socket; until it accepts, connections queue.
        var adopted = await forwarder.HandOverAsync();
        using var queued = new TcpClient();
        await queued.ConnectAsync(IPAddress.Loopback, port).WaitAsync(TimeSpan.FromSeconds(5));
        var queuedReply = RoundTripAsync(queued, "queued");
        await Task.Delay(300);
        Assert.False(queuedReply.IsCompleted);
        adopted.Listen(512);
        var echo = EchoAsync(adopted);
        // The new owner is this replica: the held connection goes to its host.
        address = $"127.0.0.1:{port}";
        Assert.Equal("queued", await queuedReply);
        Assert.Equal("held", await RoundTripAsync(held, "held"));
        await forwarder.DisposeAsync();
        adopted.Dispose();
        await echo;
    }

    [Fact]
    public async Task DrainingClosesThePortAndWaitsForForwardedConnectionsToEnd()
    {
        using var owner = new Socket(SocketType.Stream, ProtocolType.Tcp);
        owner.Bind(AnyLoopback);
        owner.Listen();
        var echo = EchoAsync(owner);
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndPoint!).Port}";
        await using var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(address), Hold);
        var port = forwarder.Port;
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        Assert.Equal("before", await RoundTripAsync(client, "before"));
        var draining = forwarder.DrainAsync(TimeSpan.FromSeconds(20));
        await Task.Delay(300);
        Assert.False(draining.IsCompleted);
        using (var late = new TcpClient())
            await Assert.ThrowsAnyAsync<SocketException>(() => late.ConnectAsync(IPAddress.Loopback, port));
        // The forwarded connection still works until its client ends it.
        Assert.Equal("during", await RoundTripAsync(client, "during"));
        client.Client.Shutdown(SocketShutdown.Send);
        await draining.WaitAsync(TimeSpan.FromSeconds(10));
        owner.Dispose();
        await echo;
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    [Fact]
    public async Task StoppingTheForwarderClosesItsConnectionsAndFreesThePort()
    {
        using var owner = new TcpListener(AnyLoopback);
        owner.Start();
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndpoint).Port}";
        var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(address), Hold);
        var port = forwarder.Port;
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        using var accepted = await owner.AcceptTcpClientAsync();
        await forwarder.DisposeAsync();
        var buffer = new byte[1];
        Assert.Equal(0, await client.GetStream().ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        // The port is free again.
        using var rebound = new TcpListener(new IPEndPoint(IPAddress.Loopback, port));
        rebound.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        rebound.Start();
    }

    [Theory]
    [InlineData("owner-0.foxwarm:3001", "owner-0.foxwarm", 3001)]
    [InlineData("[fd00::1]:8080", "fd00::1", 8080)]
    public void ReplicaAddressesParse(string address, string host, int port) =>
        Assert.Equal((host, port), StandbyForwarder.ParseAddress(address));

    [Theory]
    [InlineData("owner")]
    [InlineData("owner:0")]
    [InlineData("owner:x")]
    public void MalformedReplicaAddressesAreRejected(string address) =>
        Assert.Throws<FormatException>(() => StandbyForwarder.ParseAddress(address));
}
