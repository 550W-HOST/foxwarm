using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using Foxwarm.Tools;

namespace Foxwarm;

public enum AtomicJsonWriteStage
{
    BeforeTempWrite,
    AfterTempFileSync,
    BeforeRename,
    AfterRenameBeforeDirectorySync,
    AfterDirectorySync,
}

public enum DirectorySyncResult
{
    Synced,
    Unsupported,
}

public sealed class AuthorityCommittedException : IOException
{
    public AuthorityCommittedException(string message, Exception cause)
        : base(message, cause) { }

    public bool AuthorityCommitted => true;
}

/// <summary>
/// Numbered backups kept beside a durable file: <c>&lt;file&gt;.1.bak</c> (newest) to
/// <c>&lt;file&gt;.&lt;Rotate&gt;.bak</c>, then the legacy <c>&lt;file&gt;.bak</c> when included.
/// Each write rotates them from the current file before publishing the new one. Rotation is
/// best effort: a failure is reported to <paramref name="OnError"/> and the write continues.
/// </summary>
public sealed record AtomicJsonBackups(
    int Rotate,
    bool IncludeLegacyBak = false,
    Action<Exception>? OnError = null
);

/// <summary>
/// Durable whole-file replacement of a small state file: a same-directory temporary file is
/// written and synced, published over the destination in one rename, and the directory is synced.
/// A failure before the rename leaves the previous file and removes the temporary file; a failure
/// after it raises <see cref="AuthorityCommittedException"/>. Callers serialize their own writes.
/// </summary>
public sealed class AtomicJsonFile
{
    private readonly string root;
    private readonly string filePath;
    private readonly Action<AtomicJsonWriteStage>? stageHook;
    private readonly bool privateFile;
    private readonly AtomicJsonBackups? backups;

