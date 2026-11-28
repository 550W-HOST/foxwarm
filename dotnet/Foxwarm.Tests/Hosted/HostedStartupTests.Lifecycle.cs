using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// The replica's lifecycle around the runtime start, with runtimes the tests gate: fence, stop
// and failure during the factory or the start, a draining standby, and a connection queued on
// the handed-over port while the new owner starts.
public sealed partial class HostedStartupTests
{
    private sealed class FakeRuntime(Func<Task>? start = null, Func<Task>? dispose = null) : IHostedRuntime
    {
        private readonly TaskCompletionSource stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal volatile bool Started;
        internal volatile bool Disposed;
        public Task Stopped => stopped.Task;

        public async Task StartAsync()
        {
            if (start is not null)
                await start();
            Started = true;
        }

        public async ValueTask DisposeAsync()
        {
            if (dispose is not null)
                await dispose();
            Disposed = true;
        }
    }

    // A runtime that echoes on the public socket it was handed, like a host that adopted it.
    private static FakeRuntime EchoRuntime(HostedRuntimeContext context, Func<Task>? beforeServing = null)
    {
        var listener = context.PublicListener!;
        Task? echo = null;
        return new FakeRuntime(
            async () =>
            {
                if (beforeServing is not null)
                    await beforeServing();
                echo = Echo(listener);
            },
            async () =>
            {
                listener.Dispose();
                if (echo is not null)
                    await echo;
            }
        );
    }

