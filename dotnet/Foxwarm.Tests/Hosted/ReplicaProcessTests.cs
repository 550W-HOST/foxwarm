using System.Diagnostics;
using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Xunit;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

// Multi-tenant replicas as real processes with production tenant runtimes. A tenant runtime
// answers an unauthenticated API request with 401; the front's own refusals are bare 503/404.
[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class ReplicaProcessTests(ITestOutputHelper output)
{
    private static readonly TimeSpan Ttl = LeaseTimings.Default.Ttl;

    private static async Task<HttpStatusCode> StatusAsync(ReplicaProcessHarness.Replica replica, string tenant)
    {
        using var response = await replica.GetAsync(tenant);
        return response.StatusCode;
    }

    private static async Task UntilAsync(Func<Task<bool>> condition, TimeSpan limit, string what)
    {
        var watch = Stopwatch.StartNew();
        while (!await condition())
        {
            Assert.True(watch.Elapsed < limit, what);
            await Task.Delay(200);
        }
    }

    [Fact]
    public async Task ReplicasServeTheirTenantsAndAKilledReplicasTenantMovesOnlyAfterExpiry()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        await harness.AddTenantAsync("alpha");
        await harness.AddTenantAsync("beta");
        var a = await harness.StartAsync("replica-a");
        var b = await harness.StartAsync("replica-b");
        try
        {
            // First requests activate each tenant on the replica they arrive at.
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(a, "alpha"));
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(b, "beta"));
            var alphaOwner = await harness.OwnerAsync("alpha");
            Assert.Equal("replica-a", ReplicaRegistry.LogicalName(alphaOwner!));
            Assert.Equal("replica-b", ReplicaRegistry.LogicalName((await harness.OwnerAsync("beta"))!));
            Assert.Equal(1, (int)(await a.StatusAsync())["tenants"]!);
            // Held by the other replica: refused (forwarding comes later), the owner unchanged.
            Assert.Equal(HttpStatusCode.ServiceUnavailable, await StatusAsync(b, "alpha"));
            var epoch = await harness.EpochAsync("alpha");

            var killed = Stopwatch.StartNew();
            a.Kill();
            await a.ExitAsync(TimeSpan.FromSeconds(10));
            // Until the grant expires nobody else takes the tenant.
            Assert.Equal(HttpStatusCode.ServiceUnavailable, await StatusAsync(b, "alpha"));
            await UntilAsync(
                async () => await StatusAsync(b, "alpha") == HttpStatusCode.Unauthorized,
                Ttl + TimeSpan.FromSeconds(20),
                "replica B serves alpha after the expiry"
            );
            output.WriteLine($"takeover after {killed.Elapsed}");
            Assert.True(killed.Elapsed > Ttl - LeaseTimings.Default.RenewInterval * 2, $"taken over after {killed.Elapsed}");
            Assert.Equal(epoch + 1, await harness.EpochAsync("alpha"));
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(b, "beta"));
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
        var b = await harness.StartAsync("replica-b");
        try
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(a, "alpha"));
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(a, "beta"));
            var stopped = Stopwatch.StartNew();
            a.Terminate();
            Assert.Equal(HostedExit.Stopped, await a.ExitAsync(TimeSpan.FromSeconds(30)));
            Assert.Null(await harness.OwnerAsync("alpha"));
            Assert.Null(await harness.OwnerAsync("beta"));
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(b, "alpha"));
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(b, "beta"));
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
        var b = await harness.StartAsync("replica-b");
        try
        {
            Assert.Equal(HttpStatusCode.Unauthorized, await StatusAsync(a, "alpha"));
            var epoch = await harness.EpochAsync("alpha");
            var partitioned = Stopwatch.StartNew();
            a.Proxy.Partition();
            // The owner stops serving at its fence deadline, before the TTL. A request after the
            // fence may wait on a new activation that can't reach the database, so each probe is
            // bounded and the measure is the last response A served.
            var lastServed = TimeSpan.Zero;
            while (partitioned.Elapsed < Ttl + TimeSpan.FromSeconds(5) && !a.Exited)
            {
                using var probe = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                try
                {
                    using var response = await a.GetAsync("alpha", token: probe.Token);
                    if (response.StatusCode == HttpStatusCode.Unauthorized)
                        lastServed = partitioned.Elapsed;
                    else
                        break;
                }
                catch (Exception error) when (error is OperationCanceledException or HttpRequestException) { }
                await Task.Delay(100);
            }
            output.WriteLine($"A last served alpha after {lastServed}");
            Assert.True(lastServed > TimeSpan.Zero, "A served alpha during the partition");
            Assert.True(
                lastServed < LeaseTimings.Default.FenceAfter + TimeSpan.FromSeconds(1),
                $"A served until {lastServed}"
            );
            await UntilAsync(
                async () => await StatusAsync(b, "alpha") == HttpStatusCode.Unauthorized,
                Ttl + TimeSpan.FromSeconds(20),
                "replica B serves alpha after the expiry"
            );
            output.WriteLine($"B took over after {partitioned.Elapsed}");
            Assert.True(partitioned.Elapsed > Ttl - LeaseTimings.Default.RenewInterval * 2, $"taken over after {partitioned.Elapsed}");
            Assert.Equal(epoch + 1, await harness.EpochAsync("alpha"));
            // A fenced replica either exited (an unconfirmed stop) or keeps running with no grant.
            if (a.Exited)
                Assert.Equal(HostedExit.Fenced, await a.ExitAsync(TimeSpan.FromSeconds(5)));
        }
        finally
        {
            output.WriteLine(a.Output);
        }
    }
}
