using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Foxwarm.Tests;

public sealed class HttpCompressionTests
{
    [Fact]
    public async Task Native_policy_accepts_HTTPS_inspection_JSON_but_excludes_textual_download_purposes()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var provider = f.Server.App.Services.GetRequiredService<IResponseCompressionProvider>();
        var endpoints = f
            .Server.App.Services.GetRequiredService<EndpointDataSource>()
            .Endpoints.OfType<RouteEndpoint>()
            .ToArray();
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Headers.AcceptEncoding = "gzip, br";
        context.Response.ContentType = "application/json";
        context.SetEndpoint(
            endpoints.Single(endpoint =>
                endpoint.RoutePattern.RawText == "/api/sessions/{id}/debug-file"
            )
        );
        Assert.True(provider.ShouldCompressResponse(context));
        // Exercise the response-purpose guard independently of today's binary/raster MIME types.
        context.Response.ContentType = "text/plain; charset=utf-8";
        foreach (
            var route in new[]
            {
                "/download",
                "/api/blobs/{blobId}",
                "/api/sessions/{id}/blobs/{blobId}",
            }
        )
        {
            context.SetEndpoint(
                endpoints.Single(endpoint => endpoint.RoutePattern.RawText == route)
            );
            Assert.False(provider.ShouldCompressResponse(context));
        }
        context.SetEndpoint(null);
        context.Response.Headers.ContentDisposition = "attachment; filename=original.txt";
        Assert.False(provider.ShouldCompressResponse(context));
    }

    [Fact]
    public async Task Download_GET_HEAD_preserves_bytes_and_length_while_signing_JSON_remains_eligible()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var bytes = Encoding.UTF8.GetBytes(
            string.Concat(Enumerable.Repeat("compressible original file\n", 1024))
        );
        var path = Path.Combine(f.Work, "original.txt");
        await File.WriteAllBytesAsync(path, bytes);
        using var signRequest = new HttpRequestMessage(HttpMethod.Post, "api/download/sign");
        signRequest.Headers.Add("Accept-Encoding", "br");
        signRequest.Content = JsonContent.Create(new { path });
        using var sign = await f.Admin.SendAsync(
            signRequest,
            HttpCompletionOption.ResponseHeadersRead
        );
        Assert.Equal(HttpStatusCode.OK, sign.StatusCode);
        Assert.Equal("no-store", sign.Headers.CacheControl!.ToString());
        var grant = JsonNode.Parse(await WebUiStartupTests.DecodeCompressed(sign, "br"))!;
        var url = grant["url"]!.GetValue<string>();
        await RawGetHead(f.Native, url, bytes);
        using var invalid = await WebUiStartupTests.EncodedGet(
            f.Native,
            url + "&signature=bad",
            "gzip"
        );
        Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);
        using var unrelated = await WebUiStartupTests.EncodedGet(
            f.Native,
            "api/sessions?" + url.Split('?')[1],
            "gzip"
        );
        Assert.Equal(HttpStatusCode.Unauthorized, unrelated.StatusCode);
        using var code = await WebUiStartupTests.EncodedGet(
            f.Admin,
            "api/vscode-web/fs/read-file?path=" + Uri.EscapeDataString(path),
            "gzip, br"
        );
        Assert.Equal(HttpStatusCode.OK, code.StatusCode);
        Assert.Equal("application/octet-stream", code.Content.Headers.ContentType!.MediaType);
        Assert.Empty(code.Content.Headers.ContentEncoding);
        Assert.Equal(bytes, await code.Content.ReadAsByteArrayAsync());

        var image = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        var blob = await f.Manager.Images.PutAsync(image, "image/png", "original");
        var blobId = blob["blobId"]!.GetValue<string>();
        foreach (
            var resource in new[] { "api/blobs/" + blobId, "api/sessions/chat/blobs/" + blobId }
        )
        foreach (var preview in new[] { "1", "0" })
            await RawGetHead(f.Admin, resource + "?preview=" + preview, image);
    }

    private static async Task RawGetHead(HttpClient client, string route, byte[] bytes)
    {
        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Head })
        {
            using var request = new HttpRequestMessage(method, route);
            request.Headers.Add("Accept-Encoding", "gzip, br");
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Empty(response.Content.Headers.ContentEncoding);
            Assert.Equal(bytes.LongLength, response.Content.Headers.ContentLength);
            Assert.Equal(
                method == HttpMethod.Get ? bytes : [],
                await response.Content.ReadAsByteArrayAsync()
            );
        }
    }

    [Fact]
    public async Task Bootstrap_outputs_and_first_live_SSE_event_remain_unencoded()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        foreach (
            var route in new[] { "node/run.sh", "node/docker-compose.yaml", "node/source.tar.gz" }
        )
        {
            using var baseline = await f.Native.GetAsync(route);
            Assert.Equal(HttpStatusCode.OK, baseline.StatusCode);
            using var response = await WebUiStartupTests.EncodedGet(f.Native, route, "gzip, br");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Empty(response.Content.Headers.ContentEncoding);
            if (!route.EndsWith(".tar.gz"))
                Assert.Equal(
                    await baseline.Content.ReadAsByteArrayAsync(),
                    await response.Content.ReadAsByteArrayAsync()
                );
            else
            {
                Assert.Equal("application/gzip", response.Content.Headers.ContentType!.MediaType);
                Assert.Null(response.Content.Headers.ContentLength);
                await using var archive = new GZipStream(
                    await response.Content.ReadAsStreamAsync(),
                    CompressionMode.Decompress
                );
                using var tar = new System.Formats.Tar.TarReader(archive);
                Assert.NotNull(await tar.GetNextEntryAsync());
            }
        }
        using var created = await f.Admin.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "chat" }
        );
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        using var request = new HttpRequestMessage(HttpMethod.Get, "api/sessions/chat/stream");
        request.Headers.Add("Accept-Encoding", "gzip, br");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var stream = await f.Admin.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            deadline.Token
        );
        Assert.Equal(HttpStatusCode.OK, stream.StatusCode);
        Assert.Equal("text/event-stream", stream.Content.Headers.ContentType!.MediaType);
        Assert.Empty(stream.Content.Headers.ContentEncoding);
        Assert.Equal("no", stream.Headers.GetValues("X-Accel-Buffering").Single());
        using var reader = new StreamReader(await stream.Content.ReadAsStreamAsync(deadline.Token));
        var first = await reader.ReadLineAsync(deadline.Token);
        Assert.Contains("connected", first);
        Assert.Equal("", await reader.ReadLineAsync(deadline.Token));
    }

    [Fact]
    public async Task Inbound_MCP_JSON_errors_SDK_events_and_attached_SSE_stay_unencoded()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        using var unauthorized = f.Request("POST", null, token: "invalid", body: "{}");
        unauthorized.Headers.Add("Accept-Encoding", "gzip, br");
        using var error = await f.Http.SendAsync(unauthorized);
        Assert.Equal(HttpStatusCode.Unauthorized, error.StatusCode);
        Assert.Equal("application/json", error.Content.Headers.ContentType!.MediaType);
        Assert.Empty(error.Content.Headers.ContentEncoding);
        Assert.NotNull((await error.Content.ReadFromJsonAsync<JsonObject>())!["error"]);
        using var initialize = f.Request(
            "POST",
            null,
            body: """
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"compression-fixture","version":"1"}}}
            """
        );
        initialize.Headers.Add("Accept-Encoding", "gzip, br");
        using var response = await f.Http.SendAsync(initialize);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        Assert.Empty(response.Content.Headers.ContentEncoding);
        var firstEvent = (await response.Content.ReadAsStringAsync())
            .Split('\n')
            .First(line => line.StartsWith("data: "));
        Assert.NotNull(JsonNode.Parse(firstEvent[6..])!["result"]);
        var id = response.Headers.GetValues("Mcp-Session-Id").Single();
        using var initialized = f.Request(
            "POST",
            id,
            body: """
            {"jsonrpc":"2.0","method":"notifications/initialized"}
            """
        );
        using var notification = await f.Http.SendAsync(initialized);
        Assert.Equal(HttpStatusCode.Accepted, notification.StatusCode);
        using var get = f.Request("GET", id);
        get.Headers.Add("Accept-Encoding", "gzip, br");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var sse = await f.Http.SendAsync(
            get,
            HttpCompletionOption.ResponseHeadersRead,
            deadline.Token
        );
        Assert.Equal(HttpStatusCode.OK, sse.StatusCode);
        Assert.Equal("text/event-stream", sse.Content.Headers.ContentType!.MediaType);
        Assert.Empty(sse.Content.Headers.ContentEncoding);
    }
}