    public AtomicJsonFile(
        string root,
        string relativePath,
        Action<AtomicJsonWriteStage>? stageHook = null,
        bool privateFile = false,
        AtomicJsonBackups? backups = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);
        if (backups is { Rotate: < 0 })
            throw new ArgumentOutOfRangeException(nameof(backups));
        this.root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        filePath = Path.GetFullPath(Path.Combine(this.root, relativePath));
        if (!filePath.StartsWith(this.root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException(
                "Authority path must remain under the supplied root.",
                nameof(relativePath)
            );
        this.stageHook = stageHook;
        this.privateFile = privateFile;
        this.backups = backups;
    }

    public string FilePath => filePath;
    public DirectorySyncResult LastDirectorySyncResult { get; private set; }

    /// <summary>The file followed by its configured backups, in load order.</summary>
    internal IReadOnlyList<string> CandidatePaths
    {
        get
        {
            var paths = new List<string> { filePath };
            for (var index = 1; index <= (backups?.Rotate ?? 0); index++)
                paths.Add(NumberedBackup(index));
            if (backups?.IncludeLegacyBak == true)
                paths.Add(filePath + ".bak");
            return paths;
        }
    }

    /// <summary>
    /// Returns the first existing candidate that <paramref name="read"/> accepts, or null when no
    /// candidate exists. An I/O or JSON failure moves on to the next candidate; when every existing
    /// candidate failed, the last failure is rethrown. Other exceptions propagate immediately.
    /// </summary>
    internal T? LoadFirstAvailable<T>(Func<string, T> read, out string? source)
        where T : class
    {
        Exception? failure = null;
        foreach (var path in CandidatePaths)
        {
            if (!File.Exists(path))
                continue;
            try
            {
                var value = read(path);
                source = path;
                return value;
            }
            catch (Exception error)
                when (error is IOException or System.Text.Json.JsonException)
            {
                failure = error;
            }
        }
        source = null;
        if (failure is not null)
            ExceptionDispatchInfo.Throw(failure);
        return null;
    }

    internal void WritePayload(System.Text.Json.Nodes.JsonObject payload) =>
        WriteText(payload.ToJsonString(), default);

    internal void WriteTextPayload(string payload, CancellationToken cancellationToken) =>
        WriteText(payload, cancellationToken);

    private void WriteText(string text, CancellationToken cancellationToken) =>
        WriteStreamPayload(
            stream => stream.Write(new UTF8Encoding(false).GetBytes(text)),
            cancellationToken
        );

    internal void WriteStreamPayload(Action<Stream> write, CancellationToken cancellationToken) =>
        WriteStreamPayloadAsync(write, null, cancellationToken).GetAwaiter().GetResult();

    // The same atomic publication path can prepare UTF-8 while accepted Archive work is
    // pending, then await its receipt before rename. A failed prerequisite discards the temp file.
    internal async Task WriteStreamPayloadAsync(
        Action<Stream> write,
        Func<Task>? beforePublish,
        CancellationToken cancellationToken
    )
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        var tempPath = Path.Combine(
            Path.GetDirectoryName(filePath)!,
            $"{Path.GetFileName(filePath)}.tmp-{Environment.ProcessId}-{Guid.NewGuid():N}"
        );
        var renamed = false;
        try
        {
            RotateBackups();
            stageHook?.Invoke(AtomicJsonWriteStage.BeforeTempWrite);
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                BufferSize = 4096,
            };
            if (privateFile && !OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(tempPath, options))
            {
                write(stream);
                // One complete-file durability boundary, rather than synchronous disk I/O
                // for every chunk emitted by a streaming serializer.
                stream.Flush(flushToDisk: true);
            }
            stageHook?.Invoke(AtomicJsonWriteStage.AfterTempFileSync);
            if (beforePublish is not null)
                await beforePublish().ConfigureAwait(false);
            stageHook?.Invoke(AtomicJsonWriteStage.BeforeRename);
            cancellationToken.ThrowIfCancellationRequested();
            // On Windows this replaces a destination held open by readers that allow deletion.
            AtomicFileReplace.Replace(tempPath, filePath);
            renamed = true;
            stageHook?.Invoke(AtomicJsonWriteStage.AfterRenameBeforeDirectorySync);
            LastDirectorySyncResult = DirectorySync.Sync(Path.GetDirectoryName(filePath)!);
            stageHook?.Invoke(AtomicJsonWriteStage.AfterDirectorySync);
        }
        catch (Exception error)
        {
            if (!renamed)
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch { }
                throw;
            }
            throw new AuthorityCommittedException(
                "Session authority was renamed into place before a later durability step failed.",
                error
            );
        }
    }

    private string NumberedBackup(int index) => $"{filePath}.{index}.bak";

    // Same names, order and best-effort handling as the TypeScript DiskJsonData backups.
    private void RotateBackups()
    {
        if (backups is null || !File.Exists(filePath))
            return;
        try
        {
            if (backups.Rotate > 0)
            {
                for (var index = backups.Rotate; index >= 2; index--)
                {
                    var previous = NumberedBackup(index - 1);
                    if (File.Exists(previous))
                        File.Move(previous, NumberedBackup(index), overwrite: true);
                }
                File.Copy(filePath, NumberedBackup(1), overwrite: true);
            }
            if (backups.IncludeLegacyBak)
                File.Copy(filePath, filePath + ".bak", overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            backups.OnError?.Invoke(error);
        }
    }
}

/// <summary>
/// Syncs a directory after a rename on Linux. Other platforms report
/// <see cref="DirectorySyncResult.Unsupported"/> without doing anything.
/// </summary>
internal static class DirectorySync
{
    private const int O_RDONLY = 0;
    private const int O_DIRECTORY = 0x10000;
    private static readonly HashSet<int> UnsupportedErrnos = [1, 21, 22, 38, 95]; // EPERM,EISDIR,EINVAL,ENOSYS,ENOTSUP

    public static DirectorySyncResult Sync(string directoryPath)
    {
        if (!OperatingSystem.IsLinux())
            return DirectorySyncResult.Unsupported;
        var descriptor = open(directoryPath, O_RDONLY | O_DIRECTORY);
        if (descriptor < 0)
        {
            var error = Marshal.GetLastPInvokeError();
            if (UnsupportedErrnos.Contains(error))
                return DirectorySyncResult.Unsupported;
            throw new IOException($"Unable to open authority directory for fsync (errno {error}).");
        }
        try
        {
            if (fsync(descriptor) == 0)
                return DirectorySyncResult.Synced;
            var error = Marshal.GetLastPInvokeError();
            if (UnsupportedErrnos.Contains(error))
                return DirectorySyncResult.Unsupported;
            throw new IOException($"Unable to fsync authority directory (errno {error}).");
        }
        finally
        {
            _ = close(descriptor);
        }
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int open(string pathname, int flags);

    [DllImport("libc", SetLastError = true)]
    private static extern int fsync(int fd);

    [DllImport("libc", SetLastError = true)]
    private static extern int close(int fd);
}
