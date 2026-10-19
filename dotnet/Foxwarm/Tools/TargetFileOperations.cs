namespace Foxwarm.Tools;

internal sealed record TargetFileStat(
    string Kind,
    long Size,
    double ModifiedAtMs,
    string? Name = null
);

/// <summary>Target-owned paths and byte operations; no Main path interpretation.</summary>
internal interface ITargetFileOperations
{
    Task<TargetFileStat> StatAsync(string path, CancellationToken token);
    Task<byte[]> ReadAsync(string path, long offset, int count, CancellationToken token);
    Task<IReadOnlyList<TargetFileStat>> ReadDirectoryAsync(string path, CancellationToken token);
    Task<string> ParentAsync(string path, CancellationToken token);
    Task WriteAsync(string path, byte[] bytes, string flag, CancellationToken token);
    Task MakeDirectoryAsync(string path, CancellationToken token);
    Task RemoveAsync(string path, CancellationToken token);
}

internal static class TargetFileContent
{
    internal const int ChunkBytes = 1024 * 1024;

    internal static void RequirePath(string path)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        if (path.Contains('\0'))
            throw new ArgumentException("Invalid path.");
        if (path.StartsWith('$'))
        {
            var slash = path.IndexOf('/');
            var name = path[1..(slash < 0 ? path.Length : slash)];
            throw new ArgumentException(
                name is "fw_agentdir" or "fw_tmp"
                    ? "Native Agent path variables are unavailable on this Node."
                    : "Unknown Agent path variable: $" + name
            );
        }
    }

    internal static async Task<byte[]> ReadAsync(
        ITargetFileOperations operations,
        string path,
        long limit,
        CancellationToken token,
        Action<long>? beforeMaterialize = null,
        int chunkSize = ChunkBytes,
        bool requireRegular = false
    )
    {
        RequirePath(path);
        var stat = await operations.StatAsync(path, token);
        if (stat.Kind == "directory" || requireRegular && stat.Kind != "file")
            throw new IOException("Source path is not a regular file.");
        if (stat.Size > limit || stat.Size > int.MaxValue)
            throw new IOException("File exceeds the materialization limit.");
        beforeMaterialize?.Invoke(stat.Size);
        var bytes = new byte[(int)stat.Size];
        for (var offset = 0; offset < bytes.Length; )
        {
            var chunk = await operations.ReadAsync(
                path,
                offset,
                Math.Min(chunkSize, bytes.Length - offset),
                token
            );
            if (chunk.Length == 0)
                throw new IOException("Source file changed or returned incomplete data.");
            chunk.CopyTo(bytes, offset);
            offset += chunk.Length;
        }
        if ((await operations.ReadAsync(path, stat.Size, 1, token)).Length != 0)
            throw new IOException("Source file changed or returned incomplete data.");
        return bytes;
    }

    internal static async Task WriteAsync(
        ITargetFileOperations operations,
        string path,
        byte[] bytes,
        bool overwrite,
        CancellationToken token
    )
    {
        RequirePath(path);
        try
        {
            _ = await operations.StatAsync(path, token);
            if (!overwrite)
                throw new IOException(
                    "File already exists: " + path + ". Use overwrite=true to replace it."
                );
        }
        catch (Foxwarm.Nodes.NodeProviderException error) when (error.Code == "ENOENT") { }
        await operations.MakeDirectoryAsync(await operations.ParentAsync(path, token), token);
        // Empty files still have one initial create/replace operation. Later errors retain the prefix.
        await operations.WriteAsync(
            path,
            bytes[..Math.Min(ChunkBytes, bytes.Length)],
            overwrite ? "w" : "wx",
            token
        );
        for (var offset = ChunkBytes; offset < bytes.Length; offset += ChunkBytes)
            await operations.WriteAsync(
                path,
                bytes[offset..Math.Min(offset + ChunkBytes, bytes.Length)],
                "a",
                token
            );
    }
}
