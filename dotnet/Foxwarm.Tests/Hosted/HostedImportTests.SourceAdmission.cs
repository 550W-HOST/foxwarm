using Foxwarm.Hosted.Import;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedImportTests
{
    [Theory]
    [InlineData("models.yaml")]
    [InlineData("catalog.sqlite")]
    [InlineData("archive-store.sqlite-wal")]
    [InlineData("artifacts/example")]
    public async Task DryRunRefusesLinksOutsideTheOfflineCopy(string name)
    {
        if (OperatingSystem.IsWindows()) return;
        var root = CopyFixture("source");
        var path = Path.Combine(root, "state", name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var target = Path.Combine(temp.Path, "outside");
        if (File.Exists(path)) File.Move(path, target);
        else File.WriteAllBytes(target, []);
        File.CreateSymbolicLink(path, target);
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "preview", Reports, dryRun: true);
        Assert.Equal(HostedImport.Refused, result.Exit);
        Assert.Contains("a link that points outside it", result.Report["refusals"]!.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ImportRefusesUnresolvableFilesAndDirectoryCycles(bool cycle)
    {
        if (OperatingSystem.IsWindows()) return;
        var root = CopyFixture("source");
        var folder = Path.Combine(root, "state", "artifacts");
        var link = Path.Combine(folder, "linked");
        if (cycle) Directory.CreateSymbolicLink(link, folder);
        else File.CreateSymbolicLink(link, Path.Combine(folder, "missing"));
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "preview", Reports, dryRun: true);
        Assert.Equal(HostedImport.Refused, result.Exit);
        Assert.Contains(cycle ? "directory cycle" : "cannot be resolved", result.Report["refusals"]!.ToJsonString());
    }

    [Fact]
    public async Task ImportReadsAnInternalStateDirectoryLink()
    {
        if (OperatingSystem.IsWindows()) return;
        var root = CopyFixture("source");
        var state = Path.Combine(root, "state");
        Directory.Move(state, Path.Combine(root, "snapshot"));
        Directory.CreateSymbolicLink(state, "snapshot");
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "internal", Reports);
        Assert.True(result.Exit == HostedImport.Imported, result.Report.ToJsonString());
    }

    [Fact]
    public async Task DryRunChecksSourceIdentityRangesAcrossStores()
    {
        var root = CopyFixture("range");
        foreach (var (file, table, column) in new[] {
            ("tasks.sqlite", "task_notes", "id"),
            ("llm-request-journal.sqlite", "llm_journal_attempt_results", "rowid"),
        })
        {
            using var copy = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "state", file), Pooling = false }.ToString());
            copy.Open();
            using var cmd = copy.CreateCommand();
            var value = column == "rowid" ? -1L : long.MaxValue / 2 + 1;
            cmd.CommandText = $"UPDATE {table} SET {column}=$value WHERE rowid=(SELECT min(rowid) FROM {table})";
            cmd.Parameters.AddWithValue("$value", value);
            Assert.Equal(1, cmd.ExecuteNonQuery());
        }
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "ranges", Reports, dryRun: true);
        Assert.Equal(HostedImport.Refused, result.Exit);
        var errors = result.Report["refusals"]!.ToJsonString();
        Assert.Contains("task_notes.id", errors);
        Assert.Contains("llm_journal_attempt_results.seq", errors);
        Assert.Null(await TenantStateAsync(database, "ranges"));
    }
}
