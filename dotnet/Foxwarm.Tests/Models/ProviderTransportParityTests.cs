using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ProviderTransportParityTests
{
    private const string Completed = "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"decoded answer\"}]}]}}\n\n";

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "wire", "a/wire", "", "", 713);

    [Theory]
    [InlineData("gzip")]
    [InlineData("br")]
    [InlineData("deflate")]
    [InlineData("deflate-raw")]
    public async Task Ordinary_configured_openai_stream_decodes_negotiated_content(string encoding)
    {
        await using var peer = new LoopbackResponsesServer((stream, _) => Reply(stream, Completed, encoding));
        using var http = ProviderHttpRequest.CreateClient();
        var model = Catalog(peer.BaseUri, encoding).Resolve("a/wire");
        var options = ConfiguredModelRequests.Plan(model, Options(peer.BaseUri), "low", "prompt", "cache", "turn");
        var result = await ConfiguredModelRequests.CreateService(http, model, options, "cache").ChatAsync("s", [], default);
        Assert.Contains("decoded answer", result.AssistantMessage!.ToJsonString());
        Assert.Equal(encoding == "deflate-raw" ? "deflate" : encoding, (await peer.Request).Headers["Accept-Encoding"]);
        Assert.Equal(1, peer.RequestCount);
    }

    [Fact]
    public async Task Compressed_http_error_body_reaches_classification_without_losing_provider_detail()
    {
        await using var peer = new LoopbackResponsesServer((stream, _) => Reply(stream, "{\"error\":{\"message\":\"invalid compressed request\"}}", "gzip", 400));
        using var http = ProviderHttpRequest.CreateClient();
        var options = Options(peer.BaseUri) with { ExtraHeaders = new JsonObject { ["Accept-Encoding"] = "gzip" } };
        var error = await Assert.ThrowsAsync<ResponsesHttpException>(() => new ResponsesChatService(http, options).ChatAsync("s", [], default));
        Assert.Contains("invalid compressed request", error.ResponseBody);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, error.StatusCode);
    }

    [Fact]
    public async Task Distinct_configured_keys_on_one_origin_do_not_inherit_response_cookies_but_keep_explicit_headers()
    {
        await using var peer = new ScriptedResponsesSequenceServer(3, (index, stream, _) => Reply(stream, Completed, null, cookie: index == 0 ? "provider-session=first; Path=/" : null));
        using var http = ProviderHttpRequest.CreateClient();
        var owner = new ModelRequestOwner(http, Options(peer.BaseUri), new ModelRouting());
        var catalog = Catalog(peer.BaseUri);
        await Request(owner, catalog, "a/wire");
        await Request(owner, catalog, "b/wire");
        var explicitCatalog = Catalog(peer.BaseUri, cookie: "intentional=third");
        await Request(owner, explicitCatalog, "b/wire");
        Assert.False((await peer.RequestAt(1)).Headers.ContainsKey("Cookie"));
        Assert.Equal("intentional=third", (await peer.RequestAt(2)).Headers["Cookie"]);
    }

    [Fact]
    public async Task Shared_response_decoder_does_not_double_decode_Anthropic_json()
    {
        await using var peer = new LoopbackResponsesServer((stream, _) => Reply(stream, "{\"content\":[{\"type\":\"text\",\"text\":\"decoded Anthropic\"}]}", "gzip"));
        using var http = ProviderHttpRequest.CreateClient();
        var options = Options(peer.BaseUri) with { ExtraFields = new JsonObject { ["stream"] = false } };
        var result = await new AnthropicMessagesService(http, options).ChatAsync("s", [], default);
        Assert.Contains("decoded Anthropic", result.AssistantMessage!.ToJsonString());
    }

    private static Task<Foxwarm.Sessions.ChatResult> Request(ModelRequestOwner owner, HostModels models, string key) => owner.RequestAsync("s", models, key, null, "cache", "turn", [], (_, _) => Task.FromResult("prompt"), null, null, null, null, default);

    private static HostModels Catalog(Uri uri, string? encoding = null, string? cookie = null)
    {
        JsonObject Provider() => new()
        {
            ["providerType"] = "openai-responses", ["baseUrl"] = uri.ToString(), ["models"] = new JsonArray("wire"),
            ["extraHeaders"] = new JsonObject { ["Accept-Encoding"] = encoding == "deflate-raw" ? "deflate" : encoding ?? "identity", ["Cookie"] = cookie ?? "" },
        };
        var a = Provider();
        var b = Provider();
        if (cookie is null)
        {
            a["extraHeaders"]!.AsObject().Remove("Cookie");
            b["extraHeaders"]!.AsObject().Remove("Cookie");
        }
        return HostModels.Parse(new JsonObject { ["default"] = "a/wire", ["providers"] = new JsonObject { ["a"] = a, ["b"] = b } }, new JsonObject());
    }

    private static async Task Reply(System.Net.Sockets.NetworkStream stream, string text, string? encoding, int status = 200, string? cookie = null)
    {
        var body = Encoding.UTF8.GetBytes(text);
        if (encoding is not null)
        {
            using var buffer = new MemoryStream();
            using (Stream compressor = encoding switch
            {
                "gzip" => new GZipStream(buffer, CompressionLevel.Fastest, true),
                "br" => new BrotliStream(buffer, CompressionLevel.Fastest, true),
                "deflate-raw" => new DeflateStream(buffer, CompressionLevel.Fastest, true),
                _ => new ZLibStream(buffer, CompressionLevel.Fastest, true),
            })
                compressor.Write(body);
            body = buffer.ToArray();
        }
        var headers = $"HTTP/1.1 {status} Result\r\nContent-Type: text/event-stream\r\nContent-Length: {body.Length}\r\nConnection: close\r\n";
        if (encoding is not null) headers += "Content-Encoding: " + (encoding == "deflate-raw" ? "deflate" : encoding) + "\r\n";
        if (cookie is not null) headers += "Set-Cookie: " + cookie + "\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(headers + "\r\n"));
        await stream.WriteAsync(body);
    }
}
