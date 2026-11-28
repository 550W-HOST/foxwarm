using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Import;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>The import's blob phase on the S3 backend, with the tenant's rows on PostgreSQL.</summary>
[Trait("Backend", "postgres")]
[Trait("Backend", "s3")]
public sealed class HostedImportS3Tests : IAsyncLifetime
{
    private readonly TempDirectory temp = new();
    private ImportFixture.Built fixture = null!;

    public async Task InitializeAsync() => fixture = await ImportFixture.BuildAsync(Path.Combine(temp.Path, "fixture"));

    public Task DisposeAsync()
    {
        temp.Dispose();
        return Task.CompletedTask;
    }

    private async Task<S3BlobSettings> SettingsAsync(S3TestBucket bucket)
    {
        var server = await S3Server.SharedAsync();
        var settings = bucket.Settings with { AccessKeyIdFile = Path.Combine(temp.Path, "id"), SecretAccessKeyFile = Path.Combine(temp.Path, "secret") };
        await File.WriteAllTextAsync(settings.AccessKeyIdFile, server.AccessKey);
        await File.WriteAllTextAsync(settings.SecretAccessKeyFile, server.SecretKey);
        return settings;
    }

    private static async Task<long> WaitForImportLeaseAsync(HostedTestDatabase db, int id, CancellationToken token)
    {
        while (true)
        {
            if (await db.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id=$1 AND state='active' AND owner_replica LIKE 'import:%'", id) is long epoch)
                return epoch;
            await Task.Delay(50, token);
        }
    }

    [Fact]
    public async Task Full_import_charges_historical_S3_bytes_to_the_targets_configured_retained_limit()
    {
        var postgres = await PostgresServer.SharedAsync();
        await using var db = await postgres.CreateDatabaseAsync();
        var id = await db.TenantIdAsync();
        var identity = (string)(await db.ScalarAsync("SELECT coalesce(object_identity,name) FROM tenants WHERE tenant_id=$1", id))!;
        var size = PgAgentFileStore.InlineBytes + 1;
        await db.ExecuteOwnerAsync("UPDATE tenants SET limits=jsonb_build_object('agentStoreBytes'," + size + ")");
        await using var bucket = await S3TestBucket.CreateAsync();
        var settings = await SettingsAsync(bucket);
        await bucket.Store("agent-files", true, tenant: identity).CreateAsync("old/body", new byte[2 * size], false, default);
        var agents = Directory.CreateDirectory(Path.Combine(temp.Path, "agents")).FullName;
        await File.WriteAllBytesAsync(Path.Combine(agents, "file"), new byte[size]);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var report = Path.Combine(temp.Path, "report.json");
        var options = new HostedImportOptions(fixture.DataRoot, PostgresServer.Tenant, false, false, report)
            { Blobs = new(BlobBackend.S3, settings), AgentsDirectory = agents };
        var import = HostedImport.RunAsync(options, new(db.OpenApp(), db.OpenOwner(), HostedTestBackend.Kek), new StringWriter(), timeout.Token);
        // Run the inventory pass only. A subsequent collection pass would free the old
        // object, so this exercises physical admission while the logical file itself fits.
        var epoch = await WaitForImportLeaseAsync(db, id, timeout.Token);
        var op = db.OpenApp(db.OperatorConnectionString);
        await new AgentBlobMaintenance(op, settings).AdvanceAsync(new TenantDb(op, id, epoch), identity, timeout.Token);
        Assert.Equal(HostedImport.Failed, await import);
        Assert.Contains("Agent file storage is full", await File.ReadAllTextAsync(report));
        Assert.Equal((decimal)(2 * size), await db.ScalarAsync("SELECT sum(byte_length) FROM agent_blob_reservations"));
        Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM agent_files WHERE kind='file'"));
    }

    [Fact]
    public async Task Fresh_full_import_waits_for_the_operator_inventory_before_writing_tenant_data()
    {
        var postgres = await PostgresServer.SharedAsync();
        await using var db = await postgres.CreateDatabaseAsync();
        await using var bucket = await S3TestBucket.CreateAsync();
        var settings = await SettingsAsync(bucket);
        var agent = Directory.CreateDirectory(Path.Combine(fixture.DataRoot, "agents", "inventory")).FullName;
        var size = PgAgentFileStore.InlineBytes + 1;
        await File.WriteAllBytesAsync(Path.Combine(agent, "large"), new byte[size]);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var report = Path.Combine(temp.Path, "report.json");
        var options = new HostedImportOptions(fixture.DataRoot, "fresh", false, false, report)
        {
            Blobs = new(BlobBackend.S3, settings),
            BeforePhase = async name =>
            {
                if (name != "keys") return;
                Assert.True(await db.ScalarAsync("SELECT blob_inventory IS NOT NULL FROM agent_file_usage WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='fresh')") is true,
                    "The import started the " + name + " phase before inventory completed.");
            }
        };
        using var stop = new CancellationTokenSource();
        var op = new OperatorStore(db.OpenApp(db.OperatorConnectionString), HostedTestBackend.Kek, settings);
        var loop = op.RunDeletionLoopAsync(stop.Token);
        try
        {
            var result = await HostedImport.RunAsync(options, new(db.OpenApp(), db.OpenOwner(), HostedTestBackend.Kek), new StringWriter(), timeout.Token);
            Assert.True(result == HostedImport.Imported, await File.ReadAllTextAsync(report));
            Assert.Equal((decimal)size, await db.ScalarAsync("SELECT byte_length FROM agent_blob_reservations WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='fresh')"));
        }
        finally { stop.Cancel(); await loop; }
    }

    [Fact]
    public async Task Interrupted_full_import_with_only_an_S3_inventory_retries_on_the_same_destination()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await using var bucket = await S3TestBucket.CreateAsync();
        var settings = await SettingsAsync(bucket);
        var agents = Directory.CreateDirectory(Path.Combine(temp.Path, "agent-source")).FullName;
        await File.WriteAllBytesAsync(Path.Combine(agents, "file"), new byte[PgAgentFileStore.InlineBytes + 1]);
        using var stop = new CancellationTokenSource();
        var op = new OperatorStore(db.OpenApp(db.OperatorConnectionString), HostedTestBackend.Kek, settings);
        var worker = op.RunDeletionLoopAsync(stop.Token);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var options = new HostedImportOptions(fixture.DataRoot, "retry", false, false, Path.Combine(temp.Path, "first.json"))
            { Blobs = new(BlobBackend.S3, settings), AgentsDirectory = agents };
        async Task<int> Attempt(HostedImportOptions o) => await HostedImport.RunAsync(o,
            new(db.OpenApp(), db.OpenOwner(), HostedTestBackend.Kek), new StringWriter(), deadline.Token);
        try
        {
            Assert.Equal(HostedImport.Failed, await Attempt(options with { BeforePhase = _ => throw new IOException("Interrupted before key adoption.") }));
            Assert.True(await db.ScalarAsync("SELECT blob_inventory IS NOT NULL AND bytes=0 AND entries=0 AND generation=0 FROM agent_file_usage") is true);
            Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM tenant_keys"));
            Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM agent_files"));
            Assert.Equal(HostedImport.Imported, await Attempt(options with { ReportPath = Path.Combine(temp.Path, "retry.json") }));
        }
        finally { stop.Cancel(); await worker; }
    }

