using System.IO.Compression;
using System.Net;

namespace Foxwarm.Models;

// Axios' Node adapter decodes responses independently of request compression,
// while respecting an explicitly configured Accept-Encoding header. Do this at
// the shared handler boundary so success streams and error bodies see one decoder.
internal sealed class ProviderResponseDecodingHandler(HttpMessageHandler inner) : DelegatingHandler(inner)
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var response = await base.SendAsync(request, token).ConfigureAwait(false);
        try
        {
            var content = response.Content;
            var encoding = string.Join(", ", content.Headers.ContentEncoding).ToLowerInvariant();
            if (encoding is not ("gzip" or "x-gzip" or "compress" or "x-compress" or "deflate" or "br"))
                return response;
            if (request.Method == HttpMethod.Head || response.StatusCode == HttpStatusCode.NoContent)
            {
                content.Headers.ContentEncoding.Clear();
                return response;
            }
            var stream = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
            Stream decoded;
            if (encoding == "br")
                decoded = new BrotliStream(stream, CompressionMode.Decompress);
            else
            {
                // Axios accepts both zlib-wrapped and raw deflate. Its gzip/
                // compress aliases use the same gzip/zlib auto-detection.
                var prefix = new byte[2];
                var used = 0;
                while (used < prefix.Length)
                {
                    var read = await stream.ReadAsync(prefix.AsMemory(used), token).ConfigureAwait(false);
                    if (read == 0) break;
                    used += read;
                }
                var input = new PrefixStream(prefix.AsMemory(0, used), stream);
                decoded = used == 2 && prefix[0] == 0x1f && prefix[1] == 0x8b
                    ? new GZipStream(input, CompressionMode.Decompress)
                    : used == 2 && (prefix[0] & 0x0f) == 8 && ((prefix[0] << 8) + prefix[1]) % 31 == 0
                        ? new ZLibStream(input, CompressionMode.Decompress)
                        : new DeflateStream(input, CompressionMode.Decompress);
            }
            var replacement = new DecodedContent(decoded, content);
            foreach (var (name, values) in content.Headers)
                if (!name.Equals("Content-Encoding", StringComparison.OrdinalIgnoreCase)
                    && !name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                    replacement.Headers.TryAddWithoutValidation(name, values);
            response.Content = replacement;
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    private sealed class DecodedContent(Stream decoded, HttpContent original) : StreamContent(decoded)
    {
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing) original.Dispose();
        }
    }

    private sealed class PrefixStream(ReadOnlyMemory<byte> prefix, Stream stream) : Stream
    {
        private int offset;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        private int Copy(Span<byte> target)
        {
            var count = Math.Min(target.Length, prefix.Length - offset);
            prefix.Span.Slice(offset, count).CopyTo(target);
            offset += count;
            return count;
        }
        public override int Read(byte[] buffer, int start, int count) => Read(buffer.AsSpan(start, count));
        public override int Read(Span<byte> buffer) => offset < prefix.Length ? Copy(buffer) : stream.Read(buffer);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => offset < prefix.Length
            ? ValueTask.FromResult(Copy(buffer.Span)) : stream.ReadAsync(buffer, token);
        public override Task<int> ReadAsync(byte[] buffer, int start, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(start, count), token).AsTask();
        protected override void Dispose(bool disposing) { if (disposing) stream.Dispose(); base.Dispose(disposing); }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
