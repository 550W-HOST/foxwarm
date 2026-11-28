using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// The production builder of a multi-tenant replica's tenant runtimes (HostedEntry), as the
// replica calls it with an activation's grant.
[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed partial class TenantRuntimeConstructionTests
{
    private sealed class Harness : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();

        internal required HostedTestDatabase Database { get; init; }
        internal required PgDatabase App { get; init; }
        internal string Kek => Path.Combine(temp.Path, "kek", "current.key");
        internal string Scratch => Path.Combine(temp.Path, "scratch");

        internal HostedBootstrap Bootstrap =>
            new(null, null, "unused", PostgresServer.AppRole, ScratchRoot: Scratch, KekFile: Kek);

        internal async Task<(int Id, long Epoch)> AddTenantAsync(string slug)
        {
            await Database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{slug}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{slug}'"
            );
            var id = await Database.TenantIdAsync(slug);
            return (id, await Database.TakeLeaseAsync(id, "replica-a/0001", TimeSpan.FromHours(1)));
        }

        internal Task<IHostedRuntime> BuildAsync(
            string slug,
            (int Id, long Epoch) lease,
            DeploymentConfiguration deployment,
            TenantProfile profile = TenantProfile.Hosted,
            TenantServer? server = null
        )
        {
            var grant = new LeaseGrant(lease.Id, slug, "replica-a/0001", lease.Epoch) { Profile = profile };
            var activation = new ActivationContext(
                new GenerationId(lease.Id, slug, lease.Epoch, 1),
                grant,
                new AdmissionGate(),
                null,
                new GenerationFence()
            );
            server ??= new TenantServer(deployment.TenantOrigin(slug));
            return HostedEntry.CreateTenantRuntimeAsync(
                new TenantRuntimeContext(activation, new TenantDb(App, lease.Id, lease.Epoch), server),
                profile == TenantProfile.Operator
                    ? Bootstrap with { Role = ReplicaRoles.MasterHost, AgentsVolume = Directory.CreateDirectory(Path.Combine(temp.Path, "operator-agents")).FullName }
                    : Bootstrap,
                deployment
            );
        }

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            await Database.DisposeAsync();
            temp.Dispose();
        }
    }

    private static async Task<Harness> CreateAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var harness = new Harness { Database = database, App = database.OpenApp() };
        Foxwarm.Secrets.InstanceKeys.OpenOrCreate(harness.Kek);
        return harness;
    }

    private static DeploymentConfiguration Deployment(string? url) =>
        DeploymentConfiguration.Parse(
            (url is null ? "" : $"url: {url}\n")
                + "bot: {httpHost: 127.0.0.1, httpPort: 3001}\nhealth: {port: 3081}\nblobs: {backend: postgres}\n"
        );

    // Review 4b #7: one expanded configuration per tenant, read by the runtime's own consumers.
    [Fact]
    public async Task EachTenantRuntimeReadsItsOwnExpandedPublicUrl()
    {
        await using var harness = await CreateAsync();
        var deployment = Deployment("https://{slug}.tenants.example.com/app");
        foreach (var slug in new[] { "alpha", "beta" })
        {
            var runtime = await harness.BuildAsync(slug, await harness.AddTenantAsync(slug), deployment);
            await using (runtime)
            {
                var configured = ((MainHostRuntime)runtime).Host.Sessions.Models.ConfigurationOwner!.AppConfiguration["url"];
                Assert.Equal($"https://{slug}.tenants.example.com/app", SessionWait.Text(configured));
                Assert.Equal($"https://{slug}.tenants.example.com/app", deployment.TenantOrigin(slug));
            }
        }
    }

    [Fact]
    public async Task TheRuntimeUsesTheTenantsAgentFileLimits()
    {
        await using var harness = await CreateAsync();
        var lease = await harness.AddTenantAsync("alpha");
        await harness.Database.ExecuteOwnerAsync("UPDATE tenants SET limits='{\"agentStoreBytes\":8000000,\"agentStoreFiles\":200,\"agentFileBytes\":300000,\"uploadBytes\":400000}' WHERE name='alpha'");
        await using var runtime = await harness.BuildAsync("alpha", lease, Deployment(null));
        var sessions = ((MainHostRuntime)runtime).Host.Sessions;
        Assert.Equal(new AgentStoreLimits(8000000, 200, 300000), sessions.Storage.AgentFiles!.Limits);
        Assert.Equal(400000, sessions.Capabilities.Limits!.UploadBytes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PhysicalFileRoutesFollowTheMasterGrant(bool master)
    {
        await using var harness = await CreateAsync();
        var lease = await harness.AddTenantAsync("alpha");
        await using var runtime = await harness.BuildAsync("alpha", lease, Deployment(null),
            master ? TenantProfile.Operator : TenantProfile.Hosted);
        await runtime.StartAsync();
        var host = ((MainHostRuntime)runtime).Host;
        Assert.Equal(master, host.Sessions.Capabilities.MasterNode);
        var routes = host.App.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>().Select(endpoint => endpoint.RoutePattern.RawText).ToHashSet();
        Assert.Contains("/api/sessions", routes);
        Assert.Equal(master, routes.Contains("/api/download/sign"));
        Assert.Equal(master, routes.Contains("/download"));
    }

    // Review 4b #8: directories are named by the numeric tenant ID, never by the stored name.
    [Fact]
    public async Task ATenantsDirectoriesAreNamedByItsNumericId()
    {
        await using var harness = await CreateAsync();
        var lease = await harness.AddTenantAsync("alpha");
        await using (var runtime = await harness.BuildAsync("alpha", lease, Deployment(null)))
        {
            Assert.True(Directory.Exists(Path.Combine(harness.Scratch, "t", lease.Id.ToString())));
            Assert.False(Directory.Exists(Path.Combine(harness.Scratch, "t", "alpha")));
        }
    }

    // Review 4b #6: the grant's profile decides the runtime, not a later read of the row: the
    // stored profile here stays `hosted` while the grant says `operator`.
    [Fact]
    public async Task TheGrantsProfileDecidesTheRuntimesCapabilities()
    {
        await using var harness = await CreateAsync();
        var lease = await harness.AddTenantAsync("alpha");
        var deployment = Deployment(null);
        await using (var runtime = await harness.BuildAsync("alpha", lease, deployment, TenantProfile.Operator))
        {
            var capabilities = ((MainHostRuntime)runtime).Host.Sessions.Capabilities;
            Assert.Equal(RuntimeCapabilities.Operator with { Egress = capabilities.Egress, Providers = capabilities.Providers }, capabilities);
            Assert.Empty(capabilities.Providers!.Drivers);
            Assert.Equal(Foxwarm.Net.EgressProfile.Operator, capabilities.Egress.Profile);
        }
        Assert.Equal("hosted", await harness.Database.ScalarAsync("SELECT profile FROM tenants WHERE name = 'alpha'"));
        await using (var runtime = await harness.BuildAsync("alpha", lease, deployment, TenantProfile.Hosted))
        {
            var capabilities = ((MainHostRuntime)runtime).Host.Sessions.Capabilities;
            Assert.Equal(RuntimeCapabilities.Hosted with { Egress = capabilities.Egress, Providers = capabilities.Providers }, capabilities);
            Assert.Empty(capabilities.Providers!.Drivers);
            Assert.Equal(Foxwarm.Net.EgressProfile.Hosted, capabilities.Egress.Profile);
        }
    }
}

public sealed class HostedSetupCleanupTests
{
    // Review 4b #11: a setup failure whose cleanup fails too is reported with both.
    [Fact]
    public async Task ASetupFailureWhoseReleaseFailsReportsBoth()
    {
        var setup = new IOException("setup");
        var cleanup = new IOException("cleanup");
        var failed = await Assert.ThrowsAsync<StartupCleanupFailedException>(
            () => HostedEntry.SetUpOrReleaseAsync(() => Task.FromException(setup), () => ValueTask.FromException(cleanup))
        );
        Assert.Same(setup, failed.InnerException);
        Assert.Same(cleanup, Assert.Single(failed.Cleanup));
        var released = false;
        Assert.Same(
            setup,
            await Assert.ThrowsAsync<IOException>(
                () => HostedEntry.SetUpOrReleaseAsync(() => Task.FromException(setup), () =>
                {
                    released = true;
                    return ValueTask.CompletedTask;
                })
            )
        );
        Assert.True(released);
    }
}

public sealed class HostnameDirectoryTests
{
    [Fact]
    [Trait("Backend", "postgres")]
    public async Task RefreshPreloadsHostnamesAndDropsAMappingWhoseNotificationWasMissed()
    {
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await database.ExecuteOwnerAsync("INSERT INTO tenant_hostnames (hostname,tenant_id,kind) SELECT 'shop.test',tenant_id,'custom' FROM tenants LIMIT 1");
        var directory = new HostnameDirectory(database.OpenApp());
        await directory.RefreshAsync(default);
        Assert.True(directory.Count > 0);
        directory.AfterQuery = () => throw new InvalidOperationException("Preloaded route required a query.");
        Assert.NotNull(await directory.ResolveAsync("shop.test", default));
        directory.AfterQuery = null;
        await database.ExecuteOwnerAsync("DELETE FROM tenant_hostnames WHERE hostname='shop.test'");
        await directory.RefreshAsync(default);
        Assert.Null(await directory.ResolveAsync("shop.test", default));
    }

    // Review 4b #10: a lookup that began before an invalidation is neither cached nor returned.
    [Fact]
    [Trait("Backend", "postgres")]
    public async Task ALookupOverlappingAnInvalidationIsRepeatedAndNotCached()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync(
            "INSERT INTO tenants (name) VALUES ('old'), ('new');"
                + " INSERT INTO tenant_hostnames (hostname, tenant_id, kind) SELECT 'shop.test', tenant_id, 'custom' FROM tenants WHERE name = 'old'"
        );
        await using var app = database.OpenApp();
        var directory = new HostnameDirectory(app);
        var once = true;
        directory.AfterQuery = async () =>
        {
            if (!once)
                return;
            once = false;
            // The old mapping was read; the hostname moves and the change is signalled now.
            await database.ExecuteOwnerAsync(
                "UPDATE tenant_hostnames SET tenant_id = (SELECT tenant_id FROM tenants WHERE name = 'new') WHERE hostname = 'shop.test'"
            );
            directory.Invalidate();
        };
        Assert.Equal("new", (await directory.ResolveAsync("shop.test", CancellationToken.None))?.Slug);
        Assert.Equal("new", (await directory.ResolveAsync("SHOP.test", CancellationToken.None))?.Slug);
    }

    [Fact]
    [Trait("Backend", "postgres")]
    public async Task ExpiredEntriesAreEvictedAndUnknownHostsAreBounded()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await using var app = database.OpenApp();
        long now = 0;
        var directory = new HostnameDirectory(app, () => now);
        for (var index = 0; index < HostnameDirectory.MaxNegative + 50; index++)
            Assert.Null(await directory.ResolveAsync($"unknown-{index}.test", CancellationToken.None));
        Assert.True(directory.Count <= HostnameDirectory.MaxNegative, $"{directory.Count} entries");
        now += (long)HostnameDirectory.Lifetime.TotalMilliseconds + 1;
        Assert.Null(await directory.ResolveAsync("one-more.test", CancellationToken.None));
        Assert.True(directory.Count <= 1, $"{directory.Count} entries after expiry");
    }
}
