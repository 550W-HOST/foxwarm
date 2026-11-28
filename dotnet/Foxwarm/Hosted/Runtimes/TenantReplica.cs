using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Forwarding;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Yarp.ReverseProxy.Forwarder;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>Settings of one multi-tenant replica process.</summary>
/// <param name="PublicEndpoint">The front listener every tenant's requests arrive on.</param>
/// <param name="PublicUrl">
/// A tenant runtime's public origin, by slug: the same expansion its configuration reads.
/// </param>
/// <param name="DrainBound">
/// How long a fenced or overrunning stop may take after its grant's deadline before the process
/// exits; below the lease TTL minus the fence deadline.
/// </param>
internal sealed record TenantReplicaOptions(
    string ReplicaName,
    string? AdvertiseAddress,
    IPEndPoint? HealthEndpoint,
    IPEndPoint PublicEndpoint,
    Func<string, string> PublicUrl,
    LeaseTimings Timings,
    TimeSpan DrainBound,
    int ReaderVersion
)
{
    internal required MeshSettings Mesh { get; init; }

    /// <summary>This replica's placement role (<see cref="ReplicaRoles"/>).</summary>
    internal string Role { get; init; } = ReplicaRoles.General;

    /// <summary>The graceful shutdown's one absolute bound for every tenant.</summary>
    internal TimeSpan ShutdownBound { get; init; } = TimeSpan.FromSeconds(8);

    /// <summary>How long a tenant must have admitted nothing before its idle release.</summary>
    internal TimeSpan IdleAfter { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>How often published tenants are checked for idle release.</summary>
    internal TimeSpan IdleScan { get; init; } = TimeSpan.FromSeconds(30);

    internal System.Text.RegularExpressions.Regex? MountedOperatorPath { get; init; }

    internal string? OperatorHostname { get; init; }

    /// <summary>Transactions in flight per tenant (<see cref="TenantDb"/>'s statement cap).</summary>
    internal int MaxInFlight { get; init; } = 8;
}

/// <summary>What the replica gives a tenant runtime it builds.</summary>
/// <param name="Server">The runtime's <c>IServer</c>: the front dispatches the tenant's requests to it.</param>
internal sealed record TenantRuntimeContext(ActivationContext Activation, TenantDb Database, TenantServer Server);

/// <summary>Builds a tenant's runtime over its database; the replica starts it.</summary>
internal delegate Task<IHostedRuntime> TenantRuntimeFactory(TenantRuntimeContext context, CancellationToken token);

/// <summary>
/// A replica that serves many tenants on one front (plan §2.1): the runtimes host. It checks
/// the schema, registers its boot, renews every grant it holds, activates a tenant on its first
/// request and dispatches requests by <c>Host</c> to the tenant's published generation. Fences
/// and escalation are the supervisor's; a graceful stop shuts every tenant down at once under
/// one bound. Selected by <c>FOXWARM_HOSTED_TOPOLOGY=tenants</c> until forwarding replaces the
/// single-tenant replica.
/// </summary>
internal sealed class TenantReplica
{
    private readonly TenantReplicaOptions options;
    private readonly PgDatabase app;
    private readonly string connectionString;
    private readonly TenantRuntimeFactory factory;
    private readonly Action<string> log;
    private readonly Action<int> exit;
    private readonly IReadOnlyList<SchemaMigration>? migrations;
    private readonly Action<IHostedRuntime>? operatorDocumentsChanged;
    private readonly object gate = new();
    // Runtimes built and not yet disposed, for operator-document invalidation.
    private readonly HashSet<TenantRuntime> live = [];
    private long operatorVersion;
    private volatile string state = "starting";
    private TenantActivations? activations;

    /// <param name="operatorDocumentsChanged">
    /// Applied to every live runtime when the operator documents may have changed: on each
    /// notification, on the first subscription and on every resubscription after a lost
    /// connection; null applies nothing.
    /// </param>
    internal TenantReplica(
        TenantReplicaOptions options,
        PgDatabase app,
        string connectionString,
        TenantRuntimeFactory factory,
        Action<string> log,
        Action<int> exit,
        IReadOnlyList<SchemaMigration>? migrations = null,
        Action<IHostedRuntime>? operatorDocumentsChanged = null
    )
    {
        options.Timings.Validate();
        this.options = options;
        this.app = app;
        this.connectionString = connectionString;
        this.factory = factory;
        this.log = log;
        this.exit = exit;
        this.migrations = migrations;
        this.operatorDocumentsChanged = operatorDocumentsChanged;
        Replica = ReplicaRegistry.NewReplicaId(options.ReplicaName);
    }

    internal string Replica { get; }

    /// <summary>The front's port once it listens.</summary>
    internal int? FrontPort { get; private set; }

    internal int? HealthPort { get; private set; }

    /// <summary>How many operator-document invalidations this replica has taken in.</summary>
    internal long OperatorVersion => Interlocked.Read(ref operatorVersion);

    /// <summary>The activation coordinator, once running.</summary>
    internal TenantActivations? Activations => activations;

    /// <summary>Completes once the front accepts requests.</summary>
    internal Task Serving => serving.Task;

    private readonly TaskCompletionSource serving = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>
    /// Runs until <paramref name="stop"/>: <see cref="HostedExit.Stopped"/> when every tenant's
    /// stop was confirmed, <see cref="HostedExit.Fenced"/> when one wasn't (its grant expires).
    /// </summary>
    internal async Task<int> RunAsync(CancellationToken stop)
    {
        try
        {
            await SchemaMigrator.RequireCompatibleAsync(app, migrations, stop).ConfigureAwait(false);
        }
        catch (SchemaIncompatibleException error)
        {
            log("[hosted] " + error.Message);
            return HostedExit.Configuration;
        }
        catch (Npgsql.NpgsqlException error) when (!stop.IsCancellationRequested)
        {
            log("[hosted] The database is unreachable: " + error.Message);
            return HostedExit.Failed;
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            return HostedExit.Stopped;
        }
        await using var control = PgDatabase.Control(connectionString);
        await using var renewal = PgDatabase.Renewal(connectionString);
        await using var renewer = new GrantRenewer(renewal, control, Replica, options.Timings, log);
        var supervisor = new FenceSupervisor(options.Timings, options.DrainBound, exit, log);
        var coordinator = new TenantActivations(
            control,
            Replica,
            options.ReaderVersion,
            options.Timings,
            BuildAsync,
            renewer,
            supervisor
        )
        {
            Role = options.Role,
            ShutdownBound = options.ShutdownBound,
        };
        activations = coordinator;
        renewer.SettingsChanged += coordinator.SettingsChanged;
        var registry = new ReplicaRegistry(control);
        var hostnames = new HostnameDirectory(app);
        using var router = new TenantRouter(Replica, new MeshAuthentication(options.Mesh.Secret, Replica),
            new RouteDirectory(app), new ReplicaRegistry(app), coordinator, hostnames, options.Timings, DispatchTenantAsync, () =>
            {
                var owners = Foxwarm.Limits.ReplicaLimits.Process.HotOwners;
                return owners.UsedBytes < owners.Limit;
            }, log);
        await using var health = options.HealthEndpoint is { } healthAddress
            ? new HealthEndpoint(healthAddress, () => new TenantReplicaHealth(state, Replica, options.Role, coordinator.Published().Count))
            : null;
        HealthPort = health?.Port;
        using var background = new CancellationTokenSource();
        List<Task> loops = [];
        var registered = false;
        var confirmed = false;
        try
        {
            await using var mesh = await StartListenerAsync(options.Mesh.Listen, mesh: true, router).ConfigureAwait(false);
            var meshPort = new Uri(mesh.Urls.Single()).Port;
            await registry
                .RegisterAsync(Replica, options.AdvertiseAddress, SchemaMigrator.BinaryLevel, options.ReaderVersion, stop, options.Role, options.Mesh.Address(meshPort))
                .ConfigureAwait(false);
            registered = true;
            renewer.Start();
            loops.Add(HeartbeatAsync(registry, background.Token));
            loops.Add(ListenAsync(hostnames, background.Token));
            loops.Add(IdleScanAsync(coordinator, background.Token));
            var wakeups = new Autonomous.Wakeups(app, options.Timings.Ttl, router.MayStartAutonomousAsync,
                (slug, cause, token) => coordinator.ActivateAsync(slug, cause, token), log);
            loops.Add(wakeups.RunAsync(background.Token));
            await hostnames.RefreshAsync(stop).ConfigureAwait(false);
            loops.Add(RefreshHostnamesAsync(hostnames, background.Token));
            await using var front = await StartListenerAsync(options.PublicEndpoint, mesh: false, router).ConfigureAwait(false);
            FrontPort = new Uri(front.Urls.Single()).Port;
            state = "serving";
            serving.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { }
            state = "stopping";
            router.Drain();
            // Tenants first: each refuses new dispatch as it latches, and the front answers.
            confirmed = await coordinator.ShutdownAsync().ConfigureAwait(false);
            using var frontStop = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await front.StopAsync(frontStop.Token).ConfigureAwait(false);
        }
        catch (Npgsql.NpgsqlException error) when (!registered)
        {
            log("[hosted] The database is unreachable: " + error.Message);
            return HostedExit.Failed;
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested && !registered)
        {
            return HostedExit.Stopped;
        }
        finally
        {
            background.Cancel();
            await Task.WhenAll(loops.Select(loop => loop.ContinueWith(_ => { }, TaskScheduler.Default))).ConfigureAwait(false);
            if (activations is not null)
                await coordinator.DisposeAsync().ConfigureAwait(false);
            if (registered && confirmed)
                try
                {
                    using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await registry.RemoveAsync(Replica, bound.Token).ConfigureAwait(false);
                }
                catch (Exception) { }
        }
        return confirmed ? HostedExit.Stopped : HostedExit.Fenced;
    }

    // One tenant runtime: its database under the generation's fence, its server behind the
    // front, and the operator-document version it was built at.
    private async Task<IGenerationRuntime> BuildAsync(ActivationContext context, CancellationToken token)
    {
        // A grandfathered name that isn't a slug never names anything this replica builds.
        if (!TenantSlugs.IsValid(context.Generation.Tenant))
        {
            log($"[hosted] Tenant {context.Grant.TenantId} has a stored name that isn't a slug ({TenantSlugs.Rule}); it isn't activated.");
            throw new HostedStartupException($"Tenant {context.Grant.TenantId}'s name isn't a slug.");
        }
        var database = new TenantDb(app, context.Grant.TenantId, context.Grant.Epoch, maxInFlight: context.Grant.DbStatements ?? options.MaxInFlight);
        context.Fence.Attach(database);
        var server = new TenantServer(options.PublicUrl(context.Generation.Tenant));
        var built = Interlocked.Read(ref operatorVersion);
        var runtime = await factory(new(context, database, server), token).ConfigureAwait(false);
        var wakeups = runtime is MainHostRuntime main ? new Autonomous.RuntimeWakeups(main.Host.Sessions, database) : null;
        var tenant = new TenantRuntime(this, runtime, server, built, wakeups, context.Wakeup is not null);
        lock (gate)
            live.Add(tenant);
        return tenant;
    }

    private async Task<WebApplication> StartListenerAsync(IPEndPoint endpoint, bool mesh, TenantRouter router)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        if (!mesh) builder.Services.AddHttpForwarder();
        builder.WebHost.UseKestrel(server =>
        {
            server.Listen(endpoint, binding =>
            {
                if (mesh) binding.Protocols = HttpProtocols.Http2;
            });
            server.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
            server.AddServerHeader = false;
        });
        var app = builder.Build();
        // Reserve the operator authority and paths before either tenant listener resolves or admits a request.
        app.Use((context, next) =>
        {
            var path = context.Request.Path;
            if (path.StartsWithSegments(Operator.OperatorServer.Path)
                || options.MountedOperatorPath?.IsMatch(path.Value ?? "") == true
                || Operator.OperatorListener.CanonicalHost(context.Request.Host.Host) == options.OperatorHostname)
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            }
            return next(context);
        });
        if (mesh)
            app.Run(router.MeshAsync);
        else
        {
            var forwarder = app.Services.GetRequiredService<IHttpForwarder>();
            app.Run(context => router.PublicAsync(context, forwarder));
        }
        try
        {
            await app.StartAsync().ConfigureAwait(false);
            return app;
        }
        catch
        {
            await app.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static async Task DispatchTenantAsync(TenantGeneration generation, HttpContext context)
    {
        var server = ((TenantRuntime)generation.Runtime!).Server;
        if (!await server.DispatchAsync(context.Features).ConfigureAwait(false))
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
    }

    private async Task RefreshHostnamesAsync(HostnameDirectory directory, CancellationToken token)
    {
        using var ticks = new PeriodicTimer(HostnameDirectory.Lifetime);
        while (await ticks.WaitForNextTickAsync(token).ConfigureAwait(false))
            try { await directory.RefreshAsync(token).ConfigureAwait(false); }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                log("[hosted] Hostname refresh failed: " + error.GetType().Name);
            }
    }

    private async Task HeartbeatAsync(ReplicaRegistry registry, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(options.Timings.RenewInterval, token).ConfigureAwait(false);
                using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
                bound.CancelAfter(options.Timings.RenewInterval);
                var counts = new JsonObject();
                foreach (var generation in activations!.Published())
                    if (((TenantRuntime)generation.Runtime!).Inner is MainHostRuntime main)
                    {
                        var owners = main.Host.Sessions.Owners().ToArray();
                        counts[generation.Id.Tenant] = new JsonObject
                        {
                            ["epoch"] = generation.Grant.Epoch,
                            ["hot"] = owners.Length,
                            ["busy"] = owners.Count(owner => owner.Entry.WithState(state => state.Busy)),
                        };
                    }
                await registry.HeartbeatAsync(Replica, bound.Token, counts.ToJsonString()).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception) { }
        }
    }

    // Idle release of published tenants. A runtime reports itself idle only when nothing it
    // must run is left without a wake-up; until then the scan releases nothing.
    private async Task IdleScanAsync(TenantActivations coordinator, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(options.IdleScan, token).ConfigureAwait(false);
                foreach (var generation in coordinator.Published())
                    await coordinator.TryReleaseIdleAsync(generation.Id, options.IdleAfter, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                log("[hosted] Idle release failed: " + error.Message);
            }
        }
    }

    // LISTEN on its own connection. Every (re)subscription invalidates as a notification does:
    // a change made while the connection was down sent no notification this replica received.
    private async Task ListenAsync(HostnameDirectory hostnames, CancellationToken token)
    {
        var delay = TimeSpan.FromMilliseconds(200);
        while (!token.IsCancellationRequested)
        {
            try
            {
                await using var connection = await PgDatabase
                    .OpenListenerAsync(connectionString, options.Timings.RenewInterval, token)
                    .ConfigureAwait(false);
                connection.Notification += (_, notification) =>
                {
                    if (notification.Channel == "foxwarm_operator")
                        _ = Task.Run(InvalidateOperatorDocuments);
                    else if (notification.Channel == "foxwarm_tenants")
                    {
                        hostnames.Invalidate();
                        CheckPlacement();
                    }
                };
                await using (var listen = new Npgsql.NpgsqlCommand("LISTEN foxwarm_operator; LISTEN foxwarm_tenants", connection))
                    await listen.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                hostnames.Invalidate();
                InvalidateOperatorDocuments();
                CheckPlacement();
                delay = TimeSpan.FromMilliseconds(200);
                while (true)
                    await connection.WaitAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                log("[hosted] The notification listener lost its connection: " + error.Message);
            }
            try
            {
                await Task.Delay(delay, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, options.Timings.RenewInterval.Ticks));
        }
    }

    // Coalesced: one check runs, and one more after it when signalled meanwhile.
    private int placementChecks;

    private void CheckPlacement()
    {
        if (Interlocked.Increment(ref placementChecks) == 1)
            _ = Task.Run(CheckPlacementLoopAsync);
    }

    private async Task CheckPlacementLoopAsync()
    {
        do
        {
            Interlocked.Exchange(ref placementChecks, 1);
            try
            {
                if (activations is { } coordinator)
                    await RetireMisplacedAsync(coordinator).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                log("[hosted] The placement check failed: " + error.Message);
            }
        } while (Interlocked.Decrement(ref placementChecks) > 0);
    }

    // A published tenant whose committed profile or pin no longer matches its grant (or that
    // this role may no longer serve) is retired and released, then acquired again under the
    // new eligibility. The lease row lock orders such an edit after any grant in flight.
    private async Task RetireMisplacedAsync(TenantActivations coordinator)
    {
        var held = coordinator.Grants();
        if (held.Count == 0)
            return;
        await using var connection = await app.OpenAsync(CancellationToken.None).ConfigureAwait(false);
        await using var command = new Npgsql.NpgsqlCommand(
            "SELECT tenant_id, profile, pinned_role, settings_revision, credential_version, state FROM tenants WHERE tenant_id = ANY($1)",
            connection
        );
        command.Parameters.Add(new Npgsql.NpgsqlParameter<int[]> { TypedValue = [.. held.Select(grant => grant.TenantId).Distinct()] });
        Dictionary<int, (TenantProfile Profile, string? Pinned, long Revision, long Credential, string State)> placement = [];
        await using (var reader = await command.ExecuteReaderAsync().ConfigureAwait(false))
            while (await reader.ReadAsync().ConfigureAwait(false))
                placement[reader.GetInt32(0)] = (TenantProfiles.Parse(reader.GetString(1)), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetInt64(3), reader.GetInt64(4), reader.GetString(5));
        foreach (var grant in held)
            if (placement.TryGetValue(grant.TenantId, out var now)
                && (now.State != "active" || now.Revision != grant.SettingsRevision || now.Profile != grant.Profile || !ReplicaRoles.MayServe(options.Role, now.Profile, now.Pinned)))
                coordinator.SettingsChanged(grant, now.Credential != grant.CredentialVersion);
    }

    private void InvalidateOperatorDocuments()
    {
        TenantRuntime[] runtimes;
        lock (gate)
        {
            operatorVersion++;
            runtimes = [.. live];
        }
        foreach (var runtime in runtimes)
            runtime.OperatorDocumentsChanged();
    }

    private void Retired(TenantRuntime runtime)
    {
        lock (gate)
            live.Remove(runtime);
    }

    // A built tenant runtime as the activation coordinator drives it. Operator-document changes
    // reach it only once started, one callback at a time; a change during its start is applied
    // when the start ends, and retirement waits for a running callback and stops further ones.
    private sealed class TenantRuntime(TenantReplica owner, IHostedRuntime runtime, TenantServer server, long builtAt, Autonomous.RuntimeWakeups? wakeups, bool pendingWakeup)
        : IGenerationRuntime
    {
        private readonly OperatorDocumentCallbacks changes = new(builtAt, () => owner.OperatorVersion, () =>
        {
            try
            {
                owner.operatorDocumentsChanged?.Invoke(runtime);
            }
            catch (Exception error)
            {
                owner.log("[hosted] Applying the operator documents failed: " + error.Message);
            }
        });

        internal TenantServer Server => server;

        internal IHostedRuntime Inner => runtime;

        public void CredentialRotated() => runtime.CredentialRotated();

        // The host's start takes no token: the whole start is awaited, never only the wait.
        public async Task StartAsync(CancellationToken token)
        {
            await runtime.StartAsync().ConfigureAwait(false);
            if (pendingWakeup && wakeups is not null)
                await wakeups.ArmedAsync(token).ConfigureAwait(false);
            _ = changes.Start();
        }

        internal void OperatorDocumentsChanged() => _ = changes.Notify();

        public bool Idle => wakeups?.Idle == true;

        public Task StopProducersAsync(CancellationToken token) => wakeups?.StopProducersAsync() ?? Task.CompletedTask;

        public Task SettleAsync(CancellationToken token) => wakeups?.SettleAsync() ?? Task.CompletedTask;

        public Task<WakeupDue?> NextDueAsync(CancellationToken token) => wakeups?.NextDueAsync(token) ?? Task.FromResult<WakeupDue?>(null);

        public async ValueTask DisposeAsync()
        {
            var running = changes.Retire();
            owner.Retired(this);
            await running.ConfigureAwait(false);
            await runtime.DisposeAsync().ConfigureAwait(false);
        }
    }

    // Serializes a runtime's operator-document callbacks across startup and retirement.
    internal sealed class OperatorDocumentCallbacks(long builtAt, Func<long> version, Action refresh)
    {
        private readonly object state = new();
        private bool started;
        private bool retired;
        private long scheduledVersion = builtAt;
        private Task callbacks = Task.CompletedTask;

        internal Task Start()
        {
            lock (state)
            {
                started = true;
                return ScheduleCurrentVersion();
            }
        }

        internal Task Notify()
        {
            lock (state)
                return ScheduleCurrentVersion();
        }

        // Caller holds state. Start and listener delivery may both observe the same change.
        private Task ScheduleCurrentVersion()
        {
            var current = version();
            if (!started || retired || scheduledVersion == current)
                return callbacks;
            scheduledVersion = current;
            callbacks = callbacks.ContinueWith(_ => Apply(current), CancellationToken.None,
                TaskContinuationOptions.None, TaskScheduler.Default);
            return callbacks;
        }

        private void Apply(long scheduled)
        {
            lock (state)
                if (retired || scheduled != scheduledVersion)
                    return;
            refresh();
        }

        internal Task Retire()
        {
            lock (state)
            {
                retired = true;
                return callbacks;
            }
        }
    }

    private sealed record TenantReplicaHealth(string State, string Replica, string Role, int Tenants) : IHealthReport
    {
        public bool Live => true;

        public bool Ready => State == "serving";

        public string ToJson() =>
            new JsonObject
            {
                ["role"] = Role,
                ["state"] = State,
                ["replica"] = Replica,
                ["tenants"] = Tenants,
                ["ready"] = Ready,
            }.ToJsonString();
    }
}

