namespace Foxwarm;

// Both official MCP HTTP transports consume this stream. The SDK's SSE parser
// accepts CR, LF and CRLF (also across reads); a blank line ends one event.
internal sealed class McpResponseBudget(string server, int limit, bool sse, bool streamingGet, Action<InvalidDataException>? rejected = null)
{
    private long total;
    private int eventBytes;
    private bool hasLineData, afterCr;

    internal void Read(ReadOnlySpan<byte> bytes)
    {
        if (!streamingGet && (total += bytes.Length) > limit)
            throw TooLarge("body");
        if (!sse) return;
        foreach (byte value in bytes)
        {
            if (++eventBytes > limit) throw TooLarge("event");
            if (value == '\n' && afterCr) { afterCr = false; continue; }
            afterCr = value == '\r';
            if (afterCr || value == '\n')
            {
                if (!hasLineData) eventBytes = 0;
                hasLineData = false;
            }
            else hasLineData = true;
        }
    }
    private InvalidDataException TooLarge(string portion)
    {
        var error = Net.BoundedResponse.TooLarge(server, portion, limit);
        rejected?.Invoke(error);
        return error;
    }

}
