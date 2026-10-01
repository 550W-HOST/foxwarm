using System.Text;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal static class ProviderHttpRequest
{
    internal static HttpRequestMessage Create(Uri endpoint, JsonObject body, ResponsesClientOptions options,
        IReadOnlyDictionary<string, string> defaults)
    {
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        if (options.RequestCompression is string compression)
        {
            using var buffer = new MemoryStream();
            using (Stream encoder = compression == "gzip"
                ? new System.IO.Compression.GZipStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true)
                : new System.IO.Compression.BrotliStream(buffer, System.IO.Compression.CompressionLevel.Optimal, true)) encoder.Write(bytes);
            bytes = buffer.ToArray();
        }
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        void Set(string name, string value)
        {
            if (request.Headers.TryAddWithoutValidation(name, value))
            {
                request.Headers.Remove(name);
                request.Headers.TryAddWithoutValidation(name, value);
            }
            else
            {
                request.Content.Headers.Remove(name);
                request.Content.Headers.TryAddWithoutValidation(name, value);
            }
        }
        foreach (var (name, value) in defaults) Set(name, value);
        if (options.ExtraHeaders is not null)
            foreach (var (name, value) in options.ExtraHeaders) Set(name, value?.ToString() ?? "");
        if (options.RequestCompression is not null)
        {
            request.Content.Headers.ContentEncoding.Clear();
            request.Content.Headers.ContentEncoding.Add(options.RequestCompression);
            request.Content.Headers.ContentLength = bytes.Length;
        }
        return request;
    }
}
