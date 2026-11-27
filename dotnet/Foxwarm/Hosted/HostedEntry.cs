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
        // Transitional: the multi-tenant runtimes host, until forwarding replaces the
        // single-tenant replica and this selection is removed.
        if (Environment.GetEnvironmentVariable("FOXWARM_HOSTED_TOPOLOGY") == "tenants")
            return await RunTenantsAsync(bootstrap, deployment, database, stop.Token).ConfigureAwait(false);
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
            (context, token) => CreateRuntimeAsync(context, bootstrap, deployment, token),
            line => Console.Error.WriteLine(line),
            // A runtime that doesn't stop by its fence's deadline ends the process there.
            exit: Environment.Exit
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

    private static async Task<int> RunTenantsAsync(
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        PgDatabase database,
        CancellationToken stop
    )
    {
        var replica = new Runtimes.TenantReplica(
            new Runtimes.TenantReplicaOptions(
                bootstrap.ReplicaName ?? Environment.MachineName,
                bootstrap.AdvertiseAddress,
                deployment.HealthEndpoint,
                deployment.PublicEndpoint,
                TenantPublicUrl(deployment),
                LeaseTimings.Default,
                DrainBound: TimeSpan.FromSeconds(8),
                AgentCatalog.ReaderVersion
            ),
            database,
            bootstrap.RequireDatabaseUrl(),
            (context, token) => CreateTenantRuntimeAsync(context, bootstrap, deployment, token),
            line => Console.Error.WriteLine(line),
            exit: Environment.Exit
        );
        var code = await replica.RunAsync(stop).ConfigureAwait(false);
        Console.Error.WriteLine($"[hosted] Replica {replica.Replica} exits with code {code}.");
        if (code == HostedExit.Fenced)
            Environment.Exit(code);
        return code;
    }

    // A tenant runtime's public origin: the deployment URL with {slug}, or the front itself.
    private static string TenantPublicUrl(DeploymentConfiguration deployment) =>
        deployment.Root["url"]?.GetValue<string>() is { } url && url.Contains("{slug}", StringComparison.Ordinal)
            ? url.TrimEnd('/')
            : $"http://{{slug}}:{deployment.PublicEndpoint.Port}";

    /// <summary>
    /// One tenant's runtime on a multi-tenant replica: its own scratch and Agents directories
    /// under the replica's (<c>t/&lt;slug&gt;</c>), its blobs, and no listener of its own.
    /// </summary>
    internal static async Task<IHostedRuntime> CreateTenantRuntimeAsync(
        Runtimes.TenantRuntimeContext context,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        CancellationToken token = default
    )
    {
        var slug = context.Activation.Generation.Tenant;
        var tenant = bootstrap with
        {
            Tenant = slug,
            ScratchRoot = Path.Combine(bootstrap.RequireScratchRoot(), "t", slug),
            AgentsRoot = bootstrap.AgentsRoot is { } agents ? Path.Combine(agents, "t", slug) : null,
        };
        var storage = new PostgresStorageContext(context.Database, tenant.RequireScratchRoot());
        try
        {
            if (storage.Missing.Count > 0)
                throw new HostedStartupException(
                    "This build has no PostgreSQL implementation of the "
                        + string.Join(", ", storage.Missing)
                        + " stores; hosted mode can't start."
                );
            await storage.OpenBlobsAsync(deployment.Blobs, slug, token).ConfigureAwait(false);
        }
        catch
        {
            await storage.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        return await BuildRuntimeAsync(storage, storage, tenant, deployment, null, token, context.Server)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Builds the tenant runtime. It refuses while this build lacks a PostgreSQL store, so a
    /// hosted replica never runs over files, then puts the blobs on the deployment's backend.
    /// </summary>
    /// <summary>
    /// How long a stopping owner's host waits for requests still in progress. The host stops
    /// after the Sessions have drained, and the lease is released only after it: a client that
    /// sent part of a request and stalls would otherwise hold the takeover for the host default
    /// of 30 s, a whole lease TTL. A request cut off here is retried on the new owner.
    /// </summary>
    internal static readonly TimeSpan HttpShutdownTimeout = TimeSpan.FromSeconds(2);

    internal static async Task<IHostedRuntime> CreateRuntimeAsync(
        HostedRuntimeContext context,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        CancellationToken token = default
    )
    {
        var storage = new PostgresStorageContext(context.Database, bootstrap.RequireScratchRoot());
        try
        {
            if (storage.Missing.Count > 0)
                throw new HostedStartupException(
                    "This build has no PostgreSQL implementation of the "
                        + string.Join(", ", storage.Missing)
                        + " stores; hosted mode can't start."
                );
            await storage
                .OpenBlobsAsync(deployment.Blobs, bootstrap.Tenant, token)
                .ConfigureAwait(false);
        }
        catch
        {
            await storage.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        return await BuildRuntimeAsync(storage, storage, bootstrap, deployment, context.PublicListener, token)
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
        System.Net.Sockets.Socket? publicListener = null,
        CancellationToken token = default,
        Runtimes.TenantServer? server = null
    )
    {
        // The runtime owns the tenant context from here; a build that fails releases it. A
        // release that fails too is reported, so the owner treats the stop as unconfirmed.
        try
        {
            return await BuildRuntimeCoreAsync(tenant, storage, bootstrap, deployment, publicListener, server, token)
                .ConfigureAwait(false);
        }
        catch (Exception error)
        {
            try
            {
                await tenant.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                throw new StartupCleanupFailedException(
                    error is StartupCleanupFailedException partial ? partial.InnerException! : error,
                    [.. (error as StartupCleanupFailedException)?.Cleanup ?? [], cleanup]
                );
            }
            throw;
        }
    }

    private static async Task<IHostedRuntime> BuildRuntimeCoreAsync(
        PostgresStorageContext tenant,
        IStorageContext storage,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        System.Net.Sockets.Socket? publicListener,
        Runtimes.TenantServer? server,
        CancellationToken token
    )
    {
        ModelConfiguration configuration;
        HostPaths paths;
        JournalRetentionOptions retention;
        // The tenant's stored profile, fixed for this runtime: a change is a move to a new one.
        var profile = await TenantProfileStore.ReadAsync(tenant.Database, token).ConfigureAwait(false);
        try
        {
            retention = JournalRetentionOptions.FromDeployment(deployment.Root["journal"]);
            var (current, previous) = bootstrap.RequireKeks();
            var keys = new HostedKeyRing(tenant.Database, current, previous);
            keys.OpenOrCreate();
            tenant.KeyRing = keys;
            // The Agents' files are in the tenant's Agent store; the host's Agents root is a
            // directory of the replica that nothing creates (the scratch guard checks it).
            var scratch = bootstrap.RequireScratchRoot();
            paths = HostPaths.ForDataRoot(scratch) with { AgentsRoot = Path.Combine(scratch, "agents") };
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
                {
                    OperatorCeiling = new OperatorCeilingDocuments(tenant.Database, profile),
                    // The paths the tenant's config document may hold.
                    Profile = profile,
                }
            );
        }
        catch (Exception error)
            when (error is TenantKeysLockedException or HostedBootstrapException or InvalidDataException)
        {
            throw new HostedStartupException(error.Message);
        }
        token.ThrowIfCancellationRequested();
        var http = (
            await HttpServerSettings
                .CaptureAsync(configuration, paths.DataRoot, storage.Credentials)
                .ConfigureAwait(false)
        ) with
        {
            // The standby's public port, kept open through the takeover.
            ListenSocket = publicListener,
            ShutdownTimeout = HttpShutdownTimeout,
            // A tenant of a multi-tenant replica: requests come from the replica's front.
            Server = server,
        };
        // Without HTTP no host adopts it, so connections queued on it are refused now.
        if (!http.HttpEnabled)
            publicListener?.Dispose();
        token.ThrowIfCancellationRequested();
        var distRoot = HttpAssets.WebUiDirectory(paths, validate: http.WebUiEnabled);
        var host = await MainHost
            .CreateAsync(
                [],
                configuration,
                http,
                distRoot,
                captureDiagnostics: true,
                storage: storage,
                capabilities: RuntimeCapabilities.For(profile, deployment.Egress),
                jsonStdoutLog: true,
                logTenant: bootstrap.Tenant
            )
            .ConfigureAwait(false);
        // The owner's daily journal retention; it stops when the host disposes the journal.
        tenant.StartJournalRetention(retention);
        return new MainHostRuntime(host, tenant);
    }
}

/// <summary><see cref="MainHost"/> as the runtime of an owner replica, with the tenant context it owns.</summary>
internal sealed class MainHostRuntime(MainHost host, PostgresStorageContext tenant) : IHostedRuntime
{
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal MainHost Host => host;

    /// <summary>
    /// The operator changed <c>operator_documents</c> (<c>NOTIFY foxwarm_operator</c>): the
    /// tenant's next authorization check reads its ceiling again. The runtimes host's listener
    /// calls this for every runtime it serves; a missed signal leaves the previous ceiling in
    /// force until the next one or a new runtime.
    /// </summary>
    internal void OperatorDocumentsChanged() => host.Sessions.Authorization.OperatorCeilingChanged();

    public async Task StartAsync()
    {
        await host.StartAsync().ConfigureAwait(false);
        started.TrySetResult();
    }

    public Task Stopped => started.Task.ContinueWith(_ => host.WaitForShutdownAsync()).Unwrap();

    public async ValueTask DisposeAsync()
    {
        try
        {
            await host.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            await tenant.DisposeAsync().ConfigureAwait(false);
        }
    }
}
