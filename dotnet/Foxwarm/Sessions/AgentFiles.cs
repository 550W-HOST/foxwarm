namespace Foxwarm.Sessions;

/// <summary>
/// One entry of an Agent directory listing. <see cref="Length"/> and
/// <see cref="LastWriteUtc"/> are set only for files that aren't links, in an unfiltered
/// listing.
/// </summary>
internal sealed record AgentFileEntry(
    string Name,
    string Locator,
    bool IsDirectory,
    bool IsLink,
    long? Length,
    DateTime? LastWriteUtc
);

/// <summary>
/// A file or directory of the Agent file store. <see cref="Generation"/> identifies a file's
/// content for conditional writes and is 0 for directories; a file's generation changes
/// whenever its content does.
/// </summary>
/// <summary>An entry's kind (file, directory, or other), length and time, without its generation.</summary>
internal sealed record AgentFileKind(string Kind, long Length, DateTime LastWriteUtc);

internal sealed record AgentFileStat(
    string Path,
    bool IsDirectory,
    long Length,
    long Generation,
    DateTime LastWriteUtc
);

/// <summary>A file's bytes with the generation they were read at.</summary>
internal sealed record AgentFileContent(byte[] Bytes, long Generation);

/// <summary>
/// Agent files and the installation's prompt files. Paths are relative and '/'-separated; a
/// null Agent addresses the installation level beside the Agent folders. A locator names where
/// a file lives and is shown in the composed system prompt, so it must be stable for an
/// unchanged installation (D-request-prefix-stability). Listings are in ordinal name order.
/// The file implementation is <see cref="FileAgentFiles"/>; hosted mode keeps them in the
/// tenant database (<c>PgAgentFileStore</c>).
/// </summary>
/// <remarks>
/// The write half takes store paths (<see cref="AgentFilePaths"/>) and runs in one lane per
/// Agent. An <c>expectedGeneration</c> of null writes unconditionally, 0 requires the file to
/// be absent and any other value requires the file to be at that generation; a failed
/// expectation is <see cref="AgentFileConflictException"/>. Writes create missing parent
/// directories. A missing file is <see cref="FileNotFoundException"/>, a missing Agent
/// <see cref="DirectoryNotFoundException"/>, an invalid path <see cref="AgentFilePathException"/>.
/// </remarks>
internal interface IAgentFileStore
{
    string Locator(string? agent, string path);

    bool FileExists(string? agent, string path);

    Task<string> ReadTextAsync(string? agent, string path, CancellationToken token);

    /// <summary>
    /// Entries directly in a directory, or none when it doesn't exist. With
    /// <paramref name="filePattern"/>, only files matching it, as the platform matches names.
    /// </summary>
    IReadOnlyList<AgentFileEntry> List(string? agent, string directory, string? filePattern = null);

    /// <summary>The file or directory at <paramref name="path"/>, or null when there is none.</summary>
    AgentFileStat? Stat(string? agent, string path);

    /// <summary>
    /// The kind, length and time of the entry at <paramref name="path"/>, or null when there is
    /// none, without reading its content: what a listing, an existence check or a read's
    /// preflight needs.
    /// </summary>
    AgentFileKind? Kind(string? agent, string path) =>
        Stat(agent, path) is { } stat ? new(stat.IsDirectory ? "directory" : "file", stat.Length, stat.LastWriteUtc) : null;

    Task<AgentFileContent> ReadAsync(string? agent, string path, CancellationToken token);

    /// <summary>
    /// One version of a file, or null when that version is larger than
    /// <paramref name="maxBytes"/>; a larger version is never materialized.
    /// </summary>
    Task<AgentFileContent?> ReadBoundedAsync(string? agent, string path, long maxBytes, CancellationToken token);

    /// <summary>
    /// Up to <paramref name="count"/> bytes of a file from <paramref name="offset"/>, without
    /// reading the rest: headers and previews of files that may be large.
    /// </summary>
    Task<byte[]> ReadRangeAsync(string? agent, string path, long offset, int count, CancellationToken token);

