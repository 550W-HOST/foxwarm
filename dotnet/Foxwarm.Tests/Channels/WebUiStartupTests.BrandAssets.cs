using System.Net;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Theory]
    [InlineData("252629", "#252629")]
    [InlineData("fff3e4", "#fff3e4")]
    [InlineData("invalid", "#f3f4f6")]
    [InlineData("123456789", "#f3f4f6")]
    public async Task Manifest_colors_are_browser_scoped_without_changing_install_identity(string cookie, string expected)
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "manifest.json"),
            """{"name":"Foxwarm","start_url":"./","scope":"./","theme_color":"#f3f4f6","background_color":"#f3f4f6","icons":[{"src":"./icon-192.png"}]}""");
        h.Start();
        await h.Ready();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/manifest.json");
        request.Headers.Authorization = new("Bearer", h.Token);
        request.Headers.Add("Cookie", "foxwarm_canvas=" + cookie);
        using var response = await h.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.Private);
        Assert.True(response.Headers.CacheControl.NoStore);
        Assert.Contains("Cookie", response.Headers.Vary);
        var json = System.Text.Json.Nodes.JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal(expected, json["theme_color"]!.GetValue<string>());
        Assert.Equal(expected, json["background_color"]!.GetValue<string>());
        Assert.Equal("./", json["start_url"]!.GetValue<string>());
        Assert.Equal("./", json["scope"]!.GetValue<string>());
        Assert.Equal("./icon-192.png", json["icons"]![0]!["src"]!.GetValue<string>());
        using var clean = new HttpRequestMessage(HttpMethod.Get, "/manifest.json");
        clean.Headers.Authorization = new("Bearer", h.Token);
        using var cleanResponse = await h.Client.SendAsync(clean);
        var baseline = System.Text.Json.Nodes.JsonNode.Parse(await cleanResponse.Content.ReadAsStringAsync())!;
        Assert.Equal("#f3f4f6", baseline["theme_color"]!.GetValue<string>());
    }

    [Fact]
    public async Task Brand_assets_are_authenticated_and_allowlisted_including_scoped_browser_access()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(
            h.ConfigPath,
            "url: https://public.invalid/nested/app/\nvector: false\naccess:\n  identities: {alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}}}}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(h.Dist, "manifest.json"),
            "{\"name\":\"Foxwarm\"}"
        );
        await File.WriteAllTextAsync(
            Path.Combine(h.Dist, "favicon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
        );
        await File.WriteAllBytesAsync(Path.Combine(h.Dist, "icon-maskable-512.png"), [1, 2, 3]);
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "private.json"), "not public");
        h.Start();
        await h.Ready();
        h.Client.DefaultRequestHeaders.Authorization = null;
        using (var response = await h.Client.GetAsync("/nested/app/manifest.json"))
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        foreach (var token in new[] { h.Token, "synthetic-alice" })
        {
            h.Client.DefaultRequestHeaders.Authorization = new("Bearer", token);
            foreach (var asset in new[] { "manifest.json", "favicon.svg", "icon-maskable-512.png" })
            {
                using var response = await h.Client.GetAsync("/nested/app/" + asset);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.Private);
            }
            using var denied = await h.Client.GetAsync("/nested/app/private.json");
            Assert.NotEqual(HttpStatusCode.OK, denied.StatusCode);
        }
    }
}
