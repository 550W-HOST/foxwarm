using System.Net;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;

namespace Foxwarm.Hosted;

/// <summary>Exit codes of a hosted replica process.</summary>
internal static class HostedExit
{
    internal const int Stopped = 0;

    /// <summary>Any other failure, for example an unreachable database; the orchestrator retries.</summary>
    internal const int Failed = 1;

    /// <summary>The replica lost or gave up ownership while running (EX_TEMPFAIL); restart it.</summary>
    internal const int Fenced = 75;

    /// <summary>Bootstrap, schema, tenant or store refusal (EX_CONFIG); restarting won't help.</summary>
    internal const int Configuration = 78;
}

/// <summary>A refusal to start the tenant runtime that no retry can fix.</summary>
internal sealed class HostedStartupException(string message) : Exception(message);

/// <summary>The tenant runtime an owner replica runs: today's Main host over hosted stores.</summary>
internal interface IHostedRuntime : IAsyncDisposable
{
    /// <summary>Starts serving.</summary>
    Task StartAsync();

    /// <summary>Completes when the runtime stopped on its own (for example a stop request).</summary>
    Task Stopped { get; }
}

/// <summary>What a starting owner gives its runtime.</summary>
internal sealed record HostedRuntimeContext(LeaseGrant Grant, TenantDb Database, LeaseMonitor Monitor);

/// <summary>A fenced run's timings since the start of the last successful renewal.</summary>
internal sealed record FenceTiming(
    string Reason,
    long RenewalStart,
    TimeSpan AtFence,
    TimeSpan? RuntimeStopped
)
{
    /// <summary>When the replica's run returned, so the process exits.</summary>
    internal TimeSpan? Exited { get; init; }
}

/// <summary>Settings of one replica process.</summary>
/// <param name="PublicEndpoint">
/// Where a standby forwards connections to the owner, the address the owner's host listens on;
/// null runs no forwarder.
/// </param>
/// <param name="DrainBound">
/// How long a fencing replica waits for its runtime to stop before it exits anyway. It is below
/// the lease TTL minus the fence deadline, so the process is gone before a successor can start.
/// </param>
internal sealed record HostedReplicaOptions(
    string Tenant,
    string ReplicaName,
    string? AdvertiseAddress,
    IPEndPoint? HealthEndpoint,
    IPEndPoint? PublicEndpoint,
    LeaseTimings Timings,
    TimeSpan DrainBound,
    int ReaderVersion
);

/// <summary>
/// One hosted replica's life: check the schema, register, wait as a standby (health endpoint
/// and forwarder), take the tenant lease, run the tenant runtime under the lease monitor, and
/// stop. A graceful stop drains the runtime while still owner, then releases the lease so a
/// standby takes over at once. A fence (takeover, refused write, renewal deadline) stops the
/// runtime within the drain bound and returns <see cref="HostedExit.Fenced"/>; the orchestrator
/// restarts the process as a standby. Takeover is therefore today's startup on the new owner.
/// </summary>
internal sealed class HostedReplica
{
    private readonly HostedReplicaOptions options;
    private readonly PgDatabase database;
    private readonly Func<HostedRuntimeContext, CancellationToken, Task<IHostedRuntime>> createRuntime;
    private readonly Action<string> log;
    private readonly IReadOnlyList<SchemaMigration>? migrations;
    private volatile HealthState health;
    private LeaseMonitor? monitor;

    internal HostedReplica(
        HostedReplicaOptions options,
        PgDatabase database,
        Func<HostedRuntimeContext, CancellationToken, Task<IHostedRuntime>> createRuntime,
        Action<string> log,
        IReadOnlyList<SchemaMigration>? migrations = null
    )
    {
        options.Timings.Validate();
        if (options.DrainBound <= TimeSpan.Zero || options.DrainBound >= options.Timings.Ttl - options.Timings.FenceAfter)
            throw new ArgumentException("The drain bound must be positive and below the lease TTL minus the fence deadline.");
        this.options = options;
        this.database = database;
        this.createRuntime = createRuntime;
        this.log = log;
        this.migrations = migrations;
        Replica = ReplicaRegistry.NewReplicaId(options.ReplicaName);
        health = new HealthState(ReplicaRole.Starting, Replica, options.Tenant);
    }

