using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorLifecycleTests
{
    [Fact]
    public async Task Failed_fork_compensates_only_its_derived_lifetime_while_clear_and_deletion_retain_committed_sources()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync(lexical: true);
        var source = await manager.CreateNamedAsync("main", "retained", null, null);
        await ForkClearLifecycleTests.AppendAsync(source, VectorFixture.Message("violet retained committed source"));
        await manager.ForceVectorIndexAsync(source);
        const string rejected = "retained_rejected";
        var faults = Path.Combine(f.Data, "state", "experiment-faults");
        Directory.CreateDirectory(faults);
        await File.WriteAllTextAsync(Path.Combine(faults, SessionIdentity.ExecDirectorySegment(rejected) + ".create-before-rename"), "once");
        await Assert.ThrowsAsync<IOException>(() => manager.ForkAsync(source, "rejected"));
        Assert.Null(manager.Catalog.Get(rejected));
        Assert.Null(f.Archive(rejected).ReadBranch());
        using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = f.Database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM archive_checkpoints WHERE session_id=$id";
            command.Parameters.AddWithValue("$id", rejected);
            Assert.Equal(0L, command.ExecuteScalar());
        }
        Assert.Empty((await manager.Vector.SearchAsync("violet", 5, new(SessionIds: [rejected]))).Hits);
        Assert.Contains("retained committed source", (await manager.SearchVectorHistoryAsync("violet", 5, null, null)).ToJsonString());
        await manager.ClearAsync(source);
        Assert.Empty(source.Entry.Snapshot().History);
        Assert.Contains("retained committed source", (await manager.SearchVectorHistoryAsync("violet", 5, null, null)).ToJsonString());
        await manager.DeleteAsync(source.Id);
        Assert.Null(manager.Catalog.Get(source.Id));
        Assert.Single(manager.ArchiveReader(source.Id).ReadMessages());
        Assert.Contains("retained committed source", (await manager.SearchVectorHistoryAsync("violet", 5, null, null)).ToJsonString());
    }
}
