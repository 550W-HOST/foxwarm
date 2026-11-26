using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// Observable behavior every <see cref="IStateDocuments"/> implementation shares. File-only
/// rules (paths, modes, parent checks, retained backups) stay in <see cref="StateDocumentsTests"/>.
/// </summary>
public abstract class StateDocumentsContractTests
{
    private protected abstract Task<StoreUnderTest> CreateAsync();

    private protected sealed class StoreUnderTest(IStateDocuments documents, Func<ValueTask> dispose)
        : IAsyncDisposable
    {
        internal IStateDocuments Documents { get; } = documents;

        public ValueTask DisposeAsync() => dispose();
    }

    [Fact]
    public async Task Every_document_reads_absent_then_returns_the_latest_text()
    {
        await using var store = await CreateAsync();
        foreach (var name in Enum.GetValues<StateDocumentName>())
        {
            var document = store.Documents.Open(name);
            Assert.False(document.Exists());
            Assert.Null(document.ReadText());
            Assert.Null(await document.ReadTextAsync());
            Assert.Null(document.ReadFirstAvailable(text => text, out var source));
            Assert.Null(source);
            var first = "{\"name\":\"" + name + "\",\"text\":\"Grüße 🦊\"}";
            document.ReplaceText(first);
            Assert.True(document.Exists());
            Assert.Equal(first, store.Documents.Open(name).ReadText());
            var second = "{\"name\":\"" + name + "\",\"version\":2}\n";
            document.ReplaceText(second);
            Assert.Equal(second, await store.Documents.Open(name).ReadTextAsync());
            Assert.Equal(second, document.ReadFirstAvailable(text => text, out source));
            Assert.Equal(document.Locator, source);
            document.EnsureDurable();
        }
    }

    [Fact]
    public async Task Documents_are_independent()
    {
        await using var store = await CreateAsync();
        store.Documents.Open(StateDocumentName.Agents).ReplaceText("{\"a\":1}");
        Assert.Null(store.Documents.Open(StateDocumentName.Installation).ReadText());
        Assert.NotEqual(
            store.Documents.Open(StateDocumentName.Agents).Locator,
            store.Documents.Open(StateDocumentName.Installation).Locator
        );
    }

    [Fact]
    public async Task An_unparseable_current_document_without_earlier_versions_rethrows()
    {
        await using var store = await CreateAsync();
        var document = store.Documents.Open(StateDocumentName.Agents);
        document.ReplaceText("{broken");
        Assert.ThrowsAny<System.Text.Json.JsonException>(() =>
            document.ReadFirstAvailable(text => JsonNode.Parse(text)!.AsObject(), out _)
        );
    }

    [Fact]
    public async Task A_cancelled_replacement_keeps_the_previous_text()
    {
        await using var store = await CreateAsync();
        var document = store.Documents.Open(StateDocumentName.Channels);
        document.ReplaceText("{\"v\":1}");
        Assert.ThrowsAny<OperationCanceledException>(() =>
            document.ReplaceText("{\"v\":2}", new CancellationToken(true))
        );
        Assert.Equal("{\"v\":1}", document.ReadText());
    }
}

public sealed class FileStateDocumentsContractTests : StateDocumentsContractTests
{
    private protected override Task<StoreUnderTest> CreateAsync()
    {
        var temp = new TempDirectory();
        return Task.FromResult(
            new StoreUnderTest(
                new FileStateDocuments(temp.Path),
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
public sealed class PostgresStateDocumentsContractTests : StateDocumentsContractTests
{
    private protected override async Task<StoreUnderTest> CreateAsync()
    {
        var (database, tenant) = await OpenAsync();
        return new StoreUnderTest(new PgStateDocuments(tenant), database.DisposeAsync);
    }

    private static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    [Fact]
    public async Task Installation_writes_raise_the_tenant_reader_version_and_never_lower_it()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var installation = new PgStateDocuments(tenant).Open(StateDocumentName.Installation);
        async Task<int> Level() =>
            (int)(await database.ScalarAsync(
                "SELECT min_reader_version FROM tenants WHERE tenant_id = $1",
                tenant.TenantId
            ))!;
        installation.ReplaceText("{}");
        Assert.Equal(0, await Level());
        installation.ReplaceText("{\"minimumReaderVersion\":2}");
        Assert.Equal(2, await Level());
        installation.ReplaceText("{\"minimumReaderVersion\":1}");
        Assert.Equal(2, await Level());
        // Other documents never touch it.
        new PgStateDocuments(tenant).Open(StateDocumentName.Agents).ReplaceText("{\"minimumReaderVersion\":9}");
        Assert.Equal(2, await Level());
    }

    [Fact]
    public async Task A_fenced_replacement_keeps_the_previous_text()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var document = new PgStateDocuments(tenant).Open(StateDocumentName.Timers);
        document.ReplaceText("{\"v\":1}");
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        Assert.Throws<TenantFencedException>(() => document.ReplaceText("{\"v\":2}"));
        Assert.Equal("{\"v\":1}", document.ReadText());
    }
}
