namespace Foxwarm.Nodes;

/// <summary>
/// Bounded newline-delimited frame reader shared by the persistent Provider service channel
/// and the CLI Node stdio mode. A frame is one UTF-8 JSON text terminated by LF (CRLF accepted).
/// </summary>
internal sealed class NdjsonLineReader(Stream stream, int frameLimit)
{
    private readonly byte[] buffer = new byte[64 * 1024];
    private int start;
    private int end;
    private MemoryStream? partial;

    /// <summary>The maximum bytes in one frame, excluding the line terminator.</summary>
    internal int FrameLimit => frameLimit;

    /// <summary>
    /// Returns the next nonblank frame, or null at end of stream. A final unterminated frame
    /// is rejected rather than parsed so that a truncated write is never mistaken for a frame.
    /// </summary>
    internal async Task<byte[]?> ReadAsync(CancellationToken token, int? limit = null)
    {
        var max = Math.Min(limit ?? frameLimit, frameLimit);
        while (true)
        {
            if (start == end)
            {
                start = 0;
                end = await stream.ReadAsync(buffer.AsMemory(), token);
                if (end == 0)
                {
                    if (partial is { Length: > 0 })
                        throw new InvalidDataException("Frame was not terminated.");
                    return null;
                }
            }
            var newline = Array.IndexOf(buffer, (byte)'\n', start, end - start);
            var count = newline < 0 ? end - start : newline - start;
            var held = partial?.Length ?? 0;
            if (held + count > max + 1)
                throw new InvalidDataException("Frame exceeds the byte limit.");
            if (newline < 0)
            {
                partial ??= new MemoryStream();
                partial.Write(buffer, start, count);
                start = end;
                continue;
            }
            byte[] frame;
            if (partial is { Length: > 0 })
            {
                partial.Write(buffer, start, count);
                frame = partial.ToArray();
                partial.SetLength(0);
            }
            else
                frame = buffer.AsSpan(start, count).ToArray();
            start = newline + 1;
            var length = frame.Length;
            if (length > 0 && frame[length - 1] == (byte)'\r')
                length--;
            if (length > max)
                throw new InvalidDataException("Frame exceeds the byte limit.");
            if (length == 0)
                continue;
            return length == frame.Length ? frame : frame.AsSpan(0, length).ToArray();
        }
    }

    /// <summary>Writes one frame and its terminator; the caller serializes writers.</summary>
    internal static async Task WriteAsync(Stream stream, byte[] frame, CancellationToken token)
    {
        await stream.WriteAsync(frame, token);
        await stream.WriteAsync(new byte[] { (byte)'\n' }, token);
        await stream.FlushAsync(token);
    }
}
