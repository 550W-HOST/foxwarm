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

    [Fact]
    public async Task TheForwarderPipesBytesToTheOwnerBothWays()
    {
        using var owner = new TcpListener(AnyLoopback);
        owner.Start();
        var ownerPort = ((IPEndPoint)owner.LocalEndpoint).Port;
        string? address = null;
        await using var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult(address));

        // Without an owner the connection closes at once.
        using (var refused = new TcpClient())
        {
            await refused.ConnectAsync(IPAddress.Loopback, forwarder.Port);
            var buffer = new byte[1];
            Assert.Equal(0, await refused.GetStream().ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        }

        address = $"127.0.0.1:{ownerPort}";
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
    public async Task StoppingTheForwarderClosesItsConnectionsAndFreesThePort()
    {
        using var owner = new TcpListener(AnyLoopback);
        owner.Start();
        var address = $"127.0.0.1:{((IPEndPoint)owner.LocalEndpoint).Port}";
        var forwarder = new StandbyForwarder(AnyLoopback, _ => Task.FromResult<string?>(address));
        var port = forwarder.Port;
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        using var accepted = await owner.AcceptTcpClientAsync();
        await forwarder.DisposeAsync();
        var buffer = new byte[1];
        Assert.Equal(0, await client.GetStream().ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        // The replica's own host can bind the public port right after.
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
