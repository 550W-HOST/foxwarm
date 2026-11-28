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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LinkedDatabaseVerifiesTheOnlyCommittedRowFromItsPhysicalWal(bool omitHostedRow)
    {
        if (OperatingSystem.IsWindows()) return;
        var root = CopyFixture("offline");
        var logical = Path.Combine(root, "state", "tasks.sqlite");
        var physical = Path.Combine(Directory.CreateDirectory(Path.Combine(root, "stores")).FullName, "tasks.db");
        var original = Path.Combine(temp.Path, "writer.db");
        File.Move(logical, original);
        File.CreateSymbolicLink(logical, physical);
        using (var writer = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = original, Pooling = false }.ToString()))
        {
            writer.Open();
            using var cmd = writer.CreateCommand();
            cmd.CommandText = "PRAGMA journal_mode=WAL; DELETE FROM task_notes; PRAGMA wal_checkpoint(TRUNCATE)";
            cmd.ExecuteNonQuery();
            cmd.CommandText = "PRAGMA wal_autocheckpoint=0; INSERT INTO task_notes(taskId,text,createdAt) SELECT id,'wal-only',1 FROM tasks LIMIT 1";
            cmd.ExecuteNonQuery();
            cmd.CommandText = "SELECT count(*) FROM task_notes";
            Assert.Equal(1L, cmd.ExecuteScalar());
            // Make a stopped copy before closing the writer checkpoints its last connection.
            foreach (var suffix in new[] { "", "-wal", "-shm" })
                File.Copy(original + suffix, physical + suffix);
        }
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        // Simulate a writer that accepts the INSERT but fails to retain the only row.
        // Without the WAL in the source view, verification would compare zero against zero.
        if (omitHostedRow)
            await database.ExecuteOwnerAsync("CREATE FUNCTION omit_note() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$; CREATE TRIGGER omit_note BEFORE INSERT ON task_notes FOR EACH ROW EXECUTE FUNCTION omit_note()");
        var result = await RunAsync(database, root, "linked", Reports);
        Assert.Equal(omitHostedRow ? HostedImport.Failed : HostedImport.Imported, result.Exit);
        var notes = result.Report["verification"]!["tables"]!.AsArray().Single(row => row!["table"]!.ToString() == "task_notes")!;
        Assert.Equal(1L, notes["sourceRows"]!.GetValue<long>());
        Assert.Equal(omitHostedRow ? 0L : 1L, notes["importedRows"]!.GetValue<long>());
        Assert.Equal(!omitHostedRow, notes["equal"]!.GetValue<bool>());
        Assert.Equal(omitHostedRow ? 0L : 1L, await database.ScalarAsync("SELECT count(*) FROM task_notes WHERE text='wal-only'"));
        Assert.Equal(omitHostedRow ? "importing" : "active", await TenantStateAsync(database, "linked"));
    }

    [Theory]
    [InlineData("-shm")]
    [InlineData("-wal")]
    public async Task AmbiguousLinkedSidecarsAreRefused(string suffix)
    {
        if (OperatingSystem.IsWindows()) return;
        var root = CopyFixture("offline");
        var logical = Path.Combine(root, "state", "tasks.sqlite");
        var physical = Path.Combine(root, "original.db");
        File.Move(logical, physical);
        File.CreateSymbolicLink(logical, physical);
        File.WriteAllBytes(logical + suffix, []);
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "ambiguous", Reports);
        Assert.Equal(HostedImport.Refused, result.Exit);
        Assert.Contains("conflicting SQLite sidecars", result.Report["refusals"]!.ToJsonString());
        Assert.Null(await TenantStateAsync(database, "ambiguous"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingRollbackJournalRefusesBeforeCopyButAnInvalidatedJournalDoesNot(bool hot)
    {
        var root = CopyFixture("offline");
        var journal = new byte[4096];
        if (hot) new byte[] { 0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7 }.CopyTo(journal, 0);
        File.WriteAllBytes(Path.Combine(root, "state", "tasks.sqlite-journal"), journal);
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var result = await RunAsync(database, root, "rollback", Reports, dryRun: true);
        Assert.Equal(hot ? HostedImport.Refused : HostedImport.Imported, result.Exit);
        if (hot) Assert.Contains("unfinished SQLite transaction", result.Report["refusals"]!.ToJsonString());
        Assert.Null(await TenantStateAsync(database, "rollback"));
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
