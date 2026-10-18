using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class CliArchiveMigrationTests
{
    private static string Repository =>
        Path.GetFullPath("../../../../../", AppContext.BaseDirectory);

    [Fact]
    public async Task Source_legacy_fork_and_journal_migrate_and_export_to_real_Source_consumers()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        var publicExport = Path.Combine(temp.Path, "public-export");
        var summary = await PublicArchive(root, publicExport);
        Assert.Equal(
            fixture["expected"]!["records"]!.GetValue<int>(),
            summary["sessions"]!["records"]!.GetValue<int>()
        );
        Assert.False(File.Exists(Path.Combine(root, "state/llm-request-journal.jsonl")));
        var manifest = JsonNode.Parse(File.ReadAllText(Manifest(root)))!;
        Assert.Equal(5, manifest["files"]!.AsArray().Count);
        Assert.All(
            manifest["files"]!.AsArray(),
            file => Assert.True(file!["moved"]!.GetValue<bool>())
        );
        var child = fixture["childId"]!.GetValue<string>();
        var branch = new SqliteArchiveMessageStore(Database(root), child).ReadBranch()!;
        Assert.Equal(fixture["parentId"]!.GetValue<string>(), branch.ParentSessionId);
        Assert.Equal(2, branch.MessageCap);
        Assert.Equal(1, branch.BlockCap);
        var export = Path.Combine(temp.Path, "export");
        var counts = await SqliteArchiveMessageStore.ExportJsonlAsync(
            Database(root),
            Path.Combine(export, "sessions")
        );
        Assert.Equal(3, counts.Files);
        Assert.Equal(fixture["expected"]!["records"]!.GetValue<int>(), counts.Records);
        await using (var journal = new LlmRequestJournalStore(root))
            Assert.True(
                await journal.ExportJsonlAsync(Path.Combine(export, "llm-request-journal.jsonl"))
                    > 0
            );
        var verification = Path.Combine(temp.Path, "source-reader");
        Directory.CreateDirectory(verification);
        File.Copy(Path.Combine(root, "fixture.json"), Path.Combine(verification, "fixture.json"));
        var verified = await Source("verify", verification, export);
        Assert.Equal("complete", verified["journal"]!.GetValue<string>());
        // Reopening already-completed authority neither remigrates nor rewrites its manifest.
        var before = File.ReadAllText(Manifest(root));
        await Migrate(root);
        Assert.Equal(before, File.ReadAllText(Manifest(root)));
    }

    [Fact]
    public async Task Structural_failure_precedes_archive_mutation_and_preexisting_rows_win_like_Source()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        var parent = fixture["parentId"]!.GetValue<string>();
        var blockPath = Path.Combine(root, "state/logs/sessions", parent + ".blocks.jsonl");
        var valid = File.ReadAllText(blockPath);
        await File.AppendAllTextAsync(blockPath, "{malformed}\n");
        await Assert.ThrowsAsync<InvalidDataException>(() => Migrate(root));
        Assert.False(File.Exists(Path.Combine(root, "state/session-id-reservations.jsonl")));
        Assert.Equal(0, Count(root, "archive_branches"));
        Assert.True(File.Exists(blockPath));
        await File.WriteAllTextAsync(blockPath, valid);
        var existing = new SqliteArchiveMessageStore(Database(root), parent);
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject { ["text"] = "Preexisting SQLite authority wins" }
            ),
            ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1001 },
        };
        existing.WriteMessages([ArchiveMessageRecord.Create(parent, "main", 1, 1001, message)]);
        await Migrate(root);
        Assert.Equal(
            "Preexisting SQLite authority wins",
            existing.ReadMessageBySeq(1)!.Message["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task New_conflicting_duplicates_fail_without_moving_sources_then_retry_keeps_committed_rows()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        var file = Path.Combine(root, "state/logs/sessions", fixture["parentId"] + ".jsonl");
        var original = File.ReadAllText(file);
        var duplicate = JsonNode.Parse(original.Split('\n')[0])!;
        duplicate["message"]!["parts"]![0]!["text"] = "Divergent new legacy duplicate";
        await File.AppendAllTextAsync(file, duplicate.ToJsonString() + "\n");
        await Assert.ThrowsAsync<InvalidDataException>(() => Migrate(root));
        Assert.False(File.Exists(Manifest(root)));
        Assert.True(File.Exists(file));
        await File.WriteAllTextAsync(file, original);
        await Migrate(root);
        Assert.Equal(fixture["messages"]!.GetValue<int>(), Count(root, "archive_messages"));
    }

    [Fact]
    public async Task Interrupted_joint_moves_restore_verify_and_resume_and_missing_completed_authority_fails()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        await Migrate(root);
        var versionPath = Path.Combine(root, "state/migrationVersion.json");
        File.Delete(versionPath); // Process stopped after the joint backup moves, before the version publication.
        var first = JsonNode.Parse(File.ReadAllText(Manifest(root)))!["files"]![0]!;
        var relative = first["relativeStatePath"]!.GetValue<string>();
        var backup = Path.Combine(Path.GetDirectoryName(Manifest(root))!, relative);
        var original = File.ReadAllText(backup);
        File.AppendAllText(backup, "changed backup");
        await Assert.ThrowsAsync<InvalidDataException>(() => Migrate(root));
        File.WriteAllText(backup, original);
        var active = Path.Combine(root, "state", relative);
        Directory.CreateDirectory(Path.GetDirectoryName(active)!);
        File.Copy(backup, active); // Recovery also handles an identical source and backup.
        await Migrate(root);
        Assert.True(File.Exists(versionPath));
        Assert.Equal(fixture["messages"]!.GetValue<int>(), Count(root, "archive_messages"));
        File.Delete(Database(root));
        await Assert.ThrowsAsync<InvalidDataException>(() => Migrate(root));
        Assert.False(File.Exists(Database(root))); // No empty replacement of completed authority.
    }

    [Fact]
    public async Task Torn_string_recovery_matches_Source_audit_and_preserves_physical_backup()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        var parent = fixture["parentId"]!.GetValue<string>();
        var file = Path.Combine(root, "state/logs/sessions", parent + ".jsonl");
        var lines = File.ReadAllLines(file);
        var torn =
            lines[0][..lines[0].IndexOf("Original", StringComparison.Ordinal)]
            + "unfinished"
            + lines[0];
        await File.WriteAllTextAsync(
            file,
            torn.Replace("\"timestamp\":1001", "\"timestamp\":NaN", StringComparison.Ordinal)
                + "\n"
                + lines[1]
                + "\n"
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => Migrate(root));
        await File.WriteAllTextAsync(file, torn + "\n" + lines[1] + "\n");
        var sourceRoot = Path.Combine(temp.Path, "source-migration");
        CopyTree(root, sourceRoot);
        await Source("migrate", sourceRoot);
        await Migrate(root);
        var native = JsonNode.Parse(File.ReadAllText(Manifest(root)))!;
        var source = JsonNode.Parse(File.ReadAllText(Manifest(sourceRoot)))!;
        Assert.True(JsonNode.DeepEquals(source["audit"], native["audit"]));
        Assert.Equal(1, native["audit"]!["tornPrefixCount"]!.GetValue<int>());
        var backup = Path.Combine(
            Path.GetDirectoryName(Manifest(root))!,
            "logs/sessions",
            parent + ".jsonl"
        );
        Assert.Equal(torn, File.ReadAllLines(backup)[0]);
        File.Delete(Path.Combine(root, "state/migrationVersion.json"));
        // Source itself consumes the C# recovery markers/manifest on a retry.
        Assert.Equal("complete", (await Source("migrate", root))["journal"]!.GetValue<string>());
    }

    [Fact]
    public async Task Prior_Csharp_journal_backup_remains_readable_during_joint_migration()
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        await using (var journal = new LlmRequestJournalStore(root))
        {
            Assert.True(
                await journal.MigrateLegacyAsync(
                    Path.Combine(root, "state/llm-request-journal.jsonl")
                )
            );
            await journal.MarkSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId);
        }
        var backups = Directory.GetFiles(
            Path.GetDirectoryName(Manifest(root))!,
            "llm-request-journal.jsonl.*"
        );
        Assert.Single(backups);
        var original = File.ReadAllText(backups[0]);
        await Migrate(root);
        Assert.Equal(original, File.ReadAllText(backups[0]));
        await using var reopened = new LlmRequestJournalStore(root);
        Assert.Equal(
            "complete",
            (await reopened.ReconstructAsync(fixture["requestId"]!.GetValue<string>()))[
                "completeness"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Ordinary_console_entry_migrates_before_loading_the_real_Source_Sessions()
    {
        if (OperatingSystem.IsWindows())
            return; // Unix signal probe; Windows qualification is separate.
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path);
        var root = fixture["legacy"]!.GetValue<string>();
        var start = new ProcessStartInfo(
            Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet")
        )
        {
            WorkingDirectory = temp.Path,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList = { typeof(HttpServer).Assembly.Location },
        };
        foreach (
            var key in start
                .Environment.Keys.Where(key =>
                    key.StartsWith("FOXWARM_", StringComparison.Ordinal)
                    || key is "CONFIG_PATH" or "MCP_CONFIG_PATH"
                )
                .ToArray()
        )
            start.Environment.Remove(key);
        start.Environment["FOXWARM_DATA_DIR"] = root;
        using var process = Process.Start(start)!;
        var errors = process.StandardError.ReadToEndAsync();
        try
        {
            while (
                await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30))
                    is { } line
            )
                if (line == "Main started without HTTP.")
                    break;
            Assert.False(process.HasExited, process.HasExited ? await errors : "No startup");
            Assert.True(File.Exists(Manifest(root)));
            Assert.Equal(fixture["messages"]!.GetValue<int>(), Count(root, "archive_messages"));
            using var signal = Process.Start("kill", ["-TERM", process.Id.ToString()])!;
            await signal.WaitForExitAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal(0, process.ExitCode);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill();
                await process.WaitForExitAsync();
            }
        }
    }

    private static async Task Migrate(string root)
    {
        await using var journal = new LlmRequestJournalStore(root);
        await SqliteOnlyArchivesMigration.RunAsync(root, journal);
    }

    private static string Database(string root) => Path.Combine(root, "state/archive-store.sqlite");

    private static string Manifest(string root) =>
        Path.Combine(
            root,
            "state/migration-backup",
            SqliteOnlyArchivesMigration.Id,
            "manifest.json"
        );

    private static long Count(string root, string table)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Database(root),
                Mode = SqliteOpenMode.ReadOnly,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM " + table;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static void CopyTree(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination);
        }
    }

    private static async Task<JsonObject> PublicArchive(string root, string output)
    {
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList =
            {
                Path.Combine(Repository, "scripts/foxwarm.js"),
                "archive",
                "export-jsonl",
                "-o",
                output,
            },
        };
        foreach (
            var key in start
                .Environment.Keys.Where(key =>
                    key.StartsWith("FOXWARM_", StringComparison.Ordinal)
                    || key is "CONFIG_PATH" or "MCP_CONFIG_PATH"
                )
                .ToArray()
        )
            start.Environment.Remove(key);
        start.Environment["FOXWARM_DATA_DIR"] = root;
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(process.ExitCode == 0, await stderr);
        Assert.Equal("", await stderr);
        return JsonNode.Parse(await stdout)!.AsObject();
    }

    private static async Task<JsonObject> Source(string mode, string root, string? artifacts = null)
    {
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = Repository,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList =
            {
                Path.Combine(Repository, "dotnet/cli-archive-fixture-ts.mjs"),
                mode,
                root,
            },
        };
        if (artifacts is not null)
            start.ArgumentList.Add(artifacts);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(process.ExitCode == 0, await errors);
        return JsonNode.Parse((await output).Trim())!.AsObject();
    }
}
