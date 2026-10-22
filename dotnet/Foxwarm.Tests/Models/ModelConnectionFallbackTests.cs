using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ModelConnectionFallbackTests
{
    [Theory]
    [InlineData("openai-responses", "/v1/responses")]
    [InlineData("openai-completions", "/v1/chat/completions")]
    [InlineData("anthropic", "/v1/messages")]
    public async Task Empty_provider_connections_inherit_startup_legacy_settings_in_physical_requests(
        string type,
        string path
    )
    {
        var response = type switch
        {
            "anthropic" => "{\"content\":[{\"type\":\"text\",\"text\":\"fallback answer\"}]}",
            "openai-completions" =>
                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"fallback answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            _ =>
                "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"fallback answer\"}]}]}}\n\n",
        };
        await using var peer = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    type == "anthropic" ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(response)
                )
        );
        var baseUri =
            type == "anthropic"
                ? new Uri(peer.BaseUri.GetLeftPart(UriPartial.Authority))
                : peer.BaseUri;
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.GetDirectoryName(paths.ConfigPath)!);
        var family = type == "anthropic" ? "anthropic" : "openai";
        await File.WriteAllTextAsync(
            paths.ConfigPath,
            new JsonObject
            {
                ["llm"] = new JsonObject
                {
                    [family + "BaseUrl"] = baseUri.ToString(),
                    [family + "ApiKey"] = "synthetic-legacy-key",
                },
            }.ToJsonString()
        );
        var configuration = new ModelConfiguration(paths);
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = new JsonObject
                {
                    ["providers"] = new JsonObject
                    {
                        ["local"] = new JsonObject
                        {
                            ["providerType"] = type,
                            ["baseUrl"] = "",
                            ["apiKey"] = "",
                            ["models"] = new JsonArray("wire"),
                            ["extraFields"] =
                                type == "anthropic"
                                    ? new JsonObject { ["stream"] = false }
                                    : new JsonObject(),
                        },
                    },
                }.ToJsonString(),
            }
        );
        var receipt = await configuration.SaveAppAsync(
            new JsonObject
            {
                ["llm"] = new JsonObject
                {
                    [family + "BaseUrl"] = baseUri.ToString(),
                    [family + "ApiKey"] = "synthetic-changed-key",
                },
            }.ToJsonString()
        );
        Assert.Contains("llm", receipt["restartRequired"]!.ToJsonString());
        await configuration.SaveAsync(
            new JsonObject { ["yaml"] = await File.ReadAllTextAsync(configuration.ActivePath) }
        );
        Assert.Equal(
            "synthetic-changed-key",
            new ModelConfiguration(paths).Capture().Resolve("local/wire").Token
        );
        var model = configuration.Capture().Resolve("local/wire");
        Assert.Equal(baseUri, model.BaseUri);
        Assert.Equal("synthetic-legacy-key", model.Token);
        var defaults = new ResponsesClientOptions(peer.BaseUri, "unused", "unused", "", "", 713);
        var options = ConfiguredModelRequests.Plan(
            model,
            defaults,
            "low",
            "prompt",
            "cache",
            "turn"
        );
        using var http = ProviderHttpRequest.CreateClient();
        var result = await ConfiguredModelRequests
            .CreateService(http, model, options, "cache")
            .ChatAsync("s", [], default);
        Assert.Contains("fallback answer", result.AssistantMessage!.ToJsonString());
        var request = await peer.Request;
        Assert.Equal("POST " + path + " HTTP/1.1", request.RequestLine);
        Assert.Equal(
            type == "anthropic" ? "synthetic-legacy-key" : "Bearer synthetic-legacy-key",
            request.Headers[type == "anthropic" ? "x-api-key" : "Authorization"]
        );
        Assert.Equal(1, peer.RequestCount);
    }

    [Theory]
    [InlineData("openai-ws", "openai", "https://api.openai.com/v1")]
    [InlineData("anthropic", "anthropic", "https://api.anthropic.com")]
    public void Empty_connections_fall_through_but_nonempty_provider_values_keep_precedence(
        string type,
        string family,
        string defaultUrl
    )
    {
        var provider = new JsonObject
        {
            ["providerType"] = type,
            ["models"] = new JsonArray("wire"),
            ["baseUrl"] = "",
            ["apiKey"] = "",
        };
        var root = new JsonObject { ["providers"] = new JsonObject { ["local"] = provider } };
        var app = new JsonObject
        {
            ["llm"] = new JsonObject { [family + "BaseUrl"] = "", [family + "ApiKey"] = "" },
        };
        var empty = HostModels.Parse(root, app).Resolve("local");
        Assert.Equal(new Uri(defaultUrl), empty.BaseUri);
        Assert.Equal("", empty.Token);
        provider["baseUrl"] = "https://provider.example/v1";
        provider["apiKey"] = "synthetic-provider-key";
        app["llm"]![family + "BaseUrl"] = "https://legacy.example/v1";
        app["llm"]![family + "ApiKey"] = "synthetic-legacy-key";
        var explicitProvider = HostModels.Parse(root, app).Resolve("local");
        Assert.Equal(new Uri("https://provider.example/v1"), explicitProvider.BaseUri);
        Assert.Equal("synthetic-provider-key", explicitProvider.Token);
    }
}
