using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Http;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Published_chart_document_reaches_scoped_HTTP_unchanged_by_Message_transport()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            "vector: false\ndbWorkers: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-artifact-viewer\n      surfaces:\n        webui: {sessions: [chart-owner]}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
        );
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(data, work, options, config.Models);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "chart-owner", null, null);
        await using var mcp = new McpClient(data);
        var registry = SessionToolExecutor.CreateRegistry(
            new JsonArray(ArtifactToolDefinition.Definition()),
            mcp,
            _ => work
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        tools.BeginTurn();
        var document = JsonNode
            .Parse(
                """
                {
                  "type": "chart", "schemaVersion": 1, "title": "Log message categories",
                  "data": [
                    {"x": 1, "messageJson": "request completed", "type": "image", "mimeType": "image/png", "data": "category"},
                    {"x": 2, "messageJson": "{ \"status\": \"request completed\" }", "type": "other", "mimeType": null, "data": false}
                  ],
                  "spec": {"mark": "line", "encoding": {
                    "x": {"field": "x", "type": "quantitative"},
                    "y": {"field": "messageJson", "type": "nominal"}
                  }}
                }
                """
            )!
            .AsObject();
        var file = Path.Combine(work, "chart.json");
        await File.WriteAllTextAsync(file, document.ToJsonString());
        var published = await tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "artifact",
                ["args"] = new JsonObject { ["action"] = "publish", ["filePath"] = file },
            },
            default
        );
        Assert.Null(published!["error"]);
        var id = SessionWait.Text(published["artifact"]?["artifactId"])!;
        var stored = await manager.Artifacts.ReadAsync(id, 1, owner.Id);
        Assert.True(JsonNode.DeepEquals(document, stored["document"]));

        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
        var address = new PublicWebAddress(
            "http://127.0.0.1:0",
            new PathString("/nested/app"),
            "/nested/app/",
            false
        );
        var server = new HttpServer(
            [],
            0,
            "synthetic-artifact-admin",
            null,
            manager,
            terminals,
            address,
            true
        );
        var runtime = new SessionRuntime(manager);
        new WebUIChannel(
            manager,
            runtime,
            new MessageRouter(runtime),
            terminals,
            server.Downloads
        ).Register(server.App);
        await server.App.StartAsync();
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = new Uri(server.App.Urls.Single() + "/nested/app/"),
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-artifact-viewer");
        try
        {
            using var response = await client.GetAsync($"api/sessions/{owner.Id}/artifacts/{id}/1");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
            Assert.True(response.Headers.CacheControl!.Private);
            Assert.True(response.Headers.CacheControl.NoStore);
            Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
            var delivered = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(
                JsonNode.DeepEquals(stored, delivered),
                $"Stored: {stored.ToJsonString()}; HTTP: {delivered?.ToJsonString()}"
            );
            Assert.True(
                JsonNode.DeepEquals(stored, await manager.Artifacts.ReadAsync(id, 1, owner.Id))
            );
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }

    [Fact]
    public async Task Actual_artifact_routes_require_current_scope_exact_owner_and_pinned_integrity_under_deployment_prefix()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var config =
            $"bot:\n  httpPort: {h.Port}\nvector: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-artifact-viewer\n      surfaces:\n        webui: {{sessions: [artifact-owner]}}\n";
        await File.WriteAllTextAsync(h.ConfigPath, config);
        await File.AppendAllTextAsync(
            h.ConfigPath,
            "url: " + h.Client.BaseAddress + "nested/main/\n"
        );
        h.Start();
        await h.Ready();
        foreach (var id in new[] { "artifact-owner", "artifact-other" })
        {
            var create = await h.Client.PostAsync(
                "/nested/main/api/sessions",
                new StringContent(
                    new JsonObject { ["agentId"] = "main", ["sessionId"] = id }.ToJsonString(),
                    System.Text.Encoding.UTF8,
                    "application/json"
                )
            );
            Assert.Equal(HttpStatusCode.OK, create.StatusCode);
            Assert.Equal(
                id,
                SessionWait.Text(
                    (await create.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]
                )
            );
        }
        var root = Path.Combine(h.Data, "state", "artifacts");
        var image = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var source = await ArtifactStoreTests.Source(
            new JsonObject
            {
                ["root"] = root,
                ["action"] = "publish",
                ["sessionId"] = "artifact-owner",
                ["image"] = Convert.ToBase64String(image),
            }
        );
        var artifactId = SessionWait.Text(source["receipt"]?["artifactId"])!;
        var route = $"/nested/main/api/sessions/artifact-owner/artifacts/{artifactId}/1";
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = h.Client.BaseAddress,
        };
        foreach (var suffix in new[] { "", "/resources/image" })
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await client.GetAsync(route + suffix)).StatusCode
            );
        client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-artifact-viewer");
        var auth = await client.GetStringAsync("/nested/main/api/auth/session");
        var history = await client.GetAsync("/nested/main/api/sessions/artifact-owner/history");
        Assert.True(
            history.IsSuccessStatusCode,
            $"Scope: {auth}; history: {history.StatusCode}: {await history.Content.ReadAsStringAsync()}"
        );
        var metadata = await client.GetAsync(route);
        Assert.True(
            metadata.StatusCode == HttpStatusCode.OK,
            $"{metadata.StatusCode}: {await metadata.Content.ReadAsStringAsync()}"
        );
        Assert.True(metadata.Headers.CacheControl!.Private);
        Assert.True(metadata.Headers.CacheControl.NoStore);
        Assert.True(
            JsonNode.DeepEquals(source, await metadata.Content.ReadFromJsonAsync<JsonObject>())
        );
        var resource = await client.GetAsync(route + "/resources/image");
        Assert.Equal(HttpStatusCode.OK, resource.StatusCode);
        Assert.Equal("image/png", resource.Content.Headers.ContentType!.MediaType);
        Assert.Equal("nosniff", resource.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal(
            "default-src 'none'; sandbox",
            resource.Headers.GetValues("Content-Security-Policy").Single()
        );
        Assert.Equal(image, await resource.Content.ReadAsByteArrayAsync());
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await client.GetAsync(route.Replace("artifact-owner", "artifact-other"))).StatusCode
        );
        foreach (var suffix in new[] { "", "/resources/image" })
            Assert.Equal(
                HttpStatusCode.NotFound,
                (
                    await h.Client.GetAsync(
                        route.Replace("artifact-owner", "artifact-other") + suffix
                    )
                ).StatusCode
            );
        // The existing resource digest is a persisted contract, not a new handoff fingerprint.
        var digest = SessionWait.Text(source["resources"]?["image"]?["sha256"])!;
        await File.WriteAllBytesAsync(Path.Combine(root, artifactId, "resources", digest), [1, 2]);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await client.GetAsync(route + "/resources/image")).StatusCode
        );
        await File.WriteAllTextAsync(Path.Combine(root, artifactId, "1.json"), "{broken");
        var unavailable = await client.GetAsync(route);
        Assert.Equal(HttpStatusCode.NotFound, unavailable.StatusCode);
        Assert.DoesNotContain(h.Data, await unavailable.Content.ReadAsStringAsync());
        var revoked =
            config[..config.IndexOf("access:", StringComparison.Ordinal)]
            + "access: {identities: {}}\n";
        Assert.Equal(
            HttpStatusCode.OK,
            (await h.Client.PostAsJsonAsync("/api/setup/config", new { yaml = revoked })).StatusCode
        );
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route)).StatusCode);
        await h.Stop();
    }
}
