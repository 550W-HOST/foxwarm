using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Providers;
using Foxwarm.Nodes;

namespace Foxwarm.Tests.Hosted;

public sealed partial class ProviderTenancyTests
{
    [Fact]
    public async Task AnUngrantedAncestorDisablesOnlyItsProviderSubtree()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var deployment = ProviderTenancyTests.Deployment(temp.Path,
            ("leaf", "extended", true), ("child", "extended", true), ("upstream", "extended", true), ("independent", "extended", true));
        var entries = deployment.Root["nodeProviders"]!.AsObject();
        entries["child"]!["parentNode"] = "upstream/anchor";
        entries["leaf"]!["parentNode"] = "child/first";
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var tenantId = await db.TenantIdAsync();
        foreach (var (id, entry) in entries)
        {
            var root = Path.Combine(temp.Path, id);
            entry!["args"]![1] = root;
            var folder = Path.Combine(root, tenantId.ToString());
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, (id == "upstream" ? "anchor" : "first") + ".node"), "");
        }
        await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,id FROM tenants CROSS JOIN unnest(ARRAY['leaf','child','independent']) id");
        var tenant = new TenantDb(db.OpenApp(), tenantId, await db.TakeLeaseAsync(tenantId));
        var scope = await new ProviderGrants(deployment).LoadAsync(tenant, PostgresServer.Tenant, TenantProfile.Hosted, default);
        using var hub = new NodeConnectionHub(Path.Combine(temp.Path, "hub"));
        await using var registry = new NodeProviderRegistry(hub, entries, tenant: scope);
        Assert.NotNull(await registry.ResolveAsync("independent/first", default));
        var listing = await registry.ListAsync(default);
        Assert.Contains(listing, n => n?["id"]?.ToString() == "independent/first");
        foreach (var id in new[] { "child", "leaf" })
        {
            Assert.Equal("parent-not-granted", scope.Problems[id]?.ToString());
            Assert.False(registry.HasProvider(id));
            Assert.Null(await registry.ResolveAsync(id + "/first", default));
            Assert.DoesNotContain(listing, n => n?["id"]?.ToString() == id + "/first");
        }
    }
}
