using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    private static ImportReport ReportForDefault() => new()
    {
        Root = { ["tenant"] = new JsonObject { ["name"] = PostgresServer.Tenant } },
    };

    [Fact]
    public async Task Local_fence_while_activation_waits_prevents_publication_without_a_takeover()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await using var blocker = new NpgsqlConnection(db.OwnerConnectionString);
        await blocker.OpenAsync();
        await using var tx = await blocker.BeginTransactionAsync();
        var lost = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var published = false;
        var report = ReportForDefault();
        var run = LeasedImport.RunAsync(db.OpenApp(), db.OpenOwner(), PostgresServer.Tenant, 0, ImportKind.Full,
            new(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(4)), null, temp.Path, report,
            async (_, _, token) =>
            {
                await using var command = new NpgsqlCommand("SELECT tenant_id FROM tenant_leases FOR UPDATE", blocker, tx);
                await command.ExecuteScalarAsync(token);
                token.Register(() => lost.TrySetResult());
            }, default, publish: () => published = true);
        await lost.Task.WaitAsync(TimeSpan.FromSeconds(20));
        await tx.RollbackAsync(); // Same epoch and an unexpired database lease, but no local proof.
        Assert.Equal(HostedImport.Fenced, await run.WaitAsync(TimeSpan.FromSeconds(15)));
        Assert.False(published);
        Assert.Equal("importing", await TenantStateAsync(db, PostgresServer.Tenant));
    }

    [Fact]
    public async Task Activation_checks_current_database_expiry_after_waiting_for_the_lease_lock()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var lease = new TenantLease(db.OpenOwner(), PostgresServer.Tenant, 2);
        var grant = (await lease.TryAcquireForImportAsync("import:clock", 0, TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(1), default))!;
        await db.ExecuteOwnerAsync("UPDATE tenant_leases SET expires_at=clock_timestamp()+interval '2 seconds'");
        await using var blocker = new NpgsqlConnection(db.OwnerConnectionString);
        await blocker.OpenAsync();
        await using var tx = await blocker.BeginTransactionAsync();
        await using var held = new NpgsqlCommand("SELECT tenant_id FROM tenant_leases FOR UPDATE", blocker, tx);
        await held.ExecuteScalarAsync();
        var published = false;
        var activation = lease.ActivateImportAsync(grant, default, publish: () => published = true);
        while ((bool)(await db.ScalarAsync("SELECT expires_at > clock_timestamp() FROM tenant_leases"))!)
            await Task.Delay(50);
        await tx.RollbackAsync();
        await Assert.ThrowsAsync<TenantFencedException>(() => activation);
        Assert.False(published);
    }

    [Fact]
    public async Task Lost_activation_commit_reply_preserves_the_published_tree_and_reports_uncertainty()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await using var proxy = PgTcpProxy.For(db.OwnerConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(db.OwnerConnectionString)) { Pooling = false, CommandTimeout = 2, Timeout = 4 }.ConnectionString;
        await using var owner = new PgDatabase(routed, "test-import");
        var report = ReportForDefault();
        var stage = Directory.CreateDirectory(Path.Combine(temp.Path, "stage"));
        var published = Path.Combine(temp.Path, "published");
        var result = await LeasedImport.RunAsync(db.OpenApp(), owner, PostgresServer.Tenant, 0, ImportKind.Full, LeaseTimings.Default,
            null, temp.Path, report, (_, _, _) => Task.CompletedTask, default, publish: () =>
            {
                Directory.Move(stage.FullName, published);
                proxy.HoldExisting(toServer: false, toClient: true);
            });
        Assert.Equal(HostedImport.Failed, result);
        Assert.Equal("active", await TenantStateAsync(db, PostgresServer.Tenant));
        Assert.True(Directory.Exists(published));
        Assert.Equal("activation-unknown", report.Outcome);
        Assert.Equal("unknown", report.Root["tenant"]!["state"]!.GetValue<string>());
    }
}
