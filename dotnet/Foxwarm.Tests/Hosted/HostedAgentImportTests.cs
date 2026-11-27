using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Lease;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class HostedAgentImportTests
{
    // Optional offline volume from a stopped installation, checked without requiring its
    // separate installation state, keys or SQLite files.
    [Fact]
    public async Task A_real_Agents_volume_is_verified_file_by_file()
    {
        if (Environment.GetEnvironmentVariable("FOXWARM_AGENT_IMPORT_GOLDEN") is not { Length: > 0 } root)
            return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var tmp = new TempDirectory();
        var report = Path.Combine(Environment.GetEnvironmentVariable("FOXWARM_IMPORT_REPORT_DIR") ?? tmp.Path, $"agent-files-{Guid.NewGuid():N}.json");
        var result = await HostedAgentImport.RunAsync(db.OpenApp(), db.OpenOwner(), PostgresServer.Tenant, root, false, report, null, new StringWriter());
        var parsed = JsonNode.Parse(await File.ReadAllTextAsync(report))!;
        Assert.True(result == 0, parsed["error"]?.ToString());
        var checkedFiles = parsed["verification"]!["agentFiles"]!.AsArray();
        Assert.NotEmpty(checkedFiles);
        Assert.All(checkedFiles, file => Assert.Equal(file!["sourceSha256"]!.ToString(), file["importedSha256"]!.ToString()));
    }

    [Fact]
    public async Task An_existing_stopped_hosted_tenant_is_required_before_an_Agent_import()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var tmp = new TempDirectory();
        var root = Directory.CreateDirectory(Path.Combine(tmp.Path, "agents")).FullName;
        async Task Refused(string tenant, string message)
        {
            var report = Path.Combine(tmp.Path, Guid.NewGuid().ToString("N") + ".json");
            var code = await HostedAgentImport.RunAsync(db.OpenApp(), db.OpenOwner(), tenant, root, false, report, null, new StringWriter());
            Assert.Equal(HostedImport.Refused, code);
            var body = JsonNode.Parse(await File.ReadAllTextAsync(report))!;
            Assert.Contains(message, body["refusals"]!.ToString());
        }
        await Refused("not-created", "existing tenant");
        Assert.Null(await db.ScalarAsync("SELECT tenant_id FROM tenants WHERE name = 'not-created'"));
        var id = await db.TenantIdAsync();
        await db.TakeLeaseAsync(id);
        await Refused(PostgresServer.Tenant, "lease is held");
        Assert.Equal("active", await db.ScalarAsync("SELECT state FROM tenants WHERE tenant_id = $1", id));
        await db.ExecuteOwnerAsync("UPDATE tenant_leases SET state = 'released', owner_replica = NULL, expires_at = '-infinity'; UPDATE tenants SET profile = 'operator', pinned_role = 'master-host'");
        await Refused(PostgresServer.Tenant, "keeps its Agent files on master");
    }

    [Fact]
    public async Task Incompatible_schema_is_refused_before_changing_the_tenant()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var tmp = new TempDirectory();
        var root = Directory.CreateDirectory(Path.Combine(tmp.Path, "agents")).FullName;
        var report = Path.Combine(tmp.Path, "report.json");
        await db.ExecuteOwnerAsync("UPDATE schema_migrations SET sha256 = 'other' WHERE version = 1100");
        var code = await HostedAgentImport.RunAsync(db.OpenApp(), db.OpenOwner(), PostgresServer.Tenant, root, false, report, null, new StringWriter());
        Assert.Equal(HostedImport.Refused, code);
        Assert.Contains("Applied migrations differ", JsonNode.Parse(await File.ReadAllTextAsync(report))!["refusals"]!.ToString());
        Assert.Equal(0L, await db.ScalarAsync("SELECT epoch FROM tenant_leases"));
    }

    [Fact]
    public async Task An_offline_volume_import_retries_identical_files_and_never_overwrites_a_conflict()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var tmp = new TempDirectory();
        var root = Path.Combine(tmp.Path, "agents");
        var folder = Directory.CreateDirectory(Path.Combine(root, "alpha")).FullName;
        async Task<(int Exit, JsonObject Report)> Run(bool abandon = false)
        {
            var reportPath = Path.Combine(tmp.Path, $"{Guid.NewGuid():N}.json");
            string[] args = ["hosted", "agents", "import", "--tenant", PostgresServer.Tenant, "--report", reportPath, .. (abandon ? new[] { "--abandon" } : ["--from", root])];
            var stdout = new StringWriter();
            var exit = await HostedCli.RunAsync(args, stdout, stdout, new System.Collections.Hashtable
            {
                ["FOXWARM_DATABASE_URL"] = db.AppConnectionString,
                ["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString,
            });
            Assert.True(File.Exists(reportPath), stdout.ToString());
            return (exit, JsonNode.Parse(await File.ReadAllTextAsync(reportPath))!.AsObject());
        }
        await File.WriteAllTextAsync(Path.Combine(folder, "b"), "original");
        await File.WriteAllTextAsync(Path.Combine(root, "00_SYSTEM.local.md"), "framework");
        Directory.CreateDirectory(Path.Combine(folder, "empty"));
        foreach (var name in new[] { "tmp", ".temp" })
            await File.WriteAllTextAsync(Path.Combine(Directory.CreateDirectory(Path.Combine(folder, name)).FullName, "ignored"), "ignored");
        if (!OperatingSystem.IsWindows())
        {
            File.CreateSymbolicLink(Path.Combine(folder, "symbolic"), Path.Combine(folder, "missing"));
            var exec = Path.Combine(folder, "executable");
            await File.WriteAllTextAsync(exec, "data");
            File.SetUnixFileMode(exec, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        }
        await using (var oversized = File.Create(Path.Combine(folder, "oversized")))
            oversized.SetLength(AgentStoreLimits.Default.FileBytes + 1);
        var first = await Run();
        Assert.True(first.Exit == 0, first.Report.ToJsonString());
        Assert.Equal(2, first.Report["verification"]!["agentFiles"]!.AsArray().Count);
        Assert.All(first.Report["verification"]!["agentFiles"]!.AsArray(), file => Assert.Equal(file!["sourceSha256"]!.ToString(), file["importedSha256"]!.ToString()));
        var skipped = first.Report["notImported"]!.AsArray().Select(entry => entry!["what"]!.ToString()).ToArray();
        Assert.Contains("agents/alpha/oversized", skipped);
        Assert.Contains("agents/alpha/tmp", skipped);
        if (!OperatingSystem.IsWindows())
        {
            Assert.Contains("agents/alpha/symbolic", skipped);
            Assert.Contains("agents/alpha/executable", skipped);
        }
        await File.WriteAllTextAsync(Path.Combine(folder, "a"), "new");
        await File.WriteAllTextAsync(Path.Combine(folder, "b"), "modified");
        var conflict = await Run();
        Assert.Equal(HostedImport.Failed, conflict.Exit);
        Assert.Contains("alpha/b", conflict.Report["error"]!.ToString());
        Assert.Equal("importing-agents", await db.ScalarAsync("SELECT state FROM tenants WHERE name = $1", PostgresServer.Tenant));
        var lease = new TenantLease(db.OpenApp(), PostgresServer.Tenant, AgentCatalog.ReaderVersion);
        Assert.Null(await lease.TryAcquireAsync("replica", LeaseTimings.Default.Ttl, LeaseTimings.Default.RenewInterval, default));
        await File.WriteAllTextAsync(Path.Combine(folder, "b"), "original");
        Assert.Equal(0, (await Run()).Exit);
        Assert.Equal("active", await db.ScalarAsync("SELECT state FROM tenants WHERE name = $1", PostgresServer.Tenant));
        Assert.Equal(HostedImport.Refused, (await Run(abandon: true)).Exit);
        await File.WriteAllTextAsync(Path.Combine(folder, "b"), "modified");
        Assert.Equal(HostedImport.Failed, (await Run()).Exit);
        var abandoned = await Run(abandon: true);
        Assert.Equal(0, abandoned.Exit);
        Assert.Contains("alpha/a", abandoned.Report["filesInPlace"]!.AsArray().Select(file => file!.ToString()));
        Assert.Equal("active", await db.ScalarAsync("SELECT state FROM tenants WHERE name = $1", PostgresServer.Tenant));
        await db.ExecuteOwnerAsync("UPDATE tenants SET state = 'importing'");
        foreach (var abandon in new[] { false, true })
        {
            var refused = await Run(abandon);
            Assert.Equal(HostedImport.Refused, refused.Exit);
            Assert.Contains("full installation import", refused.Report["refusals"]!.ToString());
        }
        Assert.Equal("importing", await db.ScalarAsync("SELECT state FROM tenants WHERE name = $1", PostgresServer.Tenant));
    }
}
