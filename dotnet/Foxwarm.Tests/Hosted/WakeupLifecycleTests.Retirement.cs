using System.Net;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Secrets;

namespace Foxwarm.Tests.Hosted;

public sealed partial class WakeupLifecycleTests
{
    private sealed class LiveReplica : IAsyncDisposable
    {
        internal required HostedTestDatabase Db;
        internal required TenantReplica Replica;
        internal MainHostRuntime Current = null!;
        internal Func<TenantRuntimeContext, Task>? BeforeBuild;
        internal readonly System.Collections.Concurrent.ConcurrentQueue<string> Logs = new();
        internal CancellationTokenSource Stop = new();
        internal TempDirectory Temp = new();
        private Task serving = null!;
        internal string Slug => PostgresServer.Tenant;
        internal TenantActivations Generations => Replica.Activations!;
        internal static async Task<LiveReplica> StartAsync(bool master = false)
        {
            var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
            await db.ExecuteOwnerAsync("INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT name || '.test',tenant_id,'primary' FROM tenants ON CONFLICT DO NOTHING");
            if (master) await db.ExecuteOwnerAsync("UPDATE tenants SET profile='operator'");
            var config = DeploymentConfiguration.Parse("url: 'http://{slug}.test'\nblobs: {backend: postgres}\nhealth: {port: 3081}\n");
            LiveReplica live = null!;
            HostedBootstrap bootstrap = null!;
            var timings = new LeaseTimings(TimeSpan.FromSeconds(12),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(6));
            var replica = new TenantReplica(new TenantReplicaOptions("schedule-tests",null,null,new IPEndPoint(IPAddress.Loopback,0),
                slug => $"http://{slug}.test", timings, TimeSpan.FromSeconds(4), 2)
            { Role = master ? ReplicaRoles.MasterHost : ReplicaRoles.General,
                Mesh = new(new(IPAddress.Loopback,0),"127.0.0.1",System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)) },
                db.OpenApp(), db.AppConnectionString, async (context,ct) =>
                {
                    if (live.BeforeBuild is { } before) await before(context);
                    return live.Current = (MainHostRuntime)await HostedEntry.CreateTenantRuntimeAsync(context,bootstrap,config,ct);
                }, line => live.Logs.Enqueue(line),
                code => throw new InvalidOperationException("Unexpected exit " + code));
            live = new LiveReplica { Db=db, Replica=replica };
            var kek = Path.Combine(live.Temp.Path,"kek","current.key");
            _ = InstanceKeys.OpenOrCreate(kek);
            bootstrap = new(null,null,PostgresServer.Tenant,PostgresServer.AppRole,ScratchRoot:Path.Combine(live.Temp.Path,"scratch"),KekFile:kek);
            live.serving = replica.RunAsync(live.Stop.Token);
            await replica.Serving.WaitAsync(TimeSpan.FromSeconds(12));
            return live;
        }
        public async ValueTask DisposeAsync()
        {
            Stop.Cancel();
            await serving.WaitAsync(TimeSpan.FromSeconds(15));
            Stop.Dispose();
            Temp.Dispose();
            await Db.DisposeAsync();
        }
    }

    [Fact]
    public async Task AFailedDeadlineReadHandsBackAnImmediateWakeForRecoveryAndRouting()
    {
        await using var live = await LiveReplica.StartAsync();
        var generation = await live.Generations.ActivateAsync(live.Slug);
        var initial = await live.Db.ScalarAsync("SELECT expires_at FROM tenant_leases");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(22));
        while (Equals(initial, await live.Db.ScalarAsync("SELECT expires_at FROM tenant_leases"))) await Task.Delay(35,deadline.Token);
        // Fail exactly the canonical wait projection, while the independent renewal connection
        // and epoch-checked release remain healthy. No Session has been created in this tenant.
        await live.Db.ExecuteOwnerAsync("ALTER TABLE session_catalog RENAME COLUMN wait_present TO paused_wait_projection");
        try
        {
            Assert.Equal(IdleReleaseOutcome.Released, await live.Generations.TryReleaseIdleAsync(generation.Id,TimeSpan.Zero));
            Assert.Equal(true,await live.Db.ScalarAsync("SELECT due_at<=now() FROM tenant_wakeups"));
        }
        finally { await live.Db.ExecuteOwnerAsync("ALTER TABLE session_catalog RENAME COLUMN paused_wait_projection TO wait_present"); }
        while (live.Generations.Current(live.Slug) is not { Published:true } next || next.Id.Epoch <= generation.Id.Epoch)
            await Task.Delay(30,deadline.Token);
        using var http = new HttpClient(new HttpClientHandler { UseProxy=false });
        using var req = new HttpRequestMessage(HttpMethod.Get,$"http://127.0.0.1:{live.Replica.FrontPort}/api/agents");
        req.Headers.Host = live.Slug+".test";
        using var response = await http.SendAsync(req,deadline.Token);
        Assert.Equal(HttpStatusCode.Unauthorized,response.StatusCode);
    }

    [Fact]
    public async Task ASettingsRevisionHandsBackTheFutureTimerWithoutHttpDemand()
    {
        await using var live = await LiveReplica.StartAsync();
        var old = await live.Generations.ActivateAsync(live.Slug);
        var sessions = live.Current.Host.Sessions;
        var owner = await sessions.CreateNamedAsync("main","scheduled",null,null);
        var at = DateTimeOffset.UtcNow.AddSeconds(2).ToUnixTimeMilliseconds();
        await sessions.Timers.CreateAsync(new JsonObject { ["sessionId"]=owner.Id,["message"]="after revision",["at"]=at },default);
        await live.Db.ExecuteOwnerAsync("UPDATE tenants SET settings_revision=settings_revision+1; SELECT pg_notify('foxwarm_tenants',tenant_id::text) FROM tenants");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        while (live.Generations.Current(live.Slug) is not { Published:true } now || now.Id.Epoch <= old.Id.Epoch)
            await Task.Delay(30,deadline.Token);
        var current = (await live.Current.Host.Sessions.GetExistingAsync(owner.Id))!;
        while (await live.Db.ScalarAsync("SELECT jsonb_array_length(text::jsonb->'timers') FROM state_documents WHERE name='timers'") is not 0)
            await Task.Delay(30,deadline.Token);
        var saved = current.Entry.Snapshot();
        Assert.Single(saved.Queue.Select(Foxwarm.Sessions.SessionQueueJson.ToJson).Concat(saved.History.Select(x=>x.ToJson())), x=>x.ToJsonString().Contains("after revision"));
    }

    [Fact]
    public async Task ADegradedTimerStoreNeverAcknowledgesAnUnarmedNomination()
    {
        await using var live = await LiveReplica.StartAsync();
        // Seed malformed timer state and a previously nominated occurrence. The degraded
        // runtime may serve requests, but cannot declare its durable clock reconciled.
        var id = await live.Db.TenantIdAsync();
        var epoch = await live.Db.TakeLeaseAsync(id, "seed/boot");
        var app = live.Db.OpenApp();
        new PgStateDocuments(new TenantDb(app,id,epoch)).Open(Foxwarm.Storage.StateDocumentName.Timers).ReplaceText("broken");
        var lease = new TenantLease(app, live.Slug, 2);
        Assert.True(await lease.ReleaseWithWakeupAsync(new(id,live.Slug,"seed/boot",epoch), new(DateTimeOffset.UtcNow.AddHours(1),
            new JsonObject { ["timerId"]="one", ["generation"]=1, ["scheduledAt"]=123 }),default));
        var generation = await live.Generations.ActivateAsync(live.Slug);
        Assert.True(generation.Published);
        Assert.NotNull(live.Current.Host.Sessions.Timers.Unavailable);
        Assert.Equal("one", await live.Db.ScalarAsync("SELECT occurrence->>'timerId' FROM tenant_wakeups"));
        Assert.True(await live.Generations.RetireForPlacementAsync(generation.Id,"settings changed"));
        Assert.Equal("one", await live.Db.ScalarAsync("SELECT occurrence->>'timerId' FROM tenant_wakeups"));
    }

    [Fact]
    public async Task ADetachedOperatorShellKeepsItsGenerationUntilTheShellExits()
    {
        await using var live=await LiveReplica.StartAsync(master:true);
        var owning=await live.Generations.ActivateAsync(live.Slug);
        var terminals=live.Current.Host.Sessions.LocalTerminals!;
        var record=await terminals.CreateAsync(live.Temp.Path,80,24,default);
        using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(8));
        async Task AttachAndDetach()
        {
            var (browser,host,resources)=await TerminalClientLifecycleTests.PairAsync();
            using var cleanup=resources;
            var attached=record.AttachAsync(host,deadline.Token,false);
            var buffer=new byte[16384];
            var ready=await browser.ReceiveAsync(buffer,deadline.Token);
            Assert.Contains(record.Id,System.Text.Encoding.UTF8.GetString(buffer,0,ready.Count));
            await browser.CloseOutputAsync(WebSocketCloseStatus.NormalClosure,"detached",deadline.Token);
            await using var client=await attached.WaitAsync(deadline.Token);
        }
        await AttachAndDetach();
        Assert.Equal(IdleReleaseOutcome.Busy,await live.Generations.TryReleaseIdleAsync(owning.Id,TimeSpan.Zero));
        Assert.Same(owning,live.Generations.Current(live.Slug));
        Assert.True(terminals.TryGet(record.Id,out var same));
        Assert.Same(record,same);
        await AttachAndDetach();
        await record.InputAsync("exit\r");
        while (terminals.HasLiveShells) await Task.Delay(20,deadline.Token);
        Assert.Equal(IdleReleaseOutcome.Released,await live.Generations.TryReleaseIdleAsync(owning.Id,TimeSpan.Zero));
    }
}
