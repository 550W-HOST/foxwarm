using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>
/// Paths of the Agent-folder file tools (<c>node:@agent/read</c>, <c>write</c>, <c>edit</c>,
/// and the <c>@agent</c> endpoint of <c>node copy</c>): relative to the caller's own Agent
/// folder, or starting with <c>$fw_agentdir/</c>. <c>.</c> and <c>..</c> resolve lexically and
/// may not leave the folder; absolute paths and other variables are outside it.
/// </summary>
internal static class AgentFolderPaths
{
    internal const string Variable = "$fw_agentdir";

    internal static InvalidDataException Outside(string raw) =>
        new($"`{AgentStorePaths.Endpoint}` reaches only this Agent's own folder: {raw}.");

    /// <summary>Whether a Main-routed path names the Agent folder through its variable.</summary>
    internal static bool NamesFolder(string? raw) =>
        raw is not null
        && (raw == Variable || raw.StartsWith(Variable + "/", StringComparison.Ordinal));

    /// <summary>
    /// The folder-relative path of a raw path, with <c>/</c> separators and no <c>.</c> or
    /// <c>..</c> segments; "" is the folder itself.
    /// </summary>
    internal static string Relative(string raw)
    {
        if (raw is null || raw.Contains('\0'))
            throw new InvalidDataException("Invalid path.");
        var text = raw;
        if (NamesFolder(text))
            text = text[Variable.Length..].TrimStart('/');
        else if (
            text.StartsWith('/')
            || text.StartsWith('~')
            || text.StartsWith('$')
            || text.Length >= 2 && text[1] == ':'
        )
            throw Outside(raw);
        var segments = new List<string>();
        foreach (var segment in text.Split('/'))
        {
            if (segment is "" or ".")
                continue;
            if (segment == "..")
            {
                if (segments.Count == 0)
                    throw Outside(raw);
                segments.RemoveAt(segments.Count - 1);
                continue;
            }
            segments.Add(segment);
        }
        return string.Join('/', segments);
    }

    /// <summary>The store path of a raw path; an invalid store path fails with its reason.</summary>
    internal static string StorePath(string raw)
    {
        // The store has no temporary directory of its own.
        if (raw == "$fw_tmp" || raw.StartsWith("$fw_tmp/", StringComparison.Ordinal))
            throw new InvalidDataException("`$fw_tmp` isn't available here; use a path under `$fw_agentdir/`.");
        var relative = Relative(raw);
        try
        {
            return AgentFilePaths.Require(relative, allowRoot: true);
        }
        catch (AgentFilePathException error)
        {
            throw new InvalidDataException(error.Message);
        }
    }

    /// <summary>The physical path of a raw path inside an Agent directory.</summary>
    internal static string Physical(string agentDirectory, string raw)
    {
        var relative = Relative(raw);
        var root = Path.GetFullPath(agentDirectory);
        return relative.Length == 0
            ? root
            : Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
    }
}

/// <summary>
/// How a <see cref="WorkspaceTools"/> confined to one Agent's folder resolves paths and states
/// them as authorization facts. Over Agent folders the facts are master's physical paths, as
/// for any master file tool; over an Agent store they are store paths on <c>@agent</c>.
/// </summary>
internal sealed record AgentFolderScope(string Agent, string? Directory)
{
    internal bool Store => Directory is null;

    // Paths resolve to store paths in both modes; the folder's file owner (the store, or
    // FileAgentFiles over the physical folder) applies the store's rules, links included.
    internal string Resolve(string raw) => AgentFolderPaths.StorePath(raw);

    // Facts are store paths on `@agent`, or master's physical paths over folders.
    internal AuthorizationPath Fact(string arg, string raw, string resolved) =>
        Store
            ? new(arg, raw, AgentStorePaths.Fact(Agent, resolved), AgentStorePaths.Endpoint)
            : new(arg, raw, AuthorizationPaths.CanonicalPotential(Physical(resolved)));

    // The master path of a folder path, over folders.
    internal string Physical(string resolved) =>
        resolved.Length == 0
            ? Path.GetFullPath(Directory!)
            : Path.Combine(Path.GetFullPath(Directory!), resolved.Replace('/', Path.DirectorySeparatorChar));
}

/// <summary>Whole-file writes, for targets where appending costs a full rewrite.</summary>
internal interface IWholeTargetFileWrites
{
    Task WriteWholeAsync(string path, byte[] bytes, bool overwrite, CancellationToken token);
}

