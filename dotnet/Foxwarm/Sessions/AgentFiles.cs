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
/// Read access to Agent memory and the installation's prompt files. Paths are relative and
/// '/'-separated; a null Agent addresses the installation level beside the Agent folders. A
/// locator names where a file lives and is shown in the composed system prompt, so it must be
/// stable for an unchanged installation (D-request-prefix-stability). Listings are unordered;
/// callers order them. The file implementation is <see cref="FileAgentFiles"/>.
/// </summary>
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
}

/// <summary>Agent folders as <see cref="AgentCatalog"/> lays them out.</summary>
internal sealed class FileAgentFiles(AgentCatalog agents) : IAgentFileStore
{
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
                    file?.LastWriteTimeUtc
                );
            })
            .ToArray();
    }
}
