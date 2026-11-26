using Foxwarm.Sessions;
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
        // Authority, Archive and Identities always come from the same side.
        var fileAuthority = reopened.Authority is FileSessionAuthorityBackend;
        Assert.Equal(fileAuthority, reopened.Archive is SqliteArchiveStore);
        Assert.Equal(fileAuthority, reopened.Identities is FileIdentityLedger);

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
        // Each store still without a PostgreSQL implementation is named and refuses access.
        foreach (var name in context.Missing)
        {
            var property = typeof(IStorageContext).GetProperty(name)!;
            var error = Assert.Throws<System.Reflection.TargetInvocationException>(() =>
                property.GetValue(context)
            );
            Assert.IsType<NotSupportedException>(error.InnerException);
            Assert.Contains(name, error.InnerException!.Message);
        }
    }
}
