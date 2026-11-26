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
            var files = new HostedFiles(
                Path.Combine(root, "scratch"),
                Path.Combine(root, "agents"),
                Path.Combine(root, "kek", "current.key")
            );
            InstanceKeys.OpenOrCreate(files.Kek);
            return files;
        }

        internal HostedBootstrap Bootstrap =>
            new(null, null, PostgresServer.Tenant, PostgresServer.AppRole, ScratchRoot: Scratch, KekFile: Kek, AgentsRoot: Agents);
    }

    private static Replica StartHosted(
        PgDatabase database,
        HostedFiles files,
        Action<IStorageContext>? built = null,
        string? fileStores = null
    )
    {
        Replica? replica = null;
        replica = Start(
            files.Scratch,
            database,
            "hosted",
            async (context, token) =>
            {
                while (replica is null)
                    await Task.Delay(10, token);
                var deployment = DeploymentConfiguration.Parse(
                    $"bot: {{httpHost: 127.0.0.1, httpPort: {replica.PublicPort}}}\nhealth: {{port: 3081}}\nblobs: {{backend: postgres}}\n"
                );
                var tenant = new PostgresStorageContext(context.Database, files.Scratch);
                var storage = HostedTestBackend.Compose(tenant, fileStores ?? files.Scratch);
                built?.Invoke(storage);
                var runtime = await HostedEntry.BuildRuntimeAsync(tenant, storage, files.Bootstrap, deployment);
                replica.Runtimes.Add(runtime);
                return runtime;
            }
        );
        return replica;
    }

    [Fact]
    public async Task AFirstHostedStartRunsSetupOverTenantDocumentsOnTheDeploymentListener()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        IStorageContext? storage = null;
        var replica = StartHosted(database.OpenApp(), files, built => storage = built);
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the hosted runtime serves"
        );
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        // The HTTP token is an instance credential of the tenant, encrypted under its data key.
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
        var replica = StartHosted(database.OpenApp(), files);
        Assert.Equal(HostedExit.Configuration, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM tenant_keys"));
        Assert.Equal("released", await database.ScalarAsync("SELECT state FROM tenant_leases"));
    }
}
