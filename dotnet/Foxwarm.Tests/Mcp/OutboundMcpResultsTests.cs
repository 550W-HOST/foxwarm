using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class OutboundMcpResultsTests
{
    [Fact]
    public async Task Actual_HTTP_turn_Stop_commits_the_paired_cancellation_before_finalization_without_undoing_the_peer_effect()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var calls = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionCall"] = OutboundMcpFixture.Call(
                        "hold",
                        new JsonObject { ["tag"] = "actual-stop" }
                    ),
                }
            ),
        };
        var host = new LocalSessionTurnHost(
            f.First.Entry,
            f.First.AuthorityStore,
            new PlannedChat(calls),
            f.Tools(f.First)
        );
        Assert.True(await host.TryClaimBusyAsync());
        var running = host.ChatAsync("actual-stop");
        await peer.WaitAsync("effect", "actual-stop");
        Assert.True((await f.First.Registry.Control.StopAsync(f.First.Id)).AbortedInFlight);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
        var response = Assert.Single(ToolResponses(f.First));
        Assert.Equal(
            "tool_call_cancelled",
            response["response"]!["error"]!["type"]!.GetValue<string>()
        );
        Assert.Contains(
            "not reversed",
            response["response"]!["error"]!["message"]!.GetValue<string>()
        );
        Assert.Single(await peer.WaitAsync("delete"));
        Assert.Single(await peer.EventsAsync(), row => row["kind"]?.GetValue<string>() == "effect");
        await host.FinalizeStoppedAsync();
        Assert.False(f.First.Entry.Snapshot().Stopping);
        Assert.False(f.First.Entry.Snapshot().Busy);
        Assert.NotNull(await f.CallAsync(f.First, "probe"));
    }

    [Fact]
    public async Task Default_official_stateless_protocol_metadata_is_not_discarded_to_force_an_unwrap()
    {
        await using var peer = await StatelessSdkPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url);
        var value = await f.CallAsync(f.First, "value", new JsonObject { ["kind"] = "array" });
        Assert.Equal("complete", value!["resultType"]!.GetValue<string>());
        Assert.Equal("[1,null,false]", value["structuredContent"]!.ToJsonString());
        Assert.NotNull(value["_meta"]!["io.modelcontextprotocol/serverInfo"]);
        var script = await f.ScriptAsync("return call_tool('mcp:peer/value', {'kind': 'null'})");
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        Assert.True(script["result"]!.AsObject().ContainsKey("structuredContent"));
        Assert.Null(script["result"]!["structuredContent"]);
        Assert.NotNull(script["result"]!["_meta"]);
    }

    [Fact]
    public async Task Official_stateless_discover_peer_keeps_natural_JSON_values_through_Session_native_Monty_history_and_provider_projection()
    {
        await using var peer = await StatelessSdkPeer.StartAsync(minimalResults: true);
        await using var f = await OutboundMcpFixture.CreateAsync();
        peer.ExpectedAuthorization = "Bearer " + Guid.NewGuid().ToString("N");
        peer.ExpectedHeader = Guid.NewGuid().ToString("N");
        await f.ConfigureAsync(
            peer.Url,
            extra: new JsonObject
            {
                ["token"] = Guid.NewGuid().ToString("N"),
                ["headers"] = new JsonObject
                {
                    ["authorization"] = peer.ExpectedAuthorization,
                    ["X-Qualification"] = peer.ExpectedHeader,
                },
            }
        );
        var search = await f.Tools(f.First)
            .ExecuteAsync(
                new JsonObject
                {
                    ["name"] = "search_tools",
                    ["args"] = new JsonObject
                    {
                        ["sources"] = new JsonArray("mcp"),
                        ["server"] = "peer",
                    },
                },
                default
            );
        Assert.Contains("value", search!["output"]!.GetValue<string>());
        var array = await f.CallAsync(f.First, "value", new JsonObject { ["kind"] = "array" });
        Assert.True(array is JsonArray, array?.ToJsonString());
        Assert.Equal("[1,null,false]", array!.ToJsonString());
        Assert.False(
            (
                await f.CallAsync(f.First, "value", new JsonObject { ["kind"] = "scalar" })
            )!.GetValue<bool>()
        );
        Assert.Null(await f.CallAsync(f.First, "value", new JsonObject { ["kind"] = "null" }));
        var script = await f.ScriptAsync(
            "a = call_tool('mcp:peer/value', {'kind': 'array'})\nb = call_tool('mcp:peer/value', {'kind': 'scalar'})\nc = call_tool('mcp:peer/value', {'kind': 'null'})\nassert a == [1, None, False]\nassert b is False\nassert c is None\nreturn [a, b, c]"
        );
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        Assert.Equal("[[1,null,false],false,null]", script["result"]!.ToJsonString());
        await TurnAsync(f, [("value", "array"), ("value", "scalar"), ("value", "null")]);
        var responses = ToolResponses(f.First);
        Assert.IsType<JsonArray>(responses[0]["response"]);
        Assert.False(responses[1]["response"]!["output"]!.GetValue<bool>());
        Assert.True(responses[2]["response"]!.AsObject().ContainsKey("output"));
        Assert.Null(responses[2]["response"]!["output"]);
        var projected = ResponsesRequestSerializer.ConvertHistory(f.First.History(), "synthetic");
        var outputs = projected
            .OfType<JsonObject>()
            .Where(row => row["type"]?.GetValue<string>() == "function_call_output")
            .ToArray();
        Assert.Equal("[1, null, false]", outputs[0]["output"]!.GetValue<string>());
        Assert.Equal("false", outputs[1]["output"]!.GetValue<string>());
        Assert.Single(peer.Requests, row => row["method"]!.GetValue<string>() == "server/discover");
        Assert.DoesNotContain(
            peer.Requests,
            row => row["method"]!.GetValue<string>() is "initialize" or "DELETE"
        );
        Assert.All(
            peer.Requests,
            row =>
            {
                Assert.Equal("", row["session"]!.GetValue<string>());
                Assert.True(row["authorizationMatched"]!.GetValue<bool>());
                Assert.True(row["headerMatched"]!.GetValue<bool>());
            }
        );
        Assert.Contains(peer.Requests, row => row["protocol"]!.GetValue<string>() == "2026-07-28");
        Assert.IsType<JsonArray>(
            await f.CallAsync(f.Second, "value", new JsonObject { ["kind"] = "array" })
        );
        Assert.Equal(
            2,
            peer.Requests.Count(row => row["method"]!.GetValue<string>() == "server/discover")
        );
        Assert.Contains(
            "[1,null,false]",
            CompactCandidateBuilder.Preview(
                f.First.History().Single(row => row["role"]?.GetValue<string>() == "tool"),
                false
            )
        );
        await f.DisposeAsync();
        Assert.DoesNotContain(peer.Requests, row => row["method"]!.GetValue<string>() == "DELETE");
    }

    [Fact]
    public async Task Official_peer_source_normalization_retains_metadata_mixed_content_audio_resources_and_image_references_in_real_native_calls()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var script = await f.ScriptAsync(
            "kinds = ['object', 'array', 'text', 'primitive-text', 'structured', 'duplicate', 'mixed', 'annotated', 'meta', 'error', 'audio', 'resource', 'image']\nvalues = {}\nfor kind in kinds:\n    values[kind] = call_tool('mcp:peer/result', {'kind': kind})\nreturn values"
        );
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        var values = script["result"]!.AsObject();
        Assert.Equal("business", values["object"]!["output"]!.GetValue<string>());
        Assert.IsType<JsonArray>(values["array"]);
        Assert.Equal("hello", values["text"]!.GetValue<string>());
        Assert.Equal("false", values["primitive-text"]!.GetValue<string>());
        Assert.Equal(1, values["structured"]!["a"]!.GetValue<int>());
        Assert.True(JsonNode.DeepEquals(values["structured"], values["duplicate"]));
        Assert.Equal("explanation", values["mixed"]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal(
            "assistant",
            values["annotated"]!["content"]![0]!["annotations"]!["audience"]![0]!.GetValue<string>()
        );
        Assert.True(values["meta"]!["_meta"]!["retained"]!.GetValue<bool>());
        Assert.Empty(values["meta"]!["content"]!.AsArray());
        Assert.True(values["error"]!["isError"]!.GetValue<bool>());
        Assert.Empty(values["error"]!["content"]!.AsArray());
        Assert.Equal("audio", values["audio"]!["content"]![0]!["type"]!.GetValue<string>());
        Assert.Equal(
            "AA==",
            values["resource"]!["content"]![0]!["resource"]!["blob"]!.GetValue<string>()
        );
        var image = values["image"]!.AsObject();
        Assert.Equal("mixed", image["_meta"]!["note"]!.GetValue<string>());
        Assert.Equal("pixels and explanation", image["content"]![0]!["text"]!.GetValue<string>());
        var occurrence = Assert.Single(image["parts"]!.AsArray().OfType<JsonObject>());
        Assert.NotNull(occurrence["inlineDataRef"]);
        Assert.Equal("assistant", occurrence["annotations"]!["audience"]![0]!.GetValue<string>());
        Assert.Equal("retained", occurrence["_meta"]!["imageNote"]!.GetValue<string>());
        var reference = occurrence["inlineDataRef"]!.AsObject();
        Assert.NotEmpty(await f.Manager.Images.ReadAsync(reference));
        Assert.False(image.ContainsKey("inlineDataItems"));
        Assert.DoesNotContain("iVBOR", image.ToJsonString());
        var direct = await f.CallAsync(f.First, "result", new JsonObject { ["kind"] = "image" });
        Assert.Equal(
            "assistant",
            direct!["inlineDataItems"]![0]!["annotations"]!["audience"]![0]!.GetValue<string>()
        );
        await TurnAsync(
            f,
            [
                ("result", "array"),
                ("result", "text"),
                ("result", "meta"),
                ("result", "error"),
                ("result", "audio"),
                ("result", "resource"),
                ("result", "image"),
            ]
        );
        var responses = ToolResponses(f.First);
        Assert.IsType<JsonArray>(responses[0]["response"]);
        Assert.Equal("hello", responses[1]["response"]!["output"]!.GetValue<string>());
        Assert.True(responses[2]["response"]!["_meta"]!["retained"]!.GetValue<bool>());
        Assert.True(responses[3]["response"]!["isError"]!.GetValue<bool>());
        Assert.Equal(
            "audio",
            responses[4]["response"]!["content"]![0]!["type"]!.GetValue<string>()
        );
        Assert.Equal(
            "AA==",
            responses[5]["response"]!["content"]![0]!["resource"]!["blob"]!.GetValue<string>()
        );
        var persisted = f.First.History().Single(row => row["role"]?.GetValue<string>() == "tool");
        Assert.Single(
            persisted["parts"]!.AsArray().OfType<JsonObject>(),
            part => part["inlineDataRef"] is not null
        );
        Assert.DoesNotContain("iVBOR", persisted.ToJsonString());
        Assert.DoesNotContain(
            "iVBOR",
            f.First.Archive.ReadMessages()
                .Single(row =>
                    row.MessageJson.Contains("\"role\":\"tool\"", StringComparison.Ordinal)
                )
                .MessageJson
        );
        var hydrated = await f.Manager.Images.HydrateAsync(f.First.History(), "responses");
        var output = ResponsesRequestSerializer
            .ConvertHistory(hydrated, "synthetic")
            .OfType<JsonObject>()
            .Where(row => row["type"]?.GetValue<string>() == "function_call_output")
            .Last();
        Assert.Contains(
            output["output"]!.AsArray(),
            block => block?["type"]?.GetValue<string>() == "input_image"
        );
        Assert.Single(
            await peer.EventsAsync(),
            row => row["kind"]!.GetValue<string>() == "initialize"
        );
    }

    private static JsonObject[] ToolResponses(SessionOwner owner) =>
        owner
            .History()
            .Where(row => row["role"]?.GetValue<string>() == "tool")
            .SelectMany(row => row["parts"]!.AsArray())
            .OfType<JsonObject>()
            .Where(part => part["functionResponse"] is not null)
            .Select(part => part["functionResponse"]!.AsObject())
            .ToArray();

    // The actual turn executor, strict JSON/Archive save lane, and owner-backed tools;
    // only the provider's requested calls are synthetic, with no paid model effect.
    private static async Task TurnAsync(OutboundMcpFixture f, (string Tool, string Kind)[] requests)
    {
        var parts = new JsonArray();
        foreach (var (tool, kind) in requests)
            parts.Add(
                new JsonObject
                {
                    ["functionCall"] = OutboundMcpFixture.Call(
                        tool,
                        new JsonObject { ["kind"] = kind }
                    ),
                }
            );
        var chat = new PlannedChat(new JsonObject { ["role"] = "model", ["parts"] = parts });
        var host = new LocalSessionTurnHost(
            f.First.Entry,
            f.First.AuthorityStore,
            chat,
            f.Tools(f.First)
        );
        Assert.True(await host.TryClaimBusyAsync());
        try
        {
            await host.ChatAsync("outbound-qualification");
        }
        finally
        {
            await host.ReleaseBusyAsync();
        }
    }

    private sealed class PlannedChat(JsonObject calls) : IChatService
    {
        private int turns;

        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) =>
            Task.FromResult(
                new ChatResult(
                    Interlocked.Increment(ref turns) == 1
                        ? calls
                        : new JsonObject
                        {
                            ["role"] = "model",
                            ["parts"] = new JsonArray(new JsonObject { ["text"] = "done" }),
                        }
                )
            );
    }
}
