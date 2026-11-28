using System.Net;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

public sealed partial class WakeupLifecycleTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IdleSweepOnTheLastDrainedBootStillAllowsDemandAndScheduledWork(bool scheduled)
    {
        await using var live = await LiveReplica.StartAsync(shortIdle:true);
        var first = await live.Generations.ActivateAsync(live.Slug);
        await using var op = new PgDatabase(live.Db.OperatorConnectionString,"idle-drain");
        Assert.True(await new ReplicaPlacementRequests(op,LeaseTimings.Default).RequestReplicaDrainAsync(live.Replica.Replica,default));
        using var check = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        while(!Equals("released", await live.Db.ScalarAsync("SELECT state FROM tenant_leases"))) await Task.Delay(30,check.Token);
        Assert.Null(live.Generations.Current(live.Slug));
        Assert.Equal(true,await live.Db.ScalarAsync("SELECT draining FROM replicas"));
        if (scheduled)
        {
            await live.Db.ExecuteOwnerAsync("INSERT INTO tenant_wakeups(tenant_id,due_at) SELECT tenant_id,now() FROM tenants; SELECT pg_notify('foxwarm_lease','wake')");
            await EventuallyAsync(() => Task.FromResult(live.Generations.Current(live.Slug) is { } next && next.Id.Epoch > first.Id.Epoch),check.Token);
        }
        else
        {
            using var client = new HttpClient();
            using var req = new HttpRequestMessage(HttpMethod.Get,$"http://127.0.0.1:{live.Replica.FrontPort}/api/sessions");
            req.Headers.Host = live.Slug + ".test";
            using var reply = await client.SendAsync(req,check.Token);
            Assert.Equal(HttpStatusCode.Unauthorized,reply.StatusCode);
        }
    }
}
