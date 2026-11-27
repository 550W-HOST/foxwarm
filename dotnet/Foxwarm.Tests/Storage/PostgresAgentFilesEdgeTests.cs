using System.Security.Cryptography;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// The hosted Agent store at its edges: admission before durable blob content, inheritance
/// copies under the per-file limit without carrying contents through the replica, the key
/// bound PostgreSQL can index, conditional deletes, range reads and new Agent names.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresAgentFilesEdgeTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static async Task<long> BlobsAsync(HostedTestDatabase database) =>
        Convert.ToInt64(await database.ScalarAsync("SELECT count(*) FROM blob_objects"));

    [Fact]
    public async Task A_large_write_the_commit_would_refuse_leaves_no_blob()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var size = PgAgentFileStore.InlineBytes + 1;
        var limits = new AgentStoreLimits(TotalBytes: size + 10, Files: 3, FileBytes: size * 2L);
        var store = PostgresAgentFilesTests.Store(tenant, limits);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        await store.WriteAsync("alpha", "a.bin", RandomNumberGenerator.GetBytes(size), null, None);
        var blobs = await BlobsAsync(database);
        // Each refusal comes from a check the commit applies: total bytes, a conflict, the
        // parent's shape and membership.
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.WriteAsync("alpha", "b.bin", RandomNumberGenerator.GetBytes(size), null, None)
        );
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            store.WriteAsync("alpha", "a.bin", RandomNumberGenerator.GetBytes(size), 0, None)
        );
        await store.WriteAsync("alpha", "f", new byte[] { 1 }, null, None);
        await Assert.ThrowsAsync<IOException>(() =>
            store.WriteAsync("alpha", "f/c.bin", RandomNumberGenerator.GetBytes(size), null, None)
        );
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            store.WriteAsync("ghost", "c.bin", RandomNumberGenerator.GetBytes(size), null, None)
        );
        Assert.Equal(blobs, await BlobsAsync(database));
    }

    [Fact]
    public async Task A_tree_copy_applies_the_file_limit_and_copies_inside_the_database()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var limits = new AgentStoreLimits(TotalBytes: 1L << 30, Files: 100, FileBytes: 1000);
        var current = limits;
        var store = new PgAgentFileStore(tenant, new PgBlobStore(tenant, PgAgentFileStore.BlobStoreName), () => current);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        await store.CreateAgentAsync("beta", ["memory"], [], None);
        var large = RandomNumberGenerator.GetBytes(PgAgentFileStore.InlineBytes + 5);
        current = limits with { FileBytes = large.Length };
        await store.WriteAsync("alpha", "memory/small.md", new byte[] { 1, 2, 3 }, null, None);
        await store.WriteAsync("alpha", "memory/deep/large.bin", large, null, None);
        // A file admitted under a higher limit isn't copied as a new file over a lower one.
        current = limits;
        var refused = await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.CopyTreeAsync("alpha", "memory", "beta", "memory", None)
        );
        Assert.Equal("fileBytes", refused.Limit);
        Assert.DoesNotContain(store.Tree("beta", "memory"), entry => !entry.IsDirectory);
        current = limits with { FileBytes = large.Length };
        await store.CopyTreeAsync("alpha", "memory", "beta", "memory", None);
        Assert.Equal(large, (await store.ReadAsync("beta", "memory/deep/large.bin", None)).Bytes);
        Assert.Equal([1, 2, 3], (await store.ReadAsync("beta", "memory/small.md", None)).Bytes);
        Assert.Equal(
            (long)large.Length * 2 + 6,
            Convert.ToInt64(await database.ScalarAsync("SELECT bytes FROM agent_file_usage"))
        );
        // Total bytes are admitted before contents move.
        current = limits with { FileBytes = large.Length, TotalBytes = (long)large.Length * 2 + 6 };
        await store.CreateAgentAsync("gamma", [], [], None);
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.CopyTreeAsync("alpha", "memory", "gamma", "memory", None)
        );
        Assert.DoesNotContain(store.Tree("gamma", ""), entry => !entry.IsDirectory);
    }

    // A path of incompressible ASCII: segments of random letters below the segment limit.
    private static string Incompressible(int bytes)
    {
        var letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        var chars = new char[bytes];
        for (var index = 0; index < bytes; index++)
            chars[index] = index % 200 == 199 ? '/' : letters[RandomNumberGenerator.GetInt32(letters.Length)];
        if (chars[^1] == '/')
            chars[^1] = 'x';
        return new string(chars);
    }

    [Fact]
    public async Task Paths_up_to_the_key_bound_are_stored_and_longer_ones_refused()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var store = PostgresAgentFilesTests.Store(tenant);
        var agent = new string('a', AgentCatalog.MaxNewNameLength);
        await store.CreateAgentAsync(agent, [], [], None);
        var limit = PgAgentFileStore.KeyBytes - agent.Length;
        var longest = Incompressible(limit);
        await store.WriteAsync(agent, longest, new byte[] { 1 }, null, None);
        Assert.Equal([1], (await store.ReadAsync(agent, longest, None)).Bytes);
        await store.MakeDirectoryAsync(agent, Incompressible(limit - 1), None);
        var tooLong = Incompressible(limit + 1);
        var refused = await Assert.ThrowsAsync<AgentFilePathTooLongException>(() =>
            store.WriteAsync(agent, tooLong, new byte[] { 1 }, null, None)
        );
        Assert.Equal(
            $"This path is too long: {limit + 1:N0} bytes, and the limit here is {limit:N0}.",
            refused.Message
        );
        // A move or copy whose longest resulting path wouldn't fit is refused before it commits.
        var tree = "t/" + Incompressible(limit - 10);
        await store.WriteAsync(agent, tree, new byte[] { 2 }, null, None);
        await Assert.ThrowsAsync<AgentFilePathTooLongException>(() =>
            store.RenameAsync(agent, "t", "longer-name", false, None)
        );
        await Assert.ThrowsAsync<AgentFilePathTooLongException>(() =>
            store.CopyTreeAsync(agent, "t", agent, "longer-target/t", None)
        );
        Assert.NotNull(store.Stat(agent, tree));
    }

    [Fact]
    public async Task New_Agent_names_are_bounded_and_matched_whole()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var store = PostgresAgentFilesTests.Store(tenant);
        var tooLong = await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.CreateAgentAsync(new string('a', AgentCatalog.MaxNewNameLength + 1), [], [], None)
        );
        Assert.Equal("Agent names can be at most 128 characters.", tooLong.Message);
        Assert.Throws<InvalidDataException>(() => AgentCatalog.ValidateName("alpha\n"));
        Assert.Throws<InvalidDataException>(() => SessionIdentity.Build("alpha\n", "main"));
        // An existing longer name stays readable.
        AgentCatalog.ValidateName(new string('a', 200));
    }

    [Fact]
    public async Task Admission_of_a_creation_refuses_before_anything_is_committed()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var store = PostgresAgentFilesTests.Store(tenant, new AgentStoreLimits(TotalBytes: 100, Files: 1, FileBytes: 50));
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        var full = Assert.Throws<AgentStoreQuotaException>(() =>
            store.AdmitCreation("beta", ["memory"], [new("memory/MEMORY.md", [1])])
        );
        Assert.Equal("files", full.Limit);
        Assert.Throws<AgentStoreQuotaException>(() =>
            store.AdmitCreation("beta", [], [new("memory/MEMORY.md", new byte[51])])
        );
    }
}
