using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelBehaviorOptionsTests
{
    [Fact]
    public void Behavior_options_inherit_provider_defaults_and_fingerprint_resolved_leaf_overrides()
    {
        var root = JsonNode.Parse(
            """
            {"providers":{
              "builtin":{},
              "leaf":{"asyncCompact":false,"disallowEmptyResponse":true},
              "p":{"asyncCompact":false,"disallowEmptyResponse":true,"models":["inherited",{"id":"overridden","asyncCompact":true,"disallowEmptyResponse":false}]},
              "alias":"p/overridden",
              "route":{"providerType":"failover","targets":["p/inherited","p/overridden"]}
            }}
            """
        )!.AsObject();
        var catalog = HostModels.Parse(root, new JsonObject());
        void Check(string key, bool background, bool strict)
        {
            var model = catalog.Resolve(key);
            Assert.Equal(background, model.Configuration["asyncCompact"]!.GetValue<bool>());
            Assert.Equal(strict, model.Configuration["disallowEmptyResponse"]!.GetValue<bool>());
        }
        Check("builtin", true, false);
        Check("leaf", false, true);
        Check("p/inherited", false, true);
        Check("p/overridden", true, false);
        Assert.True(catalog.Resolve("alias").Configuration["asyncCompact"]!.GetValue<bool>());
        Assert.False(catalog.Resolve("route").Configuration["asyncCompact"]!.GetValue<bool>());
        var original = catalog.Resolve("route").Configuration["fingerprint"]!.ToString();
        foreach (var field in new[] { "asyncCompact", "disallowEmptyResponse" })
        {
            var changed = (JsonObject)root.DeepClone();
            var model = changed["providers"]!["p"]!["models"]![1]!;
            model[field] = !model[field]!.GetValue<bool>();
            Assert.NotEqual(original, HostModels.Parse(changed, new JsonObject()).Resolve("route").Configuration["fingerprint"]!.ToString());
        }
    }

    [Theory]
    [InlineData("openai-responses", true)]
    [InlineData("openai-responses", false)]
    [InlineData("openai-completions", true)]
    [InlineData("openai-completions", false)]
    [InlineData("anthropic", true)]
    [InlineData("anthropic", false)]
    [InlineData("openai-ws", true)]
    [InlineData("openai-ws", false)]
    public async Task Selected_model_empty_policy_reaches_real_protocol_consumer_and_remains_request_captured(
        string providerType,
        bool strict
    )
    {
        using var temp = new TempDirectory();
        await using var peer = await WsPeer.StartAsync((_, number) =>
        {
            var response = ResponsesWsTests.Response(number);
            response["output"] = new JsonArray();
            return response;
        });
        using var handler = new EmptyResponseHandler(providerType);
        using var http = new HttpClient(handler);
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var configuration = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path, environment: _ => null));
        var document = new JsonObject
        {
            ["default"] = "p/other",
            ["providers"] = new JsonObject
            {
                ["p"] = new JsonObject
                {
                    ["providerType"] = providerType,
                    ["baseUrl"] = peer.Uri.ToString(),
                    ["disallowEmptyResponse"] = !strict,
                    ["extraFields"] = new JsonObject { ["stream"] = false },
                    ["models"] = new JsonArray(
                        "other",
                        new JsonObject { ["id"] = "selected", ["disallowEmptyResponse"] = strict }
                    ),
                },
                ["alias"] = "p/selected",
            },
        };
        // Anthropic JSON fixtures opt out of streaming; Responses and Completions use SSE.
        if (providerType != "anthropic")
            document["providers"]!["p"]!.AsObject().Remove("extraFields");
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        var requests = new ModelRequestOwner(
            http,
            new(peer.Uri, "fallback", "fallback", "", "", 1000),
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            websockets: transport
        );
        var captured = requests.Capture(configuration.Capture(), "alias", null);
        document["providers"]!["p"]!["models"]![1]!["disallowEmptyResponse"] = !strict;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        Assert.Equal(!strict, configuration.Capture().Resolve("p/selected").Configuration["disallowEmptyResponse"]!.GetValue<bool>());
        var events = new List<ModelRetryEvent>();
        Task<ChatResult> Send() => requests.RequestAsync(
            "session", captured, "cache", "turn", new JsonObject[] { new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "empty" }) } },
            (_, _) => Task.FromResult(""), value => { events.Add(value); return Task.FromResult(false); },
            null, null, null, CancellationToken.None, ModelRequestScope.Canonical
        );
        if (strict)
        {
            var error = await Assert.ThrowsAsync<ModelRequestException>(Send);
            Assert.Equal("response-error", error.Final.Kind);
            Assert.Equal("p/selected", error.Final.ModelId);
            Assert.Equal(6, error.Final.Attempt);
            Assert.Equal(ModelRequestScope.Canonical, error.Scope);
            Assert.All(events, value => Assert.Equal("response-error", value.Kind));
        }
        else
        {
            var result = await Send();
            Assert.False(OpenAIHttp.HasMeaningfulAssistant(result.AssistantMessage));
            Assert.Empty(events);
            result.FinalizeHistory(null);
        }
        var bodies = providerType == "openai-ws" ? peer.Requests : handler.Requests;
        Assert.Equal(strict ? 6 : 1, bodies.Count);
        Assert.All(bodies, body => Assert.Equal("selected", body["model"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Strict_model_failure_fails_over_to_model_that_explicitly_accepts_empty_output()
    {
        using var handler = new EmptyResponseHandler("openai-responses");
        using var http = new HttpClient(handler);
        var catalog = HostModels.Parse(JsonNode.Parse(
            """
            {"providers":{
              "p":{"providerType":"openai-responses","baseUrl":"http://localhost","disallowEmptyResponse":true,"models":[{"id":"strict"},{"id":"accept","disallowEmptyResponse":false}]},
              "route":{"providerType":"failover","targets":["p/strict","p/accept"],"failureThreshold":1}
            }}
            """
        )!.AsObject(), new JsonObject());
        var requests = new ModelRequestOwner(http, new(new Uri("http://localhost"), "fallback", "fallback", "", "", 1000), new ModelRouting(), (_, _) => Task.CompletedTask);
        var retries = new List<ModelRetryEvent>();
        var result = await requests.RequestAsync("session", catalog, "route", null, "cache", "turn", [], (_, _) => Task.FromResult(""), value => { retries.Add(value); return Task.FromResult(false); }, null, null, null, CancellationToken.None);
        Assert.Equal(new[] { "strict", "accept" }, handler.Requests.Select(body => body["model"]!.GetValue<string>()));
        Assert.Equal("response-error", Assert.Single(retries).Kind);
        Assert.False(OpenAIHttp.HasMeaningfulAssistant(result.AssistantMessage));
        result.FinalizeHistory(null);
    }

    private sealed class EmptyResponseHandler(string providerType) : HttpMessageHandler
    {
        internal readonly List<JsonObject> Requests = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject());
            var body = providerType switch
            {
                "openai-completions" => "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                "anthropic" => "{\"content\":[]}",
                _ => "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"empty\",\"status\":\"completed\",\"output\":[]}}\n\n",
            };
            return new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, providerType == "anthropic" ? "application/json" : "text/event-stream") };
        }
    }
}
