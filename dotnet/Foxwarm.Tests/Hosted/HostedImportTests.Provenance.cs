using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Operator;
using Foxwarm.Secrets;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    [Fact]
    public async Task Abandoning_a_partial_hosted_import_deletes_it_and_allows_migration_to_another_tenant()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var id = await db.TenantIdAsync();
        var partial = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports, o => o with
        {
            BeforePhase = phase => phase == "agent metadata" ? throw new IOException("Interrupted after key adoption.") : Task.CompletedTask,
        });
        Assert.Equal(HostedImport.Failed, partial.Exit);
        Assert.Equal(1L, await db.ScalarAsync("SELECT count(*) FROM tenant_keys WHERE tenant_id=$1", id));
        var retry = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports);
        Assert.Equal(HostedImport.Refused, retry.Exit);
        Assert.Contains("--abandon", retry.Report["refusals"]!.ToString());
        Assert.Equal(HostedImport.Refused, (await RunAsync(db, fixture.DataRoot, "newhome", Reports)).Exit);
        var stdout = new StringWriter();
        var code = await HostedCli.RunAsync(["hosted", "import", "--tenant", PostgresServer.Tenant, "--abandon", "--report", Path.Combine(Reports, "abandon.json")],
            stdout, stdout, new System.Collections.Hashtable { ["FOXWARM_DATABASE_URL"] = db.AppConnectionString, ["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString });
        Assert.True(code == HostedImport.Imported, stdout.ToString());
        Assert.Equal("deleting", await TenantStateAsync(db, PostgresServer.Tenant));
        var op = new OperatorStore(db.OpenApp(db.OperatorConnectionString), HostedTestBackend.Kek);
        using var stop = new CancellationTokenSource();
        var worker = op.RunDeletionLoopAsync(stop.Token);
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (await TenantStateAsync(db, PostgresServer.Tenant) is not null) await Task.Delay(50, deadline.Token);
            Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenant_keys WHERE tenant_id=$1", id));
            var moved = await RunAsync(db, fixture.DataRoot, "newhome", Reports);
            Assert.True(moved.Exit == HostedImport.Imported, moved.Report.ToJsonString());
        }
        finally { stop.Cancel(); await worker; }
    }

    [Fact]
    public async Task Concurrent_full_imports_of_copies_claim_exactly_one_tenant()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var copy = CopyFixture("offline-copy");
        var names = new[] { "race-a", "race-b" };
        var locked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var blocker = db.OpenOwner().ClusterAsync(async (tx, ct) =>
        {
            await tx.ExecuteAsync("LOCK TABLE tenants IN SHARE MODE", ct);
            locked.SetResult();
            await release.Task;
            return true;
        }, default);
        await locked.Task;
        var attempts = new[] { RunAsync(db, fixture.DataRoot, names[0], Reports), RunAsync(db, copy, names[1], Reports) };
        try
        {
            // Both preflights pass. Neither transaction can create a destination until
            // both jobs are ready to write, so the database decides the winner.
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while ((long)(await db.ScalarAsync("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='relation'"))! < 2)
                await Task.Delay(10, deadline.Token);
        }
        finally { release.TrySetResult(); await blocker; }
        var results = await Task.WhenAll(attempts);
        var winner = names[Array.IndexOf(results, Assert.Single(results, r => r.Exit == HostedImport.Imported))];
        var refused = Assert.Single(results, r => r.Exit == HostedImport.Refused);
        Assert.Contains("tenant '" + winner + "'", Assert.Single(refused.Report["refusals"]!.AsArray())!.GetValue<string>());
        Assert.Equal(1L, await db.ScalarAsync("SELECT count(*) FROM tenants WHERE name=ANY($1)", (object)names));
    }

    [Fact]
    public async Task A_suspended_import_reserves_its_identity_until_deletion_starts()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        Assert.Equal(HostedImport.Imported, (await RunAsync(db, fixture.DataRoot, "original", Reports)).Exit);
        var op = new OperatorStore(db.OpenApp(db.OperatorConnectionString), HostedTestBackend.Kek);
        await op.SuspendAsync("original", default);
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "master")).FullName;
        HostedImportOptions Physical(HostedImportOptions o) => o with { Profile = TenantProfile.Operator, AgentsVolume = volume };
        var copy = CopyFixture("renamed");
        // Labels are metadata; the installation key itself identifies an offline copy.
        var file = InstanceKeys.DefaultPath(copy);
        var key = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
        key["keyId"] = "different-label";
        await File.WriteAllTextAsync(file, key.ToJsonString());
        var refused = await RunAsync(db, copy, "operator", Reports, Physical, dryRun: true);
        Assert.Equal(HostedImport.Refused, refused.Exit);
        Assert.Contains("tenant 'original'", Assert.Single(refused.Report["refusals"]!.AsArray())!.GetValue<string>());
        Assert.Null(await db.ScalarAsync("SELECT tenant_id FROM tenants WHERE name='operator'"));
        await op.DeleteAsync("original", default);
        Assert.Equal("deleting", await TenantStateAsync(db, "original"));
        var moved = await RunAsync(db, fixture.DataRoot, "operator", Reports, Physical);
        Assert.True(moved.Exit == HostedImport.Imported, moved.Report.ToJsonString());
        Assert.Equal(HostedImport.Refused, (await RunAsync(db, fixture.DataRoot, "third", Reports)).Exit);
    }
}
