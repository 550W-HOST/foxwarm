namespace Foxwarm.Hosted.Forwarding;

/// <summary>Transparent non-seekable duplex stream for the two mesh transport boundaries.</summary>
internal abstract class MeshDuplexStream(Stream inner) : Stream
{
    protected Stream Inner { get; } = inner;
    public override bool CanRead => Inner.CanRead;
    public override bool CanWrite => Inner.CanWrite;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => Inner.Read(buffer, offset, count);
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => Inner.ReadAsync(buffer, token);
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
    public override void Write(byte[] buffer, int offset, int count) => Inner.Write(buffer, offset, count);
    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default) => Inner.WriteAsync(buffer, token);
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) => WriteAsync(buffer.AsMemory(offset, count), token).AsTask();
    public override void Flush() => Inner.Flush();
    public override Task FlushAsync(CancellationToken token) => Inner.FlushAsync(token);
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing) Inner.Dispose();
        base.Dispose(disposing);
    }
}
