using System.Diagnostics;
using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Runtimes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// The runtimes host on one front, over real lease rows, with small runtimes of its own: each
// answers /whoami with its tenant and epoch behind the tenant server it was given.
[Trait("Backend", "postgres")]
public sealed class TenantReplicaTests
{
    private static readonly LeaseTimings Fast = new(TimeSpan.FromSeconds(3), TimeSpan.FromMilliseconds(400), TimeSpan.FromMilliseconds(1200));
    private static readonly TimeSpan Drain = TimeSpan.FromSeconds(1);

    private sealed class Runtime(WebApplication app, string tenant, long epoch) : IHostedRuntime
    {
        internal string Tenant => tenant;
        internal long Epoch => epoch;
        internal int OperatorChanges;
        internal readonly TaskCompletionSource Disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task StartAsync() => app.StartAsync();

        public Task Stopped => app.WaitForShutdownAsync();

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
            Disposed.TrySetResult();
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required HostedTestDatabase Database { get; init; }
        internal required TenantReplica Replica { get; init; }
        internal required CancellationTokenSource Stop { get; init; }
        internal required Task<int> Run { get; init; }
        internal readonly List<Runtime> Runtimes = [];
        internal int Exits;
        internal HttpClient Client = null!;

        internal async Task<HttpResponseMessage> GetAsync(string tenant, string path = "/whoami")
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{Replica.FrontPort}{path}");
            request.Headers.Host = tenant + ".test";
            return await Client.SendAsync(request);
        }

        internal async Task<string> WhoAmIAsync(string tenant)
        {
            using var response = await GetAsync(tenant);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return await response.Content.ReadAsStringAsync();
        }

        internal Runtime[] Live(string tenant)
        {
            lock (Runtimes)
                return [.. Runtimes.Where(runtime => runtime.Tenant == tenant && !runtime.Disposed.Task.IsCompleted)];
        }

        internal async Task<object?> OwnerAsync(string tenant) =>
            await Database.ScalarAsync(
                "SELECT CASE WHEN l.state = 'active' THEN l.owner_replica END FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1",
                tenant
            );

