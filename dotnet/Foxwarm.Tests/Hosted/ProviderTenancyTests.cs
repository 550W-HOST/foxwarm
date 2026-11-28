using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Providers;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

public sealed partial class ProviderTenancyTests
{
    internal static DeploymentConfiguration Deployment(string root, params (string Id,string Mode,bool Declared)[] providers)
    {
        var entries = new JsonObject();
        foreach (var (id,mode,declared) in providers)
        {
            var value = new JsonObject { ["type"]="executable", ["command"]="python3",
                ["args"]=new JsonArray(Path.Combine(AppContext.BaseDirectory,"Tools","Fixtures","tenant-provider.py"),root,mode), ["timeoutSeconds"]=6 };
            if (declared) value["tenancy"]="per-tenant";
            entries[id] = value;
        }
        return DeploymentConfiguration.Parse(new JsonObject { ["url"]="http://{slug}.test", ["blobs"]=new JsonObject { ["backend"]="postgres" },
            ["health"]=new JsonObject { ["port"]=3081 }, ["nodeProviders"]=entries }.ToJsonString());
    }

    private static JsonObject[] Calls(string root) => File.Exists(Path.Combine(root,"calls.jsonl"))
        ? File.ReadAllLines(Path.Combine(root,"calls.jsonl")).Select(line=>JsonNode.Parse(line)!.AsObject()).ToArray() : [];

    [Fact]
    public void OperatorValidationUsesOnlyTheDeploymentAndStrictQuotaObject()
    {
        using var temp = new TempDirectory();
        var validator = new ProviderGrants(Deployment(temp.Path,("shared","extended",true),("old","legacy",false)));
        ProviderQuotas Validate(string id, string json, TenantProfile profile = TenantProfile.Hosted) =>
            validator.Validate(id,profile,JsonNode.Parse(json),default);
        Assert.Equal(new(10,8,60),Validate("shared","{}"));
        Assert.Equal(new(0,2,60),Validate("shared","{\"nodes\":0,\"execs\":2}"));
        foreach (var json in new[] { "null", "[]", "{\"nodes\":null}", "{\"execs\":1.5}", "{\"nodes\":-1}", "{\"extra\":2}", "{\"execs\":\"2\"}", "{\"execs\":1.0000000000000001}" })
            Assert.Throws<InvalidDataException>(() => Validate("shared",json));
        Assert.Throws<InvalidDataException>(() => Validate("Shared","{}"));
        Assert.Throws<InvalidDataException>(() => Validate("old","{}"));
        Assert.Equal(new(),Validate("old","{}",TenantProfile.Operator));
        Assert.Empty(Calls(temp.Path));
    }

