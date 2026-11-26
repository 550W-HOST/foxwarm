using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Npgsql;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Two in-process replicas of one tenant over one database. The runtime is today's Main host
/// over a test-only context: hosted stores where they exist, file stores under one data root
/// shared by both replicas for the rest (as a shared volume would be). Only the owner runs a
/// host, so the file part is never used by two hosts at once.
/// </summary>
[Trait("Backend", "postgres")]
public sealed partial class HostedStartupTests
{
    private static readonly LeaseTimings Timings = new(
        TimeSpan.FromSeconds(6),
        TimeSpan.FromMilliseconds(500),
        TimeSpan.FromSeconds(3)
    );
    private static readonly TimeSpan DrainBound = TimeSpan.FromMilliseconds(2500);

    private sealed class Replica(HostedReplica replica, Task<int> run, CancellationTokenSource stop, int publicPort)
    {
        internal HostedReplica Inner { get; } = replica;
        internal Task<int> Run { get; } = run;
        internal CancellationTokenSource Stop { get; } = stop;
        internal int PublicPort { get; } = publicPort;
        internal List<IHostedRuntime> Runtimes { get; } = [];
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static Replica Start(
        string dataRoot,
        PgDatabase database,
        string name,
        Func<HostedRuntimeContext, CancellationToken, Task<IHostedRuntime>>? createRuntime = null,
        int readerVersion = AgentCatalog.ReaderVersion,
        IReadOnlyList<SchemaMigration>? migrations = null
    )
    {
        var port = FreePort();
        var stop = new CancellationTokenSource();
        Replica? started = null;
        var replica = new HostedReplica(
            new HostedReplicaOptions(
                PostgresServer.Tenant,
                name,
                $"127.0.0.1:{port}",
                new IPEndPoint(IPAddress.Loopback, 0),
                new IPEndPoint(IPAddress.Loopback, port),
                Timings,
                DrainBound,
                readerVersion
            ),
            database,
            createRuntime ?? (async (context, token) =>
            {
                var runtime = await MainRuntimeAsync(context, dataRoot, port);
                started!.Runtimes.Add(runtime);
                return runtime;
            }),
            _ => { },
            migrations
        );
        started = new Replica(replica, Task.Run(() => replica.RunAsync(stop.Token)), stop, port);
        return started;
    }

    private static async Task<IHostedRuntime> MainRuntimeAsync(HostedRuntimeContext context, string dataRoot, int port)
    {
        var storage = HostedTestBackend.Compose(
            new PostgresStorageContext(context.Database, dataRoot)
            {
                KeyRing = new HostedKeyRing(context.Database, HostedTestBackend.Kek),
            },
            dataRoot
        );
        var configuration = new ModelConfiguration(HostPaths.ForDataRoot(dataRoot));
        var desktop = await HttpServerSettings.CaptureDesktopAsync(dataRoot);
        var http = desktop with
        {
            Port = port,
            Desktop = false,
            Address = new PublicWebAddress($"http://127.0.0.1:{port}", Microsoft.AspNetCore.Http.PathString.Empty, "/", false),
        };
        return new MainHostRuntime(await MainHost.CreateAsync([], configuration, http, storage: storage));
    }

    private static HttpClient Client(int port, string dataRoot)
    {
        var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{port}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        var token = HttpServerSettings.ReadExistingTokenAsync(dataRoot).GetAwaiter().GetResult();
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    private static async Task<HttpStatusCode> HealthAsync(HostedReplica replica, string path)
    {
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
        return (await http.GetAsync($"http://127.0.0.1:{replica.HealthPort}{path}")).StatusCode;
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout, string what)
    {
        var deadline = Stopwatch.StartNew();
        while (!condition())
        {
            if (deadline.Elapsed > timeout)
                throw new TimeoutException("Timed out waiting until " + what + ".");
            await Task.Delay(50);
        }
    }

    private static async Task<bool> AgentListedAsync(HttpClient client, string agent)
    {
        var listed = await client.GetFromJsonAsync<JsonNode>("api/agents");
        return listed!.ToJsonString().Contains($"\"{agent}\"", StringComparison.Ordinal);
    }

    [Fact]
    public async Task AStandbyForwardsToTheOwnerAndTakesOverAtOnceAfterAGracefulStop()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");

        var a = Start(data, database.OpenApp(), "replica-a");
        await WaitUntilAsync(() => a.Inner.Health.Role == ReplicaRole.Owner && a.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "replica A serves");
        Assert.Equal(HttpStatusCode.OK, await HealthAsync(a.Inner, "/readyz"));
        var b = Start(data, database.OpenApp(), "replica-b");
        await b.Inner.Waiting.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(ReplicaRole.Standby, b.Inner.Health.Role);
        Assert.Equal(HttpStatusCode.OK, await HealthAsync(b.Inner, "/readyz"));

        using (var owner = Client(a.PublicPort, data))
        {
            var created = await owner.PostAsJsonAsync("api/agents", new { agentId = "research" });
            Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        }
        // Through the standby's public port, requests reach the owner unchanged.
        using (var forwarded = Client(b.PublicPort, data))
            Assert.True(await AgentListedAsync(forwarded, "research"));

        var released = Stopwatch.StartNew();
        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        await WaitUntilAsync(() => b.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(10), "replica B owns the tenant");
        // A released lease is taken on the notification, not after the TTL.
        Assert.InRange(released.Elapsed, TimeSpan.Zero, Timings.Ttl);
        await WaitUntilAsync(() => b.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "replica B serves");
        Assert.True(b.Inner.Health.Epoch > 1);
        using (var owner = Client(b.PublicPort, data))
            Assert.True(await AgentListedAsync(owner, "research"));

        b.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM replicas"));
    }

