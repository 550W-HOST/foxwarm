using Foxwarm.Sessions;

namespace Foxwarm;

// One entry of a skill directory listing.
internal sealed record SkillFileEntry(string FullPath, string Name, bool IsDirectory, bool IsLink);

/// <summary>
/// Where a skill root's files are read: the file system (global skills, Agent folders) or an
/// Agent store. Paths are the root's own: physical paths, or for a store the locators
/// (<c>agents/&lt;agent&gt;/skills/...</c>) of its files, so skill resolution composes them the
/// same way. Each member keeps the file-system call it replaces: existence follows links,
/// <see cref="IsLink"/> reports a reparse point, which skill resolution never enters.
/// </summary>
internal interface ISkillFiles
{
    bool DirectoryExists(string path);
    bool FileExists(string path);
    bool IsLink(string path);
    IReadOnlyList<SkillFileEntry> Entries(string path);
    long Length(string path);
    Task<byte[]> ReadAllBytesAsync(string path, CancellationToken token = default);
    Task<string> ReadAllTextAsync(string path);
}

internal sealed class PhysicalSkillFiles : ISkillFiles
{
    internal static readonly PhysicalSkillFiles Instance = new();

    public bool DirectoryExists(string path) => Directory.Exists(path);

    public bool FileExists(string path) => File.Exists(path);

    public bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    public IReadOnlyList<SkillFileEntry> Entries(string path) =>
        new DirectoryInfo(path)
            .GetFileSystemInfos()
            .Select(info => new SkillFileEntry(
                info.FullName,
                info.Name,
                info is DirectoryInfo,
                (info.Attributes & FileAttributes.ReparsePoint) != 0
            ))
            .ToArray();

    public long Length(string path) => new FileInfo(path).Length;

    public Task<byte[]> ReadAllBytesAsync(string path, CancellationToken token = default) =>
        File.ReadAllBytesAsync(path, token);

    public Task<string> ReadAllTextAsync(string path) => File.ReadAllTextAsync(path);
}

/// <summary>An Agent's skills in an Agent store, addressed by the locators of its files.</summary>
internal sealed class StoreSkillFiles(IAgentStore store, string agent) : ISkillFiles
{
    private readonly string prefix = store.Locator(agent, "");

    // The store path a locator names; null for anything else, which exists nowhere.
    private string? Relative(string path)
    {
        var normalized = path.Replace('\\', '/').TrimEnd('/');
        if (!normalized.StartsWith(prefix, StringComparison.Ordinal))
            return null;
        var relative = normalized[prefix.Length..];
        return AgentFilePaths.Problem(relative) is null ? relative : null;
    }

    private AgentFileStat? Stat(string path) => Relative(path) is { } relative ? store.Stat(agent, relative) : null;

    public bool DirectoryExists(string path) => Stat(path) is { IsDirectory: true };

    public bool FileExists(string path) => Stat(path) is { IsDirectory: false };

    public bool IsLink(string path) => false;

    public IReadOnlyList<SkillFileEntry> Entries(string path)
    {
        if (Relative(path) is not { } relative || store.Stat(agent, relative) is not { IsDirectory: true })
            throw new DirectoryNotFoundException("No such directory: " + path);
        return store
            .List(agent, relative)
            .Select(entry => new SkillFileEntry(Path.Combine(path, entry.Name), entry.Name, entry.IsDirectory, false))
            .ToArray();
    }

    public long Length(string path) =>
        Stat(path) is { IsDirectory: false } stat ? stat.Length : throw new FileNotFoundException("No such file: " + path);

    public async Task<byte[]> ReadAllBytesAsync(string path, CancellationToken token = default) =>
        (await store.ReadAsync(agent, Relative(path) ?? throw new FileNotFoundException("No such file: " + path), token))
            .Bytes;

    public Task<string> ReadAllTextAsync(string path) =>
        store.ReadTextAsync(agent, Relative(path) ?? throw new FileNotFoundException("No such file: " + path), default);
}
