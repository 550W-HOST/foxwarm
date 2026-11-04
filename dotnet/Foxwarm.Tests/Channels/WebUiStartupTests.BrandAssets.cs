using System.Net;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Brand_assets_are_authenticated_and_allowlisted_including_scoped_browser_access()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath,
            "url: https://public.invalid/nested/app/\nvector: false\naccess:\n  identities: {alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}}}}\n");
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "manifest.json"), "{\"name\":\"Foxwarm\"}");
        await File.WriteAllTextAsync(Path.Combine(h.Dist, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
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
