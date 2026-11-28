using Foxwarm.Hosted.Lease;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class HandBackExpiryTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task StopMoveIntentDoesNotOverrideExplicitReleaseOrSuspension(bool explicitRelease)
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.RegisterBootsAsync("source");
        var lease = new TenantLease(db.OpenApp(), PostgresServer.Tenant, 2);
        var grant = Assert.IsType<LeaseGrant>(await lease.TryAcquireAsync("source", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(2), default));
        await db.ExecuteOwnerAsync(explicitRelease ? "UPDATE tenant_leases SET requested_action='release'" : "UPDATE tenants SET state='suspended'");
        Assert.True(await lease.ReleaseWithWakeupAsync(grant, null, default, moveOnStop: true));
        Assert.Null(await db.ScalarAsync("SELECT requested_action FROM tenant_leases"));
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenant_wakeups"));
    }

    [Fact]
    public async Task ExpiryDuringHandBackLeavesTheActiveGrantForRecovery()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var app = db.OpenApp();
        await db.RegisterBootsAsync("source", "destination");
        var lease = new TenantLease(app,PostgresServer.Tenant,2);
        var grant = Assert.IsType<LeaseGrant>(await lease.TryAcquireAsync("source",TimeSpan.FromSeconds(3),TimeSpan.FromSeconds(1),default));
        await db.ExecuteOwnerAsync("UPDATE tenant_leases SET requested_action='move'");
        await using var connection = new NpgsqlConnection(db.OwnerConnectionString);
        await connection.OpenAsync();
        await using var holder = await connection.BeginTransactionAsync();
        // A normal update of a non-key column. An updated tuple makes the waiting SELECT
        // re-evaluate its clock_timestamp() filter when it finally acquires the lock.
        await using(var cmd = new NpgsqlCommand("UPDATE tenant_leases SET draining_since=clock_timestamp()",connection,holder)) await cmd.ExecuteNonQueryAsync();
        var wake = new System.Text.Json.Nodes.JsonObject { ["timerId"]="cron", ["scheduledAt"]=97 };
        var release = lease.ReleaseWithWakeupAsync(grant,new(DateTimeOffset.UtcNow.AddHours(1),wake),default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await db.ScalarAsync("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')") is not true) await Task.Delay(20,deadline.Token);
        while (await db.ScalarAsync("SELECT expires_at <= clock_timestamp() FROM tenant_leases") is not true) await Task.Delay(20,deadline.Token);
        await holder.CommitAsync();
        Assert.False(await release);
        Assert.Equal("active",await db.ScalarAsync("SELECT state FROM tenant_leases"));
        Assert.Equal(0L,await db.ScalarAsync("SELECT count(*) FROM tenant_wakeups"));
    }
}
