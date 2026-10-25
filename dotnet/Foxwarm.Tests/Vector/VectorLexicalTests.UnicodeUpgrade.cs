using System.Text.Json;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed partial class VectorLexicalTests
{
    [Fact]
    public async Task Unicode16_normalizer_index_rebuilds_through_the_owner_without_changing_authorities_or_dense_rows()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "unicode-upgrade";
        string authorityPath;
        await using (var manager = await f.ManagerAsync())
        {
            var owner = await manager.CreateNamedAsync("main", id, null, null);
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                VectorFixture.Message("violet ΑΑΣ꟎ durable ꟎꟒꟔")
            );
            await manager.ForceVectorIndexAsync(owner);
            authorityPath = owner.AuthorityStore.AuthorityPath;
        }
        var authority = await File.ReadAllTextAsync(authorityPath);
        var archive = f.Archive(id);
        var messages = archive.ReadMessages().Select(row => row.Message.ToJsonString()).ToArray();
        var denseCheckpoint = archive.VectorCheckpoint();
        var embeddingRequests = f.Peer.Requests.Count;
        async Task<string> DenseRows()
        {
            using var table = new VectorTable();
            await table.OpenAsync(f.Dense);
            return JsonSerializer.Serialize(
                await table.SearchAsync(VectorEmbeddingPeer.Embedding("violet"), null, 10)
            );
        }
        var denseRows = await DenseRows();
        var path = Path.Combine(f.Dense, "archive-search.sqlite");
        object? Scalar(string sql)
        {
            using var db = new SqliteConnection($"Data Source={path};Pooling=False");
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = sql;
            return command.ExecuteScalar();
        }
        using (var db = new SqliteConnection($"Data Source={path};Pooling=False"))
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = await File.ReadAllTextAsync(
                Path.Combine(VectorFixture.Repository(), "dotnet", "Foxwarm.Tests", "Fixtures", "archive-search-unicode16.sql")
            );
            command.ExecuteNonQuery();
        }
        Assert.Equal("1", Scalar("SELECT value FROM archive_search_metadata WHERE key='schema_version'"));
        Assert.Equal("1", Scalar("SELECT value FROM archive_search_metadata WHERE key='normalizer_version'"));
        Assert.Contains("αας꟎", Assert.IsType<string>(Scalar("SELECT index_text FROM archive_search_documents")));
        Assert.Throws<ArchiveSearchRebuildRequiredException>(() => ArchiveSearchIndex.Open(path));
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using (var runtime = new VectorRuntime(f.Data, f.Configuration(lexical: true)))
        {
            runtime.Lexical.Yield = () =>
            {
                reached.TrySetResult();
                return release.Task;
            };
            await runtime.StartAsync();
            try
            {
                await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
                var status = runtime.Lexical.Status(id);
                Assert.True(status["rebuilding"]!.GetValue<bool>());
                Assert.False(status["ready"]!.GetValue<bool>());
                Assert.True(File.Exists(path + ".next"));
                Assert.Equal("1", Scalar("SELECT value FROM archive_search_metadata WHERE key='normalizer_version'"));
                var unavailable = await runtime.Lexical.QueryAsync("ΑΑΣ꟎", 5, new(SessionIds: [id]));
                Assert.Empty(unavailable.Hits);
                Assert.False(unavailable.Lexical["ready"]!.GetValue<bool>());
                Assert.False(unavailable.Lexical["used"]!.GetValue<bool>());
                Assert.True(unavailable.Lexical["backfilling"]!.GetValue<bool>());
                Assert.Equal("ARCHIVE_SEARCH_REBUILD_REQUIRED", unavailable.Lexical["errorCode"]!.GetValue<string>());
            }
            finally
            {
                release.TrySetResult();
            }
            await runtime.WaitForStartupAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var result = await runtime.Lexical.QueryAsync("ΑΑΣ꟎", 5, new(SessionIds: [id]));
            Assert.Single(result.Hits);
            Assert.True(result.Lexical["ready"]!.GetValue<bool>());
            Assert.True(result.Lexical["used"]!.GetValue<bool>());
            Assert.Null(result.Lexical["errorCode"]);
        }
        using var reopened = ArchiveSearchIndex.Open(path);
        Assert.Single(reopened.Query("ΑΑΣ꟎", new(SessionIds: [id]), 5));
        Assert.Single(reopened.Query("αασ꟏", new(SessionIds: [id]), 5));
        Assert.Equal("1", Scalar("SELECT value FROM archive_search_metadata WHERE key='schema_version'"));
        Assert.Equal("2", Scalar("SELECT value FROM archive_search_metadata WHERE key='normalizer_version'"));
        Assert.False(File.Exists(path + ".next"));
        Assert.False(File.Exists(path + ".bak"));
        Assert.Equal(authority, await File.ReadAllTextAsync(authorityPath));
        Assert.Equal(messages, archive.ReadMessages().Select(row => row.Message.ToJsonString()));
        Assert.Equal(denseCheckpoint, archive.VectorCheckpoint());
        Assert.Equal(denseRows, await DenseRows());
        Assert.Equal(embeddingRequests, f.Peer.Requests.Count);
    }
}