    /// <summary>Creates or replaces a file and returns its new generation.</summary>
    Task<long> WriteAsync(
        string? agent,
        string path,
        ReadOnlyMemory<byte> content,
        long? expectedGeneration,
        CancellationToken token
    );

    /// <summary>
    /// Removes a file, or a directory: an empty one, or with <paramref name="recursive"/> its
    /// whole tree. The expectation applies to files only. The parent directory stays.
    /// </summary>
    Task DeleteAsync(
        string? agent,
        string path,
        bool recursive,
        long? expectedGeneration,
        CancellationToken token
    );

    /// <summary>
    /// Moves a file or directory within one Agent. An existing target fails, except a file
    /// replacing a file with <paramref name="overwrite"/>.
    /// </summary>
    Task RenameAsync(string? agent, string from, string to, bool overwrite, CancellationToken token);

    /// <summary>Creates a directory and its parents; an existing directory is kept.</summary>
    Task MakeDirectoryAsync(string? agent, string path, CancellationToken token);
}

/// <summary>
/// An Agent store: Agent files held by the storage context instead of the Agent folders, with
/// the Agent lifecycle as operations on it (hosted mode, <c>PgAgentFileStore</c>). An Agent
/// exists exactly when its root (path <c>""</c>) does; only these operations create or remove
/// a root, each in one step with the Agent's files.
/// </summary>
internal interface IAgentStore : IAgentFileStore
{
    /// <summary>Agents that exist, in ordinal order.</summary>
    IReadOnlyList<string> Agents();

    bool AgentExists(string agent);

    /// <summary>
    /// Creates an Agent with its first directories and files. An existing Agent fails with
    /// <see cref="AgentFileConflictException"/>.
    /// </summary>
    Task CreateAgentAsync(
        string agent,
        IReadOnlyList<string> directories,
        IReadOnlyList<KeyValuePair<string, byte[]>> files,
        CancellationToken token,
        // Restoration of a retained Agent: an existing name, which the new-name bound doesn't apply to.
        bool restoration = false
    );

    /// <summary>Removes an Agent with all of its files; a missing Agent is a no-op.</summary>
    Task DeleteAgentAsync(string agent, CancellationToken token);

    /// <summary>Removes every file of an Agent in one transaction and keeps its root.</summary>
    Task ClearAgentAsync(string agent, CancellationToken token);

    /// <summary>
    /// Copies the tree at <paramref name="sourcePath"/> of one Agent to
    /// <paramref name="targetPath"/> of another existing Agent, replacing files that exist
    /// there; a missing source copies nothing.
    /// </summary>
    Task CopyTreeAsync(
        string sourceAgent,
        string sourcePath,
        string targetAgent,
        string targetPath,
        CancellationToken token
    );

    /// <summary>Every file and empty directory at or below a path, in ordinal path order.</summary>
    IReadOnlyList<AgentFileStat> Tree(string? agent, string path);

    /// <summary>The limits in effect now.</summary>
    AgentStoreLimits Limits { get; }

    /// <summary>
    /// Refuses, before anything is committed, a new Agent with these initial entries that
    /// wouldn't fit the limits now.
    /// </summary>
    void AdmitCreation(
        string agent,
        IReadOnlyList<string> directories,
        IReadOnlyList<KeyValuePair<string, byte[]>> files
    );
}

/// <summary>The failures both store implementations report, with the same texts.</summary>
internal static class AgentFileErrors
{
    internal static FileNotFoundException NotFound(string path) =>
        new("No such file or directory: " + path);

    internal static DirectoryNotFoundException NoAgent(string? agent) =>
        new($"Agent '{agent}' does not exist.");

    internal static IOException IsDirectory(string path) => new("Is a directory: " + path);

    internal static IOException NotDirectory(string path) => new("Not a directory: " + path);

