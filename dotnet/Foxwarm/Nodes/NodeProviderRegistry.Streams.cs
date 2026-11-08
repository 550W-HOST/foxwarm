using System.Security.Cryptography;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Nodes;

internal sealed record TransferSource(
    Stream Stream,
    long Length,
    string Path,
    string Name,
    string? MimeType = null
) : IAsyncDisposable
{
    public ValueTask DisposeAsync() => Stream.DisposeAsync();
}

internal static class TransferStream
{
    internal static async Task<string> CopyAsync(
        Stream input,
        Stream output,
        long length,
        CancellationToken token
    )
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[65536];
        long total = 0;
        int count;
        while ((count = await input.ReadAsync(buffer, token)) != 0)
        {
            if (count > length - total)
                throw new IOException("Source file changed or transfer was interrupted.");
            hash.AppendData(buffer, 0, count);
            await output.WriteAsync(buffer.AsMemory(0, count), token);
            total += count;
        }
        if (total != length)
            throw new IOException("Source file changed or transfer was interrupted.");
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}

internal sealed partial class NodeProviderRegistry
{
    internal async Task<TransferSource> OpenReadAsync(
        string node,
        string path,
        SessionOwner owner,
        bool ingress,
        CancellationToken token
    )
    {
        if (!IsProviderNode(node))
        {
            return await native.OpenReadStreamAsync(node, path, owner, ingress, token);
        }
        TargetFileContent.RequirePath(path);
        var operations = await FileOperationsAsync(node, false, null, token);
        var stat = await operations.StatAsync(path, token);
        if (stat.Kind != "file" || stat.Size < 0)
            throw new IOException("Source path is not a regular file.");
        var name = NodeConnectionHub.RemoteFileName(path);
        return new(
            new PrimitiveReadStream(operations, path, stat.Size),
            stat.Size,
            path,
            name,
            TransferMime(name)
        );
    }

    internal async Task<(string Path, string Sha256)> WriteStreamAsync(
        string node,
        string path,
        Stream input,
        long length,
        bool overwrite,
        SessionOwner owner,
        bool ingress,
        CancellationToken token
    )
    {
        if (!IsProviderNode(node))
        {
            return await native.WriteStreamAsync(
                node,
                path,
                input,
                length,
                overwrite,
                owner,
                ingress,
                token
            );
        }
        owner.Entry.RequireIdentityAuthority();
        TargetFileContent.RequirePath(path);
        var operations = await FileOperationsAsync(node, true, null, token);
        try
        {
            _ = await operations.StatAsync(path, token);
            if (!overwrite)
                throw new IOException(
                    "File already exists: " + path + ". Use overwrite=true to replace it."
                );
        }
        catch (NodeProviderException error) when (error.Code == "ENOENT") { }
        await operations.MakeDirectoryAsync(await operations.ParentAsync(path, token), token);
        await using var output = new PrimitiveWriteStream(operations, path, overwrite);
        var sha = await TransferStream.CopyAsync(input, output, length, token);
        await output.CompleteAsync(token);
        return (path, sha);
    }
}

internal sealed class PrimitiveReadStream(
    ITargetFileOperations operations,
    string path,
    long length
) : Stream
{
    private byte[] chunk = [];
    private int position;
    private long fetched;
    private bool done;

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default
    )
    {
        if (buffer.Length == 0)
            return 0;
        if (position == chunk.Length && !done)
        {
            chunk = await operations.ReadAsync(
                path,
                fetched,
                TargetFileContent.ChunkBytes,
                cancellationToken
            );
            position = 0;
            if (chunk.LongLength > length - fetched)
                throw new IOException("Source file changed or returned incomplete data.");
            fetched += chunk.Length;
            if (chunk.Length < TargetFileContent.ChunkBytes)
            {
                done = true;
                if (fetched != length)
                    throw new IOException("Source file changed or returned incomplete data.");
            }
        }
        var count = Math.Min(buffer.Length, chunk.Length - position);
        chunk.AsMemory(position, count).CopyTo(buffer);
        position += count;
        return count;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => length;
    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();

    public override void Flush() { }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();
}

internal sealed class PrimitiveWriteStream(
    ITargetFileOperations operations,
    string path,
    bool overwrite
) : Stream
{
    private readonly byte[] buffer = new byte[TargetFileContent.ChunkBytes];
    private int used;
    private bool started;

    public override async ValueTask WriteAsync(
        ReadOnlyMemory<byte> source,
        CancellationToken cancellationToken = default
    )
    {
        while (!source.IsEmpty)
        {
            var count = Math.Min(source.Length, buffer.Length - used);
            source[..count].CopyTo(buffer.AsMemory(used));
            used += count;
            source = source[count..];
            if (used == buffer.Length)
                await FlushChunk(cancellationToken);
        }
    }

    private async Task FlushChunk(CancellationToken token)
    {
        await operations.WriteAsync(
            path,
            buffer[..used],
            started ? "a"
                : overwrite ? "w"
                : "wx",
            token
        );
        started = true;
        used = 0;
    }

    internal async Task CompleteAsync(CancellationToken token)
    {
        if (used > 0 || !started)
            await FlushChunk(token);
    }

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();

    public override void Flush() { }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();
}
