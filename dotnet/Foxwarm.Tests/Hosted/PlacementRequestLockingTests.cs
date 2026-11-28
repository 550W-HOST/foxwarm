using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class PlacementRequestLockingTests
{
    [Fact]
    public async Task PlacementDoesNotDeadlockAnInstallationWriterThatAlreadyHoldsLeaseKeyShare()
    {
        await using var test = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await using var op = new PgDatabase(test.OperatorConnectionString, "placement-writer-order");
        var id = await test.TenantIdAsync(PostgresServer.Tenant);
        await test.RegisterBootsAsync("source");
        var epoch = await test.TakeLeaseAsync(id,"source");
        // The installation writer first validates its epoch (KEY SHARE on the lease), then
        // updates tenants.min_reader_version. The operator takes the tenant lock first.
        await using var writer = new Npgsql.NpgsqlConnection(test.OwnerConnectionString);
        await writer.OpenAsync();
        await using var tx = await writer.BeginTransactionAsync();
        async Task Statement(string sql)
        {
            await using var cmd = new Npgsql.NpgsqlCommand(sql,writer,tx);
            cmd.Parameters.Add(PgTx.Parameter(id));
            await cmd.ExecuteNonQueryAsync();
        }
        await Statement("SELECT 1 FROM tenant_leases WHERE tenant_id=$1 FOR KEY SHARE");
        var request = new ReplicaPlacementRequests(op,LeaseTimings.Default).RequestTenantAsync(PostgresServer.Tenant,id,"source",epoch,PlacementAction.Release,default);
        // Either the compatible request has finished, or the old implementation has taken
        // the tenant lock and is blocked by this writer’s lease key-share lock.
        await WaitUntilWaitingOrDone(test,request,"placement-writer-order");
        await Statement("UPDATE tenants SET min_reader_version=greatest(min_reader_version,1) WHERE tenant_id=$1");
        await tx.CommitAsync();
        Assert.Equal(PlacementRequestResult.Accepted,await request);
    }

    [Fact]
    public async Task AnIdenticalRequestWhoseLeaseExpiredDuringTheLockWaitIsStale()
    {
        await using var test = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await using var op = new PgDatabase(test.OperatorConnectionString, "placement-duplicate-expiry");
        var id = await test.TenantIdAsync(PostgresServer.Tenant);
        await test.RegisterBootsAsync("source");
        var epoch = await test.TakeLeaseAsync(id,"source");
        var requests = new ReplicaPlacementRequests(op,LeaseTimings.Default);
        Task<PlacementRequestResult> Request() => requests.RequestTenantAsync(PostgresServer.Tenant,id,"source",epoch,PlacementAction.Release,default);
        Assert.Equal(PlacementRequestResult.Accepted,await Request());
        await test.ExecuteOwnerAsync("UPDATE tenant_leases SET expires_at=clock_timestamp()+interval '1 second' WHERE state='active'");
        await using var holder = new Npgsql.NpgsqlConnection(test.OwnerConnectionString);
        await holder.OpenAsync();
        await using var tx = await holder.BeginTransactionAsync();
        await using var locking = new Npgsql.NpgsqlCommand("SELECT 1 FROM tenant_leases WHERE tenant_id=$1 FOR NO KEY UPDATE",holder,tx);
        locking.Parameters.Add(PgTx.Parameter(id));
        await locking.ExecuteScalarAsync();
        var retry = Request();
        await WaitUntilWaitingOrDone(test,retry,"placement-duplicate-expiry");
        Assert.False(retry.IsCompleted);
        while (!Equals(await test.ScalarAsync("SELECT clock_timestamp()>=expires_at FROM tenant_leases WHERE tenant_id=$1",id),true)) await Task.Delay(15);
        await tx.RollbackAsync();
        Assert.Equal(PlacementRequestResult.Stale, await retry);
    }

    private static async Task WaitUntilWaitingOrDone(HostedTestDatabase test, Task request, string applicationName)
    {
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!request.IsCompleted && !Equals(await test.ScalarAsync("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')",applicationName),true))
            await Task.Delay(10,bound.Token);
    }

}
