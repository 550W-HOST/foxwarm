using System.Security.Cryptography;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

[Trait("Backend", "postgres")]
public sealed class AgentBlobReservationTests
{
    [Fact]
    public async Task Collection_joins_only_local_references_and_leaves_sibling_and_image_bytes_alone()
    {
        var (db, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = db;
        await SchemaMigrator.MigrateAsync(db.OpenOwner(), PostgresServer.AppRole, PostgresServer.OperatorRole, "sibling");
        var siblingId = await db.TenantIdAsync("sibling");
        var sibling = new TenantDb(db.OpenApp(), siblingId, await db.TakeLeaseAsync(siblingId));
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        var limits = new AgentStoreLimits(bytes.Length, 10, bytes.Length);
        var first = PostgresAgentFilesTests.Store(tenant, limits);
        var other = PostgresAgentFilesTests.Store(sibling, limits);
        await first.WriteAsync(null, "file", bytes, null, default);
        await other.WriteAsync(null, "file", bytes, null, default);
        var key = PgAgentFileStore.BlobKey("", SHA256.HashData(bytes));
        var images = new PgBlobStore(tenant, "images");
        await images.CreateAsync(key, bytes, true, default);
        await first.WriteAsync(null, "file", RandomNumberGenerator.GetBytes(bytes.Length), null, default);
        await first.WriteAsync(null, "file", RandomNumberGenerator.GetBytes(bytes.Length), null, default);
        Assert.Equal(bytes, (await other.ReadAsync(null, "file", default)).Bytes);
        Assert.Equal(bytes, await images.ReadAllAsync(key, default));
        Assert.Null(tenant.Read(tx => tx.Scalar("SELECT 1 FROM agent_blob_reservations WHERE object_key=$1", key)));
        Assert.Equal(1, sibling.Read(tx => tx.Scalar("SELECT 1 FROM agent_blob_reservations WHERE object_key=$1", key)));
        Assert.True(tenant.Read(tx => tx.Scalar("""
            SELECT NOT has_table_privilege(current_user,'blob_objects','DELETE')
                AND NOT has_function_privilege(current_user,'foxwarm_agent_gc_finish(text,text)','EXECUTE')
                AND has_function_privilege(current_user,'foxwarm_collect_agent_pg(numeric)','EXECUTE')
            """) is true));
    }

    [Fact]
    public async Task Pressure_collects_only_unreferenced_Postgres_payloads()
    {
        var (db, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = db;
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        var store = PostgresAgentFilesTests.Store(tenant, new(bytes.Length, 10, bytes.Length));
        for (byte edit = 0; edit < 3; ++edit)
        {
            bytes[0] = edit;
            await store.WriteAsync(null, "document", bytes, null, default);
        }
        Assert.Equal(bytes, (await store.ReadAsync(null, "document", default)).Bytes);
        Assert.Equal(2L, await db.ScalarAsync("SELECT count(*) FROM blob_objects WHERE store='agent-files'"));
        Assert.Equal(2L, await db.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
        Assert.Equal(2L, await db.ScalarAsync("SELECT count(*) FROM blob_chunks WHERE store='agent-files'"));
    }

    [Fact]
    public async Task Ledger_migration_applies_after_the_previous_operator_head()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync(migrated: false);
        var owner = db.OpenOwner();
        var previous = SchemaMigrator.Embedded.Where(m => m.Version is not (1102 or 1103)).ToArray();
        await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, null, previous);
        Assert.True(previous.Any(m => m.Version == 1201));
        var applied = await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, null);
        Assert.Equal(new[] { 1102, 1103 }, applied.Select(m => m.Version));
    }

    [Fact]
    public async Task Initial_files_share_a_reservation_and_historical_bytes_are_charged_before_admission()
    {
        var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
        await using var _ = database;
        var bytes = new byte[PgAgentFileStore.InlineBytes + 1];
        var blobs = new PgBlobStore(tenant, PgAgentFileStore.BlobStoreName);
        await blobs.CreateAsync("old/body", bytes, true, default);
        var store = new PgAgentFileStore(tenant, blobs, () => new(2L * bytes.Length, 4, bytes.Length));
        await store.CreateAgentAsync("one", [], [new("a", bytes), new("b", bytes)], default);
        Assert.Equal(2L, await database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
        Assert.Equal(2L * bytes.Length, store.Usage().Bytes);
        Assert.Equal(2L * bytes.Length, await blobs.StoredBytesAsync(default));
        await database.TakeLeaseAsync(tenant.TenantId);
        await Assert.ThrowsAsync<TenantFencedException>(() => store.WriteAsync("one", "a", RandomNumberGenerator.GetBytes(bytes.Length), null, default));
        Assert.Equal(2L, await database.ScalarAsync("SELECT count(*) FROM agent_blob_reservations"));
    }
}
