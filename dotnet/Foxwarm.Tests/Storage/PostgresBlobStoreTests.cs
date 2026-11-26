using System.Security.Cryptography;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Tests.Hosted;
using Npgsql;

namespace Foxwarm.Tests.Storage;

/// <summary>
/// PostgreSQL blob rules beyond the shared contract: the fenced create, lost-COMMIT
/// resolution, the chunk layout, lazy chunk reads and store separation.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresBlobStoreTests
{
    internal static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    private static async Task<string> RowsAsync(HostedTestDatabase database) =>
        (string)(await database.ScalarAsync(
            "SELECT (SELECT count(*) FROM blob_objects)::text || '/' || (SELECT count(*) FROM blob_chunks)::text"
        ))!;

    [Theory]
    [InlineData("new key", false)]
    [InlineData("new key", true)]
    [InlineData("existing key", false)]
    [InlineData("existing key", true)]
    public async Task A_create_after_a_takeover_is_fenced_and_leaves_nothing(string target, bool keepExisting)
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = new PgBlobStore(tenant, "images");
        await store.CreateAsync("existing", BlobStoreContractTests.Bytes(10, 1), false, CancellationToken.None);
        var fenced = 0;
        tenant.Fenced += _ => fenced++;
        var before = await RowsAsync(database);

        await database.TakeLeaseAsync(tenant.TenantId, "other");
        var key = target == "new key" ? "fresh" : "existing";
        await Assert.ThrowsAsync<TenantFencedException>(() =>
            store.CreateAsync(key, BlobStoreContractTests.Bytes(3 * PgBlobStore.ChunkBytes, 2), keepExisting, CancellationToken.None)
        );
        Assert.True(fenced > 0);
        Assert.Equal(before, await RowsAsync(database));
        // Reads aren't fenced.
        Assert.Equal(BlobStoreContractTests.Bytes(10, 1), await store.ReadAllAsync("existing", CancellationToken.None));
        Assert.False(store.Exists("fresh"));
    }

    [Fact]
    public async Task A_lost_COMMIT_is_resolved_by_the_object_row_in_both_directions()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        var store = new PgBlobStore(new TenantDb(database.OpenApp(routed), tenant.TenantId, tenant.Epoch), "artifacts");
        var content = BlobStoreContractTests.Bytes(PgBlobStore.ChunkBytes + 5, 3);

        // COMMIT reaches the server, its reply doesn't: the row with this content shows it landed.
        store.BeforeCommit = () => proxy.HoldExisting(toServer: false, toClient: true);
        Assert.True(await store.CreateAsync("a/1.json", content, keepExisting: false, CancellationToken.None));
        store.BeforeCommit = null;
        proxy.SeverAll();
        proxy.Heal();
        Assert.Equal(content, await store.ReadAllAsync("a/1.json", CancellationToken.None));

        // COMMIT never reaches the server: no row, and the create fails as not committed.
        store.BeforeCommit = () => proxy.HoldExisting(toServer: true, toClient: false);
        var lost = await Assert.ThrowsAnyAsync<Exception>(() =>
            store.CreateAsync("a/2.json", content, keepExisting: false, CancellationToken.None)
        );
        Assert.IsNotType<CommitOutcomeUnknownException>(lost);
        store.BeforeCommit = null;
        proxy.SeverAll();
        proxy.Heal();
        Assert.False(store.Exists("a/2.json"));
        Assert.Equal("1/2", await RowsAsync(database));
    }

    [Fact]
    public async Task Content_is_stored_in_one_MiB_chunks_with_its_length_and_digest()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var content = BlobStoreContractTests.Bytes(2 * PgBlobStore.ChunkBytes + PgBlobStore.ChunkBytes / 2, 4);
        await new PgBlobStore(tenant, "images").CreateAsync("abc.png", content, false, CancellationToken.None);
        Assert.Equal(
            $"{content.Length}/3/{Convert.ToHexStringLower(SHA256.HashData(content))}",
            await database.ScalarAsync(
                "SELECT byte_length || '/' || chunk_count || '/' || encode(sha256, 'hex') FROM blob_objects"
                    + " WHERE store = 'images' AND key = 'abc.png'"
            )
        );
        Assert.Equal(
            "0:1048576,1:1048576,2:524288",
            await database.ScalarAsync(
                "SELECT string_agg(chunk || ':' || length(data), ',' ORDER BY chunk) FROM blob_chunks WHERE key = 'abc.png'"
            )
        );
    }

    [Fact]
    public async Task A_stream_fetches_each_chunk_when_it_reaches_it()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = new PgBlobStore(tenant, "images");
        var content = BlobStoreContractTests.Bytes(3 * PgBlobStore.ChunkBytes, 5);
        await store.CreateAsync("lazy.png", content, false, CancellationToken.None);
        await using var stream = store.OpenRead("lazy.png");
        var first = new byte[PgBlobStore.ChunkBytes];
        await stream.ReadExactlyAsync(first);
        Assert.Equal(content[..PgBlobStore.ChunkBytes], first);
        // Rewritten behind the open stream (bypassing the rules): the stream reads it now, so it
        // held at most the first chunk so far.
        await database.ScalarAsync(
            "SET session_replication_role = replica; UPDATE blob_chunks SET data = decode(repeat('ab', 1048576), 'hex') WHERE key = 'lazy.png' AND chunk = 2"
        );
        var rest = new byte[2 * PgBlobStore.ChunkBytes];
        await stream.ReadExactlyAsync(rest);
        Assert.Equal(content[PgBlobStore.ChunkBytes..(2 * PgBlobStore.ChunkBytes)], rest[..PgBlobStore.ChunkBytes]);
        Assert.All(rest[PgBlobStore.ChunkBytes..], value => Assert.Equal(0xab, value));
        Assert.Equal(-1, stream.ReadByte());
    }

    [Fact]
    public async Task Stores_are_separate_and_a_short_chunk_fails_the_read()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var images = new PgBlobStore(tenant, "images");
        var artifacts = new PgBlobStore(tenant, "artifacts");
        await images.CreateAsync("x/1", BlobStoreContractTests.Bytes(8, 6), false, CancellationToken.None);
        Assert.False(artifacts.Exists("x/1"));
        Assert.Empty(artifacts.List("x"));
        Assert.True(await artifacts.CreateAsync("x/1", BlobStoreContractTests.Bytes(9, 7), false, CancellationToken.None));
        Assert.Equal(8, (await images.ReadAllAsync("x/1", CancellationToken.None)).Length);

        await database.ScalarAsync("SET session_replication_role = replica; UPDATE blob_chunks SET data = '\\x00' WHERE store = 'images' AND key = 'x/1'");
        await Assert.ThrowsAnyAsync<IOException>(() => images.ReadAllAsync("x/1", CancellationToken.None));
        await using var stream = images.OpenRead("x/1");
        Assert.ThrowsAny<IOException>(() => stream.CopyTo(Stream.Null));
    }
}
