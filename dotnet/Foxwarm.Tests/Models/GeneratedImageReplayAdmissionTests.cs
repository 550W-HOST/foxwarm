using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class GeneratedImageReplayAdmissionTests
{
    private const string Png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    [Fact]
    public async Task Canonically_appended_generation_replays_natively_or_reaches_foreign_peer_after_blob_loss()
    {
        using var temp = new TempDirectory();
        var captured = new List<JsonObject>();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var peer = builder.Build();
        peer.MapPost(
            "/{**path}",
            async (HttpContext context) =>
            {
                var request = (await JsonNode.ParseAsync(context.Request.Body))!.AsObject();
                captured.Add(request);
                context.Response.ContentType = "text/event-stream";
                JsonObject frame;
                if (context.Request.Path == "/chat/completions")
                    frame = new JsonObject
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
                    };
                else
                {
                    Assert.Equal("/responses", context.Request.Path.Value);
                    var item =
                        captured.Count == 1
                            ? new JsonObject
                            {
                                ["type"] = "image_generation_call",
                                ["id"] = "normal-generation",
                                ["status"] = "completed",
                                ["output_format"] = "png",
                                ["result"] = Png,
                            }
                            : new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = "ack" }
                                ),
                            };
                    frame = new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "r" + captured.Count,
                            ["output"] = new JsonArray(item),
                        },
                    };
                }
                await context.Response.WriteAsync(
                    "data: " + frame.ToJsonString() + "\n\ndata: [DONE]\n\n"
                );
            }
        );
        await peer.StartAsync();
        var uri = new Uri(peer.Urls.Single());
        var config = new ModelConfiguration(temp.Path);
        var configuration = JsonNode
            .Parse(
                """
                {"default":"a","providers":{
                    "a":{"providerType":"openai-responses","models":["m"],"imageGeneration":{"enabled":true,"model":"image-side-model","outputFormat":"png"}},
                    "same":"a/m",
                    "b":{"providerType":"openai-responses","models":["m"]},
                    "c":{"providerType":"openai-completions","models":["m"]}
                }}
                """
            )!
            .AsObject();
        foreach (
            var provider in configuration["providers"]!
                .AsObject()
                .Select(pair => pair.Value)
                .OfType<JsonObject>()
        )
        {
            provider["baseUrl"] = uri.ToString();
            provider["apiKey"] = "synthetic";
        }
        await config.SaveAsync(new JsonObject { ["yaml"] = configuration.ToJsonString() });
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var hosted = new SessionOwner("s", "main", config.Models) { Archive = store.Archive };
        var agents = new AgentCatalog(temp.Path, temp.Path);
        var defaults = new ResponsesClientOptions(uri, "m", "a/m", "synthetic", "", 1000);
        using var http = ProviderHttpRequest.CreateClient();
        var requests = new ModelRequestOwner(
            http,
            defaults,
            new ModelRouting(),
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

        async Task Turn(string selection, bool fails = false)
        {
            await hosted.UpdateModelAsync(new JsonObject { ["model"] = selection });
            var before = captured.Count;
            var failures = hosted.Entry.BackgroundProcessorFailureCount;
            await hosted.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText("Continue with " + selection)
            );
            await hosted.DrainForegroundAsync();
            Assert.Equal(fails, hosted.Entry.BackgroundProcessorFailureCount > failures);
            Assert.Equal(before + (fails ? 0 : 1), captured.Count);
            if (fails)
            {
                var failure = Assert.IsType<ModelPreparationException>(
                    hosted.Entry.LastBackgroundProcessorFailure
                );
                Assert.IsType<Foxwarm.Images.ImageInputException>(failure.GetBaseException());
            }
        }

        void Placeholder()
        {
            var wire = captured.Last().ToJsonString();
            Assert.Contains("current model does not receive its image content", wire);
            Assert.Contains("ig_normal-generation", wire);
            Assert.Contains("image_write_to_file", wire);
            Assert.DoesNotContain(Png, wire);
            Assert.DoesNotContain("input_image", wire);
            Assert.DoesNotContain("image_url", wire);
            Assert.DoesNotContain("image_generation_call", wire);
        }

        await Turn("a");
        var generated = Assert.Single(
            hosted.History(),
            message =>
                message["parts"]!
                    .AsArray()
                    .Any(part => part?["imageMeta"]?["origin"]?.GetValue<string>() == "generated")
        );
        var canonical = generated.ToJsonString();
        var part = Assert.Single(
            generated["parts"]!.AsArray(),
            item => item?["inlineDataRef"] is not null
        )!;
        Assert.Equal("a/m", generated["__meta"]!["modelId"]!.GetValue<string>());
        Assert.Equal(
            "a/m",
            part["providerMeta"]!["openaiResponses"]!["sourceModelId"]!.GetValue<string>()
        );
        Assert.Null(part["providerMeta"]!["openaiResponses"]!["outputItem"]!["result"]);
        Assert.Null(part["inlineData"]);
        Assert.Contains("image-side-model", captured[0].ToJsonString());
        Assert.Contains(
            store.Archive.ReadMessages(),
            row => row.Message.ToJsonString() == canonical
        );
        Assert.Contains(
            (await store.LoadAsync("s"))!.History.Materialize(),
            row => row.ToJsonString() == canonical
        );

        foreach (var selection in new[] { "a", "same" })
        {
            await Turn(selection);
            var native = Assert.Single(
                captured.Last()["input"]!.AsArray(),
                item => item?["type"]?.GetValue<string>() == "image_generation_call"
            )!;
            Assert.Equal(Png, native["result"]!.GetValue<string>());
            Assert.Equal("m", captured.Last()["model"]!.GetValue<string>());
        }

        // Only the generated blob in this owned fixture is removed; history is not edited.
        File.Delete(store.Images.ResolveBlob(part["inlineDataRef"]!["blobId"]!.GetValue<string>()));
        await Turn("b");
        Placeholder();
        await Turn("c");
        Placeholder();
        await Turn("a", fails: true);

        // The normal configuration owner installs a new protocol under the same concrete key.
        configuration["providers"]!["a"]!["providerType"] = "openai-completions";
        configuration["providers"]!["a"]!.AsObject().Remove("imageGeneration");
        await config.SaveAsync(new JsonObject { ["yaml"] = configuration.ToJsonString() });
        Assert.Equal("a/m", config.Models.Resolve("a").Key);
        await Turn("a");
        Placeholder();
        Assert.Contains(hosted.History(), message => message.ToJsonString() == canonical);
        Assert.Contains(
            store.Archive.ReadMessages(),
            row => row.Message.ToJsonString() == canonical
        );
        await peer.StopAsync();
    }
}
