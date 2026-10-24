using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ModelConfigurationFormTests
{
    [Theory]
    [InlineData(
        "{\"providers\":[{\"id\":\" chosen \",\"providerKey\":\"other\",\"provider\":\"third\",\"models\":\"wire\"}]}",
        "chosen"
    )]
    [InlineData(
        "{\"providers\":[{\"id\":\"\",\"providerKey\":\" chosen \",\"provider\":\"other\",\"models\":\"wire\"}]}",
        "chosen"
    )]
    [InlineData(
        "{\"providers\":[{\"id\":false,\"providerKey\":\"\",\"provider\":\" chosen \",\"models\":\"wire\"}]}",
        "chosen"
    )]
    [InlineData("{\"providers\":[{\"models\":\"wire\"}]}", "provider1")]
    [InlineData(
        "{\"id\":\"ignored\",\"providerKey\":\" chosen \",\"provider\":\"other\",\"models\":\"wire\"}",
        "chosen"
    )]
    [InlineData("{\"providerKey\":\"\",\"provider\":\" chosen \",\"model\":\"wire\"}", "chosen")]
    [InlineData("{\"id\":\"ignored\",\"models\":\"\",\"model\":\"wire\"}", "openai")]
    public async Task Structured_provider_forms_use_TypeScript_key_precedence_and_fallbacks(
        string raw,
        string key
    )
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var receipt = await configuration.SaveAsync(JsonNode.Parse(raw)!.AsObject());
        Assert.True(receipt["saved"]!.GetValue<bool>());
        var saved = ConfigurationYaml.Parse(
            await File.ReadAllTextAsync(configuration.ActivePath),
            "models config"
        );
        Assert.Equal(key, Assert.Single(saved["providers"]!.AsObject()).Key);
        Assert.Equal("wire", configuration.Capture().Resolve(key).ModelId);
    }

    [Theory]
    [InlineData("{}", "a/wire-a")]
    [InlineData("{\"defaultModel\":\"\",\"default\":\" b/wire-b \"}", "b/wire-b")]
    [InlineData("{\"defaultModel\":\" \",\"default\":\"b/wire-b\"}", "a/wire-a")]
    [InlineData("{\"defaultModel\":\"\",\"default\":\"\"}", "a/wire-a")]
    public async Task Structured_defaults_select_before_trimming_then_use_the_first_model_fallback(
        string raw,
        string expected
    )
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var form = JsonNode.Parse(raw)!.AsObject();
        form["providers"] = JsonNode.Parse(
            """
            [{"id":"a","models":"wire-a"},{"id":"b","models":"wire-b"}]
            """
        );
        await configuration.SaveAsync(form);
        var saved = ConfigurationYaml.Parse(
            await File.ReadAllTextAsync(configuration.ActivePath),
            "models config"
        );
        Assert.Equal(expected, saved["default"]!.GetValue<string>());
        Assert.Equal(expected, configuration.Capture().DefaultKey);
        Assert.Equal(expected.Split('/')[1], configuration.Capture().Resolve(null).ModelId);
    }

    [Fact]
    public async Task Single_provider_normalization_clears_omitted_connection_fields_like_TypeScript()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] =
                    "providers:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', apiKey: synthetic-key, models: [{id: wire, maxOutput: 123}]}\n",
            }
        );
        await configuration.SaveAsync(
            new JsonObject { ["providerKey"] = "local", ["models"] = "wire" }
        );
        var saved = ConfigurationYaml.Parse(
            await File.ReadAllTextAsync(configuration.ActivePath),
            "models config"
        );
        var provider = saved["providers"]!["local"]!;
        Assert.Null(provider["apiKey"]);
        Assert.Null(provider["baseUrl"]);
        Assert.Equal("openai-responses", provider["providerType"]!.GetValue<string>());
        Assert.Equal(123, configuration.Capture().Resolve("local").MaxOutput);
    }

    [Fact]
    public async Task Mixed_key_HTTP_save_publishes_every_submitted_provider_and_routes_the_next_normal_request()
    {
        const string done =
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n";
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(done)
                )
        );
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var initial = new JsonObject
        {
            ["default"] = "a/wire-a",
            ["extension"] = new JsonObject { ["retained"] = true },
            ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = peer.BaseUri.ToString(),
                    ["models"] = new JsonArray("wire-a"),
                },
                ["b"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = peer.BaseUri.ToString(),
                    ["apiKey"] = "synthetic-retained-key",
                    ["extraFields"] = new JsonObject { ["retained_marker"] = "provider-override" },
                    ["models"] = new JsonArray(
                        new JsonObject
                        {
                            ["id"] = "wire-b",
                            ["maxOutput"] = 123,
                            ["tokenPricesPerMillion"] = new JsonObject
                            {
                                ["cached"] = 0,
                                ["input"] = .25,
                                ["output"] = 1.5,
                            },
                        }
                    ),
                },
                ["omitted"] = new JsonObject { ["models"] = new JsonArray("unused") },
            },
        };
        await configuration.SaveAsync(new JsonObject { ["yaml"] = initial.ToJsonString() });
        var settings = (await HttpServerSettings.CaptureAsync(configuration, temp.Path)) with
        {
            Port = 0,
            BindAddress = "127.0.0.1",
            Address = new("http://127.0.0.1", "", "/", false),
        };
        await using var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        using var client = new HttpClient
        {
            BaseAddress = new Uri(host.App.Urls.Single()),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var form = JsonNode.Parse(
            """
            {"providers":[{"id":"a","models":"wire-a"},{"providerKey":"b","models":"wire-b"}],"defaultModel":" \ufeffb/wire-b\ufeff ","default":"a/wire-a"}
            """
        )!;
        var response = await client.PostAsJsonAsync("/api/setup/models", form);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var receipt = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(receipt["saved"]!.GetValue<bool>());
        Assert.Equal("models", Assert.Single(receipt["applied"]!.AsArray())!.GetValue<string>());
        Assert.Empty(receipt["notApplied"]!.AsArray());
        Assert.Empty(receipt["restartRequired"]!.AsArray());
        Assert.Equal(2, receipt["models"]!["providerCount"]!.GetValue<int>());
        Assert.Equal("b/wire-b", receipt["payload"]!["defaultKey"]!.GetValue<string>());
        var catalog = (await client.GetFromJsonAsync<JsonObject>("/api/models"))!;
        Assert.Equal("b/wire-b", catalog["defaultKey"]!.GetValue<string>());
        Assert.True(configuration.Capture().Contains("b"));
        Assert.False(configuration.Capture().Contains("omitted"));
        var installed = await File.ReadAllBytesAsync(configuration.ActivePath);
        var saved = ConfigurationYaml.Parse(Encoding.UTF8.GetString(installed), "models config");
        Assert.Equal("b/wire-b", saved["default"]!.GetValue<string>());
        Assert.Equal(
            "synthetic-retained-key",
            saved["providers"]!["b"]!["apiKey"]!.GetValue<string>()
        );
        Assert.True(saved["extension"]!["retained"]!.GetValue<bool>());

        var session = await client.PostAsJsonAsync(
            "/api/sessions",
            new { agentId = "main", sessionId = "form" }
        );
        Assert.True(session.IsSuccessStatusCode);
        var sessionId = (await session.Content.ReadFromJsonAsync<JsonObject>())![
            "sessionId"
        ]!.GetValue<string>();
        var trigger = await client.PostAsJsonAsync(
            "/trigger",
            new { text = "exercise saved default", sessionId }
        );
        Assert.True(trigger.IsSuccessStatusCode, await trigger.Content.ReadAsStringAsync());
        var request = JsonNode.Parse(
            (await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10))).Body
        )!;
        Assert.Equal("wire-b", request["model"]!.GetValue<string>());
        Assert.Equal(123, request["max_output_tokens"]!.GetValue<int>());
        Assert.Equal("provider-override", request["retained_marker"]!.GetValue<string>());

        foreach (
            var invalid in new[]
            {
                "{\"providers\":[{\"id\":\"a\",\"models\":\"wire-a\"},{\"providerKey\":\"b\",\"models\":\"\"}]}",
                "{\"providers\":[{\"providerKey\":\"b\",\"providerType\":\"unsupported\",\"models\":\"wire-b\"}]}",
                "{\"yaml\":\"providers: null\\n\"}",
            }
        )
        {
            var rejected = await client.PostAsJsonAsync(
                "/api/setup/models",
                JsonNode.Parse(invalid)
            );
            Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
            Assert.Equal(installed, await File.ReadAllBytesAsync(configuration.ActivePath));
            Assert.Equal("b/wire-b", configuration.Capture().DefaultKey);
        }

        var single = await client.PostAsJsonAsync(
            "/api/setup/models",
            new
            {
                id = "ignored",
                providerKey = "b",
                models = "wire-b",
            }
        );
        Assert.Equal(HttpStatusCode.OK, single.StatusCode);
        var singleReceipt = (await single.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal(1, singleReceipt["models"]!["providerCount"]!.GetValue<int>());
        Assert.Equal("b/wire-b", singleReceipt["payload"]!["defaultKey"]!.GetValue<string>());
        Assert.Equal("b", Assert.Single(configuration.Capture().Options).ProviderKey);
        Assert.Equal(123, configuration.Capture().Resolve(null).MaxOutput);
        Assert.Equal(
            .25,
            configuration.Capture().Resolve(null).Configuration["tokenPricesPerMillion"]![
                "input"
            ]!.GetValue<double>()
        );

        var raw =
            "# exact raw bytes\r\ndefault: raw/wire\r\nproviders:\r\n  raw: {providerType: openai-responses, models: [wire]}\r\n";
        var rawResponse = await client.PostAsJsonAsync(
            "/api/setup/models",
            new
            {
                yaml = raw,
                providerKey = "ignored",
                models = "ignored",
            }
        );
        Assert.Equal(HttpStatusCode.OK, rawResponse.StatusCode);
        Assert.Equal(
            Encoding.UTF8.GetBytes(raw),
            await File.ReadAllBytesAsync(configuration.ActivePath)
        );
        Assert.Equal("raw/wire", configuration.Capture().DefaultKey);
    }
}
