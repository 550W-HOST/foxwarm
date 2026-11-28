using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    [Fact]
    public async Task Operator_import_and_master_reopen_the_same_physical_volume()
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var physical = Directory.CreateDirectory(Path.Combine(temp.Path, "physical", "volume")).FullName;
        Directory.CreateDirectory(Path.Combine(temp.Path, "volume")); // The other lexical interpretation also exists.
        Directory.CreateDirectory(Path.Combine(temp.Path, "physical", "child"));
        Directory.CreateSymbolicLink(Path.Combine(temp.Path, "jump"), "physical/child");
        var configured = Path.Combine(temp.Path, "configured");
        Directory.CreateSymbolicLink(configured, "jump/../volume");
        var result = await OperatorCli(db, "ops", configured);
        Assert.True(result.Code == 0, result.Output);
        var id = await db.TenantIdAsync("ops");
        Assert.True(Directory.Exists(Path.Combine(physical, id.ToString())));
        Assert.Equal(Path.Combine(physical, id.ToString()), HostedBootstrap.OperatorAgentsRoot(configured, id));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(temp.Path, "volume")));
    }

    [Fact]
    public async Task Operator_import_refuses_a_volume_whose_physical_parent_is_in_the_source()
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "child"));
        Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "volume"));
        Directory.CreateDirectory(Path.Combine(temp.Path, "volume"));
        Directory.CreateSymbolicLink(Path.Combine(temp.Path, "jump"), Path.Combine(fixture.DataRoot, "child"));
        var alias = Path.Combine(temp.Path, "alias");
        Directory.CreateSymbolicLink(alias, "jump/../volume");
        var result = await OperatorCli(db, "ops", alias);
        Assert.Equal(HostedImport.Refused, result.Code);
        Assert.Contains("outside the installation", result.Output);
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenants WHERE name='ops'"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Operator_import_refuses_an_unwritable_volume_before_writing_a_tenant(bool dryRun)
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        var mode = File.GetUnixFileMode(volume);
        try
        {
            File.SetUnixFileMode(volume, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            // A privileged test process can write through this mode; it isn't a read-only fixture.
            try { File.WriteAllText(Path.Combine(volume, "probe"), ""); return; }
            catch (UnauthorizedAccessException) { }
            var result = await OperatorCli(db, "ops", volume, dryRun ? ["--dry-run"] : []);
            Assert.Equal(HostedImport.Refused, result.Code);
            Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenants WHERE name='ops'"));
        }
        finally { File.SetUnixFileMode(volume, mode); }
    }

    [Fact]
    public async Task Abandon_refuses_a_missing_volume_and_keeps_the_deletion_handoff_unstarted()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("UPDATE tenants SET state='importing', profile='operator', pinned_role='master-host'");
        var code = await HostedImport.AbandonAsync(db.OpenApp(), db.OpenOwner(), PostgresServer.Tenant, TenantProfile.Operator,
            Path.Combine(temp.Path, "absent"), Path.Combine(Reports,"abandon.json"), new StringWriter());
        Assert.Equal(HostedImport.Refused, code);
        Assert.Equal("importing", await TenantStateAsync(db, PostgresServer.Tenant));
        Assert.Equal(0L, await db.ScalarAsync("SELECT max(epoch) FROM tenant_leases"));
    }

    [Fact]
    public async Task Failure_to_sync_the_published_directorys_parent_keeps_the_import_offline()
    {
        if (!OperatingSystem.IsLinux()) return;
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("UPDATE tenants SET profile='operator', pinned_role='master-host'");
        var volume = Directory.CreateDirectory(Path.Combine(temp.Path, "volume")).FullName;
        var mode = File.GetUnixFileMode(volume);
        try
        {
            File.SetUnixFileMode(volume, UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            try { Directory.GetFileSystemEntries(volume); return; }
            catch (UnauthorizedAccessException) { }
            File.SetUnixFileMode(volume, mode);
            var result = await RunAsync(db, fixture.DataRoot, PostgresServer.Tenant, Reports, options => options with
            {
                Profile = TenantProfile.Operator, AgentsVolume = volume,
                BeforePhase = name =>
                {
                    if (name == "catalog") File.SetUnixFileMode(volume, UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                    return Task.CompletedTask;
                },
            });
            Assert.Equal(HostedImport.Failed, result.Exit);
            Assert.Equal("importing", await TenantStateAsync(db, PostgresServer.Tenant));
            Assert.True(Directory.Exists(Path.Combine(volume, (await db.TenantIdAsync()).ToString())));
        }
        finally { File.SetUnixFileMode(volume, mode); }
    }
}
