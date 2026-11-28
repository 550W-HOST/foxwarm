using System.Collections;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
using Foxwarm.Secrets;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    private async Task<(int Code, string Output, JsonObject? Report)> OperatorCli(HostedTestDatabase db, string slug, string? volume, params string[] extra)
    {
        var env = new Hashtable
        {
            ["FOXWARM_DATABASE_URL"] = db.AppConnectionString,
            ["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString,
            ["FOXWARM_KEK_FILE"] = InstanceKeys.DefaultPath(fixture.DataRoot),
        };
        if (volume is not null) env["FOXWARM_AGENTS_DIR"] = volume;
        var report = Path.Combine(Reports, "operator-" + Guid.NewGuid().ToString("N") + ".json");
        var text = new StringWriter();
        var exit = await HostedCli.RunAsync(["hosted", "import", "--profile", "operator", "--tenant", slug, "--data-root", fixture.DataRoot, "--report", report, .. extra], text, text, env);
        return (exit, text.ToString(), File.Exists(report) ? JsonNode.Parse(await File.ReadAllTextAsync(report))!.AsObject() : null);
    }

    [Fact]
    public async Task Operator_import_copies_physical_files_and_keeps_the_operators_configuration()
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        var agent = Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "agents/ops")).FullName;
        var executable = Path.Combine(agent, "worker");
        await File.WriteAllTextAsync(executable, "operator's program");
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        File.CreateSymbolicLink(Path.Combine(agent, "relative"), "worker");
        var missing = Path.Combine(temp.Path, "missing");
        File.CreateSymbolicLink(Path.Combine(agent, "absolute"), missing);
        Directory.CreateSymbolicLink(Path.Combine(agent, "loop"), ".");
        Directory.CreateDirectory(Path.Combine(agent, "tmp"));
        Directory.CreateDirectory(Path.Combine(agent, ".temp"));
        await File.AppendAllTextAsync(Path.Combine(fixture.DataRoot, "state/config.yaml"), "\nclaudeCode: {executable: claude}\n");
        var dry = await OperatorCli(db, "ops", volume, "--dry-run");
        Assert.True(dry.Code == 0, dry.Output);
        Assert.Empty(Directory.EnumerateFileSystemEntries(volume));
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenants WHERE name='ops'"));
        var imported = await OperatorCli(db, "ops", volume);
        Assert.True(imported.Code == 0, imported.Report?.ToJsonString() ?? imported.Output);
        var id = await db.TenantIdAsync("ops");
        var folder = Path.Combine(volume, id.ToString(), "ops");
        Assert.Equal("operator's program", await File.ReadAllTextAsync(Path.Combine(folder, "worker")));
        Assert.Equal(File.GetUnixFileMode(executable), File.GetUnixFileMode(Path.Combine(folder, "worker")));
        Assert.Equal("worker", new FileInfo(Path.Combine(folder, "relative")).LinkTarget);
        Assert.Equal(missing, new FileInfo(Path.Combine(folder, "absolute")).LinkTarget);
        Assert.Equal(".", new DirectoryInfo(Path.Combine(folder, "loop")).LinkTarget);
        Assert.False(Directory.Exists(Path.Combine(folder, "tmp")));
        Assert.False(Directory.Exists(Path.Combine(folder, ".temp")));
        Assert.Equal(1, imported.Report!["verification"]!["danglingAgentLinks"]!.GetValue<int>());
        Assert.Equal(3, imported.Report["verification"]!["agentLinks"]!.AsArray().Count);
        Assert.Equal("operator:master-host:active", await db.ScalarAsync("SELECT profile || ':' || pinned_role || ':' || state FROM tenants WHERE tenant_id=$1", id));
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM agent_files WHERE tenant_id=$1", id));
        Assert.Contains("claudeCode:", (string)(await db.ScalarAsync("SELECT text FROM config_documents WHERE tenant_id=$1 AND name='config'", id))!);
        Assert.Equal(await File.ReadAllTextAsync(Path.Combine(fixture.DataRoot, "state/mcp.json")), (string)(await db.ScalarAsync("SELECT text FROM config_documents WHERE tenant_id=$1 AND name='mcp'", id))!);
        Assert.True((long)(await db.ScalarAsync("SELECT count(*) FROM archive_messages WHERE tenant_id=$1", id))! > 0);

        // The documented cutover step: an imported tenant initially has no routable host.
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenant_hostnames WHERE tenant_id=$1", id));
        await using var control = new Foxwarm.Hosted.Postgres.PgDatabase(db.OperatorConnectionString, "operator-test");
        var admin = new Foxwarm.Hosted.Operator.OperatorStore(control, HostedTestBackend.Kek);
        await admin.UpdateAsync("ops", new JsonObject { ["primaryHostname"] = "ops.example.test" }, default);
        var hosts = new Foxwarm.Hosted.Runtimes.HostnameDirectory(db.OpenApp());
        Assert.Equal("ops", (await hosts.ResolveAsync("ops.example.test", default))?.Slug);
    }

    [Fact]
    public async Task Operator_import_refuses_when_the_platform_cannot_sync_directories()
    {
        if (OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        var result = await OperatorCli(db, "ops", volume);
        Assert.Equal(HostedImport.Refused, result.Code);
        Assert.Contains("does not support syncing directories", result.Output);
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenants WHERE name='ops'"));
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("concurrent-file")]
    [InlineData("profile-edit")]
    [InlineData("lost-lease")]
    public async Task Physical_Agent_files_publish_only_under_the_final_grant(string condition)
    {
        if (!OperatingSystem.IsLinux()) return; // A successful publication requires Linux directory sync.
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        await db.ExecuteOwnerAsync("UPDATE tenants SET profile='operator', pinned_role='master-host'");
        var target = Directory.CreateDirectory(Path.Combine(volume, (await db.TenantIdAsync()).ToString())).FullName;
        var original = Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "agents", "from-copy"));
        await File.WriteAllTextAsync(Path.Combine(original.FullName, "value"), "source");
        var result = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports, options => options with
        {
            Profile = TenantProfile.Operator,
            AgentsVolume = volume,
            BeforePhase = async name =>
            {
                if (name != "catalog") return; // The verified candidate is still private.
                Assert.False(Directory.Exists(Path.Combine(target, "from-copy")));
                switch (condition)
                {
                    case "concurrent-file": await File.WriteAllTextAsync(Path.Combine(target, "keep"), "another writer"); break;
                    case "profile-edit": await db.ExecuteOwnerAsync("UPDATE tenants SET profile='hosted', pinned_role=NULL"); break;
                    case "lost-lease": await db.ExecuteOwnerAsync("UPDATE tenant_leases SET epoch=epoch+1"); break;
                }
            },
        });
        Assert.Equal(condition == "empty", result.Exit == HostedImport.Imported);
        Assert.Equal(condition == "empty", File.Exists(Path.Combine(target, "from-copy", "value")));
        Assert.Equal(condition == "empty" ? "active" : "importing", await TenantStateAsync(db, PostgresServer.Tenant));
        if (condition == "concurrent-file")
        {
            Assert.Equal(HostedImport.Refused, result.Exit);
            Assert.Equal("another writer", await File.ReadAllTextAsync(Path.Combine(target, "keep")));
        }
        Assert.Empty(Directory.GetDirectories(volume, ".import-*"));
    }

    [Theory]
    [InlineData("importing", false, true)]
    [InlineData("importing", true, false)]
    [InlineData("active", false, false)]
    [InlineData("importing-agents", false, false)]
    public async Task Abandon_an_interrupted_operator_import_hands_only_a_free_full_import_to_deletion(string state, bool held, bool accepted)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await db.ExecuteOwnerAsync($"UPDATE tenants SET state='{state}', profile='operator', pinned_role='master-host'");
        if (held) await db.ExecuteOwnerAsync("UPDATE tenant_leases SET state='active', owner_replica='import:owner', expires_at=now()+interval '1 minute'");
        var id = await db.TenantIdAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        var stage = Directory.CreateDirectory(Path.Combine(volume, $".import-{id}-{Guid.NewGuid():N}"));
        var unrelated = Directory.CreateDirectory(Path.Combine(volume, $".import-{id + 1}-{Guid.NewGuid():N}"));
        var stdout = new StringWriter();
        var code = await HostedCli.RunAsync(["hosted", "import", "--profile", "operator", "--tenant", PostgresServer.Tenant, "--abandon",
            "--report", Path.Combine(Reports, "abandon.json")], stdout, stdout, new Hashtable
        {
            ["FOXWARM_DATABASE_URL"] = db.AppConnectionString,
            ["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString,
            ["FOXWARM_AGENTS_DIR"] = volume,
        });
        Assert.Equal(accepted ? 0 : HostedImport.Refused, code);
        Assert.Equal(accepted ? "deleting" : state, await TenantStateAsync(db, PostgresServer.Tenant));
        Assert.Equal(!accepted, Directory.Exists(stage.FullName));
        Assert.True(Directory.Exists(unrelated.FullName));
        if (accepted)
        {
            Assert.Equal(true, await db.ScalarAsync("SELECT state='released' AND owner_replica IS NULL AND epoch=1 AND deletion_epoch=epoch AND draining_since=expires_at AND expires_at<=now() FROM tenant_leases"));
            var lease = new Foxwarm.Hosted.Lease.TenantLease(db.OpenApp(), PostgresServer.Tenant, 2, Foxwarm.Hosted.Lease.ReplicaRoles.MasterHost);
            Assert.Null(await lease.TryAcquireAsync("master", TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(1), default));
        }
        else
            Assert.Equal(0L, await db.ScalarAsync("SELECT max(epoch) FROM tenant_leases"));
    }

    [Fact]
    public async Task Operator_import_refuses_another_profile_a_second_operator_and_a_nonempty_volume()
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        Assert.Equal(HostedImport.Refused, (await OperatorCli(db, PostgresServer.Tenant, volume)).Code);
        await db.ExecuteOwnerAsync("UPDATE tenants SET profile='operator', pinned_role='master-host'");
        var second = await OperatorCli(db, "other", volume);
        Assert.Equal(HostedImport.Refused, second.Code);
        Assert.Contains("This deployment already has an operator tenant.", second.Output);
        var folder = Directory.CreateDirectory(Path.Combine(volume, (await db.TenantIdAsync()).ToString()));
        await File.WriteAllTextAsync(Path.Combine(folder.FullName, "existing"), "preserve me");
        var conflict = await OperatorCli(db, PostgresServer.Tenant, volume);
        Assert.Equal(HostedImport.Refused, conflict.Code);
        Assert.Equal("preserve me", await File.ReadAllTextAsync(Path.Combine(folder.FullName, "existing")));
        Assert.Equal(0L, await db.ScalarAsync("SELECT max(epoch) FROM tenant_leases"));
    }
}
