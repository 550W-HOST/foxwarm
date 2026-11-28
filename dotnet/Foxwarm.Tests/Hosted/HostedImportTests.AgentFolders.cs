using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    [Fact]
    public async Task Target_file_limit_governs_the_dry_run_and_actual_Agent_inventory()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("UPDATE tenants SET limits=jsonb_build_object('agentFileBytes',32)");
        var root = Directory.CreateDirectory(Path.Combine(temp.Path, "agents")).FullName;
        await File.WriteAllBytesAsync(Path.Combine(root, "accepted"), new byte[32]);
        await File.WriteAllBytesAsync(Path.Combine(root, "skipped"), new byte[33]);
        foreach (var dryRun in new[] { true, false })
        {
            var result = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports, options => options with { AgentsDirectory = root }, dryRun: dryRun);
            Assert.True(result.Exit == 0, result.Report.ToJsonString());
            Assert.Equal(1, result.Report["plan"]!["agentFiles"]!.GetValue<int>());
            Assert.Contains(result.Report["notImported"]!.AsArray(), e => e!["what"]!.ToString() == "agents/skipped");
        }
        Assert.Equal("accepted", await db.ScalarAsync("SELECT path FROM agent_files WHERE kind='file'"));
    }

    [Fact]
    public async Task Configured_Agent_root_supplies_non_main_memory()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await File.AppendAllTextAsync(Path.Combine(fixture.DataRoot, "state/config.yaml"), "\npaths:\n  agentsDir: custom-agents\n");
        var memory = Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "custom-agents/alpha/memory")).FullName;
        await File.WriteAllTextAsync(Path.Combine(memory, "MEMORY.md"), "source memory");
        var result = await RunAsync(db, fixture.DataRoot, "configured", Reports);
        Assert.True(result.Exit == 0, result.Report.ToJsonString());
        Assert.Contains(result.Report["verification"]!["agentFiles"]!.AsArray(), e => e!["path"]!.ToString() == "alpha/memory/MEMORY.md");
    }

    [Theory]
    [InlineData("missing-agents", "is missing")]
    [InlineData("../separate", "is outside the offline copy")]
    [InlineData("~/separate", "can't be found in the offline copy")]
    public async Task Unresolved_configured_Agent_root_requires_an_explicit_staged_directory(string configured, string reason)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await File.AppendAllTextAsync(Path.Combine(fixture.DataRoot, "state/config.yaml"), $"\npaths:\n  agentsDir: {configured}\n");
        var refused = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports);
        Assert.Equal(HostedImport.Refused, refused.Exit);
        Assert.Contains(reason, Assert.Single(refused.Report["refusals"]!.AsArray())!.GetValue<string>());
        Assert.Equal(0L, await db.ScalarAsync("SELECT epoch FROM tenant_leases"));
        // An explicitly staged, separate volume wins even over an unresolvable source setting.
        var root = Directory.CreateDirectory(Path.Combine(temp.Path, "staged")).FullName;
        var folder = Directory.CreateDirectory(Path.Combine(root, "different", "memory")).FullName;
        await File.WriteAllTextAsync(Path.Combine(folder, "MEMORY.md"), "memory from the staged volume");
        var report = Path.Combine(Reports, "cli.json");
        var stdout = new StringWriter();
        var exit = await HostedCli.RunAsync(["hosted", "import", "--data-root", fixture.DataRoot,
            "--agents-dir", root, "--tenant", PostgresServer.Tenant, "--report", report], stdout, stdout,
            new System.Collections.Hashtable { ["FOXWARM_DATABASE_URL"] = db.AppConnectionString,
                ["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString, ["FOXWARM_KEK_FILE"] = InstanceKeys.DefaultPath(fixture.DataRoot) });
        Assert.True(exit == 0, stdout.ToString());
        var imported = JsonNode.Parse(await File.ReadAllTextAsync(report))!;
        Assert.Equal("different/memory/MEMORY.md", Assert.Single(imported["verification"]!["agentFiles"]!.AsArray())!["path"]!.ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Store_import_requires_hosted_profile_at_acquisition_and_activation(bool changeDuringCopy)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        const string edit = "UPDATE tenants SET profile = 'operator', pinned_role = 'master-host'";
        if (!changeDuringCopy)
            await db.ExecuteOwnerAsync(edit);
        var changed = false;
        var result = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports, options => options with
        {
            BeforePhase = async _ => { if (changeDuringCopy && !changed) { changed = true; await db.ExecuteOwnerAsync(edit); } }
        });
        Assert.NotEqual(HostedImport.Imported, result.Exit);
        Assert.Equal(changeDuringCopy ? "importing" : "active", await TenantStateAsync(db, PostgresServer.Tenant));
        if (!changeDuringCopy)
            Assert.Equal(0L, await db.ScalarAsync("SELECT epoch FROM tenant_leases"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Agent_only_import_reader_floor_is_checked_under_lock(bool abandon)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await db.ExecuteOwnerAsync($"UPDATE tenants SET state = '{(abandon ? "importing-agents" : "active")}', min_reader_version = {AgentCatalog.ReaderVersion + 1}");
        var report = Path.Combine(Reports, "reader.json");
        var exit = await HostedAgentImport.RunAsync(db.OpenApp(), db.OpenOwner(), PostgresServer.Tenant, abandon ? null : Path.Combine(fixture.DataRoot, "agents"), abandon, report, null, new StringWriter());
        Assert.Equal(HostedImport.Refused, exit);
        Assert.Contains("installation level", JsonNode.Parse(await File.ReadAllTextAsync(report))!["refusals"]!.ToString());
        Assert.Equal(0L, await db.ScalarAsync("SELECT epoch FROM tenant_leases"));
    }

    [Fact]
    public async Task Unindexable_subtree_is_reported_without_stopping_the_import()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var key = string.Join('/', Enumerable.Repeat(new string('x', 220), 12));
        var dir = Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "agents/main", key));
        await File.WriteAllTextAsync(Path.Combine(dir.FullName, "notes"), "data");
        var result = await RunAsync(db, fixture.DataRoot, "deep", Reports);
        Assert.True(result.Exit == 0, result.Report["error"]?.ToString());
        Assert.Contains(result.Report["notImported"]!.AsArray(), e => e!["what"]!.ToString() == "agents/main/" + key);
    }
}
