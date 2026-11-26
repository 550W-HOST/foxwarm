using System.Security.Cryptography;
using Foxwarm.Artifacts;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests.Storage;

/// <summary>
/// Observable behavior every <see cref="IBlobStore"/> backend shares: create-once with and
/// without keeping an existing key, concurrent creates of one key, whole and streamed reads of
/// an object spanning several PostgreSQL chunks, and listing (paged on S3). The file backend is
/// the artifact store's layout, whose keys carry directories as the hosted keys do.
/// </summary>
public abstract class BlobStoreContractTests
{
    private protected abstract Task<StoreUnderTest> CreateAsync();

    /// <summary>
    /// Whether concurrent creates of one key have exactly one winner. Otherwise more than one
    /// may report the key created, and it holds the content of one of them: S3 without
    /// conditional writes, and the files where the file system can't link without replacing.
    /// File mode and the single hosted owner serialize the creates of one key in the owning
    /// store's lane; blobs whose key is their digest have one content anyway.
    /// </summary>
    private protected virtual bool ExclusiveCreate => true;

    private protected sealed class StoreUnderTest(IBlobStore blobs, bool local, Func<ValueTask> dispose)
        : IAsyncDisposable
    {
        internal IBlobStore Blobs { get; } = blobs;

        internal bool Local { get; } = local;

        public ValueTask DisposeAsync() => dispose();
    }

    internal static byte[] Bytes(int length, int seed)
    {
        var bytes = new byte[length];
        new Random(seed).NextBytes(bytes);
        return bytes;
    }

    [Fact]
    public async Task A_key_is_created_once_and_an_existing_key_keeps_its_content()
    {
        await using var store = await CreateAsync();
        var blobs = store.Blobs;
        const string key = "art_a/1.json";
        Assert.False(blobs.Exists(key));
        await Assert.ThrowsAnyAsync<IOException>(() => blobs.ReadAllAsync(key, CancellationToken.None));
        Assert.ThrowsAny<IOException>(() => blobs.OpenRead(key).Dispose());

        var first = "{\"revision\":1,\"text\":\"Grüße 🦊\"}"u8.ToArray();
        Assert.True(await blobs.CreateAsync(key, first, keepExisting: false, CancellationToken.None));
        Assert.True(blobs.Exists(key));
        Assert.Equal(first, await blobs.ReadAllAsync(key, CancellationToken.None));

        Assert.False(await blobs.CreateAsync(key, Bytes(10, 1), keepExisting: true, CancellationToken.None));
        await Assert.ThrowsAnyAsync<IOException>(() =>
            blobs.CreateAsync(key, Bytes(10, 2), keepExisting: false, CancellationToken.None)
        );
        Assert.Equal(first, await blobs.ReadAllAsync(key, CancellationToken.None));

        // Empty content is a blob too.
        Assert.True(await blobs.CreateAsync("art_a/resources/empty", ReadOnlyMemory<byte>.Empty, false, CancellationToken.None));
        Assert.Empty(await blobs.ReadAllAsync("art_a/resources/empty", CancellationToken.None));
        await using (var empty = blobs.OpenRead("art_a/resources/empty"))
        {
            Assert.Equal(0, empty.Length);
            Assert.Equal(-1, empty.ReadByte());
        }
        Assert.Equal(store.Local, blobs.LocalPath(key) is not null);
    }

    [Fact]
    public async Task Concurrent_creates_of_one_key_leave_one_complete_content()
    {
        await using var store = await CreateAsync();
        var blobs = store.Blobs;
        var contents = Enumerable
            .Range(0, 6)
            .Select(index => Bytes(300_000 + index, index))
            .ToArray();
        using var start = new ManualResetEventSlim();
        var creates = contents
            .Select(content =>
                Task.Run(async () =>
                {
                    start.Wait();
                    return await blobs.CreateAsync("shared/blob", content, keepExisting: true, CancellationToken.None);
                })
            )
            .ToArray();
        start.Set();
        var created = await Task.WhenAll(creates);
        var stored = await blobs.ReadAllAsync("shared/blob", CancellationToken.None);
        if (ExclusiveCreate)
        {
            Assert.Single(created, value => value);
            Assert.Equal(contents[Array.IndexOf(created, true)], stored);
        }
        else
            Assert.Contains(stored, contents.Where((_, index) => created[index]));
        Assert.False(await blobs.CreateAsync("shared/blob", contents[0], keepExisting: true, CancellationToken.None));
    }