/// <summary>
/// The front's hostname lookup: <c>Host</c>, lowercased and without the port, to a tenant slug
/// through <c>tenant_hostnames</c>. Cached briefly and cleared on <c>NOTIFY foxwarm_tenants</c>;
/// a clear starts a new generation, and a lookup that began in an older one is neither cached
/// nor trusted: it is repeated. Expired entries are evicted, and entries for unknown hosts are
/// bounded. It routes only; suspension and deletion are the lease row's.
/// </summary>
internal sealed class HostnameDirectory(PgDatabase database, Func<long>? clock = null)
{
    internal static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(30);

    /// <summary>At most this many unknown hosts are remembered; more are looked up each time.</summary>
    internal const int MaxNegative = 1024;

    private readonly Func<long> clock = clock ?? (() => Environment.TickCount64);
    private readonly object gate = new();
    private readonly Dictionary<string, (string? Tenant, long Expires)> cache = new(StringComparer.Ordinal);
    private long generation;
    private int negative;

    /// <summary>Test hook: runs after a lookup's query, before its result is used.</summary>
    internal Func<Task>? AfterQuery { get; set; }

    internal int Count
    {
        get
        {
            lock (gate)
                return cache.Count;
        }
    }

    internal void Invalidate()
    {
        lock (gate)
        {
            generation++;
            cache.Clear();
            negative = 0;
        }
    }