        public async ValueTask DisposeAsync()
        {
            Stop.Cancel();
            try
            {
                await Run.WaitAsync(TimeSpan.FromSeconds(30));
            }
            catch { }
            Client.Dispose();
            await Database.DisposeAsync();
        }
    }

    private static async Task<Fixture> StartAsync(params string[] tenants)
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        foreach (var tenant in tenants)
        {
            if (tenant != PostgresServer.Tenant)
                await database.ExecuteOwnerAsync(
                    $"INSERT INTO tenants (name) VALUES ('{tenant}');"
                        + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{tenant}'"
                );
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenant_hostnames (hostname, tenant_id, kind) SELECT '{tenant}.test', tenant_id, 'primary' FROM tenants WHERE name = '{tenant}'"
            );
        }
        Fixture? fixture = null;
        var stop = new CancellationTokenSource();
        var replica = new TenantReplica(
            new TenantReplicaOptions(
                "replica-a",
                null,
                null,
                new IPEndPoint(IPAddress.Loopback, 0),
                "http://{slug}.test",
                Fast,
                Drain,
                ReaderVersion: 2
            )
            {
                ShutdownBound = TimeSpan.FromSeconds(5),
            },
            database.OpenApp(),
            database.AppConnectionString,
            async (context, token) =>
            {
                var builder = WebApplication.CreateSlimBuilder();
                builder.Logging.ClearProviders();
                builder.Services.AddSingleton<IServer>(context.Server);
                builder.Services.AddSingleton<IHostLifetime, HostControlledLifetime>();
                var app = builder.Build();
                var grant = context.Activation.Grant;
                app.MapGet("/whoami", () => $"{grant.Tenant}:{grant.Epoch}");
                var runtime = new Runtime(app, grant.Tenant, grant.Epoch);
                lock (fixture!.Runtimes)
                    fixture.Runtimes.Add(runtime);
                await Task.Yield();
                return runtime;
            },
            _ => { },
            code => Interlocked.Increment(ref fixture!.Exits),
            operatorDocumentsChanged: runtime => Interlocked.Increment(ref ((Runtime)runtime).OperatorChanges)
        );
        fixture = new Fixture
        {
            Database = database,
            Replica = replica,
            Stop = stop,
            Run = replica.RunAsync(stop.Token),
        };
        fixture.Client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(20) };
        await Task.WhenAny(replica.Serving, fixture.Run).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(replica.Serving.IsCompleted, "the replica didn't start serving: " + (fixture.Run.IsCompleted ? fixture.Run.Result.ToString() : "?"));
        return fixture;
    }

    private static async Task UntilAsync(Func<bool> condition, string what, TimeSpan? limit = null)
    {
        var watch = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(watch.Elapsed < (limit ?? TimeSpan.FromSeconds(10)), what);
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task TenantsOnOneFrontAreActivatedOnTheirFirstRequestAndRoutedByHost()
    {
        await using var f = await StartAsync("alpha", "beta");
        Assert.Empty(f.Runtimes);
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
        Assert.StartsWith("beta:", await f.WhoAmIAsync("beta"));
        // Served by the published generation: no second activation.
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
        Assert.Equal(2, f.Runtimes.Count);
        Assert.Equal(f.Replica.Replica, await f.OwnerAsync("alpha"));
        Assert.Equal(f.Replica.Replica, await f.OwnerAsync("beta"));
        using var unknown = await f.GetAsync("nobody");
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("", await unknown.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task ATenantHeldElsewhereIsRefusedWithoutTenantDataAndKeepsItsOwner()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.Database.TakeLeaseAsync(await f.Database.TenantIdAsync("beta"), "replica-b/0002", TimeSpan.FromMinutes(1));
        using var refused = await f.GetAsync("beta");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal("", await refused.Content.ReadAsStringAsync());
        Assert.Equal("replica-b/0002", await f.OwnerAsync("beta"));
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
    }

    [Fact]
    public async Task ATakeoverFencesOnlyThatTenantWhileTheOtherKeepsServing()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("alpha");
        var beta = await f.WhoAmIAsync("beta");
        var alpha = f.Live("alpha").Single();
        await f.Database.TakeLeaseAsync(await f.Database.TenantIdAsync("alpha"), "replica-b/0002", TimeSpan.FromMinutes(1));
        // The next renewal round finds the row taken over and fences that generation alone.
        await alpha.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(beta, await f.WhoAmIAsync("beta"));
        using var refused = await f.GetAsync("alpha");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal("replica-b/0002", await f.OwnerAsync("alpha"));
        await Task.Delay(Drain + TimeSpan.FromMilliseconds(300));
        Assert.Equal(0, f.Exits);
    }

    [Fact]
    public async Task AnOperatorDocumentChangeAndEveryResubscriptionReachEveryLiveRuntime()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("alpha");
        await f.WhoAmIAsync("beta");
        var runtimes = f.Runtimes.ToArray();
        var before = runtimes.Select(runtime => Volatile.Read(ref runtime.OperatorChanges)).ToArray();
        // A change notifies every replica through foxwarm_operator.
        await f.Database.ExecuteOwnerAsync("INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', '{}')");
        await UntilAsync(
            () => runtimes.Select((runtime, index) => Volatile.Read(ref runtime.OperatorChanges) > before[index]).All(changed => changed),
            "the change reached both runtimes"
        );
        // A lost listener connection: a change made while it was down notified nobody, so the
        // resubscription invalidates on its own.
        var counted = runtimes.Select(runtime => Volatile.Read(ref runtime.OperatorChanges)).ToArray();
        await f.Database.ScalarAsync("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = 'foxwarm-listen'");
        await UntilAsync(
            () => runtimes.Select((runtime, index) => Volatile.Read(ref runtime.OperatorChanges) > counted[index]).All(changed => changed),
            "the resubscription reached both runtimes"
        );
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
    }

    [Fact]
    public async Task AGracefulStopReleasesEveryTenantAndExitsCleanly()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("alpha");
        await f.WhoAmIAsync("beta");
        f.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await f.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.All(f.Runtimes, runtime => Assert.True(runtime.Disposed.Task.IsCompleted));
        Assert.Null(await f.OwnerAsync("alpha"));
        Assert.Null(await f.OwnerAsync("beta"));
        Assert.Equal(0L, await f.Database.ScalarAsync("SELECT count(*) FROM replicas"));
        Assert.Equal(0, f.Exits);
    }
}
