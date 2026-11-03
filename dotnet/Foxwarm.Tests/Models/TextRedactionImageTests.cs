using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class TextRedactionImageTests
{
    [Theory]
    [InlineData("openai-responses", false)]
    [InlineData("openai-responses", true)]
    [InlineData("openai-completions", false)]
    [InlineData("openai-completions", true)]
    [InlineData("anthropic", false)]
    [InlineData("anthropic", true)]
    [InlineData("openai-ws", false)]
    [InlineData("openai-ws", true)]
    public async Task Redaction_preserves_hydrated_user_and_tool_image_state_without_mutating_canonical_history(
        string protocol,
        bool imageInput
    )
    {
        const string secret = "private@example.test";
        using var temp = new TempDirectory();
        var images = new ImageBlobStore(temp.Path);
        var reference = await images.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png, 390, 3600),
            "image/png",
            "original"
        );
        await using var detector = await TextDetectionPeer.StartAsync(secret);
        JsonObject? captured = null;
        await using var websocket =
            protocol == "openai-ws"
                ? await StreamingModelPeer.StartAsync(
                    true,
                    async (context, _) =>
                    {
                        captured = context.Request;
                        await context.Send(
                            ResponsesPrefixCommitTests.Completed(
                                new JsonObject
                                {
                                    ["type"] = "message",
                                    ["role"] = "assistant",
                                    ["content"] = new JsonArray(
                                        new JsonObject { ["type"] = "output_text", ["text"] = "ok" }
                                    ),
                                }
                            )
                        );
                    }
                )
                : null;
        await using var peer =
            protocol == "openai-ws"
                ? null
                : new LoopbackResponsesServer(
                    async (connection, request) =>
                    {
                        captured = JsonNode.Parse(request.Body)!.AsObject();
                        var response =
                            protocol == "anthropic"
                                ? "{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"stop_reason\":\"end_turn\"}"
                            : protocol == "openai-completions"
                                ? "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
                            : "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}]}}\n\n";
                        await LoopbackResponsesServer.WriteResponseAsync(
                            connection,
                            200,
                            protocol == "anthropic" ? "application/json" : "text/event-stream",
                            Encoding.UTF8.GetBytes(response)
                        );
                    }
                );
        var endpoint = websocket?.Uri ?? peer!.BaseUri;
        var provider = new JsonObject
        {
            ["providerType"] = protocol,
            ["baseUrl"] = endpoint.ToString(),
            ["models"] = new JsonArray("m"),
            ["imageInput"] = imageInput,
            ["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint),
        };
        if (protocol == "anthropic")
            provider["extraFields"] = new JsonObject { ["stream"] = false };
        var catalog = HostModels.Parse(
            new JsonObject { ["providers"] = new JsonObject { ["p"] = provider } },
            new()
        );
        JsonObject Image(string? call = null) =>
            new() { ["inlineDataRef"] = reference.DeepClone(), ["toolUseId"] = call };
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = secret }, Image()),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["name"] = "read",
                            ["id"] = "call",
                            ["args"] = new JsonObject(),
                        },
                    }
                ),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["name"] = "read",
                            ["tool_use_id"] = "call",
                            ["response"] = new JsonObject { ["output"] = secret },
                        },
                    },
                    Image("call")
                ),
            },
        };
        var original = new JsonArray(history.Select(row => row.DeepClone()).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var owner = new ModelRequestOwner(
            http,
            new(endpoint, "m", "p/m", "", "", 100, new()),
            new(),
            images: images
        );
        var result = await owner.RequestAsync(
            "s",
            owner.Capture(catalog, "p/m", null),
            "cache",
            "turn",
            history,
            (_, _) => Task.FromResult(""),
            null,
            null,
            null,
            null,
            default,
            maxAttempts: 1
        );
        Assert.NotNull(result.AssistantMessage);
        Assert.NotNull(captured);
        Assert.True(
            JsonNode.DeepEquals(
                original,
                new JsonArray(history.Select(row => row.DeepClone()).ToArray())
            )
        );
        var wire = captured.ToJsonString();
        Assert.Contains("[[FW_PRIVATE_", wire);
        Assert.DoesNotContain(secret, wire);
        var objects = Objects(captured).ToArray();
        var binaries = objects
            .Where(value =>
                SessionWait.Text(value["type"]) is "input_image" or "image_url" or "image"
            )
            .ToArray();
        var labels = objects
            .Select(value => SessionWait.Text(value["text"]))
            .Where(text => text?.StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true)
            .ToArray();
        Assert.Equal(2, labels.Length);
        if (imageInput)
        {
            Assert.Single(binaries);
            Assert.Contains("appears earlier", wire);
            Assert.All(
                labels,
                label =>
                    Assert.Contains(
                        "size=390x3600, sent_size=277x2560] image_crop coordinates use the original size.",
                        label
                    )
            );
        }
        else
        {
            Assert.Empty(binaries);
            Assert.Contains(ProviderImageParts.UnsupportedInputText, wire);
            Assert.DoesNotContain("sent_size", wire);
        }
    }

    private static IEnumerable<JsonObject> Objects(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            yield return obj;
            foreach (var (_, child) in obj)
            foreach (var nested in Objects(child))
                yield return nested;
        }
        else if (node is JsonArray array)
            foreach (var child in array)
            foreach (var nested in Objects(child))
                yield return nested;
    }
}
