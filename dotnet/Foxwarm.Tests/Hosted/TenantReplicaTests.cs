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
public sealed partial class TenantReplicaTests
{
    private static readonly LeaseTimings Fast = new(TimeSpan.FromSeconds(3), TimeSpan.FromMilliseconds(400), TimeSpan.FromMilliseconds(1200));
    private static readonly TimeSpan Drain = TimeSpan.FromSeconds(1);

    private sealed class Runtime(WebApplication app, string tenant, long epoch, Fixture owner) : IHostedRuntime
    {
        internal string Tenant => tenant;
        internal long Epoch => epoch;
        internal int OperatorChanges;
        internal int StatementLimit;
        internal readonly TaskCompletionSource Revoked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void CredentialRotated() => Revoked.TrySetResult();
        internal readonly TaskCompletionSource Disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task StartAsync()
        {
            if (owner.StartGate is { } gate)
            {
                owner.Event($"{tenant}:start-waits");
                await gate.Task;
            }
            await app.StartAsync();
            owner.Event($"{tenant}:start-end");
        }

        public Task Stopped => app.WaitForShutdownAsync();

        public async ValueTask DisposeAsync()
        {
            owner.Event($"{tenant}:dispose");
            if (owner.DrainGate is { } gate) await gate.Task;
            await app.StopAsync();
            await app.DisposeAsync();
            Disposed.TrySetResult();
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required HostedTestDatabase Database { get; init; }
        internal TenantReplica Replica { get; set; } = null!;
        internal required CancellationTokenSource Stop { get; init; }
        internal Task<int> Run { get; set; } = null!;
        internal readonly List<Runtime> Runtimes = [];
        internal readonly List<string> Events = [];
        internal readonly List<string> Log = [];
        internal int Exits;
        internal int Builds;
        internal Action<WebApplication>? AddRoutes;
        internal int ApplicationCalls;
        internal bool OwnsDatabase;
        internal required byte[] MeshKey { get; init; }
        internal readonly System.Collections.Concurrent.ConcurrentBag<string> Connections = [];
        internal readonly TaskCompletionSource Truncating = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Cut = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Continue = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal HttpClient Client = null!;

        /// <summary>When set, every runtime's start waits for it.</summary>
        internal TaskCompletionSource? StartGate;
        internal TaskCompletionSource? DrainGate;

        /// <summary>When set, the factory throws it.</summary>
        internal Exception? FactoryError;

        /// <summary>When set, the operator-document callback waits for it.</summary>
        internal TaskCompletionSource? CallbackGate;
        internal TaskCompletionSource CallbackEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);

        /// <summary>The operator documents' text as the last callback read it.</summary>
        internal string? ObservedDocuments;

        internal void Event(string what)
        {
            lock (Events)
                Events.Add(what);
        }

