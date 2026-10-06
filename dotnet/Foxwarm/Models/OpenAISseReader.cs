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
        StreamOwnership ownership
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
        var pending = "";
        void Append(string text)
        {
            if (text.Length == 0)
                return;
            callbacks?.OnDecodedChunk?.Invoke(text);
            pending += text;
            pending = pending.Replace("\r\n", "\n", StringComparison.Ordinal);
            while (true)
            {
                var boundary = pending.IndexOf("\n\n", StringComparison.Ordinal);
                if (boundary < 0)
                    return;
                var block = pending[..boundary];
                pending = pending[(boundary + 2)..];
                callbacks?.OnSseBlock?.Invoke(block);
                var lines = block
                    .Replace("\r", "", StringComparison.Ordinal)
                    .Split('\n')
                    .Where(line => line.StartsWith("data:", StringComparison.Ordinal))
                    .Select(line => OpenAIRequestText.TrimStart(line[5..]))
                    .ToArray();
                if (lines.Length == 0)
                    continue;
                var payload = string.Join("\n", lines);
                if (payload.Length == 0 || payload == "[DONE]")
                    continue;
                JsonNode? parsed;
                try
                {
                    parsed = JsonNode.Parse(payload);
                }
                catch (JsonException error)
                {
                    throw new MalformedSseEventJsonException(block, error);
                }
                if (parsed is JsonObject obj)
                    consume(obj);
            }
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
                decoder.Convert(
                    bytes.AsSpan(0, count),
                    chars,
                    count == 0,
                    out var consumed,
                    out var written,
                    out _
                );
                if (consumed != count)
                    throw new InvalidDataException(
                        "SSE decoder did not consume the complete input chunk."
                    );
                Append(new string(chars, 0, written));
                if (count == 0)
                    return;
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