    internal static IOException NotEmpty(string path) => new("Directory not empty: " + path);

    internal static AgentFileConflictException Exists(string path) =>
        new("File already exists: " + path);

    // Up to count bytes of a stream from offset: by seeking where the stream can, otherwise
    // by reading past the start.
    internal static async Task<byte[]> ReadRangeAsync(Stream stream, long offset, int count, CancellationToken token)
    {
        if (stream.CanSeek)
        {
            if (offset >= stream.Length)
                return [];
            stream.Seek(offset, SeekOrigin.Begin);
        }
        else
        {
            var skip = new byte[81920];
            for (var left = offset; left > 0; )
            {
                var read = await stream.ReadAsync(skip.AsMemory(0, (int)Math.Min(skip.Length, left)), token).ConfigureAwait(false);
                if (read == 0)
                    return [];
                left -= read;
            }
        }
        var buffer = new byte[count];
        var total = await stream.ReadAtLeastAsync(buffer, count, throwOnEndOfStream: false, token).ConfigureAwait(false);
        return total == count ? buffer : buffer[..total];
    }

    internal static AgentFilePathTooLongException PathTooLong(long bytes, long limit) =>
        new($"This path is too long: {bytes:N0} bytes, and the limit here is {limit:N0}.");

    internal static AgentFileConflictException Changed(string path) =>
        new(path + " changed since it was read. Read it again, then retry.");

    internal static AgentStoreQuotaException FileTooLarge(string path, AgentStoreLimits limit) =>
        new("fileBytes", $"{path} is larger than the {Size(limit.FileBytes)} limit for one Agent file.");

    internal static AgentStoreQuotaException TotalTooLarge(AgentStoreLimits limit) =>
        new("totalBytes", $"Agent files are full: this write would exceed the {Size(limit.TotalBytes)} limit.");

    internal static AgentStoreQuotaException RetainedTooLarge(decimal limit) =>
        new("retainedBytes", $"Agent file storage is full: this write would exceed the {Size(limit)} limit for retained content.");

    internal static AgentStoreQuotaException TooManyFiles(AgentStoreLimits limit) =>
        new(
            "files",
            "Agent files are full: this write would exceed the limit of "
                + limit.Files.ToString("N0", System.Globalization.CultureInfo.InvariantCulture)
                + " files."
        );

    // 2 GiB, 64 MiB; a limit that isn't a whole number of either is shown in bytes.
    private static string Size(decimal bytes) =>
        bytes >= 1L << 30 && bytes % (1L << 30) == 0 ? $"{bytes / (1L << 30)} GiB"
        : bytes >= 1L << 20 && bytes % (1L << 20) == 0 ? $"{bytes / (1L << 20)} MiB"
        : bytes.ToString("N0", System.Globalization.CultureInfo.InvariantCulture) + " bytes";

    internal static IOException Root() =>
        new("An Agent's own directory can't be removed or moved.");

    internal static IOException IntoItself(string path) =>
        new("A directory can't be moved into itself: " + path);

    internal static IOException Link(string path) =>
        new("Agent file paths can't pass through a symbolic link: " + path);

    /// <summary>The generation a file implementation reports for content: never 0.</summary>
    internal static long ContentGeneration(ReadOnlySpan<byte> content)
    {
        Span<byte> hash = stackalloc byte[32];
        System.Security.Cryptography.SHA256.HashData(content, hash);
        return (System.Buffers.Binary.BinaryPrimitives.ReadInt64BigEndian(hash) & long.MaxValue) | 1;
    }

    internal static long? Normalize(long? expectedGeneration) =>
        expectedGeneration is < 0
            ? throw new ArgumentOutOfRangeException(nameof(expectedGeneration))
            : expectedGeneration;
}

