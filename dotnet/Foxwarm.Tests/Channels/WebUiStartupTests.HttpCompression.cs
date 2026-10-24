using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    internal static async Task<byte[]> DecodeCompressed(HttpResponseMessage response, string encoding)
    {
        Assert.Equal(new[] { encoding }, response.Content.Headers.ContentEncoding);
        Assert.Contains("Accept-Encoding", response.Headers.Vary);
        Assert.Null(response.Content.Headers.ContentLength);
        var raw = await response.Content.ReadAsByteArrayAsync();
        await using var input = new MemoryStream(raw);
        await using Stream decoder = encoding == "br"
            ? new BrotliStream(input, CompressionMode.Decompress)
            : new GZipStream(input, CompressionMode.Decompress);
        await using var decoded = new MemoryStream();
        await decoder.CopyToAsync(decoded);
        return decoded.ToArray();
    }

    internal static Task<HttpResponseMessage> EncodedGet(HttpClient client, string route, string encoding)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, route);
        request.Headers.Add("Accept-Encoding", encoding);
        return client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
    }

    [Fact]
    public async Task Main_compresses_real_WebUI_SendFile_static_Code_and_JSON_routes_with_prefix_and_auth()
    {
        await using var h = new Host(codeAssets: true);
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(
            h.ConfigPath,
            "url: https://public.invalid/nested/app/\nvector: false\naccess:\n  identities: {alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}}}}\n"
        );
        var script = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("export const repeated = 'frontend resource';\n", 512)));
        await File.WriteAllBytesAsync(Path.Combine(h.Dist, "assets", "fixture.js"), script);
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "assets", "fixture.css"), "body { color: blue; }");
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "assets", "fixture.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>");
        var resources = Path.Combine(h.Installation, "packages", "vscode-web");
        var assets = Path.Combine(resources, "assets", "vscode-web");
        Directory.CreateDirectory(Path.Combine(assets, "out", "vs", "workbench"));
        await File.WriteAllBytesAsync(Path.Combine(assets, "out", "nls.messages.js"), script);
        foreach (var extension in new[] { "css", "js" })
            await File.WriteAllTextAsync(Path.Combine(assets, "out", "vs", "workbench", "workbench.web.main.internal." + extension), "prepared fixture");
        Directory.CreateDirectory(Path.Combine(resources, "foxwarm-fs"));
        await File.WriteAllBytesAsync(Path.Combine(resources, "foxwarm-fs", "compression.js"), script);
        h.Start();
        await h.Ready();
        var prefix = "/nested/app/";
        using var create = await h.Client.PostAsJsonAsync(prefix + "api/sessions", new { sessionId = "chat", agentId = "main" });
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        foreach (var route in new[]
        {
            "", "assets/fixture.js", "assets/fixture.css", "assets/fixture.svg",
            "vscode-web/static/out/nls.messages.js", "vscode-web/extensions/foxwarm-fs/compression.js",
            "health", "api/sessions", "api/tasks", "api/nodes", "api/webui/settings", "api/asr/status",
            "api/sessions/chat/history", "api/sessions/chat/history/continuous", "api/sessions/chat/debug-file",
            "api/vscode-web/fs/stat?path=" + Uri.EscapeDataString(h.Work),
        })
        {
            using var plain = await h.Client.GetAsync(prefix + route);
            Assert.Equal(HttpStatusCode.OK, plain.StatusCode);
            Assert.Empty(plain.Content.Headers.ContentEncoding);
            var expected = await plain.Content.ReadAsByteArrayAsync();
            foreach (var encoding in new[] { "gzip", "br" })
            {
                using var compressed = await EncodedGet(h.Client, prefix + route, encoding);
                Assert.Equal(plain.StatusCode, compressed.StatusCode);
                Assert.Equal(plain.Content.Headers.ContentType, compressed.Content.Headers.ContentType);
                Assert.Equal(plain.Headers.CacheControl, compressed.Headers.CacheControl);
                Assert.Equal(expected, await DecodeCompressed(compressed, encoding));
            }
        }
        foreach (var encoding in new[] { "identity", "unsupported" })
        {
            using var plain = await EncodedGet(h.Client, prefix + "assets/fixture.js", encoding);
            Assert.Empty(plain.Content.Headers.ContentEncoding);
            Assert.Equal(script, await plain.Content.ReadAsByteArrayAsync());
        }
        using (var range = new HttpRequestMessage(HttpMethod.Get, prefix + "assets/fixture.js"))
        {
            range.Headers.Add("Accept-Encoding", "gzip, br");
            range.Headers.Range = new(0, 49);
            using var partial = await h.Client.SendAsync(range);
            Assert.Equal(HttpStatusCode.PartialContent, partial.StatusCode);
            Assert.Empty(partial.Content.Headers.ContentEncoding);
            Assert.Equal(50, partial.Content.Headers.ContentLength);
            Assert.Equal(script[..50], await partial.Content.ReadAsByteArrayAsync());
        }
        h.Client.DefaultRequestHeaders.Authorization = null;
        using var login = await EncodedGet(h.Client, prefix, "gzip");
        Assert.Contains("id=\"token\"", Encoding.UTF8.GetString(await DecodeCompressed(login, "gzip")));
        Assert.Equal("no-store", login.Headers.CacheControl!.ToString());
        Assert.False(login.Headers.Contains("Set-Cookie"));
        using var denied = await EncodedGet(h.Client, prefix + "api/sessions", "br");
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        await DecodeCompressed(denied, "br");
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
        using var scoped = await EncodedGet(h.Client, prefix + "api/sessions/chat/history", "gzip");
        Assert.Equal(HttpStatusCode.OK, scoped.StatusCode);
        await DecodeCompressed(scoped, "gzip");
        using var forbidden = await EncodedGet(h.Client, prefix + "api/tasks", "gzip");
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        await DecodeCompressed(forbidden, "gzip");
        h.Client.DefaultRequestHeaders.Authorization = new("Bearer", h.Token);
        await h.Stop();
    }
}
