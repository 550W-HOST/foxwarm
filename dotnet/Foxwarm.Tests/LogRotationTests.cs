using System.Formats.Tar;
using System.IO.Compression;

namespace Foxwarm.Tests;

public sealed class LogRotationTests
{
    [Fact]
    public async Task Actual_archive_policy_keeps_three_date_directories_and_seven_archives_with_original_contents()
    {
        using var temp = new TempDirectory();
        for (var day = 1; day <= 12; day++)
        {
            var directory = Path.Combine(temp.Path, $"2026-10-{day:00}");
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "original.log"), $"retained {day}\n");
        }
        Directory.CreateDirectory(Path.Combine(temp.Path, "recent"));
        Directory.CreateDirectory(Path.Combine(temp.Path, "2026-10-01-error"));
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "running-exec.json"), "not an artifact");
        await LogRotation.RotateDatedLogsAsync(temp.Path);
        Assert.Equal(new[] { "2026-10-10", "2026-10-11", "2026-10-12" }, Directory.GetDirectories(temp.Path).Select(Path.GetFileName).Where(value => value!.Length == 10).Order());
        Assert.Equal(7, Directory.GetFiles(Path.Combine(temp.Path, "archives")).Length);
        Assert.False(File.Exists(Path.Combine(temp.Path, "archives", "2026-10-02.tar.gz")));
        using var file = File.OpenRead(Path.Combine(temp.Path, "archives", "2026-10-03.tar.gz"));
        using var gzip = new GZipStream(file, CompressionMode.Decompress);
        using var reader = new TarReader(gzip);
        string? captured = null;
        while (reader.GetNextEntry() is { } entry)
            if (entry.Name == "2026-10-03/original.log")
                captured = await new StreamReader(entry.DataStream!).ReadToEndAsync();
        Assert.Equal("retained 3\n", captured);
        Assert.True(Directory.Exists(Path.Combine(temp.Path, "recent")));
        Assert.True(Directory.Exists(Path.Combine(temp.Path, "2026-10-01-error")));
        Assert.Equal("not an artifact", await File.ReadAllTextAsync(Path.Combine(temp.Path, "running-exec.json")));
    }

    [Fact]
    public async Task Archive_failure_keeps_original_directory_and_later_dates_can_still_be_archived()
    {
        using var temp = new TempDirectory();
        for (var day = 1; day <= 5; day++)
        {
            var directory = Path.Combine(temp.Path, $"2026-10-{day:00}");
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "original.log"), $"data {day}");
        }
        // A directory at the destination is a real archive-open failure on both supported platforms.
        Directory.CreateDirectory(Path.Combine(temp.Path, "archives", "2026-10-02.tar.gz"));
        await LogRotation.RotateDatedLogsAsync(temp.Path);
        Assert.Equal("data 2", await File.ReadAllTextAsync(Path.Combine(temp.Path, "2026-10-02", "original.log")));
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "2026-10-01")));
        Assert.True(File.Exists(Path.Combine(temp.Path, "archives", "2026-10-01.tar.gz")));
    }

    [Fact]
    public async Task Startup_schedule_rotates_only_real_log_and_Agent_exec_roots()
    {
        using var temp = new TempDirectory();
        var logs = Path.Combine(temp.Path, "state", "logs");
        var exec = Path.Combine(temp.Path, "agent", ".temp", "exec");
        var unrelated = Path.Combine(temp.Path, "unrelated");
        foreach (var root in new[] { logs, exec, unrelated })
            for (var day = 1; day <= 4; day++) Directory.CreateDirectory(Path.Combine(root, $"2026-10-{day:00}"));
        var owner = new LogRotation(logs, () => [exec]);
        owner.Start();
        await owner.DisposeAsync(); // Drains the startup pass without waiting for the ten-hour timer.
        Assert.True(File.Exists(Path.Combine(logs, "archives", "2026-10-01.tar.gz")));
        Assert.True(File.Exists(Path.Combine(exec, "archives", "2026-10-01.tar.gz")));
        Assert.True(Directory.Exists(Path.Combine(unrelated, "2026-10-01")));
        Assert.False(Directory.Exists(Path.Combine(unrelated, "archives")));
    }
}
