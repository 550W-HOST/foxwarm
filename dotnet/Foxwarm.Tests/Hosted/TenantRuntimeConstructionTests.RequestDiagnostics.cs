using System.Text.Json.Nodes;
using Foxwarm.Hosted;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantRuntimeConstructionTests
{
    [Fact]
    public async Task RequestTimeProviderDiagnosticsKeepTheirOwnerAndLineBoundaries()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        await using var harness = await CreateAsync();
        var deployment = ProviderTenancyTests.Deployment(temp.Path, ("shared", "extended", true));
        var alpha = await harness.AddTenantAsync("alpha");
        var beta = await harness.AddTenantAsync("beta");
        const string secret = "synthetic-request-diagnostic-secret-0002";
        await using (var seed = (MainHostRuntime)await harness.BuildAsync("beta", beta, deployment))
            seed.Host.Sessions.Models.ConfigurationOwner!.Secrets.Store.Set("beta-key", secret);
        await harness.Database.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,'shared' FROM tenants WHERE name IN ('alpha','beta')");
        const string marker = "[[FW_SECRET:beta-key]]";
        var prefix = "SERVICE-BEGIN".PadRight(8184, 'x');
        var suffix = "y".PadRight(850, 'y') + "SERVICE-END";
        var oversized = "LONG:".PadRight(64 * 1024, 'z');
        await File.WriteAllTextAsync(Path.Combine(temp.Path, $"stderr-{beta.Id}-list"), "INVENTORY " + secret + "\n");
        await File.WriteAllTextAsync(Path.Combine(temp.Path, $"stderr-{beta.Id}-connect"),
            prefix + secret + suffix + "\r\n" + oversized + "discarded-tail\nAFTER-LONG\n");
        var saved = Console.Out;
        using var capture = new StringWriter();
        try
        {
            Console.SetOut(capture);
            await using var first = await harness.BuildAsync("alpha", alpha, deployment);
            await first.StartAsync();
            await using var second = (MainHostRuntime)await harness.BuildAsync("beta", beta, deployment);
            await second.StartAsync();
            await second.Host.Sessions.NodeSummariesAsync();
            var registry = second.Host.Sessions.NodeProviders;
            await registry.LifecycleAsync("create", "shared", "shared/local", new(), "s", "main", default);
            await registry.RequestServiceAsync("shared/local", "vscode-fs", "stat", new(), default);
        }
        finally { Console.SetOut(saved); }
        const string tag = "[provider:shared] [tenant:beta] ";
        var records = capture.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(line => line.StartsWith('{')).Select(line => JsonNode.Parse(line)!)
            .Where(row => row["msg"]!.ToString().StartsWith(tag, StringComparison.Ordinal)
                && !row["msg"]!.ToString().Contains("fixture diagnostic")).ToArray();
        Assert.NotEmpty(records);
        Assert.All(records, row => Assert.Equal("beta", row["tenant"]?.ToString()));
        var messages = records.Select(row => row["msg"]!.ToString()[tag.Length..]).ToArray();
        Assert.Contains("INVENTORY " + marker, messages);
        Assert.Equal(new[] { prefix + marker + suffix, oversized + " [truncated]", "AFTER-LONG" },
            messages.Where(text => !text.StartsWith("INVENTORY ", StringComparison.Ordinal)));
        string Log(int id) => File.ReadAllText(Path.Combine(harness.Scratch, "t", id.ToString(), "state", "logs", "foxwarm.log"));
        Assert.DoesNotContain(tag, Log(alpha.Id));
        Assert.Contains(tag + prefix + marker + suffix, Log(beta.Id));
        Assert.DoesNotContain(secret, capture.ToString());
    }
}
