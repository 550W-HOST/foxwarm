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

    // Sends `text` and EOF, then reads until the peer's EOF.
    private static async Task<string> ExchangeAsync(TcpClient client, string text)
    {
        // The stream first: TcpClient refuses GetStream once the send side is shut down.
        var stream = client.GetStream();
        await stream.WriteAsync(Encoding.UTF8.GetBytes(text));
        client.Client.Shutdown(SocketShutdown.Send);
        using var received = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int count;
        while ((count = await stream.ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(10))) > 0)
            received.Write(buffer, 0, count);
        return Encoding.UTF8.GetString(received.ToArray());
    }

    // True once the forwarder ended the connection, by EOF or a reset.
    private static async Task<bool> EndedAsync(TcpClient client, TimeSpan within)
    {
        try
        {
            return await client.GetStream().ReadAsync(new byte[1]).AsTask().WaitAsync(within) == 0;
        }
        catch (IOException)
        {
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    private static async Task UntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out waiting until " + what);
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task SimultaneousWaitersShareOneLookupAndReachTheOwnerOnceItListens()
    {
        // The first lookup stalls until released; later ones return the current address.
        var stalled = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstLookup = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string? address = null;
        var lookups = 0;
        await using var forwarder = new StandbyForwarder(
            AnyLoopback,
            _ =>
            {
                if (Interlocked.Increment(ref lookups) == 1)
                {
                    firstLookup.SetResult();
                    return stalled.Task;
                }
                return Task.FromResult(address);
            },
            Hold
        );
        var clients = new List<TcpClient>();
        var exchanges = new List<Task<string>>();
        for (var index = 0; index < 4; index++)
        {
            var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, forwarder.Port);
            clients.Add(client);
            // The complete request and EOF, before any owner exists.
            exchanges.Add(ExchangeAsync(client, $"request {index} " + new string('x', 50_000)));
        }
        await UntilAsync(() => forwarder.Connections == 4, "all four connections are accepted and held");
        await firstLookup.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // Longer than the retry interval: nobody starts a second lookup while one is in flight.
        await Task.Delay(StandbyForwarder.RetryInterval * 3);
        Assert.Equal(1, Volatile.Read(ref lookups));
        stalled.SetResult(null);

        // Then known but refusing, then listening.
        var port = FreePort();
        address = $"127.0.0.1:{port}";
        await Task.Delay(500);
        Assert.All(exchanges, exchange => Assert.False(exchange.IsCompleted));
        Assert.Equal(4, forwarder.Connections);
        using var owner = new Socket(SocketType.Stream, ProtocolType.Tcp);
        owner.Bind(new IPEndPoint(IPAddress.Loopback, port));
        owner.Listen();
        var echo = EchoAsync(owner);
        for (var index = 0; index < 4; index++)
            Assert.Equal($"request {index} " + new string('x', 50_000), await exchanges[index]);
        // Shared: a few lookups per retry interval for all four, not one per attempt each.
        Assert.InRange(Volatile.Read(ref lookups), 2, 12);
        foreach (var client in clients)
            client.Dispose();
        owner.Dispose();
        await echo;
    }

    [Fact]
    public async Task TheHoldCountsFromTheAcceptEvenWhileALookupStalls()
    {
        using var owner = new Socket(SocketType.Stream, ProtocolType.Tcp);
        owner.Bind(AnyLoopback);
        owner.Listen();
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndPoint!).Port}";
        // The lookup finds a listening owner, but only after the hold has passed.
        await using var forwarder = new StandbyForwarder(
            AnyLoopback,
            async _ =>
            {
                await Task.Delay(650);
                return address;
            },
            TimeSpan.FromMilliseconds(200)
        );
        using var client = new TcpClient();
        var accepted = System.Diagnostics.Stopwatch.StartNew();
        await client.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        await client.GetStream().WriteAsync(Encoding.UTF8.GetBytes("late"));
        Assert.True(await EndedAsync(client, TimeSpan.FromSeconds(5)));
        Assert.InRange(accepted.Elapsed, TimeSpan.FromMilliseconds(150), TimeSpan.FromMilliseconds(600));
        await Task.Delay(700);
        Assert.False(owner.Poll(0, SelectMode.SelectRead), "the owner got a connection after the hold");
        await UntilAsync(() => forwarder.OpenSockets == 0, "the forwarder owns no socket");

        // Without any owner, too.
        await using var brief = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(null), TimeSpan.FromMilliseconds(500));
        using var abandoned = new TcpClient();
        await abandoned.ConnectAsync(IPAddress.Loopback, brief.Port);
        Assert.True(await EndedAsync(abandoned, TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task DisposalDuringAStalledLookupLeavesNoSocketsWhenItCompletes()
    {
        using var owner = new Socket(SocketType.Stream, ProtocolType.Tcp);
        owner.Bind(AnyLoopback);
        owner.Listen();
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndPoint!).Port}";
        var stalled = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var forwarder = new StandbyForwarder(AnyLoopback, _ => stalled.Task, Hold);
        var clients = new List<TcpClient>();
        for (var index = 0; index < 4; index++)
        {
            var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, forwarder.Port);
            clients.Add(client);
        }
        await UntilAsync(() => forwarder.Connections == 4, "all four connections are held");
        var disposing = System.Diagnostics.Stopwatch.StartNew();
        await forwarder.DisposeAsync();
        Assert.True(disposing.Elapsed < TimeSpan.FromSeconds(2), "disposal waited for the stalled lookup");
        Assert.Equal(0, forwarder.Connections);
        foreach (var client in clients)
            Assert.True(await EndedAsync(client, TimeSpan.FromSeconds(5)));
        stalled.SetResult(address);
        await Task.Delay(500);
        Assert.Equal(0, forwarder.OpenSockets);
        Assert.False(owner.Poll(0, SelectMode.SelectRead), "a connection was opened after disposal");
        foreach (var client in clients)
            client.Dispose();
    }

    [Fact]
    public async Task AStandbyDoesntForwardToItsOwnAddressBeforeTheHandover()
    {
        // A restarted replica keeps its address while its old grant is still valid.
        var port = FreePort();
        var self = $"127.0.0.1:{port}";
        var forwarder = new StandbyForwarder(new IPEndPoint(IPAddress.Loopback, port), _ => Task.FromResult<string?>(self), Hold, selfAddress: self);
        using var held = new TcpClient();
        await held.ConnectAsync(IPAddress.Loopback, port);
        var exchange = ExchangeAsync(held, "held");
        await Task.Delay(800);
        // Forwarding into its own listener would have accepted a chain of connections.
        Assert.Equal(1, forwarder.Connections);
        Assert.False(exchange.IsCompleted);
        // After the handover the address is this replica's host, and the held connection goes there.
        var adopted = await forwarder.HandOverAsync();
        var echo = EchoAsync(adopted);
        Assert.Equal("held", await exchange);
        await forwarder.DisposeAsync();
        adopted.Dispose();
        await echo;
    }

    [Fact]
    public async Task ConnectionsBeyondTheLimitAreResetAtOnce()
    {
        await using var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(null), Hold, maxConnections: 2);
        using var first = new TcpClient();
        using var second = new TcpClient();
        await first.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        await second.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        await UntilAsync(() => forwarder.Connections == 2, "two connections are held");
        using var excess = new TcpClient();
        await excess.ConnectAsync(IPAddress.Loopback, forwarder.Port);
        Assert.True(await EndedAsync(excess, TimeSpan.FromSeconds(2)), "the excess connection wasn't ended");
        Assert.Equal(2, forwarder.Connections);
        Assert.False(await EndedAsync(first, TimeSpan.FromMilliseconds(200)));
    }

    [Fact]
    public async Task AHandedOverPortKeepsQueueingAndHeldConnectionsReachTheNewOwner()
    {
        string? address = null;
        var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult(address), Hold);
        var port = forwarder.Port;
        // Held by the forwarder, its request and EOF already sent.
        using var held = new TcpClient();
        await held.ConnectAsync(IPAddress.Loopback, port);
        var heldExchange = ExchangeAsync(held, "held " + new string('h', 100_000));
        await UntilAsync(() => forwarder.Connections == 1, "the connection is held");
        // Takeover: the replica's own host adopts the socket; until it accepts, connections queue.
        var adopted = await forwarder.HandOverAsync();
        using var queued = new TcpClient();
        await queued.ConnectAsync(IPAddress.Loopback, port).WaitAsync(TimeSpan.FromSeconds(5));
        var queuedExchange = ExchangeAsync(queued, "queued " + new string('q', 100_000));
        await Task.Delay(300);
        Assert.False(queuedExchange.IsCompleted);
        Assert.Equal(1, forwarder.Connections);
        var echo = EchoAsync(adopted);
        // The new owner is this replica: the held connection goes to its host.
        address = $"127.0.0.1:{port}";
        Assert.Equal("queued " + new string('q', 100_000), await queuedExchange);
        Assert.Equal("held " + new string('h', 100_000), await heldExchange);
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
