using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class ModelImageInputTests
{
    private static string Sse(JsonObject value) => "data: " + value.ToJsonString() + "\n\n";

    private static string AnthropicText() =>
        Sse(
            new JsonObject
            {
                ["type"] = "message_start",
                ["message"] = new JsonObject
                {
                    ["id"] = "anthropic-reply",
                    ["usage"] = new JsonObject { ["input_tokens"] = 4, ["output_tokens"] = 1 },
                },
            }
        )
        + Sse(
            new JsonObject
            {
                ["type"] = "content_block_start",
                ["index"] = 0,
                ["content_block"] = new JsonObject { ["type"] = "text", ["text"] = "ack" },
            }
        )
        + Sse(new JsonObject { ["type"] = "content_block_stop", ["index"] = 0 })
        + Sse(
            new JsonObject
            {
                ["type"] = "message_delta",
                ["delta"] = new JsonObject { ["stop_reason"] = "end_turn" },
                ["usage"] = new JsonObject { ["output_tokens"] = 1 },
            }
        )
        + Sse(new JsonObject { ["type"] = "message_stop" });

    [Fact]
    public async Task One_Session_switches_between_text_only_and_image_capable_targets_without_losing_images()
    {
        using var temp = new TempDirectory();
        var captured = new List<(string Path, JsonObject Body)>();
        var failCompletions = false;
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var peer = builder.Build();
        peer.MapPost(
            "/{**path}",
            async (HttpContext context) =>
            {
                var request = (await JsonNode.ParseAsync(context.Request.Body))!.AsObject();
                var path = context.Request.Path.Value!;
                lock (captured)
                    captured.Add((path, request));
                if (path == "/chat/completions" && failCompletions)
                {
                    context.Response.StatusCode = 500;
                    await context.Response.WriteAsync("{\"error\":{\"message\":\"synthetic\"}}");
                    return;
                }
                context.Response.ContentType = "text/event-stream";
                if (path == "/v1/messages")
                {
                    await context.Response.WriteAsync(AnthropicText());
                    return;
                }
                JsonObject frame =
                    path == "/chat/completions"
                        ? new JsonObject
                        {
                            ["choices"] = new JsonArray(
                                new JsonObject
                                {
                                    ["index"] = 0,
                                    ["delta"] = new JsonObject
                                    {
                                        ["role"] = "assistant",
                                        ["content"] = "ack",
                                    },
                                    ["finish_reason"] = "stop",
                                }
                            ),
                        }
                        : new JsonObject
                        {
                            ["type"] = "response.completed",
                            ["response"] = ResponsesWsTests.Response(captured.Count),
                        };
                await context.Response.WriteAsync(Sse(frame) + "data: [DONE]\n\n");
            }
        );
        await peer.StartAsync();
        await using var websocket = await WsPeer.StartAsync();
        var uri = new Uri(peer.Urls.Single());
        var configuration = Obj(
            """
            {"default":"text","defaults":{"imageInput":false},"providers":{
              "text":{"providerType":"openai-completions","models":["m"]},
              "claude":{"providerType":"anthropic","models":["m"]},
              "ws":{"providerType":"openai-ws","models":["m"]},
              "vision":{"providerType":"openai-responses","imageInput":true,"models":["m"]},
              "route":{"providerType":"failover","targets":["text","vision"],"failureThreshold":1}
            }}
            """
        );
        foreach (
            var (key, provider) in configuration["providers"]!
                .AsObject()
                .Where(pair => pair.Value?["targets"] is null)
                .Select(pair => (pair.Key, pair.Value!.AsObject()))
                .ToArray()
        )
        {
            provider["baseUrl"] = key == "ws" ? websocket.Uri.ToString() : uri.ToString();
            provider["apiKey"] = "synthetic";
        }
        var config = new ModelConfiguration(temp.Path);
        await config.SaveAsync(new JsonObject { ["yaml"] = configuration.ToJsonString() });
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var hosted = new SessionOwner("s", "main", config.Models) { Archive = store.Archive };
        var agents = new AgentCatalog(temp.Path, temp.Path);
        var defaults = new ResponsesClientOptions(uri, "m", "text/m", "synthetic", "", 1000);
        using var http = ProviderHttpRequest.CreateClient();
        var requests = new ModelRequestOwner(
            http,
            defaults,
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            images: store.Images
        );
        var chat = new SessionChatService(
            requests,
            defaults,
            hosted,
            config.Models,
            new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills"))),
            (_, _) => { }
        );
        hosted.Registry = new SessionRegistry(store, chat);
        hosted.Registry.Add("s");
        hosted.EnableCommittedNotifications();
        hosted.Registry.TriggerOverride = _ => hosted.StartProcessing();
        await hosted.Entry.SaveLane.SaveStrictAsync();

        var png = ImageCodecTests.Raster(SKEncodedImageFormat.Png, 6, 4);
        var reference = await store.Images.PutAsync(png, "image/png", "image_photo");
        await hosted.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.Prebuilt(
                Message(
                    "user",
                    new JsonObject { ["text"] = "Describe photo.png" },
                    Uploaded(reference, "image_photo")
                )
            )
        );
        await hosted.DrainForegroundAsync();
        string StoredImages() =>
            string.Join(
                '\n',
                hosted
                    .History()
                    .SelectMany(message => message["parts"]!.AsArray().OfType<JsonObject>())
                    .Where(part => part["inlineDataRef"] is not null)
                    .Select(part => part.ToJsonString())
            );
        var stored = StoredImages();
        Assert.Contains("image_photo", stored);

        void TextOnly((string Path, JsonObject Body) request, string path)
        {
            Assert.Equal(path, request.Path);
            var wire = request.Body.ToJsonString();
            Assert.Contains("Describe photo.png", wire);
            Assert.Contains(Placeholder, wire);
            Assert.Contains("image_photo", wire);
            Assert.DoesNotContain("base64", wire);
            Assert.DoesNotContain("input_image", wire);
            Assert.DoesNotContain("image_url", wire);
        }

        void Capable((string Path, JsonObject Body) request)
        {
            Assert.Equal("/responses", request.Path);
            var wire = request.Body.ToJsonString();
            Assert.DoesNotContain(Placeholder, wire);
            Assert.Contains("input_image", wire);
            Assert.Contains(";base64,", wire);
        }

        async Task Turn(string selection)
        {
            await hosted.UpdateModelAsync(new JsonObject { ["model"] = selection });
            await hosted.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText("Continue with " + selection)
            );
            await hosted.DrainForegroundAsync();
        }

        TextOnly(Assert.Single(captured), "/chat/completions");
        await Turn("claude");
        TextOnly(captured.Last(), "/v1/messages");
        await Turn("ws");
        var wsRequest = Assert.Single(websocket.Requests).ToJsonString();
        Assert.Contains(Placeholder, wsRequest);
        Assert.Contains("image_photo", wsRequest);
        Assert.DoesNotContain("input_image", wsRequest);
        Assert.DoesNotContain("base64", wsRequest);
        await Turn("vision");
        Capable(captured.Last());
        await Turn("text");
        TextOnly(captured.Last(), "/chat/completions");

        // Failover decides per concrete attempt: the text-only target fails, then the capable one sends the image.
        failCompletions = true;
        var before = captured.Count;
        await Turn("route");
        Assert.Equal(before + 2, captured.Count);
        TextOnly(captured[before], "/chat/completions");
        Capable(captured[before + 1]);

        Assert.Equal(stored, StoredImages());
        Assert.DoesNotContain(
            hosted.History(),
            message => message.ToJsonString().Contains(Placeholder, StringComparison.Ordinal)
        );
        await peer.StopAsync();
    }
}
