using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>Settings of one multi-tenant replica process.</summary>
/// <param name="PublicEndpoint">The front listener every tenant's requests arrive on.</param>
/// <param name="PublicUrl">
/// A tenant runtime's public origin; <c>{slug}</c> is replaced by the tenant's slug.
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
    string PublicUrl,
    LeaseTimings Timings,
    TimeSpan DrainBound,
    int ReaderVersion
)
{
    /// <summary>This replica's placement role (<see cref="ReplicaRoles"/>).</summary>
    internal string Role { get; init; } = ReplicaRoles.General;

    /// <summary>The graceful shutdown's one absolute bound for every tenant.</summary>
    internal TimeSpan ShutdownBound { get; init; } = TimeSpan.FromSeconds(8);

    /// <summary>How long a tenant must have admitted nothing before its idle release.</summary>
    internal TimeSpan IdleAfter { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>How often published tenants are checked for idle release.</summary>
    internal TimeSpan IdleScan { get; init; } = TimeSpan.FromSeconds(30);

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
        var registry = new ReplicaRegistry(control);
        var hostnames = new HostnameDirectory(app);
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
            await registry
                .RegisterAsync(Replica, options.AdvertiseAddress, SchemaMigrator.BinaryLevel, options.ReaderVersion, stop, options.Role)
                .ConfigureAwait(false);
            registered = true;
            renewer.Start();
            loops.Add(HeartbeatAsync(registry, background.Token));
            loops.Add(ListenAsync(hostnames, background.Token));
            loops.Add(IdleScanAsync(coordinator, background.Token));
            await using var front = await StartFrontAsync(coordinator, hostnames).ConfigureAwait(false);
            state = "serving";
            serving.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { }
            state = "stopping";
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
        var database = new TenantDb(app, context.Grant.TenantId, context.Grant.Epoch, maxInFlight: options.MaxInFlight);
        context.Fence.Attach(database);
        var server = new TenantServer(options.PublicUrl.Replace("{slug}", context.Generation.Tenant, StringComparison.Ordinal));
        var built = Interlocked.Read(ref operatorVersion);
        var runtime = await factory(new(context, database, server), token).ConfigureAwait(false);
        var tenant = new TenantRuntime(this, runtime, server, built);
        lock (gate)
            live.Add(tenant);
        return tenant;
    }

    private async Task<WebApplication> StartFrontAsync(TenantActivations coordinator, HostnameDirectory hostnames)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(server =>
        {
            server.Listen(options.PublicEndpoint);
            // As the Main server's own listener; tenant routes raise it per request.
            server.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
            server.AddServerHeader = false;
        });
        var front = builder.Build();
        front.Run(context => DispatchAsync(context, coordinator, hostnames));
        await front.StartAsync().ConfigureAwait(false);
        FrontPort = new Uri(front.Urls.First()).Port;
        return front;
    }

    // Host → tenant → its published generation. A tenant this replica can't serve gets a bare
    // 503 with no tenant data; forwarding to its owner replaces that.
    private static async Task DispatchAsync(HttpContext context, TenantActivations coordinator, HostnameDirectory hostnames)
    {
        var aborted = context.RequestAborted;
        string? tenant;
        try
        {
            tenant = await hostnames.ResolveAsync(context.Request.Host.Host, aborted).ConfigureAwait(false);
        }
        catch (Exception) when (!aborted.IsCancellationRequested)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }
        if (tenant is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        TenantGeneration generation;
        AdmissionGate.Admission admission;
        try
        {
            (generation, admission) = await coordinator.AdmitAsync(tenant, ActivationCause.Request, aborted).ConfigureAwait(false);
        }
        catch (Exception error) when (
            error is TenantHeldElsewhereException or TenantNotEligibleException or TenantFencedException
                or LeaseRefusedException or ObjectDisposedException or Npgsql.NpgsqlException
                or HostedStartupException or StartupCleanupFailedException
            || error is OperationCanceledException && !aborted.IsCancellationRequested
        )
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }
        using (admission)
        {
            var server = ((TenantRuntime)generation.Runtime!).Server;
            if (!await server.DispatchAsync(context.Features).ConfigureAwait(false))
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
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
                await registry.HeartbeatAsync(Replica, bound.Token).ConfigureAwait(false);
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
                        hostnames.Invalidate();
                };
                await using (var listen = new Npgsql.NpgsqlCommand("LISTEN foxwarm_operator; LISTEN foxwarm_tenants", connection))
                    await listen.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                hostnames.Invalidate();
                InvalidateOperatorDocuments();
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

    // A built tenant runtime as the activation coordinator drives it.
    private sealed class TenantRuntime(TenantReplica owner, IHostedRuntime runtime, TenantServer server, long builtAt)
        : IGenerationRuntime
    {
        private readonly object state = new();
        private bool started;
        private long appliedAt = builtAt;

        internal TenantServer Server => server;

        internal IHostedRuntime Inner => runtime;

        public async Task StartAsync(CancellationToken token)
        {
            await runtime.StartAsync().WaitAsync(token).ConfigureAwait(false);
            lock (state)
                started = true;
            // A change after the build read the documents, notified before the start ended.
            if (Interlocked.Read(ref owner.operatorVersion) != appliedAt)
                OperatorDocumentsChanged();
        }

        internal void OperatorDocumentsChanged()
        {
            lock (state)
            {
                appliedAt = Interlocked.Read(ref owner.operatorVersion);
                if (!started)
                    return;
            }
            try
            {
                owner.operatorDocumentsChanged?.Invoke(runtime);
            }
            catch (Exception error)
            {
                owner.log("[hosted] Applying the operator documents failed: " + error.Message);
            }
        }

        // Released only once the runtime can report what keeps it busy and what is due; until
        // then a tenant stays active while its grant renews.
        public bool Idle => false;

        public Task StopProducersAsync(CancellationToken token) => Task.CompletedTask;

        public Task SettleAsync(CancellationToken token) => Task.CompletedTask;

        public Task<WakeupDue?> NextDueAsync(CancellationToken token) => Task.FromResult<WakeupDue?>(null);

        public async ValueTask DisposeAsync()
        {
            try
            {
                await runtime.DisposeAsync().ConfigureAwait(false);
            }
            finally
            {
                owner.Retired(this);
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
/// through <c>tenant_hostnames</c>. Cached briefly, and cleared on <c>NOTIFY foxwarm_tenants</c>.
/// It routes only; suspension and deletion are the lease row's.
/// </summary>
internal sealed class HostnameDirectory(PgDatabase database)
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(30);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string? Tenant, long Expires)> cache = new(StringComparer.Ordinal);

    internal void Invalidate() => cache.Clear();

    internal async Task<string?> ResolveAsync(string host, CancellationToken token)
    {
        var key = host.ToLowerInvariant();
        var now = Environment.TickCount64;
        if (cache.TryGetValue(key, out var cached) && cached.Expires > now)
            return cached.Tenant;
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new Npgsql.NpgsqlCommand(
            "SELECT t.name FROM tenant_hostnames h JOIN tenants t USING (tenant_id) WHERE h.hostname = $1",
            connection
        );
        command.Parameters.Add(new Npgsql.NpgsqlParameter<string> { TypedValue = key });
        var tenant = await command.ExecuteScalarAsync(token).ConfigureAwait(false) as string;
        cache[key] = (tenant, now + (long)Lifetime.TotalMilliseconds);
        return tenant;
    }
}
