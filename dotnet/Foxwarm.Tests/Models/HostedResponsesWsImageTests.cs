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
