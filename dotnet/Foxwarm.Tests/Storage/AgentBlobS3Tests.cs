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

    internal static async Task<AgentBlobS3Fixture> OpenAsync(AgentStoreLimits? limits = null, bool conditional = true, Uri? endpoint = null, bool versioningGateway = true, bool objectLock = false)
    {
        var (db, runtime) = await PostgresAgentFilesTests.OpenAsync();
        var server = await S3Server.SharedAsync(enableVersioning: versioningGateway);
        var bucket = S3Server.NewBucketName();
        var root = new TempDirectory();
        var settings = new S3BlobSettings(endpoint ?? server.Endpoint, S3Server.Region, bucket, true, Path.Combine(root.Path, "id"), Path.Combine(root.Path, "secret"));
        File.WriteAllText(settings.AccessKeyIdFile, server.AccessKey);
        File.WriteAllText(settings.SecretAccessKeyFile, server.SecretKey);
        var client = S3Blobs.Client(settings, server.AccessKey, server.SecretKey, singleAttempt: true);
        await client.PutBucketAsync(new PutBucketRequest { BucketName = bucket, ObjectLockEnabledForBucket = objectLock ? true : null });
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
    public async Task The_new_epoch_reuses_the_charge_while_the_first_conditional_upload_is_outstanding()
    {
        var server = await S3Server.SharedAsync(enableVersioning: true);
        await using var proxy = await S3ConditionalProxy.StartAsync(server.Endpoint, S3ConditionalProxy.ConditionalMode.Delay);
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        await using var f = await AgentBlobS3Fixture.OpenAsync(endpoint: proxy.Endpoint);
        await f.Client.PutBucketVersioningAsync(new PutBucketVersioningRequest { BucketName = f.Bucket, VersioningConfig = new() { Status = VersionStatus.Enabled } });
        await f.InventoryAsync();
        var old = f.Store.WriteAsync(null, "file", bytes, null, default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Task<long> adopted;
        PgAgentFileStore next;
        var id = f.Runtime.TenantId;
        try
        {
            await proxy.PutArrived.Task.WaitAsync(timeout.Token);
            var epoch = await f.Database.TakeLeaseAsync(id);
            var database = new TenantDb(f.Database.OpenApp(), id, epoch);
            next = new(database, f.Store.Blobs);
            f.Operator = new(f.Database.OpenApp(f.Database.OperatorConnectionString), id, epoch);
            await f.InventoryAsync();
            Assert.Equal("pending", await f.Database.ScalarAsync("SELECT state FROM agent_blob_reservations"));
            adopted = next.WriteAsync(null, "file", bytes, null, default);
            while (proxy.ConditionalPuts != 2) await Task.Delay(10, timeout.Token);
            Assert.Equal("pinned", await f.Database.ScalarAsync("SELECT state FROM agent_blob_reservations"));
        }
        finally { proxy.ReleasePut.TrySetResult(); }
        await Assert.ThrowsAsync<TenantFencedException>(() => old);
        try { await adopted; }
        catch (Exception e) when (e is IOException or Amazon.Runtime.AmazonClientException)
        {
            // The gateway may cut short the request body of the losing conditional PUT.
            await next.WriteAsync(null, "file", bytes, null, default);
        }
        Assert.Equal(bytes, (await next.ReadAsync(null, "file", default)).Bytes);
        await next.DeleteAsync(null, "file", false, null, default);
        await f.InventoryAsync();
        Assert.Equal(1L, await f.Database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations WHERE state='pinned'"));
        Assert.Single((await f.Client.ListVersionsAsync(new ListVersionsRequest { BucketName = f.Bucket })).Versions);
    }

    [Fact]
    public async Task A_concurrent_publication_holds_its_reference_against_collection()
    {
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        await using var f = await AgentBlobS3Fixture.OpenAsync(versioningGateway: false);
        await f.InventoryAsync();
        await f.Store.WriteAsync(null, "old", bytes, null, default);
        await f.Store.DeleteAsync(null, "old", false, null, default);
        var publishing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        f.Store.BeforeCommit = () => { publishing.SetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException(); };
        var write = f.Store.WriteAsync(null, "new", bytes, null, default);
        Task collect;
        try
        {
            await publishing.Task.WaitAsync(TimeSpan.FromSeconds(10));
            collect = f.InventoryAsync();
        }
        finally { release.Set(); }
        await Task.WhenAll(write, collect);
        Assert.Equal(bytes, (await f.Store.ReadAsync(null, "new", default)).Bytes);
        Assert.Equal(1L, await f.Database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
    }

    [Fact]
    public async Task An_unconfirmed_delete_keeps_its_charge_and_cannot_retire_a_new_incarnation()
    {
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        await using var f = await AgentBlobS3Fixture.OpenAsync(objectLock: true);
        var logicalKey = PgAgentFileStore.BlobKey("", System.Security.Cryptography.SHA256.HashData(bytes));
        var old = AgentBlobS3Fixture.Prefix + logicalKey;
        var held = await f.Client.PutObjectAsync(new PutObjectRequest { BucketName = f.Bucket, Key = old,
            InputStream = new MemoryStream(bytes), ObjectLockLegalHoldStatus = ObjectLockLegalHoldStatus.On });
        try
        {
            await f.InventoryAsync();
            var error = await Record.ExceptionAsync(() => f.InventoryAsync());
            Assert.True(error is IOException or DeleteObjectsException, error?.ToString());
            Assert.Equal("deleting", await f.Database.ScalarAsync("SELECT state FROM agent_blob_reservations"));
            Assert.Equal((decimal)bytes.Length, await f.Database.ScalarAsync("SELECT byte_length FROM agent_blob_reservations"));
            await Assert.ThrowsAsync<IOException>(() => f.Store.WriteAsync(null, "file", bytes, null, default));
        }
        finally
        {
            await f.Client.PutObjectLegalHoldAsync(new PutObjectLegalHoldRequest { BucketName = f.Bucket, Key = old,
                VersionId = held.VersionId, LegalHold = new ObjectLockLegalHold { Status = ObjectLockLegalHoldStatus.Off } });
        }
        await f.InventoryAsync();
        Assert.Empty((await f.Client.ListVersionsAsync(new ListVersionsRequest { BucketName = f.Bucket })).Versions ?? []);
        await f.Store.WriteAsync(null, "file", bytes, null, default);
        Assert.NotEqual(logicalKey, await f.Database.ScalarAsync("SELECT blob_key FROM agent_files"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Collection_preserves_shared_live_content_and_readmission_uses_a_new_object(bool conditional)
    {
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        await using var f = await AgentBlobS3Fixture.OpenAsync(conditional: conditional);
        await f.InventoryAsync();
        await f.Store.WriteAsync(null, "a", bytes, null, default);
        await f.Store.WriteAsync(null, "b", bytes, null, default);
        var old = (string)(await f.Database.ScalarAsync("SELECT DISTINCT blob_key FROM agent_files"))!;
        await f.Store.DeleteAsync(null, "a", false, null, default);
        await f.InventoryAsync();
        Assert.Equal(bytes, (await f.Store.ReadAsync(null, "b", default)).Bytes);
        await f.Store.DeleteAsync(null, "b", false, null, default);
        await f.InventoryAsync();
        Assert.Equal(0L, await f.Database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
        Assert.Empty((await f.Client.ListObjectsV2Async(new ListObjectsV2Request { BucketName = f.Bucket })).S3Objects ?? []);
        await f.Store.WriteAsync(null, "a", bytes, null, default);
        Assert.NotEqual(old, await f.Database.ScalarAsync("SELECT blob_key FROM agent_files"));
        // A retried unversioned DELETE from the earlier incarnation cannot remove this one.
        await f.Client.DeleteObjectAsync(f.Bucket, AgentBlobS3Fixture.Prefix + old);
        Assert.Equal(bytes, (await f.Store.ReadAsync(null, "a", default)).Bytes);
    }

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
        await f.InventoryAsync();
        Assert.Empty((await f.Client.ListVersionsAsync(new ListVersionsRequest { BucketName = f.Bucket })).Versions ?? []);
        Assert.Equal(0L, await f.Database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
        await f.Database.TakeLeaseAsync(f.Runtime.TenantId);
        await Assert.ThrowsAsync<TenantFencedException>(() => f.InventoryAsync());
    }
}
