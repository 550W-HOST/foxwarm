using System.Text.Json.Nodes;
using Foxwarm.Hosted;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantRuntimeConstructionTests
{
    [Fact]
    public async Task StartupProviderDiagnosticsUseTheirOwnTenantSinkAndMasker()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        await using var harness = await CreateAsync();
        var deployment = ProviderTenancyTests.Deployment(temp.Path, ("shared", "extended", true));
        var alpha = await harness.AddTenantAsync("alpha");
        var beta = await harness.AddTenantAsync("beta");
        const string value = "synthetic-beta-diagnostic-secret-002";
        await using (var seed = (MainHostRuntime)await harness.BuildAsync("beta", beta, deployment))
            seed.Host.Sessions.Models.ConfigurationOwner!.Secrets.Store.Set("probe-key", value);
        await harness.Database.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,'shared' FROM tenants WHERE name IN ('alpha','beta')");
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "diagnostic-" + beta.Id), value);
        var original = Console.Out;
        using var console = new StringWriter();
        try
        {
            Console.SetOut(console);
            await using var first = await harness.BuildAsync("alpha", alpha, deployment);
            await first.StartAsync();
            await using var second = await harness.BuildAsync("beta", beta, deployment);
            await second.StartAsync();
        }
        finally { Console.SetOut(original); }
        var diagnostics = console.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith('{')).Select(line => JsonNode.Parse(line)!)
            .Where(row => row["msg"]!.ToString().Contains("fixture diagnostic")).ToArray();
        Assert.Equal(new[] { "alpha", "beta" }, diagnostics.Select(row => row["tenant"]?.ToString()));
        Assert.Contains("[[FW_SECRET:probe-key]]", diagnostics[1]["msg"]!.ToString());
        Assert.DoesNotContain(value, console.ToString());
        string Log(int id) => File.ReadAllText(Path.Combine(harness.Scratch, "t", id.ToString(), "state", "logs", "foxwarm.log"));
        Assert.DoesNotContain("[tenant:beta]", Log(alpha.Id));
        Assert.Contains("fixture diagnostic [[FW_SECRET:probe-key]]", Log(beta.Id));
    }
}
