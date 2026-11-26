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
/// <param name="PublicListener">
/// The standby's public listen socket, still open, for the runtime's host to adopt instead of
/// binding the port anew; null without a forwarder. The replica disposes it after the runtime.
/// </param>
internal sealed record HostedRuntimeContext(
    LeaseGrant Grant,
    TenantDb Database,
    LeaseMonitor Monitor,
    System.Net.Sockets.Socket? PublicListener = null
);

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

    // A fenced owner reports fencing from the fence on, before the run gets to it.
    internal HealthState Health =>
        monitor is { } current && health.Role == ReplicaRole.Owner
            ? current.Fenced.IsCompleted
                ? health with { Role = ReplicaRole.Fencing, RuntimeStarted = false }
                : health with { SinceRenewal = current.SinceRenewal }
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
        // A connection waits up to one lease TTL for a reachable owner: a graceful handover
        // takes a few seconds of it.
        await using var forwarder = options.PublicEndpoint is { } publicAddress
            ? new StandbyForwarder(
                publicAddress,
                token => registry.OwnerAddressAsync(options.Tenant, token),
                options.Timings.Ttl,
                log,
                selfAddress: options.AdvertiseAddress
            )
            : null;
        ForwarderPort = forwarder?.Port;
        waiting.TrySetResult();
        try
        {
            grant = await lease
                .AcquireAsync(Replica, options.Timings, error => log("[lease] " + error.Message), stop)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested && forwarder is not null)
        {
            // A standby's graceful stop: not ready before the port closes, so new connections go
            // elsewhere; forwarded ones finish.
            health = health with { Role = ReplicaRole.Stopping };
            await forwarder.DrainAsync(options.DrainBound).ConfigureAwait(false);
            throw;
        }
        // The monitor first: its fence clock starts at the acquisition, and a fence or a stop
        // from here on ends the run within the drain bound.
        await using var current = new LeaseMonitor(lease, grant, options.Timings, log);
        monitor = current;
        var tenant = new TenantDb(database, grant.TenantId, grant.Epoch);
        current.Attach(tenant);
        current.Start();
        health = health with { Role = ReplicaRole.Owner, Epoch = grant.Epoch };
        // The public port stays open: its socket passes to the owner's host, so connections
        // queue until the host accepts them, and the ones the forwarder holds reach this owner.
        using var publicListener = forwarder is null ? null : await forwarder.HandOverAsync().ConfigureAwait(false);
        ForwarderPort = null;
        log($"[hosted] Replica {Replica} owns tenant {options.Tenant} at epoch {grant.Epoch}.");

        // The start runs supervised: a fence or a stop doesn't wait for a factory or a start
        // that ignores cancellation.
        var start = new RuntimeStart();
        using var starting = CancellationTokenSource.CreateLinkedTokenSource(stop, current.Lost);
        var started = Task.Run(async () =>
        {
            var runtime = await createRuntime(new(grant, tenant, current, publicListener), starting.Token).ConfigureAwait(false);
            start.Runtime = runtime;
            // A runtime built after a fence or a stop is disposed, not started.
            starting.Token.ThrowIfCancellationRequested();
            await runtime.StartAsync().ConfigureAwait(false);
        });
        _ = started.ContinueWith(
            task => _ = task.Exception,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously
        );
        var stopRequested = Task.Delay(Timeout.Infinite, stop);
        await Task.WhenAny(started, current.Fenced, stopRequested).ConfigureAwait(false);
        if (current.Fenced.IsCompleted)
            return await FenceAsync(current, start, started).ConfigureAwait(false);
        if (!started.IsCompletedSuccessfully)
        {
            if (stop.IsCancellationRequested)
            {
                // A requested stop during the start: not a failure.
                health = health with { Role = ReplicaRole.Stopping };
                log("[hosted] Stopped during the runtime start.");
                await EndStartAsync(start, started).ConfigureAwait(false);
                if (current.Fenced.IsCompleted)
                    return HostedExit.Fenced;
                await current.ReleaseAsync(CancellationToken.None).ConfigureAwait(false);
                return HostedExit.Stopped;
            }
            var error = started.Exception?.GetBaseException();
            log("[hosted] Runtime start failed: " + error?.Message);
            health = health with { Role = ReplicaRole.Stopping };
            // A partly started runtime is disposed before ownership is given up.
            await EndStartAsync(start, started).ConfigureAwait(false);
            if (current.Fenced.IsCompleted)
                return HostedExit.Fenced;
            await current.ReleaseAsync(CancellationToken.None).ConfigureAwait(false);
            return error is HostedStartupException ? HostedExit.Configuration : HostedExit.Failed;
        }
        var running = start.Runtime!;
        health = health with { RuntimeStarted = true };

        var finished = await Task.WhenAny(stopRequested, current.Fenced, running.Stopped).ConfigureAwait(false);
        if (finished == current.Fenced || current.Fenced.IsCompleted)
            return await FenceAsync(current, start, started).ConfigureAwait(false);
        health = health with { Role = ReplicaRole.Stopping, RuntimeStarted = false };
        await running.DisposeAsync().ConfigureAwait(false);
        if (current.Fenced.IsCompleted)
            return HostedExit.Fenced;
        await current.ReleaseAsync(CancellationToken.None).ConfigureAwait(false);
        log($"[hosted] Replica {Replica} released tenant {options.Tenant}.");
        return HostedExit.Stopped;
    }

    /// <summary>The runtime of the start, once the factory returned it.</summary>
    private sealed class RuntimeStart
    {
        internal volatile IHostedRuntime? Runtime;
    }

    // After a fence, at whatever point of the start or run: not ready at once, then the start is
    // given up and the runtime disposed, all within the drain bound; the run returns 75 whether
    // or not they finished.
    private async Task<int> FenceAsync(LeaseMonitor current, RuntimeStart start, Task started)
    {
        var atFence = current.FencedSinceRenewal;
        health = health with { Role = ReplicaRole.Fencing, RuntimeStarted = false };
        log($"[hosted] Stopping the runtime within {options.DrainBound.TotalSeconds:0.#} s after fencing.");
        var stopped = await EndStartAsync(start, started).ConfigureAwait(false);
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

    // Waits for the start to end (its token is cancelled by a stop or a fence) and disposes the
    // runtime if the factory returned one, together bounded by the drain bound. True when both
    // finished in time.
    private async Task<bool> EndStartAsync(RuntimeStart start, Task started)
    {
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        TimeSpan Remaining() => options.DrainBound - deadline.Elapsed is var left && left > TimeSpan.Zero ? left : TimeSpan.Zero;
        if (await Task.WhenAny(started, Task.Delay(Remaining())).ConfigureAwait(false) != started)
            return false;
        if (start.Runtime is not { } runtime)
            return true;
        var disposal = runtime.DisposeAsync().AsTask();
        _ = disposal.ContinueWith(
            task => _ = task.Exception,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously
        );
        return await Task.WhenAny(disposal, Task.Delay(Remaining())).ConfigureAwait(false) == disposal;
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