/// <summary>
/// One Agent's files in an Agent store as a file target. Paths are store paths (validated by
/// <see cref="AgentFolderScope"/> before they get here); missing entries and type clashes fail
/// with the codes a Node's file primitives use.
/// </summary>
internal sealed class AgentStoreFileOperations(IAgentFileStore store, string agent)
    : ITargetFileOperations,
        IWholeTargetFileWrites
{
    private static NodeProviderException Missing(string path) =>
        new("ENOENT", "No such file or directory: " + path);

    private static double Milliseconds(DateTime? time) =>
        time is { } value
            ? new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeMilliseconds()
            : 0;

    // Kind, length and time only: no content is read and no generation is computed.
    public Task<TargetFileStat> StatAsync(string path, CancellationToken token)
    {
        var kind = store.Kind(agent, path) ?? throw Missing(path);
        return Task.FromResult(
            new TargetFileStat(
                kind.Kind,
                kind.Kind == "directory" ? 0 : kind.Length,
                Milliseconds(kind.LastWriteUtc),
                path.Length == 0 ? "" : path[(path.LastIndexOf('/') + 1)..]
            )
        );
    }

    // A configuration candidate: one committed version of a regular file, or null when it is
    // larger than the limit.
    internal async Task<byte[]?> ReadCandidateAsync(string path, long? limit, CancellationToken token)
    {
        if (store.Kind(agent, path) is not { Kind: "file" })
            throw new InvalidDataException("Configuration candidate must be a regular file.");
        try
        {
            // The limit applies to the version that is read, before its content is.
            return (await store.ReadBoundedAsync(agent, path, limit ?? long.MaxValue, token))?.Bytes;
        }
        catch (Exception error) when (error is FileNotFoundException or UnauthorizedAccessException or IOException and not AgentFileConflictException)
        {
            throw new InvalidDataException("Configuration candidate must be a regular file.");
        }
    }

    public async Task<byte[]> ReadAsync(string path, long offset, int count, CancellationToken token)
    {
        try
        {
            return await store.ReadRangeAsync(agent, path, offset, count, token);
        }
        catch (FileNotFoundException)
        {
            throw Missing(path);
        }
    }

    public Task<IReadOnlyList<TargetFileStat>> ReadDirectoryAsync(string path, CancellationToken token)
    {
        var directory = store.Kind(agent, path);
        if (directory is not { Kind: "directory" })
            throw directory is null
                ? Missing(path)
                : new NodeProviderException("ENOTDIR", "Not a directory: " + path);
        // A link is listed as a link, from its own metadata; it is never followed.
        IReadOnlyList<TargetFileStat> entries = store
            .List(agent, path)
            .Select(entry =>
            {
                if (entry.IsLink)
                    return new TargetFileStat("symlink", 0, Milliseconds(entry.LastWriteUtc), entry.Name);
                var modified = entry.IsDirectory
                    ? store.Kind(agent, path.Length == 0 ? entry.Name : path + "/" + entry.Name)?.LastWriteUtc
                    : entry.LastWriteUtc;
                return new TargetFileStat(
                    entry.IsDirectory ? "directory" : "file",
                    entry.IsDirectory ? 0 : entry.Length ?? 0,
                    Milliseconds(modified),
                    entry.Name
                );
            })
            .ToArray();
        return Task.FromResult(entries);
    }

    public Task<string> ParentAsync(string path, CancellationToken token) =>
        Task.FromResult(path.Length == 0 ? "" : AgentFilePaths.Parent(path));

    public async Task WriteAsync(string path, byte[] bytes, string flag, CancellationToken token)
    {
        switch (flag)
        {
            case "w":
                await WriteWholeAsync(path, bytes, overwrite: true, token);
                return;
            case "wx":
                await WriteWholeAsync(path, bytes, overwrite: false, token);
                return;
            case "a":
                // A rewrite conditioned on the content it extends.
                RequireParent(path);
                AgentFileContent current;
                try
                {
                    current = await store.ReadAsync(agent, path, token);
                }
                catch (FileNotFoundException)
                {
                    throw Missing(path);
                }
                await Effect(
                    path,
                    () => store.WriteAsync(agent, path, current.Bytes.Concat(bytes).ToArray(), current.Generation, token)
                );
                return;
            default:
                throw new ArgumentException("Unsupported write flag: " + flag);
        }
    }

    // A file write needs its parent directory, as a file system's does; the store would
    // create it.
    private void RequireParent(string path)
    {
        if (path.Length == 0)
            return;
        var parent = AgentFilePaths.Parent(path);
        switch (store.Kind(agent, parent))
        {
            case null:
                throw Missing(path);
            case { Kind: not "directory" }:
                throw new NodeProviderException("ENOTDIR", "Not a directory: " + path);
        }
    }

    public Task WriteWholeAsync(string path, byte[] bytes, bool overwrite, CancellationToken token)
    {
        RequireParent(path);
        // A directory is an existing entry that a file write never replaces, as on a file system.
        if (store.Kind(agent, path) is { Kind: "directory" })
            throw new NodeProviderException("EEXIST", "File already exists: " + path);
        return Effect(path, () => store.WriteAsync(agent, path, bytes, overwrite ? null : 0, token));
    }

    public Task MakeDirectoryAsync(string path, CancellationToken token) =>
        path.Length == 0 ? Task.CompletedTask : Effect(path, () => store.MakeDirectoryAsync(agent, path, token));

    // Files only: the delete is conditional on the file's generation, so it never removes a
    // directory or a replacement that took the name.
    public Task RemoveAsync(string path, CancellationToken token) =>
        store.Stat(agent, path) switch
        {
            null => throw Missing(path),
            { IsDirectory: true } => throw new NodeProviderException("EISDIR", "Is a directory: " + path),
            var file => Effect(path, () => store.DeleteAsync(agent, path, recursive: false, file.Generation, token)),
        };

    // Store failures as a Node's file primitives report them: the codes callers branch on,
    // with the store's own texts (limits, conflicts) kept.
    private async Task Effect(string path, Func<Task> effect)
    {
        try
        {
            await effect();
        }
        catch (AgentFileConflictException error) when (error.Message.StartsWith("File already exists", StringComparison.Ordinal))
        {
            throw new NodeProviderException("EEXIST", error.Message);
        }
        catch (FileNotFoundException)
        {
            throw Missing(path);
        }
        catch (DirectoryNotFoundException)
        {
            throw Missing(path);
        }
        catch (IOException error) when (error.Message.StartsWith("Not a directory", StringComparison.Ordinal))
        {
            throw new NodeProviderException("ENOTDIR", error.Message);
        }
    }
}
