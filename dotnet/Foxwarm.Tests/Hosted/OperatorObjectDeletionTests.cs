using Amazon.S3;
using Amazon.S3.Model;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
[Trait("Backend", "s3")]
public sealed class OperatorObjectDeletionTests
{
    private static async Task Until(Func<Task<bool>> check)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!await check())
            await Task.Delay(100, timeout.Token);
    }

    [Fact]
    public async Task A_changed_destination_forgets_only_its_receipt_while_a_missing_bucket_remains_pending()
    {
        var server = await S3Server.SharedAsync();
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        using var root = new TempDirectory();
        var config = new S3BlobSettings(
            server.Endpoint,
            S3Server.Region,
            S3Server.NewBucketName(),
            true,
            Path.Combine(root.Path, "access"),
            Path.Combine(root.Path, "secret")
        );
        await File.WriteAllTextAsync(config.AccessKeyIdFile, server.AccessKey);
        await File.WriteAllTextAsync(config.SecretAccessKeyFile, server.SecretKey);
        await using var op = new PgDatabase(db.OperatorConnectionString, "receipt-test");
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek"))),
            config
        );
        // IDs order the due page. The first destination matches but its bucket does not
        // exist. Neither the former bucket nor the former endpoint should be contacted.
        await db.OpenOwner()
            .ClusterAsync(
                (tx, ct) =>
                    tx.ExecuteAsync(
                        """
                        INSERT INTO operator_object_receipts(tenant_id,slug,object_identity,endpoint,bucket,recheck_after)
                        VALUES (1,'first','namespace-1',$1,$2,now()),(2,'second','namespace-2',$1,'old-bucket',now()),
                               (3,'third','namespace-3','https://former.example.invalid/',$2,now())
                        """,
                        ct,
                        config.Endpoint.AbsoluteUri,
                        config.Bucket
                    ),
                default
            );
        using var stop = new CancellationTokenSource();
        var worker = store.RunDeletionLoopAsync(stop.Token);
        try
        {
            await Until(async () => (await store.ReadReceiptsAsync(default)).AsArray().Count == 1);
        }
        finally
        {
            stop.Cancel();
            await worker;
        }
        Assert.Equal(
            1,
            (int)Assert.Single((await store.ReadReceiptsAsync(default)).AsArray())!["tenantId"]!
        );
    }

    [Theory]
    [InlineData("off")]
    [InlineData("suspended")]
    [InlineData("locked")]
    public async Task The_worker_rechecks_only_the_old_namespace_after_late_puts(string mode)
    {
        var server = await S3Server.SharedAsync(enableVersioning: true);
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        using var root = new TempDirectory();
        var settings = new S3BlobSettings(
            server.Endpoint,
            S3Server.Region,
            S3Server.NewBucketName(),
            true,
            Path.Combine(root.Path, "access"),
            Path.Combine(root.Path, "secret")
        );
        await File.WriteAllTextAsync(settings.AccessKeyIdFile, server.AccessKey);
        await File.WriteAllTextAsync(settings.SecretAccessKeyFile, server.SecretKey);
        using var s3 = S3Blobs.Client(settings, server.AccessKey, server.SecretKey);
        var bucket = settings.Bucket;
        await s3.PutBucketAsync(
            new PutBucketRequest
            {
                BucketName = bucket,
                ObjectLockEnabledForBucket = mode == "locked" ? true : null,
            }
        );
        await using var op = new PgDatabase(
            db.OperatorConnectionString,
            "operator-object-deletion"
        );
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek"))),
            settings
        );
        await store.CreateAsync("alpha", "hosted", "alpha.test", default);
        var id = await db.TenantIdAsync("alpha");
        var identity = (string)
            (await db.ScalarAsync("SELECT object_identity FROM tenants WHERE tenant_id=$1", id))!;
        var prefix = S3Blobs.TenantRoot(identity);
        async Task SetMode(VersionStatus status) =>
            await s3.PutBucketVersioningAsync(
                new PutBucketVersioningRequest
                {
                    BucketName = bucket,
                    VersioningConfig = new S3BucketVersioningConfig { Status = status },
                }
            );
        if (mode == "suspended")
            await SetMode(VersionStatus.Enabled);
        var existing = prefix + "artifacts/existing";
        await s3.PutObjectAsync(
            new PutObjectRequest
            {
                BucketName = bucket,
                Key = existing,
                ContentBody = "data",
            }
        );
        if (mode != "off")
        {
            await s3.PutObjectAsync(
                new PutObjectRequest
                {
                    BucketName = bucket,
                    Key = existing,
                    ContentBody = "replacement",
                }
            );
            await s3.DeleteObjectAsync(bucket, existing);
        }
        if (mode == "suspended")
            await SetMode(VersionStatus.Suspended);
        await using var proxy = await S3ConditionalProxy.StartAsync(
            server.Endpoint,
            S3ConditionalProxy.ConditionalMode.Delay
        );
        using var replica = S3Blobs.Client(
            settings with
            {
                Endpoint = proxy.Endpoint,
            },
            server.AccessKey,
            server.SecretKey
        );
        var lateKey = prefix + "artifacts/late";
        var put = replica.PutObjectAsync(
            new PutObjectRequest
            {
                BucketName = bucket,
                Key = lateKey,
                ContentBody = "late",
                IfNoneMatch = "*",
                ObjectLockLegalHoldStatus = mode == "locked" ? ObjectLockLegalHoldStatus.On : null,
            }
        );
        await proxy.PutArrived.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await store.SuspendAsync("alpha", default);
        await store.DeleteAsync("alpha", default);
        using var stop = new CancellationTokenSource();
        var worker = store.RunDeletionLoopAsync(stop.Token);
        try
        {
            await Until(async () =>
                await db.ScalarAsync(
                    "SELECT settle_after IS NOT NULL FROM operator_deletions WHERE tenant_id=$1",
                    id
                )
                    is true
            );
            var heldVersions = new List<string>();
            if (mode != "off")
            {
                proxy.ReleasePut.TrySetResult();
                var late = await put;
                if (mode == "locked")
                {
                    heldVersions.Add(late.VersionId);
                    // Fill the first version page at one key. A later key must be removed
                    // before any of these holds are lifted (both S3 markers matter).
                    for (int i = 1; i < 256; i++)
                        heldVersions.Add(
                            (
                                await s3.PutObjectAsync(
                                    new PutObjectRequest
                                    {
                                        BucketName = bucket,
                                        Key = lateKey,
                                        ContentBody = "held",
                                        ObjectLockLegalHoldStatus = ObjectLockLegalHoldStatus.On,
                                    }
                                )
                            ).VersionId
                        );
                    await s3.PutObjectAsync(
                        new PutObjectRequest
                        {
                            BucketName = bucket,
                            Key = prefix + "z",
                            ContentBody = "unprotected",
                        }
                    );
                }
            }
            Assert.True((bool)(await store.ReadAsync("alpha", default))["objectsPending"]!);
            Assert.Equal(
                1L,
                await db.ScalarAsync("SELECT count(*) FROM tenant_keys WHERE tenant_id=$1", id)
            );
            // Move just the persisted settle deadline. The second proof must still come from
            // a fresh version-aware listing; the wall clock isn't otherwise mocked.
            await db.ExecuteOwnerAsync(
                "UPDATE operator_deletions SET settle_after=clock_timestamp()-interval '1 second'"
            );
            if (mode == "locked")
            {
                await Until(async () =>
                    (
                        (
                            await s3.ListVersionsAsync(
                                new ListVersionsRequest
                                {
                                    BucketName = bucket,
                                    Prefix = prefix + "z",
                                }
                            )
                        ).Versions
                        ?? []
                    ).Count == 0
                );
                // A genuine protected version refuses an ordinary delete even to the bucket owner.
                var response = await Assert.ThrowsAsync<AmazonS3Exception>(() =>
                    s3.DeleteObjectAsync(bucket, lateKey, heldVersions[0])
                );
                Assert.Equal(System.Net.HttpStatusCode.Forbidden, response.StatusCode);
                Assert.True((bool)(await store.ReadAsync("alpha", default))["objectsPending"]!);
                foreach (var held in heldVersions)
                    await s3.PutObjectLegalHoldAsync(
                        new PutObjectLegalHoldRequest
                        {
                            BucketName = bucket,
                            Key = lateKey,
                            VersionId = held,
                            LegalHold = new ObjectLockLegalHold
                            {
                                Status = ObjectLockLegalHoldStatus.Off,
                            },
                        }
                    );
            }
            await Until(async () =>
                await db.ScalarAsync("SELECT 1 FROM tenants WHERE tenant_id=$1", id) is null
            );
            if (mode != "off")
                Assert.Empty(
                    (
                        await s3.ListVersionsAsync(
                            new ListVersionsRequest { BucketName = bucket, Prefix = prefix }
                        )
                    ).Versions
                        ?? []
                );
            Assert.Empty(
                (
                    await s3.ListObjectsV2Async(
                        new ListObjectsV2Request { BucketName = bucket, Prefix = prefix }
                    )
                ).S3Objects
                    ?? []
            );
            await store.CreateAsync("alpha", "hosted", "alpha.test", default);
            Assert.NotEqual(
                identity,
                await db.ScalarAsync("SELECT object_identity FROM tenants WHERE name='alpha'")
            );
            var pending = Assert.Single((await store.ReadReceiptsAsync(default)).AsArray())!;
            Assert.Equal(id, (int)pending["tenantId"]!);
            Assert.True(
                await db.ScalarAsync(
                    "SELECT recheck_after-observed_empty_at>=interval '23 hours 59 minutes' FROM operator_object_receipts WHERE tenant_id=$1",
                    id
                )
                    is true
            );
            var sibling = (string)
                (await db.ScalarAsync("SELECT object_identity FROM tenants WHERE name='alpha'"))!;
            var siblingKey = S3Blobs.TenantRoot(sibling) + "artifacts/keep";
            var keeper = await s3.PutObjectAsync(
                new PutObjectRequest
                {
                    BucketName = bucket,
                    Key = siblingKey,
                    ContentBody = "new tenant",
                }
            );
            if (mode == "off")
            {
                // This was dispatched before deletion but reaches storage only after its
                // old tenant is gone. The receipt survives a worker restart and slug reuse.
                proxy.ReleasePut.TrySetResult();
                await put;
                Assert.NotEmpty(
                    (
                        await s3.ListObjectsV2Async(
                            new ListObjectsV2Request { BucketName = bucket, Prefix = prefix }
                        )
                    ).S3Objects
                        ?? []
                );
            }
            stop.Cancel();
            await worker;
            await db.ExecuteOwnerAsync(
                "UPDATE operator_object_receipts SET recheck_after=clock_timestamp()-interval '1 second'"
            );
            using var again = new CancellationTokenSource();
            var recovery = store.RunDeletionLoopAsync(again.Token);
            try
            {
                await Until(async () =>
                    (await store.ReadReceiptsAsync(default)).AsArray().Count == 0
                );
            }
            finally
            {
                again.Cancel();
                await recovery;
            }
            Assert.Empty(
                (
                    await s3.ListObjectsV2Async(
                        new ListObjectsV2Request { BucketName = bucket, Prefix = prefix }
                    )
                ).S3Objects
                    ?? []
            );
            Assert.Equal(
                siblingKey,
                Assert
                    .Single(
                        (
                            await s3.ListObjectsV2Async(
                                new ListObjectsV2Request
                                {
                                    BucketName = bucket,
                                    Prefix = S3Blobs.TenantRoot(sibling),
                                }
                            )
                        ).S3Objects
                            ?? []
                    )
                    .Key
            );
            await s3.DeleteObjectAsync(
                new DeleteObjectRequest
                {
                    BucketName = bucket,
                    Key = siblingKey,
                    VersionId = mode == "off" ? null : keeper.VersionId ?? "null",
                }
            );
            await s3.DeleteBucketAsync(bucket);
        }
        finally
        {
            proxy.ReleasePut.TrySetResult();
            stop.Cancel();
            await worker;
        }
    }
}
