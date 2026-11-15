using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject Text(string text) => new() { ["type"] = "text", ["text"] = text };

    private static JsonObject Search(string id = "search") =>
        new()
        {
            ["type"] = "server_tool_use",
            ["id"] = id,
            ["name"] = "web_search",
            ["input"] = new JsonObject { ["query"] = "synthetic current information" },
        };

    private static JsonObject Sources(string id = "search") =>
        new()
        {
            ["type"] = "web_search_tool_result",
            ["tool_use_id"] = id,
            ["content"] = new JsonArray(
                Obj(
                    """{"type":"web_search_result","url":"https://example.com/source","title":"A source","encrypted_content":"opaque-result","page_age":"2026-11-01"}"""
                )
            ),
        };

    private static JsonObject Cited() =>
        Obj(
            """{"type":"text","text":"😀 A supported claim.","citations":[{"type":"web_search_result_location","url":"https://example.com/exact","title":"Exact citation","encrypted_index":"opaque-index","cited_text":"Exact supporting text"}]}"""
        );

    private static JsonObject Reply(string reason, params JsonObject[] blocks) =>
        new()
        {
            ["id"] = "synthetic-message",
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(blocks.Select(block => block.DeepClone()).ToArray()),
            ["stop_reason"] = reason,
            ["usage"] = Obj(
                """{"input_tokens":300000,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":40,"server_tool_use":{"web_search_requests":2},"iterations":[{"type":"message","input_tokens":5000,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":40},{"type":"message","input_tokens":10000,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":40}]}"""
            ),
        };

    private static string Sse(JsonObject reply, JsonObject? initialUsage = null)
    {
        var output = new StringBuilder();
        void Event(JsonObject item) =>
            output.Append("data: ").Append(item.ToJsonString()).Append("\n\n");
        Event(
            new JsonObject
            {
                ["type"] = "message_start",
                ["message"] = new JsonObject
                {
                    ["id"] = "synthetic-message",
                    ["usage"] =
                        initialUsage?.DeepClone()
                        ?? Obj("""{"input_tokens":1,"output_tokens":0}"""),
                },
            }
        );
        var index = 0;
        foreach (var raw in reply["content"]!.AsArray().OfType<JsonObject>())
        {
            var block = (JsonObject)raw.DeepClone();
            var kind = SessionWait.Text(block["type"]);
            JsonObject? delta = null;
            if (kind is "server_tool_use" or "tool_use")
            {
                delta = new JsonObject
                {
                    ["type"] = "input_json_delta",
                    ["partial_json"] = block["input"]!.ToJsonString(),
                };
                block["input"] = new JsonObject();
            }
            var citations = block["citations"] as JsonArray;
            block.Remove("citations");
            Event(
                new JsonObject
                {
                    ["type"] = "content_block_start",
                    ["index"] = index,
                    ["content_block"] = block,
                }
            );
            if (delta is not null)
                Event(
                    new JsonObject
                    {
                        ["type"] = "content_block_delta",
                        ["index"] = index,
                        ["delta"] = delta,
                    }
                );
            foreach (var citation in citations ?? [])
                Event(
                    new JsonObject
                    {
                        ["type"] = "content_block_delta",
                        ["index"] = index,
                        ["delta"] = new JsonObject
                        {
                            ["type"] = "citations_delta",
                            ["citation"] = citation!.DeepClone(),
                        },
                    }
                );
            Event(new JsonObject { ["type"] = "content_block_stop", ["index"] = index++ });
        }
        Event(
            new JsonObject
            {
                ["type"] = "message_delta",
                ["delta"] = new JsonObject { ["stop_reason"] = reply["stop_reason"]!.DeepClone() },
                ["usage"] = reply["usage"]!.DeepClone(),
            }
        );
        Event(new JsonObject { ["type"] = "message_stop" });
        return output.ToString();
    }

    private static Task Respond(
        System.Net.Sockets.NetworkStream stream,
        JsonObject response,
        bool streaming
    ) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            streaming ? "text/event-stream" : "application/json",
            Encoding.UTF8.GetBytes(streaming ? Sse(response) : response.ToJsonString())
        );

    [Fact]
    public async Task Models_YAML_boolean_inheritance_and_existing_Responses_objects_reach_prepared_wire()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        const string yaml = """
            default: a/inherited
            providers:
              a:
                providerType: anthropic
                baseUrl: http://127.0.0.1:1
                webSearch: true
                models:
                  - inherited
                  - {id: disabled, webSearch: false}
                  - {id: enabled, webSearch: true}
              b:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1
                webSearch:
                  enabled: true
                  toolChoice: required
                  searchContextSize: high
                  allowedDomains: [example.com]
                  userLocation: {country: US}
                models: [wire, {id: off, webSearch: false}, {id: empty, webSearch: {allowedDomains: [], userLocation: {country: " ", city: "", region: " NY ", timezone: ""}}}]
            """;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = yaml });
        Assert.Equal(yaml, await File.ReadAllTextAsync(configuration.ActivePath));
        var defaults = new ResponsesClientOptions(
            new Uri("http://localhost"),
            "wire",
            "a/wire",
            "",
            "system",
            1000
        )
        {
            Tools = new JsonArray(Obj("""{"name":"task","parameters":{"type":"object"}}""")),
        };
        ResponsesClientOptions Plan(string key, string purpose = "normal-turn") =>
            ConfiguredModelRequests.Plan(
                configuration.Capture().Resolve(key),
                defaults,
                "none",
                "system",
                "cache",
                "turn",
                purpose
            );
        foreach (var key in new[] { "a/inherited", "a/enabled" })
        {
            var normal = AnthropicRequestSerializer.BuildRequest([], Plan(key));
            Assert.True(AnthropicRequestSerializer.HasSearchTool(normal));
            Assert.Equal("web_search_20250305", normal["tools"]![1]!["type"]!.ToString());
            Assert.Null(normal["tools"]![1]!["input_schema"]);
            foreach (var purpose in new[] { "compact-plan", "background-compact-plan" })
                Assert.Equal(
                    normal.ToJsonString(),
                    AnthropicRequestSerializer.BuildRequest([], Plan(key, purpose)).ToJsonString()
                );
            foreach (var purpose in new[] { "background", "setup-test" })
                Assert.False(
                    AnthropicRequestSerializer.HasSearchTool(
                        AnthropicRequestSerializer.BuildRequest([], Plan(key, purpose))
                    )
                );
        }
        Assert.False(
            AnthropicRequestSerializer.HasSearchTool(
                AnthropicRequestSerializer.BuildRequest([], Plan("a/disabled"))
            )
        );
        var responses = HostedResponsesTools.BuildWebSearchTool(Plan("b/wire").WebSearch)!;
        Assert.Equal("high", responses["search_context_size"]!.ToString());
        Assert.Equal("example.com", responses["filters"]!["allowed_domains"]![0]!.ToString());
        Assert.Null(HostedResponsesTools.BuildWebSearchTool(Plan("b/off").WebSearch));
        var native = AnthropicRequestSerializer.BuildSearchTool(Plan("b/wire").WebSearch)!;
        Assert.Equal("example.com", native["allowed_domains"]![0]!.ToString());
        Assert.Equal("approximate", native["user_location"]!["type"]!.ToString());
        var emptyNative = AnthropicRequestSerializer.BuildSearchTool(Plan("b/empty").WebSearch)!;
        var emptyResponses = HostedResponsesTools.BuildWebSearchTool(Plan("b/empty").WebSearch)!;
        Assert.Null(emptyNative["allowed_domains"]);
        Assert.Null(emptyResponses["filters"]);
        Assert.True(
            JsonNode.DeepEquals(emptyNative["user_location"], emptyResponses["user_location"])
        );
        Assert.Equal(
            """{"type":"approximate","region":"NY"}""",
            emptyNative["user_location"]!.ToJsonString()
        );
        var overridden = AnthropicRequestSerializer.BuildRequest(
            [],
            Plan("a/enabled") with
            {
                ExtraFields = Obj("""{"tools":[],"tool_choice":{"type":"auto"}}"""),
            }
        );
        Assert.False(AnthropicRequestSerializer.HasSearchTool(overridden));
        Assert.Equal("auto", overridden["tool_choice"]!["type"]!.ToString());
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(
                new JsonObject { ["yaml"] = yaml.Replace("webSearch: true", "webSearch: invalid") }
            )
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Session_search_local_tool_pause_restart_compatible_replay_and_protocol_switch(
        bool streaming
    )
    {
        var peerFailure = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var first = Reply(
            "tool_use",
            Obj(
                """{"type":"thinking","thinking":"signed reasoning","signature":"opaque-signature"}"""
            ),
            Search(),
            Obj("""{"type":"tool_use","id":"local","name":"task","input":{"action":"list"}}""")
        );
        var paused = Reply("pause_turn", Sources(), Text("## Findings\n\n"), Text("- "), Cited(), Text("\n"));
        var final = Reply(
            "end_turn",
            Search("later"),
            Sources("later"),
            Text("Finished after search.")
        );
        // Stable endpoint usage has no per-iteration measurement. Exercise the
        // estimator with a large cumulative bill on the successful final result.
        final["usage"]!.AsObject().Remove("iterations");
        await using var peer = new ScriptedResponsesSequenceServer(
            6,
            async (index, stream, request) =>
            {
                try
                {
                    var body = Obj(request.Body);
                    if (index < 5)
                    {
                        Assert.StartsWith("POST /v1/messages ", request.RequestLine);
                        Assert.True(AnthropicRequestSerializer.HasSearchTool(body));
                        var wire = body["messages"]!.AsArray();
                        if (index == 1)
                        {
                            Assert.True(
                                JsonNode.DeepEquals(first["content"], wire[^2]!["content"])
                            );
                            Assert.Equal(
                                "tool_result",
                                wire[^1]!["content"]![0]!["type"]!.ToString()
                            );
                            Assert.Equal(
                                "local",
                                wire[^1]!["content"]![0]!["tool_use_id"]!.ToString()
                            );
                            Assert.DoesNotContain("hosted_web_search_sources", wire.ToJsonString());
                        }
                        if (index == 2)
                            Assert.True(
                                JsonNode.DeepEquals(paused["content"], wire[^1]!["content"])
                            );
                        if (index is 3 or 4)
                        {
                            Assert.Contains("opaque-result", wire.ToJsonString());
                            Assert.Contains("opaque-index", wire.ToJsonString());
                            Assert.Contains("opaque-signature", wire.ToJsonString());
                            Assert.DoesNotContain("hosted_web_search_sources", wire.ToJsonString());
                        }
                        await Respond(
                            stream,
                            index switch
                            {
                                0 => first,
                                1 => paused,
                                2 => final,
                                _ => Reply("end_turn", Text("Replay complete.")),
                            },
                            streaming
                        );
                    }
                    else
                    {
                        Assert.StartsWith("POST /v1/responses ", request.RequestLine);
                        Assert.DoesNotContain("opaque-", body.ToJsonString());
                        Assert.Contains(
                            "https://example.com/source",
                            body["input"]!.ToJsonString()
                        );
                        Assert.Contains("untrusted external data", body["input"]!.ToJsonString());
                        Assert.DoesNotContain("web_search_result_location", body.ToJsonString());
                        await LoopbackResponsesServer.WriteResponseAsync(
                            stream,
                            200,
                            "text/event-stream",
                            Encoding.UTF8.GetBytes(
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"done\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Portable complete.\"}]}]}}\n\n"
                            )
                        );
                    }
                }
                catch (Exception error)
                {
                    Console.WriteLine($"Peer {index}: {error}");
                    peerFailure.TrySetException(error);
                    throw;
                }
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\n");
        var provider = new JsonObject
        {
            ["providerType"] = "anthropic",
            ["baseUrl"] = new Uri(peer.BaseUri, "/").ToString(),
            ["contextLimit"] = 50000,
            ["asyncCompact"] = false,
            ["webSearch"] = true,
            ["extraFields"] = new JsonObject { ["stream"] = streaming },
            ["models"] = new JsonArray(
                new JsonObject
                {
                    ["id"] = "wire",
                    ["pricing"] = Obj("""{"cached":1,"input":2,"output":3}"""),
                }
            ),
        };
        var compatible = (JsonObject)provider.DeepClone();
        compatible["sameProviderAs"] = "a";
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/wire",
                ["providers"] = new JsonObject
                {
                    ["a"] = provider,
                    ["b"] = compatible,
                    ["c"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                    },
                },
            },
            new JsonObject()
        );
        var options = new ResponsesClientOptions(
            peer.BaseUri,
            "wire",
            "a/wire",
            "",
            "Stable instructions.",
            1000
        );
        async Task Run(SessionOwner owner)
        {
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("Synthetic input " + new string('a', 10000))
            );
            await await Task.WhenAny(owner.StartProcessing(), peerFailure.Task)
                .WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.False(owner.Metadata().LlmFailed);
        }
        void Stored(IReadOnlyList<JsonObject> rows)
        {
            var native = rows.SelectMany(row => row["parts"]!.AsArray())
                .SelectMany(part => part?["providerMeta"]?["anthropic"]?["contentBlocks"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .ToArray();
            Assert.Contains(
                native,
                block =>
                    SessionWait.Text(block["type"]) == "web_search_tool_result"
                    && block.ToJsonString().Contains("opaque-result")
            );
            Assert.Contains(
                native,
                block =>
                    SessionWait.Text(block["type"]) == "text"
                    && block.ToJsonString().Contains("opaque-index")
            );
            Assert.Single(rows, row => SessionWait.Text(row["role"]) == "tool");
            Assert.Empty(HostedSearchSourcesTests.Evidence(rows));
        }
        string id;
        await using (var manager = new SessionManager(data, work, options, catalog))
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.CreateNamedAsync("main", "native-search", null, null);
            id = owner.Id;
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await Run(owner);
            Assert.Equal(3, peer.RequestCount);
            Stored(owner.History());
            Stored(owner.Archive.ReadMessages().Select(row => row.Message).ToArray());
            var finalUsage = owner.History().Last(row => row["__meta"]?["usage"] is JsonObject)[
                "__meta"
            ]!["usage"]!;
            Assert.Equal(300010, finalUsage["inputTokens"]!.GetValue<double>());
            Assert.Equal(
                streaming ? "reported-input-plus-estimate" : "estimated",
                finalUsage["contextTokensSource"]!.ToString()
            );
            Assert.InRange(
                finalUsage["contextTokens"]!.GetValue<double>(),
                streaming ? 1 : 1000,
                40000
            );
            Assert.Equal(
                (20 + 300010 * 2 + 40 * 3) / 1_000_000d,
                finalUsage["cost"]!.GetValue<double>(),
                9
            );
            Assert.DoesNotContain(
                owner.History(),
                row => row["__meta"]?["contextBlock"] is not null
            );
            await manager.ShutdownAsync();
        }
        await using (var manager = new SessionManager(data, work, options, catalog))
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.RequiredAsync(id);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            Stored(owner.History());
            await Run(owner);
            await owner.UpdateModelAsync(new JsonObject { ["model"] = "b/wire" });
            await Run(owner);
            await owner.UpdateModelAsync(new JsonObject { ["model"] = "c/wire" });
            await Run(owner);
            Stored(owner.History());
            await manager.ShutdownAsync();
        }
        Assert.Equal(6, peer.RequestCount);
    }
}
