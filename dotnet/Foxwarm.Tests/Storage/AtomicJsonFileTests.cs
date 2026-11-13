using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class AtomicJsonFileTests
{
    private static AtomicJsonFile Backed(
        string root,
        int rotate,
        bool legacy,
        Action<AtomicJsonWriteStage>? stage = null,
        Action<Exception>? onError = null,
        bool privateFile = false
    ) =>
        new(
            root,
            "state/store.json",
            stage,
            privateFile,
            new AtomicJsonBackups(rotate, legacy, onError)
        );

    private static void Write(AtomicJsonFile file, int version) =>
        file.WritePayload(new JsonObject { ["v"] = version });

    private static int? Version(string path) =>
        File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!["v"]!.GetValue<int>() : null;

    [Fact]
    public void Each_write_rotates_numbered_backups_and_refreshes_the_legacy_backup()
    {
        using var temp = new TempDirectory();
        var file = Backed(temp.Path, 3, legacy: true);
        Write(file, 1);
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file.FilePath)!, "*.bak"));
        for (var version = 2; version <= 5; version++)
            Write(file, version);
        Assert.Equal(5, Version(file.FilePath));
        Assert.Equal(4, Version(file.FilePath + ".1.bak"));
        Assert.Equal(3, Version(file.FilePath + ".2.bak"));
        Assert.Equal(2, Version(file.FilePath + ".3.bak"));
        Assert.Null(Version(file.FilePath + ".4.bak"));
        Assert.Equal(4, Version(file.FilePath + ".bak"));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file.FilePath)!, "*.tmp-*"));
    }

    [Fact]
    public void Without_backups_a_write_leaves_only_the_file()
    {
        using var temp = new TempDirectory();
        var file = new AtomicJsonFile(temp.Path, "state/store.json");
        Write(file, 1);
        Write(file, 2);
        Assert.Equal(
            ["store.json"],
            Directory
                .GetFiles(Path.GetDirectoryName(file.FilePath)!)
                .Select(path => Path.GetFileName(path)!)
                .ToArray()
        );
        Assert.Equal([file.FilePath], file.CandidatePaths);
    }

    [Fact]
    public void Rotation_precedes_the_temporary_write_and_keeps_the_stage_order()
    {
        using var temp = new TempDirectory();
        var stages = new List<AtomicJsonWriteStage>();
        string? backupAtTempWrite = null;
        var file = Backed(
            temp.Path,
            1,
            legacy: false,
            stage =>
            {
                stages.Add(stage);
                if (stage == AtomicJsonWriteStage.BeforeTempWrite)
                    backupAtTempWrite = File.Exists(
                        Path.Combine(temp.Path, "state", "store.json.1.bak")
                    )
                        ? File.ReadAllText(Path.Combine(temp.Path, "state", "store.json.1.bak"))
                        : null;
            }
        );
        Write(file, 1);
        stages.Clear();
        Write(file, 2);
        Assert.Equal("""{"v":1}""", backupAtTempWrite);
        Assert.Equal(Enum.GetValues<AtomicJsonWriteStage>(), stages);
    }

    [Fact]
    public void A_failed_rotation_is_reported_and_the_write_still_publishes()
    {
        using var temp = new TempDirectory();
        var errors = new List<Exception>();
        var file = Backed(temp.Path, 2, legacy: false, onError: errors.Add);
        Write(file, 1);
        Write(file, 2);
        // A directory in the second slot makes moving the first backup into it fail.
        Directory.CreateDirectory(file.FilePath + ".2.bak");
        Write(file, 3);
        Assert.Single(errors);
        // Windows reports a directory destination as access denied.
        Assert.True(errors[0] is IOException or UnauthorizedAccessException, errors[0].ToString());
        Assert.Equal(3, Version(file.FilePath));
        Assert.Equal(1, Version(file.FilePath + ".1.bak"));
    }

    [Fact]
    public void Private_files_keep_owner_only_backups()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var file = Backed(temp.Path, 1, legacy: true, privateFile: true);
        Write(file, 1);
        Write(file, 2);
        foreach (var path in new[] { file.FilePath, file.FilePath + ".1.bak", file.FilePath + ".bak" })
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(path)
            );
    }

    [Fact]
    public void Loading_tries_the_file_then_numbered_then_legacy_backups()
    {
        using var temp = new TempDirectory();
        var file = Backed(temp.Path, 3, legacy: true);
        Assert.Equal(
            [
                file.FilePath,
                file.FilePath + ".1.bak",
                file.FilePath + ".2.bak",
                file.FilePath + ".3.bak",
                file.FilePath + ".bak",
            ],
            file.CandidatePaths
        );
        Assert.Null(file.LoadFirstAvailable(Read, out var none));
        Assert.Null(none);

        Directory.CreateDirectory(Path.GetDirectoryName(file.FilePath)!);
        File.WriteAllText(file.FilePath, "not JSON");
        File.WriteAllText(file.FilePath + ".1.bak", "{");
        File.WriteAllText(file.FilePath + ".3.bak", """{"v":3}""");
        File.WriteAllText(file.FilePath + ".bak", """{"v":9}""");
        var loaded = file.LoadFirstAvailable(Read, out var source);
        Assert.Equal(3, loaded!["v"]!.GetValue<int>());
        Assert.Equal(file.FilePath + ".3.bak", source);
    }

    [Fact]
    public void Loading_rethrows_the_last_failure_when_every_candidate_fails()
    {
        using var temp = new TempDirectory();
        var file = Backed(temp.Path, 1, legacy: true);
        Directory.CreateDirectory(Path.GetDirectoryName(file.FilePath)!);
        File.WriteAllText(file.FilePath, "not JSON");
        File.WriteAllText(file.FilePath + ".bak", "{");
        Assert.ThrowsAny<JsonException>(() => file.LoadFirstAvailable(Read, out _));
    }

    [Fact]
    public void Loading_propagates_a_rejection_that_is_not_an_io_or_json_failure()
    {
        using var temp = new TempDirectory();
        var file = Backed(temp.Path, 1, legacy: false);
        Directory.CreateDirectory(Path.GetDirectoryName(file.FilePath)!);
        File.WriteAllText(file.FilePath, "[]");
        File.WriteAllText(file.FilePath + ".1.bak", """{"v":1}""");
        Assert.Throws<InvalidDataException>(() => file.LoadFirstAvailable(Read, out _));
    }

    [Fact]
    public void Publishing_replaces_a_file_whose_reader_allows_deletion()
    {
        using var temp = new TempDirectory();
        var file = new AtomicJsonFile(temp.Path, "state/store.json");
        Write(file, 1);
        using (
            var reader = new FileStream(
                file.FilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            )
        )
        {
            Write(file, 2);
            using var text = new StreamReader(reader);
            Assert.Equal("""{"v":1}""", text.ReadToEnd());
        }
        Assert.Equal(2, Version(file.FilePath));
    }

    [Fact]
    public void A_reader_that_blocks_deletion_fails_the_write_before_publication_on_windows()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var file = new AtomicJsonFile(temp.Path, "state/store.json");
        Write(file, 1);
        using (new FileStream(file.FilePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var error = Assert.ThrowsAny<IOException>(() => Write(file, 2));
            Assert.IsNotType<AuthorityCommittedException>(error);
        }
        Assert.Equal(1, Version(file.FilePath));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file.FilePath)!, "*.tmp-*"));
    }

    private static JsonObject Read(string path) =>
        JsonNode.Parse(File.ReadAllText(path)) as JsonObject
        ?? throw new InvalidDataException("not an object");
}
