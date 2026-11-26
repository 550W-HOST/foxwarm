using System.Net;
using System.Runtime.InteropServices;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

/// <summary>
/// The process entry of hosted mode (<c>FOXWARM_MODE=hosted</c>). It replaces the file-mode
/// entry's data directory and installation lock with the bootstrap settings and the tenant
/// lease, and runs one <see cref="HostedReplica"/> until a stop signal or a fence.
/// </summary>
internal static class HostedEntry
{
    internal static async Task<int> RunAsync()
    {
        HostedBootstrap bootstrap;
        try
        {
            bootstrap = HostedBootstrap.FromEnvironment();
            bootstrap.RequireDatabaseUrl();
        }
        catch (HostedBootstrapException error)
        {
            Console.Error.WriteLine("Error: " + error.Message);
            return HostedExit.Configuration;
        }
        using var stop = new CancellationTokenSource();
        using var terminate = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Cancel);
        using var interrupt = PosixSignalRegistration.Create(PosixSignal.SIGINT, Cancel);
        await using var database = new PgDatabase(bootstrap.RequireDatabaseUrl(), "foxwarm");
        var replica = new HostedReplica(
            new HostedReplicaOptions(
                bootstrap.Tenant,
                bootstrap.ReplicaName ?? Environment.MachineName,
                bootstrap.AdvertiseAddress,
                new IPEndPoint(IPAddress.Any, bootstrap.HealthPort),
                // The public listener comes from the deployment configuration, which doesn't
                // exist yet; until then a standby forwards nothing.
                PublicEndpoint: null,
                LeaseTimings.Default,
                DrainBound: TimeSpan.FromSeconds(8),
                AgentCatalog.ReaderVersion
            ),
            database,
            (context, token) => CreateRuntimeAsync(context, bootstrap),
            line => Console.Error.WriteLine(line)
        );
        var code = await replica.RunAsync(stop.Token).ConfigureAwait(false);
        Console.Error.WriteLine($"[hosted] Replica {replica.Replica} exits with code {code}.");
        // A fenced runtime may still have work that ignored cancellation; the process ends
        // now, within the lease's slack, whatever is left.
        if (code == HostedExit.Fenced)
            Environment.Exit(code);
        return code;

        void Cancel(PosixSignalContext context)
        {
            context.Cancel = true;
            stop.Cancel();
        }
    }

    /// <summary>
    /// Builds the tenant runtime. It refuses while this build lacks a PostgreSQL store or the
    /// tenant configuration documents, so a hosted replica never runs over files.
    /// </summary>
    internal static Task<IHostedRuntime> CreateRuntimeAsync(HostedRuntimeContext context, HostedBootstrap bootstrap)
    {
        var storage = new PostgresStorageContext(context.Database, bootstrap.RequireScratchRoot());
        if (storage.Missing.Count > 0)
            throw new HostedStartupException(
                "This build has no PostgreSQL implementation of the "
                    + string.Join(", ", storage.Missing)
                    + " stores; hosted mode can't start."
            );
        throw new HostedStartupException(
            "This build reads no tenant configuration documents; hosted mode can't start."
        );
    }
}

/// <summary><see cref="MainHost"/> as the runtime of an owner replica.</summary>
internal sealed class MainHostRuntime(MainHost host) : IHostedRuntime
{
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal MainHost Host => host;

    public async Task StartAsync()
    {
        await host.StartAsync().ConfigureAwait(false);
        started.TrySetResult();
    }

    public Task Stopped => started.Task.ContinueWith(_ => host.WaitForShutdownAsync()).Unwrap();

    public ValueTask DisposeAsync() => host.DisposeAsync();
}
