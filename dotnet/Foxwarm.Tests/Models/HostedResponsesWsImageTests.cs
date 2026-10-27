using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Xunit;

namespace Foxwarm.Tests;

public sealed class HostedResponsesWsImageTests
{
    [Fact]
    public async Task Websocket_responses_externalizes_native_generated_image_and_sends_image_tool()
    {
        using var temp = new TempDirectory();
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        );
        await using var peer = await WsPeer.StartAsync(
            (_, number) =>
                new JsonObject
                {
                    ["id"] = "ws-image-" + number,
                    ["status"] = "completed",
                    ["output"] = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "ws-generated",
                            ["status"] = "completed",
                            ["output_format"] = "png",
                            ["result"] = Convert.ToBase64String(png),
                        }
                    ),
                }
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var options = new ResponsesClientOptions(
            peer.Uri,
            "wire",
            "openai-ws/wire",
            "synthetic",
            "prompt",
            713
        )
        {
            ImageGeneration = new JsonObject { ["enabled"] = true },
            Images = new ImageBlobStore(temp.Path),
        };
        var result = await new ResponsesWsChatService(
            options,
            transport,
            ModelRequestScope.Canonical,
            false,
            "ws-image"
        ).ChatAsync("session", [], default);
        var part = Assert.Single(result.AssistantMessage!["parts"]!.AsArray());
        Assert.NotNull(part!["inlineDataRef"]);
        Assert.Equal("generated", part["imageMeta"]!["origin"]!.GetValue<string>());
        Assert.Single(peer.Requests);
        var tools = Assert.IsType<JsonArray>(peer.Requests[0]["tools"]);
        Assert.Contains(tools, item => item?["type"]?.GetValue<string>() == "image_generation");
        Assert.DoesNotContain(Convert.ToBase64String(png), peer.Requests[0].ToJsonString());
    }

    [Fact]
    public async Task Websocket_generated_image_keeps_exact_append_chain_for_next_turn()
    {
        using var temp = new TempDirectory();
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        );
        await using var peer = await WsPeer.StartAsync(
            (_, number) =>
                number == 1
                    ? new JsonObject
                    {
                        ["id"] = "ws-image-first",
                        ["status"] = "completed",
                        ["output"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["type"] = "image_generation_call",
                                ["id"] = "ws-generated",
                                ["status"] = "completed",
                                ["output_format"] = "png",
                                ["result"] = Convert.ToBase64String(png),
                            },
                        },
                    }
                    : new JsonObject
                    {
                        ["id"] = "ws-image-second",
                        ["status"] = "completed",
                        ["output"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray
                                {
                                    new JsonObject
                                    {
                                        ["type"] = "output_text",
                                        ["text"] = "continued",
                                    },
                                },
                            },
                        },
                    }
        );
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var options = new ResponsesClientOptions(
            peer.Uri,
            "wire",
            "openai-ws/wire",
            "synthetic",
            "prompt",
            713
        )
        {
            ImageGeneration = new JsonObject { ["enabled"] = true },
            Images = new ImageBlobStore(temp.Path),
        };
        var service = new ResponsesWsChatService(
            options,
            transport,
            ModelRequestScope.Canonical,
            false,
            "ws-image"
        );
        var first = await service.ChatAsync("session", [], default);
        first.FinalizeHistory([first.AssistantMessage!]);
        var second = await service.ChatAsync(
            "session",
            [
                first.AssistantMessage!,
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "continue" }),
                },
            ],
            default
        );
        Assert.Equal(
            "continued",
            second.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(2, peer.Requests.Count);
        Assert.True(peer.Requests[1].ContainsKey("previous_response_id"));
    }

    [Fact]
    public async Task Compatible_variant_replays_original_image_on_its_own_connection_then_continues_its_chain()
    {
        using var temp = new TempDirectory();
        const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        await using var peer = await WsPeer.StartAsync((_, number) => number == 1
            ? new JsonObject
            {
                ["id"] = "generated-first", ["status"] = "completed",
                ["output"] = new JsonArray(new JsonObject
                {
                    ["type"] = "image_generation_call", ["id"] = "variant-generated",
                    ["status"] = "completed", ["output_format"] = "png", ["result"] = png,
                }),
            }
            : ResponsesWsTests.Response(number));
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var document = JsonNode.Parse("""
            {"providers":{"p":{"providerType":"openai-ws","imageGeneration":true,"models":[
              {"id":"a","upstreamModelId":"wire"},
              {"id":"b","upstreamModelId":"wire","sameModelAs":"a"}]}}}
            """)!.AsObject();
        document["providers"]!["p"]!["baseUrl"] = peer.Uri.ToString();
        var catalog = HostModels.Parse(document, new JsonObject());
        using var http = new HttpClient();
        var images = new ImageBlobStore(temp.Path);
        var owner = new ModelRequestOwner(http, new(peer.Uri, "wire", "unused", "", "", 1000),
            new ModelRouting(), websockets: transport, images: images);
        var history = new List<JsonObject> { ResponsesWsTests.Message("user", "draw") };
        foreach (var key in new[] { "p/a", "p/b", "p/b" })
        {
            var result = await owner.RequestAsync("s", catalog, key, null, "cache", "turn", history,
                (_, _) => Task.FromResult(""), null, null, null, null, default, ModelRequestScope.Canonical);
            history.Add(result.AssistantMessage!);
            result.FinalizeHistory([result.AssistantMessage!]);
            history.Add(ResponsesWsTests.Message("user", "continue"));
        }
        Assert.Equal(2, peer.Connections);
        Assert.False(peer.Requests[1].ContainsKey("previous_response_id"));
        var replay = Assert.Single(peer.Requests[1]["input"]!.AsArray(), item => item?["type"]?.GetValue<string>() == "image_generation_call");
        Assert.Equal(png, replay!["result"]!.GetValue<string>());
        Assert.True(peer.Requests[2].ContainsKey("previous_response_id"));
        Assert.Equal("p/a", history[1]["__meta"]!["modelId"]!.GetValue<string>());
        Assert.Equal("p/a", history[1]["parts"]![0]!["providerMeta"]!["openaiResponses"]!["sourceModelId"]!.GetValue<string>());
        Assert.Null(history[1]["parts"]![0]!["inlineData"]);
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-ws-image-" + Guid.NewGuid().ToString("N")
            );

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, true);
        }
    }
}
