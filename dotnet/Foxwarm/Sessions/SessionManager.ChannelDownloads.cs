using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private sealed class ReceivedFileTooLarge(long? size) : IOException
    {
        internal long? Size { get; } = size;
    }

    // For hosted Agent files, reject a known size before reading, and stop an unbounded
    // response at the first byte over the cap. An encrypted transport may add padding, which
    // is removed before the ordinary file-size check runs on the plaintext.
    internal async Task<byte[]> ReadChannelBodyAsync(HttpContent body, CancellationToken token, int padding = 0)
    {
        if (Capabilities.Limits is null)
            return await body.ReadAsByteArrayAsync(token);
        var cap = ReceivedFileLimit + padding;
        if (body.Headers.ContentLength is { } known && known > cap)
            throw new ReceivedFileTooLarge(padding == 0 ? known : null);
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        // The response owns its content stream and disposes it with the headers.
        var stream = await body.ReadAsStreamAsync(token);
        while (true)
        {
            var count = await stream.ReadAsync(chunk.AsMemory(0, (int)Math.Min(chunk.Length, cap - buffer.Length + 1)), token);
            if (count == 0)
                return buffer.ToArray();
            if (count + buffer.Length > cap)
                throw new ReceivedFileTooLarge(null);
            buffer.Write(chunk, 0, count);
        }
    }

    internal async Task<IReadOnlyList<JsonObject>> SaveRemoteChannelFileAsync(
        string platform, string conversation, Func<Task<byte[]>> download, string name, string mime,
        string caption, CancellationToken token, bool? image = null)
    {
        try
        {
            return await SaveInboundChannelFileAsync(platform, conversation, await download(), name, mime, caption, token, image);
        }
        catch (ReceivedFileTooLarge error)
        {
            return UnkeptStoredFile(name, mime, caption, error.Size, OversizedReason(ReceivedFileLimit), ReceivedFileLimit);
        }
    }
}