    [Fact]
    public async Task An_object_of_several_chunks_reads_whole_and_streamed()
    {
        await using var store = await CreateAsync();
        var blobs = store.Blobs;
        var content = Bytes(4 * PgBlobStore.ChunkBytes + 12_345, 42);
        Assert.True(await blobs.CreateAsync("images/large.png", content, keepExisting: false, CancellationToken.None));
        Assert.Equal(content, await blobs.ReadAllAsync("images/large.png", CancellationToken.None));

        await using (var stream = blobs.OpenRead("images/large.png"))
        {
            Assert.Equal(content.Length, stream.Length);
            Assert.True(stream.CanRead);
            Assert.False(stream.CanWrite);
            // Mixed synchronous and asynchronous reads of odd sizes across chunk boundaries.
            var copy = new MemoryStream();
            var buffer = new byte[300_001];
            for (var round = 0; ; round++)
            {
                var read =
                    round % 2 == 0
                        ? stream.Read(buffer, 0, buffer.Length)
                        : await stream.ReadAsync(buffer.AsMemory(0, 77_777));
                if (read == 0)
                    break;
                copy.Write(buffer, 0, read);
            }
            Assert.Equal(content, copy.ToArray());
        }
        await using (var stream = blobs.OpenRead("images/large.png"))
            Assert.Equal(SHA256.HashData(content), await SHA256.HashDataAsync(stream));
    }

    [Fact]
    public async Task List_returns_the_keys_directly_under_a_prefix_across_pages()
    {
        await using var store = await CreateAsync();
        var blobs = store.Blobs;
        var revisions = Enumerable.Range(1, 23).Select(index => $"{index}.json").ToArray();
        foreach (var name in revisions)
            await blobs.CreateAsync("art_list/" + name, Bytes(5, name.Length), false, CancellationToken.None);
        await blobs.CreateAsync("art_list/resources/abc", Bytes(5, 1), false, CancellationToken.None);
        await blobs.CreateAsync("art_list/resources/def", Bytes(5, 2), false, CancellationToken.None);
        await blobs.CreateAsync("art_listed/1.json", Bytes(5, 3), false, CancellationToken.None);

        Assert.Equal(revisions.Order(StringComparer.Ordinal), blobs.List("art_list").Order(StringComparer.Ordinal));
        Assert.Equal(["abc", "def"], blobs.List("art_list/resources").Order(StringComparer.Ordinal));
        Assert.Equal(["1.json"], blobs.List("art_listed"));
    }
}

public sealed class FileBlobStoreContractTests : BlobStoreContractTests
{
    private protected override bool ExclusiveCreate => false;

    private protected override Task<StoreUnderTest> CreateAsync()
    {
        var temp = new TempDirectory();
        return Task.FromResult(
            new StoreUnderTest(
                new ArtifactBlobFiles(Path.Combine(temp.Path, "state", "artifacts")),
                local: true,
                () =>
                {
                    temp.Dispose();
                    return ValueTask.CompletedTask;
                }
            )
        );
    }
}

[Trait("Backend", "postgres")]
public sealed class PostgresBlobStoreContractTests : BlobStoreContractTests
{
    private protected override async Task<StoreUnderTest> CreateAsync()
    {
        var (database, tenant) = await PostgresBlobStoreTests.OpenAsync();
        return new StoreUnderTest(new PgBlobStore(tenant, "artifacts"), local: false, database.DisposeAsync);
    }
}

[Trait("Backend", "s3")]
public sealed class S3BlobStoreContractTests : BlobStoreContractTests
{
    private protected override async Task<StoreUnderTest> CreateAsync()
    {
        var bucket = await S3TestBucket.CreateAsync();
        var conditional = await bucket.ProbeAsync();
        Assert.True(conditional);
        return new StoreUnderTest(bucket.Store("artifacts", conditional, pageSize: 7), local: false, bucket.DisposeAsync);
    }
}

/// <summary>The same contract against an endpoint that ignores <c>If-None-Match</c>.</summary>
[Trait("Backend", "s3")]
public sealed class S3FallbackBlobStoreContractTests : BlobStoreContractTests
{
    private protected override bool ExclusiveCreate => false;

    private protected override async Task<StoreUnderTest> CreateAsync()
    {
        var server = await S3Server.SharedAsync();
        var proxy = await S3ConditionalProxy.StartAsync(server.Endpoint, S3ConditionalProxy.ConditionalMode.Ignore);
        var bucket = await S3TestBucket.CreateAsync(proxy.Endpoint);
        var conditional = await bucket.ProbeAsync();
        Assert.False(conditional);
        var probed = proxy.ConditionalPuts;
        return new StoreUnderTest(
            bucket.Store("artifacts", conditional, pageSize: 7),
            local: false,
            async () =>
            {
                // After the probe, creates use HEAD then PUT only.
                Assert.Equal(probed, proxy.ConditionalPuts);
                await bucket.DisposeAsync();
                await proxy.DisposeAsync();
            }
        );
    }
}
