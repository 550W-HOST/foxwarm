using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class HttpAssetsTests
{
    private static readonly byte[] Text = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("HTTP asset original bytes\n", 200)));

    private static void WritePack(string file, string name, byte[] bytes, bool brotli = false, long? offset = null)
    {
        byte[] stored = bytes;
        if (brotli)
        {
            using var output = new MemoryStream();
            using (var compressor = new BrotliStream(output, CompressionLevel.Optimal, leaveOpen: true))
                compressor.Write(bytes);
            stored = output.ToArray();
        }
        var entry = new Dictionary<string, object>
        {
            ["offset"] = offset ?? 0,
            ["length"] = stored.Length,
            ["originalLength"] = bytes.Length,
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            ["contentType"] = "text/javascript",
        };
        if (brotli)
            entry["encoding"] = "br";
        var index = JsonSerializer.SerializeToUtf8Bytes(new { entries = new Dictionary<string, object> { [name] = entry } });
        using var fileStream = File.Create(file);
        fileStream.Write("FWASSET1"u8);
        Span<byte> length = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(length, (ulong)index.Length);
        fileStream.Write(length);
        fileStream.Write(index);
        fileStream.Write(stored);
    }

    private sealed class Host : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal readonly HttpAssets Assets;
        internal readonly WebApplication App;
        internal HttpClient Client = null!;
        internal string Pack => Path.Combine(Temp.Path, "foxwarm.assets");

        internal Host()
        {
            Assets = new(Temp.Path);
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            builder.Services.AddResponseCompression();
            builder.Services.AddSingleton<IResponseCompressionProvider, HttpResponseCompressionProvider>();
            App = builder.Build();
            App.UseResponseCompression();
            App.MapMethods("/{**path}", ["GET", "HEAD"], context => Assets.ServeAsync(context, context.Request.RouteValues["path"]?.ToString()));
        }

        internal async Task Start()
        {
            await App.StartAsync();
            Client = new HttpClient { BaseAddress = new Uri(App.Urls.Single()) };
        }

        public async ValueTask DisposeAsync()
        {
            Client?.Dispose();
            await App.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Raw_assets_support_ranges_conditionals_HEAD_and_missing_paths(bool packed)
    {
        await using var host = new Host();
        if (packed)
            WritePack(host.Pack, "asset.js", Text);
        else
            await File.WriteAllBytesAsync(Path.Combine(host.Temp.Path, "asset.js"), Text);
        await host.Start();
        using var full = await host.Client.GetAsync("asset.js");
        Assert.Equal(Text, await full.Content.ReadAsByteArrayAsync());
        Assert.Equal("text/javascript", full.Content.Headers.ContentType!.MediaType);
        Assert.NotNull(full.Headers.ETag);
        if (packed)
            Assert.Equal('"' + Convert.ToHexStringLower(SHA256.HashData(Text)) + '"', full.Headers.ETag!.Tag);
        using var conditional = new HttpRequestMessage(HttpMethod.Get, "asset.js");
        conditional.Headers.IfNoneMatch.Add(full.Headers.ETag!);
        using var unchanged = await host.Client.SendAsync(conditional);
        Assert.Equal(HttpStatusCode.NotModified, unchanged.StatusCode);
        using var head = await host.Client.SendAsync(new HttpRequestMessage(HttpMethod.Head, "asset.js"));
        Assert.Equal(Text.Length, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        using var range = new HttpRequestMessage(HttpMethod.Get, "asset.js");
        range.Headers.Range = new(3, 12);
        using var partial = await host.Client.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, partial.StatusCode);
        Assert.Equal(Text[3..13], await partial.Content.ReadAsByteArrayAsync());
        Assert.Equal($"bytes 3-12/{Text.Length}", partial.Content.Headers.ContentRange!.ToString());
        using var invalid = new HttpRequestMessage(HttpMethod.Get, "asset.js");
        invalid.Headers.Range = new(Text.Length + 1, null);
        using var outside = await host.Client.SendAsync(invalid);
        Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, outside.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await host.Client.GetAsync("missing.js")).StatusCode);
    }

    [Theory]
    [InlineData("br", true)]
    [InlineData("gzip", false)]
    [InlineData("br;q=0, gzip", false)]
    [InlineData("identity;q=1, br;q=0.5", false)]
    [InlineData("*", true)]
    [InlineData("", false)]
    public async Task Brotli_assets_negotiate_without_recompression_and_ignore_ranges(string accepted, bool encoded)
    {
        await using var host = new Host();
        WritePack(host.Pack, "asset.js", Text, brotli: true);
        await host.Start();
        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Head })
        {
            using var request = new HttpRequestMessage(method, "asset.js");
            if (accepted.Length > 0)
                request.Headers.TryAddWithoutValidation("Accept-Encoding", accepted);
            request.Headers.Range = new(3, 12);
            using var response = await host.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains("Accept-Encoding", response.Headers.Vary);
            Assert.Equal(encoded ? new[] { "br" } : [], response.Content.Headers.ContentEncoding);
            Assert.Equal('"' + Convert.ToHexStringLower(SHA256.HashData(Text)) + '"', response.Headers.ETag!.Tag);
            Assert.True(response.Headers.ETag.IsWeak);
            Assert.Empty(response.Headers.AcceptRanges);
            if (!encoded)
                Assert.Equal(Text.Length, response.Content.Headers.ContentLength);
            if (method == HttpMethod.Head)
                Assert.Empty(await response.Content.ReadAsByteArrayAsync());
            else if (encoded)
            {
                using var input = await response.Content.ReadAsStreamAsync();
                using var decoder = new BrotliStream(input, CompressionMode.Decompress);
                using var output = new MemoryStream();
                await decoder.CopyToAsync(output);
                Assert.Equal(Text, output.ToArray());
            }
            else
                Assert.Equal(Text, await response.Content.ReadAsByteArrayAsync());
            using var conditional = new HttpRequestMessage(HttpMethod.Get, "asset.js");
            conditional.Headers.IfNoneMatch.Add(response.Headers.ETag);
            using var unchanged = await host.Client.SendAsync(conditional);
            Assert.Equal(HttpStatusCode.NotModified, unchanged.StatusCode);
        }
        Assert.Equal(Encoding.UTF8.GetString(Text), await host.Assets.ReadTextAsync("asset.js", default));
    }

    [Fact]
    public async Task Store_detects_installed_and_replaced_packs_while_open_responses_keep_their_file()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "foxwarm.assets");
        var store = new HttpAssets(temp.Path);
        Assert.False(store.Exists("asset.js"));
        WritePack(path, "asset.js", Text);
        using var old = store.Open("asset.js")!;
        var replacement = path + ".new";
        WritePack(replacement, "asset.js", "replacement"u8.ToArray(), brotli: true);
        File.Move(replacement, path, overwrite: true);
        Assert.Equal("replacement", await store.ReadTextAsync("asset.js", default));
        using var bytes = new MemoryStream();
        await old.Stream.CopyToAsync(bytes);
        Assert.Equal(Text, bytes.ToArray());
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "loose.txt"), "optional old install");
        Assert.Equal("optional old install", await store.ReadTextAsync("loose.txt", default));
    }

    [Fact]
    public async Task Optional_pack_overrides_an_old_extracted_tree_beside_the_application_pack()
    {
        using var temp = new TempDirectory();
        var optional = Path.Combine(temp.Path, "optional");
        Directory.CreateDirectory(optional);
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "asset.js"), "old loose bytes");
        WritePack(Path.Combine(temp.Path, "foxwarm.assets"), "app.js", "application"u8.ToArray());
        var store = new HttpAssets(temp.Path, additionalPack: "optional/foxwarm.assets");
        Assert.Equal("old loose bytes", await store.ReadTextAsync("asset.js", default));
        WritePack(Path.Combine(optional, "foxwarm.assets"), "asset.js", Text, brotli: true);
        Assert.Equal(Encoding.UTF8.GetString(Text), await store.ReadTextAsync("asset.js", default));
        Assert.Equal("application", await store.ReadTextAsync("app.js", default));
    }

    [Theory]
    [InlineData("../outside")]
    [InlineData("/absolute")]
    [InlineData("a\\b")]
    [InlineData("a/./b")]
    [InlineData("C:/file")]
    public void Invalid_names_are_rejected_for_packed_and_loose_resources(string name)
    {
        using var temp = new TempDirectory();
        var store = new HttpAssets(temp.Path);
        Assert.Null(store.Open(name));
        WritePack(Path.Combine(temp.Path, "foxwarm.assets"), name, Text);
        Assert.Throws<InvalidDataException>(() => store.Open("asset.js"));
    }

    [Fact]
    public void Index_rejects_extents_outside_the_file()
    {
        using var temp = new TempDirectory();
        WritePack(Path.Combine(temp.Path, "foxwarm.assets"), "asset.js", Text, offset: long.MaxValue);
        Assert.Throws<InvalidDataException>(() => new HttpAssets(temp.Path).Open("asset.js"));
    }
}