    internal string Replica { get; }

    internal HealthState Health =>
        monitor is { } current && health.Role == ReplicaRole.Owner
            ? health with { SinceRenewal = current.SinceRenewal }
            : health;

    /// <summary>The health endpoint's port once listening (tests use an ephemeral port).</summary>
    internal int? HealthPort { get; private set; }

    /// <summary>The forwarder's port while a standby (tests use an ephemeral port).</summary>
    internal int? ForwarderPort { get; private set; }

    /// <summary>
    /// How a fenced run ended, measured by the lease monitor from the start of the last successful
    /// renewal (the lease's expiry is at least the TTL after it): the fence reason, the time at
    /// the fence, once the runtime had stopped (null when it outlived the drain bound) and when the
    /// run returned. Diagnostics and the fencing tests read it.
    /// </summary>
    internal FenceTiming? FenceTimes { get; private set; }

    /// <summary>Completes once the replica is a standby waiting for the lease.</summary>
    internal Task Waiting => waiting.Task;

    private readonly TaskCompletionSource waiting = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Runs until <paramref name="stop"/>, a fence or a runtime stop; returns the exit code.</summary>
    internal async Task<int> RunAsync(CancellationToken stop)
    {
        try
        {
            await SchemaMigrator.RequireCompatibleAsync(database, migrations, stop).ConfigureAwait(false);
        }
        catch (SchemaIncompatibleException error)
        {
            log("[hosted] " + error.Message);
            return HostedExit.Configuration;
        }
        catch (Npgsql.NpgsqlException error) when (!stop.IsCancellationRequested)
        {
            return DatabaseFailure(error);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            return HostedExit.Stopped;
        }
        var lease = new TenantLease(database, options.Tenant, options.ReaderVersion);
        var registry = new ReplicaRegistry(database);
        await using var healthEndpoint = options.HealthEndpoint is { } healthAddress
            ? new HealthEndpoint(healthAddress, () => Health)
            : null;
        HealthPort = healthEndpoint?.Port;
        using var heartbeatStop = new CancellationTokenSource();
        Task? heartbeat = null;
        try
        {
            await lease.TenantIdAsync(stop).ConfigureAwait(false);
            await registry
                .RegisterAsync(Replica, options.AdvertiseAddress, SchemaMigrator.BinaryLevel, options.ReaderVersion, stop)
                .ConfigureAwait(false);
            heartbeat = HeartbeatAsync(registry, heartbeatStop.Token);
            return await RunRegisteredAsync(lease, registry, stop).ConfigureAwait(false);
        }
        catch (LeaseRefusedException error)
        {
            log("[hosted] " + error.Message);
            return HostedExit.Configuration;
        }
        catch (Npgsql.NpgsqlException error) when (!stop.IsCancellationRequested && health.Role != ReplicaRole.Owner)
        {
            // Before ownership only; an owner's database failures end in a fence instead.
            return DatabaseFailure(error);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            return HostedExit.Stopped;
        }
        finally
        {
            heartbeatStop.Cancel();
            // A fenced replica exits within its drain bound, before the lease can expire: it
            // doesn't wait on a database it may be cut off from. Its row stays, without
            // heartbeats; rows are diagnostic and ownership is the lease's.
            if (FenceTimes is { } fenced)
                FenceTimes = fenced with { Exited = monitor!.SinceRenewal };
            else
            {
                if (heartbeat is not null)
                    await heartbeat.ConfigureAwait(false);
                try
                {
                    using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await registry.RemoveAsync(Replica, bound.Token).ConfigureAwait(false);
                }
                catch (Exception) { }
            }
        }
    }

