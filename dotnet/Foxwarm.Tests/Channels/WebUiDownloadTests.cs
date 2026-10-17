using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WebUiDownloadTests
{
    internal sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal const string Token = "synthetic-download-contract";
        internal SessionManager Manager = null!;
        internal HttpServer Server = null!;
        private Foxwarm.Terminal.TerminalRegistry terminals = null!;
        internal HttpClient Admin = null!;
        internal HttpClient Native = null!;
        internal string Work => Path.Combine(Temp.Path, "work");

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            var data = Path.Combine(f.Temp.Path, "data");
            Directory.CreateDirectory(f.Work);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(data, f.Work, options, HostModels.ForTest(options));
            await f.Manager.LoadAsync();
            f.terminals = new(data, CancellationToken.None);
            var address = new PublicWebAddress(
                "http://127.0.0.1:0",
                new PathString("/nested/app"),
                "/nested/app/",
                false
            );
            f.Server = new([], 0, Token, null, f.Manager, f.terminals, address, true);
            var runtime = new SessionRuntime(f.Manager);
            new WebUIChannel(
                f.Manager,
                runtime,
                new MessageRouter(runtime),
                f.terminals,
                f.Server.Downloads
            ).Register(f.Server.App);
            await f.Server.App.StartAsync();
            var root = new Uri(f.Server.App.Urls.Single() + "/nested/app/");
            f.Admin = new(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
            {
                BaseAddress = root,
            };
            f.Admin.DefaultRequestHeaders.Authorization = new("Bearer", Token);
            f.Native = new(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
            {
                BaseAddress = root,
            };
            return f;
        }

        internal async Task<JsonObject> Sign(string route, object options)
        {
            var response = await Admin.PostAsJsonAsync(route, options);
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }

        public async ValueTask DisposeAsync()
        {
            Admin.Dispose();
            Native.Dispose();
            await Server.App.StopAsync();
            await Server.App.DisposeAsync();
            await terminals.DisposeAsync();
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public void Mac_matches_Source_format_and_enforces_expiry_resource_options_and_rotation()
    {
        long clock = 1700000000;
        var signer = new WebUiDownloadSignatures("source-token", () => clock);
        var options = new JsonObject { ["filename"] = "résumé.txt", ["preview"] = "0" };
        var issued = signer.Issue("path", "/tmp/文.txt", options);
        // Independent Source JSON.stringify/HMAC fixture, including non-ASCII resource/name.
        var key = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes("source-token"),
            Encoding.UTF8.GetBytes("foxwarm/webui-download-key/v1")
        );
        var mac = Convert.ToHexStringLower(
            HMACSHA256.HashData(
                key,
                Encoding.UTF8.GetBytes(
                    "[\"download-v1\",\"path\",\"/tmp/文.txt\",null,\"résumé.txt\",\"0\",\"1700000900\"]"
                )
            )
        );
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(issued.Query);
        Assert.Equal(mac, query["signature"]);
        var parsed = new QueryCollection(query);
        Assert.True(signer.Verify("path", "/tmp/文.txt", parsed));
        Assert.False(signer.Verify("path", "/other", parsed));
        Assert.False(signer.Verify("blob", "/tmp/文.txt", parsed));
        Assert.False(
            new WebUiDownloadSignatures("rotated", () => clock).Verify(
                "path",
                "/tmp/文.txt",
                parsed
            )
        );
        clock = issued.ExpiresAt;
        Assert.False(signer.Verify("path", "/tmp/文.txt", parsed));
    }

    public static TheoryData<string, string, string?, string?, string> SourceMacCases => new()
    {
        { "path", "/tmp/😀.txt", "😀.txt", "0", "0b533788e1bf8542760efbbae952cd19f0c6da04ef1c1dfa9585a0e810dae925" },
        { "path", "/tmp/control.txt", new string(Enumerable.Range(0, 32).Select(value => (char)value).ToArray()) + ".txt", "0", "e5e980ebcbc958891ef86c47ec3ae61d5242af2d77590fdc022b12d23c9ee544" },
        { "blob", "ab12.png", "quote\" backslash\\ slash/ <>& café 文 \u2028\u2029 🦊.png", "1", "fbfd33a1276efd4bfd13227620f516469077ed5af63ae054ea37fe34ac47af57" },
        { "path", "/tmp/e\u0301.txt", null, null, "c06cc718edbf6c899b383ac173ce1baf376c12f0bc223f20eeb3aaf73acab175" },
    };

    [Theory]
    [MemberData(nameof(SourceMacCases))]
    public void Source_produced_MACs_match_and_verify_for_Unicode_controls_and_escaping(
        string kind, string resource, string? filename, string? preview, string sourceMac
    )
    {
        // Fixed Source JSON.stringify/HMAC vectors at clock 1700000000, token source-token.
        var signer = new WebUiDownloadSignatures("source-token", () => 1700000000);
        var issued = signer.Issue(kind, resource, new JsonObject { ["filename"] = filename, ["preview"] = preview });
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(issued.Query);
        Assert.Equal(sourceMac, query["signature"]);
        query["signature"] = sourceMac;
        Assert.True(signer.Verify(kind, resource, new QueryCollection(query)));
    }

    [Fact]
    public async Task Native_path_GET_HEAD_uses_resource_gate_with_prefix_names_preview_and_credentials_OR_signature()
    {
        await using var f = await Fixture.Create();
        var path = Path.Combine(f.Work, "picture🦊.png");
        await File.WriteAllBytesAsync(path, [1, 2, 3, 4]);
        var issued = await f.Sign(
            "api/download/sign",
            new
            {
                path,
                filename = "../original\r\n.png",
                preview = "1",
            }
        );
        var url = issued["url"]!.GetValue<string>();
        Assert.StartsWith("download?", url);
        Assert.InRange(
            issued["expiresAt"]!.GetValue<long>() - DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            895,
            900
        );
        var response = await f.Native.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, await response.Content.ReadAsByteArrayAsync());
        Assert.Equal("image/png", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("inline", response.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Contains(
            ".._original__.png",
            response.Content.Headers.ContentDisposition.ToString()
        );
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        var head = await f.Native.SendAsync(new(HttpMethod.Head, url));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Equal(4, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        foreach (
            var bad in new[]
            {
                url.Replace("preview=1", "preview=0"),
                url + "&filename=other",
                url.Replace("expires=", "expires=1"),
                url.Replace("signature=", "signature=0"),
            }
        )
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await f.Native.GetAsync(bad)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await f.Admin.GetAsync(bad)).StatusCode);
        }
        using var cookie = new HttpRequestMessage(HttpMethod.Get, url + "&signature=invalid");
        cookie.Headers.Add("Cookie", "foxwarm_token=" + Fixture.Token);
        Assert.Equal(HttpStatusCode.OK, (await f.Native.SendAsync(cookie)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.PostAsJsonAsync("api/download/sign", new { path })).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.GetAsync("api/sessions?" + url.Split('?')[1])).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.PostAsJsonAsync(url, new { })).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await f.Admin.PostAsJsonAsync("api/download/sign", new { path = "relative" })
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.NotFound,
            (
                await f.Admin.PostAsJsonAsync("api/download/sign", new { path = path + "absent" })
            ).StatusCode
        );
        foreach (var extension in new[] { ".svg", ".html", ".unknown" })
        {
            var active = Path.Combine(f.Work, "unsafe" + extension);
            await File.WriteAllTextAsync(active, "<script>active</script>");
            var grant = await f.Sign("api/download/sign", new { path = active, preview = "1" });
            var file = await f.Native.GetAsync(grant["url"]!.GetValue<string>());
            Assert.Equal("application/octet-stream", file.Content.Headers.ContentType!.MediaType);
            Assert.Equal("attachment", file.Content.Headers.ContentDisposition!.DispositionType);
        }
    }

    [Fact]
    public async Task Global_blob_signing_is_protected_and_preserves_safe_display_and_explicit_attachment()
    {
        await using var f = await Fixture.Create();
        var blob = await f.Manager.Images.PutAsync(
            ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png),
            "image/png",
            "archived"
        );
        var id = blob["blobId"]!.GetValue<string>();
        var resource = "api/blobs/" + id;
        Assert.Equal(HttpStatusCode.Unauthorized, (await f.Native.GetAsync(resource)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await f.Admin.GetAsync(resource)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.PostAsJsonAsync(resource + "/download", new { })).StatusCode
        );
        var issued = await f.Sign(
            resource + "/download",
            new { filename = "original.png", preview = "0" }
        );
        var native = "api/blobs/" + issued["url"]!.GetValue<string>();
        var file = await f.Native.GetAsync(native);
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        Assert.Equal("image/png", file.Content.Headers.ContentType!.MediaType);
        Assert.Equal("attachment", file.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Contains("original.png", file.Content.Headers.ContentDisposition.ToString());
        var head = await f.Native.SendAsync(new(HttpMethod.Head, native));
        Assert.Equal(file.Content.Headers.ContentLength, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.GetAsync(native.Replace("preview=0", "preview=1"))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.OK,
            (await f.Admin.GetAsync(native + "&signature=bad")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (
                await f.Native.GetAsync(
                    "download"
                        + native[native.IndexOf('?')..]
                        + "&path="
                        + Uri.EscapeDataString(f.Work)
                )
            ).StatusCode
        );
        var expired = new WebUiDownloadSignatures(
            Fixture.Token,
            () => DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 901
        ).Issue("blob", id, new JsonObject());
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await f.Native.GetAsync(resource + expired.Query)).StatusCode
        );
    }
}