    [Fact]
    public async Task TenantScopedInventoryAndAllEnvelopesUseTheGrantedSlug()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var deployment = Deployment(temp.Path,("shared","extended",true),("first-only","extended",true),("hidden","legacy",false));
        var diagnostics = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var grants = new ProviderGrants(deployment, diagnostics.Enqueue);
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("INSERT INTO tenants(name) VALUES('second'); INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM tenants WHERE name='second'; INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,'shared' FROM tenants");
        await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,'first-only' FROM tenants WHERE name<>'second'");
        var app = db.OpenApp();
        async Task<TenantProviders> Open(string slug)
        {
            int id = await db.TenantIdAsync(slug);
            return await grants.LoadAsync(new TenantDb(app,id,await db.TakeLeaseAsync(id)),slug,TenantProfile.Hosted,default);
        }
        var first = await Open(PostgresServer.Tenant);
        var second = await Open("second");
        using var aHub = new NodeConnectionHub(Path.Combine(temp.Path,"a"));
        using var bHub = new NodeConnectionHub(Path.Combine(temp.Path,"b"));
        var config = deployment.Root["nodeProviders"]!.AsObject();
        await using var a = new NodeProviderRegistry(aHub,config,tenant:first);
        await using var b = new NodeProviderRegistry(bHub,config,tenant:second);
        Assert.False(a.HasProvider("hidden"));
        Assert.True(a.HasProvider("first-only"));
        Assert.False(b.HasProvider("first-only"));
        Assert.Contains($"[provider:shared] [tenant:{PostgresServer.Tenant}] fixture diagnostic",diagnostics);
        Assert.Contains("[provider:shared] [tenant:second] fixture diagnostic",diagnostics);
        await a.LifecycleAsync("create","shared","shared/first",new(),"session","main",default);
        await b.LifecycleAsync("create","shared","shared/second",new(),"session","main",default);
        Assert.DoesNotContain(await a.ListAsync(default),item=>item?["id"]?.ToString()=="shared/second");
        Assert.DoesNotContain(await b.ListAsync(default),item=>item?["id"]?.ToString()=="shared/first");
        // Identical qualified Node IDs in two tenants must use different long-lived streams.
        await a.LifecycleAsync("create", "shared", "shared/common", new(), "session", "main", default);
        await b.LifecycleAsync("create", "shared", "shared/common", new(), "session", "main", default);
        async Task<string> Owner(NodeProviderRegistry registry) =>
            (await registry.RequestServiceAsync("shared/common", "vscode-fs", "stat", new(), default))["owner"]!.ToString();
        Assert.Equal(PostgresServer.Tenant, await Owner(a));
        Assert.Equal("second", await Owner(b));
        Assert.Equal(PostgresServer.Tenant, await Owner(a));
        var calls = Calls(temp.Path);
        Assert.Equal(2, calls.Count(c => c["operation"]?.ToString() == "connect"));
        Assert.All(calls.Where(c => c.ContainsKey("protocol")),
            c => Assert.Contains(c["tenant"]?.ToString(), new[] { PostgresServer.Tenant, "second" }));
        Assert.All(calls.Where(c => c["type"]?.ToString() == "node_service_request"), c => Assert.False(c.ContainsKey("tenant")));
        File.WriteAllText(Path.Combine(temp.Path,"mismatch-list"),"");
        Assert.Equal("NODE_PROVIDER_TENANT_MISMATCH",(await Assert.ThrowsAsync<NodeProviderException>(()=>b.ListAsync(default))).Code);
        File.Delete(Path.Combine(temp.Path,"mismatch-list"));
        File.WriteAllText(Path.Combine(temp.Path,"mismatch-connect"),"");
        await Assert.ThrowsAsync<Foxwarm.Code.CodeServiceException>(()=>b.RequestServiceAsync("shared/second","vscode-fs","stat",new(),default));
    }

    [Fact]
    public async Task NodeAndHourlyLimitsPrecedeDriverEffectsAndSurviveEpochChanges()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var deployment = Deployment(temp.Path,("shared","extended",true));
        var grants = new ProviderGrants(deployment);
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        int id = await db.TenantIdAsync();
        await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id,quotas) SELECT tenant_id,'shared','{\"nodes\":1,\"lifecycleActionsPerHour\":2}' FROM tenants");
        var app = db.OpenApp();
        var slug = PostgresServer.Tenant;
        async Task<NodeProviderRegistry> Open(NodeConnectionHub hub) => new(hub,deployment.Root["nodeProviders"]!.AsObject(),tenant:
            await grants.LoadAsync(new TenantDb(app,id,await db.TakeLeaseAsync(id)),slug,TenantProfile.Hosted,default));
        using var hub1 = new NodeConnectionHub(Path.Combine(temp.Path,"native1"));
        await using var first = await Open(hub1);
        Task<JsonObject> Run(NodeProviderRegistry registry,string action,string name) => registry.LifecycleAsync(action,"shared","shared/"+name,new(),"s","main",default);
        await Run(first,"create","one");
        Assert.Equal("NODE_PROVIDER_NODE_LIMIT",(await Assert.ThrowsAsync<NodeProviderException>(()=>Run(first,"ensure","two"))).Code);
        await Run(first,"ensure","one");
        using var hub2 = new NodeConnectionHub(Path.Combine(temp.Path,"native2"));
        await using var next = await Open(hub2);
        Assert.Equal("NODE_PROVIDER_LIFECYCLE_LIMIT",(await Assert.ThrowsAsync<NodeProviderException>(()=>Run(next,"destroy","one"))).Code);
        Assert.Single(Calls(temp.Path),c=>c["operation"]?.ToString()=="ensure");
        Assert.DoesNotContain(Calls(temp.Path),c=>c["operation"]?.ToString()=="destroy");
        // Age both charges beyond the rolling hour in the authoritative tenant state.
        var epoch = (long)(await db.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id=$1",id))!;
        var tenant = new TenantDb(app,id,epoch);
        await tenant.WriteAsync(tx=>tx.Execute("UPDATE state_documents SET text='{\"shared\":[1,2]}' WHERE name='provider-lifecycle'"));
        await Run(next,"destroy","one");
        Assert.Single(Calls(temp.Path),c=>c["operation"]?.ToString()=="destroy");
    }
}
