using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Actual_artifact_routes_require_current_scope_exact_owner_and_pinned_integrity_under_deployment_prefix()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var config = $"bot:\n  httpPort: {h.Port}\nvector: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-artifact-viewer\n      surfaces:\n        webui: {{sessions: [artifact-owner]}}\n";
        await File.WriteAllTextAsync(h.ConfigPath, config);
        h.Start(new() { ["FOXWARM_PUBLIC_BASE_URL"] = h.Client.BaseAddress + "nested/main/" });
        await h.Ready();
        foreach (var id in new[] { "artifact-owner", "artifact-other" })
        {
            var create = await h.Client.PostAsync("/nested/main/api/sessions", new StringContent(new JsonObject { ["agentId"] = "main", ["sessionId"] = id }.ToJsonString(), System.Text.Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.OK, create.StatusCode);
            Assert.Equal(id, SessionWait.Text((await create.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]));
        }
        var root = Path.Combine(h.Data, "state", "artifacts");
        var image = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var source = await ArtifactStoreTests.Source(new JsonObject { ["root"] = root, ["action"] = "publish", ["sessionId"] = "artifact-owner", ["image"] = Convert.ToBase64String(image) });
        var artifactId = SessionWait.Text(source["receipt"]?["artifactId"])!;
        var route = $"/nested/main/api/sessions/artifact-owner/artifacts/{artifactId}/1";
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false }) { BaseAddress = h.Client.BaseAddress };
        foreach (var suffix in new[] { "", "/resources/image" }) Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route + suffix)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-artifact-viewer");
        var auth = await client.GetStringAsync("/nested/main/api/auth/session");
        var history = await client.GetAsync("/nested/main/api/sessions/artifact-owner/history");
        Assert.True(history.IsSuccessStatusCode, $"Scope: {auth}; history: {history.StatusCode}: {await history.Content.ReadAsStringAsync()}");
        var metadata = await client.GetAsync(route);
        Assert.True(metadata.StatusCode == HttpStatusCode.OK, $"{metadata.StatusCode}: {await metadata.Content.ReadAsStringAsync()}");
        Assert.True(metadata.Headers.CacheControl!.Private);
        Assert.True(metadata.Headers.CacheControl.NoStore);
        Assert.True(JsonNode.DeepEquals(source, await metadata.Content.ReadFromJsonAsync<JsonObject>()));
        var resource = await client.GetAsync(route + "/resources/image");
        Assert.Equal(HttpStatusCode.OK, resource.StatusCode);
        Assert.Equal("image/png", resource.Content.Headers.ContentType!.MediaType);
        Assert.Equal("nosniff", resource.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("default-src 'none'; sandbox", resource.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal(image, await resource.Content.ReadAsByteArrayAsync());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(route.Replace("artifact-owner", "artifact-other"))).StatusCode);
        foreach (var suffix in new[] { "", "/resources/image" }) Assert.Equal(HttpStatusCode.NotFound, (await h.Client.GetAsync(route.Replace("artifact-owner", "artifact-other") + suffix)).StatusCode);
        // The existing resource digest is a persisted contract, not a new handoff fingerprint.
        var digest = SessionWait.Text(source["resources"]?["image"]?["sha256"])!;
        await File.WriteAllBytesAsync(Path.Combine(root, artifactId, "resources", digest), [1, 2]);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(route + "/resources/image")).StatusCode);
        await File.WriteAllTextAsync(Path.Combine(root, artifactId, "1.json"), "{broken");
        var unavailable = await client.GetAsync(route);
        Assert.Equal(HttpStatusCode.NotFound, unavailable.StatusCode);
        Assert.DoesNotContain(h.Data, await unavailable.Content.ReadAsStringAsync());
        var revoked = config[..config.IndexOf("access:", StringComparison.Ordinal)] + "access: {identities: {}}\n";
        Assert.Equal(HttpStatusCode.OK, (await h.Client.PostAsJsonAsync("/api/setup/config", new { yaml = revoked })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route)).StatusCode);
        await h.Stop();
    }
}
