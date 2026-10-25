using System.Runtime.InteropServices;
using System.Text;

namespace Foxwarm.Sessions;

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

public sealed class LinuxAtomicJsonFile
{
    private readonly string root;
    private readonly string filePath;
    private readonly Action<AtomicJsonWriteStage>? stageHook;
    private readonly bool privateFile;

    public LinuxAtomicJsonFile(
        string root,
        string relativePath,
        Action<AtomicJsonWriteStage>? stageHook = null,
        bool privateFile = false
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);
        this.root = Path.GetFullPath(root);
        filePath = Path.GetFullPath(Path.Combine(this.root, relativePath));
        if (!filePath.StartsWith(this.root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException(
                "Authority path must remain under the supplied root.",
                nameof(relativePath)
            );
        this.stageHook = stageHook;
        this.privateFile = privateFile;
    }

    public string FilePath => filePath;
    public DirectorySyncResult LastDirectorySyncResult { get; private set; }

    public void Write(
        SessionAuthorityDocument document,
        CancellationToken cancellationToken = default
    ) => WriteStreamPayload(document.WriteTo, cancellationToken);

    internal void WritePayload(System.Text.Json.Nodes.JsonObject payload) =>
        WriteText(payload.ToJsonString(), default);

    internal void WriteTextPayload(string payload, CancellationToken cancellationToken) =>
        WriteText(payload, cancellationToken);

    private void WriteText(string text, CancellationToken cancellationToken) =>
        WriteStreamPayload(
            stream => stream.Write(new UTF8Encoding(false).GetBytes(text)),
            cancellationToken
        );

    internal void WriteStreamPayload(Action<Stream> write, CancellationToken cancellationToken)
        => WriteStreamPayloadAsync(write, null, cancellationToken).GetAwaiter().GetResult();

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
            File.Move(tempPath, filePath, overwrite: true);
            renamed = true;
            stageHook?.Invoke(AtomicJsonWriteStage.AfterRenameBeforeDirectorySync);
            LastDirectorySyncResult = LinuxDirectorySync.Sync(Path.GetDirectoryName(filePath)!);
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

    public SessionAuthorityDocument Read(string sessionId, string agent = "main") =>
        SessionAuthorityDocument.Load(filePath, sessionId, agent);

    internal static class LinuxDirectorySync
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
                throw new IOException(
                    $"Unable to open authority directory for fsync (errno {error})."
                );
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
}
