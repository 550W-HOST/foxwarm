using System.Diagnostics;
using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Xunit;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

// Multi-tenant replicas as real processes with production tenant runtimes. A tenant runtime
// answers an unauthenticated API request with 401; the front's own refusals are bare 503/404.
// Ordering claims are checked on the database's clock: the successor's acquisition against the
// old lease's expiry.
[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class ReplicaProcessTests(ITestOutputHelper output)
{
    private static readonly TimeSpan Ttl = LeaseTimings.Default.Ttl;

    // A bounded request; gap probes use the short bound, a first activation a cold build's.
    private static async Task<HttpStatusCode?> ProbeAsync(ReplicaProcessHarness.Replica replica, string tenant, int seconds = 1)
    {
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        try
        {
            using var response = await replica.GetAsync(tenant, token: bound.Token);
            return response.StatusCode;
        }
        catch (Exception error) when (error is OperationCanceledException or HttpRequestException)
        {
            return null;
        }
    }

    // Probes the replica for the tenant without pause until it serves; returns when, and how
    // many probes it refused before.
    private static async Task<(TimeSpan Served, int Refused)> ProbeUntilServedAsync(
        ReplicaProcessHarness.Replica replica,
        string tenant,
        Stopwatch since,
        TimeSpan limit
    )
    {
        var refused = 0;
        while (since.Elapsed < limit)
        {
            if (await ProbeAsync(replica, tenant) == HttpStatusCode.Unauthorized)
                return (since.Elapsed, refused);
            refused++;
            await Task.Delay(100);
        }
        throw new Xunit.Sdk.XunitException($"{replica.Name} didn't serve {tenant} within {limit}");
    }

    private static Task<HttpStatusCode?> ServeAsync(ReplicaProcessHarness.Replica replica, string tenant) =>
        ProbeAsync(replica, tenant, 60);

    private static async Task<int> TenantsAsync(ReplicaProcessHarness.Replica replica) =>
        (int)(await replica.StatusAsync())["tenants"]!;

    [Fact]
    public async Task AFreshPortReplacesAnEdgeWhosePublicBindFailed()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("collision");
        using var occupied = new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);
        occupied.Start();
        var busy = ((IPEndPoint)occupied.LocalEndpoint).Port;
        var samples = 0;
        var edge = await cluster.StartAsync("edge", samplePort: () => ++samples == 1 ? busy : ChildListenerPorts.Sample());
        Assert.NotEqual(busy, edge.FrontPort);
        Assert.Equal(1L,await cluster.Database.ScalarAsync("SELECT count(*) FROM replicas WHERE split_part(replica_id,'/',1)='edge'"));
        using var response = await edge.GetAsync("collision");
        Assert.Equal(HttpStatusCode.Unauthorized,response.StatusCode);
    }

    [Fact]
    public async Task RebalanceMovesOnlyIdleResidentsAfterThePreferredNameHasStayedStable()
    {
        var slugs = Enumerable.Range(0,100).Select(i => "rebalance"+i)
            .Where(slug => Placement.Score(slug,"replica-b") > Placement.Score(slug,"replica-a")).Take(2).ToArray();
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        foreach (var slug in slugs) await harness.AddTenantAsync(slug);
        var source = await harness.StartAsync("replica-a");
        foreach (var slug in slugs) Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(source,slug));
        var original = await harness.OwnerAsync(slugs[0]);
        using var socket = new System.Net.WebSockets.ClientWebSocket();
        socket.Options.SetRequestHeader("Host", slugs[1]+".test");
        socket.Options.SetRequestHeader("Authorization", "Bearer "+await harness.SignInTokenAsync(slugs[1]));
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{source.FrontPort}/api/webui/stream"),default);
        var preference = Stopwatch.StartNew();
        var target = await harness.StartAsync("replica-b");
        while (await harness.OwnerAsync(slugs[0]) == original)
        {
            Assert.True(preference.Elapsed < TimeSpan.FromSeconds(90), "Idle resident never moved to its preferred name.");
            await Task.Delay(200);
        }
        Assert.True(preference.Elapsed >= TimeSpan.FromSeconds(60), "The resident left before its placement cooldown.");
        Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(target,slugs[0]));
        Assert.Equal("replica-b", ReplicaRegistry.LogicalName((await harness.OwnerAsync(slugs[0]))!));
        Assert.Equal(original,await harness.OwnerAsync(slugs[1]));
        socket.Abort();
    }

    [Fact]
    public async Task ReplicasServeTheirTenantsAndAKilledReplicasTenantMovesOnlyAfterExpiry()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        await harness.AddTenantAsync("alpha");
        await harness.AddTenantAsync("beta");
        var a = await harness.StartAsync("replica-a");
        Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(a, "alpha"));
        var b = await harness.StartAsync("replica-b");
        try
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(b, "beta"));
            Assert.Equal("replica-a", ReplicaRegistry.LogicalName((await harness.OwnerAsync("alpha"))!));
            // Either public edge reaches the active grant, even when a different boot now ranks first.
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(b, "alpha"));

            var killed = Stopwatch.StartNew();
            a.Kill();
            await a.ExitAsync(TimeSpan.FromSeconds(10));
            var before = await harness.LeaseRowAsync("alpha");
            // B is asked throughout; it may serve alpha only once the old grant expired.
            var (served, refused) = await ProbeUntilServedAsync(b, "alpha", killed, Ttl + TimeSpan.FromSeconds(30));
            var after = await harness.LeaseRowAsync("alpha");
            output.WriteLine($"served after {served}, {refused} refusals; old expiry {before.ExpiresAt:O}, acquired {after.AcquiredAt:O}");
            Assert.True(refused > 0, "B wasn't asked during the gap");
            Assert.Equal(before.Epoch + 1, after.Epoch);
            Assert.True(after.AcquiredAt >= before.ExpiresAt, $"acquired at {after.AcquiredAt:O}, before the expiry {before.ExpiresAt:O}");
            Assert.Equal("replica-b", ReplicaRegistry.LogicalName(after.Owner!));
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(b, "beta"));
        }
        finally
        {
            output.WriteLine(a.Output);
            output.WriteLine(b.Output);
        }
    }

    [Fact]
    public async Task ASigtermReleasesEveryTenantSoAnotherReplicaTakesOverAtOnce()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        await harness.AddTenantAsync("alpha");
        await harness.AddTenantAsync("beta");
        var a = await harness.StartAsync("replica-a");
        try
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(a, "alpha"));
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(a, "beta"));
            Assert.Equal(2, await TenantsAsync(a));
            var b = await harness.StartAsync("replica-b");
            var old = new Dictionary<string,ReplicaProcessHarness.LeaseRow>();
            foreach (var tenant in new[] { "alpha", "beta" }) old[tenant] = await harness.LeaseRowAsync(tenant);
            var stopped = Stopwatch.StartNew();
            a.Terminate();
            Assert.Equal(HostedExit.Stopped, await a.ExitAsync(TimeSpan.FromSeconds(30)));
            foreach (var (slug, previous) in old)
            {
                // A release notification can activate B before A finishes exiting. Prove
                // confirmed hand-back by observing the new epoch before the old expiry.
                Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(b,slug));
                var row = await harness.LeaseRowAsync(slug);
                Assert.Equal("active",row.State);
                Assert.Equal("replica-b",ReplicaRegistry.LogicalName(row.Owner!));
                Assert.Equal(previous.Epoch+1,row.Epoch);
                Assert.True(row.AcquiredAt < previous.ExpiresAt);
            }
            Assert.True(stopped.Elapsed < Ttl / 2, $"took over after {stopped.Elapsed}");
        }
        finally
        {
            output.WriteLine(a.Output);
        }
    }

    [Fact]
    public async Task APartitionedReplicaFencesItsTenantWhichMovesOnlyAfterExpiry()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        await harness.AddTenantAsync("alpha");
        var a = await harness.StartAsync("replica-a");
        try
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await ServeAsync(a, "alpha"));
            Assert.Equal(1, await TenantsAsync(a));
            var b = await harness.StartAsync("replica-b");
            var partitioned = Stopwatch.StartNew();
            a.Proxy.Partition();
            var before = await harness.LeaseRowAsync("alpha");
            // When the old grant expires, on this test's clock (the database clock's offset).
            var expiry = partitioned.Elapsed + (before.ExpiresAt - before.Now);

            // B is asked from the start of the partition, concurrently with the watch on A.
            async Task<(TimeSpan, int)> ProbeSuccessorAsync()
            {
                var refused = 0;
                while (partitioned.Elapsed < Ttl + TimeSpan.FromSeconds(30))
                {
                    if (await ProbeAsync(b, "alpha") == HttpStatusCode.Unauthorized
                        && ReplicaRegistry.LogicalName((await harness.OwnerAsync("alpha")) ?? "") == "replica-b")
                        return (partitioned.Elapsed, refused);
                    refused++;
                    await Task.Delay(100);
                }
                throw new TimeoutException("The surviving replica did not become the serving owner.");
            }
            var successor = ProbeSuccessorAsync();

            // A: its published tenant count (or its fenced exit) drops before the expiry.
            TimeSpan? retired = null;
            while (partitioned.Elapsed < expiry)
            {
                if (a.Exited || await TenantsAsync(a) == 0)
                {
                    retired = partitioned.Elapsed;
                    break;
                }
                await Task.Delay(100);
            }
            output.WriteLine($"A retired alpha at {retired}; the grant expires at {expiry}");
            Assert.True(retired is not null, "A still published alpha at the expiry");
            // And A refuses alpha from then on, across the expiry.
            while (partitioned.Elapsed < expiry + TimeSpan.FromSeconds(2) && !a.Exited)
            {
                Assert.NotEqual(HttpStatusCode.Unauthorized, await ProbeAsync(a, "alpha"));
                await Task.Delay(100);
            }

            var (served, refused) = await successor;
            var after = await harness.LeaseRowAsync("alpha");
            output.WriteLine($"B served after {served}, {refused} refusals; old expiry {before.ExpiresAt:O}, acquired {after.AcquiredAt:O}");
            Assert.True(refused > 0, "B wasn't asked during the gap");
            Assert.Equal(before.Epoch + 1, after.Epoch);
            Assert.True(after.AcquiredAt >= before.ExpiresAt, $"acquired at {after.AcquiredAt:O}, before the expiry {before.ExpiresAt:O}");
            if (a.Exited)
                Assert.Equal(HostedExit.Fenced, await a.ExitAsync(TimeSpan.FromSeconds(5)));
        }
        finally
        {
            output.WriteLine(a.Output);
        }
    }
}
