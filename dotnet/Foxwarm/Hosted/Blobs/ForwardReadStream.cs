namespace Foxwarm.Hosted.Blobs;

/// <summary>
/// A forward-only read stream of a blob whose length is known before the first byte, as the
/// blob stores return from <c>OpenRead</c>. Callers may check <see cref="Length"/> before
/// reading (the image store validates it); seeking isn't supported. Ending early fails with an
/// <see cref="IOException"/> rather than returning a short blob.
/// </summary>
internal abstract class ForwardReadStream(long length) : Stream
{
    private long position;

    public sealed override bool CanRead => true;

    public sealed override bool CanSeek => false;

    public sealed override bool CanWrite => false;

    public sealed override long Length => length;

    public sealed override long Position
    {
        get => position;
        set => throw new NotSupportedException();
    }

    /// <summary>Reads at most <paramref name="buffer"/>'s length; 0 only at the end of the source.</summary>
    protected abstract int ReadSource(Span<byte> buffer);

    protected abstract ValueTask<int> ReadSourceAsync(Memory<byte> buffer, CancellationToken token);

    public sealed override int Read(byte[] buffer, int offset, int count) =>
        Read(buffer.AsSpan(offset, count));

    public sealed override int Read(Span<byte> buffer)
    {
        if (buffer.Length == 0 || position == length)
            return Settle(0, buffer.Length);
        return Settle(ReadSource(buffer[..Remaining(buffer.Length)]), buffer.Length);
    }

    public sealed override Task<int> ReadAsync(
        byte[] buffer,
        int offset,
        int count,
        CancellationToken cancellationToken
    ) => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public sealed override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default
    )
    {
        if (buffer.Length == 0 || position == length)
            return Settle(0, buffer.Length);
        var read = await ReadSourceAsync(buffer[..Remaining(buffer.Length)], cancellationToken)
            .ConfigureAwait(false);
        return Settle(read, buffer.Length);
    }

    private int Remaining(int requested) => (int)Math.Min(requested, length - position);

    private int Settle(int read, int requested)
    {
        if (read == 0 && requested > 0 && position < length)
            throw new IOException(
                $"The blob ended after {position} of {length} bytes."
            );
        position += read;
        return read;
    }

    public sealed override void Flush() { }

    public sealed override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public sealed override void SetLength(long value) => throw new NotSupportedException();

    public sealed override void Write(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();
}