    [Fact]
    public async Task APartitionedOwnerFencesStopsAndExitsAndTheStandbyTakesOverAfterExpiry()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Timeout = 2,
            CommandTimeout = 2,
            CancellationTimeout = 500,
        }.ConnectionString;

        var a = Start(data, database.OpenApp(routed), "replica-a");
        await WaitUntilAsync(() => a.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "replica A serves");
        var epochA = a.Inner.Health.Epoch;
        var b = Start(data, database.OpenApp(), "replica-b");
        await b.Inner.Waiting.WaitAsync(TimeSpan.FromSeconds(30));

        proxy.Partition();
        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        // The U17 contract, timed by A's lease monitor from the start of its last successful
        // renewal, which the lease's expiry is at least the TTL after: A fences at the renewal
        // deadline, not before, and its run returns (the process exits) before the lease can
        // expire.
        var fence = a.Inner.FenceTimes!;
        Assert.StartsWith("No lease renewal succeeded", fence.Reason);
        Assert.InRange(fence.AtFence, Timings.FenceAfter, Timings.Ttl);
        Assert.NotNull(fence.Exited);
        Assert.InRange(fence.Exited!.Value, fence.AtFence, Timings.Ttl);
        await WaitUntilAsync(() => b.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(60), "replica B owns the tenant");
        // The standby took over only once A's lease could have expired.
        Assert.True(
            Stopwatch.GetElapsedTime(fence.RenewalStart) >= Timings.Ttl,
            "The standby acquired before the lease expired."
        );
        Assert.True(b.Inner.Health.Epoch > epochA);
        await WaitUntilAsync(() => b.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "replica B serves");
        using (var owner = Client(b.PublicPort, data))
        {
            var created = await owner.PostAsJsonAsync("api/agents", new { agentId = "after-failover" });
            Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        }
        proxy.Heal();
        b.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }

    [Fact]
    public async Task AReplicaRefusesATenantMarkedForANewerReaderAndATooNewSchema()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var unused = (Func<HostedRuntimeContext, CancellationToken, Task<IHostedRuntime>>)((_, _) =>
            throw new InvalidOperationException("No runtime may start."));

        await database.ExecuteOwnerAsync("UPDATE tenants SET min_reader_version = 99");
        var older = Start(temp.Path, database.OpenApp(), "older", unused);
        Assert.Equal(HostedExit.Configuration, await older.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        await database.ExecuteOwnerAsync("UPDATE tenants SET min_reader_version = 0");

        await database.ExecuteOwnerAsync(
            "INSERT INTO schema_migrations (version, name, sha256, reader_floor) VALUES (9999, 'future', 'x', 9999)"
        );
        var stale = Start(temp.Path, database.OpenApp(), "stale", unused);
        Assert.Equal(HostedExit.Configuration, await stale.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
    }

    [Fact]
    public async Task RefusedCredentialsAreAConfigurationExitAndAnUnreachableDatabaseIsRetryable()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var unused = (Func<HostedRuntimeContext, CancellationToken, Task<IHostedRuntime>>)((_, _) =>
            throw new InvalidOperationException("No runtime may start."));
        var wrongRole = new NpgsqlConnectionStringBuilder(database.AppConnectionString) { Username = "foxwarm_missing_role" };
        var refused = Start(temp.Path, database.OpenApp(wrongRole.ConnectionString), "refused", unused);
        Assert.Equal(HostedExit.Configuration, await refused.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        var closed = new NpgsqlConnectionStringBuilder(database.AppConnectionString)
        {
            Host = "127.0.0.1",
            Port = FreePort(),
            Timeout = 2,
        };
        var unreachable = Start(temp.Path, database.OpenApp(closed.ConnectionString), "unreachable", unused);
        Assert.Equal(HostedExit.Failed, await unreachable.Run.WaitAsync(TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public async Task TheProductionRuntimeRefusesMissingStoresAndReleasesTheLease()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var bootstrap = new HostedBootstrap(null, null, PostgresServer.Tenant, PostgresServer.AppRole, ScratchRoot: temp.Path);
        Exception? refusal = null;
        var replica = Start(
            temp.Path,
            database.OpenApp(),
            "production",
            async (context, token) =>
            {
                try
                {
                    return await HostedEntry.CreateRuntimeAsync(
                        context,
                        bootstrap,
                        DeploymentConfiguration.Parse("health: {port: 3081}\n")
                    );
                }
                catch (Exception error)
                {
                    refusal = error;
                    throw;
                }
            }
        );
        Assert.Equal(HostedExit.Configuration, await replica.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.IsType<HostedStartupException>(refusal);
        Assert.Contains("Authority", refusal!.Message);
        Assert.DoesNotContain("Documents", refusal.Message);
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        // Nothing durable was written to the scratch directory.
        Assert.Empty(Directory.EnumerateFileSystemEntries(temp.Path));
    }
}