    [Fact]
    public async Task A_fenced_import_waiting_for_inventory_leaves_no_payload_rows()
    {
        var postgres = await PostgresServer.SharedAsync();
        await using var db = await postgres.CreateDatabaseAsync();
        await using var bucket = await S3TestBucket.CreateAsync();
        var settings = await SettingsAsync(bucket);
        var agents = Directory.CreateDirectory(Path.Combine(temp.Path, "agents")).FullName;
        await File.WriteAllBytesAsync(Path.Combine(agents, "file"), new byte[PgAgentFileStore.InlineBytes + 1]);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var id = await db.TenantIdAsync();
        var options = new HostedImportOptions(fixture.DataRoot, PostgresServer.Tenant, false, false, Path.Combine(temp.Path, "report.json"))
            { Blobs = new(BlobBackend.S3, settings), AgentsDirectory = agents };
        var import = HostedImport.RunAsync(options, new(db.OpenApp(), db.OpenOwner(), HostedTestBackend.Kek), new StringWriter(), timeout.Token);
        await WaitForImportLeaseAsync(db, id, timeout.Token);
        // No operator has committed an inventory. Take over the lease before allowing
        // any import phase to run, as during an interrupted import.
        await db.TakeLeaseAsync(id);
        Assert.Equal(HostedImport.Fenced, await import);
        foreach (var table in new[] { "tenant_keys", "agent_files", "agent_blob_reservations" })
            Assert.Equal(0L, await db.ScalarAsync($"SELECT count(*) FROM {table}"));
    }