/// <summary>
/// Agent folders as <see cref="AgentCatalog"/> lays them out. Reads keep their file behavior;
/// the write half takes store paths, refuses to pass through a symbolic link, replaces a file
/// by renaming a complete temporary file over it, and reports a file's content hash as its
/// generation.
/// </summary>
internal sealed class FileAgentFiles(AgentCatalog agents) : IAgentFileStore
{
    private readonly AgentWriteLanes lanes = new();

    private string Directory(string? agent) =>
        agent is null ? agents.AgentRoot : agents.SourceDirectory(agent);

    public string Locator(string? agent, string path) =>
        Path.Combine(Directory(agent), path.Replace('/', Path.DirectorySeparatorChar));

    public bool FileExists(string? agent, string path) => File.Exists(Locator(agent, path));

    public Task<string> ReadTextAsync(string? agent, string path, CancellationToken token) =>
        File.ReadAllTextAsync(Locator(agent, path), token);

    public IReadOnlyList<AgentFileEntry> List(
        string? agent,
        string directory,
        string? filePattern = null
    )
    {
        var full = Locator(agent, directory);
        if (!System.IO.Directory.Exists(full))
            return [];
        if (filePattern is not null)
            return System
                .IO.Directory.EnumerateFiles(full, filePattern, SearchOption.TopDirectoryOnly)
                .Select(path => new AgentFileEntry(
                    Path.GetFileName(path),
                    path,
                    false,
                    (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0,
                    null,
                    null
                ))
                .OrderBy(entry => entry.Name, StringComparer.Ordinal)
                .ToArray();
        return new DirectoryInfo(full)
            .GetFileSystemInfos()
            .Select(entry =>
            {
                var link = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
                // A link's target isn't read, so a dangling link lists like any other.
                var file = !link ? entry as FileInfo : null;
                return new AgentFileEntry(
                    entry.Name,
                    entry.FullName,
                    entry is DirectoryInfo,
                    link,
                    file?.Length,
                    // A link's own time, as a listing shows it.
                    link ? entry.LastWriteTimeUtc : file?.LastWriteTimeUtc
                );
            })
            .OrderBy(entry => entry.Name, StringComparer.Ordinal)
            .ToArray();
    }

    public AgentFileStat? Stat(string? agent, string path)
    {
        AgentFilePaths.Require(path, allowRoot: true);
        var full = Resolve(agent, path, lookup: true);
        if (System.IO.Directory.Exists(full))
            return new(path, true, 0, 0, System.IO.Directory.GetLastWriteTimeUtc(full));
        if (!File.Exists(full))
            return null;
        var info = new FileInfo(full);
        if (!Foxwarm.Tools.WorkspaceTools.RegularFile(full))
            throw new IOException("Not a regular file: " + path);
        return new(
            path,
            false,
            info.Length,
            AgentFileErrors.ContentGeneration(File.ReadAllBytes(full)),
            info.LastWriteTimeUtc
        );
    }

    // Kind and length from the file system's metadata; content is never read.
    public AgentFileKind? Kind(string? agent, string path)
    {
        AgentFilePaths.Require(path, allowRoot: true);
        var full = Resolve(agent, path, lookup: true);
        if (System.IO.Directory.Exists(full))
            return new("directory", 0, System.IO.Directory.GetLastWriteTimeUtc(full));
        if (!File.Exists(full))
            return null;
        var info = new FileInfo(full);
        return new(Foxwarm.Tools.WorkspaceTools.RegularFile(full) ? "file" : "other", info.Length, info.LastWriteTimeUtc);
    }

    // An open regular file: content is read from the opened file only.
    private FileStream OpenRegular(string? agent, string path)
    {
        AgentFilePaths.Require(path);
        var full = Resolve(agent, path, lookup: true);
        if (System.IO.Directory.Exists(full))
            throw AgentFileErrors.IsDirectory(path);
        if (!File.Exists(full))
            throw AgentFileErrors.NotFound(path);
        if (!Foxwarm.Tools.WorkspaceTools.RegularFile(full))
            throw new IOException("Not a regular file: " + path);
        var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.Asynchronous);
        if (!Foxwarm.Tools.WorkspaceTools.RegularFileHandle(stream, full))
        {
            stream.Dispose();
            throw new IOException("Not a regular file: " + path);
        }
        return stream;
    }