    private static Task Echo(Socket listener) =>
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
                        try
                        {
                            while ((count = await accepted.ReceiveAsync(buffer)) > 0)
                                await accepted.SendAsync(buffer.AsMemory(0, count));
                            accepted.Shutdown(SocketShutdown.Send);
                        }
                        catch (SocketException) { }
                    }
                });
            }
        });

    private static async Task<string> SendAndReadToEndAsync(TcpClient client, string text)
    {
        // The stream first: TcpClient refuses GetStream once the send side is shut down.
        var stream = client.GetStream();
        await stream.WriteAsync(Encoding.UTF8.GetBytes(text));
        client.Client.Shutdown(SocketShutdown.Send);
        using var received = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int count;
        while ((count = await stream.ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(20))) > 0)
            received.Write(buffer, 0, count);
        return Encoding.UTF8.GetString(received.ToArray());
    }

    private static async Task<string> RoundTripOpenAsync(TcpClient client, string text)
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

    private static async Task<bool> RefusedAsync(int port)
    {
        using var probe = new TcpClient();
        try
        {
            await probe.ConnectAsync(IPAddress.Loopback, port).WaitAsync(TimeSpan.FromSeconds(2));
            return false;
        }
        catch (SocketException)
        {
            return true;
        }
    }

    [Fact]
    public async Task AFenceDuringAFactoryThatIgnoresCancellationExitsWithinTheDrainBound()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var entered = new TaskCompletionSource<LeaseMonitor>(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        FakeRuntime? built = null;
        var a = Start(temp.Path, database.OpenApp(), "replica-a", async (context, _) =>
        {
            entered.SetResult(context.Monitor);
            await gate.Task;
            return built = new FakeRuntime();
        });
        var monitor = await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(ReplicaRole.Owner, a.Inner.Health.Role);
        var fenced = Stopwatch.StartNew();
        monitor.Fence("test fence");
        // Not live and not ready from the fence on, though the start hasn't returned.
        Assert.Equal(ReplicaRole.Fencing, a.Inner.Health.Role);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, await HealthAsync(a.Inner, "/livez"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, await HealthAsync(a.Inner, "/readyz"));
        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(DrainBound + TimeSpan.FromSeconds(2)));
        Assert.InRange(fenced.Elapsed, DrainBound - TimeSpan.FromMilliseconds(100), DrainBound + TimeSpan.FromSeconds(1.5));
        var times = Assert.IsType<FenceTiming>(a.Inner.FenceTimes);
        Assert.Equal("test fence", times.Reason);
        Assert.Null(times.RuntimeStopped);
        Assert.NotNull(times.Exited);
        // A runtime the factory returns after the fence is never started.
        gate.SetResult();
        await WaitUntilAsync(() => built is not null, TimeSpan.FromSeconds(5), "the factory returned");
        await Task.Delay(200);
        Assert.False(built!.Started);
    }

    [Fact]
    public async Task AFenceDuringTheStartDisposesThePartlyStartedRuntime()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var entered = new TaskCompletionSource<LeaseMonitor>(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        FakeRuntime? runtime = null;
        var a = Start(temp.Path, database.OpenApp(), "replica-a", (context, _) =>
        {
            runtime = new FakeRuntime(async () =>
            {
                entered.SetResult(context.Monitor);
                await gate.Task;
            });
            return Task.FromResult<IHostedRuntime>(runtime);
        });
        var monitor = await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
        monitor.Fence("test fence");
        Assert.False(a.Inner.Health.Ready);
        // The start returns within the drain bound; the runtime is then disposed.
        await Task.Delay(300);
        gate.SetResult();
        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(DrainBound + TimeSpan.FromSeconds(2)));
        Assert.True(runtime!.Disposed);
        Assert.NotNull(a.Inner.FenceTimes!.RuntimeStopped);
        Assert.False(a.Inner.Health.RuntimeStarted);
    }

    [Fact]
    public async Task AStopDuringTheStartIsAStopAndDisposesTheRuntimeBeforeReleasing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();

        // A factory that honours cancellation.
        var factoryEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = Start(temp.Path, database.OpenApp(), "replica-a", async (_, token) =>
        {
            factoryEntered.SetResult();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });
        await factoryEntered.Task.WaitAsync(TimeSpan.FromSeconds(30));
        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));

        // A start that returns after the stop: disposed while the lease is still held.
        var startEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string? leaseAtDisposal = null;
        FakeRuntime? runtime = null;
        var b = Start(temp.Path, database.OpenApp(), "replica-b", (_, _) =>
        {
            runtime = new FakeRuntime(
                async () =>
                {
                    startEntered.SetResult();
                    await gate.Task;
                },
                async () => leaseAtDisposal = (string?)await database.ScalarAsync("SELECT state FROM tenant_leases")
            );
            return Task.FromResult<IHostedRuntime>(runtime);
        });
        await startEntered.Task.WaitAsync(TimeSpan.FromSeconds(30));
        b.Stop.Cancel();
        await WaitUntilAsync(() => b.Inner.Health.Role == ReplicaRole.Stopping, TimeSpan.FromSeconds(5), "replica B is stopping");
        Assert.False(b.Inner.Health.Ready);
        await Task.Delay(200);
        gate.SetResult();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(runtime!.Disposed);
        Assert.Equal("active", leaseAtDisposal);
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
    }

    [Fact]
    public async Task AFailedStartDisposesTheRuntimeBeforeReleasingAndFreesThePort()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        string? leaseAtDisposal = null;
        FakeRuntime? runtime = null;
        var a = Start(temp.Path, database.OpenApp(), "replica-a", (_, _) =>
        {
            runtime = new FakeRuntime(
                () => throw new InvalidOperationException("start failed"),
                async () => leaseAtDisposal = (string?)await database.ScalarAsync("SELECT state FROM tenant_leases")
            );
            return Task.FromResult<IHostedRuntime>(runtime);
        });
        Assert.Equal(HostedExit.Failed, await a.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.True(runtime!.Disposed);
        Assert.Equal("active", leaseAtDisposal);
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        using var rebound = new TcpListener(new IPEndPoint(IPAddress.Loopback, a.PublicPort));
        rebound.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        rebound.Start();
    }

    [Fact]
    public async Task AStandbyOnSigtermIsNotReadyWhenItsPortClosesAndFinishesForwardedConnections()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var a = Start(temp.Path, database.OpenApp(), "replica-a", (context, _) => Task.FromResult<IHostedRuntime>(EchoRuntime(context)));
        await WaitUntilAsync(() => a.Inner.Health.Ready && a.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(30), "replica A serves");
        var b = Start(temp.Path, database.OpenApp(), "replica-b", (context, _) => Task.FromResult<IHostedRuntime>(EchoRuntime(context)));
        await b.Inner.Waiting.WaitAsync(TimeSpan.FromSeconds(30));
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, b.PublicPort);
        Assert.Equal("before", await RoundTripOpenAsync(client, "before"));

        b.Stop.Cancel();
        await WaitUntilAsync(() => b.Inner.Health.Role == ReplicaRole.Stopping, TimeSpan.FromSeconds(5), "replica B is stopping");
        // SIGTERM withdraws readiness first; ending the accept loop and closing the TCP
        // listener are asynchronous. Observe the port closure itself before checking health.
        using var portDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!await RefusedAsync(b.PublicPort)) await Task.Delay(10, portDeadline.Token);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, await HealthAsync(b.Inner, "/readyz"));
        Assert.Equal("during", await RoundTripOpenAsync(client, "during"));
        Assert.False(b.Run.IsCompleted);
        client.Client.Shutdown(SocketShutdown.Send);
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(10)));

        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task AGracefullyStoppingOwnerStopsReportingOwnerAtTheStopAndNeverAfterTheRelease()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        // The first owner's runtime takes a while to drain, so the stop has a visible window.
        var a = Start(temp.Path, database.OpenApp(), "replica-a", (_, _) =>
            Task.FromResult<IHostedRuntime>(new FakeRuntime(dispose: () => Task.Delay(700))));
        await WaitUntilAsync(() => a.Inner.Health.Ready && a.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(30), "replica A serves");
        var b = Start(temp.Path, database.OpenApp(), "replica-b", (_, _) => Task.FromResult<IHostedRuntime>(new FakeRuntime()));
        await b.Inner.Waiting.WaitAsync(TimeSpan.FromSeconds(30));

        // A's /status over HTTP throughout, each sample with the time its request started; B's
        // ownership observed in process.
        var clock = Stopwatch.StartNew();
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
        var samples = new List<(TimeSpan Started, string Role, bool Ready)>();
        TimeSpan? stoppingSeen = null;
        TimeSpan? bOwnerSeen = null;
        using var sampling = new CancellationTokenSource();
        var sampler = Task.Run(async () =>
        {
            while (!sampling.IsCancellationRequested)
            {
                var started = clock.Elapsed;
                if (bOwnerSeen is null && b.Inner.Health.Role == ReplicaRole.Owner)
                    bOwnerSeen = started;
                if (stoppingSeen is null && a.Inner.Health.Role == ReplicaRole.Stopping)
                    stoppingSeen = started;
                try
                {
                    var status = System.Text.Json.Nodes.JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{a.Inner.HealthPort}/status"))!;
                    samples.Add((started, status["role"]!.GetValue<string>(), status["ready"]!.GetValue<bool>()));
                }
                catch (Exception) when (a.Run.IsCompleted) { }
                catch (HttpRequestException) { }
            }
        });
        await Task.Delay(300);
        var stopAt = clock.Elapsed;
        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(10)));
        await WaitUntilAsync(() => bOwnerSeen is not null, TimeSpan.FromSeconds(10), "replica B owns the tenant");
        sampling.Cancel();
        await sampler;

        Assert.NotNull(stoppingSeen);
        Assert.InRange(stoppingSeen!.Value - stopAt, TimeSpan.Zero, TimeSpan.FromMilliseconds(200));
        Assert.Contains(samples, sample => sample.Started < stopAt && sample.Role == "owner" && sample.Ready);
        var duringStop = samples.Where(sample => sample.Started >= stoppingSeen.Value).ToList();
        Assert.True(duringStop.Count > 5, $"only {duringStop.Count} samples during the stop");
        // From the stop on: stopping, not ready; never owner, before or after the release.
        Assert.All(duringStop, sample => Assert.False(sample.Role == "owner" || sample.Ready, $"{sample.Role} ready={sample.Ready} at {sample.Started}"));
        Assert.All(samples.Where(sample => sample.Started >= bOwnerSeen!.Value), sample => Assert.NotEqual("owner", sample.Role));
        b.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task ConnectionsHeldAndQueuedThroughAGatedStartReachTheNewOwner()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        // The first owner's port refuses: its runtime closes the socket it was handed.
        var a = Start(temp.Path, database.OpenApp(), "replica-a", (context, _) =>
        {
            context.PublicListener!.Dispose();
            return Task.FromResult<IHostedRuntime>(new FakeRuntime());
        });
        await WaitUntilAsync(() => a.Inner.Health.Ready && a.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(30), "replica A serves");
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var starting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var b = Start(temp.Path, database.OpenApp(), "replica-b", (context, _) =>
            Task.FromResult<IHostedRuntime>(EchoRuntime(context, async () =>
            {
                starting.SetResult();
                await gate.Task;
            })));
        await b.Inner.Waiting.WaitAsync(TimeSpan.FromSeconds(30));

        // Held: the owner refuses. Complete request and EOF sent at once.
        var heldText = "held " + new string('h', 200_000);
        using var held = new TcpClient();
        await held.ConnectAsync(IPAddress.Loopback, b.PublicPort);
        var heldExchange = SendAndReadToEndAsync(held, heldText);
        await Task.Delay(500);
        Assert.False(heldExchange.IsCompleted);

        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(10)));
        await starting.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(ReplicaRole.Owner, b.Inner.Health.Role);
        Assert.False(b.Inner.Health.Ready);
        Assert.Null(b.Inner.ForwarderPort);

        // Queued: connects to the handed-over port while nothing accepts on it.
        var queuedText = "queued " + new string('q', 200_000);
        using var queued = new TcpClient();
        await queued.ConnectAsync(IPAddress.Loopback, b.PublicPort).WaitAsync(TimeSpan.FromSeconds(5));
        var queuedExchange = SendAndReadToEndAsync(queued, queuedText);
        await Task.Delay(500);
        Assert.False(queuedExchange.IsCompleted);
        Assert.False(heldExchange.IsCompleted);

        gate.SetResult();
        Assert.Equal(queuedText, await queuedExchange);
        Assert.Equal(heldText, await heldExchange);
        b.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(10)));
    }
}