    private async Task<int> RunRegisteredAsync(TenantLease lease, ReplicaRegistry registry, CancellationToken stop)
    {
        LeaseGrant grant;
        health = health with { Role = ReplicaRole.Standby };
        {
            await using var forwarder = options.PublicEndpoint is { } publicAddress
                ? new StandbyForwarder(publicAddress, token => registry.OwnerAddressAsync(options.Tenant, token), log)
                : null;
            ForwarderPort = forwarder?.Port;
            waiting.TrySetResult();
            grant = await lease
                .AcquireAsync(Replica, options.Timings, error => log("[lease] " + error.Message), stop)
                .ConfigureAwait(false);
            // The forwarder is disposed here, freeing the public port for the owner's host.
        }
        ForwarderPort = null;
        log($"[hosted] Replica {Replica} owns tenant {options.Tenant} at epoch {grant.Epoch}.");
        await using var current = new LeaseMonitor(lease, grant, options.Timings, log);
        monitor = current;
        var tenant = new TenantDb(database, grant.TenantId, grant.Epoch);
        current.Attach(tenant);
        current.Start();
        health = health with { Role = ReplicaRole.Owner, Epoch = grant.Epoch };

        IHostedRuntime runtime;
        try
        {
            using var starting = CancellationTokenSource.CreateLinkedTokenSource(stop, current.Lost);
            runtime = await createRuntime(new(grant, tenant, current), starting.Token).ConfigureAwait(false);
            await runtime.StartAsync().ConfigureAwait(false);
        }
        catch (Exception error) when (current.Fenced.IsCompleted)
        {
            log("[hosted] Runtime start ended by fencing: " + error.Message);
            return HostedExit.Fenced;
        }
        catch (Exception error)
        {
            log("[hosted] Runtime start failed: " + error.Message);
            await current.ReleaseAsync(CancellationToken.None).ConfigureAwait(false);
            return error is HostedStartupException ? HostedExit.Configuration : HostedExit.Failed;
        }
        health = health with { RuntimeStarted = true };

        var stopRequested = Task.Delay(Timeout.Infinite, stop);
        var finished = await Task.WhenAny(stopRequested, current.Fenced, runtime.Stopped).ConfigureAwait(false);
        if (finished == current.Fenced)
        {
            var atFence = current.FencedSinceRenewal;
            health = health with { Role = ReplicaRole.Fencing, RuntimeStarted = false };
            log($"[hosted] Stopping the runtime within {options.DrainBound.TotalSeconds:0.#} s after fencing.");
            var disposal = runtime.DisposeAsync().AsTask();
            var stopped = await Task.WhenAny(disposal, Task.Delay(options.DrainBound)).ConfigureAwait(false) == disposal;
            if (!stopped)
                log("[hosted] The runtime didn't stop within the drain bound; exiting anyway.");
            FenceTimes = new(
                await current.Fenced.ConfigureAwait(false),
                current.RenewalStart,
                atFence!.Value,
                stopped ? current.SinceRenewal : null
            );
            return HostedExit.Fenced;
        }
        health = health with { Role = ReplicaRole.Stopping, RuntimeStarted = false };
        await runtime.DisposeAsync().ConfigureAwait(false);
        if (current.Fenced.IsCompleted)
            return HostedExit.Fenced;
        await current.ReleaseAsync(CancellationToken.None).ConfigureAwait(false);
        log($"[hosted] Replica {Replica} released tenant {options.Tenant}.");
        return HostedExit.Stopped;
    }

    // Refused credentials, role or database won't change on a restart; anything else may.
    private int DatabaseFailure(Npgsql.NpgsqlException error)
    {
        var state = (error as Npgsql.PostgresException)?.SqlState;
        var configuration = state is not null && (state.StartsWith("28", StringComparison.Ordinal) || state == "3D000");
        log("[hosted] Database " + (configuration ? "refused the connection: " : "unavailable: ") + error.Message);
        return configuration ? HostedExit.Configuration : HostedExit.Failed;
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
}
