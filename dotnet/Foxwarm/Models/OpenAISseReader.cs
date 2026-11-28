using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal static class OpenAISseReader
{
    internal static async Task ReadAsync(
        Stream stream,
        CancellationToken cancellationToken,
        Action<JsonObject> consume,
        ResponsesStreamCallbacks? callbacks,
        StreamOwnership ownership,
        Func<bool>? completed = null,
        bool flushFinalEvent = false,
        int eventBytes = 8 * 1024 * 1024,
        int responseBytes = 32 * 1024 * 1024
    )
    {
        ArgumentNullException.ThrowIfNull(stream);
        cancellationToken.ThrowIfCancellationRequested();
        using var registration =
            ownership == StreamOwnership.Dispose
                ? cancellationToken.Register(
                    static state =>
                    {
                        try
                        {
                            ((Stream)state!).Dispose();
                        }
                        catch { }
                    },
                    stream
                )
                : default;
        var decoder = new UTF8Encoding(false, false).GetDecoder();
        var bytes = new byte[4096];
        var chars = new char[8192];
        using var pending = new MemoryStream();
        var total = 0L;
        var afterNewline = false;
        var afterCr = false;

        void Add(ReadOnlySpan<byte> part)
        {
            if (pending.Length + part.Length > eventBytes)
                throw Net.BoundedResponse.TooLarge("model", "event", eventBytes);
            pending.Write(part);
        }

        void Emit(bool delimited)
        {
            var block = Encoding.UTF8.GetString(pending.GetBuffer(), 0, (int)pending.Length)
                .Replace("\r\n", "\n", StringComparison.Ordinal);
            pending.SetLength(0);
            if (delimited) block = block[..^2];
            callbacks?.OnSseBlock?.Invoke(block);
            var lines = block.Replace("\r", "", StringComparison.Ordinal).Split('\n')
                .Where(line => line.StartsWith("data:", StringComparison.Ordinal))
                .Select(line => OpenAIRequestText.TrimStart(line[5..]));
            var payload = string.Join("\n", lines);
            if (payload.Length == 0 || payload == "[DONE]") return;
            JsonNode? parsed;
            try { parsed = JsonNode.Parse(payload); }
            catch (JsonException error) { throw new MalformedSseEventJsonException(block, error); }
            if (parsed is JsonObject obj) consume(obj);
        }
        try
        {
            while (true)
            {
                int count;
                try
                {
                    count = await stream
                        .ReadAsync(bytes.AsMemory(), cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (Exception error)
                    when (cancellationToken.IsCancellationRequested
                        && error
                            is ObjectDisposedException
                                or IOException
                                or OperationCanceledException
                    )
                {
                    throw new OperationCanceledException(cancellationToken);
                }
                catch (Exception error)
                {
                    throw new ResponsesStreamReadException(error);
                }
                if ((total += count) > responseBytes)
                    throw Net.BoundedResponse.TooLarge("model", "body", responseBytes);
                if (callbacks?.OnDecodedChunk is { } chunk)
                {
                    var written = decoder.GetChars(bytes, 0, count, chars, 0, flush: count == 0);
                    if (written != 0) chunk(new string(chars, 0, written));
                }
                var start = 0;
                for (var i = 0; i < count; i++)
                {
                    var current = bytes[i];
                    if (current == '\n' && afterNewline)
                    {
                        Add(bytes.AsSpan(start, i + 1 - start));
                        Emit(delimited: true);
                        if (completed?.Invoke() == true) return;
                        start = i + 1;
                        afterNewline = false;
                    }
                    else
                        afterNewline = current == '\n' || (afterNewline && !afterCr && current == '\r');
                    afterCr = current == '\r';
                }
                Add(bytes.AsSpan(start, count - start));
                if (count == 0)
                {
                    if (flushFinalEvent && pending.Length != 0) Emit(delimited: false);
                    return;
                }
            }
        }
        finally
        {
            if (ownership == StreamOwnership.Dispose)
            {
                try
                {
                    stream.Dispose();
                }
                catch { }
            }
        }
    }
}
