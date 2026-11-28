using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

internal sealed class AgentBlobS3Fixture : IAsyncDisposable
{
    internal required HostedTestDatabase Database;
    internal required string Bucket;
    internal required PgAgentFileStore Store;
    internal required TenantDb Runtime, Operator;
    internal required AgentBlobMaintenance Maintenance;
    internal required TempDirectory Root;
    internal required AmazonS3Client Client;
    internal const string Identity = "test-storage";
    internal const string Prefix = "t/test-storage/agent-files/";
    internal Task InventoryAsync() => Maintenance.AdvanceAsync(Operator, Identity, default);

    internal static async Task<AgentBlobS3Fixture> OpenAsync(AgentStoreLimits? limits = null, bool conditional = true)
    {
        var (db, runtime) = await PostgresAgentFilesTests.OpenAsync();
        var server = await S3Server.SharedAsync(enableVersioning: true);
        var bucket = S3Server.NewBucketName();
        var root = new TempDirectory();
        var settings = new S3BlobSettings(server.Endpoint, S3Server.Region, bucket, true, Path.Combine(root.Path, "id"), Path.Combine(root.Path, "secret"));
        File.WriteAllText(settings.AccessKeyIdFile, server.AccessKey);
        File.WriteAllText(settings.SecretAccessKeyFile, server.SecretKey);
        var client = S3Blobs.Client(settings, server.AccessKey, server.SecretKey, singleAttempt: true);
        await client.PutBucketAsync(new PutBucketRequest { BucketName = bucket });
        var remote = new S3BlobStore(client, bucket, Identity, PgAgentFileStore.BlobStoreName, conditional);
        var op = db.OpenApp(db.OperatorConnectionString);
        return new() { Database = db, Bucket = bucket, Root = root, Client = client,
            Runtime = runtime, Operator = new(op, runtime.TenantId, runtime.Epoch),
            Store = new(runtime, remote, () => limits ?? AgentStoreLimits.Default), Maintenance = new(op, settings) };
    }

    public async ValueTask DisposeAsync()
    {
        // Remove all versions in a versioned test, including markers.
        var mode = (await Client.GetBucketVersioningAsync(new GetBucketVersioningRequest { BucketName = Bucket })).VersioningConfig?.Status;
        if (mode == VersionStatus.Enabled || mode == VersionStatus.Suspended)
        {
            var versions = await Client.ListVersionsAsync(new ListVersionsRequest { BucketName = Bucket });
            foreach (var v in versions.Versions ?? []) await Client.DeleteObjectAsync(Bucket, v.Key, v.VersionId);
        }
        else foreach (var obj in (await Client.ListObjectsV2Async(new ListObjectsV2Request { BucketName = Bucket })).S3Objects ?? [])
            await Client.DeleteObjectAsync(Bucket, obj.Key);
        await Client.DeleteBucketAsync(Bucket);
        Client.Dispose();
        await Database.DisposeAsync();
        Root.Dispose();
    }
}

[Trait("Backend", "s3")]
[Trait("Backend", "postgres")]
public sealed class AgentBlobS3Tests
{
    [Fact]
    public async Task Inventory_charges_every_historical_version_before_distinct_admissions()
    {
        var content = new byte[PgAgentFileStore.InlineBytes + 1];
        await using var f = await AgentBlobS3Fixture.OpenAsync(new(content.Length, 10, content.Length));
        await f.Client.PutBucketVersioningAsync(new PutBucketVersioningRequest { BucketName = f.Bucket, VersioningConfig = new() { Status = VersionStatus.Enabled } });
        var key = AgentBlobS3Fixture.Prefix + "old/body";
        for (var i = 0; i < 2; ++i)
        {
            using var body = new MemoryStream(content);
            await f.Client.PutObjectAsync(new PutObjectRequest { BucketName = f.Bucket, Key = key, InputStream = body });
        }
        await f.Client.DeleteObjectAsync(f.Bucket, key);
        Assert.Contains("inventory", (await Assert.ThrowsAsync<IOException>(() => f.Store.WriteAsync(null, "file", content, null, default))).Message);
        await f.InventoryAsync();
        Assert.Equal(2m * content.Length, await f.Database.ScalarAsync("SELECT sum(byte_length) FROM agent_blob_reservations"));
        Assert.Equal("retainedBytes", (await Assert.ThrowsAsync<AgentStoreQuotaException>(() => f.Store.WriteAsync(null, "file", content, null, default))).Limit);
        Assert.Empty((await f.Client.ListObjectsV2Async(new ListObjectsV2Request { BucketName = f.Bucket })).S3Objects ?? []);
        await f.Database.TakeLeaseAsync(f.Runtime.TenantId);
        await Assert.ThrowsAsync<TenantFencedException>(() => f.InventoryAsync());
    }
}
