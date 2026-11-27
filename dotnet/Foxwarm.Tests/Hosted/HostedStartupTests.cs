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
        IReadOnlyList<SchemaMigration>? migrations = null,
        Action<int>? exit = null
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
            migrations,
            exit
        );
        started = new Replica(replica, Task.Run(() => replica.RunAsync(stop.Token)), stop, port);
        return started;
    }

    private static async Task<IHostedRuntime> MainRuntimeAsync(HostedRuntimeContext context, string dataRoot, int port)
    {
        var tenant = new PostgresStorageContext(context.Database, dataRoot)
        {
            KeyRing = new HostedKeyRing(context.Database, HostedTestBackend.Kek),
        };
        var storage = HostedTestBackend.Compose(tenant, dataRoot);
        var configuration = new ModelConfiguration(HostPaths.ForDataRoot(dataRoot));
        var desktop = await HttpServerSettings.CaptureDesktopAsync(dataRoot);
        var http = desktop with
        {
            Port = port,
            Desktop = false,
            Address = new PublicWebAddress($"http://127.0.0.1:{port}", Microsoft.AspNetCore.Http.PathString.Empty, "/", false),
            ListenSocket = context.PublicListener,
        };
        return new MainHostRuntime(await MainHost.CreateAsync([], configuration, http, storage: storage), tenant);
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

    // GET api/agents on a new connection every 50 ms until cancelled: the successes, and every
    // failure with its reason.
    private static async Task<(int Served, List<string> Failures)> ProbeAsync(int port, string dataRoot, CancellationToken stop)
    {
        var token = await HttpServerSettings.ReadExistingTokenAsync(dataRoot);
        var served = 0;
        var failures = new List<string>();
        while (!stop.IsCancellationRequested)
        {
            using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false, PooledConnectionLifetime = TimeSpan.Zero })
            {
                Timeout = TimeSpan.FromSeconds(20),
            };
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/api/agents");
            request.Headers.Authorization = new("Bearer", token);
            request.Headers.ConnectionClose = true;
            try
            {
                using var response = await client.SendAsync(request);
                if (response.IsSuccessStatusCode)
                    served++;
                else
                    failures.Add("HTTP " + (int)response.StatusCode);
            }
            catch (Exception error)
            {
                failures.Add(error.GetType().Name + ": " + error.Message);
            }
            try
            {
                await Task.Delay(50, stop);
            }
            catch (OperationCanceledException) { }
        }
        return (served, failures);
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

        // New connections to the standby's port throughout the handover: each is held while no
        // owner is reachable and served by whichever owner it reaches, so none fails.
        using var probing = new CancellationTokenSource();
        var probes = ProbeAsync(b.PublicPort, data, probing.Token);
        await Task.Delay(300);
        var released = Stopwatch.StartNew();
        a.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        await WaitUntilAsync(() => b.Inner.Health.Role == ReplicaRole.Owner, TimeSpan.FromSeconds(10), "replica B owns the tenant");
        // A released lease is taken on the notification, not after the TTL.
        Assert.InRange(released.Elapsed, TimeSpan.Zero, Timings.Ttl);
        await WaitUntilAsync(() => b.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(60), "replica B serves");
        Assert.True(b.Inner.Health.Epoch > 1);
        await Task.Delay(300);
        probing.Cancel();
        var (served, failures) = await probes;
        Assert.True(failures.Count == 0, string.Join("; ", failures));
        Assert.True(served > 5, $"only {served} probes ran");
        using (var owner = Client(b.PublicPort, data))
            Assert.True(await AgentListedAsync(owner, "research"));

        b.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await b.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM replicas"));
    }

    // A runtime that starts at once and whose disposal waits for the test.
    private sealed class StallingRuntime : IHostedRuntime
    {
        internal TaskCompletionSource DisposeGate { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Disposing { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task StartAsync() => Task.CompletedTask;

        public Task Stopped { get; } = new TaskCompletionSource().Task;

        public ValueTask DisposeAsync()
        {
            Disposing.TrySetResult();
            return new(DisposeGate.Task);
        }
    }

    [Fact]
    public async Task AFenceDuringAGracefulDrainEndsTheProcessAtItsDeadlineAndReleasesNothing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var runtime = new StallingRuntime();
        var exited = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = Start(
            Path.Combine(temp.Path, "data"),
            database.OpenApp(),
            "replica-a",
            (context, token) => Task.FromResult<IHostedRuntime>(runtime),
            exit: code =>
            {
                Assert.Equal(HostedExit.Fenced, code);
                exited.TrySetResult(Stopwatch.GetTimestamp());
            }
        );
        await WaitUntilAsync(() => a.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(30), "replica A serves");
        // A graceful stop whose drain doesn't end, then the lease is taken over meanwhile.
        a.Stop.Cancel();
        await runtime.Disposing.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await database.TakeLeaseAsync(await database.TenantIdAsync(), "replica-b/0002");

        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        var fence = a.Inner.FenceTimes!;
        Assert.Null(fence.RuntimeStopped);
        var fencedAt = fence.RenewalStart + (long)(fence.AtFence.TotalSeconds * Stopwatch.Frequency);
        var elapsed = Stopwatch.GetElapsedTime(fencedAt, await exited.Task.WaitAsync(TimeSpan.FromSeconds(10)));
        // The drain bound counts from the fence, not from the stop request.
        Assert.InRange(elapsed, DrainBound, DrainBound + TimeSpan.FromSeconds(1));
        // Nothing was released: the takeover's lease stands.
        Assert.Equal("replica-b/0002", await database.ScalarAsync("SELECT owner_replica FROM tenant_leases"));
        Assert.Equal("active", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        runtime.DisposeGate.SetResult();
    }

    [Fact]
    public async Task ACancelledGracefulDisposalIsUnconfirmedReleasesNothingAndIsBounded()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var runtime = new StallingRuntime();
        var exited = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = Start(
            Path.Combine(temp.Path, "data"),
            database.OpenApp(),
            "replica-a",
            (context, token) => Task.FromResult<IHostedRuntime>(runtime),
            exit: code => exited.TrySetResult(Stopwatch.GetTimestamp())
        );
        await WaitUntilAsync(() => a.Inner.Health.RuntimeStarted, TimeSpan.FromSeconds(30), "replica A serves");
        a.Stop.Cancel();
        await runtime.Disposing.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The stop ends in a cancellation: not a confirmed stop.
        var stopped = Stopwatch.GetTimestamp();
        runtime.DisposeGate.SetCanceled();
        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal("active", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        Assert.Equal("replica-a", ReplicaRegistry.LogicalName((string)(await database.ScalarAsync("SELECT owner_replica FROM tenant_leases"))!));
        // The process ends at the drain bound unless it has exited by then.
        Assert.InRange(Stopwatch.GetElapsedTime(stopped, await exited.Task.WaitAsync(TimeSpan.FromSeconds(10))), DrainBound - TimeSpan.FromMilliseconds(50), DrainBound + TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task AStartWhoseCleanupFailedReleasesNothing()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var exited = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = Start(
            Path.Combine(temp.Path, "data"),
            database.OpenApp(),
            "replica-a",
            (context, token) => Task.FromException<IHostedRuntime>(
                new StartupCleanupFailedException(new InvalidOperationException("composition failed"), [new IOException("cleanup failed")])
            ),
            exit: code => exited.TrySetResult(Stopwatch.GetTimestamp())
        );
        Assert.Equal(HostedExit.Fenced, await a.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Equal("active", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        await exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
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
    public async Task TheProductionRuntimeHasEveryStoreAndRefusesWithoutKeysReleasingTheLease()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var bootstrap = new HostedBootstrap(null, null, PostgresServer.Tenant, PostgresServer.AppRole, ScratchRoot: temp.Path);
        using var probe = new TempDirectory();
        Exception? refusal = null;
        IReadOnlyList<string> missing = [];
        var replica = Start(
            temp.Path,
            database.OpenApp(),
            "production",
            async (context, token) =>
            {
                try
                {
                    // The stores this build lacks, from a context of its own.
                    missing = new PostgresStorageContext(context.Database, probe.Path).Missing;
                    return await HostedEntry.CreateRuntimeAsync(
                        context,
                        bootstrap,
                        DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n")
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
        // Every store has its PostgreSQL implementation now, so the next refusal is the key ring's.
        Assert.Empty(missing);
        Assert.Contains("FOXWARM_KEK_FILE", refusal!.Message);
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
        // Nothing durable was written to the scratch directory.
        Assert.Empty(Directory.EnumerateFileSystemEntries(temp.Path));
    }
}
