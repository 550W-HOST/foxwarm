using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Providers;
using Foxwarm.Nodes;
using Foxwarm.Secrets;

namespace Foxwarm.Tests.Hosted;

public sealed partial class ProviderTenancyTests
{
    [Theory]
    [InlineData("42", true)]
    [InlineData("43", false)]
    [InlineData("\"42\"", false)]
    [InlineData("42.1", false)]
    [InlineData("null", false)]
    [InlineData(null, false)]
    public void TenantIdentityEchoRequiresTheSameJsonInteger(string? echo, bool matches)
    {
        var request = new JsonObject
        {
            ["protocol"] = "foxwarm-node-provider", ["operation"] = "connect", ["providerId"] = "shared",
            ["requestId"] = "request", ["tenantId"] = 42,
        };
        var reply = (JsonObject)request.DeepClone();
        reply.Remove("tenantId");
        if (echo is not null) reply["tenantId"] = JsonNode.Parse(echo);
        reply["ok"] = true;
        reply["result"] = new JsonObject();
        if (matches)
            Assert.IsType<JsonObject>(ExecutableNodeProvider.ParseResponse("connect", request, reply));
        else
            Assert.Equal("NODE_PROVIDER_TENANT_MISMATCH", Assert.Throws<NodeProviderException>(() =>
                ExecutableNodeProvider.ParseResponse("connect", request, reply)).Code);
    }

    [Fact]
    public async Task RecreatedSlugCannotSeeOrOperateTheDeletedTenantsProviderNamespace()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var app = db.OpenApp();
        await using var op = new PgDatabase(db.OperatorConnectionString, "provider-identity-test");
        var store = new OperatorStore(op, KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(temp.Path, "kek"))));
        var deployment = Deployment(temp.Path, ("shared", "extended", true));
        var grants = new ProviderGrants(deployment);
        const string slug = "reused";

        async Task<int> CreateAndUse(bool original)
        {
            await store.CreateAsync(slug, "hosted", "reused.test", default);
            int id = await db.TenantIdAsync(slug);
            await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,'shared' FROM tenants WHERE name='reused'");
            long epoch = await db.TakeLeaseAsync(id);
            try
            {
                var selected = await grants.LoadAsync(new TenantDb(app, id, epoch), slug, TenantProfile.Hosted, default);
                using var hub = new NodeConnectionHub(Path.Combine(temp.Path, "core-" + id));
                await using var nodes = new NodeProviderRegistry(hub, deployment.Root["nodeProviders"]!.AsObject(), tenant: selected);
                if (!original)
                {
                    Assert.Empty(await nodes.ListAsync(default));
                    Assert.Null(await nodes.ResolveAsync("shared/old", default));
                }
                var local = original ? "old" : "new";
                await nodes.LifecycleAsync("create", "shared", "shared/" + local, new(), "s", "main", default);
                var item = Assert.Single(await nodes.ListAsync(default));
                Assert.Equal("shared/" + local, item!["id"]!.ToString());
                return id;
            }
            finally
            {
                await new TenantLease(app, slug, 2).ReleaseAsync(new LeaseGrant(id, slug, "test", epoch), default);
            }
        }

        var oldId = await CreateAndUse(true);
        await store.SuspendAsync(slug, default);
        await store.DeleteAsync(slug, default);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var deleting = store.RunDeletionLoopAsync(stop.Token);
        try
        {
            while (await db.ScalarAsync("SELECT tenant_id FROM tenants WHERE name='reused'") is not null)
                await Task.Delay(50, stop.Token);
        }
        finally { stop.Cancel(); await deleting; }
        var newId = await CreateAndUse(false);
        Assert.NotEqual(oldId, newId);
        var descriptions = Calls(temp.Path).Where(call => call["operation"]?.ToString() == "describe").ToArray();
        Assert.Equal(new[] { oldId, newId }, descriptions.Select(call => call["tenantId"]!.GetValue<int>()));
        // Deleting external resources is independent. The original driver's inventory still exists.
        Assert.True(File.Exists(Path.Combine(temp.Path, oldId.ToString(), "old.node")));
    }
}
