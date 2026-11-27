using System.Collections;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedStartupTests
{
    [Fact]
    public void Master_host_bootstrap_requires_its_volume_path()
    {
        var error = Assert.Throws<HostedBootstrapException>(() => HostedBootstrap.FromEnvironment(new Hashtable { ["FOXWARM_ROLE"] = ReplicaRoles.MasterHost }));
        Assert.Equal("A master-host replica needs FOXWARM_AGENTS_DIR, the persistent volume path for its Agent folders.", error.Message);
    }

    [Fact]
    public async Task Operator_runtime_reopens_its_physical_Agent_files_after_a_restart()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'operator', pinned_role = 'master-host'");
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path) with { Agents = Path.Combine(temp.Path, "volume", "agents") };
        var tenantId = await database.TenantIdAsync();
        var root = Path.Combine(files.Agents, tenantId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(Path.Combine(files.Agents, (tenantId + 1).ToString(), "other"));
        var folder = Directory.CreateDirectory(Path.Combine(root, "ops", "memory"));
        await File.WriteAllTextAsync(Path.Combine(folder.FullName, "MEMORY.md"), "volume memory");
        for (var boot = 0; boot < 2; boot++)
        {
            var replica = StartHosted(database.OpenApp(), files, role: ReplicaRoles.MasterHost);
            try
            {
                await WaitUntilAsync(() => replica.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "operator runtime starts");
                var sessions = ((MainHostRuntime)Assert.Single(replica.Runtimes)).Host.Sessions;
                Assert.Contains("ops", sessions.Agents());
                Assert.DoesNotContain("other", sessions.Agents());
                Assert.Equal(Path.Combine(root, "ops"), sessions.AgentDirectory("ops"));
                Assert.Null(sessions.AgentStore);
                if (boot == 0)
                {
                    var owner = await sessions.CreateNamedAsync("ops", "work", null, null);
                    await sessions.FolderFiles.WriteAsync("ops", "record.txt", "first boot"u8.ToArray(), null, default);
                    Assert.Equal("master", sessions.CurrentNode(owner));
                }
                else
                {
                    Assert.Equal("first boot", await File.ReadAllTextAsync(Path.Combine(root, "ops", "record.txt")));
                    Assert.NotNull(await sessions.GetExistingAsync("ops/work"));
                }
                Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM agent_files"));
            }
            finally
            {
                replica.Stop.Cancel();
                await replica.Run.WaitAsync(TimeSpan.FromSeconds(60));
            }
        }
    }
}
