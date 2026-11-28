using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Import;
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

    [Fact]
    public async Task Blobs_import_to_the_deployments_S3_bucket_hash_verified_and_the_draft_names_it()
    {
        var postgres = await PostgresServer.SharedAsync();
        await using var database = await postgres.CreateDatabaseAsync();
        await using var bucket = await S3TestBucket.CreateAsync();
        var server = await S3Server.SharedAsync();
        var keyFile = Path.Combine(temp.Path, "s3-access-key-id");
        var secretFile = Path.Combine(temp.Path, "s3-secret-access-key");
        await File.WriteAllTextAsync(keyFile, server.AccessKey + "\n");
        await File.WriteAllTextAsync(secretFile, server.SecretKey + "\n");
        var settings = new BlobSettings(BlobBackend.S3, bucket.Settings with { AccessKeyIdFile = keyFile, SecretAccessKeyFile = secretFile });

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
