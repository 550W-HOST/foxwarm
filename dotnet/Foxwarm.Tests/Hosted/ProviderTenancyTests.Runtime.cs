using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Providers;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

public sealed partial class ProviderTenancyTests
{
    [Fact]
    public async Task ConcurrentQuotaCountsStartsInFlightAndRestoredJobsWithoutTakingAResidentRpcSlot()
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var deployment = Deployment(temp.Path,("shared","extended",true));
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id,quotas) SELECT tenant_id,'shared','{\"execs\":1}' FROM tenants");
        int id = await db.TenantIdAsync();
        var slug = PostgresServer.Tenant;
        var tenant = new TenantDb(db.OpenApp(),id,await db.TakeLeaseAsync(id));
        var drivers = await new ProviderGrants(deployment).LoadAsync(tenant,slug,TenantProfile.Hosted,default);
        using var hub = new NodeConnectionHub(Path.Combine(temp.Path,"native")) { AdmitCall = _ => throw new InvalidOperationException("Resident RPC slot was taken") };
        await using var registry = new NodeProviderRegistry(hub,deployment.Root["nodeProviders"]!.AsObject(),tenant:drivers);
        await registry.LifecycleAsync("create","shared","shared/test",new(),"s","main",default);
        var backend = await registry.AdmitExecAsync("shared/test",default);
        var documents = new PgStateDocuments(tenant);
        LocalExecManager Manager() => new(temp.Path,_=>temp.Path,(_,_,_)=>Task.CompletedTask,documents:documents) { ResolveProviderBackend=registry.ResolveExecBackend };
        Task<JsonObject> Run(LocalExecManager manager) => manager.ExecuteAsync("s",new JsonObject { ["command"]="held job",["timeout"]=1 },default,backend:backend);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var holdPath = Path.Combine(temp.Path,"hold-start");
        File.WriteAllText(holdPath,"");
        await using (var first = Manager())
        {
            var running = Run(first);
            try
            {
                while (!Calls(temp.Path).Any(call=>call["operation"]?.ToString()=="exec-start")) await Task.Delay(20,stop.Token);
                Assert.Equal("NODE_PROVIDER_EXEC_LIMIT",(await Assert.ThrowsAsync<NodeProviderException>(()=>Run(first))).Code);
            }
            finally { File.Delete(holdPath); }
            await running.WaitAsync(stop.Token);
            Assert.Equal(1,first.TrackedCount);
        }
        await using var restored = Manager();
        await restored.RegisterRecordsAsync(_=>true);
        Assert.Equal(1,restored.TrackedCount);
        Assert.Equal("NODE_PROVIDER_EXEC_LIMIT",(await Assert.ThrowsAsync<NodeProviderException>(()=>Run(restored))).Code);
        Assert.Single(Calls(temp.Path),call=>call["operation"]?.ToString()=="exec-start");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BootChecksActualDriversAndReportsUnavailableOnesWithoutCredentials(bool master)
    {
        if (!OperatingSystem.IsLinux()) return;
        using var temp = new TempDirectory();
        var deployment = Deployment(temp.Path,("extended","extended",true),("legacy","legacy",false),
            ("mismatch","legacy",true),("broken","broken",true),("duplicate","duplicate",true),("ungranted","extended",true),("child","extended",true));
        deployment.Root["nodeProviders"]!["child"]!["parentNode"] = "ungranted/anchor";
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var slug = PostgresServer.Tenant;
        if (master) await db.ExecuteOwnerAsync("UPDATE tenants SET profile='operator'");
        await db.ExecuteOwnerAsync("INSERT INTO provider_grants(tenant_id,provider_id) SELECT tenant_id,id FROM tenants CROSS JOIN unnest(ARRAY['extended','broken','mismatch','duplicate','child']) id");
        var key = Path.Combine(temp.Path,"kek","current.key");
        _ = InstanceKeys.OpenOrCreate(key);
        var boot = new HostedBootstrap(null,null,slug,PostgresServer.AppRole,ScratchRoot:Path.Combine(temp.Path,"scratch"),KekFile:key);
        var timings = new LeaseTimings(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        using var stop = new CancellationTokenSource();
        MainHostRuntime current = null!;
        var replica = new TenantReplica(new TenantReplicaOptions("provider-host",null,null,new IPEndPoint(IPAddress.Loopback,0),
            s=>$"http://{s}.test",timings,TimeSpan.FromSeconds(5),2) { Role=master?ReplicaRoles.MasterHost:ReplicaRoles.General,
                Mesh=new(new(IPAddress.Loopback,0),"127.0.0.1",System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)) },db.OpenApp(),db.AppConnectionString,
            async (context,ct)=>current=(MainHostRuntime)await HostedEntry.CreateTenantRuntimeAsync(context,boot,deployment,ct), _=>{},
            code=>throw new InvalidOperationException("Unexpected exit " + code));
        var serving = replica.RunAsync(stop.Token);
        try
        {
            await replica.Serving.WaitAsync(TimeSpan.FromSeconds(10));
            await replica.Activations!.ActivateAsync(slug);
            var registry = current.Host.Sessions.NodeProviders;
            Assert.True(registry.HasProvider("extended"));
            Assert.Equal(master,registry.HasProvider("legacy"));
            Assert.Equal(master,registry.HasProvider("ungranted"));
            Assert.False(registry.HasProvider("mismatch"));
            Assert.False(registry.HasProvider("broken"));
            Assert.False(registry.HasProvider("duplicate"));
            var calls = Calls(temp.Path);
            Assert.Equal(master,calls.Any(c=>c["providerId"]?.ToString()=="legacy"));
            Assert.All(calls.Where(c=>c["providerId"]?.ToString()=="legacy"),c=>Assert.False(c.ContainsKey("tenantId")));
            using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            string? raw;
            while ((raw=await db.ScalarAsync("SELECT (capacity->'tenants'->$1->'providerProblems')::text FROM replicas WHERE name='provider-host'",slug) as string) is null)
                await Task.Delay(20,bound.Token);
            var problems = JsonNode.Parse(raw)!.AsObject();
            Assert.Equal(master ? 3 : 4, problems.Count);
            Assert.Equal(master, registry.HasProvider("child"));
            if (!master) Assert.Equal("parent-not-granted", problems["child"]!.ToString());
            Assert.Equal("describe-failed",problems["duplicate"]!.ToString());
            Assert.Equal("tenancy-mismatch",problems["mismatch"]!.ToString());
            Assert.Equal("describe-failed",problems["broken"]!.ToString());
            if (master)
            {
                var choices = current.Host.Sessions.Capabilities.Providers!.Drivers;
                Assert.Null(choices["legacy"].Quotas);
                Assert.Null(choices["ungranted"].Quotas);
                Assert.Equal(new ProviderQuotas(),choices["extended"].Quotas);
            }
            else
            {
                await db.ExecuteOwnerAsync("DELETE FROM provider_grants WHERE provider_id='extended'; UPDATE tenants SET settings_revision=settings_revision+1; SELECT pg_notify('foxwarm_tenants',tenant_id::text) FROM tenants");
                while (replica.Activations.Current(slug) is not null) await Task.Delay(25,bound.Token);
                await replica.Activations.ActivateAsync(slug);
                Assert.False(current.Host.Sessions.NodeProviders.HasProvider("extended"));
            }
        }
        finally { stop.Cancel(); await serving.WaitAsync(TimeSpan.FromSeconds(15)); }
    }
}
