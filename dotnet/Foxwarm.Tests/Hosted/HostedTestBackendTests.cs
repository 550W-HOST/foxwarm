using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class HostedTestBackendTests
{
    [Fact]
    public void AReopenedRootSeesTheSameHostedStateAndMissingStoresComeFromFiles()
    {
        using var temp = new TempDirectory();
        var first = HostedTestBackend.Create(temp.Path);
        var documents = first.Documents;
        Assert.IsType<PgStateDocuments>(documents);
        documents.Open(StateDocumentName.Agents).ReplaceText("{\"a\":{}}");
        // Nothing reaches the data root.
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "agents.json")));

        var reopened = HostedTestBackend.Create(temp.Path);
        Assert.Equal("{\"a\":{}}", reopened.Documents.Open(StateDocumentName.Agents).ReadText());
        Assert.IsType<FileStateDocuments>(new FileStorageContext(temp.Path).Documents);
        // Stores without a PostgreSQL implementation yet are the file ones.
        Assert.IsNotType<PgStateDocuments>(reopened.Archive);

        using var other = new TempDirectory();
        Assert.Null(HostedTestBackend.Create(other.Path).Documents.Open(StateDocumentName.Agents).ReadText());
    }

    [Fact]
    public async Task TheSkeletonNamesEveryStoreWithoutAPostgresImplementation()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var context = new PostgresStorageContext(
            new TenantDb(database.OpenApp(), tenantId, await database.TakeLeaseAsync(tenantId)),
            Path.GetTempPath()
        );
        Assert.DoesNotContain(nameof(IStorageContext.Documents), context.Missing);
        Assert.Contains(nameof(IStorageContext.Authority), context.Missing);
        var error = Assert.Throws<NotSupportedException>(() => context.Archive);
        Assert.Contains("Archive", error.Message);
    }
}