    [Fact]
    public async Task Blobs_import_to_the_deployments_S3_bucket_hash_verified_and_the_draft_names_it()
    {
        var postgres = await PostgresServer.SharedAsync();
        await using var database = await postgres.CreateDatabaseAsync();
        await using var bucket = await S3TestBucket.CreateAsync();
        var settings = new BlobSettings(BlobBackend.S3, await SettingsAsync(bucket));

        using var material = new TempDirectory();
        await using var op = new Foxwarm.Hosted.Postgres.PgDatabase(database.OperatorConnectionString,"operator-test");
        var key=Foxwarm.Hosted.Postgres.KeyEncryptionKey.From(Foxwarm.Secrets.InstanceKeys.OpenOrCreate(Path.Combine(material.Path,"kek")));
        await new Foxwarm.Hosted.Operator.OperatorStore(op,key).CreateAsync("provisioned","hosted","provisioned.test",default);
        const string slug="provisioned";
        var id=await database.TenantIdAsync(slug);
        var epoch=await database.TakeLeaseAsync(id);
        var storageId=Assert.IsType<string>(await database.ScalarAsync("SELECT object_identity FROM tenants WHERE tenant_id=$1",id));
        await using var storage=new Foxwarm.Hosted.PostgresStorageContext(new Foxwarm.Hosted.Postgres.TenantDb(database.OpenApp(),id,epoch),temp.Path);
        await storage.OpenBlobsAsync(settings,slug,default);
        await storage.ArtifactBlobs.CreateAsync("test",new byte[]{1},false,default);
        Assert.Contains($"t/{storageId}/artifacts/test",await bucket.KeysAsync());

        var result = await HostedImportTests.RunAsync(
            database,
            fixture.DataRoot,
            "s3tenant",
            Directory.CreateDirectory(Path.Combine(temp.Path, "reports")).FullName,
            options => options with { Blobs = settings }
        );

        Assert.True(result.Exit == 0, result.Report.ToJsonString());
        Assert.Equal(2, result.Report["verification"]!["blobs"]!["sameHash"]!.GetValue<long>());
        var keys = await bucket.KeysAsync();
        var identity = Assert.IsType<string>(await database.ScalarAsync("SELECT object_identity FROM tenants WHERE name='s3tenant'"));
        Assert.Contains($"t/{identity}/images/{fixture.ImageKey}", keys);
        Assert.Contains($"t/{identity}/artifacts/{fixture.ArtifactKey}", keys);
        Assert.Equal(0, (await HostedImportTests.RowCountsAsync(database, "s3tenant"))["blob_objects"]);
        var draft = await File.ReadAllTextAsync(result.Report["configuration"]!["deploymentDraft"]!.ToString());
        Assert.Contains("  backend: s3", draft);
        Assert.Contains($"    bucket: \"{bucket.Name}\"", draft);
        // The draft's blobs block is what a replica's deployment configuration accepts.
        var parsed = Foxwarm.ConfigurationYaml.Parse(draft, "draft");
        Assert.Equal(settings, BlobSettings.Parse(parsed["blobs"]));
    }
}
