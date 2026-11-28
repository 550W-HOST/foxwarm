namespace Foxwarm.Hosted.Forwarding;

/// <summary>Reads the original upload on first dispatch, retaining at most 64 KiB when a buffer is reserved.</summary>
internal sealed class ForwardedBody(Stream input, long? contentLength, bool retain) : Stream
{
    internal const int Limit = 64 * 1024;
    private MemoryStream? copy = retain ? new MemoryStream() : null;
    private long consumed;
    private bool complete;
    private bool replay;

    /// <summary>Called only after YARP has settled its previous content producer.</summary>
    internal bool RewindIfAvailable()
    {
        if (consumed == 0) return true;
        if (!complete || copy is null) return false;
        copy.Position = 0;
        replay = true;
        return true;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken cancellationToken = default)
    {
        if (replay) return await copy!.ReadAsync(destination, cancellationToken).ConfigureAwait(false);
        var count = await input.ReadAsync(destination, cancellationToken).ConfigureAwait(false);
        Record(destination.Span[..count], destination.Length);
        return count;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (replay) return copy!.Read(buffer, offset, count);
        var read = input.Read(buffer, offset, count);
        Record(buffer.AsSpan(offset, read), count);
        return read;
    }

    private void Record(ReadOnlySpan<byte> bytes, int requested)
    {
        consumed += bytes.Length;
        if (copy is not null)
        {
            if (consumed <= Limit) copy.Write(bytes);
            else { copy.Dispose(); copy = null; }
        }
        complete = consumed == contentLength || (requested > 0 && bytes.Length == 0);
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing) copy?.Dispose();
        base.Dispose(disposing);
    }
}
