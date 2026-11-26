using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal static class ProviderHttpRequest
{
    // Product code passes the runtime's policy (source rule); tests may omit it.
    internal static HttpClient CreateClient(Foxwarm.Net.EgressPolicy? egress = null) =>
        Foxwarm.Net.EgressHttp.Client(
            egress ?? Foxwarm.Net.EgressPolicy.Unguarded,
            Foxwarm.Net.EgressPurpose.Model,
            new Foxwarm.Net.EgressHandlerOptions
            {
                UseCookies = false,
                FileHandler = Foxwarm.Net.EgressFileHandler.Client,
            },
            inner => new ProviderResponseDecodingHandler(inner)
        );

    internal static JsonObject ResponseHeaders(HttpResponseMessage response)
    {
        var headers = new JsonObject();
        foreach (var (name, values) in response.Headers.Concat(response.Content.Headers))
            headers[name] = string.Join(", ", values);
        return headers;
    }

    // Request defaults first, then provider extraHeaders, which may replace them.
    internal static void ApplyHeaders(
        HttpRequestMessage request,
        ResponsesClientOptions options,
        IReadOnlyDictionary<string, string> defaults
    )
    {
        void Set(string name, string value)
        {
            if (request.Headers.TryAddWithoutValidation(name, value))
            {
                request.Headers.Remove(name);
                request.Headers.TryAddWithoutValidation(name, value);
            }
            else if (request.Content is not null)
            {
                request.Content.Headers.Remove(name);
                request.Content.Headers.TryAddWithoutValidation(name, value);
            }
        }
        Set("Accept-Encoding", "gzip, compress, deflate, br");
        foreach (var (name, value) in defaults)
            Set(name, value);
        if (options.ExtraHeaders is not null)
            foreach (var (name, value) in options.ExtraHeaders)
                Set(name, value?.ToString() ?? "");
    }

    internal static HttpRequestMessage Create(
        Uri endpoint,
        JsonObject body,
        ResponsesClientOptions options,
        IReadOnlyDictionary<string, string> defaults
    )
    {
        HttpRequestMessage? request = null;
        try
        {
            var bytes = Encoding.UTF8.GetBytes(body.ToJsonText());
            if (options.RequestCompression is string compression)
            {
                using var buffer = new MemoryStream();
                using (
                    Stream encoder =
                        compression == "gzip"
                            ? new System.IO.Compression.GZipStream(
                                buffer,
                                System.IO.Compression.CompressionLevel.Optimal,
                                true
                            )
                            : new System.IO.Compression.BrotliStream(
                                buffer,
                                System.IO.Compression.CompressionLevel.Optimal,
                                true
                            )
                )
                    encoder.Write(bytes);
                bytes = buffer.ToArray();
            }
            request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = new ByteArrayContent(bytes),
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json")
            {
                CharSet = "utf-8",
            };
            ApplyHeaders(request, options, defaults);
            if (options.RequestCompression is not null)
            {
                request.Content.Headers.ContentEncoding.Clear();
                request.Content.Headers.ContentEncoding.Add(options.RequestCompression);
                request.Content.Headers.ContentLength = bytes.Length;
            }
            return request;
        }
        catch (Exception error)
        {
            request?.Dispose();
            throw new ModelPreparationException(
                "Provider request preparation failed: " + error.Message,
                error
            );
        }
    }
}
