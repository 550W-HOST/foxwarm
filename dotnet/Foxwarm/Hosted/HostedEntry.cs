using System.Net;
using System.Runtime.InteropServices;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Storage;

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
        DeploymentConfiguration deployment;
        try
        {
            bootstrap = HostedBootstrap.FromEnvironment();
            bootstrap.RequireDatabaseUrl();
            deployment = bootstrap.RequireDeployment();
            // Checked before standing by, so a missing key or S3 credential file fails at once.
            _ = bootstrap.RequireKeks();
            _ = deployment.Blobs.S3?.ReadCredentials();
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
                deployment.HealthEndpoint,
                // A standby forwards the public listener the owner's host binds.
                deployment.PublicEndpoint,
                LeaseTimings.Default,
                DrainBound: TimeSpan.FromSeconds(8),
                AgentCatalog.ReaderVersion
            ),
            database,
            (context, token) => CreateRuntimeAsync(context, bootstrap, deployment),
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
    /// Builds the tenant runtime. It refuses while this build lacks a PostgreSQL store, so a
    /// hosted replica never runs over files, then puts the blobs on the deployment's backend.
    /// </summary>
    internal static async Task<IHostedRuntime> CreateRuntimeAsync(
        HostedRuntimeContext context,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment
    )
    {
        var storage = new PostgresStorageContext(context.Database, bootstrap.RequireScratchRoot());
        if (storage.Missing.Count > 0)
            throw new HostedStartupException(
                "This build has no PostgreSQL implementation of the "
                    + string.Join(", ", storage.Missing)
                    + " stores; hosted mode can't start."
            );
        await storage
            .OpenBlobsAsync(deployment.Blobs, bootstrap.Tenant, CancellationToken.None)
            .ConfigureAwait(false);
        return await BuildRuntimeAsync(storage, storage, bootstrap, deployment, context.PublicListener)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// <see cref="MainHost"/> over the tenant: the key ring is opened first (a locked tenant
    /// refuses), then the configuration owner reads the tenant documents with the deployment
    /// configuration, and the host starts on the deployment's listener. Production passes the
    /// complete context as <paramref name="storage"/>; tests may compose it.
    /// </summary>
    internal static async Task<IHostedRuntime> BuildRuntimeAsync(
        PostgresStorageContext tenant,
        IStorageContext storage,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        System.Net.Sockets.Socket? publicListener = null
    )
    {
        ModelConfiguration configuration;
        HostPaths paths;
        JournalRetentionOptions retention;
        try
        {
            retention = JournalRetentionOptions.FromDeployment(deployment.Root["journal"]);
            var (current, previous) = bootstrap.RequireKeks();
            var keys = new HostedKeyRing(tenant.Database, current, previous);
            keys.OpenOrCreate();
            tenant.KeyRing = keys;
            paths = HostPaths.ForDataRoot(bootstrap.RequireScratchRoot()) with
            {
                AgentsRoot = bootstrap.RequireAgentsRoot(),
            };
            configuration = new ModelConfiguration(
                paths,
                new ConfigurationSources(
                    tenant.ConfigDocuments(bootstrap.ReplicaName ?? Environment.MachineName),
                    deployment.Root,
                    // The text-redaction cache is the tenant's, under the key the tenant key
                    // ring derives for it, so a new owner sends the same placeholders.
                    hostPaths => new Foxwarm.Secrets.InstanceSecrets(
                        hostPaths.DataRoot,
                        keyRing: keys,
                        documents: storage.Documents,
                        openTextRedaction: key => tenant.OpenTextRedaction(key)
                    ),
                    storage.Credentials
                )
            );
        }
        catch (Exception error)
            when (error is TenantKeysLockedException or HostedBootstrapException or InvalidDataException)
        {
            throw new HostedStartupException(error.Message);
        }
        var http = (
            await HttpServerSettings
                .CaptureAsync(configuration, paths.DataRoot, storage.Credentials)
                .ConfigureAwait(false)
        ) with
        {
            // The standby's public port, kept open through the takeover.
            ListenSocket = publicListener,
        };
        // Without HTTP no host adopts it, so connections queued on it are refused now.
        if (!http.HttpEnabled)
            publicListener?.Dispose();
        var distRoot = HttpAssets.WebUiDirectory(paths, validate: http.WebUiEnabled);
        var host = await MainHost
            .CreateAsync(
                [],
                configuration,
                http,
                distRoot,
                captureDiagnostics: true,
                storage: storage,
                capabilities: RuntimeCapabilities.Hosted,
                jsonStdoutLog: true
            )
            .ConfigureAwait(false);
        // The owner's daily journal retention; it stops when the host disposes the journal.
        tenant.StartJournalRetention(retention);
        return new MainHostRuntime(host);
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