        internal string[] EventList()
        {
            lock (Events)
                return [.. Events];
        }

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
            StartGate?.TrySetResult();
            DrainGate?.TrySetResult();
            CallbackGate?.TrySetResult();
            Continue.TrySetResult();
            Cut.TrySetResult();
            Stop.Cancel();
            try
            {
                await Run.WaitAsync(TimeSpan.FromSeconds(30));
            }
            catch { }
            Client.Dispose();
            if (OwnsDatabase) await Database.DisposeAsync();
        }
    }

    private static async Task AddTenantAsync(HostedTestDatabase database, string tenant)
    {
        if (tenant != PostgresServer.Tenant)
            await database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{tenant}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{tenant}'"
            );
        await database.ExecuteOwnerAsync(
            $"INSERT INTO tenant_hostnames (hostname, tenant_id, kind) SELECT '{tenant.ToLowerInvariant().Replace('_', '-')}.test', tenant_id, 'primary' FROM tenants WHERE name = '{tenant}'"
        );
    }

    private static Task<Fixture> StartAsync(params string[] tenants) => StartAsync(Fast, tenants);

    private static async Task<Fixture> StartAsync(LeaseTimings timings, params string[] tenants)
    {
        var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        foreach (var tenant in tenants)
            await AddTenantAsync(database, tenant);
        return await StartReplicaAsync(database, "replica-a", System.Security.Cryptography.RandomNumberGenerator.GetBytes(32), ownsDatabase: true, timings: timings);
    }

    private static async Task<Fixture> StartReplicaAsync(HostedTestDatabase database, string name, byte[] key, bool ownsDatabase = false, LeaseTimings? timings = null)
    {
        timings ??= Fast;
        var fixture = new Fixture { Database = database, Stop = new CancellationTokenSource(), MeshKey = key, OwnsDatabase = ownsDatabase };
        fixture.Replica = new TenantReplica(
            new TenantReplicaOptions(
                name,
                null,
                null,
                new IPEndPoint(IPAddress.Loopback, 0),
                slug => $"http://{slug}.test",
                timings,
                timings == Fast ? Drain : TimeSpan.FromSeconds(4),
                ReaderVersion: 2
            )
            {
                ShutdownBound = TimeSpan.FromSeconds(5),
                Mesh = new(new(IPAddress.Loopback, 0), "127.0.0.1", key),
            },
            database.OpenApp(),
            database.AppConnectionString,
            async (context, token) =>
            {
                Interlocked.Increment(ref fixture.Builds);
                if (fixture.FactoryError is { } error)
                    throw error;
                var builder = WebApplication.CreateSlimBuilder();
                builder.Logging.ClearProviders();
                builder.Services.AddSingleton<IServer>(context.Server);
                builder.Services.AddSingleton<IHostLifetime, HostControlledLifetime>();
                var app = builder.Build();
                var grant = context.Activation.Grant;
                app.MapGet("/whoami", () => $"{grant.Tenant}:{grant.Epoch}");
                MapForwardingRoutes(app, fixture);
                fixture.AddRoutes?.Invoke(app);
                context.Activation.Fence.Lost.Register(() => fixture.Event($"{grant.Tenant}:fenced"));
                var runtime = new Runtime(app, grant.Tenant, grant.Epoch, fixture) { StatementLimit = context.Database.MaxInFlight };
                lock (fixture.Runtimes)
                    fixture.Runtimes.Add(runtime);
                await Task.Yield();
                return runtime;
            },
            line =>
            {
                lock (fixture.Log)
                    fixture.Log.Add(line);
            },
            code => Interlocked.Increment(ref fixture.Exits),
            operatorDocumentsChanged: runtime =>
            {
                var target = (Runtime)runtime;
                fixture.Event($"{target.Tenant}:callback{(target.Disposed.Task.IsCompleted ? "-after-dispose" : "")}");
                fixture.CallbackEntered.TrySetResult();
                fixture.CallbackGate?.Task.Wait();
                fixture.ObservedDocuments = database
                    .ScalarAsync("SELECT coalesce(string_agg(text, ',' ORDER BY name), '') FROM operator_documents")
                    .GetAwaiter()
                    .GetResult() as string;
                Interlocked.Increment(ref target.OperatorChanges);
            }
        );
        fixture.Run = fixture.Replica.RunAsync(fixture.Stop.Token);
        fixture.Client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(20) };
        await Task.WhenAny(fixture.Replica.Serving, fixture.Run).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(fixture.Replica.Serving.IsCompleted, "the replica didn't start serving: " + (fixture.Run.IsCompleted ? fixture.Run.Result.ToString() : "?"));
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

    private static async Task UntilAsync(Func<Task<bool>> condition, string what, TimeSpan? limit = null)
    {
        var watch = Stopwatch.StartNew();
        while (!await condition())
        {
            Assert.True(watch.Elapsed < (limit ?? TimeSpan.FromSeconds(10)), what);
            await Task.Delay(20);
        }
    }

    // The initial LISTEN transaction has committed and the replica has taken its snapshot of
    // live runtimes. A runtime activated after this point will see only subsequent changes.
    private static Task InitialSubscriptionAsync(Fixture f) =>
        UntilAsync(() => f.Replica.OperatorVersion > 0, "the initial subscription invalidated operator documents");

    private static int IndexOf(string[] events, string what)
    {
        var index = Array.IndexOf(events, what);
        Assert.True(index >= 0, $"no {what} in [{string.Join(", ", events)}]");
        return index;
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

    // Review 4b #1: a fence during the start doesn't detach the start from the settlement.
    [Fact]
    public async Task AFenceDuringAStartDisposesTheRuntimeOnlyAfterTheStartEnded()
    {
        await using var f = await StartAsync("alpha");
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var request = f.GetAsync("alpha");
        await UntilAsync(() => f.EventList().Contains("alpha:start-waits"), "the start began");
        await f.Database.TakeLeaseAsync(await f.Database.TenantIdAsync("alpha"), "replica-b/0002", TimeSpan.FromMinutes(1));
        await UntilAsync(() => f.EventList().Contains("alpha:fenced"), "the generation was fenced");
        await Task.Delay(300);
        Assert.DoesNotContain("alpha:dispose", f.EventList());
        f.StartGate.SetResult();
        using (var response = await request)
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        await UntilAsync(() => f.EventList().Contains("alpha:dispose"), "the runtime was disposed");
        var events = f.EventList();
        Assert.True(IndexOf(events, "alpha:start-end") < IndexOf(events, "alpha:dispose"), string.Join(", ", events));
        Assert.Equal("replica-b/0002", await f.OwnerAsync("alpha"));
        await Task.Delay(Drain);
        Assert.Equal(0, f.Exits);
    }

    // Review 4b #1, at shutdown: the stop waits for the start rather than only for its wait.
    [Fact]
    public async Task ASigtermDuringAStartDisposesTheRuntimeOnlyAfterTheStartEnded()
    {
        await using var f = await StartAsync("alpha");
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var request = f.GetAsync("alpha");
        await UntilAsync(() => f.EventList().Contains("alpha:start-waits"), "the start began");
        f.Stop.Cancel();
        await Task.Delay(300);
        Assert.DoesNotContain("alpha:dispose", f.EventList());
        f.StartGate.SetResult();
        Assert.Equal(HostedExit.Stopped, await f.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        var events = f.EventList();
        Assert.True(IndexOf(events, "alpha:start-end") < IndexOf(events, "alpha:dispose"), string.Join(", ", events));
        Assert.Null(await f.OwnerAsync("alpha"));
        try
        {
            (await request).Dispose();
        }
        catch (HttpRequestException) { }
    }

    // Review 4b #4: a committed placement change retires the held generation and releases it,
    // so the next request acquires under the new eligibility (refused on a general replica).
    [Fact]
    public async Task AProfileChangeRetiresTheTenantAndTheNextRequestIsRefusedUnderTheNewProfile()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("alpha");
        var beta = await f.WhoAmIAsync("beta");
        var alpha = f.Live("alpha").Single();
        await f.Database.ExecuteOwnerAsync("UPDATE tenants SET profile = 'operator', pinned_role = 'master-host' WHERE name = 'alpha'");
        await alpha.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await UntilAsync(async () => await f.OwnerAsync("alpha") is null, "alpha's lease was released");
        using (var refused = await f.GetAsync("alpha"))
            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(beta, await f.WhoAmIAsync("beta"));
        Assert.Equal(0, f.Exits);
    }

    // Review 4b #8: a stored name that isn't a slug is refused before anything is built from it.
    [Fact]
    public async Task ATenantWhoseStoredNameIsntASlugIsRefusedBeforeItsRuntimeIsBuilt()
    {
        await using var f = await StartAsync("alpha");
        // Grandfathered: the DNS-label check doesn't hold for names from before it existed.
        await f.Database.ExecuteOwnerAsync(
            "ALTER TABLE tenants DROP CONSTRAINT tenants_slug_dns_label;"
                + " INSERT INTO tenants (name) VALUES ('Legacy_Name');"
                + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = 'Legacy_Name';"
                + " INSERT INTO tenant_hostnames (hostname, tenant_id, kind) SELECT 'legacy.test', tenant_id, 'primary' FROM tenants WHERE name = 'Legacy_Name'"
        );
        var id = await f.Database.TenantIdAsync("Legacy_Name");
        var builds = f.Builds;
        using (var refused = await f.GetAsync("legacy"))
            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(builds, f.Builds);
        lock (f.Log)
            Assert.Contains(f.Log, line => line.Contains($"Tenant {id} ") && line.Contains("isn't a slug"));
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
    }

    // Review 4b #11: any activation failure is a bare 503, its cause logged.
    [Fact]
    public async Task AnyActivationFailureIsABare503AndItsCauseIsLogged()
    {
        await using var f = await StartAsync("alpha");
        f.FactoryError = new IOException("backend request failed: /private?key=sensitive");
        using (var refused = await f.GetAsync("alpha"))
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
            Assert.Equal("", await refused.Content.ReadAsStringAsync());
        }
        lock (f.Log)
        {
            Assert.Contains(f.Log, line => line.Contains("alpha") && line.Contains(nameof(IOException)));
            Assert.DoesNotContain(f.Log, line => line.Contains("/private") || line.Contains("sensitive"));
        }
        f.FactoryError = null;
        await UntilAsync(async () => (await f.GetAsync("alpha")).StatusCode == HttpStatusCode.OK, "alpha serves after the backoff", TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task AnOperatorDocumentChangeReachesEveryLiveRuntime()
    {
        await using var f = await StartAsync("alpha", "beta");
        await f.WhoAmIAsync("alpha");
        await f.WhoAmIAsync("beta");
        var runtimes = f.Runtimes.ToArray();
        var before = runtimes.Select(runtime => Volatile.Read(ref runtime.OperatorChanges)).ToArray();
        await f.Database.ExecuteOwnerAsync("INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', 'changed')");
        await UntilAsync(
            () => runtimes.Select((runtime, index) => Volatile.Read(ref runtime.OperatorChanges) > before[index]).All(changed => changed),
            "the change reached both runtimes"
        );
        Assert.Equal("changed", f.ObservedDocuments);
    }

    [Fact]
    public async Task ASubscriptionAlreadyAppliedByStartDoesNotRefreshTheRuntimeTwice()
    {
        long version = 0;
        var calls = 0;
        var callbacks = new TenantReplica.OperatorDocumentCallbacks(version, () => version, () => calls++);
        // Invalidation advanced the version and captured this runtime. Its start ended and
        // applied that version before the listener reached it in the captured set.
        version++;
        await callbacks.Start();
        Assert.Equal(1, calls);
        await callbacks.Notify();
        Assert.Equal(1, calls);
        version++;
        await callbacks.Notify();
        Assert.Equal(2, calls);
    }

    // Review 4b #9: a change during the start is applied once the start ended.
    [Fact]
    public async Task AnOperatorDocumentChangeDuringAStartIsAppliedWhenTheStartEnds()
    {
        await using var f = await StartAsync("alpha");
        await InitialSubscriptionAsync(f);
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var request = f.GetAsync("alpha");
        await UntilAsync(() => f.EventList().Contains("alpha:start-waits"), "the start began");
        var version = f.Replica.OperatorVersion;
        await f.Database.ExecuteOwnerAsync("INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', 'during-start')");
        await UntilAsync(() => f.Replica.OperatorVersion > version, "the replica took the change in");
        await Task.Delay(100);
        Assert.DoesNotContain("alpha:callback", f.EventList());
        f.StartGate.SetResult();
        using (var response = await request)
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var runtime = f.Live("alpha").Single();
        await UntilAsync(() => Volatile.Read(ref runtime.OperatorChanges) == 1, "the change was applied after the start");
        Assert.Equal("during-start", f.ObservedDocuments);
    }

    // Review 4b #9: retirement waits for a running callback and no callback follows it.
    [Fact]
    public async Task RetirementWaitsForARunningCallbackAndNoneRunsAfterIt()
    {
        await using var f = await StartAsync("alpha");
        await InitialSubscriptionAsync(f);
        await f.WhoAmIAsync("alpha");
        var runtime = f.Live("alpha").Single();
        var before = Volatile.Read(ref runtime.OperatorChanges);
        f.CallbackEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        f.CallbackGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await f.Database.ExecuteOwnerAsync("INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', 'one')");
        await f.CallbackEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await f.Database.TakeLeaseAsync(await f.Database.TenantIdAsync("alpha"), "replica-b/0002", TimeSpan.FromMinutes(1));
        await UntilAsync(() => f.EventList().Contains("alpha:fenced"), "the generation was fenced");
        await Task.Delay(200);
        Assert.False(runtime.Disposed.Task.IsCompleted, "disposed while its callback ran");
        f.CallbackGate.SetResult();
        await runtime.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await f.Database.ExecuteOwnerAsync("UPDATE operator_documents SET text = 'two'");
        await Task.Delay(500);
        Assert.DoesNotContain(f.EventList(), item => item.EndsWith("-after-dispose", StringComparison.Ordinal));
        Assert.Equal(before + 1, Volatile.Read(ref runtime.OperatorChanges));
    }

    // Review 4b #13: a change committed while the listener is disconnected reaches the runtime
    // through the resubscription, which nothing else signals.
    [Fact]
    public async Task AChangeCommittedWhileTheListenerIsDisconnectedReachesTheRuntimeAfterReconnect()
    {
        await using var f = await StartAsync("alpha");
        await InitialSubscriptionAsync(f);
        await f.WhoAmIAsync("alpha");
        var runtime = f.Live("alpha").Single();
        const string Listeners = "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'foxwarm-listen' AND datname = current_database()";
        await UntilAsync(async () => (long)(await f.Database.ScalarAsync(Listeners))! == 1, "the listener subscribed");
        Assert.Equal(0, Volatile.Read(ref runtime.OperatorChanges));
        var version = f.Replica.OperatorVersion;
        // One transaction ends this database's listener backend and commits the change, before
        // the listener's reconnect backoff has passed.
        var ended = await f.Database.ScalarAsync(
            "WITH ended AS (SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity"
                + " WHERE application_name = 'foxwarm-listen' AND datname = current_database()),"
                + " written AS (INSERT INTO operator_documents (scope, name, text) VALUES ('global', 'ceiling', 'while-away') RETURNING 1)"
                + " SELECT (SELECT count(*) FROM ended WHERE done) + 0 * (SELECT count(*) FROM written)"
        );
        Assert.Equal(1L, ended);
        await UntilAsync(async () => (long)(await f.Database.ScalarAsync(Listeners))! == 1 && f.Replica.OperatorVersion > version, "the listener resubscribed");
        await UntilAsync(() => Volatile.Read(ref runtime.OperatorChanges) > 0, "the runtime applied the reconnect refresh");
        Assert.Equal("while-away", f.ObservedDocuments);
        Assert.Equal(1, Volatile.Read(ref runtime.OperatorChanges));
        Assert.StartsWith("alpha:", await f.WhoAmIAsync("alpha"));
    }

    [Theory]
    [InlineData("notify")]
    [InlineData("reconnect")]
    [InlineData("renewal")]
    public async Task SettingsRevisionDrainsOnlyTheChangedGeneration(string path)
    {
        // In the two signal cases, no renewal could have observed the change yet.
        var timings = path == "renewal" ? Fast : new LeaseTimings(TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60));
        await using var f = await StartAsync(timings, "alpha", "beta");
        await InitialSubscriptionAsync(f);
        await f.WhoAmIAsync("alpha");
        var beta = await f.WhoAmIAsync("beta");
        var alpha = Assert.Single(f.Live("alpha"));
        const string update = "UPDATE tenants SET limits='{\"dbStatements\":3}' WHERE name='alpha'";
        if (path == "renewal")
            await f.Database.ExecuteOwnerAsync("ALTER TABLE tenants DISABLE TRIGGER foxwarm_notify_tenants; " + update);
        else if (path == "reconnect")
        {
            var count = await f.Database.ScalarAsync("WITH ended AS (SELECT pg_terminate_backend(pid) done FROM pg_stat_activity "
                + "WHERE application_name='foxwarm-listen' AND datname=current_database()), edited AS (" + update
                + " RETURNING 1) SELECT count(*) FROM ended WHERE done");
            Assert.Equal(1L, count);
        }
        else await f.Database.ExecuteOwnerAsync(update);
        await UntilAsync(async () => await f.OwnerAsync("alpha") is null, "settings revision retired and released the old grant", TimeSpan.FromSeconds(5));
        Assert.True(alpha.Disposed.Task.IsCompleted);
        Assert.DoesNotContain("alpha:fenced", f.EventList());
        Assert.Equal(beta, await f.WhoAmIAsync("beta"));
        Assert.NotEqual("alpha:" + alpha.Epoch, await f.WhoAmIAsync("alpha"));
        Assert.Equal(3, Assert.Single(f.Live("alpha")).StatementLimit);
    }

    [Fact]
    public async Task RotationReachesASettingsDrainBeforeItsRuntimeStops()
    {
        var timings = new LeaseTimings(TimeSpan.FromSeconds(30),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(15));
        await using var f=await StartAsync(timings,"alpha");
        await InitialSubscriptionAsync(f);
        await f.WhoAmIAsync("alpha");
        var old=Assert.Single(f.Live("alpha"));
        f.DrainGate=new(TaskCreationOptions.RunContinuationsAsynchronously);
        await f.Database.ExecuteOwnerAsync("UPDATE tenants SET settings='{\"journal\":{\"enabled\":false}}' WHERE name='alpha'");
        await UntilAsync(()=>f.EventList().Contains("alpha:dispose"),"settings drain");
        Assert.False(old.Revoked.Task.IsCompleted);
        await f.Database.ExecuteOwnerAsync("UPDATE tenants SET credential_version=credential_version+1 WHERE name='alpha'");
        await old.Revoked.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(old.Disposed.Task.IsCompleted);
        f.DrainGate.SetResult();
    }

    [Fact]
    public async Task SettingsObservedDuringStartCannotOpenTheObsoleteGate()
    {
        await using var f = await StartAsync("alpha");
        await InitialSubscriptionAsync(f);
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = f.GetAsync("alpha");
        await UntilAsync(() => f.EventList().Contains("alpha:start-waits"), "start paused after capture");
        var old = Assert.Single(f.Live("alpha"));
        await f.Database.ExecuteOwnerAsync("UPDATE tenants SET limits='{\"busyTurns\":3}' WHERE name='alpha'");
        // Wait for a successful renewal after the setting is committed. Its result observes the revision.
        var expiry = (DateTime)(await f.Database.ScalarAsync("SELECT expires_at FROM tenant_leases JOIN tenants USING(tenant_id) WHERE name='alpha'"))!;
        await UntilAsync(async () => (DateTime)(await f.Database.ScalarAsync("SELECT expires_at FROM tenant_leases JOIN tenants USING(tenant_id) WHERE name='alpha'"))! > expiry, "renewal observed new revision");
        f.StartGate.SetResult();
        using var response = await first;
        Assert.NotEqual("alpha:" + old.Epoch, await response.Content.ReadAsStringAsync());
        Assert.NotEqual("alpha:" + old.Epoch, await f.WhoAmIAsync("alpha"));
    }

    // Review 4c #2: a runtime that stops promptly isn't enough; a release that can't take the
    // lease row lock leaves ownership unresolved, and the replica doesn't exit as stopped.
    [Fact]
    public async Task AStopWhoseReleaseCantLockTheLeaseRowExitsFencedAndTheLeaseStays()
    {
        await using var f = await StartAsync("alpha");
        await f.WhoAmIAsync("alpha");
        var runtime = f.Live("alpha").Single();
        var tenant = await f.Database.TenantIdAsync("alpha");
        await using var holder = new Npgsql.NpgsqlConnection(f.Database.OwnerConnectionString);
        await holder.OpenAsync();
        await using var holding = await holder.BeginTransactionAsync();
        await using (var locking = new Npgsql.NpgsqlCommand($"SELECT 1 FROM tenant_leases WHERE tenant_id = {tenant} FOR UPDATE", holder, holding))
            await locking.ExecuteScalarAsync();
        f.Stop.Cancel();
        Assert.Equal(HostedExit.Fenced, await f.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.True(runtime.Disposed.Task.IsCompleted);
        await holding.RollbackAsync();
        Assert.Equal("active", await f.Database.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id = $1", tenant));
        Assert.StartsWith("replica-a", (string)(await f.Database.ScalarAsync("SELECT owner_replica FROM tenant_leases WHERE tenant_id = $1", tenant))!);
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
