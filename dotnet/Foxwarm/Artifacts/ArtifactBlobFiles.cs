using System.Security.Cryptography;
using Foxwarm.Storage;

namespace Foxwarm.Artifacts;

/// <summary>
/// Artifact revisions and resources below one directory (<c>state/artifacts</c> in a host),
/// in owner-only directories and files. Keys are <c>&lt;artifact ID&gt;/&lt;revision&gt;.json</c> and
/// <c>&lt;artifact ID&gt;/resources/&lt;SHA-256&gt;</c>.
/// </summary>
internal sealed class ArtifactBlobFiles(string root) : IBlobStore
{
    private string PathFor(string key) => Path.Combine(root, key);

    public bool Exists(string key) => File.Exists(PathFor(key));

    public async Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        CancellationToken token
    )
    {
        var target = PathFor(key);
        CreatePrivateDirectory(Path.GetDirectoryName(target)!);
        var temporary =
            target + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp";
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
            };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var stream = new FileStream(temporary, options))
                await stream.WriteAsync(content, token);
            try
            {
                File.Move(temporary, target);
                return true;
            }
            catch (IOException) when (keepExisting && File.Exists(target))
            {
                return false;
            }
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    public Task<byte[]> ReadAllAsync(string key, CancellationToken token) =>
        File.ReadAllBytesAsync(PathFor(key), token);

    public async Task<byte[]> ReadRangeAsync(string key, long offset, int count, CancellationToken token)
    {
        await using var stream = new FileStream(PathFor(key), FileMode.Open, FileAccess.Read, FileShare.Read, 1, FileOptions.Asynchronous);
        return await Foxwarm.Sessions.AgentFileErrors.ReadRangeAsync(stream, offset, count, token);
    }

    public Stream OpenRead(string key) => File.OpenRead(PathFor(key));

    public IReadOnlyList<string> List(string prefix) =>
        Directory
            .EnumerateFiles(PathFor(prefix))
            .Select(path => Path.GetFileName(path))
            .ToArray();

    public string? LocalPath(string key) => PathFor(key);

    private static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(path);
        else
            Directory.CreateDirectory(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
    }
}
