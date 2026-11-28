using Foxwarm.Hosted.Runtimes;
using Foxwarm.Hosted.Lease;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

// The hosted runtime over the tenant's configuration documents, key ring and deployment
// configuration (HostedEntry.BuildRuntimeAsync), with the stores the build lacks still composed
// from files as in the other startup tests.
public sealed partial class HostedStartupTests
{
    private const string LocalModels =
        "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n";

    private sealed record HostedFiles(string Scratch, string Agents, string Kek)
    {
        internal static HostedFiles Create(string root)
        {
            // Agents: where the host's Agents root is, inside the scratch directory; nothing
            // may create it, since the Agents' files are in the Agent store.
            var files = new HostedFiles(
                Path.Combine(root, "scratch"),
                Path.Combine(root, "scratch", "agents"),
                Path.Combine(root, "kek", "current.key")
            );
            InstanceKeys.OpenOrCreate(files.Kek);
            return files;
        }

        internal HostedBootstrap Bootstrap =>
            new(null, null, PostgresServer.Tenant, PostgresServer.AppRole, ScratchRoot: Scratch, KekFile: Kek);
    }

    private static async Task<Replica> StartHostedAsync(
        HostedTestDatabase database,
        HostedFiles files,
        Action<IStorageContext>? built = null,
        string? fileStores = null,
        string deploymentExtra = "",
        string role = ReplicaRoles.General
    )
    {
        const string slug = PostgresServer.Tenant;
        await database.ExecuteOwnerAsync($"INSERT INTO tenant_hostnames(tenant_id,hostname,kind) SELECT tenant_id,'{slug}.test','primary' FROM tenants WHERE name='{slug}' ON CONFLICT DO NOTHING");
        var local = new IPEndPoint(IPAddress.Loopback, 0);
        var deployment = DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n" + deploymentExtra);
        var runtimes = new List<IHostedRuntime>();
        var replica = new TenantReplica(
            new TenantReplicaOptions("hosted", null, local, local, _ => $"http://{slug}.test", LeaseTimings.Default,
                TimeSpan.FromSeconds(8), Foxwarm.Sessions.AgentCatalog.ReaderVersion)
            {
                Role = role,
                Mesh = new(local, "127.0.0.1", System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)),
            }, database.OpenApp(), database.AppConnectionString,
            async (context, token) =>
            {
                var tenant = new PostgresStorageContext(context.Database, files.Scratch);
                var storage = HostedTestBackend.Compose(tenant, fileStores ?? files.Scratch);
                built?.Invoke(storage);
                var runtime = await HostedEntry.BuildRuntimeAsync(tenant, storage, files.Bootstrap with
                {
                    Role = role,
                    AgentsVolume = role == ReplicaRoles.MasterHost ? Directory.CreateDirectory(files.Agents).FullName : null,
                }, deployment.ForTenant(slug), token, context.Server, context.Activation.Grant.Profile);
                runtimes.Add(runtime);
                return runtime;
            }, _ => { }, code => throw new InvalidOperationException($"Unexpected escalation {code}"),
            operatorDocumentsChanged: runtime => ((MainHostRuntime)runtime).OperatorDocumentsChanged());
        var stop = new CancellationTokenSource();
        var run = replica.RunAsync(stop.Token);
        await replica.Serving.WaitAsync(TimeSpan.FromSeconds(30));
        return new(replica, run, stop, replica.Activations!.ActivateAsync(slug), runtimes);
    }

    [Fact]
    public async Task AFirstHostedStartRunsSetupOverTenantDocumentsOnTheDeploymentListener()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        IStorageContext? storage = null;
        var replica = await StartHostedAsync(database, files, built => storage = built);
        await replica.Activation.WaitAsync(TimeSpan.FromSeconds(60));
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        // The HTTP token is an instance credential of the tenant, encrypted under its data key.
        client.DefaultRequestHeaders.Host = PostgresServer.Tenant + ".test";
        client.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            storage!.Credentials.Read(InstanceCredentialName.HttpToken)
        );
        var status = await client.GetFromJsonAsync<JsonNode>("api/setup/status");
        Assert.True(status!["oobe"]!.GetValue<bool>());
        var saved = await client.PostAsJsonAsync("api/setup/models", new { yaml = LocalModels });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
        status = await client.GetFromJsonAsync<JsonNode>("api/setup/status");
        Assert.False(status!["oobe"]!.GetValue<bool>());
        Assert.Equal(
            "config_documents/models",
            status["models"]!["path"]!.GetValue<string>()
        );
        Assert.Equal(
            LocalModels,
            await database.ScalarAsync("SELECT text FROM config_documents WHERE name = 'models'")
        );
        // The first run seeded the tenant's app document; nothing is a file on the replica.
        Assert.NotNull(await database.ScalarAsync("SELECT text FROM config_documents WHERE name = 'config'"));
        Assert.False(File.Exists(Path.Combine(files.Scratch, "state", "models.yaml")));
        Assert.False(File.Exists(Path.Combine(files.Scratch, "state", "config.yaml")));
        Assert.False(File.Exists(Path.Combine(files.Scratch, "state", "token")));
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM tenant_keys"));

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }

    [Fact]
    public async Task AnIncompleteRequestAtTheFrontDoesNotDelayTenantHandBack()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var replica = await StartHostedAsync(database, HostedFiles.Create(temp.Path));
        await replica.Activation.WaitAsync(TimeSpan.FromSeconds(60));
        // A client that sent part of a request and stalls: the host counts it as in progress.
        using var stalled = new System.Net.Sockets.TcpClient();
        await stalled.ConnectAsync(IPAddress.Loopback, replica.PublicPort);
        await stalled.GetStream().WriteAsync(System.Text.Encoding.ASCII.GetBytes("GET /api/sessions HTTP/1.1\r\nHost: x\r\n"));
        await Task.Delay(300);

        replica.Stop.Cancel();
        // The front can still be finishing connections while the tenant's lease is free.
        // Incomplete headers were never admitted and must not hold up a successor.
        await WaitUntilAsync(() => database.ScalarAsync("SELECT state FROM tenant_leases").GetAwaiter().GetResult() as string == "released",
            TimeSpan.FromSeconds(6), "the tenant hands back while the front still has the stalled connection");
        stalled.Dispose();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task ALockedTenantRefusesStartupWithoutGeneratingAKey()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        // Encrypted data without a data key, as after losing the tenant_keys row.
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId, "seed");
        new PgStateDocuments(new TenantDb(database.OpenApp(), tenantId, epoch))
            .Open(StateDocumentName.Secrets)
            .ReplaceText("{\"version\":1}");
        await database.ScalarAsync(
            "UPDATE tenant_leases SET state = 'released', expires_at = now() RETURNING 1"
        );
        var replica = await StartHostedAsync(database, files);
        await Assert.ThrowsAsync<HostedStartupException>(() => replica.Activation);
        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM tenant_keys"));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
    }
}
