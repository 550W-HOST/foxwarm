using System.Security.Cryptography;
using System.Text;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// The hosted Agent store beyond the shared contract: inline and blob content, the Agent
/// lifecycle rows, the tenant limits at write admission (§7.2, the §11 quota case), fencing of
/// every write, tenant separation and generation uniqueness.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresAgentFilesTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    internal static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    internal static PgAgentFileStore Store(TenantDb tenant, AgentStoreLimits? limits = null) =>
        new(tenant, new PgBlobStore(tenant, PgAgentFileStore.BlobStoreName), limits is null ? null : () => limits);

    private static async Task<string> SnapshotAsync(HostedTestDatabase database) =>
        (string?)await database.ScalarAsync(
            "SELECT coalesce(string_agg(agent || ':' || path || ':' || kind || ':' || size || ':' || generation, ',' ORDER BY agent, path), '')"
                + " || '|' || coalesce((SELECT bytes || '/' || entries FROM agent_file_usage), '')"
                + " FROM agent_files"
        ) ?? "";

    private static async Task<(long Bytes, long Entries)> MeasuredAsync(HostedTestDatabase database)
    {
        var text = (string)(await database.ScalarAsync(
            "SELECT coalesce(sum(size), 0)::text || '/' || count(*)::text FROM agent_files WHERE path <> ''"
        ))!;
        var parts = text.Split('/');
        return (long.Parse(parts[0]), long.Parse(parts[1]));
    }

    [Fact]
    public async Task Content_above_256_KiB_is_a_blob_written_before_its_row()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        var inline = RandomNumberGenerator.GetBytes(PgAgentFileStore.InlineBytes);
        var large = RandomNumberGenerator.GetBytes(PgAgentFileStore.InlineBytes + 1);
        await store.WriteAsync("alpha", "docs/inline.bin", inline, null, None);
        await store.WriteAsync("alpha", "docs/large.bin", large, null, None);
        Assert.Equal(inline, (await store.ReadAsync("alpha", "docs/inline.bin", None)).Bytes);
        Assert.Equal(large, (await store.ReadAsync("alpha", "docs/large.bin", None)).Bytes);
        Assert.Equal(
            "inline.bin:t:f,large.bin:f:t",
            await database.ScalarAsync(
                "SELECT string_agg(substr(path, 6) || ':' || (inline IS NOT NULL)::text || ':' || (blob_key IS NOT NULL)::text, ',' ORDER BY path)"
                    + " FROM agent_files WHERE kind = 'file'"
            ) is string text ? text.Replace("true", "t").Replace("false", "f") : null
        );
        var key = PgAgentFileStore.BlobKey("alpha", SHA256.HashData(large));
        Assert.Equal(key, await database.ScalarAsync("SELECT blob_key FROM agent_files WHERE path = 'docs/large.bin'"));
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM blob_objects WHERE store = 'agent-files' AND key = $1", key));
        // The same content again reuses the blob.
        await store.WriteAsync("alpha", "docs/copy.bin", large, null, None);
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM blob_objects WHERE store = 'agent-files'"));
        // A blob whose bytes don't match the row is refused, not returned.
        await database.ScalarAsync(
            "SET session_replication_role = replica;"
                + " UPDATE agent_files SET sha256 = '\\x00'::bytea WHERE path = 'docs/copy.bin'"
        );
        await Assert.ThrowsAsync<IOException>(() => store.ReadAsync("alpha", "docs/copy.bin", None));
    }

    [Fact]
    public async Task The_lifecycle_creates_and_deletes_an_Agent_with_its_rows()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant);
        await store.CreateAgentAsync(
            "alpha",
            ["memory", "docs/empty"],
            [new("memory/MEMORY.md", Encoding.UTF8.GetBytes("hello")), new("memory/SOUL.md", Encoding.UTF8.GetBytes("soul"))],
            None
        );
        await store.CreateAgentAsync("beta", ["memory"], [], None);
        Assert.Equal(["alpha", "beta"], store.Agents());
        Assert.True(store.AgentExists("alpha"));
        Assert.Equal(["MEMORY.md", "SOUL.md"], store.List("alpha", "memory").Select(entry => entry.Name));
        Assert.True(store.Stat("alpha", "docs/empty")!.IsDirectory);
        Assert.True(store.Stat("beta", "memory")!.IsDirectory);
        await Assert.ThrowsAsync<AgentFileConflictException>(() => store.CreateAgentAsync("alpha", [], [], None));
        Assert.Equal((9L, 4L), store.Usage());
        await store.DeleteAgentAsync("alpha", None);
        Assert.Equal(["beta"], store.Agents());
        Assert.Null(store.Stat("alpha", "memory/MEMORY.md"));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM agent_files WHERE agent = 'alpha'"));
        Assert.Equal((0L, 1L), store.Usage());
        await store.DeleteAgentAsync("alpha", None);
    }

    [Fact]
    public async Task Usage_follows_every_write_and_matches_the_rows()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        await store.WriteAsync("alpha", "memory/MEMORY.md", new byte[10], null, None);
        await store.WriteAsync("alpha", "memory/MEMORY.md", new byte[4], null, None);
        await store.WriteAsync("alpha", "docs/a/b.md", new byte[3], null, None);
        await store.MakeDirectoryAsync("alpha", "docs/empty", None);
        await store.RenameAsync("alpha", "docs/a/b.md", "docs/c.md", false, None);
        await store.WriteAsync("alpha", "docs/d.md", new byte[7], null, None);
        await store.RenameAsync("alpha", "docs/d.md", "docs/c.md", true, None);
        await store.DeleteAsync("alpha", "docs/empty", false, null, None);
        await store.WriteAsync(null, "00_SYSTEM.local.md", new byte[2], null, None);
        Assert.Equal(await MeasuredAsync(database), store.Usage());
        await store.DeleteAsync("alpha", "docs", true, null, None);
        Assert.Equal(await MeasuredAsync(database), store.Usage());
    }

    [Fact]
    public async Task Generations_are_never_reused_for_a_path()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        var first = await store.WriteAsync("alpha", "memory/A.md", "x"u8.ToArray(), null, None);
        await store.DeleteAsync("alpha", "memory/A.md", false, null, None);
        var second = await store.WriteAsync("alpha", "memory/A.md", "x"u8.ToArray(), null, None);
        Assert.True(second > first);
        await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            store.WriteAsync("alpha", "memory/A.md", "y"u8.ToArray(), first, None)
        );
    }

    [Fact]
    public async Task Limits_refuse_growth_at_admission_and_allow_shrinking()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var limits = new AgentStoreLimits(TotalBytes: 1000, Files: 5, FileBytes: 600);
        var store = Store(tenant, limits);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        var tooLarge = await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.WriteAsync("alpha", "docs/big.bin", new byte[601], null, None)
        );
        Assert.Equal("fileBytes", tooLarge.Limit);
        await store.WriteAsync("alpha", "docs/a.bin", new byte[600], null, None);
        var full = await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.WriteAsync("alpha", "docs/b.bin", new byte[401], null, None)
        );
        Assert.Equal("totalBytes", full.Limit);
        await store.WriteAsync("alpha", "docs/b.bin", new byte[400], null, None);
        // The Agent's empty memory directory is an entry too.
        Assert.Equal((1000L, 3L), store.Usage());
        // Replacing with the same size or less is admitted at the limit.
        await store.WriteAsync("alpha", "docs/a.bin", new byte[600], null, None);
        await store.WriteAsync("alpha", "docs/a.bin", new byte[100], null, None);
        await store.WriteAsync("alpha", "docs/c.bin", new byte[0], null, None);
        await store.MakeDirectoryAsync("alpha", "docs/empty", None);
        var count = await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.WriteAsync("alpha", "docs/d.bin", new byte[0], null, None)
        );
        Assert.Equal("files", count.Limit);
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() => store.MakeDirectoryAsync("alpha", "more", None));
        // Filling the empty directory doesn't add an entry.
        await store.WriteAsync("alpha", "docs/empty/e.bin", new byte[0], null, None);
        Assert.Null(store.Stat("alpha", "docs/d.bin"));
        Assert.Equal(await MeasuredAsync(database), store.Usage());
        // Every refused write left nothing, not even the blob of the oversized file.
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM blob_objects"));
        // A tenant over a lowered limit can still delete.
        var lowered = Store(tenant, new AgentStoreLimits(5, 1, 10));
        await lowered.DeleteAsync("alpha", "docs/b.bin", false, null, None);
        await lowered.WriteAsync("alpha", "docs/a.bin", new byte[5], null, None);
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() => lowered.WriteAsync("alpha", "docs/a.bin", new byte[6], null, None));
    }

    [Fact]
    public async Task Initial_files_count_against_the_limits()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant, new AgentStoreLimits(10, 2, 10));
        await Assert.ThrowsAsync<AgentStoreQuotaException>(() =>
            store.CreateAgentAsync("alpha", [], [new("a", new byte[6]), new("b", new byte[6])], None)
        );
        Assert.False(store.AgentExists("alpha"));
        Assert.Equal("|", await SnapshotAsync(database));
    }

    public static TheoryData<string> Writes() =>
        new() { "write", "conditional", "large", "delete", "deleteTree", "rename", "renameTree", "mkdir", "createAgent", "largeAgent", "deleteAgent", "clearAgent" };

    [Theory]
    [MemberData(nameof(Writes))]
    public async Task Every_write_fails_after_an_epoch_bump_and_leaves_nothing(string operation)
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var store = Store(tenant);
        await store.CreateAgentAsync("alpha", ["memory"], [], None);
        var generation = await store.WriteAsync("alpha", "docs/a.md", "a"u8.ToArray(), null, None);
        await store.WriteAsync("alpha", "docs/tree/b.md", "b"u8.ToArray(), null, None);
        var before = await SnapshotAsync(database);
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        Task attempt = operation switch
        {
            "write" => store.WriteAsync("alpha", "docs/new.md", "n"u8.ToArray(), null, None),
            "conditional" => store.WriteAsync("alpha", "docs/a.md", "n"u8.ToArray(), generation, None),
            "large" => store.WriteAsync("alpha", "docs/large.bin", new byte[PgAgentFileStore.InlineBytes + 1], null, None),
            "delete" => store.DeleteAsync("alpha", "docs/a.md", false, null, None),
            "deleteTree" => store.DeleteAsync("alpha", "docs", true, null, None),
            "rename" => store.RenameAsync("alpha", "docs/a.md", "docs/z.md", false, None),
            "renameTree" => store.RenameAsync("alpha", "docs", "moved", false, None),
            "mkdir" => store.MakeDirectoryAsync("alpha", "docs/empty", None),
            "createAgent" => store.CreateAgentAsync("beta", ["memory"], [new("memory/MEMORY.md", "m"u8.ToArray())], None),
            "largeAgent" => store.CreateAgentAsync("beta", [], [new("big.bin", new byte[PgAgentFileStore.InlineBytes + 1])], None),
            "deleteAgent" => store.DeleteAgentAsync("alpha", None),
            "clearAgent" => store.ClearAgentAsync("alpha", None),
            _ => throw new ArgumentOutOfRangeException(nameof(operation)),
        };
        await Assert.ThrowsAsync<TenantFencedException>(() => attempt);
        Assert.Equal(before, await SnapshotAsync(database));
    }

    [Fact]
    public async Task Tenants_see_only_their_own_files()
    {
        var (database, alpha) = await OpenAsync();
        await using var _ = database;
        await database.ExecuteOwnerAsync(
            "INSERT INTO tenants (name) VALUES ('beta');"
                + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = 'beta'"
        );
        var betaId = await database.TenantIdAsync("beta");
        var beta = new TenantDb(database.OpenApp(), betaId, await database.TakeLeaseAsync(betaId));
        var alphaStore = Store(alpha);
        var betaStore = Store(beta);
        await alphaStore.CreateAgentAsync("main", ["memory"], [new("memory/MEMORY.md", "alpha"u8.ToArray())], None);
        Assert.False(betaStore.AgentExists("main"));
        Assert.Null(betaStore.Stat("main", "memory/MEMORY.md"));
        Assert.Empty(betaStore.List("main", "memory"));
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            betaStore.WriteAsync("main", "memory/MEMORY.md", "beta"u8.ToArray(), null, None)
        );
        // The same Agent name in the other tenant is a different Agent.
        await betaStore.CreateAgentAsync("main", ["memory"], [new("memory/MEMORY.md", "beta"u8.ToArray())], None);
        Assert.Equal("alpha", await alphaStore.ReadTextAsync("main", "memory/MEMORY.md", None));
        Assert.Equal("beta", await betaStore.ReadTextAsync("main", "memory/MEMORY.md", None));
        Assert.Equal((5L, 1L), alphaStore.Usage());
        Assert.Equal((4L, 1L), betaStore.Usage());
    }
}
