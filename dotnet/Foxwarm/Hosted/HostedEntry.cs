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
/// lease, and runs the multi-tenant replica until shutdown.
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
        return await RunTenantsAsync(bootstrap, deployment, database, stop.Token).ConfigureAwait(false);

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
        Forwarding.MeshSettings mesh;
        try
        {
            mesh = Forwarding.MeshSettings.Load(bootstrap.AdvertiseAddress, deployment.RequireMeshEndpoint(), bootstrap.MeshSecretFile);
        }
        catch (HostedBootstrapException error)
        {
            Console.Error.WriteLine("Error: " + error.Message);
            return HostedExit.Configuration;
        }
        var replica = new Runtimes.TenantReplica(
            new Runtimes.TenantReplicaOptions(
                bootstrap.ReplicaName ?? Environment.MachineName,
                bootstrap.AdvertiseAddress,
                deployment.HealthEndpoint,
                deployment.PublicEndpoint,
                deployment.TenantOrigin,
                LeaseTimings.Default,
                DrainBound: TimeSpan.FromSeconds(8),
                AgentCatalog.ReaderVersion
            )
            {
                Role = bootstrap.Role,
                ScratchRoot = bootstrap.RequireScratchRoot(),
                MountedOperatorPath = deployment.MountedOperatorPath(),
                OperatorHostname = deployment.Root.ContainsKey("operator") ? Operator.OperatorListener.ReadSettings(deployment).Host : null,
                Mesh = mesh,
            },
            database,
            bootstrap.RequireDatabaseUrl(),
            (context, token) => CreateTenantRuntimeAsync(context, bootstrap, deployment, token),
            line => Console.Error.WriteLine(line),
            exit: Environment.Exit,
            operatorDocumentsChanged: runtime => ((MainHostRuntime)runtime).OperatorDocumentsChanged()
        );
        var code = await replica.RunAsync(stop).ConfigureAwait(false);
        Console.Error.WriteLine($"[hosted] Replica {replica.Replica} exits with code {code}.");
        if (code == HostedExit.Fenced)
            Environment.Exit(code);
        return code;
    }

    /// <summary>
    /// One tenant's runtime on a multi-tenant replica: the deployment configuration expanded for
    /// the tenant (its <c>url</c>), its own scratch directory under the replica's, named by the
    /// numeric tenant ID (<c>t/&lt;id&gt;</c>), its blobs, the profile its grant
    /// checked, and no listener of its own.
    /// </summary>
    internal static async Task<IHostedRuntime> CreateTenantRuntimeAsync(
        Runtimes.TenantRuntimeContext context,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        CancellationToken token = default
    )
    {
        var grant = context.Activation.Grant;
        var slug = context.Activation.Generation.Tenant;
        var directory = grant.TenantId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tenant = bootstrap with
        {
            Tenant = slug,
            ScratchRoot = Path.Combine(bootstrap.RequireScratchRoot(), "t", directory),
        };
        var configuration = deployment.ForTenant(slug);
        var storage = new PostgresStorageContext(context.Database, tenant.RequireScratchRoot());
        await OpenTenantStorageAsync(storage, configuration, slug, token).ConfigureAwait(false);
        return await BuildRuntimeAsync(storage, storage, tenant, configuration, token, context.Server, grant.Profile,
            new(Foxwarm.Timers.TimerOccurrence.FromJson(context.Activation.Wakeup?.Occurrence), context.Activation.Gate))
            .ConfigureAwait(false);
    }

    // The tenant context's setup before the host exists. A failure releases the context; a
    // release that fails too is reported with both, so the owner treats the stop as unconfirmed.
    private static async Task OpenTenantStorageAsync(
        PostgresStorageContext storage,
        DeploymentConfiguration deployment,
        string tenant,
        CancellationToken token
    ) =>
        await SetUpOrReleaseAsync(
                async () =>
                {
                    if (storage.Missing.Count > 0)
                        throw new HostedStartupException(
                            "This build has no PostgreSQL implementation of the "
                                + string.Join(", ", storage.Missing)
                                + " stores; hosted mode can't start."
                        );
                    await storage.OpenBlobsAsync(deployment.Blobs, tenant, token).ConfigureAwait(false);
                },
                storage.DisposeAsync
            )
            .ConfigureAwait(false);

    /// <summary>
    /// Runs <paramref name="setup"/>; when it fails, runs <paramref name="release"/> and rethrows.
    /// A release that fails too is reported with both (<see cref="StartupCleanupFailedException"/>).
    /// </summary>
    internal static async Task SetUpOrReleaseAsync(Func<Task> setup, Func<ValueTask> release)
    {
        try
        {
            await setup().ConfigureAwait(false);
        }
        catch (Exception error)
        {
            try
            {
                await release().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                throw new StartupCleanupFailedException(error, [cleanup]);
            }
            throw;
        }
    }

    internal static readonly TimeSpan HttpShutdownTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// <see cref="MainHost"/> over the tenant: the key ring is opened first (a locked tenant
    /// refuses), then the configuration owner reads the tenant documents with the deployment
    /// configuration, and the host serves behind its tenant server. Production passes the
    /// complete context as <paramref name="storage"/>; tests may compose it.
    /// </summary>
    internal static async Task<IHostedRuntime> BuildRuntimeAsync(
        PostgresStorageContext tenant,
        IStorageContext storage,
        HostedBootstrap bootstrap,
        DeploymentConfiguration deployment,
        CancellationToken token = default,
        Runtimes.TenantServer? server = null,
        TenantProfile profile = TenantProfile.Hosted,
        Foxwarm.Timers.RuntimeSchedule? schedule = null
    )
    {
        // The runtime owns the tenant context from here; a build that fails releases it. A
        // release that fails too is reported, so the owner treats the stop as unconfirmed.
        try
        {
            return await BuildRuntimeCoreAsync(tenant, storage, bootstrap, deployment, server, profile, schedule, token)
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
        Runtimes.TenantServer? server,
        TenantProfile profile,
        Foxwarm.Timers.RuntimeSchedule? schedule,
        CancellationToken token
    )
    {
        ModelConfiguration configuration;
        HostPaths paths;
        JournalRetentionOptions retention;
        // Profile comes from the grant's locked placement check; the tenant row supplies limits.
        Foxwarm.Limits.TenantLimits limits;
        TenantSettings settings;
        try
        {
            retention = JournalRetentionOptions.FromDeployment(deployment.Root["journal"]);
            // The tenant's limits and settings (journal switch, retention) from its row.
            (limits, settings) = await TenantPolicy.ReadAsync(tenant.Database, token).ConfigureAwait(false);
            tenant.ApplyJournalSettings(settings);
            tenant.AgentStoreLimits = () => limits.AgentStore;
            var (current, previous) = bootstrap.RequireKeks();
            var keys = new HostedKeyRing(tenant.Database, current, previous);
            keys.OpenOrCreate();
            tenant.KeyRing = keys;
            // A general runtime reads the Agent store. The operator opens its physical Agent
            // directories on the persistent volume, under its immutable database identity.
            var scratch = bootstrap.RequireScratchRoot();
            paths = HostPaths.ForDataRoot(scratch) with
            {
                AgentsRoot = profile == TenantProfile.Operator
                    ? bootstrap.OperatorAgentsRoot(tenant.Database.TenantId)
                    : Path.Combine(scratch, "agents"),
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
            ShutdownTimeout = HttpShutdownTimeout,
            // A tenant of a multi-tenant replica: requests come from the replica's front, and
            // the tenant can't stop the replica's process.
            Server = server,
            ReservedOperatorHost = deployment.Root.ContainsKey("operator") ? Operator.OperatorListener.ReadSettings(deployment).Host : null,
            ShutdownAvailable = server is null,
        };
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
                // Both profiles take the tenant's limits from its row.
                capabilities: RuntimeCapabilities.For(profile, deployment.Egress) with { Limits = limits },
                jsonStdoutLog: true,
                logTenant: bootstrap.Tenant,
                schedule: schedule,
                openProviders: diagnostic => new Providers.ProviderGrants(deployment, diagnostic)
                    .LoadAsync(tenant.Database, bootstrap.Tenant, profile, token)
            )
            .ConfigureAwait(false);
        if (server is not null)
            server.Log = host.Log;
        // The owner's daily journal retention; it stops when the host disposes the journal.
        tenant.StartJournalRetention(settings.Retention(retention));
        return new MainHostRuntime(host, tenant);
    }
}

/// <summary><see cref="MainHost"/> as the runtime of an owner replica, with the tenant context it owns.</summary>
internal sealed class MainHostRuntime(MainHost host, PostgresStorageContext tenant) : IHostedRuntime
{
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal MainHost Host => host;

    public void CredentialRotated()
    {
        if (tenant.Credentials is PgInstanceCredentials credentials)
            credentials.RevokeStreams();
    }

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