    public async Task<AgentFileContent> ReadAsync(string? agent, string path, CancellationToken token) =>
        (await ReadBoundedAsync(agent, path, long.MaxValue, token).ConfigureAwait(false))!;

    public async Task<AgentFileContent?> ReadBoundedAsync(string? agent, string path, long maxBytes, CancellationToken token)
    {
        await using var stream = OpenRegular(agent, path);
        if (stream.Length > maxBytes)
            return null;
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        int read;
        while ((read = await stream.ReadAsync(chunk, token).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > maxBytes)
                return null;
            buffer.Write(chunk, 0, read);
        }
        var bytes = buffer.ToArray();
        return new(bytes, AgentFileErrors.ContentGeneration(bytes));
    }

    public async Task<byte[]> ReadRangeAsync(string? agent, string path, long offset, int count, CancellationToken token)
    {
        await using var stream = OpenRegular(agent, path);
        return await AgentFileErrors.ReadRangeAsync(stream, offset, count, token).ConfigureAwait(false);
    }

    public Task<long> WriteAsync(
        string? agent,
        string path,
        ReadOnlyMemory<byte> content,
        long? expectedGeneration,
        CancellationToken token
    )
    {
        AgentFilePaths.Require(path);
        expectedGeneration = AgentFileErrors.Normalize(expectedGeneration);
        return lanes.RunAsync(
            agent ?? "",
            async () =>
            {
                var full = Resolve(agent, path);
                if (System.IO.Directory.Exists(full))
                    throw AgentFileErrors.IsDirectory(path);
                await CheckExpectationAsync(full, path, expectedGeneration, token).ConfigureAwait(false);
                CreateParents(agent, path);
                var temporary = Path.Combine(
                    Path.GetDirectoryName(full)!,
                    "." + Guid.NewGuid().ToString("N") + ".tmp"
                );
                try
                {
                    await using (
                        var output = new FileStream(
                            temporary,
                            FileMode.CreateNew,
                            FileAccess.Write,
                            FileShare.None,
                            8192,
                            true
                        )
                    )
                    {
                        await output.WriteAsync(content, token).ConfigureAwait(false);
                        await output.FlushAsync(token).ConfigureAwait(false);
                        output.Flush(flushToDisk: true);
                    }
                    File.Move(temporary, full, overwrite: true);
                }
                catch
                {
                    File.Delete(temporary);
                    throw;
                }
                return AgentFileErrors.ContentGeneration(content.Span);
            },
            token
        );
    }

    public Task DeleteAsync(
        string? agent,
        string path,
        bool recursive,
        long? expectedGeneration,
        CancellationToken token
    )
    {
        AgentFilePaths.Require(path, allowRoot: true);
        if (path.Length == 0)
            throw AgentFileErrors.Root();
        expectedGeneration = AgentFileErrors.Normalize(expectedGeneration);
        return lanes.RunAsync(
            agent ?? "",
            async () =>
            {
                var full = Resolve(agent, path);
                if (System.IO.Directory.Exists(full))
                {
                    // A conditional delete removes the file it observed, never a directory.
                    if (expectedGeneration is not null)
                        throw AgentFileErrors.Changed(path);
                    if (!recursive && System.IO.Directory.EnumerateFileSystemEntries(full).Any())
                        throw AgentFileErrors.NotEmpty(path);
                    System.IO.Directory.Delete(full, recursive);
                    return true;
                }
                if (!File.Exists(full))
                    throw AgentFileErrors.NotFound(path);
                await CheckExpectationAsync(full, path, expectedGeneration, token).ConfigureAwait(false);
                File.Delete(full);
                return true;
            },
            token
        );
    }