    internal async Task RefreshAsync(CancellationToken token)
    {
        long started;
        lock (gate) started = generation;
        var positive = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new Npgsql.NpgsqlCommand("SELECT h.hostname,t.name FROM tenant_hostnames h JOIN tenants t USING (tenant_id)", connection);
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        while (await reader.ReadAsync(token).ConfigureAwait(false))
            positive.Add(reader.GetString(0), reader.GetString(1));
        lock (gate)
        {
            if (generation != started) return;
            generation++;
            cache.Clear();
            negative = 0;
            var expires = clock() + (long)Lifetime.TotalMilliseconds;
            foreach (var (host, tenant) in positive) cache.Add(host, (tenant, expires));
        }
    }

    internal async Task<string?> ResolveAsync(string host, CancellationToken token)
    {
        var key = (host.EndsWith('.') ? host[..^1] : host).ToLowerInvariant();
        while (true)
        {
            long started;
            lock (gate)
            {
                if (cache.TryGetValue(key, out var cached))
                {
                    if (cached.Expires > clock())
                        return cached.Tenant;
                    Remove(key, cached);
                }
                started = generation;
            }
            var tenant = await QueryAsync(key, token).ConfigureAwait(false);
            if (AfterQuery is { } hook)
                await hook().ConfigureAwait(false);
            lock (gate)
            {
                // Invalidated meanwhile: this answer may predate the change.
                if (generation != started)
                    continue;
                Evict();
                if (tenant is not null || negative < MaxNegative)
                {
                    if (cache.TryGetValue(key, out var previous))
                        Remove(key, previous);
                    cache[key] = (tenant, clock() + (long)Lifetime.TotalMilliseconds);
                    if (tenant is null)
                        negative++;
                }
                return tenant;
            }
        }
    }

    private void Remove(string key, (string? Tenant, long Expires) entry)
    {
        cache.Remove(key);
        if (entry.Tenant is null)
            negative--;
    }

    // Drops expired entries once the cache has grown; caller holds the lock.
    private void Evict()
    {
        if (cache.Count < 64)
            return;
        var now = clock();
        foreach (var (key, entry) in cache.Where(pair => pair.Value.Expires <= now).ToArray())
            Remove(key, entry);
    }

    private async Task<string?> QueryAsync(string key, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new Npgsql.NpgsqlCommand(
            "SELECT t.name FROM tenant_hostnames h JOIN tenants t USING (tenant_id) WHERE h.hostname = $1",
            connection
        );
        command.Parameters.Add(new Npgsql.NpgsqlParameter<string> { TypedValue = key });
        return await command.ExecuteScalarAsync(token).ConfigureAwait(false) as string;
    }
}
