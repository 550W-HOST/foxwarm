using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class AgentDeletionHttpTests
{
    private static Task<HttpResponseMessage> Delete(
        HttpClient client,
        string name,
        string? confirmation
    ) =>
        client.SendAsync(
            new HttpRequestMessage(HttpMethod.Delete, "api/agents/" + Uri.EscapeDataString(name))
            {
                Content = JsonContent.Create(new { confirmAgentId = confirmation }),
            }
        );

    private static async Task<JsonObject> Create(
        HttpClient client,
        string name,
        string? inherit = null
    )
    {
        var response = await client.PostAsJsonAsync(
            "api/agents",
            new { agentId = name, inheritAgent = inherit }
        );
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
    }

    [Fact]
    public async Task Original_Agent_DELETE_contract_checks_authentication_confirmation_conflicts_and_exact_canonical_success_without_a_frontend_rewrite()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            """
            access:
              identities:
                reader:
                  token: synthetic-agent-delete-reader
                  surfaces:
                    webui: {sessions: [selected]}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1/v1
                models: [wire]
            """
        );
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-agent-delete-reader");
        using var stranger = new HttpClient { BaseAddress = admin.BaseAddress };
        var target = await Create(admin, "target");
        var member = target["sessionId"]!.ToString();
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await Delete(stranger, "target", "target")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Delete(scoped, "target", "target")).StatusCode
        );
        Assert.Equal(HttpStatusCode.BadRequest, (await Delete(admin, "target", null)).StatusCode);
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await Delete(admin, "target", "TARGET")).StatusCode
        );
        Assert.True(File.Exists(Path.Combine(data, "state", "sessions", member + ".json")));
        Assert.Equal(HttpStatusCode.BadRequest, (await Delete(admin, "main", "main")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Delete(admin, "absent", "absent")).StatusCode);
        await Create(admin, "inheritor", "target");
        Assert.Equal(HttpStatusCode.Conflict, (await Delete(admin, "target", "target")).StatusCode);
        var clear = await admin.PutAsJsonAsync(
            "api/agents/inheritor",
            new { inheritAgent = (string?)null }
        );
        Assert.True(clear.IsSuccessStatusCode, await clear.Content.ReadAsStringAsync());
        var deleted = await Delete(admin, "target", "target");
        Assert.True(deleted.IsSuccessStatusCode, await deleted.Content.ReadAsStringAsync());
        var result = (await deleted.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(result["success"]!.GetValue<bool>());
        Assert.Equal("target", result["agentId"]!.ToString());
        Assert.Equal(
            new[] { member },
            result["deletedSessions"]!.AsArray().Select(node => node!.ToString())
        );
        Assert.False(Directory.Exists(Path.Combine(data, "agents", "target")));
        var registry = (await admin.GetFromJsonAsync<JsonObject>("api/agents"))!;
        Assert.DoesNotContain(
            registry["agents"]!.AsArray(),
            row => row!["id"]!.ToString() == "target"
        );
        var selected = await Create(admin, "selected-command");
        var selectedId = selected["sessionId"]!.ToString();
        var route = "api/sessions/" + Uri.EscapeDataString(selectedId) + "/message";
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await scoped.PostAsJsonAsync(
                    route,
                    new { text = "/agent delete selected-command --confirm" }
                )
            ).StatusCode
        );
        var command = await admin.PostAsJsonAsync(
            route,
            new { text = "/agent delete selected-command --confirm" }
        );
        Assert.True(command.IsSuccessStatusCode, await command.Content.ReadAsStringAsync());
        Assert.False(Directory.Exists(Path.Combine(data, "agents", "selected-command")));
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", selectedId + ".json")));
        var directoryOnly = Path.Combine(data, "agents", "directory-only");
        Directory.CreateDirectory(directoryOnly);
        await Create(admin, "plain-no-metadata");
        await Create(admin, "metadata-failure", "main");
        var metadata = Path.Combine(data, "state", "agents.json");
        File.Move(metadata, metadata + ".held");
        Directory.CreateDirectory(metadata);
        try
        {
            var plain = await Delete(admin, "plain-no-metadata", "plain-no-metadata");
            Assert.True(plain.IsSuccessStatusCode, await plain.Content.ReadAsStringAsync());
            Assert.Equal(
                new[] { "plain-no-metadata/main" },
                (await plain.Content.ReadFromJsonAsync<JsonObject>())!["deletedSessions"]!
                    .AsArray()
                    .Select(node => node!.ToString())
            );
            Assert.False(Directory.Exists(Path.Combine(data, "agents", "plain-no-metadata")));
            var noMembers = await Delete(admin, "directory-only", "directory-only");
            Assert.True(noMembers.IsSuccessStatusCode, await noMembers.Content.ReadAsStringAsync());
            Assert.Empty(
                (await noMembers.Content.ReadFromJsonAsync<JsonObject>())![
                    "deletedSessions"
                ]!.AsArray()
            );
            Assert.False(Directory.Exists(directoryOnly));
            Assert.True(Directory.Exists(metadata));
            var failed = await Delete(admin, "metadata-failure", "metadata-failure");
            Assert.Equal(HttpStatusCode.BadRequest, failed.StatusCode);
            Assert.NotNull((await failed.Content.ReadFromJsonAsync<JsonObject>())!["error"]);
            Assert.False(Directory.Exists(Path.Combine(data, "agents", "metadata-failure")));
            Assert.False(
                File.Exists(
                    Path.Combine(data, "state", "sessions", "metadata-failure", "main.json")
                )
            );
        }
        finally
        {
            Directory.Delete(metadata);
            File.Move(metadata + ".held", metadata);
        }
    }
}