    public Task RenameAsync(string? agent, string from, string to, bool overwrite, CancellationToken token)
    {
        AgentFilePaths.Require(from, allowRoot: true);
        AgentFilePaths.Require(to, allowRoot: true);
        if (from.Length == 0 || to.Length == 0)
            throw AgentFileErrors.Root();
        return lanes.RunAsync(
            agent ?? "",
            () =>
            {
                var source = Resolve(agent, from);
                var target = Resolve(agent, to);
                var directory = System.IO.Directory.Exists(source);
                if (!directory && !File.Exists(source))
                    throw AgentFileErrors.NotFound(from);
                if (from == to)
                    return Task.FromResult(true);
                if (directory && AgentFilePaths.Within(to, from))
                    throw AgentFileErrors.IntoItself(from);
                if (System.IO.Directory.Exists(target))
                    throw directory ? AgentFileErrors.Exists(to) : AgentFileErrors.IsDirectory(to);
                if (File.Exists(target) && (directory || !overwrite))
                    throw AgentFileErrors.Exists(to);
                CreateParents(agent, to);
                if (directory)
                    System.IO.Directory.Move(source, target);
                else
                    File.Move(source, target, overwrite);
                return Task.FromResult(true);
            },
            token
        );
    }

    public Task MakeDirectoryAsync(string? agent, string path, CancellationToken token)
    {
        AgentFilePaths.Require(path);
        return lanes.RunAsync(
            agent ?? "",
            () =>
            {
                var full = Resolve(agent, path);
                if (File.Exists(full))
                    throw AgentFileErrors.NotDirectory(path);
                CreateParents(agent, path);
                System.IO.Directory.CreateDirectory(full);
                return Task.FromResult(true);
            },
            token
        );
    }

    /// <summary>
    /// The physical path of a store path of an Agent, under the same confinement as every
    /// write here: no existing component below the Agent's directory may be a link.
    /// </summary>
    internal string ConfinedPath(string agent, string path) => Resolve(agent, AgentFilePaths.Require(path, allowRoot: true));

    // The physical path of a store path. The Agent's directory must exist, and no existing
    // component below it may be a symbolic link, so a write can't leave the directory.
    private string Resolve(string? agent, string path, bool lookup = false)
    {
        var root = Directory(agent);
        if (!System.IO.Directory.Exists(root) || IsLink(root))
            throw AgentFileErrors.NoAgent(agent);
        var current = root;
        var walked = "";
        foreach (var segment in path.Length == 0 ? [] : path.Split('/'))
        {
            current = Path.Combine(current, segment);
            walked = walked.Length == 0 ? segment : walked + "/" + segment;
            if (!Path.Exists(current) && !IsLink(current))
                break;
            if (IsLink(current))
                throw AgentFileErrors.Link(walked);
            if (walked != path && File.Exists(current))
            {
                if (lookup)
                    break;
                throw AgentFileErrors.NotDirectory(walked);
            }
        }
        return path.Length == 0 ? root : Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar));
    }

    private void CreateParents(string? agent, string path)
    {
        var parent = AgentFilePaths.Parent(path);
        if (parent.Length > 0)
            System.IO.Directory.CreateDirectory(Resolve(agent, parent));
    }

    private static bool IsLink(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return false;
        }
    }

    private static async Task CheckExpectationAsync(
        string full,
        string path,
        long? expected,
        CancellationToken token
    )
    {
        if (expected is null)
            return;
        if (!File.Exists(full))
        {
            if (expected != 0)
                throw AgentFileErrors.Changed(path);
            return;
        }
        if (expected == 0)
            throw AgentFileErrors.Exists(path);
        if (!Foxwarm.Tools.WorkspaceTools.RegularFile(full))
            throw AgentFileErrors.Changed(path);
        var current = AgentFileErrors.ContentGeneration(
            await File.ReadAllBytesAsync(full, token).ConfigureAwait(false)
        );
        if (current != expected)
            throw AgentFileErrors.Changed(path);
    }
}
