using Foxwarm.Storage;
using Foxwarm.Tools;

namespace Foxwarm.Images;

/// <summary>
/// Image blobs in <c>state/image-blobs/&lt;first two characters&gt;/&lt;blob ID&gt;</c>. Writes are
/// flushed to disk and their directories synced up to <c>state/</c>.
/// </summary>
internal sealed class ImageBlobFiles(string dataRoot) : IBlobStore
{
    private readonly string state = Path.Combine(Path.GetFullPath(dataRoot), "state");

    internal string Root => Path.Combine(state, "image-blobs");

    internal string PathFor(string key)
    {
        var filename = Path.Combine(Root, key[..2], key);
        var actual = AuthorizationPaths.CanonicalPotential(filename);
        var root = AuthorizationPaths.CanonicalPotential(Root);
        if (!actual.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ImageInputException("Image blob resolves outside its store.");
        return filename;
    }

    public bool Exists(string key) => File.Exists(PathFor(key));

    public async Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        CancellationToken token
    )
    {
        var filename = PathFor(key);
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        var created = false;
        if (!File.Exists(filename))
        {
            var temp = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await using (
                    var file = new FileStream(
                        temp,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        65536,
                        FileOptions.Asynchronous
                    )
                )
                {
                    await file.WriteAsync(content, token);
                    await file.FlushAsync(token);
                    file.Flush(true);
                }
                try
                {
                    File.Move(temp, filename);
                    created = true;
                }
                catch (IOException) when (keepExisting && File.Exists(filename)) { }
            }
            finally
            {
                if (File.Exists(temp))
                    File.Delete(temp);
            }
        }
        else if (!keepExisting)
            throw new IOException("Image blob already exists.");
        DirectorySync.Sync(Path.GetDirectoryName(filename)!);
        DirectorySync.Sync(Root);
        DirectorySync.Sync(state);
        return created;
    }

    public Task<byte[]> ReadAllAsync(string key, CancellationToken token) =>
        File.ReadAllBytesAsync(PathFor(key), token);

    public Stream OpenRead(string key) =>
        new FileStream(
            PathFor(key),
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            65536,
            FileOptions.Asynchronous
        );

    public IReadOnlyList<string> List(string prefix) =>
        Directory
            .EnumerateFiles(Path.Combine(Root, prefix))
            .Select(path => Path.GetFileName(path))
            .ToArray();

    public string? LocalPath(string key) => PathFor(key);
}
