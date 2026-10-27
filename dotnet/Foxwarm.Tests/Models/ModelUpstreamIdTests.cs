using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelUpstreamIdTests
{
    private static JsonObject Document(Uri uri, string protocol, bool compatible = false)
    {
        var document = JsonNode
            .Parse(
                """
                {"default":"alias","providers":{
                  "p":{"models":[
                    {"id":"astra","upstreamModelId":" shared-upstream ","maxOutput":111,"pricing":{"cached":1,"input":1,"output":1}},
                    {"id":"astra-img","upstreamModelId":"shared-upstream","maxOutput":222,"pricing":{"cached":2,"input":2,"output":2}},
                    "native"
                  ]},
                  "alias":"p/astra",
                  "route":{"providerType":"failover","targets":["p/astra","p/astra-img"]}
                }}
                """
            )!
            .AsObject();
        var provider = document["providers"]!["p"]!.AsObject();
        provider["providerType"] = protocol;
        provider["baseUrl"] = uri.ToString();
        if (protocol == "anthropic")
            provider["extraFields"] = new JsonObject { ["stream"] = false };
        if (protocol is "openai-responses" or "openai-ws")
            provider["models"]![1]!["imageGeneration"] = true;
        if (compatible)
            provider["models"]![1]!["sameModelAs"] = "astra";
        return document;
    }

    [Fact]
    public void Upstream_override_preserves_internal_keys_and_changes_the_resolved_route_fingerprint()
    {
        var document = Document(new Uri("http://localhost"), "openai-responses");
        var catalog = HostModels.Parse(document, new JsonObject());
        Assert.Equal("astra", catalog.Resolve("p/astra").ModelId);
        Assert.Equal("p/astra", catalog.Resolve("p/astra").Key);
        Assert.Equal("shared-upstream", catalog.Resolve("p/astra").UpstreamModelId);
        Assert.Equal("native", catalog.Resolve("p/native").UpstreamModelId);
        Assert.Equal(
            "",
            HostModels
                .Parse(
                    JsonNode.Parse("""{"providers":{"leaf":{}}}""")!.AsObject(),
                    new JsonObject()
                )
                .Resolve("leaf")
                .UpstreamModelId
        );
        var fingerprint = catalog.Resolve("route").Configuration["fingerprint"]!.ToString();
        document["providers"]!["p"]!["models"]![0]!["upstreamModelId"] = "another-upstream";
        var changed = HostModels.Parse(document, new JsonObject());
        Assert.Equal(catalog.Resolve("route").Targets, changed.Resolve("route").Targets);
        Assert.NotEqual(
            fingerprint,
            changed.Resolve("route").Configuration["fingerprint"]!.ToString()
        );
    }

    [Theory]
    [InlineData("null")]
    [InlineData("false")]
    [InlineData("123")]
    [InlineData("\"\"")]
    [InlineData("\"   \"")]
    public async Task Invalid_upstream_value_does_not_replace_installed_bytes_or_catalog(string raw)
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var document = Document(new Uri("http://localhost"), "openai-responses");
        var original = document.ToJsonString();
        await configuration.SaveAsync(new JsonObject { ["yaml"] = original });
        document["providers"]!["p"]!["models"]![0]!["upstreamModelId"] = JsonNode.Parse(raw);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() })
        );
        Assert.Contains("upstreamModelId", error.Message);
        Assert.Equal(original, await File.ReadAllTextAsync(configuration.ActivePath));
        Assert.Equal("shared-upstream", configuration.Capture().Resolve("p/astra").UpstreamModelId);
    }

    [Fact]
    public void Upstream_field_is_rejected_outside_model_objects_and_extra_fields_keep_wire_precedence()
    {
        foreach (var type in new[] { "openai-responses", "session-hash", "failover" })
        {
            var document = Document(new Uri("http://localhost"), "openai-responses");
            document["providers"]!["p"]!["providerType"] = type;
            document["providers"]!["p"]!["upstreamModelId"] = "forbidden-default";
            Assert.Contains(
                "upstreamModelId",
                Assert
                    .Throws<InvalidDataException>(() =>
                        HostModels.Parse(document, new JsonObject())
                    )
                    .Message
            );
        }
        foreach (var protocol in new[] { "openai-responses", "openai-completions", "anthropic" })
        {
            var document = Document(new Uri("http://localhost"), protocol);
            document["providers"]!["p"]!["models"]![0]!["extraFields"] = new JsonObject
            {
                ["model"] = "wire-override",
            };
            var leaf = HostModels.Parse(document, new JsonObject()).Resolve("p/astra");
            var options = ConfiguredModelRequests.Plan(
                leaf,
                new(new Uri("http://localhost"), "unused", "unused", "", "", 1000),
                "high",
                "",
                "cache",
                "turn"
            );
            var body = protocol switch
            {
                "anthropic" => AnthropicRequestSerializer.BuildRequest([], options),
                "openai-completions" => CompletionsRequestSerializer.BuildRequest(
                    [],
                    options,
                    "reasoning_content",
                    "cache"
                ),
                _ => ResponsesRequestPlan.Build([], options),
            };
            Assert.Equal("shared-upstream", options.RequestModel);
            Assert.Equal("p/astra", options.ConcreteModelId);
            Assert.Equal("wire-override", SessionWait.Text(body["model"]));
        }
    }

    [Theory]
    [InlineData("openai-responses", false)]
    [InlineData("openai-responses", true)]
    [InlineData("openai-completions", false)]
    [InlineData("openai-completions", true)]
    [InlineData("anthropic", false)]
    [InlineData("anthropic", true)]
    public async Task HTTP_requests_keep_internal_identity_and_replay_native_history_only_with_declared_compatibility(
        string protocol, bool compatible
    )
    {
        var bodies = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            (_, stream, captured) =>
            {
                bodies.Add(JsonNode.Parse(captured.Body)!.AsObject());
                return LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    protocol == "anthropic" ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(Body(protocol))
                );
            }
        );
        await ExerciseAsync(peer.BaseUri, protocol, bodies, compatible: compatible);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WS_requests_keep_internal_identity_and_replay_native_history_only_with_declared_compatibility(bool compatible)
    {
        await using var peer = await WsPeer.StartAsync((_, number) => Response(number));
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        await ExerciseAsync(peer.Uri, "openai-ws", peer.Requests, transport, compatible);
    }

    private static async Task ExerciseAsync(
        Uri uri,
        string protocol,
        List<JsonObject> bodies,
        ResponsesWsTransport? transport = null,
        bool compatible = false
    )
    {
        using var temp = new TempDirectory();
        using var http = new HttpClient();
        using var journal = new LlmRequestJournalStore(temp.Path);
        var catalog = HostModels.Parse(Document(uri, protocol, compatible), new JsonObject());
        var requests = new ModelRequestOwner(
            http,
            new(uri, "fallback", "fallback", "", "", 1000),
            new ModelRouting(),
            websockets: transport,
            journal: journal
        );
        var history = new List<JsonObject> { ResponsesWsTests.Message("user", "first") };
        foreach (
            var (index, key) in new[] { "alias", "p/astra-img", "p/native" }.Select(
                (key, index) => (index, key)
            )
        )
        {
            var result = await requests.RequestAsync(
                "s",
                catalog,
                key,
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                ModelRequestScope.Canonical
            );
            var assistant = Assert.IsType<JsonObject>(result.AssistantMessage);
            var internalKey = index == 0 ? "p/astra" : key;
            Assert.Equal(internalKey, SessionWait.Text(assistant["__meta"]?["modelId"]));
            if (index < 2)
                Assert.Equal(
                    .000015 * (index + 1),
                    SessionCatalog.Number(result.Usage?["cost"])!.Value,
                    10
                );
            history.Add(assistant);
            result.FinalizeHistory([assistant]);
            history.Add(ResponsesWsTests.Message("user", "next"));
        }
        Assert.Equal(
            new[] { "shared-upstream", "shared-upstream", "native" },
            bodies.Select(body => SessionWait.Text(body["model"]))
        );
        var maxOutput =
            protocol == "anthropic" || protocol == "openai-completions"
                ? "max_tokens"
                : "max_output_tokens";
        Assert.Equal(111, SessionWait.Number(bodies[0][maxOutput]));
        Assert.Equal(222, SessionWait.Number(bodies[1][maxOutput]));
        var secondWire = bodies[1].ToJsonString();
        Assert.Equal(compatible, secondWire.Contains("private-reasoning", StringComparison.Ordinal));
        Assert.Equal(compatible && protocol != "openai-completions", secondWire.Contains("private-cipher", StringComparison.Ordinal));
        Assert.DoesNotContain("private-reasoning", bodies[2].ToJsonString());
        if (protocol == "openai-completions")
            Assert.Equal(compatible, secondWire.Contains("private-provider-field", StringComparison.Ordinal));
        if (protocol is "openai-responses" or "openai-ws")
        {
            Assert.Equal(compatible, secondWire.Contains("native-search", StringComparison.Ordinal));
            Assert.Equal(compatible, secondWire.Contains("citation-marker", StringComparison.Ordinal));
        }
        if (protocol is "openai-responses" or "openai-ws")
        {
            Assert.DoesNotContain(
                bodies[0]["tools"]!.AsArray(),
                tool => SessionWait.Text(tool?["type"]) == "image_generation"
            );
            Assert.Contains(
                bodies[1]["tools"]!.AsArray(),
                tool => SessionWait.Text(tool?["type"]) == "image_generation"
            );
        }
        var rows = await journal.ListAsync("s", null, null, null, 10);
        Assert.Equal(3, rows.Count);
        var attributed = new List<string>();
        foreach (var row in rows)
        {
            var record = await journal.ReconstructAsync(row!["requestId"]!.GetValue<string>());
            var attempt = Assert.Single(record["attempts"]!.AsArray());
            attributed.Add(attempt!["start"]!["concreteModelId"]!.GetValue<string>());
        }
        Assert.Equal(
            new[] { "p/astra", "p/astra-img", "p/native" },
            attributed.Order(StringComparer.Ordinal)
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Compatible_models_with_equal_options_still_use_distinct_WS_connections(bool compatible)
    {
        await using var peer = await WsPeer.StartAsync();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        using var http = new HttpClient();
        var document = Document(peer.Uri, "openai-ws", compatible);
        var second = document["providers"]!["p"]!["models"]![1]!.AsObject();
        second.Remove("imageGeneration");
        second["maxOutput"] = 111;
        var catalog = HostModels.Parse(document, new JsonObject());
        var requests = new ModelRequestOwner(
            http,
            new(peer.Uri, "unused", "unused", "", "", 1000),
            new ModelRouting(),
            websockets: transport
        );
        var history = new List<JsonObject> { ResponsesWsTests.Message("user", "first") };
        foreach (var key in new[] { "p/astra", "p/astra-img", "p/astra-img" })
        {
            var result = await requests.RequestAsync(
                "s",
                catalog,
                key,
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                ModelRequestScope.Canonical
            );
            history.Add(result.AssistantMessage!);
            result.FinalizeHistory([result.AssistantMessage!]);
            history.Add(ResponsesWsTests.Message("user", "next"));
        }
        Assert.Equal(2, peer.Connections);
        Assert.False(peer.Requests[1].ContainsKey("previous_response_id"));
        Assert.True(peer.Requests[2].ContainsKey("previous_response_id"));
        Assert.All(
            peer.Requests,
            body => Assert.Equal("shared-upstream", SessionWait.Text(body["model"]))
        );
    }

    [Fact]
    public async Task ToolScript_one_shot_uses_the_configured_upstream_model_and_internal_journal_identity()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Body("openai-responses"))
                )
        );
        using var temp = new TempDirectory();
        var catalog = HostModels.Parse(
            Document(peer.BaseUri, "openai-responses", compatible: true),
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "unused", "unused", "", "", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "one-shot", null, null);
        var result = await manager.RequestToolScriptModelAsync(
            owner,
            "hello",
            "p/astra-img",
            new Foxwarm.ToolScript.ToolScriptDataBudget(),
            default
        );
        Assert.Equal("answer", SessionWait.Text(result["text"]));
        Assert.Equal(
            "shared-upstream",
            SessionWait.Text(JsonNode.Parse((await peer.RequestAt(0)).Body)?["model"])
        );
        var row = Assert.Single(
            await manager.Journal.ListAsync(owner.Id, "toolscript-one-shot", null, null, 10)
        );
        var saved = await manager.Journal.ReconstructAsync(row!["requestId"]!.GetValue<string>());
        Assert.Equal(
            "p/astra-img",
            SessionWait.Text(saved["attempts"]![0]!["start"]!["concreteModelId"])
        );
    }

    private static JsonObject Response(int number)
    {
        var response = ResponsesWsTests.Response(number);
        response["output"]!
            .AsArray()
            .Insert(
                0,
                new JsonObject
                {
                    ["type"] = "reasoning",
                    ["summary"] = new JsonArray(
                        new JsonObject { ["type"] = "summary_text", ["text"] = "private-reasoning" }
                    ),
                    ["encrypted_content"] = "private-cipher",
                }
            );
        response["output"]!.AsArray().Add(new JsonObject
        {
            ["type"] = "web_search_call", ["id"] = "native-search", ["status"] = "completed",
            ["action"] = new JsonObject { ["type"] = "search", ["query"] = "synthetic" },
        });
        response["output"]![1]!["content"]![0]!["annotations"] = new JsonArray(new JsonObject
        {
            ["type"] = "url_citation", ["title"] = "citation-marker", ["url"] = "https://example.invalid/", ["start_index"] = 0, ["end_index"] = 1,
        });
        response["usage"] = new JsonObject { ["input_tokens"] = 10, ["output_tokens"] = 5 };
        return response;
    }

    private static string Body(string protocol) =>
        protocol switch
        {
            "anthropic" =>
                "{\"content\":[{\"type\":\"thinking\",\"thinking\":\"private-reasoning\",\"signature\":\"private-cipher\"},{\"type\":\"text\",\"text\":\"answer\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}",
            "openai-completions" =>
                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"answer\",\"reasoning_content\":\"private-reasoning\",\"provider_specific_fields\":{\"opaque\":\"private-provider-field\"}},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
            _ => "data: "
                + new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = Response(1),
                }.ToJsonString()
                + "\n\n",
        };
}
