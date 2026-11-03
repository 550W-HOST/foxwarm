using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class FirstRunWelcomeTests
{
    private const string CompletionBody =
        "data: {\"choices\":[{\"delta\":{\"content\":\"Nice to meet you.\"}}]}\n\ndata: [DONE]\n\n";

    [Theory]
    [InlineData(null, null, "en")]
    [InlineData(null, "", "en")]
    [InlineData(null, "zh-CN,zh;q=0.9,en;q=0.8", "zh")]
    [InlineData(null, "en-US,en;q=0.9,zh-CN;q=0.8", "en")]
    [InlineData(null, "ja,zh-TW;q=0.8,en;q=0.5", "zh")]
    [InlineData(null, "fr-FR,de;q=0.9", "en")]
    [InlineData(null, "en;q=0.2, zh-Hans;q=0.7", "zh")]
    [InlineData("zh-TW", "en-US", "zh")]
    [InlineData("en-GB", "zh-CN", "en")]
    [InlineData("ja-JP", "zh-CN", "en")]
    public void Language_prefers_explicit_locale_then_weighted_accept_language(
        string? locale,
        string? acceptLanguage,
        string expected
    ) => Assert.Equal(expected, FirstRunWelcome.Language(locale, acceptLanguage));

    [Fact]
    public async Task Packaged_welcome_exists_in_both_languages()
    {
        foreach (var language in new[] { FirstRunWelcome.English, FirstRunWelcome.Chinese })
        {
            var text = await FirstRunWelcome.TextAsync(AppContext.BaseDirectory, language);
            Assert.Contains("`main`", text);
            Assert.Contains("Agent", text);
            Assert.Contains("Session", text);
        }
    }

    [Fact]
    public async Task First_models_save_creates_main_welcome_that_the_model_sees_as_its_own_reply()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(CompletionBody)
                )
        );
        using var temp = new TempDirectory();
        await using var host = await StartAsync(temp.Path);
        var client = host.Client;
        Assert.Empty((await client.GetFromJsonAsync<JsonObject>("/api/sessions"))!["sessions"]!.AsArray());

        var raw =
            "default: local/wire\nproviders:\n  local:\n    providerType: openai-completions\n    baseUrl: "
            + peer.BaseUri
            + "\n    apiKey: synthetic\n    models: [wire]\n";
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/setup/models")
        {
            Content = JsonContent.Create(new { yaml = raw }),
        };
        request.Headers.AcceptLanguage.ParseAdd("zh-CN,zh;q=0.9,en;q=0.8");
        var saved = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var receipt = (await saved.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("main", receipt["firstSessionId"]!.GetValue<string>());
        Assert.Equal(raw, await File.ReadAllTextAsync(host.Configuration.ActivePath));

        var history = await HistoryAsync(client, "main");
        Assert.Equal(2, history.Count);
        Assert.Equal("user", history[0]!["role"]!.GetValue<string>());
        var opening = history[0]!["parts"]![0]!["system"]!.GetValue<string>();
        Assert.StartsWith(
            "<foxwarm-system kind=\"session-boundary\" event=\"first-run\" currentSessionId=\"main\" currentNode=\"master\"",
            opening
        );
        Assert.Equal("model", history[1]!["role"]!.GetValue<string>());
        var welcome = history[1]!["parts"]![0]!["text"]!.GetValue<string>();
        Assert.Equal(await FirstRunWelcome.TextAsync(AppContext.BaseDirectory, "zh"), welcome);

        // A later save neither recreates nor alters the default Session.
        var again = await client.PostAsJsonAsync("/api/setup/models", new { yaml = raw });
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.False((await again.Content.ReadFromJsonAsync<JsonObject>())!.ContainsKey("firstSessionId"));
        Assert.Single((await client.GetFromJsonAsync<JsonObject>("/api/sessions"))!["sessions"]!.AsArray());
        Assert.Equal(2, (await HistoryAsync(client, "main")).Count);

        // The provider history begins with a user turn and keeps the welcome as the
        // assistant's own earlier reply.
        var triggered = await client.PostAsJsonAsync(
            "/trigger",
            new { text = "Call me Ming.", sessionId = "main" }
        );
        Assert.True(triggered.IsSuccessStatusCode, await triggered.Content.ReadAsStringAsync());
        var captured = await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(15));
        var messages = JsonNode.Parse(captured.Body)!["messages"]!.AsArray();
        var roles = messages.Select(message => message!["role"]!.GetValue<string>()).ToArray();
        Assert.Equal(["system", "user", "assistant", "user"], roles);
        Assert.Contains("first-run", messages[1]!["content"]!.ToJsonString());
        Assert.Equal(welcome, messages[2]!["content"]!.GetValue<string>());
        Assert.Contains("Call me Ming.", messages[3]!["content"]!.ToJsonString());
        Assert.DoesNotContain("BOOTSTRAP.md", messages[0]!["content"]!.ToJsonString());
    }

    [Fact]
    public async Task Explicit_client_locale_selects_the_welcome_and_is_not_saved()
    {
        using var temp = new TempDirectory();
        await using var host = await StartAsync(temp.Path);
        var raw =
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n";
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/setup/models")
        {
            Content = JsonContent.Create(new { yaml = raw, locale = "en-US" }),
        };
        request.Headers.AcceptLanguage.ParseAdd("zh-CN");
        var saved = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal(raw, await File.ReadAllTextAsync(host.Configuration.ActivePath));
        var history = await HistoryAsync(host.Client, "main");
        Assert.Equal(
            await FirstRunWelcome.TextAsync(AppContext.BaseDirectory, "en"),
            history[1]!["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Installation_with_existing_Sessions_is_not_changed_by_its_first_models_save()
    {
        using var temp = new TempDirectory();
        await using var host = await StartAsync(temp.Path);
        var created = await host.Client.PostAsJsonAsync(
            "/api/sessions",
            new { agentId = "main", sessionId = "existing" }
        );
        Assert.True(created.IsSuccessStatusCode);
        var raw =
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n";
        var saved = await host.Client.PostAsJsonAsync("/api/setup/models", new { yaml = raw });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Null((await saved.Content.ReadFromJsonAsync<JsonObject>())!["firstSessionId"]);
        var sessions = (await host.Client.GetFromJsonAsync<JsonObject>("/api/sessions"))!["sessions"]!.AsArray();
        Assert.Equal("existing", Assert.Single(sessions)!["id"]!.GetValue<string>());
        Assert.Empty(await HistoryAsync(host.Client, "existing"));
    }

    private static async Task<JsonArray> HistoryAsync(HttpClient client, string sessionId) =>
        (await client.GetFromJsonAsync<JsonObject>(
            "/api/sessions/" + Uri.EscapeDataString(sessionId) + "/history"
        ))!["messages"]!.AsArray();

    private static async Task<RunningHost> StartAsync(string root)
    {
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(root, environment: _ => null)
        );
        var settings = (await HttpServerSettings.CaptureAsync(configuration, root)) with
        {
            Port = 0,
            BindAddress = "127.0.0.1",
            Address = new("http://127.0.0.1", "", "/", false),
        };
        var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        var client = new HttpClient
        {
            BaseAddress = new Uri(host.App.Urls.Single()),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        return new RunningHost(host, client, configuration);
    }

    private sealed record RunningHost(MainHost Host, HttpClient Client, ModelConfiguration Configuration)
        : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await Host.DisposeAsync();
        }
    }
}
