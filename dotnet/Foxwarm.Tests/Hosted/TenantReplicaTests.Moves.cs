using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Xunit;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantReplicaTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FreshRequestsWaitThroughASlowConfirmedMove(bool destinationDisappears)
    {
        // Source is preferred so that ordinary rendezvous would return it to itself after release.
        var slug = Enumerable.Range(0,100).Select(i => "move" + i).First(s => Placement.Score(s,"replica-a") > Placement.Score(s,"replica-b"));
        await using var source = await StartAsync(slug);
        await source.WhoAmIAsync(slug);
        await using var target = await StartReplicaAsync(source.Database, "replica-b", source.MeshKey);
        await using var op = new PgDatabase(source.Database.OperatorConnectionString,"placement-test");
        var requests = new ReplicaPlacementRequests(op, Fast);
        var id = await source.Database.TenantIdAsync(slug);
        var epoch = source.Live(slug).Single().Epoch;
        source.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Assert.Equal(PlacementRequestResult.Accepted, await requests.RequestTenantAsync(slug,id,source.Replica.Replica,epoch,PlacementAction.Move,default));
            await UntilAsync(() => source.EventList().Contains(slug + ":dispose"), "source began slow stop");
            Assert.Equal(true, await source.Database.ScalarAsync("SELECT draining_since IS NOT NULL FROM tenant_leases WHERE tenant_id=$1", id));
            var incoming = Enumerable.Range(0,20).Select(_ => source.GetAsync(slug)).ToArray();
            if (destinationDisappears)
            {
                target.Stop.Cancel();
                await target.Run.WaitAsync(TimeSpan.FromSeconds(3));
            }
            await Task.Delay(100);
            Assert.All(incoming, task => Assert.False(task.IsCompleted));
            Assert.Equal(source.Replica.Replica, await source.OwnerAsync(slug));
            source.DrainGate.TrySetResult();
            foreach (var pending in incoming)
            {
                using var result = await pending;
                Assert.Equal(HttpStatusCode.OK, result.StatusCode);
            }
            Assert.Equal(destinationDisappears ? source.Replica.Replica : target.Replica.Replica, await source.OwnerAsync(slug));
            Assert.Equal(epoch+1, (long) (await source.Database.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id=$1",id))!);
            Assert.Null(await source.Database.ScalarAsync("SELECT requested_action FROM tenant_leases WHERE tenant_id=$1",id));
        }
        finally { source.DrainGate.TrySetResult(); }
    }

    [Fact]
    public async Task AReplicaDrainKeepsTheLastOwnerServingUntilAnEligibleTargetArrives()
    {
        await using var source = await StartAsync("alpha");
        var first = await source.WhoAmIAsync("alpha");
        await using var op = new PgDatabase(source.Database.OperatorConnectionString,"placement-test");
        var requests = new ReplicaPlacementRequests(op, Fast);
        Assert.True(await requests.RequestReplicaDrainAsync(source.Replica.Replica, default));
        await UntilAsync(async () =>
        {
            var status = await source.Client.GetStringAsync($"http://127.0.0.1:{source.Replica.HealthPort}/status");
            return System.Text.Json.Nodes.JsonNode.Parse(status)?["state"]?.ToString() == "draining";
        }, "administrative drain observed by the source");
        using var ready = await source.Client.GetAsync($"http://127.0.0.1:{source.Replica.HealthPort}/readyz");
        Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
        Assert.Equal(first, await source.WhoAmIAsync("alpha"));
        Assert.Null(await source.Database.ScalarAsync("SELECT draining_since FROM tenant_leases WHERE tenant_id=$1", await source.Database.TenantIdAsync("alpha")));
        await using var target = await StartReplicaAsync(source.Database,"replica-b",source.MeshKey);
        // No public demand: the settled hand-back must wake the eligible target.
        await UntilAsync(async () => Equals(await source.OwnerAsync("alpha"), target.Replica.Replica), "resident handed off once target became eligible");
        Assert.Equal(HttpStatusCode.OK,(await source.GetAsync("alpha")).StatusCode);
    }

    [Fact]
    public async Task RequestedReleaseSleepsWithoutAnAlternativeAndKeepsTheSameBootEligible()
    {
        await using var source = await StartAsync("alpha");
        await source.WhoAmIAsync("alpha");
        await using var op = new PgDatabase(source.Database.OperatorConnectionString,"placement-test");
        var id = await source.Database.TenantIdAsync("alpha");
        var epoch = source.Live("alpha").Single().Epoch;
        Assert.Equal(PlacementRequestResult.Accepted, await new ReplicaPlacementRequests(op, Fast).RequestTenantAsync("alpha", id, source.Replica.Replica, epoch, PlacementAction.Release, default));
        await UntilAsync(async () => await source.OwnerAsync("alpha") is null, "sleeping release");
        Assert.Null(await source.Database.ScalarAsync("SELECT requested_action FROM tenant_leases WHERE tenant_id=$1",id));
        Assert.StartsWith("alpha:",await source.WhoAmIAsync("alpha"));
        Assert.Equal(epoch+1, source.Live("alpha").Single().Epoch);
    }
    [Fact]
    public async Task ARequestAdmittedBeforeMoveCompletesOnItsOriginalGrantBeforeRuntimeDisposal()
    {
        await using var source = await StartAsync("alpha");
        source.AddRoutes = app => app.MapGet("/finish", async (HttpContext context) =>
        {
            source.Entered.SetResult();
            await source.Continue.Task.WaitAsync(context.RequestAborted);
            await context.Response.WriteAsync("finished",context.RequestAborted);
        });
        var running = source.GetAsync("alpha","/finish");
        await source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(4));
        await using var target = await StartReplicaAsync(source.Database,"replica-b",source.MeshKey);
        await using var op = new PgDatabase(source.Database.OperatorConnectionString,"placement-test");
        var id = await source.Database.TenantIdAsync("alpha");
        try
        {
            Assert.Equal(PlacementRequestResult.Accepted, await new ReplicaPlacementRequests(op, Fast).RequestTenantAsync("alpha",id,source.Replica.Replica,source.Live("alpha").Single().Epoch,PlacementAction.Move,default));
            await UntilAsync(async () => Equals(await source.Database.ScalarAsync("SELECT draining_since IS NOT NULL FROM tenant_leases WHERE tenant_id=$1",id), true), "previous epoch latched");
            await Task.Delay(35);
            Assert.DoesNotContain("alpha:dispose",source.EventList());
            source.Continue.TrySetResult();
            using var response = await running;
            Assert.Equal("finished",await response.Content.ReadAsStringAsync());
            await UntilAsync(async () => Equals(await source.OwnerAsync("alpha"),target.Replica.Replica),"new owner activated");
        }
        finally { source.Continue.TrySetResult(); }
    }

    [Fact]
    public async Task ProcessDrainPublishesAllBarriersAndLetsSiblingTenantsSettleInParallel()
    {
        var slugs = Enumerable.Range(0,12).Select(i => "many"+i).ToArray();
        await using var source = await StartAsync(slugs);
        await Task.WhenAll(slugs.Select(slug => source.WhoAmIAsync(slug)));
        await using var target = await StartReplicaAsync(source.Database,"replica-b",source.MeshKey);
        source.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            source.Stop.Cancel();
            await UntilAsync(() => source.EventList().Count(line => line.EndsWith(":dispose")) == slugs.Length, "all runtime stops entered without waiting for a sibling");
            Assert.Equal((long)slugs.Length, await source.Database.ScalarAsync("SELECT count(*) FROM tenant_leases WHERE owner_replica=$1 AND draining_since IS NOT NULL AND state='active'",source.Replica.Replica));
            var incoming = slugs.Select(slug => target.GetAsync(slug)).ToArray();
            await Task.Delay(100);
            Assert.All(incoming, read => Assert.False(read.IsCompleted));
            source.DrainGate.SetResult();
            foreach (var read in incoming)
            {
                using var response = await read;
                Assert.Equal(HttpStatusCode.OK,response.StatusCode);
            }
            Assert.Equal(HostedExit.Stopped, await source.Run.WaitAsync(TimeSpan.FromSeconds(5)));
            foreach (var slug in slugs) Assert.Equal(target.Replica.Replica,await source.OwnerAsync(slug));
        }
        finally { source.DrainGate.TrySetResult(); }
    }

}
