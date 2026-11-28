using System.Net;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

public sealed partial class WakeupLifecycleTests
{
    [Fact]
    public async Task FailedBulkStopMarkerStillHandsBackTheSettledCron()
    {
        await using var live = await LiveReplica.StartAsync();
        var generation = await live.Generations.ActivateAsync(live.Slug);
        var sessions = live.Current.Host.Sessions;
        var owner = await sessions.CreateNamedAsync("main", "schedule", null, null);
        await sessions.Timers.CreateAsync(new System.Text.Json.Nodes.JsonObject
        {
            ["sessionId"] = owner.Id, ["message"] = "future occurrence", ["cron"] = $"21 {(DateTime.Now.Hour+6)%24} * * *"
        }, default);
        await live.Db.ExecuteOwnerAsync("""
            CREATE FUNCTION reject_stop_marker() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'marker interrupted' USING ERRCODE='40001'; END $$;
            CREATE TRIGGER reject_stop_marker BEFORE UPDATE ON replicas FOR EACH ROW
              WHEN (NEW.capacity->>'stopping'='true') EXECUTE FUNCTION reject_stop_marker()
            """);
        live.Stop.Cancel();
        Assert.True((await generation.Stopped.WaitAsync(TimeSpan.FromSeconds(10))).Confirmed);
        Assert.True(generation.ScheduleSettled);
        Assert.NotNull(generation.HandBack?.Occurrence);
        Assert.True(await live.Generations.ShutdownAsync());
        Assert.Equal("released", await live.Db.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id=$1", generation.Id.TenantId));
        var durable = await live.Db.ScalarAsync("SELECT occurrence::text FROM tenant_wakeups WHERE tenant_id=$1 AND due_at>now()",generation.Id.TenantId);
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(generation.HandBack.Occurrence, System.Text.Json.Nodes.JsonNode.Parse((string)durable!)));
    }

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
