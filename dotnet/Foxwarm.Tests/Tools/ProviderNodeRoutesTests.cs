using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ProviderNodeRoutesTests
{
    [Fact]
    public async Task Qualified_detail_uses_the_listed_and_selected_identity_and_retains_native_and_admin_boundaries()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        var config = new JsonObject
        {
            ["vector"] = false,
            ["nodeProviders"] = new JsonObject
            {
                ["fixture"] = ExecutableNodeProviderTests.Configuration(
                    Path.Combine(temp.Path, "target")
                ),
            },
            ["access"] = new JsonObject
            {
                ["identities"] = new JsonObject
                {
                    ["reader"] = new JsonObject
                    {
                        ["token"] = "synthetic-provider-reader",
                        ["surfaces"] = new JsonObject
                        {
                            ["webui"] = new JsonObject { ["sessions"] = new JsonArray("selected") },
                        },
                    },
                },
            },
        };
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            config.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n"
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var listed = (await admin.GetFromJsonAsync<JsonObject>("api/nodes"))!["nodes"]!.AsArray();
        var expected = listed
            .OfType<JsonObject>()
            .Single(node => SessionWait.Text(node["id"]) == "fixture/target");
        var detailPath = "api/nodes/" + Uri.EscapeDataString("fixture/target");
        var detail = await admin.GetFromJsonAsync<JsonObject>(detailPath);
        Assert.Equal("fixture/target", SessionWait.Text(detail!["id"]));
        Assert.Equal(SessionWait.Text(expected["provider"]), SessionWait.Text(detail["provider"]));
        Assert.Equal(
            "master",
            SessionWait.Text((await admin.GetFromJsonAsync<JsonObject>("api/nodes/master"))!["id"])
        );
        var created = await admin.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "selected" }
        );
        created.EnsureSuccessStatusCode();
        var session = SessionWait.Text(
            (await created.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]
        )!;
        var selection = await admin.PostAsJsonAsync(
            "api/sessions/" + Uri.EscapeDataString(session) + "/node",
            new { nodeId = "fixture/target" }
        );
        selection.EnsureSuccessStatusCode();
        Assert.Equal(
            HttpStatusCode.NotFound,
            (
                await admin.GetAsync("api/nodes/" + Uri.EscapeDataString("fixture/missing"))
            ).StatusCode
        );
        var native = await admin.PostAsJsonAsync(
            "api/nodes/onboarding/create",
            new { nodeId = "offline-native" }
        );
        native.EnsureSuccessStatusCode();
        Assert.Equal(
            "offline-native",
            SessionWait.Text(
                (await admin.GetFromJsonAsync<JsonObject>("api/nodes/offline-native"))!["id"]
            )
        );
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-provider-reader");
        Assert.Equal(HttpStatusCode.Forbidden, (await scoped.GetAsync(detailPath)).StatusCode);
        using var anonymous = new HttpClient { BaseAddress = admin.BaseAddress };
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.GetAsync(detailPath)).StatusCode
        );
    }
}
