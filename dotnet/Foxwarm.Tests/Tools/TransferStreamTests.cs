using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed class TransferStreamTests
{
    [Fact]
    public async Task Copy_accepts_lengths_above_two_gib_without_materializing_the_source()
    {
        const long size = (long)int.MaxValue + 100;
        await using var input = new GeneratedStream(size);
        var digest = await TransferStream.CopyAsync(input, Stream.Null, size, default);
        Assert.Equal(0, input.Remaining);
        Assert.Equal(64, digest.Length);
    }

    [Theory]
    [InlineData(9, 10)]
    [InlineData(11, 10)]
    public async Task Copy_rejects_source_length_changes(long supplied, long expected)
    {
        await using var input = new GeneratedStream(supplied);
        await Assert.ThrowsAsync<IOException>(() =>
            TransferStream.CopyAsync(input, Stream.Null, expected, default)
        );
    }

    private sealed class GeneratedStream(long size) : Stream
    {
        internal long Remaining { get; private set; } = size;

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            cancellationToken.ThrowIfCancellationRequested();
            var count = (int)Math.Min(Remaining, buffer.Length);
            buffer.Span[..count].Clear();
            Remaining -= count;
            return ValueTask.FromResult(count);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length { get; } = size;
        public override long Position
        {
            get => Length - Remaining;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }
}
