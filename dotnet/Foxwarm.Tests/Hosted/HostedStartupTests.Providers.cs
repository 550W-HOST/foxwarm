using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedStartupTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SingleTenantEntryIgnoresGrantRows(bool master)
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        var definitions = ProviderTenancyTests.Deployment(temp.Path, ("extended", "extended", true), ("old", "legacy", false));
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        if (master) await database.ExecuteOwnerAsync("UPDATE tenants SET profile='operator', pinned_role='master-host'");
        await database.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id,quotas) SELECT tenant_id,'extended','{\"nodes\":0}' FROM tenants");
        var replica = StartHosted(database.OpenApp(), files, deploymentExtra: "nodeProviders: " + definitions.Root["nodeProviders"]!.ToJsonString(),
            role: master ? ReplicaRoles.MasterHost : ReplicaRoles.General);
        try
        {
            await WaitUntilAsync(() => replica.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(30), "single-tenant owner");
            var sessions = ((MainHostRuntime)replica.Runtimes.Single()).Host.Sessions;
            var drivers = sessions.Capabilities.Providers!.Drivers;
            Assert.Equal(master, sessions.NodeProviders.HasProvider("extended"));
            Assert.Equal(master, sessions.NodeProviders.HasProvider("old"));
            Assert.All(drivers.Values, driver => Assert.Null(driver.Quotas));
        }
        finally { replica.Stop.Cancel(); await replica.Run.WaitAsync(TimeSpan.FromSeconds(30)); }
        var lines = File.ReadLines(Path.Combine(files.Scratch, "state", "logs", "foxwarm.log"));
        Assert.Single(lines.Where(line => line.Contains("Provider grants aren't applied in single-tenant hosted mode.")));
    }
}
