using Foxwarm.Hosted;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests.Storage;

/// <summary>
/// S3 blob rules beyond the shared contract: the key layout, the startup probe of conditional
/// writes, the behavior a write from a fenced owner relies on, and startup failures.
/// </summary>
[Trait("Backend", "s3")]
public sealed class S3BlobStoreTests
{
    private sealed class LosePutResponse(Amazon.S3.IAmazonS3 inner, CancellationTokenSource? cancel)
        : Amazon.S3.AmazonS3Client("synthetic", "synthetic", Amazon.RegionEndpoint.USEast1)
    {
        public override Task<Amazon.S3.Model.GetObjectMetadataResponse> GetObjectMetadataAsync(
            Amazon.S3.Model.GetObjectMetadataRequest request, CancellationToken cancellationToken = default
        ) => inner.GetObjectMetadataAsync(request, cancellationToken);

        public override async Task<Amazon.S3.Model.PutObjectResponse> PutObjectAsync(
            Amazon.S3.Model.PutObjectRequest request, CancellationToken cancellationToken = default
        )
        {
            await inner.PutObjectAsync(request, cancellationToken);
            cancel?.Cancel();
            cancellationToken.ThrowIfCancellationRequested();
            throw new IOException("The response was lost after the object was stored.");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LostCreateResponseIsReconciledBeforeAnotherNewWrite(bool cancelAfterPut)
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        using var stop = new CancellationTokenSource();
        using var client = new LosePutResponse(bucket.Client, cancelAfterPut ? stop : null);
        var inner = new S3BlobStore(client, bucket.Name, S3TestBucket.Tenant, "images", conditionalWrites: true);
        var measures = 0;
        var quota = new Foxwarm.Limits.BlobQuota(600, async token =>
        {
            measures++;
            return await inner.ExistsAsync("a", token) ? 600 : 0;
        });
        var limited = quota.Apply(inner);
        var write = limited.CreateAsync("a", new byte[600], true, stop.Token);
        if (cancelAfterPut)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => write);
        else
            Assert.False(await write);
        Assert.True(await inner.ExistsAsync("a", default));
        await Assert.ThrowsAsync<Foxwarm.Limits.TenantLimitException>(() => limited.CreateAsync("b", new byte[1], true, default));
        Assert.Equal(2, measures);
        Assert.Equal(600, await quota.UsedAsync(default));
    }

