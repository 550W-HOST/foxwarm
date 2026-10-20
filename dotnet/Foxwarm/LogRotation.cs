using System.Formats.Tar;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace Foxwarm;

// The Source date-directory policy is independent of exec tracking and command lifetime.
internal sealed class LogRotation(string logsRoot, Func<IEnumerable<string>> execRoots)
    : IAsyncDisposable
{
    private readonly CancellationTokenSource stopping = new();
    private Task? schedule;

    internal void Start() => schedule ??= RunScheduleAsync();

    private async Task RunScheduleAsync()
    {
        await RunAsync();
        using var timer = new PeriodicTimer(TimeSpan.FromHours(10));
        try
        {
            while (await timer.WaitForNextTickAsync(stopping.Token))
                await RunAsync();
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
    }

    internal async Task RunAsync()
    {
        await RotateDatedLogsAsync(logsRoot);
        try
        {
            foreach (var root in execRoots())
                await RotateDatedLogsAsync(root);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("Failed to rotate exec logs: " + error.Message);
        }
    }

    internal static async Task RotateDatedLogsAsync(
        string root,
        int keepDirectories = 3,
        int keepArchives = 7
    )
    {
        try
        {
            if (!Directory.Exists(root))
                return;
            var dates = Directory
                .EnumerateFileSystemEntries(root)
                .Where(path =>
                    Regex.IsMatch(
                        Path.GetFileName(path),
                        "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
                        RegexOptions.CultureInvariant
                    )
                    && (
                        File.GetAttributes(path)
                        & (FileAttributes.Directory | FileAttributes.ReparsePoint)
                    ) == FileAttributes.Directory
                )
                .OrderByDescending(Path.GetFileName, StringComparer.Ordinal)
                .ToArray();
            foreach (var directory in dates.Skip(keepDirectories))
            {
                var archives = Path.Combine(root, "archives");
                Directory.CreateDirectory(archives);
                var archive = Path.Combine(archives, Path.GetFileName(directory) + ".tar.gz");
                try
                {
                    await Task.Run(() =>
                    {
                        using var file = File.Create(archive);
                        using var gzip = new GZipStream(file, CompressionLevel.Optimal);
                        TarFile.CreateFromDirectory(directory, gzip, includeBaseDirectory: true);
                    });
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    Console.Error.WriteLine("Failed to archive logs: " + error.Message);
                    continue;
                }
                // Archive publication must succeed before deleting the original directory.
                Directory.Delete(directory, recursive: true);
            }
            var archiveRoot = Path.Combine(root, "archives");
            if (!Directory.Exists(archiveRoot))
                return;
            var retained = Directory
                .EnumerateFileSystemEntries(archiveRoot)
                .Where(path =>
                    Path.GetFileName(path).EndsWith(".tar.gz", StringComparison.Ordinal)
                    && (
                        File.GetAttributes(path)
                        & (FileAttributes.Directory | FileAttributes.ReparsePoint)
                    ) == 0
                )
                .OrderByDescending(Path.GetFileName, StringComparer.Ordinal)
                .ToArray();
            foreach (var archive in retained.Skip(keepArchives))
                File.Delete(archive);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine("Failed to rotate logs: " + error.Message);
        }
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        if (schedule is not null)
            await schedule;
        stopping.Dispose();
    }
}
