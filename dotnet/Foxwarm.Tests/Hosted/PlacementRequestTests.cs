using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class PlacementRequestTests
{
    [Fact]
    public async Task OperatorRequestsNameTheOriginalTenantAndGrantAndAreIdempotent()
    {
        var pg = await PostgresServer.SharedAsync();
        await using var test = await pg.CreateDatabaseAsync();
        await using var op = new PgDatabase(test.OperatorConnectionString, "placement-actions");
        var app = test.OpenApp();
        var requests = new ReplicaPlacementRequests(op, LeaseTimings.Default);
        var registry = new ReplicaRegistry(app);
        const string slug = PostgresServer.Tenant, source = "source/1", target = "target/2";
        var id = await test.TenantIdAsync(slug);
        await registry.RegisterAsync(source, null, SchemaMigrator.BinaryLevel, 2, default, meshAddress: "http://source:80");
        var epoch = await test.TakeLeaseAsync(id, source);
        Task<PlacementRequestResult> Request(PlacementAction action, int? entity = null, string owner = source, long? generation = null) =>
            requests.RequestTenantAsync(slug, entity ?? id, owner, generation ?? epoch, action, default);
        Assert.Equal(PlacementRequestResult.Stale, await Request(PlacementAction.Release, id + 1));
        Assert.Equal(PlacementRequestResult.Stale, await Request(PlacementAction.Release, owner: target));
        Assert.Equal(PlacementRequestResult.Stale, await Request(PlacementAction.Release, generation: epoch - 1));
        Assert.Equal(PlacementRequestResult.NoTarget, await Request(PlacementAction.Move));
        await registry.RegisterAsync(target, null, SchemaMigrator.BinaryLevel, 2, default, meshAddress: "http://target:80");
        await test.ExecuteOwnerAsync("UPDATE replicas SET capacity='{\"acceptingNew\":false}' WHERE replica_id='target/2'");
        Assert.Equal(PlacementRequestResult.NoTarget, await Request(PlacementAction.Move));
        await test.ExecuteOwnerAsync("UPDATE replicas SET capacity='{\"acceptingNew\":true}' WHERE replica_id='target/2'");
        Assert.Equal(PlacementRequestResult.Accepted, await Request(PlacementAction.Move));
        Assert.Equal(PlacementRequestResult.AlreadyRequested, await Request(PlacementAction.Move));
        Assert.Equal(PlacementRequestResult.Conflict, await Request(PlacementAction.Release));
        Assert.Null(await test.ScalarAsync("SELECT draining_since FROM tenant_leases WHERE tenant_id=$1", id));
        Assert.False(await requests.RequestReplicaDrainAsync("absent/1", default));
        Assert.True(await requests.RequestReplicaDrainAsync(target, default));
        Assert.True(await requests.RequestReplicaDrainAsync(target, default));
        Assert.Equal(true, await test.ScalarAsync("SELECT draining FROM replicas WHERE replica_id=$1", target));
    }
}