    [Fact]
    public async Task Range_reads_return_the_requested_bytes_only()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        var store = bucket.Store("agent-files", true);
        var content = new byte[200_000];
        new Random(3).NextBytes(content);
        await store.CreateAsync("a/blob", content, false, CancellationToken.None);
        Assert.Equal(content[1000..1100], await store.ReadRangeAsync("a/blob", 1000, 100, CancellationToken.None));
        Assert.Equal(content[199_950..], await store.ReadRangeAsync("a/blob", 199_950, 100, CancellationToken.None));
        Assert.Empty(await store.ReadRangeAsync("a/blob", 200_000, 10, CancellationToken.None));
        await Assert.ThrowsAnyAsync<IOException>(() => store.ReadRangeAsync("a/none", 0, 10, CancellationToken.None));
    }

    [Fact]
    public async Task Keys_are_tenant_and_store_prefixed()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        await bucket.Store("images", true).CreateAsync("ab.png", new byte[] { 1 }, false, CancellationToken.None);
        await bucket.Store("artifacts", true).CreateAsync("art_x/1.json", new byte[] { 2 }, false, CancellationToken.None);
        await bucket.Store("images", true, tenant: "other").CreateAsync("ab.png", new byte[] { 3 }, false, CancellationToken.None);
        Assert.Equal(
            ["t/default/artifacts/art_x/1.json", "t/default/images/ab.png", "t/other/images/ab.png"],
            (await bucket.KeysAsync()).Order(StringComparer.Ordinal)
        );
        Assert.False(bucket.Store("artifacts", true).Exists("ab.png"));
        Assert.Equal([3], await bucket.Store("images", true, tenant: "other").ReadAllAsync("ab.png", CancellationToken.None));
        Assert.Throws<ArgumentException>(() => bucket.Store("images", true, tenant: ".."));
    }

    [Fact]
    public async Task The_probe_finds_conditional_writes_on_the_fixture_and_none_behind_an_ignoring_or_rejecting_endpoint()
    {
        await using (var bucket = await S3TestBucket.CreateAsync())
        {
            Assert.True(await bucket.ProbeAsync());
            // A restart finds the probe object and probes the same way.
            Assert.True(await bucket.ProbeAsync());
            Assert.Equal(["t/default/" + S3Blobs.ProbeKey], await bucket.KeysAsync());
        }
        var server = await S3Server.SharedAsync();
        foreach (var mode in new[] { S3ConditionalProxy.ConditionalMode.Ignore, S3ConditionalProxy.ConditionalMode.Reject })
        {
            await using var proxy = await S3ConditionalProxy.StartAsync(server.Endpoint, mode);
            await using var bucket = await S3TestBucket.CreateAsync(proxy.Endpoint);
            Assert.False(await bucket.ProbeAsync());
            Assert.False(await bucket.ProbeAsync());
            Assert.True(proxy.ConditionalPuts > 0);
            // The fallback still creates once.
            var store = bucket.Store("images", conditional: false);
            Assert.True(await store.CreateAsync("k.png", new byte[] { 1 }, false, CancellationToken.None));
            Assert.False(await store.CreateAsync("k.png", new byte[] { 2 }, true, CancellationToken.None));
            await Assert.ThrowsAnyAsync<IOException>(() => store.CreateAsync("k.png", new byte[] { 2 }, false, CancellationToken.None));
            Assert.Equal([1], await store.ReadAllAsync("k.png", CancellationToken.None));
        }
    }

    /// <summary>
    /// S3 writes aren't fenced by the database. A fenced owner's late create either lands on a
    /// key nobody created, as an unreferenced orphan, or finds the key existing and changes
    /// nothing; the new owner's create of a key the old one wrote never takes other content.
    /// </summary>
    [Fact]
    public async Task A_late_create_of_a_fenced_owner_never_replaces_content_and_leaves_at_most_an_orphan()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        var fenced = bucket.Store("artifacts", true);
        var owner = bucket.Store("artifacts", true);

        // The new owner published revision 2 first; the fenced owner's revision 2 is refused.
        Assert.True(await owner.CreateAsync("art_a/2.json", "new"u8.ToArray(), false, CancellationToken.None));
        await Assert.ThrowsAnyAsync<IOException>(() =>
            fenced.CreateAsync("art_a/2.json", "old"u8.ToArray(), false, CancellationToken.None)
        );
        Assert.False(await fenced.CreateAsync("art_a/2.json", "old"u8.ToArray(), true, CancellationToken.None));
        Assert.Equal("new"u8.ToArray(), await owner.ReadAllAsync("art_a/2.json", CancellationToken.None));

        // The fenced owner's revision 3 lands, referenced by nothing it could commit. The new
        // owner can't take that key with other content.
        Assert.True(await fenced.CreateAsync("art_a/3.json", "orphan"u8.ToArray(), false, CancellationToken.None));
        await Assert.ThrowsAnyAsync<IOException>(() =>
            owner.CreateAsync("art_a/3.json", "mine"u8.ToArray(), false, CancellationToken.None)
        );
        Assert.Equal("orphan"u8.ToArray(), await owner.ReadAllAsync("art_a/3.json", CancellationToken.None));

        // A retried create finds its own bytes and succeeds.
        Assert.True(await owner.CreateAsync("art_a/4.json", "retry"u8.ToArray(), false, CancellationToken.None));
        Assert.True(await owner.CreateAsync("art_a/4.json", "retry"u8.ToArray(), false, CancellationToken.None));
    }

    /// <summary>
    /// The fixture refuses a conditional <c>PUT</c> of an existing key before it has read the
    /// whole body and closes the connection, so the client sees a reset rather than the 412. Such a
    /// create still observes the existing key like a 412: kept, its own earlier bytes, or the
    /// existing-key failure for other bytes.
    /// </summary>
    [Fact]
    public async Task A_create_refused_before_its_body_is_read_observes_the_existing_key()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        var store = bucket.Store("images", true);
        var content = BlobStoreContractTests.Bytes(4 << 20, 1);
        var other = BlobStoreContractTests.Bytes(4 << 20, 2);
        Assert.True(await store.CreateAsync("large.png", content, false, CancellationToken.None));
        for (var round = 0; round < 3; round++)
        {
            Assert.False(await store.CreateAsync("large.png", other, true, CancellationToken.None));
            Assert.True(await store.CreateAsync("large.png", content, false, CancellationToken.None));
            var error = await Assert.ThrowsAnyAsync<IOException>(() =>
                store.CreateAsync("large.png", other, false, CancellationToken.None)
            );
            Assert.Equal("The blob large.png already exists.", error.Message);
        }
        Assert.Equal(content, await store.ReadAllAsync("large.png", CancellationToken.None));
    }

    /// <summary>A transport failure of a create whose key doesn't exist stays a failure.</summary>
    [Fact]
    public async Task A_create_cut_off_without_an_existing_key_fails()
    {
        var server = await S3Server.SharedAsync();
        await using var proxy = await S3ConditionalProxy.StartAsync(server.Endpoint, S3ConditionalProxy.ConditionalMode.Reset);
        await using var bucket = await S3TestBucket.CreateAsync(proxy.Endpoint);
        var store = bucket.Store("images", conditional: true);
        await Assert.ThrowsAnyAsync<IOException>(() =>
            store.CreateAsync("k.png", BlobStoreContractTests.Bytes(1000, 1), true, CancellationToken.None)
        );
        Assert.False(store.Exists("k.png"));
        Assert.True(proxy.ConditionalPuts > 0);
    }

    [Fact]
    public async Task The_context_puts_images_artifacts_Agent_files_and_the_authority_on_the_selected_backend()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        using var temp = new TempDirectory();
        var server = await S3Server.SharedAsync();
        File.WriteAllText(Path.Combine(temp.Path, "id"), server.AccessKey);
        File.WriteAllText(Path.Combine(temp.Path, "secret"), server.SecretKey);
        // No statement runs: the stores are only built.
        var database = new TenantDb(new Foxwarm.Hosted.Postgres.PgDatabase("Host=/nonexistent;Database=none", "test"), 1, 1);
        var postgres = new PostgresStorageContext(database, temp.Path);
        await postgres.OpenBlobsAsync(new BlobSettings(BlobBackend.Postgres, null), "default", CancellationToken.None);
        Assert.IsType<Foxwarm.Hosted.Postgres.PgBlobStore>(postgres.ImageBlobs);
        Assert.IsType<Foxwarm.Hosted.Postgres.PgBlobStore>(postgres.ArtifactBlobs);
        Assert.IsType<Foxwarm.Hosted.Postgres.PgBlobStore>(postgres.AgentFileBlobs);

        var s3 = new PostgresStorageContext(database, temp.Path);
        var settings = bucket.Settings with
        {
            AccessKeyIdFile = Path.Combine(temp.Path, "id"),
            SecretAccessKeyFile = Path.Combine(temp.Path, "secret"),
        };
        await s3.UseS3BlobsAsync(settings, "41-20261101T120000Z", CancellationToken.None);
        var images = Assert.IsType<S3BlobStore>(s3.ImageBlobs);
        Assert.True(images.ConditionalWrites);
        Assert.IsType<S3BlobStore>(s3.ArtifactBlobs);
        Assert.Same(
            images,
            Assert.IsType<Foxwarm.Hosted.Postgres.Authority.PostgresSessionAuthorityBackend>(s3.Authority).ImageBlobs
        );
        // The Agent store is rebuilt over the S3 store of large Agent files.
        Assert.Same(
            Assert.IsType<S3BlobStore>(s3.AgentFileBlobs),
            Assert.IsType<Foxwarm.Hosted.Postgres.PgAgentFileStore>(s3.AgentFiles).Blobs
        );
        Assert.Empty(s3.Missing);
        await s3.AgentFileBlobs.CreateAsync("alpha/00", new byte[] { 1 }, false, CancellationToken.None);
        Assert.Contains("t/41-20261101T120000Z/agent-files/alpha/00", await bucket.KeysAsync());
        await s3.ArtifactBlobs.CreateAsync("art_c/1.json", new byte[] { 1 }, false, CancellationToken.None);
        Assert.Contains("t/41-20261101T120000Z/artifacts/art_c/1.json", await bucket.KeysAsync());
        // The context owns the S3 client both stores share: disposing it closes the client.
        await s3.DisposeAsync();
        await postgres.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            s3.ArtifactBlobs.CreateAsync("art_c/2.json", new byte[] { 1 }, false, CancellationToken.None)
        );
    }

    [Fact]
    public async Task Missing_keys_fail_like_files_and_refused_settings_fail_startup()
    {
        await using var bucket = await S3TestBucket.CreateAsync();
        var store = bucket.Store("images", true);
        await Assert.ThrowsAsync<FileNotFoundException>(() => store.ReadAllAsync("none.png", CancellationToken.None));
        Assert.Throws<FileNotFoundException>(() => store.OpenRead("none.png"));
        Assert.Empty(store.List("none"));

        using var temp = new TempDirectory();
        var server = await S3Server.SharedAsync();
        var id = Path.Combine(temp.Path, "id");
        var secret = Path.Combine(temp.Path, "secret");
        File.WriteAllText(id, server.AccessKey + "\n");
        File.WriteAllText(secret, server.SecretKey + "\n");
        var settings = bucket.Settings with { AccessKeyIdFile = id, SecretAccessKeyFile = secret };
        var (client, conditional) = await S3Blobs.OpenAsync(settings, "default", CancellationToken.None);
        client.Dispose();
        Assert.True(conditional);

        Assert.Contains(
            bucket.Name + "-missing",
            (await Assert.ThrowsAsync<HostedStartupException>(() =>
                S3Blobs.OpenAsync(settings with { Bucket = bucket.Name + "-missing" }, "default", CancellationToken.None)
            )).Message
        );
        File.WriteAllText(secret, "wrong");
        await Assert.ThrowsAsync<HostedStartupException>(() => S3Blobs.OpenAsync(settings, "default", CancellationToken.None));
        File.Delete(secret);
        Assert.Contains(
            "blobs.s3.secretAccessKeyFile",
            (await Assert.ThrowsAsync<HostedStartupException>(() => S3Blobs.OpenAsync(settings, "default", CancellationToken.None))).Message
        );
    }
}
