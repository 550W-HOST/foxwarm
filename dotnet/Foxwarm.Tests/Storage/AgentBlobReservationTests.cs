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
    public async Task Ledger_migration_applies_after_the_previous_operator_head()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync(migrated: false);
        var owner = db.OpenOwner();
        var previous = SchemaMigrator.Embedded.Where(m => m.Version != 1102).ToArray();
        await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, null, previous);
        Assert.True(previous.Any(m => m.Version == 1201));
        var applied = await SchemaMigrator.MigrateAsync(owner, PostgresServer.AppRole, PostgresServer.OperatorRole, null);
        Assert.Equal(1102, Assert.Single(applied).Version);
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
